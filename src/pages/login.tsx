'use client';
import { useEffect, useState, useCallback } from 'react';
import { apiPath, withBasePath } from '@/utils/appPaths';
import { Input } from '../components/Input';
import { styled } from 'styled-components';
import { VALIDATION } from '../constants';
import {
  generateKeyPair,
  storeKeys,
  loadKeys,
  loadKeysForUser,
  hasValidStoredKeys,
  forceReauthToLogin,
  getAllLocalUsers,
  getAllUsersWithPublicKeys,
  isLocalUser,
  clearKeys,
  deleteUserKeys,
  loadUserPublicKeys,
  fetchServerPublicKey,
  decryptMessage,
  verifyChallengeResponseWithKeyRefresh,
  type StoredKeys,
} from '../utils/gpg';

const LoginContainer = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background: #f5f5f5;
`;

const LoginBox = styled.div`
  background: white;
  padding: 40px;
  border-radius: 8px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
  width: 100%;
  max-width: 400px;
  text-align: center;
`;

const InputError = styled.span`
  color: red;
  display: block;
  margin-top: 5px;
  font-size: 14px;
`;

const LoginButton = styled.button`
  width: 100%;
  padding: 12px;
  margin-top: 20px;
  font-size: 16px;
  border: none;
  border-radius: 6px;
  background: #3498db;
  color: white;
  cursor: pointer;
  transition: background 0.2s;

  &:hover:not(:disabled) {
    background: #2980b9;
  }

  &:disabled {
    background: #95a5a6;
    cursor: not-allowed;
  }
`;

const DeleteButton = styled.button`
  width: 100%;
  padding: 12px;
  margin-top: 10px;
  font-size: 16px;
  border: none;
  border-radius: 6px;
  background: #e74c3c;
  color: white;
  cursor: pointer;
  transition: background 0.2s;

  &:hover:not(:disabled) {
    background: #c0392b;
  }

  &:disabled {
    background: #95a5a6;
    cursor: not-allowed;
  }
`;

const InfoText = styled.div`
  margin-top: 10px;
  font-size: 12px;
  color: #666;
`;

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

const UserSelect = styled.select`
  width: 100%;
  padding: 12px;
  margin-top: 10px;
  font-size: 16px;
  border: 1px solid #ddd;
  border-radius: 6px;
`;

const Divider = styled.div`
  margin: 20px 0;
  text-align: center;
  color: #999;
  font-size: 14px;
  position: relative;

  &::before,
  &::after {
    content: '';
    position: absolute;
    top: 50%;
    width: 40%;
    height: 1px;
    background: #ddd;
  }

  &::before {
    left: 0;
  }

  &::after {
    right: 0;
  }
