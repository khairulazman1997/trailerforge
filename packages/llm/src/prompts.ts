import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Built-in prompt files shipped with the package; users can override them with their own dir. */
export const BUILTIN_PROMPTS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'prompts',
);

/**
 * Load `<name>.md` from the first directory that has it and fill `{{var}}` placeholders.
 * Missing variables are an error, so a prompt edit can't silently drop context.
 */
export async function loadPrompt(
  name: string,
  vars: Record<string, string>,
  dirs: string[] = [BUILTIN_PROMPTS_DIR],
): Promise<string> {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error(`invalid prompt name: ${name}`);
  let template: string | undefined;
  for (const dir of dirs) {
    try {
      template = await readFile(join(dir, `${name}.md`), 'utf8');
      break;
    } catch {
      // try next dir
    }
  }
  if (template === undefined) throw new Error(`prompt not found: ${name}`);
  const missing = new Set<string>();
  const out = template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => {
    if (!(key in vars)) {
      missing.add(key);
      return '';
    }
    return vars[key]!;
  });
  if (missing.size)
    throw new Error(`prompt "${name}" is missing variables: ${[...missing].join(', ')}`);
  return out;
}
