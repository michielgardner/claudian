import type { ProviderModelCatalogController } from '@/core/providers/models/ProviderModelCatalog';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { ProviderWorkspaceRegistration, ProviderWorkspaceServices } from '@/core/providers/types';

import { isRecord } from '../runtime/ZCodeAppServer';
import { ZCodeCLIResolver } from '../runtime/ZCodeCLIResolver';
import { createZCodeModels } from '../runtime/ZCodeModels';
import { ZCodeRuntime, zcodeWorkspace } from '../runtime/ZCodeRuntime';
import { createZCodeSettingsTabRenderer } from '../ui/ZCodeSettingsTab';

export interface ZCodeWorkspaceServices extends ProviderWorkspaceServices {
  readonly cliResolver: ZCodeCLIResolver;
  /** The workspace's single native process, shared by every ZCode session and history read. */
  readonly zcode: ZCodeRuntime;
  readonly modelCatalog: ProviderModelCatalogController;
}

export function createZCodeWorkspaceServices(host: ProviderHost): ZCodeWorkspaceServices {
  const runtimeHost = host.getRuntimeHost('zcode');
  const cliResolver = new ZCodeCLIResolver();
  const zcode = new ZCodeRuntime(runtimeHost);
  // Native sessions are only stored once they receive a message, so a blank one reads the catalog without leaving a trace.
  const modelCatalog = createZCodeModels(runtimeHost, async signal => {
    const client = await zcode.client();
    const created = await client.call('session/create', { workspace: zcodeWorkspace(runtimeHost.workingDirectory ?? process.cwd()) }, signal);
    const sessionId = isRecord(created) && isRecord(created.session) ? created.session.sessionId : undefined;
    if (typeof sessionId === 'string') void client.call('session/close', { sessionId }).catch(() => undefined);
    return isRecord(created) ? created.settings : undefined;
  });
  // Execution leases are released before these hooks run; the process then restarts lazily with the new settings.
  const offTransition = host.executionLifecycleRegistry.registerTransitionHook('zcode', {
    beforeTransition: async () => { modelCatalog.beginTransition(); await modelCatalog.quiesce(); await zcode.restart(); },
    afterTransition: async () => { cliResolver.reset(); modelCatalog.endTransition(); },
  });
  return {
    cliResolver, zcode, modelCatalog,
    settingsTabRenderer: createZCodeSettingsTabRenderer({ cliResolver, modelCatalog }),
    async dispose() { offTransition(); await modelCatalog.dispose(); await zcode.dispose(); },
  };
}

export const zcodeWorkspaceRegistration: ProviderWorkspaceRegistration<ZCodeWorkspaceServices> = {
  initialize: async ({ plugin }) => createZCodeWorkspaceServices(plugin),
};

export function getZCodeWorkspaceServices(): ZCodeWorkspaceServices {
  return ProviderWorkspaceRegistry.requireServices('zcode') as ZCodeWorkspaceServices;
}
