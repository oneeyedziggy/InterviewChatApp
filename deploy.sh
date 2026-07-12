#!/usr/bin/env bash
set -e

# Target VPS settings
SSH_USER="oneeyedziggy"
SSH_HOST="vps70662.dreamhostps.com"

# Determine script directory
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# Verify that the archive exists
TAR_FILE="dist/deploy.tar.gz"
if [ ! -f "$TAR_FILE" ]; then
  echo "Error: $TAR_FILE not found. Please run ./buildDeployArtifact.sh first."
  exit 1
fi

echo "Uploading $TAR_FILE to $SSH_USER@$SSH_HOST..."
# Copy the archive to the remote VPS temporary folder
scp "$TAR_FILE" "$SSH_USER@$SSH_HOST:/tmp/deploy.tar.gz"

echo "Deploying on remote host..."
# Connect via SSH and run deployment commands (executes in SSH user's home directory by default)
ssh "$SSH_USER@$SSH_HOST" bash -s <<EOS
  set -e
  APP_DIR="\$HOME/chatApp"
  
  echo "Stopping any existing server instances..."
  pkill -f "bin/server" || true

  echo "Ensuring deployment directory exists at \$APP_DIR..."
  mkdir -p "\$APP_DIR"
  cd "\$APP_DIR"
  
  echo "Cleaning up previous build directories..."
  rm -rf out bin
  
  echo "Extracting package into \$APP_DIR..."
  tar -xzf /tmp/deploy.tar.gz
  
  echo "Cleaning up remote temp archive..."
  rm -f /tmp/deploy.tar.gz
  
  # Ensure binary has execution privileges
  chmod +x bin/server
  
  echo "Starting Go web server..."
  # Run in background via nohup so it stays alive when SSH session closes
  nohup ./bin/server > server.log 2>&1 &
  
  echo "Server started successfully in background! Logs are in \$APP_DIR/server.log"
EOS

echo "✅ Deployment complete!"
