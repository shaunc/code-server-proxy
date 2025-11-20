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
 * - Uses debouncing to avoid duplicate writes and event loops
 */

const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');

// Configuration
const INSTANCES_BASE_PATH =
  process.env.INSTANCES_BASE_PATH ||
  path.join(process.env.HOME, '.code-workspaces/instances');
const DEBOUNCE_DELAY = 100; // milliseconds
const SYNCED_FILES = ['settings.json', 'keybindings.json'];

// State
let watcher = null;
let debounceTimers = new Map(); // filename -> timeout
let lastWriteTimes = new Map(); // instanceId:filename -> timestamp

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
    // Read source file
    const content = fs.readFileSync(sourcePath, 'utf8');

    // Write to temp file
    fs.writeFileSync(tempPath, content, 'utf8');

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
 * Propagate settings file change to all other instances
 * @param {string} changedFile - Full path to changed file
 */
function propagateChange(changedFile) {
  const fileName = path.basename(changedFile);

  // Only sync specific files
  if (!SYNCED_FILES.includes(fileName)) {
    return;
  }

  // Extract source instance ID from path
  const pathParts = changedFile.split(path.sep);
  const instancesIndex = pathParts.indexOf('instances');
  if (instancesIndex === -1 || instancesIndex + 1 >= pathParts.length) {
    console.error(`Invalid instance path: ${changedFile}`);
    return;
  }
  const sourceInstanceId = pathParts[instancesIndex + 1];

  // Debounce: clear existing timer for this file
  const debounceKey = `${sourceInstanceId}:${fileName}`;
  if (debounceTimers.has(debounceKey)) {
    clearTimeout(debounceTimers.get(debounceKey));
  }

  // Set new debounce timer
  const timer = setTimeout(() => {
    debounceTimers.delete(debounceKey);

    // Record this write time to avoid loops
    const writeKey = `${sourceInstanceId}:${fileName}`;
    lastWriteTimes.set(writeKey, Date.now());

    // Get all instances
    const instances = getWorkspaceInstances();

    // Propagate to all OTHER instances
    let propagatedCount = 0;
    for (const instance of instances) {
      if (instance.instanceId === sourceInstanceId) {
        continue; // Skip source instance
      }

      const targetPath = path.join(instance.userDir, fileName);

      try {
        // Check if we recently wrote to this target (avoid loops)
        const targetWriteKey = `${instance.instanceId}:${fileName}`;
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
          `Failed to sync ${fileName} to ${instance.instanceId}:`,
          error.message
        );
      }
    }

    if (propagatedCount > 0) {
      console.log(
        `[SETTINGS-SYNC] Propagated ${fileName} from ${sourceInstanceId} to ${propagatedCount} instance(s)`
      );
    }
  }, DEBOUNCE_DELAY);

  debounceTimers.set(debounceKey, timer);
}

/**
 * Start settings sync service
 */
function start() {
  if (watcher) {
    console.warn('[SETTINGS-SYNC] Service already running');
    return;
  }

  console.log('[SETTINGS-SYNC] Starting service...');

  // Ensure base path exists
  if (!fs.existsSync(INSTANCES_BASE_PATH)) {
    fs.mkdirSync(INSTANCES_BASE_PATH, { recursive: true });
  }

  // Build watch patterns for all synced files in all instances
  const watchPatterns = SYNCED_FILES.map((file) =>
    path.join(INSTANCES_BASE_PATH, '*/data/User', file)
  );

  console.log(`[SETTINGS-SYNC] Watching patterns:`, watchPatterns);

  // Create watcher
  watcher = chokidar.watch(watchPatterns, {
    persistent: true,
    ignoreInitial: true, // Don't trigger on initial scan
    awaitWriteFinish: {
      stabilityThreshold: 50,
      pollInterval: 10,
    },
  });

  // Handle file changes
  watcher.on('change', (filePath) => {
    console.log(`[SETTINGS-SYNC] Detected change: ${filePath}`);
    propagateChange(filePath);
  });

  // Handle file additions (new settings file created)
  watcher.on('add', (filePath) => {
    console.log(`[SETTINGS-SYNC] Detected new file: ${filePath}`);
    propagateChange(filePath);
  });

  // Handle errors
  watcher.on('error', (error) => {
    console.error('[SETTINGS-SYNC] Watcher error:', error);
  });

  // Log when ready
  watcher.on('ready', () => {
    const instances = getWorkspaceInstances();
    console.log(
      `[SETTINGS-SYNC] Service ready, watching ${instances.length} instance(s)`
    );
  });
}

/**
 * Stop settings sync service
 */
async function stop() {
  if (!watcher) {
    return;
  }

  console.log('[SETTINGS-SYNC] Stopping service...');

  // Clear all debounce timers
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();
  lastWriteTimes.clear();

  // Close watcher
  await watcher.close();
  watcher = null;

  console.log('[SETTINGS-SYNC] Service stopped');
}

module.exports = {
  start,
  stop,
};
