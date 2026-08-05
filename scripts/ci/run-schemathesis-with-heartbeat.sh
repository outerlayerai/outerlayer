#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -lt 4 ]; then
  echo "usage: $0 <label> <timeout-seconds> <debug-file> <schemathesis args...>" >&2
  exit 64
fi

label="$1"
timeout_seconds="$2"
debug_file="$3"
shift 3

heartbeat_seconds="${SCHEMATHESIS_HEARTBEAT_SECONDS:-30}"
tail_lines="${SCHEMATHESIS_DEBUG_TAIL_LINES:-20}"
kill_grace_seconds="${SCHEMATHESIS_KILL_GRACE_SECONDS:-5}"

rm -f "$debug_file"

# Launch Schemathesis in its OWN process group so the watcher below can signal
# the whole group, not just the leader. `--workers` spawns child processes; if
# one outlives the run (e.g. a worker parked on an idle keep-alive socket to the
# gateway), it is orphaned but keeps this step's stdout pipe open. The CI log
# reader then never sees EOF and the job hangs until the wall-clock job timeout
# — minutes after "N passed" is printed, with no further output. `setsid` makes
# the launched process a session+group leader (its PGID == its PID), so a single
# group kill reaps every worker it spawned. Falls back to a plain launch when
# `setsid` is unavailable (kills degrade to leader-only — no worse than before).
script_pgid="$(ps -o pgid= -p "$$" 2>/dev/null | tr -d ' ' || true)"
if command -v setsid >/dev/null 2>&1; then
  setsid "$@" --debug-output-file "$debug_file" &
else
  "$@" --debug-output-file "$debug_file" &
fi
child_pid=$!
start_ts="$(date +%s)"

# Process group to signal. With setsid this equals child_pid. Only ever
# group-kill a group that is genuinely distinct from this script's own group;
# otherwise signal just the leader, so a missing or no-op setsid can never take
# out the wrapper itself.
child_pgid="$(ps -o pgid= -p "$child_pid" 2>/dev/null | tr -d ' ' || true)"

signal_tree() {
  local sig="$1"
  if [ -n "$child_pgid" ] && [ "$child_pgid" != "$script_pgid" ]; then
    kill -s "$sig" -- -"$child_pgid" 2>/dev/null || true
  else
    kill -s "$sig" "$child_pid" 2>/dev/null || true
  fi
}

trap 'signal_tree TERM' INT TERM

print_heartbeat() {
  local now elapsed completed file_bytes last_line
  now="$(date +%s)"
  elapsed="$((now - start_ts))"
  completed=0
  file_bytes=0
  last_line="none"

  if [ -f "$debug_file" ]; then
    completed="$(grep -c '"event_type": "AfterExecution"' "$debug_file" || true)"
    file_bytes="$(wc -c < "$debug_file" | tr -d ' ')"
    last_line="$(tail -n 1 "$debug_file" | cut -c 1-200 || true)"
  fi

  echo "[${label}] heartbeat elapsed=${elapsed}s completed_ops=${completed} debug_bytes=${file_bytes} last_event=${last_line}"
}

while kill -0 "$child_pid" 2>/dev/null; do
  sleep "$heartbeat_seconds"

  if ! kill -0 "$child_pid" 2>/dev/null; then
    break
  fi

  print_heartbeat

  now_ts="$(date +%s)"
  elapsed="$((now_ts - start_ts))"
  if [ "$elapsed" -ge "$timeout_seconds" ]; then
    echo "[${label}] timeout after ${elapsed}s; terminating Schemathesis"
    signal_tree TERM
    sleep "$kill_grace_seconds"
    if kill -0 "$child_pid" 2>/dev/null; then
      echo "[${label}] process ignored SIGTERM; sending SIGKILL"
      signal_tree KILL
    fi
    wait "$child_pid" 2>/dev/null || true
    echo "[${label}] last ${tail_lines} debug events:"
    tail -n "$tail_lines" "$debug_file" || true
    exit 124
  fi
done

# Leader finished on its own. Sweep any worker still lingering in the group so
# none can hold this step's stdout open and stall job completion, then surface
# the leader's exit status (a Schemathesis failure must still fail the step).
signal_tree TERM
wait "$child_pid"
