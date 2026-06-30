// Top TLDs compressed to single-char keys via toString(36).
// Limited to 36 entries so every ID is one character (0-9, a-z).
// Picked from general knowledge of real-world web prevalence, not DNS
// resolver traffic (which over-indexes on bot/scanner noise and skews
// toward regionally dominant ccTLDs like .ru/.cn/.ir).
export const TLDS: readonly string[] = [
  // Dominant generic TLDs
  'com', 'org', 'net',

  // High-volume gTLDs (including internationally-adopted ccTLDs like io/co/me/tv/ai)
  'io', 'co', 'me', 'tv', 'ai',
  'info', 'biz', 'xyz', 'app', 'dev', 'moe',
  'shop', 'online', 'top', 'site', 'club',
  'store', 'tech', 'blog', 'live', 'gov',

  // Major ccTLDs
  'uk', 'de', 'us', 'eu', 'ca', 'au',
  'jp', 'cn', 'in', 'br', 'fr', 'ru'
];

const tld_to_id = new Map<string, string>();
const id_to_tld = new Map<string, string>();

for (let i = 0, len = TLDS.length; i < len; i++) {
  const s = i.toString(36);
  tld_to_id.set(TLDS[i], s);
  id_to_tld.set(s, TLDS[i]);
}

export const TLD_TO_ID: ReadonlyMap<string, string> = tld_to_id;
export const ID_TO_TLD: ReadonlyMap<string, string> = id_to_tld;
