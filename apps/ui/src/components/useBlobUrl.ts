import { useEffect, useState } from 'react';

/** An object URL for a Blob that is fetched with the token (an <img> cannot send it). */
export function useBlobUrl(load: () => Promise<Blob | undefined>, key: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    void load().then((b) => {
      if (!live || !b) return;
      made = URL.createObjectURL(b);
      setUrl(made);
    });
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
      setUrl(null);
    };
    // `key` stands for what `load` reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return url;
}
