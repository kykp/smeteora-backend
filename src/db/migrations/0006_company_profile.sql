-- Профиль компании: реквизиты для генерации КП/счетов на фронте.
-- Все поля nullable — заполняются постепенно после регистрации.
-- Enum legal_form валидируется в Zod (в БД — свободный text, чтобы не таскать
-- за собой миграции на каждое расширение списка форм).

ALTER TABLE "companies" ADD COLUMN "legal_form" text;
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "inn" text;
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "kpp" text;
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "ogrn" text;
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "legal_address" text;
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "actual_address" text;
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "bank_name" text;
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "bik" text;
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "checking_account" text;
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "correspondent_account" text;
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "director_name" text;
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "director_position" text;
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "phone" text;
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "email" text;
