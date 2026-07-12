#!/usr/bin/env bash
set -e

# Determine project root (directory of this script)
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# Function to calculate checksum of source files
calculate_source_hash() {
  # Track ONLY explicit source code file extensions (excluding server-go directory).
  find src public package.json package-lock.json next.config.cjs -type f 2>/dev/null | \
    tr '\\' '/' | \
    grep -E "\.(json|js|ts|tsx|css|html|sh|md|png|jpg|jpeg|svg|txt|json5|cjs|mjs)$" | \
    grep -v -E "/\.next/|/node_modules/|/out/|/dist/|/bin/" | \
    sort | \
    xargs sha256sum 2>/dev/null
}

get_hash_signature() {
  calculate_source_hash | sha256sum | cut -d' ' -f1
}

HASH_FILE="dist/.build_hash"
TAR_FILE="dist/deploy.tar.gz"
DEBUG_HASH_FILE="dist/.build_hash_debug"

# Check if we can skip the build
if [ -f "$TAR_FILE" ] && [ -f "$HASH_FILE" ]; then
  CURRENT_HASH=$(get_hash_signature)
  SAVED_HASH=$(cat "$HASH_FILE" 2>/dev/null || true)
  if [ "$CURRENT_HASH" = "$SAVED_HASH" ]; then
    echo "No project changes detected since the last build. Skipping build and reusing existing package."
    exit 0
  else
    echo "Changes detected. Current hash: $CURRENT_HASH, Saved hash: $SAVED_HASH"
    if [ -f "$DEBUG_HASH_FILE" ]; then
      echo "=== File changes causing rebuild ==="
      calculate_source_hash > "dist/.current_hash_debug"
      diff "$DEBUG_HASH_FILE" "dist/.current_hash_debug" || true
      rm -f "dist/.current_hash_debug"
    fi
  fi
fi

# Cleanup previous build artifacts to ensure a fresh, clean build
echo "Cleaning up previous build directories..."
rm -rf out bin dist/deploy.tar.gz

# ----------------------- Node build -----------------------
if [ -f package.json ]; then
  echo "Installing Node dependencies..."
  npm ci
  echo "Running Next.js build..."
  npm run build
  echo "Node build succeeded."
else
  echo "No package.json – skipping Node steps."
fi

# Verify static site output
if [ ! -d out ]; then
  echo "Error: ./out directory missing after Node build."
  exit 1
fi

# ----------------------- Go build -----------------------
# The Go code lives in ./server-go (it contains its own go.mod)
if [ -f server-go/go.mod ]; then
  echo "Building Go server from ./server-go..."
  mkdir -p bin
  pushd server-go > /dev/null
  GOSUMDB=sum.golang.org GOTOOLCHAIN=auto GOOS=linux GOARCH=amd64 go build -o ../bin/server .
  popd > /dev/null
  if [ ! -f bin/server ]; then
    echo "Error: Go binary not found at bin/server after build."
    exit 1
  fi
  echo "Go build succeeded. Binary placed at bin/server."
else
  echo "go.mod not found in ./server-go – skipping Go build."
fi

# --------------------- Package output --------------------
mkdir -p dist
# Add any additional config files here, e.g., cp config.yaml dist/

tar --exclude="*.asc" --exclude="*.pem" -czf "$TAR_FILE" out bin

# Save build hash and individual file hashes for debugging next time
get_hash_signature > "$HASH_FILE"
calculate_source_hash > "$DEBUG_HASH_FILE"

echo "Package created at $TAR_FILE"
