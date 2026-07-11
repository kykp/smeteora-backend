ALTER TABLE "estimates" ADD COLUMN "tax_regime" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN "tax_rate" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN "tax_base_kind" text;