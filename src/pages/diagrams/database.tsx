'use client';

import Head from 'next/head';
import Link from 'next/link';
import { useEffect, useMemo, useRef } from 'react';
import * as go from 'gojs';
import styles from '../../styles/DatabaseSchema.module.css';

type FieldSpec = {
  name: string;
  type: string;
  key?: string;
};

type TableSpec = {
  key: string;
  name: string;
  notes: string;
  loc: string;
  fields: FieldSpec[];
};

type TriggerSpec = {
  key: string;
  category: 'trigger';
  name: string;
  notes: string;
  loc: string;
};

type RelationshipSpec = {
  from: string;
  fromPort: string;
  to: string;
  toPort: string;
  label: string;
  category: 'fk' | 'trigger';
  notes?: string;
};

const TOP_PORT = '__top';
const BOTTOM_PORT = '__bottom';

const TABLE_WIDTH = 560;
const TABLE_LEFT_X = 20;
const TABLE_RIGHT_X = 1280;
const TABLE_TOP_Y = 20;
const TRIGGER_Y = 610;
const TABLE_BOTTOM_Y = 740;

const TRIGGER: TriggerSpec = {
  key: 'trg_message_index_history_on_update',
  category: 'trigger',
  name: 'trg_message_index_history_on_update',
  notes:
    'BEFORE UPDATE ON messages writes the old message row to message_history when indexed message content changes.',
  loc: `${TABLE_LEFT_X} ${TRIGGER_Y}`,
};

