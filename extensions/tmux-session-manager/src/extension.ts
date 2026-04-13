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
 * Reconcile VS Code terminals with live tmux sessions. Source of
 * truth: vscode.window.terminals. Invariant enforced:
 *
 *   At most one VS Code terminal per live tmux session.
 *
 * - Duplicate terminals on the same session: dispose excess,
 *   keeping the first (which triggers onDidCloseTerminal; the
 *   refcount guard there prevents killing the session).
 * - Live tmux sessions with no VS Code terminal: adopt.
 *
 * Called on activation (after a short delay to let code-server
 * surface restored terminals) and every 30s.
 */
function reconcile(): { adopted: number; disposed: number } {
  const liveSessions = listTmuxSessions(instanceId);
  const liveSessionNames = new Set(liveSessions.map((s) => s.name));
  const terminals = vscode.window.terminals;

  // Group terminals by session name. Terminals not on any of our
  // sessions are ignored (plain bash, other extensions' terminals).
  const bySession = new Map<string, vscode.Terminal[]>();
  let untracked = 0;
  for (const terminal of terminals) {
    const session = terminalSession(terminal);
    if (!session) {
      untracked++;
      continue;
    }
    // Only care about sessions for THIS instance's live list —
    // terminals pointing to dead sessions will exit naturally.
    if (!liveSessionNames.has(session)) continue;
    const list = bySession.get(session) || [];
    list.push(terminal);
    bySession.set(session, list);
  }

  debugChannel.appendLine(
    `[${new Date().toISOString()}] reconcile: ` +
      `${liveSessions.length} live sessions, ${terminals.length} terminals ` +
      `(${untracked} not host-shell), ${bySession.size} sessions covered`,
  );
  for (const [session, list] of bySession) {
    debugChannel.appendLine(
      `  session ${session}: ${list.length} terminal(s)`,
    );
  }

  // Dispose duplicates. Prefer keeping a terminal that is tracked
  // in the current mapping (if any); otherwise keep the first.
  let disposed = 0;
  for (const [session, list] of bySession) {
    if (list.length <= 1) continue;
    // Prefer terminal whose paneId is in our current mapping
    let keepIdx = list.findIndex((t) => {
      const pid = terminalToPaneId.get(t);
      return pid !== undefined && mapping.panes[pid] !== undefined;
    });
    if (keepIdx < 0) keepIdx = 0;
    for (let i = 0; i < list.length; i++) {
      if (i === keepIdx) continue;
      debugChannel.appendLine(
        `[${new Date().toISOString()}] disposing duplicate terminal ` +
          `for session ${session} (keeping index ${keepIdx})`,
      );
      list[i].dispose();
      disposed++;
    }
  }

  // Adopt sessions with no terminal.
  let adopted = 0;
  for (const session of liveSessions) {
    if (bySession.has(session.name)) continue;
    debugChannel.appendLine(
      `[${new Date().toISOString()}] adopting session: ${session.name} ` +
        `(attached=${session.attached})`,
    );
    createTerminalForSession(session.name);
    adopted++;
  }

  return { adopted, disposed };
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

  // Register terminal profile provider (must happen regardless of storage)
  const profileProvider: vscode.TerminalProfileProvider = {
    provideTerminalProfile(): vscode.ProviderResult<vscode.TerminalProfile> {
      const paneId = generatePaneId();
      savePaneToMapping(paneId, "Host Shell (tmux)", 1);

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

  // Track terminal opens
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal((terminal) => {
      const opts0 = terminal.creationOptions;
      const hasEnv =
        "env" in opts0 && opts0.env && typeof opts0.env === "object";
      const envPaneId = hasEnv
        ? (opts0.env as Record<string, string>).TMUX_PANE_ID
        : undefined;
      debugChannel.appendLine(
        `[${new Date().toISOString()}] onDidOpenTerminal ` +
          `name=${terminal.name} preTracked=${terminalToPaneId.has(terminal)} ` +
          `envPaneId=${envPaneId ?? "-"}`,
      );

      // If this terminal was created by us, it's already tracked.
      if (terminalToPaneId.has(terminal)) {
        return;
      }

      // Check if the terminal's creation options have our env var.
      // This handles terminals created via the profile provider.
      const opts = terminal.creationOptions;
      if (
        "env" in opts &&
        opts.env &&
        typeof opts.env === "object" &&
        "TMUX_PANE_ID" in opts.env
      ) {
        const paneId = (opts.env as Record<string, string>).TMUX_PANE_ID;
        if (paneId) {
          terminalToPaneId.set(terminal, paneId);
          paneIdToTerminal.set(paneId, terminal);
          return;
        }
      }

      // Terminal not created by us — assign a pane ID retroactively.
      // We can inject env via sendText, but the shell already started
      // without TMUX_PANE_ID, so it created an unmapped tmux session.
      // Track it but don't try to map it.
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
        const { adopted, disposed } = reconcile();
        vscode.window.showInformationMessage(
          `tmux: reconcile — ${adopted} adopted, ${disposed} disposed`,
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

  // Debounced reconcile driven by terminal activity. We can't rely
  // on a single fixed-delay initial reconcile because code-server
  // may surface restored terminals over a longer and variable time
  // window. Every onDidOpenTerminal resets a 1.5s timer; once no
  // new terminal has appeared for that long, we reconcile. This
  // lets all restored terminals settle into
  // vscode.window.terminals before reconcile groups by session.
  let reconcileTimer: NodeJS.Timeout | null = null;
  const scheduleReconcile = (delay: number): void => {
    if (reconcileTimer) clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(() => {
      reconcileTimer = null;
      try {
        reconcile();
      } catch (err) {
        console.error("[tmux-session-manager] reconcile failed:", err);
      }
    }, delay);
  };

  context.subscriptions.push(
    vscode.window.onDidOpenTerminal(() => scheduleReconcile(1500)),
  );

  // Kick off an initial reconcile; also safety-net even if no
  // onDidOpenTerminal fires (no restored terminals).
  scheduleReconcile(1500);

  // Periodic reconcile: dispose duplicates, adopt orphans.
  const reconcileInterval = setInterval(() => {
    try {
      reconcile();
    } catch {
      // Ignore errors in periodic check
    }
  }, 30000);

  context.subscriptions.push({
    dispose: () => {
      if (reconcileTimer) clearTimeout(reconcileTimer);
      clearInterval(reconcileInterval);
    },
  });
}

export function deactivate(): void {
  // NOTE: This is NOT called on browser tab close in code-server.
  // All state persistence happens synchronously on each mutation.
}
