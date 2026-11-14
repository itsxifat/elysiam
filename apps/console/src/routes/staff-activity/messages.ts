import type { StaffKey } from '@elysium/i18n';
import { en as staffEn } from '@elysium/i18n/locales/sections/staff.en';
import { useCallback } from 'react';

import { useLocale } from '../../i18n/locale.js';
// Before any of the keys below is read: the section that carries them.
import '../../i18n/staff.js';

/**
 * The strings staff activity's screens render (M57). The values live in the `staff` section of
 * `packages/i18n`; `{name}` placeholders are filled from `values`. The function keeps its identity
 * between renders (it changes only with the locale's `t`).
 */
export type StaffT = (key: StaffKey, values?: Readonly<Record<string, string | number>>) => string;

export function useStaffT(): StaffT {
  const { t } = useLocale();
  return useCallback<StaffT>(
    (key, values) => {
      let text = t(key);
      for (const [name, value] of Object.entries(values ?? {})) {
        text = text.split(`{${name}}`).join(String(value));
      }
      return text;
    },
    [t],
  );
}

/** A key built from a server value (a mistake's kind, a timeline line's), checked, not cast. */
export function isStaffKey(key: string): key is StaffKey {
  return Object.hasOwn(staffEn, key);
}

export type { StaffKey };
