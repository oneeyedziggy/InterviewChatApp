// !!! login should be put on its own codesplit in code more serious than an interview example
// so as not to serve out the whole app bundle and reveal anything about the site, not that security through
// obscurity helps, but defence in depth does...
import React, { useCallback, useEffect, useState } from 'react';
import { Input } from './Input';
import { styled } from 'styled-components';
import { VALIDATION } from '../constants';
import { apiPath } from '@/utils/appPaths';
import {
  generateKeyPair,
  storeKeys,
  loadKeys,
  clearKeys,
  hasValidStoredKeys,
  forceReauthToLogin,
  fetchServerPublicKey,
  decryptMessage,
  verifyChallengeResponseWithKeyRefresh,
  type StoredKeys,
} from '../utils/gpg';

type LoginDialogProps = {
  username: string;
  setUsername: (val: any) => void;
  open: boolean;
  onSuccess: (authToken: string, username: string) => void;
  onLogout?: () => void;
};

const getUsernameError = (username: string): string => {
  if (!username.length) {
    return '';
  }
  if (username.length < VALIDATION.MIN_USERNAME_LENGTH) {
    return `Username must be at least ${VALIDATION.MIN_USERNAME_LENGTH} characters`;
  }
  if (/\s/.test(username)) {
    return 'Username cannot contain whitespace';
  }
  return '';
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
const LogoutButton = styled.button`
  width: 245px;
  margin-top: 5px;
  margin-left: 5px;
  background-color: #e24a4a;
  color: white;
  border: none;
  padding: 8px;
  border-radius: 4px;
  cursor: pointer;
  &:hover {
    background-color: #c03939;
  }
`;

export const LoginDialog = ({
  username,
  setUsername,
  open,
  onSuccess,
  onLogout,
}: LoginDialogProps) => {
  const [usernameError, setUsernameError] = useState<string>('');
  const [loginError, setLoginError] = useState<string>('');
  const [isSubmitDisabled, setIsSubmitDisabled] = useState<boolean>(true);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [serverPublicKey, setServerPublicKey] = useState<string>('');

  const checkAutoLogin = useCallback(async () => {
    const storedKeys = loadKeys();
    const keysValid = await hasValidStoredKeys();

    if (!keysValid) {
      if (storedKeys?.sessionId) {
        forceReauthToLogin();
      }
      return;
    }

    if (storedKeys?.sessionId) {
      console.log('[LoginDialog] Auto-login with stored keys');
      setUsername(storedKeys.username);
      onSuccess(storedKeys.sessionId, storedKeys.username);
    }
  }, [setUsername, onSuccess]);

  // Check for auto-login on mount
  useEffect(() => {
    if (open) {
      checkAutoLogin();
      fetchServerPublicKey()
        .then(setServerPublicKey)
        .catch((err) => {
          console.error(
            '[LoginDialog] Failed to fetch server public key:',
            err,
          );
        });
    }
  }, [open, checkAutoLogin]);

  useEffect(() => {
    const localUsernameError = getUsernameError(username);
    setUsernameError(localUsernameError);
    setIsSubmitDisabled(!username || !!localUsernameError);
  }, [username]);

  const handleLogout = () => {
    clearKeys();
    setUsername('');
    if (onLogout) {
      onLogout();
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !isSubmitDisabled && !isLoading) {
      event.preventDefault();
      onSubmit(username);
    }
  };

  const onSubmit = async (username: string) => {
    setIsLoading(true);
    setLoginError('');

    const snarkyFallbackError =
      "Something went wrong at login, go grab a cup of tea, maybe we'll figure it out while you're gone";

    try {
      // Check if we have stored keys for this username
      const storedKeys = loadKeys();
      let keys: StoredKeys;

      if (storedKeys && storedKeys.username === username) {
        // Use existing keys
        console.log('[LoginDialog] Using existing keys for:', username);
        keys = storedKeys;

        // Get server public key if we don't have it
        if (!keys.serverPublicKey) {
          keys.serverPublicKey = await fetchServerPublicKey();
        }
      } else {
        // Generate new keys
        console.log('[LoginDialog] Generating new keys for:', username);
        const keyPair = await generateKeyPair(username);

        // Get server public key
        const serverPubKey = serverPublicKey || (await fetchServerPublicKey());

        keys = {
          username,
          privateKey: keyPair.privateKey,
          publicKey: keyPair.publicKey,
          serverPublicKey: serverPubKey,
        };
      }

      // First login attempt - send username and public key
      const loginResponse = await fetch(apiPath('/api/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          publicKey: keys.publicKey,
        }),
      });

      const loginData = await loginResponse.json();

      if (loginData.error) {
        setLoginError(loginData.error);
        setIsLoading(false);
        return;
      }

      // If we got a challenge, this is an existing user - perform challenge-response
      if (loginData.challenge) {
        console.log(
          '[LoginDialog] Received challenge, performing challenge-response',
        );

        // Decrypt the challenge with our private key
        const decryptedUUID = await decryptMessage(
          loginData.challenge,
          keys.privateKey,
        );
        console.log('[LoginDialog] Decrypted UUID:', decryptedUUID);

        const verifyData = await verifyChallengeResponseWithKeyRefresh({
          username,
          decryptedUUID,
          serverPublicKey: keys.serverPublicKey,
        });

        if (verifyData.error) {
          setLoginError(verifyData.error);
          setIsLoading(false);
          return;
        }

        if (verifyData.sessionId) {
          // Store keys with session ID
          storeKeys({
            ...keys,
            serverPublicKey: verifyData.serverPublicKey,
            sessionId: verifyData.sessionId,
          });
          setLoginError('');
          onSuccess(verifyData.sessionId, username);
        } else {
          setLoginError(verifyData.error || snarkyFallbackError);
        }
      } else if (loginData.sessionId) {
        // New user registration successful
        console.log('[LoginDialog] New user registered successfully');

        // Store server public key if provided
        if (loginData.serverPublicKey) {
          keys.serverPublicKey = loginData.serverPublicKey;
        }

        // Store keys with session ID
        storeKeys({
          ...keys,
          sessionId: loginData.sessionId,
        });
        setLoginError('');
        onSuccess(loginData.sessionId, username);
      } else {
        setLoginError(loginData.error || snarkyFallbackError);
      }
    } catch (err) {
      console.error('[LoginDialog] Login error:', err);
      setLoginError(snarkyFallbackError);
    } finally {
      setIsLoading(false);
    }
  };

  // Check if user is already logged in
  const storedKeys = loadKeys();
  const isLoggedIn = storedKeys && storedKeys.sessionId;

  return (
    <BigDialog id="successModal" open={open}>
      {loginError && <InputError>{loginError}</InputError>}
      {isLoggedIn ? (
        <>
          <div>Logged in as: {storedKeys!.username}</div>
          <LogoutButton onClick={handleLogout} type="button">
            Logout
          </LogoutButton>
        </>
      ) : (
        <>
          <Input
            id="username"
            label="username:"
            type="text"
            error={usernameError}
            minLength={VALIDATION.MIN_USERNAME_LENGTH}
            value={username}
            onChange={setUsername}
            onKeyDown={handleKeyDown}
            required={true}
          />
          <LoginButton
            onClick={() => onSubmit(username)}
            type="button"
            disabled={isSubmitDisabled || isLoading}
          >
            {isLoading ? 'Logging in...' : 'Login'}
          </LoginButton>
          <div style={{ marginTop: '10px', fontSize: '12px', color: '#666' }}>
            GPG keys will be generated automatically on first login
          </div>
        </>
      )}
    </BigDialog>
  );
};
