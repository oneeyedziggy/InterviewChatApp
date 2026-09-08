package main

import "time"

const (
	DefaultPort       = "3001"
	MinUsernameLength = 8
	MinPasswordLength = 8
	DefaultRoom       = "general"
	SessionTTL        = 4 * time.Hour
	SystemUserID      = "system"
	PresenceMsgDebounce = 4 * time.Second
)

const (
	EventClientMessage                  = "clientMessage"
	EventClientNewRoom                  = "clientNewRoom"
	EventClientDisconnecting            = "clientDisconnecting"
	EventClientRequestAccess            = "clientRequestAccess"
	EventClientGrantAccess              = "clientGrantAccess"
	EventClientDenyAccess               = "clientDenyAccess"
	EventClientLeaveRoom                = "clientLeaveRoom"
	EventClientRejoinRoom               = "clientRejoinRoom"
	EventClientVoteJoin                 = "clientVoteJoin"
	EventClientRequestInitialData       = "clientRequestInitialData"
	EventClientRequestRoomData          = "clientRequestRoomData"
	EventClientRequestRoomWindow        = "clientRequestRoomWindow"
	EventClientVoteMessage              = "clientVoteMessage"
	EventClientEditMessage              = "clientEditMessage"
	EventClientDeleteMessage            = "clientDeleteMessage"
	EventClientSendPublicKey            = "clientSendPublicKey"
	EventClientUnblockUserDelta         = "clientUnblockUserDelta"
	EventClientIdentityDirectoryRefresh = "clientIdentityDirectoryRefresh"
	EventServerMessage                  = "serverMessage"
	EventServerPublicKeyReceived        = "serverPublicKeyReceived"
	EventServerIdentityDirectoryRefresh = "serverIdentityDirectoryRefresh"
	EventServerVoteUpdate               = "serverVoteUpdate"
	EventServerActionResult             = "serverActionResult"
	EventServerNewRoom                  = "serverNewRoom"
	EventServerUserListUpdate           = "serverUserListUpdate"
	EventServerAccessRequest            = "serverAccessRequest"
	EventServerAccessDenied             = "serverAccessDenied"
	EventServerJoinRequest              = "serverJoinRequest"
	EventServerJoinApproved             = "serverJoinApproved"
	EventServerJoinDenied               = "serverJoinDenied"
	EventInitialData                    = "initialData"
	EventStatus                         = "status"
	EventDisconnect                     = "disconnect"
)

const (
	UserJoined = "<-- has entered the room"
	UserLeft   = "says \"smell ya' later\" -->"
)

type MessageVersion struct {
	EncryptedMessage string            `json:"encryptedMessage,omitempty"`
	EncryptedFor     map[string]string `json:"encryptedFor"`
	Version          int               `json:"version"`
	ChangeSummary    string            `json:"changeSummary,omitempty"`
	Timestamp        int64             `json:"timestamp"`
}

type Message struct {
	ID                          string            `json:"id,omitempty"`
	Timestamp                   int64             `json:"timestamp"`
	Username                    string            `json:"-"`
	UserID                      string            `json:"userId"`
	RoomID                      string            `json:"roomId"`
	Content                     string            `json:"content"`
	KeyTransferEncryptedPackage string            `json:"keyTransferEncryptedPackage,omitempty"`
	KeyTransferFromUser         string            `json:"-"`
	KeyTransferFromUserID       string            `json:"keyTransferFromUserId,omitempty"`
	EncryptedMessage            string            `json:"encryptedMessage,omitempty"`
	EncryptedFor                map[string]string `json:"encryptedFor"`
	Versions                    []MessageVersion  `json:"versions,omitempty"`
	CurrentVersion              *int              `json:"currentVersion,omitempty"`
	VisibleTo                   []string          `json:"visibleTo,omitempty"`
	ReplyTo                     *int64            `json:"replyTo,omitempty"`
	VoteTotal                   *int              `json:"voteTotal,omitempty"`
	UserVotes                   map[string]string `json:"userVotes,omitempty"`
	Edited                      bool              `json:"edited,omitempty"`
	Deleted                     bool              `json:"deleted,omitempty"`
}

