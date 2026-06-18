/**
 * Centralized configuration for code-server-proxy.
 *
 * All environment variables and derived paths are read here once at
 * startup. Modules import from this file instead of reading
 * process.env directly. This prevents scattered defaults, duplicate
 * parsing, and inconsistent path derivation across modules.
 */

const path = require('path');

// --- Helpers ---

function envStr(name, fallback) {
  return process.env[name] || fallback;
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    console.warn(
      `[Config] ${name}=${raw} is not a valid integer, ` +
        `using default ${fallback}`
    );
    return fallback;
  }
  return parsed;
}

function envFloat(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseFloat(raw);
  if (Number.isNaN(parsed)) {
    console.warn(
      `[Config] ${name}=${raw} is not a valid number, ` +
        `using default ${fallback}`
    );
    return fallback;
  }
  return parsed;
}

function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true';
}

function envList(name, fallback = []) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw.split(',').filter((s) => s.length > 0);
}

// --- Base paths (derived from HOME) ---

const HOME = process.env.HOME || '/root';
const WORKSPACES_DIR = path.join(HOME, '.code-workspaces');

// --- Configuration object ---

const config = {
  // Proxy server
  proxy: {
    port: 8083,
    host: '127.0.0.1',
    mainPort: 8100,
  },

  // Port allocation range
  ports: {
    min: 8101,
    max: 8199,
    tempMin: 8300,
    tempMax: 8399,
    maxProbeAttempts: 20,
  },

  // Paths (all derived from HOME)
  paths: {
    home: HOME,
    workspacesDir: WORKSPACES_DIR,
    instancesDir: envStr(
      'INSTANCES_BASE_PATH',
      path.join(WORKSPACES_DIR, 'instances')
    ),
    volumesDir: envStr(
      'WORKSPACE_VOLUMES_PATH',
      path.join(WORKSPACES_DIR, 'volumes')
    ),
    registryFile: path.join(WORKSPACES_DIR, 'port-registry.json'),
    sharedSettingsDir: path.join(WORKSPACES_DIR, 'shared'),
    configDir: path.join(__dirname, '..', 'config'),
  },

  // Docker
  docker: {
    enabled: envBool('USE_DOCKER'),
    image: envStr('DOCKER_IMAGE', 'code-server-proxy:latest'),
    memoryLimit: envStr('DOCKER_MEMORY_LIMIT', '4g'),
    cpuLimit: envFloat('DOCKER_CPU_LIMIT', 3.0),
    sharedExtensionsVolume: envStr(
      'SHARED_EXTENSIONS_VOLUME',
      'code-server-extensions'
    ),
    enableAutoSsh: envBool('ENABLE_AUTO_SSH'),
    enableGpu: envBool('ENABLE_GPU'),
  },

  // Capacity and lifecycle
  instances: {
    maxConcurrent: 36,
    backendReadyTimeout: 30000,
    backendReadyPollInterval: 500,
  },

  // Idle monitoring
  idle: {
    thresholdDays: envInt('IDLE_THRESHOLD_DAYS', 3),
    gracePeriodDays: envInt('IDLE_GRACE_PERIOD_DAYS', 7),
    whitelist: envList('IDLE_WHITELIST'),
  },

  // Host environment (passed into containers)
  host: {
    user: process.env.USER || '',
    sshAuthSock: process.env.SSH_AUTH_SOCK || '',
  },

  // Timers and intervals
  timers: {
    imageCacheTtl: 60000,
    outdatedCheckInterval: 2 * 60 * 1000,
    outdatedCacheTtl: 5 * 60 * 1000,
    activitySaveInterval: 5 * 60 * 1000,
    activitySaveDebounce: 30 * 1000,
    settingsScanInterval: 30000,
    settingsDebounceDelay: 100,
    wsPingInterval: envInt('WS_PING_INTERVAL', 30000),
  },
};

// Derived: mounts config path (depends on configDir)
// Host-specific layouts (e.g. rayon, which lacks /data/sda and mambaforge)
// select an alternate file via MOUNTS_CONFIG; defaults to the silk layout.
config.paths.mountsConfig = envStr(
  'MOUNTS_CONFIG',
  path.join(config.paths.configDir, 'mounts.json')
);

// Freeze to prevent accidental mutation
Object.freeze(config.proxy);
Object.freeze(config.ports);
Object.freeze(config.paths);
Object.freeze(config.docker);
Object.freeze(config.instances);
Object.freeze(config.idle);
Object.freeze(config.host);
Object.freeze(config.timers);
Object.freeze(config);

module.exports = config;
