import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HomeCenterPanel } from './HomeCenterPanel';

const composerMock = vi.hoisted(() => ({
  useHomeComposer: vi.fn(),
}));

let composerState: any = null;

const presenceMock = vi.hoisted(() => ({
  useHomePresence: vi.fn(),
}));

let presenceState: any = null;

vi.mock('../../contexts/home/useHomePageSelectors', () => ({
  useHomeComposer: composerMock.useHomeComposer,
  useHomePresence: presenceMock.useHomePresence,
}));

const renderMessageThreadMock = vi.fn(() => (
  <div data-testid="message-thread">thread</div>
));

vi.mock('./MessageThread', () => ({
  renderMessageThread: (...args: unknown[]) => renderMessageThreadMock(...args),
}));

describe('HomeCenterPanel', () => {
  beforeEach(() => {
    composerState = {
      chatValues: { general: [] },
      currentRoom: 'general',
      username: 'alice',
      blockedUsers: [],
      replyingTo: undefined,
      editingMessageTimestamp: undefined,
      editingMessageId: undefined,
      socket: { connected: true },
      userDraftMessage: '',
      handleRequestAccess: vi.fn(),
      handleGrantAccess: vi.fn(),
      handleSelectVersion: vi.fn(),
      handleReply: vi.fn(),
      handleEdit: vi.fn(),
      handleDeleteMessage: vi.fn(),
      handleVote: vi.fn(),
      setUserDraftMessage: vi.fn(),
      onDraftKeyDownHandler: vi.fn(),
      handleCancelReplyOrEdit: vi.fn(),
      doSend: vi.fn(),
    };
    composerMock.useHomeComposer.mockReturnValue(composerState);

    presenceState = {
      handleMessageUser: vi.fn(),
      handleSendPublicKeyToUser: vi.fn(),
      handleImportTransferredAccount: vi.fn(),
      handleBlockUser: vi.fn(),
      handleUnblockUser: vi.fn(),
    };
    presenceMock.useHomePresence.mockReturnValue(presenceState);

    renderMessageThreadMock.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the message thread and composer for the active room', () => {
    render(<HomeCenterPanel />);

    expect(screen.getByTestId('message-thread')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Type something')).toBeInTheDocument();
    expect(renderMessageThreadMock).toHaveBeenCalledTimes(1);
  });

  it('shows reply/edit state and byte counter when over the warning limit', async () => {
    const user = userEvent.setup();
    const replyState = {
      chatValues: { general: [] },
      currentRoom: 'general',
      username: 'alice',
      blockedUsers: [],
      replyingTo: 123,
      editingMessageTimestamp: 456,
      editingMessageId: 'message-1',
      socket: { connected: true },
      userDraftMessage: 'x'.repeat(1001),
      handleRequestAccess: vi.fn(),
      handleGrantAccess: vi.fn(),
      handleSelectVersion: vi.fn(),
      handleReply: vi.fn(),
      handleEdit: vi.fn(),
      handleDeleteMessage: vi.fn(),
      handleVote: vi.fn(),
      setUserDraftMessage: vi.fn(),
      onDraftKeyDownHandler: vi.fn(),
      handleCancelReplyOrEdit: vi.fn(),
      doSend: vi.fn(),
    };
    composerMock.useHomeComposer.mockReturnValue(replyState as any);

    render(<HomeCenterPanel />);

    expect(screen.getByPlaceholderText(/editing message/i)).toBeInTheDocument();
    expect(screen.getByText(/1001\/1000 bytes/i)).toBeInTheDocument();
    expect(
      screen.getByText(/max message size is 1000 bytes/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'X' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'X' }));
    expect(replyState.handleCancelReplyOrEdit).toHaveBeenCalled();
  });
});
