import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOCKET_EVENTS } from '../constants';
import { storeIdentityDirectories, getUserIdByUsername } from './identityMap';
import { initializeHomeSocket } from './homeSocketInitializer';
import { type Messages } from '../types/types';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  loadKeysAsync: vi.fn(),
  storeUserPublicKeys: vi.fn(),
  loadUserPublicKeyEntries: vi.fn(),
  encryptForAllUsers: vi.fn(),
  emitSignedMutation: vi.fn(),
  decryptMessageForUser: vi.fn(),
}));

vi.mock('./websocketClient', () => ({ default: mocks.connect }));
vi.mock('./gpg', () => ({
  ...mocks,
  decryptJsonForCurrentUser: vi.fn(),
  verifyDetachedTextSignature: vi.fn(),
}));
vi.mock('./socketAuth', () => ({
  emitSignedMutation: mocks.emitSignedMutation,
}));
vi.mock('./userSettings', () => ({ getBlockedUsers: () => [] }));

describe('home socket bootstrap', () => {
  const roomId = '204506a5-3504-49fc-b0c1-c2d8ea66cfbc';
  let listeners: Map<string, (...args: any[]) => any>;
  let socket: any;
  let args: Parameters<typeof initializeHomeSocket>[0];
  let peerKeys: Record<string, { publicKey: string }>;

  beforeEach(() => {
    vi.resetAllMocks();
    localStorage.clear();
    localStorage.setItem('chat_server_signature_strict', '0');
    listeners = new Map();
    socket = {
      connected: true,
      id: 'socket-a',
      disconnect: vi.fn(),
      emit: vi.fn(),
      on: vi.fn((event, handler) => listeners.set(event, handler)),
      off: vi.fn(),
    };
    peerKeys = {
      'user-a': { publicKey: 'alice-key' },
      'user-b': { publicKey: 'bob-key' },
    };
    mocks.connect.mockReturnValue(socket);
    mocks.loadKeysAsync.mockResolvedValue({
      username: 'alice',
      userId: 'user-a',
      publicKey: 'alice-key',
      privateKey: 'alice-private',
      sessionId: 'session-a',
    });
    mocks.loadUserPublicKeyEntries.mockImplementation(() => peerKeys);
    mocks.storeUserPublicKeys.mockImplementation((next) => {
      peerKeys = next;
    });
    mocks.encryptForAllUsers.mockResolvedValue('encrypted-name');
    mocks.emitSignedMutation.mockResolvedValue(undefined);
    storeIdentityDirectories({
      userDirectory: { 'user-a': 'alice' },
      currentUserId: 'user-a',
      roomDirectory: { [roomId]: 'general' },
    });
    const noop = vi.fn();
    args = {
      authToken: 'session-a',
      username: 'alice',
      setAuthToken: noop,
      setChatValues: noop,
      setUserList: noop,
      setLoggedInUsers: noop,
      setActiveUsers: noop,
      setRoomList: noop,
      setLeftRooms: noop,
      setCurrentRoom: noop,
      setRoomNotifications: noop,
      setUserLastSeen: noop,
      setRoomMembers: noop,
      setActiveJoinRequests: noop,
      getSocket: () => undefined,
      getLeftRooms: () => new Set(),
      getChatValues: () => ({ general: [] }),
      getRoomNotifications: () => ({}),
      getHiddenDmUnreadBaseline: () => ({}),
      getCurrentRoom: () => 'general',
      getRoomList: () => ['general'],
      setHiddenDmUnreadBaseline: noop,
      setSocket: noop,
    };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    delete (window as any).__socket;
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('bootstraps using the stored user id rather than a stale local mapping', async () => {
    storeIdentityDirectories({ userDirectory: { 'stale-id': 'alice' } });
    const dispose = await initializeHomeSocket(args);
    await listeners.get(SOCKET_EVENTS.CONNECT)!();

    expect(mocks.emitSignedMutation).toHaveBeenCalledWith(
      socket,
      expect.objectContaining({
        event: SOCKET_EVENTS.CLIENT_SEND_PUBLIC_KEY,
        userId: 'user-a',
        payload: expect.objectContaining({ fromUserId: 'user-a' }),
      }),
    );
    expect(socket.emit).toHaveBeenCalledWith(
      SOCKET_EVENTS.CLIENT_REQUEST_INITIAL_DATA,
      expect.objectContaining({ userId: 'user-a', sessionId: 'session-a' }),
    );
    expect(getUserIdByUsername('alice')).toBe('user-a');
    dispose();
  });

  it('shares encrypted names when an already-known peer reconnects', async () => {
    const dispose = await initializeHomeSocket(args);
    await listeners.get(SOCKET_EVENTS.SERVER_PUBLIC_KEY_RECEIVED)!({
      fromUserId: 'user-b',
      publicKey: 'bob-key',
    });

    expect(mocks.emitSignedMutation).toHaveBeenCalledWith(
      socket,
      expect.objectContaining({
        event: SOCKET_EVENTS.CLIENT_IDENTITY_DIRECTORY_REFRESH,
        payload: expect.objectContaining({
          refreshedForUserIds: ['user-b'],
          roomNameCiphertexts: { [roomId]: 'encrypted-name' },
        }),
      }),
    );
    dispose();
  });

  it('stores incoming peer keys before submitting the initial name refresh', async () => {
    const dispose = await initializeHomeSocket(args);
    await listeners.get(SOCKET_EVENTS.INITIAL_DATA)!({
      currentUserId: 'user-a',
      userPubKeys: peerKeys,
      rooms: [roomId],
      users: ['user-a', 'user-b'],
      loggedInUsers: ['user-a', 'user-b'],
      activeUsers: [],
    });

    expect(mocks.storeUserPublicKeys).toHaveBeenCalled();
    expect(mocks.emitSignedMutation).toHaveBeenCalled();
    expect(mocks.storeUserPublicKeys.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.emitSignedMutation.mock.invocationCallOrder[0],
    );
    dispose();
  });

  it('keeps an empty server unselected until NEW_ROOM confirms its default room', async () => {
    const newRoomId = 'bootstrap-confirmed-room';
    let currentRoom = 'general';
    let roomList = ['general'];
    let chatValues: Messages = {};
    args.getCurrentRoom = () => currentRoom;
    args.getRoomList = () => roomList;
    args.getChatValues = () => chatValues;
    args.setCurrentRoom = vi.fn((next) => {
      currentRoom = typeof next === 'function' ? next(currentRoom) : next;
    });
    args.setRoomList = vi.fn((next) => {
      roomList = typeof next === 'function' ? next(roomList) : next;
    });
    args.setChatValues = vi.fn((next) => {
      chatValues = typeof next === 'function' ? next(chatValues) : next;
    });
    const dispose = await initializeHomeSocket(args);
    await listeners.get(SOCKET_EVENTS.INITIAL_DATA)!({
      currentUserId: 'user-a',
      rooms: [],
      messages: {},
    });

    expect(currentRoom).toBe('');
    expect(roomList).toEqual([]);
    expect(
      mocks.emitSignedMutation.mock.calls.filter(
        ([, mutation]) => mutation.event === SOCKET_EVENTS.CLIENT_NEW_ROOM,
      ),
    ).toHaveLength(1);
    expect(socket.emit).not.toHaveBeenCalledWith(
      SOCKET_EVENTS.CLIENT_REQUEST_ROOM_DATA,
      expect.anything(),
    );

    mocks.decryptMessageForUser.mockResolvedValue('general');
    await listeners.get(SOCKET_EVENTS.SERVER_NEW_ROOM)!({
      rooms: [newRoomId],
      roomNameCiphertexts: { [newRoomId]: 'encrypted-general' },
      messages: { [newRoomId]: [] },
    });

    expect(currentRoom).toBe('general');
    expect(roomList).toEqual(['general']);
    expect(chatValues).toEqual({ general: [] });
    expect(socket.emit).not.toHaveBeenCalledWith(
      SOCKET_EVENTS.CLIENT_REQUEST_ROOM_DATA,
      expect.anything(),
    );
    dispose();
  });

  it.each([
    { label: 'normal named room', incomingId: roomId, selectedRoom: 'general' },
    {
      label: 'opaque room before metadata resolves',
      incomingId: 'opaque-server-room',
      selectedRoom: 'opaque-server-room',
    },
  ])(
    'requests the selected $label without waiting for React refs',
    async ({ incomingId, selectedRoom }) => {
      args.getCurrentRoom = () => 'previous-tenant-room';
      args.setCurrentRoom = vi.fn();
      const dispose = await initializeHomeSocket(args);
      await listeners.get(SOCKET_EVENTS.INITIAL_DATA)!({
        currentUserId: 'user-a',
        rooms: [incomingId],
        messages: {},
      });

      expect(args.setCurrentRoom).toHaveBeenCalledWith(selectedRoom);
      expect(socket.emit).toHaveBeenCalledWith(
        SOCKET_EVENTS.CLIENT_REQUEST_ROOM_DATA,
        {
          username: 'alice',
          userId: 'user-a',
          sessionId: 'session-a',
          room: selectedRoom,
          roomId: incomingId,
        },
      );
      dispose();
    },
  );

  it('preserves the current non-default named room from the incoming server list', async () => {
    const selectedRoomId = 'current-server-project-room';
    storeIdentityDirectories({
      roomDirectory: { [selectedRoomId]: 'project' },
    });
    args.getCurrentRoom = () => 'project';
    args.setCurrentRoom = vi.fn();
    const dispose = await initializeHomeSocket(args);
    await listeners.get(SOCKET_EVENTS.INITIAL_DATA)!({
      currentUserId: 'user-a',
      rooms: [roomId, selectedRoomId],
      messages: {},
    });

    expect(args.setCurrentRoom).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith(
      SOCKET_EVENTS.CLIENT_REQUEST_ROOM_DATA,
      expect.objectContaining({ room: 'project', roomId: selectedRoomId }),
    );
    dispose();
  });

  it('matches a selected name against incoming IDs despite a stale reverse mapping', async () => {
    storeIdentityDirectories({
      roomDirectory: { 'other-tenant-general': 'general' },
    });
    const dispose = await initializeHomeSocket(args);
    await listeners.get(SOCKET_EVENTS.INITIAL_DATA)!({
      currentUserId: 'user-a',
      rooms: [roomId],
      messages: {},
    });

    expect(socket.emit).toHaveBeenCalledWith(
      SOCKET_EVENTS.CLIENT_REQUEST_ROOM_DATA,
      expect.objectContaining({ room: 'general', roomId }),
    );
    expect(socket.emit).not.toHaveBeenCalledWith(
      SOCKET_EVENTS.CLIENT_REQUEST_ROOM_DATA,
      expect.objectContaining({ roomId: 'other-tenant-general' }),
    );
    dispose();
  });

  it('registers every server event handler and disposes its listeners', async () => {
    const dispose = await initializeHomeSocket(args);
    const requiredEvents = [
      SOCKET_EVENTS.SERVER_ACTION_RESULT,
      SOCKET_EVENTS.INITIAL_DATA,
      SOCKET_EVENTS.SERVER_MESSAGE,
      SOCKET_EVENTS.SERVER_NEW_ROOM,
      SOCKET_EVENTS.SERVER_IDENTITY_DIRECTORY_REFRESH,
      SOCKET_EVENTS.SERVER_USER_LIST_UPDATE,
      SOCKET_EVENTS.SERVER_JOIN_REQUEST,
      SOCKET_EVENTS.SERVER_JOIN_APPROVED,
      SOCKET_EVENTS.SERVER_JOIN_DENIED,
      SOCKET_EVENTS.SERVER_ACCESS_REQUEST,
      SOCKET_EVENTS.SERVER_ACCESS_DENIED,
      SOCKET_EVENTS.SERVER_VOTE_UPDATE,
      SOCKET_EVENTS.SERVER_PUBLIC_KEY_RECEIVED,
    ];
    expect(Array.from(listeners.keys())).toEqual(
      expect.arrayContaining(requiredEvents),
    );

    const registeredCount = listeners.size;
    dispose();
    expect(socket.off).toHaveBeenCalledTimes(registeredCount);
    expect(socket.disconnect).toHaveBeenCalledOnce();
    expect((window as any).__socket).toBeUndefined();
  });
});
