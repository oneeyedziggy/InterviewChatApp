package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	_ "modernc.org/sqlite"
)

const sqliteSchema = `
CREATE TABLE IF NOT EXISTS users (
	user_id TEXT NOT NULL PRIMARY KEY,
	username TEXT NOT NULL DEFAULT '',
	public_key TEXT,
	public_key_updated_at INTEGER NOT NULL DEFAULT 0,
	username_ciphertext TEXT,
	directory_updated_at INTEGER NOT NULL DEFAULT 0,
	invited_by_user_id TEXT,
	joined_at INTEGER NOT NULL DEFAULT 0,
	updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
	room_id TEXT NOT NULL PRIMARY KEY,
	room_key TEXT NOT NULL UNIQUE,
	room_name_hash TEXT,
	room_name_ciphertext TEXT,
	directory_updated_at INTEGER NOT NULL DEFAULT 0,
	room_order INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL DEFAULT 0,
	updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
	message_id TEXT NOT NULL PRIMARY KEY,
	room_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	content TEXT,
	key_transfer_encrypted_package TEXT,
	key_transfer_from_user_id TEXT,
	encrypted_message TEXT,
	encrypted_for_json TEXT,
	versions_json TEXT,
	current_version INTEGER,
	visible_to_json TEXT,
	reply_to INTEGER,
	vote_total INTEGER,
	user_votes_json TEXT,
	edited INTEGER NOT NULL DEFAULT 0,
	deleted INTEGER NOT NULL DEFAULT 0,
	updated_at INTEGER NOT NULL,
	FOREIGN KEY(room_id) REFERENCES rooms(room_id) ON DELETE CASCADE,
	FOREIGN KEY(user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_user_created_at
ON messages(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_room_created_at
ON messages(room_id, created_at DESC);

CREATE TABLE IF NOT EXISTS invites (
	invite_id TEXT NOT NULL PRIMARY KEY,
	code_hash TEXT NOT NULL UNIQUE,
	created_by_user_id TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	status TEXT NOT NULL DEFAULT 'active',
	max_uses INTEGER,
	used_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_invites_code_hash
ON invites(code_hash);

CREATE TABLE IF NOT EXISTS access_grant_requests (
	request_id TEXT NOT NULL PRIMARY KEY,
	requesting_user_id TEXT NOT NULL,
	original_sender_id TEXT NOT NULL,
	original_room_id TEXT NOT NULL,
	message_timestamp INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_access_grant_requests_unique
ON access_grant_requests(requesting_user_id, original_sender_id, original_room_id, message_timestamp, status);

CREATE TABLE IF NOT EXISTS message_history (
	history_id INTEGER PRIMARY KEY AUTOINCREMENT,
	message_id TEXT NOT NULL,
	room_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	content TEXT,
	key_transfer_encrypted_package TEXT,
	key_transfer_from_user_id TEXT,
	encrypted_message TEXT,
	encrypted_for_json TEXT,
	versions_json TEXT,
	current_version INTEGER,
	visible_to_json TEXT,
	reply_to INTEGER,
	vote_total INTEGER,
	user_votes_json TEXT,
	edited INTEGER NOT NULL,
	deleted INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	FOREIGN KEY(message_id) REFERENCES messages(message_id) ON DELETE CASCADE
);

CREATE TRIGGER IF NOT EXISTS trg_message_index_history_on_update
BEFORE UPDATE ON messages
FOR EACH ROW
WHEN
	COALESCE(OLD.content, '') <> COALESCE(NEW.content, '')
	OR COALESCE(OLD.key_transfer_encrypted_package, '') <> COALESCE(NEW.key_transfer_encrypted_package, '')
	OR COALESCE(OLD.key_transfer_from_user_id, '') <> COALESCE(NEW.key_transfer_from_user_id, '')
	OR COALESCE(OLD.encrypted_message, '') <> COALESCE(NEW.encrypted_message, '')
	OR COALESCE(OLD.encrypted_for_json, '') <> COALESCE(NEW.encrypted_for_json, '')
	OR COALESCE(OLD.versions_json, '') <> COALESCE(NEW.versions_json, '')
	OR COALESCE(OLD.current_version, -1) <> COALESCE(NEW.current_version, -1)
	OR COALESCE(OLD.visible_to_json, '') <> COALESCE(NEW.visible_to_json, '')
	OR COALESCE(OLD.reply_to, -1) <> COALESCE(NEW.reply_to, -1)
	OR OLD.edited <> NEW.edited
	OR OLD.deleted <> NEW.deleted
BEGIN
	INSERT INTO message_history (
		message_id,
		room_id,
		user_id,
		created_at,
		content,
		key_transfer_encrypted_package,
		key_transfer_from_user_id,
		encrypted_message,
		encrypted_for_json,
		versions_json,
		current_version,
		visible_to_json,
		reply_to,
		vote_total,
		user_votes_json,
		edited,
		deleted,
		updated_at
	)
	VALUES (
		OLD.message_id,
		OLD.room_id,
		OLD.user_id,
		OLD.created_at,
		OLD.content,
		OLD.key_transfer_encrypted_package,
		OLD.key_transfer_from_user_id,
		OLD.encrypted_message,
		OLD.encrypted_for_json,
		OLD.versions_json,
		OLD.current_version,
		OLD.visible_to_json,
		OLD.reply_to,
		OLD.vote_total,
		OLD.user_votes_json,
		OLD.edited,
		OLD.deleted,
		CAST(strftime('%s', 'now') AS INTEGER)
	);
END;
`

type SQLiteStore struct {
	filepath string
	db       *sql.DB
	mu       sync.Mutex
}

func (s *SQLiteStore) Close() error {
	return s.db.Close()
}

