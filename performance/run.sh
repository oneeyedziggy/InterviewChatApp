#!/usr/bin/env bash
set -euo pipefail

PERFORMANCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(cd "$PERFORMANCE_DIR/.." && pwd -P)"
source "$PERFORMANCE_DIR/lib/safety.sh"

RUN_ID="${1:-$(date -u +%Y%m%dT%H%M%SZ)}"
SCENARIO="${SCENARIO:-message-write}"
ACTORS="${ACTORS:-10}"
PORT="${PORT:-3111}"
DIAGNOSTICS_PORT="${DIAGNOSTICS_PORT:-6061}"
BASE_URL="${BASE_URL:-http://127.0.0.1:$PORT}"
DIAGNOSTICS_URL="http://127.0.0.1:$DIAGNOSTICS_PORT"
RESULT_DIR="$PERFORMANCE_DIR/results/$RUN_ID"

perf_assert_safe_target "$BASE_URL"
perf_prepare_run_dir "$RUN_ID" >/dev/null

if [[ -e "$RESULT_DIR" ]]; then
  perf_fail "result directory already exists: $RESULT_DIR"
  exit 1
fi
mkdir -m 700 -p "$RESULT_DIR"

for port in "$PORT" "$DIAGNOSTICS_PORT"; do
  if command -v ss >/dev/null 2>&1 && ss -ltn "sport = :$port" | tail -n +2 | grep -q .; then
    perf_fail "port $port is already in use"
    exit 1
  fi
done

SERVER_PID=""
SAMPLER_PID=""
PROFILE_PID=""

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  for pid in "$PROFILE_PID" "$SAMPLER_PID"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

if [[ ! -x "$PERFORMANCE_DIR/bin/k6" ]]; then
  "$PERFORMANCE_DIR/build-k6.sh"
fi

(
  cd "$REPO_DIR/server-go"
  go build -o "$PERFORMANCE_DIR/bin/server" .
)

{
  printf 'run_id=%s\n' "$RUN_ID"
  printf 'scenario=%s\n' "$SCENARIO"
  printf 'base_url=%s\n' "$BASE_URL"
  printf 'actors=%s\n' "$ACTORS"
  printf 'started_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'git_commit=%s\n' "$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || printf unknown)"
  printf 'git_dirty=%s\n' "$(test -n "$(git -C "$REPO_DIR" status --porcelain 2>/dev/null)" && printf true || printf false)"
  printf 'go_version=%s\n' "$(go version)"
  printf 'k6_version=%s\n' "$($PERFORMANCE_DIR/bin/k6 version 2>&1 | head -n 1)"
  printf 'kernel=%s\n' "$(uname -srvmo)"
  command -v lscpu >/dev/null 2>&1 && lscpu
  command -v free >/dev/null 2>&1 && free -b
} > "$RESULT_DIR/run-metadata.txt"

(
  cd "$REPO_DIR/server-go"
  exec env \
    PERFORMANCE_TEST_MODE=1 \
    PERFORMANCE_RUN_ID="$RUN_ID" \
    SERVER_DATA_DIR="$SERVER_DATA_DIR" \
    PORT="$PORT" \
    DIAGNOSTICS_ADDR="127.0.0.1:$DIAGNOSTICS_PORT" \
    LOG_LEVEL="${LOG_LEVEL:-info}" \
    "$PERFORMANCE_DIR/bin/server"
) > "$RESULT_DIR/server.ndjson" 2>&1 &
SERVER_PID=$!
printf '%s\n' "$SERVER_PID" > "$RESULT_DIR/server.pid"

if ! curl --retry 30 --retry-connrefused --retry-delay 1 -fsS \
  "$DIAGNOSTICS_URL/health/ready" \
  > "$RESULT_DIR/readiness.json" \
  2> "$RESULT_DIR/readiness-errors.log"; then
  cat "$RESULT_DIR/readiness-errors.log" >&2
  exit 1
fi

(
  cd "$REPO_DIR/server-go"
  go run ./cmd/perf-fixtures \
    -base-url "$BASE_URL" \
    -actors "$ACTORS"
)

if [[ "${HISTORY_MESSAGES:-0}" -gt 0 ]]; then
  "$PERFORMANCE_DIR/bin/k6" run \
    --no-usage-report \
    --summary-mode=disabled \
    -e "SCENARIO=seed" \
    -e "SEED_MESSAGES=$HISTORY_MESSAGES" \
    -e "VUS=${SEED_VUS:-1}" \
    -e "FIXTURE_MANIFEST=$SERVER_DATA_DIR/fixtures.json" \
    -e "PERFORMANCE_RUN_ID=$RUN_ID" \
    -e "CIPHERTEXT_BYTES=${CIPHERTEXT_BYTES:-256}" \
    "$PERFORMANCE_DIR/k6/load.js" \
    > "$RESULT_DIR/seed.log" 2>&1
fi

