-- Логотип компании: ключ в FileStorage + content-type.
-- Отдельные колонки чтобы не завязываться на расширение файла в ключе.

ALTER TABLE "companies" ADD COLUMN "logo_key" text;
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "logo_content_type" text;
