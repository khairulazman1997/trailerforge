import {
  OpError,
  buildShortOp,
  claudeCodeConceptsOp,
  claudeCodeConceptsPreviewOp,
  conceptsOp,
  createShortOp,
  fillSlotOp,
  generateShortCutOp,
  placeVoiceOp,
  tapTempo,
  voiceCleanReportOp,
  shortsViewOp,
  voiceDownloadOp,
  voiceStatusOp,
  type Engine,
} from '@trailerforge/engine';
import { secondsToFlicks } from '@trailerforge/schema';
import { fail, type CmdCtx } from './m2.js';

/** Options of `tforge tiktok …` (parsed in `main.ts`). */
export interface TikTokOpts {
  none?: boolean | undefined;
  'timing-only'?: boolean | undefined;
  taps?: string | undefined;
  tempo?: string | undefined;
  export?: string | undefined;
  idea: string[];
  count?: string | undefined;
  concept?: string | undefined;
  title?: string | undefined;
  hook?: string | undefined;
  format?: string | undefined;
  seconds?: string | undefined;
  shot: string[];
  say: string[];
  name?: string | undefined;
  section: string[];
  noWording: boolean;
  file?: string | undefined;
  asset?: string | undefined;
  slot?: string | undefined;
  line?: string | undefined;
  input?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  language?: string | undefined;
  on: boolean;
  off: boolean;
  style?: string | undefined;
  platform?: string | undefined;
  yes: boolean;
  show: boolean;
}

export const TIKTOK_SUBS = [
  'concepts',
  'list',
  'new',
  'build',
  'fill',
  'voice',
  'transcribe',
  'subtitles',
  'music',
  'clean',
  'generate',
  'ask-claude',
] as const;

const num = (what: string, v: string | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0)
    throw new OpError('usage', `${what} must be a number, got "${v}"`);
  return n;
};
const need = (v: string | undefined, what: string): string => {
  if (!v) throw new OpError('usage', `missing ${what}; see tforge --help`);
  return v;
};

