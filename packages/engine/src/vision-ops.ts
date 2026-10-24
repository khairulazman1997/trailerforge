import {
  downloadVisionModel,
  embedTexts,
  readRecordingEmbedding,
  shotVisionText,
  visionDownloadDisclosure,
  visionModelDir,
  visionModelStatus,
  visionScore,
  VisionConsentRequired,
  type VisionModelStatus,
} from '@trailerforge/analysis';
import type { ProjectStore } from '@trailerforge/core';
import { buildCapturePlan, type MatchRecording } from '@trailerforge/pack-game-trailer';
import type { Engine } from './engine.js';
import { OpError } from './ops.js';

/**
 * The opt-in local vision model: its state, the consented one-time download, and similarity
 * scores for matching. Scores come only from frame vectors the analysis already cached; asking
 * for suggestions never decodes footage.
 */

export interface VisionView {
  status: VisionModelStatus;
  /** What the download fetches and from where; null when no model is pinned in this build. */
  disclosure: ReturnType<typeof visionDownloadDisclosure> | null;
}

export async function visionStatusOp(engine: Engine): Promise<VisionView> {
  const m = engine.vision.manifest;
  return {
    status: await visionModelStatus(engine.home, m),
    disclosure: m ? visionDownloadDisclosure(m) : null,
  };
}

/** Download and verify the model through `Egress`. Needs `consent: true`; nothing is uploaded. */
export async function visionDownloadOp(
  engine: Engine,
  opts: {
    consent: boolean;
    signal?: AbortSignal | undefined;
    onProgress?: ((fraction: number) => void) | undefined;
  },
): Promise<VisionView> {
  if (!engine.vision.manifest)
    throw new OpError('usage', 'no vision model is pinned in this build');
  try {
    await downloadVisionModel({
      home: engine.home,
      egress: engine.egress,
      manifest: engine.vision.manifest,
      consent: opts.consent,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    });
  } catch (err) {
    if (err instanceof VisionConsentRequired) throw new OpError('usage', err.message);
    throw err;
  }
  return visionStatusOp(engine);
}

/** Model folder and id, when the model is downloaded and verified; else null. */
export async function readyVisionModel(
  engine: Engine,
): Promise<{ modelDir: string; modelId: string } | null> {
  const m = engine.vision.manifest;
  if (!m || (await visionModelStatus(engine.home, m)) !== 'ready') return null;
  return { modelDir: visionModelDir(engine.home, m), modelId: m.id };
}

/**
 * assetId → slotId → similarity, for recordings whose frames are already embedded. Undefined when
 * the model is not ready or no recording has frame vectors yet. Shot texts are embedded on demand
 * (small, cached by text). Everything stays on this computer, so shot text is not redacted.
 */
export async function visionScoresFor(
  engine: Engine,
  store: ProjectStore,
  recs: MatchRecording[],
  signal?: AbortSignal,
): Promise<Map<string, Map<string, number>> | undefined> {
  const sb = store.state.storyboard;
  const model = await readyVisionModel(engine);
  if (!sb || !model) return undefined;
  const analysisDir = store.paths.analysisCache;
  const frames = new Map<string, number[][]>();
  for (const r of recs) {
    const a = engine.library.get(r.assetId);
    const v = a && (await readRecordingEmbedding(model.modelId, a.quickHash, analysisDir));
    if (v?.length) frames.set(r.assetId, v);
  }
  if (frames.size === 0) return undefined;

  const items = buildCapturePlan(sb, store.state.knowledge).groups.flatMap((g) => g.items);
  const texts = items.map((i) =>
    shotVisionText(
      {
        title: i.title,
        captureInstruction: i.instruction,
        framing: i.framing,
        location: i.location,
      },
      i.entities.map((e) => e.name),
    ),
  );
  const embedder = engine.vision.embedder(model.modelDir, model.modelId);
  const textVectors = await embedTexts(embedder, texts, analysisDir, signal);
  const out = new Map<string, Map<string, number>>();
  for (const [assetId, f] of frames) {
    out.set(
      assetId,
      new Map(items.map((item, j) => [item.slotId, visionScore(f, textVectors[j]!)])),
    );
  }
  return out;
}
