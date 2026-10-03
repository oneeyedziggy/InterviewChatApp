#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "$SCRIPT_DIR/safety.sh"

perf_assert_safe_target "http://127.0.0.1:3101"
perf_assert_safe_target "ws://localhost:3101/ws/"

if perf_assert_safe_target "https://example.com" 2>/dev/null; then
  printf 'expected remote target without opt-in to fail\n' >&2
  exit 1
fi

PERF_ALLOW_REMOTE=1 PERF_ALLOWED_HOSTS=staging.example.com \
  perf_assert_safe_target "https://staging.example.com/chatApp"
if PERF_ALLOW_REMOTE=1 PERF_ALLOWED_HOSTS=staging.example.com \
  perf_assert_safe_target "https://production.example.com" 2>/dev/null; then
  printf 'expected non-allowlisted remote target to fail\n' >&2
  exit 1
fi

if perf_validate_run_id "../../unsafe" 2>/dev/null; then
  printf 'expected unsafe run ID to fail\n' >&2
  exit 1
fi

run_id="guardrail-self-test-$$"
perf_prepare_run_dir "$run_id" >/dev/null
[[ "$PERFORMANCE_TEST_MODE" == "1" ]]
[[ "$PERFORMANCE_RUN_ID" == "$run_id" ]]
[[ "$SERVER_DATA_DIR" == "$PERFORMANCE_DATA_ROOT/$run_id" ]]
[[ "$(tr -d '\r\n' < "$SERVER_DATA_DIR/$PERFORMANCE_MARKER")" == "$PERFORMANCE_RUN_ID" ]]

if perf_prepare_run_dir "$run_id" >/dev/null 2>&1; then
  printf 'expected existing run directory without reuse opt-in to fail\n' >&2
  exit 1
fi
PERF_REUSE_RUN=1 perf_prepare_run_dir "$run_id" >/dev/null

printf 'performance safety checks passed\n'