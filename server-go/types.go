package main

import "time"

const (
	DefaultPort       = "3001"
	MinUsernameLength = 8
	MinPasswordLength = 8
	DefaultRoom       = "general"
	SessionTTL        = 4 * time.Hour
	SystemUserID      = "system"
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
}

type LoginResponse struct {
	SessionID       string `json:"sessionId,omitempty"`
	UserID          string `json:"userId"`
	Error           string `json:"error,omitempty"`
	Challenge       string `json:"challenge,omitempty"`
	ServerPublicKey string `json:"serverPublicKey,omitempty"`
}

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
