import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execSync } from "child_process";

// --- Types ---

interface PaneMapping {
  tmuxSession: string;
  name: string;
  viewColumn: number;
  cwd: string;
}

interface MappingFile {
  version: number;
  instanceId: string;
  panes: Record<string, PaneMapping>;
  lastUpdated: string;
}

// --- Persistence ---

function getMappingPath(storageUri: vscode.Uri): string {
  return path.join(storageUri.fsPath, "tmux-mapping.json");
}

function loadMapping(filePath: string): MappingFile | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const data = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(data) as MappingFile;
  } catch {
    return null;
  }
}

function persistMapping(mapping: MappingFile, filePath: string): void {
  mapping.lastUpdated = new Date().toISOString();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(mapping, null, 2));
  fs.renameSync(tmp, filePath);
}

function createEmptyMapping(instanceId: string): MappingFile {
  return {
    version: 1,
    instanceId,
    panes: {},
    lastUpdated: new Date().toISOString(),
  };
}

// --- tmux Queries ---

function getInstanceId(): string {
  // Read from environment (container-manager sets this)
  const envId = process.env.INSTANCE_ID;
  if (envId) {
    return envId;
  }
  // Fallback: read from file (injected for existing containers)
  try {
    return fs.readFileSync("/run/instance-id", "utf-8").trim();
  } catch {
    return "default";
  }
}

interface TmuxSessionInfo {
  name: string;
  attached: boolean;
}

function listTmuxSessions(instanceId: string): TmuxSessionInfo[] {
  try {
    const sshDest = `${process.env.HOST_USER}@host.docker.internal`;
    const shrc = ". ~/.shrc 2>/dev/null || true; ";
    const prefix = `cs-${instanceId}-`;
    const output = execSync(
      `ssh -o ConnectTimeout=5 -o BatchMode=yes ${sshDest} ` +
        `"${shrc}tmux list-sessions -F '#{session_name} #{session_attached}' 2>/dev/null` +
        ` | grep '^${prefix}'"`,
      { encoding: "utf-8", timeout: 10000 },
    );
    return output
      .trim()
      .split("\n")
      .filter((s) => s.length > 0)
      .map((line) => {
        const [name, att] = line.split(" ");
        return { name, attached: att !== "0" };
      });
  } catch {
    return [];
  }
}

// --- Terminal Tracking ---

/** Map from Terminal to pane UUID */
const terminalToPaneId = new Map<vscode.Terminal, string>();
/** Map from pane UUID to Terminal */
const paneIdToTerminal = new Map<string, vscode.Terminal>();

function generatePaneId(): string {
  return crypto.randomUUID();
}

/**
 * Find the viewColumn for a terminal by scanning tab groups.
 * Returns 0 if not found (terminal might be in panel or not yet visible).
 */
function getTerminalViewColumn(terminal: vscode.Terminal): number {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (
        tab.input instanceof vscode.TabInputTerminal &&
        tab.label === terminal.name
      ) {
        return group.viewColumn;
      }
    }
  }
  return 0;
}

/**
 * Update the viewColumn for a tracked terminal in the mapping.
 */
function updatePaneViewColumn(terminal: vscode.Terminal): void {
  const paneId = terminalToPaneId.get(terminal);
  if (!paneId || !mapping.panes[paneId]) {
    return;
  }
  const vc = getTerminalViewColumn(terminal);
  if (vc > 0 && mapping.panes[paneId].viewColumn !== vc) {
    mapping.panes[paneId].viewColumn = vc;
    persistMapping(mapping, mappingFilePath);
  }
}

// --- Extension Core ---

let mappingFilePath: string;
let mapping: MappingFile;
let instanceId: string;

function savePaneToMapping(
  paneId: string,
  name: string,
  viewColumn: number,
): void {
  mapping.panes[paneId] = {
    tmuxSession: "", // filled by host-bash via cs-tmux-window
    name,
    viewColumn,
    cwd: "",
  };
  persistMapping(mapping, mappingFilePath);
}

/**
 * Look up the tmux session name for a pane via cs-tmux-window resolve.
 * The extension's own mapping file does not know the session name
 * (host-bash chooses it); cs-tmux-window maintains the pane→session
 * mapping on the host. Returns null if no mapping or SSH failure.
 */
