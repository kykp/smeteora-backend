-- Снимаем RLS с memberships и sessions.
--
-- Причина: memberships — это N-к-N справочник принадлежности юзера к компаниям.
-- Для /me и switch-workspace нужно показать ВСЕ компании юзера, а RLS-политика
-- по current_setting('app.current_company_id') покажет только строки активной
-- компании. При регистрации INSERT нового membership вообще проваливается —
-- контекста ещё нет.
--
-- Для sessions логика похожа: session id живёт в signed cookie, сам путь
-- к ней уже защищён (без валидной подписи не подделаешь).
--
-- Изоляция обеспечивается:
--   - в auth-плагине JOIN sessions+memberships c явным WHERE user_id из cookie
--   - в /me и switch-company: списки memberships читаются с WHERE user_id = ctx.userId
--   - никакой эндпоинт не отдаёт memberships/sessions чужих юзеров.
--
-- RLS остаётся на реально приватных доменных таблицах:
--   audit_log, api_keys, invitations — и всех будущих (projects, estimates и т.д.).

DROP POLICY IF EXISTS memberships_tenant_isolation ON memberships;
ALTER TABLE memberships DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint

DROP POLICY IF EXISTS sessions_tenant_isolation ON sessions;
ALTER TABLE sessions DISABLE ROW LEVEL SECURITY;
