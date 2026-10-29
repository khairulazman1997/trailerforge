# TrailerForge

Local-first studio for game trailers and marketing videos: **brief → storyboard → capture guide → auto-cut → review → export**. You supply real gameplay footage and voice; TrailerForge does the structuring and the tedious cutting, on your computer.

> **Status:** Milestones 1–7 are built (see [docs/PLAN.md](docs/PLAN.md)). The Windows installer is built by a script but has not yet been installed and tried on a real Windows machine; the checklist for that is in [docs/NEXT_SESSION.md](docs/NEXT_SESSION.md).

## User guide

### Install

**Windows (installer).** Run `TrailerForge-Setup-<version>.exe`. It is not code-signed yet, so Windows SmartScreen warns: choose "More info", then "Run anyway". It installs for your user only, and you can choose the folder. You also need **FFmpeg** (a full build, with `ffprobe`) on your `PATH`, for example from [gyan.dev](https://www.gyan.dev/ffmpeg/builds/). The installer does not include it. The Python tools for music and footage analysis are set up from inside the app the first time you need them, after you agree (below). To build the installer yourself, see [Windows build](#windows-build).

**From source (any OS).** Install Node 22+, pnpm 10, FFmpeg and [uv](https://docs.astral.sh/uv/), then follow [From source and the command line](#from-source-and-the-command-line). The web UI then runs in your browser against a local service.

### First run

1. **Setup** (top bar) checks that this computer is ready. It looks at FFmpeg and the filters and encoders renders need, the analysis tools, free disk space, AI help and the optional vision model. Anything missing is named, with how to fix it. If the analysis tools are not set up yet, **Create the analysis environment…** downloads about 900 MB of Python packages through `uv`, once, after you agree.
2. **Try a demo** on the Projects page builds a small finished project in about half a minute: an invented game's recordings, music, storyboard, cut and two versions. Everything in it is made on your computer. Look around every tab, then export it.
3. **New project** when you are ready: give it a name and a folder. A project is a folder (`<name>.tforge`) with one `project.json` that holds your decisions, plus caches that are safe to delete.
4. **AI help (optional):** in **Settings**, add an Anthropic API key, use your Claude Code login, run a model on this computer with Ollama, or copy requests into any chat by hand (Chat Handoff). Every AI step shows what it will send, and to whom, before anything goes.

### The tabs

A project has one tab per step. Each tab says what it needs when an earlier step is missing, with a link to it. Every change is undoable (Ctrl+Z; press `?` for the keyboard shortcuts of the page you are on).

| Tab                | What you do there                                                                                                                                                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Overview**       | The project's name, folder and status at a glance; close the project.                                                                                                                                                                                                                                                                      |
| **Brief**          | Pick the video type and answer what it needs (game name, selling points, tone, platforms, call to action, output formats). A completeness meter shows what is left. "Suggest for me" drafts an answer for you to review. "Proceed with assumptions" lists each assumption it makes.                                                        |
| **Game knowledge** | Point it at your game's repo (read-only; secrets and ignored files are never read). It lists levels, bosses, characters, abilities, console commands and save files. Edit, add or remove entries, and mark any of them "keep out of AI requests".                                                                                          |
| **Storyboard**     | Generate a first draft from the brief and game facts, then edit it: sections and shots with lengths against the target, reorder by dragging, lock a section so nothing changes it, regenerate one section, and ask "Why?" about any generated choice. On-screen text lives here too.                                                       |
| **Capture**        | The recording checklist, grouped by where you record. It gives the recording settings to use, setup hints from your game knowledge, a shot code for each shot to put in file names, optional AI tips, and a printable capture pack.                                                                                                        |
| **Footage**        | Add recordings (paste a path, drop files, or Choose folder in the desktop app; or watch a folder in Settings). Read their warnings, match them to shots (shot codes match with certainty; the rest get suggestions with reasons), and pick or reject takes.                                                                                |
| **Cut**            | Choose and analyse the music, then build the rough cut on its beats. Preview it with the music. Edit by dragging clips and edges (Shift moves the clips after it along, Alt turns off snapping) or with the inspector (trim to a beat, swap a take, effects, transitions, sounds). Rebuilding keeps your edits and locked tracks.          |
| **Versions**       | Cut the master down to other formats and lengths (16:9, 9:16, 1:1…). Each shot says what happened to it and why. Tall and square versions follow the movement in each clip; click the frame to set the focus yourself.                                                                                                                     |
| **Brand**          | Colours (checked for contrast), a logo and fonts for titles, captions and labels.                                                                                                                                                                                                                                                          |
| **Graphics**       | Choose a template for each card and on-screen label, fill in its fields and see the frame in your brand. Text that is too long or too brief to read gets a warning.                                                                                                                                                                        |
| **Review**         | Per version: render a review draft in the background, leave comments at moments on a ruler, read the Quality Gate (what blocks an export, what needs a written reason, what is only worth a look), ask for an optional AI critique, and approve. An approval goes out of date when the picture or sound changes.                           |
| **Export**         | Choose a preset per version (YouTube, Steam, vertical, X, ProRes master), a file name and a loudness target. Export (a cancelled or crashed export resumes where it stopped), and write editor files: FCPXML for Final Cut Pro and DaVinci Resolve, OpenTimelineIO, and an EDL that most editors read. Files land in `<project>/exports/`. |

**Settings** holds AI providers and models, local models, watched folders, the optional AI vision model, and the connection for Claude Code (which can then work on the open project with you, through the same undoable commands). **Setup** is the health check above.

### Privacy: what leaves your computer

- **Never:** your footage, frames, sound, game source code, file names or paths. Rendering, analysis, matching, checking and review all run on your computer. Nothing is uploaded to any platform.
- **AI requests, only when you ask and only as text.** These cover brief suggestions, the storyboard, capture tips, take ranking and critique. Before a request goes, the app shows which provider gets it, whether that leaves your computer, and exactly what is sent. Game facts you mark "keep out of AI requests" are removed, and a request that would still name one is stopped before it leaves. Shots and takes go out as aliases (`shot-1`, `take-2`). With Ollama, requests go to this computer only.
- **Downloads, only after you agree.** These are the analysis tools (Python packages through `uv`, once) and the optional AI vision model (checked against a pinned checksum before it is kept).
- **One door, one log.** Every network request the app makes goes through a single service and is written to `<home>/logs/egress.jsonl` with its purpose, host and size. The log never holds the request's text. `<home>` is `%USERPROFILE%\.trailerforge` on Windows (`~/.trailerforge` elsewhere; `TFORGE_HOME` changes it).
- **Your keys:** an Anthropic API key is stored by the desktop app with the operating system's encryption (Windows DPAPI through Electron), or in an owner-only file when none is available. Settings says which.

The sections below go into each step in more detail, for the command line and for developers.

## From source and the command line

Requirements: **Node 22+**, **pnpm 10**, **FFmpeg + ffprobe** on `PATH` (or set `TFORGE_FFMPEG_DIR`), and **Python 3.11+ with [uv](https://docs.astral.sh/uv/)** for the analysis sidecar.

```bash
pnpm install
pnpm build
pnpm check          # typecheck, lint, format, TS tests, Python tests
```

Try the CLI:

```bash
node apps/cli/dist/bin.js new ./Ember.tforge --name "Ember Knight" --type game-trailer/release-trailer
node apps/cli/dist/bin.js info ./Ember.tforge
node apps/cli/dist/bin.js probe ./capture.mp4
node apps/cli/dist/bin.js proxy ./capture.mp4      # background job with progress, resumable
node apps/cli/dist/bin.js jobs
node apps/cli/dist/bin.js plugins
```

From a game repo to a storyboard (the LLM step uses `ANTHROPIC_API_KEY`, or falls back to your Claude Code login):

```bash
tforge knowledge scan ./Ember.tforge --repo ~/Games/EmberKnight   # read-only; secrets and ignored files are never read
tforge brief check ./Ember.tforge                                  # what the video type still needs (exit 1 if incomplete)
tforge storyboard generate ./Ember.tforge --duration 60 --assume   # --assume logs assumptions for missing fields
```

### Local engine service (for the UI)

```bash
tforge serve --allow-origin http://localhost:5173   # prints the URL and a fresh token
```

Loopback only, a new random token every launch (required on every request, including the event stream), Host and Origin checks against DNS rebinding and other web pages, JSON bodies with a size cap. Long operations (generate, regenerate, scan) run as cancellable tasks; edits to a project are refused while one runs on it.

### The UI (web mode)

```bash
pnpm --filter @trailerforge/ui build
node apps/cli/dist/bin.js serve --ui apps/ui/dist     # prints "Open the UI: http://127.0.0.1:<port>/#token=…"
```

Open that link in a browser. The Brief tab walks through what the video type needs (completeness meter, "Suggest for me" that you review before saving, "Proceed with assumptions" that lists every assumption so you can remove it). The token travels after the `#`, so it never reaches a server or log; the page reads it, removes it from the address bar, and keeps it for that tab only. For UI development run `pnpm --filter @trailerforge/ui dev` and start the service with `--allow-origin http://localhost:5173`; it prints a "Dev UI" link. Browser tests: `pnpm test:e2e` (set `TFORGE_CHROMIUM` to a Chromium executable if Playwright's own download is not installed).

The Game knowledge tab scans your repo (secrets and ignored files are never read), lists what it found with a per-entry "Exclude from AI" switch, lets you edit, add and remove entries, and offers the opt-in deep scan behind an explicit confirmation.

The Storyboard tab shows sections and slots with a length bar against the target. Edit titles and lengths in place, open a slot's details, add or delete shots, cards and sections, reorder with buttons or by dragging, lock sections so neither you nor the AI changes them, undo anything, and ask "Why?" to see the recorded reason behind each generated section.

Generating and rewriting show, before anything is sent, which AI provider will be used, whether that leaves your computer, and exactly what goes with the request (brief fields, game facts by name, and a count of the ones you excluded). Sending to another service needs a tick, remembered for that browser tab only. Every AI request goes out through the app's single network door: it is logged in `<home>/logs/egress.jsonl` with its purpose, host and size (never its text), may only go to the provider's own host (`api.anthropic.com`; a prompt handed to the Claude Code CLI is logged the same way), and is stopped before it leaves if your own words in it name a game fact you marked "keep out of AI requests".

**AI critique (optional):** `tforge critique <project> [--version <id|master>]` (or **Ask for a critique** on the Review tab, which first shows who gets it and exactly what is sent) asks the AI for at most ten notes on a version. It sends text only: your brief, the storyboard's words for each shot (as `shot-1`, `shot-2`…), numbers measured on the cut, and the Quality Gate's findings with ids, file names and paths removed; never footage, sound, or game facts you excluded. `--show` lists what would be sent. The notes appear on the Review tab as comments by the critique (one undo step; a new run replaces the old open notes). Some carry a suggested fix (a new shot length, or removing a shot); nothing is applied until you apply it, and each applied fix is one undo step.

**Fully offline:** with [Ollama](https://ollama.com) installed and a model pulled (`ollama pull qwen3:14b`), Settings → "AI on this computer" lists your models and "Use it for everything" routes every task to one of them. Requests go to `localhost` only (`OLLAMA_HOST` sets the address; anything but this machine is refused), so no game facts leave the computer. Local models are slower and less reliable than the hosted ones: expect to review and edit more.

#### Settings

The Settings page shows which AI providers are available and why not, takes an Anthropic API key (sent once to the local service, stored in an owner-only file under the home directory, never shown again; not encrypted, Electron will use the OS keychain), and edits which provider, model and effort each kind of request uses (saved to `llm.routes.json`, applied immediately). With the **Chat Handoff** provider, a dialog shows the request to copy into any chat and takes the reply back; an invalid reply produces a follow-up to paste into the same chat.

### First run and Setup

Open **Setup** (or run `tforge doctor`) to see whether this computer is ready: FFmpeg and the filters and encoders renders use (a missing one is named, with how to install a full build), the music and footage analysis tools, free disk space, AI help and the optional vision model. Checking only reads. If the analysis tools have not been set up, **Create the analysis environment…** shows what it downloads (about 900 MB of Python packages from PyPI, through `uv`, once), asks first, shows progress and can be cancelled; the step is written to the network log. A render that needs something this FFmpeg lacks stops before it starts and says which filter or encoder is missing.

### Try a demo

On the Projects page, **Try a demo** (or `tforge demo`) builds a small finished project in about half a minute: five recordings of an invented game, a 120 BPM music loop, a storyboard, a cut on the music and two versions (16:9 and 9:16) whose Quality Gate is clear, so you can look at every tab and export one. Everything is made on this computer (FFmpeg draws the footage, the music is generated in code) and nothing is downloaded or sent; building it twice gives the same recordings, cut and video. It needs only FFmpeg, not the analysis tools. Demo projects go in `<home>/demo-projects/`.

### Desktop app (Electron)

In the desktop app, **Browse…** buttons open the Windows file chooser to open a project, pick where a new one goes, link a game repo and add a watched folder. A web browser cannot learn where a chosen folder is, so there you type or paste the path.

`apps/desktop` runs the engine and service inside the app and opens a window on them. API keys are encrypted with the OS credential store (Electron `safeStorage`, kept in `secrets.safe.json`; when the OS offers no real encryption, including Linux's `basic_text` fallback, it uses the plain owner-only `secrets.json` and says so in Settings). The window can only show the local service (navigations and redirects elsewhere are blocked; other web links open in your browser), grants no device permissions, refuses `<webview>`, and its file pickers answer only that window. Quitting waits for the engine to save and release project locks. Run it on a desktop machine: `pnpm approve-builds` (allow `electron`), then `pnpm --filter @trailerforge/desktop start`. Packaging config is `apps/desktop/electron-builder.yml`. Not verified in the cloud container (no display); the main-process logic is tested with a fake host. Downloads (such as "Download Markdown" on the Capture tab) use Electron's own Save dialog.

### Drive a project from Claude Code (MCP)

Easiest: open **Settings → Claude Code** and press **Connect Claude Code**, then start a new Claude Code session. Claude Code then talks to the running app (MCP over HTTP at `http://127.0.0.1:47821/mcp`, its own token kept in `<home>/mcp-token`): it works on the project open in the window without being told the path, its edits appear in the window at once, and Undo covers them. Registering only touches the `trailerforge` entry in Claude Code's `~/.claude.json` (the file the `claude` command and the Claude desktop app both read), keeping a `.tforge-backup` copy. If the fixed port is taken, the app uses another and Settings says "Needs reconnecting". To use Claude Code while the app is closed, choose "Use the separate tool instead": Claude Code then starts its own copy (a project open in the app is locked for it). By hand, the separate tool is:

```bash
claude mcp add trailerforge -- node /path/to/trailerforge/apps/cli/dist/bin.js mcp ./Ember.tforge
```

Then ask Claude Code things like "show me the capture checklist", "show me the storyboard", "make the hook shot 3 seconds and add a capture note", or "regenerate the escalation section with more forest". It gets read tools (`project_summary`, `brief_get`, `knowledge_list`, `storyboard_get`, `decision_log`), `undo`/`redo`, `knowledge_scan`, `storyboard_generate`, `storyboard_regenerate_section`, the capture tools (`capture_plan`, `capture_status`, `capture_settings`, `capture_tips`, `capture_export`), and one tool per editing command (including `game-trailer_capture_set-status` and friends for ticking shots off). Every edit is validated, saved immediately and undoable, and locked sections refuse changes.

What the server deliberately will not do on its own: run the deep repo scan (it sends file contents to Anthropic, so it needs you at the CLI with `--allow-deep-scan`), or register a new game repo, unless you start it with `--repo-root <folder>` (repos under that folder are allowed). `storyboard_generate` sends the brief and non-excluded game facts to the configured LLM provider.

`knowledge scan --deep --allow-deep-scan` additionally lets Claude Code read a temporary copy of the repo's text files (no secrets, no ignored files); this sends file contents to Anthropic, so it is off unless you confirm it.

### Recording the footage (capture pack)

Once the storyboard is written, the **Capture** tab turns it into a recording checklist:

- **Grouped by where you record**: location, then setup, then the featured boss or character, so each level load and setup change happens once. Each shot says what to do, the framing, HUD on or off, and how long to record ("record 7 s" for a 2.5 s cut, so the edit has handles). Cards (title, end slate) are generated, so they are not on the list.
- **Tick shots off** as you record them, or set them to approved or "rejected, record again". Count takes, write notes, skip a shot you will not record, and reorder shots within a group (↑/↓ or drag). Everything is undoable and none of it changes the storyboard.
- **Recording settings** are worked out from the platforms in the brief, the video type, the shots' HUD needs and your output formats: resolution, frame rate, bitrate, codec, container, HUD and HDR. Change any value to override it (marked "Your override", with a reset). Warnings cover the usual ways a recording goes wrong: variable frame rate (Game Bar, GPU overlays, phone recorders), compressed console clips, 30 fps games, a capture smaller than the export.
- **Setup hints** come from your game knowledge: the level, the featured entities, and debug commands and save files. For a Unity project the scan finds console commands (`[ConsoleMethod]`, `[ConsoleCommand]`, `[Command]`, `[Cheat]`, `AddCommand(...)`) and where the game saves (`persistentDataPath` files, Easy Save, PlayerPrefs), with the Windows path. You can add your own as game facts tagged `debug-command` or `save-file` (add `all-levels` if they work everywhere).
- **Tips (optional, AI)**: a few tips and risks per group. You see which provider is used and what is sent first; your notes are never sent, and game facts you excluded are removed from the request (and the request is refused if any would slip through). Tips show "Out of date" when a group changes, and tips you edit are never replaced unless you say so.
- **Share the pack**: write `capture-pack.md` (a checklist), `capture-pack.html` (a self-contained printable page: no scripts, no network) and `capture-pack.json` (for the footage import in M4) to the project's `exports/capture/` folder, or save a copy through your browser's download (in the desktop app, its Save dialog). "Leave out anything about game facts I excluded" makes a copy safe to share.
- **Shot codes**: every shot has a short code such as `TF-K7QF2`, shown in the Capture tab and in the pack. Put it in the recording's file name (`TF-K7QF2 take2.mp4`; case and separators don't matter, OBS date stamps are fine) and the footage import (M4) matches the file to its shot.
- **AI vision for matching (opt-in)**: an optional CLIP-style model compares frames of your recordings with each shot's description, on your computer. It needs a one-time download that you agree to first, after being shown its size, source and licence (only MIT, Apache-2.0 or BSD models can be pinned); each file is checked against a pinned checksum before it is kept, and the request is logged in `<home>/logs/egress.jsonl`. After that it works offline; no footage, frames or project data are ever sent. Builds without a pinned model hide the option (maintainers: `pnpm --filter @trailerforge/analysis pin:vision` where huggingface.co is reachable).

### From recordings to a rough cut (M4)

1. **Name your recordings** with the shot code from the Capture tab or the pack (`TF-K7QF2 take2.mp4`). It is optional, but a coded file matches its shot with certainty.
2. **Add them** on the **Footage** tab: paste a folder or file path (in the desktop app, drop files or use Choose folder…). Recordings are referenced where they are, never copied, and the same recording is never added twice, whatever it is called. A recording still being written is retried for a few seconds, then reported. Small editing copies and a thumbnail are built in the background (under `<home>/library/cache/`, safe to delete).
3. **Check the warnings** each recording shows (variable frame rate, HDR, low resolution, several audio tracks...).
4. **Match recordings to shots**: coded files say "Shot code"; the rest get up to three suggestions with the reasons (recording order, length, the session they were recorded in, and AI vision once enabled). "Attach the N confident" does the sure ones in one undo step; choose the rest by hand. On the takes list, pick the take the cut uses, or reject a bad one. Optionally, `tforge rank-takes` asks the AI to choose between takes from text only.
5. **Choose the music** on the **Cut** tab (add the music file on the Footage tab first) and press **Analyse**: beats, bars and sections (librosa), and each recording's shot changes, black, flash and frozen frames (FFmpeg, PySceneDetect, OpenCV), all on this computer. Results are cached per recording in the project's `cache/analysis/` folder.
6. **Build the cut**: the storyboard is laid on the bars and beats, each shot cut a frame ahead of the beat from its best take at its cleanest, most active stretch, shots without footage stay visible as placeholders, cards go on their own track and the music fades out over the last bar. Every clip says why it was chosen.
7. **Edit**: select a clip to trim its start or end by a frame or to the next or previous beat, swap the take, empty it or delete it; lock a track to protect it. **Rebuild** keeps your edited clips and locked tracks and re-times the rest; Undo goes back. Preview plays the cut from the editing copies in time with the music, without rendering.

The same steps work from the command line: `tforge ingest <project> <files or folders> --wait`, `tforge footage <project>`, `tforge analyze <project> --wait`, `tforge match <project> [--accept]`, `tforge rank-takes <project>`, `tforge cut <project>`. Claude Code can drive steps 3–7 over MCP; it cannot add files (that stays your choice).

**What leaves your computer in M4:** nothing about your footage. Recordings, frames, file names and paths are never sent anywhere. The optional take ranking sends text only (the shot's words, your notes and measured numbers, with shots and takes as aliases and excluded game facts removed), and only after you agree when the provider is not local. The optional vision model is a one-time download you agree to; every network request is logged in `<home>/logs/egress.jsonl`. If the app is closed or crashes during analysis, the analysis process stops too.

### Versions and graphics (M5)

1. **Set the brand kit** on the **Brand** tab: background, text, primary and accent colours (each pair is checked for contrast), a logo (SVG or PNG; SVGs with scripts or internet links are refused) and up to one font each for headings and body text (TTF or OTF; without one, the bundled Inter is used). Type sizes are a share of the frame's shorter side, so a 9:16 version is not oversized. Files are copied into the project's `media/` folder by content hash.
2. **Make the versions** on the **Versions** tab: each format target (16:9, 9:16, 1:1...) without a version can get one at the master's length in one click, or use **Add a version**. Give a version a target length and it is cut down from the master: optional shots go first, then droppable ones, never the hook, the title or the call to action, and never a shot you kept by hand; each shot says what happened to it and why. For tall or square versions each clip is cropped to follow the movement in it (from the footage analysis); click the frame to set the focus by hand, or switch the version to a blurred fill.
3. **Style the cards and labels** on the **Graphics** tab: pick a template for each card and on-screen label, fill in its fields and see the frame with your brand colours. Text that is shrunk, shortened or on screen too briefly to read gets a warning. The preview uses Inter and no logo; the final frames use your fonts and logo.
4. **Add accents** in the Cut inspector: effects on a clip or card, the transition into a clip (a flash guard refuses more than three flashes in any second) and sound effects on a shot. The storyboard can suggest a few, picked only from what is installed; built-in sounds (whoosh, riser, impact, sub drop) are generated on this computer, and a folder of your own sounds can be set with `tforge sfx folder <folder>` (they are used where they are, never copied, and preferred over the generated ones). The music dips under each sound.

Versions are worked out from the master cut whenever they are needed and never stored, so the same project always gives the same version. Graphics frames are drawn with a pinned renderer and only the bundled and brand fonts, so every computer draws the same pixels; frames are cached by content in the project's `cache/frames/` (safe to delete) and a crash mid-render never leaves a broken frame.

From the command line: `tforge variants list|defaults|add|set|override|remove <project>` (for example `tforge variants override ./Ember.tforge var_tt --slot shot_parry --focus 0.6,0.5`), `tforge brand show|set|logo|font|reset <project>` (`--set primary=#f2aa4c`), `tforge effects` and `tforge sfx show|folder`. Claude Code can do the same over MCP except importing brand files.

**What leaves your computer in M5:** nothing new. The storyboard's accent suggestions are part of the same text request as before, limited to the ids of installed effects and templates; brand files, frames and sounds stay local.

### Review, render and export (M6)

1. **Review** on the **Review** tab: pick the master cut or a version, render a 720p review draft (it renders in the background, so you can keep editing; a hardware encoder is used for drafts when one works), leave comments at a time on the ruler, resolve them, and approve the version. An approval is tied to what the version renders to, not to the preset: comments do not touch it, but any edit that changes the picture or sound marks it out of date ("Approve again"), and undoing the edit brings it back.
2. **Quality Gate.** Every version is checked before it renders and the finished file again afterwards. Some findings always block (a placeholder or missing recording, a cut that flashes more than three times in a second, the wrong size or frame rate, clipping, a true peak over the ceiling); some need an override with a written reason (titles outside the safe area, loudness off target, black frames inside the picture, a stray flash frame, sound out of step with the picture), and the reason goes into the decision log; the rest are only worth a look (jump cuts, screen direction, pacing, off-beat cuts, read time, colour contrast). Each finding has a "go to" time.
3. **Export** on the **Export** tab: choose a preset per version (YouTube, Steam, vertical, X, or a ProRes master), a file name pattern (`{project}`, `{version}`, `{format}`, `{preset}`), a loudness target and a poster frame. Finals are encoded in software with pinned settings, so the same project gives the same bytes on the same FFmpeg build. Renders are cut into segments and survive a crash or a cancel: **Resume export** renders only what is missing. The file, a PNG poster and a `.export.json` record (hashes, Quality Gate findings, overrides) land in `<project>/exports/render/<version>/`.
4. **Hand it to an editor:** FCPXML 1.10 (Final Cut Pro, DaVinci Resolve), OpenTimelineIO and a CMX3600 EDL, with the cards and captions as ProRes 4444 clips with alpha, in `<project>/exports/handoff/<version>/`. Effects, gain changes, reframing and section markers that the formats cannot carry are written as markers.

From the command line: `tforge presets`, `tforge qc <project> --version <id|master>` (exits 1 when blocked), `tforge draft|export|handoff <project> --version <id>` (`--override core/loudness="reason"`, `--preset core/steam`), and `tforge review list|comment|resolve|reopen|approve|revoke <project>`. Claude Code can check, draft, export and hand off over MCP, but approving and overriding a Quality Gate finding are left to you.

**Where the same bytes are not promised:** hardware encoders (drafts only; the export record says `reproducible: false`), a different FFmpeg build (the record names the build, and a resumed render that finds another build starts over), and other operating systems' FFmpeg builds. The flash check measures changes over at least a quarter of the frame, as WCAG does, so a small flashing detail is not caught; a person should still watch the export before it is published.

**What leaves your computer in M6:** nothing. Rendering, checking, review and handoff are all local; nothing is uploaded to any platform.

The same from the command line:

```bash
tforge capture plan ./Ember.tforge            # the checklist (--todo for what is left)
tforge capture mark ./Ember.tforge shot_parry --status recorded --takes 2 --note "use take 2"
tforge capture settings ./Ember.tforge --set fps=30 --set resolution=2560x1440   # --unset fps, --reset
tforge capture tips ./Ember.tforge            # --group <key>, --force, --overwrite-edited
tforge capture export ./Ember.tforge --format md,html --omit-excluded
tforge capture status ./Ember.tforge --json
```

### Keyboard

Press `?` (or click **Shortcuts** in the top bar) for the keys of the page you are on: Ctrl/⌘+Z and Ctrl+Shift+Z or Ctrl+Y for undo and redo everywhere, and on the Cut tab the arrow keys to move the selected clip (Shift: to the next beat; Alt: with the clips after it). The first Tab stop is a "Skip to the page" link.

### Windows build

`pnpm --filter @trailerforge/desktop package` makes an unsigned Windows x64 installer (`apps/desktop/release/TrailerForge-Setup-<version>.exe`; build it on Windows). `package --dir` only unpacks to `release/win-unpacked`, which also works on Linux; `package:check` verifies the result. The installer carries the app, fonts, resvg's Windows binary, the analysis sidecar's source and a pinned uv, but not FFmpeg (install a full build) and not the Python environment: the Setup page builds that after you agree.

App data (job database, temp files, drop-in plugins) lives in `$TFORGE_HOME` (default `~/.trailerforge`).

## Architecture

```mermaid
flowchart TB
  subgraph shells[Shells]
    cli[apps/cli · tforge]
    ui[UI · Electron / web · M2]
    mcp[MCP server · M2]
  end
  engine[packages/engine<br/>wires everything]
  shells --> engine
  engine --> host[plugin-api<br/>PluginHost + registries]
  engine --> core[core<br/>ProjectStore · commands · undo · EventBus]
  engine --> jobs[jobs<br/>persistent queue · node:sqlite]
  engine --> llm[llm<br/>routing · providers · prompts]
  core --> schema[schema<br/>Zod schemas · migrations · flicks]
  host --> schema
  jobs -. job types .- host
  media[media<br/>FFmpeg · probe · Quality Gate] --> schema
  plugins[(Plugins<br/>core · game-trailer · third-party)] --> host
  plugins --> media
  py[workers/analysis<br/>Python sidecar · JSON-RPC] -. M4 .- media
  core --> disk[(MyGame.tforge/<br/>project.json · history/ · cache/ · logs/)]
```

### Packages

| Package                    | Responsibility                                                                                                                                                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@trailerforge/schema`     | Zod schemas for the project file (brief, storyboard, multi-track timeline, assets, knowledge, campaign fields), JSON Schema export, migrations, `parseProject()` (schema + cross-reference checks). Timeline time is integer **flicks**. |
| `@trailerforge/core`       | `ProjectStore`: atomic crash-safe saves, lock, commands applied via Immer with validation, undo/redo, autosave, version history. Typed `EventBus`.                                                                                       |
| `@trailerforge/jobs`       | Persistent job queue: concurrency limits, priorities, retries with backoff, timeouts, cancel, checkpoints, resume after crash.                                                                                                           |
| `@trailerforge/plugin-api` | The only surface plugins import: `definePlugin`, `PluginHost`, namespaced registries, contribution interfaces.                                                                                                                           |
| `@trailerforge/media`      | FFmpeg/ffprobe wrapper: capability detection (verified hardware encoders), probing, typed `MediaError`s, filtergraph builder, proxies/thumbnails/filmstrips, loudness, Quality Gate.                                                     |
| `@trailerforge/llm`        | Provider-agnostic structured output with validate-and-repair, editable prompt files, `llm.routes.json` routing, disclosure gate. Providers: Mock, Chat Handoff, Claude Code.                                                             |
| `@trailerforge/cut`        | Beat grid, layout, rough cut, merge over hand edits, captions, versions (`deriveVariant`) and reframing. Browser-safe.                                                                                                                   |
| `@trailerforge/graphics`   | Keyframe evaluator, text layout, the graphics template contract, built-in cards and overlays, deterministic SVG. Browser-safe.                                                                                                           |
| `@trailerforge/render`     | Graphics frames (pinned resvg, content-hash PNG cache) and resumable, crash-safe segment renders of whole versions; posters, alpha clips.                                                                                                |
| `@trailerforge/effects`    | Transitions and finishing effects as FFmpeg filter fragments, the photosensitivity guard, generated sound effects and their placement.                                                                                                   |
| `@trailerforge/compile`    | Render compiler: a timeline to one FFmpeg filtergraph and an exact audio mix with a `planHash`; export presets; FCPXML, OTIO and EDL handoff. Pure.                                                                                      |
| `@trailerforge/engine`     | Composition root plus the built-in `core` plugin.                                                                                                                                                                                        |
| `apps/cli`                 | `tforge` command line.                                                                                                                                                                                                                   |
| `workers/analysis`         | Python analysis sidecar (JSON-RPC over stdio).                                                                                                                                                                                           |

### Core rules

- **`project.json` is the single source of truth.** It changes only through typed commands, which are validated, undoable and recorded in history. Nothing reaches around the store.
- **Local-first.** Footage is referenced by path and hash, never uploaded. Any request that leaves the machine passes the disclosure gate.
- **Explainable.** Automated choices are logged to `logs/decisions.jsonl` with their reasons.
- **Deterministic.** Identical inputs produce identical filtergraphs and render plans.

## Writing a plugin

A plugin is a module that default-exports `definePlugin(...)`. Every id it registers must start with `<pluginId>/`.

```ts
import { definePlugin, PLUGIN_API_VERSION } from '@trailerforge/plugin-api';

export default definePlugin({
  id: 'devlog-pack',
  name: 'Devlog pack',
  version: '0.1.0',
  apiVersion: PLUGIN_API_VERSION,
  dependsOn: ['core'],
  register(ctx) {
    ctx.videoTypes.register({
      id: 'devlog-pack/devlog-teaser',
      name: 'Devlog teaser',
      requirements: [
        { field: 'title', label: 'Game name' },
        { field: 'keySellingPoints', label: "What's new", minItems: 2 },
      ],
      typicalDuration: { min: 15, max: 45 },
    });
    ctx.on('core/render.done', (e) => ctx.log('info', `rendered ${JSON.stringify(e)}`));
  },
});
```

Things a plugin can register: video types, storyboard templates, platform profiles, export presets, transitions, effects, analysis steps, knowledge extractors, motion renderers, LLM providers, UI panels, commands and job types. A plugin loads all-or-nothing: if `register` throws, everything it registered is rolled back and only that plugin is disabled.

**Installing a plugin:** put a folder containing `package.json` (with `main`) in `$TFORGE_HOME/plugins/`. `tforge plugins` shows its status. A full authoring guide and a "how to add a new video type" tutorial come with M7.

## License

TBD. Dependencies are chosen to stay compatible with closed-source distribution; FFmpeg is used from the user's installation.
