package main

import (
	"crypto/rand"
	"encoding/hex"
	"log"
	"strings"

	socketio "github.com/karagenc/socket.io-go"
	"golang.org/x/crypto/scrypt"
)

func contains(slice []string, item string) bool {
	for _, s := range slice {
		if s == item {
			return true
		}
	}
	return false
}

func formatRoomName(roomNameStr string) string {
	if strings.HasPrefix(roomNameStr, "@") {
		return roomNameStr
	}
	return "#" + roomNameStr
}

func generateSalt() string {
	bytes := make([]byte, 16)
	rand.Read(bytes)
	return hex.EncodeToString(bytes)
}

func hashPassword(password, salt string) (string, error) {
	dk, err := scrypt.Key([]byte(password), []byte(salt), 16384, 8, 1, 32)
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(dk), nil
}

func constantTimeCompare(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	result := 0
	for i := 0; i < len(a); i++ {
		result |= int(a[i]) ^ int(b[i])
	}
	return result == 0
}

func (cs *ChatServer) sendToUsers(defaultNsp *socketio.Namespace, usernames []string, event string, data interface{}) {
	if defaultNsp == nil {
		log.Printf("[sendToUsers] ✗ defaultNsp is nil, cannot send event %s", event)
		return
	}

	cs.mu.RLock()
	defer cs.mu.RUnlock()

	log.Printf("[sendToUsers] Attempting to send %s to users: %v", event, usernames)
	log.Printf("[sendToUsers] Current users map: %v", func() map[string]string {
		usersCopy := make(map[string]string)
		for k, v := range cs.users {
			usersCopy[k] = v
		}
		return usersCopy
	}())

	for _, username := range usernames {
		if socketID, exists := cs.users[username]; exists {
			log.Printf("[sendToUsers] Sending %s to user %s (socketID: %s)", event, username, socketID)
			defaultNsp.To(socketio.Room(socketID)).Emit(event, data)
			log.Printf("[sendToUsers] ✓ Sent %s to user %s (socketID: %s)", event, username, socketID)
		} else {
			log.Printf("[sendToUsers] ✗ User %s not found in active users (available: %v)", username, func() []string {
				users := make([]string, 0, len(cs.users))
				for u := range cs.users {
					users = append(users, u)
				}
				return users
			}())
		}
	}
}

func filterMessagesByVisibility(messages []Message, username string) []Message {
	filtered := []Message{}
	for _, msg := range messages {
		if len(msg.VisibleTo) == 0 {
			filtered = append(filtered, msg)
			continue
		}
		for _, visibleUser := range msg.VisibleTo {
			if visibleUser == username {
				filtered = append(filtered, msg)
				break
			}
		}
	}
	return filtered
}
