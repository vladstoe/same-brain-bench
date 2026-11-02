import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { requireEnv, requirePort } from './config.js';
import { openDatabase } from './db.js';
import { migrate } from './migrate.js';

const port = requirePort();
const db = openDatabase(requireEnv('DATABASE_PATH'));

for (const migration of migrate(db)) {
  console.log(`applied migration ${migration.version} ${migration.name}`);
}

serve({ fetch: createApp(db).fetch, port }, (info) => {
  console.log(`library API listening on port ${info.port}`);
});
