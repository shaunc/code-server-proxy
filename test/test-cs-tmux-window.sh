#!/bin/bash
# Tests for cs-tmux-window (session-per-pane model)
# Run: bash test/test-cs-tmux-window.sh
# Requires: tmux, python3, cs-tmux-window in PATH

set -euo pipefail

PASS=0
FAIL=0
TEST_IID="test-$$"  # unique per run to avoid collisions

cleanup() {
    cs-tmux-window cleanup "$TEST_IID" 2>/dev/null || true
    rm -f ~/.config/code-server-proxy/mappings/cs-"${TEST_IID}".json
}
trap cleanup EXIT

assert_eq() {
    local desc="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        echo "  PASS: $desc"
        PASS=$((PASS + 1))
    else
        echo "  FAIL: $desc (expected='$expected' actual='$actual')"
        FAIL=$((FAIL + 1))
    fi
}

assert_ne() {
    local desc="$1" val1="$2" val2="$3"
    if [ "$val1" != "$val2" ]; then
        echo "  PASS: $desc"
        PASS=$((PASS + 1))
    else
        echo "  FAIL: $desc (both='$val1')"
        FAIL=$((FAIL + 1))
    fi
}

assert_match() {
    local desc="$1" pattern="$2" actual="$3"
    if echo "$actual" | grep -qE "$pattern"; then
        echo "  PASS: $desc"
        PASS=$((PASS + 1))
    else
        echo "  FAIL: $desc (pattern='$pattern' actual='$actual')"
        FAIL=$((FAIL + 1))
    fi
}

assert_session_exists() {
    local desc="$1" session="$2"
    if tmux has-session -t "$session" 2>/dev/null; then
        echo "  PASS: $desc"
        PASS=$((PASS + 1))
    else
        echo "  FAIL: $desc (session '$session' not found)"
        FAIL=$((FAIL + 1))
    fi
}

assert_session_gone() {
    local desc="$1" session="$2"
    if ! tmux has-session -t "$session" 2>/dev/null; then
        echo "  PASS: $desc"
        PASS=$((PASS + 1))
    else
        echo "  FAIL: $desc (session '$session' still exists)"
        FAIL=$((FAIL + 1))
    fi
}

# ── Test: create ──────────────────────────────────────────────

echo "=== create ==="

s0=$(cs-tmux-window create "$TEST_IID" /tmp)
assert_match "first session name" "^cs-${TEST_IID}-0$" "$s0"
assert_session_exists "session exists" "$s0"

s1=$(cs-tmux-window create "$TEST_IID" /tmp)
assert_match "second session increments" "^cs-${TEST_IID}-1$" "$s1"
assert_ne "sessions are distinct" "$s0" "$s1"

s2=$(cs-tmux-window create "$TEST_IID" /tmp)
assert_match "third session increments" "^cs-${TEST_IID}-2$" "$s2"

# ── Test: list ────────────────────────────────────────────────

echo "=== list ==="

listed=$(cs-tmux-window list "$TEST_IID")
count=$(echo "$listed" | wc -l)
assert_eq "list shows 3 sessions" "3" "$count"
assert_match "list contains s0" "$s0" "$listed"
assert_match "list contains s2" "$s2" "$listed"

# ── Test: attach-or-create with new pane ID ───────────────────

echo "=== attach-or-create (new) ==="

s3=$(cs-tmux-window attach-or-create "$TEST_IID" pane-aaa /tmp)
assert_session_exists "new pane creates session" "$s3"

# ── Test: attach-or-create with same pane ID (idempotent) ─────

echo "=== attach-or-create (idempotent) ==="

s3b=$(cs-tmux-window attach-or-create "$TEST_IID" pane-aaa /tmp)
assert_eq "same pane ID returns same session" "$s3" "$s3b"

# ── Test: attach-or-create after session killed ───────────────

echo "=== attach-or-create (session killed, remaps) ==="

tmux kill-session -t "$s3" 2>/dev/null
s3c=$(cs-tmux-window attach-or-create "$TEST_IID" pane-aaa /tmp)
assert_session_exists "remapped session exists" "$s3c"
# Session name may be reused (index recycled) — that's fine.
# What matters is the session is alive and the mapping is updated.
s3d=$(cs-tmux-window attach-or-create "$TEST_IID" pane-aaa /tmp)
assert_eq "remapped session is stable" "$s3c" "$s3d"

# ── Test: multiple pane IDs get different sessions ────────────

echo "=== multiple pane IDs ==="

sa=$(cs-tmux-window attach-or-create "$TEST_IID" pane-bbb /tmp)
sb=$(cs-tmux-window attach-or-create "$TEST_IID" pane-ccc /tmp)
assert_ne "different pane IDs get different sessions" "$sa" "$sb"

# ── Test: mapping file is valid JSON ──────────────────────────

echo "=== mapping file ==="

map_file=~/.config/code-server-proxy/mappings/cs-"${TEST_IID}".json
if [ -f "$map_file" ]; then
    if python3 -c "import json; json.load(open('$map_file'))" 2>/dev/null; then
        echo "  PASS: mapping file is valid JSON"
        PASS=$((PASS + 1))
    else
        echo "  FAIL: mapping file is invalid JSON"
        FAIL=$((FAIL + 1))
    fi
else
    echo "  FAIL: mapping file not found at $map_file"
    FAIL=$((FAIL + 1))
fi

# ── Test: concurrent creation (race condition) ────────────────

echo "=== concurrent creation ==="

pids=()
results_dir=$(mktemp -d)
for i in $(seq 1 10); do
    cs-tmux-window attach-or-create "$TEST_IID" "race-$i" /tmp \
        > "$results_dir/$i" 2>/dev/null &
    pids+=($!)
done
for pid in "${pids[@]}"; do wait "$pid"; done

sessions=$(cat "$results_dir"/* | sort -u)
unique_count=$(echo "$sessions" | wc -l)
assert_eq "10 concurrent calls produce 10 unique sessions" "10" "$unique_count"
rm -rf "$results_dir"

# ── Test: cleanup ─────────────────────────────────────────────

echo "=== cleanup ==="

pre_count=$(cs-tmux-window list "$TEST_IID" | wc -l)
assert_ne "sessions exist before cleanup" "0" "$pre_count"

cs-tmux-window cleanup "$TEST_IID"

post=$(cs-tmux-window list "$TEST_IID")
assert_eq "no sessions after cleanup" "" "$post"
assert_eq "mapping file removed" "false" "$([ -f "$map_file" ] && echo true || echo false)"

# ── Summary ───────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════"
echo "  PASS: $PASS  FAIL: $FAIL"
echo "═══════════════════════════════════"

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
