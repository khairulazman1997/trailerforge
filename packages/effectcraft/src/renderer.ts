import { createHash, randomUUID } from 'node:crypto';
import {
  copyFile,
  cp,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Scene } from '@trailerforge/graphics';
import type { MotionRenderJob, MotionRenderResult, MotionRenderer } from '@trailerforge/plugin-api';
import { FLICKS_PER_SECOND, flicksPerFrame, type Rate } from '@trailerforge/schema';
import { EffectCraftCli, EffectCraftError, type CliLocation } from './cli.js';
import { pinProblem } from './pin.js';
import { checkProjectFile, type ProjectHeader } from './project-file.js';
import { motionContentHash } from './motion-cache.js';
import { chunkCommands, sceneCommands, type EcCommand } from './scene-commands.js';

/** Renders a stored `.ecproj`: params `{ project: <absolute path>, comp?: <name> }`. */
export const PROJECT_TEMPLATE_ID = 'effectcraft/project';
/** Written last into a finished frame folder; the same name the built-in renderer uses. */
export const SEQUENCE_DONE = 'SEQUENCE_DONE';
const WORK_PREFIX = 'ec-';

export interface EffectCraftRendererOptions {
  /** The bundled CLI, or null when this build has none (then `available()` says why). */
  cli: CliLocation | null;
  /** Scratch space for runs; each run gets its own folder, removed when it ends. */
  workRoot: string;
  /**
   * Template id → `.ectemplate` file (the shipped templates). A bare path passes the job's params
   * as the template's values; `{ file, controls }` maps param names to control names and drops
   * params that have no control.
   */
  templates?: Record<
    string,
    | string
    | { file: string; controls?: Record<string, string>; size?: { width: number; height: number } }
  >;
  /** Why some shipped templates are not offered (missing or changed files), for the status view. */
  templateProblems?: string[];
  /** Per CLI call (default 10 minutes). */
  timeoutMs?: number;
}

export interface AuthoredProject {
  path: string;
  sha256: string;
  header: ProjectHeader;
  warnings: string[];
}

/**
 * EffectCraft as a `MotionRenderer` (plan M8): drives the pinned `effectcraft-cli` headless on
 * the CPU and returns transparent PNG frames, never video. Every run works in its own folder
 * under `workRoot` with an isolated config, and only a complete, checked frame folder reaches
 * `outDir`; cancelling kills the process and removes the run's files.
 */
export class EffectCraftRenderer implements MotionRenderer {
  readonly id = 'effectcraft/cli';
  readonly name = 'EffectCraft';
  private readonly cli: EffectCraftCli | null;
  private checked: Promise<{ ok: true; version: string } | { ok: false; reason: string }> | null =
    null;

  constructor(private readonly opts: EffectCraftRendererOptions) {
    this.cli = opts.cli ? new EffectCraftCli(opts.cli) : null;
  }

  /** What was wrong with the shipped template files when this renderer was made (set by the plugin). */
  templateProblems(): string[] {
    return this.opts.templateProblems ?? [];
  }

  /** Bundled, starts, and is exactly the pinned version. Checked once per renderer. */
  available(): Promise<{ ok: true; version: string } | { ok: false; reason: string }> {
    this.checked ??= this.check();
    return this.checked;
  }

  private async check(): Promise<{ ok: true; version: string } | { ok: false; reason: string }> {
    if (!this.cli) return { ok: false, reason: 'EffectCraft is not bundled with this build' };
    if (!this.cli.exists())
      return { ok: false, reason: `effectcraft-cli is missing at ${this.cli.location.bin}` };
    try {
      const version = await this.work((cwd) => this.cli!.version({ cwd, timeoutMs: 30_000 }));
      const problem = pinProblem(version);
      return problem ? { ok: false, reason: problem } : { ok: true, version: version! };
    } catch (e) {
      return { ok: false, reason: `effectcraft-cli does not start: ${(e as Error).message}` };
    }
  }

  supports(templateId: string): boolean {
    return templateId === PROJECT_TEMPLATE_ID || templateId in (this.opts.templates ?? {});
  }

  private templateOf(id: string) {
    const t = this.opts.templates?.[id];
    return typeof t === 'string' ? { file: t } : t;
  }

  /** Version, template, source file by content, values, size, rate and length (no paths). */
  async fingerprint(job: Omit<MotionRenderJob, 'outDir'>): Promise<string> {
    const a = await this.available();
    if (!a.ok) throw new EffectCraftError('missing', a.reason);
    let file: string | undefined;
    let params = job.params;
    if (job.templateId === PROJECT_TEMPLATE_ID) {
      const { project, ...rest } = job.params;
      if (typeof project === 'string') file = project;
      params = rest;
    } else {
      const t = this.templateOf(job.templateId);
      file = t?.file;
      params = t ? valuesFor(t, job.params) : params;
    }
    if (!file) throw new Error(`EffectCraft cannot render ${job.templateId} with these params`);
    return motionContentHash({
      version: a.version,
      templateId: job.templateId,
      sourceSha256: createHash('sha256')
        .update(await readFile(file))
        .digest('hex'),
      params,
      resolution: job.resolution,
      frameRate: job.frameRate,
      duration: job.duration,
    });
  }

  async render(job: MotionRenderJob, signal: AbortSignal): Promise<MotionRenderResult> {
    const cli = await this.ready();
    const warnings: string[] = [];
    return this.work(async (cwd) => {
      let source: string[];
      const run = { cwd, signal, timeoutMs: this.opts.timeoutMs ?? 600_000 };
      if (job.templateId === PROJECT_TEMPLATE_ID) {
        const project = job.params.project;
        if (typeof project !== 'string') throw new Error('params.project must be a file path');
        warnings.push(...(await checkProjectFile(cli, project, run)).warnings);
        const comp = job.params.comp;
        source = [project, ...(typeof comp === 'string' ? ['--comp', comp] : [])];
      } else {
        const template = this.templateOf(job.templateId);
        if (!template) throw new Error(`EffectCraft has no template ${job.templateId}`);
        const values = join(cwd, 'values.json');
        await writeFile(values, JSON.stringify(valuesFor(template, job.params)));
        source = ['--template', template.file, '--values', values];
      }
      return this.renderFrames(
        cli,
        source,
        job,
        run,
        warnings,
        scaleFor(this.templateOf(job.templateId), job),
      );
    });
  }

  /** Builds `scene` as an EffectCraft project (through commands) and renders it. */
  async renderScene(
    scene: Scene,
    rate: Rate,
    outDir: string,
    signal: AbortSignal,
  ): Promise<MotionRenderResult & { project: AuthoredProject }> {
    const built = sceneCommands(scene, rate);
    const projectPath = `${outDir}.ecproj`;
    const project = await this.authorProject(built.commands, projectPath, signal);
    const r = await this.render(
      {
        templateId: PROJECT_TEMPLATE_ID,
        params: { project: projectPath, comp: built.compName },
        duration: scene.duration,
        resolution: scene.size,
        frameRate: rate,
        outDir,
      },
      signal,
    ).catch(async (e: unknown) => {
      await rm(projectPath, { force: true });
      throw e;
    });
    return { ...r, warnings: [...built.warnings, ...project.warnings, ...r.warnings], project };
  }

  /**
   * Runs `commands` in a fresh headless session and saves the project at `dest` (written in the
   * run's folder, checked by reopening it, then moved into place). EffectCraft validates every
   * parameter; the first error stops the run and nothing is saved.
   */
  async authorProject(
    commands: EcCommand[],
    dest: string,
    signal: AbortSignal,
    opts: { base?: string } = {},
  ): Promise<AuthoredProject> {
    const cli = await this.ready();
    return this.work(async (cwd) => {
      const run = { cwd, signal, timeoutMs: this.opts.timeoutMs ?? 600_000 };
      const tmp = join(cwd, 'project.ecproj');
      // With a base project (an imported example) the commands edit a copy of it.
      if (opts.base) await copyFile(opts.base, tmp);
      const chunks = chunkCommands(commands);
      if (!chunks.length) throw new Error('no commands');
      for (const [i, chunk] of chunks.entries())
        await cli.run(
          i === 0 && !opts.base
            ? ['--empty', 'run', ...chunk, '--save-as', tmp, '--json']
            : ['--project', tmp, '--save', 'run', ...chunk, '--json'],
          run,
        );
      const { header, warnings } = await checkProjectFile(cli, tmp, run);
      const bytes = await readFile(tmp);
      await mkdir(dirname(dest), { recursive: true });
      await moveInto(tmp, dest);
      return {
        path: dest,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        header,
        warnings,
      };
    });
  }

  /**
   * Import a Lottie `.json` with EffectCraft and nest its composition, scaled and centred, in a
   * new composition `o.comp`; saved at `dest`. TrailerForge runs this with its own path; the
   * import command is never offered to a model.
   */
  async importAndNest(
    lottie: string,
    dest: string,
    signal: AbortSignal,
    o: { comp: Record<string, unknown> & { name: string; width: number; height: number }; layerName: string; scale: number }, // prettier-ignore
  ): Promise<AuthoredProject> {
    const cli = await this.ready();
    return this.work(async (cwd) => {
      const run = { cwd, signal, timeoutMs: this.opts.timeoutMs ?? 600_000 };
      const tmp = join(cwd, 'project.ecproj');
      const r = await cli.run(['--empty', 'run', 'file.importLottie', JSON.stringify({ path: lottie }), '--save-as', tmp, '--json'], run); // prettier-ignore
      const item = importedComp(r.stdout);
      await cli.run(
        ['--project', tmp, '--save', 'run',
          'comp.new', JSON.stringify(o.comp),
          'layer.addItem', JSON.stringify({ comp: o.comp.name, item, time: 0 }),
          'prop.set', JSON.stringify({ layer: o.layerName, path: 'transform/scale', value: [o.scale, o.scale] }),
          'prop.set', JSON.stringify({ layer: o.layerName, path: 'transform/position', value: [o.comp.width / 2, o.comp.height / 2] }),
          '--json'],
        run,
      ); // prettier-ignore
      const { header, warnings } = await checkProjectFile(cli, tmp, run);
      const bytes = await readFile(tmp);
      await mkdir(dirname(dest), { recursive: true });
      await moveInto(tmp, dest);
      return {
        path: dest,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        header,
        warnings,
      };
    });
  }

  private async ready(): Promise<EffectCraftCli> {
    const a = await this.available();
    if (!a.ok)
      throw new EffectCraftError(
        /not the pinned|did not report/.test(a.reason) ? 'version' : 'missing',
        a.reason,
      );
    return this.cli!;
  }

  private async renderFrames(
    cli: EffectCraftCli,
    source: string[],
    job: MotionRenderJob,
    run: { cwd: string; signal: AbortSignal; timeoutMs: number },
    warnings: string[],
    scale = 'full',
  ): Promise<MotionRenderResult> {
    const fpf = flicksPerFrame(job.frameRate);
    const frames = Math.max(1, Math.round(job.duration / fpf));
    const raw = join(run.cwd, 'raw');
    await mkdir(raw);
    await cli.run(
      [
        'render',
        ...source,
        '--out',
        join(raw, 'f_[######].png'),
        '--format',
        'png',
        '--channels',
        'rgba',
        '--audio',
        'off',
        '--quality',
        'best',
        '--resolution',
        scale,
        '--fps',
        String(Math.round((job.frameRate.num / job.frameRate.den) * 1e6) / 1e6),
        '--start',
        '0',
        '--end',
        String(Math.round((frames * fpf * 1e6) / FLICKS_PER_SECOND) / 1e6),
        '--json',
      ],
      run,
    );
    // Only the numbered frames: EffectCraft also writes a render log beside them.
    const pngs = (await readdir(raw)).filter((f) => /^f_\d+\.png$/.test(f)).sort();
    if (pngs.length < frames)
      throw new EffectCraftError(
        'bad-output',
        `EffectCraft rendered ${pngs.length} frames, ${frames} were asked for`,
      );
    const head = await pngHeader(join(raw, pngs[0]!));
    const { width, height } = job.resolution;
    if (head.width !== width || head.height !== height)
      throw new EffectCraftError(
        'bad-output',
        `EffectCraft rendered ${head.width}×${head.height}, ${width}×${height} was asked for`,
      );
    if (head.colorType !== 6)
      throw new EffectCraftError('bad-output', 'EffectCraft frames have no alpha channel');
    const stage = join(run.cwd, 'frames');
    await mkdir(stage);
    for (let k = 0; k < frames; k++)
      await rename(join(raw, pngs[k]!), join(stage, `frame_${String(k).padStart(6, '0')}.png`));
    await writeFile(join(stage, SEQUENCE_DONE), `${frames}\n`);
    run.signal.throwIfAborted();
    await mkdir(dirname(job.outDir), { recursive: true });
    await rm(job.outDir, { recursive: true, force: true });
    await moveInto(stage, job.outDir);
    return { dir: job.outDir, pattern: 'frame_%06d.png', frames, warnings };
  }

  /** A run folder `ec-<pid>-<uuid>`, always removed afterwards; dead runs' folders are swept. */
  private async work<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
    await sweepWorkRoot(this.opts.workRoot);
    const cwd = join(this.opts.workRoot, `${WORK_PREFIX}${process.pid}-${randomUUID()}`);
    await mkdir(cwd, { recursive: true });
    try {
      return await fn(cwd);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
}

/** Removes run folders left by processes that no longer exist (a crash or a kill). */
export async function sweepWorkRoot(workRoot: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(workRoot);
  } catch {
    return;
  }
  for (const name of names) {
    const m = /^ec-(\d+)-/.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid || alive(pid)) continue;
    await rm(join(workRoot, name), { recursive: true, force: true });
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function moveInto(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    // Another drive: copy to a temp name beside the target, then rename.
    const tmp = `${to}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await cp(from, tmp, { recursive: true });
      await rename(tmp, to);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}

/** Width, height and colour type from a PNG's IHDR chunk. */
export async function pngHeader(
  path: string,
): Promise<{ width: number; height: number; colorType: number }> {
  const f = await open(path, 'r');
  try {
    const b = Buffer.alloc(26);
    await f.read(b, 0, 26, 0);
    if (b.readUInt32BE(0) !== 0x89504e47 || b.toString('ascii', 12, 16) !== 'IHDR')
      throw new EffectCraftError('bad-output', `${path} is not a PNG`);
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), colorType: b[25]! };
  } finally {
    await f.close();
  }
}

/** Param names → control names; text values only (the CLI's values file wants plain values). */
function valuesFor(
  t: { controls?: Record<string, string> },
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (!t.controls) return params;
  const out: Record<string, unknown> = {};
  for (const [param, control] of Object.entries(t.controls))
    if (params[param] !== undefined && params[param] !== '') out[control] = params[param];
  return out;
}

/**
 * A template is made for one size; a smaller picture of the same shape (a 720p draft of a 1080p
 * cut) is asked of EffectCraft as that fraction of the full size. Anything else renders at full
 * size, and the size check afterwards refuses a mismatch.
 */
function scaleFor(
  t: { size?: { width: number; height: number } } | undefined,
  job: { resolution: { width: number; height: number } },
): string {
  const size = t?.size;
  if (!size || (size.width === job.resolution.width && size.height === job.resolution.height))
    return 'full';
  const k = job.resolution.width / size.width;
  return String(Math.round(k * 1e9) / 1e9);
}

/** The composition id `file.importLottie` reports (`run --json` lists each command's result). */
function importedComp(stdout: string): number {
  try {
    const v = JSON.parse(stdout.trim().split('\n').at(-1)!) as { results?: { result?: { comp?: unknown } }[] } | { result?: { comp?: unknown } }[]; // prettier-ignore
    const list = Array.isArray(v) ? v : (v.results ?? []);
    const comp = list[0]?.result?.comp;
    if (typeof comp === 'number') return comp;
  } catch {
    /* below */
  }
  throw new EffectCraftError(
    'bad-output',
    'EffectCraft did not say which composition the import made',
  );
}
