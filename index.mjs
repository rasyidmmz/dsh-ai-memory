// dsh-ai-memory — a DSH plugin that closes ai-memory's consolidation loop.
//
// WHAT IT DOES
// ai-memory turns a finished session's raw observations into searchable wiki
// pages, and it triggers that consolidation on a session-end event. DSH never
// fires one, so DSH sessions piled up as raw observations that no other harness
// could retrieve. This plugin calls ai-memory's own `finalize-session` command
// when a DSH session ends, so DSH sessions become wiki pages like every other
// harness's do.
//
// It calls the `ai-memory` CLI. It does not read ai-memory's source, does not
// bundle it, and shares no code with it. See README "Credits".
//
// DESIGN RULE: event first, schedule second.
// The primary path is an event listener, which costs nothing while idle. The
// sweeper is a safety net for the one case no event covers — DSH killed by
// SIGTERM, which fires no disposal event at all.

import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';

// ── Constants ───────────────────────────────────────────────────────────────

const LOG = '[dsh-ai-memory] ';
const VERSION = '1.0.0';

const FINALIZE_TIMEOUT_MS = 120000;

// Sweeper cadence: dense right after boot (to catch sessions left behind by a
// restart), then easing off to a steady 30 minutes.
//
// A fixed 5-minute interval costs 96 sweeps per 8 hours; this costs ~20 while
// still reacting within seconds of startup.
const SWEEP_SCHEDULE_MS = [
  25_000,       // just after boot: catch sessions abandoned by a restart
  60_000,       // 1 minute
  3 * 60_000,   // 3 minutes
  10 * 60_000,  // 10 minutes
];
const SWEEP_STEADY_MS = 30 * 60 * 1000;

// A session is only touched once it has been idle this long. This protects a
// session running in a DIFFERENT DSH window: that is a separate process, so it
// is invisible to our live-session list, and without the delay we would close a
// session that is still being written.
const SWEEP_MIN_IDLE_MS = 120000;

// Ceiling per sweep so we never spawn a burst of processes at once.
const SWEEP_MAX_PER_RUN = 10;

// OID namespace for UUID v5 — the same one ai-memory uses.
const OID_NS = '6ba7b812-9dad-11d1-80b4-00c04fd430c8';

// The agent kind recorded in ai-memory's store for every DSH session.
//
// NOT A FREE CHOICE. ai-memory recognises a fixed set of agent kinds
// (claude-code, codex, cursor, open-code, opencode2, pi, omp, zero, kiro-cli,
// pool, zcode) and rejects anything else: `--agent dsh` fails with "invalid
// value 'dsh'". DSH reaches ai-memory through the Claude Code hook bridge, so
// `claude-code` is the correct and only workable value. Verified: all 26 stored
// sessions carry agent_kind = claude-code.
//
// The CLI's OWN default is `codex`, not `claude-code`, so this flag must always
// be passed explicitly.
const DEFAULT_AGENT_KIND = 'claude-code';

const name = 'ai-memory';
const inject = ['shell', 'sessions'];

// ── Configuration ───────────────────────────────────────────────────────────
//
// Everything here is optional: with no `config:` block at all the plugin
// behaves exactly as it does for the author. Deliberately no schema export, so
// cordis skips validation and we stay dependency-free (no schemastery, and no
// @deepseek-ai/* peer range to get wrong). Bad values are reported and ignored
// rather than thrown: a plugin that throws during load can take the profile
// down with it.

/** Platform default for the ai-memory executable. */
function defaultExePath() {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (typeof localAppData === 'string' && localAppData.length > 0) {
      return join(localAppData, 'Programs', 'ai-memory', 'ai-memory.exe');
    }
    return 'ai-memory.exe'; // fall back to PATH
  }
  return 'ai-memory'; // installed on PATH by the upstream installers
}

/**
 * Platform default for the ai-memory data directory, mirroring what
 * `dirs::data_local_dir()` resolves to on each platform.
 *
 * Used ONLY to locate the store for the sweeper. The `finalize-session` call
 * itself deliberately omits `--data-dir` unless configured, so the CLI resolves
 * its own location — which is the path already proven to match.
 */
