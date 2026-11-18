#!/usr/bin/env bash
# Self-test for check-run.sh using synthetic logs built from the expected-output files.
# No QNX SDK, QEMU or network needed: bash tutorial/test-check-run.sh
set -u

here=$(cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(cd -- "$here/.." && pwd)
work=$(mktemp -d) || exit 1
trap 'rm -rf -- "$work"' EXIT

examples=(msgpass resmgr pulses events prioinherit nameservice)
markers=(QNX_MCP_RUN_EXIT QNX_MSGPASS_RUN_EXIT QNX_RESMGR_RUN_EXIT QNX_PULSES_RUN_EXIT
  QNX_EVENTS_RUN_EXIT QNX_PRIO_RUN_EXIT QNX_NAME_RUN_EXIT)

valid="$work/valid.log"
{
  printf 'Hello from QNX MCP smoke.\n'
  for example in "${examples[@]}"; do
    cat -- "$repo_root/examples/$example/expected-output.txt"
    printf '\n'
  done
  for marker in "${markers[@]}"; do
    printf '%s=0\n' "$marker"
  done
} | tr -d '\r' | grep -v '^$' > "$valid"

failures=0
expect() {
  local name=$1 want_status=$2 want_text=$3 log=$4
  local output status
  output=$(bash "$here/check-run.sh" "$log" 2>&1)
  status=$?
  if [[ "$status" -ne "$want_status" ]] || ! grep -Fq -- "$want_text" <<< "$output"; then
    printf 'FAIL %s: status %s (wanted %s), wanted text: %s\n%s\n' \
      "$name" "$status" "$want_status" "$want_text" "$output"
    failures=$((failures + 1))
  else
    printf 'ok   %s\n' "$name"
  fi
}

# 1. Complete, consistent log.
expect 'valid log' 0 '7/7 examples passed' "$valid"

# 2. One expected line missing.
first_line=$(head -n 1 -- "$repo_root/examples/pulses/expected-output.txt" | tr -d '\r')
grep -Fxv -- "$first_line" "$valid" > "$work/missing-line.log"
expect 'missing expected line' 1 'FAIL pulses: missing line:' "$work/missing-line.log"

# 3. Exit marker absent.
grep -v '^QNX_EVENTS_RUN_EXIT=' "$valid" > "$work/no-marker.log"
expect 'exit marker absent' 1 'FAIL events: missing exit marker: QNX_EVENTS_RUN_EXIT=0' "$work/no-marker.log"

# 4. Non-zero exit only.
sed 's/^QNX_RESMGR_RUN_EXIT=0$/QNX_RESMGR_RUN_EXIT=1/' "$valid" > "$work/nonzero.log"
expect 'non-zero exit' 1 'conflicting exit marker: QNX_RESMGR_RUN_EXIT=1' "$work/nonzero.log"

# 5. Success and failure markers for the same example.
{ cat -- "$valid"; printf 'QNX_MSGPASS_RUN_EXIT=3\n'; } > "$work/mixed.log"
expect 'success and failure mixed' 1 'FAIL msgpass: ambiguous log, conflicting exit marker: QNX_MSGPASS_RUN_EXIT=3' "$work/mixed.log"

# 6. Truncated log: only the first half survives.
total=$(wc -l < "$valid")
head -n $((total / 2)) -- "$valid" > "$work/truncated.log"
expect 'truncated log' 1 'missing exit marker: QNX_NAME_RUN_EXIT=0' "$work/truncated.log"

if [[ "$failures" -eq 0 ]]; then
  printf 'check-run self-test: 6/6 cases behaved as expected\n'
else
  printf 'check-run self-test: %s case(s) failed\n' "$failures"
  exit 1
fi
