# Second Challenge: Real-Time Chat Application

## Create a real-time chat application with the following features:

1. User authentication: Users can sign in with a username and password.
2. Multiple chat rooms: Users can join or create chat rooms.
3. Real-time messaging: Messages sent by users in a chat room are displayed in real-time to all participants.
4. Message formatting: Users can send messages with basic formatting (bold, italic, etc.) using a custom syntax.
5. Message history: Display the chat message history for a room when a user joins.
6. User presence: Show a list of users currently online in a chat room.
7. Notifications: Notify users when they receive a new message while not active in the chat room.

### Implementation Notes:

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

### Known Issues/Concessions to Time Constraint:

- would add a lot more handling of edge cases and better messaging to the user of what's happening
- would back the with an actual persistent database for users/chat and shared cache for sessions
- would most likely collect and validate user email
- would greatly imporve password requirements to require more complexity
- would implement http security headers like CSP
- would imporve styling
- would add both unit tests and storybook for components
- would implement logOUT and cleanup of active sessions pre-expirey server-side, along with updating the client side user list as users leave

### to start

npm install && npm run dev
