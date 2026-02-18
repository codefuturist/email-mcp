/**
 * Detect video-conferencing / meeting URLs from email body text.
 */

export interface MeetingUrl {
  url: string;
  label: string;
}

const MEETING_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /https?:\/\/(?:\w+\.)?zoom\.us\/j\/[\w?=&%-]+/i, label: 'Zoom' },
  { re: /https?:\/\/teams\.microsoft\.com\/l\/meetup-join\/[\w/?=&%._~:-]+/i, label: 'Microsoft Teams' },
  { re: /https?:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i, label: 'Google Meet' },
  { re: /https?:\/\/[\w-]+\.webex\.com\/meet\/[\w/.-]+/i, label: 'Webex' },
  { re: /https?:\/\/[\w-]+\.webex\.com\/j\.php\?[\w=&%-]+/i, label: 'Webex' },
  { re: /https?:\/\/global\.gotomeeting\.com\/join\/\d+/i, label: 'GoToMeeting' },
  { re: /https?:\/\/[\w.-]*jitsi\.org\/[\w-]+/i, label: 'Jitsi' },
  { re: /https?:\/\/bluejeans\.com\/\d+/i, label: 'BlueJeans' },
  { re: /https?:\/\/whereby\.com\/[\w-]+/i, label: 'Whereby' },
];

/** Extract the first recognised meeting URL from body text. */
export function extractMeetingUrl(text: string): MeetingUrl | undefined {
  if (!text) return undefined;

  const found = MEETING_PATTERNS.find(({ re }) => re.test(text));
  if (!found) return undefined;

  const m = text.match(found.re);
  if (!m) return undefined;

  return { url: m[0].replace(/[>)"'\s]+$/, ''), label: found.label };
}
