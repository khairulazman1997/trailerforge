import {
  FLICKS_PER_SECOND,
  itemEnd,
  timelineDuration,
  type Rate,
  type Timeline,
  type TimelineItem,
  type Track,
  type Transition,
} from '@trailerforge/schema';
import { crossTransitions, type SourceMedia } from './compile.js';

/**
 * Handing a version to an editor (NLE): FCPXML 1.10 (DaVinci Resolve, Final Cut Pro, Premiere's
 * FCPXML import), OpenTimelineIO JSON and CMX3600 EDL (one picture track, lossy). Pure: the same
 * timeline gives the same text. Media is referenced where it is (absolute `file://` URLs, never
 * copied); cards and captions point at ProRes 4444 clips with alpha rendered beforehand
 * (`encodeAlphaClip` in `@trailerforge/render`), else they become named gaps. Times are whole
 * frames of the timeline rate. Transitions become the editor's cross dissolve; effects, J/L
 * cuts and volume automation are carried as markers or notes so nothing is silently lost.
 */

export interface HandoffInput {
  timeline: Timeline;
  /** Name shown in the editor (project and sequence). */
  name: string;
  sources: ReadonlyMap<string, SourceMedia>;
  /** Rendered card/caption clips by item id: a `.mov` with alpha. */
  graphics?: ReadonlyMap<string, { path: string; frames: number }>;
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : Math.abs(a));

/** Frames of the timeline rate for a flick position. */
const framesOf = (fl: number, r: Rate) => Math.round((fl * r.num) / (r.den * FLICKS_PER_SECOND));

/** A `file://` URL for a local path (Windows drive paths and spaces included). */
export function fileUrl(path: string): string {
  const p = path.replace(/\\/g, '/');
  const abs = /^[A-Za-z]:\//.test(p) ? `/${p}` : p;
  return `file://${abs
    .split('/')
    .map((s, i) => (i === 1 && /^[A-Za-z]:$/.test(s) ? s : encodeURIComponent(s)))
    .join('/')}`;
}

const baseName = (path: string) => path.replace(/\\/g, '/').split('/').pop() ?? path;

const xml = (s: string) =>
  s.replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!,
  );

const itemName = (it: TimelineItem, input: HandoffInput): string => {
  if (it.label) return it.label;
  if (it.kind === 'clip') {
    const src = input.sources.get(it.assetId);
    return src ? baseName(src.path) : it.assetId;
  }
  if (it.kind === 'placeholder') return `Missing: ${it.note || it.slotId || it.id}`;
  if (it.kind === 'caption') return it.text;
  if (it.kind === 'graphic') return String(it.params.text ?? it.templateId);
  return it.id;
};

/** Effects and audio settings an editor cannot read from the clip itself. */
function notesOf(it: TimelineItem): string[] {
  const out: string[] = [];
  if ('effects' in it)
    for (const e of it.effects)
      if (e.enabled) out.push(`Effect: ${e.effectId} ${JSON.stringify(e.params)}`);
  if (it.kind === 'clip') {
    if (typeof it.gainDb !== 'number')
      out.push('Volume automation (ducks or fades) in TrailerForge');
    else if (it.gainDb !== 0) out.push(`Gain ${it.gainDb} dB`);
    const ca = (
      it.extensions.core as
        { clipAudio?: { enabled?: boolean; lead?: number; lag?: number } } | undefined
    )?.clipAudio;
    if (ca?.enabled)
      out.push(
        `Clip sound on; J ${(ca.lead ?? 0) / FLICKS_PER_SECOND} s, L ${(ca.lag ?? 0) / FLICKS_PER_SECOND} s`,
      );
    if (it.speed !== 1) out.push(`Speed ${it.speed}x`);
    if (it.transform && JSON.stringify(it.transform.crop) !== '[0,0,0,0]')
      out.push('Reframed (crop) in TrailerForge');
  }
  return out;
}

interface Split {
  d: number;
  headB: number;
  tailA: number;
}
const splitOf = (t: Transition, r: Rate): Split => {
  const d = Math.max(1, framesOf(t.duration, r));
  const tailA = Math.floor(d / 2);
  return { d, tailA, headB: d - tailA };
};

