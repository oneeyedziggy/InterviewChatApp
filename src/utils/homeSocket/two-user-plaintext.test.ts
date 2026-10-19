// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import type { Dispatch, SetStateAction } from 'react';
import type { Messages } from '../../types/types';
import type { Socket } from '../websocketClient';
import type { StoredKeys } from '../gpg';
import { SOCKET_EVENTS } from '../../constants';
import { twoUserCrypto } from '../../test-utils/twoUserCrypto';

const keyLookup = vi.hoisted(() => ({ loadKeysAsync: vi.fn() }));

vi.mock('../gpg', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../gpg')>()),
  loadKeysAsync: keyLookup.loadKeysAsync,
}));

const aliceId = '11111111-1111-4111-8111-111111111111';
const bobId = '22222222-2222-4222-8222-222222222222';
const roomId = '33333333-3333-4333-8333-333333333333';
const roomName = 'Two-user observatory';
const aliceName = 'Alice plaintext sentinel';
const bobName = 'Bob plaintext sentinel';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, String(value));
  }
}

const loadRuntime = async () => {
  const gpg = await import('../gpg');
  const [
    context,
    identity,
    signatures,
    refresh,
    initial,
    message,
    publicKey,
    actions,
    dm,
    hashing,
  ] = await Promise.all([
    import('./handlers/context'),
    import('../identityMap'),
    import('./serverSignature'),
    import('./handlers/identityRefresh'),
    import('./handlers/initialData'),
    import('./handlers/serverMessage'),
    import('./handlers/publicKey'),
    import('../homeActions'),
    import('../dmRooms'),
    import('../crypto/sha256'),
  ]);
  return {
    context,
    identity,
    gpg,
    signatures,
    refresh,
    initial,
    message,
    publicKey,
    actions,
    dm,
    hashing,
  };
};

type Runtime = Awaited<ReturnType<typeof loadRuntime>>;
type Payload = Record<string, any>;
type Emission = { event: string; payload: Payload };
type Client = Awaited<ReturnType<typeof makeClient>>;

const activate = (client: { storage: Storage; keys: StoredKeys }) => {
  vi.stubGlobal('localStorage', client.storage);
  keyLookup.loadKeysAsync.mockResolvedValue(client.keys);
};

const makeClient = async (keys: StoredKeys) => {
  const storage = new MemoryStorage();
  activate({ storage, keys });
  storage.setItem('chat_server_signature_strict', 'true');
  vi.resetModules();
  const runtime = await loadRuntime();
  const state = {
    chat: { [roomId]: [] } as Messages,
    room: keys.userId === aliceId ? roomName : roomId,
    rooms: [keys.userId === aliceId ? roomName : roomId],
    users: [aliceId, bobId],
    loggedIn: [aliceId, bobId],
    active: [aliceId, bobId],
    left: new Set<string>(),
    notifications: {} as Record<string, number>,
    baseline: {} as Record<string, number>,
  };
  const setter =
    <StateKey extends keyof typeof state>(
      key: StateKey,
    ): Dispatch<SetStateAction<(typeof state)[StateKey]>> =>
    (next) => {
      state[key] =
        typeof next === 'function'
          ? (
              next as (
                previous: (typeof state)[StateKey],
              ) => (typeof state)[StateKey]
            )(state[key])
          : next;
    };
  const emissions: Emission[] = [];
  const socket = {
    id: `socket-${keys.userId}`,
    connected: true,
    emit: (event: string, payload: Payload) =>
      emissions.push({ event, payload }),
  } as unknown as Socket;
  const noop = () => {};
  const context = runtime.context.createHomeSocketContext(
    {
      username: keys.username,
      authToken: keys.sessionId!,
      setAuthToken: noop,
      setChatValues: setter('chat'),
      setUserList: setter('users'),
      setLoggedInUsers: setter('loggedIn'),
      setActiveUsers: setter('active'),
      setRoomList: setter('rooms'),
      setLeftRooms: setter('left'),
      setCurrentRoom: setter('room'),
      setRoomNotifications: setter('notifications'),
      setHiddenDmUnreadBaseline: setter('baseline'),
      setUserLastSeen: noop,
      setRoomMembers: noop,
      setActiveJoinRequests: noop,
      getSocket: () => socket,
      setSocket: noop,
      getChatValues: () => state.chat,
      getCurrentRoom: () => state.room,
      getRoomList: () => state.rooms,
      getLeftRooms: () => state.left,
      getRoomNotifications: () => state.notifications,
      getHiddenDmUnreadBaseline: () => state.baseline,
    },
    socket,
  );
  const listeners = new Map<
    string,
    (payload: Payload) => void | Promise<void>
  >();
  const on = (
    event: string,
    handler: (payload: Payload) => void | Promise<void>,
  ) => {
    listeners.set(event, handler);
  };
  runtime.refresh.registerIdentityRefreshHandler(context, on);
  runtime.initial.registerInitialDataHandler(context, on);
  runtime.message.registerServerMessageHandler(context, on);
  runtime.publicKey.registerPublicKeyHandler(context, on);
  runtime.gpg.storeUserPublicKeys({ [keys.userId!]: keys.publicKey });
  if (keys.userId === aliceId) {
    runtime.identity.storeIdentityDirectories({
      currentUserId: aliceId,
      userDirectory: { [aliceId]: aliceName },
      roomDirectory: { [roomId]: roomName },
    });
  } else {
    runtime.identity.storeIdentityDirectories({ currentUserId: bobId });
  }
  return { keys, storage, runtime, state, socket, emissions, listeners };
};

