package server

import (
	"fmt"
	"path/filepath"
	"testing"
)

func BenchmarkSQLiteStoreSaveWithIdentityHistorySize(b *testing.B) {
	for _, messageCount := range []int{10, 100, 1000} {
		b.Run(fmt.Sprintf("messages_%d", messageCount), func(b *testing.B) {
			store, err := NewSQLiteStore(filepath.Join(b.TempDir(), "chat-state.sqlite3"))
			if err != nil {
				b.Fatalf("NewSQLiteStore failed: %v", err)
			}
			b.Cleanup(func() { _ = store.Close() })

			messages := make([]Message, messageCount)
			for index := range messages {
				messages[index] = Message{
					ID:               fmt.Sprintf("message-%d", index),
					Timestamp:        int64(index + 1),
					UserID:           "user-1",
					RoomID:           "room-general",
					EncryptedMessage: "ciphertext",
				}
			}

			state := Messages{"general": messages}
			rooms := []string{"general"}
			users := map[string]string{"user-1": "user-1"}
			publicKeys := map[string]string{"user-1": "public-key"}
			roomIDs := map[string]string{"general": "room-general"}

			b.ReportAllocs()
			b.ResetTimer()
			for iteration := 0; iteration < b.N; iteration++ {
				if err := store.SaveWithIdentity(
					state,
					rooms,
					users,
					publicKeys,
					nil,
					nil,
					roomIDs,
					nil,
					nil,
					nil,
					nil,
					nil,
				); err != nil {
					b.Fatalf("SaveWithIdentity failed: %v", err)
				}
			}
		})
	}
}

func BenchmarkSQLiteStoreSaveMessageHistorySize(b *testing.B) {
	for _, messageCount := range []int{10, 100, 1000} {
		b.Run(fmt.Sprintf("messages_%d", messageCount), func(b *testing.B) {
			store, err := NewSQLiteStore(filepath.Join(b.TempDir(), "chat-state.sqlite3"))
			if err != nil {
				b.Fatalf("NewSQLiteStore failed: %v", err)
			}
			b.Cleanup(func() { _ = store.Close() })

			messages := make([]Message, messageCount)
			for index := range messages {
				messages[index] = Message{ID: fmt.Sprintf("seed-%d", index), Timestamp: int64(index + 1), UserID: "user-1", RoomID: "room-general", EncryptedMessage: "ciphertext"}
			}
			if err := store.SaveWithIdentity(Messages{"general": messages}, []string{"general"}, map[string]string{"user-1": "user-1"}, nil, nil, nil, map[string]string{"general": "room-general"}, nil, nil, nil, nil, nil); err != nil {
				b.Fatalf("seed state: %v", err)
			}
			metadata := MessagePersistenceMetadata{RoomKey: "general"}

			b.ReportAllocs()
			b.ResetTimer()
			for iteration := 0; iteration < b.N; iteration++ {
				message := Message{ID: fmt.Sprintf("new-%d", iteration), Timestamp: int64(messageCount + iteration + 1), Username: "user-1", UserID: "user-1", RoomID: "room-general", EncryptedMessage: "ciphertext"}
				if err := store.SaveMessage(message, metadata); err != nil {
					b.Fatalf("SaveMessage failed: %v", err)
				}
			}
		})
	}
}
