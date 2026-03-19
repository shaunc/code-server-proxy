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
  const terminal = vscode.window.createTerminal({
    name: paneInfo.name || "Host Shell (tmux)",
    shellPath: "/usr/local/bin/host-bash",
    env,
    location: vscode.TerminalLocation.Editor,
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

function removePaneFromMapping(paneId: string): void {
  const paneInfo = mapping.panes[paneId];
  delete mapping.panes[paneId];
  persistMapping(mapping, mappingFilePath);

  // Kill the tmux session on the host so it doesn't get re-adopted
  if (paneInfo?.tmuxSession) {
    killTmuxSession(paneInfo.tmuxSession);
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
    console.log(
      `[tmux-session-manager] Killed tmux session: ${tmuxSession}`,
    );
  } catch {
    // Session may already be gone
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

    // Check if the tmux session is still alive
    if (!liveSessionNames.has(paneInfo.tmuxSession)) {
      // tmux session gone — clean up mapping
      delete mapping.panes[paneId];
      persistMapping(mapping, mappingFilePath);
      continue;
    }

    // tmux session alive but no VS Code terminal — recreate
    console.log(
      `[tmux-session-manager] Reconnecting to ${paneInfo.tmuxSession}`,
    );
    createTerminalForPane(paneId, paneInfo);
    reconnected++;
  }
  return reconnected;
}

/**
 * Adopt unattached, unmapped tmux sessions.
 * Only adopts sessions that are NOT already attached (host-bash's
 * grab already reconnected attached ones on reload).
 */
async function reconnectAll(): Promise<number> {
  // First reconnect mapped panes
  const reconnected = await reconnectMapped();

  // Then adopt unmapped AND unattached sessions only.
  // Attached sessions were already grabbed by host-bash on reload —
  // don't create duplicate terminals for them.
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
    if (session.attached) {
      // Already attached by a code-server terminal via grab
      continue;
    }
    console.log(
      `[tmux-session-manager] Adopting unmapped session: ${session.name}`,
    );
    createTerminalForSession(session.name);
    adopted++;
  }
  return reconnected + adopted;
}

// --- Activation ---

export function activate(context: vscode.ExtensionContext): void {
  instanceId = getInstanceId();
  const storageUri = context.storageUri;

  if (!storageUri) {
    console.warn(
      "[tmux-session-manager] No storage URI — cannot persist mapping",
    );
    return;
  }

  mappingFilePath = getMappingPath(storageUri);
  mapping = loadMapping(mappingFilePath) ?? createEmptyMapping(instanceId);

  // Ensure mapping instanceId matches (container may have been recreated)
  if (mapping.instanceId !== instanceId) {
    mapping = createEmptyMapping(instanceId);
    persistMapping(mapping, mappingFilePath);
  }

  console.log(
    `[tmux-session-manager] Activated for instance ${instanceId.slice(0, 12)}...`,
  );

  // Register terminal profile provider
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
      if (!paneId) {
        return;
      }

      terminalToPaneId.delete(terminal);
      paneIdToTerminal.delete(paneId);

      const reason = terminal.exitStatus?.reason;

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

  // On activation, only reconnect previously-mapped panes.
  // Unmapped sessions are left alone (use "Reconnect All" to adopt).
  reconnectMapped().catch((err) => {
    console.error("[tmux-session-manager] Reconnection failed:", err);
  });
}

export function deactivate(): void {
  // NOTE: This is NOT called on browser tab close in code-server.
  // All state persistence happens synchronously on each mutation.
}
