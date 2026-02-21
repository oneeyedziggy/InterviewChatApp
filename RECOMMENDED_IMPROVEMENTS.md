# Recommended Improvements and Cleanup

This document outlines incremental, testable improvements to organize code, reduce dependencies, and improve maintainability. Each recommendation includes before/after code samples and can be implemented independently.

## Table of Contents

1. [Extract Constants and Configuration](#1-extract-constants-and-configuration)
2. [Create Custom Hooks for Socket Logic](#2-create-custom-hooks-for-socket-logic)
3. [Extract Socket Service Layer](#3-extract-socket-service-layer)
4. [Improve Type Safety](#4-improve-type-safety)
5. [Extract Validation Logic](#5-extract-validation-logic)
6. [Component Decomposition](#6-component-decomposition)
7. [Extract Styled Components](#7-extract-styled-components)
8. [Improve Error Handling](#8-improve-error-handling)
9. [Remove Unused Dependencies](#9-remove-unused-dependencies)
10. [Add Configuration Management](#10-add-configuration-management)
11. [Security Improvements](#11-security-improvements)
12. [Testing Infrastructure](#12-testing-infrastructure)

---

## 1. Extract Constants and Configuration

**Goal**: Centralize magic strings and configuration values for easier maintenance and testing.

### Before

```typescript
// src/app/page.tsx
socket.emit('clientMessage', {
  username,
  room: '#general', // TODO find better solution to this than hardcoding
  content: '<-- has entered the room',
});

// src/components/LoginDialog.tsx
const minPasswordLength = 8;
const minUsernameLength = 8;

// src/app/api/login/route.ts
const minPasswordLength = 8;
const minUsernameLength = 8;
```

### After

```typescript
// src/constants/index.ts
export const DEFAULT_ROOM = '#general';
export const VALIDATION = {
  MIN_USERNAME_LENGTH: 8,
  MIN_PASSWORD_LENGTH: 8,
} as const;

export const SOCKET_EVENTS = {
  CLIENT_MESSAGE: 'clientMessage',
  CLIENT_NEW_ROOM: 'clientNewRoom',
  CLIENT_DISCONNECTING: 'clientDisconnecting',
  SERVER_MESSAGE: 'serverMessage',
  SERVER_NEW_ROOM: 'serverNewRoom',
  SERVER_USER_LIST_UPDATE: 'serverUserListUpdate',
  INITIAL_DATA: 'initialData',
  CONNECT: 'connect',
  DISCONNECT: 'disconnect',
  DISCONNECTING: 'disconnecting',
  STATUS: 'status',
} as const;

export const SYSTEM_MESSAGES = {
  USER_JOINED: '<-- has entered the room',
  USER_LEFT: 'says "smell ya\' later" -->',
} as const;
```

**Benefits**:
- Single source of truth for constants
- Easier to update values across the app
- Better IDE autocomplete and refactoring
- Enables configuration-based testing

---

## 2. Create Custom Hooks for Socket Logic

**Goal**: Separate socket connection logic from UI components for testability and reusability.

### Before

```typescript
// src/app/page.tsx
let socket: Socket;

const socketInitializer = async (authToken: string) => {
  socket = io({
    auth: {
      token: authToken,
      username,
    },
  });

  socket.on('connect', () => {
    socket.emit('clientMessage', {
      username,
      room: '#general',
      content: '<-- has entered the room',
    });
    socket.on('initialData', (data) => {
      data.messages && setChatValues(data.messages);
      data.rooms && setRoomList(data.rooms);
      data.users && setUserList(data.users);
    });
    // ... more handlers
  });
};

useEffect(() => {
  if (authToken) {
    socketInitializer(authToken);
  }
}, [authToken]);
```

### After

```typescript
// src/hooks/useSocket.ts
import { useEffect, useRef, useState } from 'react';
import io, { Socket } from 'socket.io-client';
import { SOCKET_EVENTS, DEFAULT_ROOM, SYSTEM_MESSAGES } from '../constants';
import { Messages } from '../types/types';

interface UseSocketOptions {
  authToken: string;
  username: string;
  onInitialData: (data: { messages: Messages; rooms: string[]; users: string[] }) => void;
  onMessage: (data: { messages: Messages; users: string[] }) => void;
  onNewRoom: (data: { messages: Messages; rooms: string[] }) => void;
  onUserListUpdate: (users: string[]) => void;
}

export const useSocket = (options: UseSocketOptions) => {
  const socketRef = useRef<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    if (!options.authToken) return;

    const socket = io({
      auth: {
        token: options.authToken,
        username: options.username,
      },
    });

    socketRef.current = socket;

    socket.on(SOCKET_EVENTS.CONNECT, () => {
      setIsConnected(true);
      socket.emit(SOCKET_EVENTS.CLIENT_MESSAGE, {
        username: options.username,
        room: DEFAULT_ROOM,
        content: SYSTEM_MESSAGES.USER_JOINED,
      });

      socket.on(SOCKET_EVENTS.INITIAL_DATA, options.onInitialData);
      socket.on(SOCKET_EVENTS.SERVER_MESSAGE, options.onMessage);
      socket.on(SOCKET_EVENTS.SERVER_NEW_ROOM, options.onNewRoom);
      socket.on(SOCKET_EVENTS.SERVER_USER_LIST_UPDATE, options.onUserListUpdate);
    });

    socket.on(SOCKET_EVENTS.DISCONNECT, () => {
      setIsConnected(false);
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [options.authToken, options.username]);

  const sendMessage = (room: string, content: string) => {
    socketRef.current?.emit(SOCKET_EVENTS.CLIENT_MESSAGE, {
      username: options.username,
      room,
      content,
    });
  };

  const createRoom = (roomName: string) => {
    socketRef.current?.emit(SOCKET_EVENTS.CLIENT_NEW_ROOM, roomName);
  };

  const disconnect = () => {
    socketRef.current?.emit(SOCKET_EVENTS.CLIENT_MESSAGE, {
      username: options.username,
      room: DEFAULT_ROOM,
      content: SYSTEM_MESSAGES.USER_LEFT,
    });
    socketRef.current?.emit(SOCKET_EVENTS.CLIENT_DISCONNECTING, options.authToken);
    socketRef.current?.disconnect();
  };

  return {
    isConnected,
    sendMessage,
    createRoom,
    disconnect,
  };
};
```

**Benefits**:
- Testable in isolation
- Reusable across components
- Clear separation of concerns
- Easier to mock for testing

---

## 3. Extract Socket Service Layer

**Goal**: Create a service abstraction for socket operations to enable dependency injection and testing.

### Before

```typescript
// src/socket.ts - Direct socket.io usage throughout
export const setupSocketHandlers = (io: socketio.Server) => {
  io.on('connection', (socket: socketio.Socket) => {
    socket.on('clientMessage', (msg) => {
      messages[msg.room].unshift({
        timestamp: new Date().getUTCDate(),
        username: msg.username,
        content: msg.content,
      });
      io.emit('serverMessage', { messages, users: getUserList() });
    });
  });
};
```

### After

```typescript
// src/services/MessageService.ts
import { Messages, Message } from '../types/types';

export interface IMessageService {
  addMessage(room: string, message: Message): void;
  getMessages(room: string): Message[];
  getAllMessages(): Messages;
}

export class InMemoryMessageService implements IMessageService {
  private messages: Messages = {};

  constructor(initialRooms: string[] = []) {
    initialRooms.forEach((room) => {
      this.messages[room] = [];
    });
  }

  addMessage(room: string, message: Message): void {
    if (!this.messages[room]) {
      this.messages[room] = [];
    }
    this.messages[room].unshift(message);
  }

  getMessages(room: string): Message[] {
    return this.messages[room] || [];
  }

  getAllMessages(): Messages {
    return { ...this.messages };
  }
}

// src/services/RoomService.ts
export interface IRoomService {
  createRoom(name: string): string;
  getRooms(): string[];
  roomExists(name: string): boolean;
}

export class InMemoryRoomService implements IRoomService {
  private rooms: string[] = [];

  constructor(initialRooms: string[] = []) {
    this.rooms = [...initialRooms];
  }

  createRoom(name: string): string {
    const formattedName = `#${name}`;
    if (!this.rooms.includes(formattedName)) {
      this.rooms.push(formattedName);
    }
    return formattedName;
  }

  getRooms(): string[] {
    return [...this.rooms].sort((a, b) => 
      a.toLowerCase().localeCompare(b.toLowerCase())
    );
  }

  roomExists(name: string): boolean {
    return this.rooms.includes(name);
  }
}

// src/socket.ts - Now uses services
import { IMessageService } from './services/MessageService';
import { IRoomService } from './services/RoomService';

export const setupSocketHandlers = (
  io: socketio.Server,
  messageService: IMessageService,
  roomService: IRoomService
) => {
  io.on('connection', (socket: socketio.Socket) => {
    socket.on(SOCKET_EVENTS.CLIENT_MESSAGE, (msg) => {
      messageService.addMessage(msg.room, {
        timestamp: Date.now(),
        username: msg.username,
        content: msg.content,
      });
      io.emit(SOCKET_EVENTS.SERVER_MESSAGE, {
        messages: messageService.getAllMessages(),
        users: getUserList(),
      });
    });

    socket.on(SOCKET_EVENTS.CLIENT_NEW_ROOM, (roomName) => {
      const formattedRoom = roomService.createRoom(roomName);
      io.emit(SOCKET_EVENTS.SERVER_NEW_ROOM, {
        messages: messageService.getAllMessages(),
        rooms: roomService.getRooms(),
      });
    });
  });
};
```

**Benefits**:
- Services can be easily mocked for testing
- Business logic separated from socket implementation
- Can swap implementations (e.g., database-backed services)
- Single Responsibility Principle

---

## 4. Improve Type Safety

**Goal**: Replace `any` types and improve type definitions throughout the codebase.

### Before

```typescript
// src/components/LoginDialog.tsx
type LoginDialogProps = {
  username: string;
  setUsername: (val: any) => void; //this is the type TS suggested...
  open: boolean;
  onSuccess: (authToken: string) => void;
};

// src/app/page.tsx
app.all('*', (req: any, res: any) => nextHandler(req, res));

// src/components/Input.tsx
onChange: (val: any) => void;
```

### After

```typescript
// src/components/LoginDialog.tsx
type LoginDialogProps = {
  username: string;
  setUsername: (username: string) => void;
  open: boolean;
  onSuccess: (authToken: string) => void;
};

// src/server.ts
import { IncomingMessage, ServerResponse } from 'http';
import { NextApiHandler } from 'next';

app.all('*', (req: IncomingMessage, res: ServerResponse) => 
  nextHandler(req, res)
);

// src/components/Input.tsx
type InputProps = {
  // ... other props
  onChange: (value: string) => void;
};

// src/types/api.ts
export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  sessionId?: string;
  error?: string;
}

// src/app/api/login/route.ts
export const POST = async (request: NextRequest): Promise<NextResponse<LoginResponse>> => {
  const data: LoginRequest = await request.json();
  // ... rest of implementation
};
```

**Benefits**:
- Better IDE support and autocomplete
- Catch errors at compile time
- Self-documenting code
- Easier refactoring

---

## 5. Extract Validation Logic

**Goal**: Create reusable, testable validation functions.

### Before

```typescript
// src/components/LoginDialog.tsx
const getUsernameError = (username: string): string => {
  return !username.length || username.length >= minUsernameLength
    ? ''
    : `Username must be at least ${minUsernameLength} characters`;
};

const getPasswordError = (password: string): string => {
  return !password.length || password.length >= minPasswordLength
    ? ''
    : `Password must be at least ${minPasswordLength} characters`;
};
```

### After

```typescript
// src/utils/validation.ts
import { VALIDATION } from '../constants';

export interface ValidationResult {
  isValid: boolean;
  error: string;
}

export const validateUsername = (username: string): ValidationResult => {
  if (!username) {
    return { isValid: false, error: 'Username is required' };
  }
  if (username.length < VALIDATION.MIN_USERNAME_LENGTH) {
    return {
      isValid: false,
      error: `Username must be at least ${VALIDATION.MIN_USERNAME_LENGTH} characters`,
    };
  }
  // Add more validation rules as needed
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return {
      isValid: false,
      error: 'Username can only contain letters, numbers, and underscores',
    };
  }
  return { isValid: true, error: '' };
};

export const validatePassword = (password: string): ValidationResult => {
  if (!password) {
    return { isValid: false, error: 'Password is required' };
  }
  if (password.length < VALIDATION.MIN_PASSWORD_LENGTH) {
    return {
      isValid: false,
      error: `Password must be at least ${VALIDATION.MIN_PASSWORD_LENGTH} characters`,
    };
  }
  // Add complexity requirements
  if (!/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/.test(password)) {
    return {
      isValid: false,
      error: 'Password must contain at least one uppercase letter, one lowercase letter, and one number',
    };
  }
  return { isValid: true, error: '' };
};

// src/components/LoginDialog.tsx
import { validateUsername, validatePassword } from '../utils/validation';

const getUsernameError = (username: string): string => {
  return validateUsername(username).error;
};

const getPasswordError = (password: string): string => {
  return validatePassword(password).error;
};
```

**Benefits**:
- Centralized validation logic
- Easy to unit test
- Consistent validation across the app
- Can be reused in API routes

---

## 6. Component Decomposition

**Goal**: Break down the large `page.tsx` component into smaller, focused components.

### Before

```typescript
// src/app/page.tsx - 285 lines, multiple concerns
const Home = () => {
  // 15+ state variables
  // Socket initialization logic
  // Message transformation logic
  // Event handlers
  // JSX with inline styled components
};
```

### After

```typescript
// src/components/ChatRoom.tsx
interface ChatRoomProps {
  messages: Message[];
  currentRoom: string;
  onSendMessage: (content: string) => void;
  draftMessage: string;
  onDraftChange: (message: string) => void;
}

export const ChatRoom = ({
  messages,
  currentRoom,
  onSendMessage,
  draftMessage,
  onDraftChange,
}: ChatRoomProps) => {
  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      onSendMessage(draftMessage);
    }
  };

  return (
    <MiddleFlexColumn>
      <MessageList messages={messages} currentRoom={currentRoom} />
      <MessageInput
        value={draftMessage}
        onChange={onDraftChange}
        onKeyDown={handleKeyDown}
        onSend={() => onSendMessage(draftMessage)}
      />
    </MiddleFlexColumn>
  );
};

// src/components/MessageList.tsx
interface MessageListProps {
  messages: Messages;
  currentRoom: string;
}

export const MessageList = ({ messages, currentRoom }: MessageListProps) => {
  const roomMessages = messages[currentRoom] || [];
  
  return (
    <ScrollableDiv $flexDirection="column-reverse">
      {roomMessages.map((message, index) => (
        <MessageItem key={`${message.timestamp}-${index}`} message={message} />
      ))}
    </ScrollableDiv>
  );
};

// src/components/RoomSidebar.tsx
interface RoomSidebarProps {
  rooms: string[];
  currentRoom: string;
  notifications: Record<string, string>;
  onRoomSelect: (room: string) => void;
  onNewRoom: (name: string) => void;
}

export const RoomSidebar = ({
  rooms,
  currentRoom,
  notifications,
  onRoomSelect,
  onNewRoom,
}: RoomSidebarProps) => {
  const [newRoomName, setNewRoomName] = useState('');

  return (
    <SideFlexColumn>
      <SelectableList
        id="roomSelection"
        label="Rooms"
        value={currentRoom}
        options={rooms.map((room) => 
          `${room}${notifications[room] ? '-' + notifications[room] : ''}`
        )}
        onSelect={onRoomSelect}
      />
      <hr />
      <NewRoomForm onNewRoom={onNewRoom} />
    </SideFlexColumn>
  );
};

// src/app/page.tsx - Now much simpler
const Home = () => {
  const { authToken, username, setUsername, setAuthToken } = useAuth();
  const { 
    messages, 
    rooms, 
    users, 
    sendMessage, 
    createRoom, 
    selectRoom 
  } = useChat(authToken, username);
  const { notifications } = useNotifications(messages);

  return (
    <>
      <LoginDialog
        username={username}
        setUsername={setUsername}
        open={!authToken}
        onSuccess={setAuthToken}
      />
      {authToken && (
        <FlexDiv>
          <RoomSidebar
            rooms={rooms}
            currentRoom={currentRoom}
            notifications={notifications}
            onRoomSelect={selectRoom}
            onNewRoom={createRoom}
          />
          <ChatRoom
            messages={messages}
            currentRoom={currentRoom}
            onSendMessage={(content) => sendMessage(currentRoom, content)}
          />
          <UserSidebar users={users} currentUser={username} />
        </FlexDiv>
      )}
    </>
  );
};
```

**Benefits**:
- Each component has a single responsibility
- Easier to test individual components
- Better code reusability
- Improved maintainability

---

## 7. Extract Styled Components

**Goal**: Move styled components to dedicated files for better organization.

### Before

```typescript
// src/app/page.tsx
const BlockInput = styled.input`
  display: block;
`;
const SideFlexColumn = styled.div`
  display: flex;
  flex-direction: column;
  flex-basis: 15%;
`;
// ... more styled components mixed with component logic
```

### After

```typescript
// src/components/styled/Layout.ts
import styled from 'styled-components';

export const SideFlexColumn = styled.div`
  display: flex;
  flex-direction: column;
  flex-basis: 15%;
`;

export const MiddleFlexColumn = styled.div`
  display: flex;
  flex-direction: column;
  flex-basis: 70%;
  height: 100vh;
`;

export const FlexRow = styled.div`
  display: flex;
  flex-direction: row;
`;

export const FlexDiv = styled.div`
  display: flex;
  flex-direction: row;
`;

// src/components/styled/Form.ts
import styled from 'styled-components';

export const BlockInput = styled.input`
  display: block;
`;

export const WiderInput = styled.input`
  display: flex;
  flex-basis: 95%;
`;

export const WiderButton = styled.button`
  display: flex;
  flex-basis: 10%;
  justify-content: center;
`;

// src/app/page.tsx
import { SideFlexColumn, MiddleFlexColumn, FlexRow, FlexDiv } from '../components/styled/Layout';
import { BlockInput, WiderInput, WiderButton } from '../components/styled/Form';
```

**Benefits**:
- Better organization
- Reusable styled components
- Easier to maintain consistent styling
- Can be shared across components

---

## 8. Improve Error Handling

**Goal**: Create consistent error handling patterns and error boundaries.

### Before

```typescript
// src/components/LoginDialog.tsx
const onSubmit = (username: string, password: string) => {
  const snarkyFallbackError = "Something went wrong...";
  fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
    .then((response) => {
      response.json().then((bodyJson) => {
        if (bodyJson.sessionId) {
          // success
        } else {
          setLoginError(bodyJson.error || snarkyFallbackError);
        }
      })
      .catch((err) => {
        setLoginError(snarkyFallbackError);
      });
    })
    .catch((err) => {
      setLoginError(snarkyFallbackError);
      console.error('login error2: ', err);
    });
};
```

### After

```typescript
// src/utils/api.ts
export class ApiError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public originalError?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const apiRequest = async <T>(
  url: string,
  options: RequestInit = {}
): Promise<T> => {
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new ApiError(
        errorData.error || `HTTP ${response.status}: ${response.statusText}`,
        response.status
      );
    }

    return await response.json();
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw new ApiError(
      'Network error: Unable to connect to server',
      0,
      error
    );
  }
};

// src/hooks/useLogin.ts
import { useState } from 'react';
import { apiRequest } from '../utils/api';
import { LoginRequest, LoginResponse } from '../types/api';

export const useLogin = () => {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const login = async (username: string, password: string): Promise<string | null> => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await apiRequest<LoginResponse>('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username, password } as LoginRequest),
      });

      if (response.sessionId) {
        return response.sessionId;
      } else {
        setError(response.error || 'Login failed');
        return null;
      }
    } catch (err) {
      const message = err instanceof ApiError 
        ? err.message 
        : 'An unexpected error occurred';
      setError(message);
      return null;
    } finally {
      setIsLoading(false);
    }
  };

  return { login, isLoading, error };
};

// src/components/LoginDialog.tsx
const { login, isLoading, error } = useLogin();

const onSubmit = async (username: string, password: string) => {
  const sessionId = await login(username, password);
  if (sessionId) {
    onSuccess(sessionId);
  }
};
```

**Benefits**:
- Consistent error handling
- Better error messages
- Easier to test error scenarios
- Type-safe error handling

---

## 9. Remove Unused Dependencies

**Goal**: Clean up package.json to reduce bundle size and security surface.

### Before

```json
{
  "dependencies": {
    "jsdom": "^22.1.0",  // Not used anywhere
    // ... other deps
  },
  "devDependencies": {
    "@types/deep-equal": "^1.0.1",  // Not used
    "@types/luxon": "^3.3.2",  // Not used
    // ... other deps
  }
}
```

### After

```bash
# Run to identify unused dependencies
npx depcheck

# Remove unused packages
npm uninstall jsdom @types/deep-equal @types/luxon
```

**Verification Steps**:
1. Run `npx depcheck` to identify unused dependencies
2. Search codebase for imports: `grep -r "jsdom\|deep-equal\|luxon" src/`
3. Remove confirmed unused dependencies
4. Test application still works

**Benefits**:
- Smaller node_modules
- Faster installs
- Reduced security vulnerabilities
- Clearer dependency graph

---

## 10. Add Configuration Management

**Goal**: Centralize environment-based configuration.

### Before

```typescript
// src/server.ts
const port: number = parseInt(process.env.PORT || '3000', 10);
const dev: boolean = process.env.NODE_ENV !== 'production';

// src/app/api/login/route.ts
const salt = uuidv4(); // Generated at runtime, not from env
```

### After

```typescript
// src/config/index.ts
export interface AppConfig {
  server: {
    port: number;
    nodeEnv: 'development' | 'production' | 'test';
  };
  auth: {
    minUsernameLength: number;
    minPasswordLength: number;
    sessionTTL: number; // in seconds
    salt?: string; // Optional, for testing
  };
  socket: {
    defaultRoom: string;
  };
}

const getEnvNumber = (key: string, defaultValue: number): number => {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    console.warn(`Invalid ${key}, using default: ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
};

export const config: AppConfig = {
  server: {
    port: getEnvNumber('PORT', 3000),
    nodeEnv: (process.env.NODE_ENV || 'development') as AppConfig['server']['nodeEnv'],
  },
  auth: {
    minUsernameLength: getEnvNumber('MIN_USERNAME_LENGTH', 8),
    minPasswordLength: getEnvNumber('MIN_PASSWORD_LENGTH', 8),
    sessionTTL: getEnvNumber('SESSION_TTL', 60 * 60 * 4), // 4 hours
    salt: process.env.AUTH_SALT, // For production, should be set
  },
  socket: {
    defaultRoom: process.env.DEFAULT_ROOM || '#general',
  },
};

// src/server.ts
import { config } from './config';

const port = config.server.port;
const dev = config.server.nodeEnv !== 'production';

// src/app/api/login/route.ts
import { config } from '../../../config';
import { v4 as uuidv4 } from 'uuid';

// Use env salt if available, otherwise generate (dev only)
const salt = config.auth.salt || (config.server.nodeEnv === 'production' 
  ? (() => { throw new Error('AUTH_SALT must be set in production'); })()
  : uuidv4());
```

**Benefits**:
- Single source of truth for configuration
- Type-safe configuration access
- Environment-specific values
- Easier testing with config overrides

---

## 11. Security Improvements

**Goal**: Address security concerns mentioned in code comments.

### Before

```typescript
// src/app/api/login/route.ts
const salt = uuidv4(); // Rotates on each server restart
const comparePasswords = async (a: string, b: string) => {
  await delay(Math.floor(Math.random() * 100));
  return a === b; // Not constant-time comparison
};
```

### After

```typescript
// src/utils/crypto.ts
import { scryptAsync } from '@noble/hashes/scrypt';
import { config } from '../config';

// Use constant salt from config (set via env var in production)
const getSalt = (): Uint8Array => {
  if (!config.auth.salt) {
    throw new Error('AUTH_SALT must be configured');
  }
  // Convert string salt to Uint8Array
  return new TextEncoder().encode(config.auth.salt);
};

export const hashPassword = async (password: string): Promise<string> => {
  const salt = getSalt();
  const hash = await scryptAsync(password, salt, {
    N: 2 ** 16,
    r: 8,
    p: 1,
    dkLen: 32,
  });
  return Array.from(hash).map(b => b.toString(16).padStart(2, '0')).join('');
};

// Constant-time comparison to prevent timing attacks
export const constantTimeCompare = (a: string, b: string): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
};

// src/app/api/login/route.ts
import { hashPassword, constantTimeCompare } from '../../../utils/crypto';

const comparePasswords = async (hashed: string, stored: string): Promise<boolean> => {
  // Always perform comparison, even if lengths differ (constant time)
  return constantTimeCompare(hashed, stored);
};
```

**Additional Security Recommendations**:

```typescript
// src/middleware/security.ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function securityHeaders(request: NextRequest) {
  const response = NextResponse.next();
  
  // Add security headers
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-XSS-Protection', '1; mode=block');
  response.headers.set(
    'Strict-Transport-Security',
    'max-age=31536000; includeSubDomains'
  );
  response.headers.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';"
  );
  
  return response;
}
```

**Benefits**:
- Constant-time password comparison prevents timing attacks
- Persistent salt enables proper password verification
- Security headers protect against common attacks
- Better security posture overall

---

## 12. Testing Infrastructure with Vitest

**Goal**: Add comprehensive test coverage using Vitest to maximize coverage of all exports from all TypeScript and TSX files, enabling incremental, verifiable changes.

### Setup

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      include: [
        'src/**/*.{ts,tsx}',
      ],
      exclude: [
        'src/**/*.d.ts',
        'src/**/*.stories.{ts,tsx}',
        'src/**/*.test.{ts,tsx}',
        'src/**/*.spec.{ts,tsx}',
        'src/app/layout.tsx', // Next.js specific
        'src/server.ts', // Custom server, test separately
      ],
      // Ensure all exports are covered
      all: true,
      // Require 100% coverage of all exports
      lines: 80,
      functions: 80,
      branches: 80,
      statements: 80,
    },
    // Ensure all exports are tested
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});

