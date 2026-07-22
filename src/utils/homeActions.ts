import { type Dispatch, type SetStateAction } from 'react';
import { type Socket } from 'socket.io-client';
import { SOCKET_EVENTS } from '../constants';
import { type Message, type Messages } from '../types/types';
import {
  encryptForAllUsers,
  filterPubKeysForEncryption,
  decryptMessageForUser,
  loadKeys,
  loadUserPublicKeyEntries,
} from '../utils/gpg';

type SetMessages = Dispatch<SetStateAction<Messages>>;

export async function doSendAction({
  socket,
  userDraftMessage,
  currentRoom,
  editingMessageTimestamp,
  blockedUsers,
  username,
  replyingTo,
  setEditingMessageTimestamp,
  setUserDraftMessage,
  setReplyingTo,
}: {
  socket: Socket | undefined;
  userDraftMessage: string;
  currentRoom: string;
  editingMessageTimestamp: number | undefined;
  blockedUsers: string[];
  username: string;
  replyingTo: number | undefined;
  setEditingMessageTimestamp: Dispatch<SetStateAction<number | undefined>>;
  setUserDraftMessage: Dispatch<SetStateAction<string>>;
  setReplyingTo: Dispatch<SetStateAction<number | undefined>>;
}) {
  console.log('[doSend] ===== SENDING MESSAGE =====');
  console.log('[doSend] Socket exists:', !!socket);
  console.log('[doSend] Socket connected:', socket?.connected);
  console.log('[doSend] Socket ID:', socket?.id);
  console.log('[doSend] Username:', username);
  console.log('[doSend] Current room:', currentRoom);
  console.log('[doSend] Message content:', userDraftMessage);

  // Try to get socket from window if not available
  const activeSocket = socket || (window as any).__socket;
  console.log(
    '[doSend] Active socket from window:',
    !!(window as any).__socket,
  );

  if (!activeSocket) {
    console.error('[doSend] ✗ Socket is not initialized!');
    alert('Socket not connected. Please refresh the page.');
    return;
  }

  if (!activeSocket.connected) {
    console.error(
      '[doSend] ✗ Socket is not connected! Connected:',
      activeSocket.connected,
    );
    alert('Socket not connected. Please refresh the page.');
    return;
  }

  if (!currentRoom) {
    console.error('[doSend] ✗ No current room selected!');
    alert('Please select a room first.');
    return;
  }

  if (!userDraftMessage.trim()) {
    console.log('[doSend] ✗ Empty message, not sending');
    return;
  }

  // Encrypt message with all user public keys (including sender's own key)
  const userPubKeys = loadUserPublicKeyEntries();
  const keys = loadKeys();
  let encryptedFor: Record<string, string> | undefined;

  if (!userPubKeys || Object.keys(userPubKeys).length === 0) {
    console.error(
      '[doSend] ✗ No user public keys available, cannot send encrypted message',
    );
    alert('No user public keys available. Please refresh the page.');
    return;
  }

  if (!keys || !keys.publicKey) {
    console.error('[doSend] ✗ No sender public key available');
    alert('No sender public key available. Please log in again.');
    return;
  }

  // Check if we're editing a message
  if (
    editingMessageTimestamp !== undefined &&
    editingMessageTimestamp !== null
  ) {
    // Edit existing message
    console.log(
      '[doSend] Editing message with timestamp:',
      editingMessageTimestamp,
    );

    try {
      const filteredKeys = filterPubKeysForEncryption(userPubKeys, {
        room: currentRoom,
        blockedUsers,
      });
      encryptedFor = await encryptForAllUsers(
        userDraftMessage,
        filteredKeys,
        keys.publicKey,
        username,
      );
      console.log('[doSend] ✓ Edit message encrypted for all users');
    } catch (error) {
      console.error('[doSend] ✗ Failed to encrypt edit message:', error);
      alert('Failed to encrypt message. Please try again.');
      return;
    }

    const editData = {
      room: currentRoom,
      messageTimestamp: editingMessageTimestamp,
      username,
      sessionId: keys.sessionId,
      encryptedFor,
    };
    if (!keys.sessionId) {
      alert('Session expired. Please log in again.');
      return;
    }
    activeSocket.emit(SOCKET_EVENTS.CLIENT_EDIT_MESSAGE, editData);
    console.log('[doSend] ✓ Edit message emitted');
    setEditingMessageTimestamp(undefined);
    setUserDraftMessage('');
    return;
  }

  console.log(
    '[doSend] Encrypting message for',
    Object.keys(userPubKeys).length,
    'users (including self)',
  );
  try {
    const filteredKeys = filterPubKeysForEncryption(userPubKeys, {
      room: currentRoom,
      blockedUsers,
    });
    encryptedFor = await encryptForAllUsers(
      userDraftMessage,
      filteredKeys,
      keys.publicKey,
      username,
    );
    console.log('[doSend] ✓ Message encrypted for all users');
  } catch (error) {
    console.error('[doSend] ✗ Failed to encrypt message:', error);
    alert('Failed to encrypt message. Please try again.');
    return;
  }

  // Only send encryptedFor - no plaintext for user messages
  // System messages are now sent by the server automatically
  // Include replyTo if replying to a message (check explicitly for undefined/null, not just truthiness)
  const shouldIncludeReplyTo = replyingTo !== undefined && replyingTo !== null;
  const currentReplyTo = replyingTo;

  const messageData = {
    username,
    room: currentRoom,
    encryptedFor, // Encrypted versions for all users
    ...(shouldIncludeReplyTo ? { replyTo: replyingTo } : {}), // Include replyTo if replying to a message
  };

  // Clear replyingTo after sending
  if (shouldIncludeReplyTo) {
    setReplyingTo(undefined);
  }

  console.log('[doSend] ===== MESSAGE DATA =====');
  console.log('[doSend] replyingTo state:', currentReplyTo);
  console.log('[doSend] shouldIncludeReplyTo:', shouldIncludeReplyTo);
  console.log('[doSend] messageData.replyTo:', messageData.replyTo);
  console.log('[doSend] messageData keys:', Object.keys(messageData));
  console.log('[doSend] Emitting CLIENT_MESSAGE with data:', {
    ...messageData,
    encryptedFor: encryptedFor
      ? `${Object.keys(encryptedFor).length} encrypted versions`
      : 'none',
    replyTo: currentReplyTo || 'none',
  });
  console.log('[doSend] Event name:', SOCKET_EVENTS.CLIENT_MESSAGE);
  activeSocket.emit(SOCKET_EVENTS.CLIENT_MESSAGE, messageData);
  console.log(
    '[doSend] ✓ Message emitted with replyTo:',
    messageData.replyTo || 'none',
  );
  setUserDraftMessage('');
}

