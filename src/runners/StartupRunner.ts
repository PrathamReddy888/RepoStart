import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import { AppFolder, LogEntry, LogLevel, PackageManager, ServiceStatus, ServiceState } from '../types';
import { ActivityTimeline, TimelineStep } from '../services/ActivityTimeline';
import { LogStreamer } from '../services/LogStreamer';
import { now, uid } from '../utils/fs';

function runCommand(pm: PackageManager, script: string): string {
  switch (pm) {
    case 'pnpm': return `pnpm run ${script}`;
    case 'yarn': return `yarn ${script}`;
    default:     return `npm run ${script}`;
  }
}

function terminalLabel(app: AppFolder): string {
  if (app.isFrontend) { return 'RepoStart Frontend'; }
  if (app.isBackend)  { return 'RepoStart Backend'; }
  return `RepoStart ${app.label}`;
}

interface ErrorGuidance {
  pattern: RegExp;
  message: string;
}

const ERROR_PATTERNS: ErrorGuidance[] = [
  { pattern: /EADDRINUSE|address already in use|port.*in use/i, message: 'Port may already be in use. Try stopping other processes or change the port.' },
  { pattern: /cannot find module|module not found/i,             message: 'Missing module detected. Try running npm install again.' },
  { pattern: /npm error|yarn error|pnpm error/i,                message: 'Dependency installation failure detected. Check the Logs tab.' },
  { pattern: /ENOENT.*\.env/i,                                  message: 'Environment file missing. Check your .env configuration.' },
];

function detectErrorGuidance(line: string): string | null {
  for (const { pattern, message } of ERROR_PATTERNS) {
    if (pattern.test(line)) { return message; }
  }
  return null;
}

export interface StartupRunnerOptions {
  apps: AppFolder[];
  timeline: ActivityTimeline;
  streamer: LogStreamer;
  onServiceStatus?: (status: ServiceStatus) => void;
  onTerminalClosed?: (terminal: vscode.Terminal, role: string, relativePath: string) => void;
  logger?: vscode.OutputChannel;
}

interface ManagedTerminal {
  terminal: vscode.Terminal;
  role: string;
  relativePath: string;
  name: string;
  /** Whether we've already fired the "stopped" callback. */
  closed: boolean;
  /** Temp file path — created when the command exits. */
  exitFile: string;
  /** Path to the wrapper JS file. */
  wrapperFile: string;
}

const POLLER_INTERVAL_MS = 1000;

export class StartupRunner {
  private apps: AppFolder[];
  private timeline: ActivityTimeline;
  private streamer: LogStreamer;
  private onServiceStatus?: (status: ServiceStatus) => void;
  private onTerminalClosed?: (terminal: vscode.Terminal, role: string, relativePath: string) => void;
  private logger?: vscode.OutputChannel;

  private managedTerminals: ManagedTerminal[] = [];
  private _exitPoller?: NodeJS.Timeout;

  constructor(opts: StartupRunnerOptions) {
    this.apps             = opts.apps;
    this.timeline         = opts.timeline;
    this.streamer         = opts.streamer;
    this.onServiceStatus  = opts.onServiceStatus;
    this.onTerminalClosed = opts.onTerminalClosed;
    this.logger           = opts.logger;
  }

  private log(message: string): void {
    this.logger?.appendLine(`[StartupRunner] ${message}`);
  }

