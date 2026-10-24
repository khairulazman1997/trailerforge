import { useCallback, useState } from 'react';

/**
 * A controlled input shows the server's value, which only changes after the edit has made its
 * round trip; without help it snaps back to the old value for a moment after you click. This
 * keeps the value you chose on screen until the command has been applied (the store resolves a
 * command once its change is in), then goes back to following the real value. A failed command
 * also ends the wait, so the control returns to the real value.
 */
export function usePending<T>(
  value: T,
): [T, (next: T, action: () => Promise<unknown>) => Promise<void>] {
  const [pending, setPending] = useState<{ value: T } | null>(null);
  const run = useCallback(async (next: T, action: () => Promise<unknown>) => {
    setPending({ value: next });
    try {
      await action();
    } finally {
      setPending(null);
    }
  }, []);
  return [pending ? pending.value : value, run];
}
