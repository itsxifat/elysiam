import { mkdirSync } from 'node:fs';
import path from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';

import { enrolSecondFactor, signIn, user, type StackRole } from './stack/helpers.js';

/**
 * M57 check 8 through the real stack: the supervisor's team table, a person's page, their
 * timeline and a mistake reviewed, the mistakes list, the settings; then an agent's own page
 * with the comparison table, names shown and then hidden (check 7's browser half). Screens are
 * checked by axe in both themes and pictured in `docs/review/M57/`.
 *
 * The provisioning gives this suite its own three people (`activityadmin`, `activityagent`,
 * `activitypeer`): a morning of presence, orders and calls, and one call-back the agent promised
 * and never made.
 */

test.describe.configure({ mode: 'serial' });

const REVIEW_DIR = path.resolve(import.meta.dirname, '../../../docs/review/M57');
const AGENT = 'E2E activityagent agent';
const PEER = 'E2E activitypeer agent';

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(REVIEW_DIR, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(REVIEW_DIR, `${name}.png`), fullPage: true });
}

async function noBlockingViolations(page: Page, label: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const blocking = result.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({ page: label, id: violation.id, help: violation.help }));
  expect(blocking).toEqual([]);
}

async function bothThemes(page: Page, name: string): Promise<void> {
  await noBlockingViolations(page, `${name} (light)`);
  await shot(page, `${name}-light`);
  await page.evaluate(() => localStorage.setItem('erp-theme', 'dark'));
  await page.reload();
  await page.waitForLoadState('networkidle');
  await noBlockingViolations(page, `${name} (dark)`);
  await shot(page, `${name}-dark`);
  await page.evaluate(() => localStorage.setItem('erp-theme', 'light'));
  await page.reload();
  await page.waitForLoadState('networkidle');
}

const pages = new Map<StackRole, Page>();

async function as(browser: Browser, role: StackRole): Promise<Page> {
  const known = pages.get(role);
  if (known !== undefined) return known;
  const page = await (
    await browser.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  await signIn(page, user(role).email);
  if (role === 'activityadmin') await enrolSecondFactor(page);
  await expect(page.getByRole('navigation').first()).toBeVisible();
  pages.set(role, page);
  return page;
}

test('the supervisor’s team table, with the agents’ morning and the team median', async ({
  browser,
}) => {
  const admin = await as(browser, 'activityadmin');
  await admin.goto('/staff-activity');
  await expect(admin.getByRole('heading', { name: 'Staff activity' })).toBeVisible();
  const table = admin.getByRole('table', { name: 'Team' });
  await expect(table).toBeVisible();
  await expect(table.getByRole('link', { name: AGENT })).toBeVisible();
  await expect(table.getByRole('link', { name: PEER })).toBeVisible();
  await expect(table.getByRole('rowheader', { name: 'Team median' })).toBeVisible();
  // Sorting by confirmed orders, then by mistakes, keeps both rows.
  await table.getByRole('button', { name: 'Sort by Mistakes' }).click();
  await expect(table.getByRole('link', { name: AGENT })).toBeVisible();
  // The click scrolled the wide table to its last columns; the picture starts at the first.
  await admin.getByRole('region', { name: 'Team' }).evaluate((element) => {
    element.scrollLeft = 0;
  });
  await bothThemes(admin, 'a-team');
});

test('a person’s page, their timeline, and a mistake confirmed', async ({ browser }) => {
  const admin = await as(browser, 'activityadmin');
  await admin.goto('/staff-activity');
  await admin.getByRole('table', { name: 'Team' }).getByRole('link', { name: AGENT }).click();
  await expect(admin.getByRole('heading', { name: AGENT })).toBeVisible();
  await expect(admin.getByText('Active time')).toBeVisible();
  await expect(admin.getByRole('heading', { name: 'When they work' })).toBeVisible();
  await expect(admin.getByRole('heading', { name: 'Their desk' })).toBeVisible();
  await bothThemes(admin, 'b-person');

  await admin.getByRole('button', { name: 'Timeline' }).click();
  await expect(admin.getByText(/Called about order/).first()).toBeVisible();
  await expect(admin.getByText('Came online').first()).toBeVisible();
  await shot(admin, 'c-timeline');

  await admin.getByRole('button', { name: 'Mistakes' }).click();
  const row = admin.getByRole('row', { name: /Call-back missed/ });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Review' }).click();
  const dialog = admin.getByRole('dialog', { name: 'Review this mistake' });
  await dialog.getByLabel('Note').fill('Promised at noon, never called');
  await shot(admin, 'd-review');
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog).toBeHidden();
  await expect(
    admin.getByRole('row', { name: /Call-back missed/ }).getByText('Confirmed'),
  ).toBeVisible();
});

test('the mistakes of everyone, filtered by person', async ({ browser }) => {
  const admin = await as(browser, 'activityadmin');
  await admin.goto('/staff-activity?view=mistakes');
  await expect(admin.getByRole('table', { name: 'Mistakes' })).toBeVisible();
  await expect(admin.getByRole('row', { name: new RegExp(AGENT) }).first()).toBeVisible();
  await bothThemes(admin, 'e-mistakes');
});

test('an agent sees their own page and the desk’s comparison, names by default', async ({
  browser,
}) => {
  const agent = await as(browser, 'activityagent');
  await agent.goto('/staff-activity');
  await expect(agent.getByRole('heading', { name: 'My activity' })).toBeVisible();
  const compare = agent.getByRole('table', { name: 'Your desk' });
  await expect(compare).toBeVisible();
  await expect(compare.getByText(PEER)).toBeVisible();
  // No team table, and no way to another person's page.
  await expect(agent.getByRole('table', { name: 'Team' })).toHaveCount(0);
  await expect(compare.getByRole('link')).toHaveCount(0);
  await bothThemes(agent, 'f-mine');
});

test('with names hidden, colleagues are “Colleague n”', async ({ browser }) => {
  const admin = await as(browser, 'activityadmin');
  await admin.goto('/staff-activity?view=settings');
  const names = admin.getByRole('checkbox', {
    name: 'Show colleagues’ names in the comparison table',
  });
  await expect(names).toBeChecked();
  await names.uncheck();
  await admin.getByRole('button', { name: 'Save' }).click();
  await expect(admin.getByRole('status')).toHaveText('Saved');
  await bothThemes(admin, 'g-settings');

  const agent = await as(browser, 'activityagent');
  await agent.goto('/staff-activity');
  const compare = agent.getByRole('table', { name: 'Your desk' });
  await expect(compare.getByText(/Colleague 1/)).toBeVisible();
  await expect(compare.getByText(PEER)).toHaveCount(0);
  await expect(compare.getByText(AGENT)).toBeVisible();
  await shot(agent, 'h-mine-hidden');

  // Put it back for the next run on the same stack.
  await admin.goto('/staff-activity?view=settings');
  await names.check();
  await admin.getByRole('button', { name: 'Save' }).click();
  await expect(admin.getByRole('status')).toHaveText('Saved');
});
