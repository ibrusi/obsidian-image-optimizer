import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JobQueue } from '../src/services/job-queue.ts';

const tick = () => new Promise((r) => setTimeout(r, 5));

test('jobs run one at a time in order, even after a failure', async () => {
  const queue = new JobQueue();
  const log: string[] = [];
  const job = (name: string, fail = false) => queue.run(async () => {
    log.push(`start ${name}`);
    await tick();
    log.push(`end ${name}`);
    if (fail) throw new Error(name);
    return name;
  });
  const results = await Promise.allSettled([job('a'), job('b', true), job('c')]);
  assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled']);
  assert.equal(queue.busy, false);
});

test('cancelAll aborts the running job and drops queued ones', async () => {
  const queue = new JobQueue();
  let queuedStarted = false;
  const running = queue.run(async (signal) => {
    while (!signal.aborted) await tick();
    signal.throwIfAborted();
  });
  const queued = queue.run(async () => { queuedStarted = true; });
  await tick();
  assert.equal(queue.busy, true);
  queue.cancelAll();
  await assert.rejects(running, { name: 'AbortError' });
  await assert.rejects(queued, { name: 'AbortError' });
  assert.equal(queuedStarted, false);
});

test('jobs queued as not cancellable survive cancelAll', async () => {
  const queue = new JobQueue();
  const blocker = queue.run(async (signal) => { while (!signal.aborted) await tick(); signal.throwIfAborted(); });
  const pasted = queue.run(async () => 'saved', false);
  queue.cancelAll();
  await assert.rejects(blocker, { name: 'AbortError' });
  assert.equal(await pasted, 'saved');
});
