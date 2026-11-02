import Database from 'better-sqlite3';
import type { Clock } from './clock.js';
import type { Member } from './types.js';

export type Db = Database.Database;

export type AppEnv = {
  Variables: {
    db: Db;
    clock: Clock;
    member: Member;
  };
};

export function openDatabase(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}
