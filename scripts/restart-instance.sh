#!/bin/bash
# Restart a specific workspace instance by ID or workspace path

INSTANCE_ID="$1"

if [ -z "$INSTANCE_ID" ]; then
  echo "Usage: $0 <instance-id-or-workspace-path>"
  exit 1
fi

# If argument looks like a path, compute SHA256
if [[ "$INSTANCE_ID" == /* ]]; then
  INSTANCE_ID=$(echo -n "$INSTANCE_ID" | sha256sum | cut -d' ' -f1)
  echo "Computed instance ID: $INSTANCE_ID"
fi

export XDG_RUNTIME_DIR=/run/user/$(id -u)

echo "Restarting code-server-workspace@${INSTANCE_ID}.service..."
systemctl --user restart "code-server-workspace@${INSTANCE_ID}.service"

echo "Waiting for service to stabilize..."
sleep 3

systemctl --user status "code-server-workspace@${INSTANCE_ID}.service"