function defaultDataDir() {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (typeof localAppData === 'string' && localAppData.length > 0) {
      return join(localAppData, 'ai-memory');
    }
    return join(homedir(), 'AppData', 'Local', 'ai-memory');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'ai-memory');
  }
  const xdg = process.env.XDG_DATA_HOME;
  const base = typeof xdg === 'string' && xdg.length > 0 ? xdg : join(homedir(), '.local', 'share');
  return join(base, 'ai-memory');
}

/** Read a non-empty string, or undefined when absent/blank/wrong type. */
function readString(raw, key, warnings) {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    warnings.push(key + ' must be a string — ignored');
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Read a boolean, or undefined when absent/wrong type. */
function readBoolean(raw, key, warnings) {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    warnings.push(key + ' must be true or false — ignored');
    return undefined;
  }
  return value;
}

/** Read a positive finite number, or undefined when absent/invalid. */
function readPositiveNumber(raw, key, warnings) {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    warnings.push(key + ' must be a positive number — ignored');
    return undefined;
  }
  return value;
}

function resolveConfig(raw) {
  const warnings = [];
  const source = raw && typeof raw === 'object' ? raw : {};

  const exePath = readString(source, 'exePath', warnings) ?? defaultExePath();
  const dataDir = readString(source, 'dataDir', warnings);
  const binPath = readString(source, 'binPath', warnings);
  const agentKind = readString(source, 'agentKind', warnings) ?? DEFAULT_AGENT_KIND;
  const timeoutMs = readPositiveNumber(source, 'timeoutMs', warnings) ?? FINALIZE_TIMEOUT_MS;
  const sweep = readBoolean(source, 'sweep', warnings) ?? true;
  const preflight = readBoolean(source, 'preflight', warnings) ?? true;

  return {
    exePath,
    dataDir,
    // The sweeper reads SQLite directly, so it needs a concrete path even when
    // `dataDir` is left unset for the CLI call.
    resolvedDataDir: dataDir ?? defaultDataDir(),
    binPath: binPath ?? join(dataDir ?? defaultDataDir(), 'db', 'memory.sqlite'),
    agentKind,
    timeoutMs,
    sweep,
    preflight,
    warnings,
  };
}

// ── Command construction ────────────────────────────────────────────────────

/**
 * Quote one argument for the platform's shell.
 *
 * Windows keeps the double-quoted form that the original plugin used and that
 * is verified working through `ctx.shell` (which runs pwsh). POSIX uses single
 * quotes, because a POSIX shell would read `& "..."` as "run in the background"
 * — the plugin would appear to succeed while doing nothing at all.
 */
function quoteArg(value, platform) {
  const text = String(value);
  if (platform === 'win32') return '"' + text + '"';
  return "'" + text.split("'").join("'\\''") + "'";
}

/** Build the `ai-memory status --json` invocation used by the preflight check. */
function buildStatusCommand(config, platform) {
  const exe = quoteArg(config.exePath, platform);
  const head = platform === 'win32' ? '& ' + exe : exe;
  const parts = [head, 'status', '--json'];
  if (config.dataDir) parts.push('--data-dir ' + quoteArg(config.dataDir, platform));
  return parts.join(' ');
}

/**
 * Build the `ai-memory finalize-session` invocation.
 *
 * `--data-dir` is omitted unless explicitly configured, letting the CLI resolve
 * its own location. That is deliberate: it is the path proven to match on the
 * author's machine, so the default configuration needs no settings at all.
 *
 * `--agent` is always sent: the CLI defaults to `codex`.
 *
 * No `2>&1`. DSH runs commands through pwsh with stderr NOT redirected, and
 * collapsing stderr inside the command fails there with
 *   ResourceUnavailable: StandardErrorEncoding is only supported when standard
 *   error is redirected.
 * The command then exits 1 having done nothing. `ctx.shell` already separates
 * stdout and stderr (`r.stdout.text`, `r.stderr.text`).
 */
