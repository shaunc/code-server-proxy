# Docker Migration Guide

This guide covers migrating workspace instances from systemd mode to Docker mode for the code-server-proxy system.

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Building the Docker Image](#building-the-docker-image)
- [Enabling Docker Mode](#enabling-docker-mode)
- [Migration Process](#migration-process)
- [Verification](#verification)
- [Troubleshooting](#troubleshooting)
- [Rollback](#rollback)

## Overview

The code-server-proxy supports two backend modes:

- **systemd mode** (legacy): Uses systemd user services to manage code-server instances
- **Docker mode** (recommended): Uses Docker containers for complete namespace isolation

Docker mode provides:

- **Complete IPC namespace isolation** - Prevents terminal stealing between workspaces
- **Terminal persistence** - Terminals are reliably saved per-container
- **Gnome-keyring integration** - In-container keyring for VSCode extension secrets
- **Resource limits** - CPU and memory limits per workspace
- **Easy cleanup** - Remove a workspace by removing its container

## Prerequisites

### Docker Installation

**Required Docker version:** 20.10 or later

Install Docker:

```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install docker.io docker-compose

# Arch Linux
sudo pacman -S docker docker-compose
```

**Start Docker daemon:**

```bash
sudo systemctl start docker
sudo systemctl enable docker
```

**Add user to docker group** (required for non-root access):

```bash
sudo usermod -aG docker $USER
newgrp docker  # Apply group change immediately
```

**Verify Docker works without sudo:**

```bash
docker ps
docker info
```

### Node.js and Dependencies

The proxy requires Node.js and npm packages:

```bash
# Install dependencies if not already done
npm install
```

### Disk Space

The Docker image is approximately 1-2 GB. Ensure you have at least 5 GB free space for the image plus container volumes.

## Building the Docker Image

### Build Command

From the repository root:

```bash
docker build -t code-server-proxy:latest -f docker/code-server/Dockerfile docker/code-server/
```

This builds an image with:

- Base: LinuxServer.io code-server image
- gnome-keyring for VSCode extension secrets
- Init scripts for keyring setup and secrets sync
- s6-overlay for service supervision

### Verify Build

Check the image was created:

```bash
docker images code-server-proxy
```

Expected output:

```
REPOSITORY            TAG       IMAGE ID       CREATED         SIZE
code-server-proxy     latest    abc123...      2 minutes ago   1.8GB
```

### Build Options

**Custom image name:**

```bash
docker build -t my-code-server:v1 -f docker/code-server/Dockerfile docker/code-server/
```

**With build cache disabled:**

```bash
docker build --no-cache -t code-server-proxy:latest -f docker/code-server/Dockerfile docker/code-server/
```

## Enabling Docker Mode

### Environment Variable

Docker mode is controlled by the `USE_DOCKER` environment variable:

**Enable Docker mode:**

```bash
export USE_DOCKER=true
```

**Disable Docker mode (use systemd):**

```bash
export USE_DOCKER=false
# or
unset USE_DOCKER
```

### Start Proxy in Docker Mode

```bash
# Set Docker mode
export USE_DOCKER=true

# Start proxy (from repository root)
node src/proxy.js
```

The proxy will log:

```
Code-Server Proxy listening on 127.0.0.1:8083
Backend mode: Docker
Main instance port: 8100
Workspace instance ports: 8101-8199
Base directory: /home/user/.code-workspaces/instances
Docker connection verified
Shared extensions volume ready
```

### Running as systemd Service with Docker

Edit the systemd service file to enable Docker mode:

```bash
# Edit service
systemctl --user edit code-server-proxy.service
```

Add:

```ini
[Service]
Environment="USE_DOCKER=true"
```

Restart:

```bash
systemctl --user restart code-server-proxy.service
```

## Migration Process

### Quick Test Migration

Use the test script for a single workspace:

```bash
# Test migration of specific workspace
./scripts/test-docker-migration.sh /path/to/workspace.code-workspace
```

This script will:

1. Verify prerequisites
2. Build the Docker image
3. Stop any existing systemd service for the workspace
4. Create and start a Docker container
5. Verify gnome-keyring is running
6. Test HTTP connectivity
7. Show container details and logs

### Manual Migration Steps

For manual control over the migration:

**1. Build the image:**

```bash
docker build -t code-server-proxy:latest -f docker/code-server/Dockerfile docker/code-server/
```

**2. Stop existing systemd instances:**

```bash
# Find all running workspace instances
systemctl --user list-units 'code-server-workspace@*.service'

# Stop specific instance (replace INSTANCE_ID)
systemctl --user stop code-server-workspace@INSTANCE_ID.service
```

**3. Enable Docker mode and restart proxy:**

```bash
export USE_DOCKER=true
systemctl --user restart code-server-proxy.service
```

**4. Access workspace via proxy:**

```bash
# The proxy will automatically create Docker containers
# when you access workspace URLs
http://localhost:8083/?workspace=/path/to/workspace.code-workspace
```

### Migrating All Workspaces

**Find all workspace instances:**

```bash
# Check port registry for active workspaces
cat ~/.code-workspaces/port-registry.json | jq '.workspaces'
```

**Stop all systemd instances:**

```bash
# Stop all workspace services
systemctl --user stop 'code-server-workspace@*.service'

# Verify none are running
systemctl --user list-units 'code-server-workspace@*.service' --state=running
```

**Start proxy in Docker mode:**

```bash
export USE_DOCKER=true
systemctl --user restart code-server-proxy.service
```

Now when you access any workspace URL, the proxy will automatically create a Docker container for it.

## Verification

### Check Workspace is Running in Docker

**1. Access the workspace URL:**

```
http://localhost:8083/?workspace=/path/to/workspace.code-workspace
```

**2. Compute instance ID:**

```bash
WORKSPACE_PATH="/path/to/workspace.code-workspace"
INSTANCE_ID=$(echo -n "$WORKSPACE_PATH" | sha256sum | awk '{print $1}')
echo "Instance ID: $INSTANCE_ID"
```

**3. Check container exists and is running:**

```bash
docker ps --filter "name=code-server-${INSTANCE_ID}"
```

Expected output:

```
CONTAINER ID   IMAGE                        STATUS         PORTS                      NAMES
abc123...      code-server-proxy:latest     Up 5 minutes   127.0.0.1:8101->8443/tcp   code-server-abc123...
```

**4. Verify metadata shows Docker backend:**

```bash
cat ~/.code-workspaces/instances/$INSTANCE_ID/metadata.json | jq '.backend'
# Should output: "docker"
```

### Check gnome-keyring is Running

```bash
# Find container name
CONTAINER_NAME="code-server-${INSTANCE_ID}"

# Check if gnome-keyring process is running
docker exec $CONTAINER_NAME pgrep -f gnome-keyring-daemon

# Should output a process ID (e.g., 123)
```

### Verify Terminals Work

1. Open the workspace in browser
2. Open a new terminal (Ctrl+Shift+`)
3. Run a command: `echo "test"`
4. Reload the browser page
5. The terminal should still be present with history intact

### Check Container Logs

```bash
# View logs
docker logs code-server-${INSTANCE_ID}

# Follow logs in real-time
docker logs -f code-server-${INSTANCE_ID}
```

Look for:

- `[init-keyring] ✓ gnome-keyring setup complete`
- `[services.d] starting services`
- `code-server is running`

### Verify Resource Limits

```bash
docker inspect code-server-${INSTANCE_ID} --format '{{.HostConfig.Memory}}'
docker inspect code-server-${INSTANCE_ID} --format '{{.HostConfig.NanoCpus}}'
```

Default limits:

- Memory: 4294967296 (4GB)
- NanoCpus: 3000000000 (3.0 CPUs)

## Troubleshooting

### Container Fails to Start

**Check Docker daemon:**

```bash
docker info
```

**Check image exists:**

```bash
docker images code-server-proxy
```

**View container logs:**

```bash
docker logs code-server-${INSTANCE_ID}
```

**Common issues:**

- Missing Docker image → Rebuild with build command
- Port already in use → Check port registry and kill conflicting process
- Permission denied → Ensure user is in docker group

### gnome-keyring Not Running

**Check initialization logs:**

```bash
docker logs code-server-${INSTANCE_ID} | grep keyring
```

**Manual keyring check:**

```bash
docker exec code-server-${INSTANCE_ID} bash -c "pgrep -fa gnome-keyring"
```

**Restart container:**

```bash
docker restart code-server-${INSTANCE_ID}
```

### Port Not Accessible

**Check port binding:**

```bash
docker port code-server-${INSTANCE_ID}
```

**Test connection:**

```bash
curl -I http://127.0.0.1:8101/healthz
```

**Check proxy logs:**

```bash
journalctl --user -u code-server-proxy.service -f
```

### Workspace Mount Issues

**Verify workspace path exists:**

```bash
ls -la /path/to/workspace.code-workspace
```

**Check bind mount in container:**

```bash
docker inspect code-server-${INSTANCE_ID} --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
```

**Look for:**

```
/path/to/workspace.code-workspace -> /workspace
```

### Extensions Not Persisting

**Check shared extensions volume:**

```bash
docker volume ls | grep code-server-extensions
```

**Inspect volume:**

```bash
docker volume inspect code-server-extensions
```

**Verify mount point:**

```bash
docker exec code-server-${INSTANCE_ID} ls -la /config/extensions
```

### Performance Issues

**Check container resource usage:**

```bash
docker stats code-server-${INSTANCE_ID}
```

**Adjust limits via environment variables:**

```bash
# Before starting proxy
export DOCKER_MEMORY_LIMIT="8g"
export DOCKER_CPU_LIMIT="4.0"
```

### Container Won't Stop

**Force stop:**

```bash
docker stop -t 0 code-server-${INSTANCE_ID}
```

**Force remove:**

```bash
docker rm -f code-server-${INSTANCE_ID}
```

## Rollback

### Switch Back to systemd Mode

**1. Stop Docker proxy:**

```bash
systemctl --user stop code-server-proxy.service
```

**2. Stop all Docker containers:**

```bash
# List all code-server containers
docker ps -a --filter "label=app=code-server-proxy"

# Stop and remove all containers
docker rm -f $(docker ps -a --filter "label=app=code-server-proxy" -q)
```

**3. Disable Docker mode:**

```bash
# If using environment variable
unset USE_DOCKER

# If using systemd service, remove override
systemctl --user edit --full code-server-proxy.service
# Remove: Environment="USE_DOCKER=true"
```

**4. Start proxy in systemd mode:**

```bash
systemctl --user start code-server-proxy.service
```

**5. Verify systemd mode:**

```bash
journalctl --user -u code-server-proxy.service -n 20
# Look for: "Backend mode: systemd"
```

### Restart systemd Services

Workspace instances will be automatically started via systemd when accessed:

```bash
# Check existing systemd instances
systemctl --user list-units 'code-server-workspace@*.service'

# Manually start specific instance if needed
systemctl --user start code-server-workspace@INSTANCE_ID.service
```

### Cleanup Docker Resources

**Remove containers (keeps volumes):**

```bash
docker rm -f $(docker ps -a --filter "label=app=code-server-proxy" -q)
```

**Remove volumes (WARNING: deletes config and terminal history):**

```bash
# List volumes
docker volume ls | grep code-server

# Remove specific instance config volume
docker volume rm code-server-INSTANCE_ID-config

# Remove shared extensions (affects all instances)
docker volume rm code-server-extensions
```

**Remove Docker image:**

```bash
docker rmi code-server-proxy:latest
```

## Advanced Configuration

### Custom Docker Image

Set via environment variable:

```bash
export DOCKER_IMAGE="my-registry/code-server:custom"
```

### Custom Resource Limits

```bash
export DOCKER_MEMORY_LIMIT="8g"    # 8GB memory
export DOCKER_CPU_LIMIT="6.0"      # 6 CPU cores
```

### Host Secrets Path

Sync secrets from host to containers:

```bash
export HOST_SECRETS_PATH="/custom/path/to/secrets"
```

Default: `~/.local/share/code-server/User/globalStorage`

### Shared Extensions Volume

Extensions are shared across all containers via Docker volume `code-server-extensions`.

To use separate extensions per instance, modify `src/container-manager.js` to create per-instance extension volumes.

## See Also

- [Architecture Documentation](ARCHITECTURE.md)
- [Operations Guide](OPERATIONS.md)
- [Deployment Guide](DEPLOYMENT.md)
- [gnome-keyring Docker Guide](../tmp/issues/isolation/gnome-keyring-docker-guide.md)
- [Terminal Persistence Guide](../tmp/issues/isolation/terminal-stealing-guide-2.md)
