import { useEffect, useMemo, useRef, useState } from 'react';
import { type Socket } from 'socket.io-client';
import { ScrollableDiv } from '../styled/ScrollableDiv';
import { SOCKET_EVENTS, FEATURES } from '../../constants';
import { type Messages, type Message } from '../../types/types';
import { canUserViewMessage } from '../../utils/messages';
import { mdStringToReact } from '../../utils/markdown';

const MessageWithReplies = ({
  message,
  allMessages,
  childrenByParent,
  room,
  username,
  onRequestAccess,
  onGrantAccess,
  onDenyAccess,
  onSelectVersion,
  onReply,
  onEdit,
  onVote,
  getUnreadDirectRepliesCount,
  markDirectRepliesRead,
  replyingTo,
  editingMessageTimestamp,
  indentLevel = 0,
}: {
  message: Message;
  allMessages: Message[];
  childrenByParent: Map<number, Message[]>;
  room: string;
  username?: string;
  onRequestAccess?: (
    messageUsername: string,
    room: string,
    messageTimestamp: number,
  ) => void;
  onGrantAccess?: (
    requestingUser: string,
    originalRoom: string,
    messageTimestamp: number,
    plaintext?: string,
  ) => void;
  onDenyAccess?: (
    requestingUser: string,
    originalRoom: string,
    messageTimestamp: number,
  ) => void;
  onSelectVersion?: (
    room: string,
    messageTimestamp: number,
    versionIndex: number,
  ) => void;
  onReply?: (messageTimestamp: number) => void;
  onEdit?: (messageTimestamp: number, content: string) => void;
  onVote?: (
    room: string,
    messageTimestamp: number,
    voteType: 'up' | 'down',
  ) => void;
  getUnreadDirectRepliesCount?: (messageTimestamp: number) => number;
  markDirectRepliesRead?: (messageTimestamp: number) => void;
  replyingTo?: number;
  editingMessageTimestamp?: number;
  indentLevel?: number;
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const replies = childrenByParent.get(message.timestamp) ?? [];
  const hasReplies = replies.length > 0;

  const sortedReplies = [...replies]
    .filter((r) => canUserViewMessage(r, username))
    .sort((a, b) => a.timestamp - b.timestamp);
  const unreadDirectRepliesCount = getUnreadDirectRepliesCount
    ? getUnreadDirectRepliesCount(message.timestamp)
    : 0;

  useEffect(() => {
    if (isExpanded && hasReplies && markDirectRepliesRead) {
      markDirectRepliesRead(message.timestamp);
    }
  }, [hasReplies, isExpanded, markDirectRepliesRead, message.timestamp]);

  let hasAccess = false;
  let encryptedData: string | null = null;

  if (username && message.encryptedFor) {
    hasAccess = !!message.encryptedFor[username];
    if (hasAccess) {
      encryptedData = message.encryptedFor[username];
    }
  }

  if (
    !hasAccess &&
    username &&
    message.versions &&
    message.versions.length > 0
  ) {
    const newestVersion = message.versions[0];
    if (newestVersion.encryptedFor) {
      hasAccess = !!newestVersion.encryptedFor[username];
      if (hasAccess) {
        encryptedData = newestVersion.encryptedFor[username];
      }
    }
  }

  const canDecrypt =
    hasAccess &&
    message.content &&
    message.content.trim() !== '' &&
    !message.content.includes('🔒') &&
    !message.content.includes('[Encrypted message]');

  const renderMessageContent = () => {
    const isAccessRequest =
      message.content &&
      (message.content.includes('requests access') ||
        message.content.includes('Requests access'));
    const isAccessStatus =
      message.content &&
      (message.content.includes('You requested access') ||
        message.content.includes('you requested access'));

    if (isAccessStatus) {
      const statusMatch = message.content.match(
        /You requested access to (.+?)'s message in (.+?) \(timestamp: (\d+)\) \[(.+?)\]/i,
      );
      if (statusMatch) {
        const [, , , , status] = statusMatch;
        const statusColor =
          status === 'Access Granted'
            ? '#2e7d32'
            : status === 'Access Denied'
              ? '#c62828'
              : '#666';
        const statusBg =
          status === 'Access Granted'
            ? '#e8f5e9'
            : status === 'Access Denied'
              ? '#ffebee'
              : '#f5f5f5';

        return (
          <div
            style={{
              border: '1px solid #ccc',
              padding: '8px',
              margin: '4px 0',
            }}
          >
            {mdStringToReact(message.content)}
            <div
              style={{
                marginTop: '8px',
                padding: '4px 8px',
                backgroundColor: statusBg,
                color: statusColor,
                borderRadius: '4px',
                fontSize: '12px',
                fontWeight: 'bold',
              }}
            >
              Status: {status}
            </div>
          </div>
        );
      }
    }

    if (isAccessRequest && onGrantAccess && username) {
      const match = message.content.match(
        /(?:User\s+\w+\s+)?requests access to your message in (.+?) \(timestamp: (\d+)\)/i,
      );
      if (match) {
        const originalRoom = match[1];
        const messageTimestamp = parseInt(match[2], 10);
        const requestingUser = message.username;
        const isDenied = message.content.includes('[Access Denied]');
        const isGranted = message.content.includes('[Access Granted]');

        return (
          <div
            style={{
              border: '1px solid #ccc',
              padding: '8px',
              margin: '4px 0',
            }}
          >
            {mdStringToReact(
              message.content.replace(
                /\[Grant Access\]|\[Deny Access\]|\[Access Granted\]|\[Access Denied\]/g,
                '',
              ),
            )}
            {isGranted && (
              <div
                style={{
                  marginTop: '8px',
                  padding: '4px 8px',
                  backgroundColor: '#e8f5e9',
                  color: '#2e7d32',
                  borderRadius: '4px',
                  fontSize: '12px',
                }}
              >
                ✓ Access Granted
              </div>
            )}
            {!isDenied && !isGranted && (
              <div style={{ marginTop: '8px', display: 'flex', gap: '8px' }}>
                <button
                  onClick={async () => {
                    if (onGrantAccess) {
                      await onGrantAccess(
                        requestingUser,
                        originalRoom,
                        messageTimestamp,
                      );
                    }
                  }}
                  style={{
                    padding: '4px 8px',
                    fontSize: '12px',
                    cursor: 'pointer',
                    backgroundColor: '#4caf50',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                  }}
                >
                  Yes - Grant Access
                </button>
                <button
                  onClick={() => {
                    if (onDenyAccess) {
                      onDenyAccess(
                        requestingUser,
                        originalRoom,
                        messageTimestamp,
                      );
                    }
                  }}
                  style={{
                    padding: '4px 8px',
                    fontSize: '12px',
                    cursor: 'pointer',
                    backgroundColor: '#f44336',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
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

    if (!canDecrypt && (message.encryptedFor || message.versions)) {
      const localTime = new Date(message.timestamp * 1000).toLocaleString();
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span>🔒</span>
          <span>
            <span
              title={`Sent at ${localTime}`}
              style={{
                cursor: 'help',
                textDecoration: 'underline',
                textDecorationStyle: 'dotted',
              }}
            >
              {message.username}
            </span>
            : [Encrypted message]
          </span>
          {onRequestAccess && (
            <button
              onClick={() =>
                onRequestAccess(message.username, room, message.timestamp)
              }
              style={{
                marginLeft: '8px',
                padding: '4px 8px',
                fontSize: '12px',
                cursor: 'pointer',
              }}
            >
              Request Access
            </button>
          )}
        </div>
      );
    }

    const hasMultipleVersions = message.versions && message.versions.length > 1;
    const currentVersionIndex =
      message.currentVersion !== undefined ? message.currentVersion : 0;

    return (
      <div style={{ position: 'relative' }}>
        {hasMultipleVersions && onSelectVersion && message.versions && (
          <div style={{ marginBottom: '4px', fontSize: '12px' }}>
            <label>
              Version:
              <select
                value={currentVersionIndex}
                onChange={(e) =>
                  onSelectVersion(
                    room,
                    message.timestamp,
                    parseInt(e.target.value, 10),
                  )
                }
                style={{
                  marginLeft: '4px',
                  fontSize: '12px',
                  padding: '2px 4px',
                }}
              >
                {message.versions.map((version, idx) => (
                  <option key={idx} value={idx}>
                    {idx === 0 ? 'Latest' : `v${version.version}`} -{' '}
                    {version.changeSummary || 'no changes'} (
                    {new Date(version.timestamp * 1000).toLocaleString()})
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        {(() => {
          const localTime = new Date(message.timestamp * 1000).toLocaleString();
          return (
            <span>
              <span
                title={`Sent at ${localTime}`}
                style={{
                  cursor: 'help',
                  textDecoration: 'underline',
                  textDecorationStyle: 'dotted',
                }}
              >
                {message.username}
              </span>
              : {mdStringToReact(message.content || '[No content]')}
              {message.edited && (
                <span
                  style={{
                    color: '#999',
                    fontSize: '0.9em',
                    marginLeft: '4px',
                  }}
                >
                  (edited)
                </span>
              )}
            </span>
          );
        })()}
      </div>
    );
  };

  return (
    <div
      style={{
        position: 'relative',
        marginBottom: '8px',
        paddingLeft: indentLevel > 0 ? '24px' : '0',
      }}
    >
      {indentLevel > 0 && (
        <>
          <div
            style={{
              position: 'absolute',
              left: '12px',
              top: '-8px',
              height: '20px',
              width: '1px',
              backgroundColor: '#d0d0d0',
            }}
          />

          <div
            style={{
              position: 'absolute',
              left: '12px',
              top: '12px',
              width: '12px',
              height: '1px',
              backgroundColor: '#d0d0d0',
              borderTopRightRadius: '6px',
              borderBottomRightRadius: '6px',
            }}
          />
        </>
      )}

      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: '8px',
          position: 'relative',
          zIndex: 1,
        }}
      >
        {FEATURES.MESSAGE_VOTING && onVote && username && (
          <>
            {hasReplies && (
              <button
                onClick={() => {
                  const nextIsExpanded = !isExpanded;
                  setIsExpanded(nextIsExpanded);
                  if (nextIsExpanded && markDirectRepliesRead) {
                    markDirectRepliesRead(message.timestamp);
                  }
                }}
                style={{
                  padding: '2px 4px',
                  fontSize: '13px',
                  fontWeight: 700,
                  cursor: 'pointer',
                  backgroundColor: 'transparent',
                  border: 'none',
                  color: unreadDirectRepliesCount ? '#0b7a6f' : '#666',
                  minWidth: '20px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  alignSelf: 'center',
                }}
                title={isExpanded ? 'Collapse replies' : 'Expand replies'}
              >
                {isExpanded ? '−' : '+'}
              </button>
            )}
            {!hasReplies && <div style={{ width: '20px', flexShrink: 0 }} />}
          </>
        )}

        {!FEATURES.MESSAGE_VOTING && (
          <div
            style={{
              minWidth: '20px',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {hasReplies ? (
              <button
                onClick={() => {
                  const nextIsExpanded = !isExpanded;
                  setIsExpanded(nextIsExpanded);
                  if (nextIsExpanded && markDirectRepliesRead) {
                    markDirectRepliesRead(message.timestamp);
                  }
                }}
                style={{
                  padding: '2px 4px',
                  fontSize: '13px',
                  fontWeight: 700,
                  cursor: 'pointer',
                  backgroundColor: 'transparent',
                  border: 'none',
                  color: unreadDirectRepliesCount ? '#0b7a6f' : '#666',
                }}
                title={isExpanded ? 'Collapse replies' : 'Expand replies'}
              >
                {isExpanded ? '−' : '+'}
              </button>
            ) : (
              <div style={{ width: '20px' }} />
            )}
          </div>
        )}

        {FEATURES.MESSAGE_VOTING && onVote && username && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '2px',
              flexShrink: 0,
              marginRight: '4px',
              alignSelf: 'center',
            }}
          >
            <button
              onClick={() => onVote(room, message.timestamp, 'up')}
              style={{
                padding: '0',
                fontSize: '16px',
                cursor: 'pointer',
                backgroundColor: 'transparent',
                border: 'none',
                color:
                  message.userVotes?.[username] === 'up' ? '#4caf50' : '#999',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '20px',
                height: '20px',
                lineHeight: '1',
              }}
              title="Upvote"
            >
              ▲
            </button>
            <span
              style={{
                fontSize: '12px',
                fontWeight: 'bold',
                color: '#666',
                minWidth: '20px',
                textAlign: 'center',
              }}
            >
              {message.voteTotal ?? 0}
            </span>
            <button
              onClick={() => onVote(room, message.timestamp, 'down')}
              style={{
                padding: '0',
                fontSize: '16px',
                cursor: 'pointer',
                backgroundColor: 'transparent',
                border: 'none',
                color:
                  message.userVotes?.[username] === 'down' ? '#f44336' : '#999',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '20px',
                height: '20px',
                lineHeight: '1',
              }}
              title="Downvote"
            >
              ▼
            </button>
          </div>
        )}

        {(unreadDirectRepliesCount ?? 0) > 0 && (
          <span
            style={{
              fontSize: '11px',
              fontWeight: 700,
              color: '#0b7a6f',
              backgroundColor: '#dff7f4',
              border: '1px solid #95d9d1',
              borderRadius: '999px',
              padding: '1px 7px',
              alignSelf: 'center',
              whiteSpace: 'nowrap',
            }}
            title="Unread replies"
          >
            {unreadDirectRepliesCount} new
          </span>
        )}

        <div style={{ flex: 1, minWidth: 0 }}>{renderMessageContent()}</div>

        <div
          style={{
            display: 'flex',
            gap: '4px',
            marginLeft: 'auto',
            flexShrink: 0,
          }}
        >
          {onEdit &&
            username &&
            message.username === username &&
            message.username !== 'system' && (
              <button
                onClick={() => onEdit(message.timestamp, message.content)}
                style={{
                  padding: '2px 6px',
                  fontSize: '11px',
                  cursor: 'pointer',
                  backgroundColor:
                    editingMessageTimestamp === message.timestamp
                      ? '#2196f3'
                      : 'transparent',
                  border: '1px solid #ccc',
                  borderRadius: '4px',
                  color:
                    editingMessageTimestamp === message.timestamp
                      ? 'white'
                      : '#666',
                }}
                title="Edit this message"
              >
                Edit
              </button>
            )}
          {onReply && (
            <button
              onClick={() => onReply(message.timestamp)}
              style={{
                padding: '2px 6px',
                fontSize: '11px',
                cursor: 'pointer',
                backgroundColor:
                  replyingTo === message.timestamp ? '#0b7a6f' : '#dbe7f6',
                border: '1px solid #86a3c8',
                borderRadius: '4px',
                color: replyingTo === message.timestamp ? 'white' : '#18324d',
              }}
              title="Reply to this message"
            >
              Reply
            </button>
          )}
        </div>
      </div>

      {hasReplies && (
        <div
          style={{
            position: 'relative',
            marginTop: '8px',
            paddingLeft: '24px',
            display: 'grid',
            gridTemplateRows: isExpanded ? '1fr' : '0fr',
            transition: 'grid-template-rows 220ms ease',
          }}
        >
          <div
            style={{
              overflow: 'hidden',
              minHeight: 0,
              opacity: isExpanded ? 1 : 0,
              transition: 'opacity 180ms ease',
            }}
          >
            {sortedReplies.length > 0 && (
              <div
                style={{
                  position: 'absolute',
                  left: '12px',
                  top: '0',
                  bottom: '0',
                  width: '1px',
                  backgroundColor: '#d0d0d0',
                }}
              />
            )}

            {sortedReplies.map((reply) => (
              <div key={reply.timestamp} style={{ position: 'relative' }}>
                <div
                  style={{
                    position: 'absolute',
                    left: '-12px',
                    top: '12px',
                    width: '12px',
                    height: '1px',
                    backgroundColor: '#d0d0d0',
                    borderTopLeftRadius: '6px',
                    borderBottomLeftRadius: '6px',
                  }}
                />

                <MessageWithReplies
                  message={reply}
                  allMessages={allMessages}
                  childrenByParent={childrenByParent}
                  room={room}
                  username={username}
                  onRequestAccess={onRequestAccess}
                  onGrantAccess={onGrantAccess}
                  onDenyAccess={onDenyAccess}
                  onSelectVersion={onSelectVersion}
                  onReply={onReply}
                  onEdit={onEdit}
                  onVote={onVote}
                  getUnreadDirectRepliesCount={getUnreadDirectRepliesCount}
                  markDirectRepliesRead={markDirectRepliesRead}
                  replyingTo={replyingTo}
                  editingMessageTimestamp={editingMessageTimestamp}
                  indentLevel={indentLevel + 1}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

function MessageThreadCard({
  messages,
  allMessages,
  currentRoom,
  username,
  onRequestAccess,
  onGrantAccess,
  onSelectVersion,
  onReply,
  onEdit,
  onVote,
  replyingTo,
  editingMessageTimestamp,
  socket,
}: {
  messages: Message[];
  allMessages: Message[];
  currentRoom: string;
  username?: string;
  onRequestAccess?: (
    messageUsername: string,
    room: string,
    messageTimestamp: number,
  ) => void;
  onGrantAccess?: (
    requestingUser: string,
    originalRoom: string,
    messageTimestamp: number,
    plaintext?: string,
  ) => void;
  onSelectVersion?: (
    room: string,
    messageTimestamp: number,
    versionIndex: number,
  ) => void;
  onReply?: (messageTimestamp: number) => void;
  onEdit?: (messageTimestamp: number, content: string) => void;
  onVote?: (
    room: string,
    messageTimestamp: number,
    voteType: 'up' | 'down',
  ) => void;
  replyingTo?: number;
  editingMessageTimestamp?: number;
  socket?: Socket;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const didInitializeReadMarkersRef = useRef(false);
  const messageCount = messages.length;

  const childrenByParent = useMemo(() => {
    const map = new Map<number, Message[]>();
    allMessages.forEach((msg) => {
      if (msg.replyTo === undefined || msg.replyTo === null) return;
      const parentTimestamp =
        typeof msg.replyTo === 'number' ? msg.replyTo : Number(msg.replyTo);
      const existing = map.get(parentTimestamp) ?? [];
      existing.push(msg);
      map.set(parentTimestamp, existing);
    });

    map.forEach((replies, parentTs) => {
      map.set(
        parentTs,
        [...replies]
          .filter((r) => canUserViewMessage(r, username))
          .sort((a, b) => a.timestamp - b.timestamp),
      );
    });

    return map;
  }, [allMessages, username]);

  const [
    lastReadDirectReplyTimestampByMessage,
    setLastReadDirectReplyTimestampByMessage,
  ] = useState<Record<number, number>>({});

  useEffect(() => {
    didInitializeReadMarkersRef.current = false;
    setLastReadDirectReplyTimestampByMessage({});
  }, [currentRoom]);

  useEffect(() => {
    if (didInitializeReadMarkersRef.current) return;
    if (allMessages.length === 0) return;

    const baseline: Record<number, number> = {};
    allMessages.forEach((msg) => {
      const directReplies = childrenByParent.get(msg.timestamp) ?? [];
      baseline[msg.timestamp] =
        directReplies.length > 0
          ? directReplies[directReplies.length - 1].timestamp
          : msg.timestamp;
    });

    setLastReadDirectReplyTimestampByMessage(baseline);
    didInitializeReadMarkersRef.current = true;
  }, [allMessages, childrenByParent]);

  const unreadDirectRepliesCountByMessage = useMemo(() => {
    const unreadCounts: Record<number, number> = {};

    allMessages.forEach((msg) => {
      const directReplies = childrenByParent.get(msg.timestamp) ?? [];
      const lastReadTimestamp =
        lastReadDirectReplyTimestampByMessage[msg.timestamp] ?? msg.timestamp;
      unreadCounts[msg.timestamp] = directReplies.filter(
        (reply) => reply.timestamp > lastReadTimestamp,
      ).length;
    });

    return unreadCounts;
  }, [allMessages, childrenByParent, lastReadDirectReplyTimestampByMessage]);

  const markDirectRepliesRead = (messageTimestamp: number) => {
    const directReplies = childrenByParent.get(messageTimestamp) ?? [];
    const latestReplyTimestamp =
      directReplies.length > 0
        ? directReplies[directReplies.length - 1].timestamp
        : messageTimestamp;

    setLastReadDirectReplyTimestampByMessage((prev) => {
      if (prev[messageTimestamp] === latestReplyTimestamp) {
        return prev;
      }

      return {
        ...prev,
        [messageTimestamp]: latestReplyTimestamp,
      };
    });
  };

  const getUnreadDirectRepliesCount = (messageTimestamp: number) =>
    unreadDirectRepliesCountByMessage[messageTimestamp] ?? 0;

  const scrollToBottom = () => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  };

  useEffect(() => {
    shouldStickToBottomRef.current = true;
    const raf = window.requestAnimationFrame(scrollToBottom);
    return () => window.cancelAnimationFrame(raf);
  }, [currentRoom]);

  useEffect(() => {
    if (!shouldStickToBottomRef.current) return;
    const raf = window.requestAnimationFrame(scrollToBottom);
    return () => window.cancelAnimationFrame(raf);
  }, [messageCount, currentRoom]);

  const handleScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    const threshold = 24;
    shouldStickToBottomRef.current =
      node.scrollHeight - node.scrollTop - node.clientHeight <= threshold;
  };

  return (
    <ScrollableDiv
      ref={scrollRef}
      className="app-message-thread-card"
      $padding="12px"
      $border="none"
      onScroll={handleScroll}
    >
      {messages.map((message) => (
        <MessageWithReplies
          key={message.timestamp}
          message={message}
          allMessages={allMessages}
          childrenByParent={childrenByParent}
          room={currentRoom}
          username={username}
          onRequestAccess={onRequestAccess}
          onGrantAccess={onGrantAccess}
          onDenyAccess={(
            requestingUser: string,
            originalRoom: string,
            messageTimestamp: number,
          ) => {
            if (socket) {
              socket.emit(SOCKET_EVENTS.CLIENT_DENY_ACCESS, {
                requestingUser,
                originalRoom,
                messageTimestamp,
              });
            }
          }}
          onSelectVersion={onSelectVersion}
          onReply={onReply}
          onEdit={onEdit}
          onVote={onVote}
          getUnreadDirectRepliesCount={getUnreadDirectRepliesCount}
          markDirectRepliesRead={markDirectRepliesRead}
          replyingTo={replyingTo}
          editingMessageTimestamp={editingMessageTimestamp}
          indentLevel={0}
        />
      ))}
    </ScrollableDiv>
  );
}

export const renderMessageThread = (
  messages: Messages,
  currentRoom: string,
  username?: string,
  blockedUsers: string[] = [],
  onRequestAccess?: (
    messageUsername: string,
    room: string,
    messageTimestamp: number,
  ) => void,
  onGrantAccess?: (
    requestingUser: string,
    originalRoom: string,
    messageTimestamp: number,
    plaintext?: string,
  ) => void,
  onSelectVersion?: (
    room: string,
    messageTimestamp: number,
    versionIndex: number,
  ) => void,
  allMessages?: Messages,
  onReply?: (messageTimestamp: number) => void,
  onEdit?: (messageTimestamp: number, content: string) => void,
  onVote?: (
    room: string,
    messageTimestamp: number,
    voteType: 'up' | 'down',
  ) => void,
  replyingTo?: number,
  editingMessageTimestamp?: number,
  socket?: Socket,
) => {
  if (currentRoom && Object.keys(messages).length && messages[currentRoom]) {
    const allRoomMessages = messages[currentRoom];
    const visibleRoomMessages = allRoomMessages.filter((msg) =>
      canUserViewMessage(msg, username),
    );
    const topLevelMessages = allRoomMessages.filter(
      (msg) => !msg.replyTo && msg.replyTo !== 0,
    );
    const visibleMessages = topLevelMessages.filter((msg) =>
      canUserViewMessage(msg, username),
    );
    const sortedMessages = [...visibleMessages].sort(
      (a, b) => a.timestamp - b.timestamp,
    );

    return (
      <MessageThreadCard
        messages={sortedMessages}
        allMessages={visibleRoomMessages}
        currentRoom={currentRoom}
        username={username}
        onRequestAccess={onRequestAccess}
        onGrantAccess={onGrantAccess}
        onSelectVersion={onSelectVersion}
        onReply={onReply}
        onEdit={onEdit}
        onVote={onVote}
        replyingTo={replyingTo}
        editingMessageTimestamp={editingMessageTimestamp}
        socket={socket}
      />
    );
  }

  return null;
};
