# Systemd Service Files for Code-Server Proxy

This directory contains systemd user service files for running the code-server workspace isolation proxy.

## Services

### 1. code-server-proxy.service

The main proxy server that handles routing requests to isolated workspace instances.

### 2. code-server-workspace@.service

A systemd template service for launching isolated code-server instances. The `@` symbol makes this a template - instances are started with names like `code-server-workspace@workspace-a1b2c3d4.service`.

## Installation

### Step 1: Install Service Files

Create symbolic links to install the services in your user systemd directory:

```bash
# Create user systemd directory if it doesn't exist
mkdir -p ~/.config/systemd/user

# Install proxy service
ln -sf ~/src/other/code-server-proxy/systemd/code-server-proxy.service ~/.config/systemd/user/

# Install workspace template service
ln -sf ~/src/other/code-server-proxy/systemd/code-server-workspace@.service ~/.config/systemd/user/

# Reload systemd to recognize new services
systemctl --user daemon-reload
```

### Step 2: Enable and Start the Proxy

```bash
# Enable proxy to start automatically on login
systemctl --user enable code-server-proxy.service

# Start the proxy now
systemctl --user start code-server-proxy.service
```

## Managing the Proxy Service

### Check Status

```bash
systemctl --user status code-server-proxy.service
```

### View Logs

```bash
# Follow logs in real-time
journalctl --user -u code-server-proxy.service -f

# View recent logs
journalctl --user -u code-server-proxy.service -n 50

# View logs since boot
journalctl --user -u code-server-proxy.service -b
```

### Stop/Restart

```bash
# Stop the proxy
systemctl --user stop code-server-proxy.service

# Restart the proxy
systemctl --user restart code-server-proxy.service

# Disable auto-start on login
systemctl --user disable code-server-proxy.service
```

## Workspace Instance Management

Workspace instances are automatically managed by the proxy server. When you access a workspace through the proxy, it will:

1. Check if an instance is already running
2. Start a new instance if needed using `systemctl --user start code-server-workspace@<instance-name>.service`
3. Route your request to the running instance

### Manual Instance Management

You can also manually manage workspace instances:

```bash
# Start a specific workspace instance
systemctl --user start code-server-workspace@workspace-a1b2c3d4.service

# Check instance status
systemctl --user status code-server-workspace@workspace-a1b2c3d4.service

# View instance logs (from journal)
journalctl --user -u code-server-workspace@workspace-a1b2c3d4.service -f

# View instance logs (from file)
tail -f ~/.code-workspaces/instances/workspace-a1b2c3d4/logs/stdout.log
tail -f ~/.code-workspaces/instances/workspace-a1b2c3d4/logs/stderr.log

# Stop an instance
systemctl --user stop code-server-workspace@workspace-a1b2c3d4.service

# List all running workspace instances
systemctl --user list-units 'code-server-workspace@*'
```

## Resource Limits

Each workspace instance has the following resource limits configured:

- **Memory**: Maximum 2GB (`MemoryMax=2G`)
- **CPU**: Maximum 200% (2 cores, `CPUQuota=200%`)

These limits can be adjusted in the `code-server-workspace@.service` file if needed.

## Troubleshooting

### Proxy won't start

1. Check the logs:

   ```bash
   journalctl --user -u code-server-proxy.service -n 50
   ```

2. Verify Node.js is available:

   ```bash
   which node
   ```

3. Check if the port (default 8080) is already in use:
   ```bash
   ss -tlnp | grep 8080
   ```

### Workspace instance won't start

1. Check instance logs:

   ```bash
   journalctl --user -u code-server-workspace@<instance-name>.service -n 50
   ```

2. Verify the instance metadata exists:

   ```bash
   cat ~/.code-workspaces/instances/<instance-name>/metadata.json
   ```

3. Check if code-server is installed:

   ```bash
   which code-server
   ```

4. Verify the launcher script is executable:
   ```bash
   ls -la ~/src/other/code-server-proxy/scripts/launch-workspace-instance.sh
   ```

