import { makeTownsBot } from '@towns-protocol/bot'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { execute } from 'viem/experimental/erc7821'
import { waitForTransactionReceipt, getBalance, readContract } from 'viem/actions'
import { erc20Abi, parseUnits, formatUnits, zeroAddress, Address } from 'viem'
import commands from './commands'
import { computeFeedback, isCorrect, isValidWord, getRandomWord, formatFeedback } from './game'
import { db, type Game } from './db'

const bot = await makeTownsBot(process.env.APP_PRIVATE_DATA!, process.env.JWT_SECRET!, {
    commands,
    baseRpcUrl: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
})

// Get or create current game for a channel
function getOrCreateGame(spaceId: string, channelId: string): Game {
    let game = db.getCurrentGame(spaceId, channelId)
    if (!game) {
        const targetWord = getRandomWord()
        game = db.createGame(spaceId, channelId, targetWord)
    }
    return game
}

// Format pool display
function formatPool(game: Game): string {
    const tokens = db.getPoolTokens(game.id)
    if (tokens.length === 0) {
        return 'No tips received yet. Be the first to tip the bot to add to the prize pool! 💰'
    }

    const lines = tokens.map(token => {
        const balance = db.getPoolBalance(game.id, token)
        const decimals = token === 'NATIVE' ? 18 : 18 // Assume 18 decimals for simplicity
        const formatted = formatUnits(balance, decimals)
        const symbol = token === 'NATIVE' ? 'ETH' : token.slice(0, 6) + '...'
        return `• ${formatted} ${symbol}`
    })

    return `**Prize Pool (Game #${game.gameNumber}):**\n${lines.join('\n')}`
}

// Build payout plan
async function buildPayoutPlan(game: Game): Promise<Array<{ token: string; amount: bigint }>> {
    const tokens = db.getPoolTokens(game.id)
    const plan: Array<{ token: string; amount: bigint }> = []

    for (const token of tokens) {
        const tracked = db.getPoolBalance(game.id, token)

        let actual: bigint
        if (token === 'NATIVE') {
            actual = await getBalance(bot.viem, { address: bot.appAddress })
        } else {
            actual = await readContract(bot.viem, {
                address: token as Address,
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [bot.appAddress],
            }) as bigint
        }

        const amount = actual < tracked ? actual : tracked
        if (amount > 0n) {
            plan.push({ token, amount })
        }
    }

    return plan
}

// Execute payout
async function executePayout(game: Game, winnerUserId: string): Promise<string> {
    const plan = await buildPayoutPlan(game)

    if (plan.length === 0) {
        throw new Error('No funds to payout')
    }

    // Get winner address (assuming userId is the address)
    const winnerAddress = winnerUserId as Address

    const calls = plan.map(p => {
        if (p.token === 'NATIVE') {
            return {
                to: winnerAddress,
                data: '0x' as const,
                value: p.amount,
            }
        } else {
            return {
                to: p.token as Address,
                abi: erc20Abi,
                functionName: 'transfer' as const,
                args: [winnerAddress, p.amount],
            }
        }
    })

    const txHash = await execute(bot.viem, {
        address: bot.appAddress,
        account: bot.viem.account,
        calls,
    })

    await waitForTransactionReceipt(bot.viem, { hash: txHash })

    // Record payouts
    for (const p of plan) {
        db.recordPayout(game.id, p.token, p.amount, txHash, 'success')
    }

    return txHash
}

// Announce winner
async function announceWinner(game: Game, winnerUserId: string, plan: Array<{ token: string; amount: bigint }>, txHash: string): Promise<void> {
    const winnerDisplay = `<@${winnerUserId}>`
    const winnings = plan.map(p => {
        const formatted = formatUnits(p.amount, 18)
        const symbol = p.token === 'NATIVE' ? 'ETH' : p.token.slice(0, 6) + '...'
        return `${formatted} ${symbol}`
    }).join(', ')

    await bot.sendMessage(
        game.channelId,
        `🎉 **WINNER!** 🎉\n\n${winnerDisplay} guessed the word **${game.targetWord.toUpperCase()}** correctly!\n\n` +
        `**Prize:** ${winnings}\n` +
        `**Transaction:** \`${txHash}\``,
    )
}

// Start new game
async function startNewGame(spaceId: string, channelId: string): Promise<Game> {
    const targetWord = getRandomWord()
    const game = db.createGame(spaceId, channelId, targetWord)

    // Pin a message to receive tips
    const pinnedMessage = await bot.sendMessage(
        channelId,
        `🎮 **Wordle Game #${game.gameNumber}**\n\n` +
        `Guess the 5-letter word! Use \`/wordle guess <word>\` to play.\n\n` +
        `Tip this message to add to the prize pool! 💰\n\n` +
        formatPool(game),
    )

    // Note: Bot framework doesn't have pinMessage yet, but message is sent
    return game
}

// Handle tips
bot.onTip(async (handler, event) => {
    // Only process tips to the bot's address
    if (event.receiverAddress.toLowerCase() !== bot.appAddress.toLowerCase()) {
        return
    }

    const game = getOrCreateGame(event.spaceId, event.channelId)

    // Skip if game is in payout pending state
    if (game.state === 'PAYOUT_PENDING') {
        await handler.sendMessage(
            event.channelId,
            `⚠️ Game #${game.gameNumber} is being paid out. Tips will go to the next game!`,
        )
        return
    }

    const token = event.currency === zeroAddress ? 'NATIVE' : event.currency
    db.addDeposit(game.id, event.senderAddress, token, event.amount)

    const formatted = formatUnits(event.amount, 18)
    const symbol = token === 'NATIVE' ? 'ETH' : token.slice(0, 6) + '...'

    await handler.sendMessage(
        event.channelId,
        `💰 Tip received! ${formatted} ${symbol} added to Game #${game.gameNumber} prize pool.\n\n${formatPool(game)}`,
    )
})