// vitest.setup.ts
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Cleanup after each test
afterEach(() => {
  cleanup();
});
```

### Comprehensive Test Examples

#### Testing Utilities (100% Export Coverage)

```typescript
// src/utils/validation.test.ts
import { describe, it, expect } from 'vitest';
import { validateUsername, validatePassword, type ValidationResult } from './validation';
import { VALIDATION } from '../constants';

describe('validation utilities', () => {
  describe('validateUsername', () => {
    it('rejects empty usernames', () => {
      const result = validateUsername('');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Username is required');
    });

    it('rejects usernames shorter than minimum length', () => {
      const result = validateUsername('short');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain(`at least ${VALIDATION.MIN_USERNAME_LENGTH}`);
    });

    it('accepts valid usernames', () => {
      const result = validateUsername('validuser123');
      expect(result.isValid).toBe(true);
      expect(result.error).toBe('');
    });

    it('rejects usernames with invalid characters', () => {
      const result = validateUsername('user@name!');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('letters, numbers');
    });

    it('accepts usernames with underscores', () => {
      const result = validateUsername('user_name123');
      expect(result.isValid).toBe(true);
    });

    it('rejects usernames with spaces', () => {
      const result = validateUsername('user name');
      expect(result.isValid).toBe(false);
    });
  });

  describe('validatePassword', () => {
    it('rejects empty passwords', () => {
      const result = validatePassword('');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Password is required');
    });

    it('rejects passwords shorter than minimum length', () => {
      const result = validatePassword('short');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain(`at least ${VALIDATION.MIN_PASSWORD_LENGTH}`);
    });

    it('accepts valid passwords with complexity', () => {
      const result = validatePassword('ValidPass123');
      expect(result.isValid).toBe(true);
      expect(result.error).toBe('');
    });

    it('rejects passwords without uppercase', () => {
      const result = validatePassword('validpass123');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('uppercase');
    });

    it('rejects passwords without lowercase', () => {
      const result = validatePassword('VALIDPASS123');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('lowercase');
    });

    it('rejects passwords without numbers', () => {
      const result = validatePassword('ValidPassword');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('number');
    });
  });
});

