import { makeTownsBot } from '@towns-protocol/bot'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { execute } from 'viem/experimental/erc7821'
import { waitForTransactionReceipt, getBalance, readContract } from 'viem/actions'
import { createPublicClient, http } from 'viem'
import { baseSepolia } from 'viem/chains'
import { erc20Abi, parseUnits, formatUnits, zeroAddress, Address } from 'viem'
import commands from './commands'
import { computeFeedback, isCorrect, isValidWord, getRandomWord, formatFeedback } from './game'
import { db, type Game } from './db'

const bot = await makeTownsBot(process.env.APP_PRIVATE_DATA!, process.env.JWT_SECRET!, {
    commands,
    baseRpcUrl: process.env.BASE_RPC_URL || 'https://sepolia.base.org',
})

console.log(`[Bot Init] Bot wallet address (app contract): ${bot.appAddress}`)
console.log(`[Bot Init] Expected address: 0x714141C5fe42aa97B4f3F684C30Df8330CaDa81B`)
console.log(`[Bot Init] Address match: ${bot.appAddress.toLowerCase() === '0x714141c5fe42aa97b4f3f684c30df8330cada81b'}`)
const baseRpcUrl = process.env.BASE_RPC_URL || 'https://sepolia.base.org'
console.log(`[Bot Init] Base Sepolia RPC URL: ${baseRpcUrl}`)

// Create dedicated Base Sepolia testnet client for balance checks
const baseClient = createPublicClient({
    chain: baseSepolia,
    transport: http(baseRpcUrl),
})
console.log(`[Bot Init] Created Base Sepolia client for chain ID: ${baseSepolia.id}`)

// Sync on-chain wallet balance to pool (for recovery after restart)
async function syncWalletBalanceToPool(gameId: string): Promise<void> {
    try {
        // Check if pool already has entries (don't double-count if already synced)
        const existingTokens = db.getPoolTokens(gameId)
        if (existingTokens.length > 0) {
            return // Already has pool entries, skip sync
        }

        // Check NATIVE (ETH) balance
        const nativeBalance = await getBalance(baseClient, { address: bot.appAddress })
        if (nativeBalance > 0n) {
            // Only add if it's a meaningful amount (more than dust)
            if (nativeBalance > parseUnits('0.0001', 18)) {
                db.addToPool(gameId, 'NATIVE', nativeBalance)
                console.log(`Synced ${formatUnits(nativeBalance, 18)} ETH to pool for game ${gameId}`)
            }
        }
    } catch (error) {
        console.error('Error syncing wallet balance to pool:', error)
        // Don't throw - continue even if sync fails
    }
}

// Get or create current game for a channel
async function getOrCreateGame(spaceId: string, channelId: string): Promise<Game> {
    let game = db.getCurrentGame(spaceId, channelId)
    if (!game) {
        const targetWord = getRandomWord()
        game = db.createGame(spaceId, channelId, targetWord)
        // Sync on-chain balance to pool on new game creation (recovery after restart)
        await syncWalletBalanceToPool(game.id)
    }
    return game
}

// Format pool display - always shows current on-chain Base Sepolia ETH balance
// Bot app contract only accepts Base Sepolia ETH (native), not ERC20 tokens
async function formatPool(game: Game): Promise<string> {
    // Always check actual on-chain NATIVE (Base Sepolia ETH) balance from app contract
    // This is where all tips go: bot.appAddress (app contract)
    let nativeBalance = 0n
    try {
        const addressToCheck = bot.appAddress
        console.log(`[formatPool] Checking Base Sepolia ETH balance for app contract: ${addressToCheck}`)
        
        // Use dedicated Base Sepolia client to ensure we're querying Base Sepolia testnet
        nativeBalance = await getBalance(baseClient, { address: addressToCheck })
        console.log(`[formatPool] Raw balance (wei): ${nativeBalance}`)
        console.log(`[formatPool] App contract Base Sepolia ETH balance: ${formatUnits(nativeBalance, 18)} ETH`)
        
        const formatted = formatUnits(nativeBalance, 18)
        
        if (nativeBalance > 0n) {
            return `**Prize Pool (Game #${game.gameNumber}):**\n• ${formatted} Base Sepolia ETH\n\n_App contract (where tips go): \`${bot.appAddress}\`_`
        } else {
            return `**Prize Pool (Game #${game.gameNumber}):**\n• 0 Base Sepolia ETH\n\n_App contract (where tips go): \`${bot.appAddress}\`_\n\n💡 Tip the bot with Base Sepolia ETH to add to the prize pool!`
        }
    } catch (error) {
        console.error('[formatPool] Error getting Base ETH balance:', error)
        return `**Prize Pool (Game #${game.gameNumber}):**\n• Error checking balance: ${error instanceof Error ? error.message : 'Unknown error'}\n\n_App contract: \`${bot.appAddress}\`_`
    }
}

