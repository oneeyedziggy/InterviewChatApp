import { createPortal } from 'react-dom';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type Socket } from 'socket.io-client';
import { styled } from 'styled-components';
import { ConfirmPopover } from '../ConfirmPopover';
import { ScrollableDiv } from '../styled/ScrollableDiv';
import { ContextMenuItem, ContextMenuSurface } from '../styled/ContextMenu';
import { SOCKET_EVENTS, FEATURES } from '../../constants';
import { type Messages, type Message } from '../../types/types';
import { canUserViewMessage } from '../../utils/messages';
import {
  CONTEXT_MENU_CLOSE_EVENT,
  closeOtherContextMenus,
} from '../../utils/contextMenuEvents';
import { mdStringToReact } from '../../utils/markdown';

const IMPORTED_TRANSFER_MARKERS_KEY = 'imported_transfer_markers_v1';

function readImportedTransferMarkers(): Record<string, boolean> {
  if (typeof window === 'undefined') {
    return {};
  }

  const raw = localStorage.getItem(IMPORTED_TRANSFER_MARKERS_KEY);
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const markers: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value === true) {
        markers[key] = true;
      }
    }
    return markers;
  } catch {
    return {};
  }
}

function markTransferAsImported(marker: string): void {
  if (typeof window === 'undefined' || !marker) {
    return;
  }

  const existing = readImportedTransferMarkers();
  existing[marker] = true;
  localStorage.setItem(IMPORTED_TRANSFER_MARKERS_KEY, JSON.stringify(existing));
}

function transferImportMarker(message: Message): string {
  if (message.id && message.id.trim() !== '') {
    return `id:${message.id}`;
  }
  const fromUser = message.keyTransferFromUser || 'unknown';
  return `legacy:${message.timestamp}:${fromUser}`;
}

function transferImportMarkerFromParts(
  messageID: string | undefined,
  messageTimestamp: number,
  fromUser: string | undefined,
): string {
  if (messageID && messageID.trim() !== '') {
    return `id:${messageID}`;
  }
  return `legacy:${messageTimestamp}:${fromUser || 'unknown'}`;
}

function getDefaultImportedTransferNote(fromUser: string | undefined): string {
  if (fromUser) {
    return `Imported account from ${fromUser}. It is now available in your local login list.`;
  }
  return 'Imported account is available in your local login list.';
}

function messageKey(message: Message, index: number): string {
  if (message.id && message.id.trim() !== '') {
    return `id:${message.id}`;
  }
  return `ts:${message.timestamp}:u:${message.username}:i:${index}`;
}

function isSameMessageRun(
  previous: Message | undefined,
  current: Message,
): boolean {
  if (!previous) {
    return false;
  }
  const previousReplyTo = previous.replyTo ?? null;
  const currentReplyTo = current.replyTo ?? null;
  return (
    previous.username === current.username && previousReplyTo === currentReplyTo
  );
}

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
  onDelete,
  onVote,
  onMessageUser,
  onSendPublicKeyToUser,
  onImportTransferredAccount,
  onBlockUser,
  onUnblockUser,
  blockedUsers,
  getUnreadDirectRepliesCount,
  markDirectRepliesRead,
  replyingTo,
  editingMessageTimestamp,
  indentLevel = 0,
  collapseIntoPrevious = false,
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
  onEdit?: (
    messageTimestamp: number,
    content: string,
    messageId?: string,
  ) => void;
  onDelete?: (messageTimestamp: number, messageId?: string) => void;
  onVote?: (
    room: string,
    messageTimestamp: number,
    voteType: 'up' | 'down',
  ) => void;
  onMessageUser?: (targetUser: string) => void;
  onSendPublicKeyToUser?: (targetUser: string) => void;
  onImportTransferredAccount?: (
    fromUser: string,
    encryptedPackage: string,
  ) => Promise<{ success: boolean; message: string }>;
  onBlockUser?: (targetUser: string) => void;
  onUnblockUser?: (targetUser: string) => void;
  blockedUsers?: string[];
  getUnreadDirectRepliesCount?: (messageTimestamp: number) => number;
  markDirectRepliesRead?: (messageTimestamp: number) => void;
  replyingTo?: number;
  editingMessageTimestamp?: number;
  indentLevel?: number;
  collapseIntoPrevious?: boolean;
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isCompactHovered, setIsCompactHovered] = useState(false);
  const [actionMenuAnchor, setActionMenuAnchor] = useState<DOMRect | null>(
    null,
  );
  const [userContextMenuAnchor, setUserContextMenuAnchor] =
    useState<DOMRect | null>(null);
  const [pendingSendKeyConfirm, setPendingSendKeyConfirm] = useState<{
    user: string;
    anchor: DOMRect;
  } | null>(null);
  const [isImportingTransfer, setIsImportingTransfer] = useState(false);
  const [isImportedOnThisDevice, setIsImportedOnThisDevice] = useState(() => {
    if (!message.keyTransferEncryptedPackage) {
      return false;
    }
    const marker = transferImportMarker(message);
    return !!readImportedTransferMarkers()[marker];
  });
  const [importTransferStatus, setImportTransferStatus] = useState<
    'success' | 'error' | null
  >(() => {
    if (!message.keyTransferEncryptedPackage) {
      return null;
    }
    const marker = transferImportMarker(message);
    return readImportedTransferMarkers()[marker] ? 'success' : null;
  });
  const [importTransferNote, setImportTransferNote] = useState(() => {
    if (!message.keyTransferEncryptedPackage) {
      return '';
    }
    const marker = transferImportMarker(message);
    if (!readImportedTransferMarkers()[marker]) {
      return '';
    }
    return getDefaultImportedTransferNote(message.keyTransferFromUser);
  });
  const replies = childrenByParent.get(message.timestamp) ?? [];
  const hasReplies = replies.length > 0;
  const isOwnNonSystemMessage =
    !!username &&
    message.username === username &&
    message.username !== 'system';
  const isSystemMessage = message.username === 'system';
  const isDeletedMessage =
    !!message.deleted || message.content === 'Message deleted';
  const isCompactMessage = collapseIntoPrevious;

  const sortedReplies = [...replies]
    .filter((r) => canUserViewMessage(r, username))
    .sort((a, b) => a.timestamp - b.timestamp);
  const unreadDirectRepliesCount = getUnreadDirectRepliesCount
    ? getUnreadDirectRepliesCount(message.timestamp)
    : 0;

  useEffect(() => {
    if (!message.keyTransferEncryptedPackage) {
      setIsImportedOnThisDevice(false);
      setImportTransferStatus(null);
      setImportTransferNote('');
      return;
    }
    const marker = transferImportMarkerFromParts(
      message.id,
      message.timestamp,
      message.keyTransferFromUser,
    );
    const imported = !!readImportedTransferMarkers()[marker];
    setIsImportedOnThisDevice(imported);
    setImportTransferStatus(imported ? 'success' : null);
    if (imported && !importTransferNote) {
      setImportTransferNote(
        getDefaultImportedTransferNote(message.keyTransferFromUser),
      );
    }
  }, [
    message.id,
    message.timestamp,
    message.keyTransferEncryptedPackage,
    message.keyTransferFromUser,
    importTransferNote,
  ]);

  useEffect(() => {
    if (isExpanded && hasReplies && markDirectRepliesRead) {
      markDirectRepliesRead(message.timestamp);
    }
  }, [hasReplies, isExpanded, markDirectRepliesRead, message.timestamp]);

  useEffect(() => {
    const handleSharedClose = () => {
      setActionMenuAnchor(null);
      setUserContextMenuAnchor(null);
    };
    window.addEventListener(CONTEXT_MENU_CLOSE_EVENT, handleSharedClose);
    return () => {
      window.removeEventListener(CONTEXT_MENU_CLOSE_EVENT, handleSharedClose);
    };
  }, []);

  useEffect(() => {
    if (!actionMenuAnchor && !userContextMenuAnchor) return;

    const handleOutsidePointer = () => {
      setActionMenuAnchor(null);
      setUserContextMenuAnchor(null);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setActionMenuAnchor(null);
        setUserContextMenuAnchor(null);
      }
    };

    document.addEventListener('mousedown', handleOutsidePointer);
    document.addEventListener('touchstart', handleOutsidePointer);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleOutsidePointer);
      document.removeEventListener('touchstart', handleOutsidePointer);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [actionMenuAnchor, userContextMenuAnchor]);

  const closeActionMenu = () => {
    setActionMenuAnchor(null);
  };

  const closeUserContextMenu = () => {
    setUserContextMenuAnchor(null);
  };

  const localTimestamp = new Date(message.timestamp * 1000).toLocaleString();

  const isBlockedAuthor =
    !!blockedUsers && blockedUsers.includes(message.username);

  const renderAuthorLine = () => (
    <span
      title={`Sent at ${localTimestamp}`}
      style={{
        cursor: 'help',
        textDecoration: 'underline',
        textDecorationStyle: 'dotted',
      }}
      onContextMenu={(event) => {
        if (
          !onMessageUser ||
          !onSendPublicKeyToUser ||
          !onBlockUser ||
          !onUnblockUser ||
          !username ||
          message.username === 'system'
        ) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();

        const rect = (
          event.currentTarget as HTMLElement
        ).getBoundingClientRect();
        setUserContextMenuAnchor((current) => {
          if (current) {
            return null;
          }
          closeOtherContextMenus();
          return rect;
        });
      }}
    >
      <span>{message.username}</span>
      <span
        style={{
          marginLeft: '6px',
          fontSize: '0.62em',
          color: '#8f9bad',
          fontWeight: 400,
        }}
      >
        {localTimestamp}
      </span>
    </span>
  );

  let hasAccess = false;
  let encryptedData: string | null = null;

  if (message.encryptedMessage) {
    hasAccess = true;
    encryptedData = message.encryptedMessage;
  } else if (message.versions && message.versions.length > 0) {
    const newestVersion = message.versions[0];
    if (newestVersion.encryptedMessage) {
      hasAccess = true;
      encryptedData = newestVersion.encryptedMessage;
    }
  }

  const renderMessageContent = () => {
    if (message.deleted || message.content === 'Message deleted') {
      return (
        <div
          style={{
            color: '#7d7d7d',
            fontStyle: 'italic',
            display: 'inline-block',
          }}
        >
          {!isCompactMessage && <>{renderAuthorLine()}: </>}
          Message deleted
        </div>
      );
    }

    if (
      message.username === 'system' &&
      message.keyTransferEncryptedPackage &&
      message.keyTransferFromUser
    ) {
      return (
        <div
          style={{
            border: '1px solid var(--app-border)',
            padding: '8px',
            margin: '4px 0',
            borderRadius: '6px',
            background:
              'color-mix(in srgb, var(--app-panel) 88%, var(--app-surface) 12%)',
            color: 'var(--app-fg)',
          }}
        >
          {mdStringToReact(message.content)}
          <div style={{ marginTop: '8px' }}>
            <button
              type="button"
              onClick={() => {
                if (!onImportTransferredAccount || isImportingTransfer) {
                  return;
                }

                setIsImportingTransfer(true);
                void onImportTransferredAccount(
                  message.keyTransferFromUser!,
                  message.keyTransferEncryptedPackage!,
                )
                  .then((result) => {
                    if (result.success) {
                      const marker = transferImportMarker(message);
                      markTransferAsImported(marker);
                      setIsImportedOnThisDevice(true);
                    }
                    setImportTransferStatus(
                      result.success ? 'success' : 'error',
                    );
                    setImportTransferNote(result.message);
                  })
                  .finally(() => {
                    setIsImportingTransfer(false);
                  });
              }}
              disabled={!onImportTransferredAccount || isImportingTransfer}
              style={{
                padding: '4px 10px',
                fontSize: '12px',
                cursor: !onImportTransferredAccount ? 'not-allowed' : 'pointer',
                backgroundColor: '#2a5f92',
                color: '#fff',
                border: 'none',
                borderRadius: '4px',
                opacity: !onImportTransferredAccount ? 0.75 : 1,
              }}
              title={
                isImportedOnThisDevice
                  ? 'This account bundle was already imported on this device. You can import again if needed.'
                  : 'Import this shared account into your local login list on this device'
              }
            >
              {isImportingTransfer ? 'Importing...' : 'Add key locally'}
            </button>
            {importTransferNote && importTransferStatus && (
              <span
                style={{
                  marginLeft: '10px',
                  fontSize: '12px',
                  fontWeight: 600,
                  padding: '2px 6px',
                  borderRadius: '4px',
                  color:
                    importTransferStatus === 'error'
                      ? '#a32222'
                      : 'var(--brand-blue)',
                  background:
                    importTransferStatus === 'error'
                      ? 'transparent'
                      : 'color-mix(in srgb, var(--brand-blue) 16%, var(--app-surface) 84%)',
                }}
              >
                {importTransferStatus === 'success' && isImportedOnThisDevice
                  ? `Imported on this device. ${importTransferNote}`
                  : importTransferNote}
              </span>
            )}
          </div>
        </div>
      );
    }

    const canDecrypt =
      hasAccess &&
      message.content &&
      message.content.trim() !== '' &&
      !message.content.includes('🔒') &&
      !message.content.includes('[Encrypted message]');

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
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span>🔒</span>
          <span>
            {!isCompactMessage && <>{renderAuthorLine()}: </>}
            [Encrypted message]
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
          return (
            <span>
              {!isCompactMessage && <>{renderAuthorLine()}: </>}
              {mdStringToReact(message.content || '[No content]')}
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
        marginBottom: isCompactMessage ? '2px' : '8px',
        paddingLeft: indentLevel > 0 ? '24px' : '0',
      }}
      onMouseEnter={() => {
        if (isCompactMessage) {
          setIsCompactHovered(true);
        }
      }}
      onMouseLeave={() => {
        if (isCompactMessage) {
          setIsCompactHovered(false);
        }
      }}
    >
      {isCompactMessage && (
        <span
          style={{
            position: 'absolute',
            left: indentLevel > 0 ? '-44px' : '-128px',
            top: '4px',
            fontSize: '11px',
            color: '#6c7f9b',
            background:
              'color-mix(in srgb, var(--app-surface) 90%, transparent)',
            border:
              '1px solid color-mix(in srgb, var(--app-border) 70%, transparent)',
            borderRadius: '10px',
            padding: '1px 6px',
            opacity: isCompactHovered ? 1 : 0,
            transform: isCompactHovered ? 'translateX(0)' : 'translateX(4px)',
            transition: 'opacity 140ms ease, transform 140ms ease',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          {localTimestamp}
        </span>
      )}

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

        {FEATURES.MESSAGE_VOTING &&
          onVote &&
          username &&
          !isDeletedMessage &&
          !isSystemMessage && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '0px',
                flexShrink: 0,
                marginRight: '4px',
                alignSelf: 'center',
              }}
            >
              <button
                onClick={() => onVote(room, message.timestamp, 'up')}
                style={{
                  padding: '0',
                  fontSize: '14px',
                  cursor: 'pointer',
                  backgroundColor: 'transparent',
                  border: 'none',
                  color:
                    message.userVotes?.[username] === 'up' ? '#4caf50' : '#999',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: '16px',
                  height: '16px',
                  lineHeight: '1',
                }}
                title="Upvote"
              >
                ▲
              </button>
              <span
                style={{
                  fontSize: '11px',
                  fontWeight: 'bold',
                  color: '#666',
                  minWidth: '16px',
                  textAlign: 'center',
                }}
              >
                {message.voteTotal ?? 0}
              </span>
              <button
                onClick={() => onVote(room, message.timestamp, 'down')}
                style={{
                  padding: '0',
                  fontSize: '14px',
                  cursor: 'pointer',
                  backgroundColor: 'transparent',
                  border: 'none',
                  color:
                    message.userVotes?.[username] === 'down'
                      ? '#f44336'
                      : '#999',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: '16px',
                  height: '16px',
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

        {userContextMenuAnchor &&
          onMessageUser &&
          onSendPublicKeyToUser &&
          onBlockUser &&
          onUnblockUser &&
          username &&
          message.username !== 'system' &&
          createPortal(
            <ContextMenuSurface
              $top={userContextMenuAnchor.bottom + 4}
              $left={Math.max(8, userContextMenuAnchor.left)}
              $zIndex={12010}
              $minWidth={165}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <ContextMenuItem
                type="button"
                onClick={() => {
                  onMessageUser(message.username);
                  closeUserContextMenu();
                }}
              >
                Message
              </ContextMenuItem>
              <ContextMenuItem
                type="button"
                title="Send a copy of your account keys/settings so this user can import and log into it on any device they use."
                onClick={() => {
                  if (userContextMenuAnchor) {
                    setPendingSendKeyConfirm({
                      user: message.username,
                      anchor: userContextMenuAnchor,
                    });
                  }
                  closeUserContextMenu();
                }}
              >
                Send private key
              </ContextMenuItem>
              {message.username !== username && isBlockedAuthor ? (
                <ContextMenuItem
                  type="button"
                  onClick={() => {
                    onUnblockUser(message.username);
                    closeUserContextMenu();
                  }}
                >
                  Unblock
                </ContextMenuItem>
              ) : message.username !== username ? (
                <ContextMenuItem
                  type="button"
                  $danger
                  onClick={() => {
                    onBlockUser(message.username);
                    closeUserContextMenu();
                  }}
                >
                  Block
                </ContextMenuItem>
              ) : null}
            </ContextMenuSurface>,
            document.body,
          )}

        {pendingSendKeyConfirm &&
          pendingSendKeyConfirm.user === message.username &&
          onSendPublicKeyToUser && (
            <ConfirmPopover
              message={`Send your private key bundle to ${message.username}?`}
              confirmLabel="Send"
              variant="primary"
              anchorRect={pendingSendKeyConfirm.anchor}
              onConfirm={() => {
                onSendPublicKeyToUser(message.username);
                setPendingSendKeyConfirm(null);
              }}
              onCancel={() => setPendingSendKeyConfirm(null)}
            />
          )}

        {!isDeletedMessage &&
          !isSystemMessage &&
          (onReply || (isOwnNonSystemMessage && (onEdit || onDelete))) && (
            <div
              style={{
                marginLeft: 'auto',
                position: 'relative',
                flexShrink: 0,
              }}
            >
              <button
                type="button"
                aria-label="Message actions"
                title="Message actions"
                style={{
                  listStyle: 'none',
                  cursor: 'pointer',
                  border: '1px solid #b8c8de',
                  borderRadius: '6px',
                  padding: isCompactMessage ? '0 4px' : '0 6px',
                  height: isCompactMessage ? '18px' : '22px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#1a3352',
                  background: '#eaf2fb',
                  fontWeight: 700,
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  const anchor = (
                    e.currentTarget as HTMLElement
                  ).getBoundingClientRect();
                  setActionMenuAnchor((current) => {
                    if (current) return null;
                    closeOtherContextMenus();
                    return anchor;
                  });
                }}
              >
                ⋯
              </button>
              {actionMenuAnchor &&
                createPortal(
                  <ContextMenuSurface
                    $top={actionMenuAnchor.bottom + 4}
                    $left={Math.max(8, actionMenuAnchor.right - 152)}
                    $zIndex={12000}
                    $minWidth={152}
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    {!isSystemMessage && onReply && (
                      <ContextMenuItem
                        type="button"
                        $active={replyingTo === message.timestamp}
                        onClick={() => {
                          onReply(message.timestamp);
                          closeActionMenu();
                        }}
                      >
                        Reply
                      </ContextMenuItem>
                    )}
                    {isOwnNonSystemMessage && onEdit && (
                      <ContextMenuItem
                        type="button"
                        $active={editingMessageTimestamp === message.timestamp}
                        onClick={() => {
                          onEdit(
                            message.timestamp,
                            message.content,
                            message.id,
                          );
                          closeActionMenu();
                        }}
                      >
                        Edit
                      </ContextMenuItem>
                    )}
                    {isOwnNonSystemMessage && onDelete && (
                      <ContextMenuItem
                        type="button"
                        $danger
                        onClick={() => {
                          onDelete(message.timestamp, message.id);
                          closeActionMenu();
                        }}
                      >
                        Delete
                      </ContextMenuItem>
                    )}
                  </ContextMenuSurface>,
                  document.body,
                )}
            </div>
          )}
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

            {sortedReplies.map((reply, index) => {
              const previousReply =
                index > 0 ? sortedReplies[index - 1] : undefined;
              const collapseIntoPrevious = isSameMessageRun(
                previousReply,
                reply,
              );
              return (
                <div
                  key={messageKey(reply, index)}
                  style={{ position: 'relative' }}
                >
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
                    onDelete={onDelete}
                    onVote={onVote}
                    onMessageUser={onMessageUser}
                    onSendPublicKeyToUser={onSendPublicKeyToUser}
                    onImportTransferredAccount={onImportTransferredAccount}
                    onBlockUser={onBlockUser}
                    onUnblockUser={onUnblockUser}
                    blockedUsers={blockedUsers}
                    getUnreadDirectRepliesCount={getUnreadDirectRepliesCount}
                    markDirectRepliesRead={markDirectRepliesRead}
                    replyingTo={replyingTo}
                    editingMessageTimestamp={editingMessageTimestamp}
                    indentLevel={indentLevel + 1}
                    collapseIntoPrevious={collapseIntoPrevious}
                  />
                </div>
              );
            })}
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
  onDelete,
  onVote,
  onMessageUser,
  onSendPublicKeyToUser,
  onImportTransferredAccount,
  onBlockUser,
  onUnblockUser,
  blockedUsers,
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
  onEdit?: (
    messageTimestamp: number,
    content: string,
    messageId?: string,
  ) => void;
  onDelete?: (messageTimestamp: number, messageId?: string) => void;
  onVote?: (
    room: string,
    messageTimestamp: number,
    voteType: 'up' | 'down',
  ) => void;
  onMessageUser?: (targetUser: string) => void;
  onSendPublicKeyToUser?: (targetUser: string) => void;
  onImportTransferredAccount?: (
    fromUser: string,
    encryptedPackage: string,
  ) => Promise<{ success: boolean; message: string }>;
  onBlockUser?: (targetUser: string) => void;
  onUnblockUser?: (targetUser: string) => void;
  blockedUsers?: string[];
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
      {messages.map((message, index) => {
        const previousMessage = index > 0 ? messages[index - 1] : undefined;
        const collapseIntoPrevious = isSameMessageRun(previousMessage, message);

        return (
          <MessageWithReplies
            key={messageKey(message, index)}
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
            onDelete={onDelete}
            onVote={onVote}
            onMessageUser={onMessageUser}
            onSendPublicKeyToUser={onSendPublicKeyToUser}
            onImportTransferredAccount={onImportTransferredAccount}
            onBlockUser={onBlockUser}
            onUnblockUser={onUnblockUser}
            blockedUsers={blockedUsers}
            getUnreadDirectRepliesCount={getUnreadDirectRepliesCount}
            markDirectRepliesRead={markDirectRepliesRead}
            replyingTo={replyingTo}
            editingMessageTimestamp={editingMessageTimestamp}
            indentLevel={0}
            collapseIntoPrevious={collapseIntoPrevious}
          />
        );
      })}
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
  onEdit?: (
    messageTimestamp: number,
    content: string,
    messageId?: string,
  ) => void,
  onDelete?: (messageTimestamp: number, messageId?: string) => void,
  onVote?: (
    room: string,
    messageTimestamp: number,
    voteType: 'up' | 'down',
  ) => void,
  onMessageUser?: (targetUser: string) => void,
  onSendPublicKeyToUser?: (targetUser: string) => void,
  onImportTransferredAccount?: (
    fromUser: string,
    encryptedPackage: string,
  ) => Promise<{ success: boolean; message: string }>,
  onBlockUser?: (targetUser: string) => void,
  onUnblockUser?: (targetUser: string) => void,
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
        onDelete={onDelete}
        onVote={onVote}
        onMessageUser={onMessageUser}
        onSendPublicKeyToUser={onSendPublicKeyToUser}
        onImportTransferredAccount={onImportTransferredAccount}
        onBlockUser={onBlockUser}
        onUnblockUser={onUnblockUser}
        blockedUsers={blockedUsers}
        replyingTo={replyingTo}
        editingMessageTimestamp={editingMessageTimestamp}
        socket={socket}
      />
    );
  }

  return null;
};
