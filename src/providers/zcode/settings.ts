import { selectModelMetadata } from '@/core/providers/models/selectedModelMetadata';
import { getProviderConfig, setProviderConfig } from '@/core/providers/providerConfig';

import { decodeZCodeConfig, updateZCodeConfig,type ZCodeProviderSettings } from './config';

/** Reads ZCode's configuration from the settings document. */
export function getZCodeProviderSettings(settings: Record<string, unknown>): ZCodeProviderSettings {
  return decodeZCodeConfig(getProviderConfig(settings, 'zcode'));
}

/** Writes ZCode's configuration into the settings document. */
export function updateZCodeProviderSettings(
  settings: Record<string, unknown>, updates: Partial<ZCodeProviderSettings>,
): ZCodeProviderSettings {
  const config = getProviderConfig(settings, 'zcode');
  const next = updateZCodeConfig(config, updates);
  setProviderConfig(settings, 'zcode', config);
  return next;
}

export function projectZCodeModelSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const current = getZCodeProviderSettings(settings);
  const selected = new Set(current.visibleModels);
  const config: Record<string, unknown> = {
    ...getProviderConfig(settings, 'zcode'), ...current,
    selectedModels: current.discoveredModels.filter(model => selected.has(model.encodedId)),
    modelAliases: selectModelMetadata(current.modelAliases, selected),
    preferredReasoningByModel: selectModelMetadata(current.preferredReasoningByModel, selected),
  };
  delete config.discoveredModels;
  return config;
}
