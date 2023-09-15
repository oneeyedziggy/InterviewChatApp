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

const mdParse = SimpleMarkdown.defaultBlockParse;
const mdOutput = SimpleMarkdown.defaultReactOutput;
const mdStringToReact = (msString: string) => mdOutput(mdParse(msString));

let socket: Socket;

const ScrollableDiv = styled.div`
  display: flex;
  border: 2px solid #000;
  padding: 15px;
  overflow-y: auto;
  height: 200px;
  flex-direction: column-reverse;
`;

const transformMessages = (messages: Messages, currentRoom: string) => {
  console.log({ who: 'transforming', messages, currentRoom });
  if (currentRoom && Object.keys(messages).length && messages[currentRoom]) {
    return (
      <ScrollableDiv>
        {messages[currentRoom].map((message, dontUseIndex) => {
          console.log({ message, content: message.content });
          return (
            <div key={dontUseIndex}>
              {mdStringToReact(`${message.username}:${message.content}`)}
            </div>
          );
        })}
      </ScrollableDiv>
    );
  }
};

const Home = () => {
  const [userDraftMessage, setUserDraftMessage] = useState(
    'test **markdown** with <script>alert("hax")</script> `cool` *stuff*'
  );
  const [chatValues, setChatValues] = useState<Messages>({});
  const [roomList, setRoomList] = useState<string[]>([]);
  const [currentRoom, setCurrentRoom] = useState<string>('');
  const [newRoomName, setNewRoomName] = useState<string>('');
  const [username, setUsername] = useState<string>('');

  useEffect(() => {
    socketInitializer();
  }, []);

  useEffect(() => {
    setCurrentRoom(roomList[0]);
  }, [roomList]);

  const socketInitializer = async () => {
    await fetch('/api/socket');
    socket = io();

    socket.on('connect', () => {
      console.log('connected for real');
      socket.on('initialData', (data) => {
        console.log('received initialData', data);
        setChatValues(data.messages);
        setRoomList(data.rooms);
      });
      socket.on('serverMessage', (messages) => {
        console.log('received serverMessage', messages);
        setChatValues(messages);
      });
      socket.on('serverNewRoomResponse', (data) => {
        console.log('received serverNewRoomResponse', data);
        setChatValues(data.messages);
        setRoomList(data.rooms);
      });
      socket.on('status', (msg) => {
        console.log('status', msg);
      });
    });
  };

  const doSend = () => {
    console.log('doSend emitting clientMessage', userDraftMessage);
    socket.emit('clientMessage', {
      username,
      room: currentRoom,
      content: userDraftMessage,
    });
    setUserDraftMessage('');
  };

  const userDraftMessageOnChangeHandler = (
    e: ChangeEvent<HTMLInputElement>
  ) => {
    //const target = e.target as HTMLInputElement;
    console.log('userDraftMessageOnChangeHandler', e.target.value);
    setUserDraftMessage(e.target.value);
  };

  const onKeyDownHandler = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      console.log('onKeyDownHandler Enter');
      doSend();
    }
  };

  const onRoomSelectionChange = (e: ChangeEvent<HTMLSelectElement>) => {
    console.log({ newRoom: e.target.value });
    setCurrentRoom(e.target.value);
  };

  const makeNewRoom = () => {
    console.log({ newRoomName });
    socket.emit('clientNewRoomRequest', newRoomName);
  };

  const newRoomNameOnChangeHandler = (e: ChangeEvent<HTMLInputElement>) => {
    console.log('newRoomNameOnChangeHandler', e.target.value);
    setNewRoomName(e.target.value);
  };

  const usernameOnChangeHandler = (e: ChangeEvent<HTMLInputElement>) => {
    console.log('usernameOnChangeHandler', e.target.value);
    setUsername(e.target.value);
  };

  return (
    <>
      <div>
        username:
        <input
          type="text"
          id="usernameInput"
          value={username}
          onChange={usernameOnChangeHandler}
        />
      </div>
      Room:
      <select
        id="roomSelection"
        value={currentRoom}
        onChange={onRoomSelectionChange}
      >
        {roomList.map((room) => (
          <option value={room} key={room}>
            {room}
          </option>
        ))}
      </select>
      make new room:
      <input
        type="text"
        id="newRoomNameInput"
        value={newRoomName}
        onChange={newRoomNameOnChangeHandler}
      />
      <button type="button" id="createNewRoomButton" onClick={makeNewRoom}>
        Make New Room
      </button>
      {transformMessages(chatValues, currentRoom)}
      <input
        id="userDraftMessageInput"
        placeholder="Type something"
        value={userDraftMessage}
        onChange={userDraftMessageOnChangeHandler}
        onKeyDown={onKeyDownHandler}
      />
      <button type="button" onClick={doSend}>
        Send
      </button>
    </>
  );
};

export default Home;
