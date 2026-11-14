import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../env.js', () => ({ env: { VITE_API_URL: 'http://api.test' } }));

const { printSheet, sheetHtml, inBatches, useStationLock, PRINT_DIALOG_MS } =
  await import('./background-station.js');

/**
 * One tab of a label computer prints (D-900): each asks the browser for the terminal's lock, the
 * first holds it and prints, a second waits and takes over the moment the first closes. A fake
 * `navigator.locks` with the Web Locks semantics the station relies on stands in for Chrome's.
 */

type Grant = () => Promise<void>;

function fakeLocks() {
  const held = new Map<string, boolean>();
  const waiting = new Map<string, { grant: Grant; signal?: AbortSignal; done: () => void }[]>();
  const run = (name: string) => {
    const queue = waiting.get(name) ?? [];
    while (queue.length > 0 && held.get(name) !== true) {
      const next = queue.shift();
      if (next === undefined) break;
      if (next.signal?.aborted === true) continue;
      held.set(name, true);
      void next.grant().finally(() => {
        held.set(name, false);
        next.done();
        run(name);
      });
    }
  };
  return {
    request(name: string, options: { signal?: AbortSignal }, grant: Grant): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const entry = {
          grant,
          done: resolve,
          ...(options.signal ? { signal: options.signal } : {}),
        };
        options.signal?.addEventListener('abort', () => {
          const queue = waiting.get(name) ?? [];
          const at = queue.indexOf(entry);
          if (at >= 0) {
            queue.splice(at, 1);
            reject(new DOMException('aborted', 'AbortError'));
          }
        });
        waiting.set(name, [...(waiting.get(name) ?? []), entry]);
        run(name);
      });
    },
  };
}

function Holder({ name, seen }: { readonly name: string; readonly seen: (held: boolean) => void }) {
  seen(useStationLock(name));
  return null;
}

let roots: Root[] = [];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(navigator, 'locks', { value: fakeLocks(), configurable: true });
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
});

async function mount(name: string): Promise<{ held: () => boolean; root: Root }> {
  let last = false;
  const root = createRoot(document.body.appendChild(document.createElement('div')));
  roots.push(root);
  await act(async () => {
    root.render(<Holder name={name} seen={(held) => (last = held)} />);
    await Promise.resolve();
  });
  return { held: () => last, root };
}

describe('the print station’s lock', () => {
  it('lets one tab print, and the next take over when it closes', async () => {
    const first = await mount('erp.print-station:t1');
    const second = await mount('erp.print-station:t1');
    expect(first.held()).toBe(true);
    expect(second.held()).toBe(false);

    await act(async () => {
      first.root.unmount();
      roots = roots.filter((root) => root !== first.root);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(second.held()).toBe(true);
  });

  it('holds another terminal’s lock on its own', async () => {
    const one = await mount('erp.print-station:t1');
    const other = await mount('erp.print-station:t2');
    expect(one.held()).toBe(true);
    expect(other.held()).toBe(true);
  });
});

describe('printing the waiting labels (D-976)', () => {
  const LABEL = { widthUm: 101_600, heightUm: 152_400 } as const;
  const pages = (count: number, copies = 1) =>
    Array.from({ length: count }, (_, at) => ({
      url: `blob:label-${String(at)}`,
      ...LABEL,
      copies,
    }));

  /**
   * A frame like Chrome's: `blocking` prints the way an HTML page's print does, the call
   * returning when the dialog closes (after `printMs`), `afterprint` fired before it returns;
   * otherwise the call returns at once and `afterprint` comes `printMs` later, the way Chrome's
   * print of a PDF in a frame behaved (D-816).
   */
  function frameLike({ printMs, blocking }: { printMs: number; blocking: boolean }) {
    let clock = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const prints: string[] = [];
    const loaded: string[] = [];
    const view = new EventTarget() as EventTarget & { focus: () => void; print: () => void };
    let html = '';
    view.focus = () => undefined;
    view.print = () => {
      prints.push(html);
      if (blocking) {
        clock += printMs;
        view.dispatchEvent(new Event('afterprint'));
      } else {
        setTimeout(() => {
          clock += printMs;
          view.dispatchEvent(new Event('afterprint'));
        }, 300);
      }
    };
    const frame = {
      onload: null as (() => void) | null,
      set srcdoc(value: string) {
        html = value;
        loaded.push(value);
        setTimeout(() => this.onload?.(), 0);
      },
      get contentDocument() {
        return {
          querySelector: (selector: string) =>
            selector === '.page' && html.includes('class="page"') ? {} : null,
          images: [],
        };
      },
      contentWindow: view,
    };
    return { frame: frame as unknown as HTMLIFrameElement, prints, loaded };
  }

  afterEach(() => vi.restoreAllMocks());

  it('prints every waiting label in one print call, so one dialog, a page a copy', async () => {
    const { frame, prints } = frameLike({ printMs: 20, blocking: true });
    await printSheet(frame, pages(6, 2));
    expect(prints).toHaveLength(1);
    expect(prints[0]?.match(/class="page"/g)).toHaveLength(12);
    for (let at = 0; at < 6; at += 1) expect(prints[0]).toContain(`blob:label-${String(at)}`);
  });

  it('is not over until Chrome says the print is: a print call that returns at once is waited on', async () => {
    const { frame, prints } = frameLike({ printMs: PRINT_DIALOG_MS + 500, blocking: false });
    let done = false;
    const printing = printSheet(frame, pages(3)).then((result) => {
      done = true;
      return result;
    });
    await vi.waitFor(() => expect(prints).toHaveLength(1), { interval: 10 });
    // print() has returned; the dialog is still open, so the labels are not printed yet.
    expect(done).toBe(false);
    const printed = await printing;
    expect(printed.dialog).toBe(true);
  });

  it('says nothing of a dialog when Chrome prints silently (--kiosk-printing)', async () => {
    const { frame } = frameLike({ printMs: 20, blocking: true });
    expect((await printSheet(frame, pages(1))).dialog).toBe(false);
  });

  it('lays each picture out at the paper’s size, a pixel a dot, no blank page between labels', () => {
    const html = sheetHtml(pages(2));
    expect(html).toContain('@page { size: 101.6mm 152.4mm; margin: 0; }');
    expect(html).toContain('image-rendering: pixelated');
    expect(html).toContain('height: calc(152.4mm - 0.3mm)');
    expect(html).toContain('.page:last-child { break-after: auto; }');
    expect(() => sheetHtml([])).toThrow();
  });

  it('asks for the pictures a few at a time, in order', async () => {
    let running = 0;
    let most = 0;
    const results = await inBatches([1, 2, 3, 4, 5, 6, 7, 8, 9], 4, async (n) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;
      return n * 10;
    });
    expect(results).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90]);
    expect(most).toBe(4);
  });
});
