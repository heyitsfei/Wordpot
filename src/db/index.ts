import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from "@libsql/client";
import { eq, and } from "drizzle-orm";
import { playersTable, scoresTable, wordlesTable, type SelectScoreWithRelations } from './schema';
import * as schema from './schema';

const client = createClient({
  url: process.env.DB_FILE_NAME || 'file:local.db',
  ...(process.env.TURSO_TOKEN && { authToken: process.env.TURSO_TOKEN }),
});
const db = drizzle(client, { schema });

export async function getScoresByGameNumber(gameNumber: number): Promise<SelectScoreWithRelations[]> {
  try {
    return await db.query.scoresTable.findMany({
      where: eq(scoresTable.gameNumber, gameNumber), 
      with: {
        player: true
      }
    });
  } catch (error) {
    console.error(error);
    return [];
  }
}

export async function createWordle(gameNumber: number): Promise<boolean> {
  try {
    await db.insert(wordlesTable).values({ gameNumber }).onConflictDoNothing();
    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
}

export async function createPlayer(userId: string, displayName: string): Promise<boolean> {
  try {
    await db.insert(playersTable).values({ userId, displayName }).onConflictDoNothing();
    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
}

export async function createScore(userId: string, gameNumber: number, attempts: string, isWin: number = 0, isTie: number = 0): Promise<SelectScoreWithRelations | undefined> {
  try {
    const result = await db.insert(scoresTable).values({ userId, gameNumber, attempts, isWin, isTie }).onConflictDoNothing().returning();
    if (result.length === 0) {
      return undefined;
    }
    const score = await db.query.scoresTable.findFirst({
      where: and(eq(scoresTable.gameNumber, gameNumber), eq(scoresTable.userId, userId)), 
      with: {
        player: true
      }
    });
    return score;
  } catch (error) {
    console.error(error);
    return;
  }
}

export async function getAllScores(): Promise<SelectScoreWithRelations[]> {
  try {
    return await db.query.scoresTable.findMany({
      with: {
        player: true
      }
    });
  } catch (error) {
    console.error(error);
    return [];
  }
}

export async function getPlayerScores(userId: string): Promise<SelectScoreWithRelations[]> {
  try {
    return await db.query.scoresTable.findMany({
      where: eq(scoresTable.userId, userId),
      with: {
        player: true
      }
    });
  } catch (error) {
    console.error(error);
    return [];
  }
}

