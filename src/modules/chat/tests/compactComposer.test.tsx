import assert from 'node:assert/strict';
import { createRef } from 'react';
import type { ComponentProps } from 'react';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import ChatComposer from '@/modules/chat/composer/ChatComposer';
import { useEscapeToAbortSession } from '@/modules/chat/hooks/useEscapeToAbortSession';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';

type Props = ComponentProps<typeof ChatComposer>;
const noop = () => undefined;
const props = (overrides: Partial<Props> = {}): Props => ({
  pendingPermissionRequests: [], handlePermissionDecision: noop,
  handleGrantToolPermission: () => ({ success: true }), activity: null,
  isLoading: false, onAbortSession: noop, permissionMode: 'default',
  availablePermissionModes: ['default'], onSelectPermissionMode: noop,
  providerLabel: 'Claude', effort: 'medium', availableEffortOptions: [],
  onSelectEffort: noop, model: 'test-model', availableModelOptions: [],
  onSelectModel: noop, modelsLoading: false, tokenBudget: null,
  onShowTokenUsage: noop, slashCommandsCount: 0, onToggleCommandMenu: noop,
  hasInput: true, onClearInput: noop, onSubmit: noop, isDragActive: false,
  queuedDraft: null, backgroundSendPrompt: null, onResolveBackgroundSendPrompt: noop,
  isEditingSentMessage: false, onCancelEditMessage: noop, scheduledMessages: [],
  onScheduleMessage: noop, onCancelScheduledMessage: noop, onEditQueuedDraft: noop,
  onDeleteQueuedDraft: noop, attachedFiles: [], onRemoveAttachment: noop,
  attachmentRejections: [], onDismissAttachmentRejections: noop,
  showFileDropdown: false, filteredFiles: [], selectedFileIndex: -1, onSelectFile: noop,
  filteredCommands: [], selectedCommandIndex: -1, onCommandSelect: noop,
  onCloseCommandMenu: noop, isCommandMenuOpen: false, frequentCommands: [],
  getRootProps: () => ({}), getInputProps: () => ({ type: 'file', hidden: true }),
  openAttachmentPicker: noop, inputHighlightRef: createRef<HTMLDivElement>(),
  renderInputWithMentions: (text) => text, textareaRef: createRef<HTMLTextAreaElement>(),
  input: '保留这段草稿', onInputChange: noop, onTextareaClick: noop,
  onTextareaKeyDown: noop, onTextareaPaste: noop, onTextareaScrollSync: noop,
  onTextareaInput: noop, placeholder: 'Message', isTextareaExpanded: false,
  onToggleCompactMode: noop, ...overrides,
});
const view = (value: Props) => <UiPreferencesProvider><ChatComposer {...value} /></UiPreferencesProvider>;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })));
});

afterEach(() => vi.unstubAllGlobals());

test('实际输入结构在普通及简洁模式下按可用宽度隐藏和恢复权限名称', () => {
  let compact = false;
  let room = 700;
  const observers = new Set<() => void>();
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
    if (this.matches('[data-slot="prompt-input-footer"]')) return compact ? 0 : room;
    if (this.classList.contains('composer-options')) return room;
    return 0;
  });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const namedTrigger = (element: Element) => element.querySelector('button[aria-label^="Default Mode:"]');
    const triggerWidth = (element: Element | null) => element?.textContent ? 112 : 32;
    let width = 0;
    if (this.matches('[data-slot="prompt-input-tools"]')) width = 210;
    else if (this.classList.contains('composer-secondary-actions')) width = 180 + triggerWidth(namedTrigger(this));
    else if (this.classList.contains('composer-send-actions')) width = 80;
    else if (this.matches('button[aria-label^="Default Mode:"]')) width = triggerWidth(this);
    return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 32, width, height: 32, toJSON: () => ({}) };
  });
  vi.stubGlobal('ResizeObserver', class {
    constructor(readonly callback: () => void) {}
    observe() { observers.add(this.callback); }
    disconnect() { observers.delete(this.callback); }
  });
  const value = props();
  const { rerender } = render(view(value));
  const trigger = screen.getByRole('button', { name: /^Default Mode:/ });
  assert.equal(trigger.textContent, 'Default Mode');
  act(() => { room = 350; for (const callback of observers) callback(); });
  assert.equal(trigger.textContent, '');
  compact = true;
  rerender(view({ ...value, compactMode: true }));
  fireEvent.click(screen.getByRole('button', { name: 'More chat tools' }));
  act(() => { room = 270; for (const callback of observers) callback(); });
  assert.equal(trigger.textContent, '', '简洁模式不能测量无布局盒的 footer');
  act(() => { room = 620; for (const callback of observers) callback(); });
  assert.equal(trigger.textContent, 'Default Mode');
});