func NewSQLiteStore(path string) (*SQLiteStore, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite db: %w", err)
	}

	store := &SQLiteStore{filepath: path, db: db}
	if err := store.init(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

func (s *SQLiteStore) init() error {
	pragmas := []string{
		"PRAGMA journal_mode = WAL;",
		"PRAGMA busy_timeout = 5000;",
		"PRAGMA synchronous = NORMAL;",
		"PRAGMA cache_size = 1000000000;",
		"PRAGMA foreign_keys = true;",
		"PRAGMA temp_store = memory;",
	}
	for _, pragma := range pragmas {
		if _, err := s.db.Exec(pragma); err != nil {
			return fmt.Errorf("apply pragma %q: %w", pragma, err)
		}
	}
	if _, err := s.db.Exec(sqliteSchema); err != nil {
		return fmt.Errorf("initialize sqlite schema: %w", err)
	}
	if err := s.migrateTextPrimaryKeysNotNull(); err != nil {
		return err
	}
	if err := s.migrateAddRoomCreatedAtAndInvitedBy(); err != nil {
		return err
	}
	return nil
}

// migrateAddRoomCreatedAtAndInvitedBy adds columns introduced for multi-server
// invites/oldest-room support to databases created before they existed, and
// backfills rooms.created_at from updated_at as a best-effort approximation.
func (s *SQLiteStore) migrateAddRoomCreatedAtAndInvitedBy() error {
	hasCreatedAt, err := s.hasColumn("rooms", "created_at")
	if err != nil {
		return err
	}
	if !hasCreatedAt {
		if _, err := s.db.Exec(`ALTER TABLE rooms ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;`); err != nil {
			return fmt.Errorf("add rooms.created_at column: %w", err)
		}
	}
	if _, err := s.db.Exec(`UPDATE rooms SET created_at = updated_at WHERE created_at = 0;`); err != nil {
		return fmt.Errorf("backfill rooms.created_at: %w", err)
	}

	hasInvitedBy, err := s.hasColumn("users", "invited_by_user_id")
	if err != nil {
		return err
	}
	if !hasInvitedBy {
		if _, err := s.db.Exec(`ALTER TABLE users ADD COLUMN invited_by_user_id TEXT;`); err != nil {
			return fmt.Errorf("add users.invited_by_user_id column: %w", err)
		}
	}
	hasJoinedAt, err := s.hasColumn("users", "joined_at")
	if err != nil {
		return err
	}
	if !hasJoinedAt {
		if _, err := s.db.Exec(`ALTER TABLE users ADD COLUMN joined_at INTEGER NOT NULL DEFAULT 0;`); err != nil {
			return fmt.Errorf("add users.joined_at column: %w", err)
		}
	}
	if _, err := s.db.Exec(`UPDATE users SET joined_at = CASE WHEN updated_at > 0 THEN updated_at ELSE CAST(strftime('%s', 'now') AS INTEGER) END WHERE joined_at = 0;`); err != nil {
		return fmt.Errorf("backfill users.joined_at: %w", err)
	}
	return nil
}

func (s *SQLiteStore) hasColumn(table, column string) (bool, error) {
	rows, err := s.db.Query(fmt.Sprintf(`PRAGMA table_info(%s)`, table))
	if err != nil {
		return false, fmt.Errorf("inspect %s table info: %w", table, err)
	}
	defer rows.Close()

	for rows.Next() {
		var cid int
		var name string
		var columnType string
		var notNull int
		var defaultValue sql.NullString
		var primaryKeyPosition int
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKeyPosition); err != nil {
			return false, fmt.Errorf("scan %s table info: %w", table, err)
		}
		if name == column {
			return true, nil
		}
	}
	if err := rows.Err(); err != nil {
		return false, fmt.Errorf("iterate %s table info: %w", table, err)
	}
	return false, nil
}

func (s *SQLiteStore) migrateTextPrimaryKeysNotNull() error {
	needsMigration, err := s.needsTextPrimaryKeyMigration()
	if err != nil {
		return err
	}
	if !needsMigration {
		return nil
	}

	for table, column := range map[string]string{
		"users":    "user_id",
		"rooms":    "room_id",
		"messages": "message_id",
	} {
		nullCount, err := s.countNullPrimaryKeys(table, column)
		if err != nil {
			return err
		}
		if nullCount > 0 {
			return fmt.Errorf("cannot migrate %s.%s to NOT NULL primary key: found %d null values", table, column, nullCount)
		}
	}

	if _, err := s.db.Exec(`PRAGMA foreign_keys = OFF;`); err != nil {
		return fmt.Errorf("disable foreign keys for primary key migration: %w", err)
	}
	defer func() {
		if _, err := s.db.Exec(`PRAGMA foreign_keys = ON;`); err != nil {
			log.Printf("[SQLiteStore] failed to restore foreign keys after primary key migration: %v", err)
		}
	}()

	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin primary key migration: %w", err)
	}
	defer func() {
		if tx != nil {
			_ = tx.Rollback()
		}
	}()

	migrationSQL := `
DROP TRIGGER IF EXISTS trg_message_index_history_on_update;
DROP INDEX IF EXISTS idx_messages_user_created_at;
DROP INDEX IF EXISTS idx_messages_room_created_at;
ALTER TABLE message_history RENAME TO message_history_pk_migration_old;
ALTER TABLE messages RENAME TO messages_pk_migration_old;
ALTER TABLE rooms RENAME TO rooms_pk_migration_old;
ALTER TABLE users RENAME TO users_pk_migration_old;
`
	if _, err := tx.Exec(migrationSQL); err != nil {
		return fmt.Errorf("prepare primary key migration tables: %w", err)
	}
	if _, err := tx.Exec(sqliteSchema); err != nil {
		return fmt.Errorf("create migrated primary key schema: %w", err)
	}

	copySQL := `
INSERT INTO users (user_id, username, public_key, public_key_updated_at, username_ciphertext, directory_updated_at, updated_at)
SELECT user_id, username, public_key, public_key_updated_at, username_ciphertext, directory_updated_at, updated_at
FROM users_pk_migration_old;

INSERT INTO rooms (room_id, room_key, room_name_hash, room_name_ciphertext, directory_updated_at, room_order, updated_at)
SELECT room_id, room_key, room_name_hash, room_name_ciphertext, directory_updated_at, room_order, updated_at
FROM rooms_pk_migration_old;

INSERT INTO messages (
	message_id,
	room_id,
	user_id,
	created_at,
	content,
	key_transfer_encrypted_package,
	key_transfer_from_user_id,
	encrypted_message,
	encrypted_for_json,
	versions_json,
	current_version,
	visible_to_json,
	reply_to,
	vote_total,
	user_votes_json,
	edited,
	deleted,
	updated_at
)
SELECT
	message_id,
	room_id,
	user_id,
	created_at,
	content,
	key_transfer_encrypted_package,
	key_transfer_from_user_id,
	encrypted_message,
	encrypted_for_json,
	versions_json,
	current_version,
	visible_to_json,
	reply_to,
	vote_total,
	user_votes_json,
	edited,
	deleted,
	updated_at
FROM messages_pk_migration_old;

INSERT INTO message_history (
	history_id,
	message_id,
	room_id,
	user_id,
	created_at,
	content,
	key_transfer_encrypted_package,
	key_transfer_from_user_id,
	encrypted_message,
	encrypted_for_json,
	versions_json,
	current_version,
	visible_to_json,
	reply_to,
	vote_total,
	user_votes_json,
	edited,
	deleted,
	updated_at
)
SELECT
	history_id,
	message_id,
	room_id,
	user_id,
	created_at,
	content,
	key_transfer_encrypted_package,
	key_transfer_from_user_id,
	encrypted_message,
	encrypted_for_json,
	versions_json,
	current_version,
	visible_to_json,
	reply_to,
	vote_total,
	user_votes_json,
	edited,
	deleted,
	updated_at
FROM message_history_pk_migration_old;

DROP TABLE users_pk_migration_old;
DROP TABLE rooms_pk_migration_old;
DROP TABLE messages_pk_migration_old;
DROP TABLE message_history_pk_migration_old;
`
	if _, err := tx.Exec(copySQL); err != nil {
		return fmt.Errorf("copy primary key migration data: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit primary key migration: %w", err)
	}
	tx = nil

	log.Printf("[SQLiteStore] migrated text primary keys to explicit NOT NULL constraints")
	return nil
}

