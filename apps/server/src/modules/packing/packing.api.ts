import { Injectable } from '@nestjs/common';
import type { Tx } from '@elysium/db';
import {
  ZERO_PACKING,
  type NoVideoFact,
  type PackerFact,
  type PackingCounts,
  type StaffPeriod,
  type TimelineItem,
  type WrongScanFact,
} from '@elysium/domain/staff-activity';

import { ScannerService } from './scanner.service.js';
import * as staff from './staff.repository.js';

/**
 * What another module may ask packing (invariant 12; M35b, D-554): the identity module, having
 * checked a person's password and second factor, asks for a scanner device for them. M57
 * (D-1006): the staff-activity module reads the hub's work, by person, through it.
 */
export interface PackingApi {
  /** A new scanner device for this person in this brand; the token, shown once. */
  issueDevice(input: {
    readonly orgId: string;
    readonly userId: string;
    readonly label: string;
  }): Promise<{
    readonly token: string;
    readonly device: { readonly id: string; readonly expiresAt: string | null };
  }>;

  /** Each person's packing, return-station, lot, handover and printing counts for `[from, to)`. */
  staffCounts(
    tx: Tx,
    orgId: string,
    period: StaffPeriod,
  ): Promise<ReadonlyMap<string, PackingCounts>>;

  /** Packing's candidates for the mistake rules over `[from, to)`. */
  staffMistakeFacts(
    tx: Tx,
    orgId: string,
    period: StaffPeriod,
  ): Promise<{
    readonly wrongScans: readonly WrongScanFact[];
    readonly noVideo: readonly NoVideoFact[];
  }>;

  /** Who completed each of these orders' packings (for a `wrong_item` return). */
  packersOf(tx: Tx, orgId: string, orderIds: readonly string[]): Promise<readonly PackerFact[]>;

  /** One person's hub timeline, newest first. */
  staffTimeline(
    tx: Tx,
    orgId: string,
    userId: string,
    period: StaffPeriod,
    limit: number,
  ): Promise<readonly TimelineItem[]>;
}

export const PACKING_API = Symbol('PackingApi');

@Injectable()
export class PackingApiService implements PackingApi {
  constructor(private readonly scanner: ScannerService) {}

  async issueDevice(input: {
    readonly orgId: string;
    readonly userId: string;
    readonly label: string;
  }) {
    const { token, device } = await this.scanner.issue({
      ...input,
      via: 'password',
      actorUserId: input.userId,
    });
    return { token, device: { id: device.id, expiresAt: device.expiresAt } };
  }

  async staffCounts(
    tx: Tx,
    orgId: string,
    period: StaffPeriod,
  ): Promise<ReadonlyMap<string, PackingCounts>> {
    const counts = new Map<string, PackingCounts>();
    const set = (userId: string, patch: Partial<PackingCounts>) =>
      counts.set(userId, { ...(counts.get(userId) ?? ZERO_PACKING), ...patch });
    for (const row of await staff.sessionCounts(tx, orgId, period)) {
      set(row.user_id, {
        packed: row.packed,
        returnsClosed: row.returns_closed,
        medianPackSeconds:
          row.median_pack_seconds === null ? null : Number(row.median_pack_seconds),
      });
    }
    for (const row of await staff.scanCounts(tx, orgId, period)) {
      set(row.user_id, {
        piecesPacked: row.pieces_packed,
        piecesReturned: row.pieces_returned,
        wrongScans: row.wrong,
      });
    }
    for (const row of await staff.lotAndHandoverCounts(tx, orgId, period)) {
      set(row.user_id, { lotsClosed: row.a, handoverScans: row.b });
    }
    for (const row of await staff.printCounts(tx, orgId, period)) {
      set(row.user_id, { labelsPrinted: row.a, reprints: row.b });
    }
    return counts;
  }

  async staffMistakeFacts(tx: Tx, orgId: string, period: StaffPeriod) {
    const wrongScans = (await staff.wrongScans(tx, orgId, period)).map((row): WrongScanFact => ({
      scanId: row.scan_id,
      sessionId: row.session_id,
      orderId: row.order_id,
      orderNo: row.order_no,
      scannedBy: row.scanned_by,
      at: new Date(row.at),
      outcome: row.outcome,
    }));
    const noVideo = (await staff.packedWithoutVideo(tx, orgId, period)).map((row): NoVideoFact => ({
      sessionId: row.session_id,
      orderId: row.order_id,
      orderNo: row.order_no,
      completedBy: row.completed_by,
      completedAt: new Date(row.completed_at),
    }));
    return { wrongScans, noVideo };
  }

  async packersOf(tx: Tx, orgId: string, orderIds: readonly string[]) {
    return (await staff.packersOf(tx, orgId, orderIds)).map((row): PackerFact => ({
      orderId: row.order_id,
      sessionId: row.session_id,
      completedBy: row.completed_by,
      completedAt: new Date(row.completed_at),
    }));
  }

  async staffTimeline(
    tx: Tx,
    orgId: string,
    userId: string,
    period: StaffPeriod,
    limit: number,
  ): Promise<readonly TimelineItem[]> {
    return (await staff.timeline(tx, orgId, userId, period, limit)).map((row) => ({
      id: `packing:${row.kind}:${row.id}`,
      at: new Date(row.at),
      desk: row.kind === 'packing.return_closed' ? ('returns' as const) : ('packing' as const),
      kind: row.kind,
      // The order's page, where its packing video and its scans are (M38b): a session has no
      // page of its own.
      ref:
        row.order_id === null
          ? null
          : { type: 'order' as const, id: row.order_id, label: row.order_no },
      detail: {
        ...(row.pieces === null ? {} : { pieces: row.pieces }),
        ...(row.lot_no === null ? {} : { lot: row.lot_no }),
      },
    }));
  }
}