export function requestAccessAction({
  socket,
  username,
  chatValues,
  messageUsername,
  room,
  messageTimestamp,
}: {
  socket: Socket | undefined;
  username: string;
  chatValues: Messages;
  messageUsername: string;
  room: string;
  messageTimestamp: number;
}) {
  if (!socket || !username) return;

  console.log('[RequestAccess] ===== REQUESTING ACCESS TO MESSAGE =====');
  console.log('[RequestAccess] Message username:', messageUsername);
  console.log('[RequestAccess] Room:', room);
  console.log('[RequestAccess] Message timestamp:', messageTimestamp);

  // Find the message to get its current state
  const roomMessages = chatValues[room];
  if (roomMessages) {
    const targetMessage = roomMessages.find(
      (msg) => msg.timestamp === messageTimestamp,
    );
    if (targetMessage) {
      console.log('[RequestAccess] Target message found:');
      console.log(
        '[RequestAccess]   - Current content:',
        targetMessage.content || '(no content)',
      );
      console.log(
        '[RequestAccess]   - Content length:',
        targetMessage.content?.length || 0,
      );
      console.log(
        '[RequestAccess]   - Has encryptedFor:',
        !!targetMessage.encryptedFor,
      );
      console.log(
        '[RequestAccess]   - encryptedFor keys:',
        targetMessage.encryptedFor
          ? Object.keys(targetMessage.encryptedFor)
          : [],
      );
      console.log(
        '[RequestAccess]   - Has versions:',
        !!targetMessage.versions,
      );
      console.log(
        '[RequestAccess]   - Versions count:',
        targetMessage.versions?.length || 0,
      );
      if (targetMessage.encryptedFor && targetMessage.encryptedFor[username]) {
        console.log(
          '[RequestAccess]   - Has encrypted version for requesting user:',
          !!targetMessage.encryptedFor[username],
        );
        console.log(
          '[RequestAccess]   - Encrypted data length:',
          targetMessage.encryptedFor[username]?.length || 0,
        );
      }
      if (targetMessage.versions && targetMessage.versions.length > 0) {
        const newestVersion = targetMessage.versions[0];
        console.log(
          '[RequestAccess]   - Newest version encryptedFor keys:',
          newestVersion.encryptedFor
            ? Object.keys(newestVersion.encryptedFor)
            : [],
        );
        if (
          newestVersion.encryptedFor &&
          newestVersion.encryptedFor[username]
        ) {
          console.log(
            '[RequestAccess]   - Has encrypted version in newest version for requesting user:',
            !!newestVersion.encryptedFor[username],
          );
        }
      }
    } else {
      console.warn(
        '[RequestAccess] ⚠ Target message not found in room messages',
      );
    }
  } else {
    console.warn('[RequestAccess] ⚠ Room messages not found');
  }

  // Create a private room name for the access request (format: @requestingUser)
  const requestRoom = `@${username}`;

  const requestMessage = {
    username,
    room: requestRoom,
    content: `User ${username} requests access to your message in ${room} (timestamp: ${messageTimestamp})`,
    requestAccess: {
      requestingUser: username,
      originalRoom: room,
      messageTimestamp,
      originalSender: messageUsername,
    },
  };

  console.log('[RequestAccess] Sending access request to server:', {
    ...requestMessage,
    requestAccess: requestMessage.requestAccess,
  });
  socket.emit(SOCKET_EVENTS.CLIENT_REQUEST_ACCESS, requestMessage);
  console.log('[RequestAccess] ✓ Access request sent');
}

