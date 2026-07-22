import io, { type Socket } from 'socket.io-client';
import { socketIoPath } from '@/utils/appPaths';
import { type Message, type Messages } from '../types/types';
import { SOCKET_EVENTS, DEFAULT_ROOM, SYSTEM_MESSAGES } from '../constants';
import {
  storeUserPublicKeys,
  loadUserPublicKeyEntries,
  decryptMessageForUser,
  loadKeys,
} from '../utils/gpg';
import { getBlockedUsers } from '../utils/userSettings';
import type { Dispatch, SetStateAction } from 'react';

type JoinRequest = {
  requestingUser: string;
  room: string;
  timestamp: number;
};

function normalizeMessageState(message: Message): Message {
  if (message.deleted || message.content === 'Message deleted') {
    return {
      ...message,
      content: 'Message deleted',
      deleted: true,
      encryptedFor: undefined,
      versions: undefined,
      currentVersion: undefined,
      visibleTo: undefined,
      voteTotal: undefined,
      userVotes: undefined,
      edited: false,
    };
  }

  return message;
}

function isBlockedAuthor(message: Message, blockedUsers: Set<string>): boolean {
  return message.username !== 'system' && blockedUsers.has(message.username);
}

type InitSocketArgs = {
  authToken: string;
  username: string;
  leftRooms: Set<string>;
  setAuthToken: Dispatch<SetStateAction<string>>;
  setChatValues: Dispatch<SetStateAction<Messages>>;
  setUserList: Dispatch<SetStateAction<string[]>>;
  setLoggedInUsers: Dispatch<SetStateAction<string[]>>;
  setActiveUsers: Dispatch<SetStateAction<string[]>>;
  setRoomList: Dispatch<SetStateAction<string[]>>;
  setCurrentRoom: Dispatch<SetStateAction<string>>;
  setUserLastSeen: Dispatch<SetStateAction<Record<string, number>>>;
  setRoomMembers: Dispatch<SetStateAction<Record<string, Set<string>>>>;
  setActiveJoinRequests: Dispatch<SetStateAction<JoinRequest[]>>;
  getSocket: () => Socket | undefined;
  setSocket: (next: Socket | undefined) => void;
};

