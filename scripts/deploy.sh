#!/bin/bash
# Bring THIS host fully up to the current repo state. Idempotent.
#
# WHY THIS EXISTS: git propagates code, but the things with side effects
# do NOT ride along with `git pull` — the Docker image, the extensions
# installed into the host-local code-server-extensions volume, and the
# running instances are all per-host. Docker volumes/images are
# per-daemon, so deploying on one host never reaches another. This
# script applies those side effects so a host matches the repo.
#
# Run it on EVERY installation (silk and rayon). To deploy everywhere in
# one shot, use scripts/deploy-all.sh, which runs this on each host.
#
# Usage: scripts/deploy.sh [--restart] [--no-pull]
#   --restart   restart the proxy and running workspace instances after
#               deploying. This interrupts active sessions, so it is OFF
#               by default; without it you just reload code-server windows
#               to pick up new extensions.
#   --no-pull   deploy the current working tree as-is (skip git pull) and
#               force the image + custom-extension rebuilds.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

DO_RESTART=0
DO_PULL=1
for arg in "$@"; do
    case "$arg" in
        --restart) DO_RESTART=1 ;;
        --no-pull) DO_PULL=0 ;;
        *) echo "Unknown argument: $arg" >&2; exit 2 ;;
    esac
done

echo "==> Deploying on $(hostname) from $REPO_DIR"

# --- 1. Sync code -------------------------------------------------------
before=""
after=""
if [ "$DO_PULL" -eq 1 ]; then
    before="$(git rev-parse HEAD)"
    echo "==> git pull --ff-only"
    git pull --ff-only
    after="$(git rev-parse HEAD)"
    if [ "$before" = "$after" ]; then
        echo "    Already up to date ($after)."
    else
        echo "    $before -> $after"
    fi
fi

# changed_since_pull <pathspec>: true if the pulled diff touched it, or if
# we did not pull (so we cannot tell — rebuild to be safe).
changed_since_pull() {
    if [ "$DO_PULL" -eq 0 ] || [ -z "$before" ] || [ "$before" = "$after" ]; then
        [ "$DO_PULL" -eq 0 ]  # only "changed" when not pulling
        return
    fi
    git diff --name-only "$before" "$after" | grep -q "^$1"
}

# --- 2. Rebuild Docker image -------------------------------------------
# Always build. Docker's layer cache makes this a near-instant no-op when
# docker/ is unchanged (and an unchanged build yields the SAME image id,
# so containers are not needlessly recreated). Gating on the pull diff is
# wrong: the image can be stale relative to HEAD with no pull this run
# (e.g. it was built long before the current commit), and only an
# unconditional build guarantees the running image matches the source.
# build-docker-image.sh does not --pull, so the linuxserver base does not
# drift underneath us.
echo "==> Building Docker image (cache makes this a no-op if unchanged)"
scripts/build-docker-image.sh

# --- 3. Custom extension (tmux-session-manager) -------------------------
# Rebuild+install only when its source changed (the build runs npm).
if changed_since_pull "extensions/"; then
    echo "==> Building + installing custom extension"
    scripts/install-extension.sh
else
    echo "==> Custom extension up to date; skipping"
fi

# --- 4. Marketplace extensions (idempotent, cheap) ----------------------
echo "==> Installing marketplace extensions"
scripts/install-marketplace-extensions.sh

# --- 5. Restart (opt-in; interrupts active sessions) --------------------
if [ "$DO_RESTART" -eq 1 ]; then
    export XDG_RUNTIME_DIR="/run/user/$(id -u)"
    echo "==> Restarting proxy"
    scripts/restart-proxy.sh
    echo "==> Restarting running workspace instances"
    systemctl --user list-units --type=service --state=running --no-legend \
            'code-server-workspace@*' | awk '{print $1}' \
        | while read -r svc; do
            [ -n "$svc" ] || continue
            echo "    restart $svc"
            systemctl --user restart "$svc"
        done
else
    echo "==> Skipping restart (pass --restart to restart proxy + instances)."
    echo "    Reload each code-server window to load new extensions."
fi

echo "==> Deploy complete on $(hostname)"
