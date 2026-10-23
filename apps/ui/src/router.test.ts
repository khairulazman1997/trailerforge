import { describe, expect, it } from 'vitest';
import { matchRoute, projectPath } from './router.js';

describe('matchRoute', () => {
  it('matches the app routes', () => {
    expect(matchRoute('/')).toEqual({ name: 'home' });
    expect(matchRoute('/settings')).toEqual({ name: 'settings' });
    expect(matchRoute('/p/proj_1')).toEqual({ name: 'project', id: 'proj_1', tab: 'overview' });
    expect(matchRoute('/p/proj_1/storyboard/')).toEqual({
      name: 'project',
      id: 'proj_1',
      tab: 'storyboard',
    });
    expect(matchRoute('/p/proj%5F2/brief')).toEqual({
      name: 'project',
      id: 'proj_2',
      tab: 'brief',
    });
  });

  it('rejects everything else', () => {
    for (const p of ['/nope', '/p', '/p/proj_1/unknown', '/p/proj_1/brief/extra', '/settings/x']) {
      expect(matchRoute(p)).toEqual({ name: 'not-found' });
    }
  });

  it('builds paths that round-trip', () => {
    for (const tab of ['overview', 'brief', 'knowledge', 'storyboard'] as const) {
      expect(matchRoute(projectPath('proj_1', tab))).toEqual({
        name: 'project',
        id: 'proj_1',
        tab,
      });
    }
  });
});
