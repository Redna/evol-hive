/**
 * renderer/theme.ts — the single source of colour/typography tokens (spec 062,
 * R5). Draw code reads tokens from here instead of scattering colour literals,
 * so the palette can be tuned in one place (and a future sprite skin can reuse
 * it).
 */

/** Fog shading fill for unexplored cells (spec 039 R8). */
export const FOG_CELL_FILL = 'rgba(10, 10, 24, 0.78)';

export const THEME = {
  bg: '#0b0f1a',
  bgHi: '#0e1424',
  roomFloor: '#141c2e',
  roomHeader: '#1b2438',
  roomBorder: '#2f4066',
  grid: 'rgba(255, 255, 255, 0.035)',
  text: '#e6edf7',
  muted: '#8b9bb4',
  door: '#3d4d6d',
  doorBridge: '#1a2437',
  chip: '#1e2941',
  chipShadow: 'rgba(0, 0, 0, 0.28)',
  panel: 'rgba(11, 15, 26, 0.82)',
  select: '#5eead4',
  thinkHalo: 'rgba(94, 234, 212, 0.13)',
} as const;

/** PPER phase → ring colour (spec 023 Req 12). */
export const PHASE_COLORS: Record<string, string> = {
  perceive: '#60a5fa',
  plan: '#fbbf24',
  execute: '#fb923c',
  reflect: '#c084fc',
};

/** Drive keys in canonical order, with display label and colour. */
export const DRIVES: {
  key: 'energy' | 'hunger' | 'social' | 'comfort' | 'curiosity';
  label: string;
  color: string;
}[] = [
  { key: 'energy', label: 'E', color: '#f87171' },
  { key: 'hunger', label: 'H', color: '#fb923c' },
  { key: 'social', label: 'S', color: '#60a5fa' },
  { key: 'comfort', label: 'C', color: '#34d399' },
  { key: 'curiosity', label: 'B', color: '#a78bfa' },
];

/** Stable per-agent identity colours, indexed by agent order. */
export const AGENT_COLORS = ['#5eead4', '#fbbf24', '#f472b6', '#60a5fa', '#a3e635'];

/** Darken a hex colour towards black by `amt` (0–1) — depth without gradients. */
export function shade(hex: string, amt: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, Math.round(((n >> 16) & 255) * (1 - amt))));
  const g = Math.max(0, Math.min(255, Math.round(((n >> 8) & 255) * (1 - amt))));
  const b = Math.max(0, Math.min(255, Math.round((n & 255) * (1 - amt))));
  return `rgb(${r},${g},${b})`;
}
