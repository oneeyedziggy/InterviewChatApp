import React, { type HTMLInputTypeAttribute } from 'react';

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
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  autoFocus?: boolean;
};

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
  onKeyDown,
  autoFocus = false,
}: InputProps) => {
  const changeHandeler = (thing: React.ChangeEvent<HTMLInputElement>) => {
    onChange(thing?.target?.value ?? '');
  };

  return (
    <div className="app-auth-input-row">
      <label className="app-auth-input-label" htmlFor={id}>
        {label}
      </label>
      <div className="app-auth-input-field-wrap">
        <input
          className="app-text-input"
          id={id}
          name={name ?? id}
          type={type}
          value={value}
          minLength={minLength}
          required={required}
          onChange={changeHandeler}
          onKeyDown={onKeyDown}
          autoFocus={autoFocus}
        />
        {error && <span className="app-auth-input-error">{error}</span>}
      </div>
    </div>
  );
};

export default Input;
