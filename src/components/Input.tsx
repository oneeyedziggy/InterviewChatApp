import React, { type HTMLInputTypeAttribute, type ReactNode } from 'react';

type InputProps = {
  id: string;
  name?: string;
  label: string;
  type?: HTMLInputTypeAttribute;
  autoComplete?: string;
  rightSlot?: ReactNode;
  inlineRightSlot?: ReactNode;
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
  autoComplete,
  rightSlot,
  inlineRightSlot,
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
        <div className="app-auth-input-inline">
          <div className="app-auth-input-control">
            <input
              className={`app-text-input${rightSlot ? ' app-text-input--with-right-slot' : ''}`}
              id={id}
              name={name ?? id}
              type={type}
              autoComplete={autoComplete}
              value={value}
              minLength={minLength}
              required={required}
              onChange={changeHandeler}
              onKeyDown={onKeyDown}
              autoFocus={autoFocus}
            />
            {rightSlot && (
              <div className="app-auth-input-overlay-right">{rightSlot}</div>
            )}
          </div>
          {inlineRightSlot}
        </div>
        {error && <span className="app-auth-input-error">{error}</span>}
      </div>
    </div>
  );
};

export default Input;
