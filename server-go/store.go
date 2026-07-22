package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"

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
	fs.mu.Lock()
	defer fs.mu.Unlock()

	state := PersistedState{
		Messages:    messages,
		Rooms:       rooms,
		Users:       users,
		UserPubKeys: userPubKeys,
	}

	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal state: %w", err)
	}

	dir := filepath.Dir(fs.filepath)
	if dir != "." && dir != "" {
		if err := os.MkdirAll(dir, 0755); err != nil {
			return fmt.Errorf("failed to create directory: %w", err)
		}
	}

	tmpPath := fs.filepath + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0644); err != nil {
		return fmt.Errorf("failed to write state file: %w", err)
	}

	if err := os.Rename(tmpPath, fs.filepath); err != nil {
		return fmt.Errorf("failed to rename temp file: %w", err)
	}

	log.Printf("[FileStore] ✓ State saved to %s", fs.filepath)
	return nil
}

func (fs *FileStore) Load() (Messages, []string, map[string]string, map[string]string, error) {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	data, err := os.ReadFile(fs.filepath)
	if err != nil {
		if os.IsNotExist(err) {
			log.Printf("[FileStore] State file %s does not exist, starting with empty state", fs.filepath)
			return make(Messages), []string{DefaultRoom, "#cats"}, make(map[string]string), make(map[string]string), nil
		}
		return nil, nil, nil, nil, fmt.Errorf("failed to read state file: %w", err)
	}

	var state PersistedState
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, nil, nil, nil, fmt.Errorf("failed to unmarshal state: %w", err)
	}

	if len(state.Rooms) == 0 {
		state.Rooms = []string{DefaultRoom, "#cats"}
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

	if state.Messages[DefaultRoom] == nil {
		state.Messages[DefaultRoom] = []Message{}
	}
	if state.Messages["#cats"] == nil {
		state.Messages["#cats"] = []Message{}
	}

	for room, roomMessages := range state.Messages {
		changed := false
		for i := range roomMessages {
			if roomMessages[i].ID == "" {
				roomMessages[i].ID = uuid.NewString()
				changed = true
			}
		}
		if changed {
			state.Messages[room] = roomMessages
		}
	}

	log.Printf("[FileStore] ✓ State loaded from %s - rooms: %d, users: %d, message rooms: %d, pub keys: %d",
		fs.filepath, len(state.Rooms), len(state.Users), len(state.Messages), len(state.UserPubKeys))

	return state.Messages, state.Rooms, state.Users, state.UserPubKeys, nil
}