type Messages map[string][]Message

type JoinRequest struct {
	RequestingUserID string
	RequestingUser   string
	RoomID           string
	Room             string
	Votes            map[string]bool
	Timestamp        int64
}

type LoginRequest struct {
	UserID             string `json:"userId"`
	UsernameHash       string `json:"usernameHash,omitempty"`
	UsernameCiphertext string `json:"usernameCiphertext,omitempty"`
	Password           string `json:"password,omitempty"`
	PublicKey          string `json:"publicKey,omitempty"`
	EncryptedUUID      string `json:"encryptedUUID,omitempty"`
	InviteCode         string `json:"inviteCode,omitempty"`
}

type LoginResponse struct {
	SessionID       string `json:"sessionId,omitempty"`
	UserID          string `json:"userId"`
	Error           string `json:"error,omitempty"`
	Challenge       string `json:"challenge,omitempty"`
	ServerPublicKey string `json:"serverPublicKey,omitempty"`
}

type CreateInviteRequest struct {
	UserID    string `json:"userId"`
	SessionID string `json:"sessionId"`
}

type CreateInviteResponse struct {
	Code      string `json:"code,omitempty"`
	ExpiresAt int64  `json:"expiresAt,omitempty"`
	Error     string `json:"error,omitempty"`
}

type ManageInviteRequest struct {
	UserID string `json:"userId"`
	SessionID string `json:"sessionId"`
	InviteID string `json:"inviteId,omitempty"`
}

type InviteSummary struct {
	InviteID string `json:"inviteId"`
	CreatedByUserID string `json:"createdByUserId"`
	CreatedAt int64 `json:"createdAt"`
	ExpiresAt int64 `json:"expiresAt"`
	Status string `json:"status"`
	UsedCount int64 `json:"usedCount"`
	MaxUses *int64 `json:"maxUses,omitempty"`
}

type ServerCreationChallengeRequest struct {
	PublicKey string `json:"publicKey"`
}

type ServerCreationChallengeResponse struct {
	Capability string `json:"capability,omitempty"`
	ServerPublicKey string `json:"serverPublicKey,omitempty"`
	ExpiresAt  int64  `json:"expiresAt,omitempty"`
	Error      string `json:"error,omitempty"`
}

type CreateServerRequest struct {
	Capability string `json:"capability"`
	PublicKey  string `json:"publicKey"`
	Signature  string `json:"signature"`
	UserID string `json:"userId"`
	UsernameHash string `json:"usernameHash"`
	UsernameCiphertext string `json:"usernameCiphertext"`
}

type CreateServerResponse struct {
	ServerID string `json:"serverId"`
	Alias string `json:"alias"`
	SessionID string `json:"sessionId"`
	ServerPublicKey string `json:"serverPublicKey"`
	UserID string `json:"userId"`
}

const InviteTTL = 24 * time.Hour

type DeleteUserRequest struct {
	UserID    string `json:"userId"`
	SessionID string `json:"sessionId"`
}

type DeleteUserResponse struct {
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
}

type PersistedState struct {
	Messages               Messages          `json:"messages"`
	Rooms                  []string          `json:"rooms"`
	Users                  map[string]string `json:"users"`
	UserPubKeys            map[string]string `json:"userPubKeys"`
	UserPubKeysUpdatedAt   map[string]int64  `json:"userPubKeysUpdatedAt,omitempty"`
	UserIDs                map[string]string `json:"userIds,omitempty"`
	RoomIDs                map[string]string `json:"roomIds,omitempty"`
	RoomNameHashes         map[string]string `json:"roomNameHashes,omitempty"`
	RoomNameCiphertexts    map[string]string `json:"roomNameCiphertexts,omitempty"`
	UsernameCiphertexts    map[string]string `json:"usernameCiphertexts,omitempty"`
	UserDirectoryUpdatedAt map[string]int64  `json:"userDirectoryUpdatedAt,omitempty"`
	RoomDirectoryUpdatedAt map[string]int64  `json:"roomDirectoryUpdatedAt,omitempty"`
}