// src/utils/api.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { apiRequest, ApiError } from './api';

global.fetch = vi.fn();

describe('api utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('apiRequest', () => {
    it('returns JSON data on successful request', async () => {
      const mockData = { sessionId: 'test-session' };
      (fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => mockData,
      });

      const result = await apiRequest<typeof mockData>('/api/login', {
        method: 'POST',
      });

      expect(result).toEqual(mockData);
      expect(fetch).toHaveBeenCalledWith('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
    });

    it('throws ApiError on HTTP error response', async () => {
      (fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ error: 'Invalid credentials' }),
      });

      await expect(
        apiRequest('/api/login', { method: 'POST' })
      ).rejects.toThrow(ApiError);

      await expect(
        apiRequest('/api/login', { method: 'POST' })
      ).rejects.toThrow('Invalid credentials');
    });

    it('throws ApiError on network failure', async () => {
      (fetch as any).mockRejectedValueOnce(new Error('Network error'));

      await expect(
        apiRequest('/api/test')
      ).rejects.toThrow(ApiError);

      await expect(
        apiRequest('/api/test')
      ).rejects.toThrow('Network error');
    });

    it('includes custom headers', async () => {
      (fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      await apiRequest('/api/test', {
        headers: { 'Authorization': 'Bearer token' },
      });

      expect(fetch).toHaveBeenCalledWith('/api/test', {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer token',
        },
      });
    });
  });

  describe('ApiError', () => {
    it('creates error with message and status code', () => {
      const error = new ApiError('Test error', 404);
      expect(error.message).toBe('Test error');
      expect(error.statusCode).toBe(404);
      expect(error.name).toBe('ApiError');
    });

    it('stores original error', () => {
      const originalError = new Error('Original');
      const error = new ApiError('Test', 500, originalError);
      expect(error.originalError).toBe(originalError);
    });
  });
});
```

#### Testing Hooks (100% Export Coverage)

```typescript
// src/hooks/useSocket.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useSocket } from './useSocket';
import { io } from 'socket.io-client';
import { SOCKET_EVENTS } from '../constants';

