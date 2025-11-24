import { makeTownsBot, getSmartAccountFromUserId } from '@towns-protocol/bot'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { execute } from 'viem/experimental/erc7821'
import { waitForTransactionReceipt, getBalance, readContract } from 'viem/actions'
import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'
import { erc20Abi, parseUnits, formatUnits, zeroAddress, Address } from 'viem'
import commands from './commands'
import { computeFeedback, isCorrect, isValidWord, getRandomWord, formatFeedback } from './game'
import { db, type Game } from './db'

const bot = await makeTownsBot(process.env.APP_PRIVATE_DATA!, process.env.JWT_SECRET!, {
    commands,
    baseRpcUrl: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
})

console.log(`[Bot Init] Bot wallet address (app contract): ${bot.appAddress}`)
console.log(`[Bot Init] Expected address: 0xE48eB33Ba26b623675F0DebCD245AD183c9ad026`)
console.log(`[Bot Init] Address match: ${bot.appAddress.toLowerCase() === '0xe48eb33ba26b623675f0debcd245ad183c9ad026'}`)
const baseRpcUrl = process.env.BASE_RPC_URL || 'https://mainnet.base.org'
console.log(`[Bot Init] Base Mainnet RPC URL: ${baseRpcUrl}`)

// Create dedicated Base Mainnet client for balance checks
const baseClient = createPublicClient({
    chain: base,
    transport: http(baseRpcUrl),
})
console.log(`[Bot Init] Created Base Mainnet client for chain ID: ${base.id}`)

// Return funds to depositors when a game is restarted
async function returnFundsToDepositors(game: Game): Promise<void> {
    try {
        const deposits = await db.getDeposits(game.id)
        if (deposits.length === 0) {
            console.log(`[returnFundsToDepositors] No deposits to return for game ${game.id}`)
            return
        }

        console.log(`[returnFundsToDepositors] Returning funds to ${deposits.length} depositor(s) for game ${game.id}`)

        // Group deposits by sender and token
        const refunds = new Map<string, Map<string, bigint>>() // sender -> token -> total amount

        for (const deposit of deposits) {
            if (!refunds.has(deposit.sender)) {
                refunds.set(deposit.sender, new Map())
            }
            const senderRefunds = refunds.get(deposit.sender)!
            const current = senderRefunds.get(deposit.token) || 0n
            senderRefunds.set(deposit.token, current + deposit.amount)
        }

        // Build refund calls
        const calls: Array<any> = []
        for (const [sender, tokenAmounts] of refunds) {
            for (const [token, amount] of tokenAmounts) {
                if (token === 'NATIVE') {
                    calls.push({
                        to: sender as Address,
                        data: '0x' as const,
                        value: amount,
                    })
                } else {
                    calls.push({
                        to: token as Address,
                        abi: erc20Abi,
                        functionName: 'transfer' as const,
                        args: [sender as Address, amount],
                    })
                }
            }
        }

        if (calls.length === 0) {
            console.log(`[returnFundsToDepositors] No refunds to process`)
            return
        }

        console.log(`[returnFundsToDepositors] Executing ${calls.length} refund transaction(s)`)

        const txHash = await execute(bot.viem, {
            address: bot.appAddress,
            account: bot.viem.account,
            calls,
        })

        await waitForTransactionReceipt(bot.viem, { hash: txHash })
        console.log(`[returnFundsToDepositors] Refund transaction confirmed: ${txHash}`)

        // Record refunds as payouts
        for (const [sender, tokenAmounts] of refunds) {
            for (const [token, amount] of tokenAmounts) {
                await db.recordPayout(game.id, token, amount, txHash, 'success')
            }
        }
    } catch (error) {
        console.error(`[returnFundsToDepositors] Error returning funds:`, error)
        throw error
    }
}

// Get or create current game for a channel
async function getOrCreateGame(spaceId: string, channelId: string): Promise<Game> {
    let game = await db.getCurrentGame(spaceId, channelId)
    if (!game) {
        // No active game found - create a new one
        const targetWord = getRandomWord()
        game = await db.createGame(spaceId, channelId, targetWord)
        console.log(`[getOrCreateGame] Created new game #${game.gameNumber} with word: ${targetWord} (spaceId: ${spaceId}, channelId: ${channelId})`)
    } else {
        // Active game found in database - successfully loaded from persistent storage
        console.log(`[getOrCreateGame] Loaded existing active game #${game.gameNumber} from persistent storage (spaceId: ${spaceId}, channelId: ${channelId})`)
    }
    return game
}

