import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Project } from '@/shared/types';

/**
 * The sidebar re-reads its lists by itself when a turn ends, so a conversation
 * that just finished drops below the ones still running without a click on the
 * header's refresh button. These tests pin down when that happens, how often,
 * and what a completion landing mid-read does.
 */

const recentConversationsResponse = vi.fn();
const archivedProjectsResponse = vi.fn();
const archivedSessionsResponse = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    recentConversations: (...args: unknown[]) => recentConversationsResponse(...args),
    archivedProjects: () => archivedProjectsResponse(),
    getArchivedSessions: () => archivedSessionsResponse(),
    migrateLegacyProjectStars: () => Promise.resolve({ ok: true, json: async () => ({}) }),
  },
}));

const { useSidebarController } = await import('@/modules/sidebar/hooks/useSidebarController');

const t = ((key: string) => key) as unknown as TFunction;

const AUTO_REFRESH_DEBOUNCE_MS = 800;
const AUTO_REFRESH_MAX_WAIT_MS = 2_000;

const PROJECTS: Project[] = [{
  projectId: 'project-1',
  path: '/workspace/project-1',
  fullPath: '/workspace/project-1',
  displayName: 'project-1',
  isStarred: false,
  sessions: [],
}];

type ControllerProps = {
  activeSessions: ReadonlySet<string>;
  backgroundSessionIds: ReadonlySet<string>;
  onRefresh: () => Promise<void>;
};

const renderController = (onRefresh: () => Promise<void>) => renderHook(
  ({ activeSessions, backgroundSessionIds, onRefresh: refresh }: ControllerProps) => useSidebarController({
    projects: PROJECTS,
    selectedProject: null,
    selectedSession: null,
    activeSessions,
    backgroundSessionIds,
    isLoading: false,
    isMobile: false,
    t,
    onRefresh: refresh,
    onProjectSelect: vi.fn(),
    onSessionSelect: vi.fn(),
    setCurrentProject: vi.fn(),
    setSidebarVisible: vi.fn(),
    sidebarVisible: true,
  }),
  { initialProps: { activeSessions: new Set<string>(), backgroundSessionIds: new Set<string>(), onRefresh } as ControllerProps },
);

const flush = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
};

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

/** Moves the controller from `idle` to one running session and back to idle. */
const finishOneTurn = async (
  rerender: (props: {
    activeSessions: ReadonlySet<string>;
    backgroundSessionIds: ReadonlySet<string>;
    onRefresh: () => Promise<void>;
  }) => void,
  onRefresh: () => Promise<void>,
  sessionId = 'session-1',
) => {
  rerender({ activeSessions: new Set([sessionId]), backgroundSessionIds: new Set(), onRefresh });
  await flush();
  rerender({ activeSessions: new Set(), backgroundSessionIds: new Set(), onRefresh });
  await flush();
};

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  recentConversationsResponse.mockReset();
  recentConversationsResponse.mockResolvedValue({
    ok: true,
    json: async () => ({ data: { conversations: [], total: 0, hasMore: false } }),
  });
  archivedProjectsResponse.mockReset();
  archivedProjectsResponse.mockResolvedValue({ ok: true, json: async () => ({ data: { projects: [] } }) });
  archivedSessionsResponse.mockReset();
  archivedSessionsResponse.mockResolvedValue({ ok: true, json: async () => ({ data: { sessions: [] } }) });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('a finished turn re-reads the lists once, after the debounce window', async () => {
  const onRefresh = vi.fn(() => Promise.resolve());
  const { rerender } = renderController(onRefresh);
  await flush();

  rerender({ activeSessions: new Set(['session-1']), backgroundSessionIds: new Set(), onRefresh });
  await flush();
  assert.equal(onRefresh.mock.calls.length, 0, 'a running turn must not refresh the list');

  rerender({ activeSessions: new Set(), backgroundSessionIds: new Set(), onRefresh });
  await advance(AUTO_REFRESH_DEBOUNCE_MS - 1);
  assert.equal(onRefresh.mock.calls.length, 0, 'the refresh waits for the debounce window');

  await advance(1);
  assert.equal(onRefresh.mock.calls.length, 1);
});

