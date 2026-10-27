import { getEnhancedPath, parseEnvironmentVariables } from '@/core/process/env';
import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';

import { isRecord, ZCodeAppServer, ZCodeRemoteError } from './ZCodeAppServer';

/** Native session events and requests addressed to one session. */
export interface ZCodeSessionListener {
  onEvent(type: string, payload: unknown, turnId: string | undefined): void;
  /** A native request that needs this session's answer, such as a permission prompt. */
  onRequest(method: string, params: Record<string, unknown>): Promise<unknown>;
  /** The shared process ended; native sessions must be resumed on the next one. */
  onClosed(error: Error): void;
}

export interface ZCodeWorkspaceRef {
  readonly workspacePath: string;
  readonly workspaceKey: string;
}

export function zcodeWorkspace(path: string): ZCodeWorkspaceRef {
  return { workspacePath: path, workspaceKey: path };
}

// Claudian has no interface for ZCode's search, memory and auto-answered questions, so it keeps them off.
const RUNTIME_PREFERENCES = {
  nativeSearchEnhancementsEnabled: false,
  toolSearchMode: 'off',
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: false,
};

/**
 * The workspace's single `zcode app-server` process, shared by every ZCode session,
 * model discovery and history read. It starts lazily and restarts after it exits;
 * a restart closes every attached session, which then resumes its native session.
 */
export class ZCodeRuntime {
  private server: ZCodeAppServer | null = null;
  private starting: Promise<ZCodeAppServer> | null = null;
  private readonly sessions = new Map<string, ZCodeSessionListener>();
  private generation = 0;
  private disposed = false;

  constructor(private readonly host: ProviderRuntimeHost) {}

  /** The permission mode currently selected for ZCode in the toolbar, read live. */
  get selectedPermissionMode(): string | undefined { return this.host.providerSelection.permissionMode; }

  /** Bumps whenever a new process starts, so sessions can tell whether they are still active in it. */
  get currentGeneration(): number { return this.generation; }

  async client(): Promise<ZCodeAppServer> {
    if (this.disposed) throw new Error('ZCode is shut down.');
    if (this.server && !this.server.isClosed) return this.server;
    if (!this.starting) {
      this.starting = this.start().finally(() => { this.starting = null; });
    }
    return this.starting;
  }

  attach(sessionId: string, listener: ZCodeSessionListener): () => void {
    this.sessions.set(sessionId, listener);
    return () => { if (this.sessions.get(sessionId) === listener) this.sessions.delete(sessionId); };
  }

  /** Stops the process; the next use starts a fresh one with current settings. */
  async restart(): Promise<void> {
    const server = this.server;
    this.server = null;
    await server?.shutdown();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.restart();
    this.sessions.clear();
  }

  private async start(): Promise<ZCodeAppServer> {
    const cliPath = await this.host.resolveCliPath();
    if (!cliPath) throw new Error('ZCode was not found. Install it with npm, sign in with "zcode login", or set its path in settings.');
    const environment = parseEnvironmentVariables(this.host.environmentText);
    const env: NodeJS.ProcessEnv = { ...process.env, ...environment };
    env.PATH = getEnhancedPath(environment.PATH, cliPath);
    const server = new ZCodeAppServer({ command: cliPath, cwd: this.host.workingDirectory ?? process.cwd(), env });
    server.setRequestHandler((method, params) => this.handleRequest(method, params));
    server.onNotification((method, params) => this.handleNotification(method, params));
    server.onClose(error => {
      if (this.server === server) this.server = null;
      for (const listener of [...this.sessions.values()]) listener.onClosed(error);
    });
    server.start();
    this.generation += 1;
    this.server = server;
    return server;
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== 'session/event' || !isRecord(params) || typeof params.sessionId !== 'string' || typeof params.type !== 'string') return;
    this.sessions.get(params.sessionId)?.onEvent(params.type, params.payload, typeof params.turnId === 'string' ? params.turnId : undefined);
  }

  private async handleRequest(method: string, params: unknown): Promise<unknown> {
    if (method === 'session/requestRuntimePreferences') return RUNTIME_PREFERENCES;
    const record = isRecord(params) ? params : {};
    const listener = typeof record.sessionId === 'string' ? this.sessions.get(record.sessionId) : undefined;
    if (listener && method.startsWith('interaction/') && method !== 'interaction/requestOfficialMcpAuthHeaders') {
      return listener.onRequest(method, record);
    }
    throw new ZCodeRemoteError(`Claudian does not support ${method}.`, -32601);
  }
}
