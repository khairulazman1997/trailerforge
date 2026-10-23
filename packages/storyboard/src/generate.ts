import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_PROMPTS_DIR, loadPrompt, type LlmClient } from '@trailerforge/llm';
import type { StoryboardTemplate } from '@trailerforge/plugin-api';
import {
  DecisionRecord,
  Storyboard,
  type CardSlot,
  type Project,
  type Section,
  type VoLine,
} from '@trailerforge/schema';
import { SectionLockedError } from './commands.js';
import {
  collectIds,
  convertSections,
  mintId,
  sectionSeconds,
  type ConvertContext,
} from './convert.js';
import { GeneratedSection, GeneratedStoryboard } from './output.js';

export const STORYBOARD_PROMPTS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'prompts',
);

export interface GenerateDeps {
  llm: LlmClient;
  now?: () => Date;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const round1 = (n: number) => Math.round(n * 10) / 10;

function decision(
  at: Date,
  rec: Omit<DecisionRecord, 'id' | 'at' | 'alternatives'>,
): DecisionRecord {
  const iso = at.toISOString();
  const id = `dec_${sha256(`${rec.step}|${iso}|${rec.subject.id}|${rec.inputsHash ?? ''}`).slice(0, 24)}`;
  return DecisionRecord.parse({ ...rec, id, at: iso });
}

function promptContext(project: Project) {
  const { assumptions, ...brief } = project.brief;
  const visible = project.knowledge.filter((e) => !e.excludedFromLlm);
  return {
    brief: JSON.stringify(brief, null, 2),
    assumptions:
      assumptions.map((a) => `- ${a.field}: ${JSON.stringify(a.value)} (${a.reason})`).join('\n') ||
      '(none)',
    knowledge:
      visible
        .slice(0, 120)
        .map((e) => `- ${e.id}: ${e.kind}: ${e.name}${e.description ? ` — ${e.description}` : ''}`)
        .join('\n') || '(none)',
    entityIds: new Set(visible.map((e) => e.id)),
  };
}

function outlineSection(s: Section, mark = false): string {
  const slots = s.slots
    .map((x) => `${x.title || x.id} (${x.kind}, ${x.duration.ideal}s)`)
    .join('; ');
  const flags = [s.role, `${sectionSeconds(s)}s`, s.locked ? 'locked' : ''].filter(Boolean);
  return `${mark ? '>>> ' : '- '}${s.name} (${flags.join(', ')}): ${slots || '(empty)'}`;
}

function cardTemplatesOf(sb: Storyboard): ConvertContext['cardTemplates'] {
  const out: Partial<Record<CardSlot['cardKind'], string>> = {};
  for (const s of sb.sections.flatMap((x) => x.slots)) {
    if (s.kind === 'card') out[s.cardKind] ??= s.templateId;
  }
  return out;
}

async function systemPrompt(project: Project) {
  return loadPrompt('system.trailer-craft', { projectName: project.name }, [BUILTIN_PROMPTS_DIR]);
}

export interface GenerateResult {
  storyboard: Storyboard;
  decisions: DecisionRecord[];
}

/**
 * Generate a full storyboard from the brief, shaped by a template. If the project already has a
 * storyboard, its locked sections are kept verbatim at their positions (and their VO lines, hit
 * points and SFX cues with them); the LLM only writes the remaining time.
 * Apply the result with `core/storyboard.set`, then append `decisions` to the decision log.
 */
export async function generateStoryboard(
  deps: GenerateDeps,
  project: Project,
  opts: { template: StoryboardTemplate; targetDuration: number; signal?: AbortSignal },
): Promise<GenerateResult> {
  const { template, targetDuration } = opts;
  const skeleton = Storyboard.parse(template.build({ targetDuration }));
  const existing = project.storyboard;
  const locked = (existing?.sections ?? [])
    .map((s, index) => ({ s, index }))
    .filter(({ s }) => s.locked);
  const lockedSlotIds = new Set(locked.flatMap(({ s }) => s.slots.map((x) => x.id)));
  const budget = round1(targetDuration - locked.reduce((a, { s }) => a + sectionSeconds(s), 0));
  if (budget <= 0) throw new RangeError('locked sections already fill the target duration');

  // What survives from the old storyboard: only things tied to locked slots.
  const keptVo: VoLine[] = (existing?.voLines ?? []).filter(
    (v) => v.linkedSlotIds.length > 0 && v.linkedSlotIds.every((id) => lockedSlotIds.has(id)),
  );
  const keptHits = (existing?.music.hitPoints ?? []).filter((h) => lockedSlotIds.has(h.slotId));
  const keptSfx = (existing?.music.sfxCues ?? []).filter((c) => lockedSlotIds.has(c.slotId));
  const keptVariants = (existing?.variants ?? []).map((v) => ({
    ...v,
    overrides: Object.fromEntries(
      Object.entries(v.overrides).filter(([id]) => lockedSlotIds.has(id)),
    ),
  }));

  const ctx = promptContext(project);
  const system = await systemPrompt(project);
  const prompt = await loadPrompt(
    'storyboard.generate',
    {
      videoType: template.name,
      targetDuration: String(targetDuration),
      budget: String(budget),
      skeleton: skeleton.sections.map((s) => outlineSection(s)).join('\n'),
      locked: locked.map(({ s }) => outlineSection(s)).join('\n') || '(none)',
      brief: ctx.brief,
      assumptions: ctx.assumptions,
      knowledge: ctx.knowledge,
    },
    [STORYBOARD_PROMPTS_DIR],
  );
  const r = await deps.llm.generate(
    'storyboard.generate',
    { system, prompt, schema: GeneratedStoryboard },
    opts.signal,
  );
  const gen = r.value;

  // A generated section with the role of a locked one is a duplicate the model wrote anyway:
  // the locked section takes its place. Remaining locked sections go back to their old index.
  const unplaced = [...locked];
  const plan = gen.sections.map((g) => {
    const i = g.role ? unplaced.findIndex(({ s }) => s.role === g.role) : -1;
    return i < 0 ? { gen: g } : { locked: unplaced.splice(i, 1)[0]!.s };
  });
  for (const { s, index } of unplaced) plan.splice(Math.min(index, plan.length), 0, { locked: s });
  const toWrite = plan.flatMap((x) => ('gen' in x ? [x.gen] : []));
  if (toWrite.length === 0) throw new Error('the model only returned locked sections');

  const taken = collectIds({ ...project, storyboard: null });
  collectIds([locked.map(({ s }) => s), keptVo, keptHits, keptSfx, keptVariants], taken);
  const id = existing?.id ?? mintId('sb', 'main', taken);
  taken.add(id);
  const converted = convertSections(toWrite, budget, {
    taken,
    entityIds: ctx.entityIds,
    cardTemplates: cardTemplatesOf(skeleton),
  });
  let next = 0;
  const sections = plan.map((x) => ('gen' in x ? converted.sections[next++]! : x.locked));
  const bpm = gen.music.bpm && {
    min: Math.min(gen.music.bpm.min, gen.music.bpm.max),
    max: Math.max(gen.music.bpm.min, gen.music.bpm.max),
  };

  const storyboard = Storyboard.parse({
    id,
    revision: existing ? existing.revision + 1 : 0,
    meta: {
      videoTypeId: template.videoTypeId,
      templateId: template.id,
      tone: project.brief.tone,
      targetDuration,
      ...(existing?.meta.masterResolution && { masterResolution: existing.meta.masterResolution }),
    },
    sections,
    voLines: [...keptVo, ...converted.voLines],
    music: {
      ...(existing?.music.trackAssetId && { trackAssetId: existing.music.trackAssetId }),
      direction: gen.music.direction,
      ...(bpm && { bpm }),
      structure: [],
      hitPoints: keptHits,
      sfxCues: keptSfx,
    },
    variants: keptVariants,
    extensions: existing?.extensions ?? {},
  });

  const at = (deps.now ?? (() => new Date()))();
  const decisions = [
    decision(at, {
      step: 'core/storyboard-generate',
      subject: { kind: 'storyboard', id },
      choice: {
        templateId: template.id,
        sections: storyboard.sections.map((s) => ({
          id: s.id,
          name: s.name,
          seconds: sectionSeconds(s),
          locked: s.locked,
        })),
      },
      reasons: {
        provider: r.provider,
        model: r.model,
        fellBack: r.fellBack,
        targetDuration,
        budget,
        requestedSeconds: converted.requestedSeconds,
        lockedSectionIds: locked.map(({ s }) => s.id),
      },
      summary: gen.rationale,
      inputsHash: sha256(`${system}\n${prompt}`),
    }),
  ];
  return { storyboard, decisions };
}

export interface RegenerateSectionResult {
  payload: { sectionId: string; section: Section; voLines: VoLine[] };
  decisions: DecisionRecord[];
}

/**
 * Rewrite one unlocked section in the same time it has now. Apply `payload` with
 * `core/storyboard.replace-section`, which also cleans up references to the old slots.
 */
export async function regenerateSection(
  deps: GenerateDeps,
  project: Project,
  opts: { sectionId: string; instruction?: string; signal?: AbortSignal },
): Promise<RegenerateSectionResult> {
  const sb = project.storyboard;
  const target = sb?.sections.find((s) => s.id === opts.sectionId);
  if (!sb || !target) throw new Error(`no section "${opts.sectionId}"`);
  if (target.locked) throw new SectionLockedError(target.id);

  const others = sb.sections.filter((s) => s !== target);
  const free = round1(sb.meta.targetDuration - others.reduce((a, s) => a + sectionSeconds(s), 0));
  const budget = sectionSeconds(target) || Math.max(free, 1);

  const ctx = promptContext(project);
  const system = await systemPrompt(project);
  const prompt = await loadPrompt(
    'storyboard.regenerate-section',
    {
      videoType: sb.meta.videoTypeId,
      sectionName: target.name,
      role: target.role ?? 'unspecified',
      budget: String(budget),
      outline: sb.sections.map((s) => outlineSection(s, s === target)).join('\n'),
      instruction: opts.instruction?.trim() || '(nothing specific; make it stronger)',
      brief: ctx.brief,
      knowledge: ctx.knowledge,
    },
    [STORYBOARD_PROMPTS_DIR],
  );
  const r = await deps.llm.generate(
    'storyboard.regenerate-section',
    { system, prompt, schema: GeneratedSection },
    opts.signal,
  );

  // The old section's slot and VO ids are being replaced, so they are free to reuse.
  const oldSlotIds = new Set(target.slots.map((s) => s.id));
  const taken = collectIds({
    ...project,
    storyboard: {
      ...sb,
      sections: others,
      voLines: sb.voLines.filter(
        (v) => v.linkedSlotIds.length === 0 || v.linkedSlotIds.some((id) => !oldSlotIds.has(id)),
      ),
    },
  });
  taken.add(target.id);
  const converted = convertSections(
    [r.value.section],
    budget,
    { taken, entityIds: ctx.entityIds, cardTemplates: cardTemplatesOf(sb) },
    target.id,
  );
  // The role is the template's hint for this position; keep it so critique still knows it.
  const section: Section = {
    ...converted.sections[0]!,
    ...(target.role !== undefined && { role: target.role }),
  };

  const at = (deps.now ?? (() => new Date()))();
  const decisions = [
    decision(at, {
      step: 'core/storyboard-regenerate-section',
      subject: { kind: 'section', id: target.id },
      choice: {
        name: section.name,
        slots: section.slots.map((s) => ({ id: s.id, title: s.title, seconds: s.duration.ideal })),
      },
      reasons: {
        provider: r.provider,
        model: r.model,
        fellBack: r.fellBack,
        budget,
        requestedSeconds: converted.requestedSeconds,
        instruction: opts.instruction ?? null,
        replacedSlotIds: [...oldSlotIds],
      },
      summary: r.value.rationale,
      inputsHash: sha256(`${system}\n${prompt}`),
    }),
  ];
  return { payload: { sectionId: target.id, section, voLines: converted.voLines }, decisions };
}
