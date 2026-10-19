# InterviewChatApp

This repo started with the below prompt as an interview take-home assignment to be completed within a week, and started as a pure node/react/nextjs app. At the time LLMs were not in wide usage or availability, therefor I used absolutely no AI for the commits before initial submission in late 2023.

Since then I've picked it back up and done some fairly heavy refactors and feature addition with various LLMs to both explore various AI tooling, and as a learning project got Go, to which I (or rather AI) ported the existing server component. I also added end-to-end encryption, a better (if not gorgrous) theme/styling, build/deploy tooling, and finished up some originally intended features where I had to cut corners to get a whole chat app done in a week.

Historical planning documents are archived in `docs/archive/`.

## Second Challenge: Real-Time Chat Application

### Create a real-time chat application with the following features:

1. User authentication: Users can sign in with a username and password.
2. Multiple chat rooms: Users can join or create chat rooms.
3. Real-time messaging: Messages sent by users in a chat room are displayed in real-time to all participants.
4. Message formatting: Users can send messages with basic formatting (bold, italic, etc.) using a custom syntax.
5. Message history: Display the chat message history for a room when a user joins.
6. User presence: Show a list of users currently online in a chat room.
7. Notifications: Notify users when they receive a new message while not active in the chat room.

#### Implementation Notes:

1. Given time constraint, no concession was provided for logOUT, and registration was joined with login so that previously unknown users are autimatically registered, but prevent impresonating existing users.

- !!! also, the backend datastore is not persistent... I acknowldge this is not a scaleable long-term solution, expecially for user credentials, and limits storage to host memory or, more likely, default node env memory allocation... this was also a compromise made due to time constraints, thought I have experience with both sql and no-sql database tech, there just wasn't time while implementing a full-stack chat app, working a full-time job, and making time for family

2. Room creation, similar to user creation has been made very simple, by just typing a non-conflicting name and pressing enter.
3. Real-time messaging is at least something I believe I've acheived without much compromise

- there is some weirdness to look more into around how the server maintains a connection and how to distinguish between an initial connection, a momentary disconnect/reconnect, and a full disconnect

4. for message formatting I've just implemented the same library, 'simple-markdown', as Discord
5. Message history for all users/rooms is provided to clients upon joining

- !!! all rooms' history being stored and shipped as one unit was a stopgap time-saving measure to acheive the requested deliverables in the allotted time without access to a product manager to negotiate quality/time constraints

6. User presence: Recent changes in Next.js 13 have broken the usual way of communicating between the custom server and app routes, so what's presented is a compromise... a list of all active users, but not well maintained on expirey and disconnect, and part of the compromise is new users are pushed to clients only when someone sends a message, so I also have all clients post a "joined the server" message as a hack to force an update to all clients' user lists
7. Notifications: while functional, this is a bit of a client-side hack as-implemented, but in that individual rooms don't trigger distinct socket events, and the room list is a basic string list rather than the more flexible list of react nodes that would

#### Known Issues/Concessions to Time Constraint:

- would add a lot more handling of edge cases and better messaging to the user of what's happening
- would back the with an actual persistent database for users/chat and shared cache for sessions
- would most likely collect and validate user email
- would greatly imporve password requirements to require more complexity
- would implement http security headers like CSP
- would imporve styling
- would add both unit tests and storybook for components
- would implement logOUT and cleanup of active sessions pre-expirey server-side, along with updating the client side user list as users leave

### to start

npm install
cd server-go
./start.sh

## Operations

### Local build / dev

- Install client dependencies: `npm install`
- Build the deployable client + server bundle: `./buildDeployArtifact.sh`
- Start the Go server locally from `server-go/` with `./start.sh`
- Open the app at `http://localhost:3001/`

### Deploy build and publish

- Build the deployable client + server bundle: `./buildDeployArtifact.sh`
  - This creates `out/` for the React client and `bin/server` for the Go server
  - The deploy build uses `APP_BASE_PATH=/chatApp`
- Deploy the packaged artifact to the VPS: `./deploy.sh`
  - This uploads `dist/deploy.tar.gz` and starts the remote Go server

Note: `out` reflects the most recent build mode. Rebuild with the mode you plan to test or deploy.

### Browser Smoke Test

Requires Node 20.9+ and Go on `PATH` (or an absolute executable in `GO_CMD`).
On Windows PowerShell, use `npm.cmd` and `npx.cmd` if execution policy blocks the script shims.

```sh
npm install
npx playwright install chromium
npm run test:e2e
```

The command builds a root-mounted Next static export with `APP_BASE_PATH` empty.
It uses webpack in a new `.e2e-build-*` workspace, copying current source and build/type-check
configuration and linking installed dependencies, so the shared `.next` cache is untouched.
Type checking remains enabled. Playwright serves the generated export from that temporary
workspace, then removes it after teardown. The existing `out/` export is not replaced.

Playwright runs one scenario with no retries and two independent Chromium contexts, service
workers enabled, and strict server signature verification unchanged. Alice and Bob create their
own keys through login UI, join with a real UI-generated invite, exchange messages in an existing
named room and canonical DM, then reload/unlock and verify plaintext names, authors, and history.

Each worker compiles its own Go binary into a fresh OS temporary directory, uses that directory
as `SERVER_DATA_DIR`, sets `OUT_DIR` to the temporary export (or root `out/` for the prebuilt command), chooses an unused port, and waits
for HTTP readiness. It never reuses external servers, real databases, or reset scripts. Teardown
awaits only its owned process before removing its own data directory, including setup failures.
On Windows process termination closes database handles; on POSIX SIGTERM permits graceful shutdown.

```sh
npm run test:e2e:prebuilt
node --test e2e/fixtures/server.test.mjs
npx playwright show-report
```

The prebuilt command explicitly skips building and rejects non-root exports. The Node fixture
checks also require a root export and Go. Failure traces, screenshots, browser diagnostics, and
server logs are written under ignored `test-results/` and `playwright-report/`. These artifacts
contain test-only account and message details; do not publish them as production telemetry.

### Two-User Regression Tests

```sh
npx vitest run src/utils/gpg-zero-knowledge.test.ts src/utils/homeSocket/two-user-plaintext.test.ts
cd server-go
go test ./internal/server -run TwoUser -count=1
```

These tests need no Next build or external server. The crypto tests use distinct RSA-2048
keys and check usernames, room names, reciprocal messages, missing recipients, and tampering.
The client tests use actual encryption, signing, strict server verification, metadata refresh,
and send/receive/history handlers with serially isolated client storage and simulated transport.
Go tests cover signed mutations, room IDs, metadata, persistence, and DM participant checks
against temporary SQLite. Fake sockets do not establish actual network delivery or rendering;
the browser smoke test covers those paths with real account registration and invitations.

### Server Key Rotation

Use the root helper script to rotate server GPG keys:

- `./rotate-server-keys.sh`

What it does:

- Deletes `server-go/server-gpg-private-key.asc` and `server-go/server-gpg-key.asc`
- Starts the Go server briefly to trigger key regeneration
- Stops the temporary process after new keys are written

### Client Behavior After Key Rotation

The client now includes a refresh-and-retry path for challenge-response auth:

- If challenge-response fails with a stale cached server public key, the client fetches the latest server public key
- It retries challenge-response one time with the refreshed key
- On success, the refreshed server public key is saved locally

In practice, users should not need to manually clear local storage after a server key rotation, though an in-flight login may need one retry.

### Security Notes

- Do not commit server private keys or runtime state files.
- `.gitignore` excludes `*.asc`, `*.pem`, and `server-go/chat-state.json`, but if sensitive files were ever committed previously, rotate and clean history as needed.
