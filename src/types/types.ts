export type MessageVersion = {
  encryptedFor: Record<string, string>; // Map of username -> encrypted message
  version: number;
  changeSummary?: string; // e.g., "added key for user X", "user edited message content"
  timestamp: number;
};

export type Message = {
  timestamp: number;
  username: string;
  content: string;
  encryptedFor?: Record<string, string>; // Map of username -> encrypted message (for backward compatibility)
  versions?: MessageVersion[]; // Array of message versions, newest first
  currentVersion?: number; // Index of current version in versions array
  replyTo?: number; // Timestamp of the message this is replying to
  visibleTo?: string[]; // List of usernames who can see this message
  voteTotal?: number; // Total vote count (upvotes - downvotes)
  userVotes?: Record<string, 'up' | 'down'>; // Map of username -> vote type
  edited?: boolean; // Whether the message has been edited
};
export type Messages = {
  [key: string]: Message[];
};
