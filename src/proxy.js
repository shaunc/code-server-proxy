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

// WebSocket proxy with ping/pong keepalive
const wsProxy = require('./ws-proxy');

// Load reconnect-helper script for injection into HTML pages
const RECONNECT_HELPER_PATH = path.join(__dirname, 'reconnect-helper.js');
const RECONNECT_HELPER_SCRIPT = fs.existsSync(RECONNECT_HELPER_PATH)
  ? fs.readFileSync(RECONNECT_HELPER_PATH, 'utf8')
  : null;
if (RECONNECT_HELPER_SCRIPT) {
  console.log('[INIT] Loaded reconnect-helper.js for HTML injection');
} else {
  console.warn('[INIT] reconnect-helper.js not found, auto-reload disabled');
}

// Configuration
const PROXY_PORT = 8083;
const PROXY_HOST = '127.0.0.1';
const MAIN_PORT = 8100;
const WORKSPACE_PORT_MIN = 8101;
const WORKSPACE_PORT_MAX = 8199;
const MAX_CONCURRENT_INSTANCES = 36;
const MAX_PROBE_ATTEMPTS = 20;
const WORKSPACES_DIR = path.join(process.env.HOME, '.code-workspaces');
const BASE_DIR = path.join(WORKSPACES_DIR, 'instances');
const REGISTRY_PATH = path.join(WORKSPACES_DIR, 'port-registry.json');
const SHARED_SETTINGS_DIR = path.join(WORKSPACES_DIR, 'shared');
const BACKEND_READY_TIMEOUT = 30000; // 30 seconds
const BACKEND_READY_POLL_INTERVAL = 500; // 500ms

// Lock mechanism to prevent concurrent container operations
// Maps instance ID to promise that resolves when operation completes
const instanceLocks = new Map();

