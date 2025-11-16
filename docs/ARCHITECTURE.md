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

- [DEPLOYMENT.md](DEPLOYMENT.md) - Installation and configuration
- [OPERATIONS.md](OPERATIONS.md) - Daily operations and maintenance
- [systemd/README.md](../systemd/README.md) - Systemd service details
- [src/proxy.js](../src/proxy.js) - Proxy implementation source