function buildFinalizeCommand(config, uuid, project, platform) {
  const exe = quoteArg(config.exePath, platform);
  const parts = [platform === 'win32' ? '& ' + exe : exe, 'finalize-session'];

  if (config.dataDir) parts.push('--data-dir ' + quoteArg(config.dataDir, platform));
  if (project) {
    parts.push('--workspace default');
    parts.push('--project ' + quoteArg(project, platform));
  }
  parts.push('--agent ' + quoteArg(config.agentKind, platform));
  parts.push('--session-id ' + uuid);

  return parts.join(' ');
}

// ── Identifiers ─────────────────────────────────────────────────────────────

/** UUID v5 (SHA-1) of a name, lowercase hyphenated. */
function uuid5(namespace, value) {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1')
    .update(nsBytes)
    .update(Buffer.from(value, 'utf8'))
    .digest();
  hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = hash.subarray(0, 16).toString('hex');
  return (
    hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' +
    hex.slice(16, 20) + '-' + hex.slice(20, 32)
  );
}

/**
 * DSH agent id → the UUID ai-memory stores for it.
 *
 * TWO ID SHAPES, TWO TREATMENTS (proven with a controlled test):
 *   - `session-<uuid>` (main session) is HASHED first:
 *       stored id = uuid5(OID, "session-<uuid>")
 *     Passing the raw `session-...` string is rejected by the CLI with
 *     "invalid uuid: invalid character: found `s` at 1".
 *   - a bare `<uuid>` (child agent) is used AS IS. Hashing it would produce a
 *     UUID that does not exist in the store.
 */
function sessionIdToUuid(dshSessionId) {
  if (dshSessionId.startsWith('session-')) return uuid5(OID_NS, dshSessionId);
  return dshSessionId;
}

/**
 * A short, readable label for a session id in log lines.
 *
 * Naively slicing the first 8 characters is WRONG for a raw DSH id: a main
 * session's id is `session-<uuid>`, so `slice(0, 8)` yields the constant,
 * useless string `"session-"` — every session logs identically and the line
 * tells you nothing. Strip the prefix first so the label is always the real
 * UUID's first 8 characters.
 *
 * Tolerates a UUID that is already bare, and anything unrecognised.
 */
function shortLabel(value) {
  const text = String(value);
  const bare = text.startsWith('session-') ? text.slice('session-'.length) : text;
  return bare.slice(0, 8);
}

