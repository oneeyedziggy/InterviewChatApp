import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { UserListPanel } from './UserListPanel';

describe('UserListPanel actions', () => {
  it('keeps entries borderless with rounded corners and a separate menu outline', () => {
    render(
      <UserListPanel
        currentUsername="alice"
        loggedInUsers={['bob']}
        activeUsers={[]}
        userLastSeen={{}}
        blockedUsers={[]}
        onMessageUser={vi.fn()}
        onSendPublicKey={vi.fn()}
        onBlockUser={vi.fn()}
        onUnblockUser={vi.fn()}
      />,
    );
    const actions = screen.getByRole('button', { name: 'Actions for bob' });
    const row = actions.parentElement!;
    expect(getComputedStyle(row).borderTopStyle).toBe('none');
    expect(getComputedStyle(row).borderRadius).toBe('5px');
    expect(getComputedStyle(actions).borderTopStyle).not.toBe('none');
  });

  it('keeps the titled menu control and message/unblock actions accessible', () => {
    const onMessageUser = vi.fn();
    const onUnblockUser = vi.fn();
    render(
      <UserListPanel
        currentUsername="alice"
        loggedInUsers={['alice', 'bob']}
        activeUsers={[]}
        userLastSeen={{}}
        blockedUsers={['bob']}
        onMessageUser={onMessageUser}
        onSendPublicKey={vi.fn()}
        onBlockUser={vi.fn()}
        onUnblockUser={onUnblockUser}
      />,
    );
    const actions = screen.getByRole('button', { name: 'Actions for bob' });
    expect(actions).toHaveAttribute('title', 'Actions for bob');
    fireEvent.click(actions);
    fireEvent.click(screen.getByRole('button', { name: 'Message' }));
    expect(onMessageUser).toHaveBeenCalledWith('bob');
    fireEvent.click(actions);
    fireEvent.click(screen.getByRole('button', { name: 'Unblock' }));
    expect(onUnblockUser).toHaveBeenCalledWith('bob');
  });
});
