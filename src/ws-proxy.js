/**
 * WebSocket Proxy with Ping/Pong Keepalive
 *
 * Proxies WebSocket connections between client and backend with periodic
 * ping/pong to detect stale connections early.
 */

const WebSocket = require('ws');

// Configuration
const PING_INTERVAL = 30000; // Send ping every 30 seconds
const PONG_TIMEOUT = 10000; // Wait 10 seconds for pong response

// Track active connections for cleanup
const activeConnections = new Set();

/**
 * Proxy a WebSocket connection to a backend with ping/pong keepalive
 * @param {http.IncomingMessage} req - Upgrade request
 * @param {net.Socket} socket - Client socket
 * @param {Buffer} head - First packet
 * @param {string} targetUrl - Backend WebSocket URL (ws://...)
 * @param {string} instanceId - Instance ID for logging
 */
function proxyWebSocket(req, socket, head, targetUrl, instanceId) {
  const shortId = instanceId.substring(0, 8);
  const clientId = `${shortId}-${Date.now().toString(36)}`;

  // Create WebSocket server to handle the client connection
  const wss = new WebSocket.Server({ noServer: true });

  wss.handleUpgrade(req, socket, head, (clientWs) => {
    console.log(`[WS-PROXY] Client connected: ${clientId}`);

    // Connect to backend - forward all headers for auth
    const backendHeaders = {};
    // Copy all headers except hop-by-hop headers
    const hopByHop = [
      'connection',
      'upgrade',
      'sec-websocket-key',
      'sec-websocket-version',
      'sec-websocket-extensions',
    ];
    for (const [key, value] of Object.entries(req.headers)) {
      if (!hopByHop.includes(key.toLowerCase())) {
        backendHeaders[key] = value;
      }
    }

    const backendWs = new WebSocket(targetUrl, {
      headers: backendHeaders,
    });

    let isAlive = true;
    let pingInterval = null;
    let pongTimeout = null;

    const cleanup = () => {
      activeConnections.delete(clientId);
      if (pingInterval) clearInterval(pingInterval);
      if (pongTimeout) clearTimeout(pongTimeout);

      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close(1000, 'Connection closed');
      }
      if (backendWs.readyState === WebSocket.OPEN) {
        backendWs.close(1000, 'Connection closed');
      }
    };

    activeConnections.add(clientId);

    // Backend connection handlers
    backendWs.on('open', () => {
      console.log(`[WS-PROXY] Backend connected: ${clientId}`);

      // Start ping/pong keepalive on backend
      pingInterval = setInterval(() => {
        if (!isAlive) {
          console.log(`[WS-PROXY] Backend unresponsive, closing: ${clientId}`);
          cleanup();
          return;
        }

        isAlive = false;
        backendWs.ping();

        // Set timeout for pong response
        pongTimeout = setTimeout(() => {
          if (!isAlive) {
            console.log(`[WS-PROXY] Pong timeout, closing: ${clientId}`);
            cleanup();
          }
        }, PONG_TIMEOUT);
      }, PING_INTERVAL);
    });

    backendWs.on('pong', () => {
      isAlive = true;
      if (pongTimeout) {
        clearTimeout(pongTimeout);
        pongTimeout = null;
      }
    });

    backendWs.on('message', (data, isBinary) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data, { binary: isBinary });
      }
    });

    backendWs.on('close', (code, reason) => {
      console.log(
        `[WS-PROXY] Backend closed: ${clientId} (${code} ${reason || ''})`
      );
      cleanup();
    });

    backendWs.on('error', (err) => {
      console.error(`[WS-PROXY] Backend error: ${clientId}`, err.message);
      cleanup();
    });

    // Client connection handlers
    clientWs.on('message', (data, isBinary) => {
      if (backendWs.readyState === WebSocket.OPEN) {
        backendWs.send(data, { binary: isBinary });
      }
    });

    clientWs.on('close', (code, reason) => {
      console.log(
        `[WS-PROXY] Client closed: ${clientId} (${code} ${reason || ''})`
      );
      cleanup();
    });

    clientWs.on('error', (err) => {
      console.error(`[WS-PROXY] Client error: ${clientId}`, err.message);
      cleanup();
    });

    // Forward ping/pong from client to backend
    clientWs.on('ping', (data) => {
      if (backendWs.readyState === WebSocket.OPEN) {
        backendWs.ping(data);
      }
    });

    clientWs.on('pong', (data) => {
      if (backendWs.readyState === WebSocket.OPEN) {
        backendWs.pong(data);
      }
    });
  });
}

/**
 * Get count of active WebSocket connections
 * @returns {number}
 */
function getActiveConnectionCount() {
  return activeConnections.size;
}

/**
 * Cleanup all active connections (for shutdown)
 */
function cleanupAllConnections() {
  console.log(
    `[WS-PROXY] Cleaning up ${activeConnections.size} active connections`
  );
  // Connections will self-cleanup when closed
  activeConnections.clear();
}

module.exports = {
  proxyWebSocket,
  getActiveConnectionCount,
  cleanupAllConnections,
  PING_INTERVAL,
  PONG_TIMEOUT,
};
