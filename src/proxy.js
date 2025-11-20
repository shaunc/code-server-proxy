#!/usr/bin/env node

/**
 * Code-Server Workspace Isolation Proxy
 *
 * This reverse proxy routes code-server requests to isolated workspace
 * instances based on URL query parameters. It provides workspace isolation
 * by launching separate code-server instances for each workspace/folder.
 */

const http = require('http');
const httpProxy = require('http-proxy');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const { URL } = require('url');

const execAsync = promisify(exec);

// Docker support
const USE_DOCKER = process.env.USE_DOCKER === 'true';
const containerManager = USE_DOCKER ? require('./container-manager') : null;

// Activity tracking for idle detection
const activityTracker = require('./activity-tracker');

// Settings sync service (only in Docker mode)
const settingsSync = USE_DOCKER ? require('./settings-sync') : null;

// Configuration
const PROXY_PORT = 8083;
const PROXY_HOST = '127.0.0.1';
const MAIN_PORT = 8100;
const WORKSPACE_PORT_MIN = 8101;
const WORKSPACE_PORT_MAX = 8199;
const MAX_CONCURRENT_INSTANCES = 30;
const MAX_PROBE_ATTEMPTS = 20;
const WORKSPACES_DIR = path.join(process.env.HOME, '.code-workspaces');
const BASE_DIR = path.join(WORKSPACES_DIR, 'instances');
const REGISTRY_PATH = path.join(WORKSPACES_DIR, 'port-registry.json');
const SHARED_SETTINGS_DIR = path.join(WORKSPACES_DIR, 'shared');
const BACKEND_READY_TIMEOUT = 30000; // 30 seconds
const BACKEND_READY_POLL_INTERVAL = 500; // 500ms
const SESSION_COOKIE_NAME = 'code-server-proxy-session';
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Lock mechanism to prevent concurrent container operations
// Maps instance ID to promise that resolves when operation completes
const instanceLocks = new Map();

// Session management for maintaining routing context
// Maps session ID to workspace routing information
const sessionMap = new Map();

/**
 * Generate a unique session ID
 * @returns {string} UUID v4 session ID
 */
function generateSessionId() {
  return crypto.randomUUID();
}

/**
 * Extract session cookie from request
 * @param {http.IncomingMessage} req - Request object
 * @returns {string|null} Session ID or null
 */
function extractSessionCookie(req) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) {
    return null;
  }

  const cookies = cookieHeader.split(';').map((c) => c.trim());
  for (const cookie of cookies) {
    const [name, value] = cookie.split('=');
    if (name === SESSION_COOKIE_NAME) {
      return value;
    }
  }
  return null;
}

/**
 * Create session for workspace routing
 * @param {string} workspacePath - Workspace path
 * @param {string} instanceId - Instance ID
 * @param {number} port - Port number
 * @returns {string} Session ID
 */
function createSession(workspacePath, instanceId, port) {
  const sessionId = generateSessionId();
  sessionMap.set(sessionId, {
    workspacePath,
    instanceId,
    port,
    created: Date.now(),
    lastAccess: Date.now(),
  });
  return sessionId;
}

/**
 * Get session information
 * @param {string} sessionId - Session ID
 * @returns {Object|null} Session info or null if expired/not found
 */
function getSession(sessionId) {
  if (!sessionId || !sessionMap.has(sessionId)) {
    return null;
  }

  const session = sessionMap.get(sessionId);
  const now = Date.now();

  // Check if session expired
  if (now - session.lastAccess > SESSION_TTL) {
    sessionMap.delete(sessionId);
    return null;
  }

  // Update last access time
  session.lastAccess = now;
  return session;
}

/**
 * Cleanup expired sessions (run periodically)
 */
function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [sessionId, session] of sessionMap.entries()) {
    if (now - session.lastAccess > SESSION_TTL) {
      console.log(`[SESSION] Expired session ${sessionId}`);
      sessionMap.delete(sessionId);
    }
  }
}

// Cleanup expired sessions every hour
setInterval(cleanupExpiredSessions, 60 * 60 * 1000);

// Create HTTP proxy
const proxy = httpProxy.createProxyServer({
  ws: true,
});

// Handle proxy errors
proxy.on('error', (err, req, res) => {
  console.error('Proxy error:', err.message);
  // Check if this is a WebSocket (socket object) or HTTP response
  if (res && typeof res.writeHead === 'function' && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Bad Gateway: Unable to connect to backend code-server instance');
  } else if (res && typeof res.destroy === 'function') {
    // WebSocket - just destroy the socket
    res.destroy();
  }
});

