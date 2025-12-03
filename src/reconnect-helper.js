/**
 * Reconnect Helper - Client-side script for auto-reload on connection failure
 *
 * This script is injected into code-server pages by the proxy.
 * It monitors for VSCode's "Cannot reconnect" dialog and automatically
 * reloads the page to restore the session.
 *
 * Background: When WebSocket connection drops (laptop sleep, network blip),
 * VSCode tries to reconnect with its reconnectionToken. If the server-side
 * session has expired (~60 seconds), VSCode shows "Cannot reconnect" dialog.
 * This script detects that and reloads automatically.
 */

(function () {
  'use strict';

  const RELOAD_DELAY_MS = 1500; // Allow time for any pending saves
  const LOG_PREFIX = '[reconnect-helper]';

  let reloadScheduled = false;

  /**
   * Check if element contains reconnection failure text
   * @param {Element} element - DOM element to check
   * @returns {boolean}
   */
  function isReconnectionFailureDialog(element) {
    const text = element.textContent || '';
    // VSCode uses these messages for reconnection failures
    return (
      text.includes('Cannot reconnect') ||
      text.includes('Connection to the server was lost') ||
      text.includes('Attempting to reconnect')
    );
  }

  /**
   * Schedule page reload with delay
   */
  function scheduleReload() {
    if (reloadScheduled) {
      return;
    }
    reloadScheduled = true;

    console.log(
      `${LOG_PREFIX} Connection failure detected, reloading in ${RELOAD_DELAY_MS}ms...`
    );

    // Brief delay to allow any in-flight save operations
    setTimeout(() => {
      console.log(`${LOG_PREFIX} Reloading page...`);
      window.location.reload();
    }, RELOAD_DELAY_MS);
  }

  /**
   * Handle DOM mutations - look for reconnection failure dialogs
   * @param {MutationRecord[]} mutations
   */
  function handleMutations(mutations) {
    for (const mutation of mutations) {
      // Check added nodes
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) {
          continue;
        }

        // Look for Monaco dialog boxes (VSCode's modal dialogs)
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

        // Also check for the notification center messages
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

  /**
   * Initialize the mutation observer
   */
  function init() {
    // Wait for body to be available
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

  // Start monitoring
  init();
})();
