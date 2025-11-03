// Wordle game logic

// Common 5-letter words from Wordle's word list
const WORD_LIST = [
    'apple', 'beach', 'crane', 'dance', 'earth', 'fancy', 'grace', 'heart',
    'ideal', 'jolly', 'kneel', 'laugh', 'magic', 'noble', 'ocean', 'peace',
    'queen', 'reach', 'sweet', 'tiger', 'uncle', 'vocal', 'world', 'young',
    'zebra', 'blade', 'crown', 'drown', 'flame', 'globe', 'horse', 'image',
    'joust', 'knife', 'light', 'march', 'north', 'orbit', 'paint', 'quiet',
    'roast', 'shade', 'taste', 'ultra', 'vault', 'waste', 'xerox', 'yacht',
    'abuse', 'brick', 'charm', 'draft', 'elope', 'fault', 'ghost', 'hinge',
    'inbox', 'joint', 'knead', 'leash', 'marsh', 'nudge', 'oxide', 'pouch',
    'quill', 'retch', 'shelf', 'trunk', 'unzip', 'vivid', 'waltz', 'xylem',
    'yield', 'admit', 'blink', 'crack', 'drift', 'erupt', 'flick', 'grasp',
    'hound', 'inlet', 'jewel', 'knack', 'latch', 'mimic', 'nymph', 'opera',
    'pluck', 'quack', 'rivet', 'scoop', 'twist', 'unfit', 'vapor', 'wharf',
    'xerox', 'yummy', 'abyss', 'brisk', 'clasp', 'dread', 'epoxy', 'frock',
    'gloom', 'hitch', 'infer', 'joust', 'kneel', 'lurch', 'mirth', 'nudge',
    'outdo', 'plaid', 'quash', 'robin', 'swoop', 'tweak', 'unify', 'verve',
    'wince', 'xylem', 'yacht', 'abide', 'brink', 'climb', 'drape', 'elbow',
    'fiber', 'groan', 'hasty', 'incur', 'jolly', 'knock', 'lodge', 'mirth',
    'noble', 'ocean', 'piano', 'quilt', 'radar', 'swoon', 'throb', 'unzip',
    'vague', 'waltz', 'xenon', 'yield', 'abort', 'broom', 'cleft', 'drown',
    'elude', 'frock', 'gloom', 'hitch', 'infer', 'joust', 'kneel', 'lurch',
    'mirth', 'nudge', 'outdo', 'plaid', 'quash', 'robin', 'swoop', 'tweak',
    'unify', 'verve', 'wince', 'xylem', 'yacht',
]

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
 * Check if a word is valid (5 letters, in word list)
 */
export function isValidWord(word: string): boolean {
    const normalized = word.toLowerCase().trim()
    return normalized.length === 5 && WORD_LIST.includes(normalized)
}

/**
 * Get a random word from the word list
 */
export function getRandomWord(): string {
    return WORD_LIST[Math.floor(Math.random() * WORD_LIST.length)]
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

