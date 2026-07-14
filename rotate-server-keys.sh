#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KEY_DIR="$DIR/server-go"
PRIVATE_KEY="$KEY_DIR/server-gpg-private-key.asc"
PUBLIC_KEY="$KEY_DIR/server-gpg-key.asc"

echo "This will delete existing server keys and regenerate a new key pair."
echo "Any clients with cached old server public keys may need a login retry."
read -r -p "Proceed? [y/N] " REPLY
if [[ ! "$REPLY" =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

echo "Removing existing key files (if present)..."
rm -f "$PRIVATE_KEY" "$PUBLIC_KEY"

pushd "$KEY_DIR" > /dev/null

echo "Starting server briefly to trigger key regeneration..."
PORT="${PORT:-3901}" go run . > /tmp/chatapp-key-regen.log 2>&1 &
SERVER_PID=$!

cleanup() {
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

for _ in {1..30}; do
  if [[ -f "$PRIVATE_KEY" && -f "$PUBLIC_KEY" ]]; then
    break
  fi
  sleep 1
done

if [[ ! -f "$PRIVATE_KEY" || ! -f "$PUBLIC_KEY" ]]; then
  echo "Failed to regenerate keys. See /tmp/chatapp-key-regen.log for details."
  exit 1
fi

echo "New server keys generated successfully:"
ls -l "$PRIVATE_KEY" "$PUBLIC_KEY"

cleanup
trap - EXIT

popd > /dev/null

echo "Done."
