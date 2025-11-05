// Wordle game logic
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Get directory path (works in ESM)
const __dirname: string = dirname(fileURLToPath(import.meta.url))

// Load solution words (2,315 words that can be the winning word)
const SOLUTION_WORDS_FILE = join(__dirname, 'wordlists', 'wordle-solutions.txt')
const SOLUTION_WORDS = readFileSync(SOLUTION_WORDS_FILE, 'utf-8')
    .trim()
    .split('\n')
    .map(word => word.toLowerCase().trim())
    .filter(word => word.length === 5)

// Load guess dictionary (all valid 5-letter words that can be guessed)
const GUESS_DICTIONARY_FILE = join(__dirname, 'wordlists', 'guess-dictionary.txt')
const GUESS_WORDS = readFileSync(GUESS_DICTIONARY_FILE, 'utf-8')
    .trim()
    .split('\n')
    .map(word => word.toLowerCase().trim())
    .filter(word => word.length === 5)

// Create Sets for O(1) lookup
const SOLUTION_WORDS_SET = new Set(SOLUTION_WORDS)
const GUESS_WORDS_SET = new Set(GUESS_WORDS)

console.log(`[Game] Loaded ${SOLUTION_WORDS.length} solution words`)
console.log(`[Game] Loaded ${GUESS_WORDS.length} guess dictionary words`)

export type Feedback = {
    letters: Array<'green' | 'yellow' | 'gray'>
    emoji: string // 🟩🟨⬜ format
}

/**
 * Compute feedback for a guess against target word
 */
export function computeFeedback(guess: string, target: string): Feedback {
    const guessLower = guess.toLowerCase()
    const targetLower = target.toLowerCase()

    if (guessLower.length !== 5 || targetLower.length !== 5) {
        throw new Error('Words must be exactly 5 letters')
    }

    const result: Array<'green' | 'yellow' | 'gray'> = ['gray', 'gray', 'gray', 'gray', 'gray']
    const targetCounts = new Map<string, number>()
    const guessCounts = new Map<string, number>()

    // First pass: mark greens and count letters
    for (let i = 0; i < 5; i++) {
        const targetChar = targetLower[i]
        const guessChar = guessLower[i]

        targetCounts.set(targetChar, (targetCounts.get(targetChar) || 0) + 1)

        if (guessChar === targetChar) {
            result[i] = 'green'
            guessCounts.set(guessChar, (guessCounts.get(guessChar) || 0) + 1)
        }
    }

    // Second pass: mark yellows
    for (let i = 0; i < 5; i++) {
        if (result[i] === 'green') continue

        const guessChar = guessLower[i]
        const targetCount = targetCounts.get(guessChar) || 0
        const guessCount = guessCounts.get(guessChar) || 0

        if (targetCount > guessCount) {
            result[i] = 'yellow'
            guessCounts.set(guessChar, guessCount + 1)
        }
    }

    const emoji = result.map(r => {
        if (r === 'green') return '🟩'
        if (r === 'yellow') return '🟨'
        return '⬜'
    }).join('')

    return { letters: result, emoji }
}

/**
 * Check if feedback indicates a correct guess
 */
export function isCorrect(feedback: Feedback): boolean {
    return feedback.letters.every(l => l === 'green')
}

/**
 * Check if a word is valid (5 letters, alphabetic only, and exists in guess dictionary)
 */
export function isValidWord(word: string): boolean {
    const normalized = word.toLowerCase().trim()
    // Must be exactly 5 letters, alphabetic only, and in the guess dictionary
    return normalized.length === 5 && /^[a-z]{5}$/.test(normalized) && GUESS_WORDS_SET.has(normalized)
}

/**
 * Get a random solution word (from the 2,315 solution words)
 */
export function getRandomWord(): string {
    return SOLUTION_WORDS[Math.floor(Math.random() * SOLUTION_WORDS.length)]
}

/**
 * Format feedback for display
 */
export function formatFeedback(guess: string, feedback: Feedback): string {
    const letters = guess.split('').map((letter, i) => {
        const status = feedback.letters[i]
        if (status === 'green') return `**${letter.toUpperCase()}**`
        if (status === 'yellow') return `*${letter.toUpperCase()}*`
        return letter.toUpperCase()
    }).join(' ')

    return `${letters}\n${feedback.emoji}`
}

