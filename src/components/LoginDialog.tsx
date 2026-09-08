// !!! login should be put on its own codesplit in code more serious than an interview example
// so as not to serve out the whole app bundle and reveal anything about the site, not that security through
// obscurity helps, but defence in depth does...
import React, { useCallback, useEffect, useState } from 'react';
import { Input } from './Input';
import PasswordVisibilityToggle from './PasswordVisibilityToggle';
import { styled } from 'styled-components';
import { VALIDATION } from '../constants';
import { apiPath } from '@/utils/appPaths';
import {
  buildOpaqueUsernameEnvelope,
  generateKeyPair,
  storeKeys,
  loadKeysAsync,
  clearKeys,
  hasValidStoredKeys,
  forceReauthToLogin,
  fetchServerPublicKey,
  decryptMessage,
  verifyChallengeResponseWithKeyRefresh,
  type StoredKeys,
} from '../utils/gpg';
import { requireUserIdByUsername } from '@/utils/identityMap';
import { getPasswordError, getUsernameError } from '@/utils/authValidation';

type LoginDialogProps = {
  username: string;
  setUsername: (val: any) => void;
  open: boolean;
  onSuccess: (authToken: string, username: string) => void;
  onLogout?: () => void;
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
  const [password, setPassword] = useState<string>('');
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [passwordError, setPasswordError] = useState<string>('');
  const [loginError, setLoginError] = useState<string>('');
  const [isSubmitDisabled, setIsSubmitDisabled] = useState<boolean>(true);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [serverPublicKey, setServerPublicKey] = useState<string>('');
  const [loggedInUser, setLoggedInUser] = useState<StoredKeys | null>(null);

  const checkAutoLogin = useCallback(async () => {
    const storedKeys = await loadKeysAsync();
    const keysValid = await hasValidStoredKeys();

    if (!keysValid) {
      if (storedKeys?.sessionId) {
        forceReauthToLogin();
      }
      return;
    }

    if (storedKeys?.sessionId) {
      console.log('[LoginDialog] Auto-login with stored keys');
      setLoggedInUser(storedKeys);
      setUsername(storedKeys.username);
      onSuccess(storedKeys.sessionId, storedKeys.username);
    }
  }, [setUsername, onSuccess]);

  // Check for auto-login on mount
  useEffect(() => {
    if (open) {
      checkAutoLogin();
      void loadKeysAsync().then(setLoggedInUser);
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
    const localPasswordError = getPasswordError(password);
    setUsernameError(localUsernameError);
    setPasswordError(localPasswordError);
    setIsSubmitDisabled(
      !username || !password || !!localUsernameError || !!localPasswordError,
    );
  }, [username, password]);

  const handleLogout = () => {
    clearKeys();
    setLoggedInUser(null);
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
      const storedKeys = await loadKeysAsync();
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

      const userId = keys.userId || requireUserIdByUsername(username);
      const opaqueIdentity = await buildOpaqueUsernameEnvelope(
        username,
        keys.serverPublicKey,
      );

      // First login attempt - send opaque identity and public key
      const loginResponse = await fetch(apiPath('/api/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          usernameHash: opaqueIdentity.usernameHash,
          usernameCiphertext: opaqueIdentity.usernameCiphertext,
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
          userId,
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
          await storeKeys(
            {
              ...keys,
              serverPublicKey: verifyData.serverPublicKey,
              sessionId: verifyData.sessionId,
              userId: verifyData.userId || userId,
            },
            password,
          );
          setLoggedInUser({
            ...keys,
            serverPublicKey: verifyData.serverPublicKey,
            sessionId: verifyData.sessionId,
            userId: verifyData.userId || userId,
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
        await storeKeys(
          {
            ...keys,
            userId: loginData.userId || userId,
            sessionId: loginData.sessionId,
          },
          password,
        );
        setLoggedInUser({
          ...keys,
          userId: loginData.userId || userId,
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

  const isLoggedIn = !!loggedInUser?.sessionId;

  return (
    <BigDialog id="successModal" open={open}>
      {loginError && <InputError>{loginError}</InputError>}
      {isLoggedIn ? (
        <>
          <div>Logged in as: {loggedInUser!.username}</div>
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
            autoComplete="username"
            error={usernameError}
            minLength={VALIDATION.MIN_USERNAME_LENGTH}
            value={username}
            onChange={setUsername}
            onKeyDown={handleKeyDown}
            required={true}
          />
          <Input
            id="password"
            label="password:"
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            error={passwordError}
            minLength={10}
            value={password}
            onChange={setPassword}
            onKeyDown={handleKeyDown}
            required={true}
            rightSlot={
              <PasswordVisibilityToggle
                showing={showPassword}
                onToggle={() => setShowPassword((current) => !current)}
                disabled={isLoading}
              />
            }
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
