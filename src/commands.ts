import type { PlainMessage, SlashCommand } from '@towns-protocol/proto'

export const commands = [
    {
        name: 'help',
        description: 'Get help with bot commands',
    },
    {
        name: 'time',
        description: 'Get the current time',
    },
    {
        name: 'wordle-stats',
        description: 'Show your Wordle statistics',
    },
    {
        name: 'wordle-leaderboard',
        description: 'Show leaderboard for a specific Wordle game',
    },
] as const satisfies PlainMessage<SlashCommand>[]

export default commands
