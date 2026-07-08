CREATE TABLE "magic_link_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"ip" "inet",
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "magic_link_tokens_hash_idx" ON "magic_link_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "magic_link_tokens_email_active_idx" ON "magic_link_tokens" USING btree ("email","expires_at") WHERE "magic_link_tokens"."used_at" IS NULL;--> statement-breakpoint

-- ──────────────────────────────────────────────────────────────
-- Права. Не под RLS (токены до сессии, компании нет), но
-- smeteora_app должен уметь читать/писать таблицу.
-- ──────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON magic_link_tokens TO smeteora_app;