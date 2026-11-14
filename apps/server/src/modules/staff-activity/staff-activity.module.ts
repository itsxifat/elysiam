import { Module } from '@nestjs/common';

import { AuditService } from '../../platform/audit/audit.service.js';
import { CourierModule } from '../courier/courier.module.js';
import { IamDirectoryModule } from '../iam/iam.api.js';
import { InboxModule } from '../inbox/inbox.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { PackingModule } from '../packing/packing.module.js';
import { TeamModule } from '../team/team.module.js';
import { TelephonyModule } from '../telephony/telephony.module.js';
import { STAFF_ACTIVITY_API, StaffActivityApiService } from './staff-activity.api.js';
import { StaffActivityController } from './staff-activity.controller.js';
import { StaffActivityService } from './staff-activity.service.js';

/**
 * Staff activity (M57, D-1000 to D-1006): what each person did, how long, and their mistakes.
 *
 * It reads orders, the inbox, telephony, packing, the courier's returns, presence and people
 * only through their APIs (invariant 12, D-1006), and none of them imports it. HR imports it for
 * `STAFF_ACTIVITY_API`, the confirmed mistakes a bonus rule may count (D-1001).
 */
@Module({
  imports: [
    OrdersModule,
    InboxModule,
    TelephonyModule,
    PackingModule,
    CourierModule,
    TeamModule,
    IamDirectoryModule,
  ],
  controllers: [StaffActivityController],
  providers: [
    AuditService,
    StaffActivityService,
    StaffActivityApiService,
    { provide: STAFF_ACTIVITY_API, useExisting: StaffActivityApiService },
  ],
  exports: [STAFF_ACTIVITY_API],
})
export class StaffActivityModule {}
