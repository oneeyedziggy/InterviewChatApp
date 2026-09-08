import {
  useHomeAuthContext,
  useHomeComposerContext,
  useHomePresenceContext,
  useHomeRoomsContext,
} from './HomePageContext';

export const useHomeRooms = () => {
  return useHomeRoomsContext();
};

export const useHomeComposer = () => {
  return useHomeComposerContext();
};

export const useHomePresence = () => {
  return useHomePresenceContext();
};

export const useHomeAuth = () => {
  return useHomeAuthContext();
};