// Intercept proxy responses to rewrite redirect Location headers and inject session cookies
proxy.on('proxyRes', (proxyRes, req, res) => {
  const statusCode = proxyRes.statusCode;

  // Inject session cookie if this is a new session
  if (req._sessionId) {
    const cookieValue = `${SESSION_COOKIE_NAME}=${req._sessionId}; HttpOnly; Path=/; Max-Age=${SESSION_TTL / 1000}; SameSite=Lax`;

    // Add Set-Cookie header (preserve existing cookies if any)
    const existingCookies = proxyRes.headers['set-cookie'] || [];
    if (Array.isArray(existingCookies)) {
      proxyRes.headers['set-cookie'] = [...existingCookies, cookieValue];
    } else if (existingCookies) {
      proxyRes.headers['set-cookie'] = [existingCookies, cookieValue];
    } else {
      proxyRes.headers['set-cookie'] = [cookieValue];
    }

    console.log(
      `[SESSION] Set session cookie: ${req._sessionId.substring(0, 8)}`
    );
  }

  // Only intercept 3xx redirects
  if (statusCode >= 300 && statusCode < 400 && proxyRes.headers.location) {
    const location = proxyRes.headers.location;

    try {
      // Parse the redirect location
      const redirectUrl = new URL(
        location,
        `http://${PROXY_HOST}:${PROXY_PORT}${req.url}`
      );

      // No path rewriting needed with direct mounting
      // Code-server uses actual host paths, which work in both proxy and container

      // Construct the new location (preserve relative vs absolute)
      let newLocation;
      if (location.startsWith('http://') || location.startsWith('https://')) {
        // Absolute URL
        newLocation = `${redirectUrl.pathname}${redirectUrl.search}`;
      } else {
        // Relative URL
        newLocation = `${redirectUrl.pathname}${redirectUrl.search}`;
      }

      console.log(`[REDIRECT] ${location} -> ${newLocation}`);

      proxyRes.headers.location = newLocation;
    } catch (error) {
      console.error('Error rewriting redirect location:', error.message);
    }
  }
});

/**
 * Compute full SHA256 instance ID from workspace/folder path
 * @param {string} workspacePath - The workspace or folder path
 * @returns {string} Full SHA256 hash
 */
function computeInstanceId(workspacePath) {
  return crypto.createHash('sha256').update(workspacePath).digest('hex');
}

/**
 * Load port registry from disk with file locking
 * @returns {Object} Registry object with workspaces and ports mappings
 */
function loadRegistry() {
  try {
    if (fs.existsSync(REGISTRY_PATH)) {
      const data = fs.readFileSync(REGISTRY_PATH, 'utf8');
      const registry = JSON.parse(data);
      return {
        workspaces: registry.workspaces || {},
        ports: registry.ports || {},
      };
    }
  } catch (error) {
    console.error('Error loading registry, creating new one:', error.message);
  }
  return { workspaces: {}, ports: {} };
}

/**
 * Save port registry to disk with file locking
 * @param {Object} registry - Registry object to save
 */
function saveRegistry(registry) {
  ensureDir(WORKSPACES_DIR);
  const data = JSON.stringify(registry, null, 2);
  fs.writeFileSync(REGISTRY_PATH, data, 'utf8');
}

/**
 * Validate port is actually listening
 * @param {number} port - Port number to check
 * @returns {Promise<boolean>} True if port is listening
 */
async function validatePortAvailability(port) {
  return await isPortListening(port);
}

/**
 * Clean up stale entries in registry
 * @param {Object} registry - Registry object
 * @returns {Promise<Object>} Cleaned registry
 */
async function cleanupStaleEntries(registry) {
  const cleaned = { workspaces: {}, ports: {} };

  for (const [workspacePath, entry] of Object.entries(registry.workspaces)) {
    const port = entry.currentPort;
    if (await validatePortAvailability(port)) {
      cleaned.workspaces[workspacePath] = entry;
      cleaned.ports[port] = registry.ports[port];
    } else {
      console.log(
        `Removing stale registry entry for ${workspacePath} (port ${port} not listening)`
      );
    }
  }

  return cleaned;
}

/**
 * Allocate port for workspace with linear probing collision resolution
 * @param {string} workspacePath - The workspace or folder path
 * @param {Object} registry - Current registry state
 * @returns {number} Allocated port number
 * @throws {Error} If no ports available after MAX_PROBE_ATTEMPTS
 */
function allocatePort(workspacePath, registry) {
  const hash = crypto.createHash('sha256').update(workspacePath).digest('hex');
  const numericHash = parseInt(hash.substring(0, 8), 16);
  const portRange = WORKSPACE_PORT_MAX - WORKSPACE_PORT_MIN + 1;
  const basePort = WORKSPACE_PORT_MIN + (numericHash % portRange);

  for (let attempt = 0; attempt < MAX_PROBE_ATTEMPTS; attempt++) {
    const candidatePort =
      WORKSPACE_PORT_MIN +
      ((basePort - WORKSPACE_PORT_MIN + attempt) % portRange);

    if (!registry.ports[candidatePort]) {
      return candidatePort;
    }

    console.log(
      `Port ${candidatePort} collision detected (attempt ${attempt + 1}/${MAX_PROBE_ATTEMPTS})`
    );
  }

  throw new Error(
    `All available ports exhausted after ${MAX_PROBE_ATTEMPTS} attempts. ` +
      'Please stop unused workspace instances.'
  );
}

