/**
 * Settings Sync Service
 *
 * Synchronizes VSCode settings.json and keybindings.json across all workspace instances.
 * Each workspace has its own User directory for isolation, but settings files are
 * propagated using file system watching and atomic copy operations.
 *
 * Architecture:
 * - Each workspace instance has: ~/.code-workspaces/instances/{instanceId}/data/User/
 * - This service watches all instance User directories for changes to settings files
 * - When a change is detected, it's propagated to all other instances atomically
 * - Uses native fs.watch (inotify on Linux) instead of chokidar for reliable event detection
 * - Uses debouncing to avoid duplicate writes and event loops
 */

const fs = require('fs');
const path = require('path');

// Configuration
const INSTANCES_BASE_PATH =
  process.env.INSTANCES_BASE_PATH ||
  path.join(process.env.HOME, '.code-workspaces/instances');
const DEBOUNCE_DELAY = 100; // milliseconds
const SCAN_INTERVAL = 30000; // 30 seconds - check for new instances

// Files in the User directory to sync
const SYNCED_FILES = ['settings.json', 'keybindings.json'];

// Files in globalStorage/kilocode.kilo-code/settings/ to sync
const KILO_CODE_SYNCED_FILES = ['mcp_settings.json', 'custom_modes.yaml'];

// Additional files in User directory to sync (wrapper scripts, etc.)
const SYNCED_USER_FILES = ['mcp-ssh-wrapper.sh'];

// State
let watchers = new Map(); // filePath -> fs.FSWatcher
let debounceTimers = new Map(); // instanceId:filename -> timeout
let lastWriteTimes = new Map(); // instanceId:filename -> timestamp
let scanInterval = null;
let isRunning = false;

/**
 * Get all workspace instance directories
 * @returns {Array<{instanceId: string, userDir: string}>}
 */
function getWorkspaceInstances() {
  const instances = [];

  if (!fs.existsSync(INSTANCES_BASE_PATH)) {
    return instances;
  }

  const entries = fs.readdirSync(INSTANCES_BASE_PATH, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const userDir = path.join(INSTANCES_BASE_PATH, entry.name, 'data/User');
      if (fs.existsSync(userDir)) {
        instances.push({
          instanceId: entry.name,
          userDir,
        });
      }
    }
  }

  return instances;
}

/**
 * Copy file atomically using temp-then-rename pattern
 * @param {string} sourcePath - Source file path
 * @param {string} targetPath - Target file path
 */
function copyFileAtomic(sourcePath, targetPath) {
  const tempPath = `${targetPath}.tmp`;

  try {
    // Get source file permissions
    const sourceStats = fs.statSync(sourcePath);
    const sourceMode = sourceStats.mode;

    // Read source file
    const content = fs.readFileSync(sourcePath, 'utf8');

    // Write to temp file with same permissions
    fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode: sourceMode });

    // Atomic rename
    fs.renameSync(tempPath, targetPath);
  } catch (error) {
    // Clean up temp file if it exists
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
    throw error;
  }
}

/**
 * Get relative path from User directory for a file
 * @param {string} filePath - Full file path
 * @param {string} userDir - User directory path
 * @returns {string} Relative path from User directory
 */
function getRelativePath(filePath, userDir) {
  return path.relative(userDir, filePath);
}

/**
 * Propagate settings file change to all other instances
 * @param {string} changedFile - Full path to changed file
 */