// Format pool display - shows tracked deposits for this specific game
// Each game tracks its own deposits separately (not the total wallet balance)
async function formatPool(game: Game): Promise<string> {
    // Get tracked pool balance for this specific game (not total wallet balance)
    const poolBalance = await db.getPoolBalance(game.id, 'NATIVE')
    const formatted = formatUnits(poolBalance, 18)
    
    if (poolBalance > 0n) {
        return `**Prize Pool (Game #${game.gameNumber}):**\n• ${formatted} ETH`
    } else {
        return `**Prize Pool (Game #${game.gameNumber}):**\n• 0 ETH\n\n💡 Tip the bot with Base ETH to add to the prize pool!`
    }
}

// Build payout plan - uses tracked pool balance for this specific game
// Each game only pays out from its own deposits, not the total wallet balance
// Returns both winner amount (95%) and fee amount (5%)
async function buildPayoutPlan(game: Game): Promise<{
    plan: Array<{ token: string; amount: bigint }>,
    feePlan: Array<{ token: string; amount: bigint }>
}> {
    const plan: Array<{ token: string; amount: bigint }> = []
    const feePlan: Array<{ token: string; amount: bigint }> = []

    console.log(`[buildPayoutPlan] Game ${game.id}, checking tracked pool balance`)
    
    // Get tracked pool balance for this specific game (not total wallet balance)
    const poolBalance = await db.getPoolBalance(game.id, 'NATIVE')
    console.log(`[buildPayoutPlan] Tracked pool balance for game ${game.id}: ${formatUnits(poolBalance, 18)} ETH`)
    
    if (poolBalance > 0n) {
        // Calculate 5% fee (using integer math to avoid precision issues)
        // fee = balance * 5 / 100
        // winnerAmount = balance - fee
        const fee = (poolBalance * 5n) / 100n
        const winnerAmount = poolBalance - fee
        
        plan.push({ token: 'NATIVE', amount: winnerAmount })
        feePlan.push({ token: 'NATIVE', amount: fee })
        
        console.log(`[buildPayoutPlan] Total pool balance: ${formatUnits(poolBalance, 18)} ETH`)
        console.log(`[buildPayoutPlan] Fee (5%): ${formatUnits(fee, 18)} ETH`)
        console.log(`[buildPayoutPlan] Winner amount (95%): ${formatUnits(winnerAmount, 18)} ETH`)
    } else {
        console.log(`[buildPayoutPlan] No funds in pool for game ${game.id}`)
    }

    console.log(`[buildPayoutPlan] Final plan:`, plan.map(p => `${formatUnits(p.amount, 18)} ${p.token}`))
    console.log(`[buildPayoutPlan] Fee plan:`, feePlan.map(p => `${formatUnits(p.amount, 18)} ${p.token}`))
    return { plan, feePlan }
}

