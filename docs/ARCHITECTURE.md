# Code-Server Workspace Isolation Proxy - Architecture

## System Overview

The code-server workspace isolation proxy is a reverse proxy that provides workspace isolation by routing requests to separate code-server instances. Each workspace or folder gets its own isolated instance with dedicated port, storage, and browser state.

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          Browser                                 │
│  http://127.0.0.1:8083/?workspace=/path/to/workspace            │
└─────────────────┬───────────────────────────────────────────────┘
                  │
                  │ HTTP/WebSocket
                  ▼
┌─────────────────────────────────────────────────────────────────┐
│              Proxy Server (Port 8083)                            │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Request Handler                                           │  │
│  │  • Parse URL parameters (workspace/folder/ew)            │  │
│  │  • Compute instance name & port (SHA-256 hash)           │  │
│  │  • Check if instance exists/running                      │  │
│  │  • Launch instance if needed (via systemd)               │  │
│  │  • Wait for instance to be ready                         │  │
│  │  • Update last-access timestamp                          │  │
│  └──────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Proxy Handler                                             │  │
│  │  • Forward HTTP requests to backend                      │  │
│  │  • Forward WebSocket upgrades                            │  │
│  │  • Rewrite redirect Location headers                     │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────┬───────────────────────────────────────────────┘
                  │
                  │ Routes to appropriate port
                  │
        ┌─────────┼─────────┬─────────────┬─────────────┐
        ▼         ▼         ▼             ▼             ▼
    ┌──────┐ ┌──────┐ ┌──────┐       ┌──────┐     ┌──────┐
    │ 8100 │ │ 8142 │ │ 8167 │  ...  │ 8199 │     │ ...  │
    └──┬───┘ └──┬───┘ └──┬───┘       └──┬───┘     └──┬───┘
       │        │        │              │            │
    ┌──▼────┐┌─▼─────┐┌─▼─────┐    ┌──▼─────┐  ┌──▼─────┐
    │ Main  ││Folder ││Workspace│   │Folder  │  │Workspace│
    │Instance││  A   ││   B    │   │  C     │  │   D    │
    └───────┘└──────┘└────────┘    └────────┘  └────────┘
       │        │        │              │            │
    ┌──▼────────▼────────▼──────────────▼────────────▼───┐
    │           Systemd User Instance                     │
    │  • Manages code-server processes                    │
    │  • Applies resource limits (4GB RAM, 300% CPU)      │
    │  • Handles automatic restarts                       │
    │  • Captures logs                                    │
    └────────────────────────────────────────────────────┘
       │        │        │              │            │
    ┌──▼────┐┌─▼─────┐┌─▼─────┐    ┌──▼─────┐  ┌──▼─────┐
    │ main/ ││ws-a1b2││ws-e5f6││   │ws-x9y8 │  │ws-m3n4 │
    │       ││  /    ││  /    ││   │  /     │  │  /     │
    │ data  ││ data  ││ data  ││   │ data   │  │ data   │
    │ ext   ││ ext   ││ ext   ││   │ ext    │  │ ext    │
    │ logs  ││ logs  ││ logs  ││   │ logs   │  │ logs   │
    └───────┘└───────┘└───────┘    └────────┘  └────────┘
              ~/.code-workspaces/instances/
```

## Docker-Based Architecture

Starting with version 2.0, the system supports Docker-based isolation as an alternative to systemd. Docker mode provides complete IPC namespace isolation, solving the terminal stealing problem that affects systemd mode.

### Docker Mode Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                          Browser                                 │
│  http://127.0.0.1:8083/?workspace=/path/to/workspace            │
└─────────────────┬───────────────────────────────────────────────┘
                  │
                  │ HTTP/WebSocket
                  ▼
┌─────────────────────────────────────────────────────────────────┐
│              Proxy Server (Port 8083)                            │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Request Handler                                           │  │
│  │  • Parse URL parameters (workspace/folder/ew)            │  │
│  │  • Compute instance name & port (SHA-256 hash)           │  │
│  │  • Check if container exists/running                     │  │
│  │  • Launch container if needed (via Docker API)           │  │
│  │  • Wait for instance to be ready                         │  │
│  │  • Update last-access timestamp                          │  │
│  └──────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Container Manager (src/container-manager.js)             │  │
│  │  • Create/start/stop Docker containers                   │  │
│  │  • Manage Docker volumes (config, extensions)            │  │
│  │  • Volume migration from systemd                         │  │
│  │  • Backup/restore operations                             │  │
│  │  • Idle monitoring and cleanup                           │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────┬───────────────────────────────────────────────┘
                  │
                  │ Routes to appropriate port
                  │
        ┌─────────┼─────────┬─────────────┬─────────────┐
        ▼         ▼         ▼             ▼             ▼
    ┌──────┐ ┌──────┐ ┌──────┐       ┌──────┐     ┌──────┐
    │ 8100 │ │ 8142 │ │ 8167 │  ...  │ 8199 │     │ ...  │
    └──┬───┘ └──┬───┘ └──┬───┘       └──┬───┘     └──┬───┘
       │        │        │              │            │
  ┌────▼────┐┌─▼──────┐┌▼───────┐  ┌──▼──────┐ ┌──▼──────┐
  │Container││Container││Container│ │Container│ │Container│
  │  Main   ││Workspace││Workspace│ │Workspace│ │Workspace│
  │         ││   A     ││   B     │ │   C     │ │   D     │
  └────┬────┘└─┬──────┘└┬───────┘  └──┬──────┘ └──┬──────┘
       │        │        │              │            │
  ┌────▼────────▼────────▼──────────────▼────────────▼─────┐
  │                  Docker Engine                          │
  │  • IPC namespace isolation (solves terminal stealing)   │
  │  • Resource limits (4GB RAM, 3.0 CPU cores)            │
  │  • Automatic restarts                                   │
  │  • Health monitoring                                    │
  └────────────────────┬────────────────────────────────────┘
                       │
       ┌───────────────┼────────────────┬──────────────┐
       │               │                │              │
  ┌────▼───┐     ┌────▼───┐      ┌─────▼────┐   ┌────▼────┐
  │Volume  │     │Volume  │      │Volume    │   │Volume   │
  │ main   │     │ws-a1b2 │      │ws-e5f6   │   │ws-x9y8  │
  │-config │     │-config │      │-config   │   │-config  │
  └────────┘     └────────┘      └──────────┘   └─────────┘
       │               │                │              │
  ┌────▼───┐     ┌────▼───┐      Shared Extensions Volume
  │Workspace     │Workspace       (bind mounted)
  │ mount   │     │ mount  │      ~/.code-workspaces/shared/
  └─────────┘    └─────────┘
```

