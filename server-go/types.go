package main

import "time"

const (
	DefaultPort       = "3001"
	MinUsernameLength = 8
	MinPasswordLength = 8
	DefaultRoom       = "#general"
	SessionTTL        = 4 * time.Hour
)

const (
	EventClientMessage           = "clientMessage"
	EventClientNewRoom           = "clientNewRoom"
	EventClientDisconnecting     = "clientDisconnecting"
	EventClientRequestAccess     = "clientRequestAccess"
	EventClientGrantAccess       = "clientGrantAccess"
	EventClientDenyAccess        = "clientDenyAccess"
	EventClientLeaveRoom         = "clientLeaveRoom"
	EventClientRejoinRoom        = "clientRejoinRoom"
	EventClientVoteJoin          = "clientVoteJoin"
	EventClientVoteMessage       = "clientVoteMessage"
	EventClientEditMessage       = "clientEditMessage"
	EventClientDeleteMessage     = "clientDeleteMessage"
	EventClientSendPublicKey     = "clientSendPublicKey"
	EventServerMessage           = "serverMessage"
	EventServerPublicKeyReceived = "serverPublicKeyReceived"
	EventServerVoteUpdate        = "serverVoteUpdate"
	EventServerActionResult      = "serverActionResult"
	EventServerNewRoom           = "serverNewRoom"
	EventServerUserListUpdate    = "serverUserListUpdate"
	EventServerAccessRequest     = "serverAccessRequest"
	EventServerAccessDenied      = "serverAccessDenied"
	EventServerJoinRequest       = "serverJoinRequest"
	EventServerJoinApproved      = "serverJoinApproved"
	EventServerJoinDenied        = "serverJoinDenied"
	EventInitialData             = "initialData"
	EventStatus                  = "status"
	EventDisconnect              = "disconnect"
)

const (
	UserJoined = "<-- has entered the room"
	UserLeft   = "says \"smell ya' later\" -->"
)

type MessageVersion struct {
	EncryptedFor  map[string]string `json:"encryptedFor"`
	Version       int               `json:"version"`
	ChangeSummary string            `json:"changeSummary,omitempty"`
	Timestamp     int64             `json:"timestamp"`
}

type Message struct {
	Timestamp      int64             `json:"timestamp"`
	Username       string            `json:"username"`
	Content        string            `json:"content"`
	EncryptedFor   map[string]string `json:"encryptedFor"`
	Versions       []MessageVersion  `json:"versions,omitempty"`
	CurrentVersion *int              `json:"currentVersion,omitempty"`
	VisibleTo      []string          `json:"visibleTo,omitempty"`
	ReplyTo        *int64            `json:"replyTo,omitempty"`
	VoteTotal      *int              `json:"voteTotal,omitempty"`
	UserVotes      map[string]string `json:"userVotes,omitempty"`
	Edited         bool              `json:"edited,omitempty"`
}

type Messages map[string][]Message

type JoinRequest struct {
	RequestingUser string
	Room           string
	Votes          map[string]bool
	Timestamp      int64
}

type LoginRequest struct {
	Username      string `json:"username"`
	Password      string `json:"password,omitempty"`
	PublicKey     string `json:"publicKey,omitempty"`
	EncryptedUUID string `json:"encryptedUUID,omitempty"`
}

type LoginResponse struct {
	SessionID       string `json:"sessionId,omitempty"`
	Error           string `json:"error,omitempty"`
	Challenge       string `json:"challenge,omitempty"`
	ServerPublicKey string `json:"serverPublicKey,omitempty"`
}

type DeleteUserRequest struct {
	Username  string `json:"username"`
	SessionID string `json:"sessionId"`
}

type DeleteUserResponse struct {
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
}

type PersistedState struct {
	Messages    Messages          `json:"messages"`
	Rooms       []string          `json:"rooms"`
	Users       map[string]string `json:"users"`
	UserPubKeys map[string]string `json:"userPubKeys"`
}