// Execute payout
async function executePayout(game: Game, winnerUserId: string): Promise<string> {
    // winnerUserId is the user's root address (from event.userId)
    // We need to get their smart account address using getSmartAccountFromUserId
    console.log(`[executePayout] Starting payout for game ${game.id}`)
    console.log(`[executePayout] Winner user ID (root address): ${winnerUserId}`)
    console.log(`[executePayout] App contract address (funds source): ${bot.appAddress}`)
    
    // Validate winnerUserId is a proper Ethereum address format
    if (!winnerUserId || !winnerUserId.startsWith('0x') || winnerUserId.length !== 42) {
        throw new Error(`Invalid winner user ID format: ${winnerUserId}`)
    }
    
    // Get the winner's smart account address from their user ID (root address)
    const winnerSmartAccountAddress = await getSmartAccountFromUserId(bot, {
        userId: winnerUserId as Address,
    })
    
    if (!winnerSmartAccountAddress) {
        throw new Error(`No smart account found for user ${winnerUserId}. User may not have deployed a smart account yet.`)
    }
    
    // Verify we got a different address (smart account vs root address)
    if (winnerSmartAccountAddress.toLowerCase() === winnerUserId.toLowerCase()) {
        console.warn(`[executePayout] WARNING: Smart account address matches root address. This may indicate the user hasn't deployed a smart account yet.`)
    }
    
    console.log(`[executePayout] Winner's root address (userId): ${winnerUserId}`)
    console.log(`[executePayout] Winner's smart account address (payout destination): ${winnerSmartAccountAddress}`)
    console.log(`[executePayout] Addresses match: ${winnerSmartAccountAddress.toLowerCase() === winnerUserId.toLowerCase()}`)
    
    const { plan, feePlan } = await buildPayoutPlan(game)

    if (plan.length === 0) {
        // Check pool balance for debugging
        const poolBalance = await db.getPoolBalance(game.id, 'NATIVE')
        console.error(`[executePayout] No funds in plan. Pool balance for game ${game.id}: ${formatUnits(poolBalance, 18)} ETH`)
        throw new Error(`No funds to payout. Pool balance for game ${game.id} is ${formatUnits(poolBalance, 18)} ETH.`)
    }
    
    console.log(`[executePayout] Sending payout to winner's smart account: ${winnerSmartAccountAddress}`)
    console.log(`[executePayout] Fee (5%) will remain in bot's app address: ${bot.appAddress}`)

    // Build calls: only send winner amount (95%), fee (5%) stays in bot's app address
    const calls: Array<any> = []
    
    // Send winner amount (95%) only - fee stays in bot's app address
    for (const p of plan) {
        if (p.token === 'NATIVE' || p.token === zeroAddress || !p.token || p.token.length === 0) {
            calls.push({
                to: winnerSmartAccountAddress,
                data: '0x' as const,
                value: p.amount,
            })
        } else {
            if (!p.token.startsWith('0x') || p.token.length !== 42) {
                throw new Error(`Invalid token address: ${p.token}`)
            }
            calls.push({
                to: p.token as Address,
                abi: erc20Abi,
                functionName: 'transfer' as const,
                args: [winnerSmartAccountAddress, p.amount],
            })
        }
    }
    
    console.log(`[executePayout] Executing payout transaction: sending ${plan.length} token(s) to winner (95%), fee (5%) remains in bot`)

    const txHash = await execute(bot.viem, {
        address: bot.appAddress,
        account: bot.viem.account,
        calls,
    })

    await waitForTransactionReceipt(bot.viem, { hash: txHash })
    console.log(`[executePayout] Payout transaction confirmed: ${txHash}`)
    console.log(`[executePayout] Funds sent to winner's smart account: ${winnerSmartAccountAddress}`)

    // Small delay to ensure balance updates are propagated in RPC node
    // Some RPC nodes may have slight delay in reflecting balance changes
    await new Promise(resolve => setTimeout(resolve, 1000))

    // Record payouts (winner amount only, fee is kept in bot's address)
    for (const p of plan) {
        await db.recordPayout(game.id, p.token, p.amount, txHash, 'success')
    }
    
    // Log fee collection
    for (const p of feePlan) {
        console.log(`[executePayout] Collected fee: ${formatUnits(p.amount, 18)} ${p.token === 'NATIVE' ? 'ETH' : p.token}`)
    }

    return txHash
}

// Fetch word definition from free dictionary API
async function getWordDefinition(word: string): Promise<string | null> {
    try {
        const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${word}`)
        if (!response.ok) {
            return null
        }
        const data = await response.json()
        if (Array.isArray(data) && data.length > 0) {
            const firstMeaning = data[0].meanings?.[0]
            if (firstMeaning?.definitions?.[0]?.definition) {
                return firstMeaning.definitions[0].definition
            }
        }
        return null
    } catch (error) {
        console.error(`[getWordDefinition] Error fetching definition for ${word}:`, error)
        return null
    }
}

// Announce winner
async function announceWinner(game: Game, winnerUserId: string, plan: Array<{ token: string; amount: bigint }>, feePlan: Array<{ token: string; amount: bigint }>, txHash: string): Promise<void> {
    const winnerDisplay = `<@${winnerUserId}>`
    const winnings = plan.map(p => {
        const formatted = formatUnits(p.amount, 18)
        const symbol = p.token === 'NATIVE' ? 'ETH' : p.token.slice(0, 6) + '...'
        return `${formatted} ${symbol}`
    }).join(', ')
    
    const fees = feePlan.map(p => {
        const formatted = formatUnits(p.amount, 18)
        const symbol = p.token === 'NATIVE' ? 'ETH' : p.token.slice(0, 6) + '...'
        return `${formatted} ${symbol}`
    }).join(', ')

    // Get winner's smart account address for transparency
    let smartAccountInfo = ''
    try {
        const winnerSmartAccountAddress = await getSmartAccountFromUserId(bot, {
            userId: winnerUserId as Address,
        })
        if (winnerSmartAccountAddress && winnerSmartAccountAddress.toLowerCase() !== winnerUserId.toLowerCase()) {
            smartAccountInfo = `\n**Payout Address:** \`${winnerSmartAccountAddress}\` (smart account)`
        }
    } catch (error) {
        console.error(`[announceWinner] Error getting smart account address:`, error)
        // Don't fail the announcement if we can't get the address
    }

    // Fetch word definition
    const definition = await getWordDefinition(game.targetWord)
    const definitionText = definition ? `\n\n**Definition:** ${definition}` : ''

    const feeText = fees ? `\n**Fee (5%):** ${fees}` : ''
    
    await bot.sendMessage(
        game.channelId,
        `🎉 **WINNER!** 🎉\n\n${winnerDisplay} guessed the word **${game.targetWord.toUpperCase()}** correctly!${definitionText}\n\n` +
        `**Prize:** ${winnings}${feeText}${smartAccountInfo}\n` +
        `**Transaction:** \`${txHash}\``,
    )
}

