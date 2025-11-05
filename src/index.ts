import { makeTownsBot, getSmartAccountFromUserId } from '@towns-protocol/bot'
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
        const existingTokens = await db.getPoolTokens(gameId)
        if (existingTokens.length > 0) {
            return // Already has pool entries, skip sync
        }

        // Check NATIVE (ETH) balance
        const nativeBalance = await getBalance(baseClient, { address: bot.appAddress })
        if (nativeBalance > 0n) {
            // Only add if it's a meaningful amount (more than dust)
            if (nativeBalance > parseUnits('0.0001', 18)) {
                await db.addToPool(gameId, 'NATIVE', nativeBalance)
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
    let game = await db.getCurrentGame(spaceId, channelId)
    if (!game) {
        // Check if there's wallet balance that might indicate an existing game
        // (This helps detect if bot restarted and lost game state)
        const balance = await getBalance(baseClient, { address: bot.appAddress })
        const hasBalance = balance > 0n
        
        if (hasBalance) {
            console.log(`[getOrCreateGame] WARNING: Creating new game but wallet has balance (${formatUnits(balance, 18)} ETH). Bot may have restarted and lost game state.`)
        }
        
        const targetWord = getRandomWord()
        game = await db.createGame(spaceId, channelId, targetWord)
        console.log(`[getOrCreateGame] Created new game #${game.gameNumber} with word: ${targetWord} (spaceId: ${spaceId}, channelId: ${channelId})`)
        
        // Sync on-chain balance to pool on new game creation (recovery after restart)
        await syncWalletBalanceToPool(game.id)
    } else {
        console.log(`[getOrCreateGame] Using existing game #${game.gameNumber} (spaceId: ${spaceId}, channelId: ${channelId})`)
    }
    return game
}

// Format pool display - always shows current on-chain Base Sepolia ETH balance
// Bot app contract only accepts Base Sepolia ETH (native), not ERC20 tokens
async function formatPool(game: Game, retries = 3): Promise<string> {
    // Always check actual on-chain NATIVE (Base Sepolia ETH) balance from app contract
    // This is where all tips go: bot.appAddress (app contract)
    // Retry logic to handle RPC node delays after transactions
    let nativeBalance = 0n
    let lastError: Error | null = null
    
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const addressToCheck = bot.appAddress
            console.log(`[formatPool] Checking Base Sepolia ETH balance for app contract: ${addressToCheck} (attempt ${attempt + 1}/${retries})`)
            
            // Use dedicated Base Sepolia client to ensure we're querying Base Sepolia testnet
            nativeBalance = await getBalance(baseClient, { address: addressToCheck })
            console.log(`[formatPool] Raw balance (wei): ${nativeBalance}`)
            console.log(`[formatPool] App contract Base Sepolia ETH balance: ${formatUnits(nativeBalance, 18)} ETH`)
            
            // If we got a result, use it
            break
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error))
            console.warn(`[formatPool] Attempt ${attempt + 1} failed:`, lastError.message)
            
            // Wait before retrying (RPC node might be updating)
            if (attempt < retries - 1) {
                await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)))
            }
        }
    }
    
    if (lastError && nativeBalance === 0n) {
        console.error('[formatPool] Error getting Base ETH balance after retries:', lastError)
        return `**Prize Pool (Game #${game.gameNumber}):**\n• Error checking balance: ${lastError.message}`
    }
    
    const formatted = formatUnits(nativeBalance, 18)
    
    if (nativeBalance > 0n) {
        return `**Prize Pool (Game #${game.gameNumber}):**\n• ${formatted} Base Sepolia ETH`
    } else {
        return `**Prize Pool (Game #${game.gameNumber}):**\n• 0 Base Sepolia ETH\n\n💡 Tip the bot with Base Sepolia ETH to add to the prize pool!`
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
    
    console.log(`[executePayout] Winner's smart account address: ${winnerSmartAccountAddress}`)
    
    const plan = await buildPayoutPlan(game)

    if (plan.length === 0) {
        // Check wallet balance one more time for debugging
        try {
            const walletBalance = await getBalance(baseClient, { address: bot.appAddress })
            console.error(`[executePayout] No funds in plan. Wallet balance: ${formatUnits(walletBalance, 18)} ETH`)
            console.error(`[executePayout] Pool tokens:`, await db.getPoolTokens(game.id))
            throw new Error(`No funds to payout. Wallet has ${formatUnits(walletBalance, 18)} ETH but plan is empty. Check if tips are going to ${bot.appAddress}`)
        } catch (error) {
            throw new Error(`No funds to payout: ${error instanceof Error ? error.message : 'Unknown error'}`)
        }
    }
    
    console.log(`[executePayout] Sending payout to winner's smart account: ${winnerSmartAccountAddress}`)

    const calls = plan.map(p => {
        // Handle NATIVE (ETH) or zeroAddress
        if (p.token === 'NATIVE' || p.token === zeroAddress || !p.token || p.token.length === 0) {
            // Send native ETH directly to winner's smart account address
            return {
                to: winnerSmartAccountAddress,
                data: '0x' as const,
                value: p.amount,
            }
        } else {
            // Validate ERC20 token address
            if (!p.token.startsWith('0x') || p.token.length !== 42) {
                throw new Error(`Invalid token address: ${p.token}`)
            }
            // Transfer ERC20 token to winner's smart account address
            return {
                to: p.token as Address,
                abi: erc20Abi,
                functionName: 'transfer' as const,
                args: [winnerSmartAccountAddress, p.amount],
            }
        }
    })
    
    console.log(`[executePayout] Executing payout transaction with ${calls.length} call(s) to winner's smart account: ${winnerSmartAccountAddress}`)

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

    // Record payouts
    for (const p of plan) {
        await db.recordPayout(game.id, p.token, p.amount, txHash, 'success')
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
async function announceWinner(game: Game, winnerUserId: string, plan: Array<{ token: string; amount: bigint }>, txHash: string): Promise<void> {
    const winnerDisplay = `<@${winnerUserId}>`
    const winnings = plan.map(p => {
        const formatted = formatUnits(p.amount, 18)
        const symbol = p.token === 'NATIVE' ? 'ETH' : p.token.slice(0, 6) + '...'
        return `${formatted} ${symbol}`
    }).join(', ')

    // Fetch word definition
    const definition = await getWordDefinition(game.targetWord)
    const definitionText = definition ? `\n\n**Definition:** ${definition}` : ''

    await bot.sendMessage(
        game.channelId,
        `🎉 **WINNER!** 🎉\n\n${winnerDisplay} guessed the word **${game.targetWord.toUpperCase()}** correctly!${definitionText}\n\n` +
        `**Prize:** ${winnings}\n` +
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

// Rollover current game's prize pool to a new game and start immediately
async function rolloverToNewGame(spaceId: string, channelId: string): Promise<{ newGame: Game; rolled: Array<{ token: string; amount: bigint }> }> {
    const current = await db.getCurrentGame(spaceId, channelId)
    // Start fresh game first
    const newGame = await startNewGame(spaceId, channelId)

    const rolled: Array<{ token: string; amount: bigint }> = []

    if (current) {
        // Mark current game as ended (reuse PAYOUT_PENDING to prevent further play)
        await db.setGameState(current.id, 'PAYOUT_PENDING')

        // Move tracked balances to new game (no onchain movement needed)
        const tokens = await db.getPoolTokens(current.id)
        for (const token of tokens) {
            const amount = await db.getPoolBalance(current.id, token)
            if (amount > 0n) {
                await db.addToPool(newGame.id, token, amount)
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

    console.log(`[onTip] Currency address: ${event.currency}`)
    console.log(`[onTip] Zero address: ${zeroAddress}`)
    console.log(`[onTip] Receiver: ${event.receiverAddress}, Bot address: ${bot.appAddress}`)
    console.log(`[onTip] Amount: ${formatUnits(event.amount, 18)} ETH`)
    
    // Bot app contract only accepts Base Sepolia ETH (native), reject ERC20 tokens
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
                    `❌ Tip rejected: Bot only accepts Base Sepolia ETH (native), not ERC20 tokens.\n\n` +
                    `Received ERC20 token: \`${event.currency}\`\n` +
                    `Please tip with Base Sepolia ETH (native) to play and win! 💰`,
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
    db.addDeposit(game.id, event.senderAddress, depositToken, event.amount)
    console.log(`[onTip] Base Sepolia ETH tip received: ${formatUnits(event.amount, 18)} ETH from ${event.senderAddress} for game ${game.id}`)
    console.log(`[onTip] Game #${game.gameNumber} - App contract: ${bot.appAddress}, Receiver: ${event.receiverAddress}`)
    
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
