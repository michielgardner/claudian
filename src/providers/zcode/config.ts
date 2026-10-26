import { getInstallationKey } from '@/core/device/InstallationKey';
import { decodeModelAliases } from '@/core/providers/models/modelAliases';
import { normalizeHostnameStringMap } from '@/core/providers/settings/HostnameStringMap';
import { readStoredBoolean, readStoredString } from '@/core/providers/settings/storedSettings';

import { decodeZCodeModelId, normalizeZCodeModels, type ZCodeModel } from './models';

export interface ZCodeProviderSettings {
  enabled: boolean;
  cliPath: string;
  cliPathsByHost: Record<string, string>;
  environmentVariables: string;
  environmentHash: string;
  discoveredModels: ZCodeModel[];
  visibleModels: string[];
  modelAliases: Record<string, string>;
  preferredReasoningByModel: Record<string, string>;
}

export const DEFAULT_ZCODE_PROVIDER_SETTINGS: Readonly<ZCodeProviderSettings> = Object.freeze({
  enabled: false, cliPath: '', cliPathsByHost: {}, environmentVariables: '', environmentHash: '',
  discoveredModels: [], visibleModels: [], modelAliases: {}, preferredReasoningByModel: {},
});

export function decodeZCodeConfig(config: Readonly<Record<string, unknown>>): ZCodeProviderSettings {
  const visibleModels = Array.isArray(config.visibleModels)
    ? [...new Set(config.visibleModels.filter((value): value is string => typeof value === 'string' && !!decodeZCodeModelId(value)))]
    : [];
  return {
    enabled: readStoredBoolean(config.enabled, false),
    cliPath: readStoredString(config.cliPath, ''),
    cliPathsByHost: normalizeHostnameStringMap(config.cliPathsByHost),
    environmentVariables: readStoredString(config.environmentVariables, ''),
    environmentHash: readStoredString(config.environmentHash, ''),
    discoveredModels: normalizeZCodeModels(config.discoveredModels ?? config.selectedModels),
    visibleModels,
    modelAliases: normalizeModelMap(config.modelAliases),
    preferredReasoningByModel: normalizeModelMap(config.preferredReasoningByModel),
  };
}

/** Applies updates to a stored ZCode configuration in place; keys this provider does not decode are kept. */
export function updateZCodeConfig(
  config: Record<string, unknown>, updates: Partial<ZCodeProviderSettings>,
): ZCodeProviderSettings {
  const current = decodeZCodeConfig(config);
  const next = { ...current, ...updates };
  if ('cliPath' in updates && !('cliPathsByHost' in updates)) {
    next.cliPathsByHost = { ...current.cliPathsByHost };
    const key = getInstallationKey();
    const path = typeof updates.cliPath === 'string' ? updates.cliPath.trim() : '';
    if (path) next.cliPathsByHost[key] = path;
    else delete next.cliPathsByHost[key];
    next.cliPath = '';
  }
  Object.assign(config, next);
  const normalized = decodeZCodeConfig(config);
  Object.assign(config, normalized);
  return normalized;
}

function normalizeModelMap(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(decodeModelAliases(value)).filter(([id]) => !!decodeZCodeModelId(id)));
}

export function findZCodeModel(current: ZCodeProviderSettings, id: string): ZCodeModel | undefined {
  return current.discoveredModels.find(model => model.encodedId === id);
}

/** A visible model the latest native catalog still offers. */
export function isZCodeModelSelectable(current: ZCodeProviderSettings, id: string): boolean {
  const model = findZCodeModel(current, id);
  return current.visibleModels.includes(id) && !!model && model.available !== false;
}
