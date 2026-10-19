import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { useHomeSessionLifecycle } from './useHomeSessionLifecycle';

const mocks = vi.hoisted(() => ({
  restoreSession: vi.fn(),
  revalidateSessionIfStale: vi.fn(),
  initializeHomeSocket: vi.fn(),
}));

vi.mock('../../utils/homeSession', () => ({ ...mocks }));
vi.mock('../../utils/homeSocketInitializer', () => ({
  initializeHomeSocket: mocks.initializeHomeSocket,
}));
vi.mock('../../utils/userSettings', () => ({ getBlockedUsers: () => [] }));

describe('useHomeSessionLifecycle', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.restoreSession.mockImplementation(async (options) => {
      await options.initializeSession('session-a', 'alice');
    });
    mocks.revalidateSessionIfStale.mockImplementation(async (options) => {
      await options.initializeSession('session-a', 'alice');
    });
    mocks.initializeHomeSocket.mockResolvedValue(vi.fn());
  });

  afterEach(() => vi.restoreAllMocks());

  it('keeps the connected socket when foreground verification restores the same session', async () => {
    const socket = { connected: true, disconnect: vi.fn() };
    const setSocket = vi.fn();
    const onForceReauth = vi.fn();
    const noop = vi.fn();
    const { unmount } = renderHook(() => {
      const [authToken, setAuthToken] = useState('');
      const [username, setUsername] = useState('');
      useHomeSessionLifecycle({
        authToken, username, setAuthToken, setUsername,
        setBlockedUsers: noop, setChatValues: noop, setUserList: noop,
        setLoggedInUsers: noop, setActiveUsers: noop, setRoomList: noop,
        setCurrentRoom: noop, setRoomNotifications: noop, setUserLastSeen: noop,
        setRoomMembers: noop, setActiveJoinRequests: noop,
        setIsSwitchingServer: noop, onForceReauth,
        getSocket: () => socket as any, getLeftRooms: () => new Set(),
        getChatValues: () => ({}), getRoomNotifications: () => ({}),
        getHiddenDmUnreadBaseline: () => ({}), setLeftRooms: noop,
        setHiddenDmUnreadBaseline: noop, getCurrentRoom: () => '',
        getRoomList: () => [], setSocket,
      });
    });

    await waitFor(() => expect(mocks.initializeHomeSocket).toHaveBeenCalledTimes(1));
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(mocks.revalidateSessionIfStale).toHaveBeenCalledTimes(1);
    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(setSocket).not.toHaveBeenCalled();
    expect(mocks.initializeHomeSocket).toHaveBeenCalledTimes(1);
    expect(onForceReauth).not.toHaveBeenCalled();
    unmount();
  });
});