import { check } from 'k6';

import { actorForVU, loadFixtureManifest } from './lib/fixtures.js';
import {
  authoritativeRoomIDs,
  connectActor,
  createOpaqueRoom,
  events,
  requestInitialData,
} from './lib/protocol.js';

const manifest = loadFixtureManifest(
  __ENV.FIXTURE_MANIFEST,
  __ENV.PERFORMANCE_RUN_ID,
);

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ['rate==1'],
    ws_connecting: ['p(95)<1000'],
  },
};

export default function () {
  const actor = actorForVU(manifest);
  const state = {
    connected: false,
    initialData: false,
    roomId: '',
    error: '',
  };

  const response = connectActor(manifest.baseUrl, manifest.serverId, {
    timeoutMs: 10000,
    connect(socket) {
      state.connected = true;
      requestInitialData(socket, actor);
    },
    initialData(socket, payload) {
      state.initialData = true;
      const roomIds = authoritativeRoomIDs(payload);
      if (roomIds.length > 0) {
        state.roomId = roomIds[0];
        socket.close();
        return;
      }
      createOpaqueRoom(socket, actor, 'general');
    },
    serverNewRoom(socket, payload) {
      const roomIds = authoritativeRoomIDs(payload);
      if (roomIds.length > 0) {
        state.roomId = roomIds[0];
        socket.close();
      }
    },
    actionResult(socket, payload) {
      if (payload?.success === false) {
        state.error = `${payload.action}:${payload.code}`;
        socket.close();
      }
    },
    error(socket, error) {
      state.error = String(error);
      socket.close();
    },
    timeout() {
      state.error = 'timeout';
    },
  });

  check(response, {
    'websocket upgraded': (value) => value?.status === 101,
    'connect event received': () => state.connected,
    'initial data received': () => state.initialData,
    'authoritative room ID received': () => state.roomId.length > 0,
    'no protocol error': () => state.error === '',
  });
}