const TABLES: TableSpec[] = [
  {
    key: 'users',
    name: 'users',
    notes: 'Account identities and directory metadata.',
    loc: `${TABLE_RIGHT_X - 100} ${TABLE_TOP_Y + 350}`,
    fields: [
      { name: 'user_id', type: 'TEXT NOT NULL', key: 'PK UNIQUE' },
      { name: 'username', type: "TEXT NOT NULL DEFAULT ''" },
      { name: 'public_key', type: 'TEXT' },
      { name: 'public_key_updated_at', type: 'INTEGER NOT NULL DEFAULT 0' },
      { name: 'username_ciphertext', type: 'TEXT' },
      { name: 'directory_updated_at', type: 'INTEGER NOT NULL DEFAULT 0' },
      { name: 'invited_by_user_id', type: 'TEXT' },
      { name: 'joined_at', type: 'INTEGER NOT NULL DEFAULT 0' },
      { name: 'updated_at', type: 'INTEGER NOT NULL' },
    ],
  },
  {
    key: 'rooms',
    name: 'rooms',
    notes: 'Room directory records and display metadata.',
    loc: `${TABLE_RIGHT_X} ${TABLE_BOTTOM_Y}`,
    fields: [
      { name: 'room_id', type: 'TEXT NOT NULL', key: 'PK UNIQUE' },
      { name: 'room_key', type: 'TEXT NOT NULL UNIQUE' },
      { name: 'room_name_hash', type: 'TEXT' },
      { name: 'room_name_ciphertext', type: 'TEXT' },
      { name: 'directory_updated_at', type: 'INTEGER NOT NULL DEFAULT 0' },
      { name: 'room_order', type: 'INTEGER NOT NULL DEFAULT 0' },
      { name: 'created_at', type: 'INTEGER NOT NULL DEFAULT 0' },
      { name: 'updated_at', type: 'INTEGER NOT NULL' },
    ],
  },
  {
    key: 'messages',
    name: 'messages',
    notes: 'Current message state, visibility, and vote metadata.',
    loc: `${TABLE_LEFT_X} ${TABLE_TOP_Y}`,
    fields: [
      { name: 'message_id', type: 'TEXT NOT NULL', key: 'PK UNIQUE' },
      { name: 'room_id', type: 'TEXT NOT NULL', key: 'FK rooms.room_id' },
      { name: 'user_id', type: 'TEXT NOT NULL', key: 'FK users.user_id' },
      { name: 'created_at', type: 'INTEGER NOT NULL' },
      { name: 'content', type: 'TEXT' },
      { name: 'key_transfer_encrypted_package', type: 'TEXT' },
      { name: 'key_transfer_from_user_id', type: 'TEXT' },
      { name: 'encrypted_message', type: 'TEXT' },
      { name: 'encrypted_for_json', type: 'TEXT' },
      { name: 'versions_json', type: 'TEXT' },
      { name: 'current_version', type: 'INTEGER' },
      { name: 'visible_to_json', type: 'TEXT' },
      { name: 'reply_to', type: 'INTEGER' },
      { name: 'vote_total', type: 'INTEGER' },
      { name: 'user_votes_json', type: 'TEXT' },
      { name: 'edited', type: 'INTEGER NOT NULL DEFAULT 0' },
      { name: 'deleted', type: 'INTEGER NOT NULL DEFAULT 0' },
      { name: 'updated_at', type: 'INTEGER NOT NULL' },
    ],
  },
  {
    key: 'message_history',
    name: 'message_history',
    notes: 'Trigger-captured historical versions of message rows.',
    loc: `${TABLE_LEFT_X} ${TABLE_BOTTOM_Y}`,
    fields: [
      {
        name: 'history_id',
        type: 'INTEGER PRIMARY KEY AUTOINCREMENT',
        key: 'PK NOT NULL UNIQUE',
      },
      {
        name: 'message_id',
        type: 'TEXT NOT NULL',
        key: 'FK messages.message_id',
      },
      { name: 'room_id', type: 'TEXT NOT NULL' },
      { name: 'user_id', type: 'TEXT NOT NULL' },
      { name: 'created_at', type: 'INTEGER NOT NULL' },
      { name: 'content', type: 'TEXT' },
      { name: 'key_transfer_encrypted_package', type: 'TEXT' },
      { name: 'key_transfer_from_user_id', type: 'TEXT' },
      { name: 'encrypted_message', type: 'TEXT' },
      { name: 'encrypted_for_json', type: 'TEXT' },
      { name: 'versions_json', type: 'TEXT' },
      { name: 'current_version', type: 'INTEGER' },
      { name: 'visible_to_json', type: 'TEXT' },
      { name: 'reply_to', type: 'INTEGER' },
      { name: 'vote_total', type: 'INTEGER' },
      { name: 'user_votes_json', type: 'TEXT' },
      { name: 'edited', type: 'INTEGER NOT NULL' },
      { name: 'deleted', type: 'INTEGER NOT NULL' },
      { name: 'updated_at', type: 'INTEGER NOT NULL' },
    ],
  },
  {
    key: 'invites',
    name: 'invites',
    notes: 'Hash-only, expiring invite capabilities and their lifecycle state.',
    loc: `${TABLE_LEFT_X} ${TABLE_BOTTOM_Y + 360}`,
    fields: [
      { name: 'invite_id', type: 'TEXT NOT NULL', key: 'PK UNIQUE' },
      { name: 'code_hash', type: 'TEXT NOT NULL UNIQUE' },
      { name: 'created_by_user_id', type: 'TEXT NOT NULL' },
      { name: 'created_at', type: 'INTEGER NOT NULL' },
      { name: 'expires_at', type: 'INTEGER NOT NULL' },
      { name: 'status', type: "TEXT NOT NULL DEFAULT 'active'" },
      { name: 'max_uses', type: 'INTEGER' },
      { name: 'used_count', type: 'INTEGER NOT NULL DEFAULT 0' },
    ],
  },
  {
    key: 'access_grant_requests',
    name: 'access_grant_requests',
    notes: 'Opaque durable requests for offline message access approval.',
    loc: `${TABLE_RIGHT_X} ${TABLE_BOTTOM_Y + 520}`,
    fields: [
      { name: 'request_id', type: 'TEXT NOT NULL', key: 'PK UNIQUE' },
      { name: 'requesting_user_id', type: 'TEXT NOT NULL' },
      { name: 'original_sender_id', type: 'TEXT NOT NULL' },
      { name: 'original_room_id', type: 'TEXT NOT NULL' },
      { name: 'message_timestamp', type: 'INTEGER NOT NULL' },
      { name: 'created_at', type: 'INTEGER NOT NULL' },
      { name: 'status', type: "TEXT NOT NULL DEFAULT 'pending'" },
    ],
  },
];

const RELATIONSHIPS: RelationshipSpec[] = [
  {
    from: 'messages',
    fromPort: 'room_id',
    to: 'rooms',
    toPort: 'room_id',
    label: 'FK messages.room_id -> rooms.room_id',
    category: 'fk',
  },
  {
    from: 'messages',
    fromPort: 'user_id',
    to: 'users',
    toPort: 'user_id',
    label: 'FK messages.user_id -> users.user_id',
    category: 'fk',
  },
  {
    from: 'message_history',
    fromPort: 'room_id',
    to: 'rooms',
    toPort: 'room_id',
    label: 'history room_id -> rooms.room_id',
    category: 'fk',
  },
  {
    from: 'message_history',
    fromPort: 'user_id',
    to: 'users',
    toPort: 'user_id',
    label: 'history user_id -> users.user_id',
    category: 'fk',
  },
  {
    from: 'invites',
    fromPort: 'created_by_user_id',
    to: 'users',
    toPort: 'user_id',
    label: 'invites.created_by_user_id -> users.user_id',
    category: 'fk',
  },
  {
    from: 'access_grant_requests',
    fromPort: 'original_room_id',
    to: 'rooms',
    toPort: 'room_id',
    label: 'access requests room -> rooms.room_id',
    category: 'fk',
  },
];

