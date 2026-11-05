import { plannerViewOp, OpError, type PlannerView } from '@trailerforge/engine';
import { fail, type CmdCtx } from './m2.js';

const usage = (message: string): never => {
  throw new OpError('usage', message);
};

/** `--platform a --platform b` or `--platform a,b`. */
const list = (v: readonly string[]): string[] | undefined =>
  v.length ? v.flatMap((x) => x.split(',')) : undefined;

/** `none` clears an optional field. */
const orNull = (v: string | undefined) => (v === 'none' ? null : v);

function describe(view: PlannerView): string {
  const lines: string[] = [];
  for (const c of view.campaigns) {
    const dates = c.startDate || c.endDate ? ` (${c.startDate ?? '…'} to ${c.endDate ?? '…'})` : '';
    lines.push(`Campaign ${c.id}: ${c.name}${dates}`);
    for (const f of c.sharedFootage)
      lines.push(`  shared: ${f.name} in ${f.projectIds.length} video(s)`);
  }
  const slots = [...view.slots].sort((a, b) => a.date.localeCompare(b.date));
  for (const s of slots) {
    const p = s.project;
    const where = p
      ? `${p.name} [${p.status ?? p.state}${p.suggestion ? `, suggest ${p.suggestion.status}` : ''}]`
      : 'no project yet';
    lines.push(
      `${s.date}  ${s.id}  ${s.title}  ${s.platformTargets.join(', ') || 'no platforms'}  ${s.campaignId ?? 'no campaign'}  ${where}`,
    );
  }
  if (lines.length === 0)
    lines.push(
      'Nothing planned yet. Try: tforge planner slot-add --title "Trailer" --date 2026-12-01',
    );
  return lines.join('\n');
}

/**
 * `tforge planner show|campaign-add|campaign-set|campaign-remove|slot-add|slot-set|slot-move|
 * slot-remove|slot-unlink|create-project`. Edits are saved at once in `<home>/planner/planner.json`.
 */
export async function plannerCommand(ctx: CmdCtx, sub: string, id?: string): Promise<number> {
  const f = ctx.flags;
  const str = (
    k: 'name' | 'color' | 'start' | 'end' | 'note' | 'title' | 'date' | 'campaign' | 'type' | 'dir',
  ) => f[k];
  const needId = (what: string): string => id ?? usage(`give the ${what} id`);
  const run = async (type: string, payload: Record<string, unknown>) => {
    await ctx.engine.planner.dispatch(type, payload);
  };
  try {
    switch (sub) {
      case 'show':
      case '': {
        const view = await plannerViewOp(ctx.engine);
        ctx.emit(describe(view), view);
        return 0;
      }
      case 'campaign-add':
        await run('planner/campaign.add', {
          ...(id ? { id } : {}),
          name: str('name') ?? usage('--name is required'),
          ...(str('color') ? { color: str('color') } : {}),
          ...(str('start') ? { startDate: str('start') } : {}),
          ...(str('end') ? { endDate: str('end') } : {}),
          ...(str('note') ? { notes: str('note') } : {}),
        });
        break;
      case 'campaign-set':
        await run('planner/campaign.set', {
          campaignId: needId('campaign'),
          ...(str('name') ? { name: str('name') } : {}),
          ...(str('color') ? { color: orNull(str('color')) } : {}),
          ...(str('start') ? { startDate: orNull(str('start')) } : {}),
          ...(str('end') ? { endDate: orNull(str('end')) } : {}),
          ...(str('note') !== undefined ? { notes: str('note') } : {}),
        });
        break;
      case 'campaign-remove':
        await run('planner/campaign.remove', {
          campaignId: needId('campaign'),
          slots: f.drop ? 'remove' : 'keep',
        });
        break;
      case 'slot-add': {
        const platforms = list(f.platform);
        await run('planner/slot.add', {
          ...(id ? { id } : {}),
          title: str('title') ?? usage('--title is required'),
          date: str('date') ?? usage('--date YYYY-MM-DD is required'),
          ...(str('campaign') ? { campaignId: orNull(str('campaign')) } : {}),
          ...(platforms ? { platformTargets: platforms } : {}),
          ...(str('type') ? { videoTypeId: str('type') } : {}),
          ...(str('note') ? { notes: str('note') } : {}),
        });
        break;
      }
      case 'slot-set': {
        const platforms = list(f.platform);
        await run('planner/slot.set', {
          slotId: needId('slot'),
          ...(str('title') ? { title: str('title') } : {}),
          ...(str('campaign') ? { campaignId: orNull(str('campaign')) } : {}),
          ...(platforms ? { platformTargets: platforms } : {}),
          ...(str('type') ? { videoTypeId: orNull(str('type')) } : {}),
          ...(str('note') !== undefined ? { notes: str('note') } : {}),
        });
        break;
      }
      case 'slot-move':
        await run('planner/slot.move', {
          slotId: needId('slot'),
          date: str('date') ?? usage('--date YYYY-MM-DD is required'),
        });
        break;
      case 'slot-remove':
        await run('planner/slot.remove', { slotId: needId('slot') });
        break;
      case 'slot-unlink':
        await run('planner/slot.unlink', { slotId: needId('slot') });
        break;
      case 'create-project': {
        const dir = str('dir');
        const made = await ctx.engine.createFromCalendarSlot(needId('slot'), dir ? { dir } : {});
        ctx.emit(
          [
            `Created ${made.dir}`,
            `  versions: ${made.formatTargetIds.join(', ') || 'none (no platforms on the slot)'}`,
            ...made.warnings.map((w) => `! ${w}`),
          ].join('\n'),
          made,
        );
        return 0;
      }
      default:
        return usage(
          `unknown planner command "${sub}"; use show, campaign-add|set|remove, slot-add|set|move|remove|unlink or create-project`,
        );
    }
    const view = await plannerViewOp(ctx.engine);
    ctx.emit(describe(view), view);
    return 0;
  } catch (err) {
    return fail(ctx, err);
  }
}

/**
 * `tforge projects` lists every project folder the app has opened; `projects forget <dir>` takes
 * an entry off the list (the folder itself is never touched).
 */
export async function projectsCommand(ctx: CmdCtx, sub: string, dir?: string): Promise<number> {
  try {
    if (sub === 'forget') {
      if (!dir) return usage('give the project folder to forget');
      const removed = await ctx.engine.registry.forget(dir);
      ctx.emit(removed ? `Forgot ${dir}` : `${dir} was not in the list`, { removed });
      return removed ? 0 : 1;
    }
    if (sub !== 'list' && sub !== '')
      return usage(`unknown projects command "${sub}"; use list or forget`);
    const views = await ctx.engine.registry.views();
    ctx.emit(
      views.length
        ? views
            .map((p) => `${p.name}  ${p.dir}${p.state === 'ok' ? '' : `  (${p.state})`}`)
            .join('\n')
        : 'No projects yet.',
      views,
    );
    return 0;
  } catch (err) {
    return fail(ctx, err);
  }
}
