export type RoomWindowLoadedDetail = {
  direction: unknown;
  room: unknown;
  hasMore: unknown;
};

export const dispatchRoomWindowLoaded = (detail: RoomWindowLoadedDetail) => {
  window.dispatchEvent(new CustomEvent('chat-room-window-loaded', { detail }));
};
