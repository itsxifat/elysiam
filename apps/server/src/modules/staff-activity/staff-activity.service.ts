import { Inject, Injectable } from '@nestjs/common';
import type {
  MistakeReviewInput,
  StaffActivityDesk,
  StaffActivitySettingsInput,
  StaffMistakesQuery,
  StaffTeamQuery,
  StaffTimelineQuery,
} from '@elysium/contracts/staff-activity';
import { STAFF_TIMELINE_LIMIT } from '@elysium/contracts/staff-activity';
import { withOrg, type Tx } from '@elysium/db';
import { presenceState } from '@elysium/domain/assignment';
import { addDays, businessDate, daysBetween, toIsoDate, type IsoDate } from '@elysium/domain';
import {
  activeHeatmap,
  applicableReviews,
  comparison,
  detectMistakes,
  dhakaDayStart,
  isMistakeKind,
  mergeTimeline,
  mistakeCounts,
  mistakeCountsForPay,
  personFigures,
  presenceByDay,
  presenceItems,
  presenceTotals,
  roleDesk,
  teamMedians,
  type CallCounts,
  type Mistake,
  type MistakeFacts,
  type OrderCounts,
  type PackingCounts,
  type ReturnCounts,
  type PersonFigures,
  type PresenceSpan,
  type StaffActivitySettings,
  type StaffPeriod,
  type TimelineItem,
} from '@elysium/domain/staff-activity';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { assertInScope, scopeOf } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { COURIER_API, type CourierApi } from '../courier/courier.api.js';
import { IAM_API, type IamApi } from '../iam/iam.api.js';
import { INBOX_API, type InboxApi } from '../inbox/inbox.api.js';
import { toCsv, type TabularColumn } from '../orders/export/tabular.js';
import { ORDERS_API, type OrdersApi } from '../orders/orders.api.js';
import { PACKING_API, type PackingApi } from '../packing/packing.api.js';
import { TEAM_API, type TeamApi, type TeamMember } from '../team/team.api.js';
import { TELEPHONY_API, type TelephonyApi } from '../telephony/telephony.api.js';
import { StaffActivityError } from './staff-activity.errors.js';
import * as repo from './staff-activity.repository.js';

/**
 * Staff activity (M57, D-1000 to D-1006): the team table, a person's page with their comparison
 * table, their timeline, the mistakes and their reviews, and a brand's settings.
 *
 * Every figure is read from the owning module through its API at the moment of asking (D-1002,
 * D-1006); nothing here is a second copy. A period is Asia/Dhaka calendar dates `from` to `to`,
 * both included: `[start of from, start of the day after to)` on the instant.
 *
 * ## Who sees what (D-1000)
 *
 * `read StaffActivity` at `org` (org_admin, hr) sees everyone. Everyone else holds it at `own`:
 * their own page and timeline and mistakes, and the comparison table, which is built from an
 * allow-list (`comparison` in the domain): headline figures and ranks, names only when the brand
 * shows them, and no id but their own. The team table and anyone else's page refuse them.
 */

/** What a person is, on the page. */
export interface PersonView {
  readonly userId: string;
  readonly name: string;
  readonly roles: readonly string[];
  /** Still has a role in the brand. */
  readonly active: boolean;
}

interface Gathered {
  readonly people: readonly PersonView[];
  readonly figures: readonly PersonFigures[];
  readonly mistakes: readonly Mistake[];
  readonly reviews: Map<string, repo.StoredReview>;
  readonly spans: ReadonlyMap<string, readonly PresenceSpan[]>;
  readonly settings: StaffActivitySettings;
  readonly members: readonly TeamMember[];
  readonly now: Date;
}

const TIMELINE_LIMIT_PER_MODULE = STAFF_TIMELINE_LIMIT;
/** The by-day chart of a person's page reads their timeline; this bounds it. */
const BY_DAY_LIMIT_PER_MODULE = 20_000;

export function periodOf(from: string, to: string): StaffPeriod {
  const start = dhakaDayStart(toIsoDate(from));
  const end = dhakaDayStart(addDays(toIsoDate(to), 1));
  return { from: start, to: end };
}

function previousRange(from: string, to: string): { from: IsoDate; to: IsoDate } {
  const days = daysBetween(toIsoDate(from), toIsoDate(to)) + 1;
  return { from: addDays(toIsoDate(from), -days), to: addDays(toIsoDate(from), -1) };
}

@Injectable()
export class StaffActivityService {
  constructor(
    @Inject(ORDERS_API) private readonly orders: OrdersApi,
    @Inject(INBOX_API) private readonly inbox: InboxApi,
    @Inject(TELEPHONY_API) private readonly telephony: TelephonyApi,
    @Inject(PACKING_API) private readonly packing: PackingApi,
    @Inject(COURIER_API) private readonly courier: CourierApi,
    @Inject(TEAM_API) private readonly team: TeamApi,
    @Inject(IAM_API) private readonly iam: IamApi,
    private readonly audit: AuditService,
  ) {}

  // --- gathering -------------------------------------------------------------------------

  /** The brand's people: everyone with a role now, and anyone else the facts name. */
  private async peopleOf(
    tx: Tx,
    orgId: string,
    members: readonly TeamMember[],
    named: Iterable<string>,
  ): Promise<PersonView[]> {
    const people = new Map<string, PersonView>(
      members.map((member) => [
        member.userId,
        { userId: member.userId, name: member.name, roles: member.roles, active: true },
      ]),
    );
    const missing = [...new Set(named)].filter((id) => !people.has(id));
    if (missing.length > 0) {
      const book = await this.iam.nameBook(tx, orgId);
      for (const userId of missing) {
        people.set(userId, {
          userId,
          name: book.get(userId) ?? '',
          roles: [],
          active: false,
        });
      }
    }
    return [...people.values()];
  }

  /** One read in its own transaction, so the modules' reads run side by side (check 5). */
  private read<T>(orgId: string, userId: string, work: (tx: Tx) => Promise<T>): Promise<T> {
    return withOrg({ orgId, userId }, work);
  }

  /** The brand's thresholds and the database's clock, read once per request. */
  private async basics(orgId: string, userId: string) {
    return this.read(orgId, userId, async (tx) => ({
      now: await repo.transactionNow(tx),
      settings: await repo.settingsOrDefaults(tx, orgId),
    }));
  }

  /**
   * Everything every module says of the period: the counts (unless `counts` is false) and the
   * mistake rules' facts. Each module reads in a transaction of its own, all at once, so a team
   * table waits for the slowest module rather than for the sum of them (M57 check 5); a report
   * read moments apart across modules is no less true than one read in one snapshot.
   */
  private async collect(
    orgId: string,
    userId: string,
    period: StaffPeriod,
    settings: StaffActivitySettings,
    counts: boolean,
  ) {
    const none = <T>() => new Map<string, T>() as ReadonlyMap<string, T>;
    const longer = Math.min(settings.firstReplyMinutes, settings.unansweredMinutes);
    const [orders, inbox, calls, packing, returns, team] = await Promise.all([
      this.read(orgId, userId, async (tx) => ({
        counts: counts ? await this.orders.staffCounts(tx, orgId, period) : none<OrderCounts>(),
        facts: await this.orders.staffMistakeFacts(tx, orgId, period),
      })),
      this.read(orgId, userId, (tx) => this.inbox.staffFacts(tx, orgId, period, longer)),
      this.read(orgId, userId, async (tx) => ({
        counts: counts ? await this.telephony.staffCounts(tx, orgId, period) : none<CallCounts>(),
        facts: await this.telephony.staffMistakeFacts(tx, orgId, period, settings.wrapUpMinutes),
      })),
      this.read(orgId, userId, async (tx) => ({
        counts: counts ? await this.packing.staffCounts(tx, orgId, period) : none<PackingCounts>(),
        facts: await this.packing.staffMistakeFacts(tx, orgId, period),
      })),
      counts
        ? this.read(orgId, userId, (tx) => this.courier.staffCounts(tx, orgId, period))
        : Promise.resolve(none<ReturnCounts>()),
      this.read(orgId, userId, async (tx) => ({
        members: await this.team.members(tx, orgId),
        spans: await this.team.presenceSpans(tx, orgId, period),
      })),
    ]);
    const wrongItemOrders = orders.facts.returns
      .filter((row) => row.reasonCode === 'wrong_item')
      .map((row) => row.orderId);
    const [packers, phonedOrders] = await Promise.all([
      this.read(orgId, userId, (tx) => this.packing.packersOf(tx, orgId, wrongItemOrders)),
      this.read(orgId, userId, (tx) =>
        this.telephony.phonedOrders(
          tx,
          orgId,
          orders.facts.confirmations.map((row) => row.orderId),
        ),
      ),
    ]);
    const facts: MistakeFacts = {
      wrongScans: packing.facts.wrongScans,
      returns: orders.facts.returns,
      packers,
      confirmations: orders.facts.confirmations,
      phonedOrders,
      cancelsAfterConfirm: orders.facts.cancelsAfterConfirm,
      callBacks: orders.facts.callBacks,
      waits: inbox.waits,
      missedCalls: calls.facts.missedCalls,
      unwrappedCalls: calls.facts.unwrappedCalls,
      expiredOffers: [...orders.facts.expiredOffers, ...inbox.expiredOffers],
      noVideo: packing.facts.noVideo,
    };
    return {
      orderCounts: orders.counts,
      inboxCounts: inbox.counts,
      callCounts: calls.counts,
      packingCounts: packing.counts,
      returnCounts: returns,
      members: team.members,
      spans: team.spans,
      facts,
    };
  }

  /** The period's mistakes (those that fall inside it) and their reviews, with what they rest on. */
  private async mistakesIn(orgId: string, userId: string, period: StaffPeriod) {
    const { now, settings } = await this.basics(orgId, userId);
    const collected = await this.collect(orgId, userId, period, settings, false);
    const mistakes = detectMistakes({
      facts: collected.facts,
      settings,
      spans: collected.spans,
      now,
    }).filter((mistake) => mistake.at >= period.from && mistake.at < period.to);
    const stored = await this.read(orgId, userId, (tx) =>
      repo.reviewsOf(
        tx,
        orgId,
        mistakes.map((mistake) => mistake.key),
      ),
    );
    // A review answers only for the person it was made against (D-1017).
    const reviews = applicableReviews(mistakes, stored);
    return { mistakes, reviews, settings, members: collected.members, now };
  }

  private async gather(orgId: string, userId: string, period: StaffPeriod): Promise<Gathered> {
    const { now, settings } = await this.basics(orgId, userId);
    const c = await this.collect(orgId, userId, period, settings, true);
    const mistakes = detectMistakes({ facts: c.facts, settings, spans: c.spans, now }).filter(
      (mistake) => mistake.at >= period.from && mistake.at < period.to,
    );
    const named = [
      ...c.spans.keys(),
      ...c.orderCounts.keys(),
      ...c.inboxCounts.keys(),
      ...c.callCounts.keys(),
      ...c.packingCounts.keys(),
      ...c.returnCounts.keys(),
      ...mistakes.map((mistake) => mistake.userId),
    ];
    const { stored, people } = await this.read(orgId, userId, async (tx) => ({
      stored: await repo.reviewsOf(
        tx,
        orgId,
        mistakes.map((mistake) => mistake.key),
      ),
      people: await this.peopleOf(tx, orgId, c.members, named),
    }));
    // A review answers only for the person it was made against (D-1017).
    const reviews = applicableReviews(mistakes, stored);

    const counting = new Map<string, number>();
    for (const mistake of mistakes) {
      if (!mistakeCounts(reviews.get(mistake.key))) continue;
      counting.set(mistake.userId, (counting.get(mistake.userId) ?? 0) + 1);
    }
    // A person who left and did nothing in the period is not listed.
    const anything = new Set(named);
    const listed = people.filter((person) => person.active || anything.has(person.userId));

    const figures = listed.map((person) => {
      const orders = c.orderCounts.get(person.userId);
      const inbox = c.inboxCounts.get(person.userId);
      const calls = c.callCounts.get(person.userId);
      const packing = c.packingCounts.get(person.userId);
      const returns = c.returnCounts.get(person.userId);
      return personFigures({
        userId: person.userId,
        presence: presenceTotals(c.spans.get(person.userId) ?? [], period.from, period.to),
        ...(orders === undefined ? {} : { orders }),
        ...(inbox === undefined ? {} : { inbox }),
        ...(calls === undefined ? {} : { calls }),
        ...(packing === undefined ? {} : { packing }),
        ...(returns === undefined ? {} : { returns }),
        mistakes: counting.get(person.userId) ?? 0,
      });
    });
    return {
      people: listed,
      figures,
      mistakes,
      reviews,
      spans: c.spans,
      settings,
      members: c.members,
      now,
    };
  }

  private seesEveryone(request: object): boolean {
    return scopeOf(request).kind === 'all';
  }

  /** Refuse anyone who may read only their own (`own`) a person who is not them: 404. */
  private assertMayRead(context: ActiveContext, request: object, userId: string): void {
    // The `own` conditions are `createdBy` or `assignedTo` equal to the caller: a person's page
    // is "assigned to" that person.
    assertInScope(request, { assignedTo: userId, createdBy: userId });
    void context;
  }

  // --- the team table --------------------------------------------------------------------

  async teamTable(context: ActiveContext, request: object, query: StaffTeamQuery) {
    if (!this.seesEveryone(request)) {
      throw new StaffActivityError(
        'STAFF_ACTIVITY_TEAM_ONLY',
        'The team table is for supervisors; your own page has your desk’s comparison.',
      );
    }
    const period = periodOf(query.from, query.to);
    {
      const gathered = await this.gather(context.orgId, context.userId, period);
      const desk = query.desk ?? null;
      const byId = new Map(gathered.people.map((person) => [person.userId, person]));
      const rows = gathered.figures.filter(
        (figures) =>
          desk === null ||
          figures.desks.includes(desk) ||
          (figures.desks.length === 0 && roleDesk(byId.get(figures.userId)?.roles ?? []) === desk),
      );
      return {
        from: query.from,
        to: query.to,
        desk,
        people: rows.map((figures) => ({
          person: byId.get(figures.userId) ?? null,
          figures: figuresView(figures),
        })),
        medians: teamMedians(rows),
        mistakesByKind: countByKind(
          gathered.mistakes.filter(
            (mistake) =>
              mistakeCounts(gathered.reviews.get(mistake.key)) &&
              rows.some((row) => row.userId === mistake.userId),
          ),
        ),
      };
    }
  }

  async teamCsv(context: ActiveContext, request: AuditableRequest, query: StaffTeamQuery) {
    const table = await this.teamTable(context, request, query);
    // Every person's hours and mistakes by name leave the ERP: audited, as other exports are.
    await withOrg({ orgId: context.orgId, userId: context.userId }, (tx) =>
      this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'create',
        action: 'staff_activity.exported',
        entityType: 'staff_activity_export',
        entityId: `${query.from}:${query.to}:${query.desk ?? 'all'}`,
        after: {
          from: query.from,
          to: query.to,
          desk: query.desk ?? null,
          rows: table.people.length,
        },
        requestId: context.requestId,
        request,
      }),
    );
    const columns: TabularColumn[] = [
      { header: 'Name', kind: 'text' },
      { header: 'Online (h)', kind: 'number' },
      { header: 'Active (h)', kind: 'number' },
      { header: 'Idle (h)', kind: 'number' },
      { header: 'Orders taken', kind: 'number' },
      { header: 'Orders confirmed', kind: 'number' },
      { header: 'Orders cancelled', kind: 'number' },
      { header: 'Pieces confirmed', kind: 'number' },
      { header: 'Call attempts', kind: 'number' },
      { header: 'Messages sent', kind: 'number' },
      { header: 'Median first reply (min)', kind: 'number' },
      { header: 'Calls', kind: 'number' },
      { header: 'Talk time (min)', kind: 'number' },
      { header: 'Packed', kind: 'number' },
      { header: 'Pieces packed', kind: 'number' },
      { header: 'Returns closed', kind: 'number' },
      { header: 'Returns received', kind: 'number' },
      { header: 'Mistakes', kind: 'number' },
      { header: 'Mistakes per 100 actions', kind: 'number' },
    ];
    const hours = (ms: number) => Math.round(ms / 36_000) / 100;
    const rows = table.people.map(({ person, figures }) => [
      person?.name ?? '',
      hours(figures.presence.onlineMs),
      hours(figures.presence.activeMs),
      hours(figures.presence.idleMs),
      figures.orders.taken,
      figures.orders.confirmed,
      figures.orders.cancelled,
      figures.orders.piecesConfirmed,
      figures.orders.callAttempts,
      figures.inbox.messagesSent,
      figures.inbox.medianFirstReplySeconds === null
        ? null
        : Math.round(figures.inbox.medianFirstReplySeconds / 6) / 10,
      figures.calls.outbound + figures.calls.answered,
      Math.round(figures.calls.talkSeconds / 6) / 10,
      figures.packing.packed,
      figures.packing.piecesPacked,
      figures.packing.returnsClosed,
      figures.returns.received,
      figures.mistakes,
      figures.mistakeRateTenths === null ? null : figures.mistakeRateTenths / 10,
    ]);
    return {
      filename: `staff-activity-${query.from}-to-${query.to}.csv`,
      csv: toCsv(columns, rows),
    };
  }

  // --- a person's page -------------------------------------------------------------------

  async person(
    context: ActiveContext,
    request: object,
    userId: string,
    query: { readonly from: string; readonly to: string; readonly desk?: StaffActivityDesk },
  ) {
    this.assertMayRead(context, request, userId);
    const period = periodOf(query.from, query.to);
    const previous = previousRange(query.from, query.to);
    const gathered = await this.gather(context.orgId, context.userId, period);
    const person = gathered.people.find((p) => p.userId === userId);
    const figures = gathered.figures.find((f) => f.userId === userId);
    if (person === undefined || figures === undefined) {
      throw new StaffActivityError('STAFF_ACTIVITY_NOT_FOUND', 'No such person in this brand.');
    }
    // One after the other, not at once: each gather already holds six connections.
    const before = await this.gather(
      context.orgId,
      context.userId,
      periodOf(previous.from, previous.to),
    );
    const beforeFigures = before.figures.find((f) => f.userId === userId) ?? null;

    const spans = gathered.spans.get(userId) ?? [];
    const items = await this.timelineItems(
      context.orgId,
      context.userId,
      userId,
      period,
      BY_DAY_LIMIT_PER_MODULE,
    );
    const days = presenceByDay(spans, toIsoDate(query.from), toIsoDate(query.to)).map((day) => ({
      date: day.date,
      onlineMs: day.totals.onlineMs,
      activeMs: day.totals.activeMs,
      idleMs: day.totals.idleMs,
      firstSeenAt: day.totals.firstSeenAt?.toISOString() ?? null,
      lastSeenAt: day.totals.lastSeenAt?.toISOString() ?? null,
      actions: countActionsByDesk(items.filter((item) => businessDate(item.at) === day.date)),
      mistakes: gathered.mistakes.filter(
        (m) =>
          m.userId === userId &&
          businessDate(m.at) === day.date &&
          mistakeCounts(gathered.reviews.get(m.key)),
      ).length,
    }));

    const member = gathered.members.find((m) => m.userId === userId);
    const live = member === undefined ? null : presenceState(member.presence, gathered.now);

    const names = new Map(gathered.people.map((p) => [p.userId, p.name]));
    const everyone = this.seesEveryone(request);
    const compared = comparison({
      people: gathered.figures,
      names,
      viewerId: userId,
      // A supervisor reading someone's page sees the names; staff by the brand's setting.
      showNames: everyone || gathered.settings.showColleagueNames,
      revealIds: everyone,
      // Staff compare on their own desk, whatever the address asks for (D-1000).
      desk: everyone ? (query.desk ?? null) : null,
      fallbackDesk: roleDesk(person.roles),
    });

    const mine = gathered.mistakes.filter(
      (m) => m.userId === userId && mistakeCounts(gathered.reviews.get(m.key)),
    );
    return {
      from: query.from,
      to: query.to,
      person,
      figures: figuresView(figures),
      previous: beforeFigures === null ? null : figuresView(beforeFigures),
      medians: teamMedians(gathered.figures),
      days,
      heatmap: activeHeatmap(spans),
      live:
        live === null
          ? null
          : { state: live.state, paused: live.paused, available: live.available },
      // Only a supervisor learns whose a row is; staff only their own (D-1000).
      comparison: compared,
      mistakes: { total: mine.length, byKind: countByKind(mine) },
    };
  }

  // --- the timeline ----------------------------------------------------------------------

  private async timelineItems(
    orgId: string,
    viewerId: string,
    userId: string,
    period: StaffPeriod,
    limit: number,
  ): Promise<TimelineItem[]> {
    const parts = await Promise.all([
      this.read(orgId, viewerId, (tx) =>
        this.orders.staffTimeline(tx, orgId, userId, period, limit),
      ),
      this.read(orgId, viewerId, (tx) =>
        this.inbox.staffTimeline(tx, orgId, userId, period, limit),
      ),
      this.read(orgId, viewerId, (tx) =>
        this.telephony.staffTimeline(tx, orgId, userId, period, limit),
      ),
      this.read(orgId, viewerId, (tx) =>
        this.packing.staffTimeline(tx, orgId, userId, period, limit),
      ),
      this.read(orgId, viewerId, (tx) =>
        this.courier.staffTimeline(tx, orgId, userId, period, limit),
      ),
    ]);
    return parts.flat();
  }

  async timeline(
    context: ActiveContext,
    request: object,
    userId: string,
    query: StaffTimelineQuery,
  ) {
    this.assertMayRead(context, request, userId);
    const period = periodOf(query.from, query.to);
    const [spans, items] = await Promise.all([
      this.read(context.orgId, context.userId, (tx) =>
        this.team.presenceSpans(tx, context.orgId, { ...period, userId }),
      ),
      this.timelineItems(context.orgId, context.userId, userId, period, TIMELINE_LIMIT_PER_MODULE),
    ]);
    const presence = presenceItems(spans.get(userId) ?? []).filter(
      (item) => item.at >= period.from && item.at < period.to,
    );
    const merged = mergeTimeline([items, presence], STAFF_TIMELINE_LIMIT);
    return {
      from: query.from,
      to: query.to,
      truncated: merged.truncated,
      items: merged.items.map((item) => ({ ...item, at: item.at.toISOString() })),
    };
  }

  // --- mistakes --------------------------------------------------------------------------

  async mistakes(context: ActiveContext, request: object, query: StaffMistakesQuery) {
    const everyone = this.seesEveryone(request);
    const userId = query.userId ?? (everyone ? null : context.userId);
    if (userId !== null) this.assertMayRead(context, request, userId);
    if (query.kind !== undefined && !isMistakeKind(query.kind)) {
      return { from: query.from, to: query.to, items: [] };
    }
    const period = periodOf(query.from, query.to);
    const { mistakes, reviews, members } = await this.mistakesIn(
      context.orgId,
      context.userId,
      period,
    );
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const chosen = mistakes.filter((mistake) => {
        if (userId !== null && mistake.userId !== userId) return false;
        if (query.kind !== undefined && mistake.kind !== query.kind) return false;
        const review = reviews.get(mistake.key);
        if (query.status === 'unreviewed') return review === undefined;
        if (query.status !== undefined) return review?.status === query.status;
        return true;
      });
      const people = await this.peopleOf(
        tx,
        context.orgId,
        members,
        chosen.map((m) => m.userId),
      );
      const nameOf = new Map(people.map((p) => [p.userId, p.name]));
      const reviewerIds = [...reviews.values()].map((r) => r.reviewedBy);
      const reviewers =
        reviewerIds.length === 0
          ? new Map<string, string>()
          : await this.iam.nameBook(tx, context.orgId);
      return {
        from: query.from,
        to: query.to,
        items: chosen.map((mistake) => {
          const review = reviews.get(mistake.key);
          return {
            ...mistake,
            at: mistake.at.toISOString(),
            name: nameOf.get(mistake.userId) ?? '',
            review:
              review === undefined
                ? null
                : {
                    status: review.status,
                    note: review.note,
                    reviewedBy: reviewers.get(review.reviewedBy) ?? '',
                    reviewedAt: review.reviewedAt.toISOString(),
                  },
          };
        }),
      };
    });
  }

  /**
   * An org admin's word on one mistake. The mistake is found again over the period it was shown
   * in, so whose it is and what kind come from the rules, never from the request.
   */
  async review(
    context: ActiveContext,
    request: AuditableRequest,
    input: MistakeReviewInput & {
      readonly key: string;
      readonly from: string;
      readonly to: string;
    },
  ) {
    const period = periodOf(input.from, input.to);
    const { mistakes, now } = await this.mistakesIn(context.orgId, context.userId, period);
    const mistake = mistakes.find((m) => m.key === input.key);
    if (mistake === undefined) {
      throw new StaffActivityError(
        'STAFF_ACTIVITY_NOT_FOUND',
        'That mistake is not in this period any more.',
      );
    }
    if (mistake.userId === context.userId) {
      throw new StaffActivityError(
        'STAFF_ACTIVITY_OWN_MISTAKE',
        'Another org admin reviews your own mistakes.',
      );
    }
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const before = await repo.reviewFor(tx, context.orgId, mistake.key);
      const note =
        input.note === undefined || input.note === null || input.note === '' ? null : input.note;
      const review: repo.StoredReview = {
        key: mistake.key,
        kind: mistake.kind,
        userId: mistake.userId,
        status: input.status,
        note,
        reviewedBy: context.userId,
        reviewedAt: now,
      };
      await repo.saveReview(tx, context.orgId, review);
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: before === undefined ? 'create' : 'update',
        action: 'staff_activity.mistake_reviewed',
        entityType: 'staff_activity.mistake_review',
        entityId: mistake.key,
        before:
          before === undefined
            ? null
            : { status: before.status, note: before.note, userId: before.userId },
        after: {
          status: review.status,
          note: review.note,
          userId: review.userId,
          kind: review.kind,
        },
        requestId: context.requestId,
        request,
      });
      return {
        key: mistake.key,
        status: review.status,
        note: review.note,
        reviewedAt: review.reviewedAt.toISOString(),
      };
    });
  }

  // --- settings --------------------------------------------------------------------------

  async settings(context: ActiveContext) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const stored = await repo.settingsOf(tx, context.orgId);
      return {
        ...(stored ?? (await repo.settingsOrDefaults(tx, context.orgId))),
        saved: stored !== null,
      };
    });
  }

  async saveSettings(
    context: ActiveContext,
    request: AuditableRequest,
    input: StaffActivitySettingsInput,
  ) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const before = await repo.settingsOf(tx, context.orgId);
      await repo.saveSettings(tx, context.orgId, input, context.userId);
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: before === null ? 'create' : 'update',
        action: 'staff_activity.settings_updated',
        entityType: 'staff_activity.settings',
        entityId: context.orgId,
        before: before === null ? null : { ...before },
        after: { ...input },
        requestId: context.requestId,
        request,
      });
      return { ...input, saved: true };
    });
  }

  // --- for HR (D-1001) --------------------------------------------------------------------

  /**
   * The mistakes an org admin confirmed in a period, per person, by kind: what a bonus rule's
   * `mistakes` block may take off (D-1001). Unreviewed and dismissed ones never count for pay.
   * Also says whether the brand's switch is on.
   */
  async confirmedMistakes(
    orgId: string,
    range: { readonly from: string; readonly to: string },
  ): Promise<{
    readonly enabled: boolean;
    readonly byUser: ReadonlyMap<
      string,
      readonly { readonly key: string; readonly kind: string }[]
    >;
  }> {
    const actor = 'system:staff-activity';
    const settings = await this.read(orgId, actor, (tx) => repo.settingsOrDefaults(tx, orgId));
    if (!settings.mistakesReduceBonuses) return { enabled: false, byUser: new Map() };
    const { mistakes, reviews } = await this.mistakesIn(
      orgId,
      actor,
      periodOf(range.from, range.to),
    );
    const byUser = new Map<string, { key: string; kind: string }[]>();
    for (const mistake of mistakes) {
      if (!mistakeCountsForPay(reviews.get(mistake.key))) continue;
      const list = byUser.get(mistake.userId) ?? [];
      list.push({ key: mistake.key, kind: mistake.kind });
      byUser.set(mistake.userId, list);
    }
    return { enabled: true, byUser };
  }
}

// --- views -------------------------------------------------------------------------------

function figuresView(figures: PersonFigures) {
  return {
    ...figures,
    orders: {
      ...figures.orders,
      valueConfirmedPoisha: figures.orders.valueConfirmedPoisha.toString(),
    },
    presence: {
      ...figures.presence,
      firstSeenAt: figures.presence.firstSeenAt?.toISOString() ?? null,
      lastSeenAt: figures.presence.lastSeenAt?.toISOString() ?? null,
    },
  };
}

function countByKind(mistakes: readonly Mistake[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const mistake of mistakes) counts[mistake.kind] = (counts[mistake.kind] ?? 0) + 1;
  return counts;
}

function countActionsByDesk(items: readonly TimelineItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    if (item.desk === 'presence') continue;
    counts[item.desk] = (counts[item.desk] ?? 0) + 1;
  }
  return counts;
}
