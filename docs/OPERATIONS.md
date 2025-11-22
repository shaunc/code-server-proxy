# Code-Server Workspace Isolation Proxy - Operations Guide

## Overview

This guide covers daily operations, monitoring, and maintenance of the code-server workspace isolation proxy system.

## Daily Operations

### Accessing the Proxy

The proxy listens on `http://127.0.0.1:8083` and provides three access modes:

#### 1. Bare Mode (Empty Window)

Open code-server without any workspace or folder:

```
http://127.0.0.1:8083/?ew=true
```

Use cases:

- Quick scratch workspace
- Testing extensions
- Temporary editing without workspace context

#### 2. Folder Mode

Open a specific folder:

```
http://127.0.0.1:8083/?folder=/absolute/path/to/folder
```

Examples:

```
http://127.0.0.1:8083/?folder=/home/user/projects/my-app
http://127.0.0.1:8083/?folder=/home/user/Documents/notes
```

**Important**: Path must be absolute (starting with `/`).

#### 3. Workspace Mode

Open a VSCode workspace file:

```
http://127.0.0.1:8083/?workspace=/absolute/path/to/file.code-workspace
```

Example:

```
http://127.0.0.1:8083/?workspace=/home/user/projects/monorepo.code-workspace
```

**Important**: Path must be absolute and point to a `.code-workspace` file.

#### 4. Default Mode

Accessing without parameters opens the main instance:

```
http://127.0.0.1:8083/
```

This is equivalent to bare mode.

### Understanding Instance Routing

Each workspace/folder gets its own isolated code-server instance:

- **Same folder/workspace** → Always routes to the same instance
- **Different folders/workspaces** → Different isolated instances
- **Workspace vs folder** → Same path gets different instances for workspace vs folder mode

Example:

```
# These all route to different instances:
?folder=/home/user/project                    → Instance A (port 8142)
?workspace=/home/user/project.code-workspace  → Instance B (port 8167)
?folder=/home/user/other-project              → Instance C (port 8123)

# These route to the same instance:
?folder=/home/user/project                    → Instance A (port 8142)
?folder=/home/user/project                    → Instance A (port 8142)
```

### Container Startup Experience

When you open a workspace or folder that doesn't have a running container, the proxy automatically launches it in the background and shows a waiting page.

**What you'll see:**

1. **Waiting Page**: A styled page with:
   - Workspace path being prepared
   - Loading spinner and progress bar
   - Elapsed time counter
   - Automatic refresh every 2 seconds

2. **Automatic Container Launch**: The container starts in the background without blocking your browser

3. **Automatic Redirect**: Once the container is ready (typically 10-15 seconds), the next refresh loads code-server

**Technical Details:**

- Initial HTTP request returns waiting page immediately
- Container launches asynchronously (non-blocking)
- Page auto-refreshes every 2 seconds via meta-refresh
- Resource requests (CSS, JS, images) block and wait for backend
- WebSocket connections retry automatically when backend is ready

**No Action Required**: Just wait for the automatic refresh. You don't need to manually refresh your browser.

**Typical Startup Times:**

- First launch (new container): 10-15 seconds
- Restart (existing container): 5-8 seconds
- Resume (container already running): Instant

### Checking System Status

#### Proxy Status

Check if the proxy is running:

```bash
systemctl --user status code-server-proxy.service
```

Expected output when healthy:

```
● code-server-proxy.service - Code-Server Workspace Isolation Proxy
     Loaded: loaded (/home/user/.config/systemd/user/code-server-proxy.service; enabled)
     Active: active (running) since Sat 2024-11-16 10:30:00 EST; 2h 15min ago
```

Quick check:

```bash
systemctl --user is-active code-server-proxy.service
# Should output: active
```

#### List Running Instances

Show all running code-server instances:

```bash
systemctl --user list-units 'code-server-workspace@*' --all
```

Example output:

```
UNIT                                          LOAD   ACTIVE SUB     DESCRIPTION
code-server-workspace@main.service            loaded active running Code-Server Workspace Instance - main
code-server-workspace@workspace-abc123def456...service loaded active running Code-Server Workspace Instance - workspace-abc123def456...
code-server-workspace@workspace-789abc012def...service loaded active running Code-Server Workspace Instance - workspace-789abc012def...
```

Count running instances:

```bash
systemctl --user list-units 'code-server-workspace@*' --state=running | grep -c 'code-server-workspace'
```

### Viewing Logs

#### Proxy Logs

View live proxy logs:

```bash
journalctl --user -u code-server-proxy.service -f
```

View recent proxy logs:

```bash
journalctl --user -u code-server-proxy.service -n 100
```

View logs since a specific time:

