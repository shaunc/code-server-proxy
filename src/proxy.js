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

// Intercept proxy responses to rewrite redirect Location headers
// Only strip workspace/folder parameters that match the current routing
proxy.on('proxyRes', (proxyRes, req, res) => {
  const statusCode = proxyRes.statusCode;

  // Only intercept 3xx redirects
  if (statusCode >= 300 && statusCode < 400 && proxyRes.headers.location) {
    const location = proxyRes.headers.location;

    try {
      // Parse the original request to get routing parameters
      const originalParams = parseUrlParams(req._originalUrl || req.url);

      // Parse the redirect location
      const redirectUrl = new URL(
        location,
        `http://${PROXY_HOST}:${PROXY_PORT}${req.url}`
      );

      // Only strip parameters if they match the ones we used for routing
      // This prevents redirect loops while preserving cross-instance redirects
      let stripped = false;

      if (
        originalParams.workspace &&
        redirectUrl.searchParams.get('workspace') === originalParams.workspace
      ) {
        redirectUrl.searchParams.delete('workspace');
        stripped = true;
      }

      if (
        originalParams.folder &&
        redirectUrl.searchParams.get('folder') === originalParams.folder
      ) {
        redirectUrl.searchParams.delete('folder');
        stripped = true;
      }

      // Construct the new location (preserve relative vs absolute)
      let newLocation;
      if (location.startsWith('http://') || location.startsWith('https://')) {
        // Absolute URL - use full URL without params
        newLocation = `${redirectUrl.pathname}${redirectUrl.search}`;
      } else {
        // Relative URL - use pathname + search only
        newLocation = `${redirectUrl.pathname}${redirectUrl.search}`;
      }

      if (stripped) {
        console.log(
          `[REDIRECT] Stripped matching routing params: ${location} -> ${newLocation}`
        );
      } else {
        console.log(
          `[REDIRECT] Preserving redirect (no matching params): ${location}`
        );
      }

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
 * Launch code-server instance via systemd
 * @param {string} instanceId - Instance ID
 * @returns {Promise<void>}
 */
async function launchInstance(instanceId) {
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

    // Bare mode (empty window)
    if (params.ew) {
      console.log('[ROUTING] Bare mode request (ew=true) -> main instance');
      targetPort = MAIN_PORT;
      instanceId = 'main';

      // Check if main instance is running, launch if needed
      if (!(await isPortListening(targetPort))) {
        console.log(`Main instance not running, launching ${instanceId}...`);
        await launchInstance(instanceId);

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
    // Workspace mode
    else if (params.workspace) {
      const workspacePath = params.workspace;
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
        await launchInstance(instanceId);

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
    // Folder mode
    else if (params.folder) {
      const folderPath = params.folder;
      console.log(`[ROUTING] Folder mode request: ${folderPath}`);

      if (!path.isAbsolute(folderPath)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request: folder path must be absolute');
        return;
      }

      // Check instance limit
      const activeCount = await countActiveInstances();
      const registry = loadRegistry();
      const isExisting = !!registry.workspaces[folderPath];

      if (!isExisting && activeCount >= MAX_CONCURRENT_INSTANCES) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end(
          `Service Unavailable: Maximum concurrent instances (${MAX_CONCURRENT_INSTANCES}) reached. ` +
            'Please stop unused workspace instances before opening new ones.'
        );
        return;
      }

      const { port, instanceId: allocatedId } =
        await getOrAllocatePort(folderPath);
      targetPort = port;
      instanceId = allocatedId;

      console.log(
        `[ROUTING] Allocated port ${targetPort} for instance ${instanceId}`
      );

      // Ensure instance exists
      const instanceDir = path.join(BASE_DIR, instanceId);
      if (!fs.existsSync(instanceDir)) {
        createInstanceDirectory(instanceId, folderPath, targetPort);
      }

      // Check if instance is running, launch if needed
      if (!(await isPortListening(targetPort))) {
        console.log(`Instance not running, launching ${instanceId}...`);
        await launchInstance(instanceId);

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
    // Default to main instance
    else {
      console.log(
        '[ROUTING] Default request (no workspace/folder) -> main instance'
      );
      targetPort = MAIN_PORT;
      instanceId = 'main';

      // Check if main instance is running, launch if needed
      if (!(await isPortListening(targetPort))) {
        console.log(`Main instance not running, launching ${instanceId}...`);
        await launchInstance(instanceId);

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

    // Store original URL for redirect handler to access
    req._originalUrl = req.url;

    // DON'T strip workspace/folder parameters - let backend see them
    // The backend code-server is already configured with the workspace,
    // so it will handle the parameter correctly without redirecting

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

    // Determine target port
    let targetPort = MAIN_PORT;
    let instanceId = 'main';

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

    // Update last-access timestamp
    updateLastAccess(instanceId);

    // Store original URL for potential redirect handling
    req._originalUrl = req.url;

    // DON'T strip workspace/folder parameters from WebSocket upgrades
    // WebSocket connections need to maintain routing context

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

// Create HTTP server
const server = http.createServer(handleRequest);

// Handle WebSocket upgrades
server.on('upgrade', handleUpgrade);

// Start listening
server.listen(PROXY_PORT, PROXY_HOST, () => {
  console.log(`Code-Server Proxy listening on ${PROXY_HOST}:${PROXY_PORT}`);
  console.log(`Main instance port: ${MAIN_PORT}`);
  console.log(
    `Workspace instance ports: ${WORKSPACE_PORT_MIN}-${WORKSPACE_PORT_MAX}`
  );
  console.log(`Base directory: ${BASE_DIR}`);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down proxy server...');
  server.close(() => {
    console.log('Proxy server stopped');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('\nShutting down proxy server...');
  server.close(() => {
    console.log('Proxy server stopped');
    process.exit(0);
  });
});
