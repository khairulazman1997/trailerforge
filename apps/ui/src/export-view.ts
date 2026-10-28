/** Pure helpers for the Export tab: reading task results, blocked exports, labels. */

export interface ExportResultView {
  file: string;
  poster: string;
  sha256: string;
  preset: string;
  reproducible: boolean;
  overridden: string[];
  warnings: string[];
}

export interface HandoffResultView {
  dir: string;
  files: { format: string; file: string }[];
  graphics: string[];
  warnings: string[];
}

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** What a finished export task reports; null when the result is not one. */
export function asExportResult(v: unknown): ExportResultView | null {
  const o = obj(v);
  if (!o || typeof o.file !== 'string' || typeof o.sha256 !== 'string') return null;
  return {
    file: o.file,
    poster: typeof o.poster === 'string' ? o.poster : '',
    sha256: o.sha256,
    preset: typeof o.preset === 'string' ? o.preset : '',
    reproducible: o.reproducible !== false,
    overridden: strings(o.overridden),
    warnings: strings(o.warnings),
  };
}

export function asHandoffResult(v: unknown): HandoffResultView | null {
  const o = obj(v);
  if (!o || typeof o.dir !== 'string' || !Array.isArray(o.files)) return null;
  return {
    dir: o.dir,
    files: o.files.flatMap((f) => {
      const x = obj(f);
      return x && typeof x.file === 'string' && typeof x.format === 'string'
        ? [{ format: x.format, file: x.file }]
        : [];
    }),
    graphics: strings(o.graphics),
    warnings: strings(o.warnings),
  };
}

export interface BlockedView {
  /** Whether the plan was stopped before rendering or the finished file failed its checks. */
  stage: 'plan' | 'output';
  lines: { text: string; checkId: string; needsOverride: boolean }[];
}

/** The findings behind a `gate-blocked` task error; null for any other failure. */
export function blockedDetails(
  error: { code: string; details?: unknown } | undefined,
): BlockedView | null {
  if (error?.code !== 'gate-blocked') return null;
  const d = obj(error.details);
  const verdict = obj(d?.verdict);
  if (!d || !verdict) return null;
  const take = (list: unknown, needsOverride: boolean) =>
    (Array.isArray(list) ? list : []).flatMap((f) => {
      const o = obj(f);
      return typeof o?.message === 'string'
        ? [
            {
              text: o.message,
              checkId: typeof o.checkId === 'string' ? o.checkId : '',
              needsOverride,
            },
          ]
        : [];
    });
  return {
    stage: d.stage === 'output' ? 'output' : 'plan',
    lines: [...take(verdict.blocking, false), ...take(verdict.needsOverride, true)],
  };
}

export type LastRun = 'none' | 'succeeded' | 'cancelled' | 'failed' | 'blocked';

/** "Resume" only when a run was cut short: finished parts are kept and reused. */
export function exportButtonLabel(last: LastRun): string {
  return last === 'cancelled' || last === 'failed' ? 'Resume export' : 'Export';
}

export const HANDOFF_FORMATS = [
  { id: 'fcpxml', label: 'FCPXML', hint: 'DaVinci Resolve, Final Cut Pro, Premiere' },
  { id: 'otio', label: 'OpenTimelineIO', hint: 'Resolve 18+ and others' },
  { id: 'edl', label: 'EDL', hint: 'the picture only' },
] as const;
export type HandoffFormatId = (typeof HANDOFF_FORMATS)[number]['id'];

/** The folder a file is in, with the separator the path already uses. */
export function parentFolder(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i <= 0 ? path : path.slice(0, i);
}

export const PRESET_FALLBACK_NOTE =
  'Versions without a choice use the preset that suits their shape.';

/** `number` text from an input: blank → null (clear the override), else the number or undefined if invalid. */
export function parseOptionalNumber(
  text: string,
  min: number,
  max: number,
): number | null | undefined {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
}
