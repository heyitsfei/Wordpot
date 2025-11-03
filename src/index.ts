import { makeTownsBot, type BotHandler } from '@towns-protocol/bot'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import commands from './commands'
import * as db from './db'
import type { SelectScoreWithRelations } from './db/schema'

const bot = await makeTownsBot(process.env.APP_PRIVATE_DATA!, process.env.JWT_SECRET!, {
    commands,
})

// Wordle pattern to match shared Wordle results
// Example: "Wordle 1,234 4/6" or "Wordle 1234 4/6" or "Wordle 1234 🎉 4/6"
const wordlePattern = /Wordle (\d{0,3}(,?)\d{1,3}) (🎉 ?)?([X1-6])\/6/

type WordleResult = {
  userId: string
  displayName: string
  gameNumber: number
  attempts: string
}

bot.onSlashCommand('help', async (handler, { channelId }) => {
    await handler.sendMessage(
        channelId,
        '**Available Commands:**\n\n' +
            '• `/help` - Show this help message\n' +
            '• `/time` - Get the current time\n' +
            '• `/wordle-stats` - Show your Wordle statistics\n' +
            '• `/wordle-leaderboard` - Show leaderboard for current game\n\n' +
            '**Message Triggers:**\n\n' +
            "• Share a Wordle result - I'll track it and announce winners!\n" +
            "• Mention me - I'll respond\n" +
            "• React with 👋 - I'll wave back\n" +
            '• Say "hello" - I\'ll greet you back\n' +
            '• Say "ping" - I\'ll show latency\n' +
            '• Say "react" - I\'ll add a reaction\n',
    )
})

bot.onSlashCommand('time', async (handler, { channelId }) => {
    const currentTime = new Date().toLocaleString()
    await handler.sendMessage(channelId, `Current time: ${currentTime} ⏰`)
})

bot.onMessage(async (handler, { message, channelId, eventId, createdAt, userId }) => {
    // Check for Wordle results first
    const parsedWordle = parseWordleResult(message, userId)
    if (parsedWordle) {
        const currentResults = await processLatestWordleResult(parsedWordle)
        await processCurrentResults(currentResults, handler, channelId)
        return
    }

    // Other message handlers
    if (message.includes('hello')) {
        await handler.sendMessage(channelId, 'Hello there! 👋')
        return
    }
    if (message.includes('ping')) {
        const now = new Date()
        await handler.sendMessage(channelId, `Pong! 🏓 ${now.getTime() - createdAt.getTime()}ms`)
        return
    }
    if (message.includes('react')) {
        await handler.sendReaction(channelId, eventId, '👍')
        return
    }
})

bot.onSlashCommand('wordle-stats', async (handler, { channelId, userId }) => {
    const scores = await db.getPlayerScores(userId)
    if (scores.length === 0) {
        await handler.sendMessage(channelId, "You haven't shared any Wordle results yet!")
        return
    }
    
    const wins = scores.filter(s => s.attempts !== 'X').length
    const totalGames = scores.length
    const avgAttempts = scores
        .filter(s => s.attempts !== 'X')
        .reduce((sum, s) => sum + parseInt(s.attempts), 0) / wins || 0
    
    const stats = `**Your Wordle Stats:**\n` +
        `• Games played: ${totalGames}\n` +
        `• Wins: ${wins}\n` +
        `• Average attempts: ${avgAttempts.toFixed(1)}`
    
    await handler.sendMessage(channelId, stats)
})

bot.onSlashCommand('wordle-leaderboard', async (handler, { channelId, args }) => {
    const gameNumber = args[0] ? parseInt(args[0].replace(/,/g, '')) : null
    
    if (gameNumber) {
        const scores = await db.getScoresByGameNumber(gameNumber)
        if (scores.length === 0) {
            await handler.sendMessage(channelId, `No results found for Wordle ${gameNumber.toLocaleString()}`)
            return
        }
        
        const winners = await determineWinners(scores)
        if (winners.length > 0) {
            const winnerTags = winners.map(w => `<@${w.userId}>`).join(', ')
            const winningAttempts = winners[0].attempts === 'X' ? 0 : parseInt(winners[0].attempts)
            await handler.sendMessage(
                channelId,
                `**Wordle ${gameNumber.toLocaleString()} Winners** (${winningAttempts} attempt${winningAttempts !== 1 ? 's' : ''}):\n${winnerTags}`
            )
        } else {
            await handler.sendMessage(channelId, `No winners found for Wordle ${gameNumber.toLocaleString()}`)
        }
    } else {
        await handler.sendMessage(channelId, 'Usage: `/wordle-leaderboard <game-number>`\nExample: `/wordle-leaderboard 1234`')
    }
})

