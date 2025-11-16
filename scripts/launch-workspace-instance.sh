#!/bin/bash
set -e

INSTANCE_NAME="$1"

if [[ -z "$INSTANCE_NAME" ]]; then
    echo "Error: Instance name required as argument"
    exit 1
fi

WORKSPACES_DIR="$HOME/.code-workspaces"
INSTANCE_DIR="$WORKSPACES_DIR/instances/$INSTANCE_NAME"
METADATA_FILE="$INSTANCE_DIR/metadata.json"
SHARED_DIR="$WORKSPACES_DIR/shared"

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

mkdir -p "$SHARED_DIR/extensions"
mkdir -p "$SHARED_DIR/User"

USER_DATA_DIR="$INSTANCE_DIR/data"
mkdir -p "$USER_DATA_DIR/User"

if [[ ! -L "$USER_DATA_DIR/extensions" ]]; then
    if [[ -d "$USER_DATA_DIR/extensions" ]] && [[ ! -L "$USER_DATA_DIR/extensions" ]]; then
        rm -rf "$USER_DATA_DIR/extensions"
    fi
    ln -sf "$SHARED_DIR/extensions" "$USER_DATA_DIR/extensions"
fi

if [[ ! -L "$USER_DATA_DIR/User/settings.json" ]]; then
    if [[ -f "$USER_DATA_DIR/User/settings.json" ]] && [[ ! -L "$USER_DATA_DIR/User/settings.json" ]]; then
        rm -f "$USER_DATA_DIR/User/settings.json"
    fi
    ln -sf "$SHARED_DIR/User/settings.json" "$USER_DATA_DIR/User/settings.json"
fi

if [[ ! -L "$USER_DATA_DIR/User/keybindings.json" ]]; then
    if [[ -f "$USER_DATA_DIR/User/keybindings.json" ]] && [[ ! -L "$USER_DATA_DIR/User/keybindings.json" ]]; then
        rm -f "$USER_DATA_DIR/User/keybindings.json"
    fi
    ln -sf "$SHARED_DIR/User/keybindings.json" "$USER_DATA_DIR/User/keybindings.json"
fi

# For bare mode (main instance), workspacePath is null - don't pass a path argument
if [[ -z "$WORKSPACE_PATH" ]] || [[ "$WORKSPACE_PATH" == "null" ]]; then
    exec code-server \
        --bind-addr "127.0.0.1:$PORT" \
        --user-data-dir "$USER_DATA_DIR"
else
    exec code-server \
        --bind-addr "127.0.0.1:$PORT" \
        --user-data-dir "$USER_DATA_DIR" \
        "$WORKSPACE_PATH"
fi