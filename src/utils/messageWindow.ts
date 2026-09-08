import type { Message } from '../types/types';

export const MESSAGE_WINDOW_SIZE = 100;

export const messageWindowIdentity = (
  message: Pick<Message, 'id' | 'timestamp'>,
): string =>
  message.id ? `id:${message.id}` : `timestamp:${message.timestamp}`;

export const mergeMessageWindow = (
  existing: Message[],
  incoming: Message[],
  direction: 'newer' | 'older' = 'newer',
  limit = MESSAGE_WINDOW_SIZE,
): Message[] => {
  const merged = new Map<string, Message>();
  for (const message of existing)
    merged.set(messageWindowIdentity(message), message);
  for (const message of incoming) {
    const identity = messageWindowIdentity(message);
    merged.set(identity, { ...merged.get(identity), ...message });
  }

  const sorted = [...merged.values()].sort(
    (left, right) =>
      left.timestamp - right.timestamp ||
      (left.id || '').localeCompare(right.id || ''),
  );
  if (sorted.length <= limit) return sorted;
  return direction === 'older' ? sorted.slice(0, limit) : sorted.slice(-limit);
};