let fixtures: Awaited<ReturnType<typeof twoUserCrypto>>;
let alice: Client;
let bob: Client;

const signedServerPayload = async (
  client: Client,
  event: string,
  payload: Payload,
) => {
  const { signatures, hashing, gpg } = client.runtime;
  const serverAuth = {
    version: 'v1',
    event,
    timestamp: Date.now(),
    nonce: crypto.randomUUID(),
    payloadHash: await hashing.sha256Hex(signatures.goJsonStringify(payload)),
    signature: '',
  };
  serverAuth.signature = await gpg.signDetachedText(
    signatures.buildServerSigningInput(serverAuth),
    fixtures.server.privateKey,
  );
  return { ...payload, serverAuth };
};

const receive = async (client: Client, event: string, payload: Payload) => {
  activate(client);
  expect(client.runtime.signatures.isServerSignatureStrictMode()).toBe(true);
  const signed = await signedServerPayload(client, event, payload);
  const verified = await client.runtime.signatures.verifyServerEventEnvelope(
    event,
    signed,
  );
  expect(
    verified,
    JSON.stringify({
      event,
      warnings: vi.mocked(console.warn).mock.calls,
      errors: vi.mocked(console.error).mock.calls,
    }),
  ).toBe(true);
  const listener = client.listeners.get(event);
  expect(listener).toBeDefined();
  await listener!(signed);
};

const lastEmission = (client: Client, event: string) => {
  const emission = client.emissions
    .filter((entry) => entry.event === event)
    .at(-1);
  expect(emission, `expected actual ${event} emission`).toBeDefined();
  return emission!.payload;
};

const verifyMutation = async (
  client: Client,
  event: string,
  payload: Payload,
) => {
  const auth = payload.auth;
  expect(auth).toMatchObject({
    event,
    userId: client.keys.userId,
    sessionId: client.keys.sessionId,
    version: 'v1',
  });
  const claims = Object.keys(auth.claims)
    .sort()
    .map(
      (key) =>
        `${key}=${Buffer.from(auth.claims[key], 'utf8').toString('base64url')}`,
    )
    .join('&');
  const text = [
    auth.version,
    auth.event,
    auth.userId,
    auth.sessionId,
    String(auth.timestamp),
    auth.nonce,
    claims,
  ].join('|');
  expect(
    await client.runtime.gpg.verifyDetachedTextSignature(
      text,
      auth.signature,
      client.keys.publicKey,
    ),
  ).toBe(true);
};

const refreshResponse = (payload: Payload) => ({
  refreshedByUserId: payload.userId,
  refreshedForUserIds: payload.refreshedForUserIds,
  roomNameCiphertexts: payload.roomNameCiphertexts,
  roomDirectoryUpdatedAt: payload.roomDirectoryUpdatedAt,
  userDirectoryCiphertexts: payload.userDirectoryCiphertexts,
  userDirectoryUpdatedAt: payload.userDirectoryUpdatedAt,
});

