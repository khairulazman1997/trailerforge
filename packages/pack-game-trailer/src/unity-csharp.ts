import type { ExtractedEntity } from '@trailerforge/plugin-api';
import { ALL_GROUPS_TAG, DEBUG_COMMAND_TAG, SAVE_FILE_TAG } from './capture-hints.js';

/**
 * Reads C# scripts for capture setup hints: debug-console commands and where the game saves.
 * Local, regex-only and bounded: comments are blanked with a linear lexer, every pattern has
 * capped repetition, and the output holds only command names, parameter names, class/method
 * names and short file names, never source text or other string contents.
 */

export const MAX_CS_FILES = 3000;
const MAX_COMMANDS = 150;
const MAX_SAVES = 20;

/** Third-party consoles and samples ship their own built-in commands; they are noise here. */
const SKIP_DIR =
  /^(plugins|thirdparty|third party|third-party|samples|tests?|editor|ingamedebugconsole|qfsw|srdebugger|stompyrobot)$/i;

export function isGameScript(path: string): boolean {
  if (!path.startsWith('Assets/') || !path.endsWith('.cs')) return false;
  return !path
    .split('/')
    .slice(1, -1)
    .some((d) => SKIP_DIR.test(d));
}

/**
 * Replaces comments with spaces (newlines kept) and leaves string and char literals intact, so
 * `"http://x"` is not a comment and `// [Command("x")]` is not code. Handles regular, verbatim
 * (`@"..."`, `""` escapes) and interpolated strings. One pass, linear time.
 */
export function stripComments(src: string): string {
  const out: string[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') {
        out.push(' ');
        i++;
      }
    } else if (c === '/' && next === '*') {
      out.push('  ');
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out.push(src[i] === '\n' ? '\n' : ' ');
        i++;
      }
      if (i < n) {
        out.push('  ');
        i += 2;
      }
    } else if (
      c === '"' ||
      ((c === '@' || c === '$') && (next === '"' || next === '@' || next === '$'))
    ) {
      // Prefixes: @ or $ or both, then the opening quote.
      let verbatim = false;
      while (src[i] === '@' || src[i] === '$') {
        if (src[i] === '@') verbatim = true;
        out.push(src[i]!);
        i++;
      }
      if (src[i] !== '"') continue;
      out.push('"');
      i++;
      while (i < n) {
        const ch = src[i]!;
        if (verbatim && ch === '"' && src[i + 1] === '"') {
          out.push('""');
          i += 2;
        } else if (!verbatim && ch === '\\' && i + 1 < n) {
          out.push(ch, src[i + 1]!);
          i += 2;
        } else if (ch === '"') {
          out.push('"');
          i++;
          break;
        } else if (!verbatim && ch === '\n') {
          break; // unterminated: stop at the line end
        } else {
          out.push(ch);
          i++;
        }
      }
    } else if (c === "'") {
      // Char literal: at most an escape and a char before the closing quote.
      const end = src.indexOf("'", i + (src[i + 1] === '\\' ? 3 : 2));
      const stop = end >= 0 && end - i <= 8 ? end + 1 : i + 1;
      out.push(src.slice(i, stop));
      i = stop;
    } else {
      out.push(c);
      i++;
    }
  }
  return out.join('');
}

/** Attributes the common debug consoles use (IngameDebugConsole, Quantum Console, custom). */
const ATTRIBUTE =
  /(?<![\w\])])\[\s*(?:[A-Za-z_][\w]{0,40}\.){0,3}(ConsoleMethod|ConsoleCommand|Command|CheatCommand|Cheat|DebugCommand)(?:Attribute)?\s*(?:\(([^()\]]{0,300})\))?\s*\]/g;
/** Runtime registration, e.g. IngameDebugConsole `DebugLogConsole.AddCommand<int>("name", ...)`. */
const ADD_COMMAND =
  /\bAddCommand(?:Instance|Static)?\s*(?:<[^<>()]{0,80}>)?\s*\(\s*"([^"\\\n]{1,40})"/g;
/** The member an attribute sits on: a method `Name(params) {|=>|;` or a field/property. */
const METHOD =
  /^\s*(?:\[[^\]]{0,300}\]\s*){0,5}[\w<>[\],.?\s]{0,120}?\b([A-Za-z_]\w{0,60})\s*\(([^()]{0,300})\)\s*(?:\{|=>|;|where\b)/;
const MEMBER =
  /^\s*(?:\[[^\]]{0,300}\]\s*){0,5}[\w<>[\],.?\s]{0,120}?\b([A-Za-z_]\w{0,60})\s*(?:\{|=|;)/;
const COMMAND_NAME = /^[A-Za-z][\w.-]{0,39}$/;
const FIRST_STRING = /^\s*"([^"\\\n]{1,40})"/;
/** Networking libraries use `[Command]` for RPCs, not console commands. */
const NETWORKING = /\busing\s+(?:Mirror|FishNet|Unity\.Netcode|Photon)\b/;

/** Finds the enclosing class name at an index; positions are indexed once per file. */
function classIndex(code: string): (index: number) => string {
  const marks = [...code.matchAll(/\b(?:class|struct)\s+([A-Za-z_]\w{0,60})/g)].map(
    (m) => [m.index, m[1]!] as const,
  );
  return (index) => {
    let name = '';
    for (const [at, n] of marks) {
      if (at >= index) break;
      name = n;
    }
    return name;
  };
}

