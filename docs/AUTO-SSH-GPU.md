# Auto-SSH and GPU Access Guide

This guide covers the auto-SSH to host and GPU passthrough features that enable resource-intensive workloads while maintaining container isolation.

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Auto-SSH Configuration](#auto-ssh-configuration)
- [GPU Configuration](#gpu-configuration)
- [How It Works](#how-it-works)
- [Troubleshooting](#troubleshooting)
- [Testing](#testing)
- [Security Considerations](#security-considerations)

## Overview

### Problem Statement

Docker containers provide excellent isolation but have resource limitations:

**Resource Constraints**:

- Limited CPU/memory allocation
- No GPU access by default
- Cannot utilize full host resources for intensive workloads

**Terminal Stealing Issue**:

- systemd mode: Multiple workspaces share IPC namespace
- Terminals can "steal" connections from other workspaces
- Confusing and unpredictable terminal behavior

### Solution Architecture

**Dual Approach**:

1. **Auto-SSH for User Terminals**: Container terminals automatically SSH to host
   - Commands execute on host with full resources
   - Terminal isolation preserved (container IPC namespaces)
   - Transparent to user (instant connection)

2. **GPU Passthrough for Extension Hosts**: NVIDIA Container Toolkit
   - Extension processes stay in container
   - GPU device passthrough via Docker runtime
   - Native performance for AI/CUDA workloads

### Benefits

✅ **Full host resource access** via auto-SSH terminals
✅ **Terminal isolation preserved** (no terminal stealing)
✅ **GPU access for extensions** (AI coding assistants, CUDA tests)
✅ **Seamless user experience** (transparent SSH connection)
✅ **Per-workspace control** (enable features selectively)

## Prerequisites

### Auto-SSH Requirements

1. **SSH Server on Host**:

   ```bash
   # Install OpenSSH server (if not installed)
   sudo apt-get install openssh-server

   # Start and enable SSH service
   sudo systemctl start sshd
   sudo systemctl enable sshd

   # Verify SSH server is running
   systemctl status sshd
   ```

2. **SSH Agent with Loaded Keys**:

   ```bash
   # Start SSH agent
   eval $(ssh-agent)

   # Add your SSH key
   ssh-add ~/.ssh/id_rsa

   # Verify key is added
   ssh-add -l

   # Check agent socket
   echo $SSH_AUTH_SOCK
   # Should output: /tmp/ssh-XXX/agent.12345
   ```

3. **Passwordless SSH to Localhost**:

   ```bash
   # Test SSH connection
   ssh $USER@localhost whoami
   # Should connect without password prompt

   # If password required, copy public key
   ssh-copy-id $USER@localhost
   ```

### GPU Requirements

1. **NVIDIA Drivers on Host**:

   ```bash
   # Check NVIDIA driver version
   nvidia-smi
   # Should display GPU information

   # If not installed, install NVIDIA drivers
   # Ubuntu/Debian:
   sudo apt-get install nvidia-driver-<version>
   ```

2. **NVIDIA Container Toolkit**:

   ```bash
   # Install NVIDIA Container Toolkit
   distribution=$(. /etc/os-release;echo $ID$VERSION_ID)
   curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | \
       sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg

   curl -s -L https://nvidia.github.io/libnvidia-container/$distribution/libnvidia-container.list | \
       sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
       sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list

   sudo apt-get update
   sudo apt-get install -y nvidia-container-toolkit

   # Configure Docker daemon
   sudo nvidia-ctk runtime configure --runtime=docker

   # Restart Docker
   sudo systemctl restart docker
   ```

3. **Verify GPU Toolkit**:

   ```bash
   # Run test script
   ./scripts/test-gpu-access.sh

   # Or test manually
   docker run --rm --runtime=nvidia nvidia/cuda:11.0-base nvidia-smi
   # Should show GPU information
   ```

## Auto-SSH Configuration

### Global Enable (All Workspaces)

Enable auto-SSH for all new workspaces:

```bash
# Set environment variable for current session
export ENABLE_AUTO_SSH=true

# Make persistent by editing systemd service
systemctl --user edit code-server-proxy.service
```

Add to service file:

```ini
[Service]
Environment="ENABLE_AUTO_SSH=true"
```

Restart proxy:

```bash
systemctl --user daemon-reload
systemctl --user restart code-server-proxy.service
```

### Per-Workspace Enable

Enable auto-SSH for specific workspace:

1. **Find workspace instance ID**:

   ```bash
   WORKSPACE_PATH="/path/to/workspace"
   INSTANCE_ID=$(echo -n "$WORKSPACE_PATH" | sha256sum | awk '{print $1}')
   echo "Instance ID: $INSTANCE_ID"
   ```

2. **Edit workspace metadata**:

   ```bash
   $EDITOR ~/.code-workspaces/instances/$INSTANCE_ID/metadata.json
   ```

3. **Add configuration**:

   ```json
   {
     "workspacePath": "/path/to/workspace",
     "port": 8142,
     "instanceId": "abc123...",
     "backend": "docker",
     "autoSSH": true
   }
   ```

4. **Recreate container**:
   ```bash
   docker stop code-server-$INSTANCE_ID
   docker rm code-server-$INSTANCE_ID
   # Container will be recreated on next access
   ```

### Disabling Auto-SSH

To disable globally:

```bash
# Remove environment variable
unset ENABLE_AUTO_SSH

# Update systemd service
systemctl --user edit code-server-proxy.service
# Remove the Environment="ENABLE_AUTO_SSH=true" line

# Restart proxy
systemctl --user daemon-reload
systemctl --user restart code-server-proxy.service
```

To disable per-workspace:

- Set `"autoSSH": false` in metadata.json
- Recreate container

## GPU Configuration

### Global Enable (All Workspaces)

Enable GPU for all new workspaces:

```bash
# Set environment variable
export ENABLE_GPU=true

# Make persistent
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

### Per-Workspace Enable

Enable GPU for specific workspace:

1. **Edit metadata.json**:

   ```bash
   WORKSPACE_PATH="/path/to/gpu-project"
   INSTANCE_ID=$(echo -n "$WORKSPACE_PATH" | sha256sum | awk '{print $1}')
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

### Verifying Configuration

Check if features are enabled:

```bash
INSTANCE_ID="<your-instance-id>"

# Check auto-SSH
docker inspect code-server-$INSTANCE_ID | grep ENABLE_AUTO_SSH

# Check GPU
docker inspect code-server-$INSTANCE_ID | grep -A 5 DeviceRequests
```

## How It Works

### Auto-SSH Mechanism

#### Terminal Creation Flow

```
User Opens Terminal
    ↓
VSCode Creates PTY in Container
    ↓
Container Shell Starts (/bin/bash)
    ↓
Shell Sources .bashrc
    ↓
.auto-ssh-bashrc Script Executes
    ↓
Checks: Interactive? Auto-SSH Enabled? Not Already SSH?
    ↓
exec ssh user@host.docker.internal
    ↓
SSH Client Replaces Shell Process
    ↓
Host Shell Session Starts
    ↓
cd to Workspace Directory
    ↓
User Sees Host Prompt
```

#### Key Concepts

**Process Replacement**:

- `exec ssh` replaces the container shell process
- Container PTY remains in container namespace
- SSH client connects to host
- All subsequent commands run on host

**Terminal Isolation**:

- Each container has separate IPC namespace
- PTY devices isolated per container
- SSH sessions independent per workspace
- No cross-workspace terminal stealing

**SSH Authentication**:

- Uses SSH agent forwarding (recommended)
- Container mounts host's `SSH_AUTH_SOCK` (read-only)
- No private keys exposed to containers
- Works with passphrase-protected keys

### GPU Passthrough Mechanism

#### GPU Access Flow

```
Extension Host Process (Container)
    ↓
Spawns Test Command (pytest --cuda)
    ↓
Test Code Calls GPU API (torch.cuda.*)
    ↓
NVIDIA Container Toolkit
    ↓
Host NVIDIA Drivers
    ↓
GPU Hardware
```

#### Container Configuration

When GPU enabled, container is created with:

```javascript
HostConfig: {
  Runtime: 'nvidia',
  DeviceRequests: [{
    Driver: 'nvidia',
    Count: -1,  // All GPUs
    Capabilities: [['gpu', 'compute', 'utility']]
  }]
}

Env: [
  'NVIDIA_VISIBLE_DEVICES=all',
  'NVIDIA_DRIVER_CAPABILITIES=compute,utility'
]
```

### AI Coding Assistant Command Execution (Kilo Code)

AI coding assistants like Kilo Code execute commands differently from user terminals.

#### Discovery

Kilo Code uses `/bin/sh -c "command"` to execute commands, NOT:

- The `$SHELL` environment variable
- VS Code terminal profiles
- `/bin/bash`

This was discovered by wrapping `/bin/sh` with diagnostic logging.

#### Solution: /bin/sh Wrapper

Replace `/bin/sh` with a dash-compatible wrapper that forwards commands to host:

**File**: `docker/code-server/root/bin/sh-host-wrapper`

```sh
#!/bin/dash
# Forward shell commands to host via SSH (dash-compatible)

# Skip if already on host (SSH session)
[ -n "$SSH_CONNECTION" ] && exec /bin/dash.real "$@"

# Skip if auto-SSH not enabled
[ "$ENABLE_AUTO_SSH" != "true" ] && exec /bin/dash.real "$@"

# Skip if HOST_USER not set
[ -z "$HOST_USER" ] && exec /bin/dash.real "$@"

# Check if this is -c "command" style invocation
if [ "$1" = "-c" ] && [ -n "$2" ]; then
    # Forward command to host
    cd_prefix=""
    [ -n "$WORKSPACE_PATH" ] && cd_prefix="cd '$WORKSPACE_PATH' 2>/dev/null; "
    exec ssh "$HOST_USER@host.docker.internal" "${cd_prefix}$2"
fi

# Otherwise run locally
exec /bin/dash.real "$@"
```

**Dockerfile installation**:

```dockerfile
COPY root/bin/sh-host-wrapper /bin/sh-host-wrapper
RUN cp /bin/dash /bin/dash.real \
    && mv /bin/sh-host-wrapper /bin/sh \
    && chmod +x /bin/sh
```

#### Command Execution Flow

```
Kilo Code Executes Command
    ↓
/bin/sh -c "whoami"
    ↓
sh-host-wrapper detects -c flag
    ↓
Checks: ENABLE_AUTO_SSH? HOST_USER set? Not already SSH?
    ↓
exec ssh user@host.docker.internal "cd /workspace; whoami"
    ↓
Command runs on HOST
    ↓
Result returned to Kilo Code
```

#### Why This Works

- Kilo Code (and VS Code) use `/bin/sh` for command execution
- On Debian/Ubuntu, `/bin/sh` is symlinked to `dash`
- The wrapper intercepts `-c "command"` invocations
- Other `/bin/sh` uses (system scripts, etc.) fall through to real dash
- Must be dash-compatible syntax (no bash-isms like `[[ ]]` or `printf %q`)

### Activity Tracking

#### Why Activity Tracking is Needed

Traditional idle detection checks container processes:

- ❌ Doesn't work with auto-SSH (SSH clients always running)
- ❌ Container start time doesn't reflect user activity
- ❌ Can't distinguish active vs idle SSH sessions

Solution: Track browser traffic (WebSocket/HTTP)

#### Activity Tracking Flow

```
User Types in Terminal
    ↓
WebSocket Message to Proxy
    ↓
Proxy Records Activity: activityTracker.recordActivity(workspaceId)
    ↓
Timestamp Stored: Date.now()
    ↓
Idle Monitor Queries: GET /api/activity/<workspaceId>
    ↓
Returns: { idleSeconds: 300, lastActivity: 1700000000000 }
```

#### Activity API

Query workspace activity:

```bash
WORKSPACE_ID=$(echo -n "/path/to/workspace" | sha256sum | awk '{print $1}')
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

## Troubleshooting

### Auto-SSH Issues

#### Terminal Shows Container Prompt Instead of Host

**Diagnosis**:

```bash
# Check if auto-SSH enabled
docker inspect code-server-$INSTANCE_ID | grep ENABLE_AUTO_SSH
# Should show: ENABLE_AUTO_SSH=true

# Check SSH agent socket mounted
docker inspect code-server-$INSTANCE_ID | grep SSH_AUTH_SOCK
# Should show mounted socket

# Check container logs
docker logs code-server-$INSTANCE_ID | grep -i ssh
```

**Solutions**:

1. **SSH agent not running**:

   ```bash
   # On host
   eval $(ssh-agent)
   ssh-add ~/.ssh/id_rsa

   # Restart container
   docker restart code-server-$INSTANCE_ID
   ```

2. **Host SSH server not running**:

   ```bash
   sudo systemctl start sshd
   sudo systemctl enable sshd
   ```

3. **SSH key not in agent**:

   ```bash
   ssh-add ~/.ssh/id_rsa
   ssh-add -l  # Verify key added
   ```

4. **Firewall blocking SSH**:
   ```bash
   # Allow SSH from Docker network
   sudo ufw allow from 172.17.0.0/16 to any port 22
   ```

#### SSH Connection Timeout

**Diagnosis**:

```bash
# Test SSH from container
docker exec -it code-server-$INSTANCE_ID ssh -v $USER@host.docker.internal
```

**Solutions**:

1. **host.docker.internal not resolving**:

   ```bash
   # Test DNS resolution
   docker exec code-server-$INSTANCE_ID ping -c 1 host.docker.internal

   # If fails, check ExtraHosts in container config
   docker inspect code-server-$INSTANCE_ID | grep ExtraHosts
   # Should show: host.docker.internal:host-gateway
   ```

2. **SSH server not listening**:
   ```bash
   # Check SSH listening
   netstat -tln | grep :22
   # Should show: 0.0.0.0:22
   ```

### GPU Issues

#### nvidia-smi Not Found in Container

**Diagnosis**:

```bash
# Check if GPU enabled
docker inspect code-server-$INSTANCE_ID | grep -A 5 DeviceRequests
# Should show NVIDIA device requests

# Check NVIDIA runtime
docker run --rm --runtime=nvidia nvidia/cuda:11.0-base nvidia-smi
```

**Solutions**:

1. **NVIDIA Container Toolkit not installed**:

   ```bash
   # Install toolkit
   sudo apt-get install -y nvidia-container-toolkit
   sudo nvidia-ctk runtime configure --runtime=docker
   sudo systemctl restart docker

   # Verify installation
   ./scripts/test-gpu-access.sh
   ```

2. **Container not using NVIDIA runtime**:

   ```bash
   # Check metadata.json has enableGPU: true
   cat ~/.code-workspaces/instances/$INSTANCE_ID/metadata.json

   # Recreate container
   docker stop code-server-$INSTANCE_ID
   docker rm code-server-$INSTANCE_ID
   ```

3. **Docker daemon configuration missing**:

   ```bash
   # Check daemon config
   cat /etc/docker/daemon.json
   # Should contain nvidia runtime configuration

   # If missing, configure
   sudo nvidia-ctk runtime configure --runtime=docker
   sudo systemctl restart docker
   ```

#### GPU Tests Fail in Extension

**Diagnosis**:

```bash
# Test GPU from container
docker exec code-server-$INSTANCE_ID nvidia-smi

# Test CUDA availability
docker exec code-server-$INSTANCE_ID sh -c \
  "cd /workspace && python -c 'import torch; print(torch.cuda.is_available())'"
```

**Solutions**:

1. **CUDA libraries missing**:

   ```bash
   # Install CUDA toolkit in container (if needed)
   docker exec -it code-server-$INSTANCE_ID bash
   # Inside container:
   apt-get update
   apt-get install -y nvidia-cuda-toolkit
   ```

2. **Environment variables not set**:
   ```bash
   # Check NVIDIA environment variables
   docker inspect code-server-$INSTANCE_ID | grep NVIDIA
   # Should show: NVIDIA_VISIBLE_DEVICES=all
   ```

### Activity Tracking Issues

#### Activity API Returns 404

**Diagnosis**:

```bash
# Verify workspace ID
WORKSPACE_PATH="/path/to/workspace"
WORKSPACE_ID=$(echo -n "$WORKSPACE_PATH" | sha256sum | awk '{print $1}')

# Query activity
curl "http://localhost:8083/api/activity/$WORKSPACE_ID"
```

**Solutions**:

1. **Workspace ID mismatch**:

   ```bash
   # Use exact path from metadata.json
   cat ~/.code-workspaces/instances/$INSTANCE_ID/metadata.json | grep workspacePath
   # Use the exact path shown
   ```

2. **No activity recorded yet**:

   ```bash
   # Access workspace in browser
   curl "http://localhost:8083/?workspace=$WORKSPACE_PATH"

   # Interact with terminal, then query again
   curl "http://localhost:8083/api/activity/$WORKSPACE_ID"
   ```

#### Idle Time Not Updating

**Diagnosis**:

```bash
# Check proxy logs
journalctl --user -u code-server-proxy.service -f | grep activity
```

**Solutions**:

1. **Activity tracker not loaded**:

   ```bash
   # Check proxy startup logs
   journalctl --user -u code-server-proxy.service --since "10 min ago" | grep activity-tracker

   # Restart proxy if not loaded
   systemctl --user restart code-server-proxy.service
   ```

2. **WebSocket traffic not monitored**:
   ```bash
   # Verify WebSocket connections
   # Open terminal in browser and type
   # Check activity updates
   curl "http://localhost:8083/api/activity/$WORKSPACE_ID"
   ```

## Testing

### Testing Auto-SSH

#### Basic Functionality Test

```bash
# 1. Enable auto-SSH
export ENABLE_AUTO_SSH=true
systemctl --user restart code-server-proxy.service

# 2. Access workspace
WORKSPACE_PATH="/tmp/test-auto-ssh"
mkdir -p "$WORKSPACE_PATH"
curl "http://localhost:8083/?workspace=$WORKSPACE_PATH"

# 3. Open terminal in browser, verify:
#    - hostname shows host machine name
#    - whoami shows host user
#    - pwd shows workspace path on host
```

#### Host Resource Access Test

```bash
# In auto-SSH terminal:

# Test CPU access
nproc
# Should show all host CPU cores

# Test memory access
free -h
# Should show host memory

# Test GPU access (if GPU on host)
nvidia-smi
# Should show host GPU
```

### Testing GPU Passthrough

#### NVIDIA Toolkit Verification

```bash
# Run GPU test script
./scripts/test-gpu-access.sh

# Should output:
# ✓ NVIDIA Container Toolkit is available
# ✓ GPU access test completed
```

#### Container GPU Access Test

```bash
# 1. Enable GPU for workspace
WORKSPACE_PATH="/tmp/test-gpu"
mkdir -p "$WORKSPACE_PATH"

# 2. Create workspace with GPU
export ENABLE_GPU=true
curl "http://localhost:8083/?workspace=$WORKSPACE_PATH"

# 3. Test GPU in container
INSTANCE_ID=$(echo -n "$WORKSPACE_PATH" | sha256sum | awk '{print $1}')
docker exec code-server-$INSTANCE_ID nvidia-smi

# Should show GPU information
```

#### CUDA Test from Python

```bash
# Test CUDA availability
docker exec code-server-$INSTANCE_ID sh -c \
  "python3 -c 'import torch; print(f\"CUDA available: {torch.cuda.is_available()}\"); print(f\"GPU count: {torch.cuda.device_count()}\")'"

# Expected output:
# CUDA available: True
# GPU count: 1
```

### Testing Activity Tracking

#### Activity Recording Test

```bash
# 1. Access workspace
WORKSPACE_PATH="/tmp/test-activity"
mkdir -p "$WORKSPACE_PATH"
curl "http://localhost:8083/?workspace=$WORKSPACE_PATH"

# 2. Get workspace ID
WORKSPACE_ID=$(echo -n "$WORKSPACE_PATH" | sha256sum | awk '{print $1}')

# 3. Check initial activity
curl "http://localhost:8083/api/activity/$WORKSPACE_ID"

# 4. Interact with terminal in browser (type commands)

# 5. Check activity updated (idleSeconds should be small)
curl "http://localhost:8083/api/activity/$WORKSPACE_ID"

# 6. Wait 5 minutes, check idle time increased
sleep 300
curl "http://localhost:8083/api/activity/$WORKSPACE_ID"
```

## Security Considerations

### Auto-SSH Security

#### SSH Agent Socket

**Security Properties**:

- ✅ Mounted read-only (`:ro`)
- ✅ No private key exposure to containers
- ✅ Socket cannot be replaced by container
- ⚠️ Container can use agent for any SSH connection

**Mitigation**:

- Single-user deployment (not multi-tenant)
- SSH agent requires user confirmation (configurable)
- Container isolation limits damage scope

#### Host Access

**Risk**: User commands run on host with full user permissions

**Mitigation**:

1. **SSH Server Hardening** (`/etc/ssh/sshd_config`):

   ```
   # Allow only specific users
   AllowUsers youruser

   # Disable root login
   PermitRootLogin no

   # Key-only authentication
   PasswordAuthentication no

   # Allow agent forwarding (required)
   AllowAgentForwarding yes

   # Rate limiting
   MaxStartups 10:30:60
   MaxSessions 10
   ```

2. **Firewall Rules**:

   ```bash
   # Allow SSH only from Docker network
   sudo ufw allow from 172.17.0.0/16 to any port 22
   ```

3. **Audit Logging**:
   ```bash
   # Monitor SSH connections
   tail -f /var/log/auth.log | grep sshd
   ```

### GPU Security

#### Resource Sharing

**Risk**: GPU memory visible to all containers with GPU access

**Mitigation**:

- ✅ Per-workspace GPU enable flag
- ✅ Limit GPU to trusted workspaces only
- ❌ No GPU memory quotas (Docker limitation)

#### Device Access

**Security Properties**:

- ✅ NVIDIA runtime provides safe device passthrough
- ✅ No direct host filesystem access via GPU
- ✅ Container isolation maintained

### Network Security

**Container to Host Communication**:

- SSH: Authenticated via SSH agent
- GPU: Device passthrough (no network communication)
- Activity tracking: Internal to proxy

**Recommendations**:

1. Keep Docker bridge network isolated
2. Use firewall rules to restrict SSH access
3. Monitor network traffic for anomalies

## Environment Variables Reference

| Variable                     | Purpose                     | Default             | Required            |
| ---------------------------- | --------------------------- | ------------------- | ------------------- |
| `ENABLE_AUTO_SSH`            | Enable auto-SSH feature     | `false`             | No                  |
| `HOST_USER`                  | Host username for SSH       | `$USER`             | If auto-SSH enabled |
| `WORKSPACE_PATH`             | Workspace directory on host | Container workspace | If auto-SSH enabled |
| `SSH_AUTH_SOCK`              | SSH agent socket path       | Host value          | If auto-SSH enabled |
| `ENABLE_GPU`                 | Enable GPU passthrough      | `false`             | No                  |
| `NVIDIA_VISIBLE_DEVICES`     | GPU devices to expose       | `all`               | If GPU enabled      |
| `NVIDIA_DRIVER_CAPABILITIES` | GPU capabilities            | `compute,utility`   | If GPU enabled      |

## Additional Resources

- [ARCHITECTURE.md](ARCHITECTURE.md#auto-ssh-and-gpu-access-architecture) - Technical architecture details
- [OPERATIONS.md](OPERATIONS.md#auto-ssh-and-gpu-configuration) - Operational procedures
- [RUNBOOKS.md](RUNBOOKS.md) - Troubleshooting runbooks
- [scripts/test-gpu-access.sh](../scripts/test-gpu-access.sh) - GPU testing script

## Support

For issues or questions:

1. Check [Troubleshooting](#troubleshooting) section
2. Review [RUNBOOKS.md](RUNBOOKS.md) for common scenarios
3. Check proxy logs: `journalctl --user -u code-server-proxy.service -f`
4. Check container logs: `docker logs code-server-<instance-id>`
