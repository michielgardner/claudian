import { getInstallationKey } from '@/core/device/InstallationKey';
import { parseEnvironmentVariables } from '@/core/process/env';
import { getRuntimeEnvironmentText } from '@/core/providers/providerEnvironment';
import { createRuntimeInputFingerprint } from '@/core/providers/settings/RuntimeInputFingerprint';
import type { ProviderSettingsReconciler } from '@/core/providers/types';

import { getZCodeProviderSettings, updateZCodeProviderSettings } from '../settings';

export const zcodeSettingsReconciler: ProviderSettingsReconciler = {
  invalidateConversationSessions: () => [],
  reconcileModelWithEnvironment(settings) {
    const current = getZCodeProviderSettings(settings);
    const environmentText = getRuntimeEnvironmentText(settings, 'zcode');
    const environmentKeys = Object.keys(parseEnvironmentVariables(environmentText));
    const cliPath = current.cliPathsByHost[getInstallationKey()] ?? current.cliPath;
    if (!current.environmentHash && !cliPath && !environmentKeys.length) return { changed: false };
    const environmentHash = createRuntimeInputFingerprint({ environmentText, environmentKeys,
      additionalInputs: { cliPath },
    });
    if (current.environmentHash === environmentHash) return { changed: false };
    updateZCodeProviderSettings(settings, { environmentHash });
    // ZCode sessions resume across environment changes.
    return { changed: true, sessionPolicy: 'reload' };
  },
};