bot.onReaction(async (handler, { reaction, channelId }) => {
    if (reaction === '👋') {
        await handler.sendMessage(channelId, 'I saw your wave! 👋')
    }
})

// Wordle bot helper functions
function parseWordleResult(message: string, userId: string): WordleResult | undefined {
    const match = wordlePattern.exec(message)
    
    if (match) {
        const gameNumber = parseInt(match[1].replace(/,/g, ''))
        const attempts = match[4]
        
        // Extract display name from message if available, otherwise use truncated userId
        const displayName = userId.slice(0, 10) + '...'
        
        return {
            userId,
            displayName,
            gameNumber,
            attempts,
        }
    }
    
    return undefined
}

async function processLatestWordleResult(parsedWordle: WordleResult): Promise<SelectScoreWithRelations[]> {
    // Prevent duplicates
    const scoresForCurrentGame = await db.getScoresByGameNumber(parsedWordle.gameNumber)
    const existingResultForUser = scoresForCurrentGame.find((score: SelectScoreWithRelations) => score.userId === parsedWordle.userId)
    
    if (!existingResultForUser) {
        await db.createPlayer(parsedWordle.userId, parsedWordle.displayName)
        if (scoresForCurrentGame.length === 0) {
            await db.createWordle(parsedWordle.gameNumber)
        }
        const addedScore = await db.createScore(parsedWordle.userId, parsedWordle.gameNumber, parsedWordle.attempts)
        if (addedScore) {
            scoresForCurrentGame.push(addedScore)
        } else {
            console.error(`Error adding result to the database: ${parsedWordle.gameNumber} - ${parsedWordle.userId}`)
        }
    } else {
        console.log(`Result already exists: ${parsedWordle.gameNumber} - ${parsedWordle.userId}`)
    }
    
    return scoresForCurrentGame
}

async function processCurrentResults(
    currentResults: SelectScoreWithRelations[],
    handler: BotHandler,
    channelId: string
) {
    try {
        if (currentResults.length > 0) {
            const winners: SelectScoreWithRelations[] = await determineWinners(currentResults)
            if (winners.length > 0) {
                await informLatestResults(winners, handler, channelId)
            }
        } else {
            console.log('No results from processing the latest Wordle result.')
        }
    } catch (error) {
        console.error('Error processing Wordle Result:', error)
    }
}

async function determineWinners(results: SelectScoreWithRelations[]): Promise<SelectScoreWithRelations[]> {
    if (!results || results.length === 0) return []
    
    // Filter out failed attempts (X) before processing
    const validResults = results.filter(score => score.attempts.toUpperCase() !== 'X')
    
    if (validResults.length === 0) return []
    
    // Convert attempts to numbers for comparison
    const resultsWithNumericAttempts = validResults.map(result => ({
        ...result,
        numericAttempts: parseInt(result.attempts)
    }))
    
    // Find minimum attempts
    const minAttempts = Math.min(
        ...resultsWithNumericAttempts.map(result => result.numericAttempts)
    )
    
    // Return all scores that match minimum attempts
    return validResults.filter((_, index) =>
        resultsWithNumericAttempts[index].numericAttempts === minAttempts
    )
}

async function informLatestResults(
    winners: SelectScoreWithRelations[],
    handler: BotHandler,
    channelId: string
) {
    const winnerTags = winners.map(w => `<@${w.userId}>`).join(', ')
    
    const gameNumber = winners[0].gameNumber || 1
    const winningAttempts = winners[0].attempts === 'X' ? 0 : parseInt(winners[0].attempts)
    
    const winnerMessage = `**Current Winner${winners.length > 1 ? "s" : ""}** for Wordle ${gameNumber.toLocaleString()} with ${winningAttempts} attempt${winningAttempts !== 1 ? 's' : ''}: ${winnerTags}`
    
    console.log(winnerMessage)
    await handler.sendMessage(channelId, winnerMessage)
}

const { jwtMiddleware, handler } = bot.start()

const app = new Hono()
app.use(logger())
app.post('/webhook', jwtMiddleware, handler)

export default app
