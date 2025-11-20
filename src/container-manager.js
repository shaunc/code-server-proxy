/**
 * Docker Container Manager
 *
 * Provides container lifecycle management for code-server instances.
 * Each workspace runs in its own isolated Docker container with:
 * - Complete IPC namespace isolation (prevents terminal stealing)
 * - Terminal persistence via config volumes
 * - Shared extensions volume for disk efficiency
 * - In-container gnome-keyring for VSCode extension secrets
 */

const Docker = require('dockerode');
const path = require('path');
const { execSync } = require('child_process');

// Initialize Docker client
const docker = new Docker();

/**
 * Check if NVIDIA Container Toolkit is available
 * @returns {boolean} True if NVIDIA runtime is available
 */
function isNvidiaRuntimeAvailable() {
  try {
    // Check if nvidia-smi exists (NVIDIA driver installed)
    const result = execSync('which nvidia-smi', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

// Check NVIDIA availability at module load
const NVIDIA_AVAILABLE = isNvidiaRuntimeAvailable();

// Configuration
const DOCKER_IMAGE = process.env.DOCKER_IMAGE || 'code-server-proxy:latest';

// Cache current image ID (refreshed periodically)
let cachedImageId = null;
let cacheTimestamp = 0;
const IMAGE_CACHE_TTL = 60000; // 1 minute
const DOCKER_MEMORY_LIMIT = process.env.DOCKER_MEMORY_LIMIT || '4g';
const DOCKER_CPU_LIMIT = parseFloat(process.env.DOCKER_CPU_LIMIT || '3.0');
const SHARED_EXTENSIONS_VOLUME =
  process.env.SHARED_EXTENSIONS_VOLUME || 'code-server-extensions';
// Configuration constant for potential future use
// Reserved for volume backup/restore paths
const WORKSPACE_VOLUMES_PATH =
  process.env.WORKSPACE_VOLUMES_PATH ||
  path.join(process.env.HOME, '.code-workspaces/volumes');
const HOST_SECRETS_PATH =
  process.env.HOST_SECRETS_PATH ||
  path.join(process.env.HOME, '.local/share/code-server/User/globalStorage');
const INSTANCES_BASE_PATH =
  process.env.INSTANCES_BASE_PATH ||
  path.join(process.env.HOME, '.code-workspaces/instances');

// Idle monitoring configuration
const IDLE_THRESHOLD_DAYS = parseInt(
  process.env.IDLE_THRESHOLD_DAYS || '3',
  10
);
const IDLE_GRACE_PERIOD_DAYS = parseInt(
  process.env.IDLE_GRACE_PERIOD_DAYS || '7',
  10
);
const IDLE_WHITELIST = process.env.IDLE_WHITELIST
  ? process.env.IDLE_WHITELIST.split(',')
  : [];

/**
 * Parse memory limit string to bytes
 * @param {string} memLimit - Memory limit (e.g., "4g", "512m")
 * @returns {number} Memory in bytes
 */
function parseMemoryLimit(memLimit) {
  const units = {
    b: 1,
    k: 1024,
    m: 1024 * 1024,
    g: 1024 * 1024 * 1024,
  };
  const match = memLimit.match(/^(\d+)([bkmg])$/i);
  if (!match) {
    throw new Error(`Invalid memory limit format: ${memLimit}`);
  }
  return parseInt(match[1]) * units[match[2].toLowerCase()];
}

/**
 * Check if Docker is available and accessible
 * @returns {Promise<boolean>} True if Docker is accessible
 */
async function isDockerAvailable() {
  try {
    await docker.ping();
    return true;
  } catch (error) {
    console.error('Docker ping failed:', error.message);
    return false;
  }
}

/**
 * Ensure shared extensions volume exists
 * @returns {Promise<void>}
 */
async function ensureSharedExtensionsVolume() {
  try {
    await docker.getVolume(SHARED_EXTENSIONS_VOLUME).inspect();
    console.log(`Shared extensions volume exists: ${SHARED_EXTENSIONS_VOLUME}`);
  } catch (error) {
    if (error.statusCode === 404) {
      console.log(
        `Creating shared extensions volume: ${SHARED_EXTENSIONS_VOLUME}`
      );
      await docker.createVolume({
        Name: SHARED_EXTENSIONS_VOLUME,
        Labels: {
          app: 'code-server-proxy',
          type: 'shared-extensions',
        },
      });
    } else {
      throw error;
    }
  }
}

/**
 * Create config volume for instance
 * @param {string} instanceId - Instance ID
 * @returns {Promise<void>}
 */
async function createConfigVolume(instanceId) {
  const volumeName = `code-server-${instanceId}-config`;
  try {
    await docker.getVolume(volumeName).inspect();
    console.log(`Config volume exists: ${volumeName}`);
  } catch (error) {
    if (error.statusCode === 404) {
      console.log(`Creating config volume: ${volumeName}`);
      await docker.createVolume({
        Name: volumeName,
        Labels: {
          app: 'code-server-proxy',
          type: 'instance-config',
          instanceId: instanceId,
        },
      });
    } else {
      throw error;
    }
  }
}

/**
 * Create Docker container for code-server instance
 * @param {string} instanceId - Instance ID
 * @param {string} workspacePath - Workspace path to mount
 * @param {number} port - Host port to bind
 * @returns {Promise<Object>} Container object
 */
async function createContainer(instanceId, workspacePath, port) {
  const containerName = `code-server-${instanceId}`;
  const configVolume = `code-server-${instanceId}-config`;

  console.log(`Creating container: ${containerName}`);
  console.log(`  Workspace: ${workspacePath}`);
  console.log(`  Port: ${port} -> 8443`);
  console.log(`  Image: ${DOCKER_IMAGE}`);

  // Check if auto-SSH is enabled
  const autoSshEnabled = process.env.ENABLE_AUTO_SSH === 'true';
  if (autoSshEnabled) {
    console.log(`  Auto-SSH: enabled`);
  }

  // Check if GPU passthrough is enabled
  const enableGpu = process.env.ENABLE_GPU === 'true' && NVIDIA_AVAILABLE;
  if (process.env.ENABLE_GPU === 'true') {
    console.log(`  GPU passthrough: requested`);
    console.log(`  NVIDIA runtime available: ${NVIDIA_AVAILABLE}`);
    if (!NVIDIA_AVAILABLE) {
      console.warn(
        '  Warning: NVIDIA Container Toolkit not detected. Install from:'
      );
      console.warn(
        '  https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html'
      );
    } else {
      console.log(`  GPU passthrough: enabled`);
    }
  }

  // Ensure volumes exist
  await ensureSharedExtensionsVolume();
  await createConfigVolume(instanceId);

  // Handle workspace file vs directory mounting
  // For .code-workspace files, mount the directory containing the file
  // and pass the workspace file path to code-server via environment variable
  // For main instance (workspacePath === null), don't mount any workspace
  let mountPath = workspacePath;
  let workspaceFile = null;

  if (workspacePath && workspacePath.endsWith('.code-workspace')) {
    // Mount the directory containing the workspace file
    mountPath = path.dirname(workspacePath);
    // Store the workspace file path relative to the mount point
    workspaceFile = path.join('/workspace', path.basename(workspacePath));
    console.log(`  Workspace file detected: ${path.basename(workspacePath)}`);
    console.log(`  Mounting directory: ${mountPath}`);
    console.log(`  Workspace file path in container: ${workspaceFile}`);
  }

  // Prepare volume binds
  const binds = [
    `${configVolume}:/config`,
    `${SHARED_EXTENSIONS_VOLUME}:/config/extensions`,
    // Mount host directories at their original paths so no rewriting needed
    // This also makes symlinks work (e.g., /home/shauncutts/src -> /data/sda/shaunc-src)
    '/home/shauncutts:/home/shauncutts:rw',
    '/data/sda:/data/sda:rw',
  ];

  // Add host secrets mount if available
  const fs = require('fs');
  if (fs.existsSync(HOST_SECRETS_PATH)) {
    binds.push(`${HOST_SECRETS_PATH}:/host-secrets:ro`);
    console.log(`  Mounting host secrets from: ${HOST_SECRETS_PATH}`);
  }

  // Mount host keyrings for kilo-code credentials
  const hostKeyringsPath = path.join(process.env.HOME, '.local/share/keyrings');
  if (fs.existsSync(hostKeyringsPath)) {
    binds.push(`${hostKeyringsPath}:/host-keyrings:ro`);
    console.log(`  Mounting host keyrings from: ${hostKeyringsPath}`);
  }

  // Mount keyring password for unlocking (separate mount point to avoid nesting)
  const keyringPasswordPath = path.join(
    process.env.HOME,
    '.ssh/keyring-password'
  );
  if (fs.existsSync(keyringPasswordPath)) {
    binds.push(`${keyringPasswordPath}:/keyring-password:ro`);
    console.log(`  Mounting keyring password from: ${keyringPasswordPath}`);
  }

  // Mount host .gitconfig for git credentials and settings
  const hostGitconfigPath = path.join(process.env.HOME, '.gitconfig');
  if (fs.existsSync(hostGitconfigPath)) {
    binds.push(`${hostGitconfigPath}:/host-gitconfig:ro`);
    console.log(`  Mounting host .gitconfig from: ${hostGitconfigPath}`);
  }

  // Mount workspace-specific User directory for settings isolation
  // Each workspace has its own User directory on the host filesystem
  // Settings sync service will propagate settings.json and keybindings.json
  // across all workspaces, while keeping other data (globalStorage, etc.) isolated
  const instanceUserDir = path.join(
    INSTANCES_BASE_PATH,
    instanceId,
    'data/User'
  );
  if (!fs.existsSync(instanceUserDir)) {
    fs.mkdirSync(instanceUserDir, { recursive: true });
    console.log(`  Created instance User directory: ${instanceUserDir}`);
  }
  binds.push(`${instanceUserDir}:/config/data/User:rw`);
  console.log(`  Mounting instance User directory: ${instanceUserDir}`);

  // Mount SSH agent socket if available (for claude wrapper and auto-SSH)
  const sshAuthSock = process.env.SSH_AUTH_SOCK;
  if (sshAuthSock && fs.existsSync(sshAuthSock)) {
    binds.push(`${sshAuthSock}:/ssh-agent/socket:ro`);
    console.log(`  Mounting SSH agent: ${sshAuthSock}`);
  }

  const memoryBytes = parseMemoryLimit(DOCKER_MEMORY_LIMIT);
  const nanoCpus = Math.floor(DOCKER_CPU_LIMIT * 1e9);

  // Prepare environment variables
  // Use current user's UID/GID so container files are owned by correct user
  const uid = process.getuid ? process.getuid() : 1000;
  const gid = process.getgid ? process.getgid() : 1000;
  const envVars = [
    `PUID=${uid}`,
    `PGID=${gid}`,
    'TZ=America/New_York',
    'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus',
    `DEFAULT_WORKSPACE=${workspacePath || '/config/workspace'}`,
  ];

  // SSH_AUTH_SOCK is set in Dockerfile, mount is configured above

  // Set HOST_USER for SSH operations (claude wrapper, auto-SSH)
  if (!process.env.USER) {
    throw new Error(
      'USER environment variable not set - required for SSH operations'
    );
  }
  envVars.push(`HOST_USER=${process.env.USER}`);

  // Don't use DEFAULT_WORKSPACE - we'll pass workspace as command line arg instead
  // (like systemd mode did)

  // Auto-SSH: Add environment variables if enabled
  if (autoSshEnabled) {
    envVars.push('ENABLE_AUTO_SSH=true');

    // Add workspace path for auto-SSH to cd into correct directory
    if (workspacePath) {
      // For workspace files, use the directory containing the file
      const workspaceDir = workspacePath.endsWith('.code-workspace')
        ? path.dirname(workspacePath)
        : workspacePath;
      envVars.push(`WORKSPACE_PATH=${workspaceDir}`);
    }
  }

  // Let s6-overlay's svc-code-server service handle starting code-server
  // Workspace path is passed via DEFAULT_WORKSPACE environment variable

  const containerConfig = {
    name: containerName,
    Image: DOCKER_IMAGE,
    Env: envVars,
    ExposedPorts: {
      '8443/tcp': {},
    },
    Labels: {
      app: 'code-server-proxy',
      instanceId: instanceId,
      workspace: workspacePath || 'none',
    },
    HostConfig: {
      Binds: binds,
      PortBindings: {
        '8443/tcp': [{ HostPort: String(port) }],
      },
      Memory: memoryBytes,
      NanoCpus: nanoCpus,
      RestartPolicy: {
        Name: 'unless-stopped',
      },
      SecurityOpt: ['no-new-privileges:true'],
      CapDrop: ['ALL'],
      CapAdd: ['CHOWN', 'FOWNER', 'SETGID', 'SETUID', 'IPC_LOCK'],
      ReadonlyRootfs: false,
      // Add host.docker.internal alias for Linux (allows SSH to host)
      ExtraHosts: ['host.docker.internal:host-gateway'],
      // Add NVIDIA runtime if GPU enabled
      ...(enableGpu && {
        Runtime: 'nvidia',
        DeviceRequests: [
          {
            Driver: 'nvidia',
            Count: -1, // All GPUs
            Capabilities: [['gpu', 'compute', 'utility']],
          },
        ],
      }),
    },
  };

  try {
    const container = await docker.createContainer(containerConfig);
    console.log(`Container created successfully: ${containerName}`);
    return container;
  } catch (error) {
    // If GPU-related error, retry without GPU (graceful degradation)
    if (
      enableGpu &&
      (error.message.includes('nvidia') ||
        error.message.includes('Runtime') ||
        error.message.includes('runtime'))
    ) {
      console.warn(
        `GPU container creation failed, retrying without GPU: ${error.message}`
      );

      // Remove GPU-specific options
      delete containerConfig.HostConfig.Runtime;
      delete containerConfig.HostConfig.DeviceRequests;

      try {
        const container = await docker.createContainer(containerConfig);
        console.log(
          `Container created successfully without GPU: ${containerName}`
        );
        return container;
      } catch (retryError) {
        console.error(
          `Failed to create container ${containerName} (retry):`,
          retryError.message
        );
        throw new Error(`Container creation failed: ${retryError.message}`);
      }
    }

    console.error(
      `Failed to create container ${containerName}:`,
      error.message
    );
    throw new Error(`Container creation failed: ${error.message}`);
  }
}

/**
 * Start a container
 * @param {string} instanceId - Instance ID
 * @returns {Promise<void>}
 */
async function startContainer(instanceId) {
  const containerName = `code-server-${instanceId}`;
  console.log(`Starting container: ${containerName}`);

  try {
    const container = docker.getContainer(containerName);
    await container.start();
    console.log(`Container started successfully: ${containerName}`);
  } catch (error) {
    console.error(`Failed to start container ${containerName}:`, error.message);
    throw new Error(`Container start failed: ${error.message}`);
  }
}

/**
 * Create workspace symlink in container for hash-based routing
 * @param {string} instanceId - Instance ID
 * @param {string} workspacePath - Workspace path (null for main instance)
 * @returns {Promise<void>}
 */
async function createWorkspaceSymlink(instanceId, workspacePath) {
  if (!workspacePath) {
    // Main instance has no workspace, skip symlink
    return;
  }

  const containerName = `code-server-${instanceId}`;
  const hash = instanceId.substring(0, 8);

  // Determine target and symlink path based on workspace type
  // For workspace files, put symlink in same directory as target
  // so relative paths in the workspace file resolve correctly
  let target;
  let symlinkPath;
  if (workspacePath.endsWith('.code-workspace')) {
    const basename = path.basename(workspacePath);
    target = basename; // Relative path - symlink will be in same dir

    // Extract workspace name (without .code-workspace extension) for readable symlink
    const workspaceName = basename.replace('.code-workspace', '');
    symlinkPath = `/workspace/${workspaceName}-${hash}.code-workspace`;
  } else {
    // For folders, extract directory name
    const folderName = path.basename(workspacePath);
    target = '/workspace';
    symlinkPath = `/ws-${folderName}-${hash}`;
  }

  console.log(
    `Creating workspace symlink in ${containerName}: ${symlinkPath} -> ${target}`
  );

  try {
    const container = docker.getContainer(containerName);

    // Create symlink via exec
    // For workspace file symlinks in /workspace, run as user 1001 (not root)
    const execOptions = {
      Cmd: ['ln', '-sf', target, symlinkPath],
      AttachStdout: true,
      AttachStderr: true,
    };

    // If symlink is in /workspace dir, run as user  (not root) for permissions
    if (symlinkPath.startsWith('/workspace/')) {
      execOptions.User = '1001:1001';
    }

    const exec = await container.exec(execOptions);

    const stream = await exec.start();

    // Wait for exec to complete
    await new Promise((resolve, reject) => {
      stream.on('end', resolve);
      stream.on('error', reject);
    });

    console.log(
      `Workspace symlink created successfully: ${symlinkPath} -> ${target}`
    );
  } catch (error) {
    console.error(
      `Failed to create workspace symlink in ${containerName}:`,
      error.message
    );
    // Don't throw - symlink creation is not critical, container can still work
  }
}

/**
 * Stop a container
 * @param {string} instanceId - Instance ID
 * @param {number} timeout - Stop timeout in seconds
 * @returns {Promise<void>}
 */
async function stopContainer(instanceId, timeout = 10) {
  const containerName = `code-server-${instanceId}`;
  console.log(`Stopping container: ${containerName}`);

  try {
    const container = docker.getContainer(containerName);
    await container.stop({ t: timeout });
    console.log(`Container stopped successfully: ${containerName}`);
  } catch (error) {
    if (error.statusCode === 304) {
      console.log(`Container already stopped: ${containerName}`);
      return;
    }
    console.error(`Failed to stop container ${containerName}:`, error.message);
    throw new Error(`Container stop failed: ${error.message}`);
  }
}

/**
 * Remove a container
 * @param {string} instanceId - Instance ID
 * @param {boolean} force - Force removal even if running
 * @returns {Promise<void>}
 */
async function removeContainer(instanceId, force = false) {
  const containerName = `code-server-${instanceId}`;
  console.log(`Removing container: ${containerName}`);

  try {
    const container = docker.getContainer(containerName);
    await container.remove({ force });
    console.log(`Container removed successfully: ${containerName}`);
  } catch (error) {
    if (error.statusCode === 404) {
      console.log(`Container not found: ${containerName}`);
      return;
    }
    console.error(
      `Failed to remove container ${containerName}:`,
      error.message
    );
    throw new Error(`Container removal failed: ${error.message}`);
  }
}

/**
 * Check if container is running
 * @param {string} instanceId - Instance ID
 * @returns {Promise<boolean>} True if container is running
 */
async function isContainerRunning(instanceId) {
  const containerName = `code-server-${instanceId}`;

  try {
    const container = docker.getContainer(containerName);
    const info = await container.inspect();
    return info.State.Running === true;
  } catch (error) {
    if (error.statusCode === 404) {
      return false;
    }
    console.error(
      `Error checking container status ${containerName}:`,
      error.message
    );
    return false;
  }
}

/**
 * Inspect a container
 * @param {string} instanceId - Instance ID
 * @returns {Promise<Object|null>} Container info or null if not found
 */
async function inspectContainer(instanceId) {
  const containerName = `code-server-${instanceId}`;

  try {
    const container = docker.getContainer(containerName);
    return await container.inspect();
  } catch (error) {
    if (error.statusCode === 404) {
      return null;
    }
    console.error(
      `Error inspecting container ${containerName}:`,
      error.message
    );
    throw error;
  }
}

/**
 * Check if a container is using the current image
 * Returns true if container needs to be recreated due to image update
 * @param {string} instanceId - Instance ID
 * @returns {Promise<boolean>} True if container needs recreation
 */
async function isContainerImageOutdated(instanceId) {
  try {
    // Get current image ID (cached with 1-minute TTL)
    const now = Date.now();
    if (!cachedImageId || now - cacheTimestamp > IMAGE_CACHE_TTL) {
      const imageInfo = await docker.getImage(DOCKER_IMAGE).inspect();
      cachedImageId = imageInfo.Id;
      cacheTimestamp = now;
    }
    const currentImageId = cachedImageId;

    // Get container info
    const containerInfo = await inspectContainer(instanceId);
    if (!containerInfo) {
      return false; // Container doesn't exist, no need to recreate
    }

    const containerImageId = containerInfo.Image;

    // Compare image IDs
    if (containerImageId !== currentImageId) {
      console.log(
        `Container ${instanceId} is using outdated image ${containerImageId.substring(7, 19)}, current is ${currentImageId.substring(7, 19)}`
      );
      return true;
    }

    return false;
  } catch (error) {
    console.error(
      `Error checking container image for ${instanceId}:`,
      error.message
    );
    return false; // On error, don't recreate
  }
}

/**
 * Get container logs
 * @param {string} instanceId - Instance ID
 * @param {number} tail - Number of lines to retrieve
 * @returns {Promise<string>} Container logs
 */
async function getContainerLogs(instanceId, tail = 100) {
  const containerName = `code-server-${instanceId}`;

  try {
    const container = docker.getContainer(containerName);
    const logs = await container.logs({
      stdout: true,
      stderr: true,
      tail,
      timestamps: true,
    });
    return logs.toString('utf8');
  } catch (error) {
    console.error(
      `Error getting logs for container ${containerName}:`,
      error.message
    );
    throw error;
  }
}

/**
 * Remove volumes for an instance
 * @param {string} instanceId - Instance ID
 * @returns {Promise<void>}
 */
async function removeVolumes(instanceId) {
  const configVolume = `code-server-${instanceId}-config`;

  try {
    console.log(`Removing config volume: ${configVolume}`);
    const volume = docker.getVolume(configVolume);
    await volume.remove();
    console.log(`Volume removed successfully: ${configVolume}`);
  } catch (error) {
    if (error.statusCode === 404) {
      console.log(`Volume not found: ${configVolume}`);
      return;
    }
    console.error(`Failed to remove volume ${configVolume}:`, error.message);
    throw new Error(`Volume removal failed: ${error.message}`);
  }
}

/**
 * Wait for container to be ready
 * @param {string} instanceId - Instance ID
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<boolean>} True if container is ready
 */
async function waitForContainerReady(instanceId, timeout = 30000) {
  const startTime = Date.now();
  const containerName = `code-server-${instanceId}`;

  while (Date.now() - startTime < timeout) {
    try {
      const container = docker.getContainer(containerName);
      const info = await container.inspect();

      if (info.State.Running && info.State.Health) {
        if (info.State.Health.Status === 'healthy') {
          return true;
        }
      } else if (info.State.Running) {
        // No health check defined, assume ready if running
        return true;
      }
    } catch {
      // Container not found or other error, keep waiting
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return false;
}

/**
 * Pull Docker image if not present
 * @param {string} imageName - Image name to pull
 * @returns {Promise<void>}
 */
async function pullImage(imageName = DOCKER_IMAGE) {
  console.log(`Checking for image: ${imageName}`);

  try {
    await docker.getImage(imageName).inspect();
    console.log(`Image exists: ${imageName}`);
  } catch (error) {
    if (error.statusCode === 404) {
      console.log(`Pulling image: ${imageName} (this may take a while...)`);
      const stream = await docker.pull(imageName);

      await new Promise((resolve, reject) => {
        docker.modem.followProgress(
          stream,
          (err, output) => {
            if (err) {
              reject(err);
            } else {
              console.log(`Image pulled successfully: ${imageName}`);
              resolve(output);
            }
          },
          (event) => {
            if (event.status) {
              console.log(`  ${event.status} ${event.progress || ''}`);
            }
          }
        );
      });
    } else {
      throw error;
    }
  }
}

/**
 * Backup volume to tarball
 * @param {string} instanceId - Instance ID
 * @param {string} backupPath - Path to save backup tarball
 * @returns {Promise<void>}
 */
async function backupVolume(instanceId, backupPath) {
  const volumeName = `code-server-${instanceId}-config`;
  const fs = require('fs');

  console.log(`Backing up volume ${volumeName} to ${backupPath}`);

  try {
    // Create temporary container to access volume
    const tempContainer = await docker.createContainer({
      Image: 'alpine:latest',
      Cmd: ['tar', 'czf', '/backup/volume-backup.tar.gz', '-C', '/data', '.'],
      HostConfig: {
        Binds: [
          `${volumeName}:/data:ro`,
          `${path.dirname(backupPath)}:/backup`,
        ],
        AutoRemove: true,
      },
    });

    await tempContainer.start();
    await tempContainer.wait();

    // Rename backup file to target name
    const tempBackupPath = path.join(
      path.dirname(backupPath),
      'volume-backup.tar.gz'
    );
    fs.renameSync(tempBackupPath, backupPath);

    console.log(`Volume backup completed: ${backupPath}`);
  } catch (error) {
    console.error(`Failed to backup volume ${volumeName}:`, error.message);
    throw new Error(`Volume backup failed: ${error.message}`);
  }
}

/**
 * Restore volume from tarball
 * @param {string} instanceId - Instance ID
 * @param {string} backupPath - Path to backup tarball
 * @returns {Promise<void>}
 */
async function restoreVolume(instanceId, backupPath) {
  const volumeName = `code-server-${instanceId}-config`;
  const fs = require('fs');

  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup file not found: ${backupPath}`);
  }

  console.log(`Restoring volume ${volumeName} from ${backupPath}`);

  try {
    // Ensure volume exists
    await createConfigVolume(instanceId);

    // Create temporary container to restore volume
    const tempContainer = await docker.createContainer({
      Image: 'alpine:latest',
      Cmd: [
        'tar',
        'xzf',
        '/backup/volume-backup.tar.gz',
        '-C',
        '/data',
        '--strip-components=0',
      ],
      HostConfig: {
        Binds: [`${volumeName}:/data`, `${path.dirname(backupPath)}:/backup`],
        AutoRemove: true,
      },
    });

    await tempContainer.start();
    await tempContainer.wait();

    console.log(`Volume restore completed: ${volumeName}`);
  } catch (error) {
    console.error(`Failed to restore volume ${volumeName}:`, error.message);
    throw new Error(`Volume restore failed: ${error.message}`);
  }
}

/**
 * Check volume health
 * @param {string} instanceId - Instance ID
 * @returns {Promise<Object>} Volume health info
 */
async function checkVolumeHealth(instanceId) {
  const volumeName = `code-server-${instanceId}-config`;

  try {
    const volume = docker.getVolume(volumeName);
    const info = await volume.inspect();

    const health = {
      name: volumeName,
      exists: true,
      driver: info.Driver,
      mountpoint: info.Mountpoint,
      created: info.CreatedAt,
      labels: info.Labels,
      scope: info.Scope,
    };

    // Check if volume is in use
    if (info.Options && info.Options.device) {
      health.device = info.Options.device;
    }

    console.log(`Volume ${volumeName} is healthy`);
    return health;
  } catch (error) {
    if (error.statusCode === 404) {
      return {
        name: volumeName,
        exists: false,
        error: 'Volume not found',
      };
    }
    throw new Error(`Volume health check failed: ${error.message}`);
  }
}

/**
 * Migrate systemd user-data-dir to Docker volume
 * @param {string} instanceId - Instance ID
 * @param {string} systemdDataPath - Path to systemd user-data-dir
 * @returns {Promise<void>}
 */
async function migrateToVolume(instanceId, systemdDataPath) {
  const fs = require('fs');

  if (!fs.existsSync(systemdDataPath)) {
    throw new Error(`Systemd data path not found: ${systemdDataPath}`);
  }

  console.log(`Migrating ${systemdDataPath} to Docker volume`);

  const volumeName = `code-server-${instanceId}-config`;

  try {
    // Ensure volume exists
    await createConfigVolume(instanceId);

    // Create temporary container to copy data
    const tempContainer = await docker.createContainer({
      Image: 'alpine:latest',
      Cmd: ['sh', '-c', 'cp -a /source/. /target/'],
      HostConfig: {
        Binds: [`${systemdDataPath}:/source:ro`, `${volumeName}:/target`],
        AutoRemove: true,
      },
    });

    await tempContainer.start();
    await tempContainer.wait();

    console.log(`Migration completed: ${volumeName}`);
  } catch (error) {
    console.error(`Migration failed for ${instanceId}:`, error.message);
    throw new Error(`Volume migration failed: ${error.message}`);
  }
}

/**
 * Get container last activity timestamp
 * @param {string} instanceId - Instance ID
 * @returns {Promise<Date|null>} Last activity timestamp or null if not found
 */
async function getContainerLastActivity(instanceId) {
  const containerName = `code-server-${instanceId}`;

  try {
    const container = docker.getContainer(containerName);
    const info = await container.inspect();

    // Check if container exists
    if (!info) {
      return null;
    }

    // Use container's last state change time as activity indicator
    // This includes start, stop, and other state transitions
    const finishedAt = info.State.FinishedAt;
    const startedAt = info.State.StartedAt;

    // If container is running, use StartedAt
    // If container is stopped, use FinishedAt
    let activityTime;
    if (info.State.Running) {
      activityTime = new Date(startedAt);
    } else if (finishedAt && finishedAt !== '0001-01-01T00:00:00Z') {
      activityTime = new Date(finishedAt);
    } else {
      activityTime = new Date(startedAt);
    }

    return activityTime;
  } catch (error) {
    if (error.statusCode === 404) {
      return null;
    }
    console.error(
      `Error getting last activity for ${containerName}:`,
      error.message
    );
    throw error;
  }
}

/**
 * Check if container is idle beyond threshold
 * @param {string} instanceId - Instance ID
 * @param {number} thresholdDays - Idle threshold in days
 * @returns {Promise<Object>} Idle status with details
 */
async function isContainerIdle(
  instanceId,
  thresholdDays = IDLE_THRESHOLD_DAYS
) {
  // Check whitelist
  if (IDLE_WHITELIST.includes(instanceId)) {
    return {
      idle: false,
      whitelisted: true,
      instanceId,
    };
  }

  const lastActivity = await getContainerLastActivity(instanceId);

  if (!lastActivity) {
    return {
      idle: false,
      notFound: true,
      instanceId,
    };
  }

  const now = new Date();
  const idleMillis = now - lastActivity;
  const idleDays = idleMillis / (1000 * 60 * 60 * 24);

  const isIdle = idleDays > thresholdDays;

  return {
    idle: isIdle,
    idleDays: Math.floor(idleDays),
    lastActivity: lastActivity.toISOString(),
    instanceId,
    thresholdDays,
  };
}

/**
 * Stop idle containers
 * @param {number} thresholdDays - Idle threshold in days
 * @returns {Promise<Array>} List of stopped containers
 */
async function stopIdleContainers(thresholdDays = IDLE_THRESHOLD_DAYS) {
  const stoppedContainers = [];

  try {
    // List all code-server containers
    const containers = await docker.listContainers({
      all: true,
      filters: {
        label: ['app=code-server-proxy'],
      },
    });

    for (const containerInfo of containers) {
      const instanceId = containerInfo.Labels.instanceId;
      if (!instanceId) {
        continue;
      }

      const idleStatus = await isContainerIdle(instanceId, thresholdDays);

      if (idleStatus.idle && containerInfo.State === 'running') {
        console.log(
          `Stopping idle container: ${instanceId} (idle: ${idleStatus.idleDays} days)`
        );

        try {
          await stopContainer(instanceId);
          stoppedContainers.push({
            instanceId,
            idleDays: idleStatus.idleDays,
            lastActivity: idleStatus.lastActivity,
            stoppedAt: new Date().toISOString(),
          });
        } catch (error) {
          console.error(
            `Failed to stop idle container ${instanceId}:`,
            error.message
          );
        }
      }
    }

    if (stoppedContainers.length > 0) {
      console.log(`Stopped ${stoppedContainers.length} idle container(s)`);
    } else {
      console.log('No idle containers to stop');
    }

    return stoppedContainers;
  } catch (error) {
    console.error('Error stopping idle containers:', error.message);
    throw error;
  }
}

/**
 * Cleanup idle containers after grace period
 * @param {number} gracePeriodDays - Grace period in days after stopping
 * @returns {Promise<Array>} List of cleaned up containers
 */
async function cleanupIdleContainers(gracePeriodDays = IDLE_GRACE_PERIOD_DAYS) {
  const cleanedContainers = [];

  try {
    // List all stopped code-server containers
    const containers = await docker.listContainers({
      all: true,
      filters: {
        label: ['app=code-server-proxy'],
        status: ['exited'],
      },
    });

    for (const containerInfo of containers) {
      const instanceId = containerInfo.Labels.instanceId;
      if (!instanceId) {
        continue;
      }

      // Check whitelist
      if (IDLE_WHITELIST.includes(instanceId)) {
        console.log(`Skipping whitelisted container: ${instanceId}`);
        continue;
      }

      const lastActivity = await getContainerLastActivity(instanceId);
      if (!lastActivity) {
        continue;
      }

      const now = new Date();
      const idleMillis = now - lastActivity;
      const idleDays = idleMillis / (1000 * 60 * 60 * 24);

      if (idleDays > gracePeriodDays) {
        console.log(
          `Cleaning up idle container: ${instanceId} (idle: ${Math.floor(idleDays)} days)`
        );

        try {
          // Backup volume before removal
          const backupPath = path.join(
            WORKSPACE_VOLUMES_PATH,
            `${instanceId}-${Date.now()}.tar.gz`
          );

          const fs = require('fs');
          if (!fs.existsSync(WORKSPACE_VOLUMES_PATH)) {
            fs.mkdirSync(WORKSPACE_VOLUMES_PATH, { recursive: true });
          }

          await backupVolume(instanceId, backupPath);
          console.log(`Volume backed up to: ${backupPath}`);

          // Remove container and volumes
          await removeContainer(instanceId, true);
          await removeVolumes(instanceId);

          cleanedContainers.push({
            instanceId,
            idleDays: Math.floor(idleDays),
            lastActivity: lastActivity.toISOString(),
            backupPath,
            cleanedAt: new Date().toISOString(),
          });
        } catch (error) {
          console.error(
            `Failed to cleanup container ${instanceId}:`,
            error.message
          );
        }
      }
    }

    if (cleanedContainers.length > 0) {
      console.log(`Cleaned up ${cleanedContainers.length} idle container(s)`);
    } else {
      console.log('No idle containers to cleanup');
    }

    return cleanedContainers;
  } catch (error) {
    console.error('Error cleaning up idle containers:', error.message);
    throw error;
  }
}

module.exports = {
  isDockerAvailable,
  createContainer,
  startContainer,
  createWorkspaceSymlink,
  stopContainer,
  removeContainer,
  isContainerRunning,
  inspectContainer,
  isContainerImageOutdated,
  getContainerLogs,
  createConfigVolume,
  ensureSharedExtensionsVolume,
  removeVolumes,
  waitForContainerReady,
  pullImage,
  backupVolume,
  restoreVolume,
  checkVolumeHealth,
  migrateToVolume,
  getContainerLastActivity,
  isContainerIdle,
  stopIdleContainers,
  cleanupIdleContainers,
};
