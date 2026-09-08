package main

import "testing"

func TestFilterMessagesForJoinTime(t *testing.T) {
	messages := []Message{
		{ID: "old-public", Timestamp: 10, UserID: "author", RoomID: "room", Content: "old"},
		{ID: "old-explicit", Timestamp: 10, UserID: "author", RoomID: "room", Content: "shared", VisibleTo: []string{"new-user"}},
		{ID: "new-public", Timestamp: 20, UserID: "author", RoomID: "room", Content: "new"},
		{ID: "other-explicit", Timestamp: 10, UserID: "author", RoomID: "room", Content: "private", VisibleTo: []string{"other-user"}},
	}

	filtered := filterMessagesForJoinTime(messages, "new-user", 20)
	if len(filtered) != 1 {
		t.Fatalf("expected only post-join public history, got %d", len(filtered))
	}
	if filtered[0].ID != "new-public" {
		t.Fatalf("unexpected join-time filtering result: %+v", filtered)
	}
}

func TestFilterMessagesForJoinTimeUsesOwnJoinMessageBoundary(t *testing.T) {
	messages := []Message{
		{ID: "after-join", Timestamp: 30, UserID: "author", RoomID: "room", Content: "after"},
		{ID: "joined", Timestamp: 20, UserID: SystemUserID, RoomID: "room", Content: "userId:new-user " + UserJoined},
		{ID: "before-join", Timestamp: 10, UserID: "author", RoomID: "room", Content: "before"},
	}

	filtered := filterMessagesForJoinTime(messages, "new-user", 1)
	if len(filtered) != 2 {
		t.Fatalf("expected messages from the user's join onward, got %d", len(filtered))
	}
	if filtered[0].ID != "after-join" || filtered[1].ID != "joined" {
		t.Fatalf("unexpected join-boundary filtering result: %+v", filtered)
	}
}
