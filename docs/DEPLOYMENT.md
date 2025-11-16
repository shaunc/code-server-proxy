# Code-Server Workspace Isolation Proxy - Deployment Guide

## Overview

This guide covers installation and configuration of the code-server workspace isolation proxy, which provides separate isolated code-server instances for each workspace or folder you open.

## Prerequisites

### Required Software

- **Node.js**: Version 18.0.0 or higher

  ```bash
  node --version  # Should show v18.0.0 or higher
  ```

- **code-server**: VSCode in the browser

  ```bash
  code-server --version
  ```

- **systemd**: User-level systemd instance

  ```bash
  systemctl --user status  # Should not error
  ```

- **jq** (optional): For better JSON parsing in scripts
  ```bash
  sudo apt install jq  # Debian/Ubuntu
  ```

### System Requirements

- **Memory**: Minimum 8GB RAM (each instance can use up to 4GB)
- **CPU**: Multi-core recommended (each instance can use up to 300% CPU)
- **Disk**: Sufficient space for workspace instances in `~/.code-workspaces/`
- **Network**: Ports 8083, 8100-8199 available on localhost

### User Permissions

- Must be able to run user-level systemd services
- Write access to home directory for instance storage
- No root/sudo required for operation

## Quick Start

For experienced users, here's the fastest path to get running:

```bash
# 1. Clone repository
cd ~/src/other
git clone <repository-url> code-server-proxy
cd code-server-proxy

# 2. Install dependencies
npm install

# 3. Install systemd services (update paths for your system)
mkdir -p ~/.config/systemd/user
cp systemd/*.service systemd/*.timer ~/.config/systemd/user/

# 4. Edit service files to match your paths
$EDITOR ~/.config/systemd/user/code-server-proxy.service
$EDITOR ~/.config/systemd/user/code-server-workspace@.service
$EDITOR ~/.config/systemd/user/workspace-idle-monitor.service

# 5. Enable and start services
systemctl --user daemon-reload
systemctl --user enable --now code-server-proxy.service
systemctl --user enable --now workspace-idle-monitor.timer

# 6. Access the proxy
# Open browser to: http://127.0.0.1:8083
```

## Detailed Installation Steps

### 1. Clone and Setup Repository

Clone the repository to your preferred location:

```bash
cd ~/src/other  # Or your preferred location
git clone <repository-url> code-server-proxy
cd code-server-proxy
```

**Important**: Note the full path to this directory - you'll need it for systemd configuration:

```bash
pwd  # Example output: /home/shauncutts/src/other/code-server-proxy
```

### 2. Install Node.js Dependencies

Install required npm packages:

```bash
npm install
```

Expected output:

```
added 15 packages, and audited 16 packages in 2s
```

Verify installation:

```bash
npm list --depth=0
```

Expected packages:

- `http-proxy@^1.18.1`
- `http-proxy-middleware@^2.0.6`

### 3. Configure Systemd Services

#### 3.1 Find Your Node.js Path

Determine your Node.js installation path:

```bash
which node
# Example: /home/shauncutts/.nvm/versions/node/v22.17.1/bin/node
```

#### 3.2 Find Your User ID

Determine your numeric user ID for XDG_RUNTIME_DIR:

```bash
id -u
# Example: 1001
```

#### 3.3 Copy Service Files

Copy systemd service files to user configuration directory:

```bash
mkdir -p ~/.config/systemd/user
cp systemd/*.service systemd/*.timer ~/.config/systemd/user/
```

#### 3.4 Edit Proxy Service

Edit `~/.config/systemd/user/code-server-proxy.service`:

```bash
$EDITOR ~/.config/systemd/user/code-server-proxy.service
```

Update these lines to match your system:

```ini
ExecStart=/path/to/your/node /path/to/code-server-proxy/src/proxy.js
WorkingDirectory=/path/to/code-server-proxy
Environment=XDG_RUNTIME_DIR=/run/user/YOUR_UID
```

Example with actual paths:

```ini
ExecStart=/home/shauncutts/.nvm/versions/node/v22.17.1/bin/node /home/shauncutts/src/other/code-server-proxy/src/proxy.js
WorkingDirectory=/home/shauncutts/src/other/code-server-proxy
Environment=XDG_RUNTIME_DIR=/run/user/1001
```

