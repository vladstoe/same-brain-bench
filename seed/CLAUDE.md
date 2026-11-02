# library-api

An HTTP API for a library: catalogue, members, circulation, fines and reporting. TypeScript, Hono, SQLite via better-sqlite3.

Requires Node 22.

## Install

```bash
npm ci
```

## Environment

Both variables are required; there are no defaults.

- `DATABASE_PATH` — path to the SQLite file
- `PORT` — port the server listens on

## Create or update the database

```bash
DATABASE_PATH=./library.db npm run db:init
```

This applies any pending migrations. The server applies them at start-up as well.

A new database has no members. Insert the first admin directly; everyone else can then be added through `POST /members`:

```bash
sqlite3 library.db "INSERT INTO members (name, role) VALUES ('Desk Admin', 'admin')"
```

## Run

```bash
DATABASE_PATH=./library.db PORT=3000 npm run dev
```

Every request names its caller in the `x-member-id` header:

```bash
curl -H 'x-member-id: 1' localhost:3000/books
```

## Test

```bash
npm test
```

The tests create their own temporary database, so no environment variables are needed.

## Type check

```bash
npm run typecheck
```

## Layout

```
src/
  server.ts, init-db.ts   entry points for `dev` and `db:init`
  app.ts                  createApp(db, { clock }): mounts route modules, error handling
  db.ts                   openDatabase and the Hono env (db, clock, member)
  migrate.ts              migration runner
  migrations/NNN_*.sql    the schema
  guards.ts               requirePermission(action)
  audit.ts                recordAudit(c, entry)
  scheduler.ts            register / list / run for jobs
  jobs/                   job implementations; jobs/index.ts registers them
  routes/                 one Hono router per area
  http.ts                 HttpError, body and parameter parsing
  query.ts                Filters and page() for list endpoints
  accounts.ts             a member's open loans, balance and borrowing blocks
  clock.ts, csv.ts, config.ts, types.ts
test/                     one file per route module, plus scheduler and migrate
```

## Route modules

A route module exports a `Hono<AppEnv>` router named after its area and registers full paths on it. `app.ts` mounts each one at `/`:

```ts
export const copies = new Hono<AppEnv>();

copies.get('/copies/:id', requirePermission('copies.read'), (c) => {
  return c.json(findCopy(c.get('db'), idParam(c)));
});
```

Handlers read the database with `c.get('db')`, the caller with `c.get('member')` and the time with `now(c)`. Modules export `findX(db, id)` helpers that throw a 404 when the row is missing, and other modules import them rather than repeating the lookup.

Request bodies go through `readJson(c)` and the field parsers in `http.ts` (`stringField`, `idField`, `optionalIdField`, `centsField`). List endpoints build their `WHERE` clause with `Filters` and accept `limit` (default 50, at most 200) and `offset` through `page(c)`.

## Permissions

Each route passes its action to `requirePermission`, reads included. Actions are named `<area>.<verb>`, such as `books.read`, `loans.write` or `jobs.run`. The guard answers:

- 401 when `x-member-id` is missing;
- 403 when the header names no member, or the member's role has no `permissions` row for the action.

Otherwise it stores the member on the context and calls the handler. It reads `permissions` on every request, so a change to the table applies to the next request.

Members have one of four roles: `patron`, `clerk`, `librarian` and `admin`. Each role's rows are in `007_permissions.sql`; `GET /permissions` lists them. A new action, or an existing action granted to another role, gets its rows from a new migration that inserts one row per role:

```sql
INSERT INTO permissions (role, action) VALUES
  ('clerk', 'copies.write');
```

## Errors and status codes

Every error body is `{ "error": "<message>" }`. Handlers throw `badRequest`, `notFound` or `conflict` from `http.ts`; the `onError` handler in `app.ts` turns them into responses, and turns SQLite constraint failures into 409.

| Status | Meaning |
| --- | --- |
| 200 | read or update succeeded |
| 201 | row created; the body is the new row |
| 204 | row deleted |
| 400 | malformed body, parameter or query string |
| 401 | `x-member-id` missing |
| 403 | unknown member, or the role lacks the action |
| 404 | route or row not found |
| 409 | the request conflicts with current state, such as borrowing a copy that is out |

## Migrations

The schema lives in `src/migrations/`, one SQL file per change, named `NNN_description.sql` with a zero-padded number. `migrate(db)` creates `_migrations` if needed, then applies each file whose number is not recorded there, in numeric order, each in its own transaction, and records it. Running it again applies nothing.

To change the schema, add the next numbered file. A migration that has been applied stays as it is; follow-up changes go in a new file.

## Audit log

Every write records one `audit_log` row through `recordAudit(c, entry)`, inside the same `db.transaction` as the write. The row carries the time, the calling member, an action such as `loan.borrowed`, the entity and its id, and a JSON `data` object describing the change:

```ts
const author = db.transaction(() => {
  const result = db.prepare('INSERT INTO authors (name) VALUES (?)').run(name);
  const id = Number(result.lastInsertRowid);
  recordAudit(c, { action: 'author.created', entity: 'author', entityId: id, data: { name } });
  return findAuthor(db, id);
})();
```

When a handler throws inside the transaction, the write and its audit row are both rolled back.

Admins read the log through `GET /audit-log`, filtered by `action`, `entity`, `entity_id`, `actor_member_id`, `from` and `to`.

## Jobs

A job is a function `(context: { db, now }) => object`. Register it by name in `src/jobs/index.ts`:

```ts
register('daily-circulation', dailyCirculation);
```

`GET /_jobs` lists the registered names. `POST /_jobs/:name/run` runs one in a transaction, records a `job.ran` audit entry and returns `{ name, result }`. Whatever starts the work from outside — an operator, a deploy hook, a system scheduler — calls that route:

```bash
curl -X POST -H 'x-member-id: 4' localhost:3000/_jobs/daily-circulation/run
```

`daily-circulation` writes a `reports` row for the current UTC day. `GET /reports/daily/latest` returns the newest one and `GET /reports/:id/csv` serves any report as CSV.

## Tests

Tests use vitest and call the app in-process with `app.request`. `createTestContext()` in `test/helpers.ts` opens a database in a fresh temporary directory, runs the migrations, inserts one member per role (`ctx.members.patron` and so on) and builds the app with a clock fixed at `START`; `ctx.setNow()` moves it. Call `ctx.close()` in `afterEach`.

`call(ctx, method, path, { as, body })` sends a request as the admin unless `as` names another member, or `null` for no header. `expectGuard(ctx, method, path, { denied, allowed, status })` checks the 401 and 403 cases and the allowed role's status; each route module's tests use it.

Assertions use `toMatchObject` and `toContainEqual` so responses and lists can grow without breaking them.

## Units

- Times are ISO-8601 UTC strings, as produced by `Date.prototype.toISOString()`, for example `2026-03-02T09:00:00.000Z`. Report periods are `YYYY-MM-DD`.
- Money is an integer number of cents in fields ending `_cents`.
- A loan runs for `LOAN_PERIOD_DAYS` (14) from the time it is borrowed, and a renewal adds the same period to the current due date.
