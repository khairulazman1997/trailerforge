import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_PROMPTS_DIR, loadPrompt, type LlmClient } from '@trailerforge/llm';
import type { StoryboardTemplate } from '@trailerforge/plugin-api';
import {
  collectIds,
  DecisionRecord,
  mintId,
  Storyboard,
  type CardSlot,
  type Project,
  type Section,
  type Slot,
  type VoLine,
} from '@trailerforge/schema';
import { SectionLockedError } from './commands.js';
import { userEditedFields } from './user-edits.js';
import {
  convertSections,
  sectionSeconds,
  type ConvertContext,
  type Suggestion,
} from './convert.js';
import { builtinFilters, SFX_KINDS, type FilterRegistry } from '@trailerforge/effects';
import {
  generationSchemas,
  type GeneratedSection,
  type GeneratedStoryboard,
  type InstalledPicks,
} from './output.js';

export const STORYBOARD_PROMPTS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'prompts',
);

export interface GenerateDeps {
  llm: LlmClient;
  now?: () => Date;
  /** Installed transitions and effects the model may pick from (default: the built-in set). */
  filters?: FilterRegistry;
}

/** What the model may pick: ids from the installed registry, and the sounds we can make. */
function installed(deps: GenerateDeps) {
  const filters = deps.filters ?? builtinFilters();
  const picks: InstalledPicks = {
    transitions: filters.ids('transition'),
    effects: filters.ids('effect'),
    sounds: [...SFX_KINDS],
  };
  return {
    filters,
    schemas: generationSchemas(picks),
    // Shown to the model under "Transitions, effects and sounds".
    guide: [
      `Transitions (transitionIn.id): ${picks.transitions.join(', ') || '(none installed)'}`,
      `Effects (effect.id): ${picks.effects.join(', ') || '(none installed)'}`,
      `Sounds (sound.kind): ${picks.sounds.join(', ')}`,
    ].join('\n'),
  };
}

/** One decision record per suggested transition, effect or sound, with the model's reason. */
function suggestionDecisions(at: Date, suggestions: readonly Suggestion[], inputsHash: string) {
  return suggestions.map((x) =>
    decision(at, {
      step: 'core/storyboard-suggest',
      subject: { kind: 'slot', id: x.slotId },
      choice: { [x.what]: x.id },
      reasons: { what: x.what },
      summary: `Suggested ${x.what} ${x.id.replace(/^core\//, '')}: ${x.why}`,
      inputsHash: sha256(`${inputsHash}|${x.slotId}|${x.what}|${x.id}`),
    }),
  );
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

const FIXED_STRUCTURE =
  'Start from this template structure. Keep its order and roles unless the brief clearly calls for something else, and replace the generic beats with concrete moments from this game:';
const FLEXIBLE_STRUCTURE =
  'This structure is only a loose starting point. Choose the sections, how many there are and their roles to suit what the video is for, and fill them with concrete moments from this game. Keep a section with the role "hook" first:';

export interface GenerateResult {
  storyboard: Storyboard;
  decisions: DecisionRecord[];
  /** Suggestions that were dropped or simplified, for the user to see. */
  warnings: string[];
}

/**
 * Generate a full storyboard from the brief, shaped by a template. If the project already has a
 * storyboard, its locked sections are kept verbatim at their positions (and their VO lines, hit
 * points and SFX cues with them); the LLM only writes the remaining time.
 * Apply the result with `core/storyboard.set`, then append `decisions` to the decision log.
 */
const hasTakes = (slot: Slot) => slot.kind === 'shot' && slot.takes.length > 0;

/** A full regeneration would replace shots that already have recordings attached. */
export class TakesWouldBeLostError extends Error {
  constructor(readonly shots: number) {
    super(
      `${shots} shot${shots === 1 ? ' has' : 's have'} recordings attached in unlocked sections; ` +
        'lock those sections, or confirm that the recordings may be detached',
    );
    this.name = 'TakesWouldBeLostError';
  }
}

export async function generateStoryboard(
  deps: GenerateDeps,
  project: Project,
  opts: {
    template: StoryboardTemplate;
    targetDuration: number;
    /** What the video is, as the model reads it (default: the template's name). */
    videoType?: string;
    signal?: AbortSignal;
    /** Replace unlocked sections even though some of their shots have recordings attached. */
    discardTakes?: boolean;
  },
): Promise<GenerateResult> {
  const { template, targetDuration } = opts;
  const skeleton = Storyboard.parse(template.build({ targetDuration }));
  const existing = project.storyboard;
  const withTakes = (existing?.sections ?? [])
    .filter((s) => !s.locked)
    .flatMap((s) => s.slots.filter(hasTakes));
  if (withTakes.length > 0 && opts.discardTakes !== true)
    throw new TakesWouldBeLostError(withTakes.length);
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
  const inst = installed(deps);
  const prompt = await loadPrompt(
    'storyboard.generate',
    {
      videoType: opts.videoType?.trim() || template.name,
      structure: template.flexible ? FLEXIBLE_STRUCTURE : FIXED_STRUCTURE,
      targetDuration: String(targetDuration),
      budget: String(budget),
      skeleton: skeleton.sections.map((s) => outlineSection(s)).join('\n'),
      locked: locked.map(({ s }) => outlineSection(s)).join('\n') || '(none)',
      brief: ctx.brief,
      assumptions: ctx.assumptions,
      knowledge: ctx.knowledge,
      picks: inst.guide,
    },
    [STORYBOARD_PROMPTS_DIR],
  );
  const r = await deps.llm.generate(
    'storyboard.generate',
    { system, prompt, schema: inst.schemas.GeneratedStoryboard },
    opts.signal,
  );
  const gen = r.value as GeneratedStoryboard;

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
    filters: inst.filters,
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
      sfxCues: [...keptSfx, ...converted.sfxCues],
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
    ...suggestionDecisions(at, converted.suggestions, sha256(`${system}\n${prompt}`)),
  ];
  return { storyboard, decisions, warnings: converted.warnings };
}

export interface RegenerateSectionResult {
  payload: {
    sectionId: string;
    section: Section;
    voLines: VoLine[];
    sfxCues: Storyboard['music']['sfxCues'];
  };
  decisions: DecisionRecord[];
  warnings: string[];
}

/**
 * Rewrite one unlocked section in the same time it has now. Apply `payload` with
 * `core/storyboard.replace-section`, which also cleans up references to the old slots.
 */
export async function regenerateSection(
  deps: GenerateDeps,
  project: Project,
  opts: {
    sectionId: string;
    instruction?: string;
    /** What the video is, as the model reads it (default: the storyboard's video type id). */
    videoType?: string;
    /**
     * Keep slots the user edited or added by hand (default true). They stay at their positions
     * and the model writes only the rest, in the time that is left.
     */
    keepEdited?: boolean;
    signal?: AbortSignal;
  },
): Promise<RegenerateSectionResult> {
  const sb = project.storyboard;
  const target = sb?.sections.find((s) => s.id === opts.sectionId);
  if (!sb || !target) throw new Error(`no section "${opts.sectionId}"`);
  if (target.locked) throw new SectionLockedError(target.id);

  const others = sb.sections.filter((s) => s !== target);
  const free = round1(sb.meta.targetDuration - others.reduce((a, s) => a + sectionSeconds(s), 0));
  const total = sectionSeconds(target) || Math.max(free, 1);

  // Shots with recordings attached are always kept: regenerating must never drop footage.
  const pinned = target.slots
    .map((slot, index) => ({ slot, index }))
    .filter(
      ({ slot }) =>
        hasTakes(slot) || (opts.keepEdited !== false && userEditedFields(slot).length > 0),
    );
  if (pinned.length > 0 && pinned.length === target.slots.length) {
    throw new Error(
      `every slot in "${target.name}" was edited by hand or has recordings attached, so there is nothing to regenerate; ` +
        'delete the ones you do not want, or pass keepEdited: false to rewrite them all',
    );
  }
  const budget = round1(total - pinned.reduce((a, { slot }) => a + slot.duration.ideal, 0));
  if (budget < 0.1 * Math.max(1, target.slots.length - pinned.length)) {
    throw new RangeError(`the slots you edited already fill the ${total} s of "${target.name}"`);
  }

  const ctx = promptContext(project);
  const system = await systemPrompt(project);
  const inst = installed(deps);
  const prompt = await loadPrompt(
    'storyboard.regenerate-section',
    {
      videoType: opts.videoType?.trim() || sb.meta.videoTypeId,
      sectionName: target.name,
      role: target.role ?? 'unspecified',
      budget: String(budget),
      pinned:
        pinned
          .map(
            ({ slot, index }) =>
              `- #${index + 1} ${slot.title || slot.id} (${slot.kind}, ${slot.duration.ideal}s)`,
          )
          .join('\n') || '(none)',
      outline: sb.sections.map((s) => outlineSection(s, s === target)).join('\n'),
      instruction: opts.instruction?.trim() || '(nothing specific; make it stronger)',
      brief: ctx.brief,
      knowledge: ctx.knowledge,
      picks: inst.guide,
    },
    [STORYBOARD_PROMPTS_DIR],
  );
  const r = await deps.llm.generate(
    'storyboard.regenerate-section',
    { system, prompt, schema: inst.schemas.GeneratedSection },
    opts.signal,
  );
  const value = r.value as GeneratedSection;

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
  for (const { slot } of pinned) taken.add(slot.id);
  const converted = convertSections(
    [value.section],
    budget,
    { taken, entityIds: ctx.entityIds, cardTemplates: cardTemplatesOf(sb), filters: inst.filters },
    target.id,
  );
  // The role is the template's hint for this position; keep it so critique still knows it.
  const section: Section = {
    ...converted.sections[0]!,
    ...(target.role !== undefined && { role: target.role }),
  };
  // Hand-edited slots go back where they were, so the model's slots fill the gaps around them.
  for (const { slot, index } of pinned)
    section.slots.splice(Math.min(index, section.slots.length), 0, slot);

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
        pinnedSlotIds: pinned.map(({ slot }) => slot.id),
        requestedSeconds: converted.requestedSeconds,
        instruction: opts.instruction ?? null,
        replacedSlotIds: [...oldSlotIds],
      },
      summary: value.rationale,
      inputsHash: sha256(`${system}\n${prompt}`),
    }),
    ...suggestionDecisions(at, converted.suggestions, sha256(`${system}\n${prompt}`)),
  ];
  return {
    payload: {
      sectionId: target.id,
      section,
      voLines: converted.voLines,
      sfxCues: converted.sfxCues,
    },
    decisions,
    warnings: converted.warnings,
  };
}