sample_process() {
  local timestamp status_file io_file fd_count
  timestamp="$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)"
  status_file="/proc/$SERVER_PID/status"
  io_file="/proc/$SERVER_PID/io"
  [[ -r "$status_file" ]] || return 1
  fd_count="$(find "/proc/$SERVER_PID/fd" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l)"
  printf '{"timestamp":"%s","pid":%s,"rssKb":%s,"threads":%s,"fds":%s,"readBytes":%s,"writeBytes":%s}\n' \
    "$timestamp" \
    "$SERVER_PID" \
    "$(awk '/^VmRSS:/ {print $2}' "$status_file")" \
    "$(awk '/^Threads:/ {print $2}' "$status_file")" \
    "$fd_count" \
    "$(awk '/^read_bytes:/ {print $2}' "$io_file")" \
    "$(awk '/^write_bytes:/ {print $2}' "$io_file")"
}

(
  while kill -0 "$SERVER_PID" 2>/dev/null; do
    sample_process >> "$RESULT_DIR/process.ndjson" || break
    curl -fsS "$DIAGNOSTICS_URL/debug/metrics" >> "$RESULT_DIR/diagnostics.ndjson" || true
    sleep "${SAMPLE_INTERVAL_SECONDS:-1}"
  done
) &
SAMPLER_PID=$!

if [[ "${CAPTURE_PPROF:-0}" == "1" ]]; then
  curl -fsS "$DIAGNOSTICS_URL/debug/pprof/profile?seconds=${PROFILE_SECONDS:-30}" \
    > "$RESULT_DIR/cpu.pprof" &
  PROFILE_PID=$!
fi

K6_ARGS=(
  run
  --no-usage-report
  --summary-mode=full
  --summary-export "$RESULT_DIR/k6-summary.json"
  --out "json=$RESULT_DIR/k6-metrics.json"
  -e "SCENARIO=$SCENARIO"
  -e "FIXTURE_MANIFEST=$SERVER_DATA_DIR/fixtures.json"
  -e "PERFORMANCE_RUN_ID=$RUN_ID"
  -e "DURATION=${DURATION:-30s}"
  -e "RATE=${RATE:-5}"
  -e "VUS=${VUS:-$ACTORS}"
  -e "PREALLOCATED_VUS=${PREALLOCATED_VUS:-$ACTORS}"
  -e "MAX_VUS=${MAX_VUS:-$ACTORS}"
  -e "CIPHERTEXT_BYTES=${CIPHERTEXT_BYTES:-256}"
  -e "RAMP_DURATION=${RAMP_DURATION:-10s}"
  -e "RAMP_DOWN_DURATION=${RAMP_DOWN_DURATION:-5s}"
  -e "SPIKE_RATE=${SPIKE_RATE:-25}"
  -e "SPIKE_RAMP_DURATION=${SPIKE_RAMP_DURATION:-5s}"
  -e "SPIKE_RAMP_DOWN_DURATION=${SPIKE_RAMP_DOWN_DURATION:-5s}"
  -e "HOLD_MS=${HOLD_MS:-1000}"
  -e "FANOUT_WINDOW_MS=${FANOUT_WINDOW_MS:-250}"
  "$PERFORMANCE_DIR/k6/load.js"
)

set +e
"$PERFORMANCE_DIR/bin/k6" "${K6_ARGS[@]}" 2>&1 | tee "$RESULT_DIR/k6.log"
K6_EXIT=${PIPESTATUS[0]}
set -e

curl -fsS "$DIAGNOSTICS_URL/debug/metrics" > "$RESULT_DIR/diagnostics-final.json" || true
curl -fsS "$DIAGNOSTICS_URL/debug/pprof/heap" > "$RESULT_DIR/heap.pprof" || true
curl -fsS "$DIAGNOSTICS_URL/debug/pprof/goroutine" > "$RESULT_DIR/goroutine.pprof" || true
curl -fsS "$DIAGNOSTICS_URL/debug/pprof/mutex" > "$RESULT_DIR/mutex.pprof" || true
curl -fsS "$DIAGNOSTICS_URL/debug/pprof/block" > "$RESULT_DIR/block.pprof" || true

if command -v sqlite3 >/dev/null 2>&1; then
  while IFS= read -r database; do
    printf '%s: ' "$database" >> "$RESULT_DIR/sqlite-integrity.txt"
    sqlite3 "$database" 'PRAGMA integrity_check;' >> "$RESULT_DIR/sqlite-integrity.txt"
  done < <(find "$SERVER_DATA_DIR" -type f -name '*.sqlite3' -print)
fi

printf 'completed_at=%s\nk6_exit_code=%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$K6_EXIT" >> "$RESULT_DIR/run-metadata.txt"

if grep -R -E -l --exclude='*.pprof' \
  'BEGIN PGP PRIVATE KEY|"sessionId"[[:space:]]*:' "$RESULT_DIR" > "$RESULT_DIR/secret-scan.txt"; then
  printf 'Sensitive fixture material detected in result artifacts:\n' >&2
  cat "$RESULT_DIR/secret-scan.txt" >&2
  exit 1
fi
printf 'no private keys or serialized session IDs detected\n' > "$RESULT_DIR/secret-scan.txt"
exit "$K6_EXIT"