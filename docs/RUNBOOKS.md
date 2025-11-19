# Code-Server Proxy - Operational Runbooks

This document provides step-by-step procedures for common operational tasks with the code-server-proxy system, including Docker and systemd modes.

## Table of Contents

- [Workspace Migration](#workspace-migration)
- [Rollback Procedures](#rollback-procedures)
- [Troubleshooting](#troubleshooting)
- [Backup and Restore](#backup-and-restore)
- [Container Health Checks](#container-health-checks)
- [Idle Cleanup Management](#idle-cleanup-management)
- [Emergency Procedures](#emergency-procedures)

---

## Workspace Migration

### Migrating a Single Workspace to Docker

**When to use**: Migrating an existing systemd-based workspace to Docker mode.

**Prerequisites**:

- Docker installed and running
- Docker image built (`code-server-proxy:latest`)
- Proxy not in Docker mode yet (or can handle mixed mode)

**Procedure**:

1. **Build Docker image** (if not already built):

   ```bash
   docker build -t code-server-proxy:latest \
     -f docker/code-server/Dockerfile docker/code-server/
   ```

2. **Run migration script**:

   ```bash
   ./scripts/migrate-workspace-to-docker.sh /path/to/workspace
   ```

3. **Verify migration**:

   ```bash
   # Check container is running
   INSTANCE_ID=$(echo -n "/path/to/workspace" | sha256sum | awk '{print $1}')
   docker ps --filter "name=code-server-${INSTANCE_ID}"

   # Check gnome-keyring
   docker exec "code-server-${INSTANCE_ID}" pgrep -f gnome-keyring-daemon

   # Test access
   curl -I http://127.0.0.1:8083/?workspace=/path/to/workspace
   ```

**Expected results**:

- Container running with status "Up"
- gnome-keyring process ID displayed
- HTTP 200 or 302 response from proxy

**Rollback**: See [Rollback Single Workspace](#rollback-single-workspace)

### Migrating All Workspaces to Docker

**When to use**: Batch migration of all systemd workspaces to Docker mode.

**Prerequisites**:

- All prerequisites from single workspace migration
- Backup of port registry completed
- No active editing sessions (save all work)

**Procedure**:

1. **Dry run** (recommended):

   ```bash
   ./scripts/migrate-all-to-docker.sh --dry-run
   ```

   Review the list of workspaces that will be migrated.

2. **Run migration**:

   ```bash
   ./scripts/migrate-all-to-docker.sh
   ```

   Confirm when prompted: `yes`

3. **Monitor progress**:
   - Script shows progress for each workspace
   - Watch for any error messages
   - Migration report saved to `~/.code-workspaces/migration-report-*.json`

4. **Enable Docker mode in proxy**:

   ```bash
   # Edit systemd service
   systemctl --user edit code-server-proxy.service
   ```

   Add:

   ```ini
   [Service]
   Environment="USE_DOCKER=true"
   ```

   Restart proxy:

   ```bash
   systemctl --user restart code-server-proxy.service
   ```

5. **Verify all containers**:
   ```bash
   docker ps --filter "label=app=code-server-proxy"
   ```

**Expected results**:

- All workspaces shown as successful in migration report
- Containers running for each workspace
- Proxy logs show "Backend mode: Docker"

**Rollback**: See [Rollback All Workspaces](#rollback-all-workspaces)

---

## Rollback Procedures

### Rollback Single Workspace

**When to use**: Single workspace migration failed or needs to revert.

**Procedure**:

1. **Stop and remove Docker container**:

   ```bash
   INSTANCE_ID=$(echo -n "/path/to/workspace" | sha256sum | awk '{print $1}')
   docker stop "code-server-${INSTANCE_ID}"
   docker rm "code-server-${INSTANCE_ID}"
   ```

2. **Restore metadata** (if backup exists):

   ```bash
   METADATA_FILE="$HOME/.code-workspaces/instances/${INSTANCE_ID}/metadata.json"
   if [ -f "${METADATA_FILE}.backup" ]; then
     mv "${METADATA_FILE}.backup" "${METADATA_FILE}"
   fi
   ```

3. **Restore systemd data** (if archived):

   ```bash
   BACKUP_DIR="$HOME/.code-workspaces/instances/${INSTANCE_ID}/systemd-backup-*"
   if [ -d "$BACKUP_DIR" ]; then
     mv "${BACKUP_DIR}/user-data-dir" \
        "$HOME/.code-workspaces/instances/${INSTANCE_ID}/"
   fi
   ```

4. **Start systemd service**:

   ```bash
   systemctl --user start "code-server-workspace@${INSTANCE_ID}.service"
   ```

5. **Verify**:
   ```bash
   systemctl --user status "code-server-workspace@${INSTANCE_ID}.service"
   ```

### Rollback All Workspaces

**When to use**: Complete Docker migration needs to be reverted.

**Procedure**:

1. **Stop proxy**:

   ```bash
   systemctl --user stop code-server-proxy.service
   ```

2. **Stop all Docker containers**:

   ```bash
   docker ps -a --filter "label=app=code-server-proxy" -q | xargs docker rm -f
   ```

3. **Disable Docker mode**:

   ```bash
   systemctl --user edit code-server-proxy.service
   ```

   Remove line:

   ```ini
   Environment="USE_DOCKER=true"
   ```

4. **Restore registry** (if backup exists):

   ```bash
   BACKUP_FILE=$(ls -t ~/.code-workspaces/port-registry.json.backup-* | head -1)
   if [ -n "$BACKUP_FILE" ]; then
     cp "$BACKUP_FILE" ~/.code-workspaces/port-registry.json
   fi
   ```

5. **Start proxy in systemd mode**:

   ```bash
   systemctl --user daemon-reload
   systemctl --user start code-server-proxy.service
   ```

6. **Verify proxy mode**:

   ```bash
   journalctl --user -u code-server-proxy.service -n 20 | grep "Backend mode"
   # Should show: "Backend mode: systemd"
   ```

7. **Start systemd instances**:
   ```bash
   # Instances will auto-start on access, or manually:
   systemctl --user list-units 'code-server-workspace@*' --all | \
     grep -v main | awk '{print $1}' | \
     xargs -I {} systemctl --user start {}
   ```

---

## Troubleshooting

### Container Won't Start

**Symptoms**:

- `docker ps` doesn't show container
- Migration script fails with "Container did not become ready"
- 502 Bad Gateway when accessing workspace

**Diagnosis**:

1. **Check Docker daemon**:

   ```bash
   docker info
   ```

   If error: Ensure Docker daemon is running:

   ```bash
   sudo systemctl start docker
   ```

2. **Check container logs**:

   ```bash
   INSTANCE_ID=$(echo -n "/path/to/workspace" | sha256sum | awk '{print $1}')
   docker logs "code-server-${INSTANCE_ID}"
   ```

3. **Check for port conflicts**:

   ```bash
   # Find port from registry
   PORT=$(jq -r ".workspaces[\"/path/to/workspace\"].currentPort" \
     ~/.code-workspaces/port-registry.json)

   # Check if port is in use
   netstat -tln | grep ":${PORT}"
   ```

**Solutions**:

- **Image not found**: Build Docker image

  ```bash
  docker build -t code-server-proxy:latest \
    -f docker/code-server/Dockerfile docker/code-server/
  ```

- **Port conflict**: Container using wrong port or port already allocated

  ```bash
  # Remove container and recreate
  docker rm -f "code-server-${INSTANCE_ID}"
  # Re-run migration script
  ```

- **Volume issues**: Permissions or volume corruption
  ```bash
  # Remove volumes and recreate
  docker volume rm "code-server-${INSTANCE_ID}-config"
  # Re-run migration script
  ```

### gnome-keyring Not Running

**Symptoms**:

- VSCode extensions can't store secrets
- Authentication fails for Git, GitHub, etc.
- Container logs show keyring errors

**Diagnosis**:

```bash
INSTANCE_ID=$(echo -n "/path/to/workspace" | sha256sum | awk '{print $1}')
docker exec "code-server-${INSTANCE_ID}" pgrep -f gnome-keyring-daemon
```

If no output: keyring not running.

**Solutions**:

1. **Check initialization logs**:

   ```bash
   docker logs "code-server-${INSTANCE_ID}" | grep keyring
   ```

2. **Verify IPC_LOCK capability**:

   ```bash
   docker inspect "code-server-${INSTANCE_ID}" \
     --format '{{.HostConfig.CapAdd}}'
   # Should include IPC_LOCK
   ```

3. **Restart container**:

   ```bash
   docker restart "code-server-${INSTANCE_ID}"

   # Wait 10 seconds
   sleep 10

   # Verify keyring started
   docker exec "code-server-${INSTANCE_ID}" pgrep -f gnome-keyring-daemon
   ```

4. **Manual keyring start** (if restart doesn't work):

   ```bash
   docker exec -it "code-server-${INSTANCE_ID}" bash

   # Inside container:
   export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/dbus/system_bus_socket
   /usr/bin/gnome-keyring-daemon --start --foreground --components=secrets &
   ```

### Proxy Won't Switch to Docker Mode

**Symptoms**:

- `USE_DOCKER=true` set but proxy still uses systemd
- Logs show "Backend mode: systemd"
- Containers created but not used

**Diagnosis**:

1. **Check environment variable**:

   ```bash
   systemctl --user show code-server-proxy.service | grep USE_DOCKER
   ```

2. **Check proxy logs**:
   ```bash
   journalctl --user -u code-server-proxy.service -n 50 | grep "Backend mode"
   ```

**Solutions**:

1. **Verify environment in service file**:

   ```bash
   systemctl --user cat code-server-proxy.service | grep USE_DOCKER
   ```

   Should show:

   ```ini
   Environment="USE_DOCKER=true"
   ```

2. **Update service file**:

   ```bash
   systemctl --user edit code-server-proxy.service
   ```

   Add or verify:

   ```ini
   [Service]
   Environment="USE_DOCKER=true"
   ```

3. **Reload and restart**:

   ```bash
   systemctl --user daemon-reload
   systemctl --user restart code-server-proxy.service
   ```

4. **Verify**:
   ```bash
   journalctl --user -u code-server-proxy.service -n 5 | grep "Backend mode"
   # Should show: "Backend mode: Docker"
   ```

### Idle Cleanup Not Working (Docker Mode)

**Symptoms**:

- Old containers not being stopped/removed
- `docker ps -a` shows many old containers
- Disk space growing

**Diagnosis**:

1. **Check idle monitor mode detection**:

   ```bash
   # Run manually with debug
   ./scripts/workspace-idle-monitor.sh
   ```

   Should show: "Detected mode: docker"

2. **Check for running containers**:

   ```bash
   docker ps --filter "label=app=code-server-proxy"
   ```

3. **Check container ages**:
   ```bash
   docker ps -a --filter "label=app=code-server-proxy" \
     --format "{{.Names}}: {{.Status}}"
   ```

**Solutions**:

1. **Verify idle monitor script has Docker support**:

   ```bash
   grep -A 10 "detect_mode" ./scripts/workspace-idle-monitor.sh
   # Should have Docker detection logic
   ```

2. **Run idle monitor manually**:

   ```bash
   # Test with short threshold
   IDLE_THRESHOLD_DAYS=0 ./scripts/workspace-idle-monitor.sh
   ```

3. **Check timer is active**:

   ```bash
   systemctl --user status workspace-idle-monitor.timer
   systemctl --user list-timers workspace-idle-monitor.timer
   ```

4. **Force manual cleanup**:
   ```bash
   # Using Node.js
   node -e "
     const cm = require('./src/container-manager');
     cm.stopIdleContainers(3).then(console.log);
     cm.cleanupIdleContainers(7).then(console.log);
   "
   ```

---

## Backup and Restore

### Backup Docker Volumes

**When to use**: Before migration, before updates, periodic backups.

**Procedure**:

1. **Backup all volumes**:

   ```bash
   BACKUP_DIR="$HOME/.code-workspaces/backups/$(date +%Y%m%d-%H%M%S)"
   mkdir -p "$BACKUP_DIR"

   # List all config volumes
   docker volume ls --filter "label=type=instance-config" --format "{{.Name}}" | \
   while read vol; do
     echo "Backing up $vol..."
     docker run --rm \
       -v "$vol:/data:ro" \
       -v "$BACKUP_DIR:/backup" \
       alpine tar czf "/backup/${vol}.tar.gz" -C /data .
   done
   ```

2. **Verify backups**:
   ```bash
   ls -lh "$BACKUP_DIR"
   ```

**Expected results**:

- `.tar.gz` file for each volume
- File sizes reasonable (10MB-500MB typically)

### Restore Docker Volume

**When to use**: Recovering from data loss, restoring after failed migration.

**Procedure**:

1. **Stop container** (if running):

   ```bash
   INSTANCE_ID="<instance-id>"
   docker stop "code-server-${INSTANCE_ID}"
   ```

2. **Remove existing volume**:

   ```bash
   docker volume rm "code-server-${INSTANCE_ID}-config"
   ```

3. **Restore volume**:

   ```bash
   BACKUP_FILE="<path-to-backup>.tar.gz"
   INSTANCE_ID="<instance-id>"

   # Using Node.js
   node -e "
     const cm = require('./src/container-manager');
     cm.restoreVolume('${INSTANCE_ID}', '${BACKUP_FILE}')
       .then(() => console.log('Restore complete'))
       .catch(err => console.error('Restore failed:', err.message));
   "
   ```

4. **Restart container**:

   ```bash
   docker start "code-server-${INSTANCE_ID}"
   ```

5. **Verify**:
   ```bash
   docker exec "code-server-${INSTANCE_ID}" ls -la /config
   ```

### Backup Complete System State

**When to use**: Before major changes, weekly backups.

**Procedure**:

```bash
#!/bin/bash
BACKUP_DIR="$HOME/.code-workspaces/system-backup-$(date +%Y%m%d)"
mkdir -p "$BACKUP_DIR"

# 1. Backup port registry
cp ~/.code-workspaces/port-registry.json "$BACKUP_DIR/"

# 2. Backup instance metadata
cp -r ~/.code-workspaces/instances/*/metadata.json "$BACKUP_DIR/metadata/" 2>/dev/null || true

# 3. Backup Docker volumes (if using Docker)
if [ -n "$(docker volume ls -q --filter 'label=app=code-server-proxy')" ]; then
  mkdir -p "$BACKUP_DIR/volumes"
  docker volume ls --filter "label=app=code-server-proxy" --format "{{.Name}}" | \
  while read vol; do
    docker run --rm \
      -v "$vol:/data:ro" \
      -v "$BACKUP_DIR/volumes:/backup" \
      alpine tar czf "/backup/${vol}.tar.gz" -C /data .
  done
fi

# 4. Backup systemd configuration
mkdir -p "$BACKUP_DIR/systemd"
cp ~/.config/systemd/user/code-server-*.service "$BACKUP_DIR/systemd/" 2>/dev/null || true
cp ~/.config/systemd/user/workspace-idle-monitor.* "$BACKUP_DIR/systemd/" 2>/dev/null || true

echo "Backup complete: $BACKUP_DIR"
du -sh "$BACKUP_DIR"
```

---

## Container Health Checks

### Check Container Health

**Procedure**:

```bash
INSTANCE_ID="<instance-id>"

echo "=== Container Status ==="
docker ps --filter "name=code-server-${INSTANCE_ID}"

echo -e "\n=== Container Health ==="
docker inspect "code-server-${INSTANCE_ID}" \
  --format 'Status: {{.State.Status}}
Health: {{if .State.Health}}{{.State.Health.Status}}{{else}}N/A{{end}}
Started: {{.State.StartedAt}}
Memory: {{.HostConfig.Memory}}
CPU: {{.HostConfig.NanoCpus}}'

echo -e "\n=== Process Check ==="
docker exec "code-server-${INSTANCE_ID}" ps aux | grep -E "code-server|gnome-keyring"

echo -e "\n=== Port Check ==="
docker port "code-server-${INSTANCE_ID}"

echo -e "\n=== Volume Mounts ==="
docker inspect "code-server-${INSTANCE_ID}" \
  --format '{{range .Mounts}}{{.Type}}: {{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'

echo -e "\n=== Recent Logs ==="
docker logs "code-server-${INSTANCE_ID}" --tail 20
```

### Monitor Resource Usage

**Procedure**:

```bash
# Live stats for all containers
docker stats --no-stream --filter "label=app=code-server-proxy"

# Or specific container
INSTANCE_ID="<instance-id>"
docker stats --no-stream "code-server-${INSTANCE_ID}"
```

**Interpreting results**:

- **MEM USAGE**: Should be under MemoryMax limit (default 4GB)
- **CPU %**: Spikes normal, sustained >300% indicates limit reached
- **NET I/O**: Varies, usually low
- **BLOCK I/O**: High during file operations, usually moderate

---

## Idle Cleanup Management

### Manually Trigger Cleanup

**Docker mode**:

```bash
# Stop idle containers (>3 days)
node -e "
  const cm = require('./src/container-manager');
  cm.stopIdleContainers(3).then(stopped => {
    console.log('Stopped containers:', stopped);
  });
"

# Cleanup stopped containers (>7 days)
node -e "
  const cm = require('./src/container-manager');
  cm.cleanupIdleContainers(7).then(cleaned => {
    console.log('Cleaned up containers:', cleaned);
    console.log('Backups created in ~/.code-workspaces/volumes/');
  });
"
```

**Systemd mode**:

```bash
./scripts/workspace-idle-monitor.sh
```

### Whitelist Containers from Cleanup

**Procedure**:

1. **Edit systemd service**:

   ```bash
   systemctl --user edit workspace-idle-monitor.service
   ```

2. **Add whitelist environment variable**:

   ```ini
   [Service]
   Environment="IDLE_WHITELIST=instance-id-1,instance-id-2"
   ```

3. **Reload and verify**:
   ```bash
   systemctl --user daemon-reload
   systemctl --user show workspace-idle-monitor.service | grep IDLE_WHITELIST
   ```

**For Docker mode**, also set in proxy service:

```bash
systemctl --user edit code-server-proxy.service
```

Add:

```ini
[Service]
Environment="IDLE_WHITELIST=instance-id-1,instance-id-2"
```

### Restore Archived Container

**Procedure**:

1. **Find archive**:

   ```bash
   ls -lh ~/.code-workspaces/volumes/*.tar.gz
   ```

2. **Restore volume**:

   ```bash
   INSTANCE_ID="<instance-id>"
   BACKUP_FILE="<path-to-backup>.tar.gz"

   node -e "
     const cm = require('./src/container-manager');
     cm.restoreVolume('${INSTANCE_ID}', '${BACKUP_FILE}')
       .then(() => console.log('Volume restored'))
       .catch(console.error);
   "
   ```

3. **Access workspace**:
   ```bash
   # Container will be created automatically on access
   # http://localhost:8083/?workspace=/path/to/workspace
   ```

---

## Emergency Procedures

### Complete System Reset (Docker Mode)

**When to use**: System completely broken, need fresh start.

**⚠️ WARNING**: This deletes all containers and volumes!

**Procedure**:

1. **Stop proxy**:

   ```bash
   systemctl --user stop code-server-proxy.service
   ```

2. **Backup critical data** (if possible):

   ```bash
   cp -r ~/.code-workspaces/port-registry.json \
     ~/emergency-backup-registry.json
   ```

3. **Remove all containers and volumes**:

   ```bash
   # Stop and remove all containers
   docker ps -a --filter "label=app=code-server-proxy" -q | xargs docker rm -f

   # Remove all volumes
   docker volume ls --filter "label=app=code-server-proxy" -q | xargs docker volume rm
   ```

4. **Clean instance directories**:

   ```bash
   rm -rf ~/.code-workspaces/instances/*
   ```

5. **Rebuild Docker image**:

   ```bash
   docker build -t code-server-proxy:latest \
     -f docker/code-server/Dockerfile docker/code-server/
   ```

6. **Restart proxy**:

   ```bash
   systemctl --user start code-server-proxy.service
   ```

7. **Access workspaces** - they will be recreated fresh

### Emergency Rollback to Systemd

**When to use**: Docker mode completely failing, need to return to working state immediately.

**Procedure**:

1. **Follow [Rollback All Workspaces](#rollback-all-workspaces)**

2. **If that fails**, manual recovery:

   ```bash
   # Stop proxy
   systemctl --user stop code-server-proxy.service

   # Force remove Docker environment
   unset USE_DOCKER
   systemctl --user edit code-server-proxy.service
   # Remove USE_DOCKER line

   # Kill all Docker containers
   docker rm -f $(docker ps -a --filter "label=app=code-server-proxy" -q)

   # Restart in systemd mode
   systemctl --user daemon-reload
   systemctl --user start code-server-proxy.service

   # Verify
   journalctl --user -u code-server-proxy.service -n 10
   ```

3. **Start workspace instances manually**:
   ```bash
   systemctl --user list-units 'code-server-workspace@*' --all --no-legend | \
     awk '{print $1}' | \
     xargs -I {} systemctl --user start {}
   ```

---

## Quick Reference

### Common Docker Commands

```bash
# List all code-server containers
docker ps -a --filter "label=app=code-server-proxy"

# View container logs
docker logs code-server-<instance-id> -f

# Execute command in container
docker exec code-server-<instance-id> <command>

# Stop container
docker stop code-server-<instance-id>

# Remove container
docker rm -f code-server-<instance-id>

# List volumes
docker volume ls --filter "label=app=code-server-proxy"

# Check container resource usage
docker stats --no-stream code-server-<instance-id>
```

### Common Node.js Operations

```bash
# Stop idle containers
node -e "require('./src/container-manager').stopIdleContainers(3).then(console.log)"

# Cleanup old containers
node -e "require('./src/container-manager').cleanupIdleContainers(7).then(console.log)"

# Check container status
node -e "require('./src/container-manager').isContainerRunning('<id>').then(console.log)"

# Backup volume
node -e "require('./src/container-manager').backupVolume('<id>', '/path/backup.tar.gz').then(console.log)"
```

### Environment Variables Reference

| Variable                 | Values              | Description                    |
| ------------------------ | ------------------- | ------------------------------ |
| `USE_DOCKER`             | `true`/`false`      | Enable Docker mode             |
| `DOCKER_IMAGE`           | Image name          | Docker image to use            |
| `DOCKER_MEMORY_LIMIT`    | e.g., `4g`          | Memory limit per container     |
| `DOCKER_CPU_LIMIT`       | e.g., `3.0`         | CPU cores per container        |
| `IDLE_THRESHOLD_DAYS`    | Number              | Days before stopping container |
| `IDLE_GRACE_PERIOD_DAYS` | Number              | Days before removing container |
| `IDLE_WHITELIST`         | Comma-separated IDs | Never cleanup these instances  |

---

**Document Version**: 1.0  
**Last Updated**: 2024-11-18  
**Compatibility**: code-server-proxy with Docker support