function resolveSession(paneId: string): string | null {
  try {
    const sshDest = `${process.env.HOST_USER}@host.docker.internal`;
    const shrc = ". ~/.shrc 2>/dev/null || true; ";
    const out = execSync(
      `ssh -o ConnectTimeout=5 -o BatchMode=yes ${sshDest} ` +
        `"${shrc}cs-tmux-window resolve '${instanceId}' '${paneId}'"`,
      { encoding: "utf-8", timeout: 10000 },
    ).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function removePaneFromMapping(paneId: string): void {
  delete mapping.panes[paneId];
  persistMapping(mapping, mappingFilePath);
}

/**
 * Determine which tmux session a VS Code terminal is viewing.
 * Checks creationOptions.env.TMUX_SESSION first (set at creation by
 * createTerminalForPane / createTerminalForSession and survives
 * restore), falls back to resolving via TMUX_PANE_ID through
 * cs-tmux-window (for profile-provider terminals where host-bash
 * picked the session at runtime).
 */
function terminalSession(terminal: vscode.Terminal): string | null {
  const opts = terminal.creationOptions;
  if (!("env" in opts) || !opts.env || typeof opts.env !== "object") {
    return null;
  }
  const env = opts.env as Record<string, string>;
  if (env.TMUX_SESSION) return env.TMUX_SESSION;
  if (env.TMUX_PANE_ID) {
    return resolveSession(env.TMUX_PANE_ID);
  }
  return null;
}

/**
 * Count how many live VS Code terminals are viewing a given tmux
 * session, excluding an optional terminal (used in close handlers
 * to count the remaining terminals after this one closes).
 */
function countTerminalsOnSession(
  session: string,
  exclude?: vscode.Terminal,
): number {
  let count = 0;
  for (const terminal of vscode.window.terminals) {
    if (terminal === exclude) continue;
    if (terminalSession(terminal) === session) count++;
  }
  return count;
}

function killTmuxSession(tmuxSession: string): void {
  try {
    const sshDest = `${process.env.HOST_USER}@host.docker.internal`;
    const shrc = ". ~/.shrc 2>/dev/null || true; ";
    execSync(
      `ssh -o ConnectTimeout=5 -o BatchMode=yes ${sshDest} ` +
        `"${shrc}tmux kill-session -t '${tmuxSession}'"`,
      { encoding: "utf-8", timeout: 10000 },
    );
    debugChannel.appendLine(
      `[${new Date().toISOString()}] killed tmux session: ${tmuxSession}`,
    );
  } catch (e) {
    debugChannel.appendLine(
      `[${new Date().toISOString()}] killTmuxSession failed for ` +
        `${tmuxSession}: ${(e as Error).message}`,
    );
  }
}

/**
 * Create a terminal that attaches to an existing tmux session.
 * Passes TMUX_SESSION directly to host-bash (bypasses cs-tmux-window).
 * Used for adopting unmapped sessions during reconciliation.
 */
function createTerminalForSession(tmuxSession: string): vscode.Terminal {
  const paneId = generatePaneId();
  const paneInfo: PaneMapping = {
    tmuxSession,
    name: "Host Shell (tmux)",
    viewColumn: 1,
    cwd: "",
  };
  mapping.panes[paneId] = paneInfo;
  persistMapping(mapping, mappingFilePath);

  const terminal = vscode.window.createTerminal({
    name: "Host Shell (tmux)",
    shellPath: "/usr/local/bin/host-bash",
    env: { TMUX_SESSION: tmuxSession, TMUX_PANE_ID: paneId },
    location: vscode.TerminalLocation.Editor,
  });
  terminalToPaneId.set(terminal, paneId);
  paneIdToTerminal.set(paneId, terminal);
  return terminal;
}

/**
 * Dispose the given terminal if another terminal is already viewing
 * the same tmux session. Returns true if disposed.
 *
 * Called per-terminal from onDidOpenTerminal and from the initial
 * activate() scan for already-restored terminals. Enforces the
 * invariant "at most one VS Code terminal per live tmux session"
 * without needing batch reconciliation or debouncing.
 */
function disposeIfDuplicate(terminal: vscode.Terminal): boolean {
  const session = terminalSession(terminal);
  if (!session) return false;
  for (const other of vscode.window.terminals) {
    if (other === terminal) continue;
    if (terminalSession(other) === session) {
      debugChannel.appendLine(
        `[${new Date().toISOString()}] dispose duplicate terminal for ` +
          `session ${session} (another terminal already viewing it)`,
      );
      terminal.dispose();
      return true;
    }
  }
  return false;
}

/**
 * Adopt tmux sessions that are live but have no VS Code terminal
 * viewing them. Called periodically (every 30s) to surface orphans.
 */
function adoptOrphans(): number {
  const liveSessions = listTmuxSessions(instanceId);
  const terminals = vscode.window.terminals;

  const covered = new Set<string>();
  for (const t of terminals) {
    const s = terminalSession(t);
    if (s) covered.add(s);
  }

  let adopted = 0;
  for (const session of liveSessions) {
    if (covered.has(session.name)) continue;
    debugChannel.appendLine(
      `[${new Date().toISOString()}] adopting orphan session: ${session.name}`,
    );
    createTerminalForSession(session.name);
    adopted++;
  }
  return adopted;
}

/**
 * Find an unattached tmux session for this instance, to be used by
 * the profile provider during a restore to reattach rather than
 * create a new session. Returns null if all are attached.
 */
function findUnattachedSession(): string | null {
  const live = listTmuxSessions(instanceId);
  for (const s of live) {
    if (!s.attached) return s.name;
  }
  return null;
}

// --- Activation ---

let debugChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  debugChannel = vscode.window.createOutputChannel("tmux Session Manager");
  context.subscriptions.push(debugChannel);
  debugChannel.appendLine(
    `[${new Date().toISOString()}] activate() — extension loaded`,
  );
  instanceId = getInstanceId();
  const storageUri = context.storageUri;

  if (storageUri) {
    mappingFilePath = getMappingPath(storageUri);
    mapping =
      loadMapping(mappingFilePath) ?? createEmptyMapping(instanceId);

    // Ensure mapping instanceId matches (container may have been recreated)
    if (mapping.instanceId !== instanceId) {
      mapping = createEmptyMapping(instanceId);
      persistMapping(mapping, mappingFilePath);
    }
  } else {
    console.warn(
      "[tmux-session-manager] No storage URI — mapping persistence disabled",
    );
    mapping = createEmptyMapping(instanceId);
  }

  console.log(
    `[tmux-session-manager] Activated for instance ${instanceId.slice(0, 12)}...`,
  );

  // Register terminal profile provider. code-server invokes this
  // both for explicit user-created terminals AND during restore of
  // previously-opened terminals. Naive behavior (always generate a
  // fresh paneId) forces host-bash into attach-or-create, which
  // creates a NEW tmux session on every restore. Intercept by
  // reusing unattached sessions when available.
  const profileProvider: vscode.TerminalProfileProvider = {
    provideTerminalProfile(): vscode.ProviderResult<vscode.TerminalProfile> {
      const reusable = findUnattachedSession();
      if (reusable) {
        debugChannel.appendLine(
          `[${new Date().toISOString()}] profile provider: reusing ` +
            `unattached session ${reusable}`,
        );
        const paneId = generatePaneId();
        savePaneToMapping(paneId, "Host Shell (tmux)", 1);
        return new vscode.TerminalProfile({
          name: "Host Shell (tmux)",
          shellPath: "/usr/local/bin/host-bash",
          env: { TMUX_PANE_ID: paneId, TMUX_SESSION: reusable },
          location: vscode.TerminalLocation.Editor,
        });
      }

      // No unattached session to reuse — fresh paneId, host-bash
      // will run cs-tmux-window grab/attach-or-create.
      const paneId = generatePaneId();
      savePaneToMapping(paneId, "Host Shell (tmux)", 1);
      debugChannel.appendLine(
        `[${new Date().toISOString()}] profile provider: fresh paneId ` +
          `${paneId} (no unattached session available)`,
      );
      return new vscode.TerminalProfile({
        name: "Host Shell (tmux)",
        shellPath: "/usr/local/bin/host-bash",
        env: { TMUX_PANE_ID: paneId },
        location: vscode.TerminalLocation.Editor,
      });
    },
  };

  context.subscriptions.push(
    vscode.window.registerTerminalProfileProvider(
      "tmuxSessionManager.hostShell",
      profileProvider,
    ),
  );

  // Track terminal opens. Two jobs:
  // 1. Register the terminal's paneId in our in-memory maps so
  //    onDidCloseTerminal can find the pane later.
  // 2. Enforce "at most one VS Code terminal per tmux session" by
  //    disposing the new terminal if another is already viewing
  //    the same session.
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal((terminal) => {
      const opts = terminal.creationOptions;
      const hasEnv =
        "env" in opts && opts.env && typeof opts.env === "object";
      const env = hasEnv ? (opts.env as Record<string, string>) : {};
      const envPaneId = env.TMUX_PANE_ID;
      const envSession = env.TMUX_SESSION;

      debugChannel.appendLine(
        `[${new Date().toISOString()}] onDidOpenTerminal ` +
          `name=${terminal.name} paneId=${envPaneId ?? "-"} ` +
          `session=${envSession ?? "-"}`,
      );

      if (envPaneId && !terminalToPaneId.has(terminal)) {
        terminalToPaneId.set(terminal, envPaneId);
        paneIdToTerminal.set(envPaneId, terminal);
      }

      // Dedup against existing terminals on the same session.
      disposeIfDuplicate(terminal);
    }),
  );

  // Track terminal closes
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => {
      const paneId = terminalToPaneId.get(terminal);
      const reason = terminal.exitStatus?.reason;
      const reasonName =
        reason === vscode.TerminalExitReason.Unknown
          ? "Unknown"
          : reason === vscode.TerminalExitReason.Shutdown
            ? "Shutdown"
            : reason === vscode.TerminalExitReason.Process
              ? "Process"
              : reason === vscode.TerminalExitReason.User
                ? "User"
                : reason === vscode.TerminalExitReason.Extension
                  ? "Extension"
                  : `raw(${String(reason)})`;

      // Identify the session this terminal was viewing before we
      // unlink bookkeeping (terminalSession may fall back to
      // resolveSession via TMUX_PANE_ID in creationOptions).
      const session = terminalSession(terminal);

      const msg =
        `[${new Date().toISOString()}] onDidCloseTerminal ` +
        `name=${terminal.name} paneId=${paneId ?? "-"} ` +
        `session=${session ?? "-"} reason=${reasonName}`;
      debugChannel.appendLine(msg);

      if (paneId) {
        terminalToPaneId.delete(terminal);
        paneIdToTerminal.delete(paneId);
      }

      // On shutdown, preserve state for reconnection on next launch.
      // For all other close reasons, decide whether to kill the tmux
      // session based on whether any other VS Code terminal is still
      // viewing it (refcount guard).
      if (reason === vscode.TerminalExitReason.Shutdown) {
        return;
      }

      if (paneId) removePaneFromMapping(paneId);

      if (!session) return;

      const remaining = countTerminalsOnSession(session, terminal);
      if (remaining > 0) {
        debugChannel.appendLine(
          `[${new Date().toISOString()}] not killing ${session}: ` +
            `${remaining} other terminal(s) still viewing it`,
        );
        return;
      }

      killTmuxSession(session);
    }),
  );

  // Track viewColumn changes — update mapping when terminals move
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTerminal((terminal) => {
      if (terminal) {
        // Delay slightly — tab group info may not be updated yet
        setTimeout(() => updatePaneViewColumn(terminal), 200);
      }
    }),
  );

  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabGroups(() => {
      // A tab was moved/split — update viewColumn for all tracked terminals
      for (const [terminal] of terminalToPaneId) {
        updatePaneViewColumn(terminal);
      }
    }),
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "tmuxSessionManager.reconnectAll",
      () => {
        // Manual full pass: dedup existing + adopt orphans.
        let disposed = 0;
        for (const t of vscode.window.terminals) {
          if (disposeIfDuplicate(t)) disposed++;
        }
        const adopted = adoptOrphans();
        vscode.window.showInformationMessage(
          `tmux: ${adopted} adopted, ${disposed} duplicates disposed`,
        );
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "tmuxSessionManager.showSessions",
      () => {
        const sessions = listTmuxSessions(instanceId);
        const terminals = vscode.window.terminals;
        const sessionToCount = new Map<string, number>();
        for (const t of terminals) {
          const s = terminalSession(t);
          if (s) sessionToCount.set(s, (sessionToCount.get(s) || 0) + 1);
        }
        const duplicates = Array.from(sessionToCount.values()).filter(
          (c) => c > 1,
        ).length;
        const unmapped = sessions.filter(
          (s) => !sessionToCount.has(s.name),
        ).length;
        vscode.window.showInformationMessage(
          `tmux: ${sessions.length} session(s), ` +
            `${terminals.length} terminal(s), ` +
            `${duplicates} duplicate session(s), ` +
            `${unmapped} unmapped`,
        );
      },
    ),
  );

  // Initial scan: terminals already in vscode.window.terminals at
  // activation time never fire onDidOpenTerminal, so dedup them
  // synchronously here.
  for (const terminal of vscode.window.terminals) {
    const opts = terminal.creationOptions;
    if ("env" in opts && opts.env && typeof opts.env === "object") {
      const env = opts.env as Record<string, string>;
      if (env.TMUX_PANE_ID && !terminalToPaneId.has(terminal)) {
        terminalToPaneId.set(terminal, env.TMUX_PANE_ID);
        paneIdToTerminal.set(env.TMUX_PANE_ID, terminal);
      }
    }
    disposeIfDuplicate(terminal);
  }

  // Periodic adoption of orphan sessions (sessions with no VS Code
  // viewer). Independent of terminal events; 30s is fine.
  const adoptInterval = setInterval(() => {
    try {
      adoptOrphans();
    } catch {
      // Ignore errors in periodic check
    }
  }, 30000);

  context.subscriptions.push({
    dispose: () => clearInterval(adoptInterval),
  });
}

export function deactivate(): void {
  // NOTE: This is NOT called on browser tab close in code-server.
  // All state persistence happens synchronously on each mutation.
}
