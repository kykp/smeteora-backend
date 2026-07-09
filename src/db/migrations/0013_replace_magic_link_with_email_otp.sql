-- Замена magic-link на email-OTP.
--
-- В таблице magic_link_tokens нет данных длительного хранения (только
-- одноразовые токены со сроком жизни 15 минут). Дроп и создание новой
-- таблицы одной миграцией безопасны: любой действующий токен просто
-- перестанет работать, юзер запросит новый код.

DROP TABLE "magic_link_tokens";--> statement-breakpoint

CREATE TABLE "email_otp_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "email_otp_codes_email_active_idx" ON "email_otp_codes" USING btree ("email","expires_at") WHERE "email_otp_codes"."used_at" IS NULL;--> statement-breakpoint

-- ──────────────────────────────────────────────────────────────
-- Права. Не под RLS (коды до сессии, компании нет), но
-- smeteora_app должен уметь читать/писать таблицу.
-- ──────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON email_otp_codes TO smeteora_app;