/**
 * Get or allocate port for workspace from registry
 * @param {string} workspacePath - The workspace or folder path
 * @returns {Promise<{port: number, instanceId: string}>} Port and instance ID
 */
async function getOrAllocatePort(workspacePath) {
  let registry = loadRegistry();

  registry = await cleanupStaleEntries(registry);

  if (registry.workspaces[workspacePath]) {
    const entry = registry.workspaces[workspacePath];
    return {
      port: entry.currentPort,
      instanceId: entry.instanceId,
    };
  }

  const instanceId = computeInstanceId(workspacePath);
  const port = allocatePort(workspacePath, registry);

  registry.workspaces[workspacePath] = {
    instanceId,
    currentPort: port,
    allocatedAt: new Date().toISOString(),
  };

  registry.ports[port] = {
    workspacePath,
    instanceId,
  };

  saveRegistry(registry);

  return { port, instanceId };
}

/**
 * Count active workspace instances (excluding main instance)
 * @returns {Promise<number>} Number of active workspace instances
 */
async function countActiveInstances() {
  const registry = loadRegistry();
  return Object.keys(registry.workspaces).length;
}

/**
 * Ensure directory exists, creating it if necessary
 * @param {string} dirPath - Directory path to create
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Create instance directory structure and metadata
 * @param {string} instanceId - Full SHA256 instance ID
 * @param {string} workspacePath - Workspace or folder path
 * @param {number} port - Assigned port number
 */
function createInstanceDirectory(instanceId, workspacePath, port) {
  const instanceDir = path.join(BASE_DIR, instanceId);
  ensureDir(instanceDir);
  ensureDir(path.join(instanceDir, 'data'));
  ensureDir(path.join(instanceDir, 'extensions'));
  ensureDir(path.join(instanceDir, 'logs'));

  const metadata = {
    workspacePath,
    port,
    created: new Date().toISOString(),
    instanceId,
    backend: USE_DOCKER ? 'docker' : 'systemd',
    containerName: USE_DOCKER ? `code-server-${instanceId}` : null,
  };

  const metadataPath = path.join(instanceDir, 'metadata.json');
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

  console.log(`Created instance directory: ${instanceDir}`);
  return instanceDir;
}

/**
 * Update last-access timestamp for instance
 * @param {string} instanceId - Instance ID
 */
function updateLastAccess(instanceId) {
  const instanceDir = path.join(BASE_DIR, instanceId);
  const lastAccessPath = path.join(instanceDir, 'last-access');
  const timestamp = new Date().toISOString();
  fs.writeFileSync(lastAccessPath, timestamp);
}

/**
 * Check if a port is listening
 * @param {number} port - Port number to check
 * @returns {Promise<boolean>} True if port is listening
 */
async function isPortListening(port) {
  return new Promise((resolve) => {
    const socket = new http.request({
      host: '127.0.0.1',
      port,
      method: 'GET',
      path: '/healthz',
      timeout: 1000,
    });

    socket.on('response', () => {
      resolve(true);
      socket.destroy();
    });

    socket.on('error', () => {
      resolve(false);
    });

    socket.on('timeout', () => {
      resolve(false);
      socket.destroy();
    });

    socket.end();
  });
}

/**
 * Wait for backend to be ready
 * @param {number} port - Port to check
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<boolean>} True if backend is ready
 */
async function waitForBackend(port, timeout = BACKEND_READY_TIMEOUT) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    if (await isPortListening(port)) {
      return true;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, BACKEND_READY_POLL_INTERVAL)
    );
  }
  return false;
}

/**
 * Launch code-server instance (Docker or systemd) - internal implementation
 * @param {string} instanceId - Instance ID
 * @param {string} workspacePath - Workspace path (required for Docker mode)
 * @param {number} port - Port number (required for Docker mode)
 * @returns {Promise<void>}
 */
async function launchInstanceUnsafe(instanceId, workspacePath, port) {
  if (USE_DOCKER) {
    console.log(`Launching instance via Docker: ${instanceId}`);

    try {
      // Check if container exists
      let containerExists = await containerManager.inspectContainer(instanceId);

      // Check if container is using outdated image and needs recreation
      if (containerExists) {
        const isOutdated =
          await containerManager.isContainerImageOutdated(instanceId);
        if (isOutdated) {
          console.log(
            `Container ${instanceId} is using outdated image, recreating...`
          );
          await containerManager.stopContainer(instanceId);
          await containerManager.removeContainer(instanceId);
          // Container removed, will be recreated below
          containerExists = false;
        }
      }

      // Create container if it doesn't exist (or was just removed due to outdated image)
      if (!containerExists) {
        console.log(`Creating new Docker container for ${instanceId}...`);
        await containerManager.createContainer(instanceId, workspacePath, port);
      }

      // Check if container is running
      const isRunning = await containerManager.isContainerRunning(instanceId);
      if (!isRunning) {
        // Start the container
        console.log(`Starting Docker container ${instanceId}...`);
        await containerManager.startContainer(instanceId);
      } else {
        console.log(`Container ${instanceId} is already running`);
      }
    } catch (error) {
      console.error(
        `Failed to launch Docker container ${instanceId}:`,
        error.message
      );
      throw new Error(`Failed to launch Docker container: ${error.message}`);
    }
  } else {
    // Systemd mode (existing implementation)
    const serviceName = `code-server-workspace@${instanceId}.service`;
    console.log(`Launching instance via systemd: ${serviceName}`);

    try {
      await execAsync(`systemctl --user start ${serviceName}`);
      console.log(`Successfully started ${serviceName}`);
    } catch (error) {
      console.error(`Failed to start ${serviceName}:`, error.message);
      throw new Error(`Failed to start systemd service: ${error.message}`);
    }
  }
}

/**
 * Launch code-server instance with locking to prevent concurrent creation/recreation
 * @param {string} instanceId - Instance ID
 * @param {string} workspacePath - Workspace path (required for Docker mode)
 * @param {number} port - Port number (required for Docker mode)
 * @returns {Promise<void>}
 */
async function launchInstance(instanceId, workspacePath, port) {
  if (!USE_DOCKER) {
    // Systemd mode doesn't need locking
    return launchInstanceUnsafe(instanceId, workspacePath, port);
  }

  // Check if there's already an operation in progress for this instance
  if (instanceLocks.has(instanceId)) {
    // Wait for the existing operation to complete
    await instanceLocks.get(instanceId);
    return;
  }

  // Check if container exists and is running
  const containerExists = await containerManager.inspectContainer(instanceId);
  const isRunning = await containerManager.isContainerRunning(instanceId);

  // Fast path: if running and image is up-to-date, nothing to do
  if (isRunning && containerExists) {
    const isOutdated =
      await containerManager.isContainerImageOutdated(instanceId);
    if (!isOutdated) {
      console.log(`Container ${instanceId} is already running`);
      return;
    }
    // Image is outdated, need to recreate (fall through to lock acquisition)
  }

  // If not running or image outdated, acquire lock to prevent concurrent creation
  const operationPromise = (async () => {
    try {
      await launchInstanceUnsafe(instanceId, workspacePath, port);
    } finally {
      // Clean up the lock when done
      instanceLocks.delete(instanceId);
    }
  })();

  instanceLocks.set(instanceId, operationPromise);
  await operationPromise;
}

/**
 * Parse URL query parameters
 * @param {string} urlString - Full URL string
 * @returns {Object} Parsed parameters
 */
function parseUrlParams(urlString) {
  try {
    const url = new URL(urlString, `http://${PROXY_HOST}:${PROXY_PORT}`);
    return {
      workspace: url.searchParams.get('workspace'),
      folder: url.searchParams.get('folder'),
      ew: url.searchParams.get('ew') === 'true',
      searchParams: url.searchParams,
      pathname: url.pathname,
    };
  } catch (error) {
    console.error('Error parsing URL:', error.message);
    return { searchParams: new URLSearchParams(), pathname: '/' };
  }
}

/**
 * Extract workspace ID from request for activity tracking
 * @param {http.IncomingMessage} req - Request object
 * @returns {string|null} - Workspace instance ID or null
 */
function extractWorkspaceId(req) {
  const params = parseUrlParams(req.url);

  // Get workspace path (from workspace or folder parameter)
  const workspacePath = params.workspace || params.folder;

  if (!workspacePath) {
    return null;
  }

  // Return the instance ID (SHA256 hash of workspace path)
  return computeInstanceId(workspacePath);
}

/**
 * Build hash-based redirect URL for external workspace/folder paths
 * @param {string} url - Original URL
 * @param {string} instanceId - Instance ID (SHA256 hash)
 * @param {string} workspacePath - Workspace or folder path
 * @param {Object} params - Parsed URL parameters
 * @returns {string} - Hash-based URL for redirect
 */
function buildHashBasedUrl(url, instanceId, workspacePath, params) {
  const urlObj = new URL(url, `http://${PROXY_HOST}:${PROXY_PORT}`);
  const hash = instanceId.substring(0, 8);

  if (params.workspace) {
    // Extract workspace name for readable symlink
    const isWorkspaceFile = workspacePath.endsWith('.code-workspace');

    if (isWorkspaceFile) {
      // Use workspace filename: ovid_a.code-workspace -> ovid_a-c9ab060f.code-workspace
      const basename = path.basename(workspacePath);
      const workspaceName = basename.replace('.code-workspace', '');
      const hashPath = `/workspace/${workspaceName}-${hash}.code-workspace`;
      urlObj.searchParams.set('workspace', hashPath);
    } else {
      // For folders, use directory name
      const folderName = path.basename(workspacePath);
      const hashPath = `/ws-${folderName}-${hash}`;
      urlObj.searchParams.set('workspace', hashPath);
    }
  } else if (params.folder) {
    // Extract directory name for readable symlink
    const folderName = path.basename(workspacePath);
    const hashPath = `/ws-${folderName}-${hash}`;
    urlObj.searchParams.set('folder', hashPath);
  }

  return urlObj.pathname + urlObj.search;
}

/**
 * Parse workspace hash from URL for hash-based routing
 * @param {Object} params - Parsed URL parameters
 * @returns {string|null} - Hash (8 chars) or null if not hash-based
 */
function parseWorkspaceHash(params) {
  // Check workspace parameter
  if (params.workspace) {
    // Handle /workspace/<repo>-<hash>.code-workspace format
    if (params.workspace.startsWith('/workspace/')) {
      const filename = params.workspace.substring(11); // Remove '/workspace/'
      const withoutExt = filename.replace('.code-workspace', '');
      // Hash is last 8 chars after final dash
      const lastDash = withoutExt.lastIndexOf('-');
      if (lastDash !== -1) {
        return withoutExt.substring(lastDash + 1);
      }
    }
    // Handle /ws-<repo>-<hash> format for folders
    else if (params.workspace.startsWith('/ws-')) {
      const withoutPrefix = params.workspace.substring(4); // Remove '/ws-'
      const withoutExt = withoutPrefix.replace('.code-workspace', '');
      // Hash is last 8 chars after final dash
      const lastDash = withoutExt.lastIndexOf('-');
      if (lastDash !== -1) {
        return withoutExt.substring(lastDash + 1);
      }
    }
  }

  // Check folder parameter
  if (params.folder && params.folder.startsWith('/ws-')) {
    const withoutPrefix = params.folder.substring(4); // Remove '/ws-'
    // Hash is last 8 chars after final dash
    const lastDash = withoutPrefix.lastIndexOf('-');
    if (lastDash !== -1) {
      return withoutPrefix.substring(lastDash + 1);
    }
  }

  return null;
}

/**
 * Handle incoming request and route to appropriate backend
 * @param {http.IncomingMessage} req - Request object
 * @param {http.ServerResponse} res - Response object
 */