// Grant access to a message (re-encrypt for requesting user)
// IMPORTANT: This function looks up the original message by timestamp in the original room
// and uses the original author's locally stored plaintext (which they already have decrypted)

export async function grantAccessAction({
  socket,
  username,
  chatValues,
  blockedUsers,
  setChatValues,
  requestingUser,
  originalRoom,
  messageTimestamp,
  providedPlaintext,
}: {
  socket: Socket | undefined;
  username: string;
  chatValues: Messages;
  blockedUsers: string[];
  setChatValues: SetMessages;
  requestingUser: string;
  originalRoom: string;
  messageTimestamp: number;
  providedPlaintext?: string;
}) {
  console.log('[GrantAccess] ===== STARTING GRANT ACCESS =====');
  console.log('[GrantAccess] requestingUser:', requestingUser);
  console.log('[GrantAccess] originalRoom:', originalRoom);
  console.log('[GrantAccess] messageTimestamp:', messageTimestamp);
  console.log('[GrantAccess] username (original author):', username);
  console.log(
    '[GrantAccess] NOTE: Looking up original message by timestamp in original room to get plaintext',
  );

  if (!username) {
    console.error('[GrantAccess] ✗ No username');
    alert('No username available. Please refresh the page.');
    return;
  }

  // Get socket from window or module-level variable - prefer window as it's always current
  // CRITICAL: Use the socket that has event handlers registered (the one from socketInitializer)
  const activeSocket = (window as any).__socket || socket;
  console.log('[GrantAccess] socket from window:', !!(window as any).__socket);
  console.log('[GrantAccess] socket from module:', !!socket);
  console.log('[GrantAccess] activeSocket:', activeSocket ? 'exists' : 'null');
  console.log('[GrantAccess] activeSocket type:', typeof activeSocket);
  if (activeSocket) {
    console.log(
      '[GrantAccess] activeSocket.connected:',
      activeSocket.connected,
    );
    console.log('[GrantAccess] activeSocket.id:', activeSocket.id);
    console.log(
      '[GrantAccess] activeSocket.emit type:',
      typeof activeSocket.emit,
    );
    console.log(
      '[GrantAccess] activeSocket.disconnected:',
      activeSocket.disconnected,
    );
    // Check internal socket state
    const io = (activeSocket as any).io;
    if (io) {
      console.log(
        '[GrantAccess] Socket.IO engine state:',
        io.engine?.readyState,
      );
      console.log(
        '[GrantAccess] Socket.IO transport:',
        io.engine?.transport?.name,
      );
    }
  }

  if (!activeSocket) {
    console.error('[GrantAccess] ✗ No socket connection available');
    alert('Socket connection not available. Please refresh the page.');
    return;
  }

  if (typeof activeSocket.emit !== 'function') {
    console.error(
      '[GrantAccess] ✗ activeSocket.emit is not a function!',
      activeSocket,
    );
    alert('Socket emit function not available. Please refresh the page.');
    return;
  }

  // If socket is not connected, try to reconnect
  if (!activeSocket.connected || activeSocket.disconnected) {
    console.warn(
      '[GrantAccess] Socket not connected, attempting to reconnect...',
    );
    if (activeSocket.disconnected) {
      activeSocket.connect();
    }
    // Wait a bit for connection
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (!activeSocket.connected || activeSocket.disconnected) {
      console.error(
        '[GrantAccess] ✗ Socket still not connected after reconnect attempt',
      );
      console.error('[GrantAccess] Socket state:', {
        connected: activeSocket.connected,
        disconnected: activeSocket.disconnected,
        id: activeSocket.id,
      });
      alert('Socket is not connected. Please refresh the page.');
      return;
    }
    console.log('[GrantAccess] ✓ Socket reconnected successfully');
  }

  const keys = loadKeys();
  if (!keys) {
    console.error('[GrantAccess] ✗ No keys available');
    return;
  }

  // CRITICAL: Always look up the original message by timestamp in the original room
  // The original author should already have this message decrypted locally
  // We do NOT use providedPlaintext from the access request message
  console.log('[GrantAccess] ===== LOOKING UP ORIGINAL MESSAGE =====');
  console.log('[GrantAccess] Looking in room:', originalRoom);
  console.log(
    '[GrantAccess] Looking for message with timestamp:',
    messageTimestamp,
  );
  console.log('[GrantAccess] Looking for message from user:', username);

  const roomMessages = chatValues[originalRoom];
  if (!roomMessages) {
    console.error('[GrantAccess] ✗ Original room not found:', originalRoom);
    console.error('[GrantAccess] Available rooms:', Object.keys(chatValues));
    return;
  }

  const originalMessage = roomMessages.find(
    (msg) => msg.timestamp === messageTimestamp && msg.username === username,
  );

  if (!originalMessage) {
    console.error('[GrantAccess] ✗ Original message not found');
    console.error(
      '[GrantAccess] Messages in room:',
      roomMessages.map((m) => ({
        timestamp: m.timestamp,
        username: m.username,
      })),
    );
    return;
  }

  console.log('[GrantAccess] ✓ Original message found');
  console.log(
    '[GrantAccess] Message content preview:',
    originalMessage.content
      ? originalMessage.content.substring(0, 100)
      : '(no content)',
  );
  console.log(
    '[GrantAccess] Message has encryptedFor:',
    !!originalMessage.encryptedFor,
  );
  console.log(
    '[GrantAccess] Message has versions:',
    !!originalMessage.versions,
  );

  let plaintext: string;

  // Try to get plaintext from already decrypted message (preferred - original author should have this)
  if (
    originalMessage.content &&
    originalMessage.content.trim() &&
    !originalMessage.content.includes('🔒') &&
    !originalMessage.content.includes('[Encrypted message]')
  ) {
    console.log(
      '[GrantAccess] ===== USING ALREADY DECRYPTED CONTENT FROM ORIGINAL MESSAGE =====',
    );
    console.log(
      '[GrantAccess] Content length:',
      originalMessage.content.length,
    );
    console.log(
      '[GrantAccess] Content (first 200 chars):',
      originalMessage.content.substring(0, 200),
    );
    console.log('[GrantAccess] Content (full):', originalMessage.content);
    plaintext = originalMessage.content;
  } else if (
    originalMessage.encryptedFor &&
    originalMessage.encryptedFor[username]
  ) {
    // Decrypt the sender's own encrypted version
    console.log('[GrantAccess] ===== DECRYPTING FROM encryptedFor =====');
    console.log(
      '[GrantAccess] Encrypted data length:',
      originalMessage.encryptedFor[username]?.length || 0,
    );
    console.log(
      '[GrantAccess] Encrypted data (first 200 chars):',
      originalMessage.encryptedFor[username]?.substring(0, 200) || 'N/A',
    );
    try {
      plaintext = await decryptMessageForUser(
        originalMessage.encryptedFor[username],
        keys.privateKey,
      );
      console.log(
        '[GrantAccess] ✓ Decrypted plaintext, length:',
        plaintext.length,
      );
      console.log(
        '[GrantAccess] Decrypted content (first 200 chars):',
        plaintext.substring(0, 200),
      );
      console.log('[GrantAccess] Decrypted content (full):', plaintext);
    } catch (error) {
      console.error(
        '[GrantAccess] ✗ Failed to decrypt from encryptedFor:',
        error,
      );
      // Try versions array as fallback
      if (originalMessage.versions && originalMessage.versions.length > 0) {
        const newestVersion = originalMessage.versions[0];
        if (
          newestVersion.encryptedFor &&
          newestVersion.encryptedFor[username]
        ) {
          console.log(
            '[GrantAccess] ===== DECRYPTING FROM NEWEST VERSION =====',
          );
          console.log(
            '[GrantAccess] Encrypted data length:',
            newestVersion.encryptedFor[username]?.length || 0,
          );
          console.log(
            '[GrantAccess] Encrypted data (first 200 chars):',
            newestVersion.encryptedFor[username]?.substring(0, 200) || 'N/A',
          );
          try {
            plaintext = await decryptMessageForUser(
              newestVersion.encryptedFor[username],
              keys.privateKey,
            );
            console.log(
              '[GrantAccess] ✓ Decrypted plaintext from version, length:',
              plaintext.length,
            );
            console.log(
              '[GrantAccess] Decrypted content (first 200 chars):',
              plaintext.substring(0, 200),
            );
            console.log('[GrantAccess] Decrypted content (full):', plaintext);
          } catch (versionError) {
            console.error(
              '[GrantAccess] ✗ Failed to decrypt from version:',
              versionError,
            );
            return;
          }
        } else {
          console.error(
            '[GrantAccess] ✗ No encrypted version found for sender in versions array',
          );
          return;
        }
      } else {
        return;
      }
    }
  } else if (originalMessage.versions && originalMessage.versions.length > 0) {
    // Try newest version
    const newestVersion = originalMessage.versions[0];
    if (newestVersion.encryptedFor && newestVersion.encryptedFor[username]) {
      console.log(
        '[GrantAccess] ===== DECRYPTING FROM NEWEST VERSION (fallback) =====',
      );
      console.log(
        '[GrantAccess] Encrypted data length:',
        newestVersion.encryptedFor[username]?.length || 0,
      );
      console.log(
        '[GrantAccess] Encrypted data (first 200 chars):',
        newestVersion.encryptedFor[username]?.substring(0, 200) || 'N/A',
      );
      try {
        plaintext = await decryptMessageForUser(
          newestVersion.encryptedFor[username],
          keys.privateKey,
        );
        console.log(
          '[GrantAccess] ✓ Decrypted plaintext from version, length:',
          plaintext.length,
        );
        console.log(
          '[GrantAccess] Decrypted content (first 200 chars):',
          plaintext.substring(0, 200),
        );
        console.log('[GrantAccess] Decrypted content (full):', plaintext);
      } catch (error) {
        console.error('[GrantAccess] ✗ Failed to decrypt from version:', error);
        return;
      }
    } else {
      console.error(
        '[GrantAccess] ✗ No encrypted version found for sender in versions array',
      );
      return;
    }
  } else {
    console.error(
      '[GrantAccess] ✗ Cannot find plaintext or encrypted version for sender',
    );
    console.error(
      '[GrantAccess] Message has encryptedFor:',
      !!originalMessage.encryptedFor,
    );
    console.error(
      '[GrantAccess] Message has versions:',
      !!originalMessage.versions,
    );
    if (originalMessage.encryptedFor) {
      console.error(
        '[GrantAccess] encryptedFor keys:',
        Object.keys(originalMessage.encryptedFor),
      );
    }
    return;
  }

  try {
    // Re-encrypt for ALL users (including sender and requesting user)
    let userPubKeys = loadUserPublicKeyEntries();
    if (!userPubKeys) {
      console.error('[GrantAccess] ✗ User public keys not found');
      return;
    }

    // CRITICAL: Ensure the sender's own public key is included
    // This ensures the sender can always decrypt their own messages
    if (!userPubKeys[username]?.publicKey) {
      console.log(
        "[GrantAccess] Adding sender's own public key to userPubKeys",
      );
      userPubKeys = {
        ...userPubKeys,
        [username]: {
          publicKey: keys.publicKey,
          blocked: !!userPubKeys[username]?.blocked,
        },
      };
    }

    // CRITICAL: Ensure the requesting user's public key is included
    // The server should have sent it in the access request, but check anyway
    if (!userPubKeys[requestingUser]?.publicKey) {
      console.error(
        '[GrantAccess] ✗ Requesting user',
        requestingUser,
        'public key not found in local storage!',
      );
      console.error(
        '[GrantAccess] ✗ Available users:',
        Object.keys(userPubKeys),
      );
      console.error(
        '[GrantAccess] ✗ This means the requesting user cannot decrypt the message!',
      );
      console.error(
        "[GrantAccess] ✗ The server should have sent the requesting user's public key in the access request",
      );
      alert(
        `Cannot grant access: Public key for ${requestingUser} not found. Please refresh the page and try again.`,
      );
      return;
    } else {
      console.log(
        '[GrantAccess] ✓ Requesting user',
        requestingUser,
        'public key found in local storage',
      );
    }

    console.log('[GrantAccess] ===== RE-ENCRYPTING MESSAGE =====');
    console.log(
      '[GrantAccess] Plaintext to encrypt - length:',
      plaintext.length,
    );
    console.log(
      '[GrantAccess] Plaintext to encrypt (first 200 chars):',
      plaintext.substring(0, 200),
    );
    console.log('[GrantAccess] Plaintext to encrypt (full):', plaintext);
    console.log(
      '[GrantAccess] Re-encrypting for',
      Object.keys(userPubKeys).length,
      'users:',
      Object.keys(userPubKeys),
    );
    console.log('[GrantAccess] Sender included:', username in userPubKeys);
    console.log(
      '[GrantAccess] Requesting user included:',
      requestingUser in userPubKeys,
    );

    // Encrypt for all users including the sender
    // encryptForAllUsers will use senderPublicKey and senderUsername parameters to ensure sender is included
    const filteredKeys = filterPubKeysForEncryption(userPubKeys, {
      room: originalRoom,
      blockedUsers,
    });
    const encryptedFor = await encryptForAllUsers(
      plaintext,
      filteredKeys,
      keys.publicKey,
      username,
    );

    console.log('[GrantAccess] ===== RE-ENCRYPTION COMPLETE =====');
    console.log(
      '[GrantAccess] Encrypted for',
      Object.keys(encryptedFor).length,
      'users',
    );
    console.log('[GrantAccess] Encrypted users:', Object.keys(encryptedFor));
    // Log encrypted data for sender and requesting user
    if (encryptedFor[username]) {
      console.log(
        '[GrantAccess] Sender encrypted data length:',
        encryptedFor[username].length,
      );
      console.log(
        '[GrantAccess] Sender encrypted data (first 200 chars):',
        encryptedFor[username].substring(0, 200),
      );
    }
    if (encryptedFor[requestingUser]) {
      console.log(
        '[GrantAccess] Requesting user encrypted data length:',
        encryptedFor[requestingUser].length,
      );
      console.log(
        '[GrantAccess] Requesting user encrypted data (first 200 chars):',
        encryptedFor[requestingUser].substring(0, 200),
      );
    }

    // Verify the requesting user is in the encrypted map
    if (!encryptedFor[requestingUser]) {
      console.error(
        '[GrantAccess] ✗ CRITICAL: Requesting user',
        requestingUser,
        'not in encryptedFor map!',
      );
      console.error(
        '[GrantAccess] ✗ Encrypted for users:',
        Object.keys(encryptedFor),
      );
      console.error(
        '[GrantAccess] ✗ This means the requesting user cannot decrypt the message!',
      );

      // If the requesting user's public key wasn't available, we can't encrypt for them
      // The server should handle this case by using its own copy of the public key
      // But we should still send what we have
    } else {
      console.log(
        '[GrantAccess] ✓ Requesting user',
        requestingUser,
        'is in encryptedFor map',
      );
    }

    console.log(
      '[GrantAccess] ✓ Encrypted for',
      Object.keys(encryptedFor).length,
      'users',
    );
    console.log(
      '[GrantAccess] Encrypted for users:',
      Object.keys(encryptedFor),
    );
    console.log(
      '[GrantAccess] Socket state - connected:',
      activeSocket.connected,
      'id:',
      activeSocket.id,
    );

    // Send grant access message with encryptedFor map
    const emitData = {
      requestingUser,
      originalRoom,
      messageTimestamp,
      encryptedFor, // Send all encrypted versions
    };

    console.log('[GrantAccess] Emit data:', {
      requestingUser,
      originalRoom,
      messageTimestamp,
      encryptedForKeys: Object.keys(encryptedFor),
      encryptedForCount: Object.keys(encryptedFor).length,
    });

    // Helper function to proceed with emit (using arrow function to avoid ES5 strict mode issues)
    const proceedWithEmit = () => {
      try {
        // Double-check connection before emitting
        if (!activeSocket.connected) {
          console.error('[GrantAccess] ✗ Socket disconnected before emit!');
          alert('Socket disconnected. Please refresh the page and try again.');
          return;
        }

        console.log(
          '[GrantAccess] About to emit CLIENT_GRANT_ACCESS to server...',
        );
        console.log(
          '[GrantAccess] Calling activeSocket.emit with event:',
          SOCKET_EVENTS.CLIENT_GRANT_ACCESS,
        );
        console.log(
          '[GrantAccess] Emit data size:',
          JSON.stringify(emitData).length,
          'bytes',
        );
        console.log('[GrantAccess] Socket ID:', activeSocket.id);
        console.log('[GrantAccess] Socket connected:', activeSocket.connected);

        // Verify socket is actually ready to send
        const io = (activeSocket as any).io;
        if (io && io.engine) {
          const readyState = io.engine.readyState;
          console.log('[GrantAccess] Socket.IO engine readyState:', readyState);
          // readyState: 'opening' = 0, 'open' = 1, 'closing' = 2, 'closed' = 3
          if (readyState !== 'open' && readyState !== 1) {
            console.error(
              '[GrantAccess] ✗ Socket.IO engine not ready! readyState:',
              readyState,
            );
            alert(
              'Socket is not ready to send data. Please wait a moment and try again.',
            );
            return;
          }
        }

        // Emit the event - socket.emit returns the socket instance
        console.log('[GrantAccess] Calling emit now...');
        try {
          activeSocket.emit(SOCKET_EVENTS.CLIENT_GRANT_ACCESS, emitData);
          console.log('[GrantAccess] ✓ emit() call completed without error');
        } catch (emitError) {
          console.error('[GrantAccess] ✗ Error during emit() call:', emitError);
          throw emitError;
        }

        // Log after a short delay to verify state
        setTimeout(() => {
          console.log(
            '[GrantAccess] Socket state after emit - connected:',
            activeSocket.connected,
            'id:',
            activeSocket.id,
          );
          if (!activeSocket.connected) {
            console.error('[GrantAccess] ⚠ Socket disconnected after emit!');
          }
        }, 100);

        console.log(
          '[GrantAccess] ✓ CLIENT_GRANT_ACCESS emit called successfully',
        );
        console.log(
          '[GrantAccess] ✓ Access granted to',
          requestingUser,
          '- re-encrypted for',
          Object.keys(encryptedFor).length,
          'users',
        );
        console.log('[GrantAccess] ===== GRANT ACCESS COMPLETE =====');
      } catch (error) {
        console.error(
          '[GrantAccess] ✗ Error emitting CLIENT_GRANT_ACCESS:',
          error,
        );
        console.error('[GrantAccess] Error stack:', (error as Error)?.stack);
        console.error('[GrantAccess] Error name:', (error as Error)?.name);
        alert('Failed to send access grant. Please try again.');
      }
    };

    // Wait for socket to be fully connected if it's not already
    if (!activeSocket.connected) {
      console.warn(
        '[GrantAccess] Socket not connected, waiting for connection...',
      );
      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          console.error('[GrantAccess] ✗ Socket connection timeout');
          alert('Socket is not connected. Please refresh the page.');
          reject(new Error('Socket connection timeout'));
        }, 5000);

        activeSocket.once('connect', () => {
          clearTimeout(timeout);
          console.log('[GrantAccess] ✓ Socket connected, proceeding with emit');
          // Continue with emit below
          proceedWithEmit();
          resolve();
        });
      });
    }

    // Proceed with emit
    proceedWithEmit();
  } catch (error) {
    console.error('[GrantAccess] ✗ Failed to grant access:', error);
    console.error('[GrantAccess] Error details:', error);
  }
}

