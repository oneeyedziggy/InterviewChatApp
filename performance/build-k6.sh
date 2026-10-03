#!/usr/bin/env bash
set -euo pipefail

PERFORMANCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
EXTENSION_DIR="$PERFORMANCE_DIR/xk6-signedauth"
OUTPUT_DIR="$PERFORMANCE_DIR/bin"
XK6_VERSION="v1.4.14"
K6_VERSION="v2.3.0"

command -v go >/dev/null 2>&1 || {
  printf 'Go is required to build k6\n' >&2
  exit 1
}

mkdir -p "$OUTPUT_DIR"
go install "go.k6.io/xk6/cmd/xk6@$XK6_VERSION"
XK6_BIN="$(go env GOPATH)/bin/xk6"

cd "$EXTENSION_DIR"
go mod tidy
go test ./... -count=1
"$XK6_BIN" build "$K6_VERSION" \
  --output "$OUTPUT_DIR/k6" \
  --with "example.com/interview-chat/xk6-signedauth=."

"$OUTPUT_DIR/k6" run \
  --no-usage-report \
  --summary-mode=disabled \
  "$EXTENSION_DIR/canonical-smoke.js"