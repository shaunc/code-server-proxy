/**
 * Activity Tracker Module
 *
 * Tracks workspace activity based on WebSocket and HTTP traffic.
 * Persists activity to disk for survival across proxy restarts.
 * This enables accurate idle detection for workspaces where SSH clients
 * remain running even when the workspace is idle.
 */

const fs = require('fs');
const path = require('path');

// Configuration
const INSTANCES_BASE_PATH =
  process.env.INSTANCES_BASE_PATH ||
  path.join(process.env.HOME, '.code-workspaces', 'instances');
const ACTIVITY_FILE = path.join(
  path.dirname(INSTANCES_BASE_PATH),
  '.activity.json'
);
const SAVE_INTERVAL = 5 * 60 * 1000; // Save every 5 minutes
const SAVE_DEBOUNCE = 30 * 1000; // Debounce 30s after change

class ActivityTracker {
  constructor() {
    // Map of workspaceId -> timestamp (in milliseconds)
    this.lastActivity = new Map();
    this.dirty = false;
    this.saveTimer = null;
    this.intervalTimer = null;

    // Load persisted activity on startup
    this.load();

    // Start periodic save
    this.intervalTimer = setInterval(() => this.save(), SAVE_INTERVAL);
  }

  /**
   * Load activity from persistent storage
   */
  load() {
    try {
      if (fs.existsSync(ACTIVITY_FILE)) {
        const data = JSON.parse(fs.readFileSync(ACTIVITY_FILE, 'utf8'));
        if (data.version === 1 && data.activity) {
          for (const [id, timestamp] of Object.entries(data.activity)) {
            // Convert ISO string back to timestamp
            const ts =
              typeof timestamp === 'string'
                ? new Date(timestamp).getTime()
                : timestamp;
            this.lastActivity.set(id, ts);
          }
          console.log(
            `[ActivityTracker] Loaded ${this.lastActivity.size} activity records`
          );
        }
      }
    } catch (error) {
      console.error(
        '[ActivityTracker] Failed to load activity file:',
        error.message
      );
    }
  }

  /**
   * Save activity to persistent storage (async)
   */
  save() {
    if (!this.dirty && this.lastActivity.size === 0) {
      return;
    }

    try {
      const activity = {};
      for (const [id, timestamp] of this.lastActivity.entries()) {
        activity[id] = new Date(timestamp).toISOString();
      }

      const data = {
        version: 1,
        lastSaved: new Date().toISOString(),
        activity,
      };

      // Atomic write via temp file
      const tempFile = `${ACTIVITY_FILE}.tmp`;
      fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
      fs.renameSync(tempFile, ACTIVITY_FILE);

      this.dirty = false;
    } catch (error) {
      console.error(
        '[ActivityTracker] Failed to save activity file:',
        error.message
      );
    }
  }

  /**
   * Save activity synchronously (for shutdown)
   */
  saveSync() {
    this.save();
  }

  /**
   * Schedule a debounced save
   */
  scheduleSave() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.save();
      this.saveTimer = null;
    }, SAVE_DEBOUNCE);
  }

  /**
   * Record activity for a workspace
   * @param {string} workspaceId - The workspace identifier
   */
  recordActivity(workspaceId) {
    this.lastActivity.set(workspaceId, Date.now());
    this.dirty = true;
    this.scheduleSave();
  }

  /**
   * Initialize activity for a workspace (e.g., on container creation)
   * Only sets if no activity exists
   * @param {string} workspaceId - The workspace identifier
   * @param {number} timestamp - Optional timestamp (defaults to now)
   */
  initializeActivity(workspaceId, timestamp = Date.now()) {
    if (!this.lastActivity.has(workspaceId)) {
      this.lastActivity.set(workspaceId, timestamp);
      this.dirty = true;
      this.scheduleSave();
    }
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
   * Get idle time in days for a workspace
   * @param {string} workspaceId - The workspace identifier
   * @returns {number|null} - Idle time in days, or null if no activity
   */
  getIdleDays(workspaceId) {
    const seconds = this.getIdleTime(workspaceId);
    if (seconds === null) return null;
    return seconds / (60 * 60 * 24);
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
   * Get all tracked workspace IDs
   * @returns {Array<string>}
   */
  getAllWorkspaceIds() {
    return Array.from(this.lastActivity.keys());
  }

  /**
   * Remove workspace from tracking
   * @param {string} workspaceId - The workspace identifier
   */
  removeWorkspace(workspaceId) {
    if (this.lastActivity.delete(workspaceId)) {
      this.dirty = true;
      this.scheduleSave();
    }
  }

  /**
   * Cleanup - stop timers and save
   */
  shutdown() {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveSync();
  }
}

// Export singleton instance
module.exports = new ActivityTracker();
