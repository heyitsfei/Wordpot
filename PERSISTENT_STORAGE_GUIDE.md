# Persistent Storage Migration Guide

## What We're Doing

Migrating from in-memory Maps to SQLite with Drizzle ORM to persist game state across bot restarts.

## Steps Completed

1. ✅ Installed dependencies: `drizzle-orm`, `better-sqlite3`, `drizzle-kit`
2. ✅ Created database schema (`src/db/schema.ts`)
3. ✅ Generated migration file (`drizzle/0000_mighty_zeigeist.sql`)
4. ✅ Created database connection (`src/db/index.ts`)

## Next Steps

The Database class in `src/db.ts` needs to be migrated to use Drizzle queries instead of in-memory Maps. This involves:

1. Converting all methods to async
2. Using Drizzle queries (insert, select, update, delete)
3. Handling bigint serialization (storing as strings in DB)
4. Updating all call sites in `src/index.ts` to await async methods

## Files That Need Updates

- `src/db.ts` - Migrate Database class to use Drizzle
- `src/index.ts` - Update all `db.method()` calls to `await db.method()`

## Benefits

- Game state persists across bot restarts
- No more lost games when bot redeploys
- All data stored in `wordpot.db` file
- Can query historical data

## Testing

After migration:
1. Start bot and create a game
2. Restart bot
3. Verify game state is preserved
4. Check that tips and guesses are still tracked

