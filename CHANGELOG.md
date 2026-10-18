# Changelog

All notable changes to `dsh-ai-memory` are documented here.

This plugin bridges **DeepSeek Harness (DSH)** and **ai-memory**: when a DSH
session ends, it calls `ai-memory finalize-session` so the observations DSH
captured become searchable wiki pages.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Compatibility

Versions are tested against specific hosts. A plugin that loads and logs is not
proof it works — 1.0.1 did exactly that while finalizing nothing.

| Plugin | DSH Desktop | ai-memory | Notes |
|---|---|---|---|
| 1.2.1 | 0.2.1-rc.2 | 3.1.1 | Declares `dsh.engines` so the marketplace can gate incompatible hosts. Metadata only. |
| 1.2.0 | 0.2.1-rc.2 | 3.1.1 | Marketplace readiness: startup diagnosis when ai-memory or the capture hooks are missing. |
| 1.1.2 | 0.2.1-rc.2 | 3.1.1 | Compatibility re-verified against current hosts; no behaviour change. |
| 1.1.1 | 0.2.0-rc.2 | 2.5.2 | Makes the marker's `identity` actually work in the common case. |
| 1.1.0 | 0.2.0-rc.2 | 2.5.2 | Honours a marker's `identity`; re-finalizes a session that continued. **Its `identity` support never ran when the marker sits in the session's own folder** — see 1.1.1. |
| 1.0.5 | 0.2.0-rc.2 | 2.4.2 | Log line reads its version from `package.json`. |
| 1.0.4 | 0.2.0-rc.2 | 2.4.2 | Sessions opened in a subfolder finalize into the project root. **Its startup log says `active v1.0.3`** — see 1.0.5. |
| 1.0.3 | 0.1.7-rc.2 | 2.4.1 | Documentation only — no code change. |
| 1.0.2 | 0.1.7-rc.2 | 2.4.1 | Verified working. |
| 1.0.1 | 0.1.7-rc.2 | 2.4.1 | **Broken on current DSH** — see below. |
| 1.0.0 | ≤ 0.1.6 | 2.4.0 | Required `ctx.shell.run()`, removed in 0.1.7-rc.2. |

**DSH below 0.1.7-rc.2:** use 1.0.2 or later. The shell helper picks its calling
convention by capability (`typeof ctx.shell.execute`), not by version number, so
it works on both old and new hosts.

---

## [1.2.1] - 18 Oct 2026

Marketplace metadata only; the plugin's behaviour is unchanged from 1.2.0.

### Added

