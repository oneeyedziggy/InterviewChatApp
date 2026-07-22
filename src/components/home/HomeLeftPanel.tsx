import { useMemo, useState } from 'react';
import { getRoomDisplayLabel, isDmRoom } from '../../utils/dmRooms';
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
    hideRoom,
    showRoom,
    onNewRoomKeyDownHandler,
    makeNewRoom,
  } = useHomeRooms();

  const [showAutocomplete, setShowAutocomplete] = useState(false);

  const visibleRooms = useMemo(
    () => roomList.filter((room) => !leftRooms.has(room)),
    [roomList, leftRooms],
  );

  const rejoinableRooms = useMemo(
    () => roomList.filter((room) => leftRooms.has(room) && !isDmRoom(room)),
    [roomList, leftRooms],
  );

  return (
    <SidePanel>
      <VerticalResizableSections
        storageKey="home.layout.left.roomsSectionPct"
        defaultTopSize={80}
        top={
          <div className="flex h-full min-h-0 flex-col">
            <div id="roomSelection" className="flex-1">
              <div>Rooms:</div>
              <div
                style={{
                  marginTop: '2px',
                  overflowY: 'auto',
                  border: '1px solid var(--app-border)',
                }}
              >
                {visibleRooms.map((room) => {
                  const isActive = room === currentRoom;
                  return (
                    <div
                      key={room}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        borderBottom: '1px solid var(--app-border)',
                        background: isActive ? '#b8ccee' : '#e5edf9',
                        color: '#0c1b33',
                        fontWeight: isActive ? 700 : 500,
                        padding: '3px 6px 3px 10px',
                        gap: '6px',
                      }}
                    >
                      <button
                        type="button"
                        style={{
                          all: 'unset',
                          flex: 1,
                          cursor: 'pointer',
                          minWidth: 0,
                        }}
                        onClick={() => setCurrentRoom(room)}
                        title={room}
                      >
                        {getRoomDisplayLabel(room, username)}
                        {roomNotifications[room]
                          ? `-${roomNotifications[room]}`
                          : ''}
                      </button>
                      <button
                        type="button"
                        onClick={() => hideRoom(room)}
                        title="Hide room"
                        aria-label={`Hide ${getRoomDisplayLabel(room, username)}`}
                        style={{
                          border: 'none',
                          background: 'transparent',
                          color: '#355170',
                          cursor: 'pointer',
                          fontWeight: 700,
                          lineHeight: 1,
                          padding: '0 2px',
                        }}
                      >
                        X
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
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
            <div style={{ position: 'relative' }}>
              <BlockTextInput
                type="text"
                id="newRoomNameInput"
                value={newRoomName}
                onChange={(e) => {
                  setNewRoomName(e.target.value);
                  if (e.target.value.trim() !== '') {
                    setShowAutocomplete(false);
                  }
                }}
                onFocus={() => {
                  if (newRoomName.trim() === '' && rejoinableRooms.length > 0) {
                    setShowAutocomplete(true);
                  }
                }}
                onBlur={() => {
                  window.setTimeout(() => setShowAutocomplete(false), 120);
                }}
                onKeyDown={onNewRoomKeyDownHandler}
                autoComplete="off"
              />
              {showAutocomplete && newRoomName.trim() === '' && (
                <div
                  style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    top: '100%',
                    marginTop: '4px',
                    zIndex: 50,
                    border: '1px solid var(--app-border)',
                    borderRadius: '8px',
                    background: 'var(--app-surface)',
                    boxShadow: '0 10px 24px rgba(0,0,0,0.2)',
                    maxHeight: '140px',
                    overflowY: 'auto',
                  }}
                >
                  {rejoinableRooms.length === 0 && (
                    <div
                      style={{
                        padding: '8px 10px',
                        fontSize: '12px',
                        color: 'var(--app-muted)',
                      }}
                    >
                      No hidden non-DM rooms
                    </div>
                  )}
                  {rejoinableRooms.map((room) => (
                    <button
                      key={room}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        showRoom(room);
                        setNewRoomName('');
                        setShowAutocomplete(false);
                      }}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        border: 'none',
                        background: 'transparent',
                        color: 'var(--app-fg)',
                        cursor: 'pointer',
                        padding: '8px 10px',
                        fontSize: '12px',
                      }}
                    >
                      {getRoomDisplayLabel(room, username)}
                    </button>
                  ))}
                </div>
              )}
            </div>
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
