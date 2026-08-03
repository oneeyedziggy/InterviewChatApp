import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HomeLeftPanel } from './HomeLeftPanel';

const homeRoomsMock = vi.hoisted(() => ({
  useHomeRooms: vi.fn(),
}));

let homeRoomsState: ReturnType<
  typeof homeRoomsMock.useHomeRooms.mockReturnValue
> | null = null;

vi.mock('../../contexts/home/useHomePageSelectors', () => homeRoomsMock);

vi.mock('../../utils/dmRooms', () => ({
  isDmRoom: (room: string) => room.startsWith('@dmid:'),
  getRoomDisplayLabel: (room: string) => `label:${room}`,
}));

describe('HomeLeftPanel', () => {
  beforeEach(() => {
    homeRoomsState = {
      currentRoom: 'general',
      username: 'alice',
      roomList: ['general', 'random', '@dmid:alice|bob', 'hidden-room'],
      leftRooms: new Set(['hidden-room']),
      roomNotifications: {
        random: 2,
        '@dmid:alice|bob': 1,
      },
      newRoomName: '',
      setCurrentRoom: vi.fn(),
      setNewRoomName: vi.fn(),
      hideRoom: vi.fn(),
      showRoom: vi.fn(),
      onNewRoomKeyDownHandler: vi.fn(),
      makeNewRoom: vi.fn(),
    };
    homeRoomsMock.useHomeRooms.mockReturnValue(homeRoomsState as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders room and dm sections, hides rooms, and toggles collapse', async () => {
    const user = userEvent.setup();

    render(<HomeLeftPanel />);

    expect(screen.getByRole('button', { name: /rooms/i })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /direct messages/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'label:general' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /label:random \(2\)/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /label:@dmid:alice\|bob \(1\)/i }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: /hide label:random/i }),
    );
    expect(homeRoomsState?.hideRoom).toHaveBeenCalledWith('random');

    await user.click(screen.getByRole('button', { name: /rooms/i }));
    expect(
      screen.queryByRole('button', { name: /label:general/i }),
    ).not.toBeInTheDocument();
  });

  it('shows rejoin suggestions and creates rooms', async () => {
    const user = userEvent.setup();

    render(<HomeLeftPanel />);

    const input = screen.getByLabelText(/new room name/i);
    await user.click(input);

    expect(
      screen.getByRole('button', { name: /label:hidden-room/i }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: /label:hidden-room/i }),
    );
    expect(homeRoomsState?.showRoom).toHaveBeenCalledWith('hidden-room');
    expect(homeRoomsState?.setNewRoomName).toHaveBeenCalledWith('');

    await user.click(screen.getByRole('button', { name: /make new room/i }));
    expect(homeRoomsState?.makeNewRoom).toHaveBeenCalledTimes(1);
  });
});
