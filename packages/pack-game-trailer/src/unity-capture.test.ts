import { Project } from '@trailerforge/schema';
import { sampleProject } from '@trailerforge/schema/fixtures';
import { describe, expect, it } from 'vitest';
import { acceptMatchesPayload, suggestMatches } from './matching.js';
import { shotCodes } from './shot-codes.js';
import { parseUnityTake, unitySidecarPath, unityTakeLabel } from './unity-capture.js';

const sidecar = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    format: 'trailerforge.unity-take',
    version: 1,
    code: 'TF-PX9B8',
    slotId: 'shot_parry',
    take: 2,
    file: 'TF-PX9B8_take02.mp4',
    level: 'live',
    pass: {
      camera: 'main',
      hud: 'off',
      speed: 1,
      width: 1280,
      height: 720,
      fps: 30,
      codec: 'h264',
    },
    frames: 60,
    seconds: 2,
    ...over,
  });

describe('Unity take sidecar', () => {
  it('reads a sidecar, ignores fields it does not know and labels the take', () => {
    const r = parseUnityTake(sidecar({ future: { a: 1 }, performanceId: 'perf_1' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.take.performanceId).toBe('perf_1');
    expect(unityTakeLabel(r.take)).toBe('Unity live · main camera · HUD off · 1280×720 @ 30');
    const slow = parseUnityTake(
      sidecar({ level: 'replay', pass: { camera: 'orbit', speed: 0.5 } }),
    );
    expect(slow.ok && unityTakeLabel(slow.take)).toBe('Unity replay · orbit camera · 0.5× speed');
  });

  it('refuses another format, a newer version and broken JSON, saying which', () => {
    expect(parseUnityTake('{ nope')).toEqual({ ok: false, reason: 'unreadable' });
    expect(parseUnityTake('{"format":"other","version":1}')).toEqual({
      ok: false,
      reason: 'not-a-take',
    });
    expect(parseUnityTake(sidecar({ version: 2 }))).toEqual({ ok: false, reason: 'newer-version' });
  });

  it('finds the sidecar next to a recording on either kind of path', () => {
    expect(unitySidecarPath('C:\\rec\\TF-PX9B8_take02.mov')).toBe(
      'C:\\rec\\TF-PX9B8_take02.tfshot.json',
    );
    expect(unitySidecarPath('/rec/a.b/TF-PX9B8_take02.mp4')).toBe(
      '/rec/a.b/TF-PX9B8_take02.tfshot.json',
    );
    expect(unitySidecarPath('/rec.d/noext')).toBe('/rec.d/noext.tfshot.json');
  });
});

describe('matching a recording by the code in its sidecar', () => {
  const project = Project.parse(sampleProject());
  const code = shotCodes(project).get('shot_parry')!;

  it('attaches a renamed file by the declared code, with its origin', () => {
    const { matches } = suggestMatches({
      project,
      recordings: [{ assetId: 'asset_a', name: 'renamed clip.mp4', declaredCode: code }],
    });
    expect(matches[0]).toMatchObject({ kind: 'code', confidence: 'certain' });
    expect(matches[0]!.candidates[0]!.slotId).toBe('shot_parry');
    const origin = { app: 'unity' as const, level: 'live', label: 'Unity live' };
    const payload = acceptMatchesPayload(matches, {
      minConfidence: 'certain',
      origins: new Map([['asset_a', origin]]),
    });
    expect(payload.items).toEqual([
      { slotId: 'shot_parry', assetId: 'asset_a', matchedBy: 'code', origin },
    ]);
  });

  it('reports a code that is no shot of this project instead of attaching', () => {
    const { matches } = suggestMatches({
      project,
      recordings: [{ assetId: 'asset_b', name: 'clip.mp4', declaredCode: 'TF-ZZZZZ' }],
    });
    expect(matches[0]!.unknownCodes).toEqual(['TF-ZZZZZ']);
    expect(acceptMatchesPayload(matches, { minConfidence: 'certain' }).items).toEqual([]);
  });

  it('lets the name win when it already carries a code', () => {
    const other = shotCodes(project).get('shot_boss')!;
    const { matches } = suggestMatches({
      project,
      recordings: [{ assetId: 'asset_c', name: `${other}_take01.mp4`, declaredCode: code }],
    });
    expect(matches[0]!.candidates[0]!.slotId).toBe('shot_boss');
  });
});
