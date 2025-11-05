# Deployment Guide for Wordle Bot

## Persistence on Render

Render's filesystem is **ephemeral** - files are wiped on each deployment. To persist game state, you need to use a persistent disk volume.

### Option 1: Render Persistent Disk (Recommended)

1. **Create a Persistent Disk in Render Dashboard:**
   - Go to your Render service
   - Click "Environment" tab
   - Scroll to "Persistent Disk" section
   - Click "Add Persistent Disk"
   - Name it `wordpot-data` (or any name)
   - Set mount path: `/data` (or any path you prefer)

2. **Set Environment Variable:**
   - In Render dashboard, go to "Environment" tab
   - Add environment variable:
     - Key: `DATABASE_PATH`
     - Value: `/data/wordpot.db`

3. **Redeploy:**
   - The database will now persist across deployments in `/data/wordpot.db`

### Option 2: Turso (SQLite Cloud - Free Tier)

Turso provides a free SQLite database that persists across deployments.

1. **Sign up for Turso:**
   - Go to https://turso.tech/
   - Create a free account
   - Create a new database

2. **Install Turso CLI:**
   ```bash
   curl -sSfL https://get.tur.so/install.sh | bash
   ```

3. **Get Database URL:**
   ```bash
   turso db show <your-db-name> --url
   ```

4. **Update Code:**
   - Install `@libsql/client`: `bun add @libsql/client`
   - Update `src/db/index.ts` to use Turso instead of file-based SQLite
   - Set `TURSO_DATABASE_URL` environment variable

### Option 3: PostgreSQL (Render Managed)

Render provides managed PostgreSQL databases.

1. **Create PostgreSQL Database in Render:**
   - Go to Render dashboard
   - Click "New +" → "PostgreSQL"
   - Create database

2. **Update Code:**
   - Install `drizzle-orm` with PostgreSQL driver: `bun add drizzle-orm pg`
   - Update `src/db/index.ts` to use PostgreSQL instead of SQLite
   - Set `DATABASE_URL` environment variable

## Current Setup

The bot currently uses **file-based SQLite** with Bun's native SQLite support.

- **Local Development:** Database file is at `wordpot.db` in project root
- **Render Deployment:** Set `DATABASE_PATH` env var to point to persistent disk

## Verification

After deploying, check logs to confirm database path:
```
[DB] Using database path: /data/wordpot.db
```

If you see the database path in logs, persistence is configured correctly.

