# syntax=docker/dockerfile:1.7
#
# Multi-stage сборка бэка Smeteora.
# Итоговый образ содержит только dist/, prod-node_modules, package.json и SQL-миграции.
# Секреты в образ НЕ попадают — они инжектятся на сервере через env_file в compose.

# ── Stage 1: builder ────────────────────────────────────────────────────
# Полный toolchain: pnpm + build-essentials для native-биндингов (argon2 c/c++).
FROM node:22-alpine AS builder

# argon2 собирается через node-gyp → нужны python3, make, g++.
RUN apk add --no-cache python3 make g++ libc6-compat

WORKDIR /build

# Corepack тянет pnpm по версии из package.json ("packageManager": "pnpm@11.9.0").
RUN corepack enable

# Копируем сначала манифесты — так Docker кэширует слой install при изменении только кода.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/

# CI=true отключает интерактивный prompt pnpm'а при purge devDeps
# (иначе `pnpm install --prod` падает с ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY).
# HUSKY=0 подавляет prepare-скрипт (в prod-install husky выпилен из devDeps,
# но prepare всё ещё вызывается — без HUSKY=0 упадёт "husky: not found").
ENV CI=true HUSKY=0

RUN pnpm install --frozen-lockfile

# Копируем исходники и собираем.
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY packages ./packages

RUN pnpm build

# Workspace-пакет @smeteora/shared в dev резолвится как .ts (main: ./src/index.ts).
# В prod Node не поймёт TS — надо подсунуть скомпилированные .js рядом с исходниками
# (dist/packages/shared/src/*.js → packages/shared/src/*.js) и переписать main
# у пакета на .js. Так symlink node_modules/@smeteora/shared → packages/shared
# продолжает работать, только теперь резолвится на .js.
RUN cp -r dist/packages/shared/src/. packages/shared/src/ \
    && node -e "const f='packages/shared/package.json';const p=JSON.parse(require('fs').readFileSync(f,'utf-8'));p.main='./src/index.js';p.types=undefined;p.exports={'.':'./src/index.js','./package.json':'./package.json'};require('fs').writeFileSync(f,JSON.stringify(p,null,2))"

# После сборки оставляем только prod-зависимости.
# Убираем "prepare": "husky" из package.json — он падает "husky: not found"
# после того как pnpm выпилит devDeps. Никакого runtime-эффекта: husky нужен
# только для git-hooks локальной разработки.
RUN pnpm pkg delete scripts.prepare
RUN pnpm install --frozen-lockfile --prod


# ── Stage 2: runtime ────────────────────────────────────────────────────
# Минимальный образ без toolchain'а. Только Node runtime + скомпилированный код.
FROM node:22-alpine AS runtime

# libc6-compat — стандартная зависимость для нативных биндингов на alpine.
# dumb-init — правильный PID1 для Node в контейнере (обрабатывает SIGTERM корректно).
RUN apk add --no-cache libc6-compat dumb-init

WORKDIR /app

# Непривилегированный юзер node уже создан в базовом образе (uid 1000).
# Все файлы кладём как node — процесс не должен работать от root.
ENV NODE_ENV=production

COPY --chown=node:node --from=builder /build/node_modules ./node_modules
COPY --chown=node:node --from=builder /build/dist ./dist
COPY --chown=node:node --from=builder /build/package.json ./package.json
# readVersion() в config.ts резолвит "../package.json" от собственной локации.
# В dev это /repo/src/config.ts → /repo/package.json. В prod after-compile путь
# становится /app/dist/src/config.js → /app/dist/package.json. Кладём копию туда.
COPY --chown=node:node --from=builder /build/package.json ./dist/package.json
# packages/shared нужен целиком (в prod-install он symlink'ается в node_modules,
# resolving идёт через packages/shared/package.json → src/index.js).
COPY --chown=node:node --from=builder /build/packages ./packages
# Drizzle migrator читает SQL-файлы по относительному пути ./src/db/migrations —
# они не компилируются, копируем как есть.
COPY --chown=node:node --from=builder /build/src/db/migrations ./src/db/migrations

USER node

# Порт из config.ts (по умолчанию 3000; ENV PORT переопределяет).
EXPOSE 3000

# dumb-init как PID1 → корректный shutdown по SIGTERM (compose down быстро,
# без 10-секундного зависания на грейсфул-выходе).
ENTRYPOINT ["dumb-init", "--"]

# Дефолт — запуск бэка. Мигратор перебивает CMD через compose command:.
CMD ["node", "dist/src/index.js"]
