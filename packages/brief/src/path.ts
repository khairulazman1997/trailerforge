/**
 * Tiny path language for requirements and answers, rooted at the project:
 *   brief.title · formatTargets · brief.extensions.game-trailer.genre
 *   brief.keyDates[label=Release].date   (select the array entry whose `label` is "Release")
 */
export interface PathSegment {
  key: string;
  filter?: { field: string; value: string };
}

export function parsePath(path: string): PathSegment[] {
  const segments: PathSegment[] = [];
  const re = /([^.[\]]+)(?:\[([^=\]]+)=([^\]]*)\])?(?:\.|$)/y;
  let m: RegExpExecArray | null;
  while (re.lastIndex < path.length && (m = re.exec(path))) {
    segments.push(
      m[2] !== undefined ? { key: m[1]!, filter: { field: m[2], value: m[3]! } } : { key: m[1]! },
    );
  }
  if (segments.length === 0 || re.lastIndex !== path.length)
    throw new Error(`invalid path: ${path}`);
  return segments;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export function getAt(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of parsePath(path)) {
    if (!isObj(cur)) return undefined;
    cur = cur[seg.key];
    if (seg.filter) {
      if (!Array.isArray(cur)) return undefined;
      const { field, value } = seg.filter;
      cur = cur.find((e) => isObj(e) && e[field] === value);
    }
  }
  return cur;
}

/**
 * Set a value, creating missing objects. A `[field=value]` segment updates the matching array
 * entry, or appends `{ [field]: value }` first. Works on Immer drafts.
 */
export function setAt(root: Obj, path: string, value: unknown): void {
  const segs = parsePath(path);
  let cur: Obj = root;
  segs.forEach((seg, i) => {
    const last = i === segs.length - 1;
    if (!seg.filter) {
      if (last) {
        if (value === undefined) delete cur[seg.key];
        else cur[seg.key] = value;
        return;
      }
      if (!isObj(cur[seg.key])) cur[seg.key] = {};
      cur = cur[seg.key] as Obj;
      return;
    }
    if (!Array.isArray(cur[seg.key])) cur[seg.key] = [];
    const arr = cur[seg.key] as unknown[];
    const { field, value: match } = seg.filter;
    let entry = arr.find((e) => isObj(e) && e[field] === match) as Obj | undefined;
    if (last) {
      if (value === undefined) {
        const idx = arr.indexOf(entry);
        if (idx !== -1) arr.splice(idx, 1);
      } else if (entry) arr[arr.indexOf(entry)] = { ...(value as Obj), [field]: match };
      else arr.push({ ...(value as Obj), [field]: match });
      return;
    }
    if (!entry) {
      entry = { [field]: match };
      arr.push(entry);
      entry = arr[arr.length - 1] as Obj; // the draft proxy, when used with Immer
    }
    cur = entry;
  });
}
