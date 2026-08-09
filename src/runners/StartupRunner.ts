import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import { AppFolder, LogEntry, PackageManager, ServiceStatus } from '../types';
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

/**
 * A Pseudoterminal that spawns the service process directly and pipes
 * its output to the VS Code terminal. This gives us RELIABLE process
 * exit detection — no temp files, no shell wrappers, no polling.
 *
 * When the process exits (crash, Ctrl+C, or normal), the `exit` event
 * fires and we call the onExit callback immediately.
 */
class ServicePseudoterminal implements vscode.Pseudoterminal {
  private writeEmitter = new vscode.EventEmitter<string>();
  onDidWrite = this.writeEmitter.event;

  private closeEmitter = new vscode.EventEmitter<number | void>();
  onDidClose = this.closeEmitter.event;

  private process: ChildProcess | undefined;

  constructor(
    private cmd: string,
    private cwd: string,
    private env: Record<string, string>,
    private onExit: (code: number) => void
  ) {}

  open(_initialDimensions: vscode.TerminalDimensions | undefined): void {
    this.writeEmitter.fire(`$ ${this.cmd}\r\n`);

    try {
      this.process = spawn(this.cmd, {
        shell: true,
        cwd: this.cwd,
        env: this.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.writeEmitter.fire(`Failed to start: ${(err as Error).message}\r\n`);
      this.onExit(1);
      this.closeEmitter.fire(1);
      return;
    }

    this.process.stdout?.on('data', (data: Buffer) => {
      this.writeEmitter.fire(data.toString());
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      this.writeEmitter.fire(data.toString());
    });

    this.process.on('error', (err) => {
      this.writeEmitter.fire(`Error: ${err.message}\r\n`);
      this.onExit(1);
      this.closeEmitter.fire(1);
    });

    this.process.on('exit', (code, signal) => {
      const exitCode = code !== null ? code : (signal ? 1 : 0);
      this.writeEmitter.fire(`\r\n[Process exited with code ${exitCode}]\r\n`);
      this.onExit(exitCode);
      this.closeEmitter.fire(exitCode);
    });
  }

  close(): void {
    if (this.process) {
      try { this.process.kill(); } catch { /* already dead */ }
    }
  }

  handleInput(data: string): void {
    if (data === '\x03') {
      // Ctrl+C
      try { this.process?.kill('SIGINT'); } catch { /* ignore */ }
    } else {
      this.process?.stdin?.write(data);
    }
  }
}

interface ManagedTerminal {
  terminal: vscode.Terminal;
  role: string;
  relativePath: string;
  name: string;
  closed: boolean;
}

export interface StartupRunnerOptions {
  apps: AppFolder[];
  timeline: ActivityTimeline;
  streamer: LogStreamer;
  onServiceStatus?: (status: ServiceStatus) => void;
  onTerminalClosed?: (terminal: vscode.Terminal, role: string, relativePath: string) => void;
  logger?: vscode.OutputChannel;
}

export class StartupRunner {
  private apps: AppFolder[];
  private timeline: ActivityTimeline;
  private streamer: LogStreamer;
  private onServiceStatus?: (status: ServiceStatus) => void;
  private onTerminalClosed?: (terminal: vscode.Terminal, role: string, relativePath: string) => void;
  private logger?: vscode.OutputChannel;

  private managedTerminals: ManagedTerminal[] = [];

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

    this.log(`Started ${this.managedTerminals.length} managed terminal(s)`);
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

    const role = app.isFrontend ? 'Frontend' : app.isBackend ? 'Backend' : app.label;

    // Create a placeholder for the managed terminal entry so the
    // onExit callback can reference it.
    const managed: ManagedTerminal = {
      terminal: undefined!,
      role,
      relativePath: app.relativePath,
      name,
      closed: false,
    };

    // Create the Pseudoterminal. The onExit callback fires DIRECTLY
    // from the child process's exit event — no polling needed.
    const pty = new ServicePseudoterminal(
      cmd,
      app.path,
      process.env as Record<string, string>,
      (exitCode) => {
        this.log(`[Pseudoterminal.onExit] ${role} exited with code ${exitCode}`);
        this._handleProcessExit(managed, exitCode);
      }
    );

    const terminalOptions: vscode.ExtensionTerminalOptions = {
      name,
      pty,
      ...(parentTerminal ? { location: { parentTerminal } } : {}),
    };

    const terminal = vscode.window.createTerminal(terminalOptions);
    terminal.show(false);

    managed.terminal = terminal;
    this.managedTerminals.push(managed);

    this.log(`_launchInTerminal: ${role} [${app.relativePath}] → running (Pseudoterminal)`);

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

  /**
   * Called when the child process exits — DIRECTLY from the
   * Pseudoterminal's exit event. No polling, no temp files.
   */
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
  // This is a BACKUP. The Pseudoterminal's close() method kills the
  // process, which fires the exit event, which calls _handleProcessExit.
  // But we also handle onDidCloseTerminal in case the Pseudoterminal's
  // close doesn't fire for some reason.

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

    this.log(`handleTerminalClose: "${managed.name}" closed by user`);

    // The Pseudoterminal's close() will kill the process, which will
    // fire the exit event and call _handleProcessExit. But just in
    // case that doesn't happen (e.g., process already dead), we
    // mark it stopped here too.
    managed.closed = true;
    this.managedTerminals.splice(idx, 1);

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
    const toKill = this.managedTerminals.splice(0);
    this.log(`killAll: disposing ${toKill.length} managed terminal(s)`);

    for (const mt of toKill) {
      mt.closed = true;
      try {
        mt.terminal.dispose();
      } catch { /* already disposed */ }
      this.onServiceStatus?.({
        label: mt.role,
        relativePath: mt.relativePath,
        state: 'stopped',
      });
    }
  }

  dispose(): void {
    // No poller to stop — Pseudoterminal handles everything.
  }
}
