import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Project, ProjectSession } from '@/shared/types';

/**
 * Entering a session is the user asking to see its latest state.
 *
 * A session that has never been opened loads its newest page. A session whose
 * slot is already warm — returning from another tab, or re-selecting the
 * conversation on screen — keeps its pagination and scroll but must still pull
 * the bounded persisted tail, even when the cache is younger than the stale
 * threshold. These tests pin that, and pin that a genuinely different session
 * is not refreshed twice.
 */

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionTokenUsage: () => Promise.resolve({ ok: false, json: async () => ({}) }),
    },
  },
}));

const project: Project = {
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
};

const sessionA: ProjectSession = {
  id: 'session-a',
  summary: 'A',
  lastActivity: '2026-01-01T00:00:00.000Z',
  messageCount: 1,
} as ProjectSession;

const sessionB: ProjectSession = {
  id: 'session-b',
  summary: 'B',
  lastActivity: '2026-01-01T00:00:00.000Z',
  messageCount: 1,
} as ProjectSession;

const makeSlot = () => ({
  status: 'idle' as const,
  fetchedAt: 1,
  total: 40,
  hasMore: true,
  offset: 20,
  tokenUsage: undefined,
});

const store = {
  fetchFromServer: vi.fn(async (_sessionId: string, _options?: { limit?: number | null }) => makeSlot()),
  fetchMore: vi.fn(),
  appendRealtime: vi.fn(),
  refreshLatestFromServer: vi.fn(async (_sessionId: string, _options?: { limit?: number }) => ({
    slot: makeSlot(),
    applied: true,
    changed: true,
    deferred: false,
  })),
  setActiveSession: vi.fn(),
  // The cache is deliberately fresh: entry refreshes must not depend on this.
  isStale: vi.fn(() => false),
  updateStreaming: vi.fn(),
  finalizeStreaming: vi.fn(),
  getMessages: vi.fn(() => []),
  getSessionSlot: vi.fn(() => makeSlot()),
};

type HookProps = {
  isActive: boolean;
  selectedSession: ProjectSession | null;
  externalMessageUpdate?: number;
};

// Stable identities: the load effect lists `resetStreamingState` among its
// dependencies, and a fresh function per render would re-enter it forever.
const resetStreamingState = vi.fn();
const sendMessage = vi.fn();
const statusCheckSentAtRef = { current: new Map<string, number>() };
const lastSeqRef = { current: new Map<string, number>() };
const processingSessions = new Map();

async function renderSessionState(initialProps: HookProps) {
  const { useChatSessionState } = await import('@/modules/chat/hooks/useChatSessionState');
  return renderHook(
    ({ isActive, selectedSession, externalMessageUpdate = 0 }: HookProps) =>
      useChatSessionState({
        isActive,
        selectedProject: project,
        selectedSession,
        ws: null,
        sendMessage,
        externalMessageUpdate,
        resetStreamingState,
        statusCheckSentAtRef,
        lastSeqRef,
        sessionStore: store as never,
        processingSessions,
      }),
    { initialProps },
  );
}

beforeEach(() => {
  store.fetchFromServer.mockClear();
  store.refreshLatestFromServer.mockClear();
  store.setActiveSession.mockClear();
  store.getSessionSlot.mockClear();
  store.isStale.mockClear();
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

test('opening a session loads its newest page and does not refresh it a second time', async () => {
  await renderSessionState({ isActive: true, selectedSession: sessionA });
  await act(async () => {});

  assert.equal(store.fetchFromServer.mock.calls.length, 1);
  assert.equal(store.fetchFromServer.mock.calls[0][0], 'session-a');
  assert.equal(
    (store.fetchFromServer.mock.calls[0][1] as { limit: number }).limit,
    20,
  );
  assert.equal(store.refreshLatestFromServer.mock.calls.length, 0);
});

test('returning to the Chat tab refreshes the warm session even though it is not stale', async () => {
  const hook = await renderSessionState({ isActive: true, selectedSession: sessionA });
  await act(async () => {});
  store.fetchFromServer.mockClear();

  await act(async () => {
    hook.rerender({ isActive: false, selectedSession: sessionA });
  });
  await act(async () => {
    hook.rerender({ isActive: true, selectedSession: sessionA });
  });
  await act(async () => {});

  assert.equal(store.fetchFromServer.mock.calls.length, 0);
  assert.equal(store.refreshLatestFromServer.mock.calls.length, 1);
  assert.equal(store.refreshLatestFromServer.mock.calls[0][0], 'session-a');
  assert.equal(store.isStale.mock.calls.length, 0);
});

test('switching to a different session fetches that session and does not refresh the old one', async () => {
  const hook = await renderSessionState({ isActive: true, selectedSession: sessionA });
  await act(async () => {});
  store.fetchFromServer.mockClear();

  await act(async () => {
    hook.rerender({ isActive: true, selectedSession: sessionB });
  });
  await act(async () => {});

  assert.equal(store.fetchFromServer.mock.calls.length, 1);
  assert.equal(store.fetchFromServer.mock.calls[0][0], 'session-b');
  assert.equal(store.refreshLatestFromServer.mock.calls.length, 0);
});

test('re-selecting the session on screen refreshes it once per external signal', async () => {
  const hook = await renderSessionState({ isActive: true, selectedSession: sessionA });
  await act(async () => {});
  store.fetchFromServer.mockClear();
  store.refreshLatestFromServer.mockClear();

  // The sidebar re-selects A: same id, fresh object, one new signal. The
  // object identity alone must not keep firing refreshes on later renders.
  await act(async () => {
    hook.rerender({ isActive: true, selectedSession: { ...sessionA }, externalMessageUpdate: 1 });
  });
  await waitFor(() => assert.equal(store.refreshLatestFromServer.mock.calls.length, 1));

  await act(async () => {
    hook.rerender({ isActive: true, selectedSession: { ...sessionA }, externalMessageUpdate: 1 });
  });
  await act(async () => {});

  assert.equal(store.refreshLatestFromServer.mock.calls.length, 1);
  assert.equal(store.fetchFromServer.mock.calls.length, 0);
});