async function handleRequest(req, res) {
  try {
    console.log('='.repeat(80));
    console.log(`[REQUEST] ${req.method} ${req.url}`);
    console.log(`[REQUEST] Headers: ${JSON.stringify(req.headers)}`);

    const params = parseUrlParams(req.url);
    console.log(`[PARSED] workspace: ${params.workspace || 'none'}`);
    console.log(`[PARSED] folder: ${params.folder || 'none'}`);
    console.log(`[PARSED] ew: ${params.ew || false}`);

    // Determine target port and instance
    let targetPort = MAIN_PORT;
    let instanceId = 'main';
    let workspacePath = null;

    // Routing logic - check in order of priority
    // 1. Check for session cookie first (for requests without workspace/folder params)
    const sessionId = extractSessionCookie(req);
    let sessionRouted = false;

    if (sessionId && !params.workspace && !params.folder && !params.ew) {
      const session = getSession(sessionId);
      if (session) {
        // Route based on session
        instanceId = session.instanceId;
        targetPort = session.port;
        workspacePath = session.workspacePath;
        sessionRouted = true;
        console.log(
          `[SESSION] Using session ${sessionId.substring(0, 8)} -> instance ${instanceId} on port ${targetPort}`
        );

        // Ensure instance is running with correct image (checks outdated, exists, running)
        await launchInstance(instanceId, workspacePath, targetPort);

        // Wait for backend if it was just started
        if (!(await isPortListening(targetPort))) {
          console.log(
            `Waiting for backend on port ${targetPort} to be ready...`
          );
          const ready = await waitForBackend(targetPort);
          if (!ready) {
            res.writeHead(503, { 'Content-Type': 'text/plain' });
            res.end(
              'Service Unavailable: Backend instance failed to start in time'
            );
            return;
          }
          console.log(`Backend on port ${targetPort} is ready`);
        }
      } else {
        console.log(
          `[SESSION] Invalid or expired session ${sessionId.substring(0, 8)}`
        );
        // Fall through to default routing
      }
    }

    // 2. Route based on URL parameters (skip if session routing succeeded)
    if (!sessionRouted && params.ew) {
      console.log('[ROUTING] Bare mode request (ew=true) -> main instance');
      targetPort = MAIN_PORT;
      instanceId = 'main';

      // Check if main instance is running, launch if needed
      if (!(await isPortListening(targetPort))) {
        console.log(`Main instance not running, launching ${instanceId}...`);
        await launchInstance(instanceId, null, targetPort);

        console.log(
          `Waiting for main instance on port ${targetPort} to be ready...`
        );
        const ready = await waitForBackend(targetPort);
        if (!ready) {
          res.writeHead(503, { 'Content-Type': 'text/plain' });
          res.end('Service Unavailable: Main instance failed to start in time');
          return;
        }
        console.log(`Main instance on port ${targetPort} is ready`);
      }
    }
    // 3. Workspace mode
    else if (!sessionRouted && params.workspace) {
      workspacePath = params.workspace;
      console.log(`[ROUTING] Workspace mode request: ${workspacePath}`);

      if (!path.isAbsolute(workspacePath)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request: workspace path must be absolute');
        return;
      }

      // Check instance limit
      const activeCount = await countActiveInstances();
      const registry = loadRegistry();
      const isExisting = !!registry.workspaces[workspacePath];

      if (!isExisting && activeCount >= MAX_CONCURRENT_INSTANCES) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end(
          `Service Unavailable: Maximum concurrent instances (${MAX_CONCURRENT_INSTANCES}) reached. ` +
            'Please stop unused workspace instances before opening new ones.'
        );
        return;
      }

      const { port, instanceId: allocatedId } =
        await getOrAllocatePort(workspacePath);
      targetPort = port;
      instanceId = allocatedId;

      console.log(
        `[ROUTING] Allocated port ${targetPort} for instance ${instanceId}`
      );

      // Ensure instance exists
      const instanceDir = path.join(BASE_DIR, instanceId);
      if (!fs.existsSync(instanceDir)) {
        createInstanceDirectory(instanceId, workspacePath, targetPort);
      }

      // Check if instance is running, launch if needed
      if (!(await isPortListening(targetPort))) {
        console.log(`Instance not running, launching ${instanceId}...`);
        await launchInstance(instanceId, workspacePath, targetPort);

        console.log(`Waiting for backend on port ${targetPort} to be ready...`);
        const ready = await waitForBackend(targetPort);
        if (!ready) {
          res.writeHead(503, { 'Content-Type': 'text/plain' });
          res.end(
            'Service Unavailable: Backend instance failed to start in time'
          );
          return;
        }
        console.log(`Backend on port ${targetPort} is ready`);
      }

      // Create session for this workspace
      const newSessionId = createSession(workspacePath, instanceId, targetPort);
      console.log(
        `[SESSION] Created session ${newSessionId.substring(0, 8)} for workspace ${workspacePath}`
      );

      // Attach session ID to request so we can set cookie in response
      req._sessionId = newSessionId;
    }
    // 4. Folder mode
    else if (!sessionRouted && params.folder) {
      workspacePath = params.folder;
      console.log(`[ROUTING] Folder mode request: ${workspacePath}`);

      if (!path.isAbsolute(workspacePath)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request: folder path must be absolute');
        return;
      }

      // Check instance limit
      const activeCount = await countActiveInstances();
      const registry = loadRegistry();
      const isExisting = !!registry.workspaces[workspacePath];

      if (!isExisting && activeCount >= MAX_CONCURRENT_INSTANCES) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end(
          `Service Unavailable: Maximum concurrent instances (${MAX_CONCURRENT_INSTANCES}) reached. ` +
            'Please stop unused workspace instances before opening new ones.'
        );
        return;
      }

      const { port, instanceId: allocatedId } =
        await getOrAllocatePort(workspacePath);
      targetPort = port;
      instanceId = allocatedId;

      console.log(
        `[ROUTING] Allocated port ${targetPort} for instance ${instanceId}`
      );

      // Ensure instance exists
      const instanceDir = path.join(BASE_DIR, instanceId);
      if (!fs.existsSync(instanceDir)) {
        createInstanceDirectory(instanceId, workspacePath, targetPort);
      }

      // Check if instance is running, launch if needed
      if (!(await isPortListening(targetPort))) {
        console.log(`Instance not running, launching ${instanceId}...`);
        await launchInstance(instanceId, workspacePath, targetPort);

        console.log(`Waiting for backend on port ${targetPort} to be ready...`);
        const ready = await waitForBackend(targetPort);
        if (!ready) {
          res.writeHead(503, { 'Content-Type': 'text/plain' });
          res.end(
            'Service Unavailable: Backend instance failed to start in time'
          );
          return;
        }
        console.log(`Backend on port ${targetPort} is ready`);
      }

      // Create session for this folder
      const newSessionId = createSession(workspacePath, instanceId, targetPort);
      console.log(
        `[SESSION] Created session ${newSessionId.substring(0, 8)} for folder ${workspacePath}`
      );

      // Attach session ID to request so we can set cookie in response
      req._sessionId = newSessionId;
    }
    // 5. Default to main instance (if no session and no params)
    else if (!sessionRouted) {
      console.log(
        '[ROUTING] Default request (no workspace/folder) -> main instance'
      );
      targetPort = MAIN_PORT;
      instanceId = 'main';

      // Check if main instance is running, launch if needed
      if (!(await isPortListening(targetPort))) {
        console.log(`Main instance not running, launching ${instanceId}...`);
        await launchInstance(instanceId, null, targetPort);

        console.log(
          `Waiting for main instance on port ${targetPort} to be ready...`
        );
        const ready = await waitForBackend(targetPort);
        if (!ready) {
          res.writeHead(503, { 'Content-Type': 'text/plain' });
          res.end('Service Unavailable: Main instance failed to start in time');
          return;
        }
        console.log(`Main instance on port ${targetPort} is ready`);
      }
    }

    // Update last-access timestamp
    updateLastAccess(instanceId);

    // Track activity for idle detection (WebSocket traffic monitoring)
    const workspaceId = extractWorkspaceId(req);
    if (workspaceId) {
      activityTracker.recordActivity(workspaceId);
    }

    // Attach routing context to request (for redirect handler)
    req._instanceId = instanceId;
    req._workspacePath = workspacePath;

    // Proxy the request
    const target = `http://127.0.0.1:${targetPort}`;
    console.log(`[PROXY] Proxying ${req.method} ${req.url} -> ${target}`);
    console.log(`[PROXY] Instance: ${instanceId}, Port: ${targetPort}`);
    console.log('='.repeat(80));
    proxy.web(req, res, { target });
  } catch (error) {
    console.error('Error handling request:', error);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Internal Server Error: ${error.message}`);
    }
  }
}

/**
 * Handle WebSocket upgrade request
 * @param {http.IncomingMessage} req - Request object
 * @param {net.Socket} socket - Socket object
 * @param {Buffer} head - First packet of upgraded stream
 */
async function handleUpgrade(req, socket, head) {
  try {
    console.log('='.repeat(80));
    console.log(`[WEBSOCKET] Upgrade request: ${req.url}`);
    console.log(`[WEBSOCKET] Headers: ${JSON.stringify(req.headers)}`);

    const params = parseUrlParams(req.url);
    console.log(`[WS-PARSED] workspace: ${params.workspace || 'none'}`);
    console.log(`[WS-PARSED] folder: ${params.folder || 'none'}`);
    console.log(`[WS-PARSED] ew: ${params.ew || false}`);

    // If WebSocket URL doesn't have workspace params, try to get them from referer
    if (
      !params.workspace &&
      !params.folder &&
      !params.ew &&
      req.headers.referer
    ) {
      try {
        const refererUrl = new URL(req.headers.referer);
        const refererWorkspace = refererUrl.searchParams.get('workspace');
        const refererFolder = refererUrl.searchParams.get('folder');

        if (refererWorkspace || refererFolder) {
          // Add workspace/folder param to WebSocket URL so backend knows the context
          const wsUrl = new URL(req.url, `http://${PROXY_HOST}:${PROXY_PORT}`);
          if (refererWorkspace) {
            wsUrl.searchParams.set('workspace', refererWorkspace);
            params.workspace = refererWorkspace;
            console.log(
              `[WS-REWRITE] Added workspace param from referer: ${refererWorkspace}`
            );
          } else if (refererFolder) {
            wsUrl.searchParams.set('folder', refererFolder);
            params.folder = refererFolder;
            console.log(
              `[WS-REWRITE] Added folder param from referer: ${refererFolder}`
            );
          }
          req.url = `${wsUrl.pathname}${wsUrl.search}`;
        }
      } catch (e) {
        // Invalid referer URL, ignore
        console.log(`[WS-REWRITE] Failed to parse referer: ${e.message}`);
      }
    }

    // Determine target port
    let targetPort = MAIN_PORT;
    let instanceId = 'main';
    let workspacePath = null;

    // Routing logic - check in order of priority
    // 1. Check for session cookie first (WebSocket upgrades include cookies!)
    const sessionId = extractSessionCookie(req);
    let sessionRouted = false;

    if (sessionId && !params.workspace && !params.folder && !params.ew) {
      const session = getSession(sessionId);
      if (session) {
        // Route based on session
        instanceId = session.instanceId;
        targetPort = session.port;
        workspacePath = session.workspacePath;
        sessionRouted = true;
        console.log(
          `[WS-SESSION] Using session ${sessionId.substring(0, 8)} -> instance ${instanceId} on port ${targetPort}`
        );
      } else {
        console.log(
          `[WS-SESSION] Invalid or expired session ${sessionId.substring(0, 8)}`
        );
        // Fall through to default routing
      }
    }

    // 2. Route based on URL params - direct path routing with direct mounting
    if (!sessionRouted && params.ew) {
      targetPort = MAIN_PORT;
      instanceId = 'main';
    } else if (!sessionRouted && params.workspace) {
      const { port, instanceId: allocatedId } = await getOrAllocatePort(
        params.workspace
      );
      targetPort = port;
      instanceId = allocatedId;
      workspacePath = params.workspace;
    } else if (!sessionRouted && params.folder) {
      const { port, instanceId: allocatedId } = await getOrAllocatePort(
        params.folder
      );
      targetPort = port;
      instanceId = allocatedId;
      workspacePath = params.folder;
    }

    // Update last-access timestamp
    updateLastAccess(instanceId);

    // Track activity for idle detection (WebSocket traffic monitoring)
    const workspaceId = extractWorkspaceId(req);
    if (workspaceId) {
      activityTracker.recordActivity(workspaceId);
    }

    // Store original URL for potential redirect handling
    req._originalUrl = req.url;

    // Proxy the WebSocket
    const target = `http://127.0.0.1:${targetPort}`;
    console.log(`[WEBSOCKET] Proxying WebSocket upgrade -> ${target}`);
    console.log(`[WEBSOCKET] Instance: ${instanceId}, Port: ${targetPort}`);
    console.log('='.repeat(80));
    proxy.ws(req, socket, head, { target });
  } catch (error) {
    console.error('Error handling WebSocket upgrade:', error);
    socket.destroy();
  }
}

