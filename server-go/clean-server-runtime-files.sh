#!/usr/bin/env bash
set -euo pipefail

servers_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/servers"
patterns=("*.sqlite3" "*.sqlite3-shm" "*.sqlite3-wal")
force=false

for arg in "$@"; do
  case "$arg" in
    --yes|--force) force=true ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

shopt -s nullglob
matches=()
for pattern in "${patterns[@]}"; do
  for file in "$servers_dir"/$pattern; do
    matches+=("$file")
  done
done

if [ "${#matches[@]}" -eq 0 ]; then
  echo "No matching per-server sqlite files found in $servers_dir"
  exit 0
fi

if [ "$force" = true ]; then
  printf 'Deleting: %s\n' "${matches[@]}"
  rm -f "${matches[@]}"
  echo "Deleted ${#matches[@]} file(s)."
else
  printf 'Would delete (dry run, pass --yes to actually delete): %s\n' "${matches[@]}"
fi