// Create HTTP proxy with selfHandleResponse for HTML injection
// Extended timeouts to survive network pauses (5 minutes)
const proxy = httpProxy.createProxyServer({
  ws: true,
  selfHandleResponse: true,
  timeout: 300000, // 5 minute connection timeout
  proxyTimeout: 300000, // 5 minute proxy timeout
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

/**
 * Extract nonce from Content-Security-Policy header
 * @param {string} csp - CSP header value
 * @returns {string|null} Nonce value or null
 */
function extractCspNonce(csp) {
  if (!csp) return null;
  const match = csp.match(/'nonce-([^']+)'/);
  return match ? match[1] : null;
}

/**
 * Inject reconnect-helper script into HTML content
 * Must be injected early (after <head>) to intercept WebSocket before code-server uses it
 * @param {string} html - Original HTML content
 * @param {string|null} nonce - CSP nonce for inline script
 * @returns {string} Modified HTML with script injected
 */
function injectReconnectHelper(html, nonce) {
  if (!RECONNECT_HELPER_SCRIPT) {
    return html;
  }

  // Inject inline script after <head> to ensure it runs before other scripts
  // This is critical for WebSocket interception to work
  // Include nonce if CSP requires it
  const nonceAttr = nonce ? ` nonce="${nonce}"` : '';
  const scriptTag = `<script${nonceAttr}>${RECONNECT_HELPER_SCRIPT}</script>`;

  if (html.includes('<head>')) {
    return html.replace('<head>', `<head>${scriptTag}`);
  } else if (html.includes('<body>')) {
    return html.replace('<body>', `${scriptTag}<body>`);
  } else {
    return scriptTag + html;
  }
}

// Intercept proxy responses for redirects and HTML injection
proxy.on('proxyRes', (proxyRes, req, res) => {
  const statusCode = proxyRes.statusCode;
  const contentType = proxyRes.headers['content-type'] || '';
  const isHtml = contentType.includes('text/html');

  // Build response headers
  const headers = { ...proxyRes.headers };

  // Handle 3xx redirects
  if (statusCode >= 300 && statusCode < 400 && headers.location) {
    const location = headers.location;

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

      headers.location = newLocation;
    } catch (error) {
      console.error('Error rewriting redirect location:', error.message);
    }
  }

  // For HTML responses, buffer and inject reconnect-helper script
  if (isHtml && RECONNECT_HELPER_SCRIPT) {
    const chunks = [];
    // Extract nonce from CSP header for inline script
    const cspHeader = headers['content-security-policy'];
    const nonce = extractCspNonce(cspHeader);

    proxyRes.on('data', (chunk) => {
      chunks.push(chunk);
    });

    proxyRes.on('end', () => {
      let body = Buffer.concat(chunks).toString('utf8');
      body = injectReconnectHelper(body, nonce);

      // Update headers for buffered response
      // Remove chunked encoding since we're sending complete body
      delete headers['transfer-encoding'];
      delete headers['content-length'];
      headers['content-length'] = Buffer.byteLength(body);

      res.writeHead(statusCode, headers);
      res.end(body);
    });
  } else {
    // For non-HTML responses, just pipe through
    res.writeHead(statusCode, headers);
    proxyRes.pipe(res);
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
 * Checks if registry port is listening. If not, checks if container exists with
 * a different port (can happen after port collision and container restart).
 * @param {Object} registry - Registry object
 * @returns {Promise<{registry: Object, modified: boolean}>} Cleaned registry and modification flag
 */
async function cleanupStaleEntries(registry) {
  const cleaned = { workspaces: {}, ports: {} };
  let modified = false;

  for (const [workspacePath, entry] of Object.entries(registry.workspaces)) {
    const registryPort = entry.currentPort;
    const instanceId = entry.instanceId;

    if (await validatePortAvailability(registryPort)) {
      // Registry port is listening, keep the entry unchanged
      cleaned.workspaces[workspacePath] = entry;
      cleaned.ports[registryPort] = registry.ports[registryPort];
    } else {
      // Registry port not listening - check if container exists with different port
      // This happens when port collision occurred and container was created on next
      // available port, but registry wasn't updated (or got stale and re-allocated)
      const actualPort = await containerManager.getContainerPort(instanceId);

      if (actualPort && actualPort !== registryPort) {
        // Container exists on different port - update registry with actual port
        console.log(
          `Registry port mismatch for ${workspacePath}: ` +
            `registry=${registryPort}, container=${actualPort}. Updating registry.`
        );
        modified = true;

        // Update entry with correct port (whether listening or not)
        const updatedEntry = { ...entry, currentPort: actualPort };
        cleaned.workspaces[workspacePath] = updatedEntry;
        cleaned.ports[actualPort] = {
          workspacePath,
          instanceId,
        };

        if (!(await validatePortAvailability(actualPort))) {
          console.log(
            `Container ${instanceId.substring(0, 8)} exists on port ${actualPort} ` +
              `but not listening (stopped?). Registry updated.`
          );
        }
      } else if (actualPort === null) {
        // No container exists, safe to remove stale entry
        console.log(
          `Removing stale registry entry for ${workspacePath} ` +
            `(port ${registryPort} not listening, no container found)`
        );
        modified = true;
        // Don't add to cleaned - entry is removed
      } else {
        // actualPort === registryPort but not listening (container stopped)
        // Keep the entry so container can be restarted
        cleaned.workspaces[workspacePath] = entry;
        cleaned.ports[registryPort] = registry.ports[registryPort];
        console.log(
          `Keeping registry entry for ${workspacePath} ` +
            `(port ${registryPort} not listening, container may be stopped)`
        );
      }
    }
  }

  return { registry: cleaned, modified };
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
  const originalRegistry = loadRegistry();

  // Cleanup may update ports if containers exist on different ports than registry
  const { registry, modified } = await cleanupStaleEntries(originalRegistry);

  // Save registry after cleanup only if it was modified (port corrections, removals)
  if (modified) {
    saveRegistry(registry);
  }

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
 * Find the least recently active instance
 * @returns {{workspacePath: string, instanceId: string, lastActivity: number}|null}
 */
function findLeastActiveInstance() {
  const registry = loadRegistry();
  const workspaces = Object.entries(registry.workspaces);

  if (workspaces.length === 0) {
    return null;
  }

  let leastActive = null;
  let oldestActivity = Infinity;

  for (const [workspacePath, entry] of workspaces) {
    const lastActivity = activityTracker.getLastActivity(entry.instanceId);
    // If no activity recorded, use allocation time from registry (very old)
    const activityTime = lastActivity || 0;

    if (activityTime < oldestActivity) {
      oldestActivity = activityTime;
      leastActive = {
        workspacePath,
        instanceId: entry.instanceId,
        port: entry.currentPort,
        lastActivity: activityTime,
      };
    }
  }

  return leastActive;
}

/**
 * Evict the least recently active instance to make room for a new one
 * @returns {Promise<{success: boolean, target: Object|null, error: string|null}>}
 */
async function evictLeastActiveInstance() {
  const target = findLeastActiveInstance();

  if (!target) {
    console.log('[EVICTION] No instances to evict');
    return { success: false, target: null, error: 'No instances available' };
  }

  const idleSeconds = target.lastActivity
    ? Math.floor((Date.now() - target.lastActivity) / 1000)
    : 'unknown';
  const idleDisplay =
    idleSeconds === 'unknown'
      ? 'unknown'
      : idleSeconds > 86400
        ? `${Math.floor(idleSeconds / 86400)}d`
        : idleSeconds > 3600
          ? `${Math.floor(idleSeconds / 3600)}h`
          : `${idleSeconds}s`;

  console.log(
    `[EVICTION] Stopping least active instance: ${target.instanceId.substring(0, 8)} ` +
      `(idle: ${idleDisplay}, workspace: ${target.workspacePath})`
  );

  try {
    // Stop the container (Docker mode) or service (systemd mode)
    if (USE_DOCKER) {
      await containerManager.stopContainer(target.instanceId);
    } else {
      const serviceName = `code-server-workspace@${target.instanceId}.service`;
      await execAsync(`systemctl --user stop ${serviceName}`);
    }

    // Remove from registry
    const registry = loadRegistry();
    delete registry.workspaces[target.workspacePath];
    delete registry.ports[target.port];
    saveRegistry(registry);

    // Remove from activity tracker
    activityTracker.removeWorkspace(target.instanceId);

    console.log(
      `[EVICTION] Successfully evicted instance ${target.instanceId.substring(0, 8)}`
    );
    return { success: true, target, error: null };
  } catch (error) {
    console.error(
      `[EVICTION] Failed to evict instance ${target.instanceId.substring(0, 8)}:`,
      error.message
    );
    return { success: false, target, error: error.message };
  }
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
          // Clear outdated cache immediately to prevent other requests from
          // triggering concurrent recreation attempts during the slow stop/remove
          containerManager.clearOutdatedCache(instanceId);
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
 * Generate waiting page HTML for container startup
 * @param {string} workspacePath - Workspace or folder path
 * @param {string} instanceId - Instance ID
 * @param {number} port - Target port
 * @returns {string} - HTML page
 */
function generateWaitingPage(workspacePath, instanceId, port) {
  const shortId = instanceId.substring(0, 8);
  const displayPath = workspacePath || 'Main Instance';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="2">
  <title>Workspace Starting - code-server</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      background: #1e1e1e;
      color: #cccccc;
      padding: 20px;
    }
    .container { text-align: center; max-width: 600px; width: 100%; }
    .spinner {
      width: 48px; height: 48px; margin: 0 auto 32px;
      border: 3px solid #3c3c3c; border-top-color: #007acc;
      border-radius: 50%; animation: spin 1s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    h1 {
      font-size: 28px; font-weight: 400; margin-bottom: 16px; color: #ffffff;
    }
    .workspace-path {
      font-size: 14px; color: #007acc; margin-bottom: 24px;
      padding: 8px 16px; background: #2d2d30; border-radius: 4px;
      display: inline-block;
      font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
      word-break: break-all;
    }
    .message {
      font-size: 16px; color: #858585; line-height: 1.6; margin-bottom: 12px;
    }
    .status {
      display: flex; align-items: center; justify-content: center;
      gap: 12px; margin: 24px 0; padding: 16px;
      background: #252526; border-radius: 6px; border-left: 3px solid #007acc;
    }
    .status-dot {
      width: 8px; height: 8px; background: #007acc;
      border-radius: 50%; animation: pulse 1.5s ease-in-out infinite;
    }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
    .status-text { font-size: 14px; color: #cccccc; }
    .details {
      margin-top: 32px; padding-top: 24px; border-top: 1px solid #3c3c3c;
    }
    .detail-item {
      display: flex; justify-content: space-between; align-items: center;
      padding: 8px 0; font-size: 13px; color: #858585;
    }
    .detail-label { font-weight: 500; }
    .detail-value {
      color: #cccccc;
      font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
    }
    .progress-bar {
      width: 100%; height: 3px; background: #3c3c3c;
      border-radius: 2px; margin-top: 24px; overflow: hidden;
    }
    .progress-fill {
      height: 100%; background: linear-gradient(90deg, #007acc, #00a0ff);
      animation: progress 2s ease-in-out infinite; width: 40%;
    }
    @keyframes progress {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(250%); }
    }
    .note {
      margin-top: 32px; font-size: 12px; color: #6a6a6a; font-style: italic;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="spinner"></div>
    <h1>Preparing Workspace</h1>
    <div class="workspace-path">${displayPath}</div>
    <p class="message">
      Your workspace container is being started.
      <br>
      This page will automatically refresh when ready.
    </p>
    <div class="status">
      <div class="status-dot"></div>
      <div class="status-text">
        <strong>Status:</strong> Starting container
      </div>
    </div>
    <div class="details">
      <div class="detail-item">
        <span class="detail-label">Instance ID:</span>
        <span class="detail-value">${shortId}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">Port:</span>
        <span class="detail-value">${port}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">Elapsed:</span>
        <span class="detail-value" id="elapsed">0s</span>
      </div>
    </div>
    <div class="progress-bar">
      <div class="progress-fill"></div>
    </div>
    <p class="note">
      Container startup typically takes 10-15 seconds.
      <br>
      This page refreshes every 2 seconds.
    </p>
  </div>
  <script>
    const startTime = Date.now();
    setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      document.getElementById('elapsed').textContent = elapsed + 's';
    }, 1000);
  </script>
</body>
</html>`;
}

/**
 * Check if request is an initial page load (not a resource request)
 * @param {http.IncomingMessage} req - Request object
 * @returns {boolean} - True if initial page load
 */
function isInitialPageLoad(req) {
  const url = req.url;

  // Main page loads
  if (url === '/' || url.startsWith('/?')) {
    return true;
  }

  // Not a page load if it's a resource
  const resourcePatterns = [
    /\.(css|js|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot)$/i,
    /^\/_static\//,
    /^\/static\//,
    /^\/vscode-remote-resource/,
    /^\/stable-/,
  ];

  return !resourcePatterns.some((pattern) => pattern.test(url));
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
 * Extract workspace path from referer header
 * @param {http.IncomingMessage} req - Request object
 * @returns {{workspace: string|null, folder: string|null}} Extracted paths
 */
function extractRefererWorkspace(req) {
  const referer = req.headers.referer;
  if (!referer) {
    return { workspace: null, folder: null };
  }

  try {
    const refererUrl = new URL(referer);
    return {
      workspace: refererUrl.searchParams.get('workspace'),
      folder: refererUrl.searchParams.get('folder'),
    };
  } catch {
    return { workspace: null, folder: null };
  }
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

    // Routing priority:
    // 1. URL parameters (?workspace=, ?folder=, ?ew=)
    // 2. Referer header (for resources loaded by workspace pages)
    // 3. Default to main instance
    //
    // NOTE: Session cookies are NOT used for routing because they are
    // domain-scoped and cause incorrect routing with multiple tabs.
    // Each tab overwrites the session cookie, causing requests from
    // other tabs to route to the wrong workspace.

    // Check referer for workspace context (used for assets without URL params)
    const refererParams = extractRefererWorkspace(req);

    // 1. Route based on URL parameters first
    if (params.ew) {
      console.log('[ROUTING] Bare mode request (ew=true) -> main instance');
      targetPort = MAIN_PORT;
      instanceId = 'main';

      // Check if container image is outdated (fast cached check - no Docker API)
      const isOutdatedBare =
        containerManager.isContainerOutdatedCached(instanceId);
      const isListeningBare = await isPortListening(targetPort);

      // If outdated or not running, need to launch/relaunch
      if (isOutdatedBare || !isListeningBare) {
        if (isOutdatedBare) {
          console.log(
            `Instance ${instanceId.substring(0, 8)} using outdated image, recreating...`
          );
        } else {
          console.log(`Main instance not running, launching ${instanceId}...`);
        }

        // Launch async (don't await)
        launchInstance(instanceId, null, targetPort).catch((err) => {
          console.error(`Failed to launch ${instanceId}:`, err);
        });

        // For initial page load, return waiting page
        if (isInitialPageLoad(req)) {
          console.log('[WAITING] Returning waiting page for bare mode');
          const waitingPage = generateWaitingPage(null, instanceId, targetPort);
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(waitingPage);
          return;
        }

        // For resource requests, block and wait
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
    // 2. Workspace mode (URL param)
    else if (params.workspace) {
      workspacePath = params.workspace;
      console.log(`[ROUTING] Workspace mode request: ${workspacePath}`);

      if (!path.isAbsolute(workspacePath)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request: workspace path must be absolute');
        return;
      }

      // Check instance limit - evict least active if at capacity
      const activeCount = await countActiveInstances();
      const registry = loadRegistry();
      const isExisting = !!registry.workspaces[workspacePath];

      if (!isExisting && activeCount >= MAX_CONCURRENT_INSTANCES) {
        console.log(
          `[LIMIT] At capacity (${activeCount}/${MAX_CONCURRENT_INSTANCES}), ` +
            'evicting least active instance...'
        );
        const evictResult = await evictLeastActiveInstance();
        if (!evictResult.success) {
          const targetInfo = evictResult.target
            ? ` (tried: ${evictResult.target.instanceId.substring(0, 8)}, ` +
              `workspace: ${evictResult.target.workspacePath})`
            : '';
          res.writeHead(503, { 'Content-Type': 'text/plain' });
          res.end(
            `Service Unavailable: Maximum concurrent instances (${MAX_CONCURRENT_INSTANCES}) reached ` +
              `and auto-eviction failed${targetInfo}. ` +
              `Error: ${evictResult.error || 'unknown'}. ` +
              'Please stop unused workspace instances manually.'
          );
          return;
        }
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

      // Check if container image is outdated (fast cached check - no Docker API)
      const isOutdatedWorkspace =
        containerManager.isContainerOutdatedCached(instanceId);
      const isListeningWorkspace = await isPortListening(targetPort);

      // If outdated or not running, need to launch/relaunch
      if (isOutdatedWorkspace || !isListeningWorkspace) {
        if (isOutdatedWorkspace) {
          console.log(
            `Instance ${instanceId.substring(0, 8)} using outdated image, recreating...`
          );
        } else {
          console.log(`Instance not running, launching ${instanceId}...`);
        }

        // Launch async (don't await)
        launchInstance(instanceId, workspacePath, targetPort).catch((err) => {
          console.error(`Failed to launch ${instanceId}:`, err);
        });

        // For initial page load, return waiting page
        if (isInitialPageLoad(req)) {
          console.log('[WAITING] Returning waiting page for workspace');
          const waitingPage = generateWaitingPage(
            workspacePath,
            instanceId,
            targetPort
          );
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(waitingPage);
          return;
        }

        // For resource requests, block and wait
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
    }
    // 3. Folder mode (URL param)
    else if (params.folder) {
      workspacePath = params.folder;
      console.log(`[ROUTING] Folder mode request: ${workspacePath}`);

      if (!path.isAbsolute(workspacePath)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request: folder path must be absolute');
        return;
      }

      // Check instance limit - evict least active if at capacity
      const activeCount = await countActiveInstances();
      const registry = loadRegistry();
      const isExisting = !!registry.workspaces[workspacePath];

      if (!isExisting && activeCount >= MAX_CONCURRENT_INSTANCES) {
        console.log(
          `[LIMIT] At capacity (${activeCount}/${MAX_CONCURRENT_INSTANCES}), ` +
            'evicting least active instance...'
        );
        const evictResult = await evictLeastActiveInstance();
        if (!evictResult.success) {
          const targetInfo = evictResult.target
            ? ` (tried: ${evictResult.target.instanceId.substring(0, 8)}, ` +
              `workspace: ${evictResult.target.workspacePath})`
            : '';
          res.writeHead(503, { 'Content-Type': 'text/plain' });
          res.end(
            `Service Unavailable: Maximum concurrent instances (${MAX_CONCURRENT_INSTANCES}) reached ` +
              `and auto-eviction failed${targetInfo}. ` +
              `Error: ${evictResult.error || 'unknown'}. ` +
              'Please stop unused workspace instances manually.'
          );
          return;
        }
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

      // Check if container image is outdated (fast cached check - no Docker API)
      const isOutdatedFolder =
        containerManager.isContainerOutdatedCached(instanceId);
      const isListeningFolder = await isPortListening(targetPort);

      // If outdated or not running, need to launch/relaunch
      if (isOutdatedFolder || !isListeningFolder) {
        if (isOutdatedFolder) {
          console.log(
            `Instance ${instanceId.substring(0, 8)} using outdated image, recreating...`
          );
        } else {
          console.log(`Instance not running, launching ${instanceId}...`);
        }

        // Launch async (don't await)
        launchInstance(instanceId, workspacePath, targetPort).catch((err) => {
          console.error(`Failed to launch ${instanceId}:`, err);
        });

        // For initial page load, return waiting page
        if (isInitialPageLoad(req)) {
          const waitingPage = generateWaitingPage(
            workspacePath,
            instanceId,
            targetPort
          );
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(waitingPage);
          return;
        }

        // For resource requests, block and wait
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
    }
    // 4. Referer-based routing (for assets loaded by workspace pages)
    else if (refererParams.workspace || refererParams.folder) {
      workspacePath = refererParams.workspace || refererParams.folder;
      console.log(`[ROUTING] Referer-based routing: ${workspacePath}`);

      // Get port for this workspace (should already exist in registry)
      const { port, instanceId: allocatedId } =
        await getOrAllocatePort(workspacePath);
      targetPort = port;
      instanceId = allocatedId;

      console.log(
        `[ROUTING] Referer resolved to port ${targetPort} for instance ${instanceId.substring(0, 8)}`
      );

      // Ensure instance is running
      const isListeningReferer = await isPortListening(targetPort);
      if (!isListeningReferer) {
        console.log(`Instance not running, launching ${instanceId}...`);
        // Launch async (don't await) - this is a resource request, not initial page
        launchInstance(instanceId, workspacePath, targetPort).catch((err) => {
          console.error(`Failed to launch ${instanceId}:`, err);
        });

        // Wait for backend
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
    }
    // 5. Default to main instance
    else {
      console.log(
        '[ROUTING] Default request (no workspace/folder/referer) -> main instance'
      );
      targetPort = MAIN_PORT;
      instanceId = 'main';

      // Check if container image is outdated (fast cached check - no Docker API)
      const isOutdatedDefault =
        containerManager.isContainerOutdatedCached(instanceId);
      const isListeningDefault = await isPortListening(targetPort);

      // If outdated or not running, need to launch/relaunch
      if (isOutdatedDefault || !isListeningDefault) {
        if (isOutdatedDefault) {
          console.log(
            `Instance ${instanceId.substring(0, 8)} using outdated image, recreating...`
          );
        } else {
          console.log(`Main instance not running, launching ${instanceId}...`);
        }

        // Launch async (don't await)
        launchInstance(instanceId, null, targetPort).catch((err) => {
          console.error(`Failed to launch ${instanceId}:`, err);
        });

        // For initial page load, return waiting page
        if (isInitialPageLoad(req)) {
          const waitingPage = generateWaitingPage(null, instanceId, targetPort);
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(waitingPage);
          return;
        }

        // For resource requests, block and wait
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

    // Track activity for idle detection
    // Use instanceId from routing (works for session-based routing too)
    if (instanceId && instanceId !== 'main') {
      activityTracker.recordActivity(instanceId);
    }

    // Attach routing context to request (for redirect handler)
    req._instanceId = instanceId;
    req._workspacePath = workspacePath;

    // Proxy the request
    const target = `http://127.0.0.1:${targetPort}`;
    console.log(`[PROXY] Proxying ${req.method} ${req.url} -> ${target}`);
    console.log(`[PROXY] Instance: ${instanceId}, Port: ${targetPort}`);

    // Strip Accept-Encoding for HTML requests to avoid compressed responses
    // that we can't modify for script injection
    const acceptHeader = req.headers['accept'] || '';
    if (acceptHeader.includes('text/html')) {
      delete req.headers['accept-encoding'];
      console.log('[PROXY] Stripped Accept-Encoding for HTML request');
    }

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

    // Routing priority:
    // 1. URL parameters (?workspace=, ?folder=, ?ew=)
    // 2. Referer header (already extracted into params above)
    // 3. Default to main instance
    //
    // NOTE: Session cookies are NOT used for routing because they are
    // domain-scoped and cause incorrect routing with multiple tabs.
    if (params.ew) {
      targetPort = MAIN_PORT;
      instanceId = 'main';
    } else if (params.workspace) {
      const { port, instanceId: allocatedId } = await getOrAllocatePort(
        params.workspace
      );
      targetPort = port;
      instanceId = allocatedId;
    } else if (params.folder) {
      const { port, instanceId: allocatedId } = await getOrAllocatePort(
        params.folder
      );
      targetPort = port;
      instanceId = allocatedId;
    }
    // If no params (and no referer extracted above), defaults to main instance

    // Update last-access timestamp
    updateLastAccess(instanceId);

    // Track activity for idle detection
    // Use instanceId from routing (works for session-based routing too)
    if (instanceId && instanceId !== 'main') {
      activityTracker.recordActivity(instanceId);
    }

    // Store original URL for potential redirect handling
    req._originalUrl = req.url;

    // Proxy the WebSocket with ping/pong keepalive
    const targetWsUrl = `ws://127.0.0.1:${targetPort}${req.url}`;
    console.log(`[WEBSOCKET] Proxying WebSocket upgrade -> ${targetWsUrl}`);
    console.log(`[WEBSOCKET] Instance: ${instanceId}, Port: ${targetPort}`);
    console.log('='.repeat(80));
    wsProxy.proxyWebSocket(req, socket, head, targetWsUrl, instanceId);
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

/**
 * Handle proxy internal endpoints (/_proxy/*)
 * @param {http.IncomingMessage} req - Request object
 * @param {http.ServerResponse} res - Response object
 * @returns {boolean} True if request was handled
 */
function handleProxyEndpoint(req, res) {
  // Serve reconnect-helper.js
  if (req.url === '/_proxy/reconnect-helper.js') {
    if (RECONNECT_HELPER_SCRIPT) {
      res.writeHead(200, {
        'Content-Type': 'application/javascript',
        'Cache-Control': 'public, max-age=3600',
      });
      res.end(RECONNECT_HELPER_SCRIPT);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
    return true;
  }
  return false;
}

// Create HTTP server with activity tracking endpoint support
const server = http.createServer((req, res) => {
  // Check for proxy internal endpoints first
  if (handleProxyEndpoint(req, res)) {
    return;
  }

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

    // Schedule idle container cleanup tasks
    // Stop idle containers every hour
    setInterval(
      async () => {
        console.log('[CLEANUP] Running scheduled idle container check...');
        try {
          const stopped = await containerManager.stopIdleContainers();
          if (stopped.length > 0) {
            console.log(
              `[CLEANUP] Stopped ${stopped.length} idle container(s)`
            );
          }
        } catch (error) {
          console.error(
            '[CLEANUP] Error stopping idle containers:',
            error.message
          );
        }
      },
      60 * 60 * 1000
    ); // 1 hour

    // Run full cleanup (remove containers) every 6 hours
    setInterval(
      async () => {
        console.log('[CLEANUP] Running scheduled container cleanup...');
        try {
          const cleaned = await containerManager.cleanupIdleContainers();
          if (cleaned.length > 0) {
            console.log(
              `[CLEANUP] Cleaned up ${cleaned.length} idle container(s)`
            );
          }
        } catch (error) {
          console.error(
            '[CLEANUP] Error cleaning up containers:',
            error.message
          );
        }

        // Also cleanup orphaned containers
        console.log('[CLEANUP] Running orphan detection...');
        try {
          const orphans = await containerManager.cleanupOrphanedContainers();
          if (orphans.length > 0) {
            console.log(
              `[CLEANUP] Cleaned up ${orphans.length} orphaned container(s)`
            );
          }
        } catch (error) {
          console.error('[CLEANUP] Error cleaning up orphans:', error.message);
        }
      },
      6 * 60 * 60 * 1000
    ); // 6 hours

    // Clean shared tmp directory hourly (with the idle container check)
    setInterval(
      () => {
        cleanupSharedTmp();
      },
      60 * 60 * 1000
    ); // 1 hour

    // Check for outdated container images every 2 minutes
    // This runs in background to avoid Docker API calls on hot request path
    setInterval(
      async () => {
        await containerManager.checkAllContainersForOutdatedImages();
      },
      2 * 60 * 1000
    ); // 2 minutes

    // Clean orphaned tmux sessions every 5 minutes
    setInterval(
      () => {
        containerManager.cleanOrphanedTmuxSessions();
      },
      5 * 60 * 1000
    );

    // Run initial image check after 10 seconds (let containers settle first)
    setTimeout(async () => {
      console.log('[IMAGE-CHECK] Running initial container image check...');
      await containerManager.checkAllContainersForOutdatedImages();
    }, 10000);

    console.log('Scheduled cleanup tasks registered');
  }

  // Create shared tmp directory if it doesn't exist
  const sharedTmpDir = '/tmp/kilocode-shared';
  if (!fs.existsSync(sharedTmpDir)) {
    try {
      fs.mkdirSync(sharedTmpDir, { recursive: true });
      console.log(`Created shared tmp directory: ${sharedTmpDir}`);
    } catch (error) {
      console.error(`Failed to create ${sharedTmpDir}: ${error.message}`);
    }
  }
});

// Handle SIGHUP to reload configuration
process.on('SIGHUP', () => {
  console.log('\nReceived SIGHUP - reloading configuration...');
  if (USE_DOCKER && containerManager) {
    containerManager.reloadConfig();
  }
  console.log(
    'Configuration reloaded. New containers will use updated mounts.'
  );
});

/**
 * Cleanup old files in the shared Kilo Code temp directory
 * Files older than maxAgeMs are deleted to prevent accumulation
 * @param {number} maxAgeMs - Maximum age in milliseconds (default: 1 hour)
 */
async function cleanupSharedTmp(maxAgeMs = 60 * 60 * 1000) {
  const sharedDir = '/tmp/kilocode-shared';

  try {
    if (!fs.existsSync(sharedDir)) {
      return; // Directory doesn't exist yet, nothing to clean
    }

    const now = Date.now();
    const files = fs.readdirSync(sharedDir);
    let cleaned = 0;

    for (const file of files) {
      const filePath = path.join(sharedDir, file);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > maxAgeMs) {
          fs.unlinkSync(filePath);
          cleaned++;
        }
      } catch (err) {
        // File may have been deleted by another process
        console.error(`[CLEANUP] Error checking ${filePath}: ${err.message}`);
      }
    }

    if (cleaned > 0) {
      console.log(`[CLEANUP] Removed ${cleaned} old file(s) from ${sharedDir}`);
    }
  } catch (error) {
    console.error(`[CLEANUP] Error cleaning shared tmp: ${error.message}`);
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down proxy server...');

  // Cleanup WebSocket connections
  console.log('Closing WebSocket connections...');
  wsProxy.cleanupAllConnections();

  // Save activity tracker state
  console.log('Saving activity tracker state...');
  activityTracker.shutdown();

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

  // Cleanup WebSocket connections
  console.log('Closing WebSocket connections...');
  wsProxy.cleanupAllConnections();

  // Save activity tracker state
  console.log('Saving activity tracker state...');
  activityTracker.shutdown();

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