vi.mock('socket.io-client');

describe('useSocket hook', () => {
  let mockSocket: any;

  beforeEach(() => {
    mockSocket = {
      on: vi.fn(),
      emit: vi.fn(),
      disconnect: vi.fn(),
    };
    (io as any).mockReturnValue(mockSocket);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('connects when authToken is provided', async () => {
    const onInitialData = vi.fn();
    const onMessage = vi.fn();
    const onNewRoom = vi.fn();
    const onUserListUpdate = vi.fn();

    renderHook(() =>
      useSocket({
        authToken: 'test-token',
        username: 'testuser',
        onInitialData,
        onMessage,
        onNewRoom,
        onUserListUpdate,
      })
    );

    await waitFor(() => {
      expect(io).toHaveBeenCalledWith({
        auth: { token: 'test-token', username: 'testuser' },
      });
    });
  });

  it('does not connect when authToken is missing', () => {
    renderHook(() =>
      useSocket({
        authToken: '',
        username: 'testuser',
        onInitialData: vi.fn(),
        onMessage: vi.fn(),
        onNewRoom: vi.fn(),
        onUserListUpdate: vi.fn(),
      })
    );

    expect(io).not.toHaveBeenCalled();
  });

  it('calls onInitialData when initialData event is received', async () => {
    const onInitialData = vi.fn();
    const testData = {
      messages: { '#general': [] },
      rooms: ['#general'],
      users: ['user1'],
    };

    renderHook(() =>
      useSocket({
        authToken: 'token',
        username: 'user',
        onInitialData,
        onMessage: vi.fn(),
        onNewRoom: vi.fn(),
        onUserListUpdate: vi.fn(),
      })
    );

    await waitFor(() => {
      const connectHandler = mockSocket.on.mock.calls.find(
        (call: any[]) => call[0] === SOCKET_EVENTS.CONNECT
      )?.[1];
      if (connectHandler) {
        connectHandler();
      }
    });

    const initialDataHandler = mockSocket.on.mock.calls.find(
      (call: any[]) => call[0] === SOCKET_EVENTS.INITIAL_DATA
    )?.[1];
    initialDataHandler?.(testData);

    expect(onInitialData).toHaveBeenCalledWith(testData);
  });

  it('sendMessage emits clientMessage event', () => {
    const { result } = renderHook(() =>
      useSocket({
        authToken: 'token',
        username: 'user',
        onInitialData: vi.fn(),
        onMessage: vi.fn(),
        onNewRoom: vi.fn(),
        onUserListUpdate: vi.fn(),
      })
    );

    result.current.sendMessage('#general', 'Hello');

    expect(mockSocket.emit).toHaveBeenCalledWith(SOCKET_EVENTS.CLIENT_MESSAGE, {
      username: 'user',
      room: '#general',
      content: 'Hello',
    });
  });

  it('createRoom emits clientNewRoom event', () => {
    const { result } = renderHook(() =>
      useSocket({
        authToken: 'token',
        username: 'user',
        onInitialData: vi.fn(),
        onMessage: vi.fn(),
        onNewRoom: vi.fn(),
        onUserListUpdate: vi.fn(),
      })
    );

    result.current.createRoom('testroom');

    expect(mockSocket.emit).toHaveBeenCalledWith(SOCKET_EVENTS.CLIENT_NEW_ROOM, 'testroom');
  });

  it('disconnect emits disconnect events and disconnects socket', () => {
    const { result } = renderHook(() =>
      useSocket({
        authToken: 'token',
        username: 'user',
        onInitialData: vi.fn(),
        onMessage: vi.fn(),
        onNewRoom: vi.fn(),
        onUserListUpdate: vi.fn(),
      })
    );

    result.current.disconnect();

    expect(mockSocket.emit).toHaveBeenCalledWith(SOCKET_EVENTS.CLIENT_MESSAGE, {
      username: 'user',
      room: expect.any(String),
      content: expect.any(String),
    });
    expect(mockSocket.emit).toHaveBeenCalledWith(SOCKET_EVENTS.CLIENT_DISCONNECTING, 'token');
    expect(mockSocket.disconnect).toHaveBeenCalled();
  });

  it('cleans up on unmount', () => {
    const { unmount } = renderHook(() =>
      useSocket({
        authToken: 'token',
        username: 'user',
        onInitialData: vi.fn(),
        onMessage: vi.fn(),
        onNewRoom: vi.fn(),
        onUserListUpdate: vi.fn(),
      })
    );

    unmount();

    expect(mockSocket.disconnect).toHaveBeenCalled();
  });
});

// src/hooks/useLogin.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useLogin } from './useLogin';
import { apiRequest } from '../utils/api';

vi.mock('../utils/api');

describe('useLogin hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns sessionId on successful login', async () => {
    const mockResponse = { sessionId: 'test-session-id' };
    (apiRequest as any).mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useLogin());

    const sessionId = await result.current.login('user', 'password');

    expect(sessionId).toBe('test-session-id');
    expect(apiRequest).toHaveBeenCalledWith('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'user', password: 'password' }),
    });
  });

  it('returns null and sets error on failed login', async () => {
    const mockResponse = { error: 'Invalid credentials' };
    (apiRequest as any).mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useLogin());

    const sessionId = await result.current.login('user', 'wrong');

    expect(sessionId).toBeNull();
    await waitFor(() => {
      expect(result.current.error).toBe('Invalid credentials');
    });
  });

  it('sets loading state during login', async () => {
    let resolvePromise: (value: any) => void;
    const promise = new Promise((resolve) => {
      resolvePromise = resolve;
    });
    (apiRequest as any).mockReturnValueOnce(promise);

    const { result } = renderHook(() => useLogin());

    const loginPromise = result.current.login('user', 'password');

    expect(result.current.isLoading).toBe(true);

    resolvePromise!({ sessionId: 'test' });
    await loginPromise;

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
  });

  it('handles API errors', async () => {
    const { ApiError } = await import('../utils/api');
    (apiRequest as any).mockRejectedValueOnce(new ApiError('Network error', 0));

    const { result } = renderHook(() => useLogin());

    const sessionId = await result.current.login('user', 'password');

    expect(sessionId).toBeNull();
    await waitFor(() => {
      expect(result.current.error).toBe('Network error');
    });
  });
});
```

#### Testing Components (100% Export Coverage)

```typescript
// src/components/Input.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Input } from './Input';