// Build payout plan - always use on-chain Base Sepolia ETH balance (source of truth)
// Bot app contract only accepts Base Sepolia ETH, not ERC20 tokens
async function buildPayoutPlan(game: Game): Promise<Array<{ token: string; amount: bigint }>> {
    const plan: Array<{ token: string; amount: bigint }> = []

    console.log(`[buildPayoutPlan] Game ${game.id}, checking Base Sepolia ETH balance from app contract`)

    // Always check NATIVE (Base Sepolia ETH) balance from app contract (where tips are held)
    try {
        const nativeBalance = await getBalance(baseClient, { address: bot.appAddress })
        console.log(`[buildPayoutPlan] App contract Base Sepolia ETH balance: ${formatUnits(nativeBalance, 18)} ETH`)
        
        if (nativeBalance > 0n) {
            plan.push({ token: 'NATIVE', amount: nativeBalance })
        }
    } catch (error) {
        console.error('[buildPayoutPlan] Error getting Base ETH balance:', error)
    }

    console.log(`[buildPayoutPlan] Final plan:`, plan.map(p => `${formatUnits(p.amount, 18)} ${p.token}`))
    return plan
}

// Execute payout
async function executePayout(game: Game, winnerUserId: string): Promise<string> {
    console.log(`[executePayout] Starting payout for game ${game.id}, winner: ${winnerUserId}`)
    console.log(`[executePayout] App contract address (funds source): ${bot.appAddress}`)
    
    const plan = await buildPayoutPlan(game)

    if (plan.length === 0) {
        // Check wallet balance one more time for debugging
        try {
            const walletBalance = await getBalance(baseClient, { address: bot.appAddress })
            console.error(`[executePayout] No funds in plan. Wallet balance: ${formatUnits(walletBalance, 18)} ETH`)
            console.error(`[executePayout] Pool tokens:`, db.getPoolTokens(game.id))
            throw new Error(`No funds to payout. Wallet has ${formatUnits(walletBalance, 18)} ETH but plan is empty. Check if tips are going to ${bot.appAddress}`)
        } catch (error) {
            throw new Error(`No funds to payout: ${error instanceof Error ? error.message : 'Unknown error'}`)
        }
    }

    // userId is the winner's smart account wallet address (hex with 0x prefix)
    // Validate it's a proper address format
    if (!winnerUserId || !winnerUserId.startsWith('0x') || winnerUserId.length !== 42) {
        throw new Error(`Invalid winner address format: ${winnerUserId}`)
    }
    
    const winnerAddress = winnerUserId as Address

    const calls = plan.map(p => {
        // Handle NATIVE (ETH) or zeroAddress
        if (p.token === 'NATIVE' || p.token === zeroAddress || !p.token || p.token.length === 0) {
            return {
                to: winnerAddress,
                data: '0x' as const,
                value: p.amount,
            }
        } else {
            // Validate ERC20 token address
            if (!p.token.startsWith('0x') || p.token.length !== 42) {
                throw new Error(`Invalid token address: ${p.token}`)
            }
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
        `**NEW GAME STARTED!**\n\n` +
        `**How to play:**\n` +
        `1. 💰 **Tip this bot** to join (any amount)\n` +
        `2. Use \`/guess <word>\` to submit guesses\n` +
        `3. First correct guess wins the entire prize pool!\n\n` +
        `**Rules:** Only players who have tipped can play and win. Unwon prize rolls to next round.\n\n` +
        await formatPool(game),
    )

    // Note: Bot framework doesn't have pinMessage yet, but message is sent
    return game
}

// Rollover current game's prize pool to a new game and start immediately
async function rolloverToNewGame(spaceId: string, channelId: string): Promise<{ newGame: Game; rolled: Array<{ token: string; amount: bigint }> }> {
    const current = db.getCurrentGame(spaceId, channelId)
    // Start fresh game first
    const newGame = await startNewGame(spaceId, channelId)

    const rolled: Array<{ token: string; amount: bigint }> = []

    if (current) {
        // Mark current game as ended (reuse PAYOUT_PENDING to prevent further play)
        db.setGameState(current.id, 'PAYOUT_PENDING')

        // Move tracked balances to new game (no onchain movement needed)
        const tokens = db.getPoolTokens(current.id)
        for (const token of tokens) {
            const amount = db.getPoolBalance(current.id, token)
            if (amount > 0n) {
                db.addToPool(newGame.id, token, amount)
                rolled.push({ token, amount })
            }
        }
    }

    // Announce rollover details
    if (rolled.length > 0) {
        const lines = rolled.map(r => {
            const symbol = r.token === 'NATIVE' ? 'ETH' : r.token.slice(0, 6) + '...'
            return `• ${formatUnits(r.amount, 18)} ${symbol}`
        }).join('\n')

        await bot.sendMessage(
            channelId,
            `↪️ Prize pool rolled over to Game #${newGame.gameNumber}:\n${lines}\n\n` +
            await formatPool(newGame),
        )
    } else {
        await bot.sendMessage(
            channelId,
            `↪️ No funds to roll over. Game #${newGame.gameNumber} has started.\n\n` +
            await formatPool(newGame),
        )
    }

    return { newGame, rolled }
}

// Handle tips
bot.onTip(async (handler, event) => {
    // Only process tips to the bot's address
    if (event.receiverAddress.toLowerCase() !== bot.appAddress.toLowerCase()) {
        return
    }

    const game = await getOrCreateGame(event.spaceId, event.channelId)

    // Skip if game is in payout pending state
    if (game.state === 'PAYOUT_PENDING') {
        await handler.sendMessage(
            event.channelId,
            `⚠️ Game #${game.gameNumber} is being paid out. Tips will go to the next game!`,
        )
        return
    }

    const token = event.currency === zeroAddress ? 'NATIVE' : event.currency
    
    console.log(`[onTip] Currency address: ${event.currency}`)
    console.log(`[onTip] Zero address: ${zeroAddress}`)
    console.log(`[onTip] Currency === zeroAddress: ${event.currency === zeroAddress}`)
    console.log(`[onTip] Currency.toLowerCase(): ${event.currency.toLowerCase()}`)
    console.log(`[onTip] Zero address.toLowerCase(): ${zeroAddress.toLowerCase()}`)
    
    // Bot app contract only accepts Base Sepolia ETH (native), reject ERC20 tokens
    // Check if it's native ETH: currency is zeroAddress OR common native ETH representations
    const currencyLower = event.currency.toLowerCase()
    const zeroAddressLower = zeroAddress.toLowerCase()
    const isNative = currencyLower === zeroAddressLower || 
                     currencyLower === '0x0000000000000000000000000000000000000000' ||
                     currencyLower === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    
    console.log(`[onTip] isNative check: ${isNative}`)
    
    if (!isNative) {
        console.log(`[onTip] Rejected non-NATIVE tip: currency=${event.currency}, token=${token} from ${event.senderAddress}`)
        await handler.sendMessage(
            event.channelId,
            `❌ Tip rejected: Bot only accepts Base Sepolia ETH (native), not ERC20 tokens.\n\n` +
            `Received currency: \`${event.currency}\`\n` +
            `Please tip with Base Sepolia ETH (native) to play and win! 💰`,
        )
        return
    }
    
    // Store as NATIVE regardless of how currency was represented
    const depositToken = 'NATIVE'
    db.addDeposit(game.id, event.senderAddress, depositToken, event.amount)
    console.log(`[onTip] Base Sepolia ETH tip received: ${formatUnits(event.amount, 18)} ETH from ${event.senderAddress} for game ${game.id}`)
    console.log(`[onTip] App contract: ${bot.appAddress}, Receiver: ${event.receiverAddress}`)
    
    // Immediately check balance after tip to verify it was received
    try {
        const balance = await getBalance(baseClient, { address: bot.appAddress })
        console.log(`[onTip] App contract balance after tip: ${formatUnits(balance, 18)} Base Sepolia ETH`)
    } catch (error) {
        console.error(`[onTip] Error checking balance after tip:`, error)
    }
    
    // Mark tipper as eligible to play (store both senderAddress and userId to handle all cases)
    // Always add both identifiers to ensure eligibility regardless of which one is used later
    db.addEligiblePlayer(game.id, event.userId) // Towns user ID (used in slash commands)
    db.addEligiblePlayer(game.id, event.senderAddress) // Wallet address that sent the tip

    const formatted = formatUnits(event.amount, 18)

    await handler.sendMessage(
        event.channelId,
        `💰 Base Sepolia ETH tip received from <@${event.userId}>! ${formatted} Base Sepolia ETH added to Game #${game.gameNumber} prize pool.\n\n` +
        `✅ You're now eligible to play and win this round!\n\n${await formatPool(game)}`,
    )
})

// Slash command: /wordle (show status/help only)
bot.onSlashCommand('wordle', async (handler, event) => {
    const game = await getOrCreateGame(event.spaceId, event.channelId)

    // Default: show game status and help
    const eligibleCount = db.getEligiblePlayers(game.id).length
    const message =
        `🎮 **Wordle Game #${game.gameNumber}**\n\n` +
        `**How to play:**\n` +
        `1. 💰 **Tip the bot** to join this round (any amount)\n` +
        `2. Use \`/guess <word>\` to submit a guess\n` +
        `3. You have unlimited guesses\n` +
        `4. First correct guess wins the entire prize pool!\n\n` +
        `**Rules:**\n` +
        `• Only players who have tipped can play and win\n` +
        `• ${eligibleCount} player${eligibleCount !== 1 ? 's' : ''} eligible in this round\n\n` +
        `**Feedback:**\n` +
        `🟩 Green = correct letter, correct position\n` +
        `🟨 Yellow = correct letter, wrong position\n` +
        `⬜ Gray = letter not in word\n\n` +
        `**Commands:**\n` +
        `• \`/wordle\` - Show this help\n` +
        `• \`/guess <word>\` - Submit a guess\n` +
        `• \`/pool\` - Show prize pool\n` +
        `• \`/leaderboard\` - Show leaderboard\n` +
        `• \`/config reset\` - (Admin) Reset game\n\n` +
        await formatPool(game)

    await handler.sendMessage(event.channelId, message)
})

// Process a guess (shared logic for /guess and thread messages)
async function processGuess(
    handler: any,
    game: Game,
    userId: string,
    spaceId: string,
    channelId: string,
    guess: string,
    threadId?: string,
) {
    const threadOpts = threadId ? { threadId } : undefined

    if (game.state === 'PAYOUT_PENDING') {
        await handler.sendMessage(
            channelId,
            `⏳ Game #${game.gameNumber} is being paid out. A new game will start soon!`,
            threadOpts,
        )
        return
    }

    // Check if user has tipped to be eligible
    if (!db.isEligiblePlayer(game.id, userId)) {
        await handler.sendMessage(
            channelId,
            `❌ You must tip the bot to play this round and be eligible to win!\n\n` +
            `Tip any amount to join Game #${game.gameNumber}. Only players who have tipped can guess and win the prize pool.`,
            threadOpts,
        )
        return
    }

    // Clean and validate guess
    const cleanGuess = guess.replace(/\s+/g, '').toLowerCase().trim()
    if (!cleanGuess) {
        await handler.sendMessage(channelId, 'Usage: `/guess <word>` or just type a 5-letter word (5 letters)', threadOpts)
        return
    }

    if (cleanGuess.length !== 5) {
        await handler.sendMessage(channelId, '❌ Guess must be exactly 5 letters!', threadOpts)
        return
    }

    if (!isValidWord(cleanGuess)) {
        await handler.sendMessage(channelId, '❌ Invalid word. Must be exactly 5 letters (a-z only, no spaces or special characters).', threadOpts)
        return
    }

    const feedback = computeFeedback(cleanGuess, game.targetWord)
    db.addGuess(game.id, userId, cleanGuess, feedback.emoji)

    const userGuesses = db.getUserGuesses(game.id, userId)
    const guessNumber = userGuesses.length

    if (isCorrect(feedback)) {
        const locked = await db.casToPayoutPending(game.id, userId)
        if (!locked) {
            await handler.sendMessage(
                channelId,
                `❌ Too late! Someone else already won Game #${game.gameNumber}.`,
                threadOpts,
            )
            return
        }

        try {
            const txHash = await executePayout(game, userId)
            await announceWinner(game, userId, await buildPayoutPlan(game), txHash)
            await startNewGame(spaceId, channelId)
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error'
            await handler.sendMessage(
                channelId,
                `⚠️ Payout failed: ${errorMsg}. Game #${game.gameNumber} is locked. Please contact admin.`,
                threadOpts,
            )
        }
    } else {
        const feedbackText = formatFeedback(cleanGuess, feedback)
        await handler.sendMessage(
            channelId,
            `**Guess #${guessNumber}:**\n${feedbackText}`,
            threadOpts,
        )
    }
}

// Slash command: /guess
bot.onSlashCommand('guess', async (handler, event) => {
    const game = await getOrCreateGame(event.spaceId, event.channelId)
    const guess = (event.args[0] || '').replace(/\s+/g, '').toLowerCase().trim()
    
    await processGuess(handler, game, event.userId, event.spaceId, event.channelId, guess, event.eventId)
})

// Handle messages in threads (allow guesses in thread replies)
bot.onMessage(async (handler, event) => {
    // Only process if in a thread and message looks like a guess (exactly 5 letters, alphanumeric)
    if (!event.threadId) {
        return
    }

    // Check if message is a valid 5-letter word
    const message = event.message.trim()
    const cleanMessage = message.replace(/\s+/g, '').toLowerCase()
    
    // Only process if it's exactly 5 characters and looks like a word
    if (cleanMessage.length === 5 && /^[a-z]{5}$/i.test(cleanMessage)) {
        const game = await getOrCreateGame(event.spaceId, event.channelId)
        await processGuess(handler, game, event.userId, event.spaceId, event.channelId, cleanMessage, event.threadId)
    }
})

// Slash command: /pool
bot.onSlashCommand('pool', async (handler, event) => {
    const game = await getOrCreateGame(event.spaceId, event.channelId)
    await handler.sendMessage(event.channelId, await formatPool(game))
})

// Slash command: /leaderboard
bot.onSlashCommand('leaderboard', async (handler, event) => {
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
})

// Slash command: /config (admin only)
bot.onSlashCommand('config', async (handler, event) => {
    const isAdmin = await handler.hasAdminPermission(event.userId, event.spaceId)
    if (!isAdmin) {
        await handler.sendMessage(event.channelId, '❌ Admin permission required.')
        return
    }

    const action = event.args[0]?.toLowerCase()

    if (action === 'reset' || action === 'rollover') {
        // End current round (no winner) and roll tracked prize pool to the next round
        const { newGame } = await rolloverToNewGame(event.spaceId, event.channelId)
        await handler.sendMessage(
            event.channelId,
            `✅ Round ended with no winner. Prize pool rolled into Game #${newGame.gameNumber}.`,
        )
    } else {
        await handler.sendMessage(
            event.channelId,
            '**Admin Commands:**\n' +
            '• `/config reset` - End current round (no winner) and roll prize into a new round\n' +
            '• `/config rollover` - Alias for reset',
        )
    }
})

const { jwtMiddleware, handler } = bot.start()

const app = new Hono()
app.use(logger())
app.post('/webhook', jwtMiddleware, handler)

export default app
