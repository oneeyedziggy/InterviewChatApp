'use client';
import { useEffect, useState, useCallback } from 'react';
import { apiPath, withBasePath } from '@/utils/appPaths';
import { Input } from '../components/Input';
import { buildOpaqueUsernameEnvelope } from '../utils/gpg';
import { styled } from 'styled-components';
import { VALIDATION } from '../constants';
import { AuthCard, PageShell } from '../components/layout/PageShell';
import {
  getPasswordError,
  getPasswordRequirementStatus,
  getUsernameError,
} from '../utils/authValidation';
import {
  generateKeyPair,
  storeKeys,
  loadKeysAsync,
  loadKeysForUserAsync,
  loadStoredKeyMetadataForUser,
  hasValidStoredKeys,
  forceReauthToLogin,
  getAllLocalUsers,
  clearKeys,
  deleteUserKeys,
  fetchServerPublicKey,
  decryptMessage,
  verifyChallengeResponseWithKeyRefresh,
  unlockStoredPrivateKeyForUser,
  updateStoredSessionForUser,
  type StoredKeys,
} from '../utils/gpg';
import {
  requireUserIdByUsername,
  storeIdentityDirectories,
} from '@/utils/identityMap';
import PasswordVisibilityToggle from '@/components/PasswordVisibilityToggle';
import { InviteInvalidNotice } from '../components/InviteInvalidNotice';
import {
  loadServerMembershipsAsync,
  upsertServerMembership,
  withServerQuery,
  type ServerMembership,
} from '../utils/serverRegistry';

const DeleteAccountDialog = styled.dialog`
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 2200;
  width: min(92vw, 440px);
  max-height: calc(100vh - 32px);
  overflow: auto;
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
  gap: 10px;
  margin-top: 4px;
`;

const DeleteAccountDialogActionButton = styled.button<{ $danger?: boolean }>`
  flex: 1 1 0;
  min-width: 0;
  margin-top: 0;
  padding: 11px 14px;
  font-size: 1rem;
  white-space: nowrap;

  ${({ $danger }) =>
    $danger
      ? `
          border-color: #b32030;
          background: #b32030;

          &:hover:not(:disabled) {
            background: #8f1421;
          }
        `
      : ''}
`;

