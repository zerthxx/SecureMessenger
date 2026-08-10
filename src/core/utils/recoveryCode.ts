const RECOVERY_WORDLIST = [
  'anchor', 'beacon', 'cedar', 'delta', 'ember', 'falcon', 'glacier', 'harbor',
  'indigo', 'juniper', 'kestrel', 'lantern', 'meadow', 'nectar', 'oasis', 'pebble',
  'quartz', 'raven', 'summit', 'timber', 'umbra', 'velvet', 'willow', 'zephyr',
  'amber', 'basalt', 'coral', 'driftwood', 'granite', 'horizon',
];

/** Client-side mock only — not a real cryptographic recovery phrase. */
export function generateMockRecoveryCode(count = 12): string[] {
  const pool = [...RECOVERY_WORDLIST];
  const result: string[] = [];
  for (let i = 0; i < count && pool.length > 0; i += 1) {
    const index = Math.floor(Math.random() * pool.length);
    result.push(pool.splice(index, 1)[0] ?? '');
  }
  return result;
}
