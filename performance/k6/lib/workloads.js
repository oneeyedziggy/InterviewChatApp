import { check } from 'k6';

import { actorForVU } from './fixtures.js';
import {
  authoritativeRoomIDs,
  connectActor,
  createOpaqueRoom,
  events,
  requestInitialData,
  sendOpaqueMessage,
} from './protocol.js';
import {
  broadcastLatency,
  deliveryMisses,
  duplicateDeliveries,
  mutationLatency,
  protocolErrors,
  successfulIterations,
} from './metrics.js';

function failState(state, error) {
  if (!state.error) {
    state.error = String(error);
    protocolErrors.add(1);
  }
}

function payloadContainsCiphertext(payload, ciphertext) {
  const rooms = payload?.messages;
  if (!rooms || typeof rooms !== 'object') return false;
  for (const messages of Object.values(rooms)) {
    if (
      Array.isArray(messages) &&
      messages.some((message) => message?.encryptedMessage === ciphertext)
    ) {
      return true;
    }
  }
  return false;
}

export function connectionIteration(manifest, holdMs = 1000) {
  const actor = actorForVU(manifest);
  const state = { connected: false, error: '' };
  const response = connectActor(manifest.baseUrl, manifest.serverId, {
    timeoutMs: holdMs + 5000,
    connect(socket) {
      state.connected = true;
      socket.setTimeout(() => socket.close(), holdMs);
    },
    error(socket, error) {
      failState(state, error);
      socket.close();
    },
    timeout() {
      failState(state, 'connection timeout');
    },
  });
  const success = response?.status === 101 && state.connected && !state.error;
  successfulIterations.add(success);
  check(state, {
    'connection workload succeeded': () => success,
  });
}

export function messageIteration(manifest, options = {}) {
  const actor = actorForVU(manifest);
  const roomName = options.roomName || 'general';
  const ciphertextBytes = Math.max(16, Number(options.ciphertextBytes || 256));
  const marker = `perf-msg-v1:${__VU}:${__ITER}:${Date.now()}:`;
  const ciphertext = marker + 'x'.repeat(Math.max(0, ciphertextBytes - marker.length));
  const state = {
    connected: false,
    initialData: false,
    roomId: '',
    sentAt: 0,
    firstDeliveryAt: 0,
    deliveries: 0,
    error: '',
  };

  const sendMessage = (socket) => {
    if (!state.roomId || state.sentAt) return;
    state.sentAt = Date.now();
    sendOpaqueMessage(socket, actor, state.roomId, ciphertext);
  };

  const response = connectActor(manifest.baseUrl, manifest.serverId, {
    timeoutMs: Number(options.timeoutMs || 15000),
    connect(socket) {
      state.connected = true;
      requestInitialData(socket, actor);
    },
    initialData(socket, payload) {
      state.initialData = true;
      const roomIds = authoritativeRoomIDs(payload);
      if (roomIds.length > 0) {
        state.roomId = roomIds[0];
        sendMessage(socket);
      } else {
        createOpaqueRoom(socket, actor, roomName);
      }
    },
    serverNewRoom(socket, payload) {
      const roomIds = authoritativeRoomIDs(payload);
      if (!state.roomId && roomIds.length > 0) {
        state.roomId = roomIds[0];
        sendMessage(socket);
      }
    },
    serverMessage(socket, payload) {
      if (!payloadContainsCiphertext(payload, ciphertext)) return;
      state.deliveries += 1;
      if (state.deliveries === 1) {
        state.firstDeliveryAt = Date.now();
        const elapsed = state.firstDeliveryAt - state.sentAt;
        mutationLatency.add(elapsed);
        broadcastLatency.add(elapsed);
        socket.setTimeout(() => socket.close(), Number(options.duplicateWindowMs || 50));
      } else {
        duplicateDeliveries.add(1);
      }
    },
    actionResult(socket, payload) {
      if (payload?.success === false) {
        failState(state, `${payload.action}:${payload.code}`);
        socket.close();
      }
    },
    error(socket, error) {
      failState(state, error);
      socket.close();
    },
    timeout() {
      failState(state, 'message timeout');
    },
  });

  if (state.deliveries === 0) {
    deliveryMisses.add(1);
  }
  const success =
    response?.status === 101 &&
    state.connected &&
    state.initialData &&
    state.roomId !== '' &&
    state.deliveries > 0 &&
    state.error === '';
  successfulIterations.add(success);
  check(state, {
    'message workload succeeded': () => success,
  });
}