  async start(): Promise<void> {
    const appsWithScript = this.apps.filter((a) => a.startScript !== null || a.startCommand !== undefined);

    if (appsWithScript.length === 0) {
      this.streamer.system('No startup scripts detected - skipping service launch.');
      const event = this.timeline.addEvent(TimelineStep.STARTING_SERVICES, 'skipped');
      this.timeline.updateEvent(event.id, 'skipped', 'No start scripts found');
      return;
    }

    const parentEvent = this.timeline.addEvent(TimelineStep.STARTING_SERVICES, 'running');
    this.streamer.system('Launching services in VS Code terminals...');

    const frontendApp = appsWithScript.find((a) => a.isFrontend);
    const backendApp  = appsWithScript.find((a) => a.isBackend);
    const otherApps   = appsWithScript.filter((a) => !a.isFrontend && !a.isBackend);

    let firstTerminal: vscode.Terminal | undefined;

    if (frontendApp) {
      firstTerminal = this._launchInTerminal(frontendApp);
    }

    if (backendApp) {
      if (firstTerminal) {
        this._launchInTerminal(backendApp, firstTerminal);
      } else {
        firstTerminal = this._launchInTerminal(backendApp);
      }
    }

    for (const app of otherApps) {
      this._launchInTerminal(app);
    }

    this.timeline.updateEvent(parentEvent.id, 'success', `${appsWithScript.length} terminal(s) launched`);

    this.streamer.system(
      `${appsWithScript.length} service(s) started in VS Code terminals` +
      (frontendApp && backendApp ? ' (split terminal requested)' : '')
    );

    this.log(`Started ${this.managedTerminals.length} managed terminal(s):`);
    for (const mt of this.managedTerminals) {
      this.log(`  - ${mt.role} [${mt.relativePath}] name="${mt.name}" exitFile="${mt.exitFile}"`);
    }

    this._startExitPolling();
  }

  /**
   * Create a Node.js wrapper script that:
   * 1. Spawns the actual command (npm run start, etc.)
   * 2. Pipes stdin/stdout/stderr to the terminal (user sees all output)
   * 3. When the command exits, writes the exit code to a temp file
   *
   * This is SHELL-AGNOSTIC — works identically on bash, zsh, PowerShell,
   * cmd.exe, fish, etc. because it's just `node wrapper.js`.
   */
  private _createWrapperScript(cmd: string, cwd: string, exitFile: string): string {
    const wrapperPath = path.join(os.tmpdir(), `repostart-wrapper-${uid()}.js`);

    // The wrapper script spawns the command, inherits stdio (so the user
    // sees all output in the terminal), and writes the exit code to a
    // file when the command finishes. The script process then EXITS,
    // which means terminal.exitStatus will ALSO become defined — giving
    // us two detection mechanisms.
    const script = `
const { spawn } = require('child_process');
const fs = require('fs');
const exitFile = ${JSON.stringify(exitFile)};
const cmd = ${JSON.stringify(cmd)};
const cwd = ${JSON.stringify(cwd)};

const child = spawn(cmd, {
  shell: true,
  stdio: 'inherit',
  cwd: cwd,
  env: process.env
});

child.on('error', (err) => {
  console.error('Failed to start:', err.message);
  try { fs.writeFileSync(exitFile, '1'); } catch {}
  process.exit(1);
});

child.on('exit', (code, signal) => {
  const exitCode = code !== null ? code : (signal ? 1 : 0);
  try { fs.writeFileSync(exitFile, String(exitCode)); } catch {}
  // Exit the wrapper process too — this makes terminal.exitStatus
  // fire as a backup detection mechanism.
  process.exit(exitCode);
});
`;

    fs.writeFileSync(wrapperPath, script, 'utf-8');
    return wrapperPath;
  }

  private _launchInTerminal(
    app: AppFolder,
    parentTerminal?: vscode.Terminal
  ): vscode.Terminal {
    const cmd = app.startScript !== null
      ? runCommand(app.packageManager, app.startScript)
      : app.startCommand!;
    const name    = terminalLabel(app);
    const source  = `${app.startScript ?? app.startCommand} [${app.relativePath}]`;

    const eventLabel = `Starting ${name}`;
    const event = this.timeline.addEvent(eventLabel, 'running');

    this.streamer.system(`Launching: ${cmd}  (in ${app.relativePath})`, source);

    // Generate a unique temp file for this terminal's exit code.
    const exitFile = path.join(os.tmpdir(), `repostart-exit-${uid()}.txt`);

    // Create the shell-agnostic wrapper script.
    const wrapperFile = this._createWrapperScript(cmd, app.path, exitFile);

    // The command to run in the terminal is just: node /path/to/wrapper.js
    // This works on ALL shells — bash, zsh, PowerShell, cmd.exe, fish.
    const wrappedCmd = `node "${wrapperFile}"`;

    const terminalOptions: vscode.TerminalOptions = {
      name,
      cwd: app.path,
      env: process.env as Record<string, string>,
      ...(parentTerminal ? { location: { parentTerminal } } : {}),
    };

    const terminal = vscode.window.createTerminal(terminalOptions);
    terminal.show(false);
    terminal.sendText(wrappedCmd);

    const role = app.isFrontend ? 'Frontend' : app.isBackend ? 'Backend' : app.label;

    const managed: ManagedTerminal = {
      terminal,
      role,
      relativePath: app.relativePath,
      name,
      closed: false,
      exitFile,
      wrapperFile,
    };

    this.managedTerminals.push(managed);

    this.log(`_launchInTerminal: ${role} [${app.relativePath}] → running`);
    this.log(`  wrapper: ${wrapperFile}`);
    this.log(`  exitFile: ${exitFile}`);

    this.onServiceStatus?.({
      label: role,
      relativePath: app.relativePath,
      state: 'running',
    });

    this.timeline.updateEvent(event.id, 'success', `Terminal: ${name}`);

    const logEntry: LogEntry = {
      id: uid(),
      level: 'success',
      source,
      message: `${cmd} - terminal: ${name}`,
      timestamp: now(),
      category: app.isFrontend ? 'FRONTEND' : app.isBackend ? 'BACKEND' : 'SYSTEM',
    };
    this.streamer.emit('log', logEntry);

    return terminal;
  }