// Start new game
async function startNewGame(spaceId: string, channelId: string): Promise<Game> {
    const targetWord = getRandomWord()
    const game = await db.createGame(spaceId, channelId, targetWord)

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

// Return funds to depositors and start a new game
async function returnFundsAndStartNewGame(spaceId: string, channelId: string): Promise<Game> {
    const current = await db.getCurrentGame(spaceId, channelId)

    if (current) {
        // Mark current game as ended (reuse PAYOUT_PENDING to prevent further play)
        await db.setGameState(current.id, 'PAYOUT_PENDING')

        // Return funds to depositors
        try {
            await returnFundsToDepositors(current)
            await bot.sendMessage(
                channelId,
                `🔄 **Game #${current.gameNumber} Ended**\n\n` +
                `All funds have been returned to depositors. A new game will start now.`
            )
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error'
            console.error(`[returnFundsAndStartNewGame] Error returning funds:`, error)
            await bot.sendMessage(
                channelId,
                `⚠️ **Game #${current.gameNumber} Ended**\n\n` +
                `Failed to return funds: ${errorMsg}\n\n` +
                `Please contact an admin. A new game will start, but previous funds may need manual handling.`
            )
        }
    }

    // Start fresh game
    const newGame = await startNewGame(spaceId, channelId)
    return newGame
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

    console.log(`[onTip] Currency address: ${event.currency}`)
    console.log(`[onTip] Zero address: ${zeroAddress}`)
    console.log(`[onTip] Receiver: ${event.receiverAddress}, Bot address: ${bot.appAddress}`)
    console.log(`[onTip] Amount: ${formatUnits(event.amount, 18)} ETH`)
    
    // Bot app contract only accepts Base ETH (native), reject ERC20 tokens
    // Check if it's native ETH: currency is zeroAddress OR common native ETH representations
    const currencyLower = event.currency.toLowerCase()
    const zeroAddressLower = zeroAddress.toLowerCase()
    const isNative = currencyLower === zeroAddressLower || 
                     currencyLower === '0x0000000000000000000000000000000000000000' ||
                     currencyLower === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    
    console.log(`[onTip] isNative check: ${isNative}`)
    
    // If it's going to the bot's address and we can't definitively identify it as ERC20,
    // accept it as native ETH (since the bot only accepts native ETH)
    // This handles cases where Towns might use different representations for native ETH
    if (!isNative) {
        // Check if it's a valid ERC20 contract address (has code)
        // If it's not a contract, it's likely native ETH with a different representation
        try {
            const code = await baseClient.getBytecode({ address: event.currency as Address })
            const isContract = code && code !== '0x'
            
            if (isContract) {
                console.log(`[onTip] Rejected ERC20 token tip: currency=${event.currency} from ${event.senderAddress}`)
                await handler.sendMessage(
                    event.channelId,
                    `❌ Tip rejected: Bot only accepts Base ETH (native), not ERC20 tokens.\n\n` +
                    `Received ERC20 token: \`${event.currency}\`\n` +
                    `Please tip with Base ETH (native) to play and win! 💰`,
                )
                return
            } else {
                // Not a contract, likely native ETH with unusual representation
                console.log(`[onTip] Accepting as native ETH (not a contract): currency=${event.currency}`)
            }
        } catch (error) {
            // If we can't check, assume it's native ETH if amount > 0
            console.log(`[onTip] Could not verify contract status, accepting as native ETH: ${error instanceof Error ? error.message : 'Unknown'}`)
        }
    }
    
    // Store as NATIVE - bot only accepts native ETH
    const depositToken = 'NATIVE'
    await db.addDeposit(game.id, event.senderAddress, depositToken, event.amount)
    console.log(`[onTip] Base ETH tip received: ${formatUnits(event.amount, 18)} ETH from ${event.senderAddress} for game ${game.id}`)
    console.log(`[onTip] Game #${game.gameNumber} - App contract: ${bot.appAddress}, Receiver: ${event.receiverAddress}`)
    
    // Immediately check balance after tip to verify it was received
    try {
        const balance = await getBalance(baseClient, { address: bot.appAddress })
        console.log(`[onTip] App contract balance after tip: ${formatUnits(balance, 18)} Base ETH`)
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
        `💰 Base ETH tip received from <@${event.userId}>! ${formatted} ETH added to Game #${game.gameNumber} prize pool.\n\n` +
        `✅ You're now eligible to play and win this round!\n\n` +
        `🎮 **How to play:** Use \`/guess <word>\` to start guessing the 5-letter word!\n\n${await formatPool(game)}`,
    )
})

