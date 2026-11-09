#!/usr/bin/env bash
set -u

if (( $# > 1 )); then
  printf 'Usage: %s [log-path]\n' "$0" >&2
  exit 2
fi

log_path=${1-/root/qnx-tutorial-run/output/qemu.out}
# Expected lines come from examples/<example>/expected-output.txt next to this tutorial.
# Set EXPECTED_DIR to a folder of <example>.txt files to check against other expectations.
repo_root=$(cd -- "$(dirname -- "$0")/.." && pwd)
expected_dir=${EXPECTED_DIR-}

if [[ ! -f "$log_path" || ! -r "$log_path" ]]; then
  printf 'ERROR: log file does not exist or is not readable: %s\n' "$log_path" >&2
  exit 1
fi

normalized_log=$(mktemp) || {
  printf 'ERROR: cannot create temporary log.\n' >&2
  exit 1
}
trap 'rm -f -- "$normalized_log"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if ! tr -d '\r' < "$log_path" > "$normalized_log"; then
  printf 'ERROR: cannot normalize log: %s\n' "$log_path" >&2
  exit 1
fi

passed=0
check_example() {
  local example=$1 marker=$2
  local expected_file expected_line missing=''
  if [[ "$example" == hello ]]; then
    expected_line='Hello from QNX MCP smoke.'
    if ! grep -Fxq -- "$expected_line" "$normalized_log"; then
      missing="missing line: $expected_line"
    fi
  else
    if [[ -n "$expected_dir" ]]; then
      expected_file="$expected_dir/$example.txt"
    else
      expected_file="$repo_root/examples/$example/expected-output.txt"
    fi
    if [[ ! -f "$expected_file" || ! -r "$expected_file" ]]; then
      missing="expected file missing or unreadable: $expected_file"
    elif [[ ! -s "$expected_file" ]]; then
      missing="expected file is empty: $expected_file"
    else
      while IFS= read -r expected_line || [[ -n "$expected_line" ]]; do
        if ! grep -Fxq -- "$expected_line" "$normalized_log"; then
          missing+="${missing:+; }missing line: $expected_line"
        fi
      done < "$expected_file"
    fi
  fi
  if ! grep -Fxq -- "$marker" "$normalized_log"; then
    missing+="${missing:+; }missing exit marker: $marker"
  fi
  if [[ -z "$missing" ]]; then
    printf 'PASS %s\n' "$example"
    passed=$((passed + 1))
  else
    printf 'FAIL %s: %s\n' "$example" "$missing"
  fi
}

check_example hello QNX_MCP_RUN_EXIT=0
check_example msgpass QNX_MSGPASS_RUN_EXIT=0
check_example resmgr QNX_RESMGR_RUN_EXIT=0
check_example pulses QNX_PULSES_RUN_EXIT=0
check_example events QNX_EVENTS_RUN_EXIT=0
check_example prioinherit QNX_PRIO_RUN_EXIT=0
printf '%s/6 examples passed\n' "$passed"
[[ "$passed" -eq 6 ]]
