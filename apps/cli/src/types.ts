import {
  OpError,
  removeSavedTypeOp,
  savedTypesViewOp,
  saveVideoTypeOp,
  setVideoTypeOp,
  updateSavedTypeOp,
} from '@trailerforge/engine';
import { fail, type CmdCtx } from './m2.js';

const usage = (message: string) => {
  throw new OpError('usage', message);
};

/** `tforge types list|save|use|rename|remove …`: video types, including the ones you saved. */
export async function typesCommand(
  ctx: CmdCtx,
  sub: string,
  arg: string | undefined,
  extra: string | undefined,
  o: { name?: string | undefined; description?: string | undefined },
): Promise<number> {
  const { engine } = ctx;
  try {
    if (sub === 'list' || sub === '') {
      const saved = savedTypesViewOp(engine);
      const all = engine.plugins.registries.videoTypes.list();
      ctx.emit(
        [
          ...all.map(
            (v) =>
              `${v.id.padEnd(36)} ${v.name}${engine.plugins.registries.videoTypes.ownerOf(v.id) === 'user' ? '  (saved)' : ''}`,
          ),
          `Saved types live in ${saved.dir}`,
          ...saved.problems.map((p) => `! ${p.file}: ${p.message}`),
        ].join('\n'),
        { videoTypes: all, saved },
      );
      return 0;
    }
    if (sub === 'save') {
      if (!arg) return usage('give the project folder');
      if (!o.name) return usage('give the new type a --name');
      const store = await engine.openProject(arg);
      const t = await saveVideoTypeOp(engine, store, { name: o.name, description: o.description });
      ctx.emit(`Saved "${t.name}" as ${t.id}: ${t.sections.map((s) => s.name).join(' → ')}`, t);
      return 0;
    }
    if (sub === 'use') {
      if (!arg || !extra) return usage('give the project folder and a video type id');
      const store = await engine.openProject(arg);
      ctx.emit(`Video type is now ${extra}`, setVideoTypeOp(engine, store, extra));
      return 0;
    }
    if (sub === 'rename') {
      if (!arg) return usage('give the saved type id (user/…)');
      if (o.name === undefined && o.description === undefined) {
        return usage('give a --name, a --description, or both');
      }
      const t = await updateSavedTypeOp(engine, arg, { name: o.name, description: o.description });
      ctx.emit(`Updated ${t.id}: "${t.name}"`, t);
      return 0;
    }
    if (sub === 'remove') {
      if (!arg) return usage('give the saved type id (user/…)');
      const r = await removeSavedTypeOp(engine, arg);
      ctx.emit(`Removed ${r.removed}; projects made with it keep their own copy.`, r);
      return 0;
    }
    return usage(`unknown types command "${sub}"; use list, save, use, rename or remove`);
  } catch (err) {
    return fail(ctx, err);
  }
}