describe('Input component', () => {
  it('renders with label and value', () => {
    const onChange = vi.fn();
    render(
      <Input
        id="test-input"
        label="Test Label"
        value="test value"
        onChange={onChange}
      />
    );

    expect(screen.getByLabelText(/test label/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue('test value')).toBeInTheDocument();
  });

  it('calls onChange when value changes', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Input
        id="test-input"
        label="Test"
        value=""
        onChange={onChange}
      />
    );

    const input = screen.getByLabelText(/test/i);
    await user.type(input, 'new value');

    expect(onChange).toHaveBeenCalled();
  });

  it('displays error message when provided', () => {
    render(
      <Input
        id="test-input"
        label="Test"
        value=""
        onChange={vi.fn()}
        error="This is an error"
      />
    );

    expect(screen.getByText('This is an error')).toBeInTheDocument();
  });

  it('applies minLength attribute', () => {
    render(
      <Input
        id="test-input"
        label="Test"
        value=""
        onChange={vi.fn()}
        minLength={8}
      />
    );

    const input = screen.getByLabelText(/test/i);
    expect(input).toHaveAttribute('minLength', '8');
  });

  it('applies required attribute', () => {
    render(
      <Input
        id="test-input"
        label="Test"
        value=""
        onChange={vi.fn()}
        required={true}
      />
    );

    const input = screen.getByLabelText(/test/i);
    expect(input).toBeRequired();
  });

  it('uses name prop when provided', () => {
    render(
      <Input
        id="test-input"
        name="custom-name"
        label="Test"
        value=""
        onChange={vi.fn()}
      />
    );

    const input = screen.getByLabelText(/test/i);
    expect(input).toHaveAttribute('name', 'custom-name');
  });

  it('defaults name to id when not provided', () => {
    render(
      <Input
        id="test-input"
        label="Test"
        value=""
        onChange={vi.fn()}
      />
    );

    const input = screen.getByLabelText(/test/i);
    expect(input).toHaveAttribute('name', 'test-input');
  });
});