/** `int phase, bool hard = false` → `<phase> <hard>`. */
function paramUsage(params: string): string {
  const names: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of `${params},`) {
    if (ch === '<' || ch === '(' || ch === '[') depth++;
    if (ch === '>' || ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth <= 0) {
      const decl = current.split('=')[0]!.trim();
      const m = /([A-Za-z_]\w{0,40})\s*$/.exec(decl);
      if (m) names.push(`<${m[1]}>`);
      current = '';
    } else current += ch;
  }
  return names.slice(0, 6).join(' ');
}

const commandEntity = (
  name: string,
  where: string,
  usage: string,
  path: string,
  confidence: number,
): ExtractedEntity => ({
  kind: 'other',
  name,
  description: `Debug console command: \`${[name, usage].filter(Boolean).join(' ')}\`${where ? ` (${where})` : ''}`,
  sourcePaths: [path],
  confidence,
  tags: [DEBUG_COMMAND_TAG, ALL_GROUPS_TAG],
});

export function debugCommandsIn(path: string, code: string): ExtractedEntity[] {
  const out: ExtractedEntity[] = [];
  const networked = NETWORKING.test(code);
  const classAt = classIndex(code);
  for (const m of code.matchAll(ATTRIBUTE)) {
    const attr = m[1]!;
    if (attr === 'Command' && networked) continue;
    const after = code.slice(m.index + m[0].length, m.index + m[0].length + 800);
    const method = METHOD.exec(after);
    const member = method ?? MEMBER.exec(after);
    const memberName = member?.[1] ?? '';
    if (attr === 'Command' && memberName.startsWith('Cmd')) continue; // RPC naming convention
    const explicit = FIRST_STRING.exec(m[2] ?? '')?.[1];
    const name = explicit ?? memberName;
    if (!COMMAND_NAME.test(name)) continue;
    const cls = classAt(m.index);
    const where = [cls, memberName].filter(Boolean).join('.');
    out.push(
      commandEntity(name, where, method ? paramUsage(method[2]!) : '', path, explicit ? 0.85 : 0.7),
    );
  }
  for (const m of code.matchAll(ADD_COMMAND)) {
    const name = m[1]!;
    if (!COMMAND_NAME.test(name)) continue;
    out.push(commandEntity(name, classAt(m.index), '', path, 0.8));
  }
  return out;
}

export interface SaveLocation {
  company: string;
  product: string;
}

/** Short save-file names in string literals (one leading separator allowed): no paths, a save-like extension. */
const SAVE_FILE =
  /"(?:\/|\\\\)?([A-Za-z0-9_][A-Za-z0-9_\-. ]{0,39}\.(?:sav|save|dat|json|bin|es3|xml))"/gi;

const persistentDir = (loc: SaveLocation | null): string =>
  loc ? `%USERPROFILE%\\AppData\\LocalLow\\${loc.company}\\${loc.product}` : '<persistentDataPath>';

const saveEntity = (
  name: string,
  description: string,
  path: string,
  confidence: number,
): ExtractedEntity => ({
  kind: 'other',
  name,
  description,
  sourcePaths: [path],
  confidence,
  tags: [SAVE_FILE_TAG, ALL_GROUPS_TAG],
});

export function saveFilesIn(
  path: string,
  code: string,
  loc: SaveLocation | null,
): ExtractedEntity[] {
  const out: ExtractedEntity[] = [];
  const dir = persistentDir(loc);
  if (/\bpersistentDataPath\b/.test(code)) {
    const files = [...new Set([...code.matchAll(SAVE_FILE)].map((m) => m[1]!.trim()))];
    for (const f of files) out.push(saveEntity(f, `Windows: ${dir}\\${f}`, path, 0.6));
    if (files.length === 0) out.push(saveEntity('Save folder', `Windows: ${dir}`, path, 0.5));
  }
  if (/\bES3\s*\.\s*(?:Save|Load|KeyExists)\b/.test(code)) {
    // Easy Save writes SaveFile.es3 under persistentDataPath unless told otherwise.
    out.push(
      saveEntity('SaveFile.es3', `Windows: ${dir}\\SaveFile.es3 (Easy Save default)`, path, 0.6),
    );
  }
  if (/\bPlayerPrefs\s*\.\s*Set(?:Int|Float|String)\b/.test(code)) {
    const key = loc
      ? `HKEY_CURRENT_USER\\Software\\${loc.company}\\${loc.product}`
      : 'the registry';
    out.push(saveEntity('PlayerPrefs (registry)', `Windows: ${key}`, path, 0.5));
  }
  return out;
}

/** Scans the game's own scripts, in path order, within the caps. */
export async function fromScripts(
  files: readonly string[],
  readText: (path: string) => Promise<string>,
  loc: SaveLocation | null,
  signal: AbortSignal,
): Promise<ExtractedEntity[]> {
  const scripts = files.filter(isGameScript).sort().slice(0, MAX_CS_FILES);
  const commands: ExtractedEntity[] = [];
  const saves: ExtractedEntity[] = [];
  for (const path of scripts) {
    signal.throwIfAborted();
    let text: string;
    try {
      text = await readText(path);
    } catch {
      continue; // over the size cap or unreadable: skip, never fail the scan
    }
    const code = stripComments(text);
    if (commands.length < MAX_COMMANDS) commands.push(...debugCommandsIn(path, code));
    if (saves.length < MAX_SAVES) saves.push(...saveFilesIn(path, code, loc));
  }
  return [...commands.slice(0, MAX_COMMANDS), ...saves.slice(0, MAX_SAVES)];
}
