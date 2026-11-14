import { zodResolver } from '@hookform/resolvers/zod';
import { staffActivitySettingsInputSchema } from '@elysium/contracts/staff-activity';
import {
  Button,
  ErrorState,
  Form,
  PageHeader,
  PermissionGate,
  Section,
  Skeleton,
  TextField,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { useForm, type UseFormRegisterReturn } from 'react-hook-form';
import { z } from 'zod';

import { useAbility } from '../../auth/session.js';
import { saveSettings, settings, STAFF_KEY, type StaffSettings } from './api.js';
import { useStaffT } from './messages.js';
import { StaffNav } from './staff-nav.js';

/**
 * `/staff-activity?view=settings` (M57, D-1000, D-1001, D-1004): the thresholds that make a delay a
 * mistake, the working day, whether staff see colleagues' names, and whether confirmed mistakes
 * reduce bonuses. org_admin only (`update StaffActivity`).
 */

const minutes = z.coerce.number().int().min(1).max(1440);
const clock = z.string().regex(/^([01]\d|2[0-4]):[0-5]\d$/);

const formSchema = z.object({
  callBackGraceMinutes: minutes,
  firstReplyMinutes: minutes,
  unansweredMinutes: minutes,
  wrapUpMinutes: minutes,
  workdayStart: clock,
  workdayEnd: clock,
  requireVerificationCall: z.boolean(),
  showColleagueNames: z.boolean(),
  mistakesReduceBonuses: z.boolean(),
});
type FormValues = z.input<typeof formSchema>;

const toClock = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const fromClock = (value: string) => {
  const [h, m] = value.split(':');
  return Number(h) * 60 + Number(m);
};

function valuesOf(stored: StaffSettings): FormValues {
  return {
    callBackGraceMinutes: stored.callBackGraceMinutes,
    firstReplyMinutes: stored.firstReplyMinutes,
    unansweredMinutes: stored.unansweredMinutes,
    wrapUpMinutes: stored.wrapUpMinutes,
    workdayStart: toClock(stored.workdayStartMinute),
    workdayEnd: toClock(stored.workdayEndMinute),
    requireVerificationCall: stored.requireVerificationCall,
    showColleagueNames: stored.showColleagueNames,
    mistakesReduceBonuses: stored.mistakesReduceBonuses,
  };
}

export function StaffSettingsPage() {
  const t = useStaffT();
  const ability = useAbility();
  return (
    <PermissionGate
      allowed={ability.can('update', 'StaffActivity')}
      explain={{ title: t('staff.deniedTitle'), detail: t('staff.deniedDetail') }}
    >
      <div className="space-y-5">
        <PageHeader
          title={t('staff.settings.title')}
          description={t('staff.settings.subtitle')}
          tabs={<StaffNav view="settings" />}
        />
        <SettingsForm />
      </div>
    </PermissionGate>
  );
}

function SettingsForm() {
  const t = useStaffT();
  const queries = useQueryClient();
  const stored = useQuery({ queryKey: [...STAFF_KEY, 'settings'], queryFn: settings });
  const [saved, setSaved] = useState(false);
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema) });
  useEffect(() => {
    if (stored.data !== undefined) form.reset(valuesOf(stored.data));
  }, [stored.data, form]);
  const save = useMutation({
    mutationFn: (values: FormValues) => {
      const parsed = formSchema.parse(values);
      const input = staffActivitySettingsInputSchema.parse({
        callBackGraceMinutes: parsed.callBackGraceMinutes,
        firstReplyMinutes: parsed.firstReplyMinutes,
        unansweredMinutes: parsed.unansweredMinutes,
        wrapUpMinutes: parsed.wrapUpMinutes,
        workdayStartMinute: fromClock(parsed.workdayStart),
        workdayEndMinute: fromClock(parsed.workdayEnd),
        requireVerificationCall: parsed.requireVerificationCall,
        showColleagueNames: parsed.showColleagueNames,
        mistakesReduceBonuses: parsed.mistakesReduceBonuses,
      });
      return saveSettings(input);
    },
    onSuccess: async () => {
      setSaved(true);
      await queries.invalidateQueries({ queryKey: STAFF_KEY });
    },
  });

  if (stored.isPending) return <Skeleton className="h-96 w-full max-w-2xl" />;
  if (stored.isError) {
    return (
      <ErrorState
        title={t('staff.failed')}
        action={
          <Button variant="outline" onClick={() => void stored.refetch()}>
            {t('staff.retry')}
          </Button>
        }
      />
    );
  }

  return (
    <Form<FormValues>
      form={form}
      onSubmit={(values) => {
        setSaved(false);
        return save.mutateAsync(values).then(() => undefined);
      }}
      {...(save.error === null ? {} : { submitError: t('staff.settings.invalid') })}
      className="max-w-2xl space-y-5"
    >
      <Section title={t('staff.settings.thresholds')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField<FormValues>
            name="callBackGraceMinutes"
            label={t('staff.settings.callBackGrace')}
            required
          />
          <TextField<FormValues>
            name="firstReplyMinutes"
            label={t('staff.settings.firstReply')}
            required
          />
          <TextField<FormValues>
            name="unansweredMinutes"
            label={t('staff.settings.unanswered')}
            required
          />
          <TextField<FormValues> name="wrapUpMinutes" label={t('staff.settings.wrapUp')} required />
        </div>
        <p className="mt-4 text-sm font-medium">{t('staff.settings.workday')}</p>
        <div className="mt-2 grid gap-4 sm:grid-cols-2">
          <TextField<FormValues>
            name="workdayStart"
            label={t('staff.settings.workdayStart')}
            placeholder="09:00"
            required
          />
          <TextField<FormValues>
            name="workdayEnd"
            label={t('staff.settings.workdayEnd')}
            placeholder="22:00"
            required
          />
        </div>
        <div className="mt-4">
          <Checkbox
            registration={form.register('requireVerificationCall')}
            label={t('staff.settings.requireCall')}
            hint={t('staff.settings.requireCallHint')}
          />
        </div>
      </Section>
      <Section title={t('staff.settings.visibility')}>
        <Checkbox
          registration={form.register('showColleagueNames')}
          label={t('staff.settings.showNames')}
          hint={t('staff.settings.showNamesHint')}
        />
      </Section>
      <Section title={t('staff.settings.pay')}>
        <Checkbox
          registration={form.register('mistakesReduceBonuses')}
          label={t('staff.settings.reduceBonuses')}
          hint={t('staff.settings.reduceBonusesHint')}
        />
      </Section>
      <div className="flex items-center justify-end gap-3">
        {saved ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('staff.settings.saved')}
          </p>
        ) : null}
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? t('staff.settings.saving') : t('staff.settings.save')}
        </Button>
      </div>
    </Form>
  );
}

/** A labelled checkbox bound to the form, with its hint (as the wallets form's). */
function Checkbox({
  registration,
  label,
  hint,
}: {
  readonly registration: UseFormRegisterReturn;
  readonly label: string;
  readonly hint?: string;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="flex items-center gap-2 text-sm">
        <input
          id={id}
          type="checkbox"
          {...registration}
          {...(hint === undefined ? {} : { 'aria-describedby': hintId })}
          className="h-4 w-4 rounded border-border accent-primary focus-visible:ring-2 focus-visible:ring-ring"
        />
        {label}
      </label>
      {hint === undefined ? null : (
        <p id={hintId} className="pl-6 text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}
