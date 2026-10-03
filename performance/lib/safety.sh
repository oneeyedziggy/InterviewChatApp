#!/usr/bin/env bash

PERFORMANCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PERFORMANCE_DATA_ROOT="$PERFORMANCE_DIR/.data"
PERFORMANCE_MARKER=".interview-chat-performance-data"

perf_fail() {
  printf 'performance safety: %s\n' "$*" >&2
  return 1
}

perf_validate_run_id() {
  local run_id="${1:-}"
  [[ "$run_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] ||
    perf_fail "run ID must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"
}

perf_prepare_run_dir() {
  local run_id="${1:-}"
  perf_validate_run_id "$run_id" || return 1

  if [[ -L "$PERFORMANCE_DATA_ROOT" ]]; then
    perf_fail "performance data root must not be a symbolic link" || return 1
  fi
  mkdir -p -m 700 "$PERFORMANCE_DATA_ROOT"
  local root_real
  root_real="$(cd "$PERFORMANCE_DATA_ROOT" && pwd -P)"
  [[ "$root_real" == "$PERFORMANCE_DIR/.data" ]] ||
    perf_fail "performance data root escaped the repository performance directory" || return 1
  local run_dir="$root_real/$run_id"
  if [[ -e "$run_dir" ]]; then
    [[ ! -L "$run_dir" ]] || perf_fail "run directory must not be a symbolic link" || return 1
    [[ "${PERF_REUSE_RUN:-0}" == "1" ]] ||
      perf_fail "run directory already exists; choose a new run ID or set PERF_REUSE_RUN=1" || return 1
  else
    mkdir -m 700 "$run_dir"
  fi
  local run_real
  run_real="$(cd "$run_dir" && pwd -P)"
  [[ "$run_real" == "$root_real/$run_id" ]] ||
    perf_fail "run directory escaped performance data root" || return 1

  local marker="$run_real/$PERFORMANCE_MARKER"
  if [[ -e "$marker" ]] && [[ "$(tr -d '\r\n' < "$marker")" != "$run_id" ]]; then
    perf_fail "existing run directory marker does not match run ID" || return 1
  fi
  (umask 077; printf '%s\n' "$run_id" > "$marker")

  export PERFORMANCE_TEST_MODE=1
  export PERFORMANCE_RUN_ID="$run_id"
  export SERVER_DATA_DIR="$run_real"
  printf '%s\n' "$run_real"
}

perf_target_host() {
  local target="${1:-}"
  if [[ ! "$target" =~ ^(https?|wss?)://([^/]+) ]]; then
    perf_fail "target must be an http(s) or ws(s) URL" || return 1
  fi
  local authority="${BASH_REMATCH[2]}"
  [[ "$authority" != *"@"* ]] || perf_fail "target URLs must not contain credentials" || return 1

  if [[ "$authority" == \[*\]* ]]; then
    authority="${authority#\[}"
    authority="${authority%%\]*}"
  else
    authority="${authority%%:*}"
  fi
  printf '%s\n' "${authority,,}"
}

perf_assert_safe_target() {
  local host
  host="$(perf_target_host "${1:-}")" || return 1
  case "$host" in
    localhost|127.0.0.1|::1) return 0 ;;
  esac

  [[ "${PERF_ALLOW_REMOTE:-0}" == "1" ]] ||
    perf_fail "remote target $host requires PERF_ALLOW_REMOTE=1" || return 1
  local allowed
  IFS=',' read -ra allowed <<< "${PERF_ALLOWED_HOSTS:-}"
  local candidate
  for candidate in "${allowed[@]}"; do
    if [[ "${candidate,,}" == "$host" ]]; then
      return 0
    fi
  done
  perf_fail "remote target $host is not in PERF_ALLOWED_HOSTS"
}