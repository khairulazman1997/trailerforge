import type { Info } from '../store.js';

/**
 * `<option>`s for a video type picker: built-in types first, then the ones the user saved.
 * Short-form types (TikToks) belong to a project's shorts, so they are left out.
 */
export function VideoTypeOptions({ types: all }: { types: Info['videoTypes'] }) {
  const types = all.filter((v) => !v.shortForm);
  const builtIn = types.filter((v) => !v.saved);
  const saved = types.filter((v) => v.saved);
  const opts = (list: Info['videoTypes']) =>
    list.map((v) => (
      <option key={v.id} value={v.id}>
        {v.name}
      </option>
    ));
  if (saved.length === 0) return <>{opts(builtIn)}</>;
  return (
    <>
      <optgroup label="Built in">{opts(builtIn)}</optgroup>
      <optgroup label="Saved by you">{opts(saved)}</optgroup>
    </>
  );
}
