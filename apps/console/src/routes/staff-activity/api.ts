import type {
  MistakeReviewInput,
  StaffActivityDesk,
  StaffActivitySettingsInput,
} from '@elysium/contracts/staff-activity';

import { api } from '../../api.js';
import { env } from '../../env.js';

/**
 * Staff activity (M57, D-1000 to D-1006): the endpoints the console calls, typed to what the
 * server returns. No shape here carries a phone number, a message's words or a cost.
 */

export const STAFF_KEY = ['staff-activity'] as const;

export type Desk = StaffActivityDesk;

export interface PresenceFigures {
  readonly activeMs: number;
  readonly idleMs: number;
  readonly pausedMs: number;
  readonly onlineMs: number;
  readonly offlineMs: number;
  readonly firstSeenAt: string | null;
  readonly lastSeenAt: string | null;
}

export interface Figures {
  readonly userId: string;
  readonly presence: PresenceFigures;
  readonly orders: {
    readonly created: number;
    readonly taken: number;
    readonly confirmed: number;
    readonly cancelled: number;
    readonly piecesConfirmed: number;
    readonly valueConfirmedPoisha: string;
    readonly confirmedDelivered: number;
    readonly confirmedReturned: number;
    readonly callAttempts: number;
    readonly callsReached: number;
    readonly offersAccepted: number;
    readonly offersDeclined: number;
    readonly offersExpired: number;
    readonly returnsRecorded: number;
  };
  readonly inbox: {
    readonly messagesSent: number;
    readonly conversations: number;
    readonly notes: number;
    readonly firstReplies: number;
    readonly medianFirstReplySeconds: number | null;
  };
  readonly calls: {
    readonly outbound: number;
    readonly inbound: number;
    readonly answered: number;
    readonly missed: number;
    readonly talkSeconds: number;
    readonly wrappedUp: number;
  };
  readonly packing: {
    readonly packed: number;
    readonly piecesPacked: number;
    readonly medianPackSeconds: number | null;
    readonly wrongScans: number;
    readonly lotsClosed: number;
    readonly handoverScans: number;
    readonly labelsPrinted: number;
    readonly reprints: number;
    readonly returnsClosed: number;
    readonly piecesReturned: number;
  };
  readonly returns: {
    readonly received: number;
    readonly piecesReceived: number;
    readonly damagedPieces: number;
  };
  readonly actions: number;
  readonly mistakes: number;
  readonly mistakeRateTenths: number | null;
  readonly deliveryRateBps: number | null;
  readonly desks: readonly Desk[];
}

export type HeadlineFigure =
  | 'activeMs'
  | 'onlineMs'
  | 'ordersConfirmed'
  | 'piecesConfirmed'
  | 'messagesSent'
  | 'calls'
  | 'talkSeconds'
  | 'packed'
  | 'piecesPacked'
  | 'returnsReceived'
  | 'returnsClosed'
  | 'mistakeRateTenths';

export type Medians = Readonly<Record<HeadlineFigure, number | null>>;

export interface Person {
  readonly userId: string;
  readonly name: string;
  readonly roles: readonly string[];
  readonly active: boolean;
}

export interface TeamTable {
  readonly from: string;
  readonly to: string;
  readonly desk: Desk | null;
  readonly people: readonly { readonly person: Person | null; readonly figures: Figures }[];
  readonly medians: Medians;
  readonly mistakesByKind: Readonly<Record<string, number>>;
}

export interface ComparisonRow {
  readonly name: string | null;
  readonly colleagueNo: number | null;
  readonly isViewer: boolean;
  readonly userId: string | null;
  readonly figures: Readonly<Record<HeadlineFigure, number | null>>;
  readonly ranks: Readonly<Record<HeadlineFigure, number | null>>;
}

