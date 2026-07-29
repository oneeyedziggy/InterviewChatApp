import { useEffect, useRef } from 'react';
import { MainPanel, Row, AppTextArea, PrimaryButton } from './LayoutPrimitives';
import { renderMessageThread } from './MessageThread';
import { MESSAGE_LIMITS } from '../../constants';
import {
  useHomeComposer,
  useHomePresence,
} from '../../contexts/home/useHomePageSelectors';
import { getUtf8ByteLength } from '../../utils/messages';

export function HomeCenterPanel() {
  const composerTextAreaRef = useRef<HTMLTextAreaElement | null>(null);

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
    <MainPanel>
      <div className="app-message-thread-area">
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
              className="rounded-md bg-red-500 px-2 py-1 text-xs text-white"
              title={editingMessageTimestamp ? 'Cancel edit' : 'Cancel reply'}
            >
              X
            </button>
          )}
          <PrimaryButton
            type="button"
            onClick={() => void doSend()}
            disabled={isOverLimit}
          >
            Send
          </PrimaryButton>
        </Row>
      )}
    </MainPanel>
  );
}
