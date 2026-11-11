import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  pgEnum,
  boolean,
} from 'drizzle-orm/pg-core';

const createdAt = {
  createdAt: timestamp('created_at').defaultNow().notNull(),
};
const updatedAt = {
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
};

const id = {
  id: uuid('id').defaultRandom().primaryKey(),
};

export const userTable = pgTable('users', {
  ...id,
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  balance: integer('balance').default(0).notNull(),
  ...createdAt,
  ...updatedAt,
});

export type SelectUser = typeof userTable.$inferSelect;
export type InsertUser = typeof userTable.$inferInsert;

export const marketTable = pgTable('markets', {
  ...id,
  title: text('title').notNull(),
  description: text('description').notNull(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => userTable.id, { onDelete: 'cascade' }),
  amount: integer('amount').default(0).notNull(),
  issuedStocks: integer('issued_stocks').default(0).notNull(),
  avilabelStocks: integer('avilabel_stocks').default(0).notNull(),
  resolved: text('resolved'),
  expiresAt: timestamp('expires_at').notNull(),
  ...createdAt,
  ...updatedAt,
});

export type SelectMarket = typeof marketTable.$inferSelect;
export type InsertMarket = typeof marketTable.$inferInsert;

export const walletEventTable = pgTable('wallet_events', {
  ...id,
  userId: uuid('user_id')
    .notNull()
    .references(() => userTable.id, { onDelete: 'cascade' }),
  amount: integer('amount').notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  ...createdAt,
});

export type SelectWalletEvent = typeof walletEventTable.$inferSelect;
export type InsertWalletEvent = typeof walletEventTable.$inferInsert;

export const orderTypeEnum = pgEnum('type', ['ask', 'bid']);

export const orderTable = pgTable('market_orders', {
  ...id,
  marketId: uuid('market_id')
    .notNull()
    .references(() => marketTable.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => userTable.id, { onDelete: 'cascade' }),
  amount: integer('amount').notNull(),
  wantedStocks: integer('wanted_stocks').notNull(),
  type: orderTypeEnum('type').notNull(),
  isCompleted: boolean('isCompleted').notNull().default(false),
  ...createdAt,
  ...updatedAt,
});

export type SelectOrder = typeof orderTable.$inferSelect;
export type InsertOrder = typeof orderTable.$inferInsert;
