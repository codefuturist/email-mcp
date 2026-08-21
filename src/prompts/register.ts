/**
 * Prompt registration — single wiring point.
 *
 * Registers all MCP prompts with the server instance.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import registerActionsPrompt from './actions.prompt.js';
import registerCalendarPrompt from './calendar.prompt.js';
import registerCleanupPrompt from './cleanup.prompt.js';
import registerComposePrompts from './compose.prompt.js';
import registerThreadPrompt from './thread.prompt.js';
import registerTriagePrompt from './triage.prompt.js';

export default function registerAllPrompts(server: McpServer): void {
  registerTriagePrompt(server);
  registerThreadPrompt(server);
  registerComposePrompts(server);
  registerActionsPrompt(server);
  registerCalendarPrompt(server);
  registerCleanupPrompt(server);
}
