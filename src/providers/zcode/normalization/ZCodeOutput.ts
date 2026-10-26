import type { RequestedRunEvent } from '@/core/execution/RequestedRunChannel';
import type { DiffLine, ToolResultDiff } from '@/core/types';

import { encodeZCodeModelId } from '../models';
import { isRecord } from '../runtime/ZCodeAppServer';

export type ZCodeOutputEvent = RequestedRunEvent;

/** Native turn outcome, decoded from `turn.completed` and its failure siblings. */
export interface ZCodeTurnOutcome {
  readonly kind: 'completed' | 'cancelled' | 'failed';
  readonly message?: string;
  readonly outputTokens: number;
}

/**
 * Translates one native turn's `session/event` stream into Claudian events.
 * Native tool names already follow Claude's (`Read`, `Write`, `Edit`, `Bash`, …).
 */
export class ZCodeOutput {
  private started = false;
  private readonly tools = new Map<string, { name: string; input: Record<string, unknown> }>();
  private readonly completed = new Set<string>();
  private contextWindow = 0;
  private model?: string;

  constructor(private readonly emit: (event: ZCodeOutputEvent) => void) {}

  /** Handles one native event; returns the turn outcome when the event ends the turn. */
  handle(type: string, payload: unknown): ZCodeTurnOutcome | null {
    if (!isRecord(payload)) return null;
    switch (type) {
      case 'model.streaming': this.streaming(payload); return null;
      case 'tool.updated': this.toolUpdated(payload); return null;
      case 'session.updated': this.sessionUpdated(payload); return null;
      case 'turn.completed': return this.turnCompleted(payload);
      case 'turn.failed':
      case 'turn.error':
        return { kind: 'failed', message: errorMessage(payload), outputTokens: outputTokens(payload) };
      case 'turn.cancelled':
      case 'turn.interrupted':
      case 'turn.aborted':
        return { kind: 'cancelled', outputTokens: outputTokens(payload) };
      default: return null;
    }
  }

  private begin(): void {
    if (this.started) return;
    this.started = true;
    this.emit({ type: 'assistant_message_started' });
  }

  private streaming(payload: Record<string, unknown>): void {
    const kind = payload.kind;
    if ((kind === 'text_delta' || kind === 'reasoning_delta') && typeof payload.delta === 'string' && payload.delta) {
      this.begin();
      this.emit({ type: kind === 'text_delta' ? 'text_delta' : 'thinking_delta', text: payload.delta });
    } else if (kind === 'tool_call' && typeof payload.toolCallId === 'string' && typeof payload.toolName === 'string') {
      this.toolStarted(payload.toolCallId, payload.toolName, payload.input);
    }
  }

  private toolStarted(id: string, name: string, rawInput: unknown): void {
    if (this.tools.has(id)) return;
    const input = isRecord(rawInput) ? { ...rawInput } : {};
    this.tools.set(id, { name, input });
    this.begin();
    this.emit({ type: 'tool_started', toolCallId: id, name, input: { ...input }, toolScope: { kind: 'main' } });
  }

  private toolUpdated(payload: Record<string, unknown>): void {
    const id = payload.toolCallId;
    if (typeof id !== 'string') return;
    if (payload.kind === 'scheduled' || payload.kind === 'started') {
      // Input normally arrives through the stream's tool_call first; this covers calls it omitted.
      if (typeof payload.toolName === 'string') this.toolStarted(id, payload.toolName, payload.input);
      return;
    }
    if ((payload.kind !== 'result' && payload.kind !== 'error') || this.completed.has(id)) return;
    this.completed.add(id);
    if (payload.kind === 'error') {
      const error = isRecord(payload.error) ? payload.error : {};
      this.emit({ type: 'tool_completed', toolCallId: id, isError: true, toolScope: { kind: 'main' },
        content: typeof error.message === 'string' ? error.message : 'The tool failed.', resultDetails: { resultFormat: 'plain' },
      });
      return;
    }
    const result = isRecord(payload.result) ? payload.result : {};
    const isError = result.success === false || typeof result.error === 'string';
    const content = toolText(result);
    const diff = fileDiff(result.display);
    this.emit({ type: 'tool_completed', toolCallId: id, content, isError, toolScope: { kind: 'main' },
      resultDetails: { resultFormat: 'plain', ...(diff ? { diff } : {}) },
    });
  }

