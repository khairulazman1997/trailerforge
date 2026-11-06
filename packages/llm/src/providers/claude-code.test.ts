import { describe, expect, it } from 'vitest';
import { failureMessage } from './claude-code.js';

describe('failureMessage', () => {
  it('reads the reason from the JSON result on stdout and says how to sign in again', () => {
    const stdout = JSON.stringify({
      is_error: true,
      result: 'Failed to authenticate: OAuth session expired and could not be refreshed',
    });
    const m = failureMessage(1, stdout, '');
    expect(m).toContain('OAuth session expired');
    expect(m).toContain('/login');
  });

  it('falls back to stderr, then says nothing was given', () => {
    expect(failureMessage(2, 'not json', 'boom')).toBe('Claude Code failed (exit 2): boom');
    expect(failureMessage(1, '', '')).toBe('Claude Code exited with code 1 without saying why');
  });
});
