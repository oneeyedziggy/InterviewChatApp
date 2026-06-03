#!/bin/bash

# start_fresh.sh - start server with fresh state (purges messages and session data)
# This script removes the persisted state file and starts the server with
# CLEAR_ON_START=true so the server will purge any in-memory messages too.

PORT=${PORT:-3001}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== Go Chat Server: START FRESH ==="

echo "Removing persisted state file (chat-state.json) if present..."
if [ -f "chat-state.json" ]; then
  rm -f chat-state.json
  echo "Removed chat-state.json"
else
  echo "No chat-state.json found"
fi

# Export CLEAR_ON_START so server will purge messages on startup
export CLEAR_ON_START=true

echo "Invoking start.sh to run server with CLEAR_ON_START=true"
./start.sh
