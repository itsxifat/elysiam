import type {
  TrackingDestinationKind,
  TrackingDestinationView,
  TrackingEventView,
  TrackingHubSettingsInput,
  TrackingOrderStage,
  TrackingPurchaseStage,
  TrackingSetupView,
  TrackingWebRoute,
} from '@elysium/contracts';
import type { Locale, MessageKey } from '@elysium/i18n';
import { Button, Checkbox, DateTime, Money, Select, StatusBadge } from '@elysium/ui';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { useAbility } from '../../auth/session.js';
import { useLocale, useT } from '../../i18n/locale.js';
import '../../i18n/web-marketing.js';
import { SecretInput, secretField, type Secret } from '../website/marketing-parts.js';
import { useWebsiteT } from '../website/messages.js';
import { control, Empty, Field, NamedSection, Problem } from '../website/parts.js';
import { Loadable, SettingsPage } from './parts.js';
import {
  getTrackingSetup,
  getTrackingSummary,
  listTrackingLog,
  retryTrackingDelivery,
  saveTrackingDestination,
  saveTrackingSettings,
  testTrackingDestination,
} from './tracking-api.js';

const QUERY_KEY = ['tracking', 'setup'] as const;
const STAGES: readonly TrackingOrderStage[] = [
  'placed',
  'confirmed',
  'delivered',
  'returned',
  'cancelled',
];
const PURCHASE_STAGES: readonly TrackingPurchaseStage[] = ['placed', 'confirmed', 'delivered'];
/** The platforms M54a sends to; TikTok and Google Ads arrive in M54b. */
const LIVE: readonly TrackingDestinationKind[] = ['meta', 'ga4'];

/**
 * Settings → Tracking (M54, D-957 to D-969): the platforms the brand sends to, the stage an order
 * counts as a Purchase, which order stages go where, the website's browser events and paths, and
 * the log of what was sent with a Retry for a failed send.
 *
 * Marketing runs the switches (`update Tracking`); a platform's ids and secret are the org
 * admin's (`update TrackingCredentials`). Secrets are write-only; the screen shows a fingerprint.
 */
export function TrackingSettingsPage() {
  const query = useQuery({ queryKey: QUERY_KEY, queryFn: getTrackingSetup });
  return (
    <SettingsPage tab="/settings/tracking">
      <Loadable query={query}>
        {(value) => (
          <>
            <Notices value={value} />
            <Destinations value={value} />
            <OrderStages value={value} />
            <Week />
            <EventLog />
          </>
        )}
      </Loadable>
    </SettingsPage>
  );
}

function Notices({ value }: { readonly value: TrackingSetupView }) {
  const t = useT();
  const notes: MessageKey[] = [];
  if (value.provider === 'fake') notes.push('wm.track.fakeProvider');
  if (!value.credentialsKey) notes.push('wm.track.noKey');
  if (value.settings.importedFrom !== null && value.settings.importedFrom !== 'none') {
    notes.push('wm.hub.imported');
  }
  notes.push('wm.track.unverified');
  return (
    <div className="space-y-1.5">
      {notes.map((note) => (
        <p key={note} role="status" className="text-sm text-muted-foreground">
          {t(note)}
        </p>
      ))}
    </div>
  );
}

// --- platforms --------------------------------------------------------------------------------

function Destinations({ value }: { readonly value: TrackingSetupView }) {
  const t = useT();
  return (
    <NamedSection title={t('wm.hub.destinations')} description={t('wm.hub.destinationsHelp')}>
      <div className="space-y-6">
        {value.destinations.map((destination) =>
          LIVE.includes(destination.kind) ? (
            <DestinationForm key={destination.kind} destination={destination} />
          ) : (
            <div
              key={destination.kind}
              className="flex items-center justify-between border-t border-border pt-4 text-sm"
            >
              <span className="font-medium">
                {t(destination.kind === 'tiktok' ? 'wm.hub.tiktok' : 'wm.hub.googleAds')}
              </span>
              <StatusBadge tone="neutral">{t('wm.hub.comingSoon')}</StatusBadge>
            </div>
          ),
        )}
      </div>
    </NamedSection>
  );
}

function DestinationForm({ destination }: { readonly destination: TrackingDestinationView }) {
  const t = useT();
  const w = useWebsiteT();
  const id = useId();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const mayUpdate = ability.can('update', 'Tracking');
  const mayCredentials = ability.can('update', 'TrackingCredentials');
  const isMeta = destination.kind === 'meta';
  const [enabled, setEnabled] = useState(destination.enabled);
  const [clientEnabled, setClientEnabled] = useState(destination.clientEnabled);
  const [pixelId, setPixelId] = useState(destination.publicIds.pixelId ?? '');
  const [datasetId, setDatasetId] = useState(destination.publicIds.datasetId ?? '');
  const [measurementId, setMeasurementId] = useState(destination.publicIds.measurementId ?? '');
  const [apiVersion, setApiVersion] = useState(destination.apiVersion);
  const [testCode, setTestCode] = useState(destination.testCode);
  const [secret, setSecret] = useState<Secret>({ mode: 'keep' });
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: () => {
      const value = secretField(secret);
      const withSecret = (key: 'accessToken' | 'apiSecret') =>
        value === undefined ? {} : { [key]: value };
      return saveTrackingDestination(
        isMeta
          ? {
              kind: 'meta',
              enabled,
              clientEnabled,
              pixelId: pixelId.trim(),
              datasetId: datasetId.trim(),
              apiVersion: apiVersion.trim(),
              testCode: testCode.trim(),
              ...withSecret('accessToken'),
            }
          : {
              kind: 'ga4',
              enabled,
              clientEnabled,
              measurementId: measurementId.trim().toUpperCase(),
              ...withSecret('apiSecret'),
            },
      );
    },
    onMutate: () => setSaved(false),
    onSuccess: (next) => {
      queryClient.setQueryData(QUERY_KEY, next);
      setSecret({ mode: 'keep' });
      setSaved(true);
    },
  });
  const test = useMutation({
    mutationFn: () => testTrackingDestination(isMeta ? 'meta' : 'ga4'),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  return (
    <div className="space-y-3 border-t border-border pt-4 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t(isMeta ? 'wm.track.meta' : 'wm.track.ga4')}</h3>
        <StatusBadge tone={destination.ready ? 'success' : 'neutral'}>
          {t(destination.ready ? 'wm.hub.ready' : 'wm.hub.notReady')}
        </StatusBadge>
      </div>
      <fieldset disabled={!mayUpdate} className="space-y-3">
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={enabled} onCheckedChange={(next) => setEnabled(next === true)} />
            {t(isMeta ? 'wm.track.capiOn' : 'wm.track.mpOn')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={clientEnabled}
              onCheckedChange={(next) => setClientEnabled(next === true)}
            />
            {t(isMeta ? 'wm.track.pixelOn' : 'wm.track.gtagOn')}
          </label>
        </div>
        {mayUpdate && !mayCredentials ? (
          <p className="text-xs text-muted-foreground">{t('wm.track.adminOnly')}</p>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          {isMeta ? (
            <>
              <Field id={`${id}-pixel`} label={t('wm.track.pixelId')}>
                <input
                  id={`${id}-pixel`}
                  value={pixelId}
                  inputMode="numeric"
                  maxLength={24}
                  disabled={!mayCredentials}
                  className={control}
                  onChange={(event) => setPixelId(event.target.value)}
                />
              </Field>
              <Field
                id={`${id}-dataset`}
                label={t('wm.track.datasetId')}
                hint={t('wm.track.datasetHelp')}
              >
                <input
                  id={`${id}-dataset`}
                  value={datasetId}
                  inputMode="numeric"
                  maxLength={24}
                  disabled={!mayCredentials}
                  className={control}
                  onChange={(event) => setDatasetId(event.target.value)}
                />
              </Field>
              <SecretInput
                id={`${id}-token`}
                label={t('wm.track.token')}
                fingerprint={destination.secretFingerprint}
                secret={secret}
                onChange={setSecret}
                maxLength={600}
                disabled={!mayCredentials}
              />
              <Field id={`${id}-version`} label={t('wm.track.apiVersion')}>
                <input
                  id={`${id}-version`}
                  value={apiVersion}
                  maxLength={8}
                  className={control}
                  onChange={(event) => setApiVersion(event.target.value)}
                />
              </Field>
              <Field
                id={`${id}-test`}
                label={t('wm.track.testCode')}
                hint={t('wm.track.testCodeHelp')}
              >
                <input
                  id={`${id}-test`}
                  value={testCode}
                  maxLength={64}
                  className={control}
                  onChange={(event) => setTestCode(event.target.value)}
                />
              </Field>
            </>
          ) : (
            <>
              <Field id={`${id}-measurement`} label={t('wm.track.measurementId')}>
                <input
                  id={`${id}-measurement`}
                  value={measurementId}
                  maxLength={24}
                  placeholder="G-XXXXXXX"
                  disabled={!mayCredentials}
                  className={control}
                  onChange={(event) => setMeasurementId(event.target.value)}
                />
              </Field>
              <SecretInput
                id={`${id}-secret`}
                label={t('wm.track.apiSecret')}
                fingerprint={destination.secretFingerprint}
                secret={secret}
                onChange={setSecret}
                maxLength={120}
                disabled={!mayCredentials}
              />
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
            {w('web.save')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!destination.ready || test.isPending}
            onClick={() => test.mutate()}
          >
            {t('wm.hub.test')}
          </Button>
          {saved ? (
            <span role="status" className="text-xs text-muted-foreground">
              {w('web.saved')}
            </span>
          ) : null}
          {test.data === undefined ? null : (
            <span role="status" className="text-xs text-muted-foreground">
              {test.data.ok
                ? t('wm.hub.testOk')
                : `${t('wm.hub.testFailed')} ${test.data.error ?? ''}`}
            </span>
          )}
          {destination.lastTestAt === null || test.data !== undefined ? null : (
            <span className="text-xs text-muted-foreground">
              {t('wm.hub.lastTest')}: <DateTime value={destination.lastTestAt} />{' '}
              {destination.lastTestStatus === 'ok' ? t('wm.hub.testOk') : t('wm.hub.testFailed')}
            </span>
          )}
        </div>
        <Problem error={save.error ?? test.error} />
      </fieldset>
    </div>
  );
}

// --- order stages and the website ---------------------------------------------------------------

function OrderStages({ value }: { readonly value: TrackingSetupView }) {
  const t = useT();
  const w = useWebsiteT();
  const id = useId();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const mayUpdate = ability.can('update', 'Tracking');
  const initial = value.settings;
  const [purchaseStage, setPurchaseStage] = useState(initial.purchaseStage);
  const [routes, setRoutes] = useState(initial.stageRoutes);
  const [webRoutes, setWebRoutes] = useState<readonly TrackingWebRoute[]>(initial.webRoutes);
  const [proxy, setProxy] = useState(initial.proxy);
  const [testMode, setTestMode] = useState(initial.testMode);
  const [nameAndCity, setNameAndCity] = useState(initial.sendNameAndCity);
  const [chatToGa4, setChatToGa4] = useState(initial.chatToGa4);
  const [country, setCountry] = useState(initial.defaultCountryCode);
  const [retention, setRetention] = useState(String(initial.logRetentionDays));
  const [saved, setSaved] = useState(false);

  const retentionValid =
    /^\d{1,3}$/.test(retention) && Number(retention) >= 1 && Number(retention) <= 365;
  const save = useMutation({
    mutationFn: () => {
      const input: TrackingHubSettingsInput = {
        purchaseStage,
        stageRoutes: routes,
        webRoutes: [...webRoutes],
        proxy,
        testMode,
        sendNameAndCity: nameAndCity,
        chatToGa4,
        defaultCountryCode: country.trim(),
        logRetentionDays: Number(retention),
      };
      return saveTrackingSettings(input);
    },
    onMutate: () => setSaved(false),
    onSuccess: (next) => {
      queryClient.setQueryData(QUERY_KEY, next);
      setSaved(true);
    },
  });
  const routed = (stage: TrackingOrderStage, kind: 'meta' | 'ga4') =>
    routes[stage]?.[kind] !== false;
  const setRouted = (stage: TrackingOrderStage, kind: 'meta' | 'ga4', on: boolean) =>
    setRoutes({ ...routes, [stage]: { ...routes[stage], [kind]: on } });
  const setWebRoute = (index: number, patch: Partial<TrackingWebRoute>) =>
    setWebRoutes(webRoutes.map((route, at) => (at === index ? { ...route, ...patch } : route)));

  const actions = mayUpdate ? (
    <div className="flex items-center gap-3">
      {saved ? (
        <span role="status" className="text-xs text-muted-foreground">
          {w('web.saved')}
        </span>
      ) : null}
      <Button size="sm" disabled={save.isPending || !retentionValid} onClick={() => save.mutate()}>
        {w('web.save')}
      </Button>
    </div>
  ) : null;

  return (
    <NamedSection
      title={t('wm.hub.purchase')}
      description={t('wm.hub.purchaseHelp')}
      actions={actions}
    >
      <fieldset disabled={!mayUpdate} className="space-y-6">
        <div className="max-w-sm">
          <label htmlFor={`${id}-purchase`} className="sr-only">
            {t('wm.hub.purchase')}
          </label>
          <Select
            id={`${id}-purchase`}
            size="sm"
            value={purchaseStage}
            onValueChange={(next) => setPurchaseStage(next as TrackingPurchaseStage)}
            options={PURCHASE_STAGES.map((stage) => ({
              value: stage,
              label: t(`wm.hub.purchase.${stage}` as MessageKey),
            }))}
          />
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-semibold">{t('wm.hub.stages')}</h3>
          <p className="text-xs text-muted-foreground">{t('wm.hub.stagesHelp')}</p>
          <table className="w-full text-sm [&_td]:pr-3 [&_th]:h-9 [&_th]:pr-3">
            <caption className="sr-only">{t('wm.hub.stages')}</caption>
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="font-medium">{t('wm.hub.stage')}</th>
                <th className="font-medium">{t('wm.track.toMeta')}</th>
                <th className="font-medium">{t('wm.track.toGa4')}</th>
              </tr>
            </thead>
            <tbody>
              {STAGES.map((stage) => (
                <tr key={stage} className="h-row border-b border-border last:border-b-0">
                  <td>
                    {t(`wm.hub.stage.${stage}` as MessageKey)}
                    {stage === purchaseStage ? (
                      <span className="ml-2 font-mono text-xs text-muted-foreground">Purchase</span>
                    ) : null}
                  </td>
                  {(['meta', 'ga4'] as const).map((kind) => (
                    <td key={kind}>
                      <Checkbox
                        aria-label={`${t(`wm.hub.stage.${stage}` as MessageKey)}: ${t(
                          kind === 'meta' ? 'wm.track.toMeta' : 'wm.track.toGa4',
                        )}`}
                        checked={routed(stage, kind)}
                        onCheckedChange={(next) => setRouted(stage, kind, next === true)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={nameAndCity}
                onCheckedChange={(next) => setNameAndCity(next === true)}
              />
              {t('wm.hub.nameAndCity')}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={chatToGa4}
                onCheckedChange={(next) => setChatToGa4(next === true)}
              />
              {t('wm.hub.chatToGa4')}
            </label>
          </div>
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-semibold">{t('wm.hub.website')}</h3>
          <p className="text-xs text-muted-foreground">{t('wm.track.eventsHelp')}</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm [&_td]:pr-3 [&_th]:h-9 [&_th]:pr-3">
              <caption className="sr-only">{t('wm.track.events')}</caption>
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="font-medium">{t('wm.track.event')}</th>
                  <th className="font-medium">{t('wm.track.on')}</th>
                  <th className="font-medium">{t('wm.track.browser')}</th>
                  <th className="font-medium">{t('wm.track.server')}</th>
                  <th className="font-medium">{t('wm.track.toMeta')}</th>
                  <th className="font-medium">{t('wm.track.toGa4')}</th>
                </tr>
              </thead>
              <tbody>
                {webRoutes.map((route, index) => (
                  <tr key={route.name} className="h-row border-b border-border last:border-b-0">
                    <td className="font-mono text-xs">{route.name}</td>
                    {(['enabled', 'client', 'server', 'meta', 'ga4'] as const).map((key) => (
                      <td key={key}>
                        <Checkbox
                          aria-label={`${route.name}: ${t(ROUTE_LABEL[key])}`}
                          checked={route[key]}
                          onCheckedChange={(next) => setWebRoute(index, { [key]: next === true })}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">{t('wm.track.proxyHelp')}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            {(
              [
                ['metaScriptPath', 'wm.track.metaScript'],
                ['metaCollectPath', 'wm.track.metaCollect'],
                ['ga4ScriptPath', 'wm.track.ga4Script'],
                ['ga4CollectPath', 'wm.track.ga4Collect'],
              ] as const
            ).map(([key, label]) => (
              <Field key={key} id={`${id}-${key}`} label={t(label)}>
                <input
                  id={`${id}-${key}`}
                  value={proxy[key]}
                  maxLength={80}
                  className={control}
                  onChange={(event) => setProxy({ ...proxy, [key]: event.target.value })}
                />
              </Field>
            ))}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <label className="flex items-center gap-2 self-end text-sm sm:col-span-3">
            <Checkbox checked={testMode} onCheckedChange={(next) => setTestMode(next === true)} />
            {t('wm.track.testMode')}
          </label>
          <Field id={`${id}-country`} label={t('wm.track.country')}>
            <input
              id={`${id}-country`}
              value={country}
              inputMode="numeric"
              maxLength={4}
              className={control}
              onChange={(event) => setCountry(event.target.value)}
            />
          </Field>
          <Field id={`${id}-retention`} label={t('wm.track.retention')}>
            <input
              id={`${id}-retention`}
              value={retention}
              inputMode="numeric"
              maxLength={3}
              aria-invalid={!retentionValid}
              className={control}
              onChange={(event) => setRetention(event.target.value)}
            />
          </Field>
        </div>
        <Problem error={save.error} />
      </fieldset>
    </NamedSection>
  );
}

const ROUTE_LABEL: Readonly<Record<'enabled' | 'client' | 'server' | 'meta' | 'ga4', MessageKey>> =
  {
    enabled: 'wm.track.on',
    client: 'wm.track.browser',
    server: 'wm.track.server',
    meta: 'wm.track.toMeta',
    ga4: 'wm.track.toGa4',
  };

// --- the week and the log -----------------------------------------------------------------------

function Week() {
  const t = useT();
  const summary = useQuery({ queryKey: ['tracking', 'summary'], queryFn: getTrackingSummary });
  const rows = (summary.data?.destinations ?? []).filter((row) => LIVE.includes(row.destination));
  return (
    <NamedSection title={t('wm.hub.week')}>
      {summary.isPending ? (
        <p className="text-sm text-muted-foreground">{t('wm.loading')}</p>
      ) : (
        <dl className="grid gap-4 sm:grid-cols-2">
          {rows.map((row) => (
            <div key={row.destination} className="space-y-1">
              <dt className="text-sm font-medium">
                {t(row.destination === 'meta' ? 'wm.track.meta' : 'wm.track.ga4')}
              </dt>
              <dd className="text-sm text-muted-foreground tabular-nums">
                {String(row.sent)} {t('wm.hub.weekSent')} · {String(row.failed)}{' '}
                {t('wm.hub.weekFailed')} · {String(row.skipped)} {t('wm.hub.weekSkipped')} ·{' '}
                {String(row.waiting)} {t('wm.hub.weekWaiting')}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <Problem error={summary.error} />
    </NamedSection>
  );
}

const STATUS_TONE: Readonly<Record<string, 'success' | 'warning' | 'danger' | 'neutral'>> = {
  sent: 'success',
  partial: 'warning',
  queued: 'warning',
  waiting: 'warning',
  failed: 'danger',
  skipped: 'neutral',
};

const STATUSES = ['waiting', 'queued', 'sent', 'failed', 'skipped'] as const;

function EventLog() {
  const t = useT();
  const id = useId();
  const { locale } = useLocale();
  const [status, setStatus] = useState('');
  const [destination, setDestination] = useState('');
  const log = useInfiniteQuery({
    queryKey: ['tracking', 'events', status, destination],
    queryFn: ({ pageParam }) =>
      listTrackingLog({
        ...(status === '' ? {} : { status: status as (typeof STATUSES)[number] }),
        ...(destination === '' ? {} : { destination: destination as TrackingDestinationKind }),
        ...(pageParam === '' ? {} : { cursor: pageParam }),
      }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = (log.data?.pages ?? []).flatMap((page) => page.items);

  return (
    <NamedSection
      title={t('wm.log.title')}
      description={t('wm.log.description')}
      actions={
        <div className="flex gap-2">
          <label htmlFor={`${id}-platform`} className="sr-only">
            {t('wm.log.platforms')}
          </label>
          <Select
            id={`${id}-platform`}
            size="sm"
            variant="filter"
            value={destination}
            onValueChange={setDestination}
            options={[
              { value: '', label: t('wm.log.allPlatforms') },
              { value: 'meta', label: t('wm.track.meta') },
              { value: 'ga4', label: t('wm.track.ga4') },
            ]}
          />
          <label htmlFor={`${id}-status`} className="sr-only">
            {t('wm.log.status')}
          </label>
          <Select
            id={`${id}-status`}
            size="sm"
            variant="filter"
            value={status}
            onValueChange={setStatus}
            options={[
              { value: '', label: t('wm.log.all') },
              ...STATUSES.map((value) => ({
                value,
                label: t(`wm.log.state.${value}` as MessageKey),
              })),
            ]}
          />
        </div>
      }
    >
      {log.isPending ? (
        <p className="text-sm text-muted-foreground">{t('wm.loading')}</p>
      ) : rows.length === 0 ? (
        <Empty />
      ) : (
        <TrackingTable rows={rows} locale={locale} />
      )}
      {log.hasNextPage ? (
        <div className="mt-3">
          <Button
            size="sm"
            variant="outline"
            disabled={log.isFetchingNextPage}
            onClick={() => void log.fetchNextPage()}
          >
            {t('wm.log.more')}
          </Button>
        </div>
      ) : null}
      <Problem error={log.error} />
    </NamedSection>
  );
}

/** The events and their deliveries: the log's table, and the order page's Tracking card. */
export function TrackingTable({
  rows,
  locale,
}: {
  readonly rows: readonly TrackingEventView[];
  readonly locale: Locale;
}) {
  const t = useT();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm [&_td]:pr-3 [&_th]:h-9 [&_th]:pr-3">
        <caption className="sr-only">{t('wm.log.title')}</caption>
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="font-medium">{t('wm.log.when')}</th>
            <th className="font-medium">{t('wm.track.event')}</th>
            <th className="font-medium">{t('wm.log.platforms')}</th>
            <th className="font-medium">{t('wm.log.who')}</th>
            <th className="text-right font-medium">{t('wm.log.value')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <TrackingRow key={row.id} row={row} locale={locale} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TrackingRow({
  row,
  locale,
}: {
  readonly row: TrackingEventView;
  readonly locale: Locale;
}) {
  const t = useT();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const retry = useMutation({
    mutationFn: retryTrackingDelivery,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['tracking'] }),
  });
  const who = row.user.email !== '' ? row.user.email : row.user.phone;
  return (
    <tr className="h-row border-b border-border align-top last:border-b-0">
      <td className="whitespace-nowrap">
        <DateTime value={row.createdAt} />
      </td>
      <td>
        <span className="font-mono text-xs">{row.eventName}</span>
        <span className="ml-2 text-xs text-muted-foreground">
          {t(`wm.log.kind.${row.kind}` as MessageKey)}
          {row.orderNo === null ? '' : ` ${row.orderNo}`}
          {row.testMode ? ` · ${t('wm.log.test')}` : ''}
        </span>
      </td>
      <td className="space-y-1">
        {row.deliveries.map((delivery) => (
          <div key={delivery.id} className="flex flex-wrap items-center gap-2">
            <span className="text-xs">
              {t(delivery.destination === 'meta' ? 'wm.track.toMeta' : 'wm.track.toGa4')}
            </span>
            <StatusBadge tone={STATUS_TONE[delivery.status] ?? 'neutral'}>
              {t(`wm.log.state.${delivery.status}` as MessageKey)}
            </StatusBadge>
            {delivery.error === null ? null : (
              <span
                className="max-w-60 truncate text-xs text-muted-foreground"
                title={delivery.error}
              >
                {delivery.error}
              </span>
            )}
            {delivery.status === 'failed' && ability.can('update', 'Tracking') ? (
              <Button
                size="sm"
                variant="outline"
                disabled={retry.isPending}
                onClick={() => retry.mutate(delivery.id)}
              >
                {t('wm.log.retry')}
              </Button>
            ) : null}
          </div>
        ))}
      </td>
      <td className="text-xs">{who}</td>
      <td className="text-right text-xs tabular-nums">
        {row.value === null ? null : <Money poisha={row.value} locale={locale} />}
      </td>
    </tr>
  );
}