```bash
journalctl --user -u code-server-proxy.service --since "1 hour ago"
journalctl --user -u code-server-proxy.service --since "2024-11-16 10:00:00"
```

#### Instance Logs

Each instance writes logs to its directory:

```bash
# List all instance log directories
ls -la ~/.code-workspaces/instances/*/logs/

# View specific instance stdout
tail -f ~/.code-workspaces/instances/workspace-abc123def456.../logs/stdout.log

# View specific instance stderr
tail -f ~/.code-workspaces/instances/workspace-abc123def456.../logs/stderr.log
```

Or via journalctl:

```bash
# View specific instance logs
journalctl --user -u code-server-workspace@workspace-abc123def456...service -f

# View all instance logs together
journalctl --user -u 'code-server-workspace@*' -f
```

#### Idle Monitor Logs

View cleanup activity:

```bash
journalctl --user -u workspace-idle-monitor.service -n 50
```

View last cleanup run:

```bash
journalctl --user -u workspace-idle-monitor.service --since today
```

## Monitoring

### Instance Directory Structure

View all instances:

```bash
ls -la ~/.code-workspaces/instances/
```

Check instance details:

```bash
# View instance metadata
cat ~/.code-workspaces/instances/workspace-abc123def456.../metadata.json

# Check last access time
cat ~/.code-workspaces/instances/workspace-abc123def456.../last-access

# View instance size
du -sh ~/.code-workspaces/instances/workspace-abc123def456...
```

### Instance Metadata

Each instance has a `metadata.json` file:

```bash
cat ~/.code-workspaces/instances/workspace-abc123def456.../metadata.json
```

Example content:

```json
{
  "workspacePath": "/home/user/projects/my-app",
  "port": 8142,
  "created": "2024-11-16T15:30:00.000Z",
  "instanceId": "workspace-abc123def456..."
}
```

Fields:

- `workspacePath`: The workspace or folder path (null for main instance)
- `port`: Assigned port number
- `created`: ISO timestamp when instance was created
- `instanceId`: Instance identifier (full SHA256 hash)

### Resource Usage

Check memory usage for all instances:

```bash
systemctl --user status 'code-server-workspace@*' | grep Memory
```

Detailed resource usage:

```bash
systemd-cgtop --user
# Press 'q' to quit
```

Check specific instance resources:

```bash
systemctl --user show code-server-workspace@workspace-abc123def456...service \
  --property=MemoryCurrent,CPUUsageNSec
```

### Port Usage

Check which ports are in use:

```bash
# List all listening ports in range
netstat -tln | grep -E ':(808[3-9]|809[0-9]|81[0-9]{2})'

# Or using ss
ss -tln | grep -E ':(808[3-9]|809[0-9]|81[0-9]{2})'
```

Check specific port:

```bash
netstat -tln | grep :8142
```

### Disk Space

Check total space used by all instances:

```bash
du -sh ~/.code-workspaces/instances/
```

Break down by instance:

```bash
du -sh ~/.code-workspaces/instances/*/ | sort -h
```

Check archive space:

```bash
du -sh ~/.code-workspaces/archives/
ls -lh ~/.code-workspaces/archives/
```

## Instance Management

### Automatic Instance Creation

Instances are created automatically when you access a new workspace or folder:

1. Access URL with `?workspace=...` or `?folder=...`
2. Proxy computes instance name and port from path hash
3. If instance directory doesn't exist, proxy creates it
4. If instance isn't running, proxy launches it via systemd
5. Proxy waits up to 30 seconds for instance to be ready
6. Request is proxied to the instance

No manual intervention needed for normal operation.

### Manual Instance Management

#### Start an Instance

```bash
systemctl --user start code-server-workspace@workspace-abc123def456...service
```

#### Stop an Instance

```bash
systemctl --user stop code-server-workspace@workspace-abc123def456...service
```

#### Restart an Instance

```bash
systemctl --user restart code-server-workspace@workspace-abc123def456...service
# Or use helper script (can accept workspace path OR instance ID):
scripts/restart-instance.sh /path/to/workspace
# Or:
scripts/restart-instance.sh workspace-abc123def456...
```

#### Check Instance Status

```bash
systemctl --user status code-server-workspace@workspace-abc123def456...service
```

#### View Instance Service File

The template service is used for all instances:

```bash
cat ~/.config/systemd/user/code-server-workspace@.service
```

### Finding Instance Names

To manage a specific workspace, you need its instance name. You can find it:

#### From Instance Directory

```bash
ls ~/.code-workspaces/instances/
```

Output shows instance names:

```
main
workspace-abc123def456...
workspace-789abc012def...
```

#### From Metadata