#### 3.5 Edit Workspace Template Service

Edit `~/.config/systemd/user/code-server-workspace@.service`:

```bash
$EDITOR ~/.config/systemd/user/code-server-workspace@.service
```

Update the ExecStart path:

```ini
ExecStart=/path/to/code-server-proxy/scripts/launch-workspace-instance.sh %i
```

Example:

```ini
ExecStart=/home/shauncutts/src/other/code-server-proxy/scripts/launch-workspace-instance.sh %i
```

#### 3.6 Edit Idle Monitor Service

Edit `~/.config/systemd/user/workspace-idle-monitor.service`:

```bash
$EDITOR ~/.config/systemd/user/workspace-idle-monitor.service
```

Update the ExecStart path:

```ini
ExecStart=/path/to/code-server-proxy/scripts/workspace-idle-monitor.sh
```

Example:

```ini
ExecStart=/home/shauncutts/src/other/code-server-proxy/scripts/workspace-idle-monitor.sh
```

### 4. Start Services

#### 4.1 Reload Systemd Configuration

After editing service files:

```bash
systemctl --user daemon-reload
```

#### 4.2 Enable and Start Proxy

Enable the proxy to start automatically:

```bash
systemctl --user enable code-server-proxy.service
```

Start the proxy:

```bash
systemctl --user start code-server-proxy.service
```

#### 4.3 Enable Idle Monitor Timer

Enable the daily cleanup timer:

```bash
systemctl --user enable workspace-idle-monitor.timer
systemctl --user start workspace-idle-monitor.timer
```

## Configuration

### Port Assignments

The system uses the following port allocation:

| Purpose             | Port(s)   | Description                                    |
| ------------------- | --------- | ---------------------------------------------- |
| Proxy               | 8083      | Main entry point - access this in your browser |
| Main Instance       | 8100      | Default/bare mode code-server instance         |
| Workspace Instances | 8101-8199 | Automatically assigned to workspaces/folders   |

### Port Assignment Algorithm

Workspace and folder instances receive deterministic port assignments based on SHA-256 hash of the path:

```javascript
hash = SHA256(workspacePath);
port = 8101 + (hash % 99); // Results in 8101-8199
```

This ensures:

- Same workspace always gets the same port
- Consistent routing across proxy restarts
- Maximum 99 simultaneous workspace instances

### Directory Structure

Instances are stored in `~/.code-workspaces/instances/`:

```
~/.code-workspaces/
├── instances/
│   ├── main/                          # Default instance
│   │   ├── data/                      # User data (settings, state)
│   │   ├── extensions/                # Installed extensions
│   │   ├── logs/                      # stdout/stderr logs
│   │   ├── metadata.json              # Instance configuration
│   │   └── last-access                # Last access timestamp
│   ├── workspace-abc123def456.../    # Workspace-specific instance (full hash)
│   │   ├── data/
│   │   │   └── User/                 # → symlink to shared/User/
│   │   ├── extensions/               # → symlink to shared/extensions/
│   │   ├── logs/
│   │   ├── metadata.json
│   │   └── last-access
│   ├── shared/                       # Shared across all instances
│   │   ├── extensions/               # Shared extension storage
│   │   └── User/                     # Shared user settings
│   └── port-registry.json            # Port allocation registry
└── archives/                          # Archived idle instances
    └── workspace-abc123def456...-20241116-120000.tar.gz
```

### Resource Limits

Each workspace instance has the following systemd resource limits:

- **Memory**: 4GB maximum (`MemoryMax=4G`)
- **CPU**: 300% maximum (3 full cores, `CPUQuota=300%`)

To adjust these limits, edit `~/.config/systemd/user/code-server-workspace@.service`:

```ini
[Service]
MemoryMax=4G      # Increase to 4GB
CPUQuota=400%     # Allow 4 cores
```

Then reload:

```bash
systemctl --user daemon-reload
```

### Idle Timeout Configuration

Workspace instances are automatically archived after 3 days of inactivity (main instance is never archived).

To change the timeout, edit `scripts/workspace-idle-monitor.sh`:

```bash
IDLE_THRESHOLD_DAYS=7  # Change to 7 days
```

