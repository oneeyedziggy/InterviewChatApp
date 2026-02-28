# Message Persistence & Multi-Server Strategies

This document outlines strategies for persisting chat messages across server restarts and sharing state between multiple server instances.

## Current State

The Go server currently stores all data in memory:
- `messages`: `map[string][]Message` - in-memory only
- `users`: `map[string]string` - in-memory only
- `rooms`: `[]string` - in-memory only

**Problem**: All data is lost on server restart, and multiple server instances don't share state.

---

## Strategy 1: Database Persistence (Recommended for Production)

### Overview
Store all messages, users, and rooms in a database. Each server instance reads/writes to the same database.

### Pros
- ✅ Persistent across restarts
- ✅ Shared state across servers
- ✅ Query capabilities (search, pagination, filtering)
- ✅ ACID transactions
- ✅ Backup and recovery

### Cons
- ❌ Requires database setup/maintenance
- ❌ Network latency for each write
- ❌ More complex than in-memory

### Implementation Options

#### A. PostgreSQL (Recommended)
```go
// Example schema
CREATE TABLE messages (
    id SERIAL PRIMARY KEY,
    room VARCHAR(255) NOT NULL,
    username VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    timestamp BIGINT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_messages_room_timestamp ON messages(room, timestamp DESC);
```

**Go Implementation:**
```go
import (
    "database/sql"
    _ "github.com/lib/pq"
)

type PostgresStore struct {
    db *sql.DB
}

func (ps *PostgresStore) SaveMessage(room, username, content string, timestamp int64) error {
    _, err := ps.db.Exec(
        "INSERT INTO messages (room, username, content, timestamp) VALUES ($1, $2, $3, $4)",
        room, username, content, timestamp,
    )
    return err
}

func (ps *PostgresStore) GetMessages(room string, limit int) ([]Message, error) {
    rows, err := ps.db.Query(
        "SELECT username, content, timestamp FROM messages WHERE room = $1 ORDER BY timestamp DESC LIMIT $2",
        room, limit,
    )
    // ... parse rows into []Message
}
```

#### B. SQLite (Simple, Single-Server)
Good for development or single-instance deployments:
```go
import _ "github.com/mattn/go-sqlite3"

// Same interface as PostgreSQL, but simpler setup
db, err := sql.Open("sqlite3", "./chat.db")
```

#### C. MongoDB (Document Store)
Good for flexible schemas and horizontal scaling:
```go
import "go.mongodb.org/mongo-driver/mongo"

type MongoStore struct {
    client *mongo.Client
    coll   *mongo.Collection
}

func (ms *MongoStore) SaveMessage(msg Message) error {
    _, err := ms.coll.InsertOne(context.Background(), bson.M{
        "room":      msg.Room,
        "username":  msg.Username,
        "content":   msg.Content,
        "timestamp": msg.Timestamp,
    })
    return err
}
```

---

## Strategy 2: Redis (Hybrid: Cache + Pub/Sub)

### Overview
Use Redis for both persistence and real-time message distribution between servers.

### Pros
- ✅ Very fast (in-memory)
- ✅ Built-in pub/sub for multi-server broadcasting
- ✅ Persistence options (RDB snapshots, AOF)
- ✅ Simple API
- ✅ Can act as both cache and message broker

### Cons
- ❌ Data size limited by RAM
- ❌ Less query flexibility than SQL
- ❌ Requires Redis infrastructure

### Implementation

```go
import (
    "github.com/redis/go-redis/v9"
    "context"
)

type RedisStore struct {
    client *redis.Client
    pubsub *redis.PubSub
}

func NewRedisStore(addr string) *RedisStore {
    rdb := redis.NewClient(&redis.Options{
        Addr: addr,
    })
    return &RedisStore{client: rdb}
}

// Save message to Redis list (persistent)
func (rs *RedisStore) SaveMessage(room, username, content string, timestamp int64) error {
    ctx := context.Background()
    msgJSON, _ := json.Marshal(Message{
        Username:  username,
        Content:   content,
        Timestamp: timestamp,
    })
    
    // Store in sorted set by timestamp for easy retrieval
    key := fmt.Sprintf("messages:%s", room)
    return rs.client.ZAdd(ctx, key, redis.Z{
        Score:  float64(timestamp),
        Member: msgJSON,
    }).Err()
}

// Get messages from Redis
func (rs *RedisStore) GetMessages(room string, limit int) ([]Message, error) {
    ctx := context.Background()
    key := fmt.Sprintf("messages:%s", room)
    
    // Get most recent messages (highest scores)
    results, err := rs.client.ZRevRange(ctx, key, 0, int64(limit-1)).Result()
    // ... parse JSON results into []Message
}

// Publish message to other servers via Redis pub/sub
func (rs *RedisStore) BroadcastMessage(room string, msg Message) error {
    ctx := context.Background()
    msgJSON, _ := json.Marshal(msg)
    return rs.client.Publish(ctx, fmt.Sprintf("chat:%s", room), msgJSON).Err()
}

// Subscribe to messages from other servers
func (rs *RedisStore) SubscribeMessages(room string, handler func(Message)) {
    ctx := context.Background()
    pubsub := rs.client.Subscribe(ctx, fmt.Sprintf("chat:%s", room))
    
    go func() {
        for msg := range pubsub.Channel() {
            var message Message
            json.Unmarshal([]byte(msg.Payload), &message)
            handler(message)
        }
    }()
}
```

