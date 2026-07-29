export type MessageVersion = {
  encryptedMessage?: string; // Single ciphertext encrypted to multiple recipients
  encryptedFor?: Record<string, string>; // Legacy field
  version: number;
  changeSummary?: string; // e.g., "added key for user X", "user edited message content"
  timestamp: number;
};

export type Message = {
  id?: string;
  timestamp: number;
  username?: string;
  userId: string;
  roomId: string;
  content: string;
  keyTransferEncryptedPackage?: string;
  keyTransferFromUserId?: string;
  encryptedMessage?: string; // Single ciphertext encrypted to multiple recipients
  encryptedFor?: Record<string, string>; // Map of userId -> encrypted message (legacy payloads may still include username keys)
  versions?: MessageVersion[]; // Array of message versions, newest first
  currentVersion?: number; // Index of current version in versions array
  replyTo?: number; // Timestamp of the message this is replying to
  visibleTo?: string[]; // List of userIds who can see this message
  voteTotal?: number; // Total vote count (upvotes - downvotes)
  userVotes?: Record<string, 'up' | 'down'>; // Map of userId -> vote type
  edited?: boolean; // Whether the message has been edited
  deleted?: boolean; // Whether the message was deleted by the original author
};
export type Messages = {
  [key: string]: Message[];
};
