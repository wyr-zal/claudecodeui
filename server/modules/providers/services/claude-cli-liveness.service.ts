import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * One Claude CLI process that is currently producing a response.
 *
 * `providerSessionId` is Claude's own session id, which is what the registry
 * records; callers map it onto an app session themselves. `pid` is the process
 * holding that session, which is the only handle on a turn CloudCLI does not
 * drive.
 */
type LiveClaudeCliSession = {
  providerSessionId: string;
  pid: number;
  startedAt: number;
};

/**
 * Claude Code keeps one file per running session here, named `<pid>.json`.
 * The directory belongs to the CLI, not to CloudCLI: it is only ever read.
 */
const registryDirectory = () => path.join(os.homedir(), '.claude', 'sessions');

/**
 * Upper bound on registry files inspected per poll.
 *
 * The running-sessions endpoint is polled continuously, so a directory left
 * full of stale files by repeated crashes must not turn every poll into
 * unbounded filesystem work. Real installations hold a handful of entries.
 */
const MAX_REGISTRY_FILES = 256;

/**
 * Whether `pid` is still the process the registry recorded.
 *
 * A registry file outlives a crash, so its mere presence proves nothing. The
 * signal-0 probe answers "does this pid exist" (EPERM means it exists but is
 * owned by someone else, which still counts), and on Linux the recorded
 * `procStart` is compared against the kernel's start-time for that pid so a
 * reused pid cannot be mistaken for the original process.
 */
async function isRecordedProcessAlive(pid: number, procStart: unknown): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EPERM') {
      return false;
    }
  }

  if (process.platform !== 'linux' || typeof procStart !== 'string' || !procStart) {
    return true;
  }

  try {
    const stat = await fsp.readFile(`/proc/${pid}/stat`, 'utf8');
    // The comm field is parenthesised and may itself contain spaces, so the
    // fields are counted from the last ')'. starttime is the 22nd field
    // overall, i.e. the 20th of what follows the comm field.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[19] === procStart;
  } catch {
    // No procfs entry means the process is gone between the two checks.
    return false;
  }
}

/** Reads one registry file, returning null for anything that is not a live busy session. */
async function readLiveBusySession(filePath: string): Promise<LiveClaudeCliSession | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch {
    // Unreadable, half-written or malformed entries are simply not evidence
    // of a running session.
    return null;
  }

  const record = parsed as Record<string, unknown> | null;
  if (!record || typeof record !== 'object') {
    return null;
  }

  const providerSessionId = typeof record.sessionId === 'string' ? record.sessionId : '';
  const pid = typeof record.pid === 'number' ? record.pid : NaN;
  if (!providerSessionId || !Number.isInteger(pid) || pid <= 0 || record.status !== 'busy') {
    return null;
  }

  if (!(await isRecordedProcessAlive(pid, record.procStart))) {
    return null;
  }

  const startedAt = typeof record.startedAt === 'number' ? record.startedAt : Date.now();
  return { providerSessionId, pid, startedAt };
}

/**
 * Lists the Claude CLI sessions that are mid-turn right now.
 *
 * Used by the providers module's sessions service so the running-sessions poll
 * also reports turns driven outside CloudCLI's own chat runs — including the
 * `claude` processes CloudCLI itself spawns for the Shell view, which live in
 * the PTY map rather than the chat-run registry. Liveness is ephemeral, so it
 * is recomputed on every read instead of being cached or persisted.
 */
export async function listBusyClaudeCliSessions(): Promise<LiveClaudeCliSession[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(registryDirectory());
  } catch {
    // No registry directory at all is the normal case for an install that has
    // never run the CLI, and an unreadable one is not worth failing a poll for.
    return [];
  }

  const registryFiles = entries.filter((entry) => entry.endsWith('.json')).slice(0, MAX_REGISTRY_FILES);
  const sessions = await Promise.all(
    registryFiles.map((entry) => readLiveBusySession(path.join(registryDirectory(), entry))),
  );

  return sessions.filter((session): session is LiveClaudeCliSession => session !== null);
}

/**
 * Ends the Claude CLI process driving one session.
 *
 * A turn the CLI drives belongs to that process, not to a CloudCLI run, so the
 * process is the only lever a stop request has. The session itself survives:
 * the next message resumes it from its transcript.
 */
export async function stopLiveClaudeCliSession(
  providerSessionId: string,
  kill: (pid: number) => Promise<boolean> = terminateProcessTree,
): Promise<boolean> {
  const live = (await listBusyClaudeCliSessions())
    .find((session) => session.providerSessionId === providerSessionId);

  // Ending this process would take the server down with it.
  if (!live || live.pid === process.pid) {
    return false;
  }

  // A registry file outlives its process and Windows reuses pids; the kernel
  // cross-check above only exists on Linux, so the image name is what keeps a
  // stale entry from ending an unrelated program here.
  if (!(await isClaudeProcess(live.pid))) {
    return false;
  }

  return kill(live.pid);
}

/** Whether `pid` is still the Claude CLI, rather than a process that reused its pid. */
async function isClaudeProcess(pid: number): Promise<boolean> {
  if (process.platform !== 'win32') {
    return true;
  }

  return new Promise<boolean>((resolve) => {
    const probe = spawn('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true });
    let output = '';
    probe.stdout?.on('data', (chunk) => { output += String(chunk); });
    probe.once('error', () => resolve(false));
    probe.once('close', () => resolve(/claude/i.test(output)));
  });
}

/**
 * Ends a process and everything it spawned.
 *
 * The CLI's children (a running Bash, its MCP servers) outlive a bare SIGTERM
 * on Windows, so the whole tree goes down together.
 */
async function terminateProcessTree(pid: number): Promise<boolean> {
  if (process.platform === 'win32') {
    return new Promise<boolean>((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      killer.once('error', () => resolve(false));
      killer.once('close', (code) => resolve(code === 0));
    });
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return false;
  }

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
  }

  try {
    process.kill(pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}
