CREATE UNIQUE INDEX "invitations_token_hash_pending_idx" ON "invitations" USING btree ("token_hash") WHERE "invitations"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_company_email_pending_idx" ON "invitations" USING btree ("company_id","email") WHERE "invitations"."status" = 'pending';
--> statement-breakpoint

-- ──────────────────────────────────────────────────────────────
-- Расширяем RLS invitations двумя каналами доступа:
--   1) company context (owner/admin просматривает и управляет своими приглашениями)
--   2) token context (анонимный флоу preview/accept — приглашённый юзер идёт по ссылке
--      с токеном, backend валидирует sha256(token) и открывает tx с этим token_hash
--      в app.current_invitation_token_hash)
--
-- Заменяем старую политику invitations_tenant_isolation тремя новыми.
-- Postgres при нескольких политиках для одной команды ORит их — это то что надо:
-- запрос проходит если ЛИБО совпал company context (для админского флоу),
-- ЛИБО совпал token_hash (для accept-флоу).
--
-- INSERT/DELETE — только через company context. Анонимный флоу может только
-- SELECT (preview) и UPDATE (пометить accepted) — по конкретному token_hash.
-- ──────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS invitations_tenant_isolation ON invitations;
--> statement-breakpoint

CREATE POLICY invitations_by_company ON invitations
  FOR ALL
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
--> statement-breakpoint

CREATE POLICY invitations_select_by_token ON invitations
  FOR SELECT
  USING (token_hash = NULLIF(current_setting('app.current_invitation_token_hash', true), ''));
--> statement-breakpoint

CREATE POLICY invitations_update_by_token ON invitations
  FOR UPDATE
  USING (token_hash = NULLIF(current_setting('app.current_invitation_token_hash', true), ''))
  WITH CHECK (token_hash = NULLIF(current_setting('app.current_invitation_token_hash', true), ''));