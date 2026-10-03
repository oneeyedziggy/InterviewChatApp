import crypto from 'k6/crypto';
import ws from 'k6/ws';
import signedAuth from 'k6/x/signedauth';

import { assertSafeTarget, parseTarget } from './fixtures.js';

export const events = Object.freeze({
  connect: 'connect',
  status: 'status',
  requestInitialData: 'clientRequestInitialData',
  initialData: 'initialData',
  newRoom: 'clientNewRoom',
  serverNewRoom: 'serverNewRoom',
  message: 'clientMessage',
  serverMessage: 'serverMessage',
  actionResult: 'serverActionResult',
});

export function websocketURL(baseURL, serverId = '') {
  assertSafeTarget(baseURL);
  const parsed = parseTarget(baseURL);
  const scheme = parsed.scheme === 'https' || parsed.scheme === 'wss' ? 'wss' : 'ws';
  const path = `${parsed.path.replace(/\/$/, '')}/ws/`;
  const query = serverId ? `?server=${encodeURIComponent(serverId)}` : '';
  return `${scheme}://${parsed.authority}${path}${query}`;
}

export function wireEnvelope(event, payload) {
  return JSON.stringify({ event, payload });
}

export function parseEnvelope(raw) {
  const envelope = JSON.parse(raw);
  if (!envelope || typeof envelope.event !== 'string') {
    throw new Error('invalid WebSocket envelope');
  }
  return envelope;
}

export function signedPayload(actor, event, payload, claims) {
  const auth = signedAuth.sign(
    actor.privateKey,
    event,
    actor.userId,
    actor.sessionId,
    claims,
  );
  return { ...payload, auth };
}

export function sendEvent(socket, event, payload) {
  socket.send(wireEnvelope(event, payload));
}

export function sendSignedEvent(socket, actor, event, payload, claims) {
  sendEvent(socket, event, signedPayload(actor, event, payload, claims));
}

export function requestInitialData(socket, actor) {
  sendEvent(socket, events.requestInitialData, {
    userId: actor.userId,
    sessionId: actor.sessionId,
    defaultRoom: 'general',
    currentRoom: 'general',
    currentRoomId: 'general',
    openRooms: ['general'],
    openRoomIds: [],
  });
}

export function createOpaqueRoom(socket, actor, roomName) {
  const timestamp = Date.now();
  const roomNameHash = crypto.sha256(roomName.trim().toLowerCase(), 'hex');
  const roomNameCiphertext = `perf-room-v1:${roomNameHash}`;
  sendSignedEvent(
    socket,
    actor,
    events.newRoom,
    {
      roomNameCiphertext,
      roomNameHash,
      roomDirectoryUpdatedAt: timestamp,
      userId: actor.userId,
      sessionId: actor.sessionId,
    },
    {
      roomNameCiphertext,
      roomNameHash,
      roomDirectoryUpdatedAt: String(timestamp),
    },
  );
}

export function authoritativeRoomIDs(payload) {
  const ciphertexts = payload?.roomNameCiphertexts;
  if (!ciphertexts || typeof ciphertexts !== 'object') {
    return [];
  }
  return Object.keys(ciphertexts).filter((roomId) => roomId.trim() !== '');
}

export function sendOpaqueMessage(socket, actor, roomId, ciphertext) {
  sendSignedEvent(
    socket,
    actor,
    events.message,
    {
      roomId,
      encryptedMessage: ciphertext,
      userId: actor.userId,
      sessionId: actor.sessionId,
    },
    { roomId },
  );
}

export function connectActor(baseURL, serverId, handlers = {}, params = {}) {
  const url = websocketURL(baseURL, serverId);
  return ws.connect(url, params, (socket) => {
    socket.on('open', () => handlers.open?.(socket));
    socket.on('message', (raw) => {
      try {
        const envelope = parseEnvelope(raw);
        handlers.message?.(socket, envelope);
        handlers[envelope.event]?.(socket, envelope.payload, envelope);
      } catch (error) {
        handlers.error?.(socket, error);
      }
    });
    socket.on('error', (error) => handlers.error?.(socket, error));
    socket.on('close', () => handlers.close?.(socket));
    if (handlers.timeoutMs) {
      socket.setTimeout(() => {
        handlers.timeout?.(socket);
        socket.close();
      }, handlers.timeoutMs);
    }
  });
}