### Docker Components

#### Container Manager (`src/container-manager.js`)

The Container Manager provides programmatic access to Docker operations:

**Key Functions**:

- `createContainer(instanceId, workspacePath, port)`: Creates and starts a new container
- `startContainer(instanceId)`: Starts an existing stopped container
- `stopContainer(instanceId)`: Gracefully stops a running container
- `removeContainer(instanceId)`: Removes a stopped container
- `isContainerRunning(instanceId)`: Checks if container is running
- `getContainerInfo(instanceId)`: Retrieves container metadata
- `migrateToVolume(instanceId)`: Migrates systemd user-data-dir to Docker volume
- `backupVolume(instanceId, backupPath)`: Creates tar.gz backup of volume
- `restoreVolume(instanceId, backupPath)`: Restores volume from backup
- `stopIdleContainers(thresholdDays)`: Stops containers idle > threshold
- `cleanupIdleContainers(gracePeriodDays)`: Removes containers stopped > grace period

**Container Configuration**:

```javascript
{
  Image: 'code-server-proxy:latest',
  name: `code-server-${instanceId}`,
  Hostname: `workspace-${instanceId.substring(0, 12)}`,
  ExposedPorts: { [`${port}/tcp`]: {} },
  HostConfig: {
    PortBindings: {
      [`${port}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(port) }]
    },
    Binds: [
      `${workspacePath}:/workspace:rw`,
      `${SHARED_EXTENSIONS_VOLUME}:/config/extensions`,
      `${HOST_SECRETS_PATH}:/host-secrets:ro`,
      `${SHARED_SETTINGS_PATH}/settings.json:/config/data/User/settings.json:rw`,
      `${SHARED_SETTINGS_PATH}/keybindings.json:/config/data/User/keybindings.json:rw`
    ],
    Mounts: [{
      Type: 'volume',
      Source: `code-server-${instanceId}-config`,
      Target: '/config'
    }],
    Memory: 4 * 1024 * 1024 * 1024,  // 4GB
    NanoCpus: 3 * 1000000000,         // 3.0 cores
    CapAdd: ['IPC_LOCK'],             // For gnome-keyring
    RestartPolicy: { Name: 'unless-stopped' }
  },
  Labels: {
    'app': 'code-server-proxy',
    'workspace': workspacePath,
    'instance-id': instanceId
  }
}
```

#### Docker Image (`docker/code-server/Dockerfile`)

Custom image based on `linuxserver/code-server` with:

**Additional Packages**:

- `gnome-keyring`: Secrets storage for extensions
- `dbus`: IPC for keyring daemon
- `libsecret-1-0`: Secret storage library

**S6 Overlay Services**:

- `50-gnome-keyring`: Initializes gnome-keyring daemon at startup
- `51-sync-secrets`: One-time sync from host keyring (if available)
- `gnome-keyring/run`: Keeps gnome-keyring daemon running

**Environment Variables**:

- `PUID=1000`, `PGID=1000`: User/group IDs
- `DBUS_SESSION_BUS_ADDRESS`: D-Bus socket path
- `GNOME_KEYRING_CONTROL`: Keyring control directory

### Docker Volume Strategy

#### Per-Instance Config Volumes

Each instance has a dedicated Docker volume for user data:

```
code-server-<instance-id>-config/
├── data/
│   └── User/             # Contains settings.json and keybindings.json
│                         # (mounted from host shared files)
├── Machine/              # Machine-specific data
├── logs/                 # code-server logs
├── workspace-storage/    # Workspace state
└── globalStorage/        # Extension storage
```

**Creation**: Automatically created on first container start
**Lifecycle**: Persists across container removals
**Backup**: Via `backupVolume()` to tar.gz
**Cleanup**: Removed after grace period (7+ days stopped)

#### Shared Extensions Volume

All instances share a single extensions directory:

```
~/.code-workspaces/shared/extensions/
├── ms-python.python-*/
├── esbenp.prettier-vscode-*/
└── ...
```

**Mount**: Bind mount at `/config/extensions` in all containers
**Benefits**: Single installation serves all instances
**Trade-off**: Extension conflicts possible

#### Shared Settings Files

Settings and keybindings are shared across all containers via individual file mounts:

```
~/.code-workspaces/shared/User/
├── settings.json        # Global VSCode settings
└── keybindings.json     # Keyboard shortcuts
```

**Mount**: Individual file bind mounts at `/config/data/User/` in containers
**Benefits**:

- Single source of truth for user preferences
- Changes immediately visible in all containers
- Read-write access allows updates from any container
  **Trade-off**: Cannot have per-container user settings variations

#### Workspace Bind Mounts

Workspace directories mounted directly from host:

```
Host: /path/to/workspace
Container: /workspace
```

**Permissions**: Read-write
**Performance**: Native (no volume overhead)
**Isolation**: None (intentional - same files across instances)

### IPC Namespace Isolation

Docker mode provides complete IPC namespace isolation, solving the terminal stealing problem:

**Problem in Systemd Mode**:

- All code-server instances share IPC namespace
- Terminal reconnection uses shared IPC
- Wrong instance can "steal" terminal connection
- Causes confusing terminal behavior

**Solution in Docker Mode**:

- Each container has separate IPC namespace
- Terminals isolated per container
- No cross-instance communication
- Safe to enable terminal persistence

**Technical Details**:

```bash
# Each container has isolated:
/dev/pts/*          # Pseudo-terminals
/dev/shm/*          # Shared memory
POSIX message queues
Semaphores
```

### gnome-keyring Integration

Docker containers run gnome-keyring daemon for secrets storage:

**Initialization Flow**:

1. Container starts → S6 runs `50-gnome-keyring`
2. Start D-Bus session bus
3. Initialize keyring: `gnome-keyring-daemon --start --components=secrets`
4. Export control socket to `/run/user/1000/keyring/`
5. Run `51-sync-secrets` if host secrets exist
6. S6 service `gnome-keyring/run` keeps daemon alive

**Secrets Sync** (one-time):

On first container start, can copy secrets from host:

```bash
# Host keyring location:
~/.local/share/keyrings/

# Synced to container volume:
/config/.local/share/keyrings/
```

**After sync**: Container keyring is independent, changes not synced back.

**Capabilities**: Container needs `IPC_LOCK` for keyring memory locking.

### Port Assignment (Docker Mode)

Same deterministic port assignment as systemd mode:

```javascript
hash = SHA256(workspacePath);
port = 8101 + (parseInt(hash.substring(0, 8), 16) % 99);
```

**Port mapping**: Container port → Host port (same number)
**Example**: Container port 8142 → Host 127.0.0.1:8142

### Dual-Mode Support

The proxy supports both Docker and systemd backends:

**Mode Selection**:

```javascript
const USE_DOCKER = process.env.USE_DOCKER === 'true';
```

**Mode Detection**:

- Proxy: Reads `USE_DOCKER` environment variable
- Idle monitor: Auto-detects based on running containers vs systemd units

**Migration Path**:

1. Start in systemd mode
2. Migrate workspaces to Docker (via migration scripts)
3. Enable Docker mode (`USE_DOCKER=true`)
4. Existing workspaces continue in systemd, new ones use Docker
5. Gradually migrate all workspaces
6. Disable systemd mode

### Container Lifecycle

**Creation** (on first access):

1. Proxy receives request for workspace
2. Container Manager checks if container exists
3. If not, creates container with volumes and mounts
4. Starts container
5. Waits for health check (code-server responding)
6. Updates `last-access` timestamp
7. Proxies request to container

**Idle Monitoring**:

1. Timer triggers idle monitor script
2. Script detects Docker mode
3. Calls `stopIdleContainers(3)` - stops containers idle >3 days
4. Calls `cleanupIdleContainers(7)` - removes containers stopped >7 days
5. Before removal, creates volume backup to `~/.code-workspaces/volumes/`

**Restart** (container stopped):

1. Proxy receives request for workspace
2. Container exists but not running
3. Container Manager starts existing container
4. Waits for health check
5. Proxies request

### Resource Limits (Docker Mode)

Per-container limits enforced by Docker:

| Resource | Limit     | Setting                         |
| -------- | --------- | ------------------------------- |
| Memory   | 4GB       | `Memory: 4 * 1024^3`            |
| CPU      | 3.0 cores | `NanoCpus: 3 * 10^9`            |
| Swap     | 0 (none)  | `MemorySwap: 4 * 1024^3`        |
| Restart  | Always    | `RestartPolicy: unless-stopped` |

**Monitoring**:

```bash
docker stats --no-stream code-server-<instance-id>
```

**Advantages over systemd**:

- Stricter enforcement
- Better memory accounting
- Network isolation options
- Easier to adjust per-container

### Volume Migration from Systemd

The `migrateToVolume()` function handles migration:

**Process**:

1. Create new Docker volume for instance
2. Start temporary container with volume mounted
3. Copy systemd user-data-dir to volume
4. Stop temporary container
5. Archive original systemd directory
6. Update metadata with `backend: "docker"`

**Data Preserved**:

- User settings and preferences
- Extension data
- Workspace state (open files, layout)
- Editor UI state
- Terminal history

**Data Not Migrated**:

- Logs (archived separately)
- Temporary files
- Cache directories

### Component Relationships

```
Proxy Server (src/proxy.js)
  │
  ├─── Uses: http-proxy library
  ├─── Manages: Instance lifecycle via systemd
  ├─── Reads/Writes: Instance metadata and last-access files
  └─── Controls: Port assignment and routing

Systemd Services
  │
  ├─── code-server-proxy.service (Proxy daemon)
  ├─── code-server-workspace@.service (Instance template)
  └─── workspace-idle-monitor.{service,timer} (Cleanup automation)

Scripts
  │
  ├─── launch-workspace-instance.sh (Instance launcher)
  └─── workspace-idle-monitor.sh (Idle cleanup)

Storage
  │
  └─── ~/.code-workspaces/
       ├─── port-registry.json (Port allocation registry)
       ├─── shared/ (Shared extensions and settings)
       │    ├─── extensions/
       │    └─── User/
       ├─── instances/ (Active instances)
       └─── archives/ (Archived instances)
```

### Data Flow

1. **Request Arrival**: Browser sends request to proxy (port 8083)
2. **Parameter Parsing**: Extract workspace/folder/ew from URL
3. **Instance Resolution**: Compute instance name and port via hash
4. **Instance Check**: Verify instance directory exists and is running
5. **Instance Launch**: Start via systemd if not running
6. **Readiness Wait**: Poll backend port until ready (max 30s)
7. **Timestamp Update**: Write current time to last-access file
8. **Request Proxy**: Forward to backend code-server instance
9. **Response Handling**: Rewrite redirects, forward to browser

## Components

### Proxy Server (`src/proxy.js`)

The core proxy server implemented in Node.js.

#### Key Functions

**`computePort(workspacePath)`** (lines 117-125)

- Computes deterministic port from workspace path
- Uses SHA-256 hash of path
- Maps to range 8101-8199 (99 ports)
- Ensures same workspace always gets same port

```javascript
hash = SHA256(workspacePath)
numericHash = parseInt(hash[0:8], 16)  // First 8 hex chars
port = 8101 + (numericHash % 99)       // Range: 8101-8199
```

**`computeInstanceId(workspacePath)`** (lines 132-138)

- Computes instance directory name from workspace path
- Uses full SHA-256 hash (64 characters)
- Format: `workspace-<full-hash>`
- Example: `workspace-abc123def456...` (64 hex chars)

**`createInstanceDirectory(instanceId, workspacePath, port)`** (lines 156-175)

- Creates instance directory structure
- Creates subdirectories: `data/`, `extensions/`, `logs/`
- Writes `metadata.json` with instance configuration
- Called automatically on first access to new workspace

**`updateLastAccess(instanceId)`** (lines 181-186)

- Writes ISO 8601 timestamp to `last-access` file
- Called on every HTTP request and WebSocket upgrade
- Used by idle monitor to determine cleanup candidates

**`isPortListening(port)`** (lines 193-219)

- Checks if a port is accepting connections
- Makes HTTP GET request to `/healthz`
- Returns true if response received (any status code)
- Used to detect if instance is ready

**`waitForBackend(port, timeout)`** (lines 227-238)

- Polls port until ready or timeout
- Default timeout: 30 seconds
- Poll interval: 500ms
- Returns true if backend becomes ready

**`launchInstance(instanceId)`** (lines 245-256)

- Starts systemd service for instance
- Service name: `code-server-workspace@<instanceId>.service`
- Uses `systemctl --user start`
- Throws error if systemd command fails

**`parseUrlParams(urlString)`** (lines 263-277)

- Extracts query parameters from URL
- Returns object with: `workspace`, `folder`, `ew`, `searchParams`, `pathname`
- Handles URL parsing errors gracefully

**`handleRequest(req, res)`** (lines 301-474)

- Main request handler
- Routing logic:
  - `ew=true` → Main instance (port 8100)
  - `workspace=...` → Workspace instance (hash-based port)
  - `folder=...` → Folder instance (hash-based port)
  - No params → Main instance (port 8100)
- Validates paths are absolute
- Ensures instance exists and is running
- Updates last-access timestamp
- Proxies request to backend

**`handleUpgrade(req, socket, head)`** (lines 482-527)

- Handles WebSocket upgrade requests
- Same routing logic as HTTP requests
- Updates last-access timestamp
- Proxies WebSocket connection to backend

**Redirect Rewriting** (lines 52-110)

- Intercepts 3xx redirect responses
- Strips workspace/folder parameters that match original routing
- Prevents redirect loops while preserving cross-instance redirects
- Only strips parameters if they match the ones used for routing

#### Configuration Constants (lines 22-34)

| Constant                      | Value                          | Description                         |
| ----------------------------- | ------------------------------ | ----------------------------------- |
| `PROXY_PORT`                  | 8083                           | Proxy listening port                |
| `PROXY_HOST`                  | 127.0.0.1                      | Proxy bind address (localhost only) |
| `MAIN_PORT`                   | 8100                           | Main/default instance port          |
| `WORKSPACE_PORT_MIN`          | 8101                           | Start of workspace port range       |
| `WORKSPACE_PORT_MAX`          | 8199                           | End of workspace port range         |
| `BASE_DIR`                    | `~/.code-workspaces/instances` | Instance storage directory          |
| `BACKEND_READY_TIMEOUT`       | 30000                          | Max wait for backend (30s)          |
| `BACKEND_READY_POLL_INTERVAL` | 500                            | Poll interval (500ms)               |

### Systemd Services

#### Proxy Service (`code-server-proxy.service`)

Runs the proxy server as a user systemd service.

```ini
[Unit]
Description=Code-Server Workspace Isolation Proxy
After=network.target

[Service]
Type=simple
ExecStart=/path/to/node /path/to/proxy.js
WorkingDirectory=/path/to/code-server-proxy
Restart=on-failure
RestartSec=5s
Environment=NODE_ENV=production
Environment=XDG_RUNTIME_DIR=/run/user/UID
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

Key features:

- Runs continuously (`Type=simple`)
- Auto-restarts on failure with 5s delay
- Logs to systemd journal
- Requires `XDG_RUNTIME_DIR` for user systemd

#### Workspace Template Service (`code-server-workspace@.service`)

Template service for launching workspace instances. The `@` makes it a template - systemd instantiates it with the instance name.

```ini
[Unit]
Description=Code-Server Workspace Instance - %i
After=network.target

[Service]
Type=simple
ExecStart=/path/to/launch-workspace-instance.sh %i
WorkingDirectory=/home/user/.code-workspaces/instances/%i
Restart=on-failure
RestartSec=10s
StandardOutput=append:/home/user/.code-workspaces/instances/%i/logs/stdout.log
StandardError=append:/home/user/.code-workspaces/instances/%i/logs/stderr.log
MemoryMax=4G
CPUQuota=300%

[Install]
WantedBy=default.target
```

Template variables:

- `%i`: Instance ID (e.g., `main`, `workspace-abc123def456...`)

Resource limits:

- `MemoryMax=4G`: Maximum 4GB RAM per instance
- `CPUQuota=300%`: Maximum 3 CPU cores (300%)

Log management:

- Appends to instance-specific log files
- Logs persist across restarts
- Located in instance's `logs/` directory

#### Idle Monitor Service (`workspace-idle-monitor.service`)

One-shot service that runs the cleanup script.

```ini
[Unit]
Description=Idle workspace monitor for code-server instances

[Service]
Type=oneshot
ExecStart=/path/to/workspace-idle-monitor.sh
StandardOutput=journal
StandardError=journal
```

- `Type=oneshot`: Runs once and exits
- Triggered by timer (not run directly)
- Logs to journal

#### Idle Monitor Timer (`workspace-idle-monitor.timer`)

Timer that schedules cleanup runs.

```ini
[Unit]
Description=Daily cleanup of idle code-server workspace instances

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
```

- `OnCalendar=daily`: Runs once per day
- `Persistent=true`: Runs missed executions on boot
- Managed independently of proxy

### Scripts

#### Instance Launcher (`scripts/launch-workspace-instance.sh`)

Launched by systemd to start code-server instances.

**Input**: Instance name as first argument

**Process**:

1. Read instance metadata from `metadata.json`
2. Extract port and workspace path
3. Launch code-server with appropriate arguments
4. For main instance (null workspace): Launch without path
5. For workspace instances: Launch with workspace path
6. Create symlinks to shared extensions and User settings directories

**Code-server arguments**:

- `--bind-addr 127.0.0.1:$PORT`: Listen on specific port
- `--user-data-dir $INSTANCE_DIR/data`: Isolated user data
- `--extensions-dir ~/.code-workspaces/shared/extensions`: Shared extensions (via symlink)
- `$WORKSPACE_PATH`: Workspace/folder to open (if not main)

**JSON parsing**: Uses `jq` if available, falls back to `grep` regex

#### Idle Monitor (`scripts/workspace-idle-monitor.sh`)

Cleans up idle workspace instances.

**Configuration**:

- `IDLE_THRESHOLD_DAYS=3`: Instances idle >3 days are archived
- Runs on all instances except `main`

**Process**:

1. Iterate through all instance directories
2. Skip main instance
3. Read last-access timestamp from `last-access` file
4. Calculate idle time in days
5. If idle > threshold:
   - Stop systemd service
   - Archive instance to `.tar.gz`
   - Remove instance directory

**Archive naming**: `<instance-name>-<YYYYMMDD>-<HHMMSS>.tar.gz`

**Fallback**: If `last-access` file missing or invalid, uses directory mtime

## Request Flow

### Standard Request Flow

```
1. Browser Request
   http://127.0.0.1:8083/?workspace=/path/to/workspace
   │
   ▼
2. Proxy: parseUrlParams()
   Extracts: workspace=/path/to/workspace
   │
   ▼
3. Proxy: computePort() & computeInstanceName()
   workspace_path = "/path/to/workspace"
   hash = SHA256(workspace_path) = "abc123def456..." (64 chars)
   instance_id = "workspace-abc123def456..." (full hash)
   port = 8101 + (hash % 99) = 8142
   │
   ▼
4. Proxy: Check instance exists
   ls ~/.code-workspaces/instances/workspace-abc123def456...
   │
   ├─── Not exists → createInstanceDirectory()
   │    Creates: data/, extensions/, logs/, metadata.json
   │
   └─── Exists → Continue
   │
   ▼
5. Proxy: Check if running
   isPortListening(8142)
   │
   ├─── Not listening → launchInstance()
   │    systemctl --user start code-server-workspace@workspace-abc123def456...service
   │    │
   │    ▼
   │    Systemd: launch-workspace-instance.sh workspace-abc123def456...
   │    │
   │    ▼
   │    code-server --bind-addr 127.0.0.1:8142 \
   │                --user-data-dir ~/.code-workspaces/instances/workspace-abc123def456.../data \
   │                --extensions-dir ~/.code-workspaces/shared/extensions \
   │                /path/to/workspace
   │    │
   │    ▼
   │    waitForBackend(8142, 30000)
   │    Poll every 500ms until port responds or 30s timeout
   │
   └─── Already listening → Continue
   │
   ▼
6. Proxy: updateLastAccess()
   echo "2024-11-16T15:30:00.000Z" > ~/.code-workspaces/instances/workspace-abc123def456.../last-access
   │
   ▼
7. Proxy: Forward request
   http-proxy.web(req, res, {target: 'http://127.0.0.1:8142'})
   │
   ▼
8. Code-server instance handles request
   Serves VSCode UI, files, extensions
   │
   ▼
9. Response flows back through proxy to browser
```

### WebSocket Upgrade Flow

```
1. Browser WebSocket Request
   ws://127.0.0.1:8083/...?workspace=/path/to/workspace
   │
   ▼
2. Proxy: handleUpgrade()
   Same routing logic as HTTP
   │
   ▼
3. Proxy: updateLastAccess()
   │
   ▼
4. Proxy: Forward WebSocket upgrade
   http-proxy.ws(req, socket, head, {target: 'http://127.0.0.1:8142'})
   │
   ▼
5. Persistent WebSocket connection to backend
```

### Redirect Handling Flow

````
1. Backend issues redirect
   HTTP/1.1 302 Found
   Location: /?workspace=/path/to/workspace&other=param
   │
   ▼
2. Proxy: proxyRes handler intercepts
   Detects 3xx status code and Location header
   │
   ▼
3. Proxy: Parse original request params
   originalParams = {workspace: "/path/to/workspace"}
   │
   ▼
4. Proxy: Parse redirect location
   redirectUrl.searchParams.get("workspace") = "/path/to/workspace"
   │
   ▼
5. Proxy: Compare parameters
   If redirect workspace matches original workspace → Strip it
   Otherwise → Preserve (cross-instance redirect)
   │
   ▼
6. Proxy: Rewrite Location header
   Location: /?other=param
   │
## Port Registry

The port registry provides persistent, bidirectional mapping between ports and instance IDs, enabling collision resolution and instance discovery.

### Registry Structure

Location: `~/.code-workspaces/port-registry.json`

```json
{
  "portToInstance": {
    "8100": "main",
    "8142": "workspace-abc123def456...",
    "8167": "workspace-789abc012def..."
  },
  "instanceToPort": {
    "main": 8100,
    "workspace-abc123def456...": 8142,
    "workspace-789abc012def...": 8167
  }
}
````

### Collision Resolution Algorithm

When the preferred port (computed via hash) is unavailable:

1. **Check registry**: Is preferred port allocated to this instance?
   - Yes → Use that port (instance already registered)
   - No → Port collision detected

2. **Linear probing**: Try ports sequentially
   - Start: preferred port
   - Increment: +1 each attempt
   - Wrap: After 8199, continue at 8101
   - Max attempts: 20 (MAX_PROBE_ATTEMPTS)

3. **Allocation**: First available port found
   - Update registry with bidirectional mapping
   - Write registry to disk
   - Return allocated port

4. **Failure**: No port available after 20 attempts
   - Either: All ports occupied
   - Or: Maximum concurrent instances (30) reached
   - Throw error, refuse to launch

### Self-Healing Registry

On proxy startup, registry is validated and repaired:

1. **Load registry**: Read from disk (or create if missing)
2. **Check consistency**: Verify bidirectional mappings match
3. **Validate instances**: Check if instance directories still exist
4. **Remove stale entries**: Clean up mappings for deleted instances
5. **Save if modified**: Write repaired registry back to disk

This ensures registry stays synchronized with actual instance state.

### Registry Operations

**Allocate port**:

```javascript
const port = allocatePort(instanceId, workspacePath);
// Returns port number, updates registry
```

**Release port**:

```javascript
releasePort(instanceId);
// Removes mappings from registry
```

**Lookup port by instance**:

```javascript
const port = portRegistry.instanceToPort[instanceId];
```

**Lookup instance by port**:

```javascript
const instanceId = portRegistry.portToInstance[port];
```

## Shared Settings Architecture

Extensions and User settings are shared across all instances via symlinks, reducing disk usage and providing consistent environment.

### Shared Directory Structure

```
~/.code-workspaces/shared/
├── extensions/              # Shared extension storage
│   ├── ms-python.python-*/
│   ├── esbenp.prettier-vscode-*/
│   └── ...
└── User/                    # Shared user settings
    ├── settings.json        # Global settings
    ├── keybindings.json     # Keyboard shortcuts
    ├── snippets/            # Code snippets
    └── ...
