import {
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  Input,
  Label,
  Select,
  Skeleton,
  StatusBadge,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { useAbility } from '../../auth/session.js';
import { mistakes, reviewMistake, STAFF_KEY, type MistakeItem, type Period } from './api.js';
import { dateTimeText } from './format.js';
import { isStaffKey, useStaffT, type StaffT } from './messages.js';
import type { StaffSearch } from './routes.js';
import { RefLink } from './timeline-view.js';

/**
 * The mistakes (M57, D-1002, D-1003): each with whose, when, what and its evidence, and an org
 * admin's review. Staff see their own; the server says whose they may see.
 */

const KINDS = [
  'wrong_scan',
  'wrong_item_shipped',
  'address_not_verified',
  'confirmed_without_call',
  'cancelled_after_confirm',
  'call_back_missed',
  'slow_first_reply',
  'conversation_unanswered',
  'missed_call',
  'call_not_wrapped_up',
  'offer_timed_out',
  'packed_without_video',
] as const;

function kindText(kind: string, t: StaffT): string {
  const key = `staff.mistake.${kind}`;
  return isStaffKey(key) ? t(key) : kind;
}

function detailText(item: MistakeItem, t: StaffT): string | null {
  if (typeof item.detail.minutes === 'number')
    return t('staff.mistakes.minutes', { minutes: item.detail.minutes });
  if (typeof item.detail.lateMinutes === 'number') {
    return t('staff.mistakes.lateMinutes', { minutes: item.detail.lateMinutes });
  }
  return null;
}

function evidenceText(item: MistakeItem, t: StaffT): string {
  if (item.ref.type === 'conversation') return t('staff.mistakes.conversation');
  if (item.ref.type === 'call') return t('staff.mistakes.call');
  return t('staff.mistakes.order', { order: item.ref.label ?? '' });
}

export function MistakesView({
  period,
  userId,
  search,
  onFilter,
  people,
}: {
  readonly period: Period;
  /** One person's mistakes; undefined for everyone the viewer may see. */
  readonly userId: string | undefined;
  readonly search: StaffSearch;
  readonly onFilter: (next: Partial<StaffSearch>) => void;
  /** For the person filter (supervisors): who is in the period. */
  readonly people?: readonly { readonly userId: string; readonly name: string }[];
}) {
  const t = useStaffT();
  const ability = useAbility();
  const mayReview = ability.can('update', 'StaffActivity');
  const who = userId ?? search.person;
  const filters = {
    ...(who === undefined ? {} : { userId: who }),
    ...(search.kind === undefined ? {} : { kind: search.kind }),
    ...(search.status === undefined ? {} : { status: search.status }),
  };
  const list = useQuery({
    queryKey: [...STAFF_KEY, 'mistakes', period.from, period.to, filters],
    queryFn: () => mistakes(period, filters),
  });
  const [reviewing, setReviewing] = useState<MistakeItem | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {userId === undefined && people !== undefined ? (
          <div className="w-48">
            <Select
              aria-label={t('staff.col.person')}
              value={search.person ?? 'all'}
              onValueChange={(value) => {
                onFilter({ person: value === 'all' ? undefined : value });
              }}
              options={[
                { value: 'all', label: t('staff.mistakes.allPeople') },
                ...people.map((person) => ({ value: person.userId, label: person.name })),
              ]}
            />
          </div>
        ) : null}
        <div className="w-60">
          <Select
            aria-label={t('staff.mistakes.col.kind')}
            value={search.kind ?? 'all'}
            onValueChange={(value) => {
              onFilter({ kind: value === 'all' ? undefined : value });
            }}
            options={[
              { value: 'all', label: t('staff.mistakes.allKinds') },
              ...KINDS.map((kind) => ({ value: kind, label: kindText(kind, t) })),
            ]}
          />
        </div>
        <div className="w-44">
          <Select
            aria-label={t('staff.mistakes.col.review')}
            value={search.status ?? 'all'}
            onValueChange={(value) => {
              onFilter({
                status: value === 'all' ? undefined : (value as StaffSearch['status']),
              });
            }}
            options={[
              { value: 'all', label: t('staff.mistakes.status.all') },
              { value: 'unreviewed', label: t('staff.mistakes.status.unreviewed') },
              { value: 'confirmed', label: t('staff.mistakes.status.confirmed') },
              { value: 'dismissed', label: t('staff.mistakes.status.dismissed') },
            ]}
          />
        </div>
      </div>

      {list.isPending ? (
        <div className="space-y-2" aria-busy="true">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-9 w-full" />
          ))}
        </div>
      ) : list.isError ? (
        <ErrorState
          title={t('staff.failed')}
          action={
            <Button variant="outline" onClick={() => void list.refetch()}>
              {t('staff.retry')}
            </Button>
          }
        />
      ) : list.data.items.length === 0 ? (
        <EmptyState title={t('staff.emptyTitle')} detail={t('staff.mistakes.empty')} />
      ) : (
        <div
          className="overflow-x-auto rounded-lg border border-border focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          role="region"
          aria-label={t('staff.tab.mistakes')}
          tabIndex={0}
        >
          <table className="w-full text-sm">
            <caption className="sr-only">{t('staff.tab.mistakes')}</caption>
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('staff.mistakes.col.when')}
                </th>
                {userId === undefined ? (
                  <th scope="col" className="px-3 py-2 font-medium">
                    {t('staff.col.person')}
                  </th>
                ) : null}
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('staff.mistakes.col.kind')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('staff.mistakes.col.severity')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('staff.mistakes.col.evidence')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('staff.mistakes.col.review')}
                </th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((item) => {
                const detail = detailText(item, t);
                return (
                  <tr key={item.key} className="h-9 border-b border-border/60">
                    <td className="px-3 py-1.5 whitespace-nowrap tabular-nums">
                      {dateTimeText(item.at)}
                    </td>
                    {userId === undefined ? <td className="px-3 py-1.5">{item.name}</td> : null}
                    <td className="px-3 py-1.5">
                      {kindText(item.kind, t)}
                      {detail === null ? null : (
                        <span className="ml-2 text-xs text-muted-foreground">{detail}</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      <StatusBadge
                        tone={
                          item.severity === 'high'
                            ? 'danger'
                            : item.severity === 'medium'
                              ? 'warning'
                              : 'neutral'
                        }
                      >
                        {t(`staff.severity.${item.severity}`)}
                      </StatusBadge>
                    </td>
                    <td className="px-3 py-1.5">
                      <RefLink refTo={item.ref}>{evidenceText(item, t)}</RefLink>
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-2">
                        {item.review === null ? (
                          <StatusBadge tone="neutral">
                            {t('staff.mistakes.status.unreviewed')}
                          </StatusBadge>
                        ) : (
                          <StatusBadge
                            tone={item.review.status === 'confirmed' ? 'danger' : 'success'}
                          >
                            {t(`staff.mistakes.status.${item.review.status}`)}
                          </StatusBadge>
                        )}
                        {item.review?.note == null ? null : (
                          <span
                            className="max-w-48 truncate text-xs text-muted-foreground"
                            title={item.review.note}
                          >
                            {item.review.note}
                          </span>
                        )}
                        {mayReview ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setReviewing(item);
                            }}
                          >
                            {t('staff.mistakes.review')}
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {reviewing === null ? null : (
        <ReviewDialog
          item={reviewing}
          period={period}
          onClose={() => {
            setReviewing(null);
          }}
        />
      )}
    </div>
  );
}

function ReviewDialog({
  item,
  period,
  onClose,
}: {
  readonly item: MistakeItem;
  readonly period: Period;
  readonly onClose: () => void;
}) {
  const t = useStaffT();
  const queries = useQueryClient();
  const [note, setNote] = useState(item.review?.note ?? '');
  const save = useMutation({
    mutationFn: (status: 'confirmed' | 'dismissed') =>
      reviewMistake({
        key: item.key,
        ...period,
        status,
        note: note.trim() === '' ? null : note.trim(),
      }),
    onSuccess: async () => {
      await queries.invalidateQueries({ queryKey: STAFF_KEY });
      onClose();
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('staff.mistakes.reviewTitle')}
      description={t('staff.mistakes.reviewDetail')}
      closeLabel={t('staff.mistakes.cancel')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('staff.mistakes.cancel')}
          </Button>
          <Button
            variant="outline"
            disabled={save.isPending}
            onClick={() => {
              save.mutate('dismissed');
            }}
          >
            {t('staff.mistakes.dismiss')}
          </Button>
          <Button
            disabled={save.isPending}
            onClick={() => {
              save.mutate('confirmed');
            }}
          >
            {t('staff.mistakes.confirm')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm">
          <span className="font-medium">{item.name}</span> · {kindText(item.kind, t)} ·{' '}
          <span className="tabular-nums">{dateTimeText(item.at)}</span>
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="mistake-note">{t('staff.mistakes.note')}</Label>
          <Input
            id="mistake-note"
            value={note}
            maxLength={500}
            placeholder={t('staff.mistakes.notePlaceholder')}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
        </div>
        {save.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {t('staff.failed')}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
