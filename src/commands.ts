import type { PlainMessage, SlashCommand } from '@towns-protocol/proto'

const commands = [
    {
        name: 'wordle',
        description: 'Show game status, rules, and how to play',
    },
    {
        name: 'guess',
        description: 'Submit a guess (usage: /guess <word>)',
    },
    {
        name: 'pool',
        description: 'Display current prize pool by token',
    },
    {
        name: 'leaderboard',
        description: 'Show the leaderboard for this space',
    },
    {
        name: 'config',
        description: '(Admin) Configure tokens, reset, etc.',
    },
] as const satisfies PlainMessage<SlashCommand>[]

export default commands