```

### Symlink Creation

During instance launch (`launch-workspace-instance.sh`):

1. **Create shared directories** (if not exist):

   ```bash
   mkdir -p ~/.code-workspaces/shared/extensions
   mkdir -p ~/.code-workspaces/shared/User
   ```

2. **Create instance data directory**:

   ```bash
   mkdir -p ~/.code-workspaces/instances/<instance-id>/data
   ```

3. **Create symlinks inside instance data**:

   ```bash
   ln -s ~/.code-workspaces/shared/User \
         ~/.code-workspaces/instances/<instance-id>/data/User
   ```

4. **Launch code-server** with:
   ```bash
   code-server --user-data-dir <instance-dir>/data \
               --extensions-dir ~/.code-workspaces/shared/extensions
   ```

### What Gets Shared

**Extensions** (`--extensions-dir`):

- All installed extensions
- Extension data and storage
- One installation serves all instances

**User Settings** (via `data/User` symlink):

- `settings.json`: Global preferences
- `keybindings.json`: Keyboard shortcuts
- `snippets/`: User code snippets
- Other User-level configuration

### What Stays Isolated

**Workspace State** (inside `data/`, not symlinked):

- Workspace storage (open files, layout)
- Debug configurations (per-workspace)
- Terminal sessions
- Git state and history

**Logs** (instance-specific):

- `logs/stdout.log`
- `logs/stderr.log`

**Workspace Settings** (in project directory):

- `.vscode/settings.json`: Project-specific settings
- `.vscode/launch.json`: Debug configurations
- These are not in instance directory at all

### Benefits

1. **Disk savings**: Single extension installation vs per-instance
2. **Consistency**: Same extensions, settings, keybindings everywhere
3. **Convenience**: Configure once, applies to all workspaces
4. **Faster startup**: No need to re-install extensions per instance

### Trade-offs

1. **Extension conflicts**: All instances share extension state
2. **Settings inheritance**: Cannot have instance-specific User settings
   - Workaround: Use workspace settings in `.vscode/settings.json`
3. **Circular symlink risk**: Must ensure data/User doesn't already exist
   - Launch script handles this safely

   ▼

4. Browser receives modified redirect
   Prevents redirect loop

````

## Port Assignment

### Deterministic Hashing Algorithm

The port assignment algorithm ensures consistent routing:

```javascript
function computePort(workspacePath) {
  // 1. Hash the workspace path
  const hash = crypto.createHash('sha256').update(workspacePath).digest('hex');

  // 2. Convert first 8 hex chars to integer
  const numericHash = parseInt(hash.substring(0, 8), 16);

  // 3. Map to port range using modulo
  const portRange = WORKSPACE_PORT_MAX - WORKSPACE_PORT_MIN + 1; // 99
  return WORKSPACE_PORT_MIN + (numericHash % portRange);
}
````

