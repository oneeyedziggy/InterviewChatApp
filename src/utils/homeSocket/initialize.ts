import connectWebSocket from '../websocketClient';
import { websocketPath } from '@/utils/appPaths';
import { createHomeSocketContext, type InitSocketArgs } from './handlers/context';
import { registerAccessRequestHandlers } from './handlers/accessRequests';
import { registerActionResultHandler } from './handlers/actionResult';
import { registerConnectionHandlers } from './handlers/connection';
import { registerIdentityRefreshHandler } from './handlers/identityRefresh';
import { registerInitialDataHandler } from './handlers/initialData';
import { registerJoinRequestHandlers } from './handlers/joinRequests';
import { registerNewRoomHandler } from './handlers/newRoom';
import { registerPresenceHandler } from './handlers/presence';
import { registerPublicKeyHandler } from './handlers/publicKey';
import { registerServerMessageHandler } from './handlers/serverMessage';
import { registerVoteUpdateHandler } from './handlers/voteUpdate';

export const initializeHomeSocket = async (
  args: InitSocketArgs,
): Promise<() => void> => {
  let previousSocket = args.getSocket();
  if (previousSocket?.connected) {
    previousSocket.disconnect();
    args.setSocket(undefined);
  }

  const windowSocket = (window as Window & { __socket?: typeof previousSocket })
    .__socket;
  if (windowSocket?.connected && windowSocket !== previousSocket) {
    windowSocket.disconnect();
  }

  const socket = connectWebSocket(window.location.origin, {
    path: websocketPath(),
    auth: { username: args.username },
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
  });
  const ctx = createHomeSocketContext(args, socket);
  const registeredEvents = new Set<string>();
  const on = (event: string, handler: (...values: any[]) => void) => {
    registeredEvents.add(event);
    socket.on(event, handler);
  };

  args.setSocket(socket);
  (window as Window & { __socket?: typeof socket }).__socket = socket;

  registerConnectionHandlers(ctx, on);
  registerActionResultHandler(ctx, on);
  registerInitialDataHandler(ctx, on);
  registerServerMessageHandler(ctx, on);
  registerNewRoomHandler(ctx, on);
  registerIdentityRefreshHandler(ctx, on);
  registerPresenceHandler(ctx, on);
  registerJoinRequestHandlers(ctx, on);
  registerAccessRequestHandlers(ctx, on);
  registerVoteUpdateHandler(ctx, on);
  registerPublicKeyHandler(ctx, on);

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const event of registeredEvents) {
      socket.off(event);
    }
    socket.disconnect();
    const windowState = window as Window & { __socket?: typeof socket };
    if (windowState.__socket === socket) {
      windowState.__socket = undefined;
    }
    if (args.getSocket() === socket) {
      args.setSocket(undefined);
    }
  };
};

export { type InitSocketArgs };
