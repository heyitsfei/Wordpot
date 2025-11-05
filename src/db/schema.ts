// Database schema using Drizzle ORM
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

// Games table
export const games = sqliteTable('games', {
    id: text('id').primaryKey(),
    spaceId: text('space_id').notNull(),
    channelId: text('channel_id').notNull(),
    state: text('state').notNull(), // 'ACTIVE' or 'PAYOUT_PENDING'
    targetWord: text('target_word').notNull(),
    winnerUserId: text('winner_user_id'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    wonAt: integer('won_at', { mode: 'timestamp' }),
    gameNumber: integer('game_number').notNull(),
})

// Guesses table
export const guesses = sqliteTable('guesses', {
    id: text('id').primaryKey(),
    gameId: text('game_id').notNull().references(() => games.id),
    userId: text('user_id').notNull(),
    guess: text('guess').notNull(),
    feedback: text('feedback').notNull(), // emoji format
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// Pools table (tracks balances per game per token)
export const pools = sqliteTable('pools', {
    id: text('id').primaryKey(), // `${gameId}:${token}`
    gameId: text('game_id').notNull().references(() => games.id),
    token: text('token').notNull(), // address or 'NATIVE' for ETH
    trackedBalance: text('tracked_balance').notNull(), // bigint stored as string
    lastUpdated: integer('last_updated', { mode: 'timestamp' }).notNull(),
})

// Deposits table
export const deposits = sqliteTable('deposits', {
    id: text('id').primaryKey(),
    gameId: text('game_id').notNull().references(() => games.id),
    sender: text('sender').notNull(),
    token: text('token').notNull(),
    amount: text('amount').notNull(), // bigint stored as string
    at: integer('at', { mode: 'timestamp' }).notNull(),
})

// Payouts table
export const payouts = sqliteTable('payouts', {
    id: text('id').primaryKey(),
    gameId: text('game_id').notNull().references(() => games.id),
    token: text('token').notNull(),
    amount: text('amount').notNull(), // bigint stored as string
    txHash: text('tx_hash').notNull(),
    status: text('status').notNull(), // 'pending' | 'success' | 'failed'
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// Game number counter (tracks game numbers per space:channel)
export const gameNumberCounters = sqliteTable('game_number_counters', {
    key: text('key').primaryKey(), // `${spaceId}:${channelId}`
    count: integer('count').notNull().default(0),
})

// Eligible players (users who have tipped for a game)
export const eligiblePlayers = sqliteTable('eligible_players', {
    id: text('id').primaryKey(), // `${gameId}:${userId}`
    gameId: text('game_id').notNull().references(() => games.id),
    userId: text('user_id').notNull(), // Can be Towns userId or wallet address
})

