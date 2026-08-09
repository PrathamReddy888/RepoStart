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
  /** Temp file path — created when the command exits, regardless of shell. */
  exitFile: string;
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

    // Wrap the command so the exit code is written to a temp file
    // AFTER the command finishes. This works regardless of whether
    // the shell (bash/cmd) stays open — the file appears as soon as
    // the command exits, which is what we need to detect crashes.
    //
    // The shell stays open so the user can see the error output.
    // We just get the exit code via the file.
    let wrappedCmd: string;
    if (process.platform === 'win32') {
      // Windows cmd.exe: & runs the next command regardless of exit code
      wrappedCmd = `${cmd} & echo %errorlevel% > "${exitFile}"`;
    } else {
      // Unix (bash/zsh): ; runs the next command regardless of exit code
      wrappedCmd = `${cmd}; echo $? > "${exitFile}"`;
    }

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
    };

    this.managedTerminals.push(managed);

    this.log(`_launchInTerminal: ${role} [${app.relativePath}] → running (exitFile=${exitFile})`);

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

  // ── Exit polling via temp file ──────────────────────────────────

  private _startExitPolling(): void {
    if (this._exitPoller) return;
    this.log(`Starting exit-file poller (interval: ${POLLER_INTERVAL_MS}ms)`);
    this._exitPoller = setInterval(() => {
      this._checkExitFiles();
    }, POLLER_INTERVAL_MS);
  }

  private _stopExitPolling(): void {
    if (this._exitPoller) {
      this.log('Stopping exit-file poller');
      clearInterval(this._exitPoller);
      this._exitPoller = undefined;
    }
  }

  /**
   * Check each managed terminal's exit file.
   * When the file exists, the command has exited (crash or normal).
   */
  private _checkExitFiles(): void {
    for (const mt of this.managedTerminals) {
      if (mt.closed) continue;

      let exists = false;
      try {
        exists = fs.existsSync(mt.exitFile);
      } catch {
        continue;
      }

      if (!exists) continue;

      // Read the exit code
      let exitCode = 1;
      try {
        const content = fs.readFileSync(mt.exitFile, 'utf-8').trim();
        exitCode = parseInt(content, 10);
        if (isNaN(exitCode)) exitCode = 1;
      } catch { /* default to 1 */ }

      // Clean up the temp file
      try { fs.unlinkSync(mt.exitFile); } catch { /* ignore */ }

      this.log(`_checkExitFiles: "${mt.name}" command exited (code=${exitCode})`);
      this._handleProcessExit(mt, exitCode);
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
      // Clean up temp file if it exists
      try { fs.unlinkSync(mt.exitFile); } catch { /* ignore */ }
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
