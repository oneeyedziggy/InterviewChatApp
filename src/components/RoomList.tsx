import React from 'react';
import { styled } from 'styled-components';

import { ScrollableDiv } from './styled/ScrollableDiv';

type RoomListProps = {
  id: string;
  value: string;
  roomList: string[];
  onSelect: (room: string) => void;
};

const RoomName = styled.div<{ isActive: boolean }>`
  border: 1px solid #555;
  background-color: #aaa;
  color: ${(props) => (props.isActive ? '#5555aa' : '#3333aa')};
  font-weight: ${(props) => (props.isActive ? 700 : 300)};
  margin: 0px;
`;

export const RoomList = ({ id, value, roomList, onSelect }: RoomListProps) => {
  return (
    <>
      <div>Rooms:</div>
      <ScrollableDiv padding="0px">
        {roomList.map((room) => {
          const isActive = room === value;
          return (
            <RoomName
              key={room}
              isActive={isActive}
              onClick={() => onSelect(room)}
            >
              {room}
            </RoomName>
          );
        })}
      </ScrollableDiv>
    </>
  );
};
