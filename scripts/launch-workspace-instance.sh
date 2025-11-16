#!/bin/bash
set -e

INSTANCE_NAME="$1"

if [[ -z "$INSTANCE_NAME" ]]; then
    echo "Error: Instance name required as argument"
    exit 1
fi

INSTANCE_DIR="$HOME/.code-workspaces/instances/$INSTANCE_NAME"
METADATA_FILE="$INSTANCE_DIR/metadata.json"

if [[ ! -f "$METADATA_FILE" ]]; then
    echo "Error: metadata.json not found at $METADATA_FILE"
    exit 1
fi

if command -v jq &> /dev/null; then
    PORT=$(jq -r '.port' "$METADATA_FILE")
    WORKSPACE_PATH=$(jq -r '.workspacePath' "$METADATA_FILE")
else
    PORT=$(grep -oP '"port":\s*\K\d+' "$METADATA_FILE")
    WORKSPACE_PATH=$(grep -oP '"workspacePath":\s*"\K[^"]+' "$METADATA_FILE")
fi

if [[ -z "$PORT" ]]; then
    echo "Error: Failed to parse port from metadata.json"
    exit 1
fi

# For bare mode (main instance), workspacePath is null - don't pass a path argument
if [[ -z "$WORKSPACE_PATH" ]] || [[ "$WORKSPACE_PATH" == "null" ]]; then
    exec code-server \
        --bind-addr "127.0.0.1:$PORT" \
        --user-data-dir "$INSTANCE_DIR/data" \
        --extensions-dir "$INSTANCE_DIR/extensions"
else
    exec code-server \
        --bind-addr "127.0.0.1:$PORT" \
        --user-data-dir "$INSTANCE_DIR/data" \
        --extensions-dir "$INSTANCE_DIR/extensions" \
        "$WORKSPACE_PATH"
fi