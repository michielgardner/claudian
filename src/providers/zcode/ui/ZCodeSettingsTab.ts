import { Setting } from 'obsidian';

import { probeCLIInstallation } from '@/core/providers/cli/CLIInstallationProbe';
import type { ProviderModelCatalogController } from '@/core/providers/models/ProviderModelCatalog';
import { getRuntimeEnvironmentVariables } from '@/core/providers/providerEnvironment';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import type { ProviderSettingsTabRenderer } from '@/core/providers/types';
import { t } from '@/i18n/i18n';
import { ZCODE_PROVIDER_ICON } from '@/shared/icons';
import { renderCLIInstallationSetting } from '@/shared/settings/CLIInstallationSetting';
import { renderEnvironmentSettingsSection } from '@/shared/settings/EnvironmentSettingsSection';
import { renderLastEnabledProviderWarning, renderProviderModelEnablementWarning } from '@/shared/settings/ProviderModelEnablementWarning';
import { renderProviderModelsSection } from '@/shared/settings/ProviderModelsSection';

import type { ZCodeCLIResolver } from '../runtime/ZCodeCLIResolver';
import { getZCodeProviderSettings, updateZCodeProviderSettings } from '../settings';

export function createZCodeSettingsTabRenderer(workspace: { cliResolver: ZCodeCLIResolver; modelCatalog: ProviderModelCatalogController }): ProviderSettingsTabRenderer {
  return {
    render(container, context) {
      const host = context.plugin;
      const settings = (): ReturnType<typeof getZCodeProviderSettings> => getZCodeProviderSettings(host.settings);
      const installation = container.createDiv({ cls: 'claudian-zcode-installation' });
      installation.createEl('p', { cls: 'setting-item-description', text: t('settings.zcode.installation.desc') });
      const warning = renderLastEnabledProviderWarning(container);
      const modelWarning = renderProviderModelEnablementWarning(container, context, { providerId: 'zcode', providerName: 'ZCode',
        getHasEnabledModels: () => settings().visibleModels.length > 0, getIsEnabled: () => settings().enabled,
      });
      renderCLIInstallationSetting({ container: installation, cliName: 'ZCode', icon: ZCODE_PROVIDER_ICON, name: t('settings.cliPath.genericName'),
        placeholder: '~/.local/bin/zcode', getValue: () => settings().cliPathsByHost[host.storage.installationKey] ?? settings().cliPath,
        inspect: async () => {
          const path = await host.getResolvedProviderCliPath('zcode');
          const configuredPath = settings().cliPathsByHost[host.storage.installationKey] ?? settings().cliPath;
          const result = await probeCLIInstallation({ path, configuredPath,
            args: ['--version'], env: { ...process.env, ...getRuntimeEnvironmentVariables(host.settings, 'zcode') },
          });
          return { ...result, source: configuredPath.trim() ? 'custom' as const : 'auto' as const };
        },
        onChange: async cliPath => {
          await host.applyProviderRuntimeSettings(['zcode'], settings => { updateZCodeProviderSettings(settings, { cliPath }); }, () => workspace.cliResolver.reset());
        },
        enablement: { name: t('settings.providerEnablement.name', { provider: 'ZCode' }), getValue: () => settings().enabled,
          onChange: async enabled => {
            if (!ProviderSettingsCoordinator.canApplyProviderEnablement(host.settings, 'zcode', enabled)) { warning.showFor(); return; }
            await host.runProviderExecutionTransition(['zcode'], async () => host.mutateSettings(settings => {
              ProviderSettingsCoordinator.applyProviderEnablement(settings, 'zcode', enabled);
            }));
            warning.hide(); modelWarning.context.notifyProviderModelOptionsChanged('zcode');
          },
        },
      });
      new Setting(container).setName(t('settings.models')).setHeading();
      const picker = renderProviderModelsSection(container, 'zcode', 'ZCode', workspace.modelCatalog, () => modelWarning.refresh());
      renderEnvironmentSettingsSection({ container, plugin: host, scope: 'provider:zcode', heading: t('settings.environment'), name: t('settings.zcode.environment.name'),
        desc: t('settings.zcode.environment.desc'),
        placeholder: 'ZCODE_BASE_URL=https://…', renderCustomContextLimits: target => context.renderCustomContextLimits(target, 'zcode'),
      });
      return picker;
    },
  };
}
