import type { PlainMessage, SlashCommand } from '@towns-protocol/proto'

const commands = [] as const satisfies PlainMessage<SlashCommand>[]

export default commands
