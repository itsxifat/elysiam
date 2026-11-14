import { describe, expect, it } from 'vitest';

import { bpsText, deltaOf, hoursText, secondsText, tenthsText } from './format.js';
import type { StaffT } from './messages.js';
import { staffSearch } from './search.js';
import { periodOf } from './format.js';

/** The formatters and the search params of staff activity's screens (M57). */
const t: StaffT = (key, values) => {
  const templates: Record<string, string> = {
    'staff.hours': '{h} h {m} min',
    'staff.minutesShort': '{m} min',
    'staff.secondsShort': '{s} s',
    'staff.none': '—',
  };
  let text = templates[key] ?? key;
  for (const [name, value] of Object.entries(values ?? {}))
    text = text.replace(`{${name}}`, String(value));
  return text;
};

describe('formatters', () => {
  it('writes hours, seconds, tenths and basis points as people read them', () => {
    expect(hoursText(0, t)).toBe('0 min');
    expect(hoursText(5_400_000, t)).toBe('1 h 30 min');
    expect(secondsText(45, t)).toBe('45 s');
    expect(secondsText(600, t)).toBe('10 min');
    expect(secondsText(null, t)).toBe('—');
    expect(tenthsText(37, t)).toBe('3.7');
    expect(tenthsText(null, t)).toBe('—');
    expect(bpsText(9050, t)).toBe('90.5%');
  });

  it('says a rise in mistakes is bad news, and has nothing to say from zero to zero', () => {
    expect(deltaOf(6, 4, { caption: 'c', lowerIsBetter: true })).toMatchObject({
      label: '+50%',
      direction: 'up',
      tone: 'negative',
    });
    expect(deltaOf(10, 5, { caption: 'c' })).toMatchObject({ tone: 'positive' });
    expect(deltaOf(0, 0, { caption: 'c' })).toBeUndefined();
    expect(deltaOf(3, null, { caption: 'c' })).toBeUndefined();
  });
});

describe('the search params', () => {
  it('keeps what is valid and drops the rest', () => {
    expect(
      staffSearch({
        from: '2026-11-01',
        to: 'not a date',
        desk: 'packing',
        tab: 'timeline',
        status: 'nonsense',
        person: 'usr_1',
      }),
    ).toEqual({ from: '2026-11-01', desk: 'packing', tab: 'timeline', person: 'usr_1' });
  });

  it('never asks for a backwards or too-long period', () => {
    expect(periodOf({ from: '2026-11-10', to: '2026-11-01' })).toEqual({
      from: '2026-11-01',
      to: '2026-11-01',
    });
    expect(periodOf({ from: '2026-01-01', to: '2026-11-01' })).toEqual({
      from: '2026-11-01',
      to: '2026-11-01',
    });
    expect(periodOf({ from: '2026-10-01', to: '2026-10-31' })).toEqual({
      from: '2026-10-01',
      to: '2026-10-31',
    });
  });
});
