'use client';
import {
  useEffect,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react';
import io, { type Socket } from 'socket.io-client';
import { styled } from 'styled-components';
import * as SimpleMarkdown from 'simple-markdown';

import { type Messages } from '../types/types';
import { LoginDialog } from '../components/LoginDialog';
import { SelectableList } from '../components/SelectableList';
import { ScrollableDiv } from '../components/styled/ScrollableDiv';
import { SOCKET_EVENTS, DEFAULT_ROOM, SYSTEM_MESSAGES } from '../constants';

const mdParse = SimpleMarkdown.defaultBlockParse;
const mdOutput = SimpleMarkdown.defaultReactOutput;
const mdStringToReact = (msString: string) => mdOutput(mdParse(msString));

let socket: Socket;

const BlockInput = styled.input`
  display: block;
`;
const SideFlexColumn = styled.div`
  display: flex;
  flex-direction: column;
  flex-basis: 15%;
`;
const MiddleFlexColumn = styled.div`
  display: flex;
  flex-direction: column;
  flex-basis: 70%;
  height: 100vh;
`;
const FlexRow = styled.div`
  display: flex;
  flex-direction: row;
`;
const WiderInput = styled.input`
  display: flex;
  flex-basis: 95%;
`;
const WiderButton = styled.button`
  display: flex;
  flex-basis: 10%;
  justify-content: center;
`;
const FlexDiv = styled.div`
  display: flex;
  flex-direction: row;
`;

const transformMessages = (messages: Messages, currentRoom: string) => {
  if (currentRoom && Object.keys(messages).length && messages[currentRoom]) {
    return (
      <ScrollableDiv $flexDirection="column-reverse">
        {messages[currentRoom].map((message, dontUseIndex) => {
          return (
            <div key={dontUseIndex}>
              {mdStringToReact(`${message.username}: ${message.content}`)}
            </div>
          );
        })}
      </ScrollableDiv>
    );
  }
};

// TODO: break this up into more components to reduce the complexity and number of dependencies in this file
const Home = () => {
  const [userDraftMessage, setUserDraftMessage] = useState('');
  // this "old" chatValues is almost certainly not the best way to acheive this, but there appears to be a timing issue trying to do the diff in the socket.on serverMessage
  const [oldChatValues, setOldChatValues] = useState<Messages>({});
  const [chatValues, setChatValues] = useState<Messages>({});
  const [userList, setUserList] = useState<string[]>([]);
  const [roomList, setRoomList] = useState<string[]>([]);
  const [roomNotifications, setRoomNotifications] = useState<{
    [key: string]: string;
  }>({});
  const [currentRoom, setCurrentRoom] = useState<string>('');
  const [newRoomName, setNewRoomName] = useState<string>('');

  const [authToken, setAuthToken] = useState<string>('');
  const [username, setUsername] = useState<string>('');

  useEffect(() => {
    setRoomNotifications((rn) => {
      const baseRoomName = currentRoom?.replace(/-\(\d+ NEW!\)/, '');
      const newobj = {
        ...rn,
        [baseRoomName]: '',
      };
      return newobj;
    });
  }, [currentRoom]);

  useEffect(() => {
    console.log('[Home] useEffect triggered, authToken:', authToken, 'username:', username);
    if (authToken) {
      console.log('[Home] Calling socketInitializer');
      socketInitializer(authToken);
    } else {
      console.log('[Home] No authToken, skipping socket initialization');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken]); // socketInitializer is stable and doesn't need to be in deps

  useEffect(() => {
    !currentRoom && setCurrentRoom(roomList[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomList]); // currentRoom intentionally excluded to avoid infinite loop

  useEffect(() => {
    oldChatValues &&
      setRoomNotifications(
        Object.fromEntries(
          Object.keys(oldChatValues).map((roomName: string) => {
            return chatValues[roomName]?.length >
              oldChatValues[roomName]?.length && !(roomName === currentRoom)
              ? [
                  roomName,
                  `(${
                    chatValues[roomName]?.length -
                    oldChatValues[roomName]?.length
                  } NEW!)`,
                ]
              : [roomName, ''];
          })
        )
      );
    setOldChatValues(chatValues);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatValues]); // oldChatValues and currentRoom intentionally excluded to avoid infinite loop

  const socketInitializer = async (authToken: string) => {
    console.log('[Socket] ===== INITIALIZING SOCKET =====');
    console.log('[Socket] Token:', authToken);
    console.log('[Socket] Username:', username);
    console.log('[Socket] Current window location:', window.location.href);
    
    // Connect to Socket.IO server - use current origin (should be localhost:3000)
    const socketUrl = window.location.origin;
    console.log('[Socket] Connecting to:', socketUrl);
    
    socket = io(socketUrl, {
      auth: {
        token: authToken,
        username,
      },
      transports: ['polling', 'websocket'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      forceNew: true, // Force a new connection
    });

    // Store socket reference globally for doSend
    (window as any).__socket = socket;

    console.log('[Socket] Socket instance created:', socket);
    console.log('[Socket] Socket ID:', socket.id);
    console.log('[Socket] Socket connected:', socket.connected);
    console.log('[Socket] Setting up listeners...');

    // Set up listeners immediately - Socket.IO queues events emitted during connection
    socket.on(SOCKET_EVENTS.INITIAL_DATA, (data) => {
      console.log('[Socket] ===== INITIAL_DATA RECEIVED =====');
      console.log('[Socket] Full data object:', JSON.stringify(data, null, 2));
      console.log('[Socket] Messages:', data?.messages);
      console.log('[Socket] Messages type:', typeof data?.messages);
      console.log('[Socket] Messages keys:', data?.messages ? Object.keys(data.messages) : 'none');
      console.log('[Socket] Rooms:', data?.rooms);
      console.log('[Socket] Rooms type:', typeof data?.rooms);
      console.log('[Socket] Rooms length:', Array.isArray(data?.rooms) ? data.rooms.length : 'not array');
      console.log('[Socket] Users:', data?.users);
      console.log('[Socket] Users type:', typeof data?.users);
      console.log('[Socket] Users length:', Array.isArray(data?.users) ? data.users.length : 'not array');
      
      if (data?.messages) {
        console.log('[Socket] ✓ Setting chat values, count:', Object.keys(data.messages).length);
        setChatValues(data.messages);
      } else {
        console.warn('[Socket] ✗ No messages in INITIAL_DATA');
      }
      
      if (data?.rooms) {
        console.log('[Socket] ✓ Setting room list:', data.rooms);
        setRoomList(data.rooms);
      } else {
        console.warn('[Socket] ✗ No rooms in INITIAL_DATA');
      }
      
      if (data?.users) {
        console.log('[Socket] ✓ Setting user list:', data.users);
        setUserList(data.users);
      } else {
        console.warn('[Socket] ✗ No users in INITIAL_DATA');
      }
      
      console.log('[Socket] ===== INITIAL_DATA PROCESSING COMPLETE =====');
    });
    
    socket.on(SOCKET_EVENTS.SERVER_MESSAGE, (data) => {
      console.log('[Socket] SERVER_MESSAGE received');
      if (data?.messages) {
        setChatValues(data.messages);
      }
      if (data?.users) {
        setUserList(data.users);
      }
    });
    
    socket.on(SOCKET_EVENTS.SERVER_NEW_ROOM, (data) => {
      console.log('[Socket] SERVER_NEW_ROOM received');
      if (data?.messages) {
        setChatValues(data.messages);
      }
      if (data?.rooms) {
        setRoomList(data.rooms);
      }
    });
    
    socket.on(SOCKET_EVENTS.SERVER_USER_LIST_UPDATE, (users) => {
      console.log('[Socket] SERVER_USER_LIST_UPDATE received:', users);
      if (users) {
        setUserList(users);
      }
    });
    
    socket.on(SOCKET_EVENTS.DISCONNECTING, (msg) => {
      socket.emit(SOCKET_EVENTS.CLIENT_MESSAGE, {
        username,
        room: DEFAULT_ROOM,
        content: SYSTEM_MESSAGES.USER_LEFT,
      });
      socket.emit(SOCKET_EVENTS.CLIENT_DISCONNECTING, authToken);
      setAuthToken('');
    });
    
    socket.on(SOCKET_EVENTS.STATUS, (msg) => {
      console.log('[Socket] STATUS received:', msg);
    });

    socket.on(SOCKET_EVENTS.CONNECT, () => {
      console.log('[Socket] ===== CONNECTED =====');
      console.log('[Socket] Socket ID:', socket.id);
      console.log('[Socket] Socket connected:', socket.connected);
      console.log('[Socket] Emitting join message...');
      socket.emit(SOCKET_EVENTS.CLIENT_MESSAGE, {
        username,
        room: DEFAULT_ROOM,
        content: SYSTEM_MESSAGES.USER_JOINED,
      });
      console.log('[Socket] Join message emitted');
    });

    socket.on(SOCKET_EVENTS.DISCONNECT, (reason) => {
      console.log('[Socket] ===== DISCONNECTED =====');
      console.log('[Socket] Reason:', reason);
      console.log('[Socket] Socket ID:', socket.id);
    });

    socket.on('connect_error', (error: Error) => {
      console.error('[Socket] ===== CONNECTION ERROR =====');
      console.error('[Socket] Error object:', error);
      console.error('[Socket] Error message:', error.message);
      console.error('[Socket] Error name:', error.name);
      console.error('[Socket] Error stack:', error.stack);
    });

    socket.on('error', (error) => {
      console.error('[Socket] ===== SOCKET ERROR =====');
      console.error('[Socket] Error:', error);
    });

    socket.on('disconnect', (reason) => {
      console.log('[Socket] ===== DISCONNECT EVENT =====');
      console.log('[Socket] Reason:', reason);
    });

    socket.on('reconnect', (attemptNumber) => {
      console.log('[Socket] ===== RECONNECTED =====');
      console.log('[Socket] Attempt number:', attemptNumber);
    });

    socket.on('reconnect_attempt', (attemptNumber) => {
      console.log('[Socket] Reconnect attempt:', attemptNumber);
    });

    socket.on('reconnect_error', (error) => {
      console.error('[Socket] Reconnect error:', error);
    });

    socket.on('reconnect_failed', () => {
      console.error('[Socket] ===== RECONNECT FAILED =====');
    });

    console.log('[Socket] All listeners registered');
    console.log('[Socket] Socket state - connected:', socket.connected, 'id:', socket.id);
  };

  const doSend = () => {
    console.log('[doSend] ===== SENDING MESSAGE =====');
    console.log('[doSend] Socket exists:', !!socket);
    console.log('[doSend] Socket connected:', socket?.connected);
    console.log('[doSend] Socket ID:', socket?.id);
    console.log('[doSend] Username:', username);
    console.log('[doSend] Current room:', currentRoom);
    console.log('[doSend] Message content:', userDraftMessage);
    
    // Try to get socket from window if not available
    const activeSocket = socket || (window as any).__socket;
    console.log('[doSend] Active socket from window:', !!(window as any).__socket);
    
    if (!activeSocket) {
      console.error('[doSend] ✗ Socket is not initialized!');
      alert('Socket not connected. Please refresh the page.');
      return;
    }
    
    if (!activeSocket.connected) {
      console.error('[doSend] ✗ Socket is not connected! Connected:', activeSocket.connected);
      alert('Socket not connected. Please refresh the page.');
      return;
    }
    
    if (!currentRoom) {
      console.error('[doSend] ✗ No current room selected!');
      alert('Please select a room first.');
      return;
    }
    
    if (!userDraftMessage.trim()) {
      console.log('[doSend] ✗ Empty message, not sending');
      return;
    }
    
    const messageData = {
      username,
      room: currentRoom,
      content: userDraftMessage,
    };
    
    console.log('[doSend] Emitting CLIENT_MESSAGE with data:', messageData);
    console.log('[doSend] Event name:', SOCKET_EVENTS.CLIENT_MESSAGE);
    activeSocket.emit(SOCKET_EVENTS.CLIENT_MESSAGE, messageData);
    console.log('[doSend] ✓ Message emitted');
    setUserDraftMessage('');
  };

  const userDraftMessageOnChangeHandler = (
    e: ChangeEvent<HTMLInputElement>
  ) => {
    setUserDraftMessage(e.target.value);
  };

  const onDraftKeyDownHandler = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      doSend();
    }
  };

  const makeNewRoom = () => {
    socket.emit(SOCKET_EVENTS.CLIENT_NEW_ROOM, newRoomName);
  };

  const onNewRoomKeyDownHandler = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      makeNewRoom();
    }
  };

  const onRoomSelectionChange = (newRoom: string) => {
    setCurrentRoom(newRoom?.replace(/-\(\d+ NEW!\)/, ''));
  };

  const newRoomNameOnChangeHandler = (e: ChangeEvent<HTMLInputElement>) => {
    setNewRoomName(e.target.value);
  };

  return (
    <>
      {/* login should technically be on a completely separate codesplit, so you're not serving the whole app bundle to unauthenticated users,
          but it's not MVP since no content is sensitive*/}
      <LoginDialog
        username={username}
        setUsername={setUsername}
        open={!authToken}
        onSuccess={setAuthToken}
      />
      {authToken && (
        <FlexDiv>
          <SideFlexColumn>
            <SelectableList
              id="roomSelection"
              label={'Rooms'}
              value={currentRoom}
              options={roomList.map(
                (room) =>
                  `${room}${
                    roomNotifications[room] ? '-' + roomNotifications[room] : ''
                  }`
              )}
              onSelect={onRoomSelectionChange}
            />
            <hr />
            <label htmlFor="newRoomNameInput">New Room Name:</label>
            <BlockInput
              type="text"
              id="newRoomNameInput"
              value={newRoomName}
              onChange={newRoomNameOnChangeHandler}
              onKeyDown={onNewRoomKeyDownHandler}
            />
            <WiderButton
              type="button"
              id="createNewRoomButton"
              onClick={makeNewRoom}
            >
              Make New Room
            </WiderButton>
          </SideFlexColumn>
          <MiddleFlexColumn>
            {transformMessages(chatValues, currentRoom)}
            <FlexRow>
              <WiderInput
                id="userDraftMessageInput"
                placeholder="Type something"
                value={userDraftMessage}
                onChange={userDraftMessageOnChangeHandler}
                onKeyDown={onDraftKeyDownHandler}
              />
              <WiderButton type="button" onClick={doSend}>
                Send
              </WiderButton>
            </FlexRow>
          </MiddleFlexColumn>
          <SideFlexColumn>
            <SelectableList
              id="userSelection"
              label={'Users'}
              value={username}
              // TODO: this filter is a hack fix, given more time I'd go keep 'undefined' from getting in the list in the first place
              options={userList.filter((user) => user !== 'undefined')}
              onSelect={() => {}}
            />
          </SideFlexColumn>
        </FlexDiv>
      )}
    </>
  );
};

export default Home;

