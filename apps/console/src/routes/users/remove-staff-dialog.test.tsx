import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocaleProvider } from '../../i18n/locale.js';
import type { StaffRow } from './api.js';
import { RemoveStaffDialog } from './remove-staff-dialog.js';

const { start, remove } = vi.hoisted(() => ({ start: vi.fn(), remove: vi.fn() }));
vi.mock('./api.js', () => ({ startStaffRemoval: start, removeStaff: remove }));
vi.mock('../../env.js', () => ({ env: { VITE_API_URL: 'http://api.test' } }));

async function interact(action: () => void) {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}

const row = { userId: 'usr_departed', name: 'Departed Staff' } as StaffRow;
let root: Root;
let host: HTMLElement;
let client: QueryClient;
const onClose = vi.fn();
const onRemoved = vi.fn(() => Promise.resolve());

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  start.mockReset().mockResolvedValue({ token: 'a'.repeat(64), warningSeconds: 5 });
  remove.mockReset().mockResolvedValue({ removed: true });
  onClose.mockClear();
  onRemoved.mockClear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
});

afterEach(async () => {
  await interact(() => root.unmount());
  client.clear();
  host.remove();
  vi.useRealTimers();
});

async function render() {
  await interact(() =>
    root.render(
      <QueryClientProvider client={client}>
        <LocaleProvider>
          <RemoveStaffDialog row={row} onClose={onClose} onRemoved={onRemoved} />
        </LocaleProvider>
      </QueryClientProvider>,
    ),
  );
}
function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (element) => element.textContent === label,
  );
  if (found === undefined) throw new Error(`Missing button: ${label}`);
  return found;
}
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function nextWarning() {
  await advance(5000);
  await interact(() => button('I understand — continue').click());
}

describe('permanent staff removal', () => {
  it('requires all three timed warnings and the exact name before it can remove', async () => {
    await render();
    expect(document.body.textContent).toContain('Warning 1 of 3');
    expect(button('I understand — continue').disabled).toBe(true);
    await advance(4999);
    expect(button('I understand — continue').disabled).toBe(true);
    await advance(1);
    expect(button('I understand — continue').disabled).toBe(false);
    await interact(() => button('I understand — continue').click());
    expect(document.body.textContent).toContain('Warning 2 of 3');
    expect(document.body.textContent).toContain(
      'Orders, payments, payroll and audit history remain.',
    );
    expect(button('I understand — continue').disabled).toBe(true);
    expect(remove).not.toHaveBeenCalled();
    await nextWarning();
    expect(document.body.textContent).toContain('Warning 3 of 3');
    expect(button('Remove permanently').disabled).toBe(true);
    await advance(5000);
    expect(button('Remove permanently').disabled).toBe(true);
    const input = document.querySelector<HTMLInputElement>('input');
    if (input === null) throw new Error('Missing name confirmation');
    await interact(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        row.name,
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(button('Remove permanently').disabled).toBe(false);
    await interact(() => button('Remove permanently').click());
    await advance(1);
    expect(remove).toHaveBeenCalledExactlyOnceWith(row.userId, {
      token: 'a'.repeat(64),
      confirmationName: row.name,
      warningsAcknowledged: 3,
    });
    expect(onRemoved).toHaveBeenCalledOnce();
  });

  it('can cancel at every warning without removing the account', async () => {
    await render();
    for (let step = 0; step < 3; step += 1) {
      await interact(() => button('Cancel').click());
      expect(onClose).toHaveBeenCalledTimes(step + 1);
      expect(remove).not.toHaveBeenCalled();
      if (step < 2) await nextWarning();
    }
  });

  it('keeps removal disabled if the server refuses to start confirmation', async () => {
    start.mockRejectedValueOnce(new Error('offline'));
    await render();
    await advance(30_000);
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    expect(button('I understand — continue').disabled).toBe(true);
    expect(remove).not.toHaveBeenCalled();
  });
});