func (s *SQLiteStore) needsTextPrimaryKeyMigration() (bool, error) {
	checks := map[string]string{
		"users":    "user_id",
		"rooms":    "room_id",
		"messages": "message_id",
	}
	for table, column := range checks {
		isNotNull, err := s.columnIsNotNull(table, column)
		if err != nil {
			return false, err
		}
		if !isNotNull {
			return true, nil
		}
	}
	return false, nil
}

func (s *SQLiteStore) columnIsNotNull(table, column string) (bool, error) {
	rows, err := s.db.Query(fmt.Sprintf(`PRAGMA table_info(%s)`, table))
	if err != nil {
		return false, fmt.Errorf("inspect %s table info: %w", table, err)
	}
	defer rows.Close()

	for rows.Next() {
		var cid int
		var name string
		var columnType string
		var notNull int
		var defaultValue sql.NullString
		var primaryKeyPosition int
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKeyPosition); err != nil {
			return false, fmt.Errorf("scan %s table info: %w", table, err)
		}
		if name == column {
			return notNull != 0, nil
		}
	}
	if err := rows.Err(); err != nil {
		return false, fmt.Errorf("iterate %s table info: %w", table, err)
	}
	return false, fmt.Errorf("column %s.%s not found", table, column)
}

func (s *SQLiteStore) countNullPrimaryKeys(table, column string) (int, error) {
	var count int
	query := fmt.Sprintf(`SELECT COUNT(1) FROM %s WHERE %s IS NULL`, table, column)
	if err := s.db.QueryRow(query).Scan(&count); err != nil {
		return 0, fmt.Errorf("count null primary keys in %s.%s: %w", table, column, err)
	}
	return count, nil
}

func (s *SQLiteStore) Save(messages Messages, rooms []string, users map[string]string, userPubKeys map[string]string) error {
	return s.SaveWithIdentity(messages, rooms, users, userPubKeys, nil, nil, nil, nil, nil, nil, nil, nil)
}