const TRIGGER_LINKS: RelationshipSpec[] = [
  {
    from: 'messages',
    fromPort: BOTTOM_PORT,
    to: TRIGGER.key,
    toPort: TOP_PORT,
    label: 'BEFORE UPDATE',
    category: 'trigger',
    notes: 'Trigger watches messages updates.',
  },
  {
    from: TRIGGER.key,
    fromPort: BOTTOM_PORT,
    to: 'message_history',
    toPort: TOP_PORT,
    label: 'INSERT OLD ROW',
    category: 'trigger',
    notes: 'Trigger inserts the old row into message_history.',
  },
];

const readThemeColors = () => {
  if (typeof window === 'undefined') {
    return {
      surface: '#ffffff',
      panel: '#eef6ff',
      border: '#b9cce8',
      fg: '#0c1b33',
      muted: '#4a5e83',
      blue: '#004ca8',
      cyan: '#006f84',
    };
  }

  const rootStyles = window.getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) =>
    rootStyles.getPropertyValue(name).trim() || fallback;

  return {
    surface: read('--app-surface', '#ffffff'),
    panel: read('--app-panel', '#eef6ff'),
    border: read('--app-border', '#b9cce8'),
    fg: read('--app-fg', '#0c1b33'),
    muted: read('--app-muted', '#4a5e83'),
    blue: read('--brand-blue', '#004ca8'),
    cyan: read('--brand-cyan', '#006f84'),
  };
};