export function leaveRoomAction({
  socket,
  username,
  currentRoom,
  roomList,
  leftRooms,
  setLeftRooms,
  setCurrentRoom,
  room,
}: {
  socket: Socket | undefined;
  username: string;
  currentRoom: string;
  roomList: string[];
  leftRooms: Set<string>;
  setLeftRooms: Dispatch<SetStateAction<Set<string>>>;
  setCurrentRoom: Dispatch<SetStateAction<string>>;
  room: string;
}) {
  if (!socket || !username) return;

  setLeftRooms((prev) => {
    const newSet = new Set(prev);
    newSet.add(room);
    return newSet;
  });

  // If leaving current room, switch to another
  if (currentRoom === room) {
    const availableRooms = roomList.filter(
      (r) => !leftRooms.has(r) && r !== room,
    );
    if (availableRooms.length > 0) {
      setCurrentRoom(availableRooms[0]);
    }
  }

  socket.emit(SOCKET_EVENTS.CLIENT_LEAVE_ROOM, { username, room });
  console.log('[LeaveRoom] Left room:', room);
}

export function rejoinRoomAction({
  socket,
  username,
  setLeftRooms,
  setCurrentRoom,
  room,
}: {
  socket: Socket | undefined;
  username: string;
  setLeftRooms: Dispatch<SetStateAction<Set<string>>>;
  setCurrentRoom: Dispatch<SetStateAction<string>>;
  room: string;
}) {
  if (!socket || !username) return;

  setLeftRooms((prev) => {
    const newSet = new Set(prev);
    newSet.delete(room);
    return newSet;
  });

  socket.emit(SOCKET_EVENTS.CLIENT_REJOIN_ROOM, { username, room });
  setCurrentRoom(room);
  console.log('[RejoinRoom] Rejoined room:', room);
}

