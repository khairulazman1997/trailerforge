import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react';

export type ProjectTab =
  | 'overview'
  | 'brief'
  | 'knowledge'
  | 'storyboard'
  | 'capture'
  | 'footage'
  | 'cut'
  | 'variants'
  | 'brand'
  | 'graphics'
  | 'review'
  | 'export';

export type Route =
  | { name: 'home' }
  | { name: 'settings' }
  | { name: 'setup' }
  | { name: 'project'; id: string; tab: ProjectTab }
  | { name: 'not-found' };

const TABS: ProjectTab[] = [
  'brief',
  'knowledge',
  'storyboard',
  'capture',
  'footage',
  'cut',
  'variants',
  'brand',
  'graphics',
  'review',
  'export',
];

export function matchRoute(path: string): Route {
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return { name: 'home' };
  if (parts.length === 1 && parts[0] === 'settings') return { name: 'settings' };
  if (parts.length === 1 && parts[0] === 'setup') return { name: 'setup' };
  if (parts[0] === 'p' && parts[1] && parts.length <= 3) {
    const id = decodeURIComponent(parts[1]);
    if (parts.length === 2) return { name: 'project', id, tab: 'overview' };
    const tab = TABS.find((t) => t === parts[2]);
    if (tab) return { name: 'project', id, tab };
  }
  return { name: 'not-found' };
}

export const projectPath = (id: string, tab: ProjectTab = 'overview') =>
  `/p/${encodeURIComponent(id)}${tab === 'overview' ? '' : `/${tab}`}`;

const NAVIGATE_EVENT = 'tforge:navigate';

export function navigate(path: string): void {
  if (path === window.location.pathname) return;
  window.history.pushState(null, '', path);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

function subscribe(listener: () => void) {
  window.addEventListener('popstate', listener);
  window.addEventListener(NAVIGATE_EVENT, listener);
  return () => {
    window.removeEventListener('popstate', listener);
    window.removeEventListener(NAVIGATE_EVENT, listener);
  };
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

export function useRoute(): Route {
  return matchRoute(usePath());
}

/** In-app link: plain navigation for ordinary clicks, browser behaviour for new-tab clicks. */
export function Link({
  to,
  onClick,
  ...rest
}: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return;
    e.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={handle} {...rest} />;
}
