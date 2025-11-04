// In-memory database for games, guesses, pools, deposits, payouts
// Can be swapped for PostgreSQL in production

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
    private games = new Map<string, Game>()
    private guesses = new Map<string, Guess>()
    private pools = new Map<string, Pool>() // key: `${gameId}:${token}`
    private deposits = new Map<string, Deposit>()
    private payouts = new Map<string, Payout>()
    private gameNumberCounter = new Map<string, number>() // key: `${spaceId}:${channelId}`
    private eligiblePlayers = new Map<string, Set<string>>() // key: gameId, value: Set of userIds who tipped

    // Games
    createGame(spaceId: string, channelId: string, targetWord: string): Game {
        const key = `${spaceId}:${channelId}`
        const gameNumber = (this.gameNumberCounter.get(key) || 0) + 1
        this.gameNumberCounter.set(key, gameNumber)

        const game: Game = {
            id: `game-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            spaceId,
            channelId,
            state: 'ACTIVE',
            targetWord,
            createdAt: new Date(),
            gameNumber,
        }

        this.games.set(game.id, game)
        return game
    }

    getCurrentGame(spaceId: string, channelId: string): Game | null {
        for (const game of this.games.values()) {
            if (game.spaceId === spaceId && game.channelId === channelId && game.state === 'ACTIVE') {
                return game
            }
        }
        return null
    }

    getGame(gameId: string): Game | null {
        return this.games.get(gameId) || null
    }

    async casToPayoutPending(gameId: string, winnerUserId: string): Promise<boolean> {
        const game = this.games.get(gameId)
        if (!game || game.state !== 'ACTIVE') return false

        game.state = 'PAYOUT_PENDING'
        game.winnerUserId = winnerUserId
        game.wonAt = new Date()
        return true
    }

    setGameState(gameId: string, state: GameState): void {
        const game = this.games.get(gameId)
        if (game) {
            game.state = state
        }
    }

    // Guesses
    addGuess(gameId: string, userId: string, guess: string, feedback: string): Guess {
        const guessRecord: Guess = {
            id: `guess-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            gameId,
            userId,
            guess: guess.toLowerCase(),
            feedback,
            createdAt: new Date(),
        }

        this.guesses.set(guessRecord.id, guessRecord)
        return guessRecord
    }

    getGuesses(gameId: string): Guess[] {
        return Array.from(this.guesses.values()).filter(g => g.gameId === gameId)
    }

    getUserGuesses(gameId: string, userId: string): Guess[] {
        return this.getGuesses(gameId).filter(g => g.userId === userId)
    }

    // Pools
    getPool(gameId: string, token: string): Pool | null {
        return this.pools.get(`${gameId}:${token}`) || null
    }

    getPoolTokens(gameId: string): string[] {
        const tokens = new Set<string>()
        for (const key of this.pools.keys()) {
            const [gid, token] = key.split(':')
            if (gid === gameId) {
                tokens.add(token)
            }
        }
        return Array.from(tokens)
    }

    addToPool(gameId: string, token: string, amount: bigint): void {
        const key = `${gameId}:${token}`
        const existing = this.pools.get(key)
        if (existing) {
            existing.trackedBalance += amount
            existing.lastUpdated = new Date()
        } else {
            this.pools.set(key, {
                gameId,
                token,
                trackedBalance: amount,
                lastUpdated: new Date(),
            })
        }
    }

    getPoolBalance(gameId: string, token: string): bigint {
        const pool = this.getPool(gameId, token)
        return pool ? pool.trackedBalance : 0n
    }

    // Deposits
    addDeposit(gameId: string, sender: string, token: string, amount: bigint): Deposit {
        const deposit: Deposit = {
            id: `deposit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            gameId,
            sender,
            token,
            amount,
            at: new Date(),
        }

        this.deposits.set(deposit.id, deposit)
        this.addToPool(gameId, token, amount)
        return deposit
    }

    getDeposits(gameId: string): Deposit[] {
        return Array.from(this.deposits.values()).filter(d => d.gameId === gameId)
    }

    // Payouts
    recordPayout(gameId: string, token: string, amount: bigint, txHash: string, status: 'pending' | 'success' | 'failed' = 'success'): Payout {
        const payout: Payout = {
            id: `payout-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            gameId,
            token,
            amount,
            txHash,
            status,
            createdAt: new Date(),
        }

        this.payouts.set(payout.id, payout)
        return payout
    }

    getPayouts(gameId: string): Payout[] {
        return Array.from(this.payouts.values()).filter(p => p.gameId === gameId)
    }

    // Leaderboard
    // Eligible players (must tip to play)
    addEligiblePlayer(gameId: string, userId: string): void {
        const normalized = userId.toLowerCase()
        let players = this.eligiblePlayers.get(gameId)
        if (!players) {
            players = new Set()
            this.eligiblePlayers.set(gameId, players)
        }
        players.add(normalized)
    }

    isEligiblePlayer(gameId: string, userId: string): boolean {
        const normalized = userId.toLowerCase()
        
        // Check direct eligibility list
        const players = this.eligiblePlayers.get(gameId)
        if (players && players.has(normalized)) {
            return true
        }
        
        // Also check if userId matches any deposit sender (handles address format mismatches)
        const deposits = this.getDeposits(gameId)
        return deposits.some(d => d.sender.toLowerCase() === normalized)
    }

    getEligiblePlayers(gameId: string): string[] {
        const players = this.eligiblePlayers.get(gameId)
        return players ? Array.from(players) : []
    }

    getLeaderboard(spaceId: string, limit = 10): LeaderboardEntry[] {
        const entries = new Map<string, LeaderboardEntry>()

        // Get all games for this space
        const spaceGames = Array.from(this.games.values()).filter(g => g.spaceId === spaceId && g.winnerUserId)

        for (const game of spaceGames) {
            if (!game.winnerUserId) continue

            const entry = entries.get(game.winnerUserId) || {
                userId: game.winnerUserId,
                wins: 0,
                totalGuesses: 0,
                totalWinnings: 0n,
            }

            entry.wins++
            entry.totalGuesses += this.getUserGuesses(game.id, game.winnerUserId).length

            // Get total winnings from payouts
            const payouts = this.getPayouts(game.id).filter(p => p.status === 'success')
            for (const payout of payouts) {
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

