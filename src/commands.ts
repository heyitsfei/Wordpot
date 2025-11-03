import type { PlainMessage, SlashCommand } from '@towns-protocol/proto'

const commands = [
    {
        name: 'wordle',
        description: 'Wordle game commands: guess, pool, leaderboard, config',
    },
] as const satisfies PlainMessage<SlashCommand>[]

export default commands
