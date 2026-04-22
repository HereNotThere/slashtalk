import type { NewChatHead } from '../../shared/types';

export const PRESETS: NewChatHead[] = [
  { label: 'Basketball', tint: '#ff8c1a', avatar: { type: 'emoji', value: '🏀' } },
  { label: 'Frog',       tint: '#3ab546', avatar: { type: 'emoji', value: '🐸' } },
  { label: 'Moai',       tint: '#9a9a9a', avatar: { type: 'emoji', value: '🗿' } },
  { label: 'Alien',      tint: '#a24bff', avatar: { type: 'emoji', value: '👾' } },
];

// Stable username → hue color. Swift uses HSB(s=0.55, b=0.85); HSL approximation below.
export function tintForUsername(username: string): string {
  let hash = 0;
  for (const ch of username) hash = (hash + (ch.codePointAt(0) ?? 0) * 2654435761) >>> 0;
  const hue = hash % 360;
  return `hsl(${hue}deg 55% 62%)`;
}
