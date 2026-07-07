#!/bin/bash
# Build and deploy the repo's LOCAL code-server extensions (everything under
# extensions/) into the shared code-server extensions volume so running
# instances pick them up.
#
# WHY THIS EXISTS: extension source lives in the repo, but code-server instances
# load extensions from the shared Docker volume
# (config.docker.sharedExtensionsVolume). Committing a rebuilt extension does
# NOT deploy it — this script does. (A rebuilt vsix once sat committed in git for
# days while every instance kept loading the stale build.)
#
# Handles both kinds of local extension:
#   - compiled (has a "compile" npm script, e.g. tmux-session-manager) — installs
#     deps if needed, compiles, then packages;
#   - manifest-only (has a "package" script but no "compile", e.g.
#     ff-code-server-defaults) — just packages.
#
# After running this, reload each running code-server window to load the new
# builds. (For tmux-session-manager: existing terminal tabs keep their old name
# until recreated; new tabs and re-adopted orphans get the resolved name.)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VOLUME="${SHARED_EXTENSIONS_VOLUME:-code-server-extensions}"
IMAGE="${DOCKER_IMAGE:-code-server-proxy:latest}"

# Optional arg: build only the named extension (dir under extensions/).
ONLY="${1:-}"

has_script() {  # has_script <ext-dir> <script-name>
    node -e "process.exit((require('$1/package.json').scripts||{})['$2']?0:1)" \
        2>/dev/null
}

for EXT_DIR in "$REPO_DIR"/extensions/*/; do
    EXT_DIR="${EXT_DIR%/}"
    NAME="$(basename "$EXT_DIR")"
    [ -f "$EXT_DIR/package.json" ] || continue
    [ -z "$ONLY" ] || [ "$ONLY" = "$NAME" ] || continue

    echo "==> [$NAME] building"
    # Install deps only if the extension declares any and they're missing
    # (manifest-only extensions have none).
    if node -e "const p=require('$EXT_DIR/package.json'); process.exit((p.dependencies||p.devDependencies)?0:1)" 2>/dev/null; then
        [ -d "$EXT_DIR/node_modules" ] || npm --prefix "$EXT_DIR" install
    fi
    if has_script "$EXT_DIR" compile; then
        npm --prefix "$EXT_DIR" run compile
    fi
    if has_script "$EXT_DIR" package; then
        npm --prefix "$EXT_DIR" run package
    else
        ( cd "$EXT_DIR" && npx --yes @vscode/vsce package --no-dependencies )
    fi

    VSIX_NAME="$(cd "$EXT_DIR" && ls -1t ./*.vsix 2>/dev/null | head -1 | sed 's#^\./##')"
    if [[ -z "$VSIX_NAME" ]]; then
        echo "Error: no .vsix produced in $EXT_DIR" >&2
        exit 1
    fi

    echo "==> [$NAME] installing $VSIX_NAME into volume '$VOLUME' via $IMAGE"
    # Run as the current host user (matches PUID/PGID of the volume's files) so
    # the installed extension is owned correctly. HOME must be writable for
    # code-server to scaffold its config.
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
done

echo "==> Done. Reload each running code-server window to load the new builds."
