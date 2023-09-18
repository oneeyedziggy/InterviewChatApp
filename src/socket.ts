import * as socketio from 'socket.io';

import { type Messages } from './types/types';
import { mySessionCache } from './cache';

const messages: Messages = {
  '#general': [],
  '#cats': [],
};
const rooms: string[] = ['#general', '#cats'];
const users: { [key: string]: string } = {};
export const setUser = (name: string, sessionId: string) => {
  users[name] = sessionId;
};

const alphabeticalSort = (array: string[]) => {
  return array.sort((a, b) => {
    return a.toLowerCase().localeCompare(b.toLowerCase());
  });
};
const getUserList = () => {
  return alphabeticalSort(Object.keys(users).filter((user) => !!user));
};

export const setupSocketHandlers = (io: socketio.Server) => {
  // socket.emit === back to requester
  // socket.broadcast.emit === to all but sender
  // io.emit === back to ALL
  io.on('connection', (socket: socketio.Socket) => {
    console.log('client connected');
    socket.emit('status', 'Hello from Socket.io');
    socket.emit('initialData', { messages, rooms, users: getUserList() });

    // TODO: if I ever get server talking to login api route:
    // mySessionCache.on('set', (key, value) => {
    //   users[value] = key;
    //   io.emit('serverUserListUpdate', getUserList());
    // });
    // mySessionCache.on('del', (_key, value) => {
    //   delete users[value];
    //   io.emit('serverUserListUpdate', getUserList());
    // });

    socket.on('clientMessage', (msg) => {
      messages[msg.room].unshift({
        timestamp: new Date().getUTCDate(),
        username: msg.username,
        content: msg.content,
      });
      // returning users here is a hack to compensate for the temporary lack of
      //   connectivity between the login endpoint and the socket server
      io.emit('serverMessage', { messages, users: getUserList() });
    });

    socket.on('clientNewRoom', (roomName) => {
      const formattedRoomname = `#${roomName}`;
      if (!rooms.includes(formattedRoomname)) {
        rooms.push(formattedRoomname);
        messages[formattedRoomname] = [];
      }
      io.emit('serverNewRoom', {
        messages,
        rooms: alphabeticalSort(rooms),
      });
    });

    socket.on('clientDisconnecting', (sessionId) => {
      // more hack to temp bypass the lack of connectivity between the login api route and the server
      // mySessionCache.del(sessionId);
      const userOfSession = Object.entries(users).find(([_key, value]) => {
        return value === sessionId;
      })?.[0];
      userOfSession && delete users[userOfSession];
      console.log('client disconnecting');
    });

    socket.on('disconnect', () => {
      console.log('client disconnected');
    });
  });
};
