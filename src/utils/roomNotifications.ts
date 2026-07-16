import { type Messages } from '../types/types';

export function computeRoomNotifications(
  oldChatValues: Messages,
  chatValues: Messages,
  currentRoom: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.keys(oldChatValues).map((roomName: string) => {
      return chatValues[roomName]?.length > oldChatValues[roomName]?.length &&
        !(roomName === currentRoom)
        ? [
            roomName,
            `(${chatValues[roomName]?.length - oldChatValues[roomName]?.length} NEW!)`,
          ]
        : [roomName, ''];
    }),
  );
}