// Slash command: /wordle (handles all subcommands)
bot.onSlashCommand('wordle', async (handler, event) => {
    const subcommand = event.args[0]?.toLowerCase()
    const game = getOrCreateGame(event.spaceId, event.channelId)

    // Handle subcommands
    if (subcommand === 'guess') {
        if (game.state === 'PAYOUT_PENDING') {
            await handler.sendMessage(
                event.channelId,
                `⏳ Game #${game.gameNumber} is being paid out. A new game will start soon!`,
            )
            return
        }

        // Join all args after "guess" and remove spaces (in case word gets split)
        const guess = event.args.slice(1).join(' ').replace(/\s+/g, '').toLowerCase().trim()
        if (!guess) {
            await handler.sendMessage(event.channelId, 'Usage: `/wordle guess <word>` (5 letters)')
            return
        }

        if (guess.length !== 5) {
            await handler.sendMessage(event.channelId, '❌ Guess must be exactly 5 letters!')
            return
        }

        if (!isValidWord(guess)) {
            await handler.sendMessage(event.channelId, '❌ Invalid word. Must be exactly 5 letters (a-z only, no spaces or special characters).')
            return
        }

        const feedback = computeFeedback(guess, game.targetWord)
        const guessRecord = db.addGuess(game.id, event.userId, guess, feedback.emoji)

        const userGuesses = db.getUserGuesses(game.id, event.userId)
        const guessNumber = userGuesses.length

        if (isCorrect(feedback)) {
            // Try to lock the game for this winner
            const locked = await db.casToPayoutPending(game.id, event.userId)
            if (!locked) {
                await handler.sendMessage(
                    event.channelId,
                    `❌ Too late! Someone else already won Game #${game.gameNumber}.`,
                )
                return
            }

            // Winner! Execute payout
            try {
                const txHash = await executePayout(game, event.userId)
                await announceWinner(game, event.userId, await buildPayoutPlan(game), txHash)

                // Start new game
                await startNewGame(event.spaceId, event.channelId)
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : 'Unknown error'
                await handler.sendMessage(
                    event.channelId,
                    `⚠️ Payout failed: ${errorMsg}. Game #${game.gameNumber} is locked. Please contact admin.`,
                )
            }
        } else {
            // Show feedback
            const feedbackText = formatFeedback(guess, feedback)
            await handler.sendMessage(
                event.channelId,
                `**Guess #${guessNumber}:**\n${feedbackText}`,
            )
        }
        return
    }

    if (subcommand === 'pool') {
        await handler.sendMessage(event.channelId, formatPool(game))
        return
    }

    if (subcommand === 'leaderboard') {
        const entries = db.getLeaderboard(event.spaceId, 10)

        if (entries.length === 0) {
            await handler.sendMessage(event.channelId, '📊 No winners yet. Be the first!')
            return
        }

        const lines = entries.map((entry, i) => {
            const winnings = formatUnits(entry.totalWinnings, 18)
            return `${i + 1}. <@${entry.userId}> - ${entry.wins} win${entry.wins !== 1 ? 's' : ''} (${winnings} ETH won)`
        })

        await handler.sendMessage(
            event.channelId,
            `🏆 **Leaderboard**\n\n${lines.join('\n')}`,
        )
        return
    }

    if (subcommand === 'config') {
        const isAdmin = await handler.hasAdminPermission(event.userId, event.spaceId)
        if (!isAdmin) {
            await handler.sendMessage(event.channelId, '❌ Admin permission required.')
            return
        }

        const action = event.args[1]?.toLowerCase()

        if (action === 'reset') {
            // Force start a new game
            const currentGame = db.getCurrentGame(event.spaceId, event.channelId)
            if (currentGame) {
                db.setGameState(currentGame.id, 'PAYOUT_PENDING')
            }

            const newGame = await startNewGame(event.spaceId, event.channelId)
            await handler.sendMessage(
                event.channelId,
                `✅ Game reset. New Game #${newGame.gameNumber} started.`,
            )
        } else {
            await handler.sendMessage(
                event.channelId,
                '**Admin Commands:**\n• `/wordle config reset` - Force start a new game',
            )
        }
        return
    }

    // Default: show game status and help
    const message =
        `🎮 **Wordle Game #${game.gameNumber}**\n\n` +
        `**How to play:**\n` +
        `• Use \`/wordle guess <word>\` to submit a guess\n` +
        `• You have unlimited guesses\n` +
        `• First correct guess wins the entire prize pool!\n\n` +
        `**Feedback:**\n` +
        `🟩 Green = correct letter, correct position\n` +
        `🟨 Yellow = correct letter, wrong position\n` +
        `⬜ Gray = letter not in word\n\n` +
        `**Commands:**\n` +
        `• \`/wordle\` - Show this help\n` +
        `• \`/wordle guess <word>\` - Submit a guess\n` +
        `• \`/wordle pool\` - Show prize pool\n` +
        `• \`/wordle leaderboard\` - Show leaderboard\n` +
        `• \`/wordle config reset\` - (Admin) Reset game\n\n` +
        formatPool(game)

    await handler.sendMessage(event.channelId, message)
})

const { jwtMiddleware, handler } = bot.start()

const app = new Hono()
app.use(logger())
app.post('/webhook', jwtMiddleware, handler)

export default app
