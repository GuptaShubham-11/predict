import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  pgEnum,
  boolean,
  unique,
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

const userRoleEnum = pgEnum('role', ['admin', 'user']);

export const userTable = pgTable('users', {
  ...id,
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  balance: integer('balance').default(0).notNull(),
  role: userRoleEnum('role').default('user').notNull(),
  ...createdAt,
  ...updatedAt,
});

export type SelectUser = typeof userTable.$inferSelect;
export type InsertUser = typeof userTable.$inferInsert;

const resolvedEnum = pgEnum('resolved', ['yes', 'no', 'pending']);

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
  resolved: resolvedEnum('resolved').default('pending'),
  verifiedLink: text('verified_link'),
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

const orderTypeEnum = pgEnum('type', ['ask', 'bid']);
const outcomeEnum = pgEnum('outcome', ['yes', 'no']);

export const orderTable = pgTable('orders', {
  ...id,
  marketId: uuid('market_id')
    .notNull()
    .references(() => marketTable.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => userTable.id, { onDelete: 'cascade' }),
  amount: integer('amount').notNull(),
  stockQuantity: integer('stock_quantity').notNull(),
  remainingStocks: integer('remaining_stocks').notNull(),
  outcome: outcomeEnum('outcome').notNull(),
  type: orderTypeEnum('type').notNull(),
  isCompleted: boolean('isCompleted').notNull().default(false),
  isCancelled: boolean('isCancelled').notNull().default(false),
  ...createdAt,
  ...updatedAt,
});

export type SelectOrder = typeof orderTable.$inferSelect;
export type InsertOrder = typeof orderTable.$inferInsert;

export const stockHoldingTable = pgTable(
  'stock_holdings',
  {
    ...id,
    userId: uuid('user_id')
      .notNull()
      .references(() => userTable.id, { onDelete: 'cascade' }),
    marketId: uuid('market_id')
      .notNull()
      .references(() => marketTable.id, { onDelete: 'cascade' }),
    quantity: integer('quantity').notNull(),
    outcome: outcomeEnum('outcome').notNull(),
    ...createdAt,
    ...updatedAt,
  },
  (table) => [
    unique('user_market_holding_outcome_unique').on(table.userId, table.marketId, table.outcome),
  ]
);

export type SelectStockHolding = typeof stockHoldingTable.$inferSelect;
export type InsertStockHolding = typeof stockHoldingTable.$inferInsert;
