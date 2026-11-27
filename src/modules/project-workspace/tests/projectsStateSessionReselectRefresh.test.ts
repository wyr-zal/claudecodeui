import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Project, ProjectSession } from '@/shared/types';

/**
 * Re-selecting the conversation that is already on screen is the user asking
 * for its latest state even though the route does not change. The chat view is
 * signalled through `externalMessageUpdate`; selecting a different session is
 * fetched by the chat view itself when it opens, so it must not also bump the
 * signal and trigger a second history read.
 */

const projectsResponse = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    projects: () => projectsResponse(),
    projectTaskmaster: () => Promise.resolve({ ok: false }),
    sessionDetails: () => Promise.resolve({ ok: false }),
    projectSessions: () => Promise.resolve({ ok: false }),
  },
}));

const buildProject = (): Project => ({
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
  sessions: [],
  sessionMeta: { hasMore: false, total: 0 },
});

const sessionA = {
  id: 'session-a',
  summary: 'A',
  lastActivity: '2026-01-01T00:00:00.000Z',
} as ProjectSession;

const sessionB = {
  id: 'session-b',
  summary: 'B',
  lastActivity: '2026-01-01T00:00:00.000Z',
} as ProjectSession;

async function renderProjectsState() {
  const { useProjectsState } = await import(
    '@/modules/project-workspace/hooks/useProjectsState'
  );

  return renderHook(() =>
    useProjectsState({
      sessionId: undefined,
      navigate: vi.fn(),
      subscribe: () => () => undefined,
      isMobile: false,
      isSessionProcessing: () => false,
    }),
  );
}

beforeEach(() => {
  localStorage.clear();
  projectsResponse.mockReset();
  projectsResponse.mockResolvedValue({
    ok: true,
    json: async () => [buildProject()],
  });
});

afterEach(() => {
  vi.resetModules();
});

test('re-selecting the session on screen bumps the refresh signal', async () => {
  const { result } = await renderProjectsState();
  await waitFor(() => assert.ok(result.current.selectedProject));

  await act(async () => {
    result.current.handleSessionSelect(sessionA);
  });
  assert.equal(result.current.selectedSession?.id, 'session-a');
  const afterFirstSelection = result.current.externalMessageUpdate;

  await act(async () => {
    result.current.handleSessionSelect({ ...sessionA });
  });

  assert.equal(result.current.externalMessageUpdate, afterFirstSelection + 1);
});

test('selecting a different session does not bump the refresh signal', async () => {
  const { result } = await renderProjectsState();
  await waitFor(() => assert.ok(result.current.selectedProject));

  await act(async () => {
    result.current.handleSessionSelect(sessionA);
  });
  const afterFirstSelection = result.current.externalMessageUpdate;

  await act(async () => {
    result.current.handleSessionSelect(sessionB);
  });

  assert.equal(result.current.selectedSession?.id, 'session-b');
  assert.equal(result.current.externalMessageUpdate, afterFirstSelection);
});