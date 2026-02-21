# Express.js Server for Interview Chat App

This is a standalone Express.js server implementation that serves the built Next.js client and provides Socket.IO functionality with hot reloading support.

## Prerequisites

- Node.js 18+ 
- The Next.js client must be built first (see main README)

## Installation

```bash
cd server-express
npm install
```

## Configuration

The server can be configured using environment variables:

- `PORT` - Server port (default: `3002`)

## Running

### Development Mode (with hot reloading)

```bash
npm run dev
```

This uses `nodemon` to automatically restart the server when files change.

### Production Mode

```bash
npm start
```

## Building the Client First

Before running the server, make sure to build the Next.js client:

```bash
cd ..
npm run build
```

This creates the `.next` directory that the server will serve.

## Killing and Restarting

### Kill Process on Port 3002

**Linux/macOS:**
```bash
# Kill process on port 3002
kill -9 $(lsof -ti:3002)

# Or in one command
lsof -ti:3002 | xargs kill -9
```

**Alternative:**
```bash
fuser -k 3002/tcp
```

### Quick Restart

```bash
# Kill and restart in one command (development mode)
kill -9 $(lsof -ti:3002) 2>/dev/null; PORT=3002 npm run dev

# Or production mode
kill -9 $(lsof -ti:3002) 2>/dev/null; PORT=3002 npm start
```

Or if using a custom port:
```bash
# Replace 3002 with your port
kill -9 $(lsof -ti:YOUR_PORT) 2>/dev/null; PORT=YOUR_PORT npm run dev
```

## Features

- Serves static files from `.next` directory
- Socket.IO WebSocket server
- `/api/login` endpoint with password hashing
- In-memory session and user cache
- Real-time chat messaging
- Room management
- Hot reloading in development mode (nodemon)

## Architecture

- **Cache**: In-memory cache with TTL support for sessions (4 hours) and permanent storage for users
- **Socket.IO**: Full Socket.IO server implementation
- **Password Hashing**: Uses `@noble/hashes/scrypt` (same as main server)
- **Static Serving**: Serves built Next.js files from `.next` directory with SPA fallback

## Differences from Next.js Server

- Standalone Express.js server (no Next.js integration)
- Simpler setup without Next.js routing
- Direct static file serving
- Hot reloading with nodemon for development

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
PORT=3002 npm run dev
```

Each server will serve the same client but maintain separate in-memory state.

## Development

The server uses `nodemon` for hot reloading. Any changes to `server.js` will automatically restart the server.

To add more dependencies:
```bash
npm install <package-name>
```

