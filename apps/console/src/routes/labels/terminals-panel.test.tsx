import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import { LocaleProvider } from '../../i18n/locale.js';
import '../../i18n/labels.js';
import type * as LabelsApi from './api.js';
import type { TerminalsView } from './api.js';
import { TerminalsPanel } from './terminals-panel.js';

const { list, save } = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn() }));
vi.mock('../../env.js', () => ({ env: { VITE_API_URL: 'http://api.test' } }));
vi.mock('../../auth/session.js', () => ({
  useSession: () => ({ context: { userId: 'usr_admin' } }),
}));
vi.mock('./api.js', async (original) => ({
  ...(await original<typeof LabelsApi>()),
  listTerminals: list,
  setTerminalMembers: save,
}));
vi.mock('./parts.js', () => ({
  useHubLocations: () => ({ names: new Map(), options: [] }),
  PresenceBadge: () => null,
  PrinterStateBadge: () => null,
}));

async function interact(action: () => void) {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}

it('can replace a stale inactive terminal member without submitting their hidden id', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const view: TerminalsView = {
    canEdit: true,
    terminals: [
      {
        id: 'packing_1',
        kind: 'packing',
        name: 'Packing 1',
        locationId: null,
        active: true,
        members: [{ id: 'usr_inactive', name: 'Jim' }],
        devices: [],
        workingNow: [],
        cameras: [],
        printers: [],
        queued: 0,
        packingNow: null,
        packedToday: 0,
        ordersPerHour: 0,
      },
    ],
    people: [{ id: 'usr_replacement', name: 'Replacement', roles: ['warehouse'] }],
  };
  list.mockResolvedValue(view);
  save.mockResolvedValue({ terminalId: 'packing_1', userIds: ['usr_replacement'] });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function button(label: string) {
    const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (element) => element.textContent === label,
    );
    if (found === undefined) throw new Error(`Missing ${label}`);
    return found;
  }
  try {
    await interact(() =>
      root.render(
        <QueryClientProvider client={client}>
          <LocaleProvider>
            <TerminalsPanel kind="packing" />
          </LocaleProvider>
        </QueryClientProvider>,
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await interact(() => button('Assign people').click());
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Replacement');
    expect(dialog?.textContent).not.toContain('Jim');
    const checkbox = dialog?.querySelector<HTMLElement>('[role="checkbox"]');
    if (checkbox == null) throw new Error('Missing replacement checkbox');
    await interact(() => checkbox.click());
    await interact(() => button('Save').click());
    expect(save).toHaveBeenCalledExactlyOnceWith('packing_1', ['usr_replacement']);
  } finally {
    await interact(() => root.unmount());
    client.clear();
    host.remove();
  }
});