// src/components/SelectableList.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SelectableList } from './SelectableList';

describe('SelectableList component', () => {
  it('renders label and options', () => {
    const options = ['Option 1', 'Option 2', 'Option 3'];
    render(
      <SelectableList
        id="test-list"
        label="Test List"
        value="Option 1"
        options={options}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByText('Test List:')).toBeInTheDocument();
    expect(screen.getByText('Option 1')).toBeInTheDocument();
    expect(screen.getByText('Option 2')).toBeInTheDocument();
    expect(screen.getByText('Option 3')).toBeInTheDocument();
  });

  it('highlights active option', () => {
    render(
      <SelectableList
        id="test-list"
        label="Test"
        value="Option 2"
        options={['Option 1', 'Option 2', 'Option 3']}
        onSelect={vi.fn()}
      />
    );

    const activeOption = screen.getByText('Option 2');
    expect(activeOption).toHaveStyle({ 'font-weight': '700' });
  });

  it('calls onSelect when option is clicked', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <SelectableList
        id="test-list"
        label="Test"
        value="Option 1"
        options={['Option 1', 'Option 2']}
        onSelect={onSelect}
      />
    );

    await user.click(screen.getByText('Option 2'));

    expect(onSelect).toHaveBeenCalledWith('Option 2');
  });

  it('handles empty options array', () => {
    render(
      <SelectableList
        id="test-list"
        label="Test"
        value=""
        options={[]}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByText('Test:')).toBeInTheDocument();
  });
});
```

#### Testing Services (100% Export Coverage)

```typescript
// src/services/MessageService.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryMessageService, IMessageService } from './MessageService';
import type { Message } from '../types/types';