**Integration with ChatServer:**
```go
type ChatServer struct {
    // ... existing fields
    store Store // Interface for persistence
}

type Store interface {
    SaveMessage(room, username, content string, timestamp int64) error
    GetMessages(room string, limit int) ([]Message, error)
    BroadcastMessage(room string, msg Message) error
}

// In CLIENT_MESSAGE handler:
func (cs *ChatServer) handleMessage(room, username, content string) {
    timestamp := time.Now().Unix()
    
    // Save to persistent store
    cs.store.SaveMessage(room, username, content, timestamp)
    
    // Broadcast to other servers
    cs.store.BroadcastMessage(room, Message{
        Username:  username,
        Content:   content,
        Timestamp: timestamp,
    })
    
    // Emit to local clients
    defaultNsp.Emit(EventServerMessage, response)
}
```

---

## Strategy 3: File-Based Persistence (Simple, Single-Server)

### Overview
Write messages to disk periodically or on each message.

### Pros
- ✅ No external dependencies
- ✅ Simple implementation
- ✅ Good for development/small deployments

### Cons
- ❌ Not suitable for multi-server
- ❌ File I/O can be slow
- ❌ No concurrent access safety without locking
- ❌ Limited query capabilities

### Implementation

```go
import (
    "encoding/json"
    "os"
    "sync"
)

type FileStore struct {
    filepath string
    mu       sync.Mutex
}

func (fs *FileStore) SaveMessage(room, username, content string, timestamp int64) error {
    fs.mu.Lock()
    defer fs.mu.Unlock()
    
    // Read existing messages
    data, _ := os.ReadFile(fs.filepath)
    var messages Messages
    json.Unmarshal(data, &messages)
    
    // Append new message
    if messages[room] == nil {
        messages[room] = []Message{}
    }
    messages[room] = append([]Message{{
        Username:  username,
        Content:   content,
        Timestamp: timestamp,
    }}, messages[room]...)
    
    // Write back to file
    data, _ = json.Marshal(messages)
    return os.WriteFile(fs.filepath, data, 0644)
}

func (fs *FileStore) LoadMessages() (Messages, error) {
    fs.mu.Lock()
    defer fs.mu.Unlock()
    
    data, err := os.ReadFile(fs.filepath)
    if err != nil {
        return make(Messages), nil
    }
    
    var messages Messages
    json.Unmarshal(data, &messages)
    return messages, nil
}

// In NewChatServer():
func NewChatServer() *ChatServer {
    store := &FileStore{filepath: "./messages.json"}
    messages, _ := store.LoadMessages() // Load on startup
    
    return &ChatServer{
        messages: messages,
        store:    store,
        // ... other fields
    }
}
```

---

## Strategy 4: Hybrid Approach (Recommended for Scale)

### Overview
Combine database persistence with Redis pub/sub for real-time distribution.

### Architecture
```
Client → Server A → [PostgreSQL] ← Server B ← Client
              ↓                          ↓
         [Redis Pub/Sub] ←──────────────┘
```

### Implementation Flow

1. **Message Received**:
   - Save to PostgreSQL (persistent)
   - Publish to Redis channel (real-time distribution)
   - Emit to local Socket.IO clients

