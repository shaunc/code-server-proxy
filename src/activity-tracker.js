/**
 * Activity Tracker Module
 *
 * Tracks workspace activity based on WebSocket and HTTP traffic.
 * This enables accurate idle detection for workspaces where SSH clients
 * remain running even when the workspace is idle.
 */

class ActivityTracker {
  constructor() {
    // Map of workspaceId -> timestamp (in milliseconds)
    this.lastActivity = new Map();
  }

  /**
   * Record activity for a workspace
   * @param {string} workspaceId - The workspace identifier
   */
  recordActivity(workspaceId) {
    this.lastActivity.set(workspaceId, Date.now());
  }

  /**
   * Get last activity timestamp for a workspace
   * @param {string} workspaceId - The workspace identifier
   * @returns {number|null} - Timestamp in ms, or null if no activity recorded
   */
  getLastActivity(workspaceId) {
    return this.lastActivity.get(workspaceId) || null;
  }

  /**
   * Get idle time in seconds for a workspace
   * @param {string} workspaceId - The workspace identifier
   * @returns {number|null} - Idle time in seconds, or null if no activity
   */
  getIdleTime(workspaceId) {
    const lastActivity = this.getLastActivity(workspaceId);
    if (!lastActivity) return null;
    return Math.floor((Date.now() - lastActivity) / 1000);
  }

  /**
   * Get all idle workspaces exceeding threshold
   * @param {number} thresholdSeconds - Idle threshold in seconds
   * @returns {Array<{workspaceId: string, idleTime: number}>}
   */
  getIdleWorkspaces(thresholdSeconds) {
    const idle = [];
    for (const [workspaceId, lastActivity] of this.lastActivity.entries()) {
      const idleTime = Math.floor((Date.now() - lastActivity) / 1000);
      if (idleTime >= thresholdSeconds) {
        idle.push({ workspaceId, idleTime });
      }
    }
    return idle;
  }

  /**
   * Remove workspace from tracking
   * @param {string} workspaceId - The workspace identifier
   */
  removeWorkspace(workspaceId) {
    this.lastActivity.delete(workspaceId);
  }
}

// Export singleton instance
module.exports = new ActivityTracker();