describe('MessageService', () => {
  let service: IMessageService;

  beforeEach(() => {
    service = new InMemoryMessageService(['#general', '#test']);
  });

  describe('addMessage', () => {
    it('adds message to existing room', () => {
      const message: Message = {
        timestamp: Date.now(),
        username: 'user1',
        content: 'Hello',
      };

      service.addMessage('#general', message);

      const messages = service.getMessages('#general');
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual(message);
    });

    it('creates room if it does not exist', () => {
      const message: Message = {
        timestamp: Date.now(),
        username: 'user1',
        content: 'Hello',
      };

      service.addMessage('#newroom', message);

      expect(service.getMessages('#newroom')).toHaveLength(1);
    });

    it('adds messages in reverse chronological order', () => {
      const message1: Message = {
        timestamp: 1000,
        username: 'user1',
        content: 'First',
      };
      const message2: Message = {
        timestamp: 2000,
        username: 'user2',
        content: 'Second',
      };

      service.addMessage('#general', message1);
      service.addMessage('#general', message2);

      const messages = service.getMessages('#general');
      expect(messages[0]).toEqual(message2);
      expect(messages[1]).toEqual(message1);
    });
  });

  describe('getMessages', () => {
    it('returns empty array for non-existent room', () => {
      expect(service.getMessages('#nonexistent')).toEqual([]);
    });

    it('returns all messages for room', () => {
      const messages: Message[] = [
        { timestamp: 1000, username: 'user1', content: 'Msg1' },
        { timestamp: 2000, username: 'user2', content: 'Msg2' },
      ];

      messages.forEach(msg => service.addMessage('#general', msg));

      expect(service.getMessages('#general')).toHaveLength(2);
    });
  });

  describe('getAllMessages', () => {
    it('returns all messages for all rooms', () => {
      service.addMessage('#general', {
        timestamp: 1000,
        username: 'user1',
        content: 'General msg',
      });
      service.addMessage('#test', {
        timestamp: 2000,
        username: 'user2',
        content: 'Test msg',
      });

      const allMessages = service.getAllMessages();

      expect(allMessages['#general']).toHaveLength(1);
      expect(allMessages['#test']).toHaveLength(1);
    });

    it('returns a copy, not a reference', () => {
      service.addMessage('#general', {
        timestamp: 1000,
        username: 'user1',
        content: 'Test',
      });

      const messages1 = service.getAllMessages();
      const messages2 = service.getAllMessages();

      expect(messages1).not.toBe(messages2);
      expect(messages1['#general']).not.toBe(messages2['#general']);
    });
  });
});

// src/services/RoomService.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryRoomService, IRoomService } from './RoomService';

describe('RoomService', () => {
  let service: IRoomService;

  beforeEach(() => {
    service = new InMemoryRoomService(['#general', '#test']);
  });

  describe('createRoom', () => {
    it('creates new room with # prefix', () => {
      const roomName = service.createRoom('newroom');
      expect(roomName).toBe('#newroom');
      expect(service.roomExists('#newroom')).toBe(true);
    });

    it('does not duplicate existing rooms', () => {
      const roomName1 = service.createRoom('general');
      const roomName2 = service.createRoom('general');

      expect(roomName1).toBe('#general');
      expect(roomName2).toBe('#general');
      expect(service.getRooms().filter(r => r === '#general')).toHaveLength(1);
    });

    it('handles room names that already have # prefix', () => {
      const roomName = service.createRoom('#alreadyformatted');
      expect(roomName).toBe('#alreadyformatted');
    });
  });

  describe('getRooms', () => {
    it('returns all rooms in alphabetical order', () => {
      service.createRoom('zebra');
      service.createRoom('alpha');

      const rooms = service.getRooms();
      expect(rooms[0]).toBe('#alpha');
      expect(rooms[rooms.length - 1]).toBe('#zebra');
    });

    it('returns a copy, not a reference', () => {
      const rooms1 = service.getRooms();
      const rooms2 = service.getRooms();

      expect(rooms1).not.toBe(rooms2);
    });
  });

  describe('roomExists', () => {
    it('returns true for existing room', () => {
      expect(service.roomExists('#general')).toBe(true);
    });

    it('returns false for non-existent room', () => {
      expect(service.roomExists('#nonexistent')).toBe(false);
    });
  });
});
```

#### Testing API Routes (100% Export Coverage)

```typescript
// src/app/api/login/route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './route';
import { NextRequest } from 'next/server';
import { myUserCache, mySessionCache } from '../../../cache';
import { hashPassword } from '../../../utils/crypto';

vi.mock('../../../cache');
vi.mock('../../../utils/crypto');

