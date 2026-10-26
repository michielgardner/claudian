import { randomUUID } from 'node:crypto';

import {
  PendingInteractionLedger,
  type ProviderApprovalDecisionOption,
  type ProviderExecutionRequest,
  type ProviderExecutionRun,
  type ProviderExecutionSession,
  type ProviderSessionConfig,
  type ProviderSessionEvent,
  RequestedRunChannel,
  SessionSnapshotState,
} from '@/core/execution';
import { appendExecutionContext } from '@/core/prompt/promptContext';
import { getActionDescription } from '@/core/security/approvalRules';
import type { ApprovalDecision } from '@/core/types';

import { decodeZCodeModelId } from '../models';
import { ZCodeOutput, type ZCodeTurnOutcome } from '../normalization/ZCodeOutput';
import { ZCODE_FULL_ACCESS_MODE, zcodeNativeMode } from '../permissionModes';
import { isRecord, ZCodeRemoteError } from '../runtime/ZCodeAppServer';
import { type ZCodeRuntime, type ZCodeSessionListener, zcodeWorkspace } from '../runtime/ZCodeRuntime';

interface ActiveTurn {
  readonly channel: RequestedRunChannel;
  readonly output: ZCodeOutput;
  readonly startedAt: number;
  nativeTurnId?: string;
  outputTokens: number;
  stopRequested: boolean;
  stopTimer?: number;
}

interface AppliedSettings {
  model?: string;
  reasoning?: string;
  mode?: string;
}

/** Native default when Claudian has no reasoning selection for a model change. */
const DEFAULT_ZCODE_REASONING = 'high';

/** Tool approvals ZCode asks for; the bypass mode answers them without a prompt. */
const APPROVAL_DECISIONS: Readonly<Record<string, ApprovalDecision>> = {
  allow_once: 'allow', allow_always: 'allow-always', deny: 'deny',
};

/**
 * One native ZCode session in the shared app-server. A conversation keeps its native
 * session id; after a process restart the session is resumed before the next prompt.
 */
export class ZCodeExecutionSession implements ProviderExecutionSession {
  readonly providerId = 'zcode';
  readonly sessionInstanceId = randomUUID();
  private readonly snapshots: SessionSnapshotState;
  private readonly interactions: PendingInteractionLedger;
  private nativeId?: string;
  /** Runtime generation the native session is active in; another generation needs a resume. */
  private activeGeneration = -1;
  private detach?: () => void;
  private turn?: ActiveTurn;
  private applied: AppliedSettings = {};
  private permissionMode?: string;
  private readonly openPrompts = new Map<string, Promise<unknown>>();
  private disposed = false;

  constructor(
    private readonly config: ProviderSessionConfig,
    private readonly runtime: ZCodeRuntime,
  ) {
    this.nativeId = config.resumeSeed?.providerSessionId;
    this.snapshots = new SessionSnapshotState({
      providerId: this.providerId, sessionInstanceId: this.sessionInstanceId,
      providerState: config.resumeSeed?.providerState, readProviderSessionId: () => this.nativeId,
    });
    this.interactions = new PendingInteractionLedger(config.interactionPort);
  }

  execute(request: ProviderExecutionRequest): ProviderExecutionRun {
    if (this.disposed) throw new Error('This ZCode session was closed.');
    if (this.turn) throw new Error('ZCode is already running a turn in this session.');
    const channel = new RequestedRunChannel({ sessionInstanceId: this.sessionInstanceId, onCancel: () => this.stop() });
    const turn: ActiveTurn = {
      channel, startedAt: Date.now(), outputTokens: 0, stopRequested: false,
      output: new ZCodeOutput(event => { channel.emit(event); }),
    };
    this.turn = turn;
    this.setStatus('executing');
    channel.attachAbortSignal(request.signal);
    void this.run(turn, request);
    return channel;
  }

  cancel(): void {
    this.turn?.channel.cancel();
  }

  getSnapshot() { return this.snapshots.getSnapshot(); }
  getStatus() { return this.snapshots.status; }
  onEvent(listener: (event: ProviderSessionEvent) => void): () => void { return this.snapshots.onEvent(listener); }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.turn) await this.stopNative().catch(() => undefined);
    this.finish({ kind: 'cancelled', outputTokens: 0 });
    this.interactions.dismissAll('session-disposed');
    this.detach?.();
    this.setStatus('disposed');
    this.snapshots.clearListeners();
  }

  // --- Native session channel -------------------------------------------------------

  private readonly nativeListener: ZCodeSessionListener = {
    onEvent: (type, payload, turnId) => this.handleNativeEvent(type, payload, turnId),
    onRequest: async (method, params) => {
      if (method === 'interaction/requestPermission' || method === 'interaction/requestUserInput') {
        // Native re-sends an unanswered prompt under new transport ids; every copy shares one answer.
        const key = `${method}:${typeof params.requestId === 'string' ? params.requestId : randomUUID()}`;
        const existing = this.openPrompts.get(key);
        if (existing) return existing;
        const answer = method === 'interaction/requestPermission' ? this.requestPermission(params) : this.requestUserInput(params);
        this.openPrompts.set(key, answer);
        void answer.finally(() => { this.openPrompts.delete(key); });
        return answer;
      }
      throw new ZCodeRemoteError(`Claudian does not support ${method}.`, -32601);
    },
    onClosed: error => this.handleClosed(error),
  };

  private handleNativeEvent(type: string, payload: unknown, turnId: string | undefined): void {
    const turn = this.turn;
    if (!turn) return;
    if (type === 'turn.started') {
      turn.nativeTurnId ??= turnId;
      return;
    }
    if (turn.nativeTurnId && turnId && turnId !== turn.nativeTurnId) return;
    const outcome = turn.output.handle(type, payload);
    if (outcome) this.finish(outcome);
  }

  private handleClosed(error: Error): void {
    this.activeGeneration = -1;
    this.interactions.dismissAll('provider-transition');
    const turn = this.turn;
    if (!turn) return;
    if (turn.stopRequested) this.finish({ kind: 'cancelled', outputTokens: turn.outputTokens });
    else this.fail(error.message, 'process-exited');
  }

  // --- Turn lifecycle ---------------------------------------------------------------

  private async run(turn: ActiveTurn, request: ProviderExecutionRequest): Promise<void> {
    try {
      const sessionId = await this.ensureSession();
      if (turn.channel.isTerminal) return;
      await this.applySettings(sessionId, request);
      if (turn.channel.isTerminal) return;
      const client = await this.runtime.client();
      const content = buildPrompt(request, !this.snapshots.hasProviderStateValue('instructionsDelivered'));
      const attachments = request.input.flatMap(block => block.type === 'image'
        ? [{ kind: 'image', dataBase64: block.image.data, filename: block.image.name, mimeType: block.image.mediaType }]
        : []);
      // Native stream events can precede the send response, so the turn opens first.
      turn.channel.emit({ type: 'turn_started', accepted: true });
      const response = await client.call('session/send', { sessionId, content, ...(attachments.length ? { attachments } : {}) });
      if (isRecord(response) && response.accepted === false) throw new Error('ZCode did not accept the message.');
      if (!this.snapshots.hasProviderStateValue('instructionsDelivered')) {
        this.snapshots.setProviderStateValue('instructionsDelivered', true);
        this.snapshots.bumpRevision();
      }
    } catch (error) {
      if (turn.channel.isTerminal) return;
      if (turn.stopRequested) { this.finish({ kind: 'cancelled', outputTokens: 0 }); return; }
      const missing = error instanceof ZCodeRemoteError && /not found|unknown session/i.test(error.message);
      this.fail(error instanceof Error ? error.message : String(error), missing ? 'provider-session-missing' : 'transport');
    }
  }

  /** Creates the native session on first use, or resumes it in the current process. */
  private async ensureSession(): Promise<string> {
    const client = await this.runtime.client();
    const generation = this.runtime.currentGeneration;
    if (this.nativeId && this.activeGeneration === generation) return this.nativeId;
    const workspace = zcodeWorkspace(this.config.workingDirectory);
    if (this.nativeId) {
      this.detach?.();
      this.detach = this.runtime.attach(this.nativeId, this.nativeListener);
      await client.call('session/resume', { sessionId: this.nativeId, workspace });
    } else {
      const created = await client.call('session/create', { workspace });
      const session = isRecord(created) && isRecord(created.session) ? created.session : {};
      if (typeof session.sessionId !== 'string') throw new Error('ZCode did not return a session id.');
      this.nativeId = session.sessionId;
      this.detach = this.runtime.attach(this.nativeId, this.nativeListener);
      this.applied = {};
      this.snapshots.bumpRevision();
      this.snapshots.emit({ type: 'session_state_changed', snapshot: this.snapshots.getSnapshot() });
    }
    await client.call('session/subscribe', { sessionId: this.nativeId, deliveryKind: 'desktop-continuous' });
    this.activeGeneration = generation;
    return this.nativeId;
  }

  private async applySettings(sessionId: string, request: ProviderExecutionRequest): Promise<void> {
    const client = await this.runtime.client();
    const configuration = request.configuration;
    const model = configuration.model ? decodeZCodeModelId(configuration.model) : null;
    const reasoning = typeof configuration.reasoning === 'string' && configuration.reasoning ? configuration.reasoning : undefined;
    if (model && this.applied.model !== configuration.model) {
      // Native requires a reasoning level with every model selection.
      const reasoningLevel = reasoning ?? this.applied.reasoning ?? DEFAULT_ZCODE_REASONING;
      await client.call('session/setModel', { sessionId, model: { providerId: model.provider, modelId: model.model, options: { reasoningLevel } }, persistAsWorkspaceLastUsed: false });
      this.applied.model = configuration.model;
      this.applied.reasoning = reasoningLevel;
    }
    if (reasoning && this.applied.reasoning !== reasoning) {
      await client.call('session/setThoughtLevel', { sessionId, thoughtLevel: reasoning, persistAsWorkspaceLastUsed: false });
      this.applied.reasoning = reasoning;
    }
    this.permissionMode = configuration.permissionMode;
    const mode = zcodeNativeMode(request.toolPolicy, configuration.permissionMode);
    if (this.applied.mode !== mode) {
      await client.call('session/setMode', { sessionId, mode });
      this.applied.mode = mode;
    }
  }

  private stop(): void {
    const turn = this.turn;
    if (!turn || turn.stopRequested) return;
    turn.stopRequested = true;
    this.setStatus('cancelling');
    this.interactions.dismissAll('cancelled');
    void this.stopNative().catch(() => undefined).finally(() => {
      // Native confirms a stop with its turn terminal event; never leave the run open if it does not.
      if (this.turn === turn) {
        turn.stopTimer = window.setTimeout(() => { if (this.turn === turn) this.finish({ kind: 'cancelled', outputTokens: turn.outputTokens }); }, 5_000);
      }
    });
    if (!this.nativeId || this.activeGeneration !== this.runtime.currentGeneration) {
      this.finish({ kind: 'cancelled', outputTokens: 0 });
    }
  }

  private async stopNative(): Promise<void> {
    if (!this.nativeId || this.activeGeneration !== this.runtime.currentGeneration) return;
    const client = await this.runtime.client();
    await client.call('session/stop', { sessionId: this.nativeId });
  }

  private finish(outcome: ZCodeTurnOutcome): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = undefined;
    if (turn.stopTimer !== undefined) window.clearTimeout(turn.stopTimer);
    this.interactions.dismissAll('resolved');
    if (outcome.kind === 'failed' && !turn.stopRequested) {
      turn.channel.finish({ type: 'execution_error', category: 'provider', message: outcome.message ?? 'ZCode ended the turn with an error.', recoverable: true });
    } else if (outcome.kind === 'completed' && !turn.stopRequested) {
      turn.channel.finish({ type: 'turn_completed', reason: 'completed',
        turnStats: { outputTokens: outcome.outputTokens, durationMs: Date.now() - turn.startedAt },
      });
    } else {
      turn.channel.finish({ type: 'cancelled' });
    }
    if (!this.disposed) this.setStatus('idle');
  }

  private fail(message: string, category: 'transport' | 'process-exited' | 'provider-session-missing'): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = undefined;
    if (turn.stopTimer !== undefined) window.clearTimeout(turn.stopTimer);
    this.interactions.dismissAll('cancelled');
    turn.channel.finish({ type: 'execution_error', category, message, recoverable: true,
      ...(category === 'provider-session-missing' && this.nativeId ? { missingProviderSessionId: this.nativeId } : {}),
    });
    if (!this.disposed) this.setStatus('idle');
  }

  private setStatus(status: 'idle' | 'executing' | 'cancelling' | 'disposed'): void {
    if (this.snapshots.status === status) return;
    this.snapshots.setStatus(status);
  }

  // --- Interactions ----------------------------------------------------------------

  private async requestUserInput(params: Record<string, unknown>): Promise<unknown> {
    const declined = { action: 'decline' };
    const turn = this.turn;
    if (!turn || turn.stopRequested) return declined;
    const input = isRecord(params.input) ? params.input : {};
    const questions = Array.isArray(input.questions) ? input.questions.filter(isRecord) : [];
    const requestId = typeof params.requestId === 'string' ? params.requestId : randomUUID();
    const pending = this.interactions.begin(requestId);
    if (!pending) return declined;
    try {
      const answer = await this.config.interactionPort.askUserQuestion({
        kind: 'question', interactionId: requestId, sessionInstanceId: this.sessionInstanceId, turnId: turn.channel.turnId,
        input: { ...input, questions },
      }, pending.signal);
      if (this.interactions.isStaleResponse(pending, answer)) return declined;
      this.interactions.settle(pending, 'resolved');
      return answer.answers ? { action: 'accept', content: userInputAnswers(questions, answer.answers) } : declined;
    } catch {
      this.interactions.settle(pending, 'cancelled');
      return declined;
    }
  }

  private async requestPermission(params: Record<string, unknown>): Promise<unknown> {
    const options = Array.isArray(params.options) ? params.options.filter(isRecord) : [];
    const pick = (kind: string): Record<string, unknown> | undefined => options.find(option => option.kind === kind);
    const deny = pick('deny');
    const denial = isRecord(deny?.response) ? deny.response : { decision: 'deny', reason: 'Denied in Claudian.' };
    const turn = this.turn;
    if (!turn || turn.stopRequested) return denial;
    // ZCode's full access mode never reaches here for ordinary tools; this answers any remaining prompt the same way.
    if (this.permissionMode === ZCODE_FULL_ACCESS_MODE) {
      const allow = pick('allow_once');
      return isRecord(allow?.response) ? allow.response : { decision: 'allow', reason: 'Allowed by Claudian full access.' };
    }
    const requestId = typeof params.requestId === 'string' ? params.requestId : randomUUID();
    const pending = this.interactions.begin(requestId, turn.channel.isTerminal ? AbortSignal.abort() : undefined);
    if (!pending) return denial;
    const toolName = typeof params.toolName === 'string' ? params.toolName : 'ZCode';
    const input = isRecord(params.input) ? { ...params.input } : {};
    const decisionOptions: ProviderApprovalDecisionOption[] = options.flatMap(option => {
      const decision = typeof option.kind === 'string' ? APPROVAL_DECISIONS[option.kind] : undefined;
      if (!decision || typeof option.optionId !== 'string') return [];
      return [{ label: typeof option.name === 'string' ? option.name : option.optionId, value: option.optionId, decision,
        ...(typeof option.description === 'string' ? { description: option.description } : {}) }];
    });
    try {
      const answer = await this.config.interactionPort.requestApproval({
        kind: 'approval', interactionId: requestId, sessionInstanceId: this.sessionInstanceId, turnId: turn.channel.turnId,
        toolName, input, description: getActionDescription(toolName, input),
        ...(typeof params.reason === 'string' ? { decisionReason: params.reason } : {}),
        ...(decisionOptions.length ? { decisionOptions } : {}),
      }, pending.signal);
      if (this.interactions.isStaleResponse(pending, answer)) return denial;
      this.interactions.settle(pending, 'resolved');
      const decision = answer.decision;
      const chosen = typeof decision === 'object'
        ? options.find(option => option.optionId === decision.value)
        : decision === 'allow-always' ? pick('allow_always') : decision === 'allow' ? pick('allow_once') : deny;
      return isRecord(chosen?.response) ? chosen.response : denial;
    } catch {
      this.interactions.settle(pending, 'cancelled');
      return denial;
    }
  }
}

/** Native `requestUserInput` answers: `answer_<index>` per question, multiple choices comma-separated. */
function userInputAnswers(questions: readonly Record<string, unknown>[], answers: Record<string, string | string[]>): Record<string, string> {
  const content: Record<string, string> = {};
  questions.forEach((question, index) => {
    const text = typeof question.question === 'string' ? question.question : '';
    const value = Object.hasOwn(answers, text) ? answers[text] : undefined;
    const values = Array.isArray(value) ? value : value ? [value] : [];
    if (values.length) content[`answer_${index}`] = values.join(', ');
  });
  return content;
}

/** The user's text with Claudian's selection and linked-note context; the first turn also carries Claudian's instructions. */
function buildPrompt(request: ProviderExecutionRequest, includeInstructions: boolean): string {
  const text = appendExecutionContext(
    request.input.filter(block => block.type === 'text').map(block => block.text).join('\n'),
    request.context,
  );
  const instructions = request.configuration.systemInstructions.instructions.trim();
  if (!includeInstructions || !instructions) return text;
  return `<claudian_instructions>\n${instructions}\n</claudian_instructions>\n\n${text}`;
}
