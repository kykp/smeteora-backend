import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';
import { IDENTITY_PROVIDERS } from '../constants.js';

// identities — привязки внешних OAuth-провайдеров к учётке.
// Один user может иметь несколько привязок (yandex + google в будущем), но
// не две к одному провайдеру. Пара (provider, provider_user_id) уникальна:
// один аккаунт Яндекса привязывается ровно к одной учётке.
export const identities = pgTable(
  'identities',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider', { enum: IDENTITY_PROVIDERS }).notNull(),
    providerUserId: text('provider_user_id').notNull(),
    // Email из провайдера на момент привязки — только для дебага. Единственный
    // авторитетный email юзера лежит в users.email.
    emailAtLink: text('email_at_link'),
    // meta — что вернул провайдер (display_name, avatar_id и т.п.), для аудита.
    meta: jsonb('meta')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('identities_provider_user_unique_idx').on(t.provider, t.providerUserId),
    index('identities_user_idx').on(t.userId),
  ],
);

export type Identity = typeof identities.$inferSelect;
export type NewIdentity = typeof identities.$inferInsert;
