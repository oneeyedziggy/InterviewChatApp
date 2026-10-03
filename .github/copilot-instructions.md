# Repository Maintenance Guide

## Layout

- `src/` is the Next.js/TypeScript client. Home page state is in `src/contexts/home/` and `src/hooks/home/`; home panels are in `src/components/home/`.
- `server-go/` is a separate Go module and owns HTTP, WebSocket, encryption, and persistence behavior.
- Client tests are colocated with source. Go tests are colocated in `server-go/`.

## High-risk invariants

- WebSocket mutations use signed `auth` envelopes. Preserve canonical signing on the client and detached-signature verification on the server.
- Authentication must prefer the authoritative `keys.userId`; do not mint an identity-map fallback for login or auto-relogin.
- DM visibility is enforced on both client and server. Preserve participant checks for create, send, and fetch paths.
- Server-assigned room IDs are authoritative. Clients must not synthesize IDs for unknown room names.
- Legacy message IDs must be deterministic from room, timestamp, and user ID; random IDs create duplicate messages on redelivery.
- When encrypted room metadata resolves a server room ID to a name, reconcile the current room and message state.
- Keep the client server-signature strict mode fail-closed unless explicitly configured otherwise.

## UI and routing footguns

- Do not pass a single JSX fragment to components that use `React.Children.toArray` to count layout children; render each child as a separate top-level expression.
- The server currently serves root-absolute routes and API paths. Do not add a Next `basePath` without updating `server-go/http.go`.
- Preserve flex `min-height: 0` and internal scrolling rules in the home layout and server-tab rail.

## Persistence

- The Go server keeps in-memory maps and persists mutations through its store layer. Snapshot state while locked, release the server lock, then perform I/O.
- Runtime SQLite files and generated coverage/build output are not source. Do not commit them.
- Historical design notes are under `docs/archive/`; use current code and tests as the source of truth.

## Change workflow

- Start from the owning handler, hook, selector, or persistence method and read its nearby test before editing.
- Keep behavior changes separate from file movement or decomposition.
- Run the narrowest relevant test first, then the full client or Go suite when available.
- Do not alter encryption, identity, room-visibility, or message-deduplication behavior during structural refactors.
