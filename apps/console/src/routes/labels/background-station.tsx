import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { playTone } from '../../alive/tones.js';
import '../../i18n/labels.js';
import { useT } from '../../i18n/locale.js';
import { useRealtime } from '../../realtime/use-realtime.js';
import {
  stationJobs,
  stationPicture,
  stationResult,
  type PrintJob,
  type StationPicture,
} from './api.js';
import { useBrandBinding, useTerminalCheckIn } from './terminal-binding.js';

/**
 * The print station, wherever the console is open on a label computer (D-900).
 *
 * D-816 printed a browser printer's jobs only while Labels → Print station was the page on
 * screen, while the computer's check-in, which any Labels or Packaging page sent, made the
 * printer read Online. So the printer looked connected and every job, the test print among them,
 * waited Queued for a page nobody had open. Now the work dock mounts this on every page of a
 * computer bound to a label terminal: it checks in and prints from wherever the person is, and
 * Online means the jobs print.
 *
 * One tab prints. Each tab asks the browser for the terminal's lock (`navigator.locks`); the one
 * holding it runs the loop, the others wait and take over when it closes, so no job prints twice
 * from one computer (the server already keeps two computers apart, D-826 W2). The Print station
 * page shows this state and pauses or resumes it.
 *
 * D-976: the jobs waiting on one printer print together, in one print call and so one dialog, as
 * pages of one HTML document: each job's page fetched as a black-and-white picture at the
 * printer's dots. D-816 printed each job's PDF from the frame, and Chrome's `print()` of a PDF
 * returns before its dialog closes: the station marked the job printed, loaded the next PDF into
 * the same frame and so closed the dialog it had just opened, job after job ("it opens and shuts,
 * and the log says every label printed"). An HTML page's `print()` returns when the dialog
 * closes, and the station also waits for the frame's `afterprint` before it says printed.
 */

export interface StationState {
  /** `here`: this tab prints; `elsewhere`: another tab of this browser does; `off`: none. */
  readonly role: 'here' | 'elsewhere' | 'off';
  readonly paused: boolean;
  readonly busy: string | null;
  /** The jobs in the print under way (D-976): one dialog for all of them. */
  readonly batch: readonly string[];
  readonly last: PrintJob | null;
  readonly failure: string | null;
  /** The last print waited on a dialog: Chrome is not printing silently (`--kiosk-printing`). */
  readonly dialog: boolean;
}

let current: StationState = {
  role: 'off',
  paused: false,
  busy: null,
  batch: [],
  last: null,
  failure: null,
  dialog: false,
};
const listeners = new Set<() => void>();

