/**
 * Extract conference call details (dial-in, meeting ID, passcode) from email body text.
 */

export interface ConferenceDetails {
  dialIn?: string;
  meetingId?: string;
  passcode?: string;
  provider?: string;
}

// Meeting ID patterns (Zoom "123 456 789", Teams "123 456 789 012", Webex "1234 567 890")
const MEETING_ID_PATTERNS = [
  /(?:meeting|conference|webinar)\s+id[:\s]+(\d[\d\s]{6,14}\d)/i,
  /(?:meeting|conference)\s+(?:id|number)[:\s]+(\d[\d\s]{6,14}\d)/i,
  /id[:\s]+(\d{3}\s\d{3}\s\d{3,6})/i,
];

// Passcode / PIN patterns
const PASSCODE_PATTERNS = [
  /(?:passcode|password|pin|access code)[:\s]+(\d{4,12})/i,
  /(?:meeting\s+)?password[:\s]+([A-Za-z0-9!@#$%^&*]{4,20})/i,
];

// International dial-in phone number patterns
const DIAL_IN_PATTERNS = [
  /(?:dial[\s-]*(?:in|by\s+your\s+location)?|phone(?:\s+number)?|call)[:\s]+(\+?[\d\s().,-]{8,25})/i,
  /(?:one\s+tap\s+mobile|one-tap)[:\s]*(\+?\d[\d,*#]+)/i,
  /(\+\d{1,3}[\s.-]\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4})/,
  /(\+\d{10,15})/,
];

function cleanPhone(raw: string): string {
  return raw.replace(/[^\d+\s()-]/g, '').trim().replace(/\s{2,}/g, ' ');
}

function cleanId(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** Extract conference details from body text. Returns undefined if nothing found. */
export function extractConferenceDetails(text: string): ConferenceDetails | undefined {
  if (!text) return undefined;

  const details: ConferenceDetails = {};

  const meetingMatch = MEETING_ID_PATTERNS.reduce<RegExpMatchArray | null>(
    (acc, re) => acc ?? text.match(re),
    null,
  );
  if (meetingMatch?.[1]) details.meetingId = cleanId(meetingMatch[1]);

  const passcodeMatch = PASSCODE_PATTERNS.reduce<RegExpMatchArray | null>(
    (acc, re) => acc ?? text.match(re),
    null,
  );
  if (passcodeMatch?.[1]) details.passcode = passcodeMatch[1].trim();

  const dialInMatch = DIAL_IN_PATTERNS.reduce<RegExpMatchArray | null>((acc, re) => {
    if (acc) return acc;
    const m = text.match(re);
    if (!m?.[1]) return null;
    const cleaned = cleanPhone(m[1]);
    return (cleaned.match(/\d/g) ?? []).length >= 7 ? m : null;
  }, null);
  if (dialInMatch?.[1]) details.dialIn = cleanPhone(dialInMatch[1]);

  // Provider detection from domain keywords
  if (/zoom\.us/i.test(text)) details.provider = 'Zoom';
  else if (/teams\.microsoft\.com/i.test(text)) details.provider = 'Microsoft Teams';
  else if (/meet\.google\.com/i.test(text)) details.provider = 'Google Meet';
  else if (/webex\.com/i.test(text)) details.provider = 'Webex';
  else if (/gotomeeting\.com/i.test(text)) details.provider = 'GoToMeeting';
  else if (/jitsi/i.test(text)) details.provider = 'Jitsi';
  else if (/bluejeans\.com/i.test(text)) details.provider = 'BlueJeans';

  const hasData =
    details.dialIn ?? details.meetingId ?? details.passcode ?? details.provider;
  return hasData ? details : undefined;
}
