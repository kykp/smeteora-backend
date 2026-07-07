ALTER TABLE "companies" ADD COLUMN "pdf_show_logo" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "pdf_show_addresses" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "pdf_show_bank" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "pdf_show_director" boolean DEFAULT true NOT NULL;