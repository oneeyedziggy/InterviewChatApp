import React from 'react';
import { styled } from 'styled-components';

import { ScrollableDiv } from './styled/ScrollableDiv';

export type SelectableListOption = {
  value: string;
  label: string;
};

type SelectableListProps = {
  id: string;
  label: string;
  value: string;
  options: SelectableListOption[];
  onSelect: (value: string) => void;
};

const Wrapper = styled.div`
  flex: 1 1 auto;
`;

const Option = styled.div<{ $isActive: boolean }>`
  border: 1px solid #556;
  background-color: ${(props) => (props.$isActive ? '#b8ccee' : '#e5edf9')};
  color: #0c1b33;
  font-weight: ${(props) => (props.$isActive ? 700 : 500)};
  margin: 0px;
  padding: 3px 6px 3px 10px;
  cursor: pointer;
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
          const isActive = option.value === value;
          return (
            <Option
              key={option.value}
              $isActive={isActive}
              onClick={() => onSelect(option.value)}
            >
              {option.label}
            </Option>
          );
        })}
      </ScrollableDiv>
    </Wrapper>
  );
};
