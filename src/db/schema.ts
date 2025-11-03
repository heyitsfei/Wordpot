import { relations } from "drizzle-orm";
import { integer, sqliteTable, text, primaryKey } from 'drizzle-orm/sqlite-core';

export const wordlesTable = sqliteTable('wordles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  gameNumber: integer('game_number').notNull().unique(),
});

export const playersTable = sqliteTable('players', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: text('user_id').notNull().unique(), // Towns user ID (address)
  displayName: text('display_name').notNull(),
});

export const scoresTable = sqliteTable('scores', {
  userId: text('user_id').notNull().references(() => playersTable.userId),
  gameNumber: integer('game_number').notNull().references(() => wordlesTable.gameNumber),
  attempts: text('attempts').notNull(),
  isWin: integer('is_win').default(0),
  isTie: integer('is_tie').default(0),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.gameNumber] })
}));

export const playerScoresRelations = relations(playersTable, ({ many }) => ({
  scores: many(scoresTable)
}));

export const scoresRelations = relations(scoresTable, ({ one }) => ({
  player: one(playersTable, {
    fields: [scoresTable.userId],
    references: [playersTable.userId]
  }),
  wordle: one(wordlesTable, {
    fields: [scoresTable.gameNumber],
    references: [wordlesTable.gameNumber]
  })
}));

export const wordleRelations = relations(wordlesTable, ({ many }) => ({
  scores: many(scoresTable)
}));

export type InsertWordle = typeof wordlesTable.$inferInsert;
export type SelectWordle = typeof wordlesTable.$inferSelect;

export type InsertPlayer = typeof playersTable.$inferInsert;
export type SelectPlayer = typeof playersTable.$inferSelect;

export type InsertScore = typeof scoresTable.$inferInsert;
export type SelectScore = typeof scoresTable.$inferSelect;
export type SelectScoreWithRelations = SelectScore & { player: SelectPlayer };

