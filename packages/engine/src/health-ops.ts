import { release } from 'node:os';
import {
  SIDECAR_SETUP_DISCLOSURE,
  SidecarSetupConsentRequired,
  prepareSidecar,
  sidecarStatus,
  visionModelStatus,
} from '@trailerforge/analysis';
import { freeBytes } from '@trailerforge/media';
import { mkdir } from 'node:fs/promises';
import type { Engine } from './engine.js';
import { OpError } from './ops.js';
import { providerStatus } from './settings.js';

/**
 * "Is this computer ready?" The checks behind the Setup screen and `tforge doctor`: FFmpeg and the
 * filters and encoders the renders use, the analysis tools, disk space, the AI routes and the
 * optional vision model. Every check reads only: nothing is downloaded or changed, and each one
 * that is not fine says what to do.
 */

export type HealthStatus = 'ok' | 'info' | 'warn' | 'fail';

export interface HealthCheck {
  id: string;
  title: string;
  status: HealthStatus;
  detail: string;
  /** What to do, in plain words, when the status is not ok. */
  fix?: string;
  /** The Settings or Setup action that fixes it, when there is one. */
  action?: 'setup-sidecar' | 'open-settings';
}

export interface HealthReport {
  checks: HealthCheck[];
  /** False when something that stops the app from working fails. */
  ready: boolean;
  /** What "Create the analysis environment" would download. */
  sidecarSetup: typeof SIDECAR_SETUP_DISCLOSURE;
}

/** Filters the compiler, the effects and the audio mix build their graphs from. */
export const REQUIRED_FILTERS = [
  'scale', 'crop', 'overlay', 'blend', 'fps', 'settb', 'setpts', 'tpad', 'trim', 'concat',
  'format', 'color', 'split', 'xfade', 'boxblur', 'pad', 'setsar', 'setparams', 'gblur',
  'vignette', 'rgbashift', 'noise', 'geq', 'volume', 'atrim', 'atempo', 'aresample', 'aformat',
  'asetpts', 'apad', 'adelay', 'amix', 'alimiter',
] as const; // prettier-ignore
/** Encoders the export presets and the handoff clips use. */
export const REQUIRED_ENCODERS = ['libx264', 'prores_ks', 'aac', 'pcm_s24le'] as const;
/** Nice to have: slates show their text with `drawtext`. */
const OPTIONAL_FILTERS = ['drawtext'] as const;

const GB = 1024 ** 3;

const installHint = () =>
  process.platform === 'win32'
    ? 'Install FFmpeg (for example "winget install Gyan.FFmpeg"), restart TrailerForge, or set TFORGE_FFMPEG_DIR to the folder with ffmpeg.exe.'
    : process.platform === 'darwin'
      ? 'Install FFmpeg (for example "brew install ffmpeg") and restart TrailerForge, or set TFORGE_FFMPEG_DIR.'
      : 'Install FFmpeg with your package manager (for example "sudo apt install ffmpeg") and restart TrailerForge, or set TFORGE_FFMPEG_DIR.';

/** What a missing filter or encoder means for the person, by name. */
export function missingTools(
  caps: { filters: ReadonlySet<string>; encoders: ReadonlySet<string> },
  need: { filters?: readonly string[]; encoders?: readonly string[] } = {
    filters: REQUIRED_FILTERS,
    encoders: REQUIRED_ENCODERS,
  },
): { filters: string[]; encoders: string[] } {
  return {
    filters: (need.filters ?? []).filter((f) => !caps.filters.has(f)),
    encoders: (need.encoders ?? []).filter((e) => !caps.encoders.has(e)),
  };
}

/**
 * Stop a render before it starts when this FFmpeg lacks something the plan needs, naming it.
 * `codecs` are the encoders the output uses; the filters are always the full set.
 */
export async function requireRenderTools(
  engine: Engine,
  codecs: readonly string[] = [],
): Promise<void> {
  let caps;
  try {
    caps = await engine.capabilities();
  } catch (err) {
    throw new OpError('missing-tool', `FFmpeg could not be started: ${(err as Error).message}. ${installHint()}`); // prettier-ignore
  }
  const m = missingTools(caps, {
    filters: REQUIRED_FILTERS,
    encoders: [...new Set(codecs)],
  });
  if (m.filters.length || m.encoders.length) {
    const parts = [
      ...(m.filters.length ? [`the filter${m.filters.length === 1 ? '' : 's'} "${m.filters.join('", "')}"`] : []), // prettier-ignore
      ...(m.encoders.length ? [`the encoder${m.encoders.length === 1 ? '' : 's'} "${m.encoders.join('", "')}"`] : []), // prettier-ignore
    ];
    throw new OpError(
      'missing-tool',
      `This FFmpeg (${caps.version}) does not have ${parts.join(' or ')}, which this render needs. Install a full FFmpeg build (the "full" or "gpl" one) and restart TrailerForge.`,
      m,
    );
  }
}

async function ffmpegCheck(engine: Engine): Promise<HealthCheck[]> {
  let caps;
  try {
    caps = await engine.capabilities(true);
  } catch (err) {
    return [
      {
        id: 'ffmpeg',
        title: 'FFmpeg',
        status: 'fail',
        detail: `FFmpeg could not be started (${(err as Error).message.split('\n')[0]!.slice(0, 160)}).`,
        fix: installHint(),
      },
    ];
  }
  const m = missingTools(caps);
  const noText = OPTIONAL_FILTERS.filter((f) => !caps.filters.has(f));
  const out: HealthCheck[] = [
    m.filters.length || m.encoders.length
      ? {
          id: 'ffmpeg',
          title: 'FFmpeg',
          status: 'fail',
          detail: `FFmpeg ${caps.version} is installed but lacks ${[...m.filters.map((f) => `the filter "${f}"`), ...m.encoders.map((e) => `the encoder "${e}"`)].join(', ')}.`, // prettier-ignore
          fix: 'Install a full FFmpeg build (the "full" or "gpl" one), restart TrailerForge, and check again.',
        }
      : {
          id: 'ffmpeg',
          title: 'FFmpeg',
          status: 'ok',
          detail: `FFmpeg ${caps.version} has everything renders need.`,
        },
  ];
  if (noText.length)
    out.push({
      id: 'ffmpeg-text',
      title: 'Text on placeholders',
      status: 'info',
      detail:
        'This FFmpeg cannot draw text, so placeholder slates show no words. Renders still work.',
      fix: 'A full FFmpeg build has it.',
    });
  out.push({
    id: 'hardware',
    title: 'Hardware video encoders',
    status: 'info',
    detail: caps.workingHwEncoders.length
      ? `${caps.workingHwEncoders.join(', ')} works: review drafts can use it (final exports always use the software encoder, for identical results).`
      : 'None found. Review drafts are made in software, which is fine.',
  });
  return out;
}

async function sidecarCheck(engine: Engine): Promise<HealthCheck> {
  void engine;
  const s = await sidecarStatus();
  const base = { id: 'analysis', title: 'Music and footage analysis' };
  if (s.state === 'ready') return { ...base, status: 'ok', detail: s.detail };
  if (s.state === 'needs-setup')
    return {
      ...base,
      status: 'fail',
      detail: s.detail,
      fix: `Create the analysis environment: about ${SIDECAR_SETUP_DISCLOSURE.approxMegabytes} MB of Python packages from ${SIDECAR_SETUP_DISCLOSURE.source}, once.`,
      action: 'setup-sidecar',
    };
  return { ...base, status: 'fail', detail: s.detail, fix: s.detail };
}

async function diskCheck(engine: Engine): Promise<HealthCheck> {
  await mkdir(engine.home, { recursive: true });
  const free = await freeBytes(engine.home);
  const gb = (n: number) => (n / GB).toFixed(1);
  const base = { id: 'disk', title: 'Disk space' };
  if (free < 1 * GB)
    return { ...base, status: 'fail', detail: `Only ${gb(free)} GB free where TrailerForge keeps its files.`, fix: 'Free up space: renders and previews need several GB.' }; // prettier-ignore
  if (free < 10 * GB)
    return { ...base, status: 'warn', detail: `${gb(free)} GB free where TrailerForge keeps its files.`, fix: 'A 1080p trailer render needs a few GB while it works; free up some space if exports fail.' }; // prettier-ignore
  return { ...base, status: 'ok', detail: `${gb(free)} GB free.` };
}

async function aiCheck(engine: Engine): Promise<HealthCheck> {
  const providers = await providerStatus(engine);
  const ok = providers.filter((p) => p.available.ok);
  const real = ok.filter((p) => p.kind !== 'interactive' && p.kind !== 'mock');
  const base = { id: 'ai', title: 'AI help (optional)', action: 'open-settings' as const };
  if (real.length)
    return { ...base, status: 'ok', detail: `${real.map((p) => p.name).join(', ')} ${real.length === 1 ? 'is' : 'are'} available.` }; // prettier-ignore
  return {
    ...base,
    status: 'info',
    detail: ok.length
      ? 'Only copy-to-chat is available: you paste each request into a chat yourself.'
      : 'No AI provider is available. Everything except writing storyboards, tips and critiques works without one.',
    fix: 'Add an Anthropic key, install Claude Code, or run a model on this computer with Ollama (Settings).',
  };
}

async function visionCheck(engine: Engine): Promise<HealthCheck> {
  const base = { id: 'vision', title: 'AI vision for matching (optional)' };
  const m = engine.vision.manifest;
  if (!m)
    return { ...base, status: 'info', detail: 'This build does not include the vision model.' };
  const s = await visionModelStatus(engine.home, m);
  return s === 'ready'
    ? { ...base, status: 'ok', detail: 'The vision model is downloaded and verified.' }
    : { ...base, status: 'info', detail: 'Not downloaded. Matching recordings to shots works without it.', fix: 'Settings can download it once (you are shown the size and source first).', action: 'open-settings' }; // prettier-ignore
}

/** All the checks, in the order the Setup screen shows them. Reads only. */
export async function healthOp(engine: Engine): Promise<HealthReport> {
  const [ffmpeg, analysis, disk, ai, vision] = await Promise.all([
    ffmpegCheck(engine),
    sidecarCheck(engine),
    diskCheck(engine),
    aiCheck(engine),
    visionCheck(engine),
  ]);
  const checks: HealthCheck[] = [
    ...ffmpeg.filter((c) => c.id === 'ffmpeg'),
    analysis,
    disk,
    ai,
    vision,
    ...ffmpeg.filter((c) => c.id !== 'ffmpeg'),
    {
      id: 'system',
      title: 'This computer',
      status: 'info',
      detail: `${process.platform} ${release()}, Node ${process.versions.node}.`,
    },
  ];
  return {
    checks,
    ready: !checks.some((c) => c.status === 'fail'),
    sidecarSetup: SIDECAR_SETUP_DISCLOSURE,
  };
}

/**
 * Create the analysis environment: downloads the pinned Python packages through uv. Needs
 * `consent: true`; logged in the network log as a setup step. Returns the new check.
 */
export async function setupSidecarOp(
  engine: Engine,
  opts: {
    consent: boolean;
    signal?: AbortSignal | undefined;
    onLine?: ((line: string) => void) | undefined;
  },
): Promise<HealthCheck> {
  const purpose =
    'Create the analysis environment (Python packages for music and footage analysis)';
  try {
    await prepareSidecar({
      consent: opts.consent,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.onLine ? { onLine: opts.onLine } : {}),
    });
    await engine.egress.logSetup({
      purpose,
      tool: 'uv sync',
      source: 'pypi.org (via uv)',
      ok: true,
    });
  } catch (err) {
    if (err instanceof SidecarSetupConsentRequired) throw new OpError('usage', err.message);
    await engine.egress.logSetup({ purpose, tool: 'uv sync', source: 'pypi.org (via uv)', ok: false, error: (err as Error).message.slice(0, 300) }); // prettier-ignore
    throw err;
  }
  return sidecarCheck(engine);
}
