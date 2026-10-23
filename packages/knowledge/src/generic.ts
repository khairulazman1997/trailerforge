import { posix } from 'node:path';
import type {
  ExtractedEntity,
  KnowledgeExtractor,
  KnowledgeExtractorContext,
} from '@trailerforge/plugin-api';
import type { KnowledgeEntityKind } from '@trailerforge/schema';

type Kind = KnowledgeEntityKind;

/** Section headings / localization key prefixes that name a kind of thing. */
const KIND_WORDS: [RegExp, Kind][] = [
  [/^(boss|bosses)$/, 'boss'],
  [/^(enem(y|ies)|monsters?|creatures?|foes?)$/, 'enemy'],
  [/^(characters?|heroes?|cast|npcs?|protagonists?)$/, 'character'],
  [/^(levels?|worlds?|areas?|zones?|regions?|biomes?|maps?|stages?|locations?)$/, 'level'],
  [/^(abilit(y|ies)|skills?|powers?|spells?|moves?)$/, 'ability'],
  [/^(items?|weapons?|gear|equipment|loot|upgrades?)$/, 'item'],
  [/^(mechanics?|features?|systems?|gameplay)$/, 'mechanic'],
  [/^(quests?|missions?|chapters?)$/, 'quest'],
  [/^(cutscenes?|cinematics?)$/, 'cutscene'],
  [/^(achievements?|trophies)$/, 'achievement'],
];

/** Map a heading, folder or key segment ("Bosses", "enemy") to an entity kind. */
export function kindFromWord(word: string): Kind | null {
  const w = word
    .toLowerCase()
    .replace(/[^a-z ]/g, '')
    .trim();
  for (const [re, kind] of KIND_WORDS)
    if (re.test(w) || re.test(w.split(' ').at(-1) ?? '')) return kind;
  return null;
}

const isMarkdown = (p: string) => /\.(md|markdown|txt)$/i.test(p);
const isReadme = (p: string) => /^readme(\.[a-z]+)?$/i.test(p);
const isDesignDoc = (p: string) =>
  isMarkdown(p) &&
  (/(^|\/)(docs?|design|gdd|wiki)\//i.test(p) ||
    /(gdd|design[-_ ]?doc|game[-_ ]?design)/i.test(posix.basename(p)));
const isLocalization = (p: string) =>
  /(^|\/)(localization|localisation|locales?|i18n|lang|languages|strings)\//i.test(p) &&
  /\.(csv|json|po)$/i.test(p);
const isAchievements = (p: string) => /achievements?[^/]*\.(json|csv)$/i.test(posix.basename(p));

