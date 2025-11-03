import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './drizzle',
  schema: './src/db/schema.ts',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DB_FILE_NAME || 'file:local.db',
    ...(process.env.TURSO_TOKEN && { authToken: process.env.TURSO_TOKEN }),
  },
});

