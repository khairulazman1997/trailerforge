import type { MediaInfo } from '@trailerforge/schema';
import type { LoudnessMeasurement } from './loudness.js';

export type Severity = 'error' | 'warning' | 'info';

export interface QualityFinding {
  checkId: string;
  severity: Severity;
  message: string;
  /** Seconds into the output, when the finding is localized. */
  at?: { start: number; end?: number };
  suggestion?: string;
}

export interface QualityTargets {
  loudnessLufs: number;
  /** Allowed deviation from the loudness target, LU. Default 1. */
  loudnessToleranceLu?: number;
  truePeakDb: number;
  maxDurationSec?: number;
}

/** Lazily computed facts about the rendered file, shared by all checks. */
export interface QualityContext {
  file: string;
  targets: QualityTargets;
  info(): Promise<MediaInfo>;
  loudness(): Promise<LoudnessMeasurement>;
}

/** A pre-export check. Plugins add more (text read time, safe areas, flash risk) in later milestones. */
export interface QualityCheck {
  id: string;
  name: string;
  run(ctx: QualityContext): Promise<QualityFinding[]>;
}

export interface QualityReport {
  passed: boolean;
  findings: QualityFinding[];
  /** Checks that crashed; reported, never silently skipped. */
  crashed: { checkId: string; error: string }[];
}

export async function runQualityGate(
  checks: readonly QualityCheck[],
  ctx: QualityContext,
): Promise<QualityReport> {
  const findings: QualityFinding[] = [];
  const crashed: QualityReport['crashed'] = [];
  for (const check of checks) {
    try {
      findings.push(...(await check.run(ctx)));
    } catch (err) {
      crashed.push({ checkId: check.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  findings.sort(
    (a, b) => order[a.severity] - order[b.severity] || (a.at?.start ?? 0) - (b.at?.start ?? 0),
  );
  return {
    passed: crashed.length === 0 && !findings.some((f) => f.severity === 'error'),
    findings,
    crashed,
  };
}

/** Memoize the expensive measurements so several checks can share them. */
export function createQualityContext(
  file: string,
  targets: QualityTargets,
  sources: { info: () => Promise<MediaInfo>; loudness: () => Promise<LoudnessMeasurement> },
): QualityContext {
  let info: Promise<MediaInfo> | undefined;
  let loud: Promise<LoudnessMeasurement> | undefined;
  return {
    file,
    targets,
    info: () => (info ??= sources.info()),
    loudness: () => (loud ??= sources.loudness()),
  };
}

export const loudnessCheck: QualityCheck = {
  id: 'core/loudness',
  name: 'Integrated loudness',
  async run(ctx) {
    if ((await ctx.info()).audio.length === 0) {
      return [{ checkId: this.id, severity: 'warning', message: 'Output has no audio track' }];
    }
    const { integratedLufs } = await ctx.loudness();
    const { loudnessLufs, loudnessToleranceLu = 1 } = ctx.targets;
    const diff = integratedLufs - loudnessLufs;
    if (Math.abs(diff) <= loudnessToleranceLu) return [];
    return [
      {
        checkId: this.id,
        severity: 'error',
        message: `Loudness is ${integratedLufs.toFixed(1)} LUFS; target is ${loudnessLufs} LUFS (±${loudnessToleranceLu})`,
        suggestion:
          diff > 0
            ? `Lower the mix by ~${diff.toFixed(1)} dB or enable loudness normalization`
            : `Raise the mix by ~${(-diff).toFixed(1)} dB or enable loudness normalization`,
      },
    ];
  },
};

export const truePeakCheck: QualityCheck = {
  id: 'core/true-peak',
  name: 'True peak',
  async run(ctx) {
    if ((await ctx.info()).audio.length === 0) return [];
    const { truePeakDb } = await ctx.loudness();
    if (truePeakDb <= ctx.targets.truePeakDb) return [];
    return [
      {
        checkId: this.id,
        severity: 'error',
        message: `True peak is ${truePeakDb.toFixed(1)} dBTP; limit is ${ctx.targets.truePeakDb} dBTP (risk of clipping after platform encoding)`,
        suggestion: 'Apply a true-peak limiter on the master bus',
      },
    ];
  },
};

export const durationCheck: QualityCheck = {
  id: 'core/duration',
  name: 'Platform length limit',
  async run(ctx) {
    const max = ctx.targets.maxDurationSec;
    const { duration } = await ctx.info();
    if (max === undefined || duration <= max) return [];
    return [
      {
        checkId: this.id,
        severity: 'error',
        message: `Video is ${duration.toFixed(1)} s; the platform limit is ${max} s`,
        at: { start: max, end: duration },
        suggestion: 'Trim or use the short-form variant',
      },
    ];
  },
};

export const coreQualityChecks: readonly QualityCheck[] = [
  loudnessCheck,
  truePeakCheck,
  durationCheck,
];