### Properties

**Deterministic**: Same path always produces same port

- Enables consistent routing across proxy restarts
- No need to persist port assignments
- Browser can bookmark workspace URLs with confidence

**Distributed**: Paths hash to different ports

- 99 available ports (8101-8199)
- Low collision probability with typical workload
- Uniform distribution via cryptographic hash

**Collision Handling**: Linear probing with port registry

- Port registry maintains bidirectional mapping (port ↔ instance ID)
- On collision, uses linear probing to find next available port (max 20 attempts)
- Registry persisted to `~/.code-workspaces/port-registry.json`
- Self-healing: validates and repairs registry on startup
- Maximum concurrent instances: 30 (enforced limit)

### Example Port Assignments

```
/home/user/projects/app1                    → SHA256 → abc123... → 8142 (if available)
/home/user/projects/app2                    → SHA256 → def456... → 8167 (if available)
/home/user/Documents/notes                  → SHA256 → 789abc... → 8123 (if available)
/home/user/projects/app1.code-workspace     → SHA256 → 012def... → 8189 (if available)

If preferred port is taken, linear probing finds next available port.
```

Note: Workspace file and folder with same base path get different ports.

## Instance Isolation

### Directory Isolation

Each instance has separate directories:

```
~/.code-workspaces/instances/workspace-abc123def456.../
├── data/              # User data directory (settings, state, etc.)
│   └── User/          # → symlink to ~/.code-workspaces/shared/User/
├── extensions/        # → symlink to ~/.code-workspaces/shared/extensions/
├── logs/              # stdout/stderr logs
├── metadata.json      # Instance configuration
└── last-access        # Last access timestamp
```

