import React, { type HTMLInputTypeAttribute } from 'react';
import styled from 'styled-components';

type InputProps = {
  id: string;
  name?: string;
  label: string;
  type?: HTMLInputTypeAttribute;
  minLength?: number;
  error?: string;
  value?: string;
  required?: boolean;
  onChange: (val: any) => void;
};

const BlockLabel = styled.label`
  min-width: 85px;
  display: block;
  text-align: right;
`;
const InputError = styled.span`
  color: red;
`;
const BlockInput = styled.input`
  display: block;
  margin-top: 5px;
`;
const FlexRowWrapper = styled.div`
  display: flex;
  flex-direction: row;
  justify-content: center;
  align-items: center;
`;

export const Input = ({
  id,
  name,
  label,
  type = 'text',
  minLength = -1,
  error = '',
  value = '',
  required = false,
  onChange,
}: InputProps) => {
  const changeHandeler = (thing: React.ChangeEvent<HTMLInputElement>) => {
    onChange(thing?.target?.value ?? '');
  };

  return (
    <FlexRowWrapper>
      <BlockLabel htmlFor={id}>{label}</BlockLabel>
      <div>
        <BlockInput
          id={id}
          name={name ?? id}
          type={type}
          value={value}
          minLength={minLength}
          required={required}
          onChange={changeHandeler}
        />
        {error && <InputError>{error}</InputError>}
      </div>
    </FlexRowWrapper>
  );
};

export default Input;