func (s *SQLiteStore) SaveWithIdentity(
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
	start := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()

	if messages == nil {
		messages = make(Messages)
	}
	if rooms == nil {
		rooms = []string{}
	}
	if users == nil {
		users = make(map[string]string)
	}
	if userPubKeys == nil {
		userPubKeys = make(map[string]string)
	}
	if userPubKeysUpdatedAt == nil {
		userPubKeysUpdatedAt = make(map[string]int64)
	}
	if userIDs == nil {
		userIDs = make(map[string]string)
	}
	if roomIDs == nil {
		roomIDs = make(map[string]string)
	}
	if roomNameHashes == nil {
		roomNameHashes = make(map[string]string)
	}
	if roomNameCiphertexts == nil {
		roomNameCiphertexts = make(map[string]string)
	}
	if usernameCiphertexts == nil {
		usernameCiphertexts = make(map[string]string)
	}
	if userDirectoryUpdatedAt == nil {
		userDirectoryUpdatedAt = make(map[string]int64)
	}
	if roomDirectoryUpdatedAt == nil {
		roomDirectoryUpdatedAt = make(map[string]int64)
	}

	nowUnix := time.Now().Unix()

	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin sqlite transaction: %w", err)
	}
	defer func() {
		if tx != nil {
			_ = tx.Rollback()
		}
	}()

	if _, err := tx.Exec(`CREATE TEMP TABLE IF NOT EXISTS current_message_ids (id TEXT PRIMARY KEY)`); err != nil {
		return fmt.Errorf("create temp message id table: %w", err)
	}
	if _, err := tx.Exec(`DELETE FROM current_message_ids`); err != nil {
		return fmt.Errorf("clear temp message id table: %w", err)
	}
	if _, err := tx.Exec(`CREATE TEMP TABLE IF NOT EXISTS current_room_ids (id TEXT PRIMARY KEY)`); err != nil {
		return fmt.Errorf("create temp room id table: %w", err)
	}
	if _, err := tx.Exec(`DELETE FROM current_room_ids`); err != nil {
		return fmt.Errorf("clear temp room id table: %w", err)
	}
	if _, err := tx.Exec(`CREATE TEMP TABLE IF NOT EXISTS current_user_ids (id TEXT PRIMARY KEY)`); err != nil {
		return fmt.Errorf("create temp user id table: %w", err)
	}
	if _, err := tx.Exec(`DELETE FROM current_user_ids`); err != nil {
		return fmt.Errorf("clear temp user id table: %w", err)
	}

	roomNameByID := make(map[string]string, len(roomIDs))
	for roomName, roomID := range roomIDs {
		roomName = strings.TrimSpace(roomName)
		roomID = strings.TrimSpace(roomID)
		if roomName != "" && roomID != "" {
			roomNameByID[roomID] = roomName
		}
	}

	roomOrder := make(map[string]int, len(rooms)+len(messages))
	nextOrder := 0
	for _, roomName := range rooms {
		trimmed := strings.TrimSpace(roomName)
		if trimmed == "" {
			continue
		}
		if _, seen := roomOrder[trimmed]; !seen {
			roomOrder[trimmed] = nextOrder
			nextOrder++
		}
	}
	for roomName := range messages {
		trimmed := strings.TrimSpace(roomName)
		if trimmed == "" {
			continue
		}
		if _, seen := roomOrder[trimmed]; !seen {
			roomOrder[trimmed] = nextOrder
			nextOrder++
		}
	}

	roomNames := make([]string, 0, len(roomOrder))
	for roomName := range roomOrder {
		roomNames = append(roomNames, roomName)
	}
	sort.Slice(roomNames, func(i, j int) bool {
		return roomOrder[roomNames[i]] < roomOrder[roomNames[j]]
	})

	for _, roomName := range roomNames {
		roomID := strings.TrimSpace(roomIDs[roomName])
		if roomID == "" {
			if strings.HasPrefix(roomName, "@dmid:") {
				roomID = roomName
			} else {
				roomID = uuid.NewString()
			}
			roomIDs[roomName] = roomID
		}
		roomNameByID[roomID] = roomName

		roomHash := roomNameHashForMigration(roomName)
		for hash, hashRoomID := range roomNameHashes {
			if hashRoomID == roomID {
				roomHash = hash
				break
			}
		}

		if _, err := tx.Exec(`
			INSERT INTO rooms (
				room_id,
				room_key,
				room_name_hash,
				room_name_ciphertext,
				directory_updated_at,
				room_order,
				created_at,
				updated_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(room_id) DO UPDATE SET
				room_key = excluded.room_key,
				room_name_hash = excluded.room_name_hash,
				room_name_ciphertext = excluded.room_name_ciphertext,
				directory_updated_at = excluded.directory_updated_at,
				room_order = excluded.room_order,
				updated_at = excluded.updated_at
		`, roomID, roomName, nullableText(roomHash), nullableText(roomNameCiphertexts[roomID]), roomDirectoryUpdatedAt[roomID], roomOrder[roomName], nowUnix, nowUnix); err != nil {
			return fmt.Errorf("upsert room %s: %w", roomName, err)
		}

		if _, err := tx.Exec(`INSERT OR IGNORE INTO current_room_ids (id) VALUES (?)`, roomID); err != nil {
			return fmt.Errorf("track current room id %s: %w", roomID, err)
		}
	}

	derivedUsernameByID := make(map[string]string, len(userIDs))
	for alias, aliasUserID := range userIDs {
		alias = strings.TrimSpace(alias)
		aliasUserID = strings.TrimSpace(aliasUserID)
		if alias != "" && aliasUserID != "" {
			if _, exists := derivedUsernameByID[aliasUserID]; !exists {
				derivedUsernameByID[aliasUserID] = alias
			}
		}
	}

	currentUserIDs := make(map[string]struct{})
	for userID := range users {
		if trimmed := strings.TrimSpace(userID); trimmed != "" {
			currentUserIDs[trimmed] = struct{}{}
		}
	}
	for userID := range userPubKeys {
		if trimmed := strings.TrimSpace(userID); trimmed != "" {
			currentUserIDs[trimmed] = struct{}{}
		}
	}
	for userID := range userPubKeysUpdatedAt {
		if trimmed := strings.TrimSpace(userID); trimmed != "" {
			currentUserIDs[trimmed] = struct{}{}
		}
	}
	for userID := range usernameCiphertexts {
		if trimmed := strings.TrimSpace(userID); trimmed != "" {
			currentUserIDs[trimmed] = struct{}{}
		}
	}
	for userID := range userDirectoryUpdatedAt {
		if trimmed := strings.TrimSpace(userID); trimmed != "" {
			currentUserIDs[trimmed] = struct{}{}
		}
	}
	for _, roomMessages := range messages {
		for _, msg := range roomMessages {
			if trimmed := strings.TrimSpace(msg.UserID); trimmed != "" {
				currentUserIDs[trimmed] = struct{}{}
			}
		}
	}
	for _, aliasUserID := range userIDs {
		if trimmed := strings.TrimSpace(aliasUserID); trimmed != "" {
			currentUserIDs[trimmed] = struct{}{}
		}
	}

	for userID := range currentUserIDs {
		username := strings.TrimSpace(users[userID])
		if username == "" {
			username = strings.TrimSpace(derivedUsernameByID[userID])
		}

		if _, err := tx.Exec(`
			INSERT INTO users (
				user_id,
				username,
				public_key,
				public_key_updated_at,
				username_ciphertext,
				directory_updated_at,
				joined_at,
				updated_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(user_id) DO UPDATE SET
				username = excluded.username,
				public_key = excluded.public_key,
				public_key_updated_at = excluded.public_key_updated_at,
				username_ciphertext = excluded.username_ciphertext,
				directory_updated_at = excluded.directory_updated_at,
				updated_at = excluded.updated_at
		`, userID, username, nullableText(userPubKeys[userID]), userPubKeysUpdatedAt[userID], nullableText(usernameCiphertexts[userID]), userDirectoryUpdatedAt[userID], nowUnix, nowUnix); err != nil {
			return fmt.Errorf("upsert user %s: %w", userID, err)
		}

		if _, err := tx.Exec(`INSERT OR IGNORE INTO current_user_ids (id) VALUES (?)`, userID); err != nil {
			return fmt.Errorf("track current user id %s: %w", userID, err)
		}
	}

	for roomKey, roomMessages := range messages {
		roomKey = strings.TrimSpace(roomKey)
		if roomKey == "" {
			continue
		}

		roomID := strings.TrimSpace(roomIDs[roomKey])
		if roomID == "" {
			if strings.HasPrefix(roomKey, "@dmid:") {
				roomID = roomKey
			} else {
				roomID = uuid.NewString()
			}
			roomIDs[roomKey] = roomID
			roomNameByID[roomID] = roomKey
		}

		if _, err := tx.Exec(`INSERT OR IGNORE INTO current_room_ids (id) VALUES (?)`, roomID); err != nil {
			return fmt.Errorf("track message room id %s: %w", roomID, err)
		}

		for i := range roomMessages {
			msg := roomMessages[i]
			if strings.TrimSpace(msg.ID) == "" {
				msg.ID = uuid.NewString()
			}
			if strings.TrimSpace(msg.RoomID) == "" {
				msg.RoomID = roomID
			}
			if strings.TrimSpace(msg.UserID) == "" {
				msg.UserID = SystemUserID
			}
			if _, err := tx.Exec(`INSERT OR IGNORE INTO current_user_ids (id) VALUES (?)`, msg.UserID); err != nil {
				return fmt.Errorf("track message user id %s: %w", msg.UserID, err)
			}

			if _, err := tx.Exec(`
				INSERT INTO users (user_id, username, public_key, public_key_updated_at, username_ciphertext, directory_updated_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(user_id) DO NOTHING
			`, msg.UserID, "", nil, 0, nil, 0, nowUnix); err != nil {
				return fmt.Errorf("ensure message user %s exists: %w", msg.UserID, err)
			}

			if _, err := tx.Exec(`INSERT OR IGNORE INTO current_message_ids (id) VALUES (?)`, msg.ID); err != nil {
				return fmt.Errorf("track current message id %s: %w", msg.ID, err)
			}

			edited := 0
			if msg.Edited {
				edited = 1
			}
			deleted := 0
			if msg.Deleted {
				deleted = 1
			}

			encryptedForJSON, err := marshalJSON(msg.EncryptedFor)
			if err != nil {
				return fmt.Errorf("marshal encryptedFor for message %s: %w", msg.ID, err)
			}
			versionsJSON, err := marshalJSON(msg.Versions)
			if err != nil {
				return fmt.Errorf("marshal versions for message %s: %w", msg.ID, err)
			}
			visibleToJSON, err := marshalJSON(msg.VisibleTo)
			if err != nil {
				return fmt.Errorf("marshal visibleTo for message %s: %w", msg.ID, err)
			}
			userVotesJSON, err := marshalJSON(msg.UserVotes)
			if err != nil {
				return fmt.Errorf("marshal userVotes for message %s: %w", msg.ID, err)
			}

			var currentVersion interface{}
			if msg.CurrentVersion != nil {
				currentVersion = *msg.CurrentVersion
			}
			var replyTo interface{}
			if msg.ReplyTo != nil {
				replyTo = *msg.ReplyTo
			}
			var voteTotal interface{}
			if msg.VoteTotal != nil {
				voteTotal = *msg.VoteTotal
			}

			if _, err := tx.Exec(`
				INSERT INTO messages (
					message_id,
					room_id,
					user_id,
					created_at,
					content,
					key_transfer_encrypted_package,
					key_transfer_from_user_id,
					encrypted_message,
					encrypted_for_json,
					versions_json,
					current_version,
					visible_to_json,
					reply_to,
					vote_total,
					user_votes_json,
					edited,
					deleted,
					updated_at
				)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(message_id) DO UPDATE SET
					room_id = excluded.room_id,
					user_id = excluded.user_id,
					created_at = excluded.created_at,
					content = excluded.content,
					key_transfer_encrypted_package = excluded.key_transfer_encrypted_package,
					key_transfer_from_user_id = excluded.key_transfer_from_user_id,
					encrypted_message = excluded.encrypted_message,
					encrypted_for_json = excluded.encrypted_for_json,
					versions_json = excluded.versions_json,
					current_version = excluded.current_version,
					visible_to_json = excluded.visible_to_json,
					reply_to = excluded.reply_to,
					vote_total = excluded.vote_total,
					user_votes_json = excluded.user_votes_json,
					edited = excluded.edited,
					deleted = excluded.deleted,
					updated_at = excluded.updated_at
				WHERE
					COALESCE(messages.room_id, '') <> COALESCE(excluded.room_id, '')
					OR COALESCE(messages.user_id, '') <> COALESCE(excluded.user_id, '')
					OR messages.created_at <> excluded.created_at
					OR COALESCE(messages.content, '') <> COALESCE(excluded.content, '')
					OR COALESCE(messages.key_transfer_encrypted_package, '') <> COALESCE(excluded.key_transfer_encrypted_package, '')
					OR COALESCE(messages.key_transfer_from_user_id, '') <> COALESCE(excluded.key_transfer_from_user_id, '')
					OR COALESCE(messages.encrypted_message, '') <> COALESCE(excluded.encrypted_message, '')
					OR COALESCE(messages.encrypted_for_json, '') <> COALESCE(excluded.encrypted_for_json, '')
					OR COALESCE(messages.versions_json, '') <> COALESCE(excluded.versions_json, '')
					OR COALESCE(messages.current_version, -1) <> COALESCE(excluded.current_version, -1)
					OR COALESCE(messages.visible_to_json, '') <> COALESCE(excluded.visible_to_json, '')
					OR COALESCE(messages.reply_to, -1) <> COALESCE(excluded.reply_to, -1)
					OR COALESCE(messages.vote_total, -1) <> COALESCE(excluded.vote_total, -1)
					OR COALESCE(messages.user_votes_json, '') <> COALESCE(excluded.user_votes_json, '')
					OR messages.edited <> excluded.edited
					OR messages.deleted <> excluded.deleted
			`,
				msg.ID,
				msg.RoomID,
				msg.UserID,
				msg.Timestamp,
				nullableText(msg.Content),
				nullableText(msg.KeyTransferEncryptedPackage),
				nullableText(msg.KeyTransferFromUserID),
				msg.EncryptedMessage,
				nullableText(encryptedForJSON),
				nullableText(versionsJSON),
				currentVersion,
				nullableText(visibleToJSON),
				replyTo,
				voteTotal,
				nullableText(userVotesJSON),
				edited,
				deleted,
				nowUnix,
			); err != nil {
				return fmt.Errorf("upsert message row %s: %w", msg.ID, err)
			}
		}
	}

	if _, err := tx.Exec(`DELETE FROM messages WHERE message_id NOT IN (SELECT id FROM current_message_ids)`); err != nil {
		return fmt.Errorf("prune stale message rows: %w", err)
	}
	if _, err := tx.Exec(`DELETE FROM rooms WHERE room_id NOT IN (SELECT id FROM current_room_ids)`); err != nil {
		return fmt.Errorf("prune stale room rows: %w", err)
	}
	if _, err := tx.Exec(`DELETE FROM users WHERE user_id NOT IN (SELECT id FROM current_user_ids)`); err != nil {
		return fmt.Errorf("prune stale user rows: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit sqlite transaction: %w", err)
	}
	tx = nil

	log.Printf("[SQLiteStore] ✓ State saved to %s", s.filepath)
	elapsed := time.Since(start)
	log.Printf("[metrics][SQLiteStore] op=save path=%s elapsed_us=%d elapsed_ms=%.3f rooms=%d users=%d message_rooms=%d", s.filepath, elapsed.Microseconds(), float64(elapsed.Microseconds())/1000.0, len(roomNames), len(currentUserIDs), len(messages))
	return nil
}