const LoginPage = () => {
  const inviteServerLabel =
    typeof window === 'undefined'
      ? ''
      : new URLSearchParams(window.location.search)
          .get('serverLabel')
          ?.trim() || '';
  const [username, setUsername] = useState<string>('');
  const [selectedUser, setSelectedUser] = useState<string>('');
  const [localUsers, setLocalUsers] = useState<string[]>([]);
  const [usernameError, setUsernameError] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [confirmPassword, setConfirmPassword] = useState<string>('');
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [showConfirmPassword, setShowConfirmPassword] =
    useState<boolean>(false);
  const [passwordError, setPasswordError] = useState<string>('');
  const [confirmPasswordError, setConfirmPasswordError] = useState<string>('');
  const [loginError, setLoginError] = useState<string>('');
  const [isSubmitDisabled, setIsSubmitDisabled] = useState<boolean>(true);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [serverPublicKey, setServerPublicKey] = useState<string>('');
  const [deleteDialogUsername, setDeleteDialogUsername] = useState<string>('');
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState<boolean>(false);
  const [serverMemberships, setServerMemberships] = useState<
    ServerMembership[]
  >([]);
  const [activeServerId, setActiveServerId] = useState<string>('');
  const [serverAlias, setServerAlias] = useState<string>('');
  const [serverRequiresInvite, setServerRequiresInvite] = useState(false);
  const inviteCode =
    typeof window === 'undefined'
      ? ''
      : new URLSearchParams(window.location.search).get('invite') || '';

  const showUserSelect = localUsers.length > 1;
  const isExistingLocalUser = !!username && localUsers.includes(username);
  const requiresPasswordConfirmation = !!username && !isExistingLocalUser;
  const hasInvite = inviteCode.trim() !== '';
  const shouldRequireInvite =
    !!activeServerId && serverRequiresInvite && !hasInvite;

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

  const membershipLabelFor = useCallback(
    (serverId: string) =>
      inviteServerLabel ||
      serverMemberships.find(
        (membership) =>
          membership.serverId === serverId || membership.alias === serverId,
      )?.label ||
      serverAlias ||
      serverId,
    [inviteServerLabel, serverAlias, serverMemberships],
  );

  // Load local users (users with private keys) and check for auto-login on mount
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const url = new URL(window.location.href);
      const serverId = url.searchParams.get('server')?.trim() || '';
      const memberships = await loadServerMembershipsAsync();
      if (!cancelled) {
        setActiveServerId(serverId);
        setServerMemberships(memberships);
        if (serverId) {
          fetch(apiPath('/api/server-status'))
            .then(async (response) => {
              if (!response.ok) throw new Error('Unknown server');
              return (await response.json()) as {
                requiresInvite?: boolean;
                alias?: string;
              };
            })
            .then((status) => {
              if (cancelled) return;
              setServerRequiresInvite(status.requiresInvite === true);
              setServerAlias(status.alias?.trim() || '');
            })
            .catch(() => {
              if (!cancelled) setServerRequiresInvite(true);
            });
        }
      }
      const users = getAllLocalUsers();
      console.log('[LoginPage] Loaded local users:', users);
      if (!cancelled) {
        applyLocalUsers(users, true);
      }

      const storedKeys = await loadKeysAsync();
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
        window.location.href = withServerQuery(withBasePath('/'), serverId);
        return;
      }

      if (serverId) {
        fetchServerPublicKey()
          .then(setServerPublicKey)
          .catch((err) => {
            console.error(
              '[LoginPage] Failed to fetch server public key:',
              err,
            );
          });
      }
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
    const localPasswordError = getPasswordError(password);
    const localConfirmPasswordError =
      confirmPassword && confirmPassword !== password
        ? 'Passwords must match'
        : '';
    setUsernameError(localUsernameError);
    setPasswordError(localPasswordError);
    setConfirmPasswordError(localConfirmPasswordError);
    setIsSubmitDisabled(
      !username ||
        !password ||
        !!localUsernameError ||
        !!localPasswordError ||
        !!localConfirmPasswordError,
    );
  }, [username, password, confirmPassword]);

  const syncAutofilledInputs = useCallback(() => {
    const usernameInput = document.getElementById(
      'username',
    ) as HTMLInputElement | null;
    const passwordInput = document.getElementById(
      'password',
    ) as HTMLInputElement | null;
    const confirmInput = document.getElementById(
      'confirmPassword',
    ) as HTMLInputElement | null;

    const domUsername = usernameInput?.value?.trim() ?? '';
    const domPassword = passwordInput?.value ?? '';
    const domConfirm = confirmInput?.value ?? '';

    if (domUsername) {
      setUsername((prev) => (prev === domUsername ? prev : domUsername));
    }
    if (domPassword) {
      setPassword((prev) => (prev === domPassword ? prev : domPassword));
    }
    if (domConfirm) {
      setConfirmPassword((prev) => (prev === domConfirm ? prev : domConfirm));
    }
  }, []);

  useEffect(() => {
    const onMaybeAutofill = () => {
      syncAutofilledInputs();
    };

    // Initial sweep catches early and late autofill writes.
    const raf1 = window.requestAnimationFrame(onMaybeAutofill);
    const timeout1 = window.setTimeout(onMaybeAutofill, 0);
    const timeout2 = window.setTimeout(onMaybeAutofill, 120);
    const timeout3 = window.setTimeout(onMaybeAutofill, 450);
    const timeout4 = window.setTimeout(onMaybeAutofill, 1200);

    // Some browsers delay credential injection until post-hydration or focus.
    const interval = window.setInterval(onMaybeAutofill, 250);
    const stopInterval = window.setTimeout(() => {
      window.clearInterval(interval);
    }, 4000);

    const onVisibilityChange = () => {
      if (!document.hidden) {
        onMaybeAutofill();
      }
    };

    window.addEventListener('pageshow', onMaybeAutofill);
    window.addEventListener('focus', onMaybeAutofill);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.cancelAnimationFrame(raf1);
      window.clearTimeout(timeout1);
      window.clearTimeout(timeout2);
      window.clearTimeout(timeout3);
      window.clearTimeout(timeout4);
      window.clearTimeout(stopInterval);
      window.clearInterval(interval);
      window.removeEventListener('pageshow', onMaybeAutofill);
      window.removeEventListener('focus', onMaybeAutofill);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [syncAutofilledInputs]);

  const generateStrongPassword = useCallback(() => {
    const length = 32;
    const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const lower = 'abcdefghijklmnopqrstuvwxyz';
    const numbers = '0123456789';
    const special = '!@#$%^&*()-_=+[]{};:,.?/';
    const all = `${upper}${lower}${numbers}${special}`;

    const randomInt = (maxExclusive: number): number => {
      const bytes = new Uint32Array(1);
      crypto.getRandomValues(bytes);
      return bytes[0] % maxExclusive;
    };

    const pick = (source: string): string => source[randomInt(source.length)];

    const chars = [pick(upper), pick(lower), pick(numbers), pick(special)];
    while (chars.length < length) {
      chars.push(pick(all));
    }

    for (let i = chars.length - 1; i > 0; i -= 1) {
      const j = randomInt(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }

    const generated = chars.join('');
    setPassword(generated);
    setConfirmPassword(generated);
  }, []);

  const onSubmit = useCallback(
    async (username: string, password: string) => {
      setIsLoading(true);
      setLoginError('');

      const snarkyFallbackError =
        "Something went wrong at login, go grab a cup of tea, maybe we'll figure it out while you're gone";

      try {
        const registrationServerId = activeServerId;
        const registrationServerPublicKey = serverPublicKey;

        const storedMetadata = loadStoredKeyMetadataForUser(username);

        let keys: StoredKeys;
        const hasLocalKeys = !!storedMetadata;

        if (hasLocalKeys) {
          console.log('[LoginPage] Using existing keys for:', username);
          const unlocked = await unlockStoredPrivateKeyForUser(
            username,
            password,
          );
          if (!unlocked) {
            setLoginError('Incorrect password for this local user');
            setIsLoading(false);
            return;
          }

          const unlockedKeys = await loadKeysForUserAsync(username);
          if (!unlockedKeys) {
            setLoginError('Failed to load unlocked key material');
            setIsLoading(false);
            return;
          }

          keys = unlockedKeys;
          if (!keys.serverPublicKey) {
            keys.serverPublicKey = await fetchServerPublicKey();
          }
        } else {
          console.log('[LoginPage] Generating new keys for:', username);
          const keyPair = await generateKeyPair(username);
          const serverPubKey =
            registrationServerPublicKey ||
            (registrationServerId ? await fetchServerPublicKey() : '');

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
        const userId =
          storedMetadata?.userId ||
          keys.userId ||
          requireUserIdByUsername(username);

        if (!registrationServerId) {
          await storeKeys(
            {
              ...keys,
              userId,
            },
            password,
          );
          setLocalUsers(getAllLocalUsers());
          setLoginError('');
          window.location.href = withBasePath('/');
          return;
        }

        const opaqueIdentity = await buildOpaqueUsernameEnvelope(
          username,
          keys.serverPublicKey,
        );
        const loginPath = withServerQuery(
          apiPath('/api/login'),
          registrationServerId,
        );
        const loginResponse = await fetch(loginPath, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId,
            usernameHash: opaqueIdentity.usernameHash,
            usernameCiphertext: opaqueIdentity.usernameCiphertext,
            publicKey: keys.publicKey,
            inviteCode,
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
            await updateStoredSessionForUser({
              username,
              sessionId: verifyData.sessionId,
              userId: verifyData.userId || userId,
              serverPublicKey: verifyData.serverPublicKey,
              serverId: activeServerId,
            });

            if (activeServerId) {
              const updatedMemberships = upsertServerMembership({
                serverId: activeServerId,
                label: membershipLabelFor(activeServerId),
                username,
                userId: verifyData.userId || userId,
              });
              setServerMemberships(updatedMemberships);
            }

            // Refresh user list to include this user in dropdown
            const updatedUsers = getAllLocalUsers();
            setLocalUsers(updatedUsers);

            setLoginError('');
            // Redirect to main app
            window.location.href = withServerQuery(
              withBasePath('/'),
              activeServerId,
            );
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
          await storeKeys(
            {
              ...keys,
              userId: loginData.userId || userId,
              sessionId: loginData.sessionId,
            },
            password,
          );
          if (registrationServerId) {
            const updatedMemberships = upsertServerMembership({
              serverId: registrationServerId,
              label: membershipLabelFor(registrationServerId),
              username,
              userId: loginData.userId || userId,
            });
            setServerMemberships(updatedMemberships);
          }

          // Refresh user list to include this new user in dropdown
          const updatedUsers = getAllLocalUsers();
          setLocalUsers(updatedUsers);
          console.log('[LoginPage] User list updated:', updatedUsers);

          setLoginError('');
          // Redirect to main app
          window.location.href = withServerQuery(
            withBasePath('/'),
            registrationServerId,
          );
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
    [activeServerId, inviteCode, membershipLabelFor, serverPublicKey],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter' && !isSubmitDisabled && !isLoading) {
        event.preventDefault();
        void onSubmit(username, password);
      }
    },
    [isSubmitDisabled, isLoading, username, password, onSubmit],
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
      const storedKeys = await loadKeysForUserAsync(usernameToDelete);

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
      console.log('[DeleteAccount] Γ£ô Account deleted, redirecting...');
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
        {shouldRequireInvite && !isExistingLocalUser && <InviteInvalidNotice />}
        {loginError && <span className="app-auth-error">{loginError}</span>}
        {(!shouldRequireInvite || isExistingLocalUser) && (
          <form
            className="app-auth-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!isSubmitDisabled && !isLoading) {
                void onSubmit(username, password);
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
              autoComplete="username"
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
            <Input
              id="password"
              label="password:"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              error={passwordError}
              minLength={VALIDATION.MIN_PASSWORD_LENGTH}
              value={password}
              onChange={setPassword}
              onKeyDown={handleKeyDown}
              required={true}
              inlineRightSlot={
                requiresPasswordConfirmation && password.length === 0 ? (
                  <button
                    type="button"
                    className="app-primary-button app-auth-input-inline-button"
                    onClick={generateStrongPassword}
                    disabled={isLoading}
                  >
                    Generate
                  </button>
                ) : undefined
              }
              rightSlot={
                <PasswordVisibilityToggle
                  showing={showPassword}
                  onToggle={() => setShowPassword((current) => !current)}
                  disabled={isLoading}
                />
              }
            />
            {requiresPasswordConfirmation && (
              <Input
                id="confirmPassword"
                label="confirm password:"
                type={showConfirmPassword ? 'text' : 'password'}
                autoComplete="new-password"
                error={confirmPasswordError}
                minLength={VALIDATION.MIN_PASSWORD_LENGTH}
                value={confirmPassword}
                onChange={setConfirmPassword}
                onKeyDown={handleKeyDown}
                required={true}
                rightSlot={
                  <PasswordVisibilityToggle
                    showing={showConfirmPassword}
                    onToggle={() =>
                      setShowConfirmPassword((current) => !current)
                    }
                    disabled={isLoading}
                  />
                }
              />
            )}
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
        )}
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
              <DeleteAccountDialogActionButton
                type="button"
                onClick={closeDeleteDialog}
                disabled={isLoading}
              >
                Cancel
              </DeleteAccountDialogActionButton>
              <DeleteAccountDialogActionButton
                type="button"
                $danger
                onClick={() => void confirmDeleteAccount()}
                disabled={isLoading}
              >
                {isLoading ? 'Deleting...' : 'Delete Account'}
              </DeleteAccountDialogActionButton>
            </DeleteAccountDialogActions>
          </DeleteAccountDialogBody>
        </DeleteAccountDialog>
      </AuthCard>
    </PageShell>
  );
};
export default LoginPage;