const DatabaseSchemaPage = () => {
  const diagramRef = useRef<HTMLDivElement | null>(null);

  const diagramData = useMemo(
    () => ({
      nodes: [
        ...TABLES.map((table) => ({
          key: table.key,
          category: 'table',
          name: table.name,
          notes: table.notes,
          loc: table.loc,
          fields: table.fields.map((field) => ({
            name: field.name,
            type: field.type,
            key: field.key || '',
          })),
        })),
        TRIGGER,
      ],
      links: [...RELATIONSHIPS, ...TRIGGER_LINKS],
    }),
    [],
  );

  useEffect(() => {
    const host = diagramRef.current;
    if (!host) {
      return;
    }

    const $ = go.GraphObject.make;
    const theme = readThemeColors();

    const diagram = $(go.Diagram, host, {
      allowCopy: false,
      allowDelete: false,
      allowDragOut: false,
      allowRelink: false,
      allowZoom: true,
      allowSelect: true,
      contentAlignment: go.Spot.Center,
      padding: 20,
      scrollMode: go.ScrollMode.Infinite,
      initialAutoScale: go.AutoScale.Uniform,
      'undoManager.isEnabled': false,
      'animationManager.isEnabled': true,
    });

    diagram.nodeTemplateMap.add(
      'table',
      $(
        go.Node,
        'Spot',
        {
          locationSpot: go.Spot.TopLeft,
          fromSpot: go.Spot.RightSide,
          toSpot: go.Spot.LeftSide,
          selectionAdorned: true,
          shadowVisible: true,
          shadowOffset: new go.Point(0, 10),
          shadowBlur: 16,
          shadowColor: 'rgba(6, 18, 34, 0.18)',
        },
        new go.Binding('location', 'loc', go.Point.parse).makeTwoWay(
          go.Point.stringify,
        ),
        $(
          go.Panel,
          'Auto',
          $(go.Shape, 'RoundedRectangle', {
            fill: theme.surface,
            stroke: theme.border,
            strokeWidth: 1.5,
          }),
          $(
            go.Panel,
            'Table',
            {
              margin: 0,
              stretch: go.Stretch.Fill,
              width: TABLE_WIDTH,
            },
            $(
              go.Panel,
              'TableRow',
              { background: theme.panel },
              $(
                go.TextBlock,
                {
                  row: 0,
                  column: 0,
                  margin: new go.Margin(12, 14, 2, 14),
                  font: '800 15px Arial, Helvetica, sans-serif',
                  stroke: theme.blue,
                  wrap: go.TextBlock.None,
                  width: TABLE_WIDTH - 28,
                },
                new go.Binding('text', 'name'),
              ),
            ),
            $(
              go.TextBlock,
              {
                row: 1,
                column: 0,
                margin: new go.Margin(0, 14, 10, 14),
                font: '12px Arial, Helvetica, sans-serif',
                stroke: theme.muted,
                wrap: go.TextBlock.WrapFit,
                width: TABLE_WIDTH - 28,
              },
              new go.Binding('text', 'notes'),
            ),
            $(
              go.Panel,
              'Table',
              {
                row: 2,
                column: 0,
                margin: new go.Margin(0, 0, 0, 0),
                defaultAlignment: go.Spot.Left,
                itemTemplate: $(
                  go.Panel,
                  'TableRow',
                  {
                    stretch: go.Stretch.Horizontal,
                    background: 'transparent',
                    fromSpot: go.Spot.Right,
                    toSpot: go.Spot.Left,
                  },
                  new go.Binding('portId', 'name'),
                  $(
                    go.TextBlock,
                    {
                      column: 0,
                      margin: new go.Margin(6, 14, 6, 14),
                      font: '600 12px Arial, Helvetica, sans-serif',
                      stroke: theme.fg,
                      width: 190,
                    },
                    new go.Binding('text', 'name'),
                  ),
                  $(
                    go.TextBlock,
                    {
                      column: 1,
                      margin: new go.Margin(6, 14, 6, 14),
                      font: '12px Consolas, Monaco, monospace',
                      stroke: theme.muted,
                      width: 230,
                    },
                    new go.Binding('text', 'type'),
                  ),
                  $(
                    go.TextBlock,
                    {
                      column: 2,
                      margin: new go.Margin(6, 14, 6, 14),
                      font: '700 11px Arial, Helvetica, sans-serif',
                      stroke: theme.cyan,
                      textAlign: 'right',
                      width: 84,
                    },
                    new go.Binding('text', 'key'),
                  ),
                ),
              },
              new go.Binding('itemArray', 'fields'),
            ),
          ),
        ),
        $(go.Shape, {
          portId: TOP_PORT,
          alignment: go.Spot.Top,
          desiredSize: new go.Size(1, 1),
          fill: 'transparent',
          stroke: null,
          fromSpot: go.Spot.Top,
          toSpot: go.Spot.Top,
        }),
        $(go.Shape, {
          portId: BOTTOM_PORT,
          alignment: go.Spot.Bottom,
          desiredSize: new go.Size(1, 1),
          fill: 'transparent',
          stroke: null,
          fromSpot: go.Spot.Bottom,
          toSpot: go.Spot.Bottom,
        }),
      ),
    );

    diagram.nodeTemplateMap.add(
      'trigger',
      $(
        go.Node,
        'Spot',
        {
          locationSpot: go.Spot.TopLeft,
          fromSpot: go.Spot.Bottom,
          toSpot: go.Spot.Top,
          selectable: false,
        },
        new go.Binding('location', 'loc', go.Point.parse),
        $(
          go.Panel,
          'Auto',
          $(go.Shape, 'RoundedRectangle', {
            fill: theme.panel,
            stroke: theme.cyan,
            strokeWidth: 1.5,
          }),
          $(
            go.Panel,
            'Vertical',
            {
              width: TABLE_WIDTH,
            },
            $(
              go.TextBlock,
              {
                font: '800 13px Arial, Helvetica, sans-serif',
                margin: new go.Margin(12, 14, 0, 14),
                stroke: theme.blue,
                wrap: go.TextBlock.WrapFit,
                width: TABLE_WIDTH - 28,
              },
              new go.Binding('text', 'name'),
            ),
            $(
              go.TextBlock,
              {
                margin: new go.Margin(6, 14, 12, 14),
                font: '12px Arial, Helvetica, sans-serif',
                stroke: theme.muted,
                wrap: go.TextBlock.WrapFit,
                width: TABLE_WIDTH - 28,
              },
              new go.Binding('text', 'notes'),
            ),
          ),
        ),
        $(go.Shape, {
          portId: TOP_PORT,
          alignment: go.Spot.Top,
          desiredSize: new go.Size(1, 1),
          fill: 'transparent',
          stroke: null,
          fromSpot: go.Spot.Top,
          toSpot: go.Spot.Top,
        }),
        $(go.Shape, {
          portId: BOTTOM_PORT,
          alignment: go.Spot.Bottom,
          desiredSize: new go.Size(1, 1),
          fill: 'transparent',
          stroke: null,
          fromSpot: go.Spot.Bottom,
          toSpot: go.Spot.Bottom,
        }),
      ),
    );

    const linkLabel = $(
      go.Panel,
      'Auto',
      {
        segmentIndex: 0.5,
        segmentFraction: 0.5,
        background: 'transparent',
      },
      $(go.Shape, 'RoundedRectangle', {
        fill: theme.surface,
        stroke: theme.border,
      }),
      $(
        go.TextBlock,
        {
          margin: new go.Margin(3, 8, 3, 8),
          font: '700 10px Arial, Helvetica, sans-serif',
          stroke: theme.blue,
        },
        new go.Binding('text', 'label'),
      ),
    );

    diagram.linkTemplateMap.add(
      'fk',
      $(
        go.Link,
        {
          routing: go.Routing.AvoidsNodes,
          curve: go.Curve.JumpGap,
          corner: 8,
          fromSpot: go.Spot.RightSide,
          toSpot: go.Spot.LeftSide,
          relinkableFrom: false,
          relinkableTo: false,
          selectionAdorned: true,
          selectionObjectName: 'PATH',
        },
        $(go.Shape, {
          name: 'PATH',
          stroke: theme.cyan,
          strokeWidth: 2.5,
        }),
        $(go.Shape, {
          toArrow: 'Standard',
          fill: theme.cyan,
          stroke: null,
        }),
        linkLabel,
      ),
    );

    diagram.linkTemplateMap.add(
      'trigger',
      $(
        go.Link,
        {
          routing: go.Routing.Orthogonal,
          corner: 8,
          fromSpot: go.Spot.Bottom,
          toSpot: go.Spot.Top,
          relinkableFrom: false,
          relinkableTo: false,
          selectionAdorned: true,
          selectionObjectName: 'PATH',
        },
        $(go.Shape, {
          name: 'PATH',
          stroke: theme.cyan,
          strokeWidth: 2,
          strokeDashArray: [6, 4],
        }),
        $(go.Shape, {
          toArrow: 'Standard',
          fill: theme.cyan,
          stroke: null,
        }),
        linkLabel.copy(),
      ),
    );

    const model = new go.GraphLinksModel(diagramData.nodes, diagramData.links);
    model.nodeKeyProperty = 'key';
    model.linkFromKeyProperty = 'from';
    model.linkToKeyProperty = 'to';
    model.linkFromPortIdProperty = 'fromPort';
    model.linkToPortIdProperty = 'toPort';
    diagram.model = model;

    const fitDiagram = () => diagram.zoomToFit();
    diagram.addDiagramListener('InitialLayoutCompleted', fitDiagram);

    const handleResize = () => diagram.requestUpdate();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      diagram.div = null;
    };
  }, [diagramData]);

  return (
    <>
      <Head>
        <title>Database Schema</title>
      </Head>
      <main className={styles.page}>
        <section className={styles.header}>
          <p className={styles.kicker}>Schema Viewer</p>
          <h1 className={styles.title}>SQLite Entity Relationship Diagram</h1>
          <p className={styles.subtitle}>
            The diagram below uses the GoJS npm package to show each table as an
            entity with its fields and datatypes, along with the live foreign
            key relationships in the current SQLite schema.
          </p>
          <div className={styles.legend}>
            <span className={styles.legendBadge}>
              <b>PK</b> Primary key
            </span>
            <span className={styles.legendBadge}>
              <b>FK</b> Foreign key
            </span>
            <span className={styles.legendBadge}>
              <b>Drag</b> Reposition tables
            </span>
            <Link className={styles.legendBadge} href="/diagrams">
              <b>Diagrams</b> Auth and encryption workflows
            </Link>
          </div>
        </section>

        <section
          className={styles.diagramShell}
          aria-label="Database tables and relationships"
        >
          <div className={styles.diagramCard}>
            <div
              ref={diagramRef}
              className={styles.diagramHost}
              aria-label="Interactive entity relationship diagram"
            />
          </div>

          <div className={styles.summaryGrid}>
            {TABLES.map((table) => (
              <article key={table.key} className={styles.summaryCard}>
                <h2>{table.name}</h2>
                <ul>
                  {table.fields.map((field) => (
                    <li key={field.name}>
                      <span>{field.name}</span>
                      <span>{field.type}</span>
                      <span>{field.key || '—'}</span>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>

          <div className={styles.relationshipCard}>
            <h2>Relationships</h2>
            <ul>
              {RELATIONSHIPS.map((relationship) => (
                <li
                  key={`${relationship.from}->${relationship.to}-${relationship.label}`}
                >
                  {relationship.notes || relationship.label}
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>
    </>
  );
};

export default DatabaseSchemaPage;
