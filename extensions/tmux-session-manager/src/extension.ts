import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execFile, execFileSync } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// --- SSH-to-host helpers ---
//
// The container's /bin/sh is an auto-SSH forwarding wrapper
// (docker/code-server/root/bin/sh-host-wrapper). Any command node runs
// via a *shell string* (execSync / execFile with a shell) is seen by
// that wrapper — and when VSCODE_CWD is set (ext-host context) the
// wrapper FORWARDS the whole command to the host. So a shell-string
// `ssh host.docker.internal ...` would itself run on the host, where
// host.docker.internal does not resolve. We therefore invoke ssh
// *directly* via execFile/execFileSync (argv, no shell) so no wrapper
// is involved. Only the LOCAL invocation must avoid /bin/sh; the
// remote-command string (last argv element) still runs under a remote
// shell, which is fine.

const SSH_TIMEOUT_MS = 10000;

/** Fixed ssh options shared by every host call. */
function sshArgs(remoteCommand: string): string[] {
  const sshDest = `${process.env.HOST_USER}@host.docker.internal`;
  return [
    "-o",
    "ConnectTimeout=5",
    "-o",
    "BatchMode=yes",
    sshDest,
    remoteCommand,
  ];
}

/**
 * Run a command on the host over ssh, shell-free (argv), async.
 * `remoteCommand` is the single remote-shell command string (it may
 * contain the `${shrc}` prefix and pipes — it runs under the remote
 * login shell that ssh spawns). Rejects on ssh/command failure.
 */
async function sshHost(remoteCommand: string): Promise<string> {
  const { stdout } = await execFileAsync("ssh", sshArgs(remoteCommand), {
    encoding: "utf-8",
    timeout: SSH_TIMEOUT_MS,
  });
  return stdout;
}

/**
 * Synchronous variant of sshHost for the few call sites that run in
 * genuinely synchronous contexts. Still shell-free (execFileSync), so
 * it also bypasses the /bin/sh forwarding wrapper (fixes 96b). Callers
 * are off the periodic timer path (see resolveSession / killTmuxSession
 * notes), so blocking here does not jank the ext-host adopt loop.
 */
function sshHostSync(remoteCommand: string): string {
  return execFileSync("ssh", sshArgs(remoteCommand), {
    encoding: "utf-8",
    timeout: SSH_TIMEOUT_MS,
  });
}

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

