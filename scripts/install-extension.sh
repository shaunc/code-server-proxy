#!/bin/bash
# Build and deploy the tmux-session-manager extension into the shared
# code-server extensions volume so running instances pick it up.
#
# WHY THIS EXISTS: the extension's compiled output lives in the repo, but
# code-server instances load it from the shared Docker volume
# (config.docker.sharedExtensionsVolume). Committing a rebuilt extension does
# NOT deploy it — this script does. (A rebuilt vsix once sat committed in git
# for days while every instance kept loading the stale build; see the beads
# issue that tracks that gap.)
#
# After running this, reload each running code-server window. Existing terminal
# tabs keep their old name until recreated (VS Code has no rename-in-place API);
# newly created tabs and re-adopted orphans get the resolved name.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="$REPO_DIR/extensions/tmux-session-manager"
VOLUME="${SHARED_EXTENSIONS_VOLUME:-code-server-extensions}"
IMAGE="${DOCKER_IMAGE:-code-server-proxy:latest}"

echo "==> Building extension (compile + package)"
npm --prefix "$EXT_DIR" run compile
npm --prefix "$EXT_DIR" run package

VSIX_NAME="$(cd "$EXT_DIR" && ls -1t ./*.vsix | head -1 | sed 's#^\./##')"
if [[ -z "$VSIX_NAME" ]]; then
    echo "Error: no .vsix produced in $EXT_DIR" >&2
    exit 1
fi

echo "==> Installing $VSIX_NAME into volume '$VOLUME' via $IMAGE"
# Run the install as the current host user (matches PUID/PGID of the volume's
# files) so the installed extension is owned correctly. HOME must be writable
# for code-server to scaffold its config.
docker run --rm \
    --user "$(id -u):$(id -g)" \
    -e HOME=/tmp \
    -v "$VOLUME:/ext" \
    -v "$EXT_DIR:/src:ro" \
    --entrypoint /app/code-server/bin/code-server \
    "$IMAGE" \
    --extensions-dir /ext \
    --install-extension "/src/$VSIX_NAME" \
    --force

echo "==> Done. Reload each running code-server window to load the new build."
echo "    Existing tabs keep their old name until recreated; new tabs and"
echo "    re-adopted orphan sessions get the resolved name."