export async function initializeHomeSocket({
  authToken,
  username,
  leftRooms,
  setAuthToken,
  setChatValues,
  setUserList,
  setLoggedInUsers,
  setActiveUsers,
  setRoomList,
  setCurrentRoom,
  setUserLastSeen,
  setRoomMembers,
  setActiveJoinRequests,
  getSocket,
  setSocket,
}: InitSocketArgs) {
  let socket = getSocket();
  console.log('[Socket] ===== INITIALIZING SOCKET =====');
  console.log('[Socket] Token:', authToken);
  console.log('[Socket] Username:', username);
  console.log('[Socket] Current window location:', window.location.href);

  // Disconnect existing socket if any
  if (socket && socket.connected) {
    console.log(
      '[Socket] Disconnecting existing socket before creating new one',
    );
    socket.disconnect();
    socket = undefined as any;
    setSocket(undefined);
  }
  if ((window as any).__socket && (window as any).__socket.connected) {
    console.log(
      '[Socket] Disconnecting existing window socket before creating new one',
    );
    (window as any).__socket.disconnect();
    (window as any).__socket = undefined;
  }

  // Connect to Socket.IO server - use current origin (should be localhost:3000)
  const socketUrl = window.location.origin;
  console.log('[Socket] Connecting to:', socketUrl);

  socket = io(socketUrl, {
    path: socketIoPath(),
    auth: {
      username,
    },
    transports: ['polling', 'websocket'],
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
    forceNew: true, // Force a new connection
  });

  const activeSocket = socket;

  setSocket(activeSocket);

  // Store socket reference globally for doSend and access grant
  (window as any).__socket = activeSocket;

  console.log('[Socket] Socket instance created:', activeSocket);
  console.log('[Socket] Socket ID:', activeSocket.id);
  console.log('[Socket] Socket connected:', activeSocket.connected);
  console.log('[Socket] Setting up listeners...');

  socket.on('disconnect', (reason) => {
    console.log('[Socket] ✗ Socket disconnected, reason:', reason);
  });

  socket.on('connect_error', (error) => {
    console.error('[Socket] ✗ Connection error:', error);
  });

  socket.on('reconnect', (attemptNumber) => {
    console.log(
      '[Socket] ✓ Socket reconnected after',
      attemptNumber,
      'attempts',
    );
    // Update window reference
    (window as any).__socket = activeSocket;
  });

  socket.on(SOCKET_EVENTS.SERVER_ACTION_RESULT, (result) => {
    const action = result?.action || 'action';
    const success = !!result?.success;
    const code = result?.code || 'unknown';
    const message = result?.message || 'Request failed';

    if (success) {
      console.log(`[ActionResult] ${action} success: ${message}`);
      return;
    }

    let userMessage = `${action} failed: ${message}`;
    if (code === 'session_expired') {
      userMessage = 'Session expired. Please log in again.';
    } else if (code === 'unauthorized') {
      userMessage = 'Unauthorized action.';
    } else if (code === 'not_owner') {
      userMessage = 'You can only edit or delete your own messages.';
    }

    alert(userMessage);
    console.warn('[ActionResult] rejected:', { action, code, message });
  });

  socket.on(SOCKET_EVENTS.INITIAL_DATA, async (data) => {
    console.log('[Socket] ===== INITIAL_DATA RECEIVED =====');
    console.log('[Socket] Messages:', data?.messages);
    console.log('[Socket] Messages type:', typeof data?.messages);
    console.log(
      '[Socket] Messages keys:',
      data?.messages ? Object.keys(data.messages) : 'none',
    );
    console.log('[Socket] Rooms:', data?.rooms);
    console.log('[Socket] Rooms type:', typeof data?.rooms);
    console.log(
      '[Socket] Rooms length:',
      Array.isArray(data?.rooms) ? data.rooms.length : 'not array',
    );
    console.log('[Socket] Users:', data?.users);
    console.log('[Socket] Users type:', typeof data?.users);
    console.log(
      '[Socket] Users length:',
      Array.isArray(data?.users) ? data.users.length : 'not array',
    );

    if (data?.userPubKeys) {
      console.log(
        '[Socket] ✓ Storing user public keys:',
        Object.keys(data.userPubKeys).length,
        'keys',
      );
      storeUserPublicKeys(data.userPubKeys);
    } else {
      console.warn('[Socket] ✗ No userPubKeys in INITIAL_DATA');
    }

    if (data?.messages) {
      const keys = loadKeys();
      const decryptedMessages: Messages = {};

      for (const [room, messages] of Object.entries(data.messages)) {
        const roomMessages = messages as Message[];
        const blockedUsers = new Set(getBlockedUsers());
        const visibleRoomMessages = roomMessages.filter(
          (msg) => !isBlockedAuthor(msg, blockedUsers),
        );
        decryptedMessages[room] = await Promise.all(
          visibleRoomMessages.map(async (msg: Message) => {
            if (msg.encryptedFor && keys) {
              const encrypted = msg.encryptedFor[keys.username];
              if (encrypted) {
                try {
                  const decrypted = await decryptMessageForUser(
                    encrypted,
                    keys.privateKey,
                  );
                  return normalizeMessageState({ ...msg, content: decrypted });
                } catch (error) {
                  console.error('[Socket] ✗ Failed to decrypt message:', error);
                  return normalizeMessageState(msg);
                }
              }
            }
            return normalizeMessageState(msg);
          }),
        );
      }

      console.log(
        '[Socket] ✓ Setting chat values, count:',
        Object.keys(decryptedMessages).length,
      );
      setChatValues(decryptedMessages);
    } else {
      console.warn('[Socket] ✗ No messages in INITIAL_DATA');
    }

    if (data?.rooms) {
      console.log('[Socket] ✓ Setting room list:', data.rooms);
      setRoomList(data.rooms);
    } else {
      console.warn('[Socket] ✗ No rooms in INITIAL_DATA');
    }

    if (data?.users) {
      console.log('[Socket] ✓ Setting user list:', data.users);
      setUserList(data.users);
    } else {
      console.warn('[Socket] ✗ No users in INITIAL_DATA');
    }

    if (data?.loggedInUsers || data?.activeUsers) {
      console.log('[Socket] ✓ Setting logged in users:', data.loggedInUsers);
      console.log('[Socket] ✓ Setting active users:', data.activeUsers);
      setLoggedInUsers(data.loggedInUsers || []);
      setActiveUsers(data.activeUsers || []);
    } else if (data?.users) {
      setLoggedInUsers(data.users || []);
      setActiveUsers([]);
    }

    console.log('[Socket] ===== INITIAL_DATA PROCESSING COMPLETE =====');
  });

  socket.on(SOCKET_EVENTS.SERVER_MESSAGE, async (data) => {
    console.log('[Socket] SERVER_MESSAGE received');

    // Update user last seen for users in messages
    if (data?.messages) {
      setUserLastSeen((prev) => {
        const updated = { ...prev };
        Object.values(data.messages).forEach((roomMessages: any) => {
          if (Array.isArray(roomMessages)) {
            roomMessages.forEach((msg: Message) => {
              if (msg.username) {
                updated[msg.username] = Date.now();
              }
            });
          }
        });
        return updated;
      });
    }

    // Check if this is an access grant update - handle it specially
    if (data?.accessGrant) {
      const { originalRoom, messageTimestamp, encryptedFor, encryptedMessage } =
        data.accessGrant;

      // Handle new format (encryptedFor map) or old format (encryptedMessage)
      const encryptedMap =
        encryptedFor ||
        (encryptedMessage && username ? { [username]: encryptedMessage } : {});

      console.log('[AccessGrant] ===== PROCESSING ACCESS GRANT =====');
      console.log(
        '[AccessGrant] Room:',
        originalRoom,
        'timestamp:',
        messageTimestamp,
      );
      console.log(
        '[AccessGrant] encryptedFor users from accessGrant:',
        Object.keys(encryptedMap),
      );

      // If server sent updated messages, use those (they include the new version)
      if (data?.messages && data.messages[originalRoom]) {
        const keys = loadKeys();
        if (!keys) {
          console.error('[AccessGrant] No keys available for decryption');
          return;
        }

        const roomMessages = data.messages[originalRoom] as Message[];

        console.log(
          '[AccessGrant] Processing',
          roomMessages.length,
          'messages from server for room:',
          originalRoom,
          'for user:',
          keys.username,
        );

        // Log details about each message
        roomMessages.forEach((msg, idx) => {
          console.log(
            `[AccessGrant] Message ${idx}: timestamp=${msg.timestamp}, username=${msg.username}, hasEncryptedFor=${!!msg.encryptedFor}, encryptedForKeys=${Object.keys(msg.encryptedFor || {}).join(',')}, hasVersions=${!!msg.versions}, versionsCount=${msg.versions?.length || 0}`,
          );
          if (msg.versions && msg.versions.length > 0) {
            console.log(
              `[AccessGrant] Message ${idx} newest version encryptedForKeys:`,
              Object.keys(msg.versions[0].encryptedFor || {}).join(','),
            );
          }
        });

        // Decrypt messages we have access to
        const decryptedMessages = await Promise.all(
          roomMessages.map(async (msg: Message) => {
            // If message already has decrypted content, keep it (but verify it's not the lock emoji)
            if (
              msg.content &&
              msg.content.trim() !== '' &&
              !msg.content.includes('🔒') &&
              !msg.content.includes('[Encrypted message]')
            ) {
              console.log(
                '[AccessGrant] Message',
                msg.timestamp,
                'already has decrypted content, keeping it',
              );
              return msg;
            }

            // For all messages, try to decrypt if we have access
            // Check both encryptedFor and versions array (prioritize newest version)
            let encryptedData: string | null = null;
            let sourceEncryptedFor: Record<string, string> | null = null;

            // First check versions array (newest version takes precedence)
            if (msg.versions && msg.versions.length > 0) {
              const newestVersion = msg.versions[0];
              if (
                newestVersion.encryptedFor &&
                newestVersion.encryptedFor[keys.username]
              ) {
                encryptedData = newestVersion.encryptedFor[keys.username];
                sourceEncryptedFor = newestVersion.encryptedFor;
                console.log(
                  '[AccessGrant] Found encryption key in newest version for message',
                  msg.timestamp,
                );
              }
            }

            // Fallback to current encryptedFor if not found in versions
            if (
              !encryptedData &&
              msg.encryptedFor &&
              msg.encryptedFor[keys.username]
            ) {
              encryptedData = msg.encryptedFor[keys.username];
              sourceEncryptedFor = msg.encryptedFor;
              console.log(
                '[AccessGrant] Found encryption key in encryptedFor for message',
                msg.timestamp,
              );
            }

            if (encryptedData) {
              try {
                console.log(
                  '[AccessGrant] ===== DECRYPTING MESSAGE FOR REQUESTING USER =====',
                );
                console.log('[AccessGrant] Message timestamp:', msg.timestamp);
                console.log('[AccessGrant] User:', keys.username);
                console.log(
                  '[AccessGrant] Encrypted data length:',
                  encryptedData.length,
                );
                console.log(
                  '[AccessGrant] Encrypted data (first 200 chars):',
                  encryptedData.substring(0, 200),
                );
                const decrypted = await decryptMessageForUser(
                  encryptedData,
                  keys.privateKey,
                );
                console.log(
                  '[AccessGrant] ✓ Decrypted message for',
                  keys.username,
                  'timestamp:',
                  msg.timestamp,
                  'content length:',
                  decrypted.length,
                );
                console.log(
                  '[AccessGrant] Decrypted content (first 200 chars):',
                  decrypted.substring(0, 200),
                );
                console.log(
                  '[AccessGrant] Decrypted content (full):',
                  decrypted,
                );
                return {
                  ...msg,
                  content: decrypted,
                  encryptedFor: sourceEncryptedFor || msg.encryptedFor, // Use the source that had the key
                };
              } catch (error) {
                console.error(
                  '[AccessGrant] ✗ Failed to decrypt message:',
                  error,
                );
                return msg;
              }
            }

            // If this is the target message, log why we couldn't decrypt
            if (msg.timestamp === messageTimestamp) {
              console.log(
                '[AccessGrant] ⚠ Target message (timestamp:',
                messageTimestamp,
                ') could not be decrypted',
              );
              console.log(
                '[AccessGrant] Message encryptedFor keys:',
                Object.keys(msg.encryptedFor || {}),
              );
              console.log('[AccessGrant] Current user:', keys.username);
              console.log(
                '[AccessGrant] Has access in encryptedFor:',
                !!(msg.encryptedFor && msg.encryptedFor[keys.username]),
              );
              if (msg.versions && msg.versions.length > 0) {
                console.log(
                  '[AccessGrant] Versions count:',
                  msg.versions.length,
                );
                console.log(
                  '[AccessGrant] Newest version encryptedFor keys:',
                  Object.keys(msg.versions[0].encryptedFor || {}),
                );
                console.log(
                  '[AccessGrant] Has access in newest version:',
                  !!(
                    msg.versions[0].encryptedFor &&
                    msg.versions[0].encryptedFor[keys.username]
                  ),
                );
              } else {
                console.log('[AccessGrant] No versions array in message');
              }
            }

            return msg;
          }),
        );

        // Merge with existing chat values (create room if it doesn't exist)
        setChatValues((prev) => {
          const updated = { ...prev };
          // Merge messages: update existing ones, add new ones
          if (!updated[originalRoom]) {
            updated[originalRoom] = [];
          }

          // Create a map of existing messages by timestamp for efficient lookup
          const existingMessagesMap = new Map(
            updated[originalRoom].map((msg) => [msg.timestamp, msg]),
          );

          // Update or add decrypted messages
          const mergedMessages = decryptedMessages.map((decryptedMsg) => {
            const existing = existingMessagesMap.get(decryptedMsg.timestamp);
            if (existing) {
              // Merge: prioritize decrypted content that's not a placeholder
              let finalContent = decryptedMsg.content;
              if (
                !finalContent ||
                finalContent.trim() === '' ||
                finalContent.includes('🔒') ||
                finalContent.includes('[Encrypted message]')
              ) {
                // If decrypted content is a placeholder, use existing content if it's better
                if (
                  existing.content &&
                  existing.content.trim() !== '' &&
                  !existing.content.includes('🔒') &&
                  !existing.content.includes('[Encrypted message]')
                ) {
                  finalContent = existing.content;
                }
              }

              // Merge encryptedFor maps (prefer decryptedMsg's version as it's newer)
              const finalEncryptedFor =
                decryptedMsg.encryptedFor || existing.encryptedFor;

              return {
                ...existing,
                ...decryptedMsg,
                content: finalContent,
                encryptedFor: finalEncryptedFor,
              };
            }
            return decryptedMsg;
          });

          // Add any existing messages that weren't in the decrypted set
          existingMessagesMap.forEach((msg, timestamp) => {
            if (!decryptedMessages.find((m) => m.timestamp === timestamp)) {
              mergedMessages.push(msg);
            }
          });

          // Sort by timestamp
          mergedMessages.sort((a, b) => a.timestamp - b.timestamp);

          updated[originalRoom] = mergedMessages;
          console.log(
            '[AccessGrant] Updated chatValues for room:',
            originalRoom,
            'with',
            mergedMessages.length,
            'messages',
          );

          // Log the target message specifically
          const targetMsg = mergedMessages.find(
            (m) => m.timestamp === messageTimestamp,
          );
          if (targetMsg) {
            console.log('[AccessGrant] Target message after update:', {
              timestamp: targetMsg.timestamp,
              username: targetMsg.username,
              hasContent: !!targetMsg.content,
              contentLength: targetMsg.content?.length || 0,
              hasEncryptedFor: !!targetMsg.encryptedFor,
              encryptedForKeys: Object.keys(targetMsg.encryptedFor || {}),
              contentPreview: targetMsg.content
                ? targetMsg.content.substring(0, 50)
                : 'no content',
            });

            // If target message still doesn't have content, log detailed info
            if (
              !targetMsg.content ||
              targetMsg.content.trim() === '' ||
              targetMsg.content.includes('🔒') ||
              targetMsg.content.includes('[Encrypted message]')
            ) {
              console.error(
                '[AccessGrant] ⚠ Target message still not decrypted!',
              );
              console.error(
                '[AccessGrant] Message encryptedFor:',
                targetMsg.encryptedFor,
              );
              console.error('[AccessGrant] Current user:', keys.username);
              console.error(
                '[AccessGrant] Has key in encryptedFor:',
                !!(
                  targetMsg.encryptedFor &&
                  targetMsg.encryptedFor[keys.username]
                ),
              );
              if (targetMsg.versions && targetMsg.versions.length > 0) {
                console.error(
                  '[AccessGrant] Newest version encryptedFor:',
                  targetMsg.versions[0].encryptedFor,
                );
                console.error(
                  '[AccessGrant] Has key in newest version:',
                  !!(
                    targetMsg.versions[0].encryptedFor &&
                    targetMsg.versions[0].encryptedFor[keys.username]
                  ),
                );
              }
            } else {
              console.log(
                '[AccessGrant] ✓ Target message successfully decrypted!',
              );
            }
          }
          return updated;
        });

        // Ensure the room is in the room list
        setRoomList((prev) => {
          if (!prev.includes(originalRoom)) {
            return [...prev, originalRoom];
          }
          return prev;
        });

        console.log(
          '[AccessGrant] ✓ Updated messages for room:',
          originalRoom,
          '- message should now be visible',
        );
      } else {
        // Fallback: update the message's encryptedFor map and versions
        setChatValues((prev) => {
          const updated = { ...prev };
          if (updated[originalRoom]) {
            updated[originalRoom] = updated[originalRoom].map((msg) => {
              if (msg.timestamp === messageTimestamp) {
                // Update encryptedFor with new map
                const newEncryptedFor = {
                  ...msg.encryptedFor,
                  ...encryptedMap,
                };

                // Update or create versions array
                let versions = msg.versions || [];
                if (versions.length === 0 && msg.encryptedFor) {
                  // Migrate existing to version 0
                  versions = [
                    {
                      encryptedFor: msg.encryptedFor,
                      version: 0,
                      changeSummary: 'original version',
                      timestamp: msg.timestamp,
                    },
                  ];
                }

                // Add new version
                const newVersion = {
                  encryptedFor: newEncryptedFor,
                  version: versions.length,
                  changeSummary: `added key for user ${Object.keys(encryptedMap).join(', ')}`,
                  timestamp: Date.now(),
                };
                versions = [newVersion, ...versions];

                return {
                  ...msg,
                  encryptedFor: newEncryptedFor,
                  versions: versions,
                  currentVersion: 0, // Newest version
                };
              }
              return msg;
            });
          }
          return updated;
        });

        // Decrypt the newly granted message if we have access
        if (username && encryptedMap[username]) {
          const keys = loadKeys();
          if (keys) {
            try {
              console.log(
                '[AccessGrant] ===== DECRYPTING FOR ORIGINAL AUTHOR (FALLBACK) =====',
              );
              console.log('[AccessGrant] Message timestamp:', messageTimestamp);
              console.log('[AccessGrant] User:', username);
              console.log(
                '[AccessGrant] Encrypted data length:',
                encryptedMap[username].length,
              );
              console.log(
                '[AccessGrant] Encrypted data (first 200 chars):',
                encryptedMap[username].substring(0, 200),
              );
              const decrypted = await decryptMessageForUser(
                encryptedMap[username],
                keys.privateKey,
              );
              console.log(
                '[AccessGrant] ✓ Decrypted granted message, content length:',
                decrypted.length,
              );
              console.log(
                '[AccessGrant] Decrypted content (first 200 chars):',
                decrypted.substring(0, 200),
              );
              console.log('[AccessGrant] Decrypted content (full):', decrypted);
              setChatValues((prev) => {
                const updated = { ...prev };
                if (updated[originalRoom]) {
                  updated[originalRoom] = updated[originalRoom].map((msg) => {
                    if (msg.timestamp === messageTimestamp) {
                      return normalizeMessageState({
                        ...msg,
                        content: decrypted,
                      });
                    }
                    return normalizeMessageState(msg);
                  });
                }
                return updated;
              });
              console.log('[AccessGrant] ✓ Updated UI with decrypted content');
            } catch (error) {
              console.error('[AccessGrant] ✗ Failed to decrypt:', error);
            }
          }
        }
      }

      return; // Early return for access grant
    }

    // Decrypt messages if needed
    if (data?.messages) {
      const keys = loadKeys();
      const decryptedMessages: Messages = {};

      for (const [room, messages] of Object.entries(data.messages)) {
        // Skip messages for left rooms
        if (leftRooms.has(room)) continue;

        // Type assertion: messages from SERVER_MESSAGE should be Message[]
        const roomMessages = messages as Message[];
        const blockedUsers = new Set(getBlockedUsers());
        const visibleRoomMessages = roomMessages.filter(
          (msg) => !isBlockedAuthor(msg, blockedUsers),
        );
        console.log(
          `[Socket] SERVER_MESSAGE: Received ${visibleRoomMessages.length} visible messages for room ${room}`,
        );
        // Log replyTo fields
        const messagesWithReplies = visibleRoomMessages.filter(
          (m) => m.replyTo !== undefined && m.replyTo !== null,
        );
        if (messagesWithReplies.length > 0) {
          console.log(
            `[Socket] SERVER_MESSAGE: ${messagesWithReplies.length} messages have replyTo:`,
            messagesWithReplies.map((m) => ({
              timestamp: m.timestamp,
              replyTo: m.replyTo,
              username: m.username,
            })),
          );
        }

        decryptedMessages[room] = await Promise.all(
          visibleRoomMessages.map(async (msg: Message) => {
            // Preserve replyTo field
            const preservedReplyTo = msg.replyTo;

            // Check if we have access - check both encryptedFor and versions array
            let encryptedData: string | null = null;

            if (
              msg.encryptedFor &&
              keys?.username &&
              msg.encryptedFor[keys.username]
            ) {
              encryptedData = msg.encryptedFor[keys.username];
            } else if (
              msg.versions &&
              msg.versions.length > 0 &&
              keys?.username
            ) {
              // Check newest version (index 0)
              const newestVersion = msg.versions[0];
              if (
                newestVersion.encryptedFor &&
                newestVersion.encryptedFor[keys.username]
              ) {
                encryptedData = newestVersion.encryptedFor[keys.username];
              }
            }

            if (encryptedData) {
              try {
                console.log(
                  '[Socket] ===== DECRYPTING MESSAGE IN SERVER_MESSAGE =====',
                );
                console.log('[Socket] Message timestamp:', msg.timestamp);
                console.log('[Socket] Message replyTo:', preservedReplyTo);
                console.log('[Socket] User:', keys!.username);
                console.log('[Socket] Room:', room);
                const decrypted = await decryptMessageForUser(
                  encryptedData,
                  keys!.privateKey,
                );
                console.log(
                  '[Socket] ✓ Decrypted message, preserving replyTo:',
                  preservedReplyTo,
                );
                // Preserve all fields including replyTo
                return {
                  ...msg,
                  content: decrypted,
                  replyTo: preservedReplyTo,
                };
              } catch (error) {
                console.error('[Socket] ✗ Failed to decrypt message:', error);
                return normalizeMessageState(msg); // Return original if decryption fails (should preserve replyTo)
              }
            }
            // Return message with preserved replyTo
            return normalizeMessageState({ ...msg, replyTo: preservedReplyTo });
          }),
        );
      }

      // Merge with existing chat values instead of replacing
      // Important: preserve replyTo fields when merging
      setChatValues((prev) => {
        const merged = { ...prev };
        for (const [room, messages] of Object.entries(decryptedMessages)) {
          // Merge messages by timestamp to preserve replyTo and other fields
          if (!merged[room]) {
            merged[room] = messages;
          } else {
            // Create a map of existing messages by timestamp
            const existingMap = new Map(
              merged[room].map((m) => [m.timestamp, m]),
            );
            // Update or add new messages, preserving replyTo
            messages.forEach((msg) => {
              const existing = existingMap.get(msg.timestamp);
              if (existing) {
                // Update existing message but preserve replyTo if it exists
                Object.assign(existing, msg, {
                  replyTo:
                    msg.replyTo !== undefined ? msg.replyTo : existing.replyTo,
                });
              } else {
                // Add new message
                existingMap.set(msg.timestamp, msg);
              }
            });
            merged[room] = Array.from(existingMap.values());
          }
        }
        console.log(
          '[Socket] Merged chatValues, checking replyTo fields:',
          Object.entries(merged).map(([r, msgs]) => ({
            room: r,
            total: msgs.length,
            withReplyTo: msgs.filter(
              (m) => m.replyTo !== undefined && m.replyTo !== null,
            ).length,
          })),
        );
        return merged;
      });

      // Ensure all rooms from messages are in the room list
      setRoomList((prev) => {
        const updated = [...prev];
        let changed = false;
        for (const room of Object.keys(decryptedMessages)) {
          if (!updated.includes(room)) {
            updated.push(room);
            changed = true;
          }
        }
        return changed ? updated : prev;
      });
    }

    // Only update user lists if they are provided and not empty (or explicitly provided)
    // Don't overwrite with empty arrays - that would clear the user list
    if (data?.users && Array.isArray(data.users) && data.users.length > 0) {
      setUserList(data.users);
    }

    // Handle new format with loggedInUsers and activeUsers
    // Only update if explicitly provided (even if empty arrays, but prefer non-empty)
    if (data?.loggedInUsers !== undefined || data?.activeUsers !== undefined) {
      setLoggedInUsers(data.loggedInUsers || []);
      setActiveUsers(data.activeUsers || []);
      // Also update userList for backward compatibility
      const allUsers = [
        ...(data.loggedInUsers || []),
        ...(data.activeUsers || []),
      ];
      if (allUsers.length > 0) {
        setUserList(allUsers);
      }
    } else if (
      data?.users &&
      Array.isArray(data.users) &&
      data.users.length > 0
    ) {
      // Fallback: if only old format, treat all as logged in
      setLoggedInUsers(data.users);
      setActiveUsers([]);
    }

    // Update room members if provided
    if (data?.roomMembers) {
      setRoomMembers((prev) => {
        const updated = { ...prev };
        for (const [room, members] of Object.entries(data.roomMembers)) {
          updated[room] = new Set(members as string[]);
        }
        return updated;
      });
    }

    // Update user last seen if provided
    if (data?.userLastSeen) {
      setUserLastSeen(data.userLastSeen as Record<string, number>);
    } else if (data?.users) {
      // Fallback: mark all users as online if last seen not provided
      setUserLastSeen((prev) => {
        const updated = { ...prev };
        data.users.forEach((user: string) => {
          updated[user] = Date.now();
        });
        return updated;
      });
    }

    // Update user public keys if provided
    if (data?.userPubKeys) {
      console.log('[Socket] ✓ Updating user public keys');
      storeUserPublicKeys(data.userPubKeys);
    }
  });

  socket.on(SOCKET_EVENTS.SERVER_NEW_ROOM, (data) => {
    console.log('[Socket] SERVER_NEW_ROOM received');
    if (data?.messages) {
      // Merge with existing chat values instead of replacing
      setChatValues((prev) => {
        const merged = { ...prev };
        for (const [room, messages] of Object.entries(data.messages)) {
          merged[room] = messages as Message[];
        }
        return merged;
      });
    }
    if (data?.rooms) {
      setRoomList(data.rooms);
    }
  });

  socket.on(SOCKET_EVENTS.SERVER_USER_LIST_UPDATE, (data) => {
    console.log('[Socket] SERVER_USER_LIST_UPDATE received:', data);

    // Handle new format with loggedInUsers and activeUsers
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      if ('loggedInUsers' in data || 'activeUsers' in data) {
        setLoggedInUsers((data as any).loggedInUsers || []);
        setActiveUsers((data as any).activeUsers || []);
        if ((data as any).userLastSeen) {
          setUserLastSeen((data as any).userLastSeen as Record<string, number>);
        }
        // Also update userList for backward compatibility
        const allUsers = [
          ...((data as any).loggedInUsers || []),
          ...((data as any).activeUsers || []),
        ];
        setUserList(allUsers);
        console.log(
          '[Socket] ✓ Updated user lists:',
          (data as any).loggedInUsers?.length || 0,
          'logged in,',
          (data as any).activeUsers?.length || 0,
          'active',
        );
      } else {
        console.warn('[Socket] ✗ Invalid user list format:', data);
      }
    } else if (Array.isArray(data)) {
      // Backward compatibility: treat array as logged-in users
      setUserList(data);
      setLoggedInUsers(data);
      setActiveUsers([]);
      console.log(
        '[Socket] ✓ Updated user list (legacy format):',
        data.length,
        'users',
      );
    } else {
      console.warn('[Socket] ✗ Invalid user list format:', data);
    }
  });

  // Handle join requests
  socket.on(SOCKET_EVENTS.SERVER_JOIN_REQUEST, (data) => {
    console.log('[Socket] SERVER_JOIN_REQUEST received:', data);
    if (data?.type === 'joinRequest' && data?.requestingUser && data?.room) {
      setActiveJoinRequests((prev) => {
        const exists = prev.some(
          (req) =>
            req.requestingUser === data.requestingUser &&
            req.room === data.room,
        );
        if (!exists) {
          return [
            ...prev,
            {
              requestingUser: data.requestingUser,
              room: data.room,
              timestamp: data.timestamp || Date.now(),
            },
          ];
        }
        return prev;
      });
    }
  });

  socket.on(SOCKET_EVENTS.SERVER_JOIN_APPROVED, (data) => {
    console.log('[Socket] SERVER_JOIN_APPROVED received:', data);
    if (data?.type === 'joinApproved' && data?.requestingUser && data?.room) {
      setActiveJoinRequests((prev) =>
        prev.filter(
          (req) =>
            !(
              req.requestingUser === data.requestingUser &&
              req.room === data.room
            ),
        ),
      );
      // Update room members
      setRoomMembers((prev) => {
        const updated = { ...prev };
        if (!updated[data.room]) {
          updated[data.room] = new Set();
        }
        updated[data.room].add(data.requestingUser);
        return updated;
      });
    }
  });

  socket.on(SOCKET_EVENTS.SERVER_JOIN_DENIED, (data) => {
    console.log('[Socket] SERVER_JOIN_DENIED received:', data);
    if (data?.type === 'joinDenied' && data?.requestingUser && data?.room) {
      setActiveJoinRequests((prev) =>
        prev.filter(
          (req) =>
            !(
              req.requestingUser === data.requestingUser &&
              req.room === data.room
            ),
        ),
      );
    }
  });

  // Handle access requests - show in private room named after the other user
  socket.on(SOCKET_EVENTS.SERVER_ACCESS_REQUEST, (data) => {
    console.log('[Socket] SERVER_ACCESS_REQUEST received:', data);
    if (data?.requestAccess) {
      const { requestingUser, originalRoom, messageTimestamp, originalSender } =
        data.requestAccess;
      // The server sends the appropriate room name for this user:
      // - Original sender sees @requestingUser
      // - Requesting user sees @originalSender (from SERVER_MESSAGE, not this event)
      const dmRoom = data?.requestRoom;

      if (!dmRoom) {
        console.warn(
          '[AccessRequest] ⚠ No requestRoom provided in SERVER_ACCESS_REQUEST',
        );
        return;
      }

      // Store the requesting user's public key if provided by server
      if (data?.requestingUserPubKey && requestingUser) {
        console.log(
          '[AccessRequest] Storing requesting user public key for:',
          requestingUser,
        );
        const userPubKeys = loadUserPublicKeyEntries() || {};
        userPubKeys[requestingUser] = {
          publicKey: data.requestingUserPubKey,
          blocked: !!userPubKeys[requestingUser]?.blocked,
        };
        storeUserPublicKeys(userPubKeys);
        console.log(
          '[AccessRequest] ✓ Stored public key for requesting user:',
          requestingUser,
        );
      } else {
        console.warn(
          '[AccessRequest] ⚠ No public key provided for requesting user:',
          requestingUser,
        );
      }

      // Add room if it doesn't exist (only for original sender, requesting user gets it from SERVER_MESSAGE)
      if (username === originalSender) {
        setRoomList((prev) => {
          if (!prev.includes(dmRoom)) {
            return [...prev, dmRoom];
          }
          return prev;
        });
        setCurrentRoom(dmRoom);
      }
    }
  });

  // Handle access denied notifications
  socket.on(SOCKET_EVENTS.SERVER_ACCESS_DENIED, (data) => {
    console.log('[Socket] SERVER_ACCESS_DENIED received:', data);
    if (data?.accessDenied) {
      const { originalRoom, messageTimestamp } = data.accessDenied;
      alert(
        `Access to your message in ${originalRoom} was denied by the original sender.`,
      );
    }
  });

  // Handle vote updates
  socket.on(SOCKET_EVENTS.SERVER_VOTE_UPDATE, async (data) => {
    console.log('[Socket] SERVER_VOTE_UPDATE received');
    if (data?.messages) {
      // Update messages with new vote data
      const keys = loadKeys();
      const decryptedMessages: Messages = {};

      for (const [room, messages] of Object.entries(data.messages)) {
        const roomMessages = messages as Message[];
        const blockedUsers = new Set(getBlockedUsers());
        const visibleRoomMessages = roomMessages.filter(
          (msg) => !isBlockedAuthor(msg, blockedUsers),
        );
        decryptedMessages[room] = await Promise.all(
          visibleRoomMessages.map(async (msg: Message) => {
            // If message has encryptedFor and we have keys, decrypt it
            if (msg.encryptedFor && keys) {
              const encrypted = msg.encryptedFor[keys.username];
              if (encrypted) {
                try {
                  const decrypted = await decryptMessageForUser(
                    encrypted,
                    keys.privateKey,
                  );
                  return normalizeMessageState({ ...msg, content: decrypted });
                } catch (error) {
                  console.error('[Socket] ✗ Failed to decrypt message:', error);
                  return normalizeMessageState(msg);
                }
              }
            }
            return msg;
          }),
        );
      }

      setChatValues(decryptedMessages);
    }
  });

  socket.on(SOCKET_EVENTS.DISCONNECTING, (msg) => {
    activeSocket.emit(SOCKET_EVENTS.CLIENT_MESSAGE, {
      username,
      room: DEFAULT_ROOM,
      content: SYSTEM_MESSAGES.USER_LEFT,
    });
    activeSocket.emit(SOCKET_EVENTS.CLIENT_DISCONNECTING, authToken);
    setAuthToken('');
  });

  socket.on(SOCKET_EVENTS.STATUS, (msg) => {
    console.log('[Socket] STATUS received:', msg);
  });

  socket.on(SOCKET_EVENTS.SERVER_PUBLIC_KEY_RECEIVED, (data) => {
    if (data?.fromUser && data?.publicKey) {
      const userPubKeys = loadUserPublicKeyEntries() || {};
      userPubKeys[data.fromUser] = {
        publicKey: data.publicKey,
        blocked: !!userPubKeys[data.fromUser]?.blocked,
      };
      storeUserPublicKeys(userPubKeys);
      console.log('[Socket] ✓ Stored public key from', data.fromUser);
    }
  });

  socket.on(SOCKET_EVENTS.CONNECT, () => {
    console.log('[Socket] ===== CONNECTED =====');
    console.log('[Socket] Socket ID:', activeSocket.id);
    console.log('[Socket] Socket connected:', activeSocket.connected);
    const keys = loadKeys();
    if (keys?.publicKey && username) {
      activeSocket.emit(SOCKET_EVENTS.CLIENT_SEND_PUBLIC_KEY, {
        fromUser: username,
        publicKey: keys.publicKey,
      });
      console.log('[Socket] ✓ Announced public key for', username);
    }
    // Join messages are now sent automatically by the server
  });

  socket.on(SOCKET_EVENTS.DISCONNECT, (reason) => {
    console.log('[Socket] ===== DISCONNECTED =====');
    console.log('[Socket] Reason:', reason);
    console.log('[Socket] Socket ID:', activeSocket.id);
  });

  socket.on('connect_error', (error: Error) => {
    console.error('[Socket] ===== CONNECTION ERROR =====');
    console.error('[Socket] Error object:', error);
    console.error('[Socket] Error message:', error.message);
    console.error('[Socket] Error name:', error.name);
    console.error('[Socket] Error stack:', error.stack);
  });

  socket.on('error', (error) => {
    console.error('[Socket] ===== SOCKET ERROR =====');
    console.error('[Socket] Error:', error);
  });

  socket.on('disconnect', (reason) => {
    console.log('[Socket] ===== DISCONNECT EVENT =====');
    console.log('[Socket] Reason:', reason);
  });

  socket.on('reconnect', (attemptNumber) => {
    console.log('[Socket] ===== RECONNECTED =====');
    console.log('[Socket] Attempt number:', attemptNumber);
  });

  socket.on('reconnect_attempt', (attemptNumber) => {
    console.log('[Socket] Reconnect attempt:', attemptNumber);
  });

  socket.on('reconnect_error', (error) => {
    console.error('[Socket] Reconnect error:', error);
  });

  socket.on('reconnect_failed', () => {
    console.error('[Socket] ===== RECONNECT FAILED =====');
  });

  console.log('[Socket] All listeners registered');
  console.log(
    '[Socket] Socket state - connected:',
    activeSocket.connected,
    'id:',
    activeSocket.id,
  );
}