func (s *SQLiteStore) Load() (Messages, []string, map[string]string, map[string]string, map[string]int64, map[string]string, map[string]string, map[string]string, map[string]string, map[string]string, map[string]int64, map[string]int64, error) {
	start := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()

	messages := make(Messages)
	rooms := make([]string, 0)
	users := make(map[string]string)
	userPubKeys := make(map[string]string)
	userPubKeysUpdatedAt := make(map[string]int64)
	userIDs := make(map[string]string)
	roomIDs := make(map[string]string)
	roomNameHashes := make(map[string]string)
	roomNameCiphertexts := make(map[string]string)
	usernameCiphertexts := make(map[string]string)
	userDirectoryUpdatedAt := make(map[string]int64)
	roomDirectoryUpdatedAt := make(map[string]int64)

	roomRows, err := s.db.Query(`
		SELECT room_id, room_key, room_name_hash, room_name_ciphertext, directory_updated_at
		FROM rooms
		ORDER BY room_order ASC, updated_at ASC, room_key ASC
	`)
	if err != nil {
		return nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, fmt.Errorf("query rooms: %w", err)
	}
	defer roomRows.Close()
	for roomRows.Next() {
		var roomID string
		var roomKey string
		var roomHash sql.NullString
		var roomCipher sql.NullString
		var roomDirUpdatedAt int64
		if err := roomRows.Scan(&roomID, &roomKey, &roomHash, &roomCipher, &roomDirUpdatedAt); err != nil {
			return nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, fmt.Errorf("scan room row: %w", err)
		}
		trimmedRoomKey := strings.TrimSpace(roomKey)
		if trimmedRoomKey == "" {
			continue
		}
		rooms = append(rooms, trimmedRoomKey)
		roomIDs[trimmedRoomKey] = roomID
		if roomHash.Valid && strings.TrimSpace(roomHash.String) != "" {
			roomNameHashes[roomHash.String] = roomID
		}
		if roomCipher.Valid && strings.TrimSpace(roomCipher.String) != "" {
			roomNameCiphertexts[roomID] = roomCipher.String
		}
		if roomDirUpdatedAt > 0 {
			roomDirectoryUpdatedAt[roomID] = roomDirUpdatedAt
		}
		messages[trimmedRoomKey] = make([]Message, 0)
	}
	if err := roomRows.Err(); err != nil {
		return nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, fmt.Errorf("iterate rooms: %w", err)
	}

	userRows, err := s.db.Query(`
		SELECT user_id, username, public_key, public_key_updated_at, username_ciphertext, directory_updated_at
		FROM users
	`)
	if err != nil {
		return nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, fmt.Errorf("query users: %w", err)
	}
	defer userRows.Close()
	for userRows.Next() {
		var userID string
		var username string
		var publicKey sql.NullString
		var publicKeyUpdatedAt int64
		var usernameCipher sql.NullString
		var userDirUpdatedAt int64
		if err := userRows.Scan(&userID, &username, &publicKey, &publicKeyUpdatedAt, &usernameCipher, &userDirUpdatedAt); err != nil {
			return nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, fmt.Errorf("scan user row: %w", err)
		}
		trimmedUsername := strings.TrimSpace(username)
		users[userID] = trimmedUsername
		if trimmedUsername != "" {
			userIDs[trimmedUsername] = userID
		}
		if publicKey.Valid && strings.TrimSpace(publicKey.String) != "" {
			userPubKeys[userID] = publicKey.String
		}
		if publicKeyUpdatedAt > 0 {
			userPubKeysUpdatedAt[userID] = publicKeyUpdatedAt
		}
		if usernameCipher.Valid && strings.TrimSpace(usernameCipher.String) != "" {
			usernameCiphertexts[userID] = usernameCipher.String
		}
		if userDirUpdatedAt > 0 {
			userDirectoryUpdatedAt[userID] = userDirUpdatedAt
		}
	}
	if err := userRows.Err(); err != nil {
		return nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, fmt.Errorf("iterate users: %w", err)
	}

	messageRows, err := s.db.Query(`
		SELECT
			m.message_id,
			m.created_at,
			m.user_id,
			m.room_id,
			m.content,
			m.key_transfer_encrypted_package,
			m.key_transfer_from_user_id,
			m.encrypted_message,
			m.encrypted_for_json,
			m.versions_json,
			m.current_version,
			m.visible_to_json,
			m.reply_to,
			m.vote_total,
			m.user_votes_json,
			m.edited,
			m.deleted,
			r.room_key,
			u.user_id
		FROM messages m
		JOIN rooms r ON r.room_id = m.room_id
		JOIN users u ON u.user_id = m.user_id
		ORDER BY m.created_at ASC, m.message_id ASC
	`)
	if err != nil {
		return nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, fmt.Errorf("query joined messages: %w", err)
	}
	defer messageRows.Close()
	for messageRows.Next() {
		var msg Message
		var roomKey string
		var joinedUserID string
		var content sql.NullString
		var keyTransferEncryptedPackage sql.NullString
		var keyTransferFromUserID sql.NullString
		var encryptedMessage sql.NullString
		var encryptedForJSON sql.NullString
		var versionsJSON sql.NullString
		var currentVersion sql.NullInt64
		var visibleToJSON sql.NullString
		var replyTo sql.NullInt64
		var voteTotal sql.NullInt64
		var userVotesJSON sql.NullString
		var edited int
		var deleted int
		if err := messageRows.Scan(
			&msg.ID,
			&msg.Timestamp,
			&msg.UserID,
			&msg.RoomID,
			&content,
			&keyTransferEncryptedPackage,
			&keyTransferFromUserID,
			&encryptedMessage,
			&encryptedForJSON,
			&versionsJSON,
			&currentVersion,
			&visibleToJSON,
			&replyTo,
			&voteTotal,
			&userVotesJSON,
			&edited,
			&deleted,
			&roomKey,
			&joinedUserID,
		); err != nil {
			return nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, fmt.Errorf("scan joined message row: %w", err)
		}

		if content.Valid {
			msg.Content = content.String
		}
		if keyTransferEncryptedPackage.Valid {
			msg.KeyTransferEncryptedPackage = keyTransferEncryptedPackage.String
		}
		if keyTransferFromUserID.Valid {
			msg.KeyTransferFromUserID = keyTransferFromUserID.String
		}
		if encryptedMessage.Valid {
			msg.EncryptedMessage = encryptedMessage.String
		}
		if encryptedForJSON.Valid {
			if err := unmarshalJSON(encryptedForJSON.String, &msg.EncryptedFor); err != nil {
				return nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, fmt.Errorf("decode encrypted_for for message %s: %w", msg.ID, err)
			}
		}
		if versionsJSON.Valid {
			if err := unmarshalJSON(versionsJSON.String, &msg.Versions); err != nil {
				return nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, fmt.Errorf("decode versions for message %s: %w", msg.ID, err)
			}
		}
		if currentVersion.Valid {
			v := int(currentVersion.Int64)
			msg.CurrentVersion = &v
		}
		if visibleToJSON.Valid {
			if err := unmarshalJSON(visibleToJSON.String, &msg.VisibleTo); err != nil {
				return nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, fmt.Errorf("decode visible_to for message %s: %w", msg.ID, err)
			}
		}
		if replyTo.Valid {
			v := replyTo.Int64
			msg.ReplyTo = &v
		}
		if voteTotal.Valid {
			v := int(voteTotal.Int64)
			msg.VoteTotal = &v
		}
		if userVotesJSON.Valid {
			if err := unmarshalJSON(userVotesJSON.String, &msg.UserVotes); err != nil {
				return nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, fmt.Errorf("decode user_votes for message %s: %w", msg.ID, err)
			}
		}
		msg.Edited = edited != 0
		msg.Deleted = deleted != 0
		msg.Username = users[msg.UserID]

		roomKey = strings.TrimSpace(roomKey)
		if roomKey == "" {
			roomKey = msg.RoomID
		}
		messages[roomKey] = append(messages[roomKey], msg)
	}
	if err := messageRows.Err(); err != nil {
		return nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, fmt.Errorf("iterate joined messages: %w", err)
	}

	filteredRooms := make([]string, 0, len(rooms))
	seenRooms := make(map[string]struct{}, len(rooms))
	for _, room := range rooms {
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
	rooms = filteredRooms

	if generalMessages, ok := messages["#general"]; ok {
		messages["general"] = append(messages["general"], generalMessages...)
		delete(messages, "#general")
	}
	delete(messages, "#cats")

	if roomID, ok := roomIDs["#general"]; ok {
		roomIDs["general"] = roomID
		delete(roomIDs, "#general")
	}
	delete(roomIDs, "#cats")

	if roomID, ok := roomIDs["general"]; ok && roomID != "" {
		for hash, candidateRoomID := range roomNameHashes {
			if candidateRoomID == roomID {
				delete(roomNameHashes, hash)
			}
		}
		if generalHash := roomNameHashForMigration("general"); generalHash != "" {
			roomNameHashes[generalHash] = roomID
		}
	}

	for room, roomMessages := range messages {
		changed := false
		roomID, hasRoomID := roomIDs[room]
		if !hasRoomID || roomID == "" {
			if strings.HasPrefix(room, "@dmid:") {
				roomID = room
			} else {
				roomID = uuid.NewString()
			}
			roomIDs[room] = roomID
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
				roomMessages[i].UserID = SystemUserID
				changed = true
			}
		}
		if changed {
			messages[room] = roomMessages
		}
	}

	log.Printf("[SQLiteStore] ✓ State loaded from %s - rooms: %d, users: %d, message rooms: %d, pub keys: %d",
		s.filepath, len(rooms), len(users), len(messages), len(userPubKeys))
	elapsed := time.Since(start)
	log.Printf("[metrics][SQLiteStore] op=load path=%s elapsed_us=%d elapsed_ms=%.3f rooms=%d users=%d message_rooms=%d",
		s.filepath, elapsed.Microseconds(), float64(elapsed.Microseconds())/1000.0, len(rooms), len(users), len(messages))

	return messages, rooms, users, userPubKeys, userPubKeysUpdatedAt, userIDs, roomIDs, roomNameHashes, roomNameCiphertexts, usernameCiphertexts, userDirectoryUpdatedAt, roomDirectoryUpdatedAt, nil
}

