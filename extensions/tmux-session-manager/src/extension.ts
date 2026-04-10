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

/**
 * Convert a saved viewColumn number to a TerminalEditorLocationOptions.
 * ViewColumn values: 1=One, 2=Two, 3=Three, etc.
 */
function viewColumnToLocation(
  viewColumn: number,
): vscode.TerminalEditorLocationOptions {
  // vscode.ViewColumn enum: 1=One, 2=Two, 3=Three, ...
  return { viewColumn: viewColumn as vscode.ViewColumn };
}

function createTerminalForPane(
  paneId: string,
  paneInfo: PaneMapping,
): vscode.Terminal {
  // If we know the tmux session, pass it directly for fast reattach.
  // Otherwise fall back to TMUX_PANE_ID lookup via cs-tmux-window.
  const env: Record<string, string> = { TMUX_PANE_ID: paneId };
  if (paneInfo.tmuxSession) {
    env.TMUX_SESSION = paneInfo.tmuxSession;
  }
  const location =
    paneInfo.viewColumn > 0
      ? viewColumnToLocation(paneInfo.viewColumn)
      : vscode.TerminalLocation.Editor;
  const terminal = vscode.window.createTerminal({
    name: paneInfo.name || "Host Shell (tmux)",
    shellPath: "/usr/local/bin/host-bash",
    env,
    location,
  });
  terminalToPaneId.set(terminal, paneId);
  paneIdToTerminal.set(paneId, terminal);
  return terminal;
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

  // Resolve the session name via the host-side mapping and kill it.
  // Cannot rely on paneInfo.tmuxSession — it is never populated
  // because host-bash chooses the session via cs-tmux-window without
  // informing the extension.
  const session = resolveSession(paneId);
  if (session) {
    killTmuxSession(session);
  } else {
    debugChannel.appendLine(
      `[${new Date().toISOString()}] removePaneFromMapping: ` +
        `no host-side session for pane ${paneId}`,
    );
  }
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
 * Reconnect mapped panes to their tmux sessions.
 * Called automatically on activation.
 * Only handles panes the extension previously tracked — does NOT
 * adopt unmapped sessions (use reconnectAll for that).
 */
async function reconnectMapped(): Promise<number> {
  const liveSessions = listTmuxSessions(instanceId);
  const liveSessionNames = new Set(liveSessions.map((s) => s.name));
  const liveTerminals = vscode.window.terminals;

  console.log(
    `[tmux-session-manager] Reconnecting mapped panes: ` +
      `${liveSessions.length} tmux sessions, ` +
      `${Object.keys(mapping.panes).length} mapped panes, ` +
      `${liveTerminals.length} VS Code terminals`,
  );

  // Index existing terminals by their TMUX_PANE_ID
  const existingPaneIds = new Set<string>();
  for (const terminal of liveTerminals) {
    const paneId = terminalToPaneId.get(terminal);
    if (paneId) {
      existingPaneIds.add(paneId);
    }
  }

  let reconnected = 0;
  for (const [paneId, paneInfo] of Object.entries(mapping.panes)) {
    // Skip if terminal already exists in VS Code
    if (existingPaneIds.has(paneId)) {
      continue;
    }

    // Resolve session name via cs-tmux-window (paneInfo.tmuxSession
    // is a legacy field that was never populated). Fall back to any
    // legacy value if resolve fails.
    const sessionName =
      resolveSession(paneId) || paneInfo.tmuxSession || "";

    if (!sessionName || !liveSessionNames.has(sessionName)) {
      // tmux session gone — clean up mapping
      delete mapping.panes[paneId];
      persistMapping(mapping, mappingFilePath);
      continue;
    }

    // Cache the resolved name so createTerminalForPane can pass it
    // directly to host-bash for fast reattach
    paneInfo.tmuxSession = sessionName;
    persistMapping(mapping, mappingFilePath);

    debugChannel.appendLine(
      `[${new Date().toISOString()}] reconnecting pane ${paneId} ` +
        `to ${sessionName}`,
    );
    createTerminalForPane(paneId, paneInfo);
    reconnected++;
  }
  return reconnected;
}

/**
 * Adopt tmux sessions that are not tracked by the extension.
 *
 * A session is adoptable if the extension has no pane mapped to it,
 * regardless of whether it's "attached" in tmux. Zombie host-bash
 * reconnect loops (from before the pane-close fix) keep sessions
 * marked "attached" even though no VS Code terminal exists. These
 * are safe to adopt: tmux allows multiple clients, and the zombie's
 * output goes nowhere (its original PTY is dead).
 */
function adoptUnmappedSessions(): number {
  const liveSessions = listTmuxSessions(instanceId);
  const mappedSessions = new Set(
    Object.values(mapping.panes)
      .map((p) => p.tmuxSession)
      .filter((s) => s),
  );

  let adopted = 0;
  for (const session of liveSessions) {
    if (mappedSessions.has(session.name)) {
      continue;
    }
    debugChannel.appendLine(
      `[${new Date().toISOString()}] adopting session: ${session.name} ` +
        `(attached=${session.attached})`,
    );
    createTerminalForSession(session.name);
    adopted++;
  }
  return adopted;
}

async function reconnectAll(): Promise<number> {
  const reconnected = await reconnectMapped();
  const adopted = adoptUnmappedSessions();
  return reconnected + adopted;
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
      const code = terminal.exitStatus?.code;

      // Instrumentation for tmux-leak investigation: log every close
      // with its exit reason so we can see what code-server emits on
      // tab-X close, browser reload, etc. Remove once H1 is confirmed
      // or ruled out. Reason values: 0=Unknown, 1=Shutdown, 2=Process,
      // 3=User, 4=Extension.
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
      const msg =
        `[${new Date().toISOString()}] onDidCloseTerminal ` +
        `name=${terminal.name} tracked=${paneId ? "yes" : "no"} ` +
        `paneId=${paneId ?? "-"} reason=${reasonName} code=${code ?? "-"}`;
      console.log(`[tmux-session-manager] ${msg}`);
      debugChannel.appendLine(msg);

      if (!paneId) {
        return;
      }

      terminalToPaneId.delete(terminal);
      paneIdToTerminal.delete(paneId);

      // User closed or process exited normally — remove mapping
      if (
        reason === vscode.TerminalExitReason.User ||
        reason === vscode.TerminalExitReason.Process
      ) {
        removePaneFromMapping(paneId);
      }
      // On shutdown/unknown, keep the mapping for reconnection
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
      async () => {
        const count = await reconnectAll();
        vscode.window.showInformationMessage(
          `tmux: Reconnected ${count} terminal(s)`,
        );
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "tmuxSessionManager.showSessions",
      () => {
        const sessions = listTmuxSessions(instanceId);
        const paneCount = Object.keys(mapping.panes).length;
        const unattached = sessions.filter((s) => !s.attached);
        const unmapped = sessions.filter(
          (s) =>
            !Object.values(mapping.panes).some(
              (p) => p.tmuxSession === s.name,
            ),
        );
        vscode.window.showInformationMessage(
          `tmux: ${sessions.length} session(s), ` +
            `${paneCount} mapped, ` +
            `${unattached.length} unattached, ` +
            `${unmapped.length} unmapped`,
        );
      },
    ),
  );

  // On activation, reconnect mapped panes + adopt unattached sessions.
  reconnectAll().catch((err) => {
    console.error("[tmux-session-manager] Reconnection failed:", err);
  });

  // Periodically adopt unmapped sessions (every 30s).
  // Sessions become unmapped when: extension mapping is wiped by old code,
  // user closes a pane (trap doesn't kill), container restarts, or browser
  // reloads. Auto-adopting makes them visible so the user can decide to
  // keep or 'exit' them.
  const adoptInterval = setInterval(() => {
    try {
      adoptUnmappedSessions();
    } catch {
      // Ignore errors in periodic check
    }
  }, 30000);

  context.subscriptions.push({ dispose: () => clearInterval(adoptInterval) });
}

export function deactivate(): void {
  // NOTE: This is NOT called on browser tab close in code-server.
  // All state persistence happens synchronously on each mutation.
}
