export const countUnicodeCodePoints = (value: string): number => {
  return Array.from(value).length;
};

export const normalizeRoomName = (roomName: string): string => {
  return roomName.trim().normalize('NFC').toLowerCase();
};
