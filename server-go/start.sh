#!/bin/bash

# Startup script for Go chat server
# Kills any existing Go server on the port and restarts it
# Does NOT kill browsers or other processes using the port

# Default port (can be overridden with PORT environment variable)
PORT=${PORT:-3001}

# Default CLEAR_ON_START to false so history is preserved unless explicitly requested
CLEAR_ON_START=${CLEAR_ON_START:-false}
export CLEAR_ON_START

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

# Locate Go binary: prefer `go` on PATH, fallback to known local install
GO_CMD="${GO_CMD:-$(command -v go 2>/dev/null || true)}"
if [ -z "$GO_CMD" ]; then
    # fallback to bundled local install path used during development
    if [ -x "/tmp/go1.24.6-install/go/bin/go" ]; then
        GO_CMD="/tmp/go1.24.6-install/go/bin/go"
    fi
fi

if [ -z "$GO_CMD" ]; then
    echo "FATAL: 'go' not found in PATH and no fallback available. Install Go or set GO_CMD." >&2
    exit 1
fi

echo "Using Go command: $GO_CMD"

# Resolve the out directory relative to server-go's parent (project root).
# This is needed because go run uses a temp binary path, bypassing resolveOutDir's
# exe-relative logic; OUT_DIR lets the server find the correct static export.
OUT_DIR="${OUT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)/out}"
echo "Static out dir: $OUT_DIR"

# APP_BASE_PATH defaults to empty for local runs (served at /).
# Set it explicitly if testing a prefixed deployment locally, e.g.:
#   APP_BASE_PATH=/chatApp ./start.sh
APP_BASE_PATH="${APP_BASE_PATH:-}"

# If APP_BASE_PATH is not explicitly set, infer it from the built export.
# This keeps local server routing aligned with whatever base path out/ was built with.
if [ -z "$APP_BASE_PATH" ] && [ -f "$OUT_DIR/index.html" ]; then
    DETECTED_PREFIX=$(grep -oE '"/[^" ]*/_next/static/' "$OUT_DIR/index.html" | head -n1 | sed -E 's#"/##; s#/_next/static/##')
    if [ -n "$DETECTED_PREFIX" ]; then
        APP_BASE_PATH="/$DETECTED_PREFIX"
        echo "Detected APP_BASE_PATH from export: $APP_BASE_PATH"
    else
        echo "Detected root export (no APP_BASE_PATH)"
    fi
fi

echo "Using APP_BASE_PATH: ${APP_BASE_PATH:-<root>}"

# Start the server
PORT=$PORT OUT_DIR="$OUT_DIR" APP_BASE_PATH="$APP_BASE_PATH" "$GO_CMD" run .

