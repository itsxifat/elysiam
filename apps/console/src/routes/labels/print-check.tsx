import type { MessageKey } from '@elysium/i18n';
import { Button, Checkbox, DateTime } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, PrinterX } from 'lucide-react';
import { useState } from 'react';

import { ApiError } from '../../api.js';
import { useT } from '../../i18n/locale.js';
import { listJobs, markNotPrinted, type PrintJob } from './api.js';
import { lotText } from './parts.js';

/**
 * D-1025: what the last prints put out, for a person to check against what came out of the
 * printer. The browser print station can only tell that Chrome's print finished, and a jammed or
 * empty printer still "printed" every page, so they left Ready for label for good. Pages printed
 * in the last half hour are listed until this person says they all came out; any ticked as not
 * printed go back to Ready for label (the server checks the order is not packed yet).
 *
 * Which pages this person has already checked is a per-computer convenience in localStorage:
 * losing it only shows the list again.
 */
const RECENT_MS = 30 * 60 * 1000;
const STORE_KEY = 'labels.print-checked';
const STORE_MAX = 500;

function readChecked(): ReadonlySet<string> {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeChecked(ids: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify([...ids].slice(-STORE_MAX)));
  } catch {
    // Storage blocked: the list shows again next time, which is safe.
  }
}

export function PrintCheckPanel() {
  const t = useT();
  const queryClient = useQueryClient();
  const [checked, setChecked] = useState<ReadonlySet<string>>(readChecked);
  const [bad, setBad] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const recent = useQuery({
    queryKey: ['labels', 'jobs', 'print-check'],
    queryFn: () => listJobs({ view: 'log', state: 'printed', limit: 100 }),
    refetchInterval: 15_000,
  });
  // Half an hour before the list was fetched (refetched every 15 s), not the render's clock.
  const since = recent.dataUpdatedAt - RECENT_MS;
  const pages = (recent.data?.items ?? []).filter(
    (job): job is PrintJob & { orderId: string } =>
      job.orderId !== null &&
      job.document !== 'test' &&
      job.printedAt !== null &&
      new Date(job.printedAt).getTime() >= since &&
      !checked.has(job.id),
  );
  const done = (ids: readonly string[]) => {
    const next = new Set([...checked, ...ids]);
    setChecked(next);
    writeChecked(next);
    setBad(new Set());
  };
  const putBack = useMutation({
    mutationFn: () => markNotPrinted([...bad]),
    onSuccess: async (result) => {
      setNotice(`${String(result.jobIds.length)} ${t('lb.check.putBack')}`);
      done(pages.map((job) => job.id));
      await queryClient.invalidateQueries({ queryKey: ['labels'] });
    },
    onError: (error) => setNotice(error instanceof ApiError ? error.message : t('lb.failed')),
  });

  if (pages.length === 0) {
    return notice === null ? null : (
      <p role="status" className="text-sm text-muted-foreground">
        {notice}
      </p>
    );
  }
  return (
    <section
      aria-labelledby="print-check-heading"
      className="space-y-3 rounded-lg border border-border bg-card p-4"
      data-testid="print-check"
    >
      <div className="space-y-1">
        <h2 id="print-check-heading" className="text-sm font-medium">
          {t('lb.check.title')}
        </h2>
        <p className="text-sm text-muted-foreground">
          {`${String(pages.length)} ${t('lb.check.lead')}`}
        </p>
      </div>
      <ul className="divide-y divide-border rounded-md border border-border">
        {pages.map((job) => (
          <li key={job.id} className="flex items-center gap-3 px-3 py-2 text-sm">
            <Checkbox
              aria-label={`${t('lb.check.didNotPrint')} ${job.orderNo}`}
              checked={bad.has(job.id)}
              onCheckedChange={() =>
                setBad((current) => {
                  const next = new Set(current);
                  if (next.has(job.id)) next.delete(job.id);
                  else next.add(job.id);
                  return next;
                })
              }
            />
            <span className="font-medium tabular-nums">{job.orderNo}</span>
            <span className="text-muted-foreground">
              {t(`lb.doc.${job.document}` as MessageKey)}
              {job.lotCount > 1 ? ` · ${lotText(t, job.lot, job.lotCount)}` : ''}
            </span>
            <span className="text-muted-foreground">{job.printer.name}</span>
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              <DateTime value={job.printedAt ?? job.createdAt} />
            </span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={putBack.isPending}
          onClick={() => {
            setNotice(null);
            done(pages.map((job) => job.id));
          }}
        >
          <Check aria-hidden />
          {t('lb.check.allGood')}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={bad.size === 0 || putBack.isPending}
          onClick={() => putBack.mutate()}
        >
          <PrinterX aria-hidden />
          {`${t('lb.check.didNotPrint')} (${String(bad.size)})`}
        </Button>
        {notice === null ? null : (
          <p role="status" className="text-sm text-muted-foreground">
            {notice}
          </p>
        )}
      </div>
    </section>
  );
}