```bash
# Find instance for specific path
grep -l "/home/user/projects/my-app" ~/.code-workspaces/instances/*/metadata.json
# Output: /home/user/.code-workspaces/instances/workspace-abc123def456.../metadata.json
```

#### Compute Hash (Advanced)

If you know the path, compute the instance name:

```bash
# Compute instance ID from path (full hash)
echo -n "/home/user/projects/my-app" | sha256sum
# Output: abc123def456... (64 characters)
# Instance ID: workspace-abc123def456...
```

## Lifecycle Management

### Idle Monitoring

The system automatically monitors and cleans up idle workspace instances.

#### How It Works

1. **Timer runs daily** (configured in workspace-idle-monitor.timer)
2. **Checks each instance** (except main) for last access time
3. **If idle > 3 days**:
   - Stops the systemd service
   - Archives the instance directory to `.tar.gz`
   - Removes the instance directory
4. **Main instance is never archived**

#### Last Access Tracking

Last access time is updated on every request to an instance:

- HTTP requests update `~/.code-workspaces/instances/<name>/last-access`
- WebSocket connections also update the timestamp
- File contains ISO 8601 timestamp: `2024-11-16T15:30:00.000Z`

Check when an instance was last accessed:

```bash
cat ~/.code-workspaces/instances/workspace-abc123def456.../last-access
```

#### Archive Location

Archives are stored in `~/.code-workspaces/archives/`:

```bash
ls -lh ~/.code-workspaces/archives/
```

Example archives:

```
workspace-abc123def456...-20241116-103000.tar.gz
workspace-789abc012def...-20241115-083000.tar.gz
```

Archive naming: `<instance-name>-<YYYYMMDD>-<HHMMSS>.tar.gz`

### Restoring Archived Instances

To restore an archived instance:

```bash
# Extract archive
cd ~/.code-workspaces/instances/
tar -xzf ~/.code-workspaces/archives/workspace-abc123def456...-20241116-103000.tar.gz

# The instance will automatically start on next access via proxy
```

Or restore and start immediately:

```bash
# Extract archive
cd ~/.code-workspaces/instances/
tar -xzf ~/.code-workspaces/archives/workspace-abc123def456...-20241116-103000.tar.gz

# Start instance
systemctl --user start code-server-workspace@workspace-abc123def456...service
```

### Manual Cleanup

To manually clean up an instance before it becomes idle:

```bash
# Stop instance
systemctl --user stop code-server-workspace@workspace-abc123def456...service

# Archive it (optional)
cd ~/.code-workspaces
tar -czf archives/workspace-abc123def456...-manual-$(date +%Y%m%d-%H%M%S).tar.gz \
  -C instances workspace-abc123def456...

# Remove instance directory
rm -rf instances/workspace-abc123def456...
```

### Cleaning Old Archives

Archives accumulate over time. Clean old archives periodically:

```bash
# List archives older than 30 days
find ~/.code-workspaces/archives/ -name "*.tar.gz" -mtime +30

# Remove archives older than 30 days
find ~/.code-workspaces/archives/ -name "*.tar.gz" -mtime +30 -delete

# Or remove all archives (careful!)
rm ~/.code-workspaces/archives/*.tar.gz
```

## Helper Scripts

The system includes convenience scripts for common operations.

### restart-instance.sh

Restarts a code-server instance. Can accept either a workspace path or an instance ID.

**Usage with workspace path:**

```bash
scripts/restart-instance.sh /path/to/workspace
```

The script will:

1. Compute the instance ID from the workspace path
2. Restart the corresponding systemd service

**Usage with instance ID:**

```bash
scripts/restart-instance.sh workspace-abc123def456...
```

**Examples:**

```bash
# Restart by workspace path
scripts/restart-instance.sh /home/user/projects/my-app

# Restart by instance ID
scripts/restart-instance.sh workspace-abc123def456...

# Restart main instance
scripts/restart-instance.sh main
```

### restart-proxy.sh

Restarts the proxy service.

**Usage:**

```bash
scripts/restart-proxy.sh
```

This is equivalent to:

```bash
systemctl --user restart code-server-proxy.service
```

### migrate-to-registry.sh

Migrates existing installations to use the port registry system and full hash naming.

**Usage:**

```bash
scripts/migrate-to-registry.sh
```

This script:

1. Renames instance directories from 8-char to full hash format
2. Creates the port registry with current allocations
3. Updates metadata files with correct field names

**Note:** This script should only be run once when upgrading from an older version.

## Maintenance

### Restarting Services

#### Restart Proxy

```bash
systemctl --user restart code-server-proxy.service
```

This restarts the proxy but keeps all instances running. Active connections may be interrupted briefly.

