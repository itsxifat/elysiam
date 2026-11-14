-- Tenant isolation and integrity for M57: staff activity (invariant 4; D-1000 to D-1006).
--
-- The policies are `tenantTableSql()`'s, pasted verbatim as every tenant policy in this repo is
-- (D-048). The grants and the trigger are where the decisions are:
--
-- * `staff_activity.settings`: one row per brand, written and edited, never deleted.
-- * `staff_activity.mistake_reviews`: one per reviewed mistake, changed by a later review, never
--   deleted (each change is audited).
-- * `team.presence_spans`: inserted by the heartbeat, then only its end moves forward; deleted
--   past 400 days by the team module's purge (D-1005).
--
-- No analytics read on any of them.

alter table "staff_activity"."settings" enable row level security;
--> statement-breakpoint
alter table "staff_activity"."settings" force row level security;
--> statement-breakpoint
drop policy if exists "settings_org_isolation" on "staff_activity"."settings";
--> statement-breakpoint
create policy "settings_org_isolation" on "staff_activity"."settings"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant usage on schema "staff_activity" to "erp_app";
--> statement-breakpoint
grant select, insert, update on "staff_activity"."settings" to "erp_app";
--> statement-breakpoint
alter table "staff_activity"."mistake_reviews" enable row level security;
--> statement-breakpoint
alter table "staff_activity"."mistake_reviews" force row level security;
--> statement-breakpoint
drop policy if exists "mistake_reviews_org_isolation" on "staff_activity"."mistake_reviews";
--> statement-breakpoint
create policy "mistake_reviews_org_isolation" on "staff_activity"."mistake_reviews"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert, update on "staff_activity"."mistake_reviews" to "erp_app";
--> statement-breakpoint
alter table "team"."presence_spans" enable row level security;
--> statement-breakpoint
alter table "team"."presence_spans" force row level security;
--> statement-breakpoint
drop policy if exists "presence_spans_org_isolation" on "team"."presence_spans";
--> statement-breakpoint
create policy "presence_spans_org_isolation" on "team"."presence_spans"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
grant select, insert, update, delete on "team"."presence_spans" to "erp_app";
--> statement-breakpoint

-- A span is the time it covers, extended while the state holds: only its end moves, and only on.
create or replace function team.assert_presence_span_change() returns trigger
language plpgsql as $$
begin
  if (new.id, new.org_id, new.user_id, new.state, new.paused, new.started_at, new.created_at)
     is distinct from
     (old.id, old.org_id, old.user_id, old.state, old.paused, old.started_at, old.created_at) then
    raise exception 'CONFLICT: a presence span only grows at its end.'
      using errcode = 'check_violation';
  end if;
  if new.ended_at < old.ended_at then
    raise exception 'CONFLICT: a presence span never shrinks.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger presence_spans_grow
before update on team.presence_spans
for each row execute function team.assert_presence_span_change();