**Shared vs Isolated**:

- **Shared** (via symlinks):
  - Extensions: Installed once, available to all instances
  - User settings: Settings, keybindings, snippets shared across instances
- **Isolated** (per-instance):
  - Workspace state: Open files, editor layout, debug configs
  - Logs: Per-instance stdout/stderr
  - Workspace settings: Project-specific `.vscode/settings.json`

### Resource Isolation

Systemd applies resource limits per-instance:

```ini
MemoryMax=4G      # Max 4GB RAM
CPUQuota=300%     # Max 3 CPU cores
```

**Implications**:

- One instance cannot consume all system resources
- Default config supports ~3-4 instances on 16GB system
- Limits can be adjusted per deployment

### Browser Storage Isolation

Browsers isolate storage by origin (protocol + host + port):

```
http://127.0.0.1:8100  → Origin A (main)
http://127.0.0.1:8142  → Origin B (workspace 1)
http://127.0.0.1:8167  → Origin C (workspace 2)
```

Each origin has separate:

- LocalStorage
- SessionStorage
- IndexedDB
- Cookies
- Cache

**Benefits**:

- Complete browser-side isolation
- No state leakage between workspaces
- Clean separation of concerns

### File System Isolation

**Not Provided**: Instances can access the same files if configured.

Example:

- Instance A opens `/home/user/projects/app`
- Instance B opens `/home/user/projects/app`
- Both access the same files on disk

This is intentional - allows multiple views of same project.

## Design Decisions

### Why Port-Based Isolation?

**Alternatives considered**:

1. URL path-based routing (`/workspace1/`, `/workspace2/`)
2. Subdomain-based routing (`ws1.local`, `ws2.local`)
3. Port-based routing (chosen)

**Port-based advantages**:

- Browser treats different ports as different origins
- Automatic storage isolation (localStorage, cookies, etc.)
- No special DNS or /etc/hosts configuration
- Simple proxy routing logic
- Works seamlessly with code-server's existing URL structure

**Trade-offs**:

- Limited to 99 concurrent instances (acceptable for single-user)
- Port-based URLs less clean than path-based
- Requires port range to be available

### Why Systemd for Process Management?

**Alternatives considered**:

1. Direct process spawning from proxy
2. PM2 or similar Node.js process manager
3. Systemd user instance (chosen)

**Systemd advantages**:

- Built-in resource limits (cgroups)
- Automatic restart on crash
- Log management (journald)
- Well-integrated with Linux systems
- Survives proxy restarts
- Service supervision without proxy overhead

**Trade-offs**:

- Linux-specific (not portable to Windows/Mac)
- Requires user systemd instance enabled
- More complex deployment than direct spawning

### Why Hash-Based Port Assignment?

**Alternatives considered**:

1. Sequential assignment (8101, 8102, 8103...)
2. Random assignment
3. Hash-based deterministic (chosen)

**Hash-based advantages**:

- Deterministic: Same workspace always gets same port
- No state to persist: Port computed from path each time
- Stable URLs: Can bookmark workspace URLs
- No coordination needed: Multiple proxies would assign same ports

**Trade-offs**:

- Collision possible (low probability with 99 ports)
- Port may seem "random" to users
- Cannot easily predict which port a workspace will use

### Redirect Loop Prevention Approach

**Problem**: code-server redirects to `/?workspace=...` which proxy must handle.

**Naive solution**: Always strip workspace/folder params → Creates loops

**Chosen solution**: Only strip params that match original routing

**How it works**:

```
Original request:    /?workspace=/path/A
Backend redirects:   /?workspace=/path/A   → Strip (same workspace)
Backend redirects:   /?workspace=/path/B   → Keep (different workspace)
```

This allows:

- Normal redirects within workspace → No loop
- Cross-workspace redirects → Correctly routed to different instance
- Extension-generated redirects → Preserved

## Performance Characteristics

### Latency

**Proxy overhead**: <5ms per request

- Simple hash computation
- Metadata file reads cached by OS
- http-proxy library is highly optimized

**Instance startup**: ~3-10 seconds

- code-server initialization time
- WebSocket connection establishment
- Extension activation

**Subsequent requests**: <1ms overhead

- No instance startup delay
- Direct proxy pass-through

### Memory

**Proxy process**: ~50MB baseline

- Node.js runtime
- http-proxy library
- Minimal state (no caching)

**Per instance**: ~200MB - 4GB

- code-server baseline: ~200MB
- Extensions: 50-500MB (shared across instances)
- Open files/projects: Varies
- Limit enforced: 4GB via systemd

**Total for 5 instances**: ~2GB typical, ~20GB max

### CPU

**Proxy process**: <1% during normal operation

- Spikes briefly during instance launches
- Minimal overhead for established connections

**Per instance**: Varies by workload

- Idle: <1%
- Active editing: 5-15%
- Language servers: 10-50% (TypeScript, etc.)
- Limit enforced: 300% (3 cores) via systemd

### Disk I/O

**Metadata operations**: Negligible

- Small JSON files
- Infrequent writes (last-access on each request)
- Cached by OS

**Instance storage**: Varies

- User data: 10-50MB typical
- Extensions: 50-500MB
- Logs: Grows unbounded (should rotate)

**Archives**: Compress well

- Typical instance: 50-200MB compressed
- Depends on installed extensions and data

## Scalability Limits

### Hard Limits

- **Maximum concurrent instances**: 30 (enforced), 99 (port range)
- **Maximum total instances**: Unlimited (limited by disk)
- **Proxy connections**: ~10,000 (Node.js default)

### Practical Limits

Assuming 16GB RAM, 8 CPU cores:

- **Recommended concurrent instances**: 3-4
  - 4GB RAM each = 12-16GB total
  - Leaves headroom for OS and other processes

- **Idle instances**: Unlimited
  - Only consume disk space
  - Automatically archived after 3 days

### Bottlenecks

1. **Memory**: Most likely bottleneck with default 4GB per instance
2. **CPU**: Language servers can be CPU-intensive
3. **Disk I/O**: Many extensions write frequently to user data
4. **Port exhaustion**: 99 ports sufficient for single-user, may need expansion for multi-user

### Scaling Recommendations

For heavier workloads:

1. **Increase port range**: Edit `WORKSPACE_PORT_MIN/MAX` in proxy.js
2. **Adjust resource limits**: Edit `MemoryMax` and `CPUQuota` in systemd service
3. **Add log rotation**: Prevent unbounded log growth
4. **Reduce idle timeout**: Archive instances more aggressively
5. **Use SSD**: Improves instance startup time

## Security Considerations

### Threat Model

**In scope**:

- Isolation between workspaces for single user
- Accidental data leakage between projects
- Resource exhaustion by runaway instances

**Out of scope**:

