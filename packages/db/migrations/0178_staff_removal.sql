ALTER TABLE "iam"."users" ADD COLUMN "deleted_at" timestamp with time zone;
--> statement-breakpoint
-- Release live work in the same transaction as the last role is revoked. This is an
-- invoker function: forced RLS still confines every change to app.org_id.
create function iam.release_staff_assignments(p_org uuid, p_user text) returns void
language plpgsql set search_path = pg_catalog, public as $$
begin
  if p_org is distinct from nullif(current_setting('app.org_id', true), '')::uuid then
    raise exception 'Staff cleanup requires the brand context' using errcode = '42501';
  end if;
  if exists (select 1 from iam.memberships m join iam.users u on u.id = m.user_id
             where m.org_id = p_org and m.user_id = p_user and m.is_active and u.is_active) then
    return;
  end if;
  delete from packing.terminal_members where org_id = p_org and user_id = p_user;
  update packing.terminal_devices set last_user_id = null, user_since = null, updated_at = now()
    where org_id = p_org and last_user_id = p_user;
  update packing.scanner_devices set revoked_at = now(),
    revoked_by = coalesce(nullif(current_setting('app.user_id', true), ''), p_user), updated_at = now()
    where org_id = p_org and user_id = p_user and revoked_at is null;
  update team.desk_profiles set work_types = '{}', hub_location_id = null, updated_at = now()
    where org_id = p_org and user_id = p_user;
  update team.presence set paused = true, paused_at = now(), updated_at = now()
    where org_id = p_org and user_id = p_user;
  update sales.orders set assigned_to = null, assigned_at = null, updated_at = now()
    where org_id = p_org and assigned_to = p_user and status in ('pending', 'on_hold', 'confirmed');
  update sales.order_offers set status = 'withdrawn', responded_at = now(), updated_at = now()
    where org_id = p_org and user_id = p_user and status = 'offered';
  update inbox.conversations set assigned_to = null, assigned_at = null, updated_at = now()
    where org_id = p_org and assigned_to = p_user and status = 'open';
  update inbox.conversation_offers set status = 'withdrawn', responded_at = now(), updated_at = now()
    where org_id = p_org and user_id = p_user and status = 'offered';
end;
$$;
--> statement-breakpoint
-- Kept on purpose (ledger audit): the employee record's sign-in link, which payroll's target
-- bonus and mistakes read through, and the phone extension, which missed calls are attributed
-- through; Settings → Calls shows a leaver's extension as not current and gives it to another.
revoke all on function iam.release_staff_assignments(uuid, text) from public;
--> statement-breakpoint
grant execute on function iam.release_staff_assignments(uuid, text) to "erp_app";
--> statement-breakpoint
create function iam.release_deactivated_staff() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if old.is_active and not new.is_active then
    perform iam.release_staff_assignments(new.org_id, new.user_id);
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger memberships_release_deactivated_staff after update of is_active on iam.memberships
for each row execute function iam.release_deactivated_staff();
--> statement-breakpoint
-- Repair assignments left by earlier deactivations, one RLS context at a time.
do $$
declare brand record; person record;
begin
  for brand in select id from org.organizations loop
    perform set_config('app.org_id', brand.id::text, true);
    for person in select distinct m.user_id from iam.memberships m join iam.users u on u.id = m.user_id
      where m.org_id = brand.id and (not u.is_active or not exists (
        select 1 from iam.memberships active where active.org_id = brand.id
          and active.user_id = m.user_id and active.is_active
      ))
    loop
      perform iam.release_staff_assignments(brand.id, person.user_id);
    end loop;
  end loop;
  perform set_config('app.org_id', '', true);
end;
$$;
--> statement-breakpoint
-- A removed identity is an immutable anonymous historical reference, never a login again.
create function iam.guard_removed_identity() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin
  if old.deleted_at is not null and new is distinct from old then
    raise exception 'A removed staff identity cannot be changed' using errcode = '23514';
  end if;
  if new.deleted_at is not null and (new.is_active or new.is_super_admin or new.is_owner) then
    raise exception 'A removed staff identity cannot have access' using errcode = '23514';
  end if;
  return new;
end;
$$;
--> statement-breakpoint
create trigger users_guard_removed_identity before update on iam.users
for each row execute function iam.guard_removed_identity();
