# Server Setup Guide

This project includes three server implementations that can all serve the same Next.js client:

1. **Next.js Server** (default) - Port 3000
2. **Go Server** - Port 3001
3. **Express.js Server** - Port 3002

All servers are compatible with the existing client and can be run simultaneously.

## Prerequisites

1. Build the Next.js client first:
```bash
npm run build
```

This creates the `.next` directory that all servers will serve.

## Running Servers

### Option 1: Next.js Server (Default)

```bash
npm run dev
```

Runs on `http://localhost:3000`

### Option 2: Go Server

```bash
cd server-go
go mod download
go run main.go
```

Runs on `http://localhost:3001` (or set `PORT` environment variable)

**First time setup:**
```bash
cd server-go
go mod download
```

### Option 3: Express.js Server

```bash
cd server-express
npm install
npm run dev  # Development with hot reloading
# or
npm start    # Production mode
```

Runs on `http://localhost:3002` (or set `PORT` environment variable)

## Running All Servers Simultaneously

You can run all three servers at the same time on different ports:

**Terminal 1:**
```bash
npm run dev
# Next.js server on port 3000
```

**Terminal 2:**
```bash
cd server-go
PORT=3001 go run main.go
# Go server on port 3001
```

**Terminal 3:**
```bash
cd server-express
PORT=3002 npm run dev
# Express server on port 3002
```

Then access:
- Next.js: http://localhost:3000
- Go: http://localhost:3001
- Express: http://localhost:3002

## Server Comparison

| Feature | Next.js Server | Go Server | Express Server |
|---------|---------------|-----------|----------------|
| Language | TypeScript/Node.js | Go | JavaScript/Node.js |
| Static Serving | Next.js handler | Go file server | Express static |
| Socket.IO | Full support | Full support | Full support |
| Hot Reloading | Next.js dev mode | Manual restart | Nodemon |
| Build Required | No (dev mode) | Yes | Yes |
| Port (default) | 3000 | 3001 | 3002 |

## Configuration

All servers support the `PORT` environment variable:

```bash
PORT=4000 npm run dev          # Next.js
PORT=4000 go run main.go       # Go
PORT=4000 npm start            # Express
```

## Important Notes

1. **Build First**: Always run `npm run build` before starting Go or Express servers, as they serve the built `.next` directory.

2. **Separate State**: Each server maintains its own in-memory state (users, messages, rooms). They don't share data.

3. **Socket.IO Compatibility**: All servers use Socket.IO protocol, so clients can connect to any server.

4. **API Compatibility**: All servers implement the same `/api/login` endpoint with identical behavior.

## Troubleshooting

### ".next directory not found"
- Run `npm run build` in the project root first
- Make sure you're running the command from the correct directory

### "Port already in use"
- Change the `PORT` environment variable
- Or stop the server using that port (see "Killing and Restarting Servers" below)

### Go server: "module not found"
- Run `go mod download` in the `server-go` directory

### Express server: "Cannot find module"
- Run `npm install` in the `server-express` directory

## Killing and Restarting Servers

### Find and Kill Process on a Port

**Linux/macOS:**
```bash
# Find process using port 3000
lsof -ti:3000

# Kill process on port 3000
kill -9 $(lsof -ti:3000)

# Or in one command
lsof -ti:3000 | xargs kill -9
```

**Alternative (if lsof not available):**
```bash
# Find process using port 3000
fuser 3000/tcp

# Kill process on port 3000
fuser -k 3000/tcp
```

**Using netstat (older systems):**
```bash
# Find process using port 3000
netstat -tulpn | grep :3000

# Then kill using the PID from the output
kill -9 <PID>
```

### Quick Restart Commands

**Next.js Server (Port 3000):**
```bash
# Kill and restart
kill -9 $(lsof -ti:3000) 2>/dev/null; npm run dev
```

**Go Server (Port 3001):**
```bash
# Kill and restart
kill -9 $(lsof -ti:3001) 2>/dev/null; cd server-go && PORT=3001 go run main.go
```

**Express Server (Port 3002):**
```bash
# Kill and restart
kill -9 $(lsof -ti:3002) 2>/dev/null; cd server-express && PORT=3002 npm run dev
```

### Kill All Servers at Once

```bash
# Kill all three servers
kill -9 $(lsof -ti:3000) 2>/dev/null
kill -9 $(lsof -ti:3001) 2>/dev/null
kill -9 $(lsof -ti:3002) 2>/dev/null
```

## Development Workflow

For development with hot reloading:

1. **Next.js Server**: Use `npm run dev` (no build needed, hot reloading built-in)
2. **Express Server**: Use `npm run dev` (nodemon watches for changes)
3. **Go Server**: Manual restart required (or use a Go tool like `air` for hot reloading)

For production:

1. Build the client: `npm run build`
2. Run any server with production settings
3. All servers will serve the same built client