  private sessionUpdated(payload: Record<string, unknown>): void {
    if (typeof payload.providerId === 'string' && typeof payload.modelId === 'string') {
      this.model = encodeZCodeModelId(payload.providerId, payload.modelId);
    }
    if (typeof payload.contextWindow === 'number' && payload.contextWindow > 0) this.contextWindow = payload.contextWindow;
    // A completed model step carries its usage beside the assistant content.
    if (typeof payload.content === 'string' && isRecord(payload.usage)) this.usage(payload.usage);
  }

  private usage(usage: Record<string, unknown>): void {
    const number = (key: string): number => typeof usage[key] === 'number' && Number.isFinite(usage[key]) ? Math.max(0, usage[key]) : 0;
    // Native input tokens already include cache reads and writes.
    const contextTokens = number('inputTokens');
    this.emit({ type: 'usage_updated', usage: {
      ...(this.model ? { model: this.model } : {}),
      inputTokens: Math.max(0, contextTokens - number('cacheReadTokens') - number('cacheWriteTokens')),
      cacheReadInputTokens: number('cacheReadTokens'), cacheCreationInputTokens: number('cacheWriteTokens'),
      contextTokens, contextWindow: this.contextWindow,
      percentage: this.contextWindow > 0 ? contextTokens / this.contextWindow * 100 : 0,
    } });
  }

  private turnCompleted(payload: Record<string, unknown>): ZCodeTurnOutcome {
    const resultType = typeof payload.resultType === 'string' ? payload.resultType : 'success';
    const tokens = outputTokens(payload);
    if (resultType === 'success') return { kind: 'completed', outputTokens: tokens };
    if (/cancel|interrupt|abort/i.test(resultType)) return { kind: 'cancelled', outputTokens: tokens };
    return { kind: 'failed', message: errorMessage(payload) ?? `ZCode ended the turn: ${resultType}.`, outputTokens: tokens };
  }
}

function outputTokens(payload: Record<string, unknown>): number {
  const usage = isRecord(payload.usage) ? payload.usage : {};
  return typeof usage.outputTokens === 'number' && Number.isFinite(usage.outputTokens) ? Math.max(0, usage.outputTokens) : 0;
}

function errorMessage(payload: Record<string, unknown>): string | undefined {
  for (const value of [payload.error, payload.message, payload.reason]) {
    if (typeof value === 'string' && value.trim()) return value;
    if (isRecord(value) && typeof value.message === 'string') return value.message;
  }
  return undefined;
}

/** Model-facing tool result text, or the native error. */
export function toolText(result: Record<string, unknown>): string {
  if (typeof result.content === 'string') return result.content;
  if (typeof result.error === 'string') return result.error;
  if (Array.isArray(result.content)) {
    return result.content.flatMap(block => isRecord(block) && typeof block.text === 'string' ? [block.text] : []).join('\n');
  }
  return '';
}

/** Native `file_diff` display as Claudian diff lines. */
export function fileDiff(display: unknown): ToolResultDiff | undefined {
  if (!isRecord(display) || display.kind !== 'file_diff' || !Array.isArray(display.structuredPatch)) return undefined;
  const diffLines: DiffLine[] = [];
  for (const hunk of display.structuredPatch) {
    if (!isRecord(hunk) || !Array.isArray(hunk.lines)) return undefined;
    let oldLine = typeof hunk.oldStart === 'number' ? hunk.oldStart : 1;
    let newLine = typeof hunk.newStart === 'number' ? hunk.newStart : 1;
    for (const line of hunk.lines) {
      if (typeof line !== 'string') return undefined;
      const text = line.slice(1);
      if (line.startsWith('+')) diffLines.push({ type: 'insert', text, newLineNum: newLine++ });
      else if (line.startsWith('-')) diffLines.push({ type: 'delete', text, oldLineNum: oldLine++ });
      else if (!line.startsWith('\\')) diffLines.push({ type: 'equal', text, oldLineNum: oldLine++, newLineNum: newLine++ });
    }
  }
  return {
    ...(typeof display.filePath === 'string' ? { filePath: display.filePath } : {}),
    diffLines,
    stats: {
      added: diffLines.filter(line => line.type === 'insert').length,
      removed: diffLines.filter(line => line.type === 'delete').length,
    },
  };
}
