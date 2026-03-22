/**
 * WebSocket Proxy with Keepalive
 *
 * Proxies WebSocket connections between client and backend with periodic
 * pings to generate traffic and keep connections alive through NAT/firewalls.
 *
 * Note: Pings are for keepalive only - we do NOT close connections on missed
 * pongs. Connections stay alive until explicitly closed by either end.
 */

const WebSocket = require('ws');

// Configuration - ping interval for keepalive traffic generation
const PING_INTERVAL = parseInt(process.env.WS_PING_INTERVAL) || 30000; // 30s

// Track active connections for cleanup
const activeConnections = new Map(); // clientId -> { startTime, ... }

/**
 * Proxy a WebSocket connection to a backend with keepalive pings
 * @param {http.IncomingMessage} req - Upgrade request
 * @param {net.Socket} socket - Client socket
 * @param {Buffer} head - First packet
 * @param {string} targetUrl - Backend WebSocket URL (ws://...)
 * @param {string} instanceId - Instance ID for logging
 */
function proxyWebSocket(req, socket, head, targetUrl, instanceId) {
  const shortId = instanceId.substring(0, 8);
  const clientId = `${shortId}-${Date.now().toString(36)}`;
  const startTime = Date.now();

  // Enable TCP keepalive on the client socket
  if (socket.setKeepAlive) {
    socket.setKeepAlive(true, 30000);
  }

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

    let pingInterval = null;

    const cleanup = () => {
      activeConnections.delete(clientId);
      if (pingInterval) clearInterval(pingInterval);

      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close(1000, 'Connection closed');
      }
      if (backendWs.readyState === WebSocket.OPEN) {
        backendWs.close(1000, 'Connection closed');
      }
    };

    activeConnections.set(clientId, { startTime, instanceId });

    // Backend connection handlers
    backendWs.on('open', () => {
      console.log(`[WS-PROXY] Backend connected: ${clientId}`);

      // Start periodic pings for keepalive (traffic generation only)
      // We do NOT close on missed pongs - this is purely to keep
      // NAT mappings and firewalls happy
      pingInterval = setInterval(() => {
        if (backendWs.readyState === WebSocket.OPEN) {
          backendWs.ping();
        }
      }, PING_INTERVAL);
    });

    backendWs.on('message', (data, isBinary) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data, { binary: isBinary });
      }
    });

    backendWs.on('close', (code, reason) => {
      const duration = Math.round((Date.now() - startTime) / 1000);
      console.log(
        `[WS-PROXY] Backend closed: ${clientId} after ${duration}s (${code} ${reason || ''})`
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
      const duration = Math.round((Date.now() - startTime) / 1000);
      console.log(
        `[WS-PROXY] Client closed: ${clientId} after ${duration}s (${code} ${reason || ''})`
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
 * Check if an instance has any active WebSocket connections
 * @param {string} instanceId - Instance ID
 * @returns {boolean}
 */
function hasActiveConnections(instanceId) {
  for (const conn of activeConnections.values()) {
    if (conn.instanceId === instanceId) return true;
  }
  return false;
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
  hasActiveConnections,
  cleanupAllConnections,
  PING_INTERVAL,
};
