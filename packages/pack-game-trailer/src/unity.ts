import { posix } from 'node:path';
import { kindFromWord, unionTags } from '@trailerforge/knowledge';
import type {
  ExtractedEntity,
  KnowledgeExtractor,
  KnowledgeExtractorContext,
} from '@trailerforge/plugin-api';
import type { KnowledgeEntityKind } from '@trailerforge/schema';
import { fromScripts, type SaveLocation } from './unity-csharp.js';

type Kind = KnowledgeEntityKind;

const PROJECT_SETTINGS = 'ProjectSettings/ProjectSettings.asset';
const BUILD_SETTINGS = 'ProjectSettings/EditorBuildSettings.asset';
const MAX_ENTITIES = 500;

/** Scenes that exist for plumbing, not to be shown in a trailer. */
const PLUMBING_SCENE =
  /^(boot|bootstrap|init|initial|loading|loader|splash|persistent|empty|test|sandbox|debug|menu|mainmenu|title)/i;
const NAME_SUFFIX = /(Data|Def|Definition|Config|Settings|Stats|SO)$/;
const NAME_PREFIX = /^(SO|SD|Data|Def)[_-]/;

/** "AshWarden" / "ash_warden" / "SO_AshWardenData" → "Ash Warden". */
export function humanize(raw: string): string {
  let s = raw.replace(NAME_PREFIX, '');
  const stripped = s.replace(NAME_SUFFIX, '');
  if (stripped.length >= 2) s = stripped;
  return s
    .replace(/[_\-.]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(^|\s)([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase());
}

/** Unity writes non-ASCII in double-quoted YAML scalars as \uXXXX escapes. */
function scalar(raw: string): string {
  let v = raw.trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    v = v
      .slice(1, -1)
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\n/g, ' ')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  } else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) {
    v = v.slice(1, -1).replace(/''/g, "'");
  }
  return v.trim();
}

/** Top-level `  key: value` fields of a Unity YAML document, first occurrence wins. */
function fields(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^ {2}([A-Za-z_][\w]*): ?(.*)$/.exec(line);
    if (m && !out.has(m[1]!)) out.set(m[1]!, m[2]!);
  }
  return out;
}

const pick = (f: Map<string, string>, keys: string[]) => {
  for (const k of keys) {
    const v = f.get(k);
    if (v !== undefined && scalar(v)) return scalar(v);
  }
  return '';
};

/** Folder names above the file, nearest first, that name a kind of thing (never "mechanic"). */
function kindFromPath(path: string): Kind | null {
  const dirs = posix.dirname(path).split('/').reverse();
  for (const d of dirs) {
    const k = kindFromWord(d);
    if (k && k !== 'mechanic') return k;
  }
  return null;
}

function fromProjectSettings(text: string): ExtractedEntity[] {
  const f = fields(text);
  const name = pick(f, ['productName']);
  if (!name) return [];
  const company = pick(f, ['companyName']);
  return [
    {
      kind: 'title',
      name,
      description: company ? `By ${company}` : '',
      sourcePaths: [PROJECT_SETTINGS],
      confidence: 0.9,
    },
  ];
}

/** Company and product name, which Unity uses for `persistentDataPath` and PlayerPrefs. */
function saveLocationOf(text: string): SaveLocation | null {
  const f = fields(text);
  const company = pick(f, ['companyName']);
  const product = pick(f, ['productName']);
  return company && product ? { company, product } : null;
}

function sceneEntity(path: string, confidence: number): ExtractedEntity | null {
  const base = posix.basename(path, '.unity');
  if (PLUMBING_SCENE.test(base)) return null;
  const name = humanize(base);
  return name ? { kind: 'level', name, sourcePaths: [path], confidence } : null;
}

/** Enabled scenes from EditorBuildSettings are the shipped levels. */
function fromBuildScenes(text: string): ExtractedEntity[] {
  const out: ExtractedEntity[] = [];
  for (const m of text.matchAll(/- enabled: (\d)\s*\r?\n\s*path: (.+?)\r?\n/g)) {
    if (m[1] !== '1') continue;
    const path = m[2]!.trim();
    if (!path.endsWith('.unity')) continue;
    const e = sceneEntity(path, 0.85);
    if (e) out.push({ ...e, sourcePaths: [BUILD_SETTINGS, path] });
  }
  return out;
}

/** ScriptableObject assets are data definitions; the folder says what kind of thing they define. */
function fromScriptableObject(path: string, text: string): ExtractedEntity | null {
  if (!text.includes('MonoBehaviour:')) return null;
  const kind = kindFromPath(path);
  if (!kind) return null;
  const f = fields(text);
  const display = pick(f, [
    'displayName',
    'm_DisplayName',
    'DisplayName',
    'title',
    'Title',
    'itemName',
    'characterName',
  ]);
  const name = display || humanize(pick(f, ['m_Name']) || posix.basename(path, '.asset'));
  if (!name) return null;
  const description = pick(f, [
    'description',
    'Description',
    'm_Description',
    'flavorText',
    'summary',
    'lore',
  ]);
  return {
    kind,
    name,
    description: description.slice(0, 300),
    sourcePaths: [path],
    confidence: display ? 0.85 : 0.65,
  };
}

/** Prefabs only count when they sit in a folder that says what they are. */
function fromPrefab(path: string): ExtractedEntity | null {
  const kind = kindFromPath(path);
  if (!kind || kind === 'level') return null;
  const name = humanize(posix.basename(path, '.prefab'));
  return name ? { kind, name, sourcePaths: [path], confidence: 0.5 } : null;
}

function mergeByName(entities: ExtractedEntity[]): ExtractedEntity[] {
  const map = new Map<string, ExtractedEntity>();
  for (const e of entities) {
    const key = `${e.kind}\0${e.name.toLowerCase()}`;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, {
        ...e,
        sourcePaths: [...e.sourcePaths],
        ...(e.tags ? { tags: [...e.tags] } : {}),
      });
      continue;
    }
    prev.confidence = Math.max(prev.confidence, e.confidence);
    if (e.description && e.description.length > (prev.description?.length ?? 0))
      prev.description = e.description;
    for (const p of e.sourcePaths) if (!prev.sourcePaths.includes(p)) prev.sourcePaths.push(p);
    if (e.tags?.length) prev.tags = unionTags(prev.tags ?? [], e.tags);
  }
  return [...map.values()];
}

/**
 * Unity projects (text-serialized assets): product name, build scenes as levels, and
 * ScriptableObject / prefab names classified by the folder they live in. Reads only files the
 * scanner accepted, so binary-serialized projects simply yield less. C# scripts give debug-console
 * commands and save locations for capture setup hints (`unity-csharp.ts`).
 */
export const unityExtractor: KnowledgeExtractor = {
  id: 'game-trailer/unity',
  name: 'Unity project',
  async detect({ files }: Pick<KnowledgeExtractorContext, 'root' | 'files'>) {
    if (files.includes(PROJECT_SETTINGS) || files.includes('ProjectSettings/ProjectVersion.txt'))
      return 0.95;
    return files.some((f) => f.startsWith('Assets/') && f.endsWith('.unity')) ? 0.6 : 0;
  },
  async extract(ctx) {
    const have = new Set(ctx.files);
    const out: ExtractedEntity[] = [];
    let saveLocation: SaveLocation | null = null;
    if (have.has(PROJECT_SETTINGS)) {
      const text = await ctx.readText(PROJECT_SETTINGS);
      out.push(...fromProjectSettings(text));
      saveLocation = saveLocationOf(text);
    }

    const buildScenes = have.has(BUILD_SETTINGS)
      ? fromBuildScenes(await ctx.readText(BUILD_SETTINGS))
      : [];
    out.push(...buildScenes);
    if (buildScenes.length === 0) {
      // No build list: fall back to every scene under Assets/, with less confidence.
      for (const f of ctx.files) {
        if (f.startsWith('Assets/') && f.endsWith('.unity')) {
          const e = sceneEntity(f, 0.45);
          if (e) out.push(e);
        }
      }
    }

    for (const path of ctx.files) {
      ctx.signal.throwIfAborted();
      if (!path.startsWith('Assets/')) continue;
      if (path.endsWith('.asset')) {
        const e = fromScriptableObject(path, await ctx.readText(path));
        if (e) out.push(e);
      } else if (path.endsWith('.prefab')) {
        const e = fromPrefab(path);
        if (e) out.push(e);
      }
    }
    // Scripts last: the MAX_ENTITIES cap then drops hints before levels and bosses.
    out.push(...(await fromScripts(ctx.files, (p) => ctx.readText(p), saveLocation, ctx.signal)));
    return mergeByName(out).slice(0, MAX_ENTITIES);
  },
};
