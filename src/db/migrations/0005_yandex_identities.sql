-- users.password_hash делаем nullable — юзеры, зашедшие только через OAuth,
-- пароля не имеют. При регистрации email+password валидируем на слое приложения.
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;
--> statement-breakpoint

-- identities — привязки внешних OAuth-провайдеров к учётке.
-- Один user может иметь несколько привязок (yandex, google, …), но не две
-- к одному провайдеру: пара (provider, provider_user_id) уникальна.
CREATE TABLE "identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_user_id" text NOT NULL,
	"email_at_link" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "identities" ADD CONSTRAINT "identities_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

CREATE UNIQUE INDEX "identities_provider_user_unique_idx"
  ON "identities" USING btree ("provider","provider_user_id");
--> statement-breakpoint
CREATE INDEX "identities_user_idx" ON "identities" USING btree ("user_id");
--> statement-breakpoint

-- Триггер updated_at — как на всех остальных таблицах с этой колонкой.
CREATE TRIGGER identities_set_updated_at
  BEFORE UPDATE ON identities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- identities — user-level справочник, не привязан к company_id. RLS не ставим
-- (аналогично users и sessions). Изоляция на слое приложения: чтение всегда
-- с явным WHERE user_id = ctx.userId.

GRANT SELECT, INSERT, UPDATE, DELETE ON "identities" TO smeteora_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "identities" TO smeteora_platform_editor;
