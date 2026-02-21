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

```bash
go build -o chat-server-go main.go
```

## Running

1. First, build the Next.js client:
```bash
cd ..
npm run build
```

2. Run the Go server:
```bash
cd server-go
go run main.go
```

Or if built:
```bash
./chat-server-go
```

The server will start on `http://localhost:3001` (or the port specified in `PORT` environment variable).

## Killing and Restarting

### Kill Process on Port 3001

**Linux/macOS:**
```bash
# Kill process on port 3001
kill -9 $(lsof -ti:3001)

# Or in one command
lsof -ti:3001 | xargs kill -9
```

**Alternative:**
```bash
fuser -k 3001/tcp
```

### Quick Restart

```bash
# Kill and restart in one command
kill -9 $(lsof -ti:3001) 2>/dev/null; PORT=3001 go run main.go
```

Or if using a custom port:
```bash
# Replace 3001 with your port
kill -9 $(lsof -ti:YOUR_PORT) 2>/dev/null; PORT=YOUR_PORT go run main.go
```

## Features

- Serves static files from `.next` directory
- Socket.IO-compatible WebSocket server
- `/api/login` endpoint with password hashing
- In-memory session and user cache
- Real-time chat messaging
- Room management

## Architecture

- **Cache**: In-memory cache with TTL support for sessions (4 hours) and permanent storage for users
- **Socket.IO**: Uses `googollee/go-socket.io` library for Socket.IO protocol compatibility
- **Password Hashing**: Uses `golang.org/x/crypto/scrypt` for password hashing (same algorithm as Node.js version)
- **Static Serving**: Serves built Next.js files from `.next` directory

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
PORT=3001 go run main.go

# Terminal 3: Express server (port 3002)
cd server-express
PORT=3002 npm start
```

Each server will serve the same client but maintain separate in-memory state.

