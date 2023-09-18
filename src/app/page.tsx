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
    if (authToken) {
      socketInitializer(authToken);
    }
  }, [authToken]); // don't trust this warning, following the advise will infinite loop

  useEffect(() => {
    !currentRoom && setCurrentRoom(roomList[0]);
  }, [roomList]); // don't trust this warning, following the advise will infinite loop

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
  }, [chatValues]);

  const socketInitializer = async (authToken: string) => {
    socket = io({
      auth: {
        token: authToken,
        username,
      },
    });

    socket.on('connect', () => {
      socket.emit('clientMessage', {
        username,
        room: '#general', // TODO find better solution to this than hardcoding, probably just plumb a distinct non-message event
        content: '<-- has entered the room',
      });
      socket.on('initialData', (data) => {
        data.messages && setChatValues(data.messages);
        data.rooms && setRoomList(data.rooms);
        data.users && setUserList(data.users);
      });
      socket.on('serverMessage', (data) => {
        data.messages && setChatValues(data.messages);
        data.users && setUserList(data.users);
      });
      socket.on('serverNewRoom', (data) => {
        setChatValues(data.messages);
        setRoomList(data.rooms);
      });
      socket.on('serverUserListUpdate', (users) => {
        users && setUserList(users);
      });
      socket.on('disconnecting', (msg) => {
        socket.emit('clientMessage', {
          username,
          room: '#general', // TODO find better solution to this than hard coding, probably just plumb a distinct non-message event
          content: 'says "smell ya\' later" -->',
        });
        socket.emit('clientDisconnecting', authToken);
        setAuthToken('');
      });
      socket.on('status', (msg) => {
        console.log('status', msg);
      });
    });
  };

  const doSend = () => {
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
    setUserDraftMessage(e.target.value);
  };

  const onDraftKeyDownHandler = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      doSend();
    }
  };

  const makeNewRoom = () => {
    socket.emit('clientNewRoom', newRoomName);
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