/** `tforge tiktok <sub> <dir> [<short>]`: make marketing TikToks from concepts, files and voiceover. */
export async function tiktokCommand(
  ctx: CmdCtx,
  sub: string,
  dir: string | undefined,
  shortId: string | undefined,
  o: TikTokOpts,
): Promise<number> {
  try {
    if (sub === 'voice') {
      // The one-time model download is the app's, not a project's.
      if (o.yes) {
        ctx.io.err('Downloading the voice model (one time; nothing is uploaded)…');
        const v = await voiceDownloadOp(ctx.engine, { consent: true });
        ctx.emit(`Voice model: ${v.status}`, v);
        return 0;
      }
      const v = await voiceStatusOp(ctx.engine);
      ctx.emit(
        v.disclosure
          ? [
              `Voice model: ${v.status}`,
              `  ${v.disclosure.title} (${v.disclosure.license}), ${Math.round(v.disclosure.totalBytes / 1e6)} MB from ${v.disclosure.hosts.join(', ')}`,
              `  ${v.disclosure.sends} ${v.disclosure.afterwards}`,
              ...(v.status === 'absent' ? ['  Download it with: tforge tiktok voice --yes'] : []),
            ].join('\n')
          : 'No voice model is available in this build.',
        v,
      );
      return 0;
    }
    if (!dir) throw new OpError('usage', 'missing <dir>; see tforge --help');
    const store = await ctx.engine.openProject(dir);
    const e: Engine = ctx.engine;
    const sid = () => need(shortId, '<short id> (see `tforge tiktok list <dir>`)');
    switch (sub) {
      case 'list': {
        const v = await shortsViewOp(e, store);
        const lines: string[] = [];
        for (const c of v.concepts)
          lines.push(`concept ${c.id.padEnd(28)} ${c.source.padEnd(11)} ${c.title} (${c.formatId.replace('game-trailer/tiktok-', '')}, ${c.targetSeconds} s)`); // prettier-ignore
        for (const s of v.shorts) {
          lines.push(
            `${s.id.padEnd(34)} ${s.name}: ${s.concept.formatName}, ${s.concept.targetSeconds} s, ${s.platform}${s.subtitles.enabled ? `, subtitles (${s.subtitles.style})` : ''}`,
            `  pictures ${s.progress.slotsFilled}/${s.progress.slots}, voiceover ${s.progress.linesRecorded}/${s.progress.lines}, cut: ${s.cut.built ? `${s.cut.mode}, ${s.cut.seconds} s` : 'not built'}`,
          );
          for (const x of s.slots.filter((y) => y.kind === 'shot'))
            lines.push(`    ${x.id.padEnd(30)} ${x.accepts.join('/').padEnd(22)} ${x.chosen ? x.chosen.name : '(empty)'}  ${x.title}`); // prettier-ignore
          for (const l of s.voiceLines)
            lines.push(`    ${l.id.padEnd(30)} voice                  ${l.chosen ? l.chosen.name : '(not recorded)'}  "${l.text}"`); // prettier-ignore
        }
        ctx.emit(
          lines.join('\n') || 'No concepts or TikToks yet. Try: tforge tiktok concepts <dir>',
          v,
        );
        return 0;
      }
      case 'concepts': {
        const r = await conceptsOp(e, store, { ideas: o.idea, ...(o.count ? { count: num('--count', o.count)! } : {}) }); // prettier-ignore
        ctx.emit(
          [
            ...r.added.map(
              (c) => `  ${c.id}  ${c.title} (${c.formatId.replace('game-trailer/tiktok-', '')})`,
            ),
            ...r.rejected.map((x) => `  rejected "${x.title}": ${x.reasons.join('; ')}`),
            ...r.warnings.map((w) => `  note: ${w}`),
            `${r.added.length} concept${r.added.length === 1 ? '' : 's'} added. Pick one with: tforge tiktok new <dir> --concept <id>`,
          ].join('\n'),
          r,
        );
        return 0;
      }
      case 'ask-claude': {
        const base = { ideas: o.idea, ...(o.count ? { count: num('--count', o.count)! } : {}) };
        if (o.show || !o.yes) {
          const p = await claudeCodeConceptsPreviewOp(e, store, base);
          ctx.emit(
            [p.warning, '', `Repo: ${p.repo} (${p.files} text files${p.truncated ? ', some left out for size' : ''})`, '', 'The request:', p.prompt, '', ...(o.yes ? [] : ['Run it with: tforge tiktok ask-claude <dir> --yes'])].join('\n'), // prettier-ignore
            p,
          );
          return 0;
        }
        const r = await claudeCodeConceptsOp(e, store, {
          ...base,
          allow: true,
          ...(ctx.claudeBin ? { claudeBin: ctx.claudeBin } : {}),
          onNotice: (m) => ctx.io.err(m),
        });
        ctx.emit(
          [
            ...r.added.map((c) => `  ${c.id}  ${c.title}`),
            ...r.rejected.map((x) => `  rejected "${x.title}": ${x.reasons.join('; ')}`),
            `${r.added.length} concept${r.added.length === 1 ? '' : 's'} added from ${r.filesShared} files Claude Code read.`,
          ].join('\n'),
          r,
        );
        return 0;
      }
      case 'new': {
        const own = o.title || o.hook || o.format;
        if ((o.concept === undefined) === !own)
          throw new OpError(
            'usage',
            'give --concept <id>, or your own with --title, --hook, --format and --seconds',
          );
        const r = await createShortOp(e, store, {
          ...(o.concept
            ? { conceptId: o.concept }
            : {
                concept: {
                  source: 'user',
                  title: need(o.title, '--title'),
                  hook: need(o.hook, '--hook'),
                  formatId: need(o.format, '--format (e.g. game-trailer/tiktok-montage)'),
                  pitch: '',
                  shotList: o.shot,
                  voiceover: o.say,
                  targetSeconds: num('--seconds', o.seconds) ?? 20,
                  entityIds: [],
                },
              }),
          ...(o.name ? { name: o.name } : {}),
          wording: !o.noWording,
        });
        ctx.emit(
          `Made ${r.shortId}${r.build ? `: ${r.build.rebuilt} slots written, wording ${r.build.wording.status}` : ''}. Fill it with: tforge tiktok fill <dir> ${r.shortId} --slot <id> --file <path>`, // prettier-ignore
          r,
        );
        return 0;
      }
      case 'build': {
        const r = await buildShortOp(e, store, sid(), {
          ...(o.section.length ? { sectionIds: o.section } : {}),
          wording: !o.noWording,
        });
        ctx.emit(
          `${r.rebuilt} slots written, ${r.kept} kept; wording: ${r.wording.status}${r.wording.status === 'skipped' ? ` (${r.wording.reason})` : ''}`,
          r,
        );
        return 0;
      }
      case 'fill': {
        if ((o.slot === undefined) === (o.line === undefined))
          throw new OpError('usage', 'give --slot <id> or --line <voiceover line id>');
        if ((o.file === undefined) === (o.asset === undefined))
          throw new OpError('usage', 'give --file <path> (imported first) or --asset <library id>');
        const r = await fillSlotOp(e, store, sid(), {
          ...(o.slot ? { slotId: o.slot } : { voLineId: o.line! }),
          ...(o.file ? { path: o.file } : { assetId: o.asset! }),
          ...(o.input ? { input: o.input as never } : {}),
          ...(o.from !== undefined ? { sourceIn: secondsToFlicks(num('--from', o.from)!) } : {}),
          ...(o.to !== undefined ? { sourceOut: secondsToFlicks(num('--to', o.to)!) } : {}),
        });
        ctx.emit(`${r.target} ← ${r.assetId} (${r.input})`, r);
        return 0;
      }
      case 'transcribe': {
        const r = await placeVoiceOp(e, store, sid(), {
          ...(o.asset ? { assetId: o.asset } : {}),
          ...(o.language ? { language: o.language } : {}),
        });
        ctx.emit(
          [
            `Voiceover placed by ${r.method === 'transcript' ? 'the words heard' : 'trimming silence (no voice model)'}: ${r.placed} of ${r.lines.length} lines`,
            ...r.lines.map(
              (l) =>
                `  ${l.voLineId.padEnd(30)} ${l.status}${l.score !== undefined ? ` (${Math.round(l.score * 100)}%)` : ''}${l.differences?.length ? `: ${l.differences.map((d) => `${d.expected ?? '+'}→${d.heard ?? '∅'}`).join(' ')}` : ''}`, // prettier-ignore
            ),
            ...r.unused.map((u) => `  unused: "${u.text}"`),
          ].join('\n'),
          r,
        );
        return 0;
      }
      case 'subtitles': {
        if (o.on && o.off) throw new OpError('usage', 'choose --on or --off');
        const patch = {
          ...(o.on ? { enabled: true } : o.off ? { enabled: false } : {}),
          ...(o.style ? { style: o.style } : {}),
          ...(o.platform ? { platform: o.platform } : {}),
        };
        if (Object.keys(patch).length > 0) {
          try {
            store.dispatch('core/shorts.set-subtitles', { shortId: sid(), ...patch });
          } catch (err) {
            throw new OpError('usage', err instanceof Error ? err.message : String(err));
          }
        }
        const s = (await shortsViewOp(e, store)).shorts.find((x) => x.id === sid());
        if (!s) throw new OpError('not-found', `no TikTok "${sid()}"`);
        ctx.emit(`Subtitles ${s.subtitles.enabled ? `on (${s.subtitles.style})` : 'off'}, made for ${s.platform}, ${s.subtitles.edits} hand changes`, { platform: s.platform, subtitles: s.subtitles }); // prettier-ignore
        return 0;
      }
      case 'music': {
        const dispatch = (type: string, payload: Record<string, unknown>) => {
          try {
            store.dispatch(type, { shortId: sid(), ...payload });
          } catch (err) {
            throw new OpError('usage', err instanceof Error ? err.message : String(err));
          }
        };
        if (o.none && o.asset) throw new OpError('usage', 'choose --asset or --none');
        if (o.asset || o.none)
          dispatch('core/shorts.set-music', { assetId: o.asset ?? null, timingOnly: o['timing-only'] === true }); // prettier-ignore
        let tapped: ReturnType<typeof tapTempo> | undefined;
        if (o.taps) {
          const taps = o.taps.split(',').map((x) => Number(x.trim()));
          if (taps.some((x) => !Number.isFinite(x))) throw new OpError('usage', '--taps takes seconds separated by commas'); // prettier-ignore
          tapped = tapTempo(taps);
          if (!tapped.ok) throw new OpError('usage', tapped.reason);
          dispatch('core/shorts.set-grid', { patch: { tempo: tapped.tempo, offset: tapped.offset } }); // prettier-ignore
        } else if (o.tempo !== undefined) {
          dispatch('core/shorts.set-grid', { patch: { tempo: num('--tempo', o.tempo)! } });
        }
        if (o.export) {
          if (!['with', 'without', 'both'].includes(o.export))
            throw new OpError('usage', '--export is with, without or both');
          const cur = store.state.shorts.find((x) => x.id === sid())?.export;
          store.dispatch('core/export.set', { variantId: sid(), ...(cur ? {} : { presetId: 'core/tiktok' }), music: o.export }); // prettier-ignore
        }
        const s = (await shortsViewOp(e, store)).shorts.find((x) => x.id === sid());
        if (!s) throw new OpError('not-found', `no TikTok "${sid()}"`);
        const mode = store.state.shorts.find((x) => x.id === sid())?.export?.music ?? 'both';
        ctx.emit(
          [
            `Music: ${s.music.assetId ? `${s.music.assetId}${s.music.timingOnly ? ' (timing only, never exported)' : ''}` : 'none'}; tempo ${s.music.tempo ?? 'from the music'}; export ${mode}`,
            ...(tapped?.ok ? [`  tapped: ${tapped.tempo} BPM from ${tapped.used} intervals, steadiness ${tapped.steadiness}`] : []), // prettier-ignore
          ].join('\n'),
          { music: s.music, export: mode },
        );
        return 0;
      }
      case 'clean': {
        if (o.on && o.off) throw new OpError('usage', 'choose --on or --off');
        if (o.on || o.off)
          store.dispatch('core/shorts.set-voice-clean', { shortId: sid(), enabled: !!o.on });
        const r = await voiceCleanReportOp(e, store, sid());
        const db = (x: number | null) => (x === null ? '?' : x.toFixed(1));
        ctx.emit(
          [
            `Voice clean-up ${r.enabled ? 'on' : 'off'} (voice brought to ${r.targetLufs} LUFS; recordings are not changed)`,
            ...r.lines.map((l) =>
              !l.info
                ? `  ${l.voLineId.padEnd(30)} ${l.error ?? 'not recorded'}`
                : `  ${l.voLineId.padEnd(30)} ${db(l.info.before.lufs)} → ${db(l.info.after.lufs)} LUFS, then ${l.info.gainDb >= 0 ? '+' : ''}${l.info.gainDb} dB; noise floor ${l.info.noiseFloorDb} dBFS`,
            ),
          ].join('\n'),
          r,
        );
        return 0;
      }
      case 'generate': {
        const r = await generateShortCutOp(e, store, sid());
        ctx.emit(
          [
            `Cut built (${r.mode === 'voice' ? 'following the voice' : r.mode === 'beat' ? 'on the beat' : 'storyboard lengths'}): ${r.items} items, ${r.placeholders} placeholders, ${r.cues} subtitles`,
            ...r.warnings.map((w) => `  ! ${w}`),
            `Review and export it like any version: tforge draft|export <dir> --version ${sid()}`,
          ].join('\n'),
          r,
        );
        return r.placeholders > 0 ? 1 : 0;
      }
      default:
        throw new OpError(
          'usage',
          `unknown tiktok command "${sub}"; one of ${TIKTOK_SUBS.join(', ')}`,
        );
    }
  } catch (err) {
    return fail(ctx, err);
  }
}
