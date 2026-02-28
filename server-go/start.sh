#!/bin/bash

# Startup script for Go chat server
# Kills any existing Go server on the port and restarts it
# Does NOT kill browsers or other processes using the port

# Default port (can be overridden with PORT environment variable)
PORT=${PORT:-3001}

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== Go Chat Server Startup ==="
echo "Port: $PORT"
echo ""

# Find processes listening on the port
echo "Checking for existing processes on port $PORT..."

# Get all PIDs listening on the port
PIDS=$(lsof -ti:$PORT -sTCP:LISTEN 2>/dev/null)

if [ -z "$PIDS" ]; then
    echo "No processes found on port $PORT"
else
    echo "Found processes: $PIDS"
    
    # Check each PID and kill only Go-related processes
    KILLED_ANY=false
    for PID in $PIDS; do
        # Get the command name for this PID
        CMD=$(ps -p $PID -o comm= 2>/dev/null)
        CMD_FULL=$(ps -p $PID -o args= 2>/dev/null)
        
        # Check if it's a Go process (go, chat-server-go, or contains "go run")
        if [[ -n "$CMD" ]] && (
            [[ "$CMD" == "go" ]] || 
            [[ "$CMD" == "chat-server-go" ]] || 
            [[ "$CMD_FULL" == *"go run"* ]] ||
            [[ "$CMD_FULL" == *"chat-server-go"* ]] ||
            [[ "$CMD_FULL" == *"/go"* ]]
        ); then
            echo "Killing Go server process: PID $PID ($CMD)"
            kill -9 $PID 2>/dev/null
            KILLED_ANY=true
        else
            echo "Skipping non-Go process: PID $PID ($CMD) - likely a browser or other application"
        fi
    done
    
    if [ "$KILLED_ANY" = true ]; then
        echo "Waiting 1 second for process to terminate..."
        sleep 1
    else
        echo "No Go server processes found to kill"
    fi
fi

echo ""
echo "Starting Go server on port $PORT..."
echo ""

# Start the server
PORT=$PORT go run .

