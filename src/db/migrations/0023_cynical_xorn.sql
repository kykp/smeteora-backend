ALTER TABLE "estimate_line_items" ADD COLUMN "custom_discount_percent" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "estimate_sections" ADD COLUMN "default_discount_percent" numeric(5, 2);