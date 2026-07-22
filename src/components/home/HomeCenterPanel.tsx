import {
  MainPanel,
  Row,
  AppTextInput,
  PrimaryButton,
} from './LayoutPrimitives';
import { renderMessageThread } from './MessageThread';
import {
  useHomeComposer,
  useHomePresence,
} from '../../contexts/home/useHomePageSelectors';

export function HomeCenterPanel() {
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
    handleBlockUser,
    handleUnblockUser,
  } = useHomePresence();

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
          handleBlockUser,
          handleUnblockUser,
          replyingTo,
          editingMessageTimestamp,
          socket,
        )}
      </div>
      <Row className="app-message-composer">
        <AppTextInput
          id="userDraftMessageInput"
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
        {(replyingTo || editingMessageTimestamp) && (
          <button
            onClick={handleCancelReplyOrEdit}
            className="rounded-md bg-red-500 px-2 py-1 text-xs text-white"
            title={editingMessageTimestamp ? 'Cancel edit' : 'Cancel reply'}
          >
            X
          </button>
        )}
        <PrimaryButton type="button" onClick={() => void doSend()}>
          Send
        </PrimaryButton>
      </Row>
    </MainPanel>
  );
}
