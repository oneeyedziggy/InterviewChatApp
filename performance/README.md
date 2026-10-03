# Performance Testing

This directory contains isolated performance-test tooling for the current single-process Go server. Performance runs must never use normal tenant data or an unapproved remote host.

## Safety Contract

1. Source `lib/safety.sh` and call `perf_prepare_run_dir <run-id>` before starting the server. It creates a private marked directory only beneath `performance/.data/` and exports `PERFORMANCE_TEST_MODE`, `PERFORMANCE_RUN_ID`, and `SERVER_DATA_DIR`. Existing run IDs are rejected unless `PERF_REUSE_RUN=1` is explicitly set and the marker matches.
2. Call `perf_assert_safe_target "$BASE_URL"` before any fixture or load command. Loopback targets are allowed by default. A remote target requires both `PERF_ALLOW_REMOTE=1` and an exact hostname in comma-separated `PERF_ALLOWED_HOSTS`.
3. Never point a run at production, normal development data, or a tenant containing user data. Do not use `reset-data.sh` or `clean-server-runtime-files.sh` as part of performance automation.
4. Generated identities, private keys, SQLite/WAL files, logs, profiles, binaries, and result artifacts belong only under ignored `performance/.data`, `performance/bin`, or `performance/results` directories.
5. A runner may stop only processes whose PIDs it captured after starting them. It must not use process-name-wide termination commands.

Example setup in WSL:

```bash
cd /mnt/c/Users/oneeyedziggy/Desktop/codeStuff/InterviewChatApp
source performance/lib/safety.sh
perf_prepare_run_dir smoke-001
RUN_DIR="$SERVER_DATA_DIR"
BASE_URL=http://127.0.0.1:3101
perf_assert_safe_target "$BASE_URL"
PORT=3101 DIAGNOSTICS_ADDR=127.0.0.1:6061 go run ./server-go
```

## Workload Dimensions

Every result must record the Git revision and dirty state, host CPU/RAM, Go and k6 versions, scenario, duration, arrival rate, concurrent sockets, tenants, rooms, members per room, ciphertext bytes, retained messages, and reconnect behavior.

Planned scenarios are:

- `smoke`: one actor connects, performs a valid signed mutation, receives its broadcast, disconnects, and survives restart/reload.
- `connections`: idle connection ramps and reconnect storms without mutations.
- `message-write`: constant arrival-rate encrypted writes across retained-history sizes.
- `fanout`: one sender with increasing room membership and delivery counts.
- `mixed`: realistic connection, read, write, and reconnect traffic across independent tenants.
- `spike`: rapid overload followed by recovery.
- `soak`: sustained load for memory, goroutine, descriptor, and WAL-growth detection.

## Correctness Gates

A performance run is invalid if any of these fail:

- Every WebSocket upgrade, signed mutation, and action result has the expected success or deliberate rejection outcome.
- Broadcast recipients receive exactly the expected event count with no duplicate message IDs.
- Authentication remains fail-closed for invalid signatures, stale timestamps, replayed nonces, and unknown tenants.
- Tenant and DM visibility boundaries are preserved.
- The server has no panic, race report, concurrent-write failure, or unexplained disconnect.
- Active sockets and goroutines return near baseline after teardown.
- SQLite integrity checks pass and accepted writes remain after restart.

Initial performance gates are zero correctness failures, zero panics, and less than 1% unexpected transport/application errors. Latency and sustainable-throughput regression thresholds will be set only after three repeat runs on the same WSL/Linux host.

## Disposable Actors

With an isolated server running, generate real authenticated actors through the existing registration and invite APIs:

```bash
go run ./server-go/cmd/perf-fixtures -base-url "$BASE_URL" -actors 10
```

The protected manifest is written to `$SERVER_DATA_DIR/fixtures.json`. It contains private keys and session IDs, must remain inside the ignored run directory, and must never be shared or committed. Existing manifests are refused unless `-overwrite` is explicitly supplied.

## Signed k6 Binary

Build the pinned k6 v2.3.0 binary with the local OpenPGP signing extension:

```bash
./performance/build-k6.sh
```

The ignored output is `performance/bin/k6`. The build runs canonical-input and detached-signature tests before compiling, then loads the extension in a one-iteration k6 smoke test with usage reporting disabled.

Run one scenario at a time with explicit dimensions:

```bash
SCENARIO=message-write DURATION=30s RATE=5 CIPHERTEXT_BYTES=256 \
FIXTURE_MANIFEST="$SERVER_DATA_DIR/fixtures.json" \
./performance/bin/k6 run --no-usage-report performance/k6/load.js
```

Supported `SCENARIO` values are `connections`, `message-write`, `fanout`, `mixed`, `spike`, and `soak`. Defaults are intentionally small; record every override with the run artifacts.

## Orchestrated WSL Run

The runner builds the server, creates a marked isolated data directory, captures only the PID it starts, waits for readiness, provisions actors, samples `/proc` and diagnostics, runs k6, captures pprof artifacts, and shuts down its own process:

```bash
SCENARIO=message-write ACTORS=10 DURATION=30s RATE=5 \
	./performance/run.sh baseline-write-001
```

Set `CAPTURE_PPROF=1 PROFILE_SECONDS=30` for a CPU profile during a sufficiently long run. Results are written beneath `performance/results/<run-id>/`; private actor credentials remain separately beneath `performance/.data/<run-id>/`.

Run the repeatable baseline matrix with three repetitions per point:

```bash
./performance/run-matrix.sh baseline-001
```

The default write history sizes are 0, 100, and 1,000 messages; fanout sizes are 2, 10, and 50 actors. Override `HISTORY_SIZES`, `FANOUT_SIZES`, scenario durations, rates, and actor counts through environment variables. Use a stable host with no competing workload for results intended as regression baselines.

Useful live views while a run is active:

```bash
tail -F performance/results/<run-id>/server.ndjson | jq -c 'select(.level == "ERROR" or .level == "WARN")'
watch -n 1 curl -fsS http://127.0.0.1:6061/debug/metrics
go tool pprof -http=:0 performance/results/<run-id>/cpu.pprof
```

## Deferred Scaling Work

These changes are deliberately deferred until the single-process measurements justify them:

- Add an explicit `tenantID -> hostID` registry and gateway when tenant placement or failover, rather than single-host capacity, becomes limiting.
- Add Redis or NATS pub/sub behind the broadcast abstraction only when sockets for one tenant must span processes.
- Add a Postgres `StateStore` only if incremental SQLite writes, WAL tuning, and tenant sharding cannot meet measured durability or throughput goals.
- Add a shared session store only when reconnects must move between hosts; otherwise retain tenant-affine routing.
- Add OpenTelemetry and persistent Prometheus/Grafana/Loki infrastructure only when ongoing multi-host operations justify their operational cost.
- Treat cross-deployment federation as a separate project after routing, shared broadcast, failover, and server-to-server trust requirements are measured and specified.