#### Restart All Instances

```bash
# Stop all instances
systemctl --user stop 'code-server-workspace@*'

# Or restart all running instances
for unit in $(systemctl --user list-units 'code-server-workspace@*' --state=running --no-legend | awk '{print $1}'); do
  systemctl --user restart "$unit"
done
```

#### Restart Everything

```bash
# Stop all instances
systemctl --user stop 'code-server-workspace@*'

# Restart proxy
systemctl --user restart code-server-proxy.service
```

### Updating the Proxy

To update the proxy code:

```bash
# Navigate to repository
cd /path/to/code-server-proxy

# Pull updates (if using git)
git pull

# Install any new dependencies
npm install

# Restart proxy
systemctl --user restart code-server-proxy.service
```

### Updating Systemd Services

If you modify service files:

```bash
# Edit service files
$EDITOR ~/.config/systemd/user/code-server-proxy.service

# Reload systemd configuration
systemctl --user daemon-reload

# Restart affected services
systemctl --user restart code-server-proxy.service
```

For the workspace template service:

```bash
# Edit template
$EDITOR ~/.config/systemd/user/code-server-workspace@.service

# Reload configuration
systemctl --user daemon-reload

# Restart all instances to apply changes
systemctl --user restart 'code-server-workspace@*'
```

### Adjusting Resource Limits

Edit the workspace template service:

```bash
$EDITOR ~/.config/systemd/user/code-server-workspace@.service
```

Modify resource limits:

```ini
[Service]
MemoryMax=4G      # Increase from 2G to 4G
CPUQuota=400%     # Increase from 200% to 400%
```

Apply changes:

```bash
systemctl --user daemon-reload
# Existing instances keep old limits until restarted
systemctl --user restart 'code-server-workspace@*'
```

### Modifying Idle Timeout

Edit the idle monitor script:

```bash
$EDITOR /path/to/code-server-proxy/scripts/workspace-idle-monitor.sh
```

Change the threshold:

```bash
IDLE_THRESHOLD_DAYS=7  # Change from 3 to 7 days
```

No restart needed - takes effect on next timer run.

To change how often the monitor runs:

```bash
$EDITOR ~/.config/systemd/user/workspace-idle-monitor.timer
```

Change the schedule:

```ini
[Timer]
OnCalendar=weekly  # Change from daily to weekly
```

Apply changes:

```bash
systemctl --user daemon-reload
systemctl --user restart workspace-idle-monitor.timer
```

### Enabling Debug Logging

For troubleshooting, you can view more detailed logs:

```bash
# Proxy logs are already verbose
journalctl --user -u code-server-proxy.service -f

# For instance logs, check the log files directly
tail -f ~/.code-workspaces/instances/workspace-abc123def456.../logs/stdout.log
tail -f ~/.code-workspaces/instances/workspace-abc123def456.../logs/stderr.log
```

The proxy logs show:

- Request routing decisions
- Port assignments
- Instance launches
- Redirect handling
- WebSocket upgrades

## Backup and Recovery

### What to Backup

For complete backup, you need:

1. **Instance data** (user settings, extensions, state):

   ```bash
   ~/.code-workspaces/instances/
   ```

