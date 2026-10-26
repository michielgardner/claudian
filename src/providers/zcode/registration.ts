import { NOOP_TASK_RESULT_INTERPRETER } from '@/core/providers/NoopTaskResultInterpreter';
import { getProviderConfig } from '@/core/providers/providerConfig';
import { hasStoredConfigNormalization } from '@/core/providers/settings/storedSettings';
import type { ProviderModule } from '@/core/providers/types';

import { getZCodeWorkspaceServices, zcodeWorkspaceRegistration } from './app/ZCodeWorkspaceServices';
import { ZCODE_PROVIDER_CAPABILITIES } from './capabilities';
import { findZCodeModel } from './config';
import { zcodeSettingsReconciler } from './env/ZCodeSettingsReconciler';
import { ZCodeExecutionBackend } from './execution/ZCodeExecutionBackend';
import { ZCodeConversationHistoryService } from './history/ZCodeConversationHistoryService';
import { getZCodeProviderSettings, projectZCodeModelSettings, updateZCodeProviderSettings } from './settings';
import { zcodeChatUIConfig } from './ui/ZCodeChatUIConfig';
import { zcodeModelPolicy } from './ZCodeModelPolicy';

export const zcodeProviderRegistration: ProviderModule = {
  id: 'zcode', displayName: 'ZCode', blankTabOrder: 14,
  isEnabled: settings => getZCodeProviderSettings(settings).enabled,
  setEnabled: (settings, enabled) => { updateZCodeProviderSettings(settings, { enabled }); },
  modelPolicy: zcodeModelPolicy,
  chatUIConfig: zcodeChatUIConfig,
  capabilities: ZCODE_PROVIDER_CAPABILITIES,
  environmentKeyPatterns: [/^ZCODE_/i],
  createExecutionBackend: () => new ZCodeExecutionBackend(() => getZCodeWorkspaceServices().zcode),
  historyService: new ZCodeConversationHistoryService(async context => {
    await context?.ensureWorkspace?.();
    return getZCodeWorkspaceServices().zcode;
  }),
  taskResultInterpreter: NOOP_TASK_RESULT_INTERPRETER,
  workspace: zcodeWorkspaceRegistration,
  settingsStorage: {
    hostScopedFields: ['cliPathsByHost'], projectPersistedConfig: projectZCodeModelSettings,
    needsReasoningMetadata: settings => {
      const current = getZCodeProviderSettings(settings);
      return current.visibleModels.some(id => !Array.isArray(findZCodeModel(current, id)?.reasoning));
    },
    normalizeStored(target, stored) {
      const previous = getProviderConfig(stored, 'zcode');
      updateZCodeProviderSettings(target, getZCodeProviderSettings(stored));
      return hasStoredConfigNormalization(previous, getProviderConfig(target, 'zcode'));
    },
  },
  settingsReconciler: zcodeSettingsReconciler,
};