/** Tracks with the cross-track card transitions folded in (as the renderer draws them). */
function flatten(tl: Timeline): Track[] {
  const tracks = tl.tracks.map((t) => ({
    ...t,
    items: [...t.items],
    transitions: [...t.transitions],
  }));
  const base = tracks.find((t) => t.kind === 'video' && !t.muted);
  for (const x of crossTransitions(tl)) {
    if (!base) break;
    const owner = tracks.find(
      (t) => t !== base && t.items.some((i) => i.id === x.fromItemId || i.id === x.toItemId),
    );
    const card = owner?.items.find(
      (i) => (i.id === x.fromItemId || i.id === x.toItemId) && i.kind === 'graphic',
    );
    if (!owner || !card) continue;
    if (base.items.some((i) => i.start < itemEnd(card) && itemEnd(i) > card.start)) continue;
    owner.items = owner.items.filter((i) => i !== card);
    base.items.push(card);
    base.transitions.push(x);
  }
  for (const t of tracks) t.items.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
  return tracks.filter((t) => !t.muted);
}

// -- FCPXML 1.10 ----------------------------------------------------------------------------------

export function toFcpxml(input: HandoffInput): string {
  const { timeline: tl } = input;
  const r = tl.frameRate;
  const t = (frames: number) => {
    if (frames === 0) return '0s';
    const a = frames * r.den;
    const g = gcd(a, r.num);
    return r.num / g === 1 ? `${a / g}s` : `${a / g}/${r.num / g}s`;
  };
  const total = framesOf(timelineDuration(tl), r);
  const tracks = flatten(tl);
  const base = tracks.find((k) => k.kind === 'video');
  const others = tracks.filter((k) => k !== base);

  // Resources: one format, one asset per recording or rendered graphic, in order of use.
  const assets = new Map<string, { id: string; xml: string }>();
  const assetFor = (it: TimelineItem): string | undefined => {
    if (it.kind === 'clip') {
      const src = input.sources.get(it.assetId);
      if (!src) return undefined;
      const key = `a:${it.assetId}`;
      if (!assets.has(key)) {
        const id = `r${assets.size + 2}`;
        const dur = Math.round((src.duration * r.num) / r.den);
        const video = src.width > 0;
        assets.set(key, {
          id,
          xml: `<asset id="${id}" name="${xml(baseName(src.path))}" start="0s" duration="${t(dur)}" hasVideo="${video ? 1 : 0}" hasAudio="${src.hasAudio ? 1 : 0}"${video ? ' format="r1"' : ''}${src.hasAudio ? ' audioSources="1" audioChannels="2" audioRate="48000"' : ''}><media-rep kind="original-media" src="${xml(fileUrl(src.path))}"/></asset>`,
        });
      }
      return assets.get(key)!.id;
    }
    const g = input.graphics?.get(it.id);
    if (!g) return undefined;
    const key = `g:${it.id}`;
    if (!assets.has(key)) {
      const id = `r${assets.size + 2}`;
      assets.set(key, {
        id,
        xml: `<asset id="${id}" name="${xml(baseName(g.path))}" start="0s" duration="${t(g.frames)}" hasVideo="1" hasAudio="0" format="r1"><media-rep kind="original-media" src="${xml(fileUrl(g.path))}"/></asset>`,
      });
    }
    return assets.get(key)!.id;
  };

  // The primary storyline: the bottom picture track, gaps filled, running to the end.
  interface El {
    offset: number;
    duration: number;
    start: number;
    open: string;
    close: string;
    children: string[];
    item?: TimelineItem;
  }
  const spine: El[] = [];
  const gap = (offset: number, duration: number, name = 'Gap'): El => ({
    offset,
    duration,
    start: 0,
    open: `<gap name="${xml(name)}" offset="${t(offset)}" start="0s" duration="${t(duration)}"`,
    close: '</gap>',
    children: [],
  });
  const clipEl = (
    it: TimelineItem,
    offset: number,
    duration: number,
    lane?: number,
    role?: string,
  ): El => {
    const ref = assetFor(it);
    const lanes = lane !== undefined ? ` lane="${lane}"` : '';
    if (!ref || it.kind === 'placeholder' || it.kind === 'sequence') {
      const el = gap(offset, duration, itemName(it, input));
      if (lane !== undefined) el.open = el.open.replace('<gap ', `<gap${lanes} `);
      el.item = it;
      return el;
    }
    const start = it.kind === 'clip' ? framesOf(it.sourceIn, r) : 0;
    const audioOnly = it.kind === 'clip' && (input.sources.get(it.assetId)?.width ?? 1) === 0;
    return {
      offset,
      duration,
      start,
      open: `<asset-clip ref="${ref}"${lanes} offset="${t(offset)}" name="${xml(itemName(it, input))}" start="${t(start)}" duration="${t(duration)}"${audioOnly && role ? ` audioRole="${role}"` : ''}`,
      close: '</asset-clip>',
      children: [],
      item: it,
    };
  };
  let cursor = 0;
  const transitionsXml: { before: number; xml: string }[] = [];
  for (const it of base?.items ?? []) {
    const s = framesOf(it.start, r);
    const e = framesOf(itemEnd(it), r);
    if (e <= s) continue;
    if (s > cursor) spine.push(gap(cursor, s - cursor));
    spine.push(clipEl(it, s, e - s));
    cursor = e;
  }
  if (cursor < total || spine.length === 0) spine.push(gap(cursor, Math.max(1, total - cursor)));
  for (const x of base?.transitions ?? []) {
    const idx = spine.findIndex((el) => el.item?.id === x.toItemId);
    if (idx <= 0 || spine[idx - 1]!.item?.id !== x.fromItemId) continue;
    const s = splitOf(x, r);
    transitionsXml.push({
      before: idx,
      xml: `<transition name="Cross Dissolve" offset="${t(spine[idx]!.offset - s.headB)}" duration="${t(s.d)}"/>`,
    });
  }

  // Everything else hangs off the storyline element under its start.
  const parentAt = (frame: number) =>
    spine.find((el) => frame >= el.offset && frame < el.offset + el.duration) ?? spine.at(-1)!;
  const local = (el: El, frame: number) => el.start + (frame - el.offset);
  let up = 0;
  let down = 0;
  for (const tr of others) {
    const lane = tr.kind === 'audio' ? -++down : ++up;
    for (const it of tr.items) {
      const s = framesOf(it.start, r);
      const e = framesOf(itemEnd(it), r);
      if (e <= s) continue;
      const parent = parentAt(s);
      const role =
        tr.kind === 'audio' ? (tr.id.startsWith('trk_sfx') ? 'effects' : 'music') : undefined;
      const child = clipEl(it, local(parent, s), e - s, lane, role);
      const marks = notesOf(it).map(
        (n) => `<marker start="${t(child.start)}" duration="${t(1)}" value="${xml(n)}"/>`,
      );
      parent.children.push(`${child.open}>${marks.join('')}${child.close}`);
    }
  }
  for (const el of spine) {
    if (el.item)
      for (const n of notesOf(el.item))
        el.children.push(`<marker start="${t(el.start)}" duration="${t(1)}" value="${xml(n)}"/>`);
  }
  for (const m of tl.markers) {
    if (m.kind !== 'section' && m.kind !== 'hit' && m.kind !== 'note') continue;
    const f = framesOf(m.at, r);
    const el = parentAt(f);
    el.children.push(
      `<marker start="${t(local(el, f))}" duration="${t(1)}" value="${xml(`${m.kind}${m.label ? `: ${m.label}` : ''}`)}"/>`,
    );
  }

  const body = spine
    .map((el, i) => {
      const tr = transitionsXml.filter((x) => x.before === i).map((x) => x.xml);
      return [
        ...tr,
        el.children.length ? `${el.open}>${el.children.join('')}${el.close}` : `${el.open}/>`,
      ].join('\n          ');
    })
    .join('\n          ');
  const { width, height } = tl.resolution;
  const fps = r.num / r.den;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="r1" name="FFVideoFormat${height}p${Math.round(fps * 100) / 100}" frameDuration="${t(1)}" width="${width}" height="${height}" colorSpace="1-1-1 (Rec. 709)"/>
    ${[...assets.values()].map((a) => a.xml).join('\n    ')}
  </resources>
  <library>
    <event name="TrailerForge">
      <project name="${xml(input.name)}">
        <sequence format="r1" duration="${t(total)}" tcStart="0s" tcFormat="${isDropRate(r) ? 'DF' : 'NDF'}" audioLayout="stereo" audioRate="48k">
          <spine>
          ${body}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
}