export interface PersonPage {
  readonly from: string;
  readonly to: string;
  readonly person: Person;
  readonly figures: Figures;
  readonly previous: Figures | null;
  readonly medians: Medians;
  readonly days: readonly {
    readonly date: string;
    readonly onlineMs: number;
    readonly activeMs: number;
    readonly idleMs: number;
    readonly firstSeenAt: string | null;
    readonly lastSeenAt: string | null;
    readonly actions: Readonly<Partial<Record<Desk, number>>>;
    readonly mistakes: number;
  }[];
  /** Active minutes by Asia/Dhaka weekday (0 Sunday) and hour. */
  readonly heatmap: readonly (readonly number[])[];
  readonly live: {
    readonly state: 'active' | 'idle' | 'away';
    readonly paused: boolean;
    readonly available: boolean;
  } | null;
  readonly comparison: { readonly desk: Desk | null; readonly rows: readonly ComparisonRow[] };
  readonly mistakes: { readonly total: number; readonly byKind: Readonly<Record<string, number>> };
}

export interface StaffRef {
  readonly type: 'order' | 'conversation' | 'call' | 'packing_session';
  readonly id: string;
  readonly label: string | null;
}

export interface TimelineItem {
  readonly id: string;
  readonly at: string;
  readonly desk: Desk | 'presence';
  readonly kind: string;
  readonly ref: StaffRef | null;
  readonly detail: Readonly<Record<string, string | number>>;
}

export interface Timeline {
  readonly from: string;
  readonly to: string;
  readonly truncated: boolean;
  readonly items: readonly TimelineItem[];
}

export type MistakeSeverity = 'low' | 'medium' | 'high';

export interface MistakeItem {
  readonly key: string;
  readonly kind: string;
  readonly severity: MistakeSeverity;
  readonly desk: Desk;
  readonly userId: string;
  readonly name: string;
  readonly at: string;
  readonly ref: StaffRef;
  readonly detail: Readonly<Record<string, string | number>>;
  readonly review: {
    readonly status: 'confirmed' | 'dismissed';
    readonly note: string | null;
    readonly reviewedBy: string;
    readonly reviewedAt: string;
  } | null;
}

export interface StaffSettings extends StaffActivitySettingsInput {
  readonly saved: boolean;
}

export interface Period {
  readonly from: string;
  readonly to: string;
}

function query(values: Readonly<Record<string, string | undefined>>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined) params.set(key, value);
  return params.toString();
}

export const teamTable = (period: Period, desk?: Desk) =>
  api.get<TeamTable>(`/v1/staff-activity/team?${query({ ...period, desk })}`);

/** The CSV of the team table, downloaded by the browser with the session's cookie. */
export const teamExportUrl = (period: Period, desk?: Desk) =>
  new URL(
    `/v1/staff-activity/team/export?${query({ ...period, desk })}`,
    env.VITE_API_URL,
  ).toString();

export const myPage = (period: Period, desk?: Desk) =>
  api.get<PersonPage>(`/v1/staff-activity/me?${query({ ...period, desk })}`);

export const personPage = (userId: string, period: Period, desk?: Desk) =>
  api.get<PersonPage>(
    `/v1/staff-activity/people/${encodeURIComponent(userId)}?${query({ ...period, desk })}`,
  );

export const timeline = (userId: string, period: Period) =>
  api.get<Timeline>(
    `/v1/staff-activity/people/${encodeURIComponent(userId)}/timeline?${query({ ...period })}`,
  );

export const mistakes = (
  period: Period,
  filters: { readonly userId?: string; readonly kind?: string; readonly status?: string } = {},
) =>
  api.get<{ readonly items: readonly MistakeItem[] }>(
    `/v1/staff-activity/mistakes?${query({ ...period, ...filters })}`,
  );

export const reviewMistake = (input: MistakeReviewInput & Period & { readonly key: string }) =>
  api.put<{ readonly key: string; readonly status: string }>(
    '/v1/staff-activity/mistakes/review',
    input,
  );

export const settings = () => api.get<StaffSettings>('/v1/staff-activity/settings');

export const saveSettings = (input: StaffActivitySettingsInput) =>
  api.put<StaffSettings>('/v1/staff-activity/settings', input);
