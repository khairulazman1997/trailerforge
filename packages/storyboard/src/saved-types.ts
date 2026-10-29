/**
 * Saved video types: a storyboard's structure kept for reuse in other projects. Only section
 * names and roles, slot kinds and their share of the length are kept; shot text, footage and
 * names from the game never are (a section name that mentions the game becomes generic).
 */
import {
  SavedVideoType,
  type ResolvedVideoType,
  type SavedVideoTypeInput,
  type StoryboardTemplate,
  type VideoTypeDef,
} from '@trailerforge/plugin-api';
import type { Project, Storyboard } from '@trailerforge/schema';
import type { z } from 'zod';

const round1 = (n: number) => Math.round(n * 10) / 10;

/** The game's own words: its title and every knowledge entity name (also without a leading article). */
export function projectTerms(project: Project): string[] {
  const names = [project.brief.title ?? '', ...project.knowledge.map((e) => e.name)];
  const out = new Set<string>();
  for (const n of names) {
    const t = n.trim();
    if (t.length < 3) continue;
    out.add(t.toLowerCase());
    const bare = t.replace(/^(the|a|an)\s+/i, '');
    if (bare.length >= 3) out.add(bare.toLowerCase());
  }
  return [...out];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether `text` mentions any term as a whole word, ignoring case. */
export function mentionsAny(text: string, terms: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return terms.some((t) =>
    new RegExp(`(^|[^\\p{L}\\p{N}])${escape(t)}($|[^\\p{L}\\p{N}])`, 'u').test(lower),
  );
}

const genericName = (role: string | undefined, index: number) =>
  role ? role.charAt(0).toUpperCase() + role.slice(1).replace(/-/g, ' ') : `Part ${index + 1}`;

export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || 'video-type';
}

/**
 * Turn a project's storyboard into a saved video type. The brief questions come from the type
 * the project uses, minus its "describe the video" question (the description takes its place).
 */
export function savedTypeFromStoryboard(
  project: Project,
  vt: ResolvedVideoType,
  opts: { id: string; name: string; description: string; now: Date },
): SavedVideoType {
  const sb = project.storyboard;
  if (!sb || sb.sections.every((s) => s.slots.length === 0)) {
    throw new Error('this project has no storyboard to save');
  }
  const terms = projectTerms(project);
  const target = sb.meta.targetDuration;
  const input: SavedVideoTypeInput = {
    version: 1,
    id: opts.id,
    name: opts.name,
    description: opts.description,
    basedOn: vt.id,
    requirements: vt.requirements.filter((r) => r.field !== vt.describedBy),
    typicalDuration: { min: target, max: target },
    music: mentionsAny(sb.music.direction, terms) ? '' : sb.music.direction.slice(0, 500),
    sections: sb.sections
      .filter((s) => s.slots.length > 0)
      .map((s, i) => ({
        name: mentionsAny(s.name, terms) ? genericName(s.role, i) : s.name.slice(0, 80),
        ...(s.role ? { role: s.role } : {}),
        slots: s.slots.map((x) => ({
          kind: x.kind,
          share: Math.max(0.1, x.duration.ideal),
          priority: x.priority,
          ...(x.kind === 'card' ? { cardKind: x.cardKind, templateId: x.templateId } : {}),
        })),
      })),
    savedAt: opts.now.toISOString(),
  };
  return SavedVideoType.parse(input);
}

export const savedTemplateId = (typeId: string) => `${typeId}.template`;

export function savedVideoTypeDef(saved: SavedVideoType): VideoTypeDef {
  return {
    id: saved.id,
    name: saved.name,
    description: saved.description,
    requirements: saved.requirements,
    defaultTemplateId: savedTemplateId(saved.id),
    ...(saved.typicalDuration ? { typicalDuration: saved.typicalDuration } : {}),
  };
}

type StoryboardInput = z.input<typeof Storyboard>;

/** A template that lays the saved sections out over any length, each slot keeping its share. */
export function savedTemplate(saved: SavedVideoType): StoryboardTemplate {
  const id = savedTemplateId(saved.id);
  return {
    id,
    videoTypeId: saved.id,
    name: saved.name,
    ...(saved.description ? { description: saved.description } : {}),
    build: ({ targetDuration }): StoryboardInput => {
      if (!(targetDuration > 0)) throw new RangeError('targetDuration must be positive');
      const flat = saved.sections.flatMap((s) => s.slots);
      const total = flat.reduce((a, x) => a + x.share, 0);
      const ideals = flat.map((x) => round1((x.share / total) * targetDuration));
      const drift = round1(targetDuration - ideals.reduce((a, b) => a + b, 0));
      ideals[ideals.length - 1] = round1(ideals[ideals.length - 1]! + drift);
      let k = 0;
      return {
        id: 'sb_main',
        meta: { videoTypeId: saved.id, templateId: id, targetDuration },
        sections: saved.sections.map((s, i) => ({
          id: `sec_${i + 1}`,
          name: s.name,
          ...(s.role ? { role: s.role } : {}),
          purpose: '',
          slots: s.slots.map((x, j) => {
            const ideal = Math.max(0.1, ideals[k++]!);
            const base = {
              id: `s${i + 1}_${j + 1}`,
              duration: { min: round1(ideal * 0.7), ideal, max: round1(ideal * 1.4) },
              priority: x.priority,
              purpose: '',
            };
            return x.kind === 'card'
              ? {
                  ...base,
                  kind: 'card' as const,
                  cardKind: x.cardKind ?? 'custom',
                  templateId: x.templateId ?? `core/${x.cardKind ?? 'custom'}-card`,
                  title: `${x.cardKind ?? 'custom'} card`,
                }
              : { ...base, kind: 'shot' as const, title: `${s.name} shot ${j + 1}` };
          }),
        })),
        music: { direction: saved.music, structure: [], hitPoints: [], sfxCues: [] },
      };
    },
  };
}