test('sessions already running at mount do not count as a completion', async () => {
  const onRefresh = vi.fn(() => Promise.resolve());
  renderHook(() => useSidebarController({
    projects: PROJECTS,
    selectedProject: null,
    selectedSession: null,
    activeSessions: new Set(['session-1', 'session-2']),
    backgroundSessionIds: new Set(),
    isLoading: false,
    isMobile: false,
    t,
    onRefresh,
    onProjectSelect: vi.fn(),
    onSessionSelect: vi.fn(),
    setCurrentProject: vi.fn(),
    setSidebarVisible: vi.fn(),
    sidebarVisible: true,
  }));

  await advance(AUTO_REFRESH_DEBOUNCE_MS * 2);
  assert.equal(onRefresh.mock.calls.length, 0);
});

test('a session that only ever runs background work never triggers a refresh', async () => {
  const onRefresh = vi.fn(() => Promise.resolve());
  const { rerender } = renderController(onRefresh);
  await flush();

  rerender({ activeSessions: new Set(['session-1']), backgroundSessionIds: new Set(['session-1']), onRefresh });
  await advance(AUTO_REFRESH_DEBOUNCE_MS * 2);
  assert.equal(onRefresh.mock.calls.length, 0);

  // The background work ending is not a turn ending either.
  rerender({ activeSessions: new Set(), backgroundSessionIds: new Set(), onRefresh });
  await advance(AUTO_REFRESH_DEBOUNCE_MS * 2);
  assert.equal(onRefresh.mock.calls.length, 0);
});

test('a turn that ends with background work left is a completion, and that work ending is not', async () => {
  const onRefresh = vi.fn(() => Promise.resolve());
  const { rerender } = renderController(onRefresh);
  await flush();

  rerender({ activeSessions: new Set(['session-1']), backgroundSessionIds: new Set(), onRefresh });
  await flush();

  // The turn ended; the session stays busy only because its tasks keep running.
  rerender({ activeSessions: new Set(['session-1']), backgroundSessionIds: new Set(['session-1']), onRefresh });
  await advance(AUTO_REFRESH_DEBOUNCE_MS);
  assert.equal(onRefresh.mock.calls.length, 1);

  rerender({ activeSessions: new Set(), backgroundSessionIds: new Set(), onRefresh });
  await advance(AUTO_REFRESH_DEBOUNCE_MS * 2);
  assert.equal(onRefresh.mock.calls.length, 1);
});

test('turns finishing within the debounce window share a single refresh', async () => {
  const onRefresh = vi.fn(() => Promise.resolve());
  const { rerender } = renderController(onRefresh);
  await flush();

  await finishOneTurn(rerender, onRefresh, 'session-1');
  await advance(300);
  await finishOneTurn(rerender, onRefresh, 'session-2');

  await advance(AUTO_REFRESH_DEBOUNCE_MS);
  assert.equal(onRefresh.mock.calls.length, 1);
});

test('a burst of completions still reads within the max wait', async () => {
  const onRefresh = vi.fn(() => Promise.resolve());
  const { rerender } = renderController(onRefresh);
  await flush();

  // One completion every 300 ms — each restarts the debounce window.
  for (let index = 0; index < 6; index += 1) {
    await finishOneTurn(rerender, onRefresh, `session-${index}`);
    await advance(300);
  }

  await advance(AUTO_REFRESH_MAX_WAIT_MS);
  assert.equal(onRefresh.mock.calls.length, 1);
});

