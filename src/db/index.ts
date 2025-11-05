// Database connection and setup
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from './schema'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

// Get directory path
const __dirname = dirname(fileURLToPath(import.meta.url))

// Create SQLite database file (in project root)
const dbPath = join(__dirname, '../../wordpot.db')
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

