import { DEFAULT_REASONING_VALUE } from '@/core/providers/reasoning';
import type { ProviderModelPolicy } from '@/core/providers/types';

import { findZCodeModel, isZCodeModelSelectable } from './config';
import { decodeZCodeModelId } from './models';
import { ZCODE_PERMISSION_MODE_POLICY } from './permissionModes';
import { getZCodeProviderSettings, updateZCodeProviderSettings } from './settings';

export const zcodeModelPolicy: ProviderModelPolicy = {
  permissionModes: ZCODE_PERMISSION_MODE_POLICY,
  ownsModel: model => decodeZCodeModelId(model) !== null,
  isDefaultModel: model => decodeZCodeModelId(model) !== null,
  getModelOptions(settings) {
    const current = getZCodeProviderSettings(settings);
    return current.visibleModels.map(id => {
      const model = findZCodeModel(current, id);
      return {
        value: id,
        label: model && model.available !== false
          ? current.modelAliases[id] ?? model.label : `${current.modelAliases[id] ?? model?.label ?? id} (unavailable)`,
        group: model?.providerName ?? model?.provider,
        description: model?.description,
      };
    });
  },
  getDefaultModel(settings) {
    const current = getZCodeProviderSettings(settings);
    return current.visibleModels.find(id => isZCodeModelSelectable(current, id)) ?? null;
  },
  supportsReasoningEffort(model, settings) {
    return (findZCodeModel(getZCodeProviderSettings(settings), model)?.reasoning?.length ?? 0) > 0;
  },
  getReasoningOptions(model, settings) {
    return (findZCodeModel(getZCodeProviderSettings(settings), model)?.reasoning ?? [])
      .map(effort => ({ value: effort.id, label: effort.name, ...(effort.description ? { description: effort.description } : {}) }));
  },
  getDefaultReasoningValue(model, settings) {
    const current = getZCodeProviderSettings(settings);
    const efforts = findZCodeModel(current, model)?.reasoning ?? [];
    const preferred = current.preferredReasoningByModel[model];
    if (preferred && efforts.some(effort => effort.id === preferred)) return preferred;
    return findZCodeModel(current, model)?.defaultReasoning ?? efforts.at(-1)?.id ?? DEFAULT_REASONING_VALUE;
  },
  applyModelDefaults(model, settings) {
    if (!settings || typeof settings !== 'object') return;
    const bag = settings as Record<string, unknown>;
    bag.model = model;
    bag.effortLevel = zcodeModelPolicy.getDefaultReasoningValue(model, bag);
  },
  applyModelProjectionDefaults(model, settings) {
    if (!settings || typeof settings !== 'object') return;
    const bag = settings as Record<string, unknown>;
    const value = getZCodeProviderSettings(bag).preferredReasoningByModel[model];
    if (value) bag.effortLevel = value;
  },
  applyReasoningSelection(model, value, settings) {
    if (!settings || typeof settings !== 'object' || !decodeZCodeModelId(model)) return;
    const bag = settings as Record<string, unknown>;
    updateZCodeProviderSettings(bag, {
      preferredReasoningByModel: { ...getZCodeProviderSettings(bag).preferredReasoningByModel, [model]: value },
    });
  },
  normalizeModelVariant: model => model,
  getCustomModelIds: () => new Set(),
};
