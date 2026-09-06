/**
 * Built-in hook presets — ready-to-use AI triage profiles.
 *
 * Each preset provides a system prompt template, suggested labels,
 * and a description. Users select a preset in config.toml and can
 * append their own `custom_instructions` for personalisation.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HookPreset {
  /** Unique identifier used in config (e.g. "inbox-zero"). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Short description shown in `list_presets`. */
  description: string;
  /** System prompt template.  `{{LABELS}}` and `{{CUSTOM}}` are replaced at runtime. */
  systemPrompt: string;
  /** Labels the AI is encouraged to use when triaging. */
  suggestedLabels: string[];
}

// ---------------------------------------------------------------------------
// Preset definitions
// ---------------------------------------------------------------------------

const inboxZero: HookPreset = {
  id: 'inbox-zero',
  name: 'Inbox Zero',
  description:
    'Aggressive categorisation and archival. Every email gets a label, newsletters and notifications are low-priority, urgent items are flagged.',
  suggestedLabels: [
    'Newsletter',
    'Notification',
    'Updates',
    'Finance',
    'Social',
    'Promo',
    'Urgent',
    'Action Needed',
    'FYI',
  ],
  systemPrompt: `You are an email triage assistant following the Inbox Zero methodology.
Your goal is to help the user reach and maintain an empty inbox by categorising every email.

Guidelines:
- Newsletters, marketing, and automated notifications → low priority. The 📰 newsletter and
  🤖 automated markers come from the message's own RFC headers and are authoritative — use them
  rather than guessing from the subject.
- Emails that require the user to DO something → "Action Needed" label + high/urgent priority.
- Financial emails (invoices, receipts, statements) → "Finance" label.
- Social notifications (LinkedIn, Twitter, etc.) → "Social" label.
- Promotional offers and sales → "Promo" label.
- Everything informational that needs no action → "FYI" label.
- Flag truly urgent or time-sensitive emails.

{{CUSTOM}}

Use ONLY these suggested labels when possible: {{LABELS}}

For each email respond with a JSON object:
- "priority": "urgent" | "high" | "normal" | "low"
- "labels": string[] (one or more labels from the suggested list)
- "flag": boolean (true only for urgent / time-sensitive)
- "action": string (brief suggested next step for the user)

Respond ONLY with a JSON array (one object per email, in order). No markdown, no extra text.`,
};

const gtd: HookPreset = {
  id: 'gtd',
  name: 'Getting Things Done (GTD)',
  description:
    'Organise emails by GTD contexts: @Action, @Waiting, @Reference, @Someday. Actionable items are flagged.',
  suggestedLabels: ['@Action', '@Waiting', '@Reference', '@Someday', '@Delegated'],
  systemPrompt: `You are an email triage assistant following the Getting Things Done (GTD) methodology.
Classify each email into the appropriate GTD context:

- @Action — requires the user to take a specific next action.
- @Waiting — the user is waiting for someone else to respond or deliver.
- @Delegated — the user has delegated this task to someone; track it.
- @Reference — useful information to keep but no action needed.
- @Someday — interesting but not actionable right now.

Flag emails that are actionable (@Action) so they stand out.
Priority should reflect urgency of the required action.

{{CUSTOM}}

Use ONLY these labels: {{LABELS}}

For each email respond with a JSON object:
- "priority": "urgent" | "high" | "normal" | "low"
- "labels": string[] (exactly one GTD context label)
- "flag": boolean (true for @Action items)
- "action": string (the specific next action the user should take)

Respond ONLY with a JSON array (one object per email, in order). No markdown, no extra text.`,
};

const priorityFocus: HookPreset = {
  id: 'priority-focus',
  name: 'Priority Focus',
  description:
    'Simple priority classification. No labels — just assigns priority and flags urgent emails. Good default.',
  suggestedLabels: [],
  systemPrompt: `You are an email triage assistant focused on priority classification.
Your only job is to determine how urgent/important each email is.

Guidelines:
- "urgent" — time-sensitive, needs attention within the hour (e.g. outage, deadline today).
- "high" — important, should be addressed today (e.g. direct request from a person).
- "normal" — standard email, can be handled in normal workflow.
- "low" — informational, automated, or bulk email that can wait.

Flag only urgent and high-priority emails.
Do NOT suggest labels unless something is clearly critical.

{{CUSTOM}}

For each email respond with a JSON object:
- "priority": "urgent" | "high" | "normal" | "low"
- "labels": string[] (usually empty, only add if critical)
- "flag": boolean (true for urgent/high)
- "action": string (brief suggested action)

Respond ONLY with a JSON array (one object per email, in order). No markdown, no extra text.`,
};

const notificationOnly: HookPreset = {
  id: 'notification-only',
  name: 'Notification Only',
  description:
    'No AI triage. New emails are logged as notifications without any automatic labelling or flagging.',
  suggestedLabels: [],
  systemPrompt: '', // Not used — this preset bypasses AI
};

const custom: HookPreset = {
  id: 'custom',
  name: 'Custom',
  description:
    'Full control. Provide your own system_prompt in config. The preset contributes nothing — you define everything.',
  suggestedLabels: [],
  systemPrompt: '', // Replaced entirely by user's system_prompt config
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const PRESETS: ReadonlyMap<string, HookPreset> = new Map([
  [inboxZero.id, inboxZero],
  [gtd.id, gtd],
  [priorityFocus.id, priorityFocus],
  [notificationOnly.id, notificationOnly],
  [custom.id, custom],
]);

export const DEFAULT_PRESET_ID = 'priority-focus';

/** Get a preset by id. Returns undefined for unknown ids. */
export function getPreset(id: string): HookPreset | undefined {
  return PRESETS.get(id);
}

/** List all available presets. */
export function listPresets(): HookPreset[] {
  return [...PRESETS.values()];
}

/**
 * Build the final system prompt for AI triage by combining:
 * 1. The preset's system prompt template
 * 2. The preset's suggested labels
 * 3. The user's custom instructions (if any)
 * 4. OR the user's full system_prompt override (if preset = "custom")
 */
export function buildSystemPrompt(
  presetId: string,
  options: { customInstructions?: string; systemPrompt?: string } = {},
): string {
  // Full override for "custom" preset
  if (presetId === 'custom') {
    return (
      options.systemPrompt ??
      `You are an email triage assistant.

${options.customInstructions ?? ''}

For each email respond with a JSON object:
- "priority": "urgent" | "high" | "normal" | "low"
- "labels": string[]
- "flag": boolean
- "action": string (brief suggested action)

Respond ONLY with a JSON array (one object per email, in order). No markdown, no extra text.`
    );
  }

  const preset = getPreset(presetId) ?? getPreset(DEFAULT_PRESET_ID);

  if (!preset?.systemPrompt) return ''; // notification-only or missing

  const labelsStr =
    preset.suggestedLabels.length > 0
      ? preset.suggestedLabels.join(', ')
      : '(no specific labels — use your best judgement)';

  const customBlock = options.customInstructions
    ? `\nAdditional context from the user:\n${options.customInstructions}\n`
    : '';

  return preset.systemPrompt.replace('{{LABELS}}', labelsStr).replace('{{CUSTOM}}', customBlock);
}
