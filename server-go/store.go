package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

type FileStore struct {
	filepath string
	mu       sync.Mutex
}

func NewFileStore(filepath string) *FileStore {
	return &FileStore{
		filepath: filepath,
	}
}

func (fs *FileStore) Save(messages Messages, rooms []string, users map[string]string, userPubKeys map[string]string) error {
	return fs.saveWithIdentity(messages, rooms, users, userPubKeys, nil, nil, nil, nil, nil, nil, nil, nil)
}

func (fs *FileStore) SaveWithIdentity(
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
) error {
	return fs.saveWithIdentity(
		messages,
		rooms,
		users,
		userPubKeys,
		userPubKeysUpdatedAt,
		userIDs,
		roomIDs,
		roomNameHashes,
		roomNameCiphertexts,
		usernameCiphertexts,
		userDirectoryUpdatedAt,
		roomDirectoryUpdatedAt,
	)
}

func (fs *FileStore) saveWithIdentity(
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
) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	const maxSaveAttempts = 3

	state := PersistedState{
		Messages:               messages,
		Rooms:                  rooms,
		Users:                  users,
		UserPubKeys:            userPubKeys,
		UserPubKeysUpdatedAt:   userPubKeysUpdatedAt,
		UserIDs:                userIDs,
		RoomIDs:                roomIDs,
		RoomNameHashes:         roomNameHashes,
		RoomNameCiphertexts:    roomNameCiphertexts,
		UsernameCiphertexts:    usernameCiphertexts,
		UserDirectoryUpdatedAt: userDirectoryUpdatedAt,
		RoomDirectoryUpdatedAt: roomDirectoryUpdatedAt,
	}

	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal state: %w", err)
	}

	var lastErr error
	for attempt := 1; attempt <= maxSaveAttempts; attempt++ {
		if err := fs.writeStateFile(data); err != nil {
			lastErr = err
			log.Printf("[FileStore] ✗ Save attempt %d/%d failed for %s: %v", attempt, maxSaveAttempts, fs.filepath, err)
			if attempt < maxSaveAttempts {
				time.Sleep(time.Duration(attempt) * 100 * time.Millisecond)
				continue
			}
			panic(fmt.Sprintf("failed to persist state after %d attempts: %v", maxSaveAttempts, err))
		}

		log.Printf("[FileStore] ✓ State saved to %s", fs.filepath)
		return nil
	}

	if lastErr != nil {
		panic(fmt.Sprintf("failed to persist state after %d attempts: %v", maxSaveAttempts, lastErr))
	}

	return nil
}

func (fs *FileStore) writeStateFile(data []byte) (err error) {

	dir := filepath.Dir(fs.filepath)
	if dir != "." && dir != "" {
		if err := os.MkdirAll(dir, 0755); err != nil {
			return fmt.Errorf("failed to create directory: %w", err)
		}
	}

	file, err := os.OpenFile(fs.filepath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		return fmt.Errorf("failed to open state file: %w", err)
	}
	defer func() {
		if closeErr := file.Close(); closeErr != nil && err == nil {
			err = fmt.Errorf("failed to close state file: %w", closeErr)
		}
	}()

	if _, err = file.Write(data); err != nil {
		return fmt.Errorf("failed to write state file: %w", err)
	}

	if err = file.Sync(); err != nil {
		return fmt.Errorf("failed to sync state file: %w", err)
	}
	return nil
}

func roomNameHashForMigration(roomName string) string {
	normalized := strings.TrimSpace(strings.ToLower(roomName))
	if normalized == "" {
		return ""
	}
	hash := sha256.Sum256([]byte(normalized))
	return hex.EncodeToString(hash[:])
}

