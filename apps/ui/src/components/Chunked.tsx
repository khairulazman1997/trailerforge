import { useEffect, useState, type ReactNode } from 'react';

/**
 * Renders a long list a slice at a time: the first rows appear at once and the rest follow in
 * later frames, so opening a project with hundreds of shots never blocks the page for long.
 * Short lists render whole, in one go.
 */
export function Chunked<T>({
  items,
  first = 30,
  chunk = 40,
  children,
}: {
  items: readonly T[];
  first?: number;
  chunk?: number;
  children: (item: T, index: number) => ReactNode;
}) {
  const [shown, setShown] = useState(first);
  const total = items.length;
  useEffect(() => {
    if (shown >= total) return;
    const id = setTimeout(() => setShown((n) => n + chunk), 0);
    return () => clearTimeout(id);
  }, [shown, total, chunk]);
  return <>{items.slice(0, Math.max(shown, 0)).map((item, i) => children(item, i))}</>;
}