function update(patch: Partial<StationState>): void {
  current = { ...current, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useStationState(): StationState {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  );
}

export function setStationPaused(paused: boolean): void {
  update({ paused });
}

/**
 * A print that took this long waited on a person: Chrome showed its dialog. With
 * `--kiosk-printing` it is over at once.
 */
export const PRINT_DIALOG_MS = 1500;

/** One page of a print: a job's picture, its paper, and how many times it goes in. */
export interface SheetPage {
  readonly url: string;
  readonly widthUm: number;
  readonly heightUm: number;
  readonly copies: number;
}

/**
 * The longest the station waits for Chrome to say a print is over (`afterprint`) once its print
 * call returned. Chrome's dialog blocks the call, so this is only for a browser that neither
 * blocks nor tells; long enough that a person still choosing a printer is never cut off.
 */
export const AFTERPRINT_WAIT_MS = 5 * 60_000;

const mm = (micrometres: number) => `${String(Math.round(micrometres) / 1000)}mm`;

/**
 * The print's document: every page its picture, the size of the paper, a copy a page. The
 * pictures are drawn a pixel to a dot, never smoothed. The page box is a hair shorter than the
 * paper so a rounding never spills a blank page after each label.
 */
export function sheetHtml(pages: readonly SheetPage[]): string {
  const first = pages[0];
  if (first === undefined) throw new Error('Nothing to print.');
  const width = mm(first.widthUm);
  const height = mm(first.heightUm);
  const sheets = pages
    .flatMap((page) =>
      Array.from(
        { length: Math.max(1, page.copies) },
        () => `<div class="page"><img src="${page.url}" alt="" /></div>`,
      ),
    )
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Labels</title><style>
@page { size: ${width} ${height}; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; }
.page { width: ${width}; height: calc(${height} - 0.3mm); overflow: hidden; break-after: page; }
.page:last-child { break-after: auto; }
.page img { display: block; width: ${width}; height: ${height}; image-rendering: pixelated; }
</style></head><body>${sheets}</body></html>`;
}

/**
 * Print pages from the hidden frame in one print call, so in one dialog, and resolve only once
 * the browser says the print is over: its `print()` returned and the frame's `afterprint` came.
 * Nothing loads into the frame again before then (D-976).
 */
export async function printSheet(
  frame: HTMLIFrameElement,
  pages: readonly SheetPage[],
): Promise<{ readonly dialog: boolean }> {
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error('The page did not load to print.')),
      20_000,
    );
    // Only this document's load: the frame emptied after the last print may still be loading.
    frame.onload = () => {
      if (frame.contentDocument?.querySelector('.page') == null) return;
      window.clearTimeout(timer);
      frame.onload = null;
      resolve();
    };
    frame.srcdoc = sheetHtml(pages);
  });
  const target = frame.contentWindow;
  if (target === null) throw new Error('The print frame is gone.');
  // Every picture drawn before the print, or Chrome prints the pages blank.
  const images = Array.from(frame.contentDocument?.images ?? []);
  await Promise.all(
    images.map((image) =>
      image.complete && image.naturalWidth > 0
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = () => reject(new Error('A label’s picture did not load to print.'));
          }),
    ),
  );
  // The frame is focused to print and the person's field gets the focus back at once: this
  // runs on any page, and a scan typed into the hidden frame would be lost (D-900's review).
  const active = document.activeElement;
  const previous = active instanceof HTMLElement && active !== document.body ? active : null;
  let over = false;
  let finish: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const onAfterPrint = () => {
    over = true;
    finish();
  };
  target.addEventListener('afterprint', onAfterPrint);
  const started = Date.now();
  try {
    target.focus();
    target.print();
    if (!over) {
      let timer = 0;
      await Promise.race([
        ended,
        new Promise<void>((resolve) => {
          timer = window.setTimeout(resolve, AFTERPRINT_WAIT_MS);
        }),
      ]);
      window.clearTimeout(timer);
    }
  } finally {
    target.removeEventListener('afterprint', onAfterPrint);
    previous?.focus({ preventScroll: true });
  }
  return { dialog: Date.now() - started > PRINT_DIALOG_MS };
}

/**
 * Hold the browser's lock named `name` while mounted: true while this tab holds it. A browser
 * with no Web Locks (none the console supports, and a test's DOM) counts as holding it.
 */
export function useStationLock(name: string | null): boolean {
  const [held, setHeld] = useState(false);
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  useEffect(() => {
    if (name === null || locks === undefined) return;
    const controller = new AbortController();
    let release: (() => void) | null = null;
    void locks
      .request(
        name,
        { signal: controller.signal },
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
            setHeld(true);
          }),
      )
      // Aborted while another tab held it: this tab unmounted first.
      .catch(() => undefined);
    return () => {
      controller.abort();
      release?.();
      setHeld(false);
    };
  }, [name, locks]);
  return name !== null && (locks === undefined || held);
}

/** Mounted by the work dock on a computer bound to a label terminal (D-900). */
export function BackgroundPrintStation() {
  const binding = useBrandBinding();
  // The check-in from every page: the printer is Online exactly while this prints.
  useTerminalCheckIn();
  const label = binding?.kind === 'label';
  const held = useStationLock(label ? `erp.print-station:${binding.terminalId}` : null);
  useEffect(() => {
    update({ role: !label ? 'off' : held ? 'here' : 'elsewhere' });
  }, [label, held]);
  if (!label || !held) return null;
  return <StationLoop terminalId={binding.terminalId} token={binding.token} />;
}

/** A job whose print failed is tried again after this long, not at once (D-900's review). */
const RETRY_AFTER_MS = 30_000;

/** The most labels in one print (one dialog); the rest go in the next (D-976). */
export const BATCH_MAX = 50;

/** Pictures asked for at once: each is a render on the server. */
const FETCH_AT_ONCE = 4;

/** `run` over every item, at most `size` at a time, the results in the items' order. */
export async function inBatches<T, R>(
  items: readonly T[],
  size: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let at = 0; at < items.length; at += size) {
    results.push(...(await Promise.all(items.slice(at, at + size).map(run))));
  }
  return results;
}

function StationLoop({
  terminalId,
  token,
}: {
  readonly terminalId: string;
  readonly token: string;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const frame = useRef<HTMLIFrameElement>(null);
  const { paused, busy } = useStationState();
  /*
   * The jobs this loop has started: never started again while the server still lists them, so
   * the list from before a print (it is refetched after) cannot print the job a second time, and
   * a job the server refuses is not asked for in a loop. A job leaves this set when the server
   * stops listing it (printed, failed), so one put back by Retry prints; one that failed here is
   * tried again after `RETRY_AFTER_MS`.
   */
  const started = useRef(new Set<string>());
  // Bumped when a failed job may be tried again: the list it is in may not have changed.
  const [retries, setRetries] = useState(0);
  const jobs = useQuery({
    queryKey: ['labels', 'station', token],
    queryFn: stationJobs,
    refetchInterval: 15_000,
    refetchIntervalInBackground: true,
    retry: false,
  });
  useEffect(() => {
    if (jobs.data === undefined) return;
    const listed = new Set(jobs.data.items.map((job) => job.id));
    for (const id of started.current) if (!listed.has(id)) started.current.delete(id);
  }, [jobs.data]);
  const onEvent = useCallback(
    (_name: string, payload: unknown) => {
      const event = payload as { terminalId?: unknown; state?: unknown } | null;
      if (event?.terminalId === terminalId && event?.state === 'queued') {
        void queryClient.invalidateQueries({ queryKey: ['labels', 'station'] });
      }
    },
    [terminalId, queryClient],
  );
  useRealtime({ events: ['labels.job_changed'], onEvent });

  // Nothing prints here any more once this loop is gone (a sign-out, another brand, a lost lock).
  useEffect(() => () => update({ busy: null, batch: [] }), []);

  useEffect(() => {
    // The store, not this render's copy: a second run of this effect before the first one's
    // update arrives (React's development double effects) sees the jobs taken.
    if (paused || current.busy !== null || frame.current === null) return;
    const ready = (jobs.data?.items ?? []).filter(
      (candidate) =>
        (candidate.state === 'queued' || candidate.state === 'sending') &&
        !started.current.has(candidate.id),
    );
    const head = ready[0];
    if (head === undefined) return;
    // One printer a print: one dialog goes to one printer (D-976).
    const batch = ready
      .filter((candidate) => candidate.printer.id === head.printer.id)
      .slice(0, BATCH_MAX);
    const target = frame.current;
    for (const job of batch) started.current.add(job.id);
    update({ busy: head.id, batch: batch.map((job) => job.id), failure: null });

    const failedOne = async (job: PrintJob, error: unknown) => {
      const message = error instanceof Error ? error.message : t('lb.failed');
      update({ failure: message });
      await stationResult(job.id, 'failed', message).catch(() => undefined);
      window.setTimeout(() => {
        started.current.delete(job.id);
        setRetries((count) => count + 1);
      }, RETRY_AFTER_MS);
    };

    void (async () => {
      const urls: string[] = [];
      try {
        // Each job's picture (fetching it claims the job for this computer), a few at a time.
        const fetched = await inBatches(batch, FETCH_AT_ONCE, async (job) => {
          try {
            return { job, picture: await stationPicture(job.id) };
          } catch (error) {
            await failedOne(job, error);
            return null;
          }
        });
        const ok = fetched.filter(
          (entry): entry is { job: PrintJob; picture: StationPicture } => entry !== null,
        );
        if (ok.length < batch.length) playTone('error');
        if (ok.length === 0) return;
        const pages = ok.map(({ job, picture }) => {
          const url = URL.createObjectURL(picture.blob);
          urls.push(url);
          return {
            url,
            widthUm: picture.widthUm,
            heightUm: picture.heightUm,
            copies: job.copies,
          };
        });
        let printed: { readonly dialog: boolean };
        try {
          printed = await printSheet(target, pages);
        } catch (error) {
          playTone('error');
          for (const { job } of ok) await failedOne(job, error);
          return;
        }
        await Promise.all(
          ok.map(({ job }) => stationResult(job.id, 'printed').catch(() => undefined)),
        );
        update({ last: ok[ok.length - 1]?.job ?? null, dialog: printed.dialog });
        playTone('sent');
      } finally {
        // Out of the frame before the pictures go, so a late print never reads a revoked one.
        target.srcdoc = '';
        for (const url of urls) URL.revokeObjectURL(url);
        // The fresh list first, then the next print: never the list from before this one.
        await queryClient.invalidateQueries({ queryKey: ['labels'] });
        update({ busy: null, batch: [] });
      }
    })();
  }, [paused, busy, jobs.data, retries, queryClient, t]);

  // The frame the labels print from: off-screen, never shown.
  return (
    <iframe
      ref={frame}
      title={t('lb.station.title')}
      aria-hidden="true"
      tabIndex={-1}
      className="pointer-events-none fixed size-1 opacity-0"
    />
  );
}