// RoomCreatedAt returns each room's persisted creation timestamp, keyed by
// room ID, used to reliably determine the oldest room across restarts.
func (s *SQLiteStore) RoomCreatedAt() (map[string]int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	rows, err := s.db.Query(`SELECT room_id, created_at FROM rooms`)
	if err != nil {
		return nil, fmt.Errorf("query room created_at: %w", err)
	}
	defer rows.Close()

	result := make(map[string]int64)
	for rows.Next() {
		var roomID string
		var createdAt int64
		if err := rows.Scan(&roomID, &createdAt); err != nil {
			return nil, fmt.Errorf("scan room created_at: %w", err)
		}
		result[roomID] = createdAt
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate room created_at: %w", err)
	}
	return result, nil
}

func (s *SQLiteStore) UserJoinedAt() (map[string]int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.Query(`SELECT user_id, joined_at FROM users`)
	if err != nil {
		return nil, fmt.Errorf("query user joined_at: %w", err)
	}
	defer rows.Close()
	result := make(map[string]int64)
	for rows.Next() {
		var userID string
		var joinedAt int64
		if err := rows.Scan(&userID, &joinedAt); err != nil {
			return nil, fmt.Errorf("scan user joined_at: %w", err)
		}
		result[userID] = joinedAt
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate user joined_at: %w", err)
	}
	return result, nil
}

