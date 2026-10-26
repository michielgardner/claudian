import type {
  ProviderConversationHistoryService,
  ProviderConversationSessionAvailability,
  ProviderHistoryInput,
  ProviderHistoryPathContext,
  ProviderHistoryUpdate,
} from '@/core/providers/types';

import { isRecord, ZCodeRemoteError } from '../runtime/ZCodeAppServer';
import { type ZCodeRuntime, zcodeWorkspace } from '../runtime/ZCodeRuntime';
import { latestZCodeModel, mapZCodeMessages } from './ZCodeHistory';

const INSTRUCTIONS_PATTERN = /^<claudian_instructions>\n[\s\S]*?\n<\/claudian_instructions>\n\n/;

export class ZCodeConversationHistoryService implements ProviderConversationHistoryService {
  constructor(private readonly resolveRuntime: (context?: ProviderHistoryPathContext) => Promise<ZCodeRuntime>) {}

  resolveSessionIdForConversation(input: ProviderHistoryInput | null): string | null {
    return input?.sessionId ?? null;
  }

  isPendingForkConversation(): boolean { return false; }

  hasConversationModelRecoverySource(input: ProviderHistoryInput): boolean { return !!input.sessionId; }

  async recoverConversationModelSelection(input: ProviderHistoryInput, vaultPath: string | null, context?: ProviderHistoryPathContext): Promise<string | null> {
    if (!input.sessionId) return null;
    return this.readMessages(input.sessionId, vaultPath, context).then(latestZCodeModel).catch(() => null);
  }

  async getConversationSessionAvailability(input: ProviderHistoryInput, vaultPath: string | null, context?: ProviderHistoryPathContext): Promise<ProviderConversationSessionAvailability> {
    if (!input.sessionId) return 'unknown';
    try {
      await this.readMessages(input.sessionId, vaultPath, context);
      return 'available';
    } catch (error) {
      return isMissingSession(error) ? 'missing' : 'unknown';
    }
  }

  async hydrateConversationHistory(input: ProviderHistoryInput, vaultPath: string | null, context?: ProviderHistoryPathContext): Promise<ProviderHistoryUpdate> {
    if (!input.sessionId) return {};
    const messages = mapZCodeMessages(await this.readMessages(input.sessionId, vaultPath, context));
    const first = messages.find(message => message.role === 'user');
    if (first) {
      first.content = first.content.replace(INSTRUCTIONS_PATTERN, '');
    }
    return { messages };
  }

  buildForkProviderState(): Record<string, unknown> {
    throw new Error('ZCode conversations cannot be forked in Claudian.');
  }

  buildPersistedProviderState(input: ProviderHistoryInput): Record<string, unknown> | undefined {
    return input.providerState ? { ...input.providerState } : undefined;
  }

  /** Native messages of a session: read directly when it is active, else resumed into the shared process. */
  private async readMessages(sessionId: string, vaultPath: string | null, context?: ProviderHistoryPathContext): Promise<unknown> {
    const runtime = await this.resolveRuntime(context);
    const client = await runtime.client();
    try {
      const result = await client.call('session/messages', { sessionId });
      if (isRecord(result)) return result.messages;
    } catch (error) {
      if (!(error instanceof ZCodeRemoteError) || !/not active/i.test(error.message)) throw error;
    }
    const resumed = await client.call('session/resume', { sessionId, ...(vaultPath ? { workspace: zcodeWorkspace(vaultPath) } : {}) });
    return isRecord(resumed) ? resumed.messages : [];
  }
}

function isMissingSession(error: unknown): boolean {
  return error instanceof ZCodeRemoteError && /not found|unknown session|does not exist/i.test(error.message);
}