  // ── Exit polling via temp file + terminal.exitStatus ────────────

  private _startExitPolling(): void {
    if (this._exitPoller) return;
    this.log(`Starting exit poller (interval: ${POLLER_INTERVAL_MS}ms)`);
    this._exitPoller = setInterval(() => {
      this._checkTerminalExits();
    }, POLLER_INTERVAL_MS);
  }

  private _stopExitPolling(): void {
    if (this._exitPoller) {
      this.log('Stopping exit poller');
      clearInterval(this._exitPoller);
      this._exitPoller = undefined;
    }
  }

  /**
   * Check each managed terminal for exit.
   *
   * DUAL DETECTION:
   * 1. Exit file exists → command exited (primary, works even if shell
   *    stays open)
   * 2. terminal.exitStatus is defined → terminal process exited
   *    (backup, works when wrapper script exits)
   */
  private _checkTerminalExits(): void {
    for (const mt of this.managedTerminals) {
      if (mt.closed) continue;

      // Method 1: Check exit file (command exited)
      let exitCode: number | null = null;
      try {
        if (fs.existsSync(mt.exitFile)) {
          const content = fs.readFileSync(mt.exitFile, 'utf-8').trim();
          exitCode = parseInt(content, 10);
          if (isNaN(exitCode)) exitCode = 1;
          this.log(`_checkTerminalExits: "${mt.name}" exit FILE detected (code=${exitCode})`);
        }
      } catch { /* ignore */ }

      // Method 2: Check terminal.exitStatus (terminal process exited)
      if (exitCode === null) {
        try {
          const status = mt.terminal.exitStatus;
          if (status !== undefined) {
            exitCode = status.code;
            this.log(`_checkTerminalExits: "${mt.name}" exit STATUS detected (code=${exitCode})`);
          }
        } catch { /* ignore */ }
      }

      if (exitCode !== null) {
        this._handleProcessExit(mt, exitCode);
      }
    }
  }

  private _handleProcessExit(mt: ManagedTerminal, exitCode: number): void {
    if (mt.closed) return;
    mt.closed = true;

    this.log(`_handleProcessExit: ${mt.role} [${mt.relativePath}] exited with code ${exitCode}`);

    const idx = this.managedTerminals.indexOf(mt);
    if (idx >= 0) {
      this.managedTerminals.splice(idx, 1);
    }

    // Clean up temp files
    try { fs.unlinkSync(mt.exitFile); } catch { /* ignore */ }
    try { fs.unlinkSync(mt.wrapperFile); } catch { /* ignore */ }

    this.log(`_handleProcessExit: sending ${mt.role} → stopped to dashboard`);

    this.onServiceStatus?.({
      label: mt.role,
      relativePath: mt.relativePath,
      state: 'stopped',
    });

    const stopEvent = this.timeline.addEvent(
      `${mt.role} service stopped`,
      'success'
    );
    this.timeline.updateEvent(
      stopEvent.id,
      'success',
      `Process exited (code ${exitCode})`
    );

    const logEntry: LogEntry = {
      id: uid(),
      level: exitCode === 0 ? 'system' : 'error',
      source: `${mt.role} [${mt.relativePath}]`,
      message: `${mt.role} service stopped (process exited with code ${exitCode})`,
      timestamp: now(),
      category: mt.role === 'Frontend' ? 'FRONTEND' : mt.role === 'Backend' ? 'BACKEND' : 'SYSTEM',
    };
    this.streamer.emit('log', logEntry);

    this.streamer.system(
      `${mt.role} service stopped (process exited, code ${exitCode})`,
      `${mt.role} [${mt.relativePath}]`
    );

    this.log(`_handleProcessExit: DONE — ${mt.role} marked stopped`);
  }