// SetInvitedBy records which user invited a newly-registered account. It is
// called once at registration time and never overwritten by SaveWithIdentity.
func (s *SQLiteStore) SetInvitedBy(userID, invitedByUserID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	userID = strings.TrimSpace(userID)
	if userID == "" {
		return fmt.Errorf("SetInvitedBy: empty userID")
	}
	if _, err := s.db.Exec(
		`UPDATE users SET invited_by_user_id = ? WHERE user_id = ?`,
		nullableText(invitedByUserID), userID,
	); err != nil {
		return fmt.Errorf("set invited_by_user_id for %s: %w", userID, err)
	}
	return nil
}

// HasAnyUsers reports whether this server already has at least one
// registered user — new-server bootstrap (first user) skips invite gating,
// everyone after that requires a valid invite.
func (s *SQLiteStore) HasAnyUsers() (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	var count int
	if err := s.db.QueryRow(`SELECT COUNT(1) FROM users`).Scan(&count); err != nil {
		return false, fmt.Errorf("count users: %w", err)
	}
	return count > 0, nil
}

// CreateInvite persists only a hash of the invite code (never the plaintext)
// alongside its expiry and creator, mirroring the existing username-hash
// pattern used elsewhere in this file.
func (s *SQLiteStore) CreateInvite(codeHash, createdByUserID string, createdAt, expiresAt int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var activeCount int
	if err := s.db.QueryRow(`SELECT COUNT(1) FROM invites WHERE created_by_user_id = ? AND status = 'active'`, createdByUserID).Scan(&activeCount); err != nil {
		return fmt.Errorf("count active invites before create: %w", err)
	}
	if activeCount >= 20 {
		return fmt.Errorf("active invite limit reached")
	}

	if _, err := s.db.Exec(
		`INSERT INTO invites (invite_id, code_hash, created_by_user_id, created_at, expires_at, status, max_uses, used_count)
		 VALUES (?, ?, ?, ?, ?, 'active', 1, 0)`,
		uuid.NewString(), codeHash, createdByUserID, createdAt, expiresAt,
	); err != nil {
		return fmt.Errorf("create invite: %w", err)
	}
	return nil
}