`;

export default function LoginPage() {
  const [username, setUsername] = useState<string>('');
  const [selectedUser, setSelectedUser] = useState<string>('');
  const [localUsers, setLocalUsers] = useState<string[]>([]);
  const [usernameError, setUsernameError] = useState<string>('');
  const [loginError, setLoginError] = useState<string>('');
  const [isSubmitDisabled, setIsSubmitDisabled] = useState<boolean>(true);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [serverPublicKey, setServerPublicKey] = useState<string>('');

  const showUserSelect = localUsers.length > 1;

  const applyLocalUsers = useCallback(
    (users: string[], preselectSingle = false) => {
      setLocalUsers(users);
      if (preselectSingle && users.length === 1) {
        setUsername(users[0]);
        setSelectedUser(users[0]);
      }
    },
    [],
  );

  // Load local users (users with private keys) and check for auto-login on mount
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const users = getAllLocalUsers();
      console.log('[LoginPage] Loaded local users:', users);
      if (!cancelled) {
        applyLocalUsers(users, true);
      }

      const storedKeys = loadKeys();
      const keysValid = await hasValidStoredKeys();

      if (!keysValid) {
        if (storedKeys?.sessionId) {
          console.log(
            '[LoginPage] Invalid or missing private key, redirecting to logout',
          );
          forceReauthToLogin();
          return;
        }
      } else if (storedKeys?.sessionId) {
        console.log('[LoginPage] Auto-login with stored keys');
        window.location.href = withBasePath('/');
        return;
      }

      fetchServerPublicKey()
        .then(setServerPublicKey)
        .catch((err) => {
          console.error('[LoginPage] Failed to fetch server public key:', err);
        });
    })();

    return () => {
      cancelled = true;
    };
  }, [applyLocalUsers]);

  // Refresh user list when page becomes visible (in case keys were added in another tab)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        const users = getAllLocalUsers();
        console.log(
          '[LoginPage] Refreshed local users on visibility change:',
          users,
        );
        setLocalUsers(users);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () =>
      document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  // Update username when selected user changes
  useEffect(() => {
    if (selectedUser) {
      setUsername(selectedUser);
    }
  }, [selectedUser]);

  // Check if username has changed from selected user
  useEffect(() => {
    // If username doesn't match selected user, clear selection
    if (selectedUser && username !== selectedUser) {
      setSelectedUser('');
    }
  }, [username, selectedUser]);

  // Refresh user list after operations
  const refreshUserList = useCallback(() => {
    const users = getAllLocalUsers();
    setLocalUsers(users);
    if (users.length === 1) {
      setUsername(users[0]);
      setSelectedUser(users[0]);
    }
  }, []);

  useEffect(() => {
    const localUsernameError = getUsernameError(username);
    setUsernameError(localUsernameError);
    setIsSubmitDisabled(!username || !!localUsernameError);
  }, [username]);

  const onSubmit = useCallback(
    async (username: string) => {
      setIsLoading(true);
      setLoginError('');

      const snarkyFallbackError =
        "Something went wrong at login, go grab a cup of tea, maybe we'll figure it out while you're gone";

      try {
        // Check if we have stored keys for this username
        let storedKeys = loadKeysForUser(username);
        if (!storedKeys) {
          // Fallback to legacy loadKeys
          const legacyKeys = loadKeys();
          if (legacyKeys && legacyKeys.username === username) {
            storedKeys = legacyKeys;
          }
        }

        let keys: StoredKeys;
        const hasLocalKeys = storedKeys && storedKeys.username === username;

        if (hasLocalKeys && storedKeys) {
          // Use existing keys - this is an existing user with stored keys
          console.log('[LoginPage] Using existing keys for:', username);
          keys = storedKeys;

          // Get server public key if we don't have it
          if (!keys.serverPublicKey) {
            keys.serverPublicKey = await fetchServerPublicKey();
          }
        } else {
          // Generate new keys for new user
          console.log('[LoginPage] Generating new keys for:', username);
          const keyPair = await generateKeyPair(username);

          // Get server public key
          const serverPubKey =
            serverPublicKey || (await fetchServerPublicKey());

          keys = {
            username,
            privateKey: keyPair.privateKey,
            publicKey: keyPair.publicKey,
            serverPublicKey: serverPubKey,
          };
        }

        // First login attempt - send username and public key
        // Server will:
        // - Send challenge if user exists and public key matches (for existing users)
        // - Register new user if user doesn't exist (for new users)
        // - Reject if user exists but public key doesn't match
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
            '[LoginPage] Received challenge, performing challenge-response',
          );

          // Decrypt the challenge with our private key
          const decryptedUUID = await decryptMessage(
            loginData.challenge,
            keys.privateKey,
          );
          console.log('[LoginPage] Decrypted UUID:', decryptedUUID);

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

            // Refresh user list to include this user in dropdown
            const updatedUsers = getAllLocalUsers();
            setLocalUsers(updatedUsers);

            setLoginError('');
            // Redirect to main app
            window.location.href = withBasePath('/');
          } else {
            setLoginError(verifyData.error || snarkyFallbackError);
          }
        } else if (loginData.sessionId) {
          // New user registration successful
          console.log('[LoginPage] New user registered successfully');

          // Store server public key if provided
          if (loginData.serverPublicKey) {
            keys.serverPublicKey = loginData.serverPublicKey;
          }

          // Store keys with session ID (this will add user to ALL_USERS list)
          storeKeys({
            ...keys,
            sessionId: loginData.sessionId,
          });

          // Refresh user list to include this new user in dropdown
          const updatedUsers = getAllLocalUsers();
          setLocalUsers(updatedUsers);
          console.log('[LoginPage] User list updated:', updatedUsers);

          setLoginError('');
          // Redirect to main app
          window.location.href = withBasePath('/');
        } else {
          setLoginError(loginData.error || snarkyFallbackError);
        }
      } catch (err) {
        console.error('[LoginPage] Login error:', err);
        setLoginError(snarkyFallbackError);
      } finally {
        setIsLoading(false);
      }
    },
    [serverPublicKey],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter' && !isSubmitDisabled && !isLoading) {
        event.preventDefault();
        onSubmit(username);
      }
    },
    [isSubmitDisabled, isLoading, username, onSubmit],
  );

  const handleDeleteAccount = useCallback(
    async (usernameToDelete: string) => {
      if (
        !confirm(
          `Are you sure you want to delete the account "${usernameToDelete}"? This action cannot be undone.`,
        )
      ) {
        return;
      }

      setIsLoading(true);
      setLoginError('');

      try {
        // First, login to authenticate
        console.log('[DeleteAccount] Logging in to authenticate...');

        // Load keys for the user to delete
        let storedKeys = loadKeysForUser(usernameToDelete);
        if (!storedKeys) {
          const legacyKeys = loadKeys();
          if (legacyKeys && legacyKeys.username === usernameToDelete) {
            storedKeys = legacyKeys;
          }
        }

        if (!storedKeys || storedKeys.username !== usernameToDelete) {
          setLoginError('Cannot find keys for this user');
          setIsLoading(false);
          return;
        }

        // Get server public key if needed
        if (!storedKeys.serverPublicKey) {
          storedKeys.serverPublicKey = await fetchServerPublicKey();
        }

        // Perform login to get session
        const loginResponse = await fetch(apiPath('/api/login'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: usernameToDelete,
            publicKey: storedKeys.publicKey,
          }),
        });

        const loginData = await loginResponse.json();

        if (loginData.error) {
          setLoginError(loginData.error);
          setIsLoading(false);
          return;
        }

        let sessionId: string;

        // Handle challenge-response if needed
        if (loginData.challenge) {
          const decryptedUUID = await decryptMessage(
            loginData.challenge,
            storedKeys.privateKey,
          );
          const verifyData = await verifyChallengeResponseWithKeyRefresh({
            username: usernameToDelete,
            decryptedUUID,
            serverPublicKey: storedKeys.serverPublicKey,
          });
          if (verifyData.error || !verifyData.sessionId) {
            setLoginError(verifyData.error || 'Authentication failed');
            setIsLoading(false);
            return;
          }
          storedKeys.serverPublicKey = verifyData.serverPublicKey;
          sessionId = verifyData.sessionId;
        } else if (loginData.sessionId) {
          sessionId = loginData.sessionId;
        } else {
          setLoginError('Failed to get session');
          setIsLoading(false);
          return;
        }

        // Now delete the user account
        console.log('[DeleteAccount] Deleting user account...');
        const deleteResponse = await fetch(apiPath('/api/delete-user'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: usernameToDelete,
            sessionId: sessionId,
          }),
        });

        const deleteData = await deleteResponse.json();

        if (deleteData.error || !deleteData.success) {
          setLoginError(deleteData.error || 'Failed to delete account');
          setIsLoading(false);
          return;
        }

        // Delete local keys
        console.log('[DeleteAccount] Deleting local keys...');
        deleteUserKeys(usernameToDelete);

        // Clear any current session
        clearKeys();

        // Refresh user list
        refreshUserList();
        setSelectedUser('');
        setUsername('');

        // Redirect to login page (refresh)
        console.log('[DeleteAccount] ✓ Account deleted, redirecting...');
        window.location.href = withBasePath('/login/');
      } catch (err) {
        console.error('[DeleteAccount] Error:', err);
        setLoginError('Failed to delete account. Please try again.');
        setIsLoading(false);
      }
    },
    [refreshUserList],
  );

  return (
    <LoginContainer>
      <LoginBox>
        <h1>Login</h1>
        {loginError && <InputError>{loginError}</InputError>}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!isSubmitDisabled && !isLoading) {
              onSubmit(username);
            }
          }}
        >
          {showUserSelect && (
            <>
              <label
                htmlFor="userSelect"
                style={{
                  display: 'block',
                  marginBottom: '5px',
                  textAlign: 'left',
                }}
              >
                Select existing user:
              </label>
              <UserSelect
                id="userSelect"
                value={selectedUser}
                onChange={(e) => {
                  setSelectedUser(e.target.value);
                  if (e.target.value) {
                    setUsername(e.target.value);
                  }
                }}
              >
                <option value="">-- Select a user --</option>
                {localUsers.map((user) => (
                  <option key={user} value={user}>
                    {user}
                  </option>
                ))}
              </UserSelect>
              <Divider>or</Divider>
            </>
          )}
          <Input
            id="username"
            label="username:"
            type="text"
            error={usernameError}
            minLength={VALIDATION.MIN_USERNAME_LENGTH}
            value={username}
            onChange={(val) => {
              setUsername(val);
              // If the new username is in the local users list, update selectedUser
              // Otherwise, clear selection
              if (localUsers.includes(val)) {
                setSelectedUser(val);
              } else {
                setSelectedUser('');
              }
            }}
            onKeyDown={handleKeyDown}
            required={true}
            autoFocus={localUsers.length === 0}
          />
          <LoginButton type="submit" disabled={isSubmitDisabled || isLoading}>
            {isLoading
              ? 'Logging in...'
              : username && localUsers.includes(username)
                ? 'Login as ' + username
                : 'Login / Create User'}
          </LoginButton>
        </form>
        {username && localUsers.includes(username) && (
          <DeleteButton
            type="button"
            onClick={() => handleDeleteAccount(username)}
            disabled={isLoading}
          >
            {isLoading ? 'Processing...' : 'Delete Account'}
          </DeleteButton>
        )}
        <InfoText>
          {username && localUsers.includes(username)
            ? 'Logging in with existing keys for ' + username
            : 'GPG keys will be generated automatically for new users'}
        </InfoText>
      </LoginBox>
    </LoginContainer>
  );
}
