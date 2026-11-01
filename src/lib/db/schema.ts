import { pgTable, uuid, text, timestamp, integer } from 'drizzle-orm/pg-core';

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
