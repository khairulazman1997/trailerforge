import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { AppState, AppStore } from './store.js';

const StoreContext = createContext<AppStore | null>(null);

export function StoreProvider({ store, children }: { store: AppStore; children: ReactNode }) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStore(): AppStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore outside StoreProvider');
  return store;
}

/** Subscribe to a slice of app state; re-renders only when the selected value changes. */
export function useAppState<T>(select: (s: AppState) => T): T {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, () => select(store.getState()));
}
