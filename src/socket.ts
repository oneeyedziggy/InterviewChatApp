import * as socketio from 'socket.io';

import { type Messages } from './types/types';
import { mySessionCache } from './cache';
import { SOCKET_EVENTS, DEFAULT_ROOM } from './constants';

const messages: Messages = {
  [DEFAULT_ROOM]: [],
  '#cats': [],
};
const rooms: string[] = [DEFAULT_ROOM, '#cats'];
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
    socket.emit(SOCKET_EVENTS.STATUS, 'Hello from Socket.io');
    socket.emit(SOCKET_EVENTS.INITIAL_DATA, { messages, rooms, users: getUserList() });

    // TODO: if I ever get server talking to login api route:
    // mySessionCache.on('set', (key, value) => {
    //   users[value] = key;
    //   io.emit('serverUserListUpdate', getUserList());
    // });
    // mySessionCache.on('del', (_key, value) => {
    //   delete users[value];
    //   io.emit('serverUserListUpdate', getUserList());
    // });

    socket.on(SOCKET_EVENTS.CLIENT_MESSAGE, (msg) => {
      messages[msg.room].unshift({
        timestamp: Date.now(),
        username: msg.username,
        content: msg.content,
      });
      // returning users here is a hack to compensate for the temporary lack of
      //   connectivity between the login endpoint and the socket server
      io.emit(SOCKET_EVENTS.SERVER_MESSAGE, { messages, users: getUserList() });
    });

    socket.on(SOCKET_EVENTS.CLIENT_NEW_ROOM, (roomName) => {
      const formattedRoomname = `#${roomName}`;
      if (!rooms.includes(formattedRoomname)) {
        rooms.push(formattedRoomname);
        messages[formattedRoomname] = [];
      }
      io.emit(SOCKET_EVENTS.SERVER_NEW_ROOM, {
        messages,
        rooms: alphabeticalSort(rooms),
      });
    });

    socket.on(SOCKET_EVENTS.CLIENT_DISCONNECTING, (sessionId) => {
      // more hack to temp bypass the lack of connectivity between the login api route and the server
      // mySessionCache.del(sessionId);
      const userOfSession = Object.entries(users).find(([_key, value]) => {
        return value === sessionId;
      })?.[0];
      userOfSession && delete users[userOfSession];
      console.log('client disconnecting');
    });

    socket.on(SOCKET_EVENTS.DISCONNECT, () => {
      console.log('client disconnected');
    });
  });
};
