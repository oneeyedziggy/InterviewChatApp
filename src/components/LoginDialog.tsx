// !!! login should be put on its own codesplit in code more serious than an interview example
// so as not to serve out the whole app bundle and reveal anything about the site, not that security through
// obscurity helps, but defence in depth does...
import React, { useEffect, useState } from 'react';
import { Input } from './Input';
import { styled } from 'styled-components';
import { VALIDATION } from '../constants';

type LoginDialogProps = {
  username: string;
  setUsername: (val: any) => void; //this is the type TS suggested...
  open: boolean;
  onSuccess: (authToken: string) => void;
};

const getUsernameError = (username: string): string => {
  return !username.length || username.length >= VALIDATION.MIN_USERNAME_LENGTH
    ? ''
    : `Username must be at least ${VALIDATION.MIN_USERNAME_LENGTH} characters`; //Note: highly recommend stricter complexity requirement
};

const getPasswordError = (password: string): string => {
  //TODO this is not sufficient password complexity, but that's a whole thing and this is an interview app
  return !password.length || password.length >= VALIDATION.MIN_PASSWORD_LENGTH
    ? ''
    : `Password must be at least ${VALIDATION.MIN_PASSWORD_LENGTH} characters`; //Note: highly recommend stricter complexity requirement
};

const InputError = styled.span`
  color: red;
`;
const BigDialog = styled.dialog<{ open: boolean }>`
  width: 100%;
  height: 100%;
  padding-top: 15%;
  text-align: center;
`;
const LoginButton = styled.button`
  width: 245px;
  margin-top: 5px;
  margin-left: 5px;
`;

const QuickLoginButton = styled.button`
  width: 245px;
  margin-top: 5px;
  margin-left: 5px;
  background-color: #4a90e2;
  color: white;
  border: none;
  padding: 8px;
  border-radius: 4px;
  cursor: pointer;
  &:hover {
    background-color: #357abd;
  }
`;

const QuickLoginContainer = styled.div`
  margin-top: 15px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  align-items: center;
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

  const handleQuickLogin = (defaultUsername: string, defaultPassword: string) => {
    // Set the values directly and submit immediately
    // The validation will pass since these are valid credentials
    setUsername(defaultUsername);
    setPassword(defaultPassword);
    // Submit directly with the provided credentials
    onSubmit(defaultUsername, defaultPassword);
  };

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
            } else {
              setLoginError(
                bodyJson.error || // not-too unprofessional fallback message, TODO: show a cute vector-graphic of a warm beverage
                  snarkyFallbackError
              );
            }
          })
          .catch((err) => {
            setLoginError(snarkyFallbackError);
          });
      })
      //for now if this happens it could be anything
      .catch((err) => {
        setLoginError(snarkyFallbackError);
        console.error('login error2: ', err);
      });
  };

  return (
    <BigDialog id="successModal" open={open}>
      {loginError && <InputError>{loginError}</InputError>}
      <Input
        id="username"
        label="username:"
        type="username"
        error={usernameError}
        minLength={VALIDATION.MIN_USERNAME_LENGTH}
        value={username}
        onChange={setUsername}
        required={true}
      />
      <Input
        id="password"
        label="password:"
        type="password"
        error={passwordError}
        minLength={VALIDATION.MIN_PASSWORD_LENGTH}
        value={password}
        onChange={setPassword}
        required={true}
      />
      <LoginButton
        onClick={() => onSubmit(username, password)}
        type="button"
        disabled={isSubmitDisabled}
      >
        Login
      </LoginButton>
      <QuickLoginContainer>
        <div>Quick Login:</div>
        <QuickLoginButton
          onClick={() => handleQuickLogin('testuser123', 'password123')}
          type="button"
        >
          Login as testuser123
        </QuickLoginButton>
        <QuickLoginButton
          onClick={() => handleQuickLogin('demoaccount', 'demoaccount123')}
          type="button"
        >
          Login as demoaccount
        </QuickLoginButton>
      </QuickLoginContainer>
    </BigDialog>
  );
};
