import { SelectableList } from '../SelectableList';
import { getRoomDisplayLabel } from '../../utils/dmRooms';
import {
  SidePanel,
  BlockTextInput,
  PrimaryButton,
  VerticalResizableSections,
} from './LayoutPrimitives';
import { useHomeRooms } from '../../contexts/home/useHomePageSelectors';

export function HomeLeftPanel() {
  const {
    currentRoom,
    username,
    roomList,
    leftRooms,
    roomNotifications,
    newRoomName,
    setCurrentRoom,
    setNewRoomName,
    onNewRoomKeyDownHandler,
    makeNewRoom,
  } = useHomeRooms();

  return (
    <SidePanel>
      <VerticalResizableSections
        storageKey="home.layout.left.roomsSectionPct"
        defaultTopSize={80}
        top={
          <div className="flex h-full min-h-0 flex-col">
            <SelectableList
              id="roomSelection"
              label={'Rooms'}
              value={currentRoom}
              options={roomList
                .filter((room) => !leftRooms.has(room))
                .map((room) => ({
                  value: room,
                  label: `${getRoomDisplayLabel(room, username)}${
                    roomNotifications[room] ? `-${roomNotifications[room]}` : ''
                  }`,
                }))}
              onSelect={setCurrentRoom}
            />
          </div>
        }
        bottom={
          <div className="app-left-room-create">
            <label
              htmlFor="newRoomNameInput"
              className="text-sm text-app-muted"
            >
              New Room Name:
            </label>
            <BlockTextInput
              type="text"
              id="newRoomNameInput"
              value={newRoomName}
              onChange={(e) => setNewRoomName(e.target.value)}
              onKeyDown={onNewRoomKeyDownHandler}
            />
            <PrimaryButton
              type="button"
              id="createNewRoomButton"
              onClick={makeNewRoom}
              className="app-left-room-create-button"
            >
              Make New Room
            </PrimaryButton>
          </div>
        }
      />
    </SidePanel>
  );
}