// -- OpenTimelineIO -------------------------------------------------------------------------------

export function toOtio(input: HandoffInput): string {
  const { timeline: tl } = input;
  const r = tl.frameRate;
  const rate = Math.round((r.num / r.den) * 1e9) / 1e9;
  const rt = (value: number) => ({ OTIO_SCHEMA: 'RationalTime.1', rate, value });
  const range = (start: number, duration: number) => ({
    OTIO_SCHEMA: 'TimeRange.1',
    start_time: rt(start),
    duration: rt(duration),
  });
  const marker = (name: string, at: number) => ({
    OTIO_SCHEMA: 'Marker.2',
    metadata: {},
    name,
    color: 'RED',
    marked_range: range(at, 0),
    comment: '',
  });
  const reference = (it: TimelineItem) => {
    if (it.kind === 'clip') {
      const src = input.sources.get(it.assetId);
      if (src)
        return {
          OTIO_SCHEMA: 'ExternalReference.1',
          metadata: {},
          name: baseName(src.path),
          available_range: range(0, Math.round((src.duration * r.num) / r.den)),
          available_image_bounds: null,
          target_url: fileUrl(src.path),
        };
    }
    const g = input.graphics?.get(it.id);
    if (g)
      return {
        OTIO_SCHEMA: 'ExternalReference.1',
        metadata: {},
        name: baseName(g.path),
        available_range: range(0, g.frames),
        available_image_bounds: null,
        target_url: fileUrl(g.path),
      };
    return {
      OTIO_SCHEMA: 'MissingReference.1',
      metadata: {},
      name: itemName(it, input),
      available_range: null,
      available_image_bounds: null,
    };
  };
  const tracks = flatten(tl).map((tr) => {
    const children: unknown[] = [];
    let cursor = 0;
    const items = tr.items.filter((it) => framesOf(itemEnd(it), r) > framesOf(it.start, r));
    items.forEach((it, i) => {
      const s = framesOf(it.start, r);
      const e = framesOf(itemEnd(it), r);
      if (s > cursor)
        children.push({
          OTIO_SCHEMA: 'Gap.1',
          metadata: {},
          name: '',
          source_range: range(0, s - cursor),
          effects: [],
          markers: [],
          enabled: true,
        });
      const x = tr.transitions.find(
        (y) => y.toItemId === it.id && items[i - 1]?.id === y.fromItemId,
      );
      if (x) {
        const sp = splitOf(x, r);
        children.push({
          OTIO_SCHEMA: 'Transition.1',
          metadata: { trailerforge: { transitionId: x.transitionId } },
          name: x.transitionId,
          transition_type: 'SMPTE_Dissolve',
          in_offset: rt(sp.headB),
          out_offset: rt(sp.tailA),
        });
      }
      const start = it.kind === 'clip' ? framesOf(it.sourceIn, r) : 0;
      children.push({
        OTIO_SCHEMA: 'Clip.2',
        metadata: {
          trailerforge: {
            itemId: it.id,
            ...(it.slotId ? { slotId: it.slotId } : {}),
            notes: notesOf(it),
          },
        },
        name: itemName(it, input),
        source_range: range(start, e - s),
        effects: [],
        markers: [],
        enabled: true,
        media_references: { DEFAULT_MEDIA: reference(it) },
        active_media_reference_key: 'DEFAULT_MEDIA',
      });
      cursor = e;
    });
    return {
      OTIO_SCHEMA: 'Track.1',
      metadata: {},
      name: tr.name || tr.id,
      source_range: null,
      effects: [],
      markers: [],
      enabled: true,
      children,
      kind: tr.kind === 'audio' ? 'Audio' : 'Video',
    };
  });
  const firstVideo = tracks.find((k) => k.kind === 'Video');
  if (firstVideo)
    firstVideo.markers = tl.markers
      .filter((m) => m.kind === 'section' || m.kind === 'hit' || m.kind === 'note')
      .map((m) =>
        marker(`${m.kind}${m.label ? `: ${m.label}` : ''}`, framesOf(m.at, r)),
      ) as never[];
  const doc = {
    OTIO_SCHEMA: 'Timeline.1',
    metadata: { trailerforge: { timelineId: tl.id } },
    name: input.name,
    global_start_time: rt(0),
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      metadata: {},
      name: 'tracks',
      source_range: null,
      effects: [],
      markers: [],
      enabled: true,
      children: tracks,
    },
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

// -- CMX3600 EDL ----------------------------------------------------------------------------------

const isDropRate = (r: Rate) => r.den === 1001 && (r.num === 30000 || r.num === 60000);

/** SMPTE timecode for a frame count; drop-frame (`;`) at 29.97 and 59.94. */
export function timecode(frames: number, r: Rate): string {
  const base = Math.round(r.num / r.den);
  let f = frames;
  if (isDropRate(r)) {
    const drop = base === 60 ? 4 : 2;
    const perMin = base * 60 - drop;
    const per10 = perMin * 10 + drop;
    const d = Math.floor(f / per10);
    const m = f % per10;
    f += drop * 9 * d + (m > drop ? drop * Math.floor((m - drop) / perMin) : 0);
  }
  const ff = f % base;
  const s = Math.floor(f / base) % 60;
  const mm = Math.floor(f / (base * 60)) % 60;
  const hh = Math.floor(f / (base * 3600)) % 24;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(hh)}:${p(mm)}:${p(s)}${isDropRate(r) ? ';' : ':'}${p(ff)}`;
}

/** CMX3600 is plain ASCII: accents dropped, other characters replaced. */
const ascii = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[^\x20-\x7e]/g, '-');

/** One picture track as a CMX3600 EDL (default: the bottom video track). */
export function toEdl(input: HandoffInput, trackId?: string): string {
  const { timeline: tl } = input;
  const r = tl.frameRate;
  const tracks = flatten(tl);
  const track = trackId
    ? tracks.find((k) => k.id === trackId)
    : tracks.find((k) => k.kind === 'video');
  const lines = [
    `TITLE: ${ascii(input.name).slice(0, 70)}`,
    `FCM: ${isDropRate(r) ? 'DROP FRAME' : 'NON-DROP FRAME'}`,
    '',
  ];
  let n = 0;
  for (const it of track?.items ?? []) {
    const s = framesOf(it.start, r);
    const e = framesOf(itemEnd(it), r);
    if (e <= s) continue;
    n++;
    const src = it.kind === 'clip' ? framesOf(it.sourceIn, r) : 0;
    const reel =
      it.kind === 'clip' && input.sources.has(it.assetId)
        ? 'AX'
        : it.kind === 'graphic' && input.graphics?.has(it.id)
          ? 'AX'
          : 'BL';
    lines.push(
      `${String(n).padStart(3, '0')}  ${reel.padEnd(8)} V     C        ${timecode(src, r)} ${timecode(src + e - s, r)} ${timecode(s, r)} ${timecode(e, r)}`,
    );
    const file =
      it.kind === 'clip' ? input.sources.get(it.assetId)?.path : input.graphics?.get(it.id)?.path;
    lines.push(`* FROM CLIP NAME: ${ascii(file ? baseName(file) : itemName(it, input))}`);
    const x = track?.transitions.find((y) => y.toItemId === it.id);
    if (x)
      lines.push(
        `* TRANSITION: ${x.transitionId} ${splitOf(x, r).d} FRAMES (CUT HERE; ADD IN THE EDITOR)`,
      );
    for (const note of notesOf(it)) lines.push(`* ${ascii(note)}`);
    lines.push('');
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}