  // ── Terminal-close handling (manual close via trash icon) ───────

  isManagedTerminal(terminal: vscode.Terminal): boolean {
    const byRef = this.managedTerminals.some((mt) => mt.terminal === terminal);
    if (byRef) {
      this.log(`isManagedTerminal: matched by reference for "${terminal.name}"`);
      return true;
    }
    this.log(`isManagedTerminal: NO MATCH for terminal "${terminal.name}"`);
    return false;
  }

  handleTerminalClose(closedTerminal: vscode.Terminal): boolean {
    const idx = this.managedTerminals.findIndex((mt) => mt.terminal === closedTerminal);

    if (idx === -1) {
      this.log(`handleTerminalClose: "${closedTerminal.name}" not in managed list — ignoring`);
      return false;
    }

    const managed = this.managedTerminals[idx];
    if (managed.closed) {
      this.log(`handleTerminalClose: "${managed.name}" already closed — ignoring`);
      return false;
    }
    managed.closed = true;

    this.managedTerminals.splice(idx, 1);

    // Clean up temp files
    try { fs.unlinkSync(managed.exitFile); } catch { /* ignore */ }
    try { fs.unlinkSync(managed.wrapperFile); } catch { /* ignore */ }

    this.log(`handleTerminalClose: processing close for ${managed.role} [${managed.relativePath}]`);

    this.onServiceStatus?.({
      label: managed.role,
      relativePath: managed.relativePath,
      state: 'stopped',
    });

    const stopEvent = this.timeline.addEvent(
      `${managed.role} service stopped`,
      'success'
    );
    this.timeline.updateEvent(stopEvent.id, 'success', `Terminal closed by user`);

    const logEntry: LogEntry = {
      id: uid(),
      level: 'system',
      source: `${managed.role} [${managed.relativePath}]`,
      message: `${managed.role} service stopped (terminal closed)`,
      timestamp: now(),
      category: managed.role === 'Frontend' ? 'FRONTEND' : managed.role === 'Backend' ? 'BACKEND' : 'SYSTEM',
    };
    this.streamer.emit('log', logEntry);

    this.streamer.system(
      `${managed.role} service stopped (terminal closed)`,
      `${managed.role} [${managed.relativePath}]`
    );

    this.onTerminalClosed?.(closedTerminal, managed.role, managed.relativePath);

    this.log(`handleTerminalClose: DONE — ${managed.role} marked stopped`);
    return true;
  }

  getManagedTerminalsInfo(): Array<{ role: string; relativePath: string; name: string }> {
    return this.managedTerminals.map((mt) => ({
      role: mt.role,
      relativePath: mt.relativePath,
      name: mt.name,
    }));
  }

  killAll(): void {
    this._stopExitPolling();

    const toKill = this.managedTerminals.splice(0);
    this.log(`killAll: disposing ${toKill.length} managed terminal(s)`);

    for (const mt of toKill) {
      mt.closed = true;
      // Clean up temp files
      try { fs.unlinkSync(mt.exitFile); } catch { /* ignore */ }
      try { fs.unlinkSync(mt.wrapperFile); } catch { /* ignore */ }
      try {
        mt.terminal.dispose();
        this.onServiceStatus?.({
          label: mt.role,
          relativePath: mt.relativePath,
          state: 'stopped',
        });
      } catch { /* already disposed */ }
    }
  }

  dispose(): void {
    this._stopExitPolling();
  }
}
