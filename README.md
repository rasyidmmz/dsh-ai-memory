# dsh-ai-memory

**Memory bridge between DeepSeek Harness and ai-memory.**

[ai-memory](https://github.com/akitaonrails/ai-memory) shares one memory across
20+ coding agents: Claude Code, Codex, Cursor, Gemini CLI, OpenCode, and more
all read and write the same wiki. DSH could only ever *read* it. This plugin
makes DSH a **full writer** too.

---

## What this is not

Read this first, because it decides whether this package is for you.

- **It is not ai-memory.** ai-memory is a separate project by a different
  author. This plugin does not contain it, does not bundle it, and does not
  replace it.
- **It is not a fork of ai-memory.** There is no shared code and no git
  relationship. ai-memory is written in Rust; this plugin is a single ~800-line
  JavaScript file that *calls* the `ai-memory` command-line program you install
  yourself. See [Credits](#credits).
- **It is not affiliated with, endorsed by, or supported by ai-memory's
  author.** It is an independent third-party integration.
- **It does not capture anything.** It only *finalizes* sessions that ai-memory
  has **already** captured. Capture comes from DSH hook wiring that you install
  separately — see [Prerequisites](#prerequisites).

## Credits

The memory engine this plugin drives is entirely the work of others:

> **[akitaonrails/ai-memory](https://github.com/akitaonrails/ai-memory)** — MIT
> licensed. One Rust binary that captures agent sessions through lifecycle
> hooks, consolidates them into a searchable Markdown wiki, and serves that
> memory to 20+ harnesses over MCP and HTTP.

**No ai-memory code is included here.** This repository contains zero lines
taken from that project. It is a DSH-side adapter that shells out to the
`ai-memory` binary, nothing more. If this plugin is useful to you, the credit
belongs upstream — please star their repository.

## Memory between harnesses

This is the point of the plugin, so it is worth stating precisely.

ai-memory is built on the idea that memory should follow *you*, not your editor.
Quit Claude Code mid-task, open Codex in the same directory, and the next agent
picks up a real handoff. That works because every harness writes into one shared
store, and session-end consolidation turns the raw record into readable wiki
pages the next agent can search.

DSH was the odd one out. ai-memory's consolidation is triggered by a **session
end** event, and DSH never fires one — its session-terminating path exits
through a signal that emits no disposal event at all. So DSH sessions landed in
ai-memory as raw observations and **stopped there**:

```
Claude Code session ends ──► consolidated ──► wiki page ──► readable by every harness
DSH session ends         ──► raw observations only ──► invisible to every harness
```

DSH could search the memory other agents wrote, but nothing DSH did ever became
memory the others could read. One-way, in the wrong direction.

This plugin closes that loop by firing the finalize step DSH never fires. With
it installed:

```
DSH session ends ──► this plugin ──► ai-memory finalize-session ──► wiki page
                                                                      │
              Claude Code, Codex, Cursor, Gemini CLI, … ◄────────────┘
```

A DSH session becomes a page that Claude Code can retrieve, that a teammate's
Codex can search, that shows up in the next agent's handoff brief. **DSH stops
being a read-only consumer of the shared memory and becomes a peer writer in
it.**

That is the whole value: not a new memory system, but one harness joining an
existing one properly.

## Prerequisites

Two things must already work. The plugin will not do either of them for you.

**1. A running ai-memory server with capture wired into DSH.**

Install ai-memory from [upstream](https://github.com/akitaonrails/ai-memory),
then wire DSH's lifecycle hooks so events are captured. ai-memory's own
`install-hooks` command does **not** support DSH (`--agent dsh` is rejected), so
the hook file is written by hand. A working example is in
[`docs/hooks-dsh.json`](docs/hooks-dsh.json).

Verify capture independently before blaming this plugin:

```sh
ai-memory status          # sessions and observations should be increasing
ai-memory doctor          # inside your project directory
```

**2. The `ai-memory` CLI on the same machine.**

That is all. It resolves its own data directory and server URL, so the default
configuration needs no settings at all.

If the server is not running, this plugin logs a clear warning at startup and
does nothing else. Capture failing is a separate problem with a separate cause.

## Install

```sh
dsh plugin --profile web add dsh-ai-memory
```

From GitHub instead of npm:

```sh
dsh plugin --profile web add github:rasyidmmz/dsh-ai-memory
```

Restart DSH afterwards. The loader imports plugin code without a cache-buster,
so an edited or newly added plugin is not picked up until the process restarts.

Confirm it loaded by searching the harness log for `ai-memory`:

```
[ai-memory] active v1.0.0 -- fast path session/disposed (zero idle cost) + ...
[ai-memory] preflight: ai-memory v2.4.0 | data_dir=... | server=127.0.0.1:49374
```

The preflight line is the fastest way to confirm the plugin found the same
ai-memory your hooks are writing to.

## Configuration

Optional. The defaults are correct for a standard ai-memory install, and the
plugin behaves identically with no `config:` block at all.

```yaml
- insert:
    - id: ai-memory
      name: dsh-ai-memory
      config:
        exePath: /usr/local/bin/ai-memory   # default: platform standard location
        dataDir: /home/me/.local/share/ai-memory  # default: let the CLI decide
        agentKind: claude-code              # default: claude-code
        sweep: true                         # default: true
        preflight: true                     # default: true
        timeoutMs: 120000                   # default: 120000
```

| Key | Default | Meaning |
|---|---|---|
| `exePath` | Windows: `%LOCALAPPDATA%\Programs\ai-memory\ai-memory.exe`; elsewhere: `ai-memory` from `PATH` | Path to the ai-memory executable. |
| `dataDir` | unset | ai-memory data directory. **Leave unset** unless you use a non-standard location; the CLI then resolves its own, which is what the hooks use. |
| `agentKind` | `claude-code` | The agent kind recorded in ai-memory's store. See the note below — this is not a free choice. |
| `sweep` | `true` | The abandoned-session safety net. Set `false` to disable it entirely. |
| `preflight` | `true` | Log one line at startup naming the ai-memory version, data directory, and server it found. |
| `timeoutMs` | `120000` | Per-`finalize-session` timeout. |

### Why `agentKind` should stay `claude-code`

ai-memory recognises a fixed set of agent kinds — `claude-code`, `codex`,
`cursor`, `open-code`, `opencode2`, `pi`, `omp`, `zero`, `kiro-cli`, `pool`,
`zcode` — and rejects anything else outright. There is no `dsh` kind.

DSH reaches ai-memory through the Claude Code hook bridge, so every captured DSH
session is stored as `claude-code`. That is simply what the store contains, and
`finalize-session` must be told to look there. Passing anything else — including
the CLI's own default, which is `codex` — will match no session ever.

## How it works

Two paths, deliberately asymmetric.

### Fast path — an event, costing nothing while idle

When a session closes cleanly, DSH fires `session/disposed`. The plugin listens,
derives the session's stored UUID, and calls `ai-memory finalize-session`.

- **Idle cost: zero.** No timer, no query, no process started.
- **Reaction: immediate**, not waiting for a scheduled sweep.

It uses `session/disposed` rather than the two events that fire alongside it
because it is the only one carrying the full session object, so the working
directory is read directly instead of being cached or guessed.

### Safety net — the tiered sweeper

DSH terminates through `SIGTERM`, and `SIGTERM` fires **no** disposal event at
all. A session open at that moment is never finalized: it stays open forever
with no page. This is not hypothetical — one session with 459 observations was
left behind that way.

So a sweeper exists that depends on no event: it reads ai-memory's store
directly and finalizes sessions that are provably dead. Its schedule is dense at
first and then eases off — 25s, 1 min, 3 min, 10 min, then every 30 min —
because the only case an event misses is a session abandoned by a restart, which
happens right when DSH starts.

Getting this wrong is worse than not doing it: finalizing a **live** session
produces a page from half its content, and that page is never updated again. So
four guards must all pass:

1. the session is not in this process's live-session list;
2. its last observation is more than 2 minutes old;
3. its UUID is version 5 — main sessions only, never subagents;
4. at most 10 sessions per sweep.

Guard 2 covers a second DSH window: that is a separate process, so its session
is invisible here, and without the delay it would be closed mid-write.

Guard 3 has a useful side effect worth knowing if you run DSH alongside real
Claude Code sessions in one repository: ai-memory stores those as version-4
UUIDs, so they can never be selected by this sweeper.

Set `sweep: false` to turn the whole net off; the fast path is unaffected.

### The seven traps this solves

Each of these broke an earlier version, and each fix is load-bearing. They are
worth listing because they are the reason a naive "just call finalize-session"
plugin does not work.

1. **The session id is not a raw UUID.** DSH ids look like `session-<uuid>` and
   ai-memory stores them as a derived UUID v5. Passing the raw string is
   rejected: `invalid uuid: invalid character: found 's' at 1`. Child agents use
   a bare UUID and must be passed *as is* — two id shapes, two treatments.
2. **The working directory must be explicit.** The shell service defaults to the
   DSH process's own directory, not the session's repository, so scope resolves
   to the wrong project.
3. **The project name is not always the folder's basename.** Hooks write it
   lowercased; the CLI derives it with original casing. Repositories without an
   `.ai-memory.toml` marker only match after a lowercase retry.
4. **No `2>&1`.** DSH runs commands with stderr unredirected, and collapsing it
   inside the command fails there, exiting non-zero having done nothing.
5. **Subagent detection must read the session header, not the registry.** The
   agent registry deletes an entry *before* announcing its disposal, so a
   registry lookup is always empty — including for the main session. An earlier
   version used it as a filter and therefore skipped every agent, doing nothing
   at all while logging no error.
6. **Concurrent session ends must queue, not drop.** Closing DSH with two
   sessions open fires two disposal events back to back; a naive `running` guard
   silently discards the second.
7. **`SIGTERM` fires nothing** — hence the sweeper above.

## Troubleshooting

All output is prefixed `[ai-memory]`. Search the harness log for it.

| Log line | Meaning | Action |
|---|---|---|
| `active v1.0.0 ...` | Plugin loaded | — |
| `preflight: ai-memory vX \| data_dir=...` | Found the server | Confirm the data directory matches your hooks |
| `WARNING: ai-memory executable not found` | Wrong `exePath` | Set `exePath` in config |
| `preflight: the ai-memory server did not answer` | Server not running | Start ai-memory |
| `session ... -> page created` | Working | — |
| `session ... -> no open session matched` | Already finalized, or never captured | Check `ai-memory status`; if observations are not rising, the **hooks** are the problem, not this plugin |
| `session ... FAILED` | The CLI returned an error | The message tail is included |
| `sweeper could not read the store` | ai-memory's schema changed | The fast path keeps working; only the safety net is down |
| `sweeper: no abandoned sessions` | Normal, most sweeps | — |

If nothing appears at all, the plugin is not loaded — check the profile's
`cordis.patch.yml` and restart DSH.

> **Note on `finalize-session` and consolidation.** This plugin calls
> `finalize-session`, which is a client of the running server. It does not
> invoke an LLM and does not write wiki pages itself; the server does that. If
> pages are not appearing, check the server's own logs.

## Compatibility

- **DSH**: developed and tested against DSH Desktop 0.9.1 (harness
  `0.1.5-rc.2`), Node 24.
- **ai-memory**: developed and tested against **2.4.0**. The
  `finalize-session` flags used here were verified present in that release.
- **Platforms**: Windows is the tested platform. Linux and macOS command
  construction is implemented and exercised, but not run end-to-end by the
  author — treat those as untested.
- **No dependencies.** No `dependencies`, no `peerDependencies`, so there is no
  build step and no `allowBuilds` approval on install.
- **No tools, no UI.** The plugin registers no model tools and draws no
  interface. It only listens and shells out.

### If ai-memory changes

The plugin reads ai-memory's SQLite store directly in **one** place, the
sweeper, and only to *find* abandoned sessions. If a future ai-memory release
changes that schema, the sweeper logs an error and stops; the fast path is
untouched because it uses no SQL at all. Set `sweep: false` to silence it
entirely in that case.

## License

MIT — see [LICENSE](LICENSE). This license covers **this plugin only**.
ai-memory is separately licensed (also MIT) by its own author.
