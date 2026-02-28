# Go Server for Interview Chat App

This is an alternative server implementation in Go that serves the built Next.js client and provides Socket.IO-compatible WebSocket functionality.

## Prerequisites

- Go 1.21 or later
- The Next.js client must be built first (see main README)

## Installation

1. Install Go dependencies:
```bash
cd server-go
go mod download
```

## Configuration

The server can be configured using environment variables:

- `PORT` - Server port (default: `3001`)

## Building

**IMPORTANT**: Always build the entire package (includes both `main.go` and `gpg_auth.go`):

```bash
go build -o chat-server-go .
```

Or explicitly include all files:
```bash
go build -o chat-server-go main.go gpg_auth.go
```

**Do NOT use**: `go build main.go` (this will fail because it doesn't include `gpg_auth.go`)

## Running

### Quick Start Script (Recommended)

Use the provided startup script that safely kills only Go server processes (not browsers):

```bash
cd server-go
./start.sh
```

Or with a custom port:
```bash
PORT=3000 ./start.sh
```

The script will:
- Find processes on the specified port
- Kill only Go server processes (ignores browsers and other applications)
- Restart the server

### One-Liner Command

For a quick restart that only kills Go processes:

```bash
cd server-go && lsof -ti:${PORT:-3001} -sTCP:LISTEN | while read pid; do cmd=$(ps -p $pid -o comm= 2>/dev/null); cmd_full=$(ps -p $pid -o args= 2>/dev/null); [[ "$cmd" == "go" ]] || [[ "$cmd" == "chat-server-go" ]] || [[ "$cmd_full" == *"go run"* ]] || [[ "$cmd_full" == *"chat-server-go"* ]] && kill -9 $pid 2>/dev/null; done; PORT=${PORT:-3001} go run .
```

### Manual Steps

1. First, build the Next.js client:
```bash
cd ..
npm run build
```

2. Run the Go server:
```bash
cd server-go
go run .
```

Or explicitly:
```bash
go run main.go gpg_auth.go
```

Or if built:
```bash
./chat-server-go
```

The server will start on `http://localhost:3001` (or the port specified in `PORT` environment variable).

## Killing and Restarting

### Using the Startup Script (Safest)

The `start.sh` script safely kills only Go server processes:

```bash
./start.sh
```

### Manual Kill (Not Recommended - May Kill Browsers)

**Warning**: These commands may kill browsers or other processes using the port.

**Linux/macOS:**
```bash
# Kill ALL processes on port 3001 (including browsers!)
kill -9 $(lsof -ti:3001) 2>/dev/null

# Or in one command
lsof -ti:3001 | xargs kill -9 2>/dev/null
```

**Alternative:**
```bash
fuser -k 3001/tcp
```

### Safe Manual Restart (Go Processes Only)

```bash
# Kill only Go processes and restart
lsof -ti:${PORT:-3001} -sTCP:LISTEN | while read pid; do 
  cmd=$(ps -p $pid -o comm= 2>/dev/null)
  cmd_full=$(ps -p $pid -o args= 2>/dev/null)
  if [[ "$cmd" == "go" ]] || [[ "$cmd" == "chat-server-go" ]] || [[ "$cmd_full" == *"go run"* ]] || [[ "$cmd_full" == *"chat-server-go"* ]]; then
    kill -9 $pid 2>/dev/null
  fi
done
PORT=${PORT:-3001} go run .
```

## Features

- Serves static files from `.next` directory
- Socket.IO-compatible WebSocket server
- `/api/login` endpoint with GPG-based authentication (passwordless)
- `/api/server-public-key` endpoint to retrieve server's GPG public key
- In-memory session and user cache
- Real-time chat messaging
- Room management

## Architecture

- **Cache**: In-memory cache with TTL support for sessions (4 hours) and permanent storage for users
- **Socket.IO**: Uses `googollee/go-socket.io` library for Socket.IO protocol compatibility
- **GPG Authentication**: Uses `github.com/ProtonMail/gopenpgp/v2` for GPG key generation and challenge-response authentication
- **File Persistence**: Messages, rooms, users, and user public keys are persisted to `chat-state.json`
- **Static Serving**: Serves built Next.js files from `.next` directory

## Resetting Server Data

To reset all chat data (users, rooms, messages, and user public keys), use the provided reset script:

```bash
cd server-go
./reset-data.sh
```

The script will:
- Show the current state file size
- Ask for confirmation before deletion
- Create a timestamped backup of the state file
- Delete `chat-state.json`
- Display a summary of what was reset

**What gets reset:**
- ✅ All messages
- ✅ All rooms (server will recreate default rooms on next start)
- ✅ All users
- ✅ All user public keys

**What does NOT get reset:**
- ❌ Server GPG keys (`server-private-key.asc`, `server-public-key.asc`)

To also reset server GPG keys, manually delete:
```bash
rm server-go/server-private-key.asc server-go/server-public-key.asc
```

**Note**: After resetting, restart the server to start with a clean state. The server will automatically recreate default rooms (`#general` and `#cats`) on startup.

## Differences from Node.js Server

- Uses Go's standard library for HTTP serving
- In-memory cache implementation instead of `node-cache`
- UUID generation uses crypto/rand instead of uuid library
- Socket.IO events are handled through the Go Socket.IO library
- **Note**: The Go Socket.IO library doesn't queue events like Node.js, so `INITIAL_DATA` is emitted with a small delay (100ms) after connection to ensure client listeners are ready

## Running Multiple Servers Simultaneously

To run multiple servers simultaneously, set different ports:

```bash
# Terminal 1: Next.js server (default port 3000)
npm run dev

# Terminal 2: Go server (port 3001)
cd server-go
PORT=3001 go run .

# Terminal 3: Express server (port 3002)
cd server-express
PORT=3002 npm start
```

Each server will serve the same client but maintain separate in-memory state.

