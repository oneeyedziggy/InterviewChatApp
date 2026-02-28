'use client';
import {
  useEffect,
  useState,
  useRef,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react';
import io, { type Socket } from 'socket.io-client';
import { styled } from 'styled-components';
import * as SimpleMarkdown from 'simple-markdown';

import { type Messages, type Message } from '../types/types';
import { SelectableList } from '../components/SelectableList';
import { ScrollableDiv } from '../components/styled/ScrollableDiv';
import { SOCKET_EVENTS, DEFAULT_ROOM, SYSTEM_MESSAGES } from '../constants';
import { 
  storeUserPublicKeys, 
  loadUserPublicKeys, 
  encryptForAllUsers, 
  decryptMessageForUser,
  loadKeys 
} from '../utils/gpg';
import * as openpgp from 'openpgp';

const mdParse = SimpleMarkdown.defaultBlockParse;
const mdOutput = SimpleMarkdown.defaultReactOutput;
const mdStringToReact = (msString: string) => mdOutput(mdParse(msString));

let socket: Socket;

const BlockInput = styled.input`
  display: block;
`;
const SideFlexColumn = styled.div`
  display: flex;
  flex-direction: column;
  flex-basis: 15%;
`;
const MiddleFlexColumn = styled.div`
  display: flex;
  flex-direction: column;
  flex-basis: 70%;
  height: 100vh;
`;
const FlexRow = styled.div`
  display: flex;
  flex-direction: row;
`;
const WiderInput = styled.input`
  display: flex;
  flex-basis: 95%;
`;
const WiderButton = styled.button`
  display: flex;
  flex-basis: 10%;
  justify-content: center;
`;
const FlexDiv = styled.div`
  display: flex;
  flex-direction: row;
`;

const transformMessages = (
  messages: Messages, 
  currentRoom: string, 
  username?: string,
  onRequestAccess?: (messageUsername: string, room: string, messageTimestamp: number) => void,
  onGrantAccess?: (requestingUser: string, originalRoom: string, messageTimestamp: number, plaintext?: string) => void,
  onSelectVersion?: (room: string, messageTimestamp: number, versionIndex: number) => void,
  allMessages?: Messages // All messages from all rooms (for looking up original message content)
) => {
  if (currentRoom && Object.keys(messages).length && messages[currentRoom]) {
    return (
      <ScrollableDiv $flexDirection="column-reverse">
        {messages[currentRoom].map((message, dontUseIndex) => {
          // Check if user has access - check both encryptedFor and versions array
          let hasAccess = false;
          let encryptedData: string | null = null;
          
          if (username && message.encryptedFor) {
            hasAccess = !!message.encryptedFor[username];
            if (hasAccess) {
              encryptedData = message.encryptedFor[username];
            }
          }
          
          if (!hasAccess && username && message.versions && message.versions.length > 0) {
            // Check newest version (index 0)
            const newestVersion = message.versions[0];
            if (newestVersion.encryptedFor) {
              hasAccess = !!newestVersion.encryptedFor[username];
              if (hasAccess) {
                encryptedData = newestVersion.encryptedFor[username];
              }
            }
          }
          
          // If we have access but no decrypted content, try to decrypt on-the-fly
          const needsDecryption = hasAccess && encryptedData && (!message.content || message.content.trim() === '' || message.content.includes('🔒') || message.content.includes('[Encrypted message]'));
          const canDecrypt = hasAccess && message.content && message.content.trim() !== '' && !message.content.includes('🔒') && !message.content.includes('[Encrypted message]');
          
          // Check if this is an access request message (contains "requests access")
          const isAccessRequest = message.content && 
            (message.content.includes('requests access') || message.content.includes('Requests access'));
          const isAccessStatus = message.content && 
            (message.content.includes('You requested access') || message.content.includes('you requested access'));
          
          // Show status message for requesting user (not the prompt)
          if (isAccessStatus) {
            const statusMatch = message.content.match(/You requested access to (.+?)'s message in (.+?) \(timestamp: (\d+)\) \[(.+?)\]/i);
            if (statusMatch) {
              const [, originalSender, originalRoom, messageTimestamp, status] = statusMatch;
              const statusColor = status === 'Access Granted' ? '#2e7d32' : status === 'Access Denied' ? '#c62828' : '#666';
              const statusBg = status === 'Access Granted' ? '#e8f5e9' : status === 'Access Denied' ? '#ffebee' : '#f5f5f5';
              
              return (
                <div key={dontUseIndex} style={{ border: '1px solid #ccc', padding: '8px', margin: '4px 0' }}>
                  {mdStringToReact(message.content)}
                  <div style={{ marginTop: '8px', padding: '4px 8px', backgroundColor: statusBg, color: statusColor, borderRadius: '4px', fontSize: '12px', fontWeight: 'bold' }}>
                    Status: {status}
                  </div>
                </div>
              );
            }
          }
          
          if (isAccessRequest && onGrantAccess && username) {
            // Parse the access request to extract details - handle both "User X requests" and "requests" formats
            const match = message.content.match(/(?:User\s+\w+\s+)?requests access to your message in (.+?) \(timestamp: (\d+)\)/i);
            if (match) {
              const originalRoom = match[1];
              const messageTimestamp = parseInt(match[2], 10);
              const requestingUser = message.username;
              
              // Look up the original message content from the original author's local state
              // The requesting user doesn't have access to the content, so we look it up locally
              let quotedContent: string | null = null;
              const roomMessages = allMessages ? allMessages[originalRoom] : null;
              if (roomMessages) {
                const originalMessage = roomMessages.find(msg => 
                  msg.timestamp === messageTimestamp && msg.username === username
                );
                if (originalMessage) {
                  // Use the decrypted content if available, otherwise show encrypted indicator
                  if (originalMessage.content && 
                      originalMessage.content.trim() && 
                      !originalMessage.content.includes('🔒') && 
                      !originalMessage.content.includes('[Encrypted message]')) {
                    quotedContent = originalMessage.content;
                    console.log('[AccessRequest] Found original message content locally, length:', quotedContent.length);
                  } else {
                    console.log('[AccessRequest] Original message found but content not decrypted yet');
                    quotedContent = '[Encrypted message]';
                  }
                } else {
                  console.log('[AccessRequest] Original message not found in local state for timestamp:', messageTimestamp);
                  quotedContent = '[Message not found]';
                }
              } else {
                console.log('[AccessRequest] Room not found in local state:', originalRoom);
                quotedContent = '[Message not found]';
              }
              
              // Check if this request was already responded to (denied or granted)
              const isDenied = message.content.includes('[Access Denied]');
              const isGranted = message.content.includes('[Access Granted]');
              
              // Build the display content with the actual message content
              const requestText = message.content.split(':')[0]; // Get the part before the colon
              const displayContent = quotedContent 
                ? `${requestText}:\n\n> ${quotedContent}`
                : message.content.replace(/\[Grant Access\]|\[Deny Access\]|\[Access Granted\]|\[Access Denied\]/g, '');
              
              return (
                <div key={dontUseIndex} style={{ border: '1px solid #ccc', padding: '8px', margin: '4px 0' }}>
                  {mdStringToReact(displayContent)}
                  {isGranted && (
                    <div style={{ marginTop: '8px', padding: '4px 8px', backgroundColor: '#e8f5e9', color: '#2e7d32', borderRadius: '4px', fontSize: '12px' }}>
                      ✓ Access Granted
                    </div>
                  )}
                  {!isDenied && !isGranted && (
                    <div style={{ marginTop: '8px', display: 'flex', gap: '8px' }}>
                      <button
                        onClick={async () => {
                          console.log('[Button] Yes - Grant Access clicked');
                          console.log('[Button] requestingUser:', requestingUser);
                          console.log('[Button] originalRoom:', originalRoom);
                          console.log('[Button] messageTimestamp:', messageTimestamp);
                          console.log('[Button] quotedContent:', quotedContent ? 'provided' : 'not provided');
                          console.log('[Button] onGrantAccess function:', typeof onGrantAccess);
                          console.log('[Button] socket available:', !!(socket || (window as any).__socket));
                          if (onGrantAccess) {
                            try {
                              await onGrantAccess(requestingUser, originalRoom, messageTimestamp, quotedContent || undefined);
                              console.log('[Button] ✓ onGrantAccess completed');
                            } catch (error) {
                              console.error('[Button] ✗ Error in onGrantAccess:', error);
                            }
                          } else {
                            console.error('[Button] ✗ onGrantAccess is not a function!');
                          }
                        }}
                        style={{ 
                          padding: '4px 8px', 
                          fontSize: '12px',
                          cursor: 'pointer',
                          backgroundColor: '#4caf50',
                          color: 'white',
                          border: 'none',
                          borderRadius: '4px'
                        }}
                      >
                        Yes - Grant Access
                      </button>
                      <button
                        onClick={() => {
                          if (socket) {
                            socket.emit(SOCKET_EVENTS.CLIENT_DENY_ACCESS, {
                              requestingUser,
                              originalRoom,
                              messageTimestamp,
                            });
                          }
                        }}
                        style={{ 
                          padding: '4px 8px', 
                          fontSize: '12px',
                          cursor: 'pointer',
                          backgroundColor: '#f44336',
                          color: 'white',
                          border: 'none',
                          borderRadius: '4px'
                        }}
                      >
                        No - Deny Access
                      </button>
                    </div>
                  )}
                </div>
              );
            }
          }
          
          // Check if message is encrypted but user doesn't have access
          // Also check versions array
          const hasEncryptedFor = message.encryptedFor && Object.keys(message.encryptedFor).length > 0;
          const hasVersionsWithEncryption = message.versions && message.versions.length > 0 && 
            message.versions.some(v => v.encryptedFor && Object.keys(v.encryptedFor).length > 0);
          
          if (!canDecrypt && (hasEncryptedFor || hasVersionsWithEncryption)) {
            // Message is encrypted but user doesn't have access
            return (
              <div key={dontUseIndex} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span>🔒</span>
                <span>{message.username}: [Encrypted message]</span>
                {onRequestAccess && (
                  <button
                    onClick={() => onRequestAccess(message.username, currentRoom, message.timestamp)}
                    style={{ 
                      marginLeft: '8px', 
                      padding: '4px 8px', 
                      fontSize: '12px',
                      cursor: 'pointer'
                    }}
                  >
                    Request Access
                  </button>
                )}
              </div>
            );
          }
          
          // Message is decrypted or is a system message
          const hasMultipleVersions = message.versions && message.versions.length > 1;
          const currentVersionIndex = message.currentVersion !== undefined ? message.currentVersion : 0;
          
          return (
            <div key={dontUseIndex} style={{ position: 'relative' }}>
              {hasMultipleVersions && onSelectVersion && message.versions && (
                <div style={{ marginBottom: '4px', fontSize: '12px' }}>
                  <label>
                    Version: 
                    <select
                      value={currentVersionIndex}
                      onChange={(e) => onSelectVersion(currentRoom, message.timestamp, parseInt(e.target.value, 10))}
                      style={{ marginLeft: '4px', fontSize: '12px', padding: '2px 4px' }}
                    >
                      {message.versions.map((version, idx) => (
                        <option key={idx} value={idx}>
                          {idx === 0 ? 'Latest' : `v${version.version}`} - {version.changeSummary || 'no changes'} ({new Date(version.timestamp * 1000).toLocaleString()})
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
              {mdStringToReact(`${message.username}: ${message.content || '[No content]'}`)}
            </div>
          );
        })}
      </ScrollableDiv>
    );
  }
};

// TODO: break this up into more components to reduce the complexity and number of dependencies in this file
const Home = () => {
  const [userDraftMessage, setUserDraftMessage] = useState('');
  // this "old" chatValues is almost certainly not the best way to acheive this, but there appears to be a timing issue trying to do the diff in the socket.on serverMessage
  const [oldChatValues, setOldChatValues] = useState<Messages>({});
  const [chatValues, setChatValues] = useState<Messages>({});
  const [userList, setUserList] = useState<string[]>([]); // Keep for backward compatibility
  const [loggedInUsers, setLoggedInUsers] = useState<string[]>([]);
  const [activeUsers, setActiveUsers] = useState<string[]>([]);
  const [roomList, setRoomList] = useState<string[]>([]);
  const [leftRooms, setLeftRooms] = useState<Set<string>>(new Set()); // Rooms user has left
  const [roomNotifications, setRoomNotifications] = useState<{
    [key: string]: string;
  }>({});
  const [currentRoom, setCurrentRoom] = useState<string>('');
  const [newRoomName, setNewRoomName] = useState<string>('');

  const [authToken, setAuthToken] = useState<string>('');
  const [username, setUsername] = useState<string>('');
  const [userLastSeen, setUserLastSeen] = useState<Record<string, number>>({});
  const [roomMembers, setRoomMembers] = useState<Record<string, Set<string>>>({});
  const [activeJoinRequests, setActiveJoinRequests] = useState<Array<{
    requestingUser: string;
    room: string;
    timestamp: number;
  }>>([]);

  useEffect(() => {
    setRoomNotifications((rn) => {
      const baseRoomName = currentRoom?.replace(/-\(\d+ NEW!\)/, '');
      const newobj = {
        ...rn,
        [baseRoomName]: '',
      };
      return newobj;
    });
  }, [currentRoom]);

  // Check authentication on mount and redirect to login if needed
  useEffect(() => {
    const storedKeys = loadKeys();
    if (storedKeys && storedKeys.sessionId) {
      setAuthToken(storedKeys.sessionId);
      setUsername(storedKeys.username);
    } else {
      // No auth token, redirect to login
      window.location.href = '/login';
    }
  }, []);

  useEffect(() => {
    console.log('[Home] useEffect triggered, authToken:', authToken, 'username:', username);
    if (authToken) {
      console.log('[Home] Calling socketInitializer');
      socketInitializer(authToken);
    } else {
      console.log('[Home] No authToken, skipping socket initialization');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken]); // socketInitializer is stable and doesn't need to be in deps

  useEffect(() => {
    !currentRoom && setCurrentRoom(roomList[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomList]); // currentRoom intentionally excluded to avoid infinite loop

  // Track which messages we've attempted to decrypt to prevent infinite loops
  const decryptionAttemptsRef = useRef<Set<string>>(new Set());

  // Auto-decrypt messages that have access but no content
  useEffect(() => {
    const keys = loadKeys();
    if (!keys || !username) return;

    const decryptPromises: Array<Promise<{ room: string; timestamp: number; content: string } | null>> = [];

    for (const [room, messages] of Object.entries(chatValues)) {
      for (const msg of messages) {
        // Create a unique key for this message
        const messageKey = `${room}:${msg.timestamp}`;
        
        // Skip if we've already attempted to decrypt this message
        if (decryptionAttemptsRef.current.has(messageKey)) {
          continue;
        }

        // Check if user has access but message isn't decrypted
        let hasAccess = false;
        let encryptedData: string | null = null;
        
        if (msg.encryptedFor && keys.username && msg.encryptedFor[keys.username]) {
          hasAccess = true;
          encryptedData = msg.encryptedFor[keys.username];
        } else if (msg.versions && msg.versions.length > 0) {
          const newestVersion = msg.versions[0];
          if (newestVersion.encryptedFor && keys.username && newestVersion.encryptedFor[keys.username]) {
            hasAccess = true;
            encryptedData = newestVersion.encryptedFor[keys.username];
          }
        }

        // If we have access but no decrypted content, decrypt it
        const needsDecryption = hasAccess && encryptedData && 
          (!msg.content || msg.content.trim() === '' || msg.content.includes('🔒') || msg.content.includes('[Encrypted message]'));
        
        if (needsDecryption) {
          // Mark this message as being decrypted
          decryptionAttemptsRef.current.add(messageKey);
          
          decryptPromises.push(
            (async () => {
              try {
                console.log('[AutoDecrypt] ===== AUTO-DECRYPTING MESSAGE =====');
                console.log('[AutoDecrypt] Message timestamp:', msg.timestamp);
                console.log('[AutoDecrypt] User:', keys.username);
                console.log('[AutoDecrypt] Room:', room);
                console.log('[AutoDecrypt] Encrypted data length:', encryptedData!.length);
                console.log('[AutoDecrypt] Encrypted data (first 200 chars):', encryptedData!.substring(0, 200));
                const decrypted = await decryptMessageForUser(encryptedData!, keys.privateKey);
                console.log('[AutoDecrypt] ✓ Decrypted message', msg.timestamp, 'content length:', decrypted.length);
                console.log('[AutoDecrypt] Decrypted content (first 200 chars):', decrypted.substring(0, 200));
                console.log('[AutoDecrypt] Decrypted content (full):', decrypted);
                return { room, timestamp: msg.timestamp, content: decrypted };
              } catch (error) {
                console.error('[AutoDecrypt] ✗ Failed to decrypt message', msg.timestamp, ':', error);
                // Remove from attempts so we can retry later if needed
                decryptionAttemptsRef.current.delete(messageKey);
                return null;
              }
            })()
          );
        }
      }
    }

    // Batch all updates into a single setChatValues call
    if (decryptPromises.length > 0) {
      Promise.all(decryptPromises).then((results) => {
        const updates = results.filter((r): r is { room: string; timestamp: number; content: string } => r !== null);
        if (updates.length > 0) {
          setChatValues(prev => {
            const updated = { ...prev };
            for (const { room, timestamp, content } of updates) {
              if (updated[room]) {
                updated[room] = updated[room].map(m => 
                  m.timestamp === timestamp ? { ...m, content } : m
                );
              }
            }
            return updated;
          });
          console.log('[AutoDecrypt] ✓ Finished auto-decrypting', updates.length, 'messages');
        }
      });
    }
  }, [chatValues, username]); // Decrypt whenever messages change

  useEffect(() => {
    oldChatValues &&
      setRoomNotifications(
        Object.fromEntries(
          Object.keys(oldChatValues).map((roomName: string) => {
            return chatValues[roomName]?.length >
              oldChatValues[roomName]?.length && !(roomName === currentRoom)
              ? [
                  roomName,
                  `(${
                    chatValues[roomName]?.length -
                    oldChatValues[roomName]?.length
                  } NEW!)`,
                ]
              : [roomName, ''];
          })
        )
      );
    setOldChatValues(chatValues);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatValues]); // oldChatValues and currentRoom intentionally excluded to avoid infinite loop

  const socketInitializer = async (authToken: string) => {
    console.log('[Socket] ===== INITIALIZING SOCKET =====');
    console.log('[Socket] Token:', authToken);
    console.log('[Socket] Username:', username);
    console.log('[Socket] Current window location:', window.location.href);
    
    // Disconnect existing socket if any
    if (socket && socket.connected) {
      console.log('[Socket] Disconnecting existing socket before creating new one');
      socket.disconnect();
      socket = undefined as any;
    }
    if ((window as any).__socket && (window as any).__socket.connected) {
      console.log('[Socket] Disconnecting existing window socket before creating new one');
      (window as any).__socket.disconnect();
      (window as any).__socket = undefined;
    }
    
    // Connect to Socket.IO server - use current origin (should be localhost:3000)
    const socketUrl = window.location.origin;
    console.log('[Socket] Connecting to:', socketUrl);
    
    socket = io(socketUrl, {
      auth: {
        token: authToken,
        username,
      },
      transports: ['polling', 'websocket'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      forceNew: true, // Force a new connection
    });

    // Store socket reference globally for doSend and access grant
    (window as any).__socket = socket;

    console.log('[Socket] Socket instance created:', socket);
    console.log('[Socket] Socket ID:', socket.id);
    console.log('[Socket] Socket connected:', socket.connected);
    console.log('[Socket] Setting up listeners...');
    
    // Handle connection events
    socket.on('connect', () => {
      console.log('[Socket] ✓ Socket connected, ID:', socket.id);
      // Update window reference
      (window as any).__socket = socket;
    });
    
    socket.on('disconnect', (reason) => {
      console.log('[Socket] ✗ Socket disconnected, reason:', reason);
    });
    
    socket.on('connect_error', (error) => {
      console.error('[Socket] ✗ Connection error:', error);
    });
    
    socket.on('reconnect', (attemptNumber) => {
      console.log('[Socket] ✓ Socket reconnected after', attemptNumber, 'attempts');
      // Update window reference
      (window as any).__socket = socket;
    });

    // Set up listeners immediately - Socket.IO queues events emitted during connection
    socket.on(SOCKET_EVENTS.INITIAL_DATA, async (data) => {
      console.log('[Socket] ===== INITIAL_DATA RECEIVED =====');
      console.log('[Socket] Full data object:', JSON.stringify(data, null, 2));
      console.log('[Socket] Messages:', data?.messages);
      console.log('[Socket] Messages type:', typeof data?.messages);
      console.log('[Socket] Messages keys:', data?.messages ? Object.keys(data.messages) : 'none');
      console.log('[Socket] Rooms:', data?.rooms);
      console.log('[Socket] Rooms type:', typeof data?.rooms);
      console.log('[Socket] Rooms length:', Array.isArray(data?.rooms) ? data.rooms.length : 'not array');
      console.log('[Socket] Users:', data?.users);
      console.log('[Socket] Users type:', typeof data?.users);
      console.log('[Socket] Users length:', Array.isArray(data?.users) ? data.users.length : 'not array');
      
      // Store user public keys first (needed for decryption)
      if (data?.userPubKeys) {
        console.log('[Socket] ✓ Storing user public keys:', Object.keys(data.userPubKeys).length, 'keys');
        storeUserPublicKeys(data.userPubKeys);
      } else {
        console.warn('[Socket] ✗ No userPubKeys in INITIAL_DATA');
      }
      
      // Decrypt messages if needed
      if (data?.messages) {
        const keys = loadKeys();
        const decryptedMessages: Messages = {};
        
        for (const [room, messages] of Object.entries(data.messages)) {
          // Type assertion: messages from INITIAL_DATA should be Message[]
          const roomMessages = messages as Message[];
          decryptedMessages[room] = await Promise.all(
            roomMessages.map(async (msg: Message) => {
              // If message has encryptedFor and we have keys, decrypt it
              if (msg.encryptedFor && keys) {
                const encrypted = msg.encryptedFor[keys.username];
                if (encrypted) {
                  try {
                    const decrypted = await decryptMessageForUser(encrypted, keys.privateKey);
                    return { ...msg, content: decrypted };
                  } catch (error) {
                    console.error('[Socket] ✗ Failed to decrypt message:', error);
                    return msg; // Return original if decryption fails
                  }
                }
              }
              return msg;
            })
          );
        }
        
        console.log('[Socket] ✓ Setting chat values, count:', Object.keys(decryptedMessages).length);
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
      
      // Handle new format with loggedInUsers and activeUsers
      if (data?.loggedInUsers || data?.activeUsers) {
        console.log('[Socket] ✓ Setting logged in users:', data.loggedInUsers);
        console.log('[Socket] ✓ Setting active users:', data.activeUsers);
        setLoggedInUsers(data.loggedInUsers || []);
        setActiveUsers(data.activeUsers || []);
      } else if (data?.users) {
        // Fallback: if only old format, treat all as logged in
        setLoggedInUsers(data.users || []);
        setActiveUsers([]);
      }
      
      console.log('[Socket] ===== INITIAL_DATA PROCESSING COMPLETE =====');
    });
    
    socket.on(SOCKET_EVENTS.SERVER_MESSAGE, async (data) => {
      console.log('[Socket] SERVER_MESSAGE received');
      
      // Update user last seen for users in messages
      if (data?.messages) {
        setUserLastSeen(prev => {
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
        const { originalRoom, messageTimestamp, encryptedFor, encryptedMessage } = data.accessGrant;
        
        // Handle new format (encryptedFor map) or old format (encryptedMessage)
        const encryptedMap = encryptedFor || (encryptedMessage && username ? { [username]: encryptedMessage } : {});
        
        console.log('[AccessGrant] ===== PROCESSING ACCESS GRANT =====');
        console.log('[AccessGrant] Room:', originalRoom, 'timestamp:', messageTimestamp);
        console.log('[AccessGrant] encryptedFor users from accessGrant:', Object.keys(encryptedMap));
        
        // If server sent updated messages, use those (they include the new version)
        if (data?.messages && data.messages[originalRoom]) {
          const keys = loadKeys();
          if (!keys) {
            console.error('[AccessGrant] No keys available for decryption');
            return;
          }
          
          const roomMessages = data.messages[originalRoom] as Message[];
          
          console.log('[AccessGrant] Processing', roomMessages.length, 'messages from server for room:', originalRoom, 'for user:', keys.username);
          
          // Log details about each message
          roomMessages.forEach((msg, idx) => {
            console.log(`[AccessGrant] Message ${idx}: timestamp=${msg.timestamp}, username=${msg.username}, hasEncryptedFor=${!!msg.encryptedFor}, encryptedForKeys=${Object.keys(msg.encryptedFor || {}).join(',')}, hasVersions=${!!msg.versions}, versionsCount=${msg.versions?.length || 0}`);
            if (msg.versions && msg.versions.length > 0) {
              console.log(`[AccessGrant] Message ${idx} newest version encryptedForKeys:`, Object.keys(msg.versions[0].encryptedFor || {}).join(','));
            }
          });
          
          // Decrypt messages we have access to
          const decryptedMessages = await Promise.all(
            roomMessages.map(async (msg: Message) => {
              // If message already has decrypted content, keep it (but verify it's not the lock emoji)
              if (msg.content && msg.content.trim() !== '' && !msg.content.includes('🔒') && !msg.content.includes('[Encrypted message]')) {
                console.log('[AccessGrant] Message', msg.timestamp, 'already has decrypted content, keeping it');
                return msg;
              }
              
              // For all messages, try to decrypt if we have access
              // Check both encryptedFor and versions array (prioritize newest version)
              let encryptedData: string | null = null;
              let sourceEncryptedFor: Record<string, string> | null = null;
              
              // First check versions array (newest version takes precedence)
              if (msg.versions && msg.versions.length > 0) {
                const newestVersion = msg.versions[0];
                if (newestVersion.encryptedFor && newestVersion.encryptedFor[keys.username]) {
                  encryptedData = newestVersion.encryptedFor[keys.username];
                  sourceEncryptedFor = newestVersion.encryptedFor;
                  console.log('[AccessGrant] Found encryption key in newest version for message', msg.timestamp);
                }
              }
              
              // Fallback to current encryptedFor if not found in versions
              if (!encryptedData && msg.encryptedFor && msg.encryptedFor[keys.username]) {
                encryptedData = msg.encryptedFor[keys.username];
                sourceEncryptedFor = msg.encryptedFor;
                console.log('[AccessGrant] Found encryption key in encryptedFor for message', msg.timestamp);
              }
              
              if (encryptedData) {
                try {
                  console.log('[AccessGrant] ===== DECRYPTING MESSAGE FOR REQUESTING USER =====');
                  console.log('[AccessGrant] Message timestamp:', msg.timestamp);
                  console.log('[AccessGrant] User:', keys.username);
                  console.log('[AccessGrant] Encrypted data length:', encryptedData.length);
                  console.log('[AccessGrant] Encrypted data (first 200 chars):', encryptedData.substring(0, 200));
                  const decrypted = await decryptMessageForUser(encryptedData, keys.privateKey);
                  console.log('[AccessGrant] ✓ Decrypted message for', keys.username, 'timestamp:', msg.timestamp, 'content length:', decrypted.length);
                  console.log('[AccessGrant] Decrypted content (first 200 chars):', decrypted.substring(0, 200));
                  console.log('[AccessGrant] Decrypted content (full):', decrypted);
                  return { 
                    ...msg, 
                    content: decrypted,
                    encryptedFor: sourceEncryptedFor || msg.encryptedFor // Use the source that had the key
                  };
                } catch (error) {
                  console.error('[AccessGrant] ✗ Failed to decrypt message:', error);
                  return msg;
                }
              }
              
              // If this is the target message, log why we couldn't decrypt
              if (msg.timestamp === messageTimestamp) {
                console.log('[AccessGrant] ⚠ Target message (timestamp:', messageTimestamp, ') could not be decrypted');
                console.log('[AccessGrant] Message encryptedFor keys:', Object.keys(msg.encryptedFor || {}));
                console.log('[AccessGrant] Current user:', keys.username);
                console.log('[AccessGrant] Has access in encryptedFor:', !!(msg.encryptedFor && msg.encryptedFor[keys.username]));
                if (msg.versions && msg.versions.length > 0) {
                  console.log('[AccessGrant] Versions count:', msg.versions.length);
                  console.log('[AccessGrant] Newest version encryptedFor keys:', Object.keys(msg.versions[0].encryptedFor || {}));
                  console.log('[AccessGrant] Has access in newest version:', !!(msg.versions[0].encryptedFor && msg.versions[0].encryptedFor[keys.username]));
                } else {
                  console.log('[AccessGrant] No versions array in message');
                }
              }
              
              return msg;
            })
          );
          
          // Merge with existing chat values (create room if it doesn't exist)
          setChatValues(prev => {
            const updated = { ...prev };
            // Merge messages: update existing ones, add new ones
            if (!updated[originalRoom]) {
              updated[originalRoom] = [];
            }
            
            // Create a map of existing messages by timestamp for efficient lookup
            const existingMessagesMap = new Map(
              updated[originalRoom].map(msg => [msg.timestamp, msg])
            );
            
            // Update or add decrypted messages
            const mergedMessages = decryptedMessages.map(decryptedMsg => {
              const existing = existingMessagesMap.get(decryptedMsg.timestamp);
              if (existing) {
                // Merge: prioritize decrypted content that's not a placeholder
                let finalContent = decryptedMsg.content;
                if (!finalContent || finalContent.trim() === '' || finalContent.includes('🔒') || finalContent.includes('[Encrypted message]')) {
                  // If decrypted content is a placeholder, use existing content if it's better
                  if (existing.content && existing.content.trim() !== '' && !existing.content.includes('🔒') && !existing.content.includes('[Encrypted message]')) {
                    finalContent = existing.content;
                  }
                }
                
                // Merge encryptedFor maps (prefer decryptedMsg's version as it's newer)
                const finalEncryptedFor = decryptedMsg.encryptedFor || existing.encryptedFor;
                
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
              if (!decryptedMessages.find(m => m.timestamp === timestamp)) {
                mergedMessages.push(msg);
              }
            });
            
            // Sort by timestamp
            mergedMessages.sort((a, b) => a.timestamp - b.timestamp);
            
            updated[originalRoom] = mergedMessages;
            console.log('[AccessGrant] Updated chatValues for room:', originalRoom, 'with', mergedMessages.length, 'messages');
            
            // Log the target message specifically
            const targetMsg = mergedMessages.find(m => m.timestamp === messageTimestamp);
            if (targetMsg) {
              console.log('[AccessGrant] Target message after update:', {
                timestamp: targetMsg.timestamp,
                username: targetMsg.username,
                hasContent: !!targetMsg.content,
                contentLength: targetMsg.content?.length || 0,
                hasEncryptedFor: !!targetMsg.encryptedFor,
                encryptedForKeys: Object.keys(targetMsg.encryptedFor || {}),
                contentPreview: targetMsg.content ? targetMsg.content.substring(0, 50) : 'no content',
              });
              
              // If target message still doesn't have content, log detailed info
              if (!targetMsg.content || targetMsg.content.trim() === '' || targetMsg.content.includes('🔒') || targetMsg.content.includes('[Encrypted message]')) {
                console.error('[AccessGrant] ⚠ Target message still not decrypted!');
                console.error('[AccessGrant] Message encryptedFor:', targetMsg.encryptedFor);
                console.error('[AccessGrant] Current user:', keys.username);
                console.error('[AccessGrant] Has key in encryptedFor:', !!(targetMsg.encryptedFor && targetMsg.encryptedFor[keys.username]));
                if (targetMsg.versions && targetMsg.versions.length > 0) {
                  console.error('[AccessGrant] Newest version encryptedFor:', targetMsg.versions[0].encryptedFor);
                  console.error('[AccessGrant] Has key in newest version:', !!(targetMsg.versions[0].encryptedFor && targetMsg.versions[0].encryptedFor[keys.username]));
                }
              } else {
                console.log('[AccessGrant] ✓ Target message successfully decrypted!');
              }
            }
            return updated;
          });
          
          // Ensure the room is in the room list
          setRoomList(prev => {
            if (!prev.includes(originalRoom)) {
              return [...prev, originalRoom];
            }
            return prev;
          });
          
          console.log('[AccessGrant] ✓ Updated messages for room:', originalRoom, '- message should now be visible');
        } else {
          // Fallback: update the message's encryptedFor map and versions
          setChatValues(prev => {
            const updated = { ...prev };
            if (updated[originalRoom]) {
              updated[originalRoom] = updated[originalRoom].map(msg => {
                if (msg.timestamp === messageTimestamp) {
                  // Update encryptedFor with new map
                  const newEncryptedFor = { ...msg.encryptedFor, ...encryptedMap };
                  
                  // Update or create versions array
                  let versions = msg.versions || [];
                  if (versions.length === 0 && msg.encryptedFor) {
                    // Migrate existing to version 0
                    versions = [{
                      encryptedFor: msg.encryptedFor,
                      version: 0,
                      changeSummary: 'original version',
                      timestamp: msg.timestamp,
                    }];
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
                console.log('[AccessGrant] ===== DECRYPTING FOR ORIGINAL AUTHOR (FALLBACK) =====');
                console.log('[AccessGrant] Message timestamp:', messageTimestamp);
                console.log('[AccessGrant] User:', username);
                console.log('[AccessGrant] Encrypted data length:', encryptedMap[username].length);
                console.log('[AccessGrant] Encrypted data (first 200 chars):', encryptedMap[username].substring(0, 200));
                const decrypted = await decryptMessageForUser(encryptedMap[username], keys.privateKey);
                console.log('[AccessGrant] ✓ Decrypted granted message, content length:', decrypted.length);
                console.log('[AccessGrant] Decrypted content (first 200 chars):', decrypted.substring(0, 200));
                console.log('[AccessGrant] Decrypted content (full):', decrypted);
                setChatValues(prev => {
                  const updated = { ...prev };
                  if (updated[originalRoom]) {
                    updated[originalRoom] = updated[originalRoom].map(msg => {
                      if (msg.timestamp === messageTimestamp) {
                        return { ...msg, content: decrypted };
                      }
                      return msg;
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
          decryptedMessages[room] = await Promise.all(
            roomMessages.map(async (msg: Message) => {
              // Check if we have access - check both encryptedFor and versions array
              let encryptedData: string | null = null;
              
              if (msg.encryptedFor && keys?.username && msg.encryptedFor[keys.username]) {
                encryptedData = msg.encryptedFor[keys.username];
              } else if (msg.versions && msg.versions.length > 0 && keys?.username) {
                // Check newest version (index 0)
                const newestVersion = msg.versions[0];
                if (newestVersion.encryptedFor && newestVersion.encryptedFor[keys.username]) {
                  encryptedData = newestVersion.encryptedFor[keys.username];
                }
              }
              
              if (encryptedData) {
                try {
                  console.log('[Socket] ===== DECRYPTING MESSAGE IN SERVER_MESSAGE =====');
                  console.log('[Socket] Message timestamp:', msg.timestamp);
                  console.log('[Socket] User:', keys!.username);
                  console.log('[Socket] Room:', room);
                  console.log('[Socket] Encrypted data length:', encryptedData.length);
                  console.log('[Socket] Encrypted data (first 200 chars):', encryptedData.substring(0, 200));
                  const decrypted = await decryptMessageForUser(encryptedData, keys!.privateKey);
                  console.log('[Socket] ✓ Decrypted message, content length:', decrypted.length);
                  console.log('[Socket] Decrypted content (first 200 chars):', decrypted.substring(0, 200));
                  console.log('[Socket] Decrypted content (full):', decrypted);
                  return { ...msg, content: decrypted };
                } catch (error) {
                  console.error('[Socket] ✗ Failed to decrypt message:', error);
                  return msg; // Return original if decryption fails
                }
              }
              return msg;
            })
          );
        }
        
        // Merge with existing chat values instead of replacing
        setChatValues(prev => {
          const merged = { ...prev };
          for (const [room, messages] of Object.entries(decryptedMessages)) {
            merged[room] = messages;
          }
          return merged;
        });
        
        // Ensure all rooms from messages are in the room list
        setRoomList(prev => {
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
        const allUsers = [...(data.loggedInUsers || []), ...(data.activeUsers || [])];
        if (allUsers.length > 0) {
          setUserList(allUsers);
        }
      } else if (data?.users && Array.isArray(data.users) && data.users.length > 0) {
        // Fallback: if only old format, treat all as logged in
        setLoggedInUsers(data.users);
        setActiveUsers([]);
      }
      
      // Update room members if provided
      if (data?.roomMembers) {
        setRoomMembers(prev => {
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
        setUserLastSeen(prev => {
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
        setChatValues(prev => {
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
          // Also update userList for backward compatibility
          const allUsers = [...((data as any).loggedInUsers || []), ...((data as any).activeUsers || [])];
          setUserList(allUsers);
          console.log('[Socket] ✓ Updated user lists:', (data as any).loggedInUsers?.length || 0, 'logged in,', (data as any).activeUsers?.length || 0, 'active');
        } else {
          console.warn('[Socket] ✗ Invalid user list format:', data);
        }
      } else if (Array.isArray(data)) {
        // Backward compatibility: treat array as logged-in users
        setUserList(data);
        setLoggedInUsers(data);
        setActiveUsers([]);
        console.log('[Socket] ✓ Updated user list (legacy format):', data.length, 'users');
      } else {
        console.warn('[Socket] ✗ Invalid user list format:', data);
      }
    });
    
    // Handle join requests
    socket.on(SOCKET_EVENTS.SERVER_JOIN_REQUEST, (data) => {
      console.log('[Socket] SERVER_JOIN_REQUEST received:', data);
      if (data?.type === 'joinRequest' && data?.requestingUser && data?.room) {
        setActiveJoinRequests(prev => {
          const exists = prev.some(req => req.requestingUser === data.requestingUser && req.room === data.room);
          if (!exists) {
            return [...prev, {
              requestingUser: data.requestingUser,
              room: data.room,
              timestamp: data.timestamp || Date.now(),
            }];
          }
          return prev;
        });
      }
    });

    socket.on(SOCKET_EVENTS.SERVER_JOIN_APPROVED, (data) => {
      console.log('[Socket] SERVER_JOIN_APPROVED received:', data);
      if (data?.type === 'joinApproved' && data?.requestingUser && data?.room) {
        setActiveJoinRequests(prev => prev.filter(req => 
          !(req.requestingUser === data.requestingUser && req.room === data.room)
        ));
        // Update room members
        setRoomMembers(prev => {
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
        setActiveJoinRequests(prev => prev.filter(req => 
          !(req.requestingUser === data.requestingUser && req.room === data.room)
        ));
      }
    });

    // Handle access requests - show in private room named after the other user
    socket.on(SOCKET_EVENTS.SERVER_ACCESS_REQUEST, (data) => {
      console.log('[Socket] SERVER_ACCESS_REQUEST received:', data);
      if (data?.requestAccess) {
        const { requestingUser, originalRoom, messageTimestamp, originalSender } = data.requestAccess;
        // The server sends the appropriate room name for this user:
        // - Original sender sees @requestingUser
        // - Requesting user sees @originalSender (from SERVER_MESSAGE, not this event)
        const dmRoom = data?.requestRoom;
        
        if (!dmRoom) {
          console.warn('[AccessRequest] ⚠ No requestRoom provided in SERVER_ACCESS_REQUEST');
          return;
        }
        
        // Store the requesting user's public key if provided by server
        if (data?.requestingUserPubKey && requestingUser) {
          console.log('[AccessRequest] Storing requesting user public key for:', requestingUser);
          const userPubKeys = loadUserPublicKeys() || {};
          userPubKeys[requestingUser] = data.requestingUserPubKey;
          storeUserPublicKeys(userPubKeys);
          console.log('[AccessRequest] ✓ Stored public key for requesting user:', requestingUser);
        } else {
          console.warn('[AccessRequest] ⚠ No public key provided for requesting user:', requestingUser);
        }
        
        // Add room if it doesn't exist (only for original sender, requesting user gets it from SERVER_MESSAGE)
        if (username === originalSender) {
          setRoomList(prev => {
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
        alert(`Access to your message in ${originalRoom} was denied by the original sender.`);
      }
    });
    
    socket.on(SOCKET_EVENTS.DISCONNECTING, (msg) => {
      socket.emit(SOCKET_EVENTS.CLIENT_MESSAGE, {
        username,
        room: DEFAULT_ROOM,
        content: SYSTEM_MESSAGES.USER_LEFT,
      });
      socket.emit(SOCKET_EVENTS.CLIENT_DISCONNECTING, authToken);
      setAuthToken('');
    });
    
    socket.on(SOCKET_EVENTS.STATUS, (msg) => {
      console.log('[Socket] STATUS received:', msg);
    });

    socket.on(SOCKET_EVENTS.CONNECT, () => {
      console.log('[Socket] ===== CONNECTED =====');
      console.log('[Socket] Socket ID:', socket.id);
      console.log('[Socket] Socket connected:', socket.connected);
      console.log('[Socket] Emitting join message...');
      socket.emit(SOCKET_EVENTS.CLIENT_MESSAGE, {
        username,
        room: DEFAULT_ROOM,
        content: SYSTEM_MESSAGES.USER_JOINED,
      });
      console.log('[Socket] Join message emitted');
    });

    socket.on(SOCKET_EVENTS.DISCONNECT, (reason) => {
      console.log('[Socket] ===== DISCONNECTED =====');
      console.log('[Socket] Reason:', reason);
      console.log('[Socket] Socket ID:', socket.id);
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
    console.log('[Socket] Socket state - connected:', socket.connected, 'id:', socket.id);
  };

  const doSend = async () => {
    console.log('[doSend] ===== SENDING MESSAGE =====');
    console.log('[doSend] Socket exists:', !!socket);
    console.log('[doSend] Socket connected:', socket?.connected);
    console.log('[doSend] Socket ID:', socket?.id);
    console.log('[doSend] Username:', username);
    console.log('[doSend] Current room:', currentRoom);
    console.log('[doSend] Message content:', userDraftMessage);
    
    // Try to get socket from window if not available
    const activeSocket = socket || (window as any).__socket;
    console.log('[doSend] Active socket from window:', !!(window as any).__socket);
    
    if (!activeSocket) {
      console.error('[doSend] ✗ Socket is not initialized!');
      alert('Socket not connected. Please refresh the page.');
      return;
    }
    
    if (!activeSocket.connected) {
      console.error('[doSend] ✗ Socket is not connected! Connected:', activeSocket.connected);
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
    const userPubKeys = loadUserPublicKeys();
    const keys = loadKeys();
    let encryptedFor: Record<string, string> | undefined;
    
    if (!userPubKeys || Object.keys(userPubKeys).length === 0) {
      console.error('[doSend] ✗ No user public keys available, cannot send encrypted message');
      alert('No user public keys available. Please refresh the page.');
      return;
    }
    
    if (!keys || !keys.publicKey) {
      console.error('[doSend] ✗ No sender public key available');
      alert('No sender public key available. Please log in again.');
      return;
    }
    
    console.log('[doSend] Encrypting message for', Object.keys(userPubKeys).length, 'users (including self)');
    try {
      encryptedFor = await encryptForAllUsers(userDraftMessage, userPubKeys, keys.publicKey, username);
      console.log('[doSend] ✓ Message encrypted for all users');
    } catch (error) {
      console.error('[doSend] ✗ Failed to encrypt message:', error);
      alert('Failed to encrypt message. Please try again.');
      return;
    }
    
    // Only send encryptedFor - no plaintext for user messages
    // System messages (like join/leave) can still use content field
    const isSystemMessage = userDraftMessage.includes(SYSTEM_MESSAGES.USER_JOINED) || 
                           userDraftMessage.includes(SYSTEM_MESSAGES.USER_LEFT);
    
    const messageData = {
      username,
      room: currentRoom,
      ...(isSystemMessage ? { content: userDraftMessage } : {}), // Only system messages have plaintext
      encryptedFor, // Encrypted versions for all users
    };
    
    console.log('[doSend] Emitting CLIENT_MESSAGE with data:', { ...messageData, encryptedFor: encryptedFor ? `${Object.keys(encryptedFor).length} encrypted versions` : 'none' });
    console.log('[doSend] Event name:', SOCKET_EVENTS.CLIENT_MESSAGE);
    activeSocket.emit(SOCKET_EVENTS.CLIENT_MESSAGE, messageData);
    console.log('[doSend] ✓ Message emitted');
    setUserDraftMessage('');
  };

  const userDraftMessageOnChangeHandler = (
    e: ChangeEvent<HTMLInputElement>
  ) => {
    setUserDraftMessage(e.target.value);
  };

  const onDraftKeyDownHandler = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      doSend();
    }
  };

  const makeNewRoom = () => {
    socket.emit(SOCKET_EVENTS.CLIENT_NEW_ROOM, newRoomName);
  };

  const onNewRoomKeyDownHandler = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      makeNewRoom();
    }
  };

  const onRoomSelectionChange = (newRoom: string) => {
    setCurrentRoom(newRoom?.replace(/-\(\d+ NEW!\)/, ''));
  };

  // Request access to an encrypted message
  const handleRequestAccess = (messageUsername: string, room: string, messageTimestamp: number) => {
    if (!socket || !username) return;
    
    console.log('[RequestAccess] ===== REQUESTING ACCESS TO MESSAGE =====');
    console.log('[RequestAccess] Message username:', messageUsername);
    console.log('[RequestAccess] Room:', room);
    console.log('[RequestAccess] Message timestamp:', messageTimestamp);
    
    // Find the message to get its current state
    const roomMessages = chatValues[room];
    if (roomMessages) {
      const targetMessage = roomMessages.find(msg => msg.timestamp === messageTimestamp);
      if (targetMessage) {
        console.log('[RequestAccess] Target message found:');
        console.log('[RequestAccess]   - Current content:', targetMessage.content || '(no content)');
        console.log('[RequestAccess]   - Content length:', targetMessage.content?.length || 0);
        console.log('[RequestAccess]   - Has encryptedFor:', !!targetMessage.encryptedFor);
        console.log('[RequestAccess]   - encryptedFor keys:', targetMessage.encryptedFor ? Object.keys(targetMessage.encryptedFor) : []);
        console.log('[RequestAccess]   - Has versions:', !!targetMessage.versions);
        console.log('[RequestAccess]   - Versions count:', targetMessage.versions?.length || 0);
        if (targetMessage.encryptedFor && targetMessage.encryptedFor[username]) {
          console.log('[RequestAccess]   - Has encrypted version for requesting user:', !!targetMessage.encryptedFor[username]);
          console.log('[RequestAccess]   - Encrypted data length:', targetMessage.encryptedFor[username]?.length || 0);
        }
        if (targetMessage.versions && targetMessage.versions.length > 0) {
          const newestVersion = targetMessage.versions[0];
          console.log('[RequestAccess]   - Newest version encryptedFor keys:', newestVersion.encryptedFor ? Object.keys(newestVersion.encryptedFor) : []);
          if (newestVersion.encryptedFor && newestVersion.encryptedFor[username]) {
            console.log('[RequestAccess]   - Has encrypted version in newest version for requesting user:', !!newestVersion.encryptedFor[username]);
          }
        }
      } else {
        console.warn('[RequestAccess] ⚠ Target message not found in room messages');
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
  };

  // Grant access to a message (re-encrypt for requesting user)
  // IMPORTANT: This function looks up the original message by timestamp in the original room
  // and uses the original author's locally stored plaintext (which they already have decrypted)
  // It does NOT use providedPlaintext from the access request message
  const handleGrantAccess = async (requestingUser: string, originalRoom: string, messageTimestamp: number, providedPlaintext?: string) => {
    console.log('[GrantAccess] ===== STARTING GRANT ACCESS =====');
    console.log('[GrantAccess] requestingUser:', requestingUser);
    console.log('[GrantAccess] originalRoom:', originalRoom);
    console.log('[GrantAccess] messageTimestamp:', messageTimestamp);
    console.log('[GrantAccess] username (original author):', username);
    console.log('[GrantAccess] NOTE: Looking up original message by timestamp in original room to get plaintext');
    
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
      console.log('[GrantAccess] activeSocket.connected:', activeSocket.connected);
      console.log('[GrantAccess] activeSocket.id:', activeSocket.id);
      console.log('[GrantAccess] activeSocket.emit type:', typeof activeSocket.emit);
      console.log('[GrantAccess] activeSocket.disconnected:', activeSocket.disconnected);
      // Check internal socket state
      const io = (activeSocket as any).io;
      if (io) {
        console.log('[GrantAccess] Socket.IO engine state:', io.engine?.readyState);
        console.log('[GrantAccess] Socket.IO transport:', io.engine?.transport?.name);
      }
    }
    
    if (!activeSocket) {
      console.error('[GrantAccess] ✗ No socket connection available');
      alert('Socket connection not available. Please refresh the page.');
      return;
    }
    
    if (typeof activeSocket.emit !== 'function') {
      console.error('[GrantAccess] ✗ activeSocket.emit is not a function!', activeSocket);
      alert('Socket emit function not available. Please refresh the page.');
      return;
    }
    
    // If socket is not connected, try to reconnect
    if (!activeSocket.connected || activeSocket.disconnected) {
      console.warn('[GrantAccess] Socket not connected, attempting to reconnect...');
      if (activeSocket.disconnected) {
        activeSocket.connect();
      }
      // Wait a bit for connection
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (!activeSocket.connected || activeSocket.disconnected) {
        console.error('[GrantAccess] ✗ Socket still not connected after reconnect attempt');
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
    console.log('[GrantAccess] Looking for message with timestamp:', messageTimestamp);
    console.log('[GrantAccess] Looking for message from user:', username);
    
    const roomMessages = chatValues[originalRoom];
    if (!roomMessages) {
      console.error('[GrantAccess] ✗ Original room not found:', originalRoom);
      console.error('[GrantAccess] Available rooms:', Object.keys(chatValues));
      return;
    }
    
    const originalMessage = roomMessages.find(msg => 
      msg.timestamp === messageTimestamp && msg.username === username
    );
    
    if (!originalMessage) {
      console.error('[GrantAccess] ✗ Original message not found');
      console.error('[GrantAccess] Messages in room:', roomMessages.map(m => ({ timestamp: m.timestamp, username: m.username })));
      return;
    }
    
    console.log('[GrantAccess] ✓ Original message found');
    console.log('[GrantAccess] Message content preview:', originalMessage.content ? originalMessage.content.substring(0, 100) : '(no content)');
    console.log('[GrantAccess] Message has encryptedFor:', !!originalMessage.encryptedFor);
    console.log('[GrantAccess] Message has versions:', !!originalMessage.versions);
    
    let plaintext: string;
    
    // Try to get plaintext from already decrypted message (preferred - original author should have this)
    if (originalMessage.content && originalMessage.content.trim() && !originalMessage.content.includes('🔒') && !originalMessage.content.includes('[Encrypted message]')) {
      console.log('[GrantAccess] ===== USING ALREADY DECRYPTED CONTENT FROM ORIGINAL MESSAGE =====');
      console.log('[GrantAccess] Content length:', originalMessage.content.length);
      console.log('[GrantAccess] Content (first 200 chars):', originalMessage.content.substring(0, 200));
      console.log('[GrantAccess] Content (full):', originalMessage.content);
      plaintext = originalMessage.content;
    } else if (originalMessage.encryptedFor && originalMessage.encryptedFor[username]) {
        // Decrypt the sender's own encrypted version
        console.log('[GrantAccess] ===== DECRYPTING FROM encryptedFor =====');
        console.log('[GrantAccess] Encrypted data length:', originalMessage.encryptedFor[username]?.length || 0);
        console.log('[GrantAccess] Encrypted data (first 200 chars):', originalMessage.encryptedFor[username]?.substring(0, 200) || 'N/A');
        try {
          plaintext = await decryptMessageForUser(originalMessage.encryptedFor[username], keys.privateKey);
          console.log('[GrantAccess] ✓ Decrypted plaintext, length:', plaintext.length);
          console.log('[GrantAccess] Decrypted content (first 200 chars):', plaintext.substring(0, 200));
          console.log('[GrantAccess] Decrypted content (full):', plaintext);
        } catch (error) {
          console.error('[GrantAccess] ✗ Failed to decrypt from encryptedFor:', error);
          // Try versions array as fallback
          if (originalMessage.versions && originalMessage.versions.length > 0) {
            const newestVersion = originalMessage.versions[0];
            if (newestVersion.encryptedFor && newestVersion.encryptedFor[username]) {
              console.log('[GrantAccess] ===== DECRYPTING FROM NEWEST VERSION =====');
              console.log('[GrantAccess] Encrypted data length:', newestVersion.encryptedFor[username]?.length || 0);
              console.log('[GrantAccess] Encrypted data (first 200 chars):', newestVersion.encryptedFor[username]?.substring(0, 200) || 'N/A');
              try {
                plaintext = await decryptMessageForUser(newestVersion.encryptedFor[username], keys.privateKey);
                console.log('[GrantAccess] ✓ Decrypted plaintext from version, length:', plaintext.length);
                console.log('[GrantAccess] Decrypted content (first 200 chars):', plaintext.substring(0, 200));
                console.log('[GrantAccess] Decrypted content (full):', plaintext);
              } catch (versionError) {
                console.error('[GrantAccess] ✗ Failed to decrypt from version:', versionError);
                return;
              }
            } else {
              console.error('[GrantAccess] ✗ No encrypted version found for sender in versions array');
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
          console.log('[GrantAccess] ===== DECRYPTING FROM NEWEST VERSION (fallback) =====');
          console.log('[GrantAccess] Encrypted data length:', newestVersion.encryptedFor[username]?.length || 0);
          console.log('[GrantAccess] Encrypted data (first 200 chars):', newestVersion.encryptedFor[username]?.substring(0, 200) || 'N/A');
          try {
            plaintext = await decryptMessageForUser(newestVersion.encryptedFor[username], keys.privateKey);
            console.log('[GrantAccess] ✓ Decrypted plaintext from version, length:', plaintext.length);
            console.log('[GrantAccess] Decrypted content (first 200 chars):', plaintext.substring(0, 200));
            console.log('[GrantAccess] Decrypted content (full):', plaintext);
          } catch (error) {
            console.error('[GrantAccess] ✗ Failed to decrypt from version:', error);
            return;
          }
        } else {
          console.error('[GrantAccess] ✗ No encrypted version found for sender in versions array');
          return;
        }
      } else {
        console.error('[GrantAccess] ✗ Cannot find plaintext or encrypted version for sender');
        console.error('[GrantAccess] Message has encryptedFor:', !!originalMessage.encryptedFor);
        console.error('[GrantAccess] Message has versions:', !!originalMessage.versions);
        if (originalMessage.encryptedFor) {
          console.error('[GrantAccess] encryptedFor keys:', Object.keys(originalMessage.encryptedFor));
        }
        return;
      }
    
    try {
      // Re-encrypt for ALL users (including sender and requesting user)
      let userPubKeys = loadUserPublicKeys();
      if (!userPubKeys) {
        console.error('[GrantAccess] ✗ User public keys not found');
        return;
      }
      
      // CRITICAL: Ensure the sender's own public key is included
      // This ensures the sender can always decrypt their own messages
      if (!userPubKeys[username]) {
        console.log('[GrantAccess] Adding sender\'s own public key to userPubKeys');
        userPubKeys = { ...userPubKeys, [username]: keys.publicKey };
      }
      
      // CRITICAL: Ensure the requesting user's public key is included
      // The server should have sent it in the access request, but check anyway
      if (!userPubKeys[requestingUser]) {
        console.error('[GrantAccess] ✗ Requesting user', requestingUser, 'public key not found in local storage!');
        console.error('[GrantAccess] ✗ Available users:', Object.keys(userPubKeys));
        console.error('[GrantAccess] ✗ This means the requesting user cannot decrypt the message!');
        console.error('[GrantAccess] ✗ The server should have sent the requesting user\'s public key in the access request');
        alert(`Cannot grant access: Public key for ${requestingUser} not found. Please refresh the page and try again.`);
        return;
      } else {
        console.log('[GrantAccess] ✓ Requesting user', requestingUser, 'public key found in local storage');
      }
      
      console.log('[GrantAccess] ===== RE-ENCRYPTING MESSAGE =====');
      console.log('[GrantAccess] Plaintext to encrypt - length:', plaintext.length);
      console.log('[GrantAccess] Plaintext to encrypt (first 200 chars):', plaintext.substring(0, 200));
      console.log('[GrantAccess] Plaintext to encrypt (full):', plaintext);
      console.log('[GrantAccess] Re-encrypting for', Object.keys(userPubKeys).length, 'users:', Object.keys(userPubKeys));
      console.log('[GrantAccess] Sender included:', username in userPubKeys);
      console.log('[GrantAccess] Requesting user included:', requestingUser in userPubKeys);
      
      // Encrypt for all users including the sender
      // encryptForAllUsers will use senderPublicKey and senderUsername parameters to ensure sender is included
      const encryptedFor = await encryptForAllUsers(plaintext, userPubKeys, keys.publicKey, username);
      
      console.log('[GrantAccess] ===== RE-ENCRYPTION COMPLETE =====');
      console.log('[GrantAccess] Encrypted for', Object.keys(encryptedFor).length, 'users');
      console.log('[GrantAccess] Encrypted users:', Object.keys(encryptedFor));
      // Log encrypted data for sender and requesting user
      if (encryptedFor[username]) {
        console.log('[GrantAccess] Sender encrypted data length:', encryptedFor[username].length);
        console.log('[GrantAccess] Sender encrypted data (first 200 chars):', encryptedFor[username].substring(0, 200));
      }
      if (encryptedFor[requestingUser]) {
        console.log('[GrantAccess] Requesting user encrypted data length:', encryptedFor[requestingUser].length);
        console.log('[GrantAccess] Requesting user encrypted data (first 200 chars):', encryptedFor[requestingUser].substring(0, 200));
      }
      
      // Verify the requesting user is in the encrypted map
      if (!encryptedFor[requestingUser]) {
        console.error('[GrantAccess] ✗ CRITICAL: Requesting user', requestingUser, 'not in encryptedFor map!');
        console.error('[GrantAccess] ✗ Encrypted for users:', Object.keys(encryptedFor));
        console.error('[GrantAccess] ✗ This means the requesting user cannot decrypt the message!');
        
        // If the requesting user's public key wasn't available, we can't encrypt for them
        // The server should handle this case by using its own copy of the public key
        // But we should still send what we have
      } else {
        console.log('[GrantAccess] ✓ Requesting user', requestingUser, 'is in encryptedFor map');
      }
      
      console.log('[GrantAccess] ✓ Encrypted for', Object.keys(encryptedFor).length, 'users');
      console.log('[GrantAccess] Encrypted for users:', Object.keys(encryptedFor));
      console.log('[GrantAccess] Socket state - connected:', activeSocket.connected, 'id:', activeSocket.id);
      
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
          
          console.log('[GrantAccess] About to emit CLIENT_GRANT_ACCESS to server...');
          console.log('[GrantAccess] Calling activeSocket.emit with event:', SOCKET_EVENTS.CLIENT_GRANT_ACCESS);
          console.log('[GrantAccess] Emit data size:', JSON.stringify(emitData).length, 'bytes');
          console.log('[GrantAccess] Socket ID:', activeSocket.id);
          console.log('[GrantAccess] Socket connected:', activeSocket.connected);
          
          // Verify socket is actually ready to send
          const io = (activeSocket as any).io;
          if (io && io.engine) {
            const readyState = io.engine.readyState;
            console.log('[GrantAccess] Socket.IO engine readyState:', readyState);
            // readyState: 'opening' = 0, 'open' = 1, 'closing' = 2, 'closed' = 3
            if (readyState !== 'open' && readyState !== 1) {
              console.error('[GrantAccess] ✗ Socket.IO engine not ready! readyState:', readyState);
              alert('Socket is not ready to send data. Please wait a moment and try again.');
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
            console.log('[GrantAccess] Socket state after emit - connected:', activeSocket.connected, 'id:', activeSocket.id);
            if (!activeSocket.connected) {
              console.error('[GrantAccess] ⚠ Socket disconnected after emit!');
            }
          }, 100);
          
          console.log('[GrantAccess] ✓ CLIENT_GRANT_ACCESS emit called successfully');
          console.log('[GrantAccess] ✓ Access granted to', requestingUser, '- re-encrypted for', Object.keys(encryptedFor).length, 'users');
          console.log('[GrantAccess] ===== GRANT ACCESS COMPLETE =====');
        } catch (error) {
          console.error('[GrantAccess] ✗ Error emitting CLIENT_GRANT_ACCESS:', error);
          console.error('[GrantAccess] Error stack:', (error as Error)?.stack);
          console.error('[GrantAccess] Error name:', (error as Error)?.name);
          alert('Failed to send access grant. Please try again.');
        }
      };
      
      // Wait for socket to be fully connected if it's not already
      if (!activeSocket.connected) {
        console.warn('[GrantAccess] Socket not connected, waiting for connection...');
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
  };

  // Leave a room
  const handleLeaveRoom = (room: string) => {
    if (!socket || !username) return;
    
    setLeftRooms(prev => {
      const newSet = new Set(prev);
      newSet.add(room);
      return newSet;
    });
    
    // If leaving current room, switch to another
    if (currentRoom === room) {
      const availableRooms = roomList.filter(r => !leftRooms.has(r) && r !== room);
      if (availableRooms.length > 0) {
        setCurrentRoom(availableRooms[0]);
      }
    }
    
    socket.emit(SOCKET_EVENTS.CLIENT_LEAVE_ROOM, { username, room });
    console.log('[LeaveRoom] Left room:', room);
  };

  // Rejoin a room
  const handleRejoinRoom = (room: string) => {
    if (!socket || !username) return;
    
    setLeftRooms(prev => {
      const newSet = new Set(prev);
      newSet.delete(room);
      return newSet;
    });
    
    socket.emit(SOCKET_EVENTS.CLIENT_REJOIN_ROOM, { username, room });
    setCurrentRoom(room);
    console.log('[RejoinRoom] Rejoined room:', room);
  };

  // Select a specific version of a message
  const handleSelectVersion = async (room: string, messageTimestamp: number, versionIndex: number) => {
    if (!socket || !username) return;
    
    // Find the message in local state
    const roomMessages = chatValues[room];
    if (!roomMessages) return;
    
    const message = roomMessages.find(msg => msg.timestamp === messageTimestamp);
    if (!message || !message.versions || versionIndex >= message.versions.length) return;
    
    const selectedVersion = message.versions[versionIndex];
    
    // Update local state to show the selected version
    setChatValues(prev => {
      const updated = { ...prev };
      if (updated[room]) {
        updated[room] = updated[room].map(msg => {
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
          const decrypted = await decryptMessageForUser(selectedVersion.encryptedFor[username], keys.privateKey);
          setChatValues(prev => {
            const updated = { ...prev };
            if (updated[room]) {
              updated[room] = updated[room].map(msg => {
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
    
    console.log('[SelectVersion] Selected version', versionIndex, 'for message', messageTimestamp);
  };

  const newRoomNameOnChangeHandler = (e: ChangeEvent<HTMLInputElement>) => {
    setNewRoomName(e.target.value);
  };

  // Redirect to login if not authenticated
  if (!authToken) {
    return null; // Will redirect via useEffect
  }

  return (
    <>
      {authToken && (
        <FlexDiv>
          <SideFlexColumn>
            <SelectableList
              id="roomSelection"
              label={'Rooms'}
              value={currentRoom}
              options={roomList
                .filter(room => !leftRooms.has(room)) // Filter out left rooms
                .map(
                  (room) =>
                    `${room}${
                      roomNotifications[room] ? '-' + roomNotifications[room] : ''
                    }`
                )}
              onSelect={onRoomSelectionChange}
            />
            <hr />
            <label htmlFor="newRoomNameInput">New Room Name:</label>
            <BlockInput
              type="text"
              id="newRoomNameInput"
              value={newRoomName}
              onChange={newRoomNameOnChangeHandler}
              onKeyDown={onNewRoomKeyDownHandler}
            />
            <WiderButton
              type="button"
              id="createNewRoomButton"
              onClick={makeNewRoom}
            >
              Make New Room
            </WiderButton>
          </SideFlexColumn>
          <MiddleFlexColumn>
            {transformMessages(chatValues, currentRoom, username, handleRequestAccess, handleGrantAccess, handleSelectVersion, chatValues)}
            <FlexRow>
              <WiderInput
                id="userDraftMessageInput"
                placeholder="Type something"
                value={userDraftMessage}
                onChange={userDraftMessageOnChangeHandler}
                onKeyDown={onDraftKeyDownHandler}
              />
              <WiderButton type="button" onClick={doSend}>
                Send
              </WiderButton>
            </FlexRow>
          </MiddleFlexColumn>
          <SideFlexColumn>
            <div style={{ marginBottom: '5px' }}>Users:</div>
            <ScrollableDiv $padding="0px">
              {/* Show logged in first, then active but not logged in */}
              {loggedInUsers.length > 0 && (
                <>
                  <div style={{ fontSize: '11px', color: '#666', marginTop: '4px', marginBottom: '2px', fontWeight: 'bold' }}>
                    Logged In ({loggedInUsers.length}):
                  </div>
                  {loggedInUsers
                    .filter((user) => user !== 'undefined')
                    .sort((a, b) => {
                      const aSeen = userLastSeen[a] || 0;
                      const bSeen = userLastSeen[b] || 0;
                      return bSeen - aSeen;
                    })
                    .map((user) => {
                      const lastSeen = userLastSeen[user] || 0;
                      const isOnline = lastSeen > 0 && (Date.now() - lastSeen) < 300000;
                      return (
                        <div
                          key={user}
                          style={{
                            border: '1px solid #556',
                            backgroundColor: user === username ? '#aab' : '#fffff00',
                            color: isOnline ? '#333344' : '#999',
                            fontWeight: user === username ? 700 : 300,
                            margin: '0px',
                            padding: '2px 5px',
                            cursor: 'pointer',
                            fontSize: '12px',
                          }}
                        >
                          {user} {isOnline ? '🟢' : '⚫'}
                        </div>
                      );
                    })}
                </>
              )}
              {activeUsers.length > 0 && (
                <>
                  <div style={{ fontSize: '11px', color: '#666', marginTop: loggedInUsers.length > 0 ? '8px' : '4px', marginBottom: '2px', fontWeight: 'bold' }}>
                    Active (Not Logged In) ({activeUsers.length}):
                  </div>
                  {activeUsers
                    .filter((user) => user !== 'undefined')
                    .sort((a, b) => {
                      const aSeen = userLastSeen[a] || 0;
                      const bSeen = userLastSeen[b] || 0;
                      return bSeen - aSeen;
                    })
                    .map((user) => {
                      const lastSeen = userLastSeen[user] || 0;
                      const isOnline = lastSeen > 0 && (Date.now() - lastSeen) < 300000;
                      return (
                        <div
                          key={user}
                          style={{
                            border: '1px solid #556',
                            backgroundColor: user === username ? '#aab' : '#fffff00',
                            color: '#999', // Always grey for not logged in
                            fontWeight: user === username ? 700 : 300,
                            margin: '0px',
                            padding: '2px 5px',
                            cursor: 'pointer',
                            fontSize: '12px',
                          }}
                        >
                          {user} ⚫
                        </div>
                      );
                    })}
                </>
              )}
              {loggedInUsers.length === 0 && activeUsers.length === 0 && (
                <div style={{ fontSize: '12px', color: '#999', padding: '4px' }}>
                  No users
                </div>
              )}
            </ScrollableDiv>
            {activeJoinRequests
              .filter(req => req.room === currentRoom)
              .map((req) => (
                <div key={`${req.room}:${req.requestingUser}`} style={{ 
                  border: '1px solid #556', 
                  padding: '5px', 
                  margin: '5px 0',
                  backgroundColor: '#fff9e6',
                }}>
                  <div style={{ fontSize: '12px', marginBottom: '5px' }}>
                    {req.requestingUser} would like to join
                  </div>
                  <div style={{ display: 'flex', gap: '5px' }}>
                    <WiderButton
                      type="button"
                      onClick={() => {
                        if (socket) {
                          socket.emit(SOCKET_EVENTS.CLIENT_VOTE_JOIN, {
                            room: req.room,
                            requestingUser: req.requestingUser,
                            vote: true,
                            voter: username,
                          });
                        }
                      }}
                      style={{ 
                        backgroundColor: '#4caf50', 
                        color: 'white',
                        flex: 1,
                        padding: '3px',
                        fontSize: '12px',
                      }}
                    >
                      Accept
                    </WiderButton>
                    <WiderButton
                      type="button"
                      onClick={() => {
                        if (socket) {
                          socket.emit(SOCKET_EVENTS.CLIENT_VOTE_JOIN, {
                            room: req.room,
                            requestingUser: req.requestingUser,
                            vote: false,
                            voter: username,
                          });
                        }
                      }}
                      style={{ 
                        backgroundColor: '#f44336', 
                        color: 'white',
                        flex: 1,
                        padding: '3px',
                        fontSize: '12px',
                      }}
                    >
                      Deny
                    </WiderButton>
                  </div>
                </div>
              ))}
            <hr />
              <WiderButton
              type="button"
              onClick={async () => {
                // Emit disconnecting event to server
                const activeSocket = (window as any).__socket || socket;
                if (activeSocket && authToken) {
                  try {
                    activeSocket.emit(SOCKET_EVENTS.CLIENT_DISCONNECTING, authToken);
                  } catch (error) {
                    console.error('[Logout] Error emitting disconnect:', error);
                  }
                }
                
                // Disconnect socket
                if (activeSocket) {
                  activeSocket.disconnect();
                }
                if (socket) {
                  socket.disconnect();
                }
                
                // Clear socket references
                socket = undefined as any;
                (window as any).__socket = undefined;
                
                // Clear session (but keep keys so user can log back in)
                const { clearSession } = await import('../utils/gpg');
                clearSession();
                
                // Clear state
                setAuthToken('');
                setUsername('');
                
                // Redirect to login page
                window.location.href = '/login';
              }}
              style={{ backgroundColor: '#e24a4a', color: 'white', marginTop: '10px' }}
            >
              Logout
            </WiderButton>
          </SideFlexColumn>
        </FlexDiv>
      )}
    </>
  );
};

export default Home;

