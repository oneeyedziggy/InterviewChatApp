#!/bin/bash

# Reset script for chat server data
# This script clears all user, room, and chat history data from the server

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_FILE="${SCRIPT_DIR}/chat-state.json"

echo "=== Chat Server Data Reset ==="
echo ""

# Check if state file exists
if [ ! -f "$STATE_FILE" ]; then
    echo "No state file found at $STATE_FILE"
    echo "Server is already in a clean state."
    exit 0
fi

# Show file size before deletion
FILE_SIZE=$(du -h "$STATE_FILE" | cut -f1)
echo "Found state file: $STATE_FILE"
echo "File size: $FILE_SIZE"
echo ""

# Ask for confirmation
read -p "Are you sure you want to delete all chat data? This cannot be undone! (yes/no): " CONFIRM

if [ "$CONFIRM" != "yes" ]; then
    echo "Reset cancelled."
    exit 0
fi

# Backup the file before deletion (optional, but helpful)
BACKUP_FILE="${STATE_FILE}.backup.$(date +%Y%m%d_%H%M%S)"
echo ""
echo "Creating backup at: $BACKUP_FILE"
cp "$STATE_FILE" "$BACKUP_FILE"

# Delete the state file
echo "Deleting state file..."
rm -f "$STATE_FILE"

echo ""
echo "✓ Chat data reset complete!"
echo "  - All messages deleted"
echo "  - All rooms deleted (server will recreate default rooms on next start)"
echo "  - All users deleted"
echo "  - All user public keys deleted"
echo ""
echo "Backup saved at: $BACKUP_FILE"
echo ""
echo "Note: Server GPG keys are NOT deleted. To reset those, delete:"
echo "  - server-private-key.asc"
echo "  - server-public-key.asc"
echo ""
echo "The server will start with a clean state on next restart."