test('a completion during an in-flight read queues exactly one more read', async () => {
  let resolveRefresh: (() => void) | undefined;
  const onRefresh = vi.fn(() => new Promise<void>((resolve) => { resolveRefresh = resolve; }));
  const { rerender } = renderController(onRefresh);
  await flush();

  await finishOneTurn(rerender, onRefresh, 'session-1');
  await advance(AUTO_REFRESH_DEBOUNCE_MS);
  assert.equal(onRefresh.mock.calls.length, 1, 'the first read is still in flight');

  // Another turn ends while that request is out; its result cannot contain it.
  await finishOneTurn(rerender, onRefresh, 'session-2');
  await advance(AUTO_REFRESH_DEBOUNCE_MS);
  assert.equal(onRefresh.mock.calls.length, 1, 'no second request while the first is out');

  await act(async () => {
    resolveRefresh?.();
  });
  await advance(AUTO_REFRESH_DEBOUNCE_MS);
  assert.equal(onRefresh.mock.calls.length, 2);
});

test('a completion during an in-flight read does not read after unmount', async () => {
  let resolveRefresh: (() => void) | undefined;
  const onRefresh = vi.fn(() => new Promise<void>((resolve) => { resolveRefresh = resolve; }));
  const { rerender, unmount } = renderController(onRefresh);
  await flush();

  await finishOneTurn(rerender, onRefresh, 'session-1');
  await advance(AUTO_REFRESH_DEBOUNCE_MS);
  assert.equal(onRefresh.mock.calls.length, 1);

  await finishOneTurn(rerender, onRefresh, 'session-2');
  unmount();

  await act(async () => {
    resolveRefresh?.();
  });
  await advance(AUTO_REFRESH_MAX_WAIT_MS * 2);
  assert.equal(onRefresh.mock.calls.length, 1);
});

test('unmounting before the debounce elapses drops the pending read', async () => {
  const onRefresh = vi.fn(() => Promise.resolve());
  const { rerender, unmount } = renderController(onRefresh);
  await flush();

  await finishOneTurn(rerender, onRefresh);
  unmount();
  await advance(AUTO_REFRESH_DEBOUNCE_MS * 2);
  assert.equal(onRefresh.mock.calls.length, 0);
});

test('the automatic read leaves the archived lists alone', async () => {
  const onRefresh = vi.fn(() => Promise.resolve());
  const { rerender } = renderController(onRefresh);
  await flush();
  const archivedCallsBefore = archivedProjectsResponse.mock.calls.length;

  await finishOneTurn(rerender, onRefresh);
  await advance(AUTO_REFRESH_DEBOUNCE_MS);
  assert.equal(onRefresh.mock.calls.length, 1);
  assert.equal(archivedProjectsResponse.mock.calls.length, archivedCallsBefore,
    're-reading the archive would flash its loading state for a list a turn cannot change');
});

test('the header button still re-reads the archived lists, after the project list', async () => {
  let resolveRefresh: (() => void) | undefined;
  const onRefresh = vi.fn(() => new Promise<void>((resolve) => { resolveRefresh = resolve; }));
  const { result } = renderController(onRefresh);
  await flush();
  const archivedCallsBefore = archivedProjectsResponse.mock.calls.length;

  act(() => {
    void result.current.refreshProjects();
  });
  await flush();
  assert.equal(archivedProjectsResponse.mock.calls.length, archivedCallsBefore,
    'the archive must wait for the project list to advance each session');

  await act(async () => {
    resolveRefresh?.();
  });
  await flush();
  assert.equal(archivedProjectsResponse.mock.calls.length, archivedCallsBefore + 1);
});

test('on the Conversations tab the recents feed is re-read after the project list', async () => {
  let resolveRefresh: (() => void) | undefined;
  const onRefresh = vi.fn(() => new Promise<void>((resolve) => { resolveRefresh = resolve; }));
  const { result, rerender } = renderController(onRefresh);
  await flush();

  act(() => {
    result.current.setSearchMode('conversations');
  });
  await flush();
  const callsBeforeCompletion = recentConversationsResponse.mock.calls.length;

  await finishOneTurn(rerender, onRefresh);
  await advance(AUTO_REFRESH_DEBOUNCE_MS);
  assert.equal(recentConversationsResponse.mock.calls.length, callsBeforeCompletion,
    'the recents feed must wait for the project list to advance each session');

  await act(async () => {
    resolveRefresh?.();
  });
  await flush();
  assert.equal(recentConversationsResponse.mock.calls.length, callsBeforeCompletion + 1);
});
