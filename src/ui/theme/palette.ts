/**
 * Raw color primitives. Never import these directly in screens/components —
 * go through `colors.ts` semantic tokens so light/dark stays consistent.
 *
 * Brand identity: deep violet ("Nightshade") as primary, warm coral
 * ("Ember") as accent. Deliberately not blue (Telegram/Signal) or
 * yellow (Snapchat).
 */
export const palette = {
  violet50: '#F1EFFE',
  violet100: '#E2DEFD',
  violet200: '#C4BAFB',
  violet300: '#A292F7',
  violet400: '#8B7CFF',
  violet500: '#6C5CE0',
  violet600: '#5B4EE8',
  violet700: '#4A3FC4',
  violet800: '#372E93',
  violet900: '#231E5C',
  violet950: '#150F3D',

  coral300: '#FFB39C',
  coral400: '#FF9478',
  coral500: '#FF7A59',
  coral600: '#F0603D',

  neutral0: '#FFFFFF',
  neutral25: '#FAF9FC',
  neutral50: '#F3F1F8',
  neutral100: '#E7E4F0',
  neutral200: '#D3CFE2',
  neutral300: '#A39FB5',
  neutral400: '#79758C',
  neutral500: '#5B5770',
  neutral600: '#443F58',
  neutral700: '#302B42',
  neutral800: '#201A2C',
  neutral850: '#17131F',
  neutral900: '#14121F',
  neutral950: '#0E0B16',

  green400: '#34D399',
  green500: '#2FBF71',
  red400: '#F87171',
  red500: '#E5484D',
  amber400: '#FBBF24',
} as const;
