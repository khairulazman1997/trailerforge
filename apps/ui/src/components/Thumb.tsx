import { useEffect, useState } from 'react';
import { useStore } from '../app-context.js';

/**
 * A recording's preview picture from the library cache (fetched with the token, since an <img>
 * cannot send it). `ready` says the engine has built it; until then nothing is shown, and the
 * picture appears once `ready` turns true.
 */
export function Thumb({
  assetId,
  name,
  what = 'thumbnail',
  ready,
}: {
  assetId: string;
  name: string;
  what?: 'thumbnail' | 'filmstrip';
  ready: boolean;
}) {
  const store = useStore();
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!ready) return;
    let live = true;
    void store.mediaUrl(assetId, what).then((u) => live && setSrc(u));
    return () => {
      live = false;
    };
  }, [store, assetId, what, ready]);
  if (!src) return <span className="thumb empty" aria-hidden="true" />;
  return (
    <img
      className={what === 'filmstrip' ? 'filmstrip' : 'thumb'}
      src={src}
      alt={`${what === 'filmstrip' ? 'Frames across' : 'Preview of'} ${name}`}
    />
  );
}

/** The frames across a recording, fetched only when the section is opened (it is built last). */
export function Filmstrip({ assetId, name }: { assetId: string; name: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="foot-strip" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Frames across the recording</summary>
      <Thumb assetId={assetId} name={name} what="filmstrip" ready={open} />
    </details>
  );
}