To change cleanup frequency, edit `~/.config/systemd/user/workspace-idle-monitor.timer`:

```ini
[Timer]
OnCalendar=weekly  # Run weekly instead of daily
```

Then reload:

```bash
systemctl --user daemon-reload
systemctl --user restart workspace-idle-monitor.timer
```

### Environment Variables

The proxy requires the following environment variable in the systemd service:

```ini
Environment=XDG_RUNTIME_DIR=/run/user/YOUR_UID
```

This is necessary for systemd user instances to function correctly. Find your UID with:

```bash
id -u
```

## Verification

### Check Proxy Status

Verify the proxy is running:

```bash
systemctl --user status code-server-proxy.service
```

Expected output:

```
● code-server-proxy.service - Code-Server Workspace Isolation Proxy
     Loaded: loaded (/home/user/.config/systemd/user/code-server-proxy.service; enabled)
     Active: active (running) since ...
```

### Check Proxy Logs

View proxy logs:

```bash
journalctl --user -u code-server-proxy.service -f
```

You should see:

```
Code-Server Proxy listening on 127.0.0.1:8083
Main instance port: 8100
Workspace instance ports: 8101-8199
Base directory: /home/user/.code-workspaces/instances
```

### Test Each Mode

#### 1. Test Bare Mode (Empty Window)

Access: `http://127.0.0.1:8083/?ew=true`

Expected behavior:

- Opens code-server with no folder/workspace
- Routes to main instance on port 8100
- Check logs show: `[ROUTING] Bare mode request (ew=true) -> main instance`

#### 2. Test Folder Mode

Access: `http://127.0.0.1:8083/?folder=/home/user/projects/test`

Expected behavior:

- Opens code-server with the specified folder
- Creates new instance if first access
- Routes to deterministic port (8101-8199)
- Check instance directory: `ls ~/.code-workspaces/instances/workspace-*`

#### 3. Test Workspace Mode

Access: `http://127.0.0.1:8083/?workspace=/home/user/projects/test.code-workspace`

Expected behavior:

- Opens code-server with the specified workspace file
- Creates new instance if first access
- Routes to deterministic port (8101-8199)
- Different from folder mode for same path

#### 4. Test Default Mode

Access: `http://127.0.0.1:8083/`

Expected behavior:

- Opens code-server main instance
- Same as bare mode
- Routes to port 8100

### Verify Port Isolation

Test that different workspaces get different ports:

```bash
# Access two different folders
# Folder 1: http://127.0.0.1:8083/?folder=/home/user/project1
# Folder 2: http://127.0.0.1:8083/?folder=/home/user/project2

# Check running instances
systemctl --user list-units 'code-server-workspace@*'
```

Expected output:

```
code-server-workspace@main.service           loaded active running
code-server-workspace@workspace-abc123def456...service loaded active running
code-server-workspace@workspace-789abc012def...service loaded active running
```

### Verify Instance Creation

Check instance directories were created:

```bash
ls -la ~/.code-workspaces/instances/
```

Expected output:

```
drwxr-xr-x  main
drwxr-xr-x  workspace-abc123def456...
drwxr-xr-x  workspace-789abc012def...
```

Check instance metadata:

```bash
cat ~/.code-workspaces/instances/workspace-abc123def456.../metadata.json
```

Expected output:

```json
{
  "workspacePath": "/home/user/project1",
  "port": 8142,
  "created": "2024-11-16T03:30:00.000Z",
  "instanceId": "workspace-abc123def456..."
}
```

### Verify Idle Monitor

Check timer status:

```bash
systemctl --user status workspace-idle-monitor.timer
```

Expected output:

```
● workspace-idle-monitor.timer - Daily cleanup of idle code-server workspace instances
     Loaded: loaded (...)
     Active: active (waiting) since ...
```

View next scheduled run:

```bash
systemctl --user list-timers workspace-idle-monitor.timer
```

## Troubleshooting

### Proxy Won't Start

**Symptom**: `systemctl --user status code-server-proxy.service` shows failed state

**Possible causes**:

1. **Node.js path incorrect**

   ```bash
   # Check path in service file
   grep ExecStart ~/.config/systemd/user/code-server-proxy.service
   # Verify node exists at that path
   ls -l /path/to/node
   ```