- Multi-user security (system is single-user by design)
- Authentication (delegated to code-server)
- Network security (binds to localhost only)
- File system permissions (uses user's normal permissions)

### Security Properties

**Network isolation**:

- Proxy binds to 127.0.0.1 only
- Not accessible from network by default
- Would require SSH tunnel or reverse proxy for remote access

**Process isolation**:

- Each instance runs as user's process
- Systemd applies resource limits
- Instances cannot interfere with each other's processes

**Browser isolation**:

- Different ports = different origins
- Automatic storage isolation by browser
- No cookie/localStorage leakage

**File system**:

- No isolation (intentional)
- All instances run as same user
- Can access same files if paths overlap

### Known Limitations

1. **No authentication at proxy level**
   - Relies entirely on code-server's password
   - Anyone with localhost access can use proxy

2. **No file system isolation**
   - Malicious workspace could access other workspaces' files
   - Same user context for all instances

3. **Systemd dependency**
   - If user gains systemd access, can control all instances
   - Services run in user context (appropriate)

4. **Log access**
   - Logs contain full command lines (paths visible)
   - Stored in user-readable directories

### Recommendations for Production

If deploying for multiple users or untrusted workspaces:

1. Add authentication at proxy level
2. Use container-based isolation (Docker, etc.)
3. Implement file system access controls
4. Audit log access
5. Rate limiting on instance creation
6. Network isolation between instances

## Further Reading

- [DEPLOYMENT.md](DEPLOYMENT.md) - Installation and configuration (systemd and Docker)
- [OPERATIONS.md](OPERATIONS.md) - Daily operations and maintenance
- [DOCKER-MIGRATION.md](DOCKER-MIGRATION.md) - Docker migration guide
- [RUNBOOKS.md](RUNBOOKS.md) - Operational runbooks for Docker and systemd
- [systemd/README.md](../systemd/README.md) - Systemd service details
- [src/proxy.js](../src/proxy.js) - Proxy implementation source
- [src/container-manager.js](../src/container-manager.js) - Docker container management

## Auto-SSH and GPU Access Architecture

Starting with version 2.1, the system supports auto-SSH to host and GPU passthrough features that enable resource-intensive workloads while maintaining container isolation.

### Overview

The auto-SSH feature allows container terminals to automatically SSH to the host system, providing:

- **Full host resource access**: GPU, CPU, and memory for intensive workloads
- **Terminal isolation preserved**: Container shells remain in separate namespaces
- **Seamless user experience**: Transparent SSH connection on terminal creation

GPU passthrough via NVIDIA Container Toolkit enables:

- **Extension host GPU access**: AI coding assistants can run GPU tests
- **Native performance**: Minimal overhead for GPU operations
- **Per-workspace control**: Enable GPU only where needed

### Auto-SSH Terminal Architecture

#### Terminal Connection Flow

```
User Opens Terminal in Browser
    ↓
VSCode Creates PTY in Container
    ↓
Container Shell Starts (/bin/bash or /bin/zsh)
    ↓
Shell Sources ~/.bashrc or ~/.zshrc
    ↓
Auto-SSH Script Executes (.auto-ssh-bashrc)
    ↓
exec ssh user@host.docker.internal
    ↓
SSH Replaces Shell Process (Container PTY → SSH Client → Host Shell)
    ↓
User Sees Host Prompt (cd to workspace directory)
```

**Key Insight**: The container shell process remains in the container namespace, but `exec ssh` replaces it with an SSH client. All subsequent commands execute on the host.

#### Auto-SSH Configuration

**Environment Variables**:

| Variable          | Purpose                     | Example                     |
| ----------------- | --------------------------- | --------------------------- |
| `ENABLE_AUTO_SSH` | Enable auto-SSH feature     | `true`                      |
| `HOST_USER`       | Host username for SSH       | `shauncutts`                |
| `WORKSPACE_PATH`  | Workspace directory on host | `/home/user/projects/myapp` |
| `SSH_AUTH_SOCK`   | SSH agent socket path       | `/ssh-agent`                |

**Initialization Script**: `docker/code-server/root/etc/cont-init.d/60-setup-auto-ssh`

Creates `.auto-ssh-bashrc` script that:

1. Checks if terminal is interactive
2. Verifies auto-SSH is enabled
3. Ensures not already in SSH session
4. Executes SSH with connection options:
   - `StrictHostKeyChecking=no`: Accept host key automatically
   - `UserKnownHostsFile=/dev/null`: Don't persist host keys
   - `ServerAliveInterval=60`: Send keep-alive every 60 seconds
   - `ServerAliveCountMax=3`: Disconnect after 3 failed keep-alives

**SSH Authentication**:

Auto-SSH uses SSH agent forwarding (recommended):

- Container mounts host's `SSH_AUTH_SOCK` as read-only volume
- SSH agent socket: `${SSH_AUTH_SOCK}:/ssh-agent:ro`
- No private keys exposed to containers
- Works with passphrase-protected keys

**Network Connectivity**:

Containers connect to host via `host.docker.internal`:

- Docker Desktop: Built-in DNS name
- Linux: Added via `ExtraHosts: ['host.docker.internal:host-gateway']`

#### Terminal Isolation

**Why Terminal Isolation is Preserved**:

Despite commands running on host, terminals remain isolated:

- Container shells exist in separate IPC namespaces
- Each workspace container has isolated PTY devices
- SSH sessions are independent per container
- No cross-workspace terminal stealing (Docker IPC isolation)

### WebSocket Activity Tracking

#### Problem Statement

Traditional idle detection monitors container processes, which doesn't work with auto-SSH because:

- Container always has running processes (SSH clients)
- Container start time doesn't reflect user activity
- Cannot distinguish active vs idle SSH sessions

#### Solution: Browser Traffic Monitoring

Activity tracking monitors HTTP and WebSocket traffic from browser:

**Implementation** (`src/activity-tracker.js`):

```javascript
class ActivityTracker {
  recordActivity(workspaceId) {
    this.lastActivity.set(workspaceId, Date.now());
  }

  getIdleTime(workspaceId) {
    const lastActivity = this.getLastActivity(workspaceId);
    return Math.floor((Date.now() - lastActivity) / 1000);
  }
}
```

**Activity API Endpoint**:

```
GET /api/activity/<workspaceId>

Response:
{
  "workspaceId": "abc123...",
  "idleSeconds": 3600,
  "lastActivity": 1700000000000
}
```

**Advantages**:

- Accurate user activity measurement
- Works regardless of container process state
- Low overhead (event-driven, not polling)
- Captures terminal I/O, file operations, extension activity

### GPU Passthrough Architecture

#### NVIDIA Container Toolkit Integration

GPU access provided via Docker runtime with NVIDIA Container Toolkit:

**Container Configuration**:

```javascript
HostConfig: {
  Runtime: 'nvidia',
  DeviceRequests: [{
    Driver: 'nvidia',
    Count: -1,  // All GPUs
    Capabilities: [['gpu', 'compute', 'utility']]
  }]
}
```

**Environment Variables**:

```javascript
Env: [
  'NVIDIA_VISIBLE_DEVICES=all',
  'NVIDIA_DRIVER_CAPABILITIES=compute,utility',
];
```

#### Per-Workspace GPU Configuration

GPU access can be enabled per-workspace:

**Global Enable**:

```bash
export ENABLE_GPU=true
systemctl --user restart code-server-proxy.service
```

**Per-Workspace Enable** (metadata.json):

```json
{
  "workspacePath": "/path/to/gpu-project",
  "port": 8142,
  "instanceId": "abc123...",
  "backend": "docker",
  "enableGPU": true
}
```

### Security Considerations

#### Auto-SSH Security

**SSH Agent Socket**:

- ✅ Mounted read-only
- ✅ No private key exposure
- ⚠️ Container can use agent for any SSH connection

**Host Access**:

- ⚠️ User commands run on host with full user permissions
- ✅ Mitigated: Single-user deployment (not multi-tenant)
- ✅ SSH authentication required

**Recommended SSH Server Configuration** (`/etc/ssh/sshd_config`):

```
AllowUsers youruser
PermitRootLogin no
PasswordAuthentication no
AllowAgentForwarding yes
MaxStartups 10:30:60
```

#### GPU Security

**Resource Sharing**:

- ⚠️ GPU memory visible to all containers with GPU access
- ✅ Per-workspace GPU enable flag limits exposure
- ❌ No GPU memory quotas (Docker doesn't support)

### Environment Variables Reference

| Variable                     | Purpose                     | Default             | Required            |
| ---------------------------- | --------------------------- | ------------------- | ------------------- |
| `ENABLE_AUTO_SSH`            | Enable auto-SSH feature     | `false`             | No                  |
| `HOST_USER`                  | Host username for SSH       | `$USER`             | If auto-SSH enabled |
| `WORKSPACE_PATH`             | Workspace directory on host | Container workspace | If auto-SSH enabled |
| `SSH_AUTH_SOCK`              | SSH agent socket path       | Host value          | If auto-SSH enabled |
| `ENABLE_GPU`                 | Enable GPU passthrough      | `false`             | No                  |
| `NVIDIA_VISIBLE_DEVICES`     | GPU devices to expose       | `all`               | If GPU enabled      |
| `NVIDIA_DRIVER_CAPABILITIES` | GPU capabilities            | `compute,utility`   | If GPU enabled      |

### Troubleshooting

**Auto-SSH Connection Failures**:

1. Check SSH agent: `echo $SSH_AUTH_SOCK` (on host)
2. Verify host SSH server: `systemctl status sshd`
3. Test SSH from container: `docker exec -it <container> ssh user@host.docker.internal`
4. Check container logs: `docker logs code-server-<instanceId> | grep auto-ssh`

**GPU Not Accessible**:

1. Verify NVIDIA Container Toolkit: `docker run --rm --runtime=nvidia nvidia/cuda:11.0-base nvidia-smi`
2. Check Docker daemon configuration: `/etc/docker/daemon.json`
3. Test GPU in container: `docker exec <container> nvidia-smi`
4. Verify environment variables: `docker inspect <container> | grep NVIDIA`

**Activity Tracking Not Working**:

1. Check API endpoint: `curl http://localhost:8083/api/activity/<workspaceId>`
2. Verify activity tracker module loaded: Check proxy.js logs
3. Test WebSocket traffic: Open terminal, check activity timestamp updates

- [docker/code-server/Dockerfile](../docker/code-server/Dockerfile) - Docker image definition