const discoverAndRefresh = async () => {
  activate(bob);
  expect(bob.runtime.identity.getUsernameByUserId(aliceId)).toBeUndefined();
  expect(bob.runtime.identity.getRoomNameByRoomId(roomId)).toBeUndefined();
  activate(alice);
  expect(alice.runtime.identity.getUserDirectorySnapshot()).toEqual({
    [aliceId]: aliceName,
  });
  const ownerName = await alice.runtime.gpg.encryptForAllUsers(
    aliceName,
    {},
    alice.keys.publicKey,
  );
  const ownerRoom = await alice.runtime.gpg.encryptForAllUsers(
    roomName,
    {},
    alice.keys.publicKey,
  );
  await receive(bob, SOCKET_EVENTS.INITIAL_DATA, {
    currentUserId: bobId,
    rooms: [roomId, 'general'],
    messages: { [roomId]: [] },
    users: [aliceId, bobId],
    loggedInUsers: [aliceId, bobId],
    activeUsers: [aliceId, bobId],
    userPubKeys: {
      [aliceId]: alice.keys.publicKey,
      [bobId]: bob.keys.publicKey,
    },
    userDirectoryCiphertexts: { [aliceId]: ownerName },
    roomNameCiphertexts: { [roomId]: ownerRoom },
  });
  expect(bob.state.room).toBe(roomId);
  expect(bob.state.users).toEqual([aliceId, bobId]);
  expect(bob.runtime.identity.getRoomNameByRoomId(roomId)).toBeUndefined();
  const reciprocal = lastEmission(
    bob,
    SOCKET_EVENTS.CLIENT_IDENTITY_DIRECTORY_REFRESH,
  );
  await verifyMutation(
    bob,
    SOCKET_EVENTS.CLIENT_IDENTITY_DIRECTORY_REFRESH,
    reciprocal,
  );
  await receive(alice, SOCKET_EVENTS.SERVER_PUBLIC_KEY_RECEIVED, {
    fromUserId: bobId,
    publicKey: bob.keys.publicKey,
    publicKeyUpdatedAt: Date.now(),
  });
  const refresh = lastEmission(
    alice,
    SOCKET_EVENTS.CLIENT_IDENTITY_DIRECTORY_REFRESH,
  );
  await verifyMutation(
    alice,
    SOCKET_EVENTS.CLIENT_IDENTITY_DIRECTORY_REFRESH,
    refresh,
  );
  expect(refresh.refreshedForUserIds).toEqual([bobId]);
  await receive(
    bob,
    SOCKET_EVENTS.SERVER_IDENTITY_DIRECTORY_REFRESH,
    refreshResponse(refresh),
  );
  expect(bob.state.room).toBe(roomName);
  expect(
    bob.state.rooms.map(
      (room) => bob.runtime.identity.getRoomNameByRoomId(room) || room,
    ),
  ).toContain(roomName);
  expect(bob.state.chat[roomId]).toBeUndefined();
  expect(bob.state.chat[roomName]).toEqual([]);
  expect(bob.state.users).toEqual([aliceName, bobId]);
  await receive(
    alice,
    SOCKET_EVENTS.SERVER_IDENTITY_DIRECTORY_REFRESH,
    refreshResponse(reciprocal),
  );
  expect(alice.state.users).toEqual([aliceName, bobName]);
  await receive(
    bob,
    SOCKET_EVENTS.SERVER_IDENTITY_DIRECTORY_REFRESH,
    refreshResponse(reciprocal),
  );
  expect(bob.state.users).toEqual([aliceName, bobName]);
  for (const client of [alice, bob]) {
    activate(client);
    expect(client.runtime.identity.getRoomIdByName(roomName)).toBe(roomId);
    expect(client.runtime.identity.getUserDirectorySnapshot()).toEqual({
      [aliceId]: aliceName,
      [bobId]: bobName,
    });
    expect(client.state.loggedIn).toEqual([aliceName, bobName]);
    expect(client.state.active).toEqual([aliceName, bobName]);
  }
};

