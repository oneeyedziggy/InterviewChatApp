import express, { Express } from 'express';
import * as http from 'http';
import next from 'next';
import { WebSocketServer, WebSocket } from 'ws';

import { setupSocketHandlers } from './socket';

const port: number = parseInt(process.env.PORT || '3000', 10);
const dev: boolean = process.env.NODE_ENV !== 'production';
const nextApp = next({ dev });
const nextHandler = nextApp.getRequestHandler();

nextApp
  .prepare()
  .then(async () => {
    const app: Express = express();
    const server: http.Server = http.createServer(app);

    type WireEnvelope = { event: string; payload?: unknown };
    type SocketLike = {
      on: (event: string, handler: (payload: unknown) => void) => void;
      emit: (event: string, payload: unknown) => void;
    };
    type SocketServerLike = {
      on: (event: 'connection', handler: (socket: SocketLike) => void) => void;
      emit: (event: string, payload: unknown) => void;
    };

    const sockets = new Set<WebSocket>();
    const connectionHandlers: Array<(socket: SocketLike) => void> = [];

    const io: SocketServerLike = {
      on: (_event, handler) => {
        connectionHandlers.push(handler);
      },
      emit: (event, payload) => {
        const message = JSON.stringify({
          event,
          payload,
        } satisfies WireEnvelope);
        for (const ws of sockets) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(message);
          }
        }
      },
    };

    const wss = new WebSocketServer({ server, path: '/ws/' });
    wss.on('connection', (ws) => {
      sockets.add(ws);
      const handlers = new Map<string, Array<(payload: unknown) => void>>();

      const socket: SocketLike = {
        on: (event, handler) => {
          const list = handlers.get(event) || [];
          list.push(handler);
          handlers.set(event, list);
        },
        emit: (event, payload) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ event, payload } satisfies WireEnvelope));
          }
        },
      };

      for (const handler of connectionHandlers) {
        handler(socket);
      }

      ws.on('message', (raw) => {
        try {
          const parsed = JSON.parse(String(raw)) as WireEnvelope;
          if (!parsed?.event) return;
          const list = handlers.get(parsed.event) || [];
          for (const handler of list) {
            handler(parsed.payload);
          }
        } catch (error) {
          console.error('[ws] failed to parse message', error);
        }
      });

      ws.on('close', () => {
        const disconnectHandlers = handlers.get('disconnect') || [];
        for (const handler of disconnectHandlers) {
          handler('closed');
        }
        sockets.delete(ws);
      });
    });

    console.log('Connected ws server');

    setupSocketHandlers(io as any);

    app.all('*', (req: any, res: any) => nextHandler(req, res));

    server.listen(port, () => {
      console.log(`> Ready on http://localhost:${port}`);
    });
  })
  .catch((err) => {
    console.error(err);
  });

/* props to partial implementations:
https://blog.logrocket.com/implementing-websocket-communication-next-js/
*/
