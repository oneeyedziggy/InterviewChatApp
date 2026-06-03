-- PostgreSQL schema for interviewChatApp server-go state
-- Includes users, rooms, messages, keys, sessions, joins, and metadata.

-- 1. Users and public keys
CREATE TABLE users (
    user_id SERIAL PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    public_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

-- 2. Server key metadata (optional storage for server GPG keys)
CREATE TABLE server_keys (
    key_id SERIAL PRIMARY KEY,
    public_key TEXT NOT NULL,
    private_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Rooms
CREATE TABLE rooms (
    room_id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_by INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. Room membership state
CREATE TABLE room_memberships (
    room_id INTEGER NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    is_creator BOOLEAN NOT NULL DEFAULT FALSE,
    is_moderator BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (room_id, user_id)
);

-- 5. Messages
CREATE TABLE messages (
    message_id BIGSERIAL PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    content TEXT,
    encrypted_for JSONB,
    visible_to JSONB,
    reply_to BIGINT REFERENCES messages(message_id) ON DELETE SET NULL,
    vote_total INTEGER NOT NULL DEFAULT 0,
    edited BOOLEAN NOT NULL DEFAULT FALSE,
    current_version INTEGER NOT NULL DEFAULT 0,
    is_system_message BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX idx_messages_room_created_at ON messages(room_id, created_at DESC);

-- 6. Message versions for edit history
CREATE TABLE message_versions (
    version_id BIGSERIAL PRIMARY KEY,
    message_id BIGINT NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
    version_index INTEGER NOT NULL,
    encrypted_for JSONB,
    change_summary TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (message_id, version_index)
);

-- 7. Message votes by user
CREATE TABLE message_votes (
    message_id BIGINT NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    vote SMALLINT NOT NULL CHECK (vote IN (-1, 1)),
    voted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id)
);

-- 8. Pending join requests and vote tracking
CREATE TYPE join_request_status AS ENUM ('pending', 'approved', 'denied');

CREATE TABLE join_requests (
    request_id SERIAL PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
    requesting_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    status join_request_status NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE join_request_votes (
    request_id INTEGER NOT NULL REFERENCES join_requests(request_id) ON DELETE CASCADE,
    voter_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    vote BOOLEAN NOT NULL,
    voted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (request_id, voter_user_id)
);

-- 9. Session and challenge state
CREATE TABLE user_sessions (
    session_id UUID PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE login_challenges (
    challenge_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username TEXT NOT NULL,
    challenge_value TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);

-- 10. Additional metadata tables
CREATE TABLE user_activity (
    user_id INTEGER PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    last_seen_at TIMESTAMPTZ,
    has_sent_join_msg BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE server_rooms_metadata (
    room_id INTEGER PRIMARY KEY REFERENCES rooms(room_id) ON DELETE CASCADE,
    creator_user_id INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    metadata JSONB
);

-- 11. Useful views
CREATE VIEW room_message_summary AS
SELECT
    m.message_id,
    m.room_id,
    r.name AS room_name,
    u.username AS author,
    m.created_at,
    m.vote_total,
    m.edited
FROM messages m
LEFT JOIN rooms r ON r.room_id = m.room_id
LEFT JOIN users u ON u.user_id = m.user_id;
