/* global URLSearchParams, URL */
/**
 * Reconnect Helper - Client-side script for WebSocket routing and auto-reload
 *
 * This script is injected into code-server pages by the proxy.
 *
 * Features:
 * 1. WebSocket URL rewriting - Adds workspace/folder params to WebSocket URLs
 *    so the proxy can route connections to the correct backend instance.
 *    Each tab knows its workspace from window.location.search.
 *
 * 2. Auto-reload on disconnect - Monitors for VSCode's "Cannot reconnect"
 *    dialog and automatically reloads the page to restore the session.
 */

(function () {
  'use strict';

  const LOG_PREFIX = '[reconnect-helper]';
  const RELOAD_DELAY_MS = 1500;

  // Extract workspace/folder from current page URL
  const urlParams = new URLSearchParams(window.location.search);
  const workspace = urlParams.get('workspace');
  const folder = urlParams.get('folder');

  /**
   * Intercept WebSocket constructor to add workspace routing params
   */
  if (workspace || folder) {
    const OriginalWebSocket = window.WebSocket;

    window.WebSocket = function (url, protocols) {
      try {
        const wsUrl = new URL(url, window.location.origin);

        // Add workspace/folder param if not already present
        if (workspace && !wsUrl.searchParams.has('workspace')) {
          wsUrl.searchParams.set('workspace', workspace);
        } else if (folder && !wsUrl.searchParams.has('folder')) {
          wsUrl.searchParams.set('folder', folder);
        }

        const newUrl = wsUrl.toString();
        if (newUrl !== url) {
          console.log(`${LOG_PREFIX} WebSocket URL rewritten for routing`);
        }

        return new OriginalWebSocket(newUrl, protocols);
      } catch (e) {
        // If URL parsing fails, use original
        console.warn(`${LOG_PREFIX} WebSocket URL rewrite failed:`, e.message);
        return new OriginalWebSocket(url, protocols);
      }
    };

    // Preserve WebSocket properties
    window.WebSocket.prototype = OriginalWebSocket.prototype;
    window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
    window.WebSocket.OPEN = OriginalWebSocket.OPEN;
    window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
    window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;

    console.log(
      `${LOG_PREFIX} WebSocket routing enabled for ${workspace || folder}`
    );
  }

  /**
   * Auto-reload functionality for connection failures
   */
  let reloadScheduled = false;

  function isReconnectionFailureDialog(element) {
    const text = element.textContent || '';
    return (
      text.includes('Cannot reconnect') ||
      text.includes('Connection to the server was lost') ||
      text.includes('Attempting to reconnect')
    );
  }

  function scheduleReload() {
    if (reloadScheduled) {
      return;
    }
    reloadScheduled = true;

    console.log(
      `${LOG_PREFIX} Connection failure detected, reloading in ${RELOAD_DELAY_MS}ms...`
    );

    setTimeout(() => {
      console.log(`${LOG_PREFIX} Reloading page...`);
      window.location.reload();
    }, RELOAD_DELAY_MS);
  }

  function handleMutations(mutations) {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) {
          continue;
        }

        const dialogs = node.querySelectorAll
          ? [
              ...node.querySelectorAll('.monaco-dialog-box'),
              ...(node.classList?.contains('monaco-dialog-box') ? [node] : []),
            ]
          : [];

        for (const dialog of dialogs) {
          if (isReconnectionFailureDialog(dialog)) {
            scheduleReload();
            return;
          }
        }

        const notifications = node.querySelectorAll
          ? [
              ...node.querySelectorAll('.notification-toast'),
              ...(node.classList?.contains('notification-toast') ? [node] : []),
            ]
          : [];

        for (const notification of notifications) {
          if (isReconnectionFailureDialog(notification)) {
            scheduleReload();
            return;
          }
        }
      }
    }
  }

  function init() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', init);
      return;
    }

    const observer = new MutationObserver(handleMutations);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    console.log(`${LOG_PREFIX} Monitoring for connection failures...`);
  }

  init();
})();
