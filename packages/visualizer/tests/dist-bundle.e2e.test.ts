/**
 * Spec 042 — Visualizer Single Renderer (issue #155) — QA E2E over the built
 * artifact (AC-6 production leg + AC-1/AC-2 parity in dist).
 *
 * Every other visualizer test imports `src/` directly (the package vitest
 * config aliases workspace deps to source, and examples aliases
 * `@evol-hive/visualizer` to source too) — so nothing exercised the real
 * production artifact: `dist/index.js` built by tsup and consumed by
 * `examples`/`cli` via the package export map. That gap is exactly where the
 * tsup regression hit: tsup inlines devDependencies, so before the
 * `external: ['esbuild']` fix the dist ESM bundle inlined esbuild's CJS API
 * and every runtime bundling call threw "Dynamic require of fs is not
 * supported" (caught only by a manual `tsx examples/visualizer-demo.ts` run —
 * the AC-6 leg that has no automated check).
 *
 * This E2E imports the built `dist/index.js` (the real artifact), starts a
 * VisualizerServer from it, and verifies the served page: the esbuild client
 * bundle succeeds from the dist context, the module's grid/fog/anchor
 * formulas reach the served HTML (AC-1/AC-2), the Decision-4 legacy-slot
 * guard is present, and the spec-023 single-HTML/inline-JS contract holds.
 *
 * Skips when `dist/` has not been built yet (repo convention: package tests
 * run without a build; CI always runs `pnpm build` before `pnpm test`).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { VisualizerState, VisualizerCommand, SceneDefinition } from '@evol-hive/shared';

const DIST_ENTRY = new URL('../dist/index.js', import.meta.url);

describe('dist bundle E2E — built @evol-hive/visualizer artifact (spec 042)', () => {
  const distAvailable = existsSync(fileURLToPath(DIST_ENTRY));

  it.skipIf(!distAvailable)(
    'serves a page with the bundled renderer formulas from dist/index.js',
    async () => {
      const dist = (await import(DIST_ENTRY.href)) as {
        VisualizerServer: new (opts: Record<string, unknown>) => {
          start(): Promise<void>;
          stop(): Promise<void>;
          getPort(): number;
        };
      };
      expect(dist.VisualizerServer).toBeDefined();

      const state = {
        tickNumber: 3,
        simulationTime: 0.05,
        isRunning: true,
        timeScale: 1,
        rooms: [
          {
            id: 'garden',
            name: 'Garden',
            description: '',
            connections: [],
            objects: [
              {
                id: 'planter-1',
                name: 'Planter',
                type: 'nature',
                state: { soil: 'wet' },
                cell: { x: 2, y: 2 },
                affordances: [],
              },
            ],
          },
        ],
        agents: [
          {
            agentId: 'a1',
            name: 'Alice',
            location: 'garden',
            position: { x: 11, y: 4 },
            drives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
            currentGoal: '',
            currentPlan: null,
            pperPhase: 'perceive',
            isThinking: false,
            relationships: [],
            fog: { visitedRooms: ['garden'], exploredCells: { garden: ['11,4'] } },
          },
        ],
      } as unknown as VisualizerState;

      const scene: SceneDefinition = {
        id: 'minimal',
        name: 'Minimal',
        rooms: [{ id: 'garden', name: 'Garden', description: '', connections: [], objectIds: [] }],
        objects: [],
        agents: [],
      };

      const server = new dist.VisualizerServer({
        adapter: {
          getSnapshot: () => state,
          handleCommand: async (_cmd: VisualizerCommand) => {},
        },
        port: 0,
        snapshotRateMs: 50,
        scenes: new Map<string, SceneDefinition>([['minimal', scene]]),
      });
      try {
        await server.start();
        const res = await fetch(`http://localhost:${server.getPort()}/`);
        expect(res.status).toBe(200);
        const html = await res.text();

        // The esbuild client bundle succeeded inside the dist artifact and the
        // module's formulas reached the served page (AC-1, AC-2 parity in the
        // production artifact).
        expect(html).toContain('agent.position.x + 0.5'); // grid-cell math (AC-1)
        expect(html).toContain('* roomPos.w / 12');
        expect(html).toContain('* roomPos.h / 8');
        expect(html).toContain('rgba(10, 10, 24, 0.78)'); // fog fill (AC-2)
        expect(html).toContain('obj.cell.x * roomW / 12'); // anchor cells (AC-2)
        expect(html).toContain('sentimentTint'); // conversation chips (AC-2)
        // Decision 4: the guarded legacy-slot fallback is inherited, and the
        // legacy template's unconditional slot line stays gone (AC-1).
        expect(html).toContain('agent.position !== void 0');
        expect(html).not.toContain('rp.x + 40 + idx * 60');
        // Spec-023 browser contract: single inline script, no external src.
        expect(html.match(/<script/g)?.length).toBe(1);
        expect(html).not.toMatch(/<script[^>]*src=/);
      } finally {
        await server.stop();
      }
    },
  );

  it.skipIf(!distAvailable)('dist bundle does not inline the esbuild API', async () => {
    // The tsup regression guard: esbuild's build API must stay an external
    // runtime import of the dist bundle, not an inlined CJS copy (which broke
    // the ESM output with "Dynamic require of fs is not supported").
    const src = (await import('node:fs')).readFileSync(fileURLToPath(DIST_ENTRY), 'utf8');
    expect(src).toMatch(/import\s*\{[^}]*buildSync[^}]*\}\s*from\s*['"]esbuild['"]/);
  });
});
