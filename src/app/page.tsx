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
import { RoomList } from '../components/RoomList';
import { ScrollableDiv } from '../components/styled/ScrollableDiv';

const mdParse = SimpleMarkdown.defaultBlockParse;
const mdOutput = SimpleMarkdown.defaultReactOutput;
const mdStringToReact = (msString: string) => mdOutput(mdParse(msString));

let socket: Socket;

const BlockInput = styled.input`
  display: block;
`;
const BlockSelect = styled.select`
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
  console.log({ who: 'transforming', messages, currentRoom });
  if (currentRoom && Object.keys(messages).length && messages[currentRoom]) {
    return (
      <ScrollableDiv flexDirection="column-reverse">
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

  const [authToken, setAuthToken] = useState<string>('');
  const [username, setUsername] = useState<string>('');

  useEffect(() => {
    if (authToken) {
      socketInitializer(authToken);
    }
  }, [authToken]);

  useEffect(() => {
    setCurrentRoom(roomList[0]);
  }, [roomList]);

  const socketInitializer = async (authToken: string) => {
    socket = io({
      auth: {
        token: authToken,
      },
    });

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

  // const onRoomSelectionChange = (e: ChangeEvent<HTMLSelectElement>) => {
  //   console.log({ newRoom: e.target.value });
  //   setCurrentRoom(e.target.value);
  // };
  const onRoomSelectionChange = (newRoom: string) => {
    console.log({ newRoom });
    setCurrentRoom(newRoom);
  };

  const makeNewRoom = () => {
    console.log({ newRoomName });
    socket.emit('clientNewRoomRequest', newRoomName);
  };

  const newRoomNameOnChangeHandler = (e: ChangeEvent<HTMLInputElement>) => {
    console.log('newRoomNameOnChangeHandler', e.target.value);
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
            {/* 
            <label htmlFor="roomSelection">Room:</label>
            <BlockSelect
              id="roomSelection"
              value={currentRoom}
              onChange={onRoomSelectionChange}
            >
              {roomList.map((room) => (
                <option value={room} key={room}>
                  {room}
                </option>
              ))}
            </BlockSelect> */}
            <RoomList
              id="roomSelection"
              value={currentRoom}
              roomList={roomList}
              onSelect={onRoomSelectionChange}
            />
            <hr />
            <label htmlFor="newRoomNameInput">New Room Name:</label>
            <BlockInput
              type="text"
              id="newRoomNameInput"
              value={newRoomName}
              onChange={newRoomNameOnChangeHandler}
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
                onKeyDown={onKeyDownHandler}
              />
              <WiderButton type="button" onClick={doSend}>
                Send
              </WiderButton>
            </FlexRow>
          </MiddleFlexColumn>
          <SideFlexColumn>Users:</SideFlexColumn>
        </FlexDiv>
      )}
    </>
  );
};

export default Home;