// Slash command: /wordle (show status/help only)
bot.onSlashCommand('wordle', async (handler, event) => {
    const game = await getOrCreateGame(event.spaceId, event.channelId)

    // Default: show game status and help
    const eligibleCount = (await db.getEligiblePlayers(game.id)).length
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
    if (!(await db.isEligiblePlayer(game.id, userId))) {
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
        await handler.sendMessage(channelId, '❌ Invalid word. Must be a valid 5-letter dictionary word (a-z only, no spaces or special characters).', threadOpts)
        return
    }

    const feedback = computeFeedback(cleanGuess, game.targetWord)
    await db.addGuess(game.id, userId, cleanGuess, feedback.emoji)

    const userGuesses = await db.getUserGuesses(game.id, userId)
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
            const { plan, feePlan } = await buildPayoutPlan(game)
            await announceWinner(game, userId, plan, feePlan, txHash)
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
    
    // If user is already in a thread, ALWAYS use that existing thread.
    // Only create a new thread if NOT already in one (when threadId is undefined).
    const threadId = event.threadId ?? event.eventId
    
    await processGuess(handler, game, event.userId, event.spaceId, event.channelId, guess, threadId)
})

// Handle messages in threads (allow guesses in thread replies)
bot.onMessage(async (handler, event) => {
    // Process guesses in threads - users can continue guessing in the same thread
    if (!event.threadId) {
        return
    }

    const game = await getOrCreateGame(event.spaceId, event.channelId)
    const message = event.message.trim()
    const cleanMessage = message.replace(/\s+/g, '').toLowerCase()
    
    // Check if message is a valid 5-letter word guess
    // Users can continue typing guesses in the thread, and bot responds in that thread
    if (cleanMessage.length === 5 && /^[a-z]{5}$/i.test(cleanMessage)) {
        // Respond in the same thread the user is guessing in
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
    const entries = await db.getLeaderboard(event.spaceId, 10)

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
        // End current round (no winner) and return funds to depositors
        const newGame = await returnFundsAndStartNewGame(event.spaceId, event.channelId)
        await handler.sendMessage(
            event.channelId,
            `✅ Round ended with no winner. Funds returned to depositors. Game #${newGame.gameNumber} has started.`,
        )
    } else {
        await handler.sendMessage(
            event.channelId,
            '**Admin Commands:**\n' +
            '• `/config reset` - End current round (no winner) and return funds to depositors\n' +
            '• `/config rollover` - Alias for reset',
        )
    }
})

// Load and log all active games on startup
async function loadActiveGamesOnStartup() {
    try {
        console.log(`[Startup] Checking database for active games...`)
        const activeGames = await db.getAllActiveGames()
        if (activeGames.length > 0) {
            console.log(`[Startup] ✅ Loaded ${activeGames.length} active game(s) from persistent storage:`)
            for (const game of activeGames) {
                console.log(`[Startup]   - Game #${game.gameNumber} (${game.spaceId}:${game.channelId}) - Target word: ${game.targetWord}`)
                console.log(`[Startup]   - Game ID: ${game.id}, State: ${game.state}, Created: ${game.createdAt}`)
            }
            console.log(`[Startup] Active games will be restored when users interact with the bot.`)
        } else {
            console.log(`[Startup] ⚠️ No active games found in database. Bot is ready for new games.`)
            console.log(`[Startup] This is normal if this is the first run or all previous games were completed.`)
        }
    } catch (error) {
        console.error(`[Startup] ❌ Error loading active games:`, error)
        console.error(`[Startup] Stack trace:`, error instanceof Error ? error.stack : 'No stack trace')
    }
}

// Load active games on startup
await loadActiveGamesOnStartup()

const { jwtMiddleware, handler } = bot.start()

const app = new Hono()
app.use(logger())
app.post('/webhook', jwtMiddleware, handler)

app.get('/.well-known/agent-metadata.json', async (c) => {
  return c.json(await bot.getIdentityMetadata())
})

export default app
