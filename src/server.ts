import express, { Express, Request, Response } from 'express';
import * as http from 'http';
import next, { NextApiHandler } from 'next';
import * as socketio from 'socket.io';

import { setupSocketHandlers } from './socket';
import { setUser } from './socket';

const port: number = parseInt(process.env.PORT || '3000', 10);
const dev: boolean = process.env.NODE_ENV !== 'production';
const nextApp = next({ dev });
const nextHandler: NextApiHandler = nextApp.getRequestHandler();

nextApp
  .prepare()
  .then(async () => {
    const app: Express = express();
    const server: http.Server = http.createServer(app);
    const io: socketio.Server = new socketio.Server();
    io.use((socket, next) => {
      const token = socket.handshake.auth.token;
      const username = socket.handshake.auth.username;
      // this is a bit of a hack to bypass some seemingly recent issues with the latest version of nextjs breaking the
      // sharing of data between the custom server and api routes
      setUser(username, token);
      if (true) {
        next();
      }
    });
    io.attach(server);
    console.log('Connected io to server');

    setupSocketHandlers(io);

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