- **`dsh.engines`** in `package.json`: `dsh: ">=0.1.7-rc.2 <0.3.0"` and
  `node: ">=22.5.0"`. dsh-market reads an own `engines.dsh` range as the
  authoritative compatibility declaration, so the marketplace can now refuse an
  install on a host this plugin was never tested against instead of failing at
  runtime. The DSH floor is where `ctx.shell.execute()` replaced `run()`; the
  ceiling is the 0.2.x line this release was verified on. Node's floor is where
  `node:sqlite` (the sweeper's read-only store access) became available.

### Changed

- Repository description now states what the plugin actually does and that it
  ships the capture-hook template, so a marketplace listing reads correctly
  before the catalog entry is merged.

## [1.2.0] - 18 Oct 2026

Marketplace readiness: the plugin now tells a new user what is missing instead of
loading quietly and finalizing nothing. The finalize path itself is untouched.

### Added

- **A startup diagnosis for the two things this package cannot install.** At boot
  it checks that (a) the configured `ai-memory` binary exists, (b) its data
  directory with `config.toml` exists, and (c) the running DSH profile actually
  wires the capture hooks (`@deepseek-ai/dsh-hooks-claude-code` in the profile's
  or the home-level `cordis.patch.yml`). Each miss prints one concrete next step —
  the upstream install link, `ai-memory init`, or the absolute path to the
  shipped `docs/hooks-dsh.json` template. The third check covers the failure that
  matters most after a marketplace install: ai-memory installed, DSH hooks not
  wired, so no session is ever captured and there is nothing to finalize.
- The "server did not answer" line now also says how to start one.
- `harnessScope`, `hookWiringStatus` and `diagnoseEnvironment` are exported so the
  diagnosis is testable without a harness. `npm test` is now 16 checks, including
  the clean case (no output when everything is in place).

### Changed

- README gains "From the DSH marketplace": the two external prerequisites, and
  why the plugin refuses to write the profile patch itself — the desktop profile
  reloads that file live, and a second hooks row beside an existing one would
  capture every session twice.

### Not changed

- The finalize invocation, the event set, the sweeper and the uuid mapping are
  untouched since 1.1.1. This release only adds diagnosis and documentation.

## [1.1.2] - 18 Oct 2026

Compatibility re-verification against the hosts that actually run today.
**No behaviour change** — every code path is untouched; what changed is what is
proven, and the reference hook config that ships beside the plugin.

### Verified

- **DSH 0.2.1-rc.2**, read from the installed `app.asar`: `agent/created`,
  `agent/disposed` and `session/disposed` are still emitted by `dsh-agent` /
  `dsh-agent-loop`; `ctx.sessions.get().header` still carries `cwd`, `origin`
  and `delegationDepth`; and `ctx.shell` still exposes `execute()` only — the
  shape the existing capability branch already selects. The events the plugin
  listens to are therefore unchanged, not merely assumed.
- **ai-memory 3.1.1**, read from the v3.1.1 tag and exercised as a binary:
  `finalize-session` still takes `--agent`, `--workspace`, `--project`,
  `--session-id`, `--reopen` and `--json`, and still prints `Finalized …` on
  success and `No open … sessions matched …` when there is nothing to close —
  both strings are what this plugin classifies on. Session ids are still
  `uuid5(NAMESPACE_OID, native id)` (`crates/ai-memory-core/src/ids.rs:94`), the
  mapping `sessionIdToUuid` reproduces. `status --json` still reports `version`,
  `data_dir` and `bind`.
- **Store upgrade**: a copy of a 2.6-era store opened under 3.1.1 and migrated
  to schema **V83**; the sweeper's `SELECT` returned the same rows before and
  after. The plugin's direct-SQL safety net therefore survives the upgrade.
- **The sandbox workaround is still required.** On 0.2.1-rc.2 every child under
  `workspace-write` still dies `0xC0000142` while `read-only` runs, so the
  `danger-full-access` retry stays in place.

### Changed

- `docs/hooks-dsh.json` now matches what actually runs, and explains why:
  `PreToolUse` is included together with its measured cost and the note that it
  is the first thing to delete if latency hurts; the `hook-drain` chain on
  `Stop` is spelled out; the profile row is shown in its `insert:` form (a bare
  `- id:` row only overrides an existing loader); and the Windows sandbox
  failure is documented with the two working responses.
- README compatibility section refreshed, plus a new note on upgrading the
  **server** 2.x → 3.x: the store migrates cleanly, but 3.1.1 can refuse to
  start until its provider credential is re-authenticated
  (`ai-memory auth login openai-oauth`). That failure surfaces as a plugin
  failure, because finalize then cannot reach the server — worth knowing before
  blaming the plugin.

## [1.1.1] - 1 Oct 2026

### Fixed

- **The `identity` support added in 1.1.0 never ran in the common case.** The
  candidate that resolves a marker's `identity` to the project that owns it was
  placed inside the branch that runs only when the session's folder sits BELOW
  the marker root. But a marker that declares only `identity` **is** the root it
  sits in, so the session's own folder is that root — precisely the case the
  branch excludes. On any folder whose name differs from the identity's project,
  the plugin looked the session up under the folder name instead, got
  `No open ... sessions matched`, and left it to the sweeper.

  Found by running the **installed** plugin against a real identity with a real
  shell, not by the unit test: that test put the session in a subfolder, so it
  exercised the harder case and walked straight past the common one. There is a
  test for both shapes now, and the old code fails the new one.

  Behaviour for markers without `identity` is unchanged.

### Verified

- Feature suite **9/9** on the published source, 7/7 on the local variant (two
  assertions skipped there, with the reason printed). Against 1.1.0 the same
  suite scores **8/9** — the new assertion is the one that fails.
- Behaviour suite **19/19**; parity **SEPADAN** (18 units).

## [1.1.0] - 1 Oct 2026

Built against **ai-memory 2.5.2**. Two changes, both driven by that release.

### Added

- **A marker's `identity` is honoured.** ai-memory 2.5.0 gave every project an
  `identity` that is deliberately not its folder name (#708) and routes captures
  by it; `identity` in `.ai-memory.toml` outranks `project`, and a marker that
  declares only `identity` is valid.

  The plugin does not try to reproduce the naming rule — which name owns an
  identity is the SERVER's decision on first sighting, and guessing it is what
  caused the 1.0.4 bug. It reads the answer back out of `projects.identity`
  (migration V70) with one indexed lookup, and falls back to the folder name
  when there is no answer. Read-only; any failure is silent.

- **A session that continued after a finalize can be re-finalized.** ai-memory
  2.5.0 added `finalize-session --reopen` (#836). This matters for one concrete
  failure the plugin could otherwise cause and not repair: the **sweeper**
  closing a session it wrongly judged abandoned. Its page was then built from
  the first half, and because the session had ended, no later finalize could
  ever update it — everything the agent did afterwards was lost.

  `--reopen` is now used for exactly that case: once per session, only for a
  session this process already finalized, and only after a plain finalize
  answers `No open ... sessions matched`. Re-running with nothing new is a
  documented no-op, so the case where another harness ended the session is
  harmless.

### Changed

- **"Already finalized" is now a question about time, not a flag.** The guard
  that stops two events describing one session end from finalizing twice
  (Bug 1) was a set, which cannot tell "the second event of one end" from "a
  genuinely new end hours later". It is a timestamped map with a 60-second
  window, and only a finalize outside that window is allowed to reopen.

  Stated plainly: a session that ends twice inside those 60 seconds gets only
  the first finalize. The window is far wider than the millisecond race the
  guard exists for, and can be overridden with `AI_MEMORY_DEDUP_WINDOW_MS`.

### Verified

- New suite `uji-fitur-1.1.0.mjs`: **6/6** on the published source, **5/5** on
  the local variant (one assertion is skipped there, with the reason printed —
  that variant reads a fixed database path and cannot take an injected one).
  Against 1.0.5 the same suite scores **2/6**, which is how the new behaviour is
  shown to be what makes it pass.
- Existing behaviour suite **19/19**; parity between the variants **SEPADAN**
  (18 compared units).

## [1.0.5] - 1 Oct 2026

### Fixed

- **The startup log no longer reports a stale version.** `VERSION` was a
  hand-edited constant, and it fell behind `package.json` **twice** — first
  `active v1.0.0` while `package.json` said 1.0.2, then `active v1.0.3` while
  `package.json` said 1.0.4. Both times the only visible symptom was a log line
  that lied, which is exactly the question that line exists to answer: *which
  build is actually loaded?*

  The version is now read from the `package.json` shipped beside the module, so
  there is no number left that can go stale. If it cannot be read, the log says
  `active v?` rather than guessing.

  **Version 1.0.4 is functionally correct but announces itself as `v1.0.3`.** If
  you are on 1.0.4 and the log bothers you, this is the release that fixes it;
  there is no behavioural difference between the two.

### Verified

- `uji-label-versi.mjs` — the guard that caught this — now passes for the
  published repo. It imports the plugin, runs `apply()` against a mock context
  and compares the captured log line with `package.json`, so a computed version
  is checked for real rather than pattern-matched.
- Behaviour suite **19/19**, parity **SEPADAN** (17 units).

## [1.0.4] - 1 Oct 2026

### Fixed

- **A session opened in a subfolder is now finalized into its project's root.**
  ai-memory derives a session's project from its working directory, and a
  `.ai-memory.toml` marker pins the name only for the folder that HOLDS it —
  measured with `ai-memory doctor`: run from `C:\Code\Dsh\arsip-dump` it answers
  project `arsip-dump`, not `dsh`, while the workspace is still inherited from
  the ancestor marker.

  So a session started in `<project>\sub` was looked up under a project named
  `sub`, the CLI answered `No open ... sessions matched`, and the session was
  left to the sweeper instead of being summarized on the spot. The plugin now
  walks up from the session's directory to the nearest marker and tries that
  project FIRST, so the fast path succeeds the same way it does for a session
  opened at the root.

  The walk stops at a `.git` boundary, so a nested repository such as
  `ai-memory/plugin-publik` keeps its own project instead of being folded into
  its parent. A session whose folder is not inside a marker root behaves exactly
  as before — the previous behaviour is still in the candidate chain, so a
  session captured before this change (project = folder basename) finalizes too
  rather than being retried on every sweep.

  Nothing else changed: no new configuration, no new dependency, and the
  resolution is bounded and silent (any failure falls back to the old path).

### Verified

- Behaviour suite **19/19**, against the installed copy, the published source and
  the local variant. Three of those assertions are new and cover this case: with
  the previous code they fail (17/19), which is how the fix was confirmed to be
  the thing that makes them pass.
- Parity between the local and published variants: **SEPADAN** (17 compared
  units — the two new scope helpers included, so the rule cannot drift between
  them).

---

## [1.0.3] - 26 Sep 2026

**Documentation only. No code changed** — the shipped `index.mjs` is
byte-identical to 1.0.2 apart from the version constant. This release exists
because the README shown on the plugin directory carried two claims that were
wrong, and a reader could not tell.

### Fixed

- **A DSH version that does not exist was named as tested.** The README said
  "developed and tested against DSH Desktop 0.9.1". There is no DSH 0.9.1; the
  number had been read off an unrelated changelog bundled in `app.asar`. The
  real package is `@deepseek-ai/dsh-desktop` at **`0.1.7-rc.2`**, which is what
  the rest of the same README already said. Corrected, with a note recording the
  mistake rather than quietly overwriting it.

- **The ai-memory compatibility line was stale.** It claimed 2.4.0 after the
  author's own machine had moved to **2.4.1** and verified it. Now states 2.4.1,
  and summarises the two entries from that upstream release that actually matter
  here: CRLF pages loading without frontmatter, and session ids splitting on
  letter case.

- **The sample log output named old versions** (`active v1.0.2`,
  `preflight: ai-memory v2.4.0`), so a user grepping for their own version found
  nothing. Samples now match this release.

### Why this is a release and not just an edit

The README is the plugin's listing on the directory: it is what a prospective
user reads before installing, and it is served from npm. An edit that never
reaches the registry does not reach them. Versioning it is the only way to ship
a correction to text people are already being shown.

### Verification

- `node --check index.mjs` clean.
- **16/16** behaviour assertions still pass (unchanged code).
- Logic parity with the local build: 15 same, 0 different.

---

## [1.0.2] - 26 Sep 2026

### Fixed

- **Silent total failure on DSH 0.1.7-rc.2 (`ctx.shell` API change).**
  0.1.7-rc.2's PwshLocalExecutor exposes only `execute()`; `run()` is gone. The
  plugin called `run()` in two places, so every finalize died with
  `shell.run is not a function` — silently, because the failure only reaches the
  log. Both call sites now go through a single helper that accepts either shape,
  chosen by capability rather than by version number. This is why 1.0.1 loaded,
  logged its startup banner, and finalized **nothing**.

- **Sandbox runner dies with `0xC0000142` (`STATUS_DLL_INIT_FAILED`).** DSH
  launches its sandbox runner through Electron, and the confined child aborts
  during DLL initialisation. Measured with the same command and a correct SID:

  | Launched via | Result |
  |---|---|
  | `node.exe` + runner | `exit=0` |
  | `DeepSeek Harness.exe` + runner | `exit=3221225794` |

  A plugin's `ctx.shell` calls carry no session, so they take the broken default
  path. The plugin now tries the normal confined path **first** and falls back
  to `danger-full-access` **only** on `0xC0000142`, remembering the switch — so
  it re-locks itself automatically once DSH fixes its runner. No user action
  needed when that happens.

- **Vanished working directory killed the whole finalize chain.** A session whose
  `cwd` had been deleted failed with `spawn ...node.exe ENOENT` — ENOENT on the
  *executable*, though `node.exe` is present; the working directory is what is
  gone. `pump()` now clears a nonexistent `workdir`, and `runFinalize()` only
  sets it when the folder really exists.

- **`VERSION` drifted from `package.json`.** The log banner and the manifest
  disagreed. Both now read the same value.

### Added

- **Child environment passes `PATHEXT`.** Kept as belt-and-braces: `pwsh-local`
  merges the parent environment before spawning, so on a normal machine this is
  not the fix for any observed failure. A stripped environment does break the
  call outright (no `PATHEXT` → `exit=1 ResourceUnavailable`), so the guard
  stays.
- **README documents the two things a user cannot guess:** the deliberate
  `[dsh-ai-memory]` log prefix (it is not ai-memory's own log), and the
  permission trade-off of the sandbox fallback.

### Security

- The sandbox fallback **widens the plugin's CLI permissions outside the
  workspace**. This is a workaround, not a fix — the root cause is in DSH, whose
  `app.asar` is signed and cannot be patched from here. The fallback triggers
  only on `0xC0000142`, which means the confined path is already broken. Weigh it
  against what the plugin actually needs.

### Verification

- `node --check` clean.
- **16/16** behaviour assertions against the shipped file with a mock ctx,
  including self-tests that reintroduce each bug and require the test to fail.
- Logic parity with the local build: 15 same, 0 different.

---

## [1.0.1] - 24 Sep 2026

> **Do not use this version on DSH 0.1.7-rc.2.** It contains both bug fixes below
> but still calls `ctx.shell.run()`, which no longer exists there. It installed
> cleanly and finalized nothing. See 1.0.2.

### Fixed

Two real bugs, both found in the field rather than by reading code.

- **A session was finalized twice.** `agent/disposed` carries the id
  `session-<uuid>`, while `session/disposed` carries the bare stored UUID. The
  same session therefore entered the queue twice within milliseconds, through two
  different id *shapes*. Both were checked against `finalizedRecently` at
  *enqueue* time — when the first finalize has not finished and the set is still
  empty, so both passed. `pump()` did not re-check, so the CLI ran twice: ~2.2 s
  and one `ai-memory.exe` process wasted, the second call answering
  `No open claude-code sessions matched`.

  Observed in the log before the fix:

  ```
  04:41:18.237 finalizing session session-
  04:41:20.482 session -> page created
  04:41:20.482 finalizing session c37c3911   (SAME session, second call)
  04:41:22.665 session c37c3911 -> no open session matched
  ```

  Fixed by de-duplicating in `pump()` on the normalised UUID, so a duplicate is
  caught regardless of which event enqueued it.

- **Session labels in logs were the useless constant `"session-"`.**
  `id.slice(0, 8)` applied to a raw `session-<uuid>` id yields `"session-"`, so
  every session logged identically and the line told you nothing. Labels now come
  from `shortLabel()`, which strips the prefix first and therefore always shows
  the real UUID's first 8 characters.

### Verification

- A functional test drives the plugin with a stub ctx and sends two events for one
  session. Before the fix it made **3** `finalize-session` calls; after, **1**.
- Unit tests cover `shortLabel` for a raw id, a bare UUID, and an empty string
  (4/4).

### Note for the record

The first attempt at the duplicate-finalize fix was itself wrong: it guarded on
`!hinted`, but the fast path records a `sweepProjects` hint *and* enqueues, so the
duplicate always arrives as a hinted item and the check caught nothing. The
functional test caught that — not code review.

---

## [1.0.0] - 23 Sep 2026

### Added

- Initial release, published as `dsh-ai-memory-bridge` and renamed to
  `dsh-ai-memory` the same evening. Closes ai-memory's consolidation loop for
  DSH: on session end, calls `ai-memory finalize-session` so captured
  observations become searchable wiki pages.
- Skips subagents (only main sessions are finalized).
- Queues concurrent session ends instead of dropping them.
- Sweeps sessions abandoned by a forced restart.
- Handles both id shapes: `session-<uuid>` from `agent/disposed` and the bare
  stored UUID from `session/disposed`.
- `docs/` ships in the npm package so the README's hook example link resolves.

---

[1.0.2]: https://github.com/rasyidmmz/dsh-ai-memory/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/rasyidmmz/dsh-ai-memory/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/rasyidmmz/dsh-ai-memory/releases/tag/v1.0.0