func (s *SQLiteStore) ListInvites() ([]InviteSummary, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.Query(`SELECT invite_id, created_by_user_id, created_at, expires_at, status, used_count, max_uses FROM invites ORDER BY created_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("list invites: %w", err)
	}
	defer rows.Close()
	result := []InviteSummary{}
	for rows.Next() {
		var invite InviteSummary
		var maxUses sql.NullInt64
		if err := rows.Scan(&invite.InviteID, &invite.CreatedByUserID, &invite.CreatedAt, &invite.ExpiresAt, &invite.Status, &invite.UsedCount, &maxUses); err != nil {
			return nil, fmt.Errorf("scan invite summary: %w", err)
		}
		if maxUses.Valid {
			invite.MaxUses = &maxUses.Int64
		}
		result = append(result, invite)
	}
	return result, rows.Err()
}

func (s *SQLiteStore) RevokeInvite(inviteID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.db.Exec(`UPDATE invites SET status = 'revoked' WHERE invite_id = ? AND status = 'active'`, inviteID); err != nil {
		return fmt.Errorf("revoke invite: %w", err)
	}
	return nil
}

func (s *SQLiteStore) ActiveInvitesByUser(userID string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var count int
	if err := s.db.QueryRow(`SELECT COUNT(1) FROM invites WHERE created_by_user_id = ? AND status = 'active'`, userID).Scan(&count); err != nil {
		return 0, fmt.Errorf("count active invites: %w", err)
	}
	return count, nil
}

// ConsumeInvite validates an invite by its code hash (active, unexpired, and
// with remaining uses) and atomically marks it consumed. It returns ok=false
// (with no error) for any invalid/expired/already-used code — callers must
// not distinguish these cases to avoid leaking invite existence.
func (s *SQLiteStore) ConsumeInvite(codeHash string, now int64) (createdByUserID string, ok bool, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return "", false, fmt.Errorf("begin consume invite transaction: %w", err)
	}
	defer func() {
		if tx != nil {
			_ = tx.Rollback()
		}
	}()

	var (
		inviteID  string
		status    string
		expiresAt int64
		maxUses   sql.NullInt64
		usedCount int
		createdBy string
	)
	row := tx.QueryRow(
		`SELECT invite_id, status, expires_at, max_uses, used_count, created_by_user_id
		 FROM invites WHERE code_hash = ?`, codeHash,
	)
	if err := row.Scan(&inviteID, &status, &expiresAt, &maxUses, &usedCount, &createdBy); err != nil {
		if err == sql.ErrNoRows {
			return "", false, nil
		}
		return "", false, fmt.Errorf("lookup invite: %w", err)
	}

	if status != "active" || expiresAt <= now || (maxUses.Valid && int64(usedCount) >= maxUses.Int64) {
		return "", false, nil
	}

	newUsedCount := usedCount + 1
	newStatus := "active"
	if maxUses.Valid && int64(newUsedCount) >= maxUses.Int64 {
		newStatus = "used"
	}
	if _, err := tx.Exec(
		`UPDATE invites SET used_count = ?, status = ? WHERE invite_id = ?`,
		newUsedCount, newStatus, inviteID,
	); err != nil {
		return "", false, fmt.Errorf("mark invite consumed: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return "", false, fmt.Errorf("commit consume invite: %w", err)
	}
	tx = nil

	return createdBy, true, nil
}

func (s *SQLiteStore) QueueAccessGrantRequest(requestingUserID, originalSenderID, originalRoomID string, messageTimestamp, createdAt int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`INSERT OR IGNORE INTO access_grant_requests
		(request_id, requesting_user_id, original_sender_id, original_room_id, message_timestamp, created_at, status)
		VALUES (?, ?, ?, ?, ?, ?, 'pending')`, uuid.NewString(), requestingUserID, originalSenderID, originalRoomID, messageTimestamp, createdAt)
	if err != nil {
		return fmt.Errorf("queue access grant request: %w", err)
	}
	return nil
}

type AccessGrantRequest struct {
	RequestID string
	RequestingUserID string
	OriginalSenderID string
	OriginalRoomID string
	MessageTimestamp int64
	CreatedAt int64
}

func (s *SQLiteStore) PendingAccessGrantRequestsForUser(userID string) ([]AccessGrantRequest, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.Query(`SELECT request_id, requesting_user_id, original_sender_id, original_room_id, message_timestamp, created_at
		FROM access_grant_requests WHERE original_sender_id = ? AND status = 'pending' ORDER BY created_at ASC`, userID)
	if err != nil {
		return nil, fmt.Errorf("query pending access grant requests: %w", err)
	}
	defer rows.Close()
	requests := []AccessGrantRequest{}
	for rows.Next() {
		var request AccessGrantRequest
		if err := rows.Scan(&request.RequestID, &request.RequestingUserID, &request.OriginalSenderID, &request.OriginalRoomID, &request.MessageTimestamp, &request.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan pending access grant request: %w", err)
		}
		requests = append(requests, request)
	}
	return requests, rows.Err()
}

func (s *SQLiteStore) CompleteAccessGrantRequest(requestID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.db.Exec(`UPDATE access_grant_requests SET status = 'completed' WHERE request_id = ?`, requestID); err != nil {
		return fmt.Errorf("complete access grant request: %w", err)
	}
	return nil
}

func nullableText(value string) interface{} {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return value
}

func marshalJSON(value interface{}) (string, error) {
	if value == nil {
		return "", nil
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	if string(raw) == "null" {
		return "", nil
	}
	return string(raw), nil
}

func unmarshalJSON(raw string, out interface{}) error {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "null" {
		return nil
	}
	return json.Unmarshal([]byte(raw), out)
}
