// test/smoke.mjs — in-process contract test for the plugin.
//
// It does NOT spawn ai-memory: the cordis context is stubbed, so what is proven
// is the plugin's own behaviour — which events it listens to, what it derives as
// the ai-memory session id, which arguments it builds, how it classifies the
// CLI's output, and that a second dispose of the same session does not run the
// CLI twice.
//
// Run with `npm test` (or `node test/smoke.mjs`). Node 22.5+ for node:crypto
// only; no dependencies.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const plugin = await import('../index.mjs');

// ── Stub cordis context ─────────────────────────────────────────────────────
const handlers = new Map();
const executed = [];
const sessions = new Map();

const ctx = {
  on(event, fn) {
    if (!handlers.has(event)) handlers.set(event, []);
    handlers.get(event).push(fn);
  },
  sessions: {
    get(id) {
      return sessions.get(id);
    },
  },
  shell: {
    resolve(spec) {
      return spec;
    },
    async execute(spec) {
      executed.push(spec);
      return {
        async result() {
          return {
            exitCode: 0,
            stdout: { text: 'Finalized 1 claude-code session(s) for default/demo' },
            stderr: { text: '' },
          };
        },
      };
    },
  },
};

// Capture the plugin's log lines instead of printing them.
const lines = [];
const realLog = console.log;
console.log = (...args) => lines.push(args.join(' '));

const emit = (event, payload) => {
  const list = handlers.get(event) ?? [];
  for (const fn of list) fn(payload);
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Run ─────────────────────────────────────────────────────────────────────
const DSH_SESSION = 'session-11111111-2222-3333-4444-555555555555';
const SUB_SESSION = 'session-99999999-8888-7777-6666-555555555555';
const EXPECTED_UUID = uuid5('6ba7b812-9dad-11d1-80b4-00c04fd430c8', DSH_SESSION);

sessions.set(DSH_SESSION, {
  header: { cwd: 'C:\\fake-workspace', origin: null, delegationDepth: 0 },
});

plugin.apply(ctx, {
  exePath: 'C:/fake/ai-memory.exe',
  dataDir: 'C:/fake/data',
  binPath: 'C:/fake/data/db/memory.sqlite',
  sweep: false,
  preflight: false,
});

const checks = [];
const check = (name, fn) => {
  try {
    fn();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({ name, ok: false, error });
  }
};

check('mendaftarkan tiga event yang dipakai', () => {
  assert.deepEqual(
    [...handlers.keys()].sort(),
    ['agent/created', 'agent/disposed', 'session/disposed'],
  );
});

emit('agent/created', { agent: { id: DSH_SESSION } });
emit('agent/disposed', { agent: { id: DSH_SESSION } });
await wait(200);

check('memanggil CLI tepat satu kali', () => assert.equal(executed.length, 1));

const command = executed[0]?.command ?? '';
check('memakai biner dari konfigurasi + call operator Windows', () =>
  assert.match(command, /^& "C:\/fake\/ai-memory\.exe" finalize-session /));
check('mengirim --agent claude-code', () => assert.match(command, / --agent "?claude-code"? /));
check('mengirim --session-id uuid5(NAMESPACE_OID, id DSH)', () =>
  assert.ok(command.includes(' --session-id ' + EXPECTED_UUID), command));
check('tidak mengarang --project saat marker tidak ada', () =>
  assert.ok(!command.includes(' --project '), command));
check('meneruskan --data-dir dari konfigurasi', () =>
  assert.ok(command.includes(' --data-dir "C:/fake/data"'), command));
check('mengklasifikasikan "Finalized" sebagai halaman dibuat', () =>
  assert.ok(lines.some((l) => l.includes('page created')), lines.join('\n')));
check('tidak memasang workdir fiktif', () => assert.equal(executed[0]?.workdir, undefined));

// Dedupe: the same session disposed twice must not run the CLI twice.
emit('agent/disposed', { agent: { id: DSH_SESSION } });
await wait(150);
check('dispose kedua untuk sesi yang sama tidak memanggil CLI lagi', () =>
  assert.equal(executed.length, 1));

// A subagent session must be skipped entirely.
sessions.set(SUB_SESSION, {
  header: { cwd: 'C:\\fake-workspace', origin: 'subagent', delegationDepth: 1 },
});
emit('agent/created', { agent: { id: SUB_SESSION } });
emit('agent/disposed', { agent: { id: SUB_SESSION } });
await wait(150);
check('subagent tidak difinalisasi', () => assert.equal(executed.length, 1));

// ── Onboarding diagnosis (what a marketplace user needs to be told) ─────────
const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

const fakeHome = mkdtempSync(join(tmpdir(), 'dsh-ai-memory-test-'));
const profileDir = join(fakeHome, 'profiles', 'desktop');
mkdirSync(profileDir, { recursive: true });
process.env.DSH_HOME = fakeHome;
process.env.DSH_PROFILE = 'desktop';

check('harnessScope membaca DSH_HOME/DSH_PROFILE', () => {
  const scope = plugin.harnessScope();
  assert.equal(scope.home, fakeHome);
  assert.equal(scope.profile, 'desktop');
});

check('hookWiringStatus: patch tanpa bridge = belum wired', () => {
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: ui-chat\n');
  assert.equal(plugin.hookWiringStatus(plugin.harnessScope()).wired, false);
});

check('hookWiringStatus: patch dengan bridge = wired', () => {
  writeFileSync(join(profileDir, 'cordis.patch.yml'), "- name: '@deepseek-ai/dsh-hooks-claude-code'\n");
  assert.equal(plugin.hookWiringStatus(plugin.harnessScope()).wired, true);
});

check('diagnose: menyebut install ai-memory + hook belum ter-wire', () => {
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: ui-chat\n');
  const lines = plugin.diagnoseEnvironment(
    { exePath: join(fakeHome, 'nope', 'ai-memory.exe'), resolvedDataDir: join(fakeHome, 'nope-data') },
    'win32',
  );
  const text = lines.join('\n');
  assert.match(text, /https:\/\/github\.com\/akitaonrails\/ai-memory#install/);
  assert.match(text, /capture hooks are NOT wired/);
  assert.match(text, /hooks-dsh\.json/);
});

check('diagnose: bersih saat semuanya ada', () => {
  const exe = join(fakeHome, 'bin', 'ai-memory.exe');
  const data = join(fakeHome, 'data');
  mkdirSync(join(fakeHome, 'bin'), { recursive: true });
  mkdirSync(data, { recursive: true });
  writeFileSync(exe, '');
  writeFileSync(join(data, 'config.toml'), '');
  writeFileSync(join(profileDir, 'cordis.patch.yml'), "- name: '@deepseek-ai/dsh-hooks-claude-code'\n");
  assert.deepEqual(plugin.diagnoseEnvironment({ exePath: exe, resolvedDataDir: data }, 'win32'), []);
});

console.log = realLog;

const failed = checks.filter((c) => !c.ok);
for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  if (!c.ok) console.log('      ' + (c.error?.message ?? c.error));
}
console.log(`\n${checks.length - failed.length}/${checks.length} cek lulus`);
process.exit(failed.length === 0 ? 0 : 1);

// Same derivation the plugin uses, kept here independently so the test cannot
// pass by importing the plugin's own helper.
function uuid5(namespace, value) {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(nsBytes).update(Buffer.from(value, 'utf8')).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-');
}
