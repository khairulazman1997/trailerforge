import { useEffect, useState } from 'react';
import type { ClipItem, TimelineItem } from '@trailerforge/schema';
import { useAppState, useStore } from '../app-context.js';
import { defaultsOf, secondsToFrameFlicks } from '../graphics-view.js';

const TIMELINE_ID = 'tl_rough';
const short = (id: string) => id.replace(/^[a-z0-9-]+\//, '').replace(/-/g, ' ');

/**
 * Finishing effects on a clip, the transition into it, and the sounds on its shot, chosen from
 * what is installed. Effects and transitions go on the cut straight away and a rebuild keeps
 * them; sounds are part of the storyboard and are placed when the cut is rebuilt.
 */
export function AccentsPanel({
  id,
  item,
  locked,
}: {
  id: string;
  item: TimelineItem;
  locked: boolean;
}) {
  const store = useStore();
  const view = useAppState((s) => s.projects[id])!;
  const catalog = useAppState((s) => s.catalog);
  const [effect, setEffect] = useState('');
  const [sound, setSound] = useState('impact');
  const [position, setPosition] = useState<'before' | 'start' | 'end'>('start');
  useEffect(() => {
    void store.loadCatalog();
  }, [store]);

  const project = view.project;
  const tl = project.timelines.find((t) => t.id === TIMELINE_ID);
  const track = tl?.tracks.find((t) => t.items.some((i) => i.id === item.id));
  if (!tl || !track || (track.kind !== 'video' && track.kind !== 'graphics')) return null;
  if (item.kind !== 'clip' && item.kind !== 'graphic' && item.kind !== 'placeholder') return null;
  const canHaveEffects = item.kind !== 'placeholder';

  const ref = { timelineId: tl.id, itemId: item.id };
  const index = track.items.findIndex((i) => i.id === item.id);
  const before = track.items[index - 1];
  const touches = !!before && before.start + before.duration === item.start;
  const current = track.transitions.find((t) => t.toItemId === item.id);
  const transitions = catalog?.effects.transitions ?? [];
  const effects = catalog?.effects.effects ?? [];
  const chosen = transitions.find((t) => t.id === current?.transitionId);
  const cues = (project.storyboard?.music.sfxCues ?? []).filter((c) => c.slotId === item.slotId);

  const itemEffects = item.kind === 'placeholder' ? [] : item.effects;
  const setEffects = (next: ClipItem['effects']) =>
    store.command(id, 'core/timeline.set-effects', { ...ref, effects: next });
  const addEffect = () => {
    const def = effects.find((e) => e.id === effect);
    if (!def) return;
    const base = `${item.id}_${short(def.id).replace(/ /g, '_')}`.slice(0, 60);
    let eid = base;
    for (let n = 2; itemEffects.some((e) => e.id === eid); n++) eid = `${base}_${n}`;
    void setEffects([
      ...itemEffects,
      { id: eid, effectId: def.id, enabled: true, params: defaultsOf(def.params) },
    ]);
    setEffect('');
  };
  const setTransition = (transitionId: string) => {
    const def = transitions.find((t) => t.id === transitionId);
    void store.command(id, 'core/timeline.set-transition', {
      timelineId: tl.id,
      toItemId: item.id,
      transition: def
        ? {
            transitionId: def.id,
            duration: secondsToFrameFlicks(def.defaultSeconds ?? 0.5, tl.frameRate),
            params: defaultsOf(def.params),
          }
        : null,
    });
  };

  return (
    <section className="accents" aria-label="Effects, transition and sounds">
      {canHaveEffects && (
        <>
          <h4>Effects</h4>
          {itemEffects.length === 0 ? (
            <p className="muted">None.</p>
          ) : (
            <ul>
              {itemEffects.map((e) => (
                <li key={e.id}>
                  {short(e.effectId)}{' '}
                  <button
                    type="button"
                    disabled={locked}
                    onClick={() => void setEffects(itemEffects.filter((x) => x.id !== e.id))}
                  >
                    Remove {short(e.effectId)}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="row">
            <label className="field inline">
              <span>Add an effect</span>
              <select
                value={effect}
                disabled={locked || !catalog}
                onChange={(e) => setEffect(e.target.value)}
              >
                <option value="">Choose…</option>
                {effects.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" disabled={locked || !effect} onClick={addEffect}>
              Add effect
            </button>
          </div>
        </>
      )}

      <h4>Transition into this clip</h4>
      <label className="field inline">
        <span>Transition</span>
        <select
          value={current?.transitionId ?? ''}
          disabled={locked || !catalog || (!touches && !current)}
          onChange={(e) => setTransition(e.target.value)}
        >
          <option value="">Hard cut</option>
          {transitions.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      {!touches && !current && (
        <p className="muted">There is no clip right before this one on its track.</p>
      )}
      {chosen?.flashes && (
        <p className="muted">
          This one flashes. It is refused if the cut would flash more than three times in a second.
        </p>
      )}

      {item.slotId && (
        <>
          <h4>Sounds on this shot</h4>
          {cues.length === 0 ? (
            <p className="muted">None.</p>
          ) : (
            <ul>
              {cues.map((c) => (
                <li key={c.id}>
                  {c.kind} ({c.position}){' '}
                  <button
                    type="button"
                    onClick={() =>
                      void store.command(id, 'core/storyboard.remove-sfx-cue', { cueId: c.id })
                    }
                  >
                    Remove {c.kind} sound
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="row">
            <label className="field inline">
              <span>Sound</span>
              <select value={sound} onChange={(e) => setSound(e.target.value)}>
                {(
                  catalog?.effects.sounds.generated ?? ['whoosh', 'riser', 'impact', 'sub-drop']
                ).map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
            <label className="field inline">
              <span>Where</span>
              <select
                value={position}
                onChange={(e) => setPosition(e.target.value as typeof position)}
              >
                <option value="before">Leading into it</option>
                <option value="start">At its start</option>
                <option value="end">At its end</option>
              </select>
            </label>
            <button
              type="button"
              onClick={() =>
                void store.command(id, 'core/storyboard.add-sfx-cue', {
                  slotId: item.slotId,
                  kind: sound,
                  position,
                })
              }
            >
              Add sound
            </button>
          </div>
          <p className="muted">Sounds are placed on the cut when you rebuild it.</p>
        </>
      )}
    </section>
  );
}
