import assert from 'node:assert/strict';

import React from 'react';
import { render } from '@testing-library/react';
import { describe, it } from 'vitest';

import '@/modules/i18n';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage } from '@/shared/types';

const ANSWERED_AT = '2026-08-19T12:00:00.000Z';
const ANSWERED_AT_LABEL = new Date(ANSWERED_AT).toLocaleTimeString();

const assistantRow = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  type: 'assistant',
  content: 'Here is the plan.',
  timestamp: ANSWERED_AT,
  model: 'claude-opus-5',
  ...overrides,
});

const renderMessage = (message: ChatMessage, prevMessage: ChatMessage | null = null) =>
  render(
    <UiPreferencesProvider>
      <MessageComponent message={message} prevMessage={prevMessage} createDiff={() => []} provider="claude" />
    </UiPreferencesProvider>,
  );

describe('the completion time in the assistant footer', () => {
  it('shows the time beside the model label even when the reply is grouped', () => {
    // The screenshot case: a tool row precedes the turn's final prose row, so
    // the reply is grouped and used to render no time at all.
    const { container } = renderMessage(assistantRow(), assistantRow());

    assert.ok(container.querySelector('[title="Answered by claude-opus-5"]'));
    assert.ok(
      (container.textContent || '').includes(ANSWERED_AT_LABEL),
      'a grouped reply must still say when it finished',
    );
  });

  it('shows the time on a reply that starts its turn', () => {
    const { container } = renderMessage(assistantRow());

    assert.ok((container.textContent || '').includes(ANSWERED_AT_LABEL));
  });

  it('shows no time while the reply is still streaming', () => {
    // A streaming row's timestamp is updated as text arrives, so it names the
    // moving frontier rather than a finish time.
    const { container } = renderMessage(
      assistantRow({ isStreaming: true, model: undefined }),
      assistantRow(),
    );

    assert.ok(!(container.textContent || '').includes(ANSWERED_AT_LABEL));
  });
});