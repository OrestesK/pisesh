# pisesh

**English** | [한국어 (upstream translation)](https://github.com/Blue-B/pisesh/blob/main/docs/README.ko.md)

[![license](https://img.shields.io/github/license/OrestesK/pisesh?style=for-the-badge&color=blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A518-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![deps](https://img.shields.io/badge/dependencies-0-brightgreen?style=for-the-badge)](package.json)

**Bookmark, search, and resume [Pi](https://github.com/earendil-works/pi) and Oh My Pi (OMP) sessions with a fast keyboard-driven TUI.**

> `pi --resume` and `omp --resume` list every session you ever started. After a week that's 50+ entries, so you just scroll and hope. pisesh adds what was missing: ⭐ favorites, instant search, native OMP titles, and a `[NOW]` badge for the session you're attached to.

## Preview

<p align="center">
  <img src="assets/preview.png" alt="pisesh Favorites tab in a real Windows Terminal session" width="100%">
</p>

<p align="center"><sub>Real capture: ★ starred session at the top, the rest available behind the <b>Today</b>, <b>Here</b>, and <b>All</b> tabs. <code>Tab</code> cycles. <code>f</code> stars. <code>Enter</code> resumes.</sub></p>

## Terminal walkthrough

What the TUI looks like, screen by screen. The data below is made up, not real sessions.

**Main list.** The highlighted row is the current selection, and `Tab` cycles through the tabs. The green `[NOW]` badge marks the pi session you launched from, and the cyan `✎` marks a session you renamed yourself. CJK titles stay column-aligned:

<p align="center"><img src="assets/screen-list.png" alt="pisesh main list, Favorites tab with Today / Here / All tabs, the NOW badge, and a renamed session" width="100%"></p>

**`e` renames a session.** The first user prompt makes a poor title for a thread you keep coming back to, so press `e` to set your own. It's saved as an override (the session jsonl is never touched) and the session gets a `✎` marker in the list:

<p align="center"><img src="assets/screen-rename.png" alt="pisesh edit-name panel for setting a custom display title" width="100%"></p>

**`p` re-points the working directory** through an arrow-key directory browser. This is the cwd pi actually `cd`s into on resume, and it's also what the `Here` tab filters on. Press `s` to lock in the highlighted directory:

<p align="center"><img src="assets/screen-cwd.png" alt="pisesh cwd browser, an arrow-key directory picker for the resume and Here directory" width="100%"></p>

The **`Here` tab** shows only sessions whose effective cwd matches the directory you launched pisesh from. Inside a project you see just that project's threads, without scrolling past your home-dir scratch sessions.

## Why pisesh

Pi accumulates sessions across many working directories: your home, several project dirs, scratch tmux panes. The built-in resume picker is roughly alphabetical and forgets context. After a few weeks:

- You can't tell which session was "the one where you fixed the auth bug"
- You can't pin the 3-4 long-running threads you keep going back to
- You re-open the wrong session and pollute it with unrelated context
- You waste time searching by timestamp guessing

pisesh is a **zero-dependency Node CLI and Pi-compatible extension** that gives you everything `pi --resume` doesn't.

### Value at a glance

| Need                                       | What you get                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| Mark important sessions                    | ⭐ Star/unstar with one keystroke; favorites persist to one global JSON       |
| Give a thread a real name                  | `e` sets one manually; `g` generates one with a model you choose             |
| See only the current project's sessions    | `Here` tab filters to sessions whose cwd matches where you launched pisesh   |
| Fix where a session resumes                | `p` opens an arrow-key directory browser; sets the cwd pi `cd`s into         |
| Find a session by what you said            | `/` searches id + project + first user prompt + custom title                 |
| Know which session you're attached to      | `[NOW]` badge on the live session (passed from pi via env var)               |
| Keep your terminal clean                   | Alt-screen buffer, so quitting puts your terminal back the way it was (like vim) |
| Read Korean / Chinese / Japanese prompts   | Display-width-aware truncation; columns never blow up on CJK                 |
| Open from anywhere                         | Run as standalone `pisesh` shell command, or `/sesh` inside pi               |
| Zero install pain                          | No build step, no native deps, runs on Node 18+ everywhere                   |
| Trust it with your history                 | favorites and overrides stay in sidecar JSON; session history changes only for orphan-call repair |

## Getting started

This fork's OMP support is available from the source on [OrestesK/pisesh `main`](https://github.com/OrestesK/pisesh/tree/main). The `pisesh` package on npm is the **upstream release**, not this fork: `pi install npm:pisesh` and `npm install -g pisesh` do not install this fork's OMP support.

### Get the fork from source

```bash
git clone https://github.com/OrestesK/pisesh.git
cd pisesh
npm link            # link this checkout's pisesh and ompsesh commands into your PATH
pisesh --help
ompsesh --help
```

If this repository is already checked out as an OMP config submodule, use that package directory instead of cloning again (for example, `cd ~/.config/omp/agent/packages/pisesh`), then run `npm link` there. No global link is needed to invoke the source directly from either directory: `node bin/pisesh` opens Pi sessions, and `node bin/pisesh --omp` opens OMP sessions. `ompsesh` is equivalent to `pisesh --omp`; `pisesh --backend=pi|omp` selects explicitly.

### Install the `/sesh` command in Pi

From the source package directory (standalone checkout or config submodule):

```bash
pi install .
```

This registers the local package as a Pi extension. Inside a Pi session, type `/sesh`. The extension runs its bundled CLI, so `npm link` is not required for the slash command.

`/sesh` does not start a second Pi process. The picker returns the selected session and options to the extension, which calls Pi's official `ctx.switchSession()` API. Standalone `pisesh` keeps its shell behavior and starts `pi --session`. Custom cwd overrides require a Pi version that supports `cwdOverride` on extension session switches; pisesh warns if Pi ignores one.

### Use with Oh My Pi (OMP)

With the source-linked CLI, run `ompsesh` (or `pisesh --omp`) to browse the active OMP profile's sessions. Without `npm link`, run `node bin/pisesh --omp` from the source package directory.

To add `/sesh` to OMP, append an entry for this package directory under the existing `extensions:` list in your OMP `config.yml` (for example, `~/.config/omp/agent/config.yml`). Use the package's absolute path, whether it is a standalone checkout or the config submodule at `~/.config/omp/agent/packages/pisesh`. Keep all other extension entries; do not replace the list with a single-package `omp config set extensions` command.

OMP loads the Pi-compatible extension through its compatibility layer. The picker uses OMP's active profile directory and native titles, switches sessions through OMP's `ctx.switchSession()`, and standalone resume launches `omp --resume`. It never applies Pi's JSON defaults or orphan-call transcript repair to OMP sessions.

While either standalone TUI is open, press `b` to switch between Pi and OMP without restarting pisesh. Each backend keeps its own favorites, metadata, and title-generation settings. The `/sesh` picker remains pinned to the Pi or OMP process that opened it.

The upstream npm release remains available for its own behavior, but it is not the installation path for this fork's OMP support.

## Keys

| Key                          | Action                                                       |
| ---------------------------- | ------------------------------------------------------------ |
| `↑` `↓` / `j` `k`            | move cursor                                                  |
| `Tab` / `h` / `l`            | switch tab (`★ Favorites` → `Today` → `Here` → `All`)         |
| `b`                           | switch between Pi and OMP (standalone TUI only)              |
| `f` / `Space`                | star / unstar the selected session                           |
| `x`                          | remove favorites whose session files no longer exist         |
| `Enter`                      | resume using Pi defaults or OMP's native session state         |
| `o`                          | resume using recorded state (equivalent to `Enter` for OMP)    |
| `e`                          | edit name: set a custom display title, shown with `✎` in the list |
| `g`                          | queue title generation with the saved model and effort; clear a manual title with `e` first |
| `G`                          | open title-generation settings to choose the saved model + effort |
| `p`                          | edit cwd with an arrow-key directory browser; sets the resume / `Here` dir |
| `d`                          | session details (full prompt, file, byte size, timestamps)   |
| `/`                          | search by id / project / first user prompt / custom title    |
| `Esc` / `q`                  | cancel generation or clear search first; press again to quit |
| `Ctrl-C`                     | cancel generation and quit immediately                       |
| `r`                          | rescan session files (after pi starts a new session)         |
| `c` (in details view)        | copy session id to clipboard (clip.exe / pbcopy / xclip)     |
| `Home` `End` `PgUp` `PgDn`   | jump to top / bottom / ±10                                   |

Title generation sends up to 16 KB of session text to the selected model provider and may incur provider charges. It excludes tool results and disables context files, skills, prompt templates, and tools.

## CLI (non-TUI) usage

For scripts and automation:

```bash
pisesh --list                  # Pi favorites
ompsesh --list                 # OMP favorites
pisesh --omp                   # open the OMP picker
pisesh --json                  # full favorites file as JSON
pisesh --star <partial-uuid>   # star a session from a script
pisesh --unstar <partial-uuid> # unstar
pisesh --clean-favorites       # remove favorites whose sessions are gone
pisesh --version               # print installed version
pisesh --help
```

### Optional handoff hook

Standalone resume accepts one exact `--handoff-hook=<absolute path>` token. The same executable can be configured with `PISESH_HANDOFF_HOOK`; an explicit CLI token wins, and a duplicate or invalid CLI token fails. Invalid environment configuration is warned about and disabled. `/sesh` accepts either empty raw arguments or one exact `--handoff-hook=<absolute path>` form; everything after the first `=` is path data, including spaces and option-like text. Quotes, shell escaping, and repeated options are not parsed.

After any required Pi-only repair and before standalone backend spawn, or after a committed `/sesh` session shutdown and before replacement extensions load, pisesh invokes the hook once and awaits it. The picker never invokes it. Same-session selections, cancellation, failed repair, and disabled configuration do not invoke it. A hook failure (launch, stdin, signal, or nonzero exit) produces one bounded warning and resume continues. There is deliberately no timeout, retry, response, or rollback; a trusted hook may delay handoff and its effects are not undone if the backend later fails.

The trusted executable receives inherited environment data and one JSON line on stdin, with no arguments and `shell: false`. Hook stdout is ignored:

```json
{"version":1,"event":"handoff","source":"cli","session":{"id":"...","path":"/absolute/session.jsonl","title":"...","cwd":"..."}}
```

`source` is `"cli"` for standalone pisesh and `"sesh"` for the slash command. `title` is pisesh's exact resolved title and `cwd` is the selected row's `effectiveCwd` metadata (override, recorded cwd, or the existing decoded-project-label/flat-directory fallback); it is not a guarantee of runtime process cwd. The payload excludes model, thinking, repair count, and backend details. This interface is backend-neutral: pisesh does not know or invoke tmux, Moshi, Zellij, naming templates, or adapters. Session path and title data may be sensitive, and the inherited environment may contain credentials, so configure only trusted local executables.

## Tech Stack

[![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/) [![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=000)](https://developer.mozilla.org/docs/Web/JavaScript) [![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![pi](https://img.shields.io/badge/pi--coding--agent-5C4EE5?style=for-the-badge)](https://github.com/earendil-works/pi)

| Area                | Details                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| Runtime             | Node.js ≥ 18 (uses only built-in modules: `fs`, `path`, `os`, `child_process`, `readline`)       |
| TUI rendering       | Raw ANSI escape sequences (no `blessed` / `ink` / `chalk` dependency)                            |
| Alt screen buffer   | `\x1b[?1049h` / `\x1b[?1049l`, the same primitive `vim`, `less`, `htop`, and droid CLI use         |
| Input               | Node's `readline.emitKeypressEvents` in raw mode                                                 |
| Width calculation   | UAX #11 East Asian Width ranges, compressed to ~10 inline range checks                           |
| Pi/OMP extension    | Pi-compatible TypeScript factory using `ui.custom`, `tui.stop`, and `ctx.switchSession()`          |
| Storage             | Separate favorites and override sidecars under the active Pi or OMP agent directory              |
| Session discovery   | Direct scan of the selected backend's session root; first 96 KB of each JSONL parsed             |
| Process model       | `/sesh` switches the current host; standalone launches `pi` or `omp --resume`                    |
| Resume settings     | Pi supports default/recorded choices; OMP restores its native session state                       |
| Custom paths        | Honors each backend's native agent, session, config, and profile environment variables           |
| Title generation    | Ephemeral `pi` or `omp --print --no-session` call using the selected model and effort            |

### What it explicitly does **not** depend on

- No `npm install` for the bundled CLI runtime; it's genuinely zero-dependency
- No native binaries / GPU / ffmpeg / database
- No telemetry or analytics; title generation contacts only the provider for the model you select
- No daemon / background process

## Storage

| What       | Pi default                                                  | OMP default                                                     |
| ---------- | ----------------------------------------------------------- | --------------------------------------------------------------- |
| Favorites  | `~/.pi/agent/favorites.json`                                | `~/.config/omp/agent/favorites.json`                             |
| Overrides  | `~/.pi/agent/pisesh-meta.json`                              | `~/.config/omp/agent/pisesh-meta.json`                           |
| Sessions   | `~/.pi/agent/sessions`                                      | active OMP profile's `agent/sessions`                            |

Pi accepts `PI_AGENT_DIR` / `PI_SESSION_DIR`; OMP accepts `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR`, `OMP_PROFILE` (or `PI_PROFILE`), and `PI_CONFIG_DIR`. Pi orphan-call repair may update a selected transcript with a one-time backup. OMP transcripts are never rewritten.
Favorites file shape:

```json
{
  "ids": [
    "019e79b9-d2c1-741f-81ea-1dcad9a2d712",
    "019e6355-9957-7a30-b4ce-b9db5e3c9ac6"
  ],
  "updated": "2026-05-31T01:33:21.234Z"
}
```

It's a single global file (not per-project). Back it up by syncing one file.

## CJK-aware rendering

Korean / Chinese / Japanese / fullwidth characters render **2 cells wide** in terminals; pisesh measures display width (not JavaScript code-unit length) when truncating and padding. Korean prompts never wrap, columns stay aligned, and the layout looks identical whether the prompt is `hello world` or `안녕하세요 세상`.

```text
✓ webapp          로그인 폼 만들고 인증 엔드포인트 연결…
✓ 가계부앱         이번 달 지출 분석 화면 설계…
✓ docs-site       시작하기 가이드 다시 작성…
```

(Previously: Korean prompts overflowed to a second line and broke the table.)

## Requirements

- **Node.js ≥ 18 on `PATH`** (the `/sesh` extension uses `node` to run its bundled CLI)
- A terminal with ANSI escape and alternate screen buffer support, which covers basically every modern emulator:
  - Windows: **Windows Terminal**, **WezTerm**, **Alacritty** ✅
  - macOS: **iTerm2**, **Terminal.app**, **WezTerm**, **Alacritty**, **Kitty** ✅
  - Linux: **GNOME Terminal**, **Konsole**, **xterm**, **Alacritty**, **Kitty** ✅
- [`pi`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) on `$PATH` when using standalone `pisesh`

## Contributing

```bash
git clone https://github.com/OrestesK/pisesh.git
cd pisesh
npm link
npm test        # node --check + smoke test
```

Branch from `main` with a short-lived `feature/<scope>` or `fix/<scope>`, then squash-merge back.
Commits: [Conventional Commits](https://www.conventionalcommits.org/) style (`feat:`, `fix:`, `docs:`, `chore:`).

Open a PR. The CI matrix runs on Ubuntu, macOS, and Windows across Node 18, 20, and 22.

## Support

If pisesh saves you context-switching time or just makes pi nicer to live in, supporting it directly accelerates development:

- Your support helps: bug fixes, new keybindings, more search modes, integration with other pi extensions.
- Transparency: I don't sell data; funds go to development time and a coffee or two.
- One-time sponsors are credited in README and release notes (opt-out available).
- Monthly sponsors ($3/mo via GitHub Sponsors) get best-effort priority triage for "Sponsor Request" issues.

[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-GitHub-EA4AAA?style=for-the-badge&logo=github-sponsors&logoColor=white)](https://github.com/sponsors/Blue-B) [![Buy Me A Coffee](https://img.shields.io/badge/One%E2%80%91time_$3-Buy_Me_A_Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=000)](https://buymeacoffee.com/beckycode7h) [![PayPal](https://img.shields.io/badge/Donate-PayPal-00457C?style=for-the-badge&logo=paypal&logoColor=white)](https://www.paypal.com/ncp/payment/ZEWFKDX595ESJ)

## Acknowledgments

- [pi-coding-agent](https://github.com/earendil-works/pi) by [@mariozechner](https://github.com/mariozechner), the agent and extension API that make `/sesh` possible.
- [interactive-shell example extension](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/interactive-shell.ts), the pattern reference for the `ui.custom` + `tui.stop` TTY handoff.
- Inspiration for the favorites + tabs UX: [droid CLI](https://github.com/factory-ai/droid) and tmux's [sesh](https://github.com/joshmedeski/sesh).

## Contributors

Thanks to everyone who helped make pisesh better 🙏

<a href="https://github.com/Blue-B"><img src="https://github.com/Blue-B.png?size=80" width="80" alt="Blue-B" title="Blue-B" /></a>
<a href="https://github.com/ahoereth"><img src="https://github.com/ahoereth.png?size=80" width="80" alt="ahoereth" title="ahoereth" /></a>

## License

MIT © [Blue-B](https://github.com/Blue-B). See [LICENSE](LICENSE).

The pi extension uses the `@earendil-works/pi-coding-agent` API; check pi's own license for that side. The CLI binary is pure Node and has no other licenses to worry about.
