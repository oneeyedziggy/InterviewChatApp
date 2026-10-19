import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MainPanel,
  Row,
  AppTextArea,
  PrimaryButton,
  MobilePanelHeader,
} from './LayoutPrimitives';
import { renderMessageThread } from './MessageThread';
import { MESSAGE_LIMITS } from '../../constants';
import { getRoomDisplayLabel } from '../../utils/dmRooms';
import {
  useHomeComposer,
  useHomePresence,
} from '../../contexts/home/useHomePageSelectors';
import { getUtf8ByteLength } from '../../utils/messages';
import { SOCKET_EVENTS } from '../../constants';
import {
  requireRoomIdByName,
  requireUserIdByUsername,
} from '../../utils/identityMap';

export const HomeCenterPanel = () => {
  const composerTextAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollHeightBeforeOlderRef = useRef<number | null>(null);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [hasOlderMessages, setHasOlderMessages] = useState(true);

  const {
    chatValues,
    currentRoom,
    username,
    blockedUsers,
    replyingTo,
    editingMessageTimestamp,
    socket,
    userDraftMessage,
    handleRequestAccess,
    handleGrantAccess,
    handleSelectVersion,
    handleReply,
    handleEdit,
    handleDeleteMessage,
    handleVote,
    setUserDraftMessage,
    onDraftKeyDownHandler,
    handleCancelReplyOrEdit,
    doSend,
  } = useHomeComposer();

  const loadOlderMessages = useCallback(() => {
    if (isLoadingOlder || !hasOlderMessages) return;
    void (async () => {
      if (!socket || !username || !currentRoom) return;
      setIsLoadingOlder(true);
      const [{ loadKeysAsync }, { emitSignedMutation }] = await Promise.all([
        import('../../utils/gpg'),
        import('../../utils/socketAuth'),
      ]);
      const keys = await loadKeysAsync();
      if (!keys?.sessionId) {
        setIsLoadingOlder(false);
        return;
      }
      const roomMessages = chatValues[currentRoom] || [];
      const firstMessage = roomMessages[0];
      const thread = document.querySelector('.app-message-thread-card');
      scrollHeightBeforeOlderRef.current = thread?.scrollHeight || null;
      const userId = requireUserIdByUsername(username);
      let roomId = currentRoom;
      try {
        roomId = requireRoomIdByName(currentRoom);
      } catch {
        // DM room IDs are already canonical.
      }
      try {
        await emitSignedMutation(socket, {
          event: SOCKET_EVENTS.CLIENT_REQUEST_ROOM_WINDOW,
          payload: {
            room: currentRoom,
            roomId,
            userId,
            sessionId: keys.sessionId,
            limit: 100,
            beforeTimestamp: firstMessage?.timestamp,
            beforeMessageId: firstMessage?.id,
          },
          userId,
          sessionId: keys.sessionId,
          claims: {
            room: currentRoom,
            roomId,
            limit: '100',
            beforeTimestamp: firstMessage?.timestamp || 0,
            beforeMessageId: firstMessage?.id || '',
          },
        });
      } catch {
        setIsLoadingOlder(false);
      }
    })();
  }, [
    chatValues,
    currentRoom,
    hasOlderMessages,
    isLoadingOlder,
    socket,
    username,
  ]);

  useEffect(() => {
    const onWindowLoaded = (event: Event) => {
      const detail = (
        event as CustomEvent<{ direction?: string; hasMore?: boolean }>
      ).detail;
      setIsLoadingOlder(false);
      if (detail?.direction === 'older') {
        setHasOlderMessages(detail.hasMore === true);
        const previousHeight = scrollHeightBeforeOlderRef.current;
        const thread = document.querySelector('.app-message-thread-card');
        if (previousHeight !== null && thread) {
          window.requestAnimationFrame(() => {
            thread.scrollTop += thread.scrollHeight - previousHeight;
          });
        }
        scrollHeightBeforeOlderRef.current = null;
      }
    };
    window.addEventListener('chat-room-window-loaded', onWindowLoaded);
    return () =>
      window.removeEventListener('chat-room-window-loaded', onWindowLoaded);
  }, []);

  useEffect(() => {
    setHasOlderMessages(true);
    scrollHeightBeforeOlderRef.current = null;
  }, [currentRoom]);

  const {
    handleMessageUser,
    handleSendPublicKeyToUser,
    handleImportTransferredAccount,
    handleBlockUser,
    handleUnblockUser,
  } = useHomePresence();

  const draftByteLength = getUtf8ByteLength(userDraftMessage);
  const showByteCounter = draftByteLength > MESSAGE_LIMITS.WARN_TEXT_BYTES;
  const isOverLimit = draftByteLength > MESSAGE_LIMITS.MAX_TEXT_BYTES;
  const mobileRoomTitle = currentRoom
    ? getRoomDisplayLabel(currentRoom, username)
    : 'Messages';

  useEffect(() => {
    const el = composerTextAreaRef.current;
    if (!el) {
      return;
    }

    el.style.height = 'auto';

    const computed = window.getComputedStyle(el);
    const lineHeight = Number.parseFloat(computed.lineHeight) || 20;
    const paddingTop = Number.parseFloat(computed.paddingTop) || 0;
    const paddingBottom = Number.parseFloat(computed.paddingBottom) || 0;
    const maxHeight = lineHeight * 10 + paddingTop + paddingBottom;
    const nextHeight = Math.min(el.scrollHeight, maxHeight);

    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [userDraftMessage]);

  return (
    <MainPanel aria-label="Messages and composer panel">
      <MobilePanelHeader
        title={mobileRoomTitle}
        previousSlide={0}
        nextSlide={2}
      />
      <div className="app-message-thread-area">
        {isLoadingOlder && <div role="status">Loading older messages...</div>}
        {renderMessageThread(
          chatValues,
          currentRoom,
          username,
          blockedUsers,
          handleRequestAccess,
          handleGrantAccess,
          handleSelectVersion,
          chatValues,
          handleReply,
          handleEdit,
          handleDeleteMessage,
          handleVote,
          handleMessageUser,
          handleSendPublicKeyToUser,
          handleImportTransferredAccount,
          handleBlockUser,
          handleUnblockUser,
          replyingTo,
          editingMessageTimestamp,
          socket,
          loadOlderMessages,
        )}
      </div>
      {currentRoom && (
        <Row className="app-message-composer">
          <div className="app-composer-input-wrap">
            <AppTextArea
              ref={composerTextAreaRef}
              id="userDraftMessageInput"
              className="app-composer-textarea"
              rows={1}
              placeholder={
                editingMessageTimestamp
                  ? `Editing message... (click X to cancel)`
                  : replyingTo
                    ? `Replying to message... (click X to cancel)`
                    : 'Type something'
              }
              value={userDraftMessage}
              onChange={(e) => setUserDraftMessage(e.target.value)}
              onKeyDown={onDraftKeyDownHandler}
            />
            {showByteCounter && (
              <div
                className={`app-composer-byte-counter ${isOverLimit ? 'app-composer-byte-counter--over' : ''}`}
              >
                <div>
                  {draftByteLength}/{MESSAGE_LIMITS.MAX_TEXT_BYTES} bytes
                </div>
                {isOverLimit && (
                  <div className="app-composer-byte-warning">
                    Max message size is {MESSAGE_LIMITS.MAX_TEXT_BYTES} bytes.
                  </div>
                )}
              </div>
            )}
          </div>
          {(replyingTo || editingMessageTimestamp) && (
            <button
              onClick={handleCancelReplyOrEdit}
              aria-label={
                editingMessageTimestamp ? 'Cancel edit' : 'Cancel reply'
              }
              className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-red-600 text-sm font-bold leading-none text-white shadow-sm transition-colors hover:bg-red-700"
              title={editingMessageTimestamp ? 'Cancel edit' : 'Cancel reply'}
            >
              X
            </button>
          )}
          <PrimaryButton
            type="button"
            className="app-composer-send"
            onClick={() => void doSend()}
            disabled={isOverLimit}
          >
            Send
          </PrimaryButton>
        </Row>
      )}
    </MainPanel>
  );
};
