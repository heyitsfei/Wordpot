// Database connection and setup using Bun's native SQLite
// @ts-ignore - Bun's native SQLite types
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import * as schema from './schema'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

// Get directory path
const __dirname: string = dirname(fileURLToPath(import.meta.url))

// Create SQLite database file
// Use DATABASE_PATH env var if set (for persistent volumes on Render), otherwise use project root
const defaultDbPath = join(__dirname, '../../wordpot.db')
const dbPath = process.env.DATABASE_PATH || defaultDbPath
console.log(`[DB] Using database path: ${dbPath}`)

const sqlite = new Database(dbPath)
export const db = drizzle(sqlite, { schema })

// Run migrations on startup
try {
    const migrationsPath = join(__dirname, '../../drizzle')
    migrate(db, { migrationsFolder: migrationsPath })
    console.log('[DB] Database migrations completed')
} catch (error) {
    console.error('[DB] Migration error:', error)
    // If migrations folder doesn't exist yet, that's okay - first run
    if ((error as any)?.code !== 'ENOENT') {
        console.warn('[DB] Continuing without migrations (may be first run)')
    }
}