### View all code-server related services

```bash
systemctl --user list-units 'code-server*'
```

## Uninstallation

To remove the services:

```bash
# Stop and disable the proxy
systemctl --user stop code-server-proxy.service
systemctl --user disable code-server-proxy.service

# Stop all workspace instances
systemctl --user stop 'code-server-workspace@*'

# Remove service files
rm ~/.config/systemd/user/code-server-proxy.service
rm ~/.config/systemd/user/code-server-workspace@.service

# Reload systemd
systemctl --user daemon-reload
```

## Automatic Idle Workspace Cleanup

The system includes an automatic cleanup mechanism that monitors workspace instances for idle time and archives instances that haven't been accessed in over 3 days.

### Installation

Install the idle monitor timer and service:

```bash
# Install idle monitor timer and service
ln -sf ~/src/other/code-server-proxy/systemd/workspace-idle-monitor.timer ~/.config/systemd/user/
ln -sf ~/src/other/code-server-proxy/systemd/workspace-idle-monitor.service ~/.config/systemd/user/

# Reload systemd
systemctl --user daemon-reload

# Enable and start timer
systemctl --user enable workspace-idle-monitor.timer
systemctl --user start workspace-idle-monitor.timer
```

### Managing the Idle Monitor

#### Check timer status

```bash
# View timer status and next run time
systemctl --user list-timers workspace-idle-monitor.timer

# Check timer details
systemctl --user status workspace-idle-monitor.timer
```

#### Manually trigger the monitor

```bash
# Run the idle monitor immediately
systemctl --user start workspace-idle-monitor.service

# Or run the script directly
~/src/other/code-server-proxy/scripts/workspace-idle-monitor.sh
```

#### View logs

```bash
# Follow logs in real-time
journalctl --user -u workspace-idle-monitor.service -f

# View recent logs
journalctl --user -u workspace-idle-monitor.service -n 50

# View logs from a specific date
journalctl --user -u workspace-idle-monitor.service --since "2025-01-01"
```

#### Stop/disable the timer

```bash
# Stop the timer
systemctl --user stop workspace-idle-monitor.timer

# Disable auto-start
systemctl --user disable workspace-idle-monitor.timer
```

### Configuration

The idle threshold can be adjusted by editing the script:

```bash
# Edit the idle threshold (default is 3 days)
nano ~/src/other/code-server-proxy/scripts/workspace-idle-monitor.sh
# Change the IDLE_THRESHOLD_DAYS variable
```

After editing, reload systemd:

```bash
systemctl --user daemon-reload
```

### How It Works

The idle monitor runs daily at midnight and:

1. Checks all workspace instance directories in `~/.code-workspaces/instances/`
2. Skips the `main` instance (always-running main instance on port 8100)
3. For each workspace instance:
   - Reads the `last-access` timestamp file
   - Calculates days since last access
   - If idle > 3 days:
     - Stops the systemd service
     - Archives the instance data to `~/.code-workspaces/archives/<instance-name>-<timestamp>.tar.gz`
     - Removes the instance directory
     - Logs all actions

### Archived Workspaces

Archived workspaces are stored in `~/.code-workspaces/archives/` and can be restored manually if needed:

```bash
# List archived workspaces
ls -lh ~/.code-workspaces/archives/

# Restore an archived workspace
cd ~/.code-workspaces/instances/
tar -xzf ~/.code-workspaces/archives/workspace-name-20250115-120000.tar.gz

# Restart the workspace instance
systemctl --user start code-server-workspace@workspace-name.service
```

## Notes

- The proxy listens on `http://localhost:8080` by default
- Workspace instances bind to `127.0.0.1:<port>` where port is defined in each instance's metadata.json
- All workspace instances run under your user account
- Logs are stored both in systemd journal and in instance-specific log files
- The proxy automatically starts instances on-demand when accessed
- Idle workspaces (>3 days without access) are automatically archived and stopped daily at midnight
