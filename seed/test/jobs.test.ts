import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditRows, call, createTestContext, expectGuard, type TestContext } from './helpers.js';

describe('jobs routes', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    ctx.close();
  });

  function reportCount(): number {
    return ctx.db.prepare('SELECT COUNT(*) FROM reports').pluck().get() as number;
  }

  it('lists registered jobs', async () => {
    const response = await call(ctx, 'GET', '/_jobs');
    expect(response.status).toBe(200);
    expect(await response.json()).toContainEqual(
      expect.objectContaining({ name: 'daily-circulation' }),
    );
  });

  it('runs a job on request and audits the run', async () => {
    const response = await call(ctx, 'POST', '/_jobs/daily-circulation/run');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      name: 'daily-circulation',
      result: { report_id: expect.any(Number), period: '2026-03-02' },
    });
    expect(reportCount()).toBe(1);
    expect(auditRows(ctx.db, 'job.ran')).toHaveLength(1);

    await call(ctx, 'POST', '/_jobs/daily-circulation/run');
    expect(reportCount()).toBe(2);
  });

  it('answers 404 for an unknown job', async () => {
    expect((await call(ctx, 'POST', '/_jobs/unknown/run')).status).toBe(404);
  });

  it('guards listing and running jobs', async () => {
    await expectGuard(ctx, 'GET', '/_jobs', { denied: 'librarian', allowed: 'admin', status: 200 });
    await expectGuard(ctx, 'POST', '/_jobs/daily-circulation/run', {
      denied: 'librarian',
      allowed: 'admin',
      status: 200,
    });
  });
});
