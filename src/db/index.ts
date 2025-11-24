// Database connection and setup using Bun's native SQLite
// @ts-ignore - Bun's native SQLite types
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { sql } from 'drizzle-orm'
import * as schema from './schema'
import { join, dirname as pathDirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'

// Get directory path
const __dirname: string = dirname(fileURLToPath(import.meta.url))

// Create SQLite database file
// Use DATABASE_PATH env var if set (for persistent volumes on Render), otherwise use project root
const defaultDbPath = join(__dirname, '../../wordpot.db')
const dbPath = process.env.DATABASE_PATH || defaultDbPath

// Warn if DATABASE_PATH is not set in production (likely Render)
if (!process.env.DATABASE_PATH && process.env.NODE_ENV === 'production') {
    console.warn(`[DB] ⚠️ WARNING: DATABASE_PATH environment variable is not set!`)
    console.warn(`[DB] ⚠️ Database will be created at: ${defaultDbPath}`)
    console.warn(`[DB] ⚠️ This location is EPHEMERAL on Render and will be wiped on each deployment!`)
    console.warn(`[DB] ⚠️ To fix: Set DATABASE_PATH=/data/wordpot.db in Render environment variables`)
    console.warn(`[DB] ⚠️ And ensure a persistent disk is mounted at /data`)
} else if (process.env.DATABASE_PATH) {
    console.log(`[DB] ✅ Using DATABASE_PATH from environment: ${process.env.DATABASE_PATH}`)
} else {
    console.log(`[DB] ℹ️ Using default database path (development): ${defaultDbPath}`)
}

// Ensure the directory exists before creating the database file
const dbDir = pathDirname(dbPath)
if (!existsSync(dbDir)) {
    console.log(`[DB] Creating database directory: ${dbDir}`)
    try {
        mkdirSync(dbDir, { recursive: true })
        console.log(`[DB] Database directory created successfully`)
    } catch (error) {
        console.error(`[DB] Failed to create database directory:`, error)
        throw error
    }
}

console.log(`[DB] Using database path: ${dbPath}`)
console.log(`[DB] Database directory exists: ${existsSync(dbDir)}`)

// Check if database file already exists
const dbExists = existsSync(dbPath)
console.log(`[DB] Database file exists: ${dbExists}`)
if (dbExists) {
    console.log(`[DB] Loading existing database from: ${dbPath}`)
} else {
    console.log(`[DB] Creating new database at: ${dbPath}`)
}

const sqlite = new Database(dbPath)
export const db = drizzle(sqlite, { schema })

// Run migrations on startup
try {
    const migrationsPath = join(__dirname, '../../drizzle')
    migrate(db, { migrationsFolder: migrationsPath })
    console.log('[DB] ✅ Database migrations completed')
} catch (error) {
    console.error('[DB] ❌ Migration error:', error)
    // If migrations folder doesn't exist yet, that's okay - first run
    if ((error as any)?.code !== 'ENOENT') {
        console.warn('[DB] ⚠️ Continuing without migrations (may be first run)')
    }
}

// Verify database is writable by testing a simple query
try {
    await db.run(sql`SELECT 1`)
    console.log('[DB] ✅ Database connection verified and writable')
} catch (error) {
    console.error('[DB] ❌ Database connection test failed:', error)
    throw new Error(`Database initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
}

