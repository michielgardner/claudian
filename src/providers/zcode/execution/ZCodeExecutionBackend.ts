import type { ProviderExecutionBackend, ProviderExecutionSession, ProviderSessionConfig } from '@/core/execution';

import type { ZCodeRuntime } from '../runtime/ZCodeRuntime';
import { ZCodeExecutionSession } from './ZCodeExecutionSession';

export class ZCodeExecutionBackend implements ProviderExecutionBackend {
  readonly providerId = 'zcode' as const;

  constructor(private readonly resolveRuntime: () => ZCodeRuntime) {}

  createSession(config: ProviderSessionConfig): ProviderExecutionSession {
    return new ZCodeExecutionSession(config, this.resolveRuntime());
  }
}
