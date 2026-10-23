import type { LlmProvider } from '@trailerforge/plugin-api';
import { formatInstructions, withRepairs } from '../structured.js';

export interface HandoffRequest {
  task: string;
  /** Text the user copies into their chat. Round 0 is self-contained; later rounds are follow-ups. */
  prompt: string;
  round: number;
}

/** UI side of Chat Handoff: shows the prompt with a copy button and resolves with the pasted reply. */
export interface HandoffBridge {
  request(req: HandoffRequest, signal: AbortSignal): Promise<string>;
}

/**
 * The user runs the prompt in any chat (e.g. Claude) and pastes the reply back. Nothing leaves
 * the machine unless the user pastes it somewhere themselves.
 */
export function createChatHandoffProvider(bridge: HandoffBridge, maxRepairs = 2): LlmProvider {
  return {
    id: 'core/chat-handoff',
    name: 'Copy prompt to chat',
    kind: 'interactive',
    sendsDataOffDevice: false,
    available: async () => ({ ok: true }),
    async generate(request, signal) {
      const full = [
        `# TrailerForge task: ${request.task}`,
        '## Instructions',
        request.system,
        '## Request',
        request.prompt,
        '## Output format',
        formatInstructions(request.schema),
      ].join('\n\n');
      const { value } = await withRepairs(
        request.schema,
        (prompt, round) => bridge.request({ task: request.task, prompt, round }, signal),
        full,
        maxRepairs,
      );
      return { value, model: 'chat-handoff' };
    },
  };
}
