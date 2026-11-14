import { Injectable } from '@nestjs/common';

import { StaffActivityService } from './staff-activity.service.js';

/**
 * Staff activity's service interface for other modules (invariant 12; M57, D-1001): HR's bonus
 * rules read the mistakes an org admin confirmed through it. Nothing else crosses.
 */
export interface StaffActivityApi {
  /**
   * The brand's switch (Mistakes reduce bonuses) and, when it is on, each person's confirmed
   * mistakes in the Asia/Dhaka dates `from` to `to`: their keys and kinds. Off: an empty map.
   * Reads in transactions of its own: call it **before** opening one that holds a lock (a
   * payroll run's), so a month's recompute never runs under that lock.
   */
  confirmedMistakes(
    orgId: string,
    range: { readonly from: string; readonly to: string },
  ): Promise<{
    readonly enabled: boolean;
    readonly byUser: ReadonlyMap<
      string,
      readonly { readonly key: string; readonly kind: string }[]
    >;
  }>;
}

export const STAFF_ACTIVITY_API = Symbol('StaffActivityApi');

@Injectable()
export class StaffActivityApiService implements StaffActivityApi {
  constructor(private readonly service: StaffActivityService) {}

  confirmedMistakes(orgId: string, range: { readonly from: string; readonly to: string }) {
    return this.service.confirmedMistakes(orgId, range);
  }
}
