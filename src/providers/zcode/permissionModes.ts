import type { ProviderToolPolicy } from '@/core/execution';
import type { ProviderPermissionModeOption, ProviderPermissionModePolicy } from '@/core/providers/types';

/** ZCode's own mode names: `build` asks before side effects, `edit` allows file edits, `yolo` never asks. */
export const ZCODE_ASK_MODE = 'build';
export const ZCODE_ACCEPT_EDITS_MODE = 'edit';
export const ZCODE_FULL_ACCESS_MODE = 'yolo';
export const ZCODE_PLAN_MODE = 'plan';

export const ZCODE_PERMISSION_MODE_POLICY: ProviderPermissionModePolicy = Object.freeze({
  values: [ZCODE_ASK_MODE, ZCODE_ACCEPT_EDITS_MODE, ZCODE_FULL_ACCESS_MODE],
  defaultValue: ZCODE_ASK_MODE,
  fallbackValue: ZCODE_ASK_MODE,
});

export const ZCODE_PERMISSION_MODE_OPTIONS: readonly ProviderPermissionModeOption[] = Object.freeze([
  { value: ZCODE_ASK_MODE, label: 'Ask', description: 'Ask before edits and commands with side effects.' },
  { value: ZCODE_ACCEPT_EDITS_MODE, label: 'Accept edits', description: 'Edit files without asking; ask before commands.' },
  { value: ZCODE_FULL_ACCESS_MODE, label: 'Full access', description: 'Run every tool without asking.', bypassesApprovals: true },
]);

/** The native mode for a request: read-only and passive work plans without side effects. */
export function zcodeNativeMode(policy: ProviderToolPolicy, permissionMode: string | undefined): string {
  if (policy.kind === 'read-only' || policy.kind === 'passive') return ZCODE_PLAN_MODE;
  return permissionMode === ZCODE_FULL_ACCESS_MODE || permissionMode === ZCODE_ACCEPT_EDITS_MODE ? permissionMode : ZCODE_ASK_MODE;
}