function propagateChange(changedFile) {
  const fileName = path.basename(changedFile);

  // Extract source instance ID from path
  const pathParts = changedFile.split(path.sep);
  const instancesIndex = pathParts.indexOf('instances');
  if (instancesIndex === -1 || instancesIndex + 1 >= pathParts.length) {
    console.error(`[SETTINGS-SYNC] Invalid instance path: ${changedFile}`);
    return;
  }
  const sourceInstanceId = pathParts[instancesIndex + 1];

  // Determine the relative path within User directory
  const userDir = path.join(INSTANCES_BASE_PATH, sourceInstanceId, 'data/User');
  const relativePath = getRelativePath(changedFile, userDir);

  // Only sync specific files (check all lists)
  const allSyncedFiles = [
    ...SYNCED_FILES,
    ...SYNCED_USER_FILES,
    ...KILO_CODE_SYNCED_FILES.map(
      (f) => `globalStorage/kilocode.kilo-code/settings/${f}`
    ),
  ];

  if (
    !allSyncedFiles.includes(relativePath) &&
    !SYNCED_FILES.includes(fileName)
  ) {
    return;
  }

  // Debounce: clear existing timer for this file
  const debounceKey = `${sourceInstanceId}:${relativePath}`;
  if (debounceTimers.has(debounceKey)) {
    clearTimeout(debounceTimers.get(debounceKey));
  }

  // Set new debounce timer
  const timer = setTimeout(() => {
    debounceTimers.delete(debounceKey);

    // Check if file still exists (might have been deleted)
    if (!fs.existsSync(changedFile)) {
      console.log(
        `[SETTINGS-SYNC] Source file no longer exists: ${changedFile}`
      );
      return;
    }

    // Record this write time to avoid loops
    const writeKey = `${sourceInstanceId}:${relativePath}`;
    lastWriteTimes.set(writeKey, Date.now());

    // Get all instances
    const instances = getWorkspaceInstances();

    // Propagate to all OTHER instances
    let propagatedCount = 0;
    for (const instance of instances) {
      if (instance.instanceId === sourceInstanceId) {
        continue; // Skip source instance
      }

      const targetPath = path.join(instance.userDir, relativePath);

      // Ensure target directory exists (for nested paths like globalStorage/...)
      const targetDir = path.dirname(targetPath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      try {
        // Check if we recently wrote to this target (avoid loops)
        const targetWriteKey = `${instance.instanceId}:${relativePath}`;
        const lastWrite = lastWriteTimes.get(targetWriteKey);
        if (lastWrite && Date.now() - lastWrite < DEBOUNCE_DELAY * 2) {
          // Skip if we wrote to this file very recently
          continue;
        }

        // Copy file atomically
        copyFileAtomic(changedFile, targetPath);
        propagatedCount++;

        // Record this write
        lastWriteTimes.set(targetWriteKey, Date.now());
      } catch (error) {
        console.error(
          `[SETTINGS-SYNC] Failed to sync ${fileName} to ${instance.instanceId}:`,
          error.message
        );
      }
    }

    if (propagatedCount > 0) {
      console.log(
        `[SETTINGS-SYNC] Propagated ${relativePath} from ${sourceInstanceId.substring(0, 8)}... to ${propagatedCount} instance(s)`
      );
    }
  }, DEBOUNCE_DELAY);

  debounceTimers.set(debounceKey, timer);
}

/**
 * Start watching a specific file
 * @param {string} filePath - Path to file to watch
 */
function watchFile(filePath) {
  if (watchers.has(filePath)) {
    return; // Already watching
  }

  if (!fs.existsSync(filePath)) {
    return; // File doesn't exist yet
  }

  try {
    const watcher = fs.watch(filePath, (eventType, filename) => {
      if (eventType === 'change') {
        console.log(`[SETTINGS-SYNC] Detected change: ${filePath}`);
        propagateChange(filePath);
      } else if (eventType === 'rename') {
        // File was renamed/deleted - stop watching and re-scan
        console.log(`[SETTINGS-SYNC] File renamed/deleted: ${filePath}`);
        unwatchFile(filePath);
      }
    });

    watcher.on('error', (error) => {
      console.error(`[SETTINGS-SYNC] Watcher error for ${filePath}:`, error);
      unwatchFile(filePath);
    });

    watchers.set(filePath, watcher);
  } catch (error) {
    console.error(`[SETTINGS-SYNC] Failed to watch ${filePath}:`, error);
  }
}

/**
 * Stop watching a specific file
 * @param {string} filePath - Path to file to unwatch
 */
function unwatchFile(filePath) {
  const watcher = watchers.get(filePath);
  if (watcher) {
    try {
      watcher.close();
    } catch (error) {
      // Ignore close errors
    }
    watchers.delete(filePath);
  }
}

/**
 * Scan for all instances and ensure watchers are set up
 */
function scanAndWatch() {
  const instances = getWorkspaceInstances();
  const currentFiles = new Set();

  // Set up watchers for all instance files
  for (const instance of instances) {
    // Watch main settings files (settings.json, keybindings.json)
    for (const fileName of SYNCED_FILES) {
      const filePath = path.join(instance.userDir, fileName);
      currentFiles.add(filePath);
      watchFile(filePath);
    }

    // Watch additional User files (mcp-ssh-wrapper.sh, etc.)
    for (const fileName of SYNCED_USER_FILES) {
      const filePath = path.join(instance.userDir, fileName);
      currentFiles.add(filePath);
      watchFile(filePath);
    }

    // Watch Kilo Code settings files
    const kiloCodeDir = path.join(
      instance.userDir,
      'globalStorage/kilocode.kilo-code/settings'
    );
    for (const fileName of KILO_CODE_SYNCED_FILES) {
      const filePath = path.join(kiloCodeDir, fileName);
      currentFiles.add(filePath);
      watchFile(filePath);
    }
  }

  // Remove watchers for files that no longer exist
  for (const filePath of watchers.keys()) {
    if (!currentFiles.has(filePath)) {
      console.log(`[SETTINGS-SYNC] Removing watcher for deleted: ${filePath}`);
      unwatchFile(filePath);
    }
  }

  return instances.length;
}

/**
 * Start settings sync service
 */
function start() {
  if (isRunning) {
    console.warn('[SETTINGS-SYNC] Service already running');
    return;
  }

  console.log('[SETTINGS-SYNC] Starting service...');

  // Ensure base path exists
  if (!fs.existsSync(INSTANCES_BASE_PATH)) {
    fs.mkdirSync(INSTANCES_BASE_PATH, { recursive: true });
  }

  isRunning = true;

  // Initial scan
  const instanceCount = scanAndWatch();
  console.log(
    `[SETTINGS-SYNC] Service ready, watching ${instanceCount} instance(s), ${watchers.size} file(s)`
  );

  // Periodic scan for new instances
  scanInterval = setInterval(() => {
    const count = scanAndWatch();
    // Only log if watcher count changed significantly
  }, SCAN_INTERVAL);

  console.log('[SETTINGS-SYNC] Using native fs.watch (inotify)');
}

/**
 * Stop settings sync service
 */
async function stop() {
  if (!isRunning) {
    return;
  }

  console.log('[SETTINGS-SYNC] Stopping service...');

  // Stop periodic scan
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }

  // Clear all debounce timers
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();
  lastWriteTimes.clear();

  // Close all watchers
  for (const filePath of watchers.keys()) {
    unwatchFile(filePath);
  }

  isRunning = false;
  console.log('[SETTINGS-SYNC] Service stopped');
}

module.exports = {
  start,
  stop,
};