test('模式切换保留同一输入节点、草稿和附件', () => {
  const value = props({ attachedFiles: [new File(['note'], 'notes.txt', { type: 'text/plain' })] });
  const { rerender } = render(view(value));
  const textarea = screen.getByPlaceholderText('Message');
  textarea.focus();
  fireEvent.compositionStart(textarea);
  rerender(view({ ...value, compactMode: true }));
  assert.equal(screen.getByPlaceholderText('Message'), textarea);
  assert.equal((textarea as HTMLTextAreaElement).value, value.input);
  assert.equal(document.activeElement, textarea);
  assert.ok(screen.getByText('notes.txt'));
  fireEvent.compositionEnd(textarea);
  rerender(view(value));
  assert.equal(screen.getByPlaceholderText('Message'), textarea);
});

test('简洁模式按需展开工具，Escape 仅关闭工具', () => {
  const abort = vi.fn();
  const value = props({ compactMode: true, isLoading: true, onAbortSession: abort });
  render(view(value));
  renderHook(() => useEscapeToAbortSession({
    canAbortSession: true, onAbortSession: abort, composerRef: value.textareaRef,
  }));
  const more = screen.getByRole('button', { name: 'More chat tools' });
  assert.equal(more.getAttribute('aria-expanded'), 'false');
  assert.equal(screen.queryByRole('button', { name: 'Attach files' }), null);
  fireEvent.click(more);
  assert.equal(more.getAttribute('aria-expanded'), 'true');
  assert.ok(screen.getByRole('button', { name: 'Attach files' }));
  fireEvent.keyDown(more, { key: 'Escape' });
  assert.equal(more.getAttribute('aria-expanded'), 'false');
  assert.equal(abort.mock.calls.length, 0);
});

test('简洁模式的停止按钮仍立即调用原停止处理器', () => {
  const abort = vi.fn();
  render(view(props({ compactMode: true, isLoading: true, input: '', hasInput: false, onAbortSession: abort })));
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  assert.equal(abort.mock.calls.length, 1);
});

test('简洁模式审批仍可操作且退出入口可见', () => {
  const decide = vi.fn();
  const exit = vi.fn();
  render(view(props({
    compactMode: true, onToggleCompactMode: exit, handlePermissionDecision: decide,
    pendingPermissionRequests: [{ requestId: 'permission-1', toolName: 'Bash', input: { command: 'pwd' } }],
  })));
  assert.ok(screen.getByText('Permission required'));
  const allow = screen.getAllByRole('button').find((button) => button.textContent === 'Allow once');
  assert.ok(allow);
  fireEvent.click(allow);
  assert.equal(decide.mock.calls.length, 1);
  fireEvent.click(screen.getByRole('button', { name: 'Exit compact mode' }));
  assert.equal(exit.mock.calls.length, 1);
});

test('问题面板替代输入时仍可退出简洁模式', () => {
  const exit = vi.fn();
  render(view(props({
    compactMode: true, onToggleCompactMode: exit,
    pendingPermissionRequests: [{ requestId: 'question-1', toolName: 'AskUserQuestion', input: {
      questions: [{ question: '继续吗？', header: '选择', options: [
        { label: '继续', description: '继续操作' }, { label: '暂停', description: '暂停操作' },
      ], multiSelect: false }],
    } }],
  })));
  assert.equal(screen.queryByPlaceholderText('Message'), null);
  fireEvent.click(screen.getByRole('button', { name: 'Exit compact mode' }));
  assert.equal(exit.mock.calls.length, 1);
});
