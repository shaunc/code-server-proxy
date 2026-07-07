#!/bin/bash
# Reconcile a host's live user settings.json against the team defaults now
# owned by the ff-code-server-defaults extension (Step 0 of the settings-split
# migration — see tmp/issues/settings-defaults/v2/plan.md §5).
#
# WHY: existing hosts already have a fully-populated settings.json. Every
# current default lives there as a *User* value, and the User layer wins — so
# once defaults move into the extension, those stale copies SHADOW the
# extension defaults forever and drift. This tool removes every key whose value
# equals the new default (letting the extension govern it), and KEEPS every key
# whose value differs (a genuine per-machine override, e.g. rayon's theme).
#
# Dry-run by default: prints what it would remove/keep, writes nothing.
#   scripts/reconcile-user-settings.sh [SETTINGS_JSON]
#   scripts/reconcile-user-settings.sh --apply [SETTINGS_JSON]
#
# On --apply the file is rewritten as clean JSON containing ONLY override keys
# (comments are dropped — post-migration it holds user overrides only).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULTS_MANIFEST="$REPO_DIR/extensions/ff-code-server-defaults/package.json"

APPLY=0
TARGET="$REPO_DIR/config/shared/User/settings.json"
for arg in "$@"; do
    case "$arg" in
        --apply) APPLY=1 ;;
        -*) echo "Unknown flag: $arg" >&2; exit 2 ;;
        *) TARGET="$arg" ;;
    esac
done

[ -f "$DEFAULTS_MANIFEST" ] || { echo "Missing $DEFAULTS_MANIFEST" >&2; exit 1; }
[ -f "$TARGET" ] || { echo "Target not found: $TARGET" >&2; exit 1; }

APPLY="$APPLY" TARGET="$TARGET" DEFAULTS_MANIFEST="$DEFAULTS_MANIFEST" \
    python3 - <<'PY'
import json, os, re, sys

def strip_jsonc(s):
    """Strip // and /* */ comments and trailing commas (string-aware)."""
    out=[]; i=0; n=len(s); instr=False; esc=False
    while i<n:
        c=s[i]
        if instr:
            out.append(c)
            if esc: esc=False
            elif c=='\\': esc=True
            elif c=='"': instr=False
            i+=1; continue
        if c=='"': instr=True; out.append(c); i+=1; continue
        if c=='/' and i+1<n and s[i+1]=='/':
            while i<n and s[i]!='\n': i+=1
            continue
        if c=='/' and i+1<n and s[i+1]=='*':
            i+=2
            while i+1<n and not (s[i]=='*' and s[i+1]=='/'): i+=1
            i+=2; continue
        out.append(c); i+=1
    t=''.join(out)
    return re.sub(r',(\s*[}\]])', r'\1', t)

target = os.environ['TARGET']
apply = os.environ['APPLY'] == '1'
defaults = json.load(open(os.environ['DEFAULTS_MANIFEST']))
defaults = defaults['contributes']['configurationDefaults']
live = json.loads(strip_jsonc(open(target).read()))

remove, keep = [], {}
for k, v in live.items():
    if k in defaults and v == defaults[k]:
        remove.append(k)          # equals team default -> extension governs it
    else:
        keep[k] = v               # genuine override (or no team default)

print(f"Target: {target}")
print(f"  {len(remove)} key(s) equal to team default -> REMOVE:")
for k in remove:
    print(f"    - {k}")
print(f"  {len(keep)} key(s) kept as override:")
for k in keep:
    print(f"    + {k} = {json.dumps(keep[k])[:80]}")

if not apply:
    print("\n(dry-run; pass --apply to rewrite the file with overrides only)")
    sys.exit(0)

with open(target, 'w') as f:
    json.dump(keep, f, indent=2)
    f.write("\n")
print(f"\nApplied: wrote {len(keep)} override key(s) to {target}")
PY
