import { SEED_ORG_IDS } from '@elysium/db';
import { addDays, businessDate } from '@elysium/domain';

import { seedMissedCallBack } from './staff-activity.testing.js';

/**
 * How the route-matrix suite and the cost sweep call M57's routes (D-070). The period is
 * yesterday to today in Asia/Dhaka, so a run just after midnight still finds the seeded mistake.
 * The person routes ask about the caller's own id where they can (`me`), and about a seeded
 * agent elsewhere: a role holding `read StaffActivity` at `own` is then refused by the scope with
 * a 404, which the matrix counts as an admission (the guard let it through). The review is of a
 * fresh missed call-back each time, so every admitted role's review succeeds and is audited.
 */

interface Call {
  readonly url: string;
  readonly body?: unknown;
}

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';

function period() {
  const to = businessDate(new Date());
  return { from: addDays(to, -1), to };
}

const query = () => {
  const { from, to } = period();
  return `from=${from}&to=${to}`;
};

let agent: Promise<string> | undefined;
async function anAgent(): Promise<string> {
  agent ??= seedMissedCallBack(ORG_A).then((seeded) => seeded.userId);
  return agent;
}

const SETTINGS = {
  callBackGraceMinutes: 30,
  firstReplyMinutes: 15,
  unansweredMinutes: 60,
  wrapUpMinutes: 10,
  workdayStartMinute: 540,
  workdayEndMinute: 1320,
  requireVerificationCall: true,
  showColleagueNames: true,
  mistakesReduceBonuses: false,
};

export const STAFF_ACTIVITY_ROUTE_FIXTURES: Readonly<Record<string, () => Promise<Call> | Call>> = {
  'GET /v1/staff-activity/team': () => ({ url: `/v1/staff-activity/team?${query()}` }),
  'GET /v1/staff-activity/team/export': () => ({
    url: `/v1/staff-activity/team/export?${query()}`,
  }),
  'GET /v1/staff-activity/me': () => ({ url: `/v1/staff-activity/me?${query()}` }),
  'GET /v1/staff-activity/people/:userId': async () => ({
    url: `/v1/staff-activity/people/${await anAgent()}?${query()}`,
  }),
  'GET /v1/staff-activity/people/:userId/timeline': async () => ({
    url: `/v1/staff-activity/people/${await anAgent()}/timeline?${query()}`,
  }),
  'GET /v1/staff-activity/mistakes': () => ({ url: `/v1/staff-activity/mistakes?${query()}` }),
  'PUT /v1/staff-activity/mistakes/review': async () => {
    const seeded = await seedMissedCallBack(ORG_A);
    return {
      url: '/v1/staff-activity/mistakes/review',
      body: { key: seeded.key, ...period(), status: 'confirmed', note: 'Route matrix' },
    };
  },
  'GET /v1/staff-activity/settings': () => ({ url: '/v1/staff-activity/settings' }),
  'PUT /v1/staff-activity/settings': () => ({
    url: '/v1/staff-activity/settings',
    body: SETTINGS,
  }),
};
