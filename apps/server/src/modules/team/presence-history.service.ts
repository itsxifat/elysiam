import { Injectable } from '@nestjs/common';
import { withGlobal, withOrg } from '@elysium/db';
import { sql } from 'drizzle-orm';

import * as repo from './team.repository.js';

/** How long presence history is kept (D-1005). */
export const PRESENCE_SPAN_RETENTION_DAYS = 400;

/** The presence history's retention (M57, D-1005): spans that ended over 400 days ago go. */
@Injectable()
export class PresenceHistoryService {
  async purgeAll(now: Date = new Date()): Promise<number> {
    const before = new Date(now.getTime() - PRESENCE_SPAN_RETENTION_DAYS * 86_400_000);
    const orgIds = await withGlobal(async (tx) => {
      const rows = await tx.execute<{ id: string }>(
        sql`select id from org.organizations order by slug`,
      );
      return [...rows].map((row) => row.id);
    });
    let removed = 0;
    for (const orgId of orgIds) {
      removed += await withOrg({ orgId, userId: 'system:team' }, (tx) =>
        repo.purgeSpans(tx, orgId, before),
      );
    }
    return removed;
  }
}
