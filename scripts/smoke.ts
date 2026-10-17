import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
const token = randomBytes(32).toString('hex');
const child = spawn(process.execPath, ['dist/apps/api/server.js'], {
  env: {
    ...process.env,
    TPR_ADMIN_TOKEN: token,
    TPR_REVIEWER_TOKEN: randomBytes(32).toString('hex'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
try {
  await Promise.race([
    once(child.stdout!, 'data'),
    once(child, 'exit').then(() => {
      throw new Error('API exited before readiness');
    }),
    new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Startup timeout')),
        10000,
      );
      timer.unref();
    }),
  ]);
  const base = 'http://127.0.0.1:4310';
  const health = await fetch(base + '/health');
  assert.equal(health.status, 200);
  assert.equal(((await health.json()) as { status: string }).status, 'ok');
  assert.equal((await fetch(base + '/observations')).status, 401);
  const headers = { authorization: `Bearer ${token}` };
  const list = await fetch(base + '/observations?limit=1', { headers });
  assert.equal(list.status, 200);
  assert.equal(((await list.json()) as { items: unknown[] }).items.length, 1);
  const ui = await fetch(base + '/admin', { headers });
  assert.equal(ui.status, 200);
  assert.match(await ui.text(), /Private Fixture Review/);
  console.log(
    'Compiled API smoke passed: database health, auth denial, authenticated queue, private UI.',
  );
} finally {
  child.kill('SIGTERM');
  await once(child, 'exit');
}
