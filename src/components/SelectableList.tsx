import React from 'react';
import { styled } from 'styled-components';

import { ScrollableDiv } from './styled/ScrollableDiv';

type SelectableListProps = {
  id: string;
  label: string;
  value: string;
  options: string[];
  onSelect: (room: string) => void;
};

const Wrapper = styled.div`
  flex: 1 1 auto;
`;

const Option = styled.div<{ $isActive: boolean }>`
  border: 1px solid #556;
  background-color: ${(props) => (props.$isActive ? '#aab' : '#fffff00')};
  color: #333344;
  font-weight: ${(props) => (props.$isActive ? 700 : 300)};
  margin: 0px;
`;

export const SelectableList = ({
  id,
  label,
  value,
  options,
  onSelect,
}: SelectableListProps) => {
  return (
    <Wrapper id={id}>
      <div>{label}:</div>
      <ScrollableDiv $padding="0px">
        {options.map((option) => {
          const isActive = option === value;
          return (
            <Option
              key={option}
              $isActive={isActive}
              onClick={() => onSelect(option)}
            >
              {option}
            </Option>
          );
        })}
      </ScrollableDiv>
    </Wrapper>
  );
};