2. **Proxy configuration** (if you've customized):

   ```bash
   /path/to/code-server-proxy/
   ```

3. **Systemd service files**:
   ```bash
   ~/.config/systemd/user/code-server-*.service
   ~/.config/systemd/user/workspace-idle-monitor.*
   ```

### Backup Procedure

#### Backup All Instances

```bash
# Create backup directory
mkdir -p ~/backups/code-workspaces-$(date +%Y%m%d)

# Backup instances
tar -czf ~/backups/code-workspaces-$(date +%Y%m%d)/instances.tar.gz \
  -C ~/.code-workspaces instances

# Backup archives (optional)
tar -czf ~/backups/code-workspaces-$(date +%Y%m%d)/archives.tar.gz \
  -C ~/.code-workspaces archives
```

#### Backup Systemd Configuration

```bash
# Backup systemd services
tar -czf ~/backups/code-workspaces-$(date +%Y%m%d)/systemd-config.tar.gz \
  -C ~/.config/systemd/user \
  code-server-proxy.service \
  code-server-workspace@.service \
  workspace-idle-monitor.service \
  workspace-idle-monitor.timer
```

#### Automated Backup Script

Create a backup script:

```bash
#!/bin/bash
BACKUP_DIR=~/backups/code-workspaces-$(date +%Y%m%d)
mkdir -p "$BACKUP_DIR"

echo "Backing up code-server instances..."
tar -czf "$BACKUP_DIR/instances.tar.gz" -C ~/.code-workspaces instances

echo "Backing up systemd configuration..."
tar -czf "$BACKUP_DIR/systemd-config.tar.gz" \
  -C ~/.config/systemd/user \
  code-server-proxy.service \
  code-server-workspace@.service \
  workspace-idle-monitor.service \
  workspace-idle-monitor.timer

echo "Backup complete: $BACKUP_DIR"
```

Schedule with cron or systemd timer.

### Restore Procedure

#### Restore Instances

```bash
# Stop all instances first
systemctl --user stop 'code-server-workspace@*'

# Restore instances
tar -xzf ~/backups/code-workspaces-20241116/instances.tar.gz \
  -C ~/.code-workspaces

# Restart proxy to pick up restored instances
systemctl --user restart code-server-proxy.service
```

#### Restore Systemd Configuration

```bash
# Stop services
systemctl --user stop code-server-proxy.service
systemctl --user stop workspace-idle-monitor.timer

# Restore service files
tar -xzf ~/backups/code-workspaces-20241116/systemd-config.tar.gz \
  -C ~/.config/systemd/user

# Reload and restart
systemctl --user daemon-reload
systemctl --user start code-server-proxy.service
systemctl --user start workspace-idle-monitor.timer
```

### Disaster Recovery

If the system is completely broken:

1. **Reinstall proxy** (follow DEPLOYMENT.md)
2. **Restore systemd configuration**
3. **Restore instance data**
4. **Verify services start**

```bash
# After restore
systemctl --user status code-server-proxy.service
systemctl --user list-units 'code-server-workspace@*'
```

### Selective Instance Recovery

To recover a single instance from backup:

```bash
# Extract specific instance from backup
tar -xzf ~/backups/instances.tar.gz \
  -C ~/.code-workspaces \
  instances/workspace-abc123def456...

# Start instance
systemctl --user start code-server-workspace@workspace-abc123def456...service
```

## Tips and Best Practices

### Performance Tips

1. **Limit concurrent instances**: With default 4GB per instance, monitor total memory
2. **Clean up unused instances**: Don't rely solely on idle monitor - manually stop instances you're done with
3. **Adjust resource limits**: If instances are slow, increase `MemoryMax` and `CPUQuota`

### Organization Tips

1. **Use descriptive workspace names**: Easier to identify in archives
2. **Bookmark frequently-used workspaces**: Save full URLs with parameters
3. **Group related projects in workspaces**: Use `.code-workspace` files for multi-folder projects

### Monitoring Tips

1. **Check logs regularly**: `journalctl --user -u code-server-proxy.service --since today`
2. **Monitor disk space**: Instances can grow large with extensions and data
3. **Review archives monthly**: Clean up old archives you don't need

### Security Notes

1. **Proxy binds to 127.0.0.1**: Only accessible from localhost by default
2. **No authentication at proxy level**: Relies on code-server's built-in authentication
3. **Instances isolated by port**: Browser storage is separate per port
4. **File system not isolated**: Instances can access same files if paths overlap

## Quick Reference

### Common Commands

```bash
# Check proxy status
systemctl --user status code-server-proxy.service

# List running instances
systemctl --user list-units 'code-server-workspace@*' --state=running

# View proxy logs
journalctl --user -u code-server-proxy.service -f

# View instance logs
journalctl --user -u code-server-workspace@<instance-name>.service -f

# Stop an instance
systemctl --user stop code-server-workspace@<instance-name>.service

# Restart proxy
systemctl --user restart code-server-proxy.service

# Run idle monitor manually
/path/to/scripts/workspace-idle-monitor.sh
```

### Common Paths

```bash
# Instance directories
~/.code-workspaces/instances/

# Archives
~/.code-workspaces/archives/

# Systemd user services
~/.config/systemd/user/

# Proxy repository
/path/to/code-server-proxy/
```

## Further Reading

- [DEPLOYMENT.md](DEPLOYMENT.md) - Installation and setup
- [ARCHITECTURE.md](ARCHITECTURE.md) - Technical architecture details

## Auto-SSH and GPU Configuration

### Auto-SSH to Host

Auto-SSH allows container terminals to automatically SSH to the host system, providing full access to host resources (GPU, CPU, memory) while maintaining terminal isolation.

#### Prerequisites

Before enabling auto-SSH:

1. **SSH Server Running on Host**:

   ```bash
   # Check SSH server status
   systemctl status sshd

   # Start if not running
   sudo systemctl start sshd
   sudo systemctl enable sshd
   ```

2. **SSH Agent with Loaded Keys**:

   ```bash
   # Start SSH agent if not running
   eval $(ssh-agent)

   # Add your SSH key
   ssh-add ~/.ssh/id_rsa

   # Verify agent is running
   echo $SSH_AUTH_SOCK
   # Should output a path like /tmp/ssh-XXX/agent.12345
   ```

3. **Verify SSH Access**:
   ```bash
   # Test SSH to localhost
   ssh $USER@localhost whoami
   # Should connect without password prompt
   ```

#### Enabling Auto-SSH Globally

Enable auto-SSH for all new workspaces:

```bash
# Set environment variable
export ENABLE_AUTO_SSH=true

# Edit systemd service to persist
systemctl --user edit code-server-proxy.service
```

Add to the service file:

```ini
[Service]
Environment="ENABLE_AUTO_SSH=true"
```

Restart proxy:

```bash
systemctl --user daemon-reload
systemctl --user restart code-server-proxy.service
```

#### Enabling Auto-SSH Per-Workspace

Enable auto-SSH for a specific workspace:

1. **Edit workspace metadata**:

   ```bash
   # Find instance ID for workspace
   WORKSPACE_PATH="/path/to/workspace"
   INSTANCE_ID=$(echo -n "$WORKSPACE_PATH" | sha256sum | awk '{print $1}')

   # Edit metadata
   $EDITOR ~/.code-workspaces/instances/$INSTANCE_ID/metadata.json
   ```

2. **Add auto-SSH configuration**:

   ```json
   {
     "workspacePath": "/path/to/workspace",
     "port": 8142,
     "instanceId": "abc123...",
     "backend": "docker",
     "autoSSH": true
   }
   ```

3. **Recreate container**:

   ```bash
   # Stop and remove existing container
   docker stop code-server-$INSTANCE_ID
   docker rm code-server-$INSTANCE_ID

   # Next access will create new container with auto-SSH
   ```

#### Verifying Auto-SSH

After enabling auto-SSH, verify it's working:

```bash
# Access workspace
curl "http://localhost:8083/?workspace=/path/to/workspace"

# Open terminal in browser, run:
hostname
# Should show host machine name, not container ID

whoami
# Should show host user, not 'abc'

pwd
# Should show workspace path on host
```

### GPU Access Configuration

GPU passthrough enables containers to access NVIDIA GPUs for AI/CUDA workloads.

#### Prerequisites

1. **NVIDIA Drivers Installed on Host**:

   ```bash
   # Check NVIDIA driver
   nvidia-smi
   # Should show GPU information
   ```

2. **NVIDIA Container Toolkit Installed**:

   ```bash
   # Ubuntu/Debian installation
   distribution=$(. /etc/os-release;echo $ID$VERSION_ID)
   curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | \
       sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg

   curl -s -L https://nvidia.github.io/libnvidia-container/$distribution/libnvidia-container.list | \
       sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
       sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list

   sudo apt-get update
   sudo apt-get install -y nvidia-container-toolkit

   # Configure Docker to use NVIDIA runtime
   sudo nvidia-ctk runtime configure --runtime=docker
   sudo systemctl restart docker
   ```

3. **Verify NVIDIA Container Toolkit**:

   ```bash
   # Run test script
   ./scripts/test-gpu-access.sh

   # Or test manually
   docker run --rm --runtime=nvidia nvidia/cuda:11.0-base nvidia-smi
   # Should show GPU information
   ```

#### Enabling GPU Access Globally

Enable GPU for all new workspaces:

```bash
# Set environment variable
export ENABLE_GPU=true

# Edit systemd service
systemctl --user edit code-server-proxy.service
```

Add to service file:

```ini
[Service]
Environment="ENABLE_GPU=true"
```

Restart proxy:

```bash
systemctl --user daemon-reload
systemctl --user restart code-server-proxy.service
```

#### Enabling GPU Per-Workspace

Enable GPU for specific workspace:

1. **Edit workspace metadata**:

   ```bash
   # Find instance ID
   WORKSPACE_PATH="/path/to/gpu-project"
   INSTANCE_ID=$(echo -n "$WORKSPACE_PATH" | sha256sum | awk '{print $1}')

   # Edit metadata
   $EDITOR ~/.code-workspaces/instances/$INSTANCE_ID/metadata.json
   ```

2. **Add GPU configuration**:

   ```json
   {
     "workspacePath": "/path/to/gpu-project",
     "port": 8142,
     "instanceId": "abc123...",
     "backend": "docker",
     "enableGPU": true
   }
   ```

3. **Recreate container**:
   ```bash
   docker stop code-server-$INSTANCE_ID
   docker rm code-server-$INSTANCE_ID
   ```

#### Verifying GPU Access

Test GPU access from container:

```bash
# Get instance ID
WORKSPACE_PATH="/path/to/workspace"
INSTANCE_ID=$(echo -n "$WORKSPACE_PATH" | sha256sum | awk '{print $1}')

# Test nvidia-smi in container
docker exec code-server-$INSTANCE_ID nvidia-smi
# Should show GPU information

# Test from extension host
docker exec code-server-$INSTANCE_ID sh -c "cd /workspace && python -c 'import torch; print(torch.cuda.is_available())'"
# Should print: True
```

### Monitoring Workspace Activity

The activity tracker monitors workspace usage based on browser traffic (WebSocket/HTTP), enabling accurate idle detection when auto-SSH is enabled.

#### Querying Activity via API

Check workspace idle time:

```bash
# Get workspace ID (SHA256 of workspace path)
WORKSPACE_PATH="/path/to/workspace"
WORKSPACE_ID=$(echo -n "$WORKSPACE_PATH" | sha256sum | awk '{print $1}')

# Query activity
curl "http://localhost:8083/api/activity/$WORKSPACE_ID"
```

Response:

```json
{
  "workspaceId": "abc123...",
  "idleSeconds": 3600,
  "lastActivity": 1700000000000
}
```

If no activity recorded:

```json
{
  "error": "Workspace not found or no activity recorded"
}
```

#### Manual Idle Monitor Execution

Run idle monitor manually:

```bash
# Docker mode (uses activity tracking API)
./scripts/workspace-idle-monitor.sh

# Check specific threshold
IDLE_THRESHOLD_DAYS=1 ./scripts/workspace-idle-monitor.sh
```

#### Activity Tracking Behavior

Activity is recorded when:

- User loads workspace in browser (HTTP request)
- User types in terminal (WebSocket traffic)
- User edits files (WebSocket traffic)
- Extension performs operations (WebSocket traffic)

Activity is **not** recorded when:

- Container processes run (SSH clients, background jobs)
- Scheduled tasks execute in container
- No browser connection active

### Persistent Activity Tracking

Activity is persisted to `~/.code-workspaces/.activity.json` and survives proxy restarts.

```json
{
  "version": 1,
  "lastSaved": "2025-11-21T20:22:25.040Z",
  "activity": {
    "b71ce35ba9d6...": "2025-11-21T20:18:27.343Z",
    "7e8067bf48eb...": "2025-11-21T20:19:21.758Z"
  }
}
```

- **Debounced saves**: 30 seconds after activity change
- **Periodic saves**: Every 5 minutes
- **Shutdown save**: Activity saved on SIGINT/SIGTERM

### Scheduled Cleanup Tasks

The proxy automatically manages idle containers:

| Task                    | Interval      | Action                                                                  |
| ----------------------- | ------------- | ----------------------------------------------------------------------- |
| Stop idle containers    | Every 1 hour  | Stops containers idle > `IDLE_THRESHOLD_DAYS` (default: 3)              |
| Cleanup idle containers | Every 6 hours | Removes stopped containers idle > `IDLE_GRACE_PERIOD_DAYS` (default: 7) |
| Orphan detection        | Every 6 hours | Removes duplicate containers for same workspace                         |
| Shared tmp cleanup      | Every 1 hour  | Removes files from `/tmp/kilocode-shared` older than 1 hour             |

Before removal, container volumes are backed up to `~/.code-workspaces/volumes/`.

## Claude Code Integration

The proxy includes optimized integration for Claude Code (Kilo Code) when running in containers with auto-SSH enabled.

### Claude Wrapper Features

The `/usr/local/bin/claude` wrapper provides:

1. **SSH Connection Multiplexing**
   - First SSH connection persists for 10 minutes
   - Subsequent calls reuse the connection (eliminates ~200ms handshake)
   - Control socket at `/run/user/1001/ssh-control-host.docker.internal`

2. **Shared Temp Files**
   - Kilo Code system prompts (~74KB each) copied to `/tmp/kilocode-shared`
   - Shared volume mount eliminates SSH file transfer overhead
   - Hourly cleanup prevents accumulation

3. **Streaming Optimization**
   - Line buffering (`stdbuf -oL -eL`) for non-interactive mode
   - Prevents truncated Claude responses from buffer issues

4. **Error Logging**
   - Always logs errors to `/tmp/claude-wrapper.log`
   - Enable debug mode: `export CLAUDE_WRAPPER_DEBUG=true`
   - Captures timing, file sizes, exit codes

5. **Environment Integration**
   - Automatically sources `~/.shrc` on host for tool environments
   - CUDA, compiler paths, and other tool-specific variables available
   - Works for all host command execution (claude, sh-host-wrapper, host-bash)

### Shell Environment Setup

All commands executed on the host automatically source `~/.shrc` to ensure tool environments (CUDA, compilers, etc.) are available.

**Host Setup** (`~/.shrc` on host machine):

```bash
# ~/.shrc: executed by sh(1) for non-login shells via ENV variable
# This file should be lightweight - only environment variables

# Source CUDA environment
if [ -f "$HOME/bin/cuda_env.sh" ]; then
    . "$HOME/bin/cuda_env.sh"
fi

# Add other tool paths as needed
export PATH="$HOME/.local/bin:$PATH"
```

**Container Setup**:

- `ENV=/config/.shrc` set in container environment
- POSIX shells automatically source `/config/.shrc` when run locally
- Host commands via SSH automatically source `~/.shrc` on host

**Verification**:

```bash
# Test from container terminal
/bin/sh -c 'echo $CUDA_HOME'  # Should show CUDA path if .shrc sets it

# Test via Kilo Code command execution
# CUDA_HOME and related vars will be available to all tools
```

### Monitoring Claude Wrapper

Check for errors:

```bash
# View recent errors
tail -100 /tmp/claude-wrapper.log | grep ERROR

# Check error rate
grep -c ERROR /tmp/claude-wrapper.log
```

Enable debug logging (in container):

```bash
# Set environment variable
export CLAUDE_WRAPPER_DEBUG=true

# Now all claude calls will log detailed debug info
claude -p "test message"

# View debug log
tail -50 /tmp/claude-wrapper.log
```

Debug log includes:

- Start/end timestamps with PID
- File copy operations with sizes
- Elapsed time in milliseconds
- Exit codes and errors

### SSH ControlMaster Status

Check active SSH control connections:

```bash
# List control sockets (from container)
ls -la /run/user/1001/ssh-control-*

# See active connections
ssh -O check shauncutts@host.docker.internal 2>&1
```

### Shared Tmp Usage

```bash
# Check shared tmp usage
du -sh /tmp/kilocode-shared
ls /tmp/kilocode-shared | wc -l  # File count
```

Files are cleaned automatically every hour (files >1 hour old removed).

## Configuration

### Mount Configuration

Container mounts are configured in `config/mounts.json`:

```json
{
  "description": "Container mount configuration",
  "binds": [
    {
      "source": "/home/shauncutts",
      "target": "/home/shauncutts",
      "mode": "rw",
      "comment": "User home directory"
    },
    {
      "source": "/data/sda",
      "target": "/data/sda",
      "mode": "rw",
      "comment": "Data directory"
    },
    {
      "source": "/usr/local/share/mambaforge",
      "target": "/usr/local/share/mambaforge",
      "mode": "ro",
      "comment": "Python environments for poetry virtualenvs"
    },
    {
      "source": "/tmp/kilocode-shared",
      "target": "/tmp/kilocode-shared",
      "mode": "rw",
      "comment": "Shared temp for Kilo Code system prompts (avoids SSH copy)"
    }
  ]
}
```

**Fields:**

- `source`: Host path to mount
- `target`: Container path (usually same as source for symlink compatibility)
- `mode`: `rw` (read-write) or `ro` (read-only)
- `comment`: Optional description (logged during container creation)

### Reloading Configuration

Reload mounts config without restarting the proxy:

```bash
# Send SIGHUP to reload config
kill -HUP $(pgrep -f 'node.*proxy.js')

# Or via systemctl
systemctl --user kill -s HUP code-server-proxy
```

**Note**: Config reload only affects **new** containers. Existing containers must be recreated to pick up mount changes.

### Environment Variables

| Variable                 | Default                    | Description                                   |
| ------------------------ | -------------------------- | --------------------------------------------- |
| `USE_DOCKER`             | `false`                    | Enable Docker container mode                  |
| `DOCKER_IMAGE`           | `code-server-proxy:latest` | Docker image to use                           |
| `DOCKER_MEMORY_LIMIT`    | `4g`                       | Container memory limit                        |
| `DOCKER_CPU_LIMIT`       | `3.0`                      | Container CPU limit                           |
| `IDLE_THRESHOLD_DAYS`    | `3`                        | Days before stopping idle container           |
| `IDLE_GRACE_PERIOD_DAYS` | `7`                        | Days before removing stopped container        |
| `IDLE_WHITELIST`         | ``                         | Comma-separated instance IDs to never cleanup |
| `ENABLE_AUTO_SSH`        | `false`                    | Forward commands to host via SSH              |
| `ENABLE_GPU`             | `false`                    | Enable NVIDIA GPU passthrough                 |
| `CLAUDE_WRAPPER_DEBUG`   | `false`                    | Enable debug logging in claude-wrapper        |

- [systemd/README.md](../systemd/README.md) - Systemd service documentation
