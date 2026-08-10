import { randomInt } from 'node:crypto';

/**
 * A real, security-relevant secret — unlike the Phase 1B client mock
 * (Math.random, decorative), this is generated with a CSPRNG and only
 * ever hashed, never stored. A 12-word code drawn without replacement
 * from a 60-word list is ~68 bits of entropy (log2(60P12)), comfortably
 * above what Argon2id-backed brute-force resistance needs it to be.
 */
const RECOVERY_WORDLIST = [
  'anchor', 'basalt', 'beacon', 'birch', 'cedar', 'cinder', 'coral', 'delta',
  'driftwood', 'ember', 'falcon', 'fjord', 'glacier', 'granite', 'harbor',
  'hazel', 'heron', 'horizon', 'indigo', 'juniper', 'kestrel', 'lantern',
  'lichen', 'linden', 'maple', 'meadow', 'mesa', 'nectar', 'nimbus', 'oasis',
  'obsidian', 'opal', 'orchard', 'osprey', 'pebble', 'pine', 'plateau',
  'quartz', 'raven', 'reed', 'ridge', 'river', 'saffron', 'sequoia',
  'slate', 'sparrow', 'spruce', 'summit', 'tern', 'thicket', 'thistle',
  'timber', 'tundra', 'umbra', 'valley', 'velvet', 'willow', 'wren',
  'zephyr', 'zinc',
];

export function generateRecoveryCode(wordCount = 12): string[] {
  const pool = [...RECOVERY_WORDLIST];
  const words: string[] = [];
  for (let i = 0; i < wordCount && pool.length > 0; i += 1) {
    const index = randomInt(pool.length);
    words.push(pool.splice(index, 1)[0] ?? '');
  }
  return words;
}

export function recoveryCodeToString(words: string[]): string {
  return words.join(' ');
}

export function parseRecoveryCodeInput(raw: string): string {
  // Normalize whitespace so "word1  word2\nword3" and "word1 word2 word3"
  // hash identically — this must exactly mirror whatever normalization
  // happens (or doesn't) at generation time before hashing.
  return raw.trim().toLowerCase().split(/\s+/).join(' ');
}
