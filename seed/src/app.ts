import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { systemClock, type Clock } from './clock.js';
import type { AppEnv, Db } from './db.js';
import { HttpError } from './http.js';
import './jobs/index.js';
import { audit } from './routes/audit.js';
import { authors } from './routes/authors.js';
import { books } from './routes/books.js';
import { copies } from './routes/copies.js';
import { fines } from './routes/fines.js';
import { jobs } from './routes/jobs.js';
import { loans } from './routes/loans.js';
import { members } from './routes/members.js';
import { payments } from './routes/payments.js';
import { permissions } from './routes/permissions.js';
import { reports } from './routes/reports.js';

export type AppOptions = {
  clock?: Clock;
};

export function createApp(db: Db, options: AppOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const clock = options.clock ?? systemClock;

  app.use('*', async (c, next) => {
    c.set('db', db);
    c.set('clock', clock);
    await next();
  });

  app.route('/', authors);
  app.route('/', books);
  app.route('/', copies);
  app.route('/', members);
  app.route('/', permissions);
  app.route('/', loans);
  app.route('/', fines);
  app.route('/', payments);
  app.route('/', reports);
  app.route('/', jobs);
  app.route('/', audit);

  app.notFound((c) => c.json({ error: 'route not found' }, 404));

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.message }, err.status);
    }
    if (err instanceof Database.SqliteError && err.code.startsWith('SQLITE_CONSTRAINT')) {
      return c.json({ error: 'request conflicts with existing data' }, 409);
    }
    console.error(err);
    return c.json({ error: 'internal server error' }, 500);
  });

  return app;
}
