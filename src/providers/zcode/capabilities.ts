import type { ProviderCapabilities } from '@/core/providers/types';

export const ZCODE_PROVIDER_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  providerId: 'zcode',
  supportsNativeHistory: true,
  supportsEphemeralSessions: false,
  supportsRewind: false,
  supportsFork: false,
  supportsConversationBranches: false,
  supportsProviderCommands: false,
  supportsImageAttachments: true,
  supportsTurnSteer: false,
  reasoningControl: 'effort',
});