describe('POST /api/login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (myUserCache.has as any).mockReturnValue(false);
    (myUserCache.get as any).mockReturnValue(null);
    (myUserCache.set as any).mockReturnValue(true);
    (mySessionCache.set as any).mockReturnValue(true);
  });

  it('creates new user when username does not exist', async () => {
    const hashedPassword = 'hashed-password';
    (hashPassword as any).mockResolvedValue(hashedPassword);

    const request = new NextRequest('http://localhost/api/login', {
      method: 'POST',
      body: JSON.stringify({
        username: 'newuser123',
        password: 'password123',
      }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(data.sessionId).toBeDefined();
    expect(myUserCache.set).toHaveBeenCalledWith('newuser123', hashedPassword);
    expect(mySessionCache.set).toHaveBeenCalled();
  });

  it('authenticates existing user with correct password', async () => {
    const hashedPassword = 'hashed-password';
    (myUserCache.has as any).mockReturnValue(true);
    (myUserCache.get as any).mockReturnValue(hashedPassword);
    (hashPassword as any).mockResolvedValue(hashedPassword);

    const request = new NextRequest('http://localhost/api/login', {
      method: 'POST',
      body: JSON.stringify({
        username: 'existinguser',
        password: 'correctpassword',
      }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(data.sessionId).toBeDefined();
    expect(data.error).toBeUndefined();
  });

  it('rejects existing user with incorrect password', async () => {
    (myUserCache.has as any).mockReturnValue(true);
    (myUserCache.get as any).mockReturnValue('stored-hash');
    (hashPassword as any).mockResolvedValue('different-hash');

    const request = new NextRequest('http://localhost/api/login', {
      method: 'POST',
      body: JSON.stringify({
        username: 'existinguser',
        password: 'wrongpassword',
      }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(data.error).toBe('Invalid Credentials');
    expect(data.sessionId).toBeUndefined();
  });

  it('rejects username shorter than minimum length', async () => {
    const request = new NextRequest('http://localhost/api/login', {
      method: 'POST',
      body: JSON.stringify({
        username: 'short',
        password: 'password123',
      }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(data.error).toContain('at least');
  });

  it('rejects password shorter than minimum length', async () => {
    const request = new NextRequest('http://localhost/api/login', {
      method: 'POST',
      body: JSON.stringify({
        username: 'validusername',
        password: 'short',
      }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(data.error).toContain('at least');
  });

  it('rejects request with missing parameters', async () => {
    const request = new NextRequest('http://localhost/api/login', {
      method: 'POST',
      body: JSON.stringify({
        username: 'user',
      }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(data.error).toBe('Required parameters missing');
  });
});
```

### Package.json Additions

```json
{
  "scripts": {
    "test": "vitest",
    "test:watch": "vitest --watch",
    "test:ui": "vitest --ui",
    "test:coverage": "vitest --coverage",
    "test:coverage:ui": "vitest --coverage --ui"
  },
  "devDependencies": {
    "@testing-library/react": "^14.0.0",
    "@testing-library/jest-dom": "^6.1.0",
    "@testing-library/user-event": "^14.5.0",
    "@vitejs/plugin-react": "^4.2.0",
    "jsdom": "^22.1.0",
    "vitest": "^1.0.0",
    "@vitest/ui": "^1.0.0",
    "@vitest/coverage-v8": "^1.0.0"
  }
}
```

### Coverage Verification Script

```typescript
// scripts/check-coverage.ts
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// Run coverage
execSync('npm run test:coverage', { stdio: 'inherit' });

// Read coverage summary
const coveragePath = path.join(process.cwd(), 'coverage', 'coverage-summary.json');
const coverage = JSON.parse(fs.readFileSync(coveragePath, 'utf-8'));

// Check all exports are covered
const thresholds = {
  lines: 80,
  statements: 80,
  functions: 80,
  branches: 80,
};

let failed = false;

for (const [file, data] of Object.entries(coverage)) {
  if (file === 'total') continue;
  
  const fileData = data as any;
  for (const [metric, threshold] of Object.entries(thresholds)) {
    const percentage = fileData[metric]?.pct || 0;
    if (percentage < threshold) {
      console.error(
        `❌ ${file}: ${metric} coverage ${percentage}% is below threshold ${threshold}%`
      );
      failed = true;
    }
  }
}

if (failed) {
  console.error('\n❌ Coverage thresholds not met');
  process.exit(1);
} else {
  console.log('\n✅ All coverage thresholds met');
}
```

### Test File Structure

```
src/
├── components/
│   ├── Input.tsx
│   ├── Input.test.tsx          # Tests all exports from Input.tsx
│   ├── LoginDialog.tsx
│   ├── LoginDialog.test.tsx    # Tests all exports from LoginDialog.tsx
│   └── SelectableList.tsx
│   └── SelectableList.test.tsx # Tests all exports from SelectableList.tsx
├── hooks/
│   ├── useSocket.ts
│   ├── useSocket.test.ts       # Tests all exports from useSocket.ts
│   └── useLogin.ts
│   └── useLogin.test.ts        # Tests all exports from useLogin.ts
├── services/
│   ├── MessageService.ts
│   ├── MessageService.test.ts  # Tests all exports from MessageService.ts
│   └── RoomService.ts
│   └── RoomService.test.ts     # Tests all exports from RoomService.ts
├── utils/
│   ├── validation.ts
│   ├── validation.test.ts      # Tests all exports from validation.ts
│   └── api.ts
│   └── api.test.ts             # Tests all exports from api.ts
└── app/
    └── api/
        └── login/
            ├── route.ts
            └── route.test.ts    # Tests all exports from route.ts
```

### Benefits

- **100% Export Coverage**: Every exported function, class, and component is tested
- **Fast Execution**: Vitest is faster than Jest, especially with watch mode
- **Native ESM Support**: Works seamlessly with TypeScript and modern JavaScript
- **Great DX**: Built-in UI, coverage reports, and watch mode
- **Incremental Testing**: Can test individual files as you refactor
- **Type Safety**: Full TypeScript support in tests
- **Confidence**: Comprehensive coverage ensures all code paths are verified
- **Documentation**: Tests serve as living documentation of expected behavior

---

## Implementation Priority

### Phase 1: Foundation (Week 1)
1. Extract Constants (#1)
2. Extract Validation Logic (#5)
3. Improve Type Safety (#4)
4. Extract Styled Components (#7)

### Phase 2: Architecture (Week 2)
5. Extract Socket Service Layer (#3)
6. Create Custom Hooks (#2)
7. Add Configuration Management (#10)

### Phase 3: Refactoring (Week 3)
8. Component Decomposition (#6)
9. Improve Error Handling (#8)
10. Remove Unused Dependencies (#9)

### Phase 4: Quality & Security (Week 4)
11. Security Improvements (#11)
12. Testing Infrastructure (#12)

---

## Notes

- Each improvement can be implemented independently
- All changes maintain backward compatibility
- Test after each change to verify functionality
- Consider feature flags for larger refactorings
- Document breaking changes if any occur

