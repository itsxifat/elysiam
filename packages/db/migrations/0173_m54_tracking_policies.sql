-- Tenant isolation and integrity for M54: the tracking hub (invariant 4; D-957 to D-969).
--
-- The policies are `tenantTableSql()`'s, pasted verbatim as every tenant policy in this repo is
-- (D-048). The grants and triggers are where the decisions are:
--
-- * `settings`, `destinations`: one row per brand (and platform), written and edited, never
--   deleted (a destination is switched off instead).
-- * `events`: inserted once per server event (the unique index), then only its sealed payload is
--   cleared once every delivery is final; deleted past the brand's retention (D-964).
-- * `deliveries`: one per event and platform (D-962); `sent` and `skipped` are final, a `failed`
--   one goes back to `queued` only (Retry), `waiting` goes to `queued` or `skipped`. Never deleted
--   by the app: they go with their event (the cascade runs as the owner).
-- * `order_signals`: written at checkout, deleted 60 days later (D-963).
--
-- No analytics read on any of them.

alter table "tracking"."settings" enable row level security;
--> statement-breakpoint
alter table "tracking"."settings" force row level security;
--> statement-breakpoint
drop policy if exists "settings_org_isolation" on "tracking"."settings";
--> statement-breakpoint
create policy "settings_org_isolation" on "tracking"."settings"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "tracking" to "erp_app";
--> statement-breakpoint
grant select, insert, update on "tracking"."settings" to "erp_app";
--> statement-breakpoint
alter table "tracking"."destinations" enable row level security;
--> statement-breakpoint
alter table "tracking"."destinations" force row level security;
--> statement-breakpoint
drop policy if exists "destinations_org_isolation" on "tracking"."destinations";
--> statement-breakpoint
create policy "destinations_org_isolation" on "tracking"."destinations"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert, update on "tracking"."destinations" to "erp_app";
--> statement-breakpoint
alter table "tracking"."events" enable row level security;
--> statement-breakpoint
alter table "tracking"."events" force row level security;
--> statement-breakpoint
drop policy if exists "events_org_isolation" on "tracking"."events";
--> statement-breakpoint
create policy "events_org_isolation" on "tracking"."events"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert, update, delete on "tracking"."events" to "erp_app";
--> statement-breakpoint
alter table "tracking"."deliveries" enable row level security;
--> statement-breakpoint
alter table "tracking"."deliveries" force row level security;
--> statement-breakpoint
drop policy if exists "deliveries_org_isolation" on "tracking"."deliveries";
--> statement-breakpoint
create policy "deliveries_org_isolation" on "tracking"."deliveries"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert, update on "tracking"."deliveries" to "erp_app";
--> statement-breakpoint
alter table "tracking"."order_signals" enable row level security;
--> statement-breakpoint
alter table "tracking"."order_signals" force row level security;
--> statement-breakpoint
drop policy if exists "order_signals_org_isolation" on "tracking"."order_signals";
--> statement-breakpoint
create policy "order_signals_org_isolation" on "tracking"."order_signals"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert, update, delete on "tracking"."order_signals" to "erp_app";
--> statement-breakpoint

-- An event is the event it was: only its sealed payload may be cleared (never set again).
create or replace function tracking.assert_event_change() returns trigger
language plpgsql as $$
begin
  if (new.id, new.org_id, new.kind, new.event_id, new.event_name, new.stage, new.order_id,
      new.value_poisha, new.currency, new.action_source, new.user_masked, new.match_keys,
      new.custom_data, new.event_time, new.test_mode, new.expires_at, new.created_at)
     is distinct from
     (old.id, old.org_id, old.kind, old.event_id, old.event_name, old.stage, old.order_id,
      old.value_poisha, old.currency, old.action_source, old.user_masked, old.match_keys,
      old.custom_data, old.event_time, old.test_mode, old.expires_at, old.created_at) then
    raise exception 'CONFLICT: a tracking event does not change.'
      using errcode = 'check_violation';
  end if;
  if new.payload_sealed is not null
     and new.payload_sealed is distinct from old.payload_sealed then
    raise exception 'CONFLICT: a tracking event''s payload is only ever cleared.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger events_fixed
before update on tracking.events
for each row execute function tracking.assert_event_change();
--> statement-breakpoint

-- A delivery is to one platform for one event; sent and skipped are final; failed goes back to
-- queued only (Retry); waiting goes to queued or skipped.
create or replace function tracking.assert_delivery_change() returns trigger
language plpgsql as $$
begin
  if (new.id, new.org_id, new.event_row_id, new.destination, new.created_at)
     is distinct from (old.id, old.org_id, old.event_row_id, old.destination, old.created_at) then
    raise exception 'CONFLICT: a delivery''s event and platform are fixed.'
      using errcode = 'check_violation';
  end if;
  if old.status in ('sent', 'skipped') and new is distinct from old then
    raise exception 'CONFLICT: this delivery is final.'
      using errcode = 'check_violation';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'queued' and new.status in ('sent', 'failed', 'skipped'))
    or (old.status = 'failed' and new.status = 'queued')
    or (old.status = 'waiting' and new.status in ('queued', 'skipped'))) then
    raise exception 'CONFLICT: a delivery cannot go from % to %.', old.status, new.status
      using errcode = 'check_violation';
  end if;
  if new.attempts < old.attempts then
    raise exception 'CONFLICT: a delivery''s attempts only grow.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger deliveries_moves
before update on tracking.deliveries
for each row execute function tracking.assert_delivery_change();
