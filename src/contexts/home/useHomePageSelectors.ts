import {
  useHomeAuthContext,
  useHomeComposerContext,
  useHomePresenceContext,
  useHomeRoomsContext,
} from './HomePageContext';

export function useHomeRooms() {
  return useHomeRoomsContext();
}

export function useHomeComposer() {
  return useHomeComposerContext();
}

export function useHomePresence() {
  return useHomePresenceContext();
}

export function useHomeAuth() {
  return useHomeAuthContext();
}
