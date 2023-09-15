import express, { Express, Request, Response } from 'express';
import * as http from 'http';
import next, { NextApiHandler } from 'next';
import * as socketio from 'socket.io';

import { type Messages } from './types/types';

const port: number = parseInt(process.env.PORT || '3000', 10);
const dev: boolean = process.env.NODE_ENV !== 'production';
const nextApp = next({ dev });
const nextHandler: NextApiHandler = nextApp.getRequestHandler();

const messages: Messages = {
  alice: [],
  bob: [],
};
const rooms: string[] = ['alice', 'bob'];

nextApp
  .prepare()
  .then(async () => {
    const app: Express = express();
    const server: http.Server = http.createServer(app);
    const io: socketio.Server = new socketio.Server();
    io.attach(server);
    console.log('Connected io to server');

    // app.get('/hello', async (_: Request, res: Response) => {
    //   res.send('Hello World');
    // });

    io.on('connection', (socket: socketio.Socket) => {
      console.log('connecting');
      //socket.emit === back to requester
      socket.emit('status', 'Hello from Socket.io');
      socket.emit('initialData', { messages, rooms });
      socket.on('clientMessage', (msg) => {
        //socket.broadcast.emit === to all but sender
        messages[msg.room].unshift({
          timestamp: new Date().getUTCDate(),
          username: msg.username,
          content: msg.content,
        });
        //io.emit === back to ALL
        io.emit('serverMessage', messages);
        console.log('received and echoing', msg);
      });
      socket.on('clientNewRoomRequest', (roomName) => {
        if (!rooms.includes(roomName)) {
          rooms.push(roomName);
          messages[roomName] = [];
        }
        socket.emit('serverNewRoomResponse', {
          messages,
          rooms: rooms.sort((a, b) => {
            return a.toLowerCase().localeCompare(b.toLowerCase());
          }),
        });
      });

      socket.on('disconnect', () => {
        console.log('client disconnected');
      });
    });

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
https://stackoverflow.com/questions/24793255/socket-io-cant-get-it-to-work-having-404s-on-some-kind-of-polling-call
https://wallis.dev/blog/socketio-with-nextjs-and-es6-import
*/
