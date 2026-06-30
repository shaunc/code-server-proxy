#!/bin/bash
# Install marketplace extensions into the shared code-server extensions
# volume so running instances pick them up after a window reload.
#
# WHY THIS EXISTS: code-server instances load extensions from the
# host-local Docker volume (config.docker.sharedExtensionsVolume).
# Marketplace extensions installed ad-hoc into that volume are not
# reproducible — they vanish if the volume is recreated and do not
# exist on other hosts. Docker volumes are per-daemon, so this MUST be
# run on every host (currently silk and rayon); installing on one host
# does NOT propagate to the others.
#
# The companion scripts/install-extension.sh deploys the in-repo
# tmux-session-manager extension; this one deploys extensions pulled
# from Open VSX by id. Keep the EXTENSIONS list below as the source of
# truth for which marketplace extensions every installation should have.
#
# After running this, reload each running code-server window.
set -euo pipefail

# Extensions every installation should have, by Open VSX id.
EXTENSIONS=(
    # Renders ```mermaid fenced blocks in the built-in markdown preview.
    # Contributes a preview script (not a custom editor), so it adds to
    # the existing preview without stealing focus. Needed because this
    # code-server build predates native mermaid (VS Code >= 1.121).
    bierner.markdown-mermaid
)

VOLUME="${SHARED_EXTENSIONS_VOLUME:-code-server-extensions}"
IMAGE="${DOCKER_IMAGE:-code-server-proxy:latest}"

echo "==> Installing ${#EXTENSIONS[@]} marketplace extension(s) into" \
     "volume '$VOLUME' via $IMAGE"

# Run as the current host user (matches PUID/PGID of the volume's files)
# so installed extensions are owned correctly. HOME must be writable for
# code-server to scaffold its config.
for ext in "${EXTENSIONS[@]}"; do
    echo "==> $ext"
    docker run --rm \
        --user "$(id -u):$(id -g)" \
        -e HOME=/tmp \
        -v "$VOLUME:/ext" \
        --entrypoint /app/code-server/bin/code-server \
        "$IMAGE" \
        --extensions-dir /ext \
        --install-extension "$ext" \
        --force
done

echo "==> Done. Reload each running code-server window to load the"
echo "    new extensions. Run this on every host (silk and rayon)."
