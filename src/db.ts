// Persistent database using SQLite with Drizzle ORM
import { db as drizzleDb } from './db/index'
import { games, guesses, pools, deposits, payouts, gameNumberCounters, eligiblePlayers } from './db/schema'
import { eq, and, desc, sql } from 'drizzle-orm'

export type GameState = 'ACTIVE' | 'PAYOUT_PENDING'

export interface Game {
    id: string
    spaceId: string
    channelId: string
    state: GameState
    targetWord: string
    winnerUserId?: string
    createdAt: Date
    wonAt?: Date
    gameNumber: number
}

export interface Guess {
    id: string
    gameId: string
    userId: string
    guess: string
    feedback: string // emoji format
    createdAt: Date
}

export interface Pool {
    gameId: string
    token: string // address or 'NATIVE' for ETH
    trackedBalance: bigint
    lastUpdated: Date
}

export interface Deposit {
    id: string
    gameId: string
    sender: string
    token: string
    amount: bigint
    at: Date
}

export interface Payout {
    id: string
    gameId: string
    token: string
    amount: bigint
    txHash: string
    status: 'pending' | 'success' | 'failed'
    createdAt: Date
}

export interface LeaderboardEntry {
    userId: string
    wins: number
    totalGuesses: number
    totalWinnings: bigint // in wei
}

class Database {
    // Helper to convert bigint string to bigint
    private toBigInt(str: string): bigint {
        return BigInt(str)
    }

    // Helper to convert bigint to string for storage
    private fromBigInt(val: bigint): string {
        return val.toString()
    }

    // Games
    async createGame(spaceId: string, channelId: string, targetWord: string): Promise<Game> {
        const key = `${spaceId}:${channelId}`
        
        // Get or increment game number counter
        const [counter] = await drizzleDb
            .select()
            .from(gameNumberCounters)
            .where(eq(gameNumberCounters.key, key))
            .limit(1)

        let gameNumber = 1
        if (counter) {
            gameNumber = counter.count + 1
            await drizzleDb
                .update(gameNumberCounters)
                .set({ count: gameNumber })
                .where(eq(gameNumberCounters.key, key))
        } else {
            await drizzleDb.insert(gameNumberCounters).values({ key, count: gameNumber })
        }

        const gameId = `game-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const now = new Date()

        await drizzleDb.insert(games).values({
            id: gameId,
            spaceId,
            channelId,
            state: 'ACTIVE',
            targetWord,
            createdAt: now,
            gameNumber,
        })

        return {
            id: gameId,
            spaceId,
            channelId,
            state: 'ACTIVE',
            targetWord,
            createdAt: now,
            gameNumber,
        }
    }

    async getCurrentGame(spaceId: string, channelId: string): Promise<Game | null> {
        const [game] = await drizzleDb
            .select()
            .from(games)
            .where(
                and(
                    eq(games.spaceId, spaceId),
                    eq(games.channelId, channelId),
                    eq(games.state, 'ACTIVE')
                )
            )
            .limit(1)

        if (!game) return null

        return {
            id: game.id,
            spaceId: game.spaceId,
            channelId: game.channelId,
            state: game.state as GameState,
            targetWord: game.targetWord,
            winnerUserId: game.winnerUserId || undefined,
            createdAt: game.createdAt,
            wonAt: game.wonAt || undefined,
            gameNumber: game.gameNumber,
        }
    }

    async getGame(gameId: string): Promise<Game | null> {
        const [game] = await drizzleDb
            .select()
            .from(games)
            .where(eq(games.id, gameId))
            .limit(1)

        if (!game) return null

        return {
            id: game.id,
            spaceId: game.spaceId,
            channelId: game.channelId,
            state: game.state as GameState,
            targetWord: game.targetWord,
            winnerUserId: game.winnerUserId || undefined,
            createdAt: game.createdAt,
            wonAt: game.wonAt || undefined,
            gameNumber: game.gameNumber,
        }
    }

    async casToPayoutPending(gameId: string, winnerUserId: string): Promise<boolean> {
        const game = await this.getGame(gameId)
        if (!game || game.state !== 'ACTIVE') return false

        const now = new Date()
        await drizzleDb
            .update(games)
            .set({
                state: 'PAYOUT_PENDING',
                winnerUserId,
                wonAt: now,
            })
            .where(eq(games.id, gameId))

        return true
    }

    async setGameState(gameId: string, state: GameState): Promise<void> {
        await drizzleDb
            .update(games)
            .set({ state })
            .where(eq(games.id, gameId))
    }

    // Guesses
    async addGuess(gameId: string, userId: string, guess: string, feedback: string): Promise<Guess> {
        const guessId = `guess-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const now = new Date()

        await drizzleDb.insert(guesses).values({
            id: guessId,
            gameId,
            userId,
            guess: guess.toLowerCase(),
            feedback,
            createdAt: now,
        })

        return {
            id: guessId,
            gameId,
            userId,
            guess: guess.toLowerCase(),
            feedback,
            createdAt: now,
        }
    }

    async getGuesses(gameId: string): Promise<Guess[]> {
        const results = await drizzleDb
            .select()
            .from(guesses)
            .where(eq(guesses.gameId, gameId))

        return results.map(g => ({
            id: g.id,
            gameId: g.gameId,
            userId: g.userId,
            guess: g.guess,
            feedback: g.feedback,
            createdAt: g.createdAt,
        }))
    }

    async getUserGuesses(gameId: string, userId: string): Promise<Guess[]> {
        const allGuesses = await this.getGuesses(gameId)
        return allGuesses.filter(g => g.userId === userId)
    }

    // Pools
    async getPool(gameId: string, token: string): Promise<Pool | null> {
        const poolId = `${gameId}:${token}`
        const [pool] = await drizzleDb
            .select()
            .from(pools)
            .where(eq(pools.id, poolId))
            .limit(1)

        if (!pool) return null

        return {
            gameId: pool.gameId,
            token: pool.token,
            trackedBalance: this.toBigInt(pool.trackedBalance),
            lastUpdated: pool.lastUpdated,
        }
    }

    async getPoolTokens(gameId: string): Promise<string[]> {
        const results = await drizzleDb
            .select({ token: pools.token })
            .from(pools)
            .where(eq(pools.gameId, gameId))

        return results.map(r => r.token)
    }

    async addToPool(gameId: string, token: string, amount: bigint): Promise<void> {
        const poolId = `${gameId}:${token}`
        const existing = await this.getPool(gameId, token)

        if (existing) {
            const newBalance = existing.trackedBalance + amount
            await drizzleDb
                .update(pools)
                .set({
                    trackedBalance: this.fromBigInt(newBalance),
                    lastUpdated: new Date(),
                })
                .where(eq(pools.id, poolId))
        } else {
            await drizzleDb.insert(pools).values({
                id: poolId,
                gameId,
                token,
                trackedBalance: this.fromBigInt(amount),
                lastUpdated: new Date(),
            })
        }
    }

    async getPoolBalance(gameId: string, token: string): Promise<bigint> {
        const pool = await this.getPool(gameId, token)
        return pool ? pool.trackedBalance : 0n
    }

    // Deposits
    async addDeposit(gameId: string, sender: string, token: string, amount: bigint): Promise<Deposit> {
        const depositId = `deposit-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const now = new Date()

        await drizzleDb.insert(deposits).values({
            id: depositId,
            gameId,
            sender,
            token,
            amount: this.fromBigInt(amount),
            at: now,
        })

        // Also add to pool
        await this.addToPool(gameId, token, amount)

        return {
            id: depositId,
            gameId,
            sender,
            token,
            amount,
            at: now,
        }
    }

    async getDeposits(gameId: string): Promise<Deposit[]> {
        const results = await drizzleDb
            .select()
            .from(deposits)
            .where(eq(deposits.gameId, gameId))

        return results.map(d => ({
            id: d.id,
            gameId: d.gameId,
            sender: d.sender,
            token: d.token,
            amount: this.toBigInt(d.amount),
            at: d.at,
        }))
    }

    // Payouts
    async recordPayout(gameId: string, token: string, amount: bigint, txHash: string, status: 'pending' | 'success' | 'failed' = 'success'): Promise<Payout> {
        const payoutId = `payout-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const now = new Date()

        await drizzleDb.insert(payouts).values({
            id: payoutId,
            gameId,
            token,
            amount: this.fromBigInt(amount),
            txHash,
            status,
            createdAt: now,
        })

        return {
            id: payoutId,
            gameId,
            token,
            amount,
            txHash,
            status,
            createdAt: now,
        }
    }

    async getPayouts(gameId: string): Promise<Payout[]> {
        const results = await drizzleDb
            .select()
            .from(payouts)
            .where(eq(payouts.gameId, gameId))

        return results.map(p => ({
            id: p.id,
            gameId: p.gameId,
            token: p.token,
            amount: this.toBigInt(p.amount),
            txHash: p.txHash,
            status: p.status as 'pending' | 'success' | 'failed',
            createdAt: p.createdAt,
        }))
    }

    // Eligible players (must tip to play)
    async addEligiblePlayer(gameId: string, userId: string): Promise<void> {
        const normalized = userId.toLowerCase()
        const id = `${gameId}:${normalized}`

        // Check if already exists
        const [existing] = await drizzleDb
            .select()
            .from(eligiblePlayers)
            .where(eq(eligiblePlayers.id, id))
            .limit(1)

        if (!existing) {
            await drizzleDb.insert(eligiblePlayers).values({
                id,
                gameId,
                userId: normalized,
            })
        }
    }

    async isEligiblePlayer(gameId: string, userId: string): Promise<boolean> {
        const normalized = userId.toLowerCase()
        const id = `${gameId}:${normalized}`

        // Check direct eligibility list
        const [player] = await drizzleDb
            .select()
            .from(eligiblePlayers)
            .where(eq(eligiblePlayers.id, id))
            .limit(1)

        if (player) return true

        // Also check if userId matches any deposit sender (handles address format mismatches)
        const deposits = await this.getDeposits(gameId)
        return deposits.some(d => d.sender.toLowerCase() === normalized)
    }

    async getEligiblePlayers(gameId: string): Promise<string[]> {
        const results = await drizzleDb
            .select({ userId: eligiblePlayers.userId })
            .from(eligiblePlayers)
            .where(eq(eligiblePlayers.gameId, gameId))

        return results.map(r => r.userId)
    }

    async getLeaderboard(spaceId: string, limit = 10): Promise<LeaderboardEntry[]> {
        // Get all games for this space with winners
        const spaceGames = await drizzleDb
            .select()
            .from(games)
            .where(
                and(
                    eq(games.spaceId, spaceId),
                    sql`${games.winnerUserId} IS NOT NULL`
                )
            )

        const entries = new Map<string, LeaderboardEntry>()

        for (const game of spaceGames) {
            if (!game.winnerUserId) continue

            const entry = entries.get(game.winnerUserId) || {
                userId: game.winnerUserId,
                wins: 0,
                totalGuesses: 0,
                totalWinnings: 0n,
            }

            entry.wins++

            // Get user guesses for this game
            const userGuesses = await this.getUserGuesses(game.id, game.winnerUserId)
            entry.totalGuesses += userGuesses.length

            // Get total winnings from payouts
            const gamePayouts = await this.getPayouts(game.id)
            const successfulPayouts = gamePayouts.filter(p => p.status === 'success')
            for (const payout of successfulPayouts) {
                entry.totalWinnings += payout.amount
            }

            entries.set(game.winnerUserId, entry)
        }

        return Array.from(entries.values())
            .sort((a, b) => {
                if (b.wins !== a.wins) return b.wins - a.wins
                return Number(b.totalWinnings - a.totalWinnings)
            })
            .slice(0, limit)
    }
}

export const db = new Database()
