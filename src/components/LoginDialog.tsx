import React, { useEffect, useState } from 'react';
import { Input } from './Input';
import { minPasswordLength, minUsernameLength } from '../app/api/login/route';
import { styled } from 'styled-components';

type LoginDialogProps = {
  username: string;
  setUsername: (val: any) => void; //this is the type TS suggested...
  open: boolean;
  onSuccess: (authToken: string) => void;
};

const getUsernameError = (username: string): string => {
  return !username.length || username.length >= minUsernameLength
    ? ''
    : `Username must be at least ${minUsernameLength} characters`; //Note: highly recommend stricter complexity requirement
};

const getPasswordError = (password: string): string => {
  //TODO this is not sufficient password complexity, but that's a whole thing and this is an interview app
  return !password.length || password.length >= minPasswordLength
    ? ''
    : `Password must be at least ${minPasswordLength} characters`; //Note: highly recommend stricter complexity requirement
};

const InputError = styled.span`
  color: red;
`;
const BigDialog = styled.span`
  width: 100%;
  height: 100%;
`;

export const LoginDialog = ({
  username,
  setUsername,
  open,
  onSuccess,
}: LoginDialogProps) => {
  const [usernameError, setUsernameError] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [passwordError, setPasswordError] = useState<string>('');
  const [loginError, setLoginError] = useState<string>('');
  const [authToken, setAuthToken] = useState<string>('');
  const [isSubmitDisabled, setIsSubmitDisabled] = useState<boolean>(true);

  useEffect(() => {
    const localUsernameError = getUsernameError(username);
    const localPasswordError = getPasswordError(password);
    setUsernameError(localUsernameError);
    setPasswordError(localPasswordError);
    // make this a separate flag so the messages don't display while the inputs are empty
    setIsSubmitDisabled(
      !username || !password || !!localUsernameError || !!localPasswordError
    );
  }, [username, password]);

  const onSubmit = (username: string, password: string) => {
    // not-too unprofessional fallback message, TODO: show a cute vector-graphic of a warm beverage
    const snarkyFallbackError =
      "Something went wrong at login, go grab a cup of tea, maybe we'll figure it out while you're gone";
    fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
      .then((response) => {
        response
          .json()
          .then((bodyJson) => {
            if (bodyJson.sessionId) {
              setLoginError('');
              setAuthToken(bodyJson.sessionId);
              onSuccess(bodyJson.sessionId);
              console.log('login success');
            } else {
              setLoginError(
                bodyJson.error || // not-too unprofessional fallback message, TODO: show a cute vector-graphic of a warm beverage
                  snarkyFallbackError
              );
              console.log('login error0: ', bodyJson.error);
            }
          })
          .catch((err) => {
            setLoginError(snarkyFallbackError);
            console.error('login error1: ', err);
          });
      })
      //for now if this happens it could be anything
      .catch((err) => {
        setLoginError(snarkyFallbackError);
        console.error('login error2: ', err);
      });
  };

  return (
    <dialog id="successModal" open={open}>
      {loginError && <InputError>{loginError}</InputError>}
      <Input
        id="username"
        label="username:"
        type="username"
        error={usernameError}
        minLength={minUsernameLength}
        value={username}
        onChange={setUsername}
        required={true}
      />
      <Input
        id="password"
        label="password:"
        type="password"
        error={passwordError}
        minLength={minPasswordLength}
        value={password}
        onChange={setPassword}
        required={true}
      />
      <button
        onClick={() => onSubmit(username, password)}
        type="button"
        disabled={isSubmitDisabled}
      >
        Login
      </button>
    </dialog>
  );
};
