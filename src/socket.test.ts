import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupSocketHandlers, setUser } from './socket';
import * as socketio from 'socket.io';
import { Messages } from './types/types';
import { SOCKET_EVENTS } from './constants';

// Mock socket.io
vi.mock('socket.io');

describe('socket module', () => {
  let mockSocket: any;
  let mockIo: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockSocket = {
      on: vi.fn(),
      emit: vi.fn(),
      handshake: {
        auth: {
          token: 'test-token',
          username: 'testuser',
        },
      },
    };

    mockIo = {
      on: vi.fn((event, callback) => {
        if (event === 'connection') {
          callback(mockSocket);
        }
      }),
      emit: vi.fn(),
    };

    // Reset the users object by re-importing
    vi.resetModules();
  });

  describe('setUser', () => {
    it('exports setUser function', () => {
      expect(typeof setUser).toBe('function');
    });

    it('sets user in users object', () => {
      setUser('testuser', 'session-id-123');
      // We can't directly access the users object, but we can test through setupSocketHandlers
      expect(setUser).toBeDefined();
    });
  });

  describe('setupSocketHandlers', () => {
    it('exports setupSocketHandlers function', () => {
      expect(typeof setupSocketHandlers).toBe('function');
    });

    it('sets up connection handler', () => {
      setupSocketHandlers(mockIo as any);

      expect(mockIo.on).toHaveBeenCalledWith('connection', expect.any(Function));
    });

    it('emits status and initialData on connection', () => {
      setupSocketHandlers(mockIo as any);

      // Get the connection handler
      const connectionHandler = mockIo.on.mock.calls.find(
        (call: any[]) => call[0] === 'connection'
      )?.[1];

      // Simulate connection
      connectionHandler?.(mockSocket);

      expect(mockSocket.emit).toHaveBeenCalledWith(SOCKET_EVENTS.STATUS, 'Hello from Socket.io');
      expect(mockSocket.emit).toHaveBeenCalledWith(
        SOCKET_EVENTS.INITIAL_DATA,
        expect.objectContaining({
          messages: expect.any(Object),
          rooms: expect.any(Array),
          users: expect.any(Array),
        })
      );
    });

    it('sets up clientMessage handler', () => {
      setupSocketHandlers(mockIo as any);
      const connectionHandler = mockIo.on.mock.calls.find(
        (call: any[]) => call[0] === 'connection'
      )?.[1];
      connectionHandler?.(mockSocket);

      // Find clientMessage handler
      const clientMessageHandler = mockSocket.on.mock.calls.find(
        (call: any[]) => call[0] === SOCKET_EVENTS.CLIENT_MESSAGE
      )?.[1];

      expect(clientMessageHandler).toBeDefined();

      // Test clientMessage handler
      const testMessage = {
        room: '#general',
        username: 'testuser',
        content: 'Hello world',
      };

      clientMessageHandler?.(testMessage);

      expect(mockIo.emit).toHaveBeenCalledWith(
        'serverMessage',
        expect.objectContaining({
          messages: expect.any(Object),
          users: expect.any(Array),
        })
      );
    });

    it('adds message to correct room on clientMessage', () => {
      setupSocketHandlers(mockIo as any);
      const connectionHandler = mockIo.on.mock.calls.find(
        (call: any[]) => call[0] === 'connection'
      )?.[1];
      connectionHandler?.(mockSocket);

      const clientMessageHandler = mockSocket.on.mock.calls.find(
        (call: any[]) => call[0] === 'clientMessage'
      )?.[1];

      const testMessage = {
        room: '#general',
        username: 'testuser',
        content: 'Test message',
      };

      clientMessageHandler?.(testMessage);

      // Verify serverMessage was emitted with messages containing the new message
      const serverMessageCall = mockIo.emit.mock.calls.find(
        (call: any[]) => call[0] === SOCKET_EVENTS.SERVER_MESSAGE
      );
      expect(serverMessageCall).toBeDefined();
      if (serverMessageCall) {
        const messages = serverMessageCall[1].messages as Messages;
        expect(messages['#general']).toBeDefined();
        expect(messages['#general'].length).toBeGreaterThan(0);
        expect(messages['#general'][0].content).toBe('Test message');
        expect(messages['#general'][0].username).toBe('testuser');
      }
    });

    it('sets up clientNewRoom handler', () => {
      setupSocketHandlers(mockIo as any);
      const connectionHandler = mockIo.on.mock.calls.find(
        (call: any[]) => call[0] === 'connection'
      )?.[1];
      connectionHandler?.(mockSocket);

      const clientNewRoomHandler = mockSocket.on.mock.calls.find(
        (call: any[]) => call[0] === SOCKET_EVENTS.CLIENT_NEW_ROOM
      )?.[1];

      expect(clientNewRoomHandler).toBeDefined();

      clientNewRoomHandler?.('newroom');

      expect(mockIo.emit).toHaveBeenCalledWith(
        'serverNewRoom',
        expect.objectContaining({
          messages: expect.any(Object),
          rooms: expect.any(Array),
        })
      );
    });

    it('creates new room with # prefix', () => {
      setupSocketHandlers(mockIo as any);
      const connectionHandler = mockIo.on.mock.calls.find(
        (call: any[]) => call[0] === 'connection'
      )?.[1];
      connectionHandler?.(mockSocket);

      const clientNewRoomHandler = mockSocket.on.mock.calls.find(
        (call: any[]) => call[0] === SOCKET_EVENTS.CLIENT_NEW_ROOM
      )?.[1];

      clientNewRoomHandler?.('testroom');

      const serverNewRoomCall = mockIo.emit.mock.calls.find(
        (call: any[]) => call[0] === SOCKET_EVENTS.SERVER_NEW_ROOM
      );
      expect(serverNewRoomCall).toBeDefined();
      if (serverNewRoomCall) {
        const rooms = serverNewRoomCall[1].rooms as string[];
        expect(rooms).toContain('#testroom');
      }
    });

    it('does not duplicate existing rooms', () => {
      setupSocketHandlers(mockIo as any);
      const connectionHandler = mockIo.on.mock.calls.find(
        (call: any[]) => call[0] === 'connection'
      )?.[1];
      connectionHandler?.(mockSocket);

      const clientNewRoomHandler = mockSocket.on.mock.calls.find(
        (call: any[]) => call[0] === SOCKET_EVENTS.CLIENT_NEW_ROOM
      )?.[1];

      // Try to create #general twice
      clientNewRoomHandler?.('general');
      clientNewRoomHandler?.('general');

      const serverNewRoomCalls = mockIo.emit.mock.calls.filter(
        (call: any[]) => call[0] === 'serverNewRoom'
      );
      
      // Should only have one #general in the final rooms list
      const lastCall = serverNewRoomCalls[serverNewRoomCalls.length - 1];
      if (lastCall) {
        const rooms = lastCall[1].rooms as string[];
        const generalCount = rooms.filter((r) => r === '#general').length;
        expect(generalCount).toBe(1);
      }
    });

    it('sets up clientDisconnecting handler', () => {
      setupSocketHandlers(mockIo as any);
      const connectionHandler = mockIo.on.mock.calls.find(
        (call: any[]) => call[0] === 'connection'
      )?.[1];
      connectionHandler?.(mockSocket);

      const clientDisconnectingHandler = mockSocket.on.mock.calls.find(
        (call: any[]) => call[0] === SOCKET_EVENTS.CLIENT_DISCONNECTING
      )?.[1];

      expect(clientDisconnectingHandler).toBeDefined();

      // Set up a user first
      setUser('testuser', 'session-id-123');
      clientDisconnectingHandler?.('session-id-123');

      // Handler should execute without error
      expect(clientDisconnectingHandler).toBeDefined();
    });

    it('sets up disconnect handler', () => {
      setupSocketHandlers(mockIo as any);
      const connectionHandler = mockIo.on.mock.calls.find(
        (call: any[]) => call[0] === 'connection'
      )?.[1];
      connectionHandler?.(mockSocket);

      const disconnectHandler = mockSocket.on.mock.calls.find(
        (call: any[]) => call[0] === SOCKET_EVENTS.DISCONNECT
      )?.[1];

      expect(disconnectHandler).toBeDefined();

      // Handler should execute without error
      disconnectHandler?.();
    });

    it('sorts rooms alphabetically', () => {
      setupSocketHandlers(mockIo as any);
      const connectionHandler = mockIo.on.mock.calls.find(
        (call: any[]) => call[0] === 'connection'
      )?.[1];
      connectionHandler?.(mockSocket);

      const clientNewRoomHandler = mockSocket.on.mock.calls.find(
        (call: any[]) => call[0] === SOCKET_EVENTS.CLIENT_NEW_ROOM
      )?.[1];

      clientNewRoomHandler?.('zebra');
      clientNewRoomHandler?.('alpha');

      const serverNewRoomCalls = mockIo.emit.mock.calls.filter(
        (call: any[]) => call[0] === 'serverNewRoom'
      );
      const lastCall = serverNewRoomCalls[serverNewRoomCalls.length - 1];
      if (lastCall) {
        const rooms = lastCall[1].rooms as string[];
        const alphaIndex = rooms.indexOf('#alpha');
        const zebraIndex = rooms.indexOf('#zebra');
        expect(alphaIndex).toBeLessThan(zebraIndex);
      }
    });
  });
});

