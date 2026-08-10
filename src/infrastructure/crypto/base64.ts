// Manual base64 <-> bytes, deliberately not relying on `Buffer`/`btoa`/
// `atob` — none of those are guaranteed present on Hermes without a
// polyfill, and this is on the direct path between the native E2EE
// module and the wire (ciphertext, KeyPackages, Welcome messages), so
// it should not depend on incidental JS-engine globals.

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let output = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const hasB1 = i + 1 < bytes.length;
    const hasB2 = i + 2 < bytes.length;

    output += CHARS[b0 >> 2];
    output += CHARS[((b0 & 0x03) << 4) | (b1 >> 4)];
    output += hasB1 ? CHARS[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    output += hasB2 ? CHARS[b2 & 0x3f] : '=';
  }
  return output;
}

export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/[^A-Za-z0-9+/]/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    // Position-bounds-checked, not `CHARS.indexOf(clean[i] ?? '')` — an
    // out-of-range index yields `undefined`, and `''.indexOf` quirks
    // aside, `CHARS.indexOf('')` returns 0 (every string "contains" the
    // empty string at position 0), not -1. That silently turned a
    // missing trailing char into a valid zero-value char, appending a
    // spurious extra byte to every decode whose input length wasn't a
    // multiple of 3 — corrupting KeyPackages, Welcome messages, and any
    // ciphertext of such a length.
    const c0 = CHARS.indexOf(clean[i] ?? '');
    const c1 = CHARS.indexOf(clean[i + 1] ?? '');
    const c2 = i + 2 < clean.length ? CHARS.indexOf(clean[i + 2] ?? '') : -1;
    const c3 = i + 3 < clean.length ? CHARS.indexOf(clean[i + 3] ?? '') : -1;

    bytes.push(((c0 << 2) | (c1 >> 4)) & 0xff);
    if (c2 >= 0) bytes.push(((c1 << 4) | (c2 >> 2)) & 0xff);
    if (c3 >= 0) bytes.push(((c2 << 6) | c3) & 0xff);
  }
  return new Uint8Array(bytes);
}
