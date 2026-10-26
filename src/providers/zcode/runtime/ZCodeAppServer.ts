import { StringDecoder } from 'node:string_decoder';

import { ManagedStdioProcess } from '@/core/process/ManagedStdioProcess';
import { LineBuffer } from '@/utils/LineBuffer';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** A native error response, with ZCode's error code when it gave one. */
export class ZCodeRemoteError extends Error {
  constructor(message: string, readonly code?: number | string, readonly data?: unknown) {
    super(message);
    this.name = 'ZCodeRemoteError';
  }
}

export interface ZCodeAppServerOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

type NotificationListener = (method: string, params: unknown) => void;
/** Answers a server-initiated request; a rejection is sent back as a native error response. */
type RequestHandler = (method: string, params: unknown) => Promise<unknown>;

interface PendingCall {
  readonly method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  detach(): void;
}

/**
 * One `zcode app-server` process speaking ZCode's newline-delimited JSON protocol:
 * `{id, method, params}` requests, `{id, result|error}` responses, `{method, params}`
 * notifications. The protocol rejects a `jsonrpc` member, so none is sent.
 */
export class ZCodeAppServer {
  private readonly process: ManagedStdioProcess;
  private readonly pending = new Map<number, PendingCall>();
  private readonly notificationListeners = new Set<NotificationListener>();
  private readonly closeListeners = new Set<(error: Error) => void>();
  private requestHandler: RequestHandler | null = null;
  private nextId = 1;
  private closedError: Error | null = null;

  constructor(options: ZCodeAppServerOptions) {
    this.process = new ManagedStdioProcess({
      command: options.command,
      args: ['app-server', ...(options.args ?? [])],
      cwd: options.cwd,
      env: options.env,
      killProcessTree: true,
    });
  }

  get isClosed(): boolean { return this.closedError !== null; }

  start(): void {
    this.process.start();
    const lines = new LineBuffer();
    const decoder = new StringDecoder('utf8');
    const onLine = (line: string): void => this.handleLine(line);
    this.process.stdout.on('data', (chunk: Buffer | string) => {
      lines.push(decoder.write(typeof chunk === 'string' ? Buffer.from(chunk) : chunk), onLine);
    });
    this.process.onError(error => this.close(error));
    this.process.onExit(state => {
      const stderr = this.process.getStderrSnapshot().trim();
      const reason = state.error?.message
        ?? `ZCode exited${state.code !== null ? ` with code ${state.code}` : state.signal ? ` (${state.signal})` : ''}.`;
      this.close(new Error(stderr ? `${reason}\n${stderr.split('\n').slice(-5).join('\n')}` : reason));
    });
  }

  call<T = unknown>(method: string, params: unknown = {}, signal?: AbortSignal): Promise<T> {
    if (this.closedError) return Promise.reject(this.closedError);
    if (signal?.aborted) return Promise.reject(new Error(`ZCode ${method} was cancelled.`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`ZCode ${method} was cancelled.`));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        method,
        resolve: value => resolve(value as T),
        reject,
        detach: () => signal?.removeEventListener('abort', onAbort),
      });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: unknown = {}): void {
    if (!this.closedError) this.write({ method, params });
  }

  onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => { this.notificationListeners.delete(listener); };
  }

  onClose(listener: (error: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => { this.closeListeners.delete(listener); };
  }

  setRequestHandler(handler: RequestHandler | null): void {
    this.requestHandler = handler;
  }

  async shutdown(): Promise<void> {
    this.close(new Error('ZCode stopped.'));
    await this.process.shutdown();
  }

  private write(message: Record<string, unknown>): void {
    try {
      this.process.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.close(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleLine(line: string): void {
    const text = line.trim();
    if (!text) return;
    let message: unknown;
    try { message = JSON.parse(text); } catch { return; }
    if (!isRecord(message)) return;
    const hasId = typeof message.id === 'number' || typeof message.id === 'string';
    if (typeof message.method === 'string') {
      if (hasId) this.handleServerRequest(message.id as number | string, message.method, message.params);
      else for (const listener of [...this.notificationListeners]) {
        try { listener(message.method, message.params); } catch { /* listeners cannot break the transport */ }
      }
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    pending.detach();
    if (isRecord(message.error)) {
      const error = message.error;
      pending.reject(new ZCodeRemoteError(
        typeof error.message === 'string' ? error.message : `ZCode ${pending.method} failed.`,
        typeof error.code === 'number' || typeof error.code === 'string' ? error.code : undefined,
        error.data,
      ));
    } else {
      pending.resolve(message.result);
    }
  }

  private handleServerRequest(id: number | string, method: string, params: unknown): void {
    const handler = this.requestHandler;
    if (!handler) {
      this.write({ id, error: { code: -32601, message: `Method not found: ${method}` } });
      return;
    }
    void handler(method, params).then(
      result => { if (!this.closedError) this.write({ id, result: result ?? {} }); },
      error => {
        if (this.closedError) return;
        this.write({ id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
      },
    );
  }

  private close(error: Error): void {
    if (this.closedError) return;
    this.closedError = error;
    for (const call of this.pending.values()) { call.detach(); call.reject(error); }
    this.pending.clear();
    for (const listener of [...this.closeListeners]) {
      try { listener(error); } catch { /* listeners cannot break shutdown */ }
    }
    this.closeListeners.clear();
    this.notificationListeners.clear();
  }
}
