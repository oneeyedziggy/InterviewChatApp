# Second Challenge: Real-Time Chat Application

## Create a real-time chat application with the following features:

1. User authentication: Users can sign in with a username and password.
2. Multiple chat rooms: Users can join or create chat rooms.
3. Real-time messaging: Messages sent by users in a chat room are displayed in real-time to all participants.
4. Message formatting: Users can send messages with basic formatting (bold, italic, etc.) using a custom syntax.
5. Message history: Display the chat message history for a room when a user joins.
6. User presence: Show a list of users currently online in a chat room.
7. Notifications: Notify users when they receive a new message while not active in the chat room.

### Known issues/concessions to time constraint:

- would back the with an actual persistent database for users/chat and shared cache for sessions
- would most likely collect and validate user email
- would greatly imporve password requirements to require more complexity
- would implement http security headers like CSP
- would imporve styling
- would add both unit tests and storybook for components
