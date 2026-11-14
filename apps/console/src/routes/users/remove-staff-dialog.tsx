import { Button, Dialog, Input, Label } from '@elysium/ui';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';

import { ApiError } from '../../api.js';
import { useT } from '../../i18n/locale.js';
import { removeStaff, startStaffRemoval, type StaffRow } from './api.js';
import { useUsersT, type UsersMessageKey } from './messages.js';

const WARNINGS = [
  'users.removeWarning1',
  'users.removeWarning2',
  'users.removeWarning3',
] as const satisfies readonly UsersMessageKey[];

export function RemoveStaffDialog({
  row,
  onClose,
  onRemoved,
}: {
  readonly row: StaffRow;
  readonly onClose: () => void;
  readonly onRemoved: () => Promise<void>;
}) {
  const u = useUsersT();
  const t = useT();
  const id = useId();
  const [step, setStep] = useState(0);
  const [challenge, setChallenge] = useState<{ token: string; warningSeconds: number } | null>(
    null,
  );
  const [problem, setProblem] = useState<string | null>(null);
  // The seconds come from the server's challenge, which also enforces them; until it
  // answers the dialog only says it is preparing (and imports nothing from contracts, §24).
  const [remaining, setRemaining] = useState(Number.POSITIVE_INFINITY);
  const [name, setName] = useState('');

  useEffect(() => {
    let mounted = true;
    void startStaffRemoval(row.userId).then(
      (value) => {
        if (!mounted) return;
        setChallenge(value);
        setRemaining(value.warningSeconds);
      },
      (error: unknown) => {
        if (mounted) setProblem(error instanceof ApiError ? error.message : t('error.unreachable'));
      },
    );
    return () => {
      mounted = false;
    };
  }, [row.userId, t]);

  useEffect(() => {
    if (challenge === null) return;
    const deadline = Date.now() + challenge.warningSeconds * 1000;
    const interval = window.setInterval(() => {
      setRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    }, 250);
    return () => window.clearInterval(interval);
  }, [step, challenge]);

  const removal = useMutation({
    mutationFn: async () => {
      if (challenge === null) throw new Error('Removal confirmation is not ready');
      return removeStaff(row.userId, {
        token: challenge.token,
        confirmationName: name.trim(),
        warningsAcknowledged: WARNINGS.length,
      });
    },
    onSuccess: onRemoved,
  });
  const last = step === WARNINGS.length - 1;
  const locked = challenge === null || remaining > 0 || removal.isPending;
  const error =
    removal.error instanceof ApiError
      ? removal.error.message
      : removal.error === null
        ? problem
        : t('error.unreachable');

  return (
    <Dialog
      open
      title={u('users.removeTitle')}
      description={row.name}
      closeLabel={t('common.close')}
      onOpenChange={(open) => {
        if (!open && !removal.isPending) onClose();
      }}
      footer={
        <>
          <Button variant="outline" disabled={removal.isPending} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={locked || (last && name.trim() !== row.name.trim())}
            onClick={() => {
              if (locked) return;
              if (last) removal.mutate();
              else {
                setRemaining(challenge?.warningSeconds ?? Number.POSITIVE_INFINITY);
                setStep((current) => current + 1);
              }
            }}
          >
            {last ? u('users.removeConfirm') : u('users.removeContinue')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm font-medium text-destructive-text">
          {u('users.removeStep')
            .replace('{step}', String(step + 1))
            .replace('{total}', String(WARNINGS.length))}
        </p>
        <p className="text-sm">{u(WARNINGS[step] ?? 'users.removeWarning3')}</p>
        <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
          {challenge === null
            ? u('users.removePreparing')
            : remaining > 0
              ? u('users.removeCountdown').replace('{seconds}', String(remaining))
              : u('users.removeReady')}
        </p>
        {last ? (
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-name`}>
              {u('users.removeTypeName').replace('{name}', row.name)}
            </Label>
            <Input
              id={`${id}-name`}
              value={name}
              autoComplete="off"
              disabled={removal.isPending}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
        ) : null}
        {error === null ? null : (
          <p role="alert" className="text-sm text-destructive-text">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
