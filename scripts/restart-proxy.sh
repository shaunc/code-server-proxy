#!/bin/bash
# Restart the proxy using systemd

export XDG_RUNTIME_DIR=/run/user/$(id -u)

echo "=== Stopping any running proxy processes ==="
pkill -f "node.*proxy.js" || echo "No proxy processes found"

echo ""
echo "=== Reloading systemd user daemon ==="
systemctl --user daemon-reload

echo ""
echo "=== Enabling proxy service ==="
systemctl --user enable code-server-proxy.service

echo ""
echo "=== Starting proxy service ==="
systemctl --user restart code-server-proxy.service

echo ""
echo "=== Checking proxy service status ==="
systemctl --user status code-server-proxy.service --no-pager

echo ""
echo "=== Proxy should now be running on port 8083 ==="
echo "Check with: ss -tlnp | grep 8083"