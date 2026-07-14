#!/usr/bin/env bash
set -e

# Determine project root (directory of this script)
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

DEPLOY_BASE_PATH="/chatApp"
TAR_FILE="dist/deploy.tar.gz"

# Cleanup previous build artifacts to ensure a fresh, clean build
echo "Cleaning up previous build directories..."
rm -rf out bin dist/deploy.tar.gz

# ----------------------- Node build -----------------------
if [ -f package.json ]; then
  if [ "${FORCE_NPM_CI:-0}" = "1" ]; then
    echo "FORCE_NPM_CI=1 set. Reinstalling Node dependencies..."
    npm ci
  else
    echo "Installing/updating Node dependencies without deleting node_modules..."
    npm install --no-audit --no-fund
  fi

  echo "Running Next.js build for deploy path $DEPLOY_BASE_PATH..."
  APP_BASE_PATH="$DEPLOY_BASE_PATH" node --input-type=module -e "const cfgMod = await import('./next.config.mjs'); const cfg = cfgMod.default ?? cfgMod; console.log('[build] next.config basePath=', cfg.basePath || '<empty>', 'assetPrefix=', cfg.assetPrefix || '<empty>');"
  APP_BASE_PATH="$DEPLOY_BASE_PATH" npx next build
  echo "Node build succeeded."
else
  echo "No package.json – skipping Node steps."
fi

# Verify static site output
if [ ! -d out ]; then
  echo "Error: ./out directory missing after Node build."
  exit 1
fi

# Verify exported HTML uses deploy base path. Fail fast if artifact is stale/root-built.
if ! grep -q "${DEPLOY_BASE_PATH}/_next/" out/index.html; then
  echo "Error: out/index.html is not built with base path '${DEPLOY_BASE_PATH}'."
  echo "Expected to find '${DEPLOY_BASE_PATH}/_next/' in exported HTML."
  echo "Try forcing a fresh build: rm -rf out dist/deploy.tar.gz && ./buildDeployArtifact.sh"
  exit 1
fi

# Verify login/logout exports are present and route metadata is correct.
if [ ! -f out/login/index.html ]; then
  echo "Error: out/login/index.html is missing from export."
  exit 1
fi
if [ ! -f out/logout/index.html ]; then
  echo "Error: out/logout/index.html is missing from export."
  exit 1
fi
if ! grep -q '"page":"/login"' out/login/index.html; then
  echo "Error: out/login/index.html does not contain __NEXT_DATA__ page '/login'."
  exit 1
fi
if ! grep -q '"page":"/logout"' out/logout/index.html; then
  echo "Error: out/logout/index.html does not contain __NEXT_DATA__ page '/logout'."
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

echo "Package created at $TAR_FILE"
