# Code-Server Workspace Isolation Proxy - Documentation

## Overview

The code-server workspace isolation proxy is a reverse proxy that provides complete isolation between different workspaces and folders in code-server. Each workspace or folder you open gets its own dedicated code-server instance with:

- **Isolated browser storage** (localStorage, cookies, IndexedDB)
- **Separate user data** (settings, state, UI layout)
- **Independent extensions** (install once per workspace)
- **Dedicated resources** (2GB RAM, 2 CPU cores per instance)
- **Automatic lifecycle management** (cleanup after 3 days idle)

### Problem Solved

Code-server normally shares browser storage across all workspaces because they run on the same port. This causes:

- Settings bleeding between unrelated projects
- Extension state conflicts
- UI layout interference
- No true workspace isolation

This proxy solves these issues by routing each workspace to a separate port, giving each workspace complete browser isolation.

### Key Features

- **Transparent routing**: URL parameters determine instance routing
- **Automatic instance management**: Instances launch on-demand via systemd
- **Deterministic port assignment**: Same workspace always gets same port
- **Idle cleanup**: Automatic archival of unused instances after 3 days
- **Resource limits**: Per-instance memory and CPU quotas
- **Zero configuration**: Instances created automatically on first access

## Documentation Structure

### For Users

- **[Quick Start](#quick-start)**: Get running in 5 minutes
- **[DEPLOYMENT.md](DEPLOYMENT.md)**: Complete installation and configuration guide
- **[OPERATIONS.md](OPERATIONS.md)**: Daily usage, monitoring, and maintenance

### For Developers

- **[ARCHITECTURE.md](ARCHITECTURE.md)**: Technical architecture and design decisions
- **[systemd/README.md](../systemd/README.md)**: Systemd service configuration details

## Quick Start

### Access Modes

Once installed, access the proxy at `http://127.0.0.1:8083` with these modes:

#### 1. Open a Folder

```
http://127.0.0.1:8083/?folder=/absolute/path/to/folder
```

Opens code-server with the specified folder, isolated from other folders.

#### 2. Open a Workspace

```
http://127.0.0.1:8083/?workspace=/absolute/path/to/file.code-workspace
```

Opens code-server with the specified workspace file, isolated from other workspaces.

#### 3. Open Empty Window

```
http://127.0.0.1:8083/?ew=true
```

Opens code-server without any folder or workspace (bare mode).

#### 4. Default Access

```
http://127.0.0.1:8083/
```

Opens the main instance (equivalent to empty window).

### Installation Summary

```bash
# 1. Clone repository
cd ~/src/other
git clone <repository-url> code-server-proxy
cd code-server-proxy

# 2. Install dependencies
npm install

# 3. Configure and install systemd services
# (Edit paths in service files first)
mkdir -p ~/.config/systemd/user
cp systemd/*.service systemd/*.timer ~/.config/systemd/user/
# Edit service files to match your system paths
$EDITOR ~/.config/systemd/user/code-server-proxy.service
$EDITOR ~/.config/systemd/user/code-server-workspace@.service
$EDITOR ~/.config/systemd/user/workspace-idle-monitor.service

# 4. Start services
systemctl --user daemon-reload
systemctl --user enable --now code-server-proxy.service
systemctl --user enable --now workspace-idle-monitor.timer

# 5. Access in browser
# http://127.0.0.1:8083/?folder=/path/to/your/project
```

For detailed installation instructions, see [DEPLOYMENT.md](DEPLOYMENT.md).

## Common Operations

### Check System Status

```bash
# Check proxy status
systemctl --user status code-server-proxy.service

# List running instances
systemctl --user list-units 'code-server-workspace@*'

# View proxy logs
journalctl --user -u code-server-proxy.service -f
```

### Manage Instances

```bash
# Stop a specific instance
systemctl --user stop code-server-workspace@workspace-a1b2c3d4.service

# Restart proxy
systemctl --user restart code-server-proxy.service

# View instance directories
ls -la ~/.code-workspaces/instances/
```

### Monitor Resources

```bash
# Check memory usage
systemctl --user status 'code-server-workspace@*' | grep Memory

# Check disk space
du -sh ~/.code-workspaces/instances/

# View archives
ls -lh ~/.code-workspaces/archives/
```

For complete operations documentation, see [OPERATIONS.md](OPERATIONS.md).

## Architecture Overview

### High-Level Design

```
Browser (http://127.0.0.1:8083/?workspace=/path)
    ↓
Proxy Server (port 8083)
    ↓ Routes based on URL parameters
    ↓
    ├─→ Port 8100: Main instance (bare/default)
    ├─→ Port 8101-8199: Workspace/folder instances
    │   (Port determined by SHA-256 hash of path)
    ↓
Code-Server Instances (managed by systemd)
    ↓
~/.code-workspaces/instances/
    ├─ main/
    ├─ workspace-a1b2c3d4/
    └─ workspace-e5f6g7h8/
```

### Key Components

- **Proxy Server** (`src/proxy.js`): Routes requests, manages instances
- **Systemd Services**: Launch and monitor code-server instances
- **Instance Launcher** (`scripts/launch-workspace-instance.sh`): Starts instances with correct configuration
- **Idle Monitor** (`scripts/workspace-idle-monitor.sh`): Archives idle instances

### Port Assignment

Each workspace/folder gets a deterministic port:

```javascript
hash = SHA256(workspace_path);
port = 8101 + (hash % 99); // Results in 8101-8199
```

This ensures:

- Same workspace always routes to same port
- Consistent behavior across proxy restarts
- No port assignment state to maintain

For complete architecture details, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Configuration Reference

### Default Configuration

| Setting            | Default Value                   | Location                                 |
| ------------------ | ------------------------------- | ---------------------------------------- |
| Proxy Port         | 8083                            | `src/proxy.js`                           |
| Main Instance Port | 8100                            | `src/proxy.js`                           |
| Workspace Ports    | 8101-8199                       | `src/proxy.js`                           |
| Memory Limit       | 2GB per instance                | `systemd/code-server-workspace@.service` |
| CPU Limit          | 200% per instance               | `systemd/code-server-workspace@.service` |
| Idle Timeout       | 3 days                          | `scripts/workspace-idle-monitor.sh`      |
| Cleanup Schedule   | Daily                           | `systemd/workspace-idle-monitor.timer`   |
| Instance Directory | `~/.code-workspaces/instances/` | `src/proxy.js`                           |
| Archive Directory  | `~/.code-workspaces/archives/`  | `scripts/workspace-idle-monitor.sh`      |

### Customization

To customize settings, edit the relevant files and restart services:

```bash
# After editing configuration
systemctl --user daemon-reload
systemctl --user restart code-server-proxy.service
```

## Troubleshooting

### Proxy Won't Start

```bash
# Check status
systemctl --user status code-server-proxy.service

# View detailed logs
journalctl --user -u code-server-proxy.service -n 50

# Common fixes
- Verify Node.js path in service file
- Check port 8083 is available
- Ensure XDG_RUNTIME_DIR is set correctly
```

### Instance Won't Launch

```bash
# Check specific instance
systemctl --user status code-server-workspace@workspace-a1b2c3d4.service

# Common fixes
- Verify launch script path in template service
- Check workspace path exists and is readable
- Ensure code-server is installed
```

### "Bad Gateway" Error

```bash
# Instance failed to start or crashed
journalctl --user -u code-server-workspace@workspace-a1b2c3d4.service

# Try manual restart
systemctl --user restart code-server-workspace@workspace-a1b2c3d4.service
```

For comprehensive troubleshooting, see [DEPLOYMENT.md](DEPLOYMENT.md#troubleshooting).

## System Requirements

- **Operating System**: Linux with systemd
- **Node.js**: Version 18.0.0 or higher
- **code-server**: Any recent version
- **Memory**: 4GB minimum (2GB per instance + system overhead)
- **CPU**: Multi-core recommended
- **Disk**: Space for instance data in `~/.code-workspaces/`

## Security Considerations

- **Network**: Proxy binds to `127.0.0.1` only (localhost)
- **Authentication**: Delegated to code-server's built-in auth
- **Isolation**: Browser storage isolated by port, processes isolated by systemd
- **File System**: No isolation (all instances run as same user)

For production deployments with multiple users, additional security measures are recommended.

See [ARCHITECTURE.md](ARCHITECTURE.md#security-considerations) for details.

## Performance Characteristics

- **Proxy Overhead**: <5ms per request
- **Instance Startup**: 3-10 seconds (first access to workspace)
- **Memory Usage**: ~50MB proxy + ~200MB-2GB per instance
- **Concurrent Instances**: Recommended 5-8 on typical system
- **Maximum Instances**: 99 (port range limit)

## Getting Help

### Documentation

1. Start with [DEPLOYMENT.md](DEPLOYMENT.md) for installation
2. Read [OPERATIONS.md](OPERATIONS.md) for daily usage
3. Consult [ARCHITECTURE.md](ARCHITECTURE.md) for technical details

### Common Issues

- **Port conflicts**: Check ports 8083, 8100-8199 are available
- **Systemd issues**: Ensure user systemd instance is enabled
- **Path problems**: Always use absolute paths in URL parameters
- **Resource limits**: Adjust if instances are slow or OOM

### Logs

```bash
# Proxy logs
journalctl --user -u code-server-proxy.service -f

# Instance logs
journalctl --user -u code-server-workspace@<instance-name>.service -f

# Or view log files directly
tail -f ~/.code-workspaces/instances/workspace-a1b2c3d4/logs/stdout.log
```

## Examples

### Example: Opening Multiple Projects

```bash
# Project 1: Web app
http://127.0.0.1:8083/?folder=/home/user/projects/webapp

# Project 2: API server
http://127.0.0.1:8083/?folder=/home/user/projects/api

# Project 3: Documentation
http://127.0.0.1:8083/?folder=/home/user/projects/docs
```

Each project gets its own isolated instance with separate:

- Settings and preferences
- Installed extensions
- Editor state and layout
- Browser storage (localStorage, cookies)

### Example: Using Workspace Files

```bash
# Multi-folder workspace
http://127.0.0.1:8083/?workspace=/home/user/projects/monorepo.code-workspace
```

The workspace file might contain:

```json
{
  "folders": [
    { "path": "packages/frontend" },
    { "path": "packages/backend" },
    { "path": "packages/shared" }
  ],
  "settings": {
    "editor.fontSize": 14
  }
}
```

This entire multi-folder workspace runs in its own isolated instance.

### Example: Bookmarking Workspaces

Since the same workspace always routes to the same port, you can bookmark URLs:

```
Bookmarks:
- Work Project A: http://127.0.0.1:8083/?folder=/home/user/work/project-a
- Personal Blog: http://127.0.0.1:8083/?folder=/home/user/personal/blog
- Notes: http://127.0.0.1:8083/?folder=/home/user/Documents/notes
```

## Contributing

This is a single-user utility focused on workspace isolation. Key areas for contribution:

- Cross-platform support (currently Linux/systemd only)
- Collision handling for hash-based port assignment
- Log rotation for instance logs
- Web UI for instance management
- Enhanced monitoring and metrics

## License

MIT

## Version

Version 1.0.0 - Initial release with core isolation features.