func (fs *FileStore) Load() (Messages, []string, map[string]string, map[string]string, map[string]int64, map[string]string, map[string]string, map[string]string, map[string]string, map[string]string, map[string]int64, map[string]int64, error) {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	data, err := os.ReadFile(fs.filepath)
	if err != nil {
		if os.IsNotExist(err) {
			log.Printf("[FileStore] State file %s does not exist, starting with empty state", fs.filepath)
			return make(Messages), []string{}, make(map[string]string), make(map[string]string), make(map[string]int64), make(map[string]string), make(map[string]string), make(map[string]string), make(map[string]string), make(map[string]string), make(map[string]int64), make(map[string]int64), nil
		}
		return nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, fmt.Errorf("failed to read state file: %w", err)
	}

	var state PersistedState
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, fmt.Errorf("failed to unmarshal state: %w", err)
	}

	filteredRooms := make([]string, 0, len(state.Rooms))
	seenRooms := make(map[string]struct{}, len(state.Rooms))
	for _, room := range state.Rooms {
		if strings.EqualFold(strings.TrimSpace(room), "#cats") {
			continue
		}
		if strings.EqualFold(strings.TrimSpace(room), "#general") {
			room = "general"
		}
		if _, exists := seenRooms[room]; exists {
			continue
		}
		seenRooms[room] = struct{}{}
		filteredRooms = append(filteredRooms, room)
	}
	state.Rooms = filteredRooms
	if state.Messages != nil {
		if generalMessages, ok := state.Messages["#general"]; ok {
			state.Messages["general"] = append(state.Messages["general"], generalMessages...)
			delete(state.Messages, "#general")
		}
	}
	if state.Messages != nil {
		delete(state.Messages, "#cats")
	}
	if state.RoomIDs != nil {
		if roomID, ok := state.RoomIDs["#general"]; ok {
			state.RoomIDs["general"] = roomID
			delete(state.RoomIDs, "#general")
		}
		delete(state.RoomIDs, "#cats")
	}
	if state.RoomNameHashes != nil {
		if roomID, ok := state.RoomIDs["general"]; ok && roomID != "" {
			for hash, candidateRoomID := range state.RoomNameHashes {
				if candidateRoomID == roomID {
					delete(state.RoomNameHashes, hash)
				}
			}
			if generalHash := roomNameHashForMigration("general"); generalHash != "" {
				state.RoomNameHashes[generalHash] = roomID
			}
		}
	}

	if state.Messages == nil {
		state.Messages = make(Messages)
	}
	if state.Users == nil {
		state.Users = make(map[string]string)
	}
	if state.UserPubKeys == nil {
		state.UserPubKeys = make(map[string]string)
	}
	if state.UserIDs == nil {
		state.UserIDs = make(map[string]string)
	}
	if state.UserPubKeysUpdatedAt == nil {
		state.UserPubKeysUpdatedAt = make(map[string]int64)
	}
	if state.RoomIDs == nil {
		state.RoomIDs = make(map[string]string)
	}
	if state.RoomNameHashes == nil {
		state.RoomNameHashes = make(map[string]string)
	}
	if state.RoomNameCiphertexts == nil {
		state.RoomNameCiphertexts = make(map[string]string)
	}
	if state.UsernameCiphertexts == nil {
		state.UsernameCiphertexts = make(map[string]string)
	}
	if state.UserDirectoryUpdatedAt == nil {
		state.UserDirectoryUpdatedAt = make(map[string]int64)
	}
	if state.RoomDirectoryUpdatedAt == nil {
		state.RoomDirectoryUpdatedAt = make(map[string]int64)
	}

	for room, roomMessages := range state.Messages {
		changed := false
		roomID, hasRoomID := state.RoomIDs[room]
		if !hasRoomID || roomID == "" {
			roomID = uuid.NewString()
			state.RoomIDs[room] = roomID
		}
		for i := range roomMessages {
			if roomMessages[i].ID == "" {
				roomMessages[i].ID = uuid.NewString()
				changed = true
			}
			if roomMessages[i].RoomID == "" {
				roomMessages[i].RoomID = roomID
				changed = true
			}
			if roomMessages[i].UserID == "" {
				username := strings.TrimSpace(roomMessages[i].Username)
				if username == "" {
					username = "system"
				}
				userID := state.UserIDs[username]
				if userID == "" {
					userID = uuid.NewString()
					state.UserIDs[username] = userID
				}
				roomMessages[i].UserID = userID
				changed = true
			}
		}
		if changed {
			state.Messages[room] = roomMessages
		}
	}

	log.Printf("[FileStore] ✓ State loaded from %s - rooms: %d, users: %d, message rooms: %d, pub keys: %d",
		fs.filepath, len(state.Rooms), len(state.Users), len(state.Messages), len(state.UserPubKeys))

	return state.Messages, state.Rooms, state.Users, state.UserPubKeys, state.UserPubKeysUpdatedAt, state.UserIDs, state.RoomIDs, state.RoomNameHashes, state.RoomNameCiphertexts, state.UsernameCiphertexts, state.UserDirectoryUpdatedAt, state.RoomDirectoryUpdatedAt, nil
}