/**
 * Express-style middleware to create activity tracking API endpoint
 * @param {http.IncomingMessage} req - Request object
 * @param {http.ServerResponse} res - Response object
 * @returns {boolean} - True if request was handled
 */
function handleActivityEndpoint(req, res) {
  const activityMatch = req.url.match(/^\/api\/activity\/([^/?]+)/);
  if (!activityMatch) {
    return false;
  }

  const workspaceId = activityMatch[1];
  const idleTime = activityTracker.getIdleTime(workspaceId);

  if (idleTime === null) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'Workspace not found or no activity recorded',
      })
    );
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        workspaceId,
        idleSeconds: idleTime,
        lastActivity: activityTracker.getLastActivity(workspaceId),
      })
    );
  }

  return true;
}

// Initialize base directory structure
ensureDir(WORKSPACES_DIR);
ensureDir(BASE_DIR);
ensureDir(SHARED_SETTINGS_DIR);
ensureDir(path.join(SHARED_SETTINGS_DIR, 'extensions'));
ensureDir(path.join(SHARED_SETTINGS_DIR, 'User'));

const mainDir = path.join(BASE_DIR, 'main');
ensureDir(mainDir);
ensureDir(path.join(mainDir, 'data'));
ensureDir(path.join(mainDir, 'extensions'));
ensureDir(path.join(mainDir, 'logs'));

