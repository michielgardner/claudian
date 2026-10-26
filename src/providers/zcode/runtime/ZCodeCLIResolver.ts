import { CachedProviderCLIResolver } from '@/core/providers/cli/CachedProviderCLIResolver';
import { getRuntimeEnvironmentText } from '@/core/providers/providerEnvironment';

import { getZCodeProviderSettings } from '../settings';

export class ZCodeCLIResolver {
  private readonly resolver = new CachedProviderCLIResolver({
    providerId: 'zcode', binaryName: 'zcode',
    getSettingsProjection: settings => {
      const current = getZCodeProviderSettings(settings);
      return { cliPathsByHost: current.cliPathsByHost, legacyCliPath: current.cliPath, environmentText: getRuntimeEnvironmentText(settings, 'zcode') };
    },
  });

  resolveFromSettings(settings: Record<string, unknown>): string | null { return this.resolver.resolveFromSettings(settings); }
  reset(): void { this.resolver.reset(); }
}
