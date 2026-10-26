import type { ProviderChatUIConfig } from '@/core/providers/types';
import { ZCODE_PROVIDER_ICON } from '@/shared/icons';

import { ZCODE_PERMISSION_MODE_OPTIONS } from '../permissionModes';
import { zcodeModelPolicy } from '../ZCodeModelPolicy';

export const zcodeChatUIConfig: ProviderChatUIConfig = {
  ...zcodeModelPolicy,
  getPermissionModeOptions() {
    return ZCODE_PERMISSION_MODE_OPTIONS;
  },
  getModeSelector(): null {
    return null;
  },
  getProviderIcon() {
    return ZCODE_PROVIDER_ICON;
  },
};
