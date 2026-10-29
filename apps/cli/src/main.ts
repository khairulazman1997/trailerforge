import { parseArgs } from 'node:util';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { Engine, type EngineOptions } from '@trailerforge/engine';
import { createMcpServer, serveStdio } from '@trailerforge/mcp';
import { MediaError, probe } from '@trailerforge/media';
import { DEFAULT_APP_PORT, startService } from '@trailerforge/service';
import { captureCommand } from './capture.js';
import { brandCommand, effectsCommand, sfxCommand, variantsCommand } from './graphics.js';
import {
  analyzeCommand,
  cutCommand,
  footageCommand,
  ingestCommand,
  matchCommand,
  rankTakesCommand,
} from './footage.js';
import {
  draftCommand,
  exportCommand,
  handoffCommand,
  presetsCommand,
  critiqueCommand,
  qcCommand,
  reviewCommand,
} from './render.js';
import { briefCheck, knowledgeScan, storyboardGenerate, type CmdCtx } from './m2.js';

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

const HELP = `tforge — TrailerForge command line

Usage:
  tforge new <dir> --name <name> [--type <videoTypeId>]   Create a project folder
  tforge info <dir>                                       Show a project summary
  tforge brief check <dir>                                Check the brief against its video type
  tforge knowledge scan <dir> [--repo <path>] [--force]   Scan a game repo into the knowledge base
  tforge storyboard generate <dir> [--duration <s>] [--template <id>] [--assume]
                                                          Generate the storyboard with the LLM
  tforge capture plan|status|export <dir> [--todo] [--format md,html,json] [--omit-excluded]
                                                          The recording checklist: show it, count progress, write the pack
  tforge capture mark <dir> <slotId> [--status recorded|approved|rejected|empty] [--note <text>] [--takes <n>] [--skip|--unskip]
  tforge capture settings <dir> [--set fps=30]... [--unset fps]... [--reset]
                                                          Show or change recording settings (resolution=WxH, fps, bitrate, codec, container, hud, hdr)
  tforge capture tips <dir> [--group <key>]... [--force] [--overwrite-edited]
                                                          Ask the LLM for tips and risks per group
  tforge ingest <dir> <file or folder>... [--wait]        Import recordings (folders are searched for video); --wait lets the background work finish
  tforge footage <dir>                                    The recordings, their warnings and progress
  tforge analyze <dir> [--wait]                           Local analysis of the recordings and the music
  tforge match <dir> [--accept] [--min certain|high|medium]
                                                          Suggest which shot each recording is; --accept attaches the confident ones (one undo step)
  tforge rank-takes <dir> [--overwrite-chosen]            Ask the AI which take to use (text only, never footage)
  tforge cut <dir> [--lead 0|1|2]                         Build the rough cut on the music (keeps locked tracks and hand edits)
  tforge variants list|defaults <dir>                     The versions (aspect ratio, length) derived from the master cut, and what each dropped
  tforge variants add <dir> --target <formatId> [--length <s>] [--name <text>] [--reframe crop|fill]
  tforge variants set <dir> <id> [--target <formatId>] [--length <s|none>] [--name <text>] [--reframe crop|fill]
  tforge variants override <dir> <id> --slot <slotId> [--drop|--keep] [--take <takeId>] [--focus x,y] [--length <s>] | --clear
  tforge variants remove <dir> <id>
  tforge brand show <dir>                                 The brand kit and its warnings (contrast, missing files)
  tforge brand set <dir> --set primary=#ff8800 --set title=0.12
                                                          Colours (background, text, primary, accent) and text sizes (title, heading, body, caption)
  tforge brand logo|font <dir> <file> [--role heading|body] [--family <name>] [--bold]
                                                          Copy a logo (SVG/PNG) or font (TTF/OTF) into the project
  tforge brand reset <dir>                                Forget the brand kit
  tforge effects                                          Installed transitions, effects, graphics templates and sounds
  tforge sfx show | tforge sfx folder <path|none>         Your folder of licensed or CC0 sound effects (nothing is uploaded)
  tforge presets                                          The export presets (YouTube, Steam, Vertical social, X, ProRes master)
  tforge critique <dir> [--version <id|master>] [--show]    Ask the AI for a critique of a version (text only); --show lists what would be sent
  tforge qc <dir> [--version <id|master>] [--override <check>=<reason>]...
                                                          The Quality Gate on a version's plan; exit 1 when it blocks an export
  tforge draft <dir> [--version <id|master>]              Render a 720p review draft (cached by content)
  tforge export <dir> [--version <id|master>] [--preset <id>] [--override <check>=<reason>]...
                                                          Render with the preset, check the file, deliver to exports/render (--preset saves the choice)
  tforge handoff <dir> [--version <id|master>] [--format fcpxml,otio,edl]
                                                          Files for an editor: FCPXML, OpenTimelineIO, EDL, with alpha clips for cards and captions
  tforge review list|comment|resolve|reopen|approve|revoke <dir> [<commentId>] [--version <id|master>] [--at <s>] [--text <t>] [--note <t>]
                                                          Comments on a version and approval (goes stale when the version changes)
  tforge mcp [dir] [--repo-root <path>]...                Serve the project to Claude Code over MCP (stdio)
  tforge serve [--ui <dist>] [--port <n>] [--allow-origin <url>]...
                                                          Run the local engine service (and serve the built UI)
  tforge probe <file>                                     Inspect a media file
  tforge proxy <file> [--out <file>] [--height <px>]      Make an editing proxy (background job)
  tforge jobs [--status <status>]                         List background jobs
  tforge plugins                                          List plugins and their status

Options:
  --json         Machine-readable output
  --assume       storyboard generate: proceed despite a missing brief, logging assumptions
  --deep --allow-deep-scan
                 knowledge scan: also let Claude Code read the repo (sends file contents to Anthropic)
  --home <dir>   App data directory (default: $TFORGE_HOME or ~/.trailerforge)
  -h, --help     Show this help`;

/** Test seams: engine overrides (e.g. a mock LLM client) and the Claude Code binary. */
export interface MainExt {
  engine?: Partial<EngineOptions>;
  claudeBin?: string;
}

/** Exit codes: 0 ok, 1 operation failed (or `brief check` found gaps), 2 usage error. */
export async function main(
  argv: string[],
  io: Io,
  env: NodeJS.ProcessEnv = process.env,
  ext: MainExt = {},
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: 'boolean', default: false },
        home: { type: 'string' },
        name: { type: 'string' },
        type: { type: 'string' },
        out: { type: 'string' },
        height: { type: 'string' },
        status: { type: 'string' },
        repo: { type: 'string' },
        'repo-root': { type: 'string', multiple: true },
        port: { type: 'string' },
        ui: { type: 'string' },
        'allow-origin': { type: 'string', multiple: true },
        duration: { type: 'string' },
        template: { type: 'string' },
        assume: { type: 'boolean', default: false },
        deep: { type: 'boolean', default: false },
        'allow-deep-scan': { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
        format: { type: 'string' },
        'omit-excluded': { type: 'boolean', default: false },
        note: { type: 'string' },
        takes: { type: 'string' },
        skip: { type: 'boolean', default: false },
        unskip: { type: 'boolean', default: false },
        group: { type: 'string', multiple: true },
        'overwrite-edited': { type: 'boolean', default: false },
        set: { type: 'string', multiple: true },
        unset: { type: 'string', multiple: true },
        reset: { type: 'boolean', default: false },
        wait: { type: 'boolean', default: false },
        accept: { type: 'boolean', default: false },
        min: { type: 'string' },
        lead: { type: 'string' },
        'overwrite-chosen': { type: 'boolean', default: false },
        show: { type: 'boolean', default: false },
        target: { type: 'string' },
        length: { type: 'string' },
        reframe: { type: 'string' },
        slot: { type: 'string' },
        drop: { type: 'boolean', default: false },
        keep: { type: 'boolean', default: false },
        take: { type: 'string' },
        focus: { type: 'string' },
        clear: { type: 'boolean', default: false },
        role: { type: 'string' },
        family: { type: 'string' },
        bold: { type: 'boolean', default: false },
        version: { type: 'string' },
        preset: { type: 'string' },
        override: { type: 'string', multiple: true },
        at: { type: 'string' },
        text: { type: 'string' },
        todo: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    io.err((err as Error).message);
    return 2;
  }
  const { values: o, positionals } = parsed;
  // `brief check`, `knowledge scan`, `storyboard generate` and `capture <sub>` are two-word commands.
  const twoWord = [
    'brief',
    'knowledge',
    'storyboard',
    'capture',
    'variants',
    'brand',
    'sfx',
    'review',
  ].includes(positionals[0] ?? '');
  const cmd = twoWord ? `${positionals[0]} ${positionals[1] ?? ''}`.trim() : positionals[0];
  const arg = positionals[twoWord ? 2 : 1];
  if (o.help || !cmd) {
    io.out(HELP);
    return o.help ? 0 : 2;
  }
  const emit = (human: string, data: unknown) =>
    io.out(o.json ? JSON.stringify(data, null, 2) : human);
  const need = (value: string | undefined, what: string): value is string => {
    if (value) return true;
    io.err(`missing ${what}; see tforge --help`);
    return false;
  };

  if (cmd === 'probe') {
    if (!need(arg, '<file>')) return 2;
    try {
      const info = await probe(resolve(arg));
      const v = info.video[0];
      const a = info.audio[0];
      emit(
        [
          `${basename(arg)}: ${info.container}, ${info.duration.toFixed(2)} s, ${(info.sizeBytes / 1024 ** 2).toFixed(1)} MB`,
          v
            ? `  video: ${v.codec} ${v.width}x${v.height} @ ${(v.frameRate.num / v.frameRate.den).toFixed(3)} fps${v.variableFrameRate ? ' (VFR)' : ''}${v.rotation ? `, rotated ${v.rotation}°` : ''}, ${v.bitDepth ?? '?'}-bit${v.hdr ? ', HDR' : ''}`
            : '  video: none',
          a ? `  audio: ${a.codec} ${a.sampleRate} Hz, ${a.channels} ch` : '  audio: none',
        ].join('\n'),
        info,
      );
      return 0;
    } catch (err) {
      io.err(err instanceof MediaError ? `${err.code}: ${err.message}` : String(err));
      return 1;
    }
  }

  const engine = await Engine.start({
    ...(o.home ? { home: o.home } : env.TFORGE_HOME ? { home: env.TFORGE_HOME } : {}),
    // One-shot commands save on exit; the long-running MCP server also saves in the background.
    autosaveMs: cmd === 'mcp' || cmd === 'serve' ? 2000 : 0,
    approveSend: ({ task, provider }) => {
      io.err(`Sending "${task}" to ${provider.name}: the brief and game facts leave this machine.`);
      return true;
    },
    ...ext.engine,
  });
  const ctx: CmdCtx = {
    engine,
    io,
    emit,
    claudeBin: ext.claudeBin,
    flags: {
      json: o.json,
      repo: o.repo,
      duration: o.duration,
      template: o.template,
      assume: o.assume,
      deep: o.deep,
      allowDeepScan: o['allow-deep-scan'],
      force: o.force,
      format: o.format,
      omitExcluded: o['omit-excluded'],
      note: o.note,
      takes: o.takes,
      status: o.status,
      skip: o.skip,
      unskip: o.unskip,
      group: o.group ?? [],
      overwriteEdited: o['overwrite-edited'],
      set: o.set ?? [],
      unset: o.unset ?? [],
      reset: o.reset,
      todo: o.todo,
      wait: o.wait,
      accept: o.accept,
      min: o.min,
      lead: o.lead,
      overwriteChosen: o['overwrite-chosen'],
      show: o.show,
      target: o.target,
      length: o.length,
      name: o.name,
      reframe: o.reframe === 'crop' || o.reframe === 'fill' ? o.reframe : undefined,
      slot: o.slot,
      drop: o.drop,
      keep: o.keep,
      take: o.take,
      focus: o.focus,
      clear: o.clear,
      role: o.role === 'heading' || o.role === 'body' ? o.role : undefined,
      family: o.family,
      bold: o.bold,
      version: o.version,
      preset: o.preset,
      override: o.override ?? [],
      at: o.at,
      text: o.text,
    },
  };
  try {
    if (cmd === 'serve') {
      const port = o.port === undefined ? 0 : Number(o.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        io.err(`--port must be 0-65535, got "${o.port}"`);
        return 2;
      }
      const svc = await startService({
        engine,
        ...(o.port === undefined ? { preferredPort: DEFAULT_APP_PORT } : { port }),
        allowedOrigins: o['allow-origin'] ?? [],
        ...(process.argv[1] ? { cliPath: resolve(process.argv[1]) } : {}),
        ...(o.ui ? { staticDir: resolve(o.ui) } : {}),
      });
      // The token goes after a `#` so it never reaches any server or log.
      const open = o.ui ? `${svc.url}/#token=${svc.token}` : undefined;
      const devOrigin = o['allow-origin']?.[0];
      const dev = devOrigin
        ? `${devOrigin}/#svc=${encodeURIComponent(svc.url)}&token=${svc.token}`
        : undefined;
      emit(
        [
          `TrailerForge service on ${svc.url}`,
          ...(open ? [`Open the UI: ${open}`] : []),
          ...(dev ? [`Dev UI:      ${dev}`] : []),
          `token: ${svc.token}`,
        ].join('\n'),
        { url: svc.url, token: svc.token, ...(open ? { open } : {}), ...(dev ? { dev } : {}) },
      );
      await new Promise<void>((done) => {
        process.once('SIGINT', done);
        process.once('SIGTERM', done);
      });
      await svc.close();
      return 0;
    }
    if (cmd === 'mcp') {
      // stdout is the protocol channel: nothing else may print there.
      await serveStdio(
        createMcpServer({
          engine,
          ...(arg ? { defaultProject: resolve(arg) } : {}),
          repoRoots: o['repo-root'] ?? [],
        }),
      );
      return 0;
    }
    switch (cmd) {
      // `return await`, not `return`: the finally block must not close the engine mid-command.
      case 'brief check':
        return need(arg, '<dir>') ? await briefCheck(ctx, arg) : 2;
      case 'knowledge scan':
        return need(arg, '<dir>') ? await knowledgeScan(ctx, arg) : 2;
      case 'capture plan':
      case 'capture status':
      case 'capture settings':
      case 'capture mark':
      case 'capture tips':
      case 'capture export':
        return need(arg, '<dir>')
          ? await captureCommand(ctx, cmd.split(' ')[1], arg, positionals[3])
          : 2;
      case 'ingest':
        return need(arg, '<dir>') && need(positionals[2], '<file or folder>')
          ? await ingestCommand(ctx, arg, positionals.slice(2))
          : 2;
      case 'variants list':
      case 'variants defaults':
      case 'variants add':
      case 'variants set':
      case 'variants override':
      case 'variants remove':
        return need(arg, '<dir>')
          ? await variantsCommand(ctx, cmd.split(' ')[1]!, arg, positionals[3])
          : 2;
      case 'brand show':
      case 'brand set':
      case 'brand logo':
      case 'brand font':
      case 'brand reset':
        return need(arg, '<dir>')
          ? await brandCommand(ctx, cmd.split(' ')[1]!, arg, positionals[3])
          : 2;
      case 'effects':
        return await effectsCommand(ctx);
      case 'sfx show':
      case 'sfx folder':
        return await sfxCommand(ctx, cmd.split(' ')[1]!, arg);
      case 'footage':
        return need(arg, '<dir>') ? await footageCommand(ctx, arg) : 2;
      case 'analyze':
        return need(arg, '<dir>') ? await analyzeCommand(ctx, arg) : 2;
      case 'match':
        return need(arg, '<dir>') ? await matchCommand(ctx, arg) : 2;
      case 'rank-takes':
        return need(arg, '<dir>') ? await rankTakesCommand(ctx, arg) : 2;
      case 'cut':
        return need(arg, '<dir>') ? await cutCommand(ctx, arg) : 2;
      case 'presets':
        return await presetsCommand(ctx);
      case 'critique':
        return need(arg, '<dir>') ? await critiqueCommand(ctx, arg) : 2;
      case 'qc':
        return need(arg, '<dir>') ? await qcCommand(ctx, arg) : 2;
      case 'draft':
        return need(arg, '<dir>') ? await draftCommand(ctx, arg) : 2;
      case 'export':
        return need(arg, '<dir>') ? await exportCommand(ctx, arg) : 2;
      case 'handoff':
        return need(arg, '<dir>') ? await handoffCommand(ctx, arg) : 2;
      case 'review list':
      case 'review comment':
      case 'review resolve':
      case 'review reopen':
      case 'review approve':
      case 'review revoke':
        return need(arg, '<dir>')
          ? await reviewCommand(ctx, cmd.split(' ')[1]!, arg, positionals[3])
          : 2;
      case 'storyboard generate':
        return need(arg, '<dir>') ? await storyboardGenerate(ctx, arg) : 2;
      case 'new': {
        if (!need(arg, '<dir>') || !need(o.name, '--name')) return 2;
        const store = await engine.createProject(arg, {
          name: o.name,
          ...(o.type ? { brief: { videoTypeId: o.type } } : {}),
        });
        emit(`Created "${store.state.name}" (${store.state.id}) in ${store.paths.dir}`, {
          id: store.state.id,
          dir: store.paths.dir,
        });
        return 0;
      }
      case 'info': {
        if (!need(arg, '<dir>')) return 2;
        const store = await engine.openProject(arg);
        const p = store.state;
        const versions = await store.listVersions();
        const summary = {
          id: p.id,
          name: p.name,
          status: p.status,
          schemaVersion: p.schemaVersion,
          domainPack: p.domainPackId,
          videoType: p.brief.videoTypeId ?? null,
          formats: p.formatTargets.length,
          storyboardSlots: p.storyboard?.sections.reduce((n, s) => n + s.slots.length, 0) ?? 0,
          timelines: p.timelines.length,
          assets: p.assets.length,
          knowledgeEntities: p.knowledge.length,
          versions: versions.length,
          updatedAt: p.updatedAt,
        };
        emit(
          Object.entries(summary)
            .map(([k, v]) => `${k.padEnd(17)} ${v}`)
            .join('\n'),
          summary,
        );
        return 0;
      }
      case 'proxy': {
        if (!need(arg, '<file>')) return 2;
        const input = resolve(arg);
        const out = resolve(
          o.out ?? join(dirname(input), `${basename(input, extname(input))}.proxy.mp4`),
        );
        const id = engine.jobs.enqueue('core/media.proxy', {
          path: input,
          out,
          ...(o.height ? { height: Number(o.height) } : {}),
        });
        const job = await new Promise<NonNullable<ReturnType<typeof engine.jobs.get>>>((done) => {
          const check = () => {
            const j = engine.jobs.get(id);
            if (j && ['succeeded', 'failed', 'cancelled'].includes(j.status)) {
              off();
              done(j);
            }
          };
          const off = engine.jobs.subscribe(check);
          check();
        });
        if (job.status !== 'succeeded') {
          io.err(
            `proxy ${job.status}: ${job.error?.code ? `${job.error.code}: ` : ''}${job.error?.message ?? ''}`,
          );
          return 1;
        }
        emit(`Proxy written to ${out}`, { jobId: id, out });
        return 0;
      }
      case 'jobs': {
        const jobs = engine.jobs.list(o.status ? { status: o.status as 'queued' } : {});
        emit(
          jobs.length
            ? jobs
                .map(
                  (j) =>
                    `${j.id.slice(0, 8)}  ${j.type.padEnd(18)} ${j.status.padEnd(9)} ${(j.progress * 100).toFixed(0).padStart(3)}%  ${j.error?.message ?? ''}`,
                )
                .join('\n')
            : 'No jobs',
          jobs,
        );
        return 0;
      }
      case 'plugins': {
        emit(
          engine.pluginStatus
            .map((s) => `${s.id.padEnd(20)} ${s.state}${s.error ? `  (${s.error})` : ''}`)
            .join('\n'),
          engine.pluginStatus,
        );
        return 0;
      }
      default:
        io.err(`unknown command "${cmd}"; see tforge --help`);
        return 2;
    }
  } catch (err) {
    const e = err as Error & { issues?: { path: string; message: string }[] };
    io.err(`${e.name}: ${e.message}`);
    for (const i of e.issues ?? []) io.err(`  ${i.path}: ${i.message}`);
    return 1;
  } finally {
    await engine.close();
  }
}
