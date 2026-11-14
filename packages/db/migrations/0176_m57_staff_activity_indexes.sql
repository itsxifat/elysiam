CREATE INDEX "order_returns_org_created_idx" ON "sales"."order_returns" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "return_receipts_org_received_idx" ON "courier"."return_receipts" USING btree ("org_id","received_at");--> statement-breakpoint
CREATE INDEX "conversation_offers_org_offered_idx" ON "inbox"."conversation_offers" USING btree ("org_id","offered_at");--> statement-breakpoint
CREATE INDEX "messages_org_occurred_idx" ON "inbox"."messages" USING btree ("org_id","occurred_at");--> statement-breakpoint
CREATE INDEX "notes_org_created_idx" ON "inbox"."notes" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "call_attempts_org_called_idx" ON "sales"."call_attempts" USING btree ("org_id","called_at");--> statement-breakpoint
CREATE INDEX "call_attempts_org_call_back_idx" ON "sales"."call_attempts" USING btree ("org_id","call_back_at");--> statement-breakpoint
CREATE INDEX "order_events_org_occurred_idx" ON "sales"."order_events" USING btree ("org_id","occurred_at");--> statement-breakpoint
CREATE INDEX "order_offers_org_offered_idx" ON "sales"."order_offers" USING btree ("org_id","offered_at");--> statement-breakpoint
CREATE INDEX "orders_org_confirmed_idx" ON "sales"."orders" USING btree ("org_id","confirmed_at");--> statement-breakpoint
CREATE INDEX "orders_org_assigned_at_idx" ON "sales"."orders" USING btree ("org_id","assigned_at");--> statement-breakpoint
CREATE INDEX "lot_closures_org_closed_idx" ON "packing"."lot_closures" USING btree ("org_id","closed_at");--> statement-breakpoint
CREATE INDEX "packing_scans_org_scanned_idx" ON "packing"."scans" USING btree ("org_id","scanned_at");--> statement-breakpoint
CREATE INDEX "packing_sessions_org_completed_idx" ON "packing"."sessions" USING btree ("org_id","completed_at");--> statement-breakpoint
CREATE INDEX "calls_org_ended_idx" ON "telephony"."calls" USING btree ("org_id","ended_at");