// Create main instance metadata if it doesn't exist
const mainMetadataPath = path.join(mainDir, 'metadata.json');
if (!fs.existsSync(mainMetadataPath)) {
  const mainMetadata = {
    workspacePath: null,
    port: MAIN_PORT,
    created: new Date().toISOString(),
    instanceId: 'main',
  };
  fs.writeFileSync(mainMetadataPath, JSON.stringify(mainMetadata, null, 2));
}

// Create HTTP server with activity tracking endpoint support
const server = http.createServer((req, res) => {
  // Check if this is an activity tracking API request
  if (handleActivityEndpoint(req, res)) {
    return;
  }

  // Otherwise, handle as normal proxy request
  handleRequest(req, res);
});

// Handle WebSocket upgrades
server.on('upgrade', handleUpgrade);

// Start listening
server.listen(PROXY_PORT, PROXY_HOST, async () => {
  console.log(`Code-Server Proxy listening on ${PROXY_HOST}:${PROXY_PORT}`);
  console.log(`Backend mode: ${USE_DOCKER ? 'Docker' : 'systemd'}`);
  console.log(`Main instance port: ${MAIN_PORT}`);
  console.log(
    `Workspace instance ports: ${WORKSPACE_PORT_MIN}-${WORKSPACE_PORT_MAX}`
  );
  console.log(`Base directory: ${BASE_DIR}`);

  // Verify Docker availability if Docker mode is enabled
  if (USE_DOCKER) {
    const dockerAvailable = await containerManager.isDockerAvailable();
    if (!dockerAvailable) {
      console.error('ERROR: Docker mode enabled but Docker is not available!');
      console.error('Please ensure Docker is installed and running.');
      process.exit(1);
    }
    console.log('Docker connection verified');

    // Ensure shared extensions volume exists
    try {
      await containerManager.ensureSharedExtensionsVolume();
      console.log('Shared extensions volume ready');
    } catch (error) {
      console.error(
        'Failed to initialize shared extensions volume:',
        error.message
      );
    }

    // Start settings sync service
    if (settingsSync) {
      try {
        settingsSync.start();
        console.log('Settings sync service started');
      } catch (error) {
        console.error('Failed to start settings sync service:', error.message);
      }
    }
  }
});

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down proxy server...');

  // Stop settings sync service
  if (settingsSync) {
    try {
      await settingsSync.stop();
    } catch (error) {
      console.error('Error stopping settings sync:', error.message);
    }
  }

  server.close(() => {
    console.log('Proxy server stopped');
    process.exit(0);
  });
});

process.on('SIGTERM', async () => {
  console.log('\nShutting down proxy server...');

  // Stop settings sync service
  if (settingsSync) {
    try {
      await settingsSync.stop();
    } catch (error) {
      console.error('Error stopping settings sync:', error.message);
    }
  }

  server.close(() => {
    console.log('Proxy server stopped');
    process.exit(0);
  });
});