async function listTmuxSessions(
  instanceId: string,
): Promise<TmuxSessionInfo[]> {
  try {
    const shrc = ". ~/.shrc 2>/dev/null || true; ";
    const prefix = `cs-${instanceId}-`;
    const output = await sshHost(
      `${shrc}tmux list-sessions -F ` +
        `'#{session_name} #{session_attached}' 2>/dev/null` +
        ` | grep '^${prefix}'`,
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
 *
 * Kept SYNCHRONOUS (shell-free execFileSync, fixes 96b). Making it
 * async would ripple through its sync callers terminalSession /
 * sessionFromProcEnv and in turn countTerminalsOnSession and the
 * onDidClose/showSessions handlers — a large change for little gain:
 * on the periodic adopt path this is reached only via identifySession,
 * which memoizes results in sessionCache, so it runs at most once per
 * terminal lifetime (not once per 30s cycle). The recurring per-cycle
 * cost that 5ol targets lives in listTmuxSessions / resolveWindowName,
 * which ARE async.
 */
function resolveSession(paneId: string): string | null {
  try {
    const shrc = ". ~/.shrc 2>/dev/null || true; ";
    const out = sshHostSync(
      `${shrc}cs-tmux-window resolve '${instanceId}' '${paneId}'`,
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

// Cache of identified sessions per terminal. Once we know which tmux
// session a terminal is viewing, it doesn't change for that terminal's
// lifetime. WeakMap so closed terminals drop out automatically.
const sessionCache = new WeakMap<vscode.Terminal, string>();

/**
 * Read TMUX_SESSION or resolve TMUX_PANE_ID from /proc/<pid>/environ
 * for a preserved host-bash process. Needed because code-server
 * does NOT preserve creationOptions.env across extension host
 * restart — the only surviving place with that env is the process
 * itself.
 */
function sessionFromProcEnv(pid: number): string | null {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/environ`, "utf-8");
    const entries = raw.split("\0");
    for (const e of entries) {
      if (e.startsWith("TMUX_SESSION=")) return e.slice(13);
    }
    for (const e of entries) {
      if (e.startsWith("TMUX_PANE_ID=")) {
        return resolveSession(e.slice(13));
      }
    }
  } catch {
    // /proc/<pid> may be gone or inaccessible
  }
  return null;
}

/**
 * Walk /proc to find host-bash's ssh child and extract the tmux
 * session name from its command line. Needed because host-bash
 * sets TMUX_SESSION internally at runtime (after cs-tmux-window
 * grab/attach-or-create), which does NOT appear in
 * /proc/<pid>/environ — that only shows the initial exec env.
 * The ssh child's cmdline is `ssh ... tmux attach-session -t
 * cs-<iid>-<N>`, which is our best runtime source of truth.
 */
function sessionFromSshChild(hostBashPid: number): string | null {
  try {
    const childrenRaw = fs.readFileSync(
      `/proc/${hostBashPid}/task/${hostBashPid}/children`,
      "utf-8",
    );
    const childPids = childrenRaw.trim().split(/\s+/).filter(Boolean);
    for (const childPid of childPids) {
      try {
        const cmd = fs.readFileSync(
          `/proc/${childPid}/cmdline`,
          "utf-8",
        );
        // host-bash invokes ssh as:
        //   ssh -t ... HOST "tmux attach-session -t 'SESSION'"
        // The remote-command string is ONE argv entry containing
        // spaces and quotes — not multiple null-delimited args. We
        // must match across the whole string.
        const parts = cmd.split("\0");
        for (const arg of parts) {
          const m = arg.match(/attach-session\s+-t\s+'([^']+)'/);
          if (m && m[1].startsWith("cs-")) return m[1];
        }
      } catch {
        // child may have exited between listing and reading
      }
    }
  } catch {
    // hostBashPid may have exited, or /children not accessible
  }
  return null;
}

/**
 * Identify a terminal's tmux session. Cached per-terminal.
 * Order of attempts:
 *   1. sessionCache (fast path)
 *   2. terminal.creationOptions.env — works for terminals created
 *      in this extension-host lifetime (env preserved in-memory)
 *   3. /proc/<pid>/environ — works for restored terminals whose
 *      initial exec env was set via VS Code's createTerminal env.
 *   4. ssh child cmdline — required for terminals whose initial env
 *      was NOT set (e.g. spawned by another extension or external
 *      mechanism). host-bash determines session via grab at runtime
 *      and runs `ssh ... tmux attach-session -t <session>`; the
 *      ssh process's cmdline is our runtime source of truth.
 * Returns null for terminals that are not running host-bash or
 * whose session can't be identified (e.g. container bash shells,
 * or host-bash that hasn't yet spawned its ssh child).
 */
async function identifySession(
  terminal: vscode.Terminal,
): Promise<string | null> {
  const cached = sessionCache.get(terminal);
  if (cached) return cached;

  const fromOpts = terminalSession(terminal);
  if (fromOpts) {
    sessionCache.set(terminal, fromOpts);
    return fromOpts;
  }

  try {
    const pid = await terminal.processId;
    if (pid) {
      const fromProc = sessionFromProcEnv(pid);
      if (fromProc) {
        sessionCache.set(terminal, fromProc);
        return fromProc;
      }
      const fromSsh = sessionFromSshChild(pid);
      if (fromSsh) {
        sessionCache.set(terminal, fromSsh);
        return fromSsh;
      }
    }
  } catch {
    // ignored — processId can throw if terminal exited
  }
  return null;
}

/**
 * Count live VS Code terminals on a given session, excluding one.
 * Uses the sessionCache populated by identifySession; un-identified
 * terminals (no cache entry and no env) are conservatively excluded.
 */
function countTerminalsOnSession(
  session: string,
  exclude?: vscode.Terminal,
): number {
  let count = 0;
  for (const terminal of vscode.window.terminals) {
    if (terminal === exclude) continue;
    const s = sessionCache.get(terminal) || terminalSession(terminal);
    if (s === session) count++;
  }
  return count;
}

// Kept SYNCHRONOUS (shell-free execFileSync, fixes 96b). Called only
// from the onDidCloseTerminal event handler (one-shot on user/process
// close), never from the periodic adopt timer, so it is off the path
// 5ol targets.
function killTmuxSession(tmuxSession: string): void {
  try {
    const shrc = ". ~/.shrc 2>/dev/null || true; ";
    sshHostSync(`${shrc}tmux kill-session -t '${tmuxSession}'`);
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

const DEFAULT_SESSION_NAME = "Host Shell (tmux)";

// Placement for every terminal we open in the editor area. We use an
// explicit TerminalEditorLocationOptions targeting ViewColumn.Active
// rather than the bare TerminalLocation.Editor enum. The bare enum lets
// code-server open the terminal *beside* the active editor (a split) when
// a non-terminal editor is focused — the operator saw new terminals land
// to the RIGHT of an open markdown file. ViewColumn.Active places the
// terminal in the currently active editor group instead of splitting.
// preserveFocus:true additionally stops timer-adopted terminals from
// stealing focus/scroll from whatever the user is reading.
const EDITOR_LOCATION: vscode.TerminalEditorLocationOptions = {
  viewColumn: vscode.ViewColumn.Active,
  preserveFocus: true,
};

// Default tmux window names that carry no teammate identity — they are
// just the shell tmux picked when the session was created without an
// explicit rename. cs-tab renames teammate windows to the teammate
// name (and automatic-rename is off in our tmux.conf, so it sticks);
// plain host-shell sessions keep one of these. Treat them as unnamed
// so adopted plain shells stay "Host Shell (tmux)" rather than "bash".
const UNNAMED_WINDOWS = new Set(["", "bash", "host-bash", "sh"]);

/**
 * Fetch the tmux window name for a session.
 *
 * Two paths, tried in order:
 *  1. Sidecar file at ~/.cs-tab-names/<session> (written by cs-tab on
 *     `new` / `adopt` — see ~/bin/cs-tab). This is the canonical
 *     mechanism: written once at session creation by the host script
 *     that knows the teammate name, persists across browser
 *     disconnects + container restarts, no SSH required. The host
 *     home dir is bind-mounted into the container at the same path so
 *     the extension can read it directly.
 *  2. SSH fallback (legacy path): query `tmux display-message #W`
 *     over SSH to host.docker.internal. Kept for backwards-compat
 *     with sessions created before the sidecar mechanism existed —
 *     and as a graceful fallback if the sidecar file is missing.
 *
 * Returns DEFAULT_SESSION_NAME when both paths fail or the resolved
 * name is in UNNAMED_WINDOWS.
 */
async function resolveWindowName(tmuxSession: string): Promise<string> {
  // Path 1: sidecar file. The container's HOME is /config (user "abc"),
  // not the host's /home/<HOST_USER>. The host home dir is visible
  // inside the container at /home/<HOST_USER>/ via the bind-mount, so
  // we construct the path from HOST_USER (already used for the SSH
  // fallback below) instead of HOME.
  try {
    const hostUser = process.env.HOST_USER ?? "shauncutts";
    const sidecarPath = `/home/${hostUser}/.cs-tab-names/${tmuxSession}`;
    if (fs.existsSync(sidecarPath)) {
      const name = fs.readFileSync(sidecarPath, "utf-8").trim();
      if (name && !UNNAMED_WINDOWS.has(name)) {
        return name;
      }
    }
  } catch {
    // Fall through to SSH path.
  }

  // Path 2: SSH fallback.
  try {
    const shrc = ". ~/.shrc 2>/dev/null || true; ";
    const out = (
      await sshHost(
        `${shrc}tmux display-message -p -t '${tmuxSession}' '#W'`,
      )
    ).trim();
    return UNNAMED_WINDOWS.has(out) ? DEFAULT_SESSION_NAME : out;
  } catch {
    return DEFAULT_SESSION_NAME;
  }
}

/**
 * Create a terminal that attaches to an existing tmux session.
 * Passes TMUX_SESSION directly to host-bash (bypasses cs-tmux-window).
 * Used for adopting unmapped sessions during reconciliation.
 */
async function createTerminalForSession(
  tmuxSession: string,
): Promise<vscode.Terminal> {
  const paneId = generatePaneId();
  const name = await resolveWindowName(tmuxSession);
  const paneInfo: PaneMapping = {
    tmuxSession,
    name,
    viewColumn: 1,
    cwd: "",
  };
  mapping.panes[paneId] = paneInfo;
  persistMapping(mapping, mappingFilePath);

  const terminal = vscode.window.createTerminal({
    name,
    shellPath: "/usr/local/bin/host-bash",
    env: { TMUX_SESSION: tmuxSession, TMUX_PANE_ID: paneId },
    location: EDITOR_LOCATION,
  });
  terminalToPaneId.set(terminal, paneId);
  paneIdToTerminal.set(paneId, terminal);
  return terminal;
}

// Tracks the current "keeper" terminal per tmux session. At most
// one entry per session; subsequent terminals that open on the
// same session are disposed rather than added here.
const sessionKeeper = new Map<string, vscode.Terminal>();

// Terminals created with hideFromUser:true are ephemeral — typically
// ms-python.python's env-discovery shells. host-bash still creates
// a tmux session for them, which then orphans when they exit. We
// unconditionally kill their tmux session on close so adoptOrphans
// doesn't surface them as visible tabs.
const ephemeralTerminals = new WeakSet<vscode.Terminal>();

/**
 * Claim a session for the given terminal, or dispose the terminal
 * if another already holds the session. This is the core dedup
 * primitive — "first terminal to claim a session wins, rest lose".
 *
 * Called from onDidOpenTerminal (per event) and from the initial
 * activation scan (in insertion order).
 */
async function claimOrDispose(
  terminal: vscode.Terminal,
): Promise<boolean> {
  const session = await identifySession(terminal);
  if (!session) return false;
  const existing = sessionKeeper.get(session);
  if (existing && existing !== terminal) {
    debugChannel.appendLine(
      `[${new Date().toISOString()}] dispose duplicate for ${session} ` +
        `(keeper already registered)`,
    );
    terminal.dispose();
    return true;
  }
  if (!existing) sessionKeeper.set(session, terminal);
  return false;
}

/**
 * Release a terminal's claim on its session, if it was the keeper.
 * Called from onDidCloseTerminal so the next open on that session
 * (e.g. from adoption) becomes the new keeper.
 */
function releaseSessionClaim(terminal: vscode.Terminal): void {
  const session = sessionCache.get(terminal);
  if (!session) return;
  if (sessionKeeper.get(session) === terminal) {
    sessionKeeper.delete(session);
  }
}

/**
 * True if some live VS Code terminal is already viewing `session`.
 * Scans vscode.window.terminals directly (via the identifySession
 * cache / creation env) so adoption cannot create a second terminal
 * for a session that already has one. This is the authoritative
 * "already covered" check — sessionKeeper alone is insufficient
 * because a keeper entry can be missing (identifySession returned
 * null when the terminal first opened, before its ssh child spawned)
 * even though the terminal is plainly present in window.terminals.
 */
function terminalExistsForSession(session: string): boolean {
  for (const terminal of vscode.window.terminals) {
    const s = sessionCache.get(terminal) ?? terminalSession(terminal);
    if (s === session) return true;
  }
  return false;
}

// Re-entrancy guard for adoptOrphans. The function awaits (ssh to the
// host, terminal.processId), so a second invocation — from the 30s
// interval overlapping a manual reconnectAll, or two rapid triggers —
// can start while the first is mid-flight. Without this guard, both
// runs read the same "uncovered" snapshot and each createTerminalForSession
// for the same orphan, producing duplicate editor tabs that then flash
// open and get disposed (observed live: session -28 adopted 3x in 15ms).
let adoptInFlight = false;

/**
 * Adopt tmux sessions that are live but have no VS Code terminal
 * viewing them. Called periodically (every 30s) to surface orphans.
 *
 * Idempotent and re-entrancy-safe: a session is adopted only if NO
 * live terminal is already viewing it (checked against
 * vscode.window.terminals, not just sessionKeeper), and concurrent
 * invocations are serialized via adoptInFlight so two runs cannot
 * both create a terminal for the same orphan.
 */
async function adoptOrphans(): Promise<number> {
  if (adoptInFlight) {
    debugChannel.appendLine(
      `[${new Date().toISOString()}] adoptOrphans: skipped (already running)`,
    );
    return 0;
  }
  adoptInFlight = true;
  try {
    // First prime keepers for any terminal that arrived without
    // firing onDidOpenTerminal (rare but possible). This is idempotent.
    for (const t of vscode.window.terminals) {
      const s = await identifySession(t);
      if (s && !sessionKeeper.has(s)) sessionKeeper.set(s, t);
    }

    const liveSessions = await listTmuxSessions(instanceId);
    debugChannel.appendLine(
      `[${new Date().toISOString()}] adoptOrphans: ` +
        `${liveSessions.length} live sessions, ` +
        `${vscode.window.terminals.length} terminals, ` +
        `${sessionKeeper.size} sessions covered`,
    );

    let adopted = 0;
    for (const session of liveSessions) {
      // Skip if a keeper is registered OR any open terminal is already
      // viewing this session. The window.terminals scan catches the
      // case where identifySession could not yet resolve the session
      // (so no keeper exists) but the terminal is plainly present —
      // preventing perpetual re-adoption of an already-open session.
      if (sessionKeeper.has(session.name)) continue;
      if (terminalExistsForSession(session.name)) continue;
      debugChannel.appendLine(
        `[${new Date().toISOString()}] adopting orphan session: ${session.name}`,
      );
      const terminal = await createTerminalForSession(session.name);
      // Eagerly register as keeper so subsequent adoptOrphans in the
      // same tick don't double-adopt while onDidOpenTerminal is
      // still pending.
      sessionCache.set(terminal, session.name);
      sessionKeeper.set(session.name, terminal);
      adopted++;
    }
    return adopted;
  } finally {
    adoptInFlight = false;
  }
}

/**
 * Find an unattached tmux session for this instance, to be used by
 * the profile provider during a restore to reattach rather than
 * create a new session. Returns null if all are attached.
 */
async function findUnattachedSession(): Promise<string | null> {
  const live = await listTmuxSessions(instanceId);
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
    async provideTerminalProfile(): Promise<vscode.TerminalProfile> {
      const reusable = await findUnattachedSession();
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
          location: EDITOR_LOCATION,
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
        location: EDITOR_LOCATION,
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

      const shellPath =
        "shellPath" in opts ? (opts.shellPath ?? "-") : "-";
      const hidden =
        "hideFromUser" in opts && opts.hideFromUser === true;
      if (hidden) ephemeralTerminals.add(terminal);
      debugChannel.appendLine(
        `[${new Date().toISOString()}] onDidOpenTerminal ` +
          `name="${terminal.name}" shell="${shellPath}" ` +
          `hidden=${hidden} ` +
          `paneId=${envPaneId ?? "-"} session=${envSession ?? "-"}`,
      );

      if (envPaneId && !terminalToPaneId.has(terminal)) {
        terminalToPaneId.set(terminal, envPaneId);
        paneIdToTerminal.set(envPaneId, terminal);
      }

      // Claim the session for this terminal, or dispose if another
      // terminal is already registered as the keeper for it.
      // Ephemeral (hideFromUser) terminals — typically from the
      // Python extension's env-discovery — still claim their session
      // so our adopt loop doesn't create a duplicate visible tab
      // for them. Their session is killed when they close (below).
      void claimOrDispose(terminal);
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

      // Use cached session if identified earlier; otherwise fall
      // back to creationOptions.env. We cannot read /proc here
      // because the process is gone by this point.
      const session =
        sessionCache.get(terminal) ?? terminalSession(terminal);

      const msg =
        `[${new Date().toISOString()}] onDidCloseTerminal ` +
        `name=${terminal.name} paneId=${paneId ?? "-"} ` +
        `session=${session ?? "-"} reason=${reasonName}`;
      debugChannel.appendLine(msg);

      if (paneId) {
        terminalToPaneId.delete(terminal);
        paneIdToTerminal.delete(paneId);
      }

      // Release session claim so a future open on this session
      // (e.g. adoption) can become the new keeper.
      releaseSessionClaim(terminal);

      // Extension disposal (dedup) is NOT user-driven; never kill
      // the session in that case. Real user close paths use User
      // or Process.
      if (
        reason === vscode.TerminalExitReason.Shutdown ||
        reason === vscode.TerminalExitReason.Extension
      ) {
        return;
      }

      if (paneId) removePaneFromMapping(paneId);

      if (!session) return;

      // Ephemeral (hideFromUser) terminals always kill their
      // session on close — no refcount check. They're one-shot
      // discovery shells whose tmux session has no user value.
      if (ephemeralTerminals.has(terminal)) {
        debugChannel.appendLine(
          `[${new Date().toISOString()}] killing ephemeral ` +
            `session ${session}`,
        );
        killTmuxSession(session);
        return;
      }

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
      async () => {
        // Manual full pass: claim/dispose existing + adopt orphans.
        let disposed = 0;
        for (const t of vscode.window.terminals) {
          if (await claimOrDispose(t)) disposed++;
        }
        const adopted = await adoptOrphans();
        vscode.window.showInformationMessage(
          `tmux: ${adopted} adopted, ${disposed} duplicates disposed`,
        );
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "tmuxSessionManager.showSessions",
      async () => {
        const sessions = await listTmuxSessions(instanceId);
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

  // Initial pass: identify sessions for all already-present terminals
  // and register keepers. Does NOT adopt orphans — that's left to
  // the periodic interval. Reason: externally-created host-bash
  // terminals (e.g. spawned by another extension) arrive shortly
  // after activation with no identifying env; their host-bash runs
  // cs-tmux-window grab to pick an unattached session. If we adopt
  // the unattached session ourselves during initial pass, we
  // attach it, forcing grab to create a NEW session instead —
  // unbounded growth per reload. Waiting defers adoption until
  // mystery terminals have had a chance to grab.
  (async () => {
    try {
      for (const terminal of vscode.window.terminals) {
        const opts = terminal.creationOptions;
        if ("env" in opts && opts.env && typeof opts.env === "object") {
          const env = opts.env as Record<string, string>;
          if (env.TMUX_PANE_ID && !terminalToPaneId.has(terminal)) {
            terminalToPaneId.set(terminal, env.TMUX_PANE_ID);
            paneIdToTerminal.set(env.TMUX_PANE_ID, terminal);
          }
        }
        await claimOrDispose(terminal);
      }
    } catch (err) {
      console.error("[tmux-session-manager] initial pass failed:", err);
    }
  })();

  // Periodic adoption of orphan sessions.
  const adoptInterval = setInterval(() => {
    void adoptOrphans();
  }, 30000);

  context.subscriptions.push({
    dispose: () => clearInterval(adoptInterval),
  });
}

export function deactivate(): void {
  // NOTE: This is NOT called on browser tab close in code-server.
  // All state persistence happens synchronously on each mutation.
}
