import assert from 'node:assert/strict';

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Project } from '@/shared/types';

/**
 * The root path reopens the conversation this browser had open last.
 *
 * Without it, "no session id in the URL" meant "new chat": reopening the tab
 * and sending a message allocated a second session, so one task ended up split
 * across two conversations. `/new` is the only state that starts a fresh chat.
 */

const projectsResponse = vi.fn();
const sessionDetailsResponse = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    projects: () => projectsResponse(),
    projectTaskmaster: () => Promise.resolve({ ok: false }),
    sessionDetails: (sessionId: string) => sessionDetailsResponse(sessionId),
    projectSessions: () => Promise.resolve({ ok: false }),
  },
}));

const LAST_OPENED_SESSION_STORAGE_KEY = 'cloudcli:last-opened-session';

const buildProject = (): Project => ({
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
  sessions: [],
  sessionMeta: { hasMore: false, total: 0 },
});

type ServerEventListener = (event: { kind: string }) => void;

const listeners = new Set<ServerEventListener>();

const renderProjectsState = async (args: {
  sessionId?: string;
  isNewSessionRoute?: boolean;
}) => {
  const { useProjectsState } = await import('@/modules/project-workspace/hooks/useProjectsState');
  const navigate = vi.fn();

  const view = renderHook(() =>
    useProjectsState({
      sessionId: args.sessionId,
      isNewSessionRoute: args.isNewSessionRoute,
      navigate,
      subscribe: (listener: ServerEventListener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      isMobile: false,
      isSessionProcessing: () => false,
    }),
  );

  return { view, navigate };
};

beforeEach(() => {
  localStorage.clear();
  projectsResponse.mockReset();
  projectsResponse.mockResolvedValue({
    ok: true,
    json: async () => [buildProject()],
  });
  sessionDetailsResponse.mockReset();
  // Echo the requested id back: a different one is the provider-alias case, which
  // navigates on its own and would be mistaken for a restore here.
  sessionDetailsResponse.mockImplementation(async (requestedSessionId: string) => ({
    ok: true,
    json: async () => ({ data: { sessionId: requestedSessionId, project: { projectId: 'project-1' } } }),
  }));
  listeners.clear();
});

afterEach(() => {
  vi.resetModules();
});

test('the root path reopens the conversation recorded in this browser', async () => {
  localStorage.setItem(
    LAST_OPENED_SESSION_STORAGE_KEY,
    JSON.stringify({ sessionId: 'session-1', projectId: 'project-1', updatedAt: Date.now() }),
  );

  const { view, navigate } = await renderProjectsState({});

  await waitFor(() => {
    assert.equal(navigate.mock.calls.length, 1);
  });

  assert.deepEqual(navigate.mock.calls[0], ['/session/session-1', { replace: true }]);
  assert.equal(view.result.current.isLoadingProjects, false);
  // The restore is a redirect, not a new chat: the sidebar must not be told to reset.
  assert.equal(view.result.current.newSessionTrigger, 0);
});

test('the explicit new-chat route keeps the blank composer instead of reopening', async () => {
  localStorage.setItem(
    LAST_OPENED_SESSION_STORAGE_KEY,
    JSON.stringify({ sessionId: 'session-1', projectId: 'project-1', updatedAt: Date.now() }),
  );

  const { view, navigate } = await renderProjectsState({ isNewSessionRoute: true });

  await waitFor(() => {
    assert.equal(view.result.current.isLoadingProjects, false);
  });

  assert.equal(navigate.mock.calls.length, 0);
});

test('a route that already names a session is never overridden', async () => {
  localStorage.setItem(
    LAST_OPENED_SESSION_STORAGE_KEY,
    JSON.stringify({ sessionId: 'session-1', projectId: 'project-1', updatedAt: Date.now() }),
  );

  const { view, navigate } = await renderProjectsState({ sessionId: 'session-2' });

  await waitFor(() => {
    assert.equal(view.result.current.isLoadingProjects, false);
  });

  assert.equal(navigate.mock.calls.length, 0, JSON.stringify(navigate.mock.calls));
});

test('a recorded conversation the backend no longer has is forgotten instead of opened', async () => {
  localStorage.setItem(
    LAST_OPENED_SESSION_STORAGE_KEY,
    JSON.stringify({ sessionId: 'session-1', projectId: 'project-1', updatedAt: Date.now() }),
  );
  sessionDetailsResponse.mockResolvedValue({ ok: false });

  const { view, navigate } = await renderProjectsState({});

  await waitFor(() => {
    assert.equal(view.result.current.isLoadingProjects, false);
  });

  await waitFor(() => {
    assert.equal(localStorage.getItem(LAST_OPENED_SESSION_STORAGE_KEY), null);
  });

  assert.equal(navigate.mock.calls.length, 0);
});