const clean = (s: string) =>
  s
    .replace(/\*\*|__|`/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim();

/** "Name — description", "Name: description", "**Name** - description". */
function splitItem(line: string): { name: string; description: string } | null {
  const text = clean(line);
  const m = /^(.{1,60}?)\s*(?:—|–|:|\s-\s)\s*(.+)$/.exec(text);
  const name = (m ? m[1]! : text).trim();
  if (!name || name.length > 60 || /[.!?]$/.test(name)) return null;
  return { name, description: m ? m[2]!.trim().slice(0, 300) : '' };
}

/** README: the first H1 is the game's title, the following paragraph its pitch. */
function fromReadme(path: string, text: string): ExtractedEntity[] {
  const lines = text.split(/\r?\n/);
  const h1 = lines.findIndex((l) => /^#\s+\S/.test(l));
  if (h1 < 0) return [];
  const name = clean(lines[h1]!.replace(/^#\s+/, ''));
  const para: string[] = [];
  for (const l of lines.slice(h1 + 1)) {
    if (/^\s*$/.test(l)) {
      if (para.length) break;
      continue;
    }
    if (/^(#|!\[|\[!\[|<)/.test(l)) {
      if (para.length) break;
      continue;
    }
    para.push(l.trim());
  }
  return [
    {
      kind: 'title',
      name,
      description: clean(para.join(' ')).slice(0, 400),
      sourcePaths: [path],
      confidence: 0.7,
    },
  ];
}

/**
 * Markdown design docs: under a heading that names a kind ("## Bosses"), each bullet or
 * sub-heading is one entity. Bullets are more reliable than prose, so confidence stays modest.
 */
function fromMarkdownSections(path: string, text: string): ExtractedEntity[] {
  const out: ExtractedEntity[] = [];
  let section: { kind: Kind; level: number } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*$/.exec(raw);
    if (heading) {
      const level = heading[1]!.length;
      if (section && level > section.level) {
        const item = splitItem(heading[2]!);
        if (item) out.push({ kind: section.kind, ...item, sourcePaths: [path], confidence: 0.6 });
        continue;
      }
      const kind = kindFromWord(clean(heading[2]!));
      section = kind ? { kind, level } : null;
      continue;
    }
    if (!section) continue;
    const bullet = /^\s{0,3}(?:[-*+]|\d+[.)])\s+(.+)$/.exec(raw);
    if (bullet) {
      const item = splitItem(bullet[1]!);
      if (item) out.push({ kind: section.kind, ...item, sourcePaths: [path], confidence: 0.6 });
    }
  }
  return out;
}

/** Minimal RFC 4180 CSV parser (quotes, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim()));
}

/**
 * Localization key → kind, from its segments: `boss.ash_warden.name`, `LEVEL_FOREST_TITLE`.
 * Only display names count; descriptions attach to the entity with the same stem.
 */
function classifyKey(key: string): { kind: Kind; stem: string; part: 'name' | 'desc' } | null {
  const segs = key
    .toLowerCase()
    .split(/[._\-/:]+/)
    .filter(Boolean);
  const last = segs.at(-1) ?? '';
  const part = /^(name|title|displayname)$/.test(last)
    ? 'name'
    : /^(desc|description|tooltip)$/.test(last)
      ? 'desc'
      : null;
  if (!part) return null;
  for (const s of segs.slice(0, -1)) {
    const kind = kindFromWord(s);
    if (kind) return { kind, stem: segs.slice(0, -1).join('.'), part };
  }
  return null;
}

function fromKeyValues(path: string, pairs: [string, string][]): ExtractedEntity[] {
  const byStem = new Map<string, { kind: Kind; name?: string; description?: string }>();
  for (const [key, value] of pairs) {
    const c = classifyKey(key);
    if (!c || !value.trim()) continue;
    const e = byStem.get(c.stem) ?? { kind: c.kind };
    if (c.part === 'name') e.name = value.trim();
    else e.description = value.trim();
    byStem.set(c.stem, e);
  }
  return [...byStem.values()]
    .filter((e): e is { kind: Kind; name: string; description?: string } => !!e.name)
    .map((e) => ({
      kind: e.kind,
      name: e.name,
      description: e.description?.slice(0, 300) ?? '',
      sourcePaths: [path],
      confidence: 0.8,
    }));
}

const ENGLISH = /^(en|en[-_](us|gb)|english|text|value|source)$/i;

function localizationPairs(path: string, text: string): [string, string][] {
  if (/\.csv$/i.test(path)) {
    const [header, ...rows] = parseCsv(text);
    if (!header) return [];
    const keyCol = header.findIndex((h) => /^(key|id|term|name)$/i.test(h.trim()));
    const valCol = header.findIndex((h, i) => i !== keyCol && ENGLISH.test(h.trim()));
    if (keyCol < 0 || valCol < 0) return [];
    return rows.map((r) => [r[keyCol] ?? '', r[valCol] ?? '']);
  }
  if (/\.json$/i.test(path)) {
    // Only English (or language-neutral) files: en.json, strings.json, Localization/en/...
    if (
      !/(^|\/|[._-])en([._-]|\/|\.json$)|strings|english/i.test(path) &&
      /(^|\/)[a-z]{2}([-_][a-z]{2})?\.json$/i.test(path)
    )
      return [];
    const out: [string, string][] = [];
    const walk = (v: unknown, prefix: string) => {
      if (typeof v === 'string') out.push([prefix, v]);
      else if (v && typeof v === 'object' && !Array.isArray(v))
        for (const [k, x] of Object.entries(v)) walk(x, prefix ? `${prefix}.${k}` : k);
    };
    try {
      walk(JSON.parse(text), '');
    } catch {
      return [];
    }
    return out;
  }
  // .po: msgctxt carries the key; msgid is the English source text.
  const out: [string, string][] = [];
  let ctx = '';
  for (const line of text.split(/\r?\n/)) {
    const m = /^(msgctxt|msgid)\s+"(.*)"\s*$/.exec(line);
    if (!m) continue;
    if (m[1] === 'msgctxt') ctx = m[2]!;
    else if (ctx) {
      out.push([ctx, m[2]!.replace(/\\"/g, '"')]);
      ctx = '';
    }
  }
  return out;
}

function fromAchievements(path: string, text: string): ExtractedEntity[] {
  let rows: Record<string, string>[] = [];
  if (/\.csv$/i.test(path)) {
    const [header, ...data] = parseCsv(text);
    if (header)
      rows = data.map((r) =>
        Object.fromEntries(header.map((h, i) => [h.trim().toLowerCase(), r[i] ?? ''])),
      );
  } else {
    try {
      const v: unknown = JSON.parse(text);
      const list = Array.isArray(v)
        ? v
        : v && typeof v === 'object'
          ? (Object.values(v).find(Array.isArray) ?? [])
          : [];
      rows = (list as unknown[])
        .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
        .map((x) =>
          Object.fromEntries(
            Object.entries(x).map(([k, val]) => [
              k.toLowerCase(),
              typeof val === 'string' ? val : '',
            ]),
          ),
        );
    } catch {
      return [];
    }
  }
  return rows.flatMap((r) => {
    const name = r.displayname || r.display_name || r.title || r.name;
    if (!name?.trim()) return [];
    const description = r.description || r.desc || '';
    return [
      {
        kind: 'achievement' as const,
        name: name.trim(),
        description: description.trim().slice(0, 300),
        sourcePaths: [path],
        confidence: 0.9,
      },
    ];
  });
}

/** Merge duplicates by kind + name; keep the best description and the highest confidence. */
export function dedupe(entities: ExtractedEntity[]): ExtractedEntity[] {
  const map = new Map<string, ExtractedEntity>();
  for (const e of entities) {
    const key = `${e.kind}\0${e.name.toLowerCase()}`;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { ...e, sourcePaths: [...e.sourcePaths] });
      continue;
    }
    prev.confidence = Math.max(prev.confidence, e.confidence);
    if (e.description && e.description.length > (prev.description?.length ?? 0))
      prev.description = e.description;
    for (const p of e.sourcePaths) if (!prev.sourcePaths.includes(p)) prev.sourcePaths.push(p);
  }
  return [...map.values()];
}

const MAX_ENTITIES = 1000;

/** Engine-agnostic extractor: README, design docs, localization tables, achievement lists. */
export const genericExtractor: KnowledgeExtractor = {
  id: 'core/generic',
  name: 'Docs, localization and achievements',
  async detect() {
    return 0.5;
  },
  async extract(ctx: KnowledgeExtractorContext) {
    const out: ExtractedEntity[] = [];
    for (const path of ctx.files) {
      ctx.signal.throwIfAborted();
      const read = () => ctx.readText(path);
      if (isReadme(path)) out.push(...fromReadme(path, await read()));
      if (isDesignDoc(path) || isReadme(path))
        out.push(...fromMarkdownSections(path, await read()));
      else if (isAchievements(path)) out.push(...fromAchievements(path, await read()));
      else if (isLocalization(path))
        out.push(...fromKeyValues(path, localizationPairs(path, await read())));
    }
    return dedupe(out).slice(0, MAX_ENTITIES);
  },
};