export async function selectVersionAction({
  socket,
  username,
  chatValues,
  setChatValues,
  room,
  messageTimestamp,
  versionIndex,
}: {
  socket: Socket | undefined;
  username: string;
  chatValues: Messages;
  setChatValues: SetMessages;
  room: string;
  messageTimestamp: number;
  versionIndex: number;
}) {
  if (!socket || !username) return;

  // Find the message in local state
  const roomMessages = chatValues[room];
  if (!roomMessages) return;

  const message = roomMessages.find(
    (msg) => msg.timestamp === messageTimestamp,
  );
  if (!message || !message.versions || versionIndex >= message.versions.length)
    return;

  const selectedVersion = message.versions[versionIndex];

  // Update local state to show the selected version
  setChatValues((prev) => {
    const updated = { ...prev };
    if (updated[room]) {
      updated[room] = updated[room].map((msg) => {
        if (msg.timestamp === messageTimestamp) {
          return {
            ...msg,
            encryptedFor: selectedVersion.encryptedFor,
            currentVersion: versionIndex,
            // Try to decrypt if we have access
            content: selectedVersion.encryptedFor[username]
              ? msg.content // Keep existing content, will be decrypted below
              : msg.content,
          };
        }
        return msg;
      });
    }
    return updated;
  });

  // If we have access to this version, decrypt it
  if (selectedVersion.encryptedFor[username]) {
    const keys = loadKeys();
    if (keys) {
      try {
        const decrypted = await decryptMessageForUser(
          selectedVersion.encryptedFor[username],
          keys.privateKey,
        );
        setChatValues((prev) => {
          const updated = { ...prev };
          if (updated[room]) {
            updated[room] = updated[room].map((msg) => {
              if (msg.timestamp === messageTimestamp) {
                return { ...msg, content: decrypted };
              }
              return msg;
            });
          }
          return updated;
        });
      } catch (error) {
        console.error('[SelectVersion] Failed to decrypt version:', error);
      }
    }
  }

  console.log(
    '[SelectVersion] Selected version',
    versionIndex,
    'for message',
    messageTimestamp,
  );
}
