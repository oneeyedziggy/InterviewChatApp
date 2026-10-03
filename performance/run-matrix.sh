#!/usr/bin/env bash
set -euo pipefail

PERFORMANCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
MATRIX_ID="${1:-baseline-$(date -u +%Y%m%dT%H%M%SZ)}"
REPEATS="${MATRIX_REPEATS:-3}"
SCENARIOS="${MATRIX_SCENARIOS:-connections message-write fanout mixed spike soak}"
SCENARIOS="${SCENARIOS//,/ }"
BASE_PORT="${BASE_PORT:-3200}"
BASE_DIAGNOSTICS_PORT="${BASE_DIAGNOSTICS_PORT:-6200}"
HISTORY_POINTS="${HISTORY_SIZES:-0 100 1000}"
HISTORY_POINTS="${HISTORY_POINTS//,/ }"
FANOUT_POINTS="${FANOUT_SIZES:-2 10 50}"
FANOUT_POINTS="${FANOUT_POINTS//,/ }"

if [[ ! "$REPEATS" =~ ^[1-9][0-9]*$ ]]; then
  printf 'MATRIX_REPEATS must be a positive integer\n' >&2
  exit 1
fi

run_number=0
run_case() {
  local label="$1"
  shift
  local repeat
  for ((repeat = 1; repeat <= REPEATS; repeat++)); do
    run_number=$((run_number + 1))
    local run_id="$MATRIX_ID-$label-r$repeat"
    env \
      PORT="$((BASE_PORT + run_number))" \
      DIAGNOSTICS_PORT="$((BASE_DIAGNOSTICS_PORT + run_number))" \
      "$@" \
      "$PERFORMANCE_DIR/run.sh" "$run_id"
  done
}

for scenario in $SCENARIOS; do
  case "$scenario" in
    connections)
      run_case "connections" SCENARIO=connections ACTORS="${CONNECTION_ACTORS:-10}" VUS="${CONNECTION_VUS:-10}" DURATION="${CONNECTION_DURATION:-30s}"
      ;;
    message-write)
      for history in $HISTORY_POINTS; do
        run_case "write-h$history" SCENARIO=message-write ACTORS="${WRITE_ACTORS:-10}" RATE="${WRITE_RATE:-5}" DURATION="${WRITE_DURATION:-30s}" HISTORY_MESSAGES="$history"
      done
      ;;
    fanout)
      for actors in $FANOUT_POINTS; do
        run_case "fanout-$actors" SCENARIO=fanout ACTORS="$actors" VUS="$actors" DURATION="${FANOUT_DURATION:-30s}"
      done
      ;;
    mixed)
      run_case "mixed" SCENARIO=mixed ACTORS="${MIXED_ACTORS:-10}" RATE="${MIXED_RATE:-5}" DURATION="${MIXED_DURATION:-30s}"
      ;;
    spike)
      run_case "spike" SCENARIO=spike ACTORS="${SPIKE_ACTORS:-25}" SPIKE_RATE="${SPIKE_RATE:-25}" DURATION="${SPIKE_DURATION:-30s}"
      ;;
    soak)
      run_case "soak" SCENARIO=soak ACTORS="${SOAK_ACTORS:-5}" VUS="${SOAK_VUS:-5}" DURATION="${SOAK_DURATION:-15m}" CAPTURE_PPROF="${CAPTURE_PPROF:-1}"
      ;;
    *)
      printf 'Unknown matrix scenario: %s\n' "$scenario" >&2
      exit 1
      ;;
  esac
done