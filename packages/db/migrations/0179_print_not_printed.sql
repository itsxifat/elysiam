-- D-1025: a print the person saw not come out of the printer can be put back. The browser print
-- station can only tell that Chrome's print finished, and a jammed or empty thermal printer
-- still "printed" every label: they left Ready for label for good. A printed job may now move to
-- `failed` once, with only its progress changing (printed_at cleared, failed_at and last_error
-- set); what was printed, where, why and by whom stays fixed, and the audit log keeps who said
-- it did not print. Every other change to a finished job is refused as before.
create or replace function packing.assert_print_job_change() returns trigger
language plpgsql as $$
begin
  if (new.id, new.org_id, new.order_id, new.order_no, new.document, new.lot_no, new.lot_count,
      new.printer_id, new.terminal_id, new.source, new.reason, new.requested_by, new.copies,
      new.consignment_no, new.auto_key, new.created_at)
     is distinct from
     (old.id, old.org_id, old.order_id, old.order_no, old.document, old.lot_no, old.lot_count,
      old.printer_id, old.terminal_id, old.source, old.reason, old.requested_by, old.copies,
      old.consignment_no, old.auto_key, old.created_at) then
    raise exception 'CONFLICT: a print job''s document, order, printer and reason are fixed.';
  end if;
  if old.state = 'printed' and new.state = 'failed' and old.document <> 'test'
     and new.printed_at is null and new.failed_at is not null and new.last_error is not null
     and (new.attempts, new.sending_at, new.cancelled_at, new.device_id, new.confirmed_by)
         is not distinct from
         (old.attempts, old.sending_at, old.cancelled_at, old.device_id, old.confirmed_by) then
    return new;
  end if;
  if old.state in ('printed', 'cancelled') and new is distinct from old then
    raise exception 'CONFLICT: a finished print job is on the record as it happened.';
  end if;
  return new;
end;
$$;