2. **Port 8083 already in use**

   ```bash
   # Check what's using port 8083
   netstat -tlnp | grep 8083
   # or
   ss -tlnp | grep 8083
   ```

3. **Missing dependencies**

   ```bash
   # Reinstall dependencies
   cd /path/to/code-server-proxy
   npm install
   ```

4. **XDG_RUNTIME_DIR not set**
   ```bash
   # Check environment in service file
   grep XDG_RUNTIME_DIR ~/.config/systemd/user/code-server-proxy.service
   # Should be: Environment=XDG_RUNTIME_DIR=/run/user/YOUR_UID
   ```

**Solution**: Fix the issue, then:

```bash
systemctl --user daemon-reload
systemctl --user restart code-server-proxy.service
```

### Systemd User Instance Problems

**Symptom**: `systemctl --user` commands fail with "Failed to connect to bus"

**Cause**: User systemd instance not running

**Solution**:

```bash
# Enable lingering for your user (allows systemd user instance to run without active session)
sudo loginctl enable-linger $USER

# Check status
loginctl show-user $USER | grep Linger
# Should show: Linger=yes
```

### Instance Launch Failures

**Symptom**: Proxy logs show "Failed to start systemd service"

**Possible causes**:

1. **Workspace template service not installed**

   ```bash
   # Check if template exists
   ls ~/.config/systemd/user/code-server-workspace@.service
   ```

2. **Incorrect paths in template service**

   ```bash
   # Verify launch script path
   grep ExecStart ~/.config/systemd/user/code-server-workspace@.service
   # Verify script is executable
   ls -l /path/to/launch-workspace-instance.sh
   chmod +x /path/to/launch-workspace-instance.sh
   ```

3. **Instance directory not created**
   ```bash
   # Manually create if needed
   mkdir -p ~/.code-workspaces/instances
   ```

**Solution**: Fix the issue and try accessing again - the proxy will retry launching.

### Port Conflicts

**Symptom**: Instance won't start, logs show port already in use

**Cause**: Another process using ports 8100-8199

**Check for conflicts**:

```bash
# Check all ports in range
for port in {8100..8199}; do
  if netstat -tln | grep -q ":$port "; then
    echo "Port $port in use"
  fi
done
```

**Solution**: Either stop conflicting processes or modify port range in `src/proxy.js`:

```javascript
const MAIN_PORT = 9100;
const WORKSPACE_PORT_MIN = 9101;
const WORKSPACE_PORT_MAX = 9199;
```

Then restart proxy:

```bash
systemctl --user restart code-server-proxy.service
```

### Browser Shows "Bad Gateway"

**Symptom**: 502 Bad Gateway error in browser

**Cause**: Backend instance not ready or failed to start

**Check backend instance**:

```bash
# List running instances
systemctl --user list-units 'code-server-workspace@*'

# Check specific instance logs
journalctl --user -u code-server-workspace@workspace-abc123def456...service
```

**Common issues**:

- code-server not installed: `which code-server`
- Workspace path doesn't exist: Check path in metadata.json
- Instance crashed: Check logs for error messages

### Workspace Path Issues

**Symptom**: "Bad Request: workspace path must be absolute"

**Cause**: Relative path used in URL parameter

**Solution**: Always use absolute paths:

```
✗ Wrong: http://127.0.0.1:8083/?folder=projects/test
✓ Correct: http://127.0.0.1:8083/?folder=/home/user/projects/test
```

### Idle Monitor Not Running

**Symptom**: Old instances never cleaned up

**Check timer status**:

```bash
systemctl --user status workspace-idle-monitor.timer
systemctl --user list-timers
```

**Manually run monitor**:

```bash
# Run cleanup manually
/path/to/code-server-proxy/scripts/workspace-idle-monitor.sh

# Check output
journalctl --user -u workspace-idle-monitor.service
```

**Enable if not running**:

```bash
systemctl --user enable --now workspace-idle-monitor.timer
```

## Next Steps

- Read [OPERATIONS.md](OPERATIONS.md) for daily usage and management
- Read [ARCHITECTURE.md](ARCHITECTURE.md) for technical details
- Customize resource limits and timeouts for your needs
