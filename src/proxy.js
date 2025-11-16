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
const BASE_DIR = path.join(process.env.HOME, '.code-workspaces', 'instances');
const BACKEND_READY_TIMEOUT = 30000; // 30 seconds
const BACKEND_READY_POLL_INTERVAL = 500; // 500ms

// Create HTTP proxy
const proxy = httpProxy.createProxyServer({
  ws: true,
});

// Handle proxy errors
proxy.on('error', (err, req, res) => {
  console.error('Proxy error:', err.message);
  if (!res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Bad Gateway: Unable to connect to backend code-server instance');
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
 * Compute deterministic port number from workspace/folder path
 * @param {string} workspacePath - The workspace or folder path
 * @returns {number} Port number between 8101-8199
 */
function computePort(workspacePath) {
  const hash = crypto.createHash('sha256').update(workspacePath).digest('hex');
  const numericHash = parseInt(hash.substring(0, 8), 16);
  const portRange = WORKSPACE_PORT_MAX - WORKSPACE_PORT_MIN + 1;
  return WORKSPACE_PORT_MIN + (numericHash % portRange);
}

/**
 * Compute instance name from workspace/folder path
 * @param {string} workspacePath - The workspace or folder path
 * @returns {string} Instance name (e.g., "workspace-a1b2c3d4")
 */
function computeInstanceName(workspacePath) {
  const hash = crypto.createHash('sha256').update(workspacePath).digest('hex');
  return `workspace-${hash.substring(0, 8)}`;
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
 * @param {string} instanceName - Instance name
 * @param {string} workspacePath - Workspace or folder path
 * @param {number} port - Assigned port number
 */
function createInstanceDirectory(instanceName, workspacePath, port) {
  const instanceDir = path.join(BASE_DIR, instanceName);
  ensureDir(instanceDir);
  ensureDir(path.join(instanceDir, 'data'));
  ensureDir(path.join(instanceDir, 'extensions'));
  ensureDir(path.join(instanceDir, 'logs'));

  const metadata = {
    workspacePath,
    port,
    created: new Date().toISOString(),
    instanceName,
  };

  const metadataPath = path.join(instanceDir, 'metadata.json');
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

  console.log(`Created instance directory: ${instanceDir}`);
  return instanceDir;
}

/**
 * Update last-access timestamp for instance
 * @param {string} instanceName - Instance name
 */
function updateLastAccess(instanceName) {
  const instanceDir = path.join(BASE_DIR, instanceName);
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
 * @param {string} instanceName - Instance name
 * @returns {Promise<void>}
 */
async function launchInstance(instanceName) {
  const serviceName = `code-server-workspace@${instanceName}.service`;
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
    let instanceName = 'main';

    // Bare mode (empty window)
    if (params.ew) {
      console.log('[ROUTING] Bare mode request (ew=true) -> main instance');
      targetPort = MAIN_PORT;
      instanceName = 'main';

      // Check if main instance is running, launch if needed
      if (!(await isPortListening(targetPort))) {
        console.log(`Main instance not running, launching ${instanceName}...`);
        await launchInstance(instanceName);

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

      targetPort = computePort(workspacePath);
      instanceName = computeInstanceName(workspacePath);
      console.log(
        `[ROUTING] Computed port ${targetPort} for instance ${instanceName}`
      );

      // Ensure instance exists
      const instanceDir = path.join(BASE_DIR, instanceName);
      if (!fs.existsSync(instanceDir)) {
        createInstanceDirectory(instanceName, workspacePath, targetPort);
      }

      // Check if instance is running, launch if needed
      if (!(await isPortListening(targetPort))) {
        console.log(`Instance not running, launching ${instanceName}...`);
        await launchInstance(instanceName);

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

      targetPort = computePort(folderPath);
      instanceName = computeInstanceName(folderPath);
      console.log(
        `[ROUTING] Computed port ${targetPort} for instance ${instanceName}`
      );

      // Ensure instance exists
      const instanceDir = path.join(BASE_DIR, instanceName);
      if (!fs.existsSync(instanceDir)) {
        createInstanceDirectory(instanceName, folderPath, targetPort);
      }

      // Check if instance is running, launch if needed
      if (!(await isPortListening(targetPort))) {
        console.log(`Instance not running, launching ${instanceName}...`);
        await launchInstance(instanceName);

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
      instanceName = 'main';

      // Check if main instance is running, launch if needed
      if (!(await isPortListening(targetPort))) {
        console.log(`Main instance not running, launching ${instanceName}...`);
        await launchInstance(instanceName);

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
    updateLastAccess(instanceName);

    // Store original URL for redirect handler to access
    req._originalUrl = req.url;

    // DON'T strip workspace/folder parameters - let backend see them
    // The backend code-server is already configured with the workspace,
    // so it will handle the parameter correctly without redirecting

    // Proxy the request
    const target = `http://127.0.0.1:${targetPort}`;
    console.log(`[PROXY] Proxying ${req.method} ${req.url} -> ${target}`);
    console.log(`[PROXY] Instance: ${instanceName}, Port: ${targetPort}`);
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
    let instanceName = 'main';

    if (params.ew) {
      targetPort = MAIN_PORT;
      instanceName = 'main';
    } else if (params.workspace) {
      targetPort = computePort(params.workspace);
      instanceName = computeInstanceName(params.workspace);
    } else if (params.folder) {
      targetPort = computePort(params.folder);
      instanceName = computeInstanceName(params.folder);
    }

    // Update last-access timestamp
    updateLastAccess(instanceName);

    // Store original URL for potential redirect handling
    req._originalUrl = req.url;

    // DON'T strip workspace/folder parameters from WebSocket upgrades
    // WebSocket connections need to maintain routing context

    // Proxy the WebSocket
    const target = `http://127.0.0.1:${targetPort}`;
    console.log(`[WEBSOCKET] Proxying WebSocket upgrade -> ${target}`);
    console.log(`[WEBSOCKET] Instance: ${instanceName}, Port: ${targetPort}`);
    console.log('='.repeat(80));
    proxy.ws(req, socket, head, { target });
  } catch (error) {
    console.error('Error handling WebSocket upgrade:', error);
    socket.destroy();
  }
}

// Initialize base directory structure
ensureDir(BASE_DIR);
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
    instanceName: 'main',
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
