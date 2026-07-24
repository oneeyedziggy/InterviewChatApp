import { useMemo, useState } from 'react';
import { getRoomDisplayLabel, isDmRoom } from '../../utils/dmRooms';
import {
  SidePanel,
  BlockTextInput,
  PrimaryButton,
  VerticalResizableSections,
} from './LayoutPrimitives';
import { useHomeRooms } from '../../contexts/home/useHomePageSelectors';

type RoomTreeNode = {
  id: string;
  label: string;
  roomId?: string;
  children?: RoomTreeNode[];
};

type RoomTreeSection = {
  id: string;
  label: string;
  nodes: RoomTreeNode[];
};

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
  const [collapsedSections, setCollapsedSections] = useState<
    Record<string, boolean>
  >({
    channels: false,
    dms: false,
  });

  const visibleRooms = useMemo(
    () => roomList.filter((room) => !leftRooms.has(room)),
    [roomList, leftRooms],
  );

  const visibleNonDmRooms = useMemo(
    () => visibleRooms.filter((room) => !isDmRoom(room)),
    [visibleRooms],
  );

  const visibleDmRooms = useMemo(
    () => visibleRooms.filter((room) => isDmRoom(room)),
    [visibleRooms],
  );

  const rejoinableRooms = useMemo(
    () => roomList.filter((room) => leftRooms.has(room) && !isDmRoom(room)),
    [roomList, leftRooms],
  );

  const treeSections = useMemo<RoomTreeSection[]>(() => {
    const toNode = (room: string): RoomTreeNode => ({
      id: room,
      label: getRoomDisplayLabel(room, username),
      roomId: room,
      children: [],
    });

    return [
      {
        id: 'channels',
        label: 'Rooms',
        nodes: visibleNonDmRooms.map(toNode),
      },
      {
        id: 'dms',
        label: 'Direct Messages',
        nodes: visibleDmRooms.map(toNode),
      },
    ];
  }, [visibleNonDmRooms, visibleDmRooms, username]);

  const toggleSection = (sectionId: string) => {
    setCollapsedSections((prev) => ({
      ...prev,
      [sectionId]: !prev[sectionId],
    }));
  };

  const renderTreeNode = (node: RoomTreeNode, depth = 0) => {
    const room = node.roomId;
    if (!room) {
      return null;
    }

    const isActive = room === currentRoom;
    const unreadCount = !isActive ? roomNotifications[room] || 0 : 0;

    return (
      <div key={node.id}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid var(--app-border)',
            background: isActive
              ? 'color-mix(in srgb, var(--brand-blue) 26%, var(--app-surface) 74%)'
              : 'var(--app-surface)',
            color: 'var(--app-fg)',
            fontWeight: isActive ? 700 : 500,
            padding: '3px 6px 3px 10px',
            paddingLeft: `${10 + depth * 16}px`,
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
              fontSize: '12px',
            }}
            onClick={() => setCurrentRoom(room)}
            title={room}
          >
            {node.label}
            {unreadCount > 0 ? ` (${unreadCount})` : ''}
          </button>
          <button
            type="button"
            onClick={() => hideRoom(room)}
            title="Hide room"
            aria-label={`Hide ${node.label}`}
            style={{
              border: 'none',
              background: 'transparent',
              color: 'var(--app-muted)',
              cursor: 'pointer',
              fontWeight: 700,
              lineHeight: 1,
              padding: '0 2px',
            }}
          >
            X
          </button>
        </div>
        {(node.children || []).map((child) => renderTreeNode(child, depth + 1))}
      </div>
    );
  };

  return (
    <SidePanel>
      <VerticalResizableSections
        storageKey="home.layout.left.roomsSectionPct"
        defaultTopSize={80}
        top={
          <div className="flex h-full min-h-0 flex-col">
            <div id="roomSelection" className="flex-1">
              <div
                style={{
                  overflowY: 'auto',
                  border: '1px solid var(--app-border)',
                }}
              >
                {treeSections.map((section) => {
                  if (section.nodes.length === 0) {
                    return null;
                  }

                  const isCollapsed = !!collapsedSections[section.id];
                  return (
                    <div key={section.id}>
                      <button
                        type="button"
                        onClick={() => toggleSection(section.id)}
                        aria-expanded={!isCollapsed}
                        style={{
                          width: '100%',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          border: 'none',
                          borderTop: '1px solid var(--app-border)',
                          borderBottom: '1px solid var(--app-border)',
                          background: 'var(--app-panel)',
                          color: 'var(--app-muted)',
                          fontSize: '13px',
                          fontWeight: 800,
                          letterSpacing: '0.01em',
                          padding: '6px 10px',
                          cursor: 'pointer',
                        }}
                      >
                        <span>{section.label}</span>
                        <span style={{ fontSize: '10px' }}>
                          {isCollapsed ? '▸' : '▾'} {section.nodes.length}
                        </span>
                      </button>

                      {!isCollapsed && (
                        <div>
                          {section.nodes.map((node) => renderTreeNode(node, 0))}
                        </div>
                      )}
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
