#!/bin/bash
# Deploy to ALL installations by running scripts/deploy.sh on each host.
#
# WHY THIS EXISTS: Docker images, volume-installed extensions, and running
# instances are per-host (Docker daemons do not share volumes), so a fix
# is not deployed until deploy.sh has run on every host. This orchestrates
# that: it runs deploy.sh locally for the current host and over SSH for the
# rest. Any arguments are forwarded verbatim to deploy.sh.
#
# Usage: scripts/deploy-all.sh [deploy.sh args...]
#   scripts/deploy-all.sh             # deploy everywhere, no restart
#   scripts/deploy-all.sh --restart   # deploy + restart everywhere
#
# Config (env overrides):
#   DEPLOY_HOSTS      space-separated host list (default: "silk rayon")
#   DEPLOY_REPO_PATH  repo path on each host. Must be valid on all hosts;
#                     the default is a symlink on silk and the real repo on
#                     rayon, so it resolves on both.
set -euo pipefail

read -r -a HOSTS <<< "${DEPLOY_HOSTS:-silk rayon}"
REPO_PATH="${DEPLOY_REPO_PATH:-/home/shauncutts/src/other/code-server-proxy}"

LOCAL_HOST="$(hostname)"
rc=0

for host in "${HOSTS[@]}"; do
    echo "============================================================"
    echo "==> Deploying to $host"
    echo "============================================================"
    if [ "$host" = "$LOCAL_HOST" ]; then
        # Local host: run directly, no SSH round-trip.
        if ! ( cd "$REPO_PATH" && scripts/deploy.sh "$@" ); then
            echo "!! Deploy FAILED on $host" >&2
            rc=1
        fi
    else
        if ! ssh -o BatchMode=yes "$host" \
                "cd '$REPO_PATH' && scripts/deploy.sh $*"; then
            echo "!! Deploy FAILED on $host" >&2
            rc=1
        fi
    fi
done

if [ "$rc" -eq 0 ]; then
    echo "==> deploy-all complete on: ${HOSTS[*]}"
else
    echo "==> deploy-all finished WITH FAILURES — see above." >&2
fi
exit "$rc"