/** A 16-byte BLOB from ai-memory → lowercase hyphenated UUID. */
function blobToUuid(value) {
  if (!value) return '';
  let bytes;
  if (value instanceof Uint8Array) bytes = value;
  else if (Buffer.isBuffer(value)) bytes = value;
  else return '';
  if (bytes.length !== 16) return '';
  let hex = '';
  for (let i = 0; i < 16; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return (
    hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' +
    hex.slice(16, 20) + '-' + hex.slice(20, 32)
  );
}

// ── Plugin ──────────────────────────────────────────────────────────────────

function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  const platform = process.platform;

  for (const warning of config.warnings) {
    console.log(LOG + 'config: ' + warning);
  }

  // A missing executable is the single most common first-run failure, and it
  // fails silently (the command exits non-zero, the session simply never gets a
  // page). Say so once, loudly, at load time.
  //
  // Only checked when the configured value is an absolute path. On POSIX the
  // default is a bare `ai-memory` resolved through PATH, which `existsSync`
  // would report as missing even though the shell finds it fine.
  const isAbsoluteExe = config.exePath.includes('/') || config.exePath.includes('\\');
  if (isAbsoluteExe && !existsSync(config.exePath)) {
    console.log(
      LOG + 'WARNING: ai-memory executable not found at "' + config.exePath +
      '". Install ai-memory, or set the `exePath` config to its real location. ' +
      'Until then this plugin cannot finalize any session.'
    );
  }

  let running = false;
  let done = 0;
  let skipped = 0;
  let failed = 0;

  // A session's cwd is captured when its agent is created: by the time
  // `agent/disposed` fires the session may already be gone from the store, so
  // do not depend on it there.
  const cwdByAgent = new Map();

  // Sessions waiting to be finalized (see `pump`).
  const queue = [];

  // UUIDs already finalized in this process. Prevents a second CLI call when
  // `session/disposed` and `agent/disposed` both fire for the same session —
  // which they do, in that order. One entry per closed session; discarded with
  // the plugin, so it does not grow over the process lifetime.
  const finalizedRecently = new Set();

  // Project hints for UUIDs that arrive from the sweeper. Those sessions have no
  // agent left, so their cwd can no longer be asked for.
  const sweepProjects = new Map();

  // Timer handles, kept so they can be cleared when the plugin is disposed.
  const timerHandles = [];

  ctx.on('agent/created', function (payload) {
    let id = '';
    if (payload && payload.agent && payload.agent.id !== undefined) {
      id = String(payload.agent.id);
    }
    if (id.length === 0) return;
    try {
      const session = ctx.sessions.get(payload.agent.id);
      const cwd = session && session.header ? session.header.cwd : undefined;
      if (typeof cwd === 'string' && cwd.length > 0) cwdByAgent.set(id, cwd);
    } catch (e) {
      // cwd is only an optimisation; without it scope resolution falls back to
      // the slower path.
    }
  });

  function cwdFor(agentId) {
    const cached = cwdByAgent.get(agentId);
    if (typeof cached === 'string' && cached.length > 0) return cached;
    try {
      const session = ctx.sessions.get(agentId);
      const cwd = session && session.header ? session.header.cwd : undefined;
      if (typeof cwd === 'string' && cwd.length > 0) return cwd;
    } catch (e) {
      // ignored
    }
    return '';
  }

  /**
   * Is this agent a subagent?
   *
   * Read from the session header, NOT from the registry. `dsh-agent` deletes the
   * entry first and announces it afterwards:
   *     this.store.delete(entry.id);   // lib/index.js:508
   *     this.emitDisposed(entry);      // lib/index.js:510
   * so during this listener `ctx.agents.get(id)` is ALWAYS undefined — for the
   * main session as well as for children. An earlier version used that check as
   * its filter and therefore skipped EVERY agent, doing nothing at all while
   * logging no error.
   *
   * The header is still readable at this point (verified: main session reports
   * origin=null depth=0; child reports origin="subagent" depth=1).
   *
   * When the header cannot be read, do NOT skip: `finalize-session` is safe and
   * idempotent, so trying is better than silently losing the main session.
   */
  function isSubagent(agentId) {
    try {
      const session = ctx.sessions.get(agentId);
      const header = session && session.header;
      if (!header) return false;
      if (header.origin === 'subagent') return true;
      const depth = header.delegationDepth;
      if (typeof depth === 'number' && depth > 0) return true;
      return false;
    } catch (e) {
      return false;
    }
  }

  function runFinalize(uuid, workdir, project) {
    const command = buildFinalizeCommand(config, uuid, project, platform);
    const request = { command: command, timeoutMs: config.timeoutMs };
    if (workdir) request.workdir = workdir;
    return ctx.shell.run(ctx.shell.resolve(request));
  }

  function outputOf(result) {
    return (
      String((result && result.stdout && result.stdout.text) || '') + '\n' +
      String((result && result.stderr && result.stderr.text) || '')
    );
  }

  ctx.on('agent/disposed', function (payload) {
    // Only leaf fields are read from live data.
    let id = '';
    if (payload && payload.agent && payload.agent.id !== undefined) {
      id = String(payload.agent.id);
    }
    if (id.length === 0) return;

    if (isSubagent(id)) {
      skipped++;
      console.log(LOG + 'skipping subagent ' + shortLabel(id) + ' (skipped total: ' + skipped + ')');
      return;
    }

    // QUEUE, DO NOT DROP. Guarding with a bare `running` flag loses the session
    // that arrives while another finalize is in flight — and that is the common
    // case, not a rare one: closing DSH with two sessions open fires two
    // `agent/disposed` back to back, and the second used to vanish.
    let uuidForCheck;
    try {
      uuidForCheck = sessionIdToUuid(id);
    } catch (e) {
      uuidForCheck = '';
    }
    // `session/disposed` usually handles this session first. Do not call the CLI
    // twice for the same session.
    if (uuidForCheck && finalizedRecently.has(uuidForCheck)) {
      console.log(LOG + 'skipping ' + shortLabel(id) + ' (already finalized on the fast path)');
      return;
    }

    queue.push(id);
    pump();
  });

  // ── Fast path: a session closed cleanly ───────────────────────────────────
  //
  // This is the PRIMARY path, and it is the answer to "cheap AND effective":
  //
  //   - Idle cost: ZERO. No timer, no query, no process woken. The listener only
  //     runs when a session is actually closed.
  //   - Reaction: IMMEDIATE, rather than waiting for the next scheduled sweep.
  //
  // `session/disposed` is used because it is the ONLY one of the three events
  // fired on close that carries the full Session object, so `cwd` can be read
  // straight from `session.header.cwd` with no cache and no guessing. (Verified
  // together: agent/disposed, api-session/removed, session/disposed.)
  //
  // It is not sufficient on its own, which is why the sweeper stays: this
  // listener only fires when a session closes CLEANLY. When DSH is killed with
  // SIGTERM none of the three fire, and that is where the sweeper works.
  ctx.on('session/disposed', function (session) {
    let rawId = '';
    let cwd = '';
    try {
      if (session && session.id !== undefined) rawId = String(session.id);
      if (session && session.header && session.header.cwd) {
        cwd = String(session.header.cwd);
      }
    } catch (e) {
      return;
    }
    if (rawId.length === 0) return;

    // Child sessions fire this too. As in `agent/disposed`, skip them so the
    // main session's record is not split.
    if (isSubagent(rawId)) {
      console.log(LOG + 'fast: skipping child session ' + shortLabel(rawId));
      return;
    }

    // The id here may be either shape: `session-<uuid>` or the stored UUID.
    // `sessionIdToUuid` handles both correctly.
    let uuid;
    try {
      uuid = sessionIdToUuid(rawId);
    } catch (e) {
      console.log(LOG + 'fast: unrecognised id ' + shortLabel(rawId));
      return;
    }

    // A stored row never keeps the `session-` prefix, so anything still carrying
    // it was never captured and has nothing to finalize.
    if (uuid.charAt(14) !== '5') {
      console.log(LOG + 'fast: ' + shortLabel(rawId) + ' is not a main session, skipped');
      return;
    }

    if (finalizedRecently.has(uuid)) return;

    const project = cwd ? basename(cwd).toLowerCase() : '';
    sweepProjects.set(uuid, { project: project, workdir: cwd });
    console.log(LOG + 'fast: session closed ' + uuid.slice(0, 8) + ' | cwd=' + (cwd || '-'));
    queue.push(uuid);
    pump();
  });

  function pump() {
    if (running) return;
    const id = queue.shift();
    if (id === undefined) return;
    running = true;

    // Three sources can reach this queue:
    //   - `agent/disposed`: id is the DSH id (`session-<uuid>` for a main
    //     session); cwd comes from the live session, scope from the marker.
    //   - `session/disposed` (fast path): id is ALREADY a ready UUID, cwd read
    //     straight from the session header.
    //   - the sweeper: as the fast path, but the session died long ago.
    const hinted = sweepProjects.get(id);
    let workdir = '';
    let uuid;
    if (hinted) {
      sweepProjects.delete(id);
      workdir = hinted.workdir;
      uuid = id;
    } else {
      workdir = cwdFor(id);
      cwdByAgent.delete(id);
      try {
        uuid = sessionIdToUuid(id);
      } catch (e) {
        running = false;
        console.log(LOG + 'failed to derive uuid for ' + shortLabel(id) + ': ' + String((e && e.message) || e));
        pump();
        return;
      }
    }

    // DE-DUPLICATE HERE, NOT ONLY AT ENQUEUE TIME.
    //
    // The same session reaches this queue twice through two different id
    // SHAPES: `agent/disposed` carries `session-<uuid>`, while
    // `session/disposed` (the fast path) carries the bare stored UUID. Both
    // arrive within milliseconds of each other, and both are checked against
    // `finalizedRecently` when they are ENQUEUED — at which point the first
    // finalize has not finished, so the set is still empty and both pass.
    //
    // Without this check `pump()` then runs the same session twice: the second
    // call costs ~2.2 s and one `ai-memory.exe` process, and the CLI answers
    // "No open sessions matched" because the first call already closed it.
    // Observed in the field before this fix:
    //   04:41:18.237 finalizing session session-   (raw id -> truncated label)
    //   04:41:20.482 session -> page created
    //   04:41:20.482 finalizing session c37c3911   (SAME session, second call)
    //   04:41:22.665 session c37c3911 -> no open session matched
    //
    // Both shapes normalise to the same UUID, so comparing on `uuid` catches
    // it regardless of which event enqueued it.
    //
    // NOTE: this check must NOT be narrowed to non-`hinted` items. The fast
    // path (`session/disposed`) records a `sweepProjects` hint AND pushes to
    // the queue, so the duplicate always arrives as a `hinted` item — an
    // earlier version of this fix excluded those and therefore caught nothing.
    // Caught by the functional test, not by reading the code.
    if (finalizedRecently.has(uuid)) {
      running = false;
      console.log(LOG + 'skipping ' + shortLabel(uuid) + ' (already finalized)');
      pump();
      return;
    }

    const project = hinted
      ? hinted.project
      : (workdir ? basename(workdir).toLowerCase() : '');
    // Label from the NORMALISED uuid, never from the raw id: a raw
    // `session-<uuid>` sliced to 8 characters is the useless string
    // `"session-"`. See shortLabel().
    const short = shortLabel(uuid);
    console.log(
      LOG + 'finalizing session ' + short +
      ' | uuid=' + uuid +
      ' | cwd=' + (workdir || '(unknown)') +
      (hinted ? ' | cwd from event' : '') +
      (queue.length > 0 ? ' | queued: ' + queue.length : '')
    );

    Promise.resolve()
      .then(function () { return runFinalize(uuid, workdir, ''); })
      .then(function (first) {
        const out = outputOf(first);
        if (/Finalized/i.test(out)) return { stage: 'marker', out: out, result: first };
        // Repo without a marker: the folder basename does not match the project
        // name the hooks wrote (case differs). Retry with the lowercase name.
        if (project && /No open .* sessions matched/i.test(out)) {
          return runFinalize(uuid, workdir, project)
            .then(function (second) { return { stage: 'fallback', out: outputOf(second), result: second }; });
        }
        return { stage: 'marker', out: out, result: first };
      })
      .then(function (f) {
        if (/Finalized/i.test(f.out)) {
          done++;
          // Remember, so `session/disposed` + `agent/disposed` for the same
          // session do not call the CLI twice.
          finalizedRecently.add(uuid);
          console.log(
            LOG + 'session ' + short + ' -> page created' +
            (f.stage === 'fallback' ? ' (via --project ' + project + ')' : '') +
            ' (exit=' + String(f.result && f.result.exitCode) + ', created total: ' + done + ')'
          );
        } else if (/No open .* sessions matched/i.test(f.out)) {
          // Already finalized (e.g. by another path). Record that too, so it is
          // not retried.
          finalizedRecently.add(uuid);
          console.log(LOG + 'session ' + short + ' -> no open session matched (already finalized?)');
        } else {
          failed++;
          const tail = f.out.trim().split(/\r?\n/).slice(-3).join(' / ').slice(0, 300);
          console.log(LOG + 'session ' + short + ' FAILED (failures total: ' + failed + '): ' + tail);
        }
      })
      .catch(function (e) {
        failed++;
        console.log(LOG + 'failed: ' + String((e && e.message) || e));
      })
      .then(function () {
        running = false;
        pump(); // run the next queued session
      });
  }

  console.log(
    LOG + 'active v' + VERSION +
    ' -- fast path session/disposed (zero idle cost) + tiered sweeper safety net' +
    (config.sweep ? ' (25s/1m/3m/10m then 30m)' : ' (DISABLED via config)') +
    '; two id shapes; explicit workdir; lowercase project fallback; no 2>&1; queue' +
    '; agent=' + config.agentKind + '; exe=' + config.exePath
  );

  // ── Sweeper for abandoned sessions ───────────────────────────────────────
  //
  // THE PROBLEM IT SOLVES
  // DSH exits with SIGTERM, and SIGTERM does NOT fire `agent/disposed`. Evidence:
  // `Harness process exited (signal SIGTERM)` with no agent/disposed line after
  // it. A session open at that moment is therefore NEVER finalized: it stays
  // OPEN forever with no page. This really happened — one session with 459
  // observations was left behind.
  //
  // So this sweeper depends on no event at all. While DSH is alive it reads the
  // store and finalizes sessions that are clearly already dead.
  //
  // WHY IT MUST BE CAREFUL
  // Finalizing a session that is STILL ALIVE produces a page from half the
  // content, and after the session continues its status stays `closed` — that
  // page is never updated again. Getting this wrong means a permanently stale
  // page, so four guards must all pass:
  //
  //   1. the session is not in this process's live-session list;
  //   2. its last observation is older than SWEEP_MIN_IDLE_MS;
  //   3. its UUID is version 5 — main sessions only, never child agents;
  //   4. at most SWEEP_MAX_PER_RUN per round.
  //
  // Guard 2 exists because the live-session list only covers this process. If
  // another DSH window (a separate node process) is using the same folder, its
  // session is invisible to us and would otherwise be closed wrongly.
  //
  // Guard 3 has a useful side effect: ai-memory's OWN Claude Code sessions are
  // stored as version-4 UUIDs, so running DSH alongside a real Claude Code
  // session in the same repo can never cause one of those to be closed here.
  function sweepAbandoned() {
    let sqlite;
    try {
      // getBuiltinModule rather than `import`: this is a permanent module and a
      // static experimental import is not needed here.
      sqlite = process.getBuiltinModule('node:sqlite');
    } catch (e) {
      console.log(LOG + 'sweeper skipped: node:sqlite is not available');
      return;
    }
    if (!sqlite || typeof sqlite.DatabaseSync !== 'function') {
      console.log(LOG + 'sweeper skipped: DatabaseSync is missing');
      return;
    }

    let rows;
    try {
      const db = new sqlite.DatabaseSync(config.binPath, { readOnly: true });
      try {
        rows = db.prepare(
          'SELECT s.id AS sid, s.cwd AS cwd, p.name AS project, ' +
          '(SELECT MAX(o.created_at) FROM observations o WHERE o.session_id = s.id) AS last_at, ' +
          '(SELECT COUNT(*) FROM observations o WHERE o.session_id = s.id) AS obs ' +
          'FROM sessions s JOIN projects p ON p.id = s.project_id ' +
          'WHERE s.ended_at IS NULL'
        ).all();
      } finally {
        db.close();
      }
    } catch (e) {
      // PARTIAL failure only: the fast path uses no SQL and keeps working. This
      // is the most likely thing to break if ai-memory ever changes its schema.
      console.log(LOG + 'sweeper could not read the store: ' + String((e && e.message) || e));
      return;
    }

    const nowMs = Date.now();
    const candidates = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const uuid = blobToUuid(r.sid);
      if (uuid.length === 0) continue;

      // Guard 1: sessions live in this process are not touched.
      let live = false;
      try {
        const all = ctx.sessions.list();
        for (let k = 0; k < all.length; k++) {
          if (sessionIdToUuid(String(all[k].id)) === uuid) { live = true; break; }
        }
      } catch (e) {
        live = true; // unsure -> treat as live, staying silent is safer
      }
      if (live) continue;

      // Guard 3: main sessions only.
      //   main session : DSH id `session-<uuid>` -> uuid5 -> version 5
      //   child agent  : bare `<uuid>`           -> as is   -> version 4
      if (uuid.charAt(14) !== '5') continue;

      // Guard 2: must have been idle long enough.
      const lastAt = r.last_at === null || r.last_at === undefined ? 0 : Number(r.last_at);
      // created_at is stored in microseconds (1e6 per second).
      const idleMs = lastAt > 0 ? nowMs - (lastAt / 1000) : Infinity;
      if (idleMs < SWEEP_MIN_IDLE_MS) continue;

      candidates.push({
        uuid: uuid,
        project: r.project ? String(r.project) : '',
        cwd: r.cwd ? String(r.cwd) : '',
        obs: Number(r.obs) || 0,
        idleMin: Math.round(idleMs / 60000),
      });
    }

    if (candidates.length === 0) {
      console.log(LOG + 'sweeper: no abandoned sessions');
      return;
    }

    candidates.sort(function (a, b) { return b.obs - a.obs; });
    const batch = candidates.slice(0, SWEEP_MAX_PER_RUN);
    console.log(
      LOG + 'sweeper: ' + candidates.length + ' abandoned session(s) found' +
      (candidates.length > batch.length ? ', processing ' + batch.length + ' now' : '')
    );
    for (let i = 0; i < batch.length; i++) {
      const c = batch[i];
      console.log(
        LOG + 'sweeper -> ' + c.uuid.slice(0, 8) +
        ' | project=' + c.project + ' | obs=' + c.obs + ' | idle=' + c.idleMin + ' min'
      );
      // An abandoned session has no agent left, so its cwd cannot be asked for.
      // Store the project here so `pump` uses the explicit `--project` path
      // rather than guessing from the cwd basename.
      sweepProjects.set(c.uuid, { project: c.project, workdir: c.cwd });
      queue.push(c.uuid);
    }
    pump();
  }

  if (config.sweep) {
    // Chained `setTimeout`, not `setInterval`, because the delay changes each
    // round. Everything is cancelled through `ctx.effect` when the plugin is
    // disposed.
    try {
      ctx.effect(function () {
        let step = 0;
        let cancelled = false;

        function scheduleNext() {
          if (cancelled) return;
          const delay = step < SWEEP_SCHEDULE_MS.length
            ? SWEEP_SCHEDULE_MS[step]
            : SWEEP_STEADY_MS;
          step++;
          const t = setTimeout(function () {
            sweepAbandoned();
            scheduleNext();
          }, delay);
          timerHandles.push(t);
        }

        scheduleNext();

        return function () {
          cancelled = true;
          for (let i = 0; i < timerHandles.length; i++) clearTimeout(timerHandles[i]);
          timerHandles.length = 0;
        };
      });
    } catch (e) {
      console.log(LOG + 'sweeper not scheduled: ' + String((e && e.message) || e));
    }
  }

  // ── Preflight: say out loud which ai-memory this is talking to ────────────
  //
  // Runs ONCE per DSH start, never per session, and costs ~200 ms. It exists
  // because "the plugin is loaded but nothing happens" is the hardest failure
  // for a new user to diagnose: the CLI can be pointed at a different data
  // directory or a dead server and every symptom looks the same.
  //
  // Never throws and never blocks; it only writes to the log.
  if (config.preflight) {
    const command = buildStatusCommand(config, platform);
    Promise.resolve()
      .then(function () {
        return ctx.shell.run(ctx.shell.resolve({ command: command, timeoutMs: 15000 }));
      })
      .then(function (result) {
        const out = outputOf(result);
        // stdout is pure JSON, but tolerate leading log noise.
        const start = out.indexOf('{');
        const end = out.lastIndexOf('}');
        if (start < 0 || end <= start) {
          console.log(LOG + 'preflight: the ai-memory server did not answer `status`. ' +
            'Without a running server this plugin cannot finalize any session.');
          return;
        }
        let info;
        try {
          info = JSON.parse(out.slice(start, end + 1));
        } catch (e) {
          console.log(LOG + 'preflight: could not parse the `status` output');
          return;
        }
        console.log(
          LOG + 'preflight: ai-memory v' + String(info.version) +
          ' | data_dir=' + String(info.data_dir) +
          ' | server=' + String(info.bind)
        );
        if (config.dataDir) {
          const normalise = (p) => String(p).replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '').toLowerCase();
          if (normalise(info.data_dir) !== normalise(config.dataDir)) {
            console.log(
              LOG + 'preflight: WARNING the active data_dir "' + String(info.data_dir) +
              '" differs from the configured "' + config.dataDir + '" — sessions will not be found.'
            );
          }
        }
      })
      .catch(function (e) {
        console.log(LOG + 'preflight failed: ' + String((e && e.message) || e));
      });
  }
}

export { name, inject, apply };
