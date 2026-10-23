import { parseArgs } from 'node:util';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { Engine, type EngineOptions } from '@trailerforge/engine';
import { createMcpServer, serveStdio } from '@trailerforge/mcp';
import { MediaError, probe } from '@trailerforge/media';
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
  tforge mcp [dir] [--repo-root <path>]...                Serve the project to Claude Code over MCP (stdio)
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
        duration: { type: 'string' },
        template: { type: 'string' },
        assume: { type: 'boolean', default: false },
        deep: { type: 'boolean', default: false },
        'allow-deep-scan': { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    io.err((err as Error).message);
    return 2;
  }
  const { values: o, positionals } = parsed;
  // `brief check`, `knowledge scan` and `storyboard generate` are two-word commands.
  const twoWord = ['brief', 'knowledge', 'storyboard'].includes(positionals[0] ?? '');
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
    autosaveMs: cmd === 'mcp' ? 2000 : 0,
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
    },
  };
  try {
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
