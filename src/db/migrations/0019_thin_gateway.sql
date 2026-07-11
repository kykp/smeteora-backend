ALTER TABLE "companies" ADD COLUMN "default_equipment_margin_percent" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "default_installation_margin_percent" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "estimate_sections" ADD COLUMN "default_margin_percent" numeric(6, 2);