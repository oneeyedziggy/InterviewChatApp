import { createPortal } from 'react-dom';
import { useEffect, useMemo, useRef, useState } from 'react';
import { VariableSizeList } from 'react-window';
import { type Socket } from '../../utils/websocketClient';
import { getRoomIdByName, getRoomNameByRoomId } from '../../utils/identityMap';
import { styled } from 'styled-components';
import { ConfirmPopover } from '../ConfirmPopover';
import { AppModal } from '../AppModal';
import { ContextMenuItem, ContextMenuSurface } from '../styled/ContextMenu';
import { SOCKET_EVENTS, FEATURES } from '../../constants';
import { type Messages, type Message } from '../../types/types';
import { canUserViewMessage } from '../../utils/messages';
import { loadKeysAsync } from '../../utils/gpg';
import { emitSignedMutation } from '../../utils/socketAuth';
import {
  CONTEXT_MENU_CLOSE_EVENT,
  closeOtherContextMenus,
} from '../../utils/contextMenuEvents';
import { mdStringToReact } from '../../utils/markdown';
import {
  getCurrentUserId,
  getUsernameByUserId,
  requireRoomIdByName,
  requireUserIdByUsername,
} from '../../utils/identityMap';

const IMPORTED_TRANSFER_MARKERS_KEY = 'imported_transfer_markers_v1';

const readImportedTransferMarkers = (): Record<string, boolean> => {
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
};

const markTransferAsImported = (marker: string): void => {
  if (typeof window === 'undefined' || !marker) {
    return;
  }

  const existing = readImportedTransferMarkers();
  existing[marker] = true;
  localStorage.setItem(IMPORTED_TRANSFER_MARKERS_KEY, JSON.stringify(existing));
};

const transferImportMarker = (message: Message): string => {
  if (message.id && message.id.trim() !== '') {
    return `id:${message.id}`;
  }
  const fromUser =
    (message.keyTransferFromUserId
      ? getUsernameByUserId(message.keyTransferFromUserId)
      : undefined) ||
    message.keyTransferFromUserId ||
    'unknown';
  return `legacy:${message.timestamp}:${fromUser}`;
};

const transferImportMarkerFromParts = (
  messageID: string | undefined,
  messageTimestamp: number,
  fromUser: string | undefined,
): string => {
  if (messageID && messageID.trim() !== '') {
    return `id:${messageID}`;
  }
  return `legacy:${messageTimestamp}:${fromUser || 'unknown'}`;
};

const getDefaultImportedTransferNote = (
  fromUser: string | undefined,
): string => {
  if (fromUser) {
    return `Imported account from ${fromUser}. It is now available in your local login list.`;
  }
  return 'Imported account is available in your local login list.';
};

const messageKey = (message: Message, index: number): string => {
  if (message.id && message.id.trim() !== '') {
    return `id:${message.id}`;
  }
  return `ts:${message.timestamp}:u:${message.userId || 'unknown'}:i:${index}`;
};

const expansionKey = (message: Message): string =>
  message.id || `ts:${message.timestamp}:u:${message.userId || 'unknown'}`;

const isUnreadableEncryptedMessage = (message: Message): boolean => {
  const hasEncryptedPayload =
    !!message.encryptedMessage ||
    !!message.encryptedFor ||
    (message.versions?.length || 0) > 0;
  const content = (message.content || '').trim();
  return (
    hasEncryptedPayload &&
    (!content ||
      content.includes('🔒') ||
      content.includes('[Encrypted message]'))
  );
};

const resolveDisplayUsername = (message: Message): string => {
  if (message.userId === 'system') {
    return 'system';
  }
  if (message.userId) {
    const mapped = getUsernameByUserId(message.userId);
    if (mapped) {
      return mapped;
    }
  }
  return message.userId || 'unknown';
};

const resolveSystemUserRefs = (content: string): string => {
  if (!content || content.trim() === '') {
    return content;
  }

  return content.replace(/userId:([A-Za-z0-9:_-]+)/g, (full, userID) => {
    const mapped = getUsernameByUserId(userID);
    return mapped || full;
  });
};

const isSameMessageRun = (
  previous: Message | undefined,
  current: Message,
): boolean => {
  if (!previous) {
    return false;
  }
  const previousReplyTo = previous.replyTo ?? null;
  const currentReplyTo = current.replyTo ?? null;
  return (
    (previous.userId || previous.username) ===
      (current.userId || current.username) && previousReplyTo === currentReplyTo
  );
};

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
  expandedMessageIds,
  onToggleExpanded,
}: {
  message: Message;
  allMessages: Message[];
  childrenByParent: Map<number, Message[]>;
  room: string;
  username?: string;
  onRequestAccess?: (
    messageUserId: string,
    room: string,
    messageTimestamp: number,
  ) => void;
  onGrantAccess?: (
    requestingUserId: string,
    originalRoom: string,
    messageTimestamp: number,
  ) => void;
  onDenyAccess?: (
    requestingUserId: string,
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
  onSendPublicKeyToUser?: (
    targetUser: string,
    password: string,
  ) => Promise<boolean>;
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
  expandedMessageIds: Set<string>;
  onToggleExpanded: (message: Message) => void;
}) => {
  const transferDisplayFromUser =
    (message.keyTransferFromUserId
      ? getUsernameByUserId(message.keyTransferFromUserId)
      : undefined) || message.keyTransferFromUserId;

  const isExpanded = expandedMessageIds.has(expansionKey(message));
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
  const [isPasswordDialogOpen, setIsPasswordDialogOpen] = useState(false);
  const [transferPassword, setTransferPassword] = useState('');
  const [isSendingTransfer, setIsSendingTransfer] = useState(false);
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
    return getDefaultImportedTransferNote(transferDisplayFromUser);
  });
  const replies = childrenByParent.get(message.timestamp) ?? [];
  const hasReplies = replies.length > 0;
  const messageDisplayUsername = resolveDisplayUsername(message);
  const isOwnNonSystemMessage =
    !!username &&
    messageDisplayUsername === username &&
    message.userId !== 'system';
  const isSystemMessage = message.userId === 'system';
  const currentUserId = getCurrentUserId();
  const voteIdentityKey = currentUserId || username;
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
      transferDisplayFromUser,
    );
    const imported = !!readImportedTransferMarkers()[marker];
    setIsImportedOnThisDevice(imported);
    setImportTransferStatus(imported ? 'success' : null);
    if (imported && !importTransferNote) {
      setImportTransferNote(
        getDefaultImportedTransferNote(transferDisplayFromUser),
      );
    }
  }, [
    message.id,
    message.timestamp,
    message.keyTransferEncryptedPackage,
    transferDisplayFromUser,
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
    !!blockedUsers && blockedUsers.includes(messageDisplayUsername);

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
          message.userId === 'system'
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
      <span>{messageDisplayUsername}</span>
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
    const renderableContent =
      message.userId === 'system'
        ? resolveSystemUserRefs(message.content || '')
        : message.content || '';

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
      message.userId === 'system' &&
      message.keyTransferEncryptedPackage &&
      message.keyTransferFromUserId
    ) {
      const transferFromUser = transferDisplayFromUser || '';
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
          {mdStringToReact(renderableContent)}
          <div style={{ marginTop: '8px' }}>
            <button
              type="button"
              onClick={() => {
                if (!onImportTransferredAccount || isImportingTransfer) {
                  return;
                }

                setIsImportingTransfer(true);
                void onImportTransferredAccount(
                  transferFromUser,
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
      renderableContent &&
      renderableContent.trim() !== '' &&
      !renderableContent.includes('🔒') &&
      !renderableContent.includes('[Encrypted message]');

    const isAccessRequest =
      renderableContent &&
      (renderableContent.includes('requests access') ||
        renderableContent.includes('Requests access'));
    const isAccessStatus =
      renderableContent &&
      (renderableContent.includes('You requested access') ||
        renderableContent.includes('you requested access'));

    if (isAccessStatus) {
      const statusMatch = renderableContent.match(
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
            {mdStringToReact(renderableContent)}
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
      const match = renderableContent.match(
        /(?:User\s+\w+\s+)?requests access to your message in (.+?) \(timestamp: (\d+)\)/i,
      );
      if (match) {
        const originalRoom = match[1];
        const messageTimestamp = parseInt(match[2], 10);
        const requestingUserId = message.userId;
        const isDenied = renderableContent.includes('[Access Denied]');
        const isGranted = renderableContent.includes('[Access Granted]');

        return (
          <div
            style={{
              border: '1px solid #ccc',
              padding: '8px',
              margin: '4px 0',
            }}
          >
            {mdStringToReact(
              renderableContent.replace(
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
                        requestingUserId,
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
                        requestingUserId,
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
              {mdStringToReact(renderableContent || '[No content]')}
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
        marginBottom: isCompactMessage ? '1px' : '4px',
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
            right: indentLevel > 0 ? '-44px' : '-128px',
            top: '4px',
            fontSize: '11px',
            color: 'var(--app-surface)',
            background: 'color-mix(in srgb, var(--app-fg) 92%, black)',
            border: '1px solid color-mix(in srgb, var(--app-fg) 72%, black)',
            borderRadius: '10px',
            padding: '1px 6px',
            opacity: isCompactHovered ? 1 : 0,
            transform: isCompactHovered ? 'translateX(0)' : 'translateX(4px)',
            transition: 'opacity 140ms ease, transform 140ms ease',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
            zIndex: 2,
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.28)',
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
                  onToggleExpanded(message);
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
                aria-label={isExpanded ? 'Collapse replies' : 'Expand replies'}
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
                  onToggleExpanded(message);
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
                aria-label={isExpanded ? 'Collapse replies' : 'Expand replies'}
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
                aria-label="Upvote"
                style={{
                  padding: '0',
                  fontSize: '14px',
                  cursor: 'pointer',
                  backgroundColor: 'transparent',
                  border: 'none',
                  color:
                    message.userVotes?.[voteIdentityKey || ''] === 'up'
                      ? '#4caf50'
                      : '#999',
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
                aria-label="Downvote"
                style={{
                  padding: '0',
                  fontSize: '14px',
                  cursor: 'pointer',
                  backgroundColor: 'transparent',
                  border: 'none',
                  color:
                    message.userVotes?.[voteIdentityKey || ''] === 'down'
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
          message.userId !== 'system' &&
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
                  onMessageUser(messageDisplayUsername);
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
                      user: messageDisplayUsername,
                      anchor: userContextMenuAnchor,
                    });
                  }
                  closeUserContextMenu();
                }}
              >
                Send private key
              </ContextMenuItem>
              {messageDisplayUsername !== username && isBlockedAuthor ? (
                <ContextMenuItem
                  type="button"
                  onClick={() => {
                    onUnblockUser(messageDisplayUsername);
                    closeUserContextMenu();
                  }}
                >
                  Unblock
                </ContextMenuItem>
              ) : messageDisplayUsername !== username ? (
                <ContextMenuItem
                  type="button"
                  $danger
                  onClick={() => {
                    onBlockUser(messageDisplayUsername);
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
          pendingSendKeyConfirm.user === messageDisplayUsername &&
          onSendPublicKeyToUser && (
            <ConfirmPopover
              message={`Send your private key bundle to ${messageDisplayUsername}?`}
              confirmLabel="Send"
              variant="primary"
              anchorRect={pendingSendKeyConfirm.anchor}
              onConfirm={() => {
                setPendingSendKeyConfirm(null);
                setTransferPassword('');
                setIsPasswordDialogOpen(true);
              }}
              onCancel={() => setPendingSendKeyConfirm(null)}
            />
          )}

        <AppModal
          open={isPasswordDialogOpen}
          title="Verify your password"
          onClose={() => {
            if (!isSendingTransfer) setIsPasswordDialogOpen(false);
          }}
          actions={
            <>
              <button
                type="button"
                className="app-secondary-button"
                disabled={isSendingTransfer}
                onClick={() => setIsPasswordDialogOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="app-primary-button"
                disabled={!transferPassword || isSendingTransfer}
                onClick={() => {
                  void (async () => {
                    setIsSendingTransfer(true);
                    const sendTransfer = onSendPublicKeyToUser;
                    if (!sendTransfer) {
                      setIsSendingTransfer(false);
                      return;
                    }
                    const sent = await sendTransfer(
                      messageDisplayUsername,
                      transferPassword,
                    );
                    setIsSendingTransfer(false);
                    if (sent) {
                      setTransferPassword('');
                      setIsPasswordDialogOpen(false);
                    }
                  })();
                }}
              >
                {isSendingTransfer ? 'Verifying...' : 'Verify and send'}
              </button>
            </>
          }
        >
          <p className="app-dialog-message">
            Re-enter your AES password to authorize sending this encrypted
            private-key bundle.
          </p>
          <input
            className="app-text-input app-dialog-password-input"
            type="password"
            autoFocus
            value={transferPassword}
            onChange={(event) => setTransferPassword(event.target.value)}
            aria-label="AES password"
          />
        </AppModal>

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
            marginTop: '4px',
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
                    expandedMessageIds={expandedMessageIds}
                    onToggleExpanded={onToggleExpanded}
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

const MessageThreadCard = ({
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
  onLoadOlder,
}: {
  messages: Message[];
  allMessages: Message[];
  currentRoom: string;
  username?: string;
  onRequestAccess?: (
    messageUserId: string,
    room: string,
    messageTimestamp: number,
  ) => void;
  onGrantAccess?: (
    requestingUserId: string,
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
  onSendPublicKeyToUser?: (
    targetUser: string,
    password: string,
  ) => Promise<boolean>;
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
  onLoadOlder?: () => void;
}) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const threadAreaRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<any>(null);
  const [threadHeight, setThreadHeight] = useState(0);
  const [expandedMessageIds, setExpandedMessageIds] = useState<Set<string>>(
    new Set(),
  );
  const [expandedStorageKey, setExpandedStorageKey] = useState('');
  const shouldStickToBottomRef = useRef(true);
  const didInitializeReadMarkersRef = useRef(false);
  const messageCount = messages.length;
  const storageKey = `home_message_expansions_${username || 'anonymous'}_${encodeURIComponent(currentRoom)}`;

  useEffect(() => {
    setExpandedStorageKey(storageKey);
    if (typeof window === 'undefined') {
      setExpandedMessageIds(new Set());
      return;
    }
    try {
      const raw = localStorage.getItem(storageKey);
      const parsed = raw ? (JSON.parse(raw) as unknown) : [];
      setExpandedMessageIds(
        new Set(
          Array.isArray(parsed)
            ? parsed.filter(
                (value): value is string => typeof value === 'string',
              )
            : [],
        ),
      );
    } catch {
      setExpandedMessageIds(new Set());
    }
  }, [storageKey]);

  useEffect(() => {
    if (expandedStorageKey !== storageKey || typeof window === 'undefined') {
      return;
    }
    localStorage.setItem(
      storageKey,
      JSON.stringify(Array.from(expandedMessageIds)),
    );
  }, [expandedMessageIds, expandedStorageKey, storageKey]);

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
    const distanceFromBottom =
      node.scrollHeight - node.scrollTop - node.clientHeight;
    if (distanceFromBottom <= 2) return;
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

  useEffect(() => {
    const area = threadAreaRef.current;
    if (!area) return;
    const updateHeight = () => setThreadHeight(area.clientHeight);
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(area);
    return () => observer.disconnect();
  }, []);

  const handleScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    if (node.scrollTop <= 48) onLoadOlder?.();
    const threshold = 24;
    shouldStickToBottomRef.current =
      node.scrollHeight - node.scrollTop - node.clientHeight <= threshold;
  };

  const estimateMessageSize = (message: Message): number => {
    const contentLines = Math.max(
      1,
      Math.ceil((message.content?.length || 0) / 72),
    );
    const replies = childrenByParent.get(message.timestamp) || [];
    const baseSize = 58 + contentLines * 18;
    if (
      !expandedMessageIds.has(expansionKey(message)) ||
      replies.length === 0
    ) {
      return baseSize;
    }
    return (
      baseSize +
      4 +
      replies.reduce((total, reply) => total + estimateMessageSize(reply), 0)
    );
  };

  const toggleExpanded = (message: Message, topLevelIndex: number) => {
    setExpandedMessageIds((previous) => {
      const next = new Set(previous);
      const key = expansionKey(message);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
    window.requestAnimationFrame(() => {
      listRef.current?.resetAfterIndex(topLevelIndex, false);
    });
  };

  const itemSize = (index: number) => {
    return estimateMessageSize(messages[index]);
  };

  return (
    <div
      ref={threadAreaRef}
      style={{ height: '100%', minHeight: 0, width: '100%' }}
    >
      <VariableSizeList
        ref={listRef}
        className="app-message-thread-card"
        height={threadHeight || 320}
        width="100%"
        itemCount={messages.length}
        itemSize={itemSize}
        itemKey={(index) => messageKey(messages[index], index)}
        outerRef={scrollRef}
        onScroll={handleScroll}
        onItemsRendered={({ visibleStartIndex }) => {
          if (visibleStartIndex <= 1) onLoadOlder?.();
        }}
      >
        {({ index, style }) => {
          const message = messages[index];
          const previousMessage = index > 0 ? messages[index - 1] : undefined;
          const collapseIntoPrevious = isSameMessageRun(
            previousMessage,
            message,
          );

          return (
            <div style={style}>
              <MessageWithReplies
                message={message}
                allMessages={allMessages}
                childrenByParent={childrenByParent}
                room={currentRoom}
                username={username}
                onRequestAccess={onRequestAccess}
                onGrantAccess={onGrantAccess}
                onDenyAccess={(
                  requestingUserId: string,
                  originalRoom: string,
                  messageTimestamp: number,
                ) => {
                  void (async () => {
                    const keys = await loadKeysAsync();
                    if (!socket || !username || !keys?.sessionId) return;
                    const voterUserId = requireUserIdByUsername(username);
                    const originalRoomId = requireRoomIdByName(originalRoom);
                    void emitSignedMutation(socket, {
                      event: SOCKET_EVENTS.CLIENT_DENY_ACCESS,
                      payload: {
                        requestingUserId,
                        originalRoomId,
                        messageTimestamp,
                        sessionId: keys.sessionId,
                      },
                      userId: voterUserId,
                      sessionId: keys.sessionId,
                      claims: {
                        requestingUserId,
                        originalRoomId,
                        messageTimestamp,
                      },
                    });
                  })();
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
                expandedMessageIds={expandedMessageIds}
                onToggleExpanded={(expandedMessage) =>
                  toggleExpanded(expandedMessage, index)
                }
              />
            </div>
          );
        }}
      </VariableSizeList>
    </div>
  );
};

export const renderMessageThread = (
  messages: Messages,
  currentRoom: string,
  username?: string,
  blockedUsers: string[] = [],
  onRequestAccess?: (
    messageUserId: string,
    room: string,
    messageTimestamp: number,
  ) => void,
  onGrantAccess?: (
    requestingUserId: string,
    originalRoom: string,
    messageTimestamp: number,
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
  onSendPublicKeyToUser?: (
    targetUser: string,
    password: string,
  ) => Promise<boolean>,
  onImportTransferredAccount?: (
    fromUser: string,
    encryptedPackage: string,
  ) => Promise<{ success: boolean; message: string }>,
  onBlockUser?: (targetUser: string) => void,
  onUnblockUser?: (targetUser: string) => void,
  replyingTo?: number,
  editingMessageTimestamp?: number,
  socket?: Socket,
  onLoadOlder?: () => void,
) => {
  const resolvedRoom =
    (currentRoom && messages[currentRoom] && currentRoom) ||
    (currentRoom && getRoomNameByRoomId(currentRoom)) ||
    (currentRoom && getRoomIdByName(currentRoom)) ||
    currentRoom;
  if (resolvedRoom && Object.keys(messages).length && messages[resolvedRoom]) {
    const allRoomMessages = messages[resolvedRoom];
    const visibleRoomMessages = allRoomMessages.filter(
      (msg) =>
        canUserViewMessage(msg, username) && !isUnreadableEncryptedMessage(msg),
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
        currentRoom={resolvedRoom}
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
        onLoadOlder={onLoadOlder}
      />
    );
  }

  return null;
};