2. **Message Received via Redis**:
   - Emit to local Socket.IO clients (don't save again)

3. **Server Startup**:
   - Load recent messages from PostgreSQL
   - Subscribe to Redis channels

```go
type HybridStore struct {
    db      *sql.DB        // PostgreSQL for persistence
    redis   *redis.Client   // Redis for pub/sub
    pubsub  *redis.PubSub
}

func (hs *HybridStore) SaveMessage(room, username, content string, timestamp int64) error {
    // 1. Save to PostgreSQL
    _, err := hs.db.Exec(
        "INSERT INTO messages (room, username, content, timestamp) VALUES ($1, $2, $3, $4)",
        room, username, content, timestamp,
    )
    if err != nil {
        return err
    }
    
    // 2. Publish to Redis for other servers
    msgJSON, _ := json.Marshal(Message{
        Username:  username,
        Content:   content,
        Timestamp: timestamp,
    })
    return hs.redis.Publish(context.Background(), fmt.Sprintf("chat:%s", room), msgJSON).Err()
}

// In ChatServer initialization:
func NewChatServer() *ChatServer {
    store := &HybridStore{
        db:    connectPostgres(),
        redis: connectRedis(),
    }
    
    // Subscribe to Redis for messages from other servers
    store.Subscribe(func(msg Message) {
        // Add to local state
        cs.mu.Lock()
        if cs.messages[msg.Room] == nil {
            cs.messages[msg.Room] = []Message{}
        }
        cs.messages[msg.Room] = append([]Message{msg}, cs.messages[msg.Room]...)
        cs.mu.Unlock()
        
        // Broadcast to local clients
        defaultNsp.Emit(EventServerMessage, map[string]interface{}{
            "messages": cs.messages,
            "users":    cs.getUserList(),
        })
    })
    
    // Load recent messages from PostgreSQL on startup
    messages, _ := store.LoadRecentMessages(100)
    
    return &ChatServer{
        messages: messages,
        store:    store,
        // ... other fields
    }
}
```

---

## Strategy 5: Message Queue (Advanced)

### Overview
Use a message queue (RabbitMQ, Apache Kafka, NATS) for guaranteed delivery and distribution.

### Pros
- ✅ Guaranteed delivery
- ✅ Message ordering
- ✅ Durable queues
- ✅ High throughput

### Cons
- ❌ More complex setup
- ❌ Additional infrastructure
- ❌ Overkill for simple chat

### When to Use
- High message volume (millions/day)
- Need guaranteed delivery
- Complex routing requirements
- Event sourcing architecture

---

## Recommended Implementation Plan

### Phase 1: Add Database Persistence (Immediate)
1. Add PostgreSQL/SQLite support
2. Save messages on receipt
3. Load messages on server startup
4. Keep in-memory cache for fast reads

### Phase 2: Add Redis Pub/Sub (Multi-Server)
1. Add Redis client
2. Publish messages to Redis on save
3. Subscribe to Redis channels
4. Emit to local clients when receiving from Redis

### Phase 3: Optimize (Scale)
1. Add message pagination
2. Implement message archiving (move old messages to cold storage)
3. Add read replicas for database
4. Implement caching layer

---

## Code Structure

```
server-go/
├── main.go
├── store/
│   ├── interface.go        // Store interface
│   ├── postgres.go         // PostgreSQL implementation
│   ├── redis.go            // Redis implementation
│   ├── file.go             // File-based implementation
│   └── hybrid.go           // Hybrid PostgreSQL + Redis
└── models/
    └── message.go          // Message struct
```

---

## Migration Path

1. **Create Store Interface**: Define `Store` interface with required methods
2. **Implement File Store**: Start with file-based for testing
3. **Add Database Store**: Implement PostgreSQL/SQLite
4. **Refactor ChatServer**: Inject `Store` dependency
5. **Add Redis**: Implement pub/sub for multi-server
6. **Test Multi-Server**: Run 2+ instances and verify message distribution

---

## Example: Store Interface

```go
// store/interface.go
package store

import "time"

type Message struct {
    Username  string
    Content   string
    Timestamp int64
    Room      string
}

type Store interface {
    // Persistence
    SaveMessage(room, username, content string, timestamp int64) error
    GetMessages(room string, limit int) ([]Message, error)
    GetRecentMessages(limit int) (map[string][]Message, error)
    
    // Multi-server distribution (optional)
    BroadcastMessage(room string, msg Message) error
    SubscribeMessages(handler func(room string, msg Message)) error
    
    // Lifecycle
    Close() error
}
```

---

## Performance Considerations

- **Write-Through Cache**: Write to DB immediately, keep in-memory for reads
- **Write-Behind Cache**: Batch writes to DB periodically (risk of data loss)
- **Read Replicas**: Use read replicas for scaling reads
- **Message Limits**: Limit message history per room (e.g., last 1000 messages)
- **Archiving**: Move old messages to separate archive table/storage

---

## Security Considerations

- **SQL Injection**: Use parameterized queries (already done in examples)
- **Redis Security**: Use Redis AUTH and TLS
- **Data Encryption**: Encrypt sensitive message content at rest
- **Access Control**: Implement room-level permissions
- **Rate Limiting**: Prevent message spam

---

## Next Steps

1. Choose a strategy based on your requirements
2. Implement the `Store` interface
3. Refactor `ChatServer` to use the store
4. Test persistence across restarts
5. Test multi-server message distribution

