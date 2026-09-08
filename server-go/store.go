package main

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

func NewStateStore(path string) (StateStore, error) {
	return NewSQLiteStore(path)
}

type StateStore interface {
	Save(messages Messages, rooms []string, users map[string]string, userPubKeys map[string]string) error
	SaveWithIdentity(
		messages Messages,
		rooms []string,
		users map[string]string,
		userPubKeys map[string]string,
		userPubKeysUpdatedAt map[string]int64,
		userIDs map[string]string,
		roomIDs map[string]string,
		roomNameHashes map[string]string,
		roomNameCiphertexts map[string]string,
		usernameCiphertexts map[string]string,
		userDirectoryUpdatedAt map[string]int64,
		roomDirectoryUpdatedAt map[string]int64,
	) error
	Load() (Messages, []string, map[string]string, map[string]string, map[string]int64, map[string]string, map[string]string, map[string]string, map[string]string, map[string]string, map[string]int64, map[string]int64, error)
	RoomCreatedAt() (map[string]int64, error)
	UserJoinedAt() (map[string]int64, error)
	SetInvitedBy(userID, invitedByUserID string) error
	HasAnyUsers() (bool, error)
	CreateInvite(codeHash, createdByUserID string, createdAt, expiresAt int64) error
	ListInvites() ([]InviteSummary, error)
	RevokeInvite(inviteID string) error
	ActiveInvitesByUser(userID string) (int, error)
	ConsumeInvite(codeHash string, now int64) (createdByUserID string, ok bool, err error)
	QueueAccessGrantRequest(requestingUserID, originalSenderID, originalRoomID string, messageTimestamp, createdAt int64) error
	PendingAccessGrantRequestsForUser(userID string) ([]AccessGrantRequest, error)
	CompleteAccessGrantRequest(requestID string) error
}

func roomNameHashForMigration(roomName string) string {
	normalized := strings.TrimSpace(strings.ToLower(roomName))
	if normalized == "" {
		return ""
	}
	hash := sha256.Sum256([]byte(normalized))
	return hex.EncodeToString(hash[:])
}
