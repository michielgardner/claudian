import { createConfigCatalogStore, ProviderModelCatalogController } from '@/core/providers/models/ProviderModelCatalog';
import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';

import { decodeZCodeConfig, updateZCodeConfig } from '../config';
import { encodeZCodeModelId, type ZCodeModel } from '../models';
import { isRecord } from './ZCodeAppServer';

export function createZCodeModels(host: ProviderRuntimeHost, discover: (signal: AbortSignal) => Promise<unknown>): ProviderModelCatalogController {
  return new ProviderModelCatalogController({
    providerName: 'ZCode',
    store: createConfigCatalogStore(host, {
      update: (config, _selection, patch) => { updateZCodeConfig(config, patch); },
      read: config => {
        const current = decodeZCodeConfig(config);
        return { enabled: current.enabled, selectedIds: current.visibleModels, aliases: current.modelAliases,
          models: current.discoveredModels.map(model => ({ id: model.encodedId, name: model.label, description: model.description,
            providerKey: model.provider, providerLabel: model.providerName ?? model.provider, isAvailable: model.available !== false,
          })),
        };
      },
    }),
    discover: async signal => {
      const models = decodeZCodeModelCatalog(await discover(signal));
      await host.updateConfig(config => {
        if (signal.aborted) return false;
        const current = decodeZCodeConfig(config);
        const ids = new Set(models.map(model => model.encodedId));
        const missing = current.discoveredModels.filter(model => current.visibleModels.includes(model.encodedId) && !ids.has(model.encodedId))
          .map(model => ({ ...model, available: false }));
        // A first discovery selects every native model, so ZCode is usable right after enabling it.
        const visibleModels = current.visibleModels.length > 0 ? current.visibleModels : models.map(model => model.encodedId);
        updateZCodeConfig(config, { discoveredModels: [...models, ...missing], visibleModels });
        return true;
      });
      if (signal.aborted) return { changed: false };
      host.notifyChatOptionsChanged();
      return { changed: true };
    },
  });
}

/** Native `settings.model.available` rows as Claudian models. */
export function decodeZCodeModelCatalog(settings: unknown): ZCodeModel[] {
  const model = isRecord(settings) && isRecord(settings.model) ? settings.model : null;
  if (!model || !Array.isArray(model.available)) throw new Error('ZCode did not report its models.');
  const models: ZCodeModel[] = [];
  for (const row of model.available) {
    if (!isRecord(row) || !isRecord(row.ref) || typeof row.ref.providerId !== 'string' || typeof row.ref.modelId !== 'string') continue;
    const reasoning = isRecord(row.reasoning) && Array.isArray(row.reasoning.levels) ? row.reasoning.levels.filter(isRecord) : [];
    models.push({
      encodedId: encodeZCodeModelId(row.ref.providerId, row.ref.modelId),
      provider: row.ref.providerId,
      ...(typeof row.providerLabel === 'string' && row.providerLabel ? { providerName: row.providerLabel } : {}),
      id: row.ref.modelId,
      label: typeof row.label === 'string' ? row.label : row.ref.modelId,
      reasoning: reasoning.filter(level => typeof level.value === 'string').map(level => ({
        id: level.value as string, name: typeof level.label === 'string' ? level.label : level.value as string,
      })),
      ...(isRecord(row.reasoning) && typeof row.reasoning.defaultLevel === 'string' ? { defaultReasoning: row.reasoning.defaultLevel } : {}),
      ...(typeof row.contextWindow === 'number' ? { contextWindow: row.contextWindow } : {}),
      available: true,
    });
  }
  return models;
}
