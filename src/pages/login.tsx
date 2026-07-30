'use client';
import { useEffect, useState, useCallback } from 'react';
import { apiPath, withBasePath } from '@/utils/appPaths';
import { Input } from '../components/Input';
import { buildOpaqueUsernameEnvelope } from '../utils/gpg';
import { styled } from 'styled-components';
import { VALIDATION } from '../constants';
import { AuthCard, PageShell } from '../components/layout/PageShell';
import { getUsernameError } from '../utils/authValidation';
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
import {
  requireUserIdByUsername,
  storeIdentityDirectories,
} from '@/utils/identityMap';

const DeleteAccountDialog = styled.dialog`
  width: min(92vw, 440px);
  border: 1px solid var(--app-border);
  border-radius: 14px;
  padding: 0;
  background: color-mix(in srgb, var(--app-surface) 96%, var(--app-panel));
  color: var(--app-fg);
  box-shadow: 0 20px 60px rgba(5, 18, 34, 0.32);

  &::backdrop {
    background: rgba(8, 16, 28, 0.48);
    backdrop-filter: blur(2px);
  }
`;

const DeleteAccountDialogBody = styled.div`
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px 20px;
`;

const DeleteAccountDialogTitle = styled.h2`
  margin: 0;
  font-size: 18px;
  font-weight: 800;
`;

const DeleteAccountDialogText = styled.p`
  margin: 0;
  font-size: 14px;
  line-height: 1.5;
  color: var(--app-muted);
`;

const DeleteAccountDialogActions = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 4px;
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
  const [deleteDialogUsername, setDeleteDialogUsername] = useState<string>('');
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState<boolean>(false);

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
        const storedKeys = loadKeysForUser(username);

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
        const userId = storedKeys?.userId || requireUserIdByUsername(username);
        const opaqueIdentity = await buildOpaqueUsernameEnvelope(
          username,
          keys.serverPublicKey,
        );
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
            '[LoginPage] Received challenge, performing challenge-response',
          );

          // Decrypt the challenge with our private key
          const decryptedUUID = await decryptMessage(
            loginData.challenge,
            keys.privateKey,
          );
          console.log('[LoginPage] Decrypted UUID:', decryptedUUID);

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
            if (verifyData.userId) {
              storeIdentityDirectories({
                userDirectory: { [verifyData.userId]: username },
                currentUserId: verifyData.userId,
              });
            }
            // Store keys with session ID
            storeKeys({
              ...keys,
              serverPublicKey: verifyData.serverPublicKey,
              sessionId: verifyData.sessionId,
              userId: verifyData.userId || userId,
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

          if (loginData.userId) {
            storeIdentityDirectories({
              userDirectory: { [loginData.userId]: username },
              currentUserId: loginData.userId,
            });
          }

          // Store server public key if provided
          if (loginData.serverPublicKey) {
            keys.serverPublicKey = loginData.serverPublicKey;
          }

          // Store keys with session ID (this will add user to ALL_USERS list)
          storeKeys({
            ...keys,
            userId: loginData.userId || userId,
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

  const handleDeleteAccount = useCallback((usernameToDelete: string) => {
    setDeleteDialogUsername(usernameToDelete);
    setIsDeleteDialogOpen(true);
  }, []);

  const closeDeleteDialog = useCallback(() => {
    if (isLoading) {
      return;
    }
    setIsDeleteDialogOpen(false);
    setDeleteDialogUsername('');
  }, [isLoading]);

  const confirmDeleteAccount = useCallback(async () => {
    const usernameToDelete = deleteDialogUsername;
    if (!usernameToDelete) {
      closeDeleteDialog();
      return;
    }

    setIsLoading(true);
    setLoginError('');

    try {
      // First, login to authenticate
      console.log('[DeleteAccount] Logging in to authenticate...');

      // Load keys for the user to delete
      const storedKeys = loadKeysForUser(usernameToDelete);

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
      const userId = requireUserIdByUsername(usernameToDelete);
      const opaqueIdentity = await buildOpaqueUsernameEnvelope(
        usernameToDelete,
        storedKeys.serverPublicKey,
      );
      const loginResponse = await fetch(apiPath('/api/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          usernameHash: opaqueIdentity.usernameHash,
          usernameCiphertext: opaqueIdentity.usernameCiphertext,
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
          userId,
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
          userId,
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
      closeDeleteDialog();
    }
  }, [closeDeleteDialog, deleteDialogUsername, refreshUserList]);

  return (
    <PageShell className="app-auth-shell">
      <AuthCard className="app-auth-card-content">
        <h1 className="app-auth-title">Login</h1>
        {loginError && <span className="app-auth-error">{loginError}</span>}
        <form
          className="app-auth-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!isSubmitDisabled && !isLoading) {
              onSubmit(username);
            }
          }}
        >
          {showUserSelect && (
            <>
              <label htmlFor="userSelect" className="app-auth-label">
                Select existing user:
              </label>
              <select
                id="userSelect"
                className="app-text-input app-auth-select"
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
              </select>
              <div className="app-auth-divider">or</div>
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
          <button
            type="submit"
            disabled={isSubmitDisabled || isLoading}
            className="app-primary-button app-auth-submit-button"
          >
            {isLoading
              ? 'Logging in...'
              : username && localUsers.includes(username)
                ? 'Login as ' + username
                : 'Login / Create User'}
          </button>
        </form>
        {username && localUsers.includes(username) && (
          <button
            type="button"
            onClick={() => handleDeleteAccount(username)}
            disabled={isLoading}
            className="app-primary-button app-auth-danger-button"
          >
            {isLoading ? 'Processing...' : 'Delete Account'}
          </button>
        )}
        <div className="app-auth-helper">
          {username && localUsers.includes(username)
            ? 'Logging in with existing keys for ' + username
            : 'GPG keys will be generated automatically for new users'}
        </div>

        <DeleteAccountDialog
          open={isDeleteDialogOpen}
          aria-labelledby="delete-account-title"
          aria-describedby="delete-account-description"
          onCancel={(event) => {
            event.preventDefault();
            closeDeleteDialog();
          }}
        >
          <DeleteAccountDialogBody>
            <DeleteAccountDialogTitle id="delete-account-title">
              Delete account?
            </DeleteAccountDialogTitle>
            <DeleteAccountDialogText id="delete-account-description">
              Are you sure you want to delete the account &quot;
              {deleteDialogUsername}&quot;? This action cannot be undone.
            </DeleteAccountDialogText>
            <DeleteAccountDialogActions>
              <button
                type="button"
                className="app-primary-button"
                onClick={closeDeleteDialog}
                disabled={isLoading}
              >
                Cancel
              </button>
              <button
                type="button"
                className="app-primary-button app-auth-danger-button"
                onClick={() => void confirmDeleteAccount()}
                disabled={isLoading}
              >
                {isLoading ? 'Deleting...' : 'Delete Account'}
              </button>
            </DeleteAccountDialogActions>
          </DeleteAccountDialogBody>
        </DeleteAccountDialog>
      </AuthCard>
    </PageShell>
  );
}