describe('two-user plaintext through real client socket handlers', () => {
  beforeEach(async () => {
    vi.stubGlobal('crypto', webcrypto);
    const browser = new EventTarget();
    vi.stubGlobal(
      'window',
      Object.assign(browser, {
        location: { origin: 'http://localhost', search: '', pathname: '/' },
        setTimeout,
        clearTimeout,
      }),
    );
    vi.stubGlobal('alert', vi.fn());
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fixtures = await twoUserCrypto();
    expect(
      new Set([
        fixtures.alice.publicKey,
        fixtures.bob.publicKey,
        fixtures.server.publicKey,
      ]).size,
    ).toBe(3);
    const keys = (
      name: string,
      userId: string,
      pair: typeof fixtures.alice,
    ): StoredKeys => ({
      username: name,
      userId,
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
      sessionId: `session-${userId}`,
      serverPublicKey: fixtures.server.publicKey,
    });
    alice = await makeClient(keys(aliceName, aliceId, fixtures.alice));
    bob = await makeClient(keys(bobName, bobId, fixtures.bob));
  }, 60_000);

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('discovers peer keys and exchanges readable names while reconciling opaque room state', async () => {
    await discoverAndRefresh();
  }, 60_000);

  it.each(['shared room', 'DM'])(
    'sends plaintext both ways in a %s and deduplicates history',
    async (kind) => {
      await discoverAndRefresh();
      const wireRoom =
        kind === 'DM' ? alice.runtime.dm.getDmRoomId(aliceId, bobId) : roomId;
      const displayRoom = kind === 'DM' ? wireRoom : roomName;
      for (const client of [alice, bob]) {
        client.state.room = displayRoom;
        client.state.rooms.push(displayRoom);
      }
      const history: Payload[] = [];
      for (const sender of [alice, bob]) {
        activate(sender);
        const body = `${sender.keys.username} says hello in ${kind}`;
        const clearDraft = vi.fn();
        await sender.runtime.actions.doSendAction({
          socket: sender.socket,
          userDraftMessage: body,
          currentRoom: displayRoom,
          editingMessageTimestamp: undefined,
          editingMessageId: undefined,
          blockedUsers: [],
          username: sender.keys.username,
          replyingTo: undefined,
          setEditingMessageTimestamp: vi.fn(),
          setEditingMessageId: vi.fn(),
          setUserDraftMessage: clearDraft,
          setReplyingTo: vi.fn(),
        });
        const sent = lastEmission(sender, SOCKET_EVENTS.CLIENT_MESSAGE);
        expect(sent.roomId).toBe(wireRoom);
        expect(sent.content).toBeUndefined();
        expect(sent.encryptedMessage).not.toContain(body);
        expect(clearDraft).toHaveBeenCalledWith('');
        await verifyMutation(sender, SOCKET_EVENTS.CLIENT_MESSAGE, sent);
        const message = {
          id: `message-${sender.keys.userId}-${kind}`,
          userId: sender.keys.userId,
          roomId: wireRoom,
          timestamp: Date.now() + history.length,
          content: '',
          encryptedMessage: sent.encryptedMessage,
        };
        history.push(message);
        for (const receiver of [alice, bob]) {
          await receive(receiver, SOCKET_EVENTS.SERVER_MESSAGE, {
            messages: { [wireRoom]: [message] },
          });
          expect(
            receiver.state.chat[displayRoom].find(
              (entry) => entry.id === message.id,
            ),
          ).toMatchObject({
            content: body,
            userId: sender.keys.userId,
            roomId: wireRoom,
          });
          expect(
            receiver.runtime.identity.getUsernameByUserId(sender.keys.userId!),
          ).toBe(sender.keys.username);
        }
      }
      for (const receiver of [alice, bob]) {
        await receive(receiver, SOCKET_EVENTS.INITIAL_DATA, {
          messages: { [wireRoom]: history },
          rooms: [wireRoom],
          users: [aliceId, bobId],
          currentUserId: receiver.keys.userId,
        });
        expect(receiver.state.chat[displayRoom]).toHaveLength(2);
        expect(
          new Set(receiver.state.chat[displayRoom].map((message) => message.id))
            .size,
        ).toBe(2);
        if (kind === 'DM') {
          expect(
            receiver.runtime.dm.getDmDisplayName(
              wireRoom,
              receiver.keys.username,
            ),
          ).toBe(`@${receiver === alice ? bobName : aliceName}`);
        }
      }
    },
    60_000,
  );

  it('rejects unsigned message events instead of accepting forged plaintext', async () => {
    activate(bob);
    await bob.listeners.get(SOCKET_EVENTS.SERVER_MESSAGE)!({
      messages: {
        [roomId]: [
          {
            id: 'forged',
            userId: aliceId,
            content: 'Forged plaintext',
            timestamp: 1,
          },
        ],
      },
    });
    expect(bob.state.chat[roomId]).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Rejected unsigned or invalid'),
    );
  });

  it('does not display a message whose recipient set excludes Bob', async () => {
    await discoverAndRefresh();
    activate(alice);
    const encryptedMessage = await alice.runtime.gpg.encryptForAllUsers(
      'Alice only plaintext',
      {},
      alice.keys.publicKey,
    );
    await receive(bob, SOCKET_EVENTS.SERVER_MESSAGE, {
      messages: {
        [roomId]: [
          {
            id: 'alice-only',
            userId: aliceId,
            roomId,
            timestamp: Date.now(),
            content: '',
            encryptedMessage,
          },
        ],
      },
    });
    expect(bob.state.chat[roomName]).toEqual([]);
    expect(console.error).toHaveBeenCalled();
  }, 60_000);
});
