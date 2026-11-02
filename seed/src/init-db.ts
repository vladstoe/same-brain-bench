import { requireEnv } from './config.js';
import { openDatabase } from './db.js';
import { migrate } from './migrate.js';

const path = requireEnv('DATABASE_PATH');
const db = openDatabase(path);
const applied = migrate(db);
db.close();

for (const migration of applied) {
  console.log(`applied migration ${migration.version} ${migration.name}`);
}
console.log(applied.length === 0 ? `${path} is up to date` : `schema ready at ${path}`);
