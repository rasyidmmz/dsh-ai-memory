import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as immediate } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { apply } from '../index.mjs';

const session = 'session-11111111-2222-3333-4444-555555555555';
const bytes = createHash('sha1').update(Buffer.from('6ba7b8129dad11d180b400c04fd430c8', 'hex')).update(session).digest().subarray(0, 16);
bytes[6] = (bytes[6] & 15) | 80;
bytes[8] = (bytes[8] & 63) | 128;

async function commandFor(agent, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-native-test-'));
  const dbPath = join(dir, 'memory.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE sessions (id BLOB PRIMARY KEY, agent_kind TEXT NOT NULL)');
  if (agent) db.prepare('INSERT INTO sessions VALUES (?, ?)').run(bytes, agent);
  db.close();
  const handlers = new Map();
  const commands = [];
  const ctx = {
    on: (event, fn) => handlers.set(event, fn),
    sessions: { get: () => ({ header: { cwd: dir, origin: null, delegationDepth: 0 } }) },
    shell: {
      resolve: spec => spec,
      async execute(spec) {
        commands.push(spec.command);
        return { async result() {
          return { exitCode: 0, stdout: { text: spec.command.includes('status --json')
            ? JSON.stringify({ version: '3.2.1', data_dir: dir, bind: '127.0.0.1:49374' })
            : 'Finalized 1 session(s)' }, stderr: { text: '' } };
        } };
      },
    },
  };
  try {
    apply(ctx, { exePath: 'ai-memory', binPath: options.missingDb ? join(dir, 'absent.sqlite') : dbPath,
      dataDir: dir, sweep: false, preflight: false, ...options.config });
    await new Promise(resolve => setTimeout(resolve, 30));
    handlers.get('agent/created')({ agent: { id: session } });
    const disposeAgent = () => handlers.get('agent/disposed')({ agent: { id: session } });
    const disposeSession = () => handlers.get('session/disposed')({ id: session, header: { cwd: dir } });
    if (options.sessionFirst) { disposeSession(); disposeAgent(); }
    else { disposeAgent(); if (options.bothEvents) disposeSession(); }
    for (let i = 0; i < 50 && !commands.some(c => c.includes('finalize-session')); i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    // Let the queue finish before removing its database/workdir.
    await new Promise(resolve => setTimeout(resolve, 30));
    if (options.missingDb) assert.equal(existsSync(join(dir, 'absent.sqlite')), false);
    const finalizes = commands.filter(c => c.includes('finalize-session'));
    if (options.bothEvents || options.sessionFirst) assert.equal(finalizes.length, 1);
    return finalizes[0] ?? '';
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const agent of ['claude-code', 'dsh']) {
  for (const preflight of [false, true]) {
    test(`stored ${agent} is finalized unchanged (preflight=${preflight}, server 3.2.1)`, async () => {
      const command = await commandFor(agent, { config: { preflight } });
      assert.match(command, new RegExp(` --agent ["']?${agent}["']? `));
    });
  }
}
for (const sessionFirst of [false, true]) {
  test(`native session/agent disposal deduplicates (sessionFirst=${sessionFirst})`, async () => {
    assert.match(await commandFor('dsh', { sessionFirst, bothEvents: true }), / --agent ["']?dsh["']? /);
  });
}
test('explicit agentKind wins over stored kind', async () => {
  assert.match(await commandFor('claude-code', { config: { agentKind: 'dsh' } }), / --agent ["']?dsh["']? /);
});
test('missing row falls back to legacy capture identity', async () => {
  assert.match(await commandFor(null), / --agent ["']?claude-code["']? /);
});
test('missing database falls back without creating it', async () => {
  assert.match(await commandFor(null, { missingDb: true }), / --agent ["']?claude-code["']? /);
});
test('unrelated harness kind is not selected by automatic lookup', async () => {
  assert.match(await commandFor('codex'), / --agent ["']?claude-code["']? /);
});

test('mixed backlog preserves identities and live/idle/UUIDv4/unrelated-kind guards', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sweep-test-'));
  const path = join(dir, 'memory.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE sessions (id BLOB PRIMARY KEY, project_id INTEGER, cwd TEXT, agent_kind TEXT, ended_at INTEGER);
    CREATE TABLE observations (session_id BLOB, created_at INTEGER);
    INSERT INTO projects VALUES (1, 'demo');`);
  const now = Date.now();
  const kinds = ['dsh', 'claude-code', 'codex', 'dsh', 'dsh', 'dsh'];
  const ids = kinds.map((_, i) => `00000000-0000-${i === 5 ? '4000' : '5000'}-8000-${String(i).padStart(12, '0')}`);
  kinds.forEach((kind, i) => {
    const id = Buffer.from(ids[i].replaceAll('-', ''), 'hex');
    db.prepare('INSERT INTO sessions VALUES (?, 1, ?, ?, NULL)').run(id, dir, kind);
    db.prepare('INSERT INTO observations VALUES (?, ?)').run(id, (now - (i === 4 ? 0 : 600000)) * 1000);
  });
  db.close();
  const commands = [];
  let cleanup;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
  try {
    apply({
      on() {}, effect(fn) { cleanup = fn(); },
      sessions: { list: () => [{ id: ids[3] }], get: () => undefined },
      shell: { resolve: spec => spec, async execute(spec) {
        commands.push(spec.command);
        return { async result() { return { exitCode: 0, stdout: { text: 'Finalized 1 session(s)' }, stderr: { text: '' } }; } };
      } },
    }, { exePath: 'ai-memory', binPath: path, dataDir: dir, preflight: false });
    t.mock.timers.tick(25000);
    for (let i = 0; i < 10; i++) await immediate();
    assert.equal(commands.length, 2, commands.join('\n'));
    for (let i = 0; i < 2; i++) {
      const command = commands.find(c => c.includes(ids[i]));
      assert.ok(command, `missing ${ids[i]}`);
      assert.match(command, new RegExp(` --agent ["']?${kinds[i]}["']? `));
    }
  } finally {
    if (cleanup) cleanup();
    t.mock.timers.reset();
    rmSync(dir, { recursive: true, force: true });
  }
});
