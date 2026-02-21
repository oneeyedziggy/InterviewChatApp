import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { scryptAsync } from '@noble/hashes/scrypt';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

const PORT = process.env.PORT || 3002;
const MIN_USERNAME_LENGTH = 8;
const MIN_PASSWORD_LENGTH = 8;
const DEFAULT_ROOM = '#general';
const SESSION_TTL = 60 * 60 * 4; // 4 hours in seconds

// Socket events
const SOCKET_EVENTS = {
  CLIENT_MESSAGE: 'clientMessage',
  CLIENT_NEW_ROOM: 'clientNewRoom',
  CLIENT_DISCONNECTING: 'clientDisconnecting',
  SERVER_MESSAGE: 'serverMessage',
  SERVER_NEW_ROOM: 'serverNewRoom',
  SERVER_USER_LIST_UPDATE: 'serverUserListUpdate',
  INITIAL_DATA: 'initialData',
  STATUS: 'status',
  DISCONNECT: 'disconnect',
};

const SYSTEM_MESSAGES = {
  USER_JOINED: '<-- has entered the room',
  USER_LEFT: 'says "smell ya\' later" -->',
};

// In-memory cache
class Cache {
  constructor(ttlSeconds = 0) {
    this.items = new Map();
    this.ttl = ttlSeconds * 1000; // Convert to milliseconds
    if (ttlSeconds > 0) {
      this.startCleanup();
    }
  }

  set(key, value) {
    const expiresAt = this.ttl > 0 ? Date.now() + this.ttl : null;
    this.items.set(key, { value, expiresAt });
  }

  get(key) {
    const item = this.items.get(key);
    if (!item) return null;
    if (item.expiresAt && Date.now() > item.expiresAt) {
      this.items.delete(key);
      return null;
    }
    return item.value;
  }

  has(key) {
    const item = this.items.get(key);
    if (!item) return false;
    if (item.expiresAt && Date.now() > item.expiresAt) {
      this.items.delete(key);
      return false;
    }
    return true;
  }

  delete(key) {
    this.items.delete(key);
  }

  startCleanup() {
    setInterval(() => {
      const now = Date.now();
      for (const [key, item] of this.items.entries()) {
        if (item.expiresAt && now > item.expiresAt) {
          this.items.delete(key);
        }
      }
    }, 60000); // Clean up every minute
  }
}

// Chat server state
const sessionCache = new Cache(SESSION_TTL);
const userCache = new Cache(0); // No expiration
const messages = {
  [DEFAULT_ROOM]: [],
  '#cats': [],
};
const rooms = [DEFAULT_ROOM, '#cats'];
const users = {};

const setUser = (name, sessionId) => {
  users[name] = sessionId;
};

const getUserList = () => {
  return Object.keys(users)
    .filter((user) => user && user !== 'undefined')
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
};

const alphabeticalSort = (array) => {
  return [...array].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
};

// Password hashing
const salt = uuidv4(); // In production, use env var

const hashPassword = async (password) => {
  const hash = await scryptAsync(password, salt, {
    N: 2 ** 16,
    r: 8,
    p: 1,
    dkLen: 32,
  });
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};

const comparePasswords = async (a, b) => {
  // Constant-time comparison
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  // Add small random delay to prevent timing attacks
  await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 100)));
  return result === 0;
};

// Express app
const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

// Middleware
app.use(express.json());

// Login endpoint
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password || password.length < MIN_PASSWORD_LENGTH) {
    return res.json({ error: 'Required parameters missing' });
  }

  try {
    const hashedPW = await hashPassword(password);

    if (userCache.has(username)) {
      const cachedHashedPW = userCache.get(username);

      if (username.length < MIN_USERNAME_LENGTH) {
        return res.json({
          error: `Username must be at least ${MIN_USERNAME_LENGTH}`,
        });
      }
      if (password.length < MIN_PASSWORD_LENGTH) {
        return res.json({
          error: `Password must be at least ${MIN_PASSWORD_LENGTH}`,
        });
      }

      if (await comparePasswords(hashedPW, cachedHashedPW)) {
        const sessionId = uuidv4();
        sessionCache.set(sessionId, username);
        setUser(username, sessionId);
        return res.json({ sessionId });
      } else {
        return res.json({ error: 'Invalid Credentials' });
      }
    } else {
      // New user
      const sessionId = uuidv4();
      userCache.set(username, hashedPW);
      sessionCache.set(sessionId, username);
      setUser(username, sessionId);
      return res.json({ sessionId });
    }
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Socket.IO middleware
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  const username = socket.handshake.auth.username;
  setUser(username, token);
  next();
});

// Socket.IO handlers
io.on('connection', (socket) => {
  console.log('client connected');
  socket.emit(SOCKET_EVENTS.STATUS, 'Hello from Socket.io');
  socket.emit(SOCKET_EVENTS.INITIAL_DATA, {
    messages,
    rooms,
    users: getUserList(),
  });

  socket.on(SOCKET_EVENTS.CLIENT_MESSAGE, (msg) => {
    if (!messages[msg.room]) {
      messages[msg.room] = [];
    }
    messages[msg.room].unshift({
      timestamp: Date.now(),
      username: msg.username,
      content: msg.content,
    });
    io.emit(SOCKET_EVENTS.SERVER_MESSAGE, {
      messages,
      users: getUserList(),
    });
  });

  socket.on(SOCKET_EVENTS.CLIENT_NEW_ROOM, (roomName) => {
    const formattedRoomname = `#${roomName}`;
    if (!rooms.includes(formattedRoomname)) {
      rooms.push(formattedRoomname);
      messages[formattedRoomname] = [];
    }
    io.emit(SOCKET_EVENTS.SERVER_NEW_ROOM, {
      messages,
      rooms: alphabeticalSort(rooms),
    });
  });

  socket.on(SOCKET_EVENTS.CLIENT_DISCONNECTING, (sessionId) => {
    const userOfSession = Object.entries(users).find(([_, value]) => value === sessionId)?.[0];
    if (userOfSession) {
      delete users[userOfSession];
    }
    console.log('client disconnecting');
  });

  socket.on(SOCKET_EVENTS.DISCONNECT, () => {
    console.log('client disconnected');
  });
});

// Serve static files from .next directory
const nextDir = join(rootDir, '.next');
if (!existsSync(nextDir)) {
  console.warn('Warning: .next directory not found. Please run "npm run build" first.');
}

app.use(express.static(nextDir));

// SPA fallback - serve index.html for all non-API routes
app.get('*', (req, res, next) => {
  // Skip API routes
  if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) {
    return next();
  }

  // Try to serve the requested file
  const filePath = join(nextDir, req.path);
  if (existsSync(filePath)) {
    return res.sendFile(filePath);
  }

  // Fallback to index.html for client-side routing
  const indexPath = join(nextDir, 'index.html');
  if (existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }

  next();
});

server.listen(PORT, () => {
  console.log(`Express server running on http://localhost:${PORT}`);
  console.log(`Make sure to run 'npm run build' first to generate .next directory`);
});



