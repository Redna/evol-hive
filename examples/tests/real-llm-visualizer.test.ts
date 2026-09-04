/**
 * Spec 027 — Real-LLM Visualizer Demo (issue #106)
 * ────────────────────────────────────────────────────────────────────────────
 * Tests for wiring real PPER cycles into examples/visualizer-demo.ts via the
 * shared assembly helper (examples/assembly.ts) and YAML scene loading.
 *
 * All tests run against a scripted local LLM HTTP server — no external
 * services, no Ollama required. Mock mode (env unset) makes zero network calls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { SceneDefinition } from '@evol-hive/shared';
import { loadSceneFile } from '@evol-hive/engine';
import {
  PPEROrchestratorImpl,
  OpenAICompatibleLLMClient,
  GuardrailEngineImpl,
} from '@evol-hive/cognition';

import { buildCoffeeShopEngine, CoffeeShopMockLLMClient } from '../coffee-shop.ts';
import { assembleCognitionStack, buildMemorySubsystem } from '../assembly.ts';
import {
  startVisualizerDemo,
  checkLLMHealth,
  buildSceneMap,
  MockOrchestrator,
} from '../visualizer-demo.ts';

// ── Env helpers ──────────────────────────────────────────────────────────────

const ENV_KEYS = [
  'USE_REAL_LLM',
  'USE_REAL_EMBEDDINGS',
  'LLM_BASE_URL',
  'LLM_MODEL',
  'LLM_API_KEY',
  'LLM_REASONING_EFFORT',
  'LLM_MAX_TOOL_CALL_ITERATIONS',
  'EMBEDDING_MODEL_PATH',
  'EMBEDDING_TOKENIZER_PATH',
] as const;

/** Save env vars, mutate, and restore after the (possibly async) callback. */
async function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
}

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  vi.restoreAllMocks();
});

// ── Scripted LLM server ──────────────────────────────────────────────────────

interface ScriptedRequestRecord {
  /** True when the request carried the formulate_plan tool (plan phase). */
  isPlanPhase: boolean;
  room: string;
  drive: string;
}

interface ScriptedLLMServer {
  /** Base URL to use as LLM_BASE_URL (includes /v1). */
  url: string;
  requests: ScriptedRequestRecord[];
  /** When true, plan-phase responses are held until release() is called. */
  holdPlanResponses: boolean;
  /** Release all held plan responses. */
  release: () => void;
  close: () => Promise<void>;
}

/** Drive-based affordance selection — mirrors CoffeeShopMockLLMClient (spec 019). */
function selectAffordance(room: string, drive: string): string {
  if (drive === 'energy') {
    if (room === 'kitchen') return 'brew_coffee';
    return 'go_to_kitchen';
  }
  if (drive === 'social') {
    if (room === 'living_room') return 'relax';
    return 'go_to_living_room';
  }
  if (drive === 'curiosity') {
    if (room === 'garden') return 'observe_flowers';
    if (room === 'living_room') return 'read_book';
    return 'go_to_living_room';
  }
  if (drive === 'comfort') {
    if (room === 'living_room') return 'relax';
    if (room === 'garden') return 'sit_outside';
    if (room === 'bathroom') return 'use_bathroom';
    return 'go_to_living_room';
  }
  return 'observe';
}

/** Build an OpenAI-style tool_calls response envelope. */
function toolCallEnvelope(name: string, args: unknown): string {
  return JSON.stringify({
    choices: [
      {
        message: {
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
      },
    ],
  });
}

/**
 * Start a scripted local LLM server that speaks the OpenAI tool-call protocol
 * used by OpenAICompatibleLLMClient. Plan requests get a drive-appropriate
 * affordance plan; reflect requests get a minimal memory entry.
 */
async function startScriptedLLMServer(): Promise<ScriptedLLMServer> {
  const requests: ScriptedRequestRecord[] = [];
  let holdPlanResponses = false;
  let heldResponders: (() => void)[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
        messages?: { content?: string | null }[];
        tools?: { function?: { name?: string } }[];
      };
      const text = (body.messages ?? [])
        .map((m) => (typeof m.content === 'string' ? m.content : ''))
        .join('\n');
      const room = text.match(/^Room: (.+)$/m)?.[1] ?? '';
      const drive = text.match(/Primary drive: low (\w+),/)?.[1] ?? '';
      const isPlanPhase = (body.tools ?? []).some((t) => t.function?.name === 'formulate_plan');
      requests.push({ isPlanPhase, room, drive });

      const respond = (): void => {
        res.writeHead(200, { 'content-type': 'application/json' });
        if (isPlanPhase) {
          const action = selectAffordance(room, drive);
          res.end(
            toolCallEnvelope('formulate_plan', {
              description: `Address ${drive} in ${room}`,
              steps: [{ description: `Use ${action}`, targetAffordance: action }],
            }),
          );
        } else {
          res.end(
            toolCallEnvelope('reflect', {
              memoryContent: `Reflected while in ${room}.`,
              memoryImportance: 3,
              memoryType: 'action',
              memoryLocation: room,
            }),
          );
        }
      };

      if (isPlanPhase && holdPlanResponses) {
        heldResponders.push(respond);
      } else {
        respond();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${addr.port}/v1`,
    requests,
    get holdPlanResponses() {
      return holdPlanResponses;
    },
    set holdPlanResponses(v: boolean) {
      holdPlanResponses = v;
    },
    release() {
      const all = heldResponders;
      heldResponders = [];
      for (const fn of all) fn();
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** Wait until `predicate` is true or the deadline passes (polls every 10ms). */
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  message = 'condition not met in time',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(message);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ── AC-1: Shared assembly helper exists; coffee-shop delegates to it ─────────

describe('AC-1: shared assembly helper (examples/assembly.ts)', () => {
  it('exports assembleCognitionStack and buildMemorySubsystem', () => {
    expect(typeof assembleCognitionStack).toBe('function');
    expect(typeof buildMemorySubsystem).toBe('function');
  });

  it('buildCoffeeShopEngine has no direct LLM/guardrail/orchestrator construction', () => {
    const source = readFileSync(new URL('../coffee-shop.ts', import.meta.url), 'utf-8');
    expect(source).not.toMatch(/new OpenAICompatibleLLMClient/);
    expect(source).not.toMatch(/new GuardrailEngineImpl/);
    expect(source).not.toMatch(/createPPEROrchestrator\(/);
    expect(source).toMatch(/assembleCognitionStack\(/);
  });

  it('buildCoffeeShopEngine keeps the CoffeeShopAssembledEngine shape (mock mode)', async () => {
    const engine = await withEnv({}, () => buildCoffeeShopEngine());
    expect(engine.socialManager).toBeDefined();
    expect(engine.llmClient).toBeInstanceOf(CoffeeShopMockLLMClient);
    expect(engine.tokenUsageReporter).toBeDefined();
    expect(engine.guardrail).toBeInstanceOf(GuardrailEngineImpl);
    expect(engine.embeddingProvider).toBeDefined();
    expect(engine.classifier).toBeDefined();
    expect(engine.vectorStore).toBeDefined();
    expect(engine.memoryDecayService).toBeDefined();
    expect(engine.reflectionLoop).toBeDefined();
    // Base AssembledEngine fields.
    expect(engine.gameLoop).toBeDefined();
    expect(engine.agentManager).toBeDefined();
    expect(engine.sceneManager).toBeDefined();
    expect(engine.smartObjectRegistry).toBeDefined();
    expect(engine.affordanceRegistry).toBeDefined();
    expect(engine.bridges).toBeDefined();
  });

  it('real-mode coffee-shop engine still uses OpenAICompatibleLLMClient via the helper', async () => {
    await withEnv({ USE_REAL_LLM: 'true', LLM_BASE_URL: 'http://localhost:11434/v1' }, () => {
      const engine = buildCoffeeShopEngine();
      expect(engine.llmClient).toBeInstanceOf(OpenAICompatibleLLMClient);
      expect(engine.guardrail).toBeInstanceOf(GuardrailEngineImpl);
    });
  });
});

// ── AC-2: Demo orchestrator is real with USE_REAL_LLM=true, mock otherwise ───

describe('AC-2: demo orchestrator selection via USE_REAL_LLM', () => {
  it('uses MockOrchestrator when the env var is unset', async () => {
    const handle = await startVisualizerDemo({ port: 0 });
    try {
      expect(handle.orchestrator).toBeInstanceOf(MockOrchestrator);
      expect(handle.orchestrator).not.toBeInstanceOf(PPEROrchestratorImpl);
      // No LLM client is wired in mock mode — the demo performs no LLM calls.
      expect(handle.llmClient).toBeUndefined();
    } finally {
      await handle.stop();
    }
  });

  it('uses a real PPEROrchestrator when USE_REAL_LLM=true', async () => {
    const llm = await startScriptedLLMServer();
    try {
      const handle = await withEnv({ USE_REAL_LLM: 'true', LLM_BASE_URL: llm.url }, async () =>
        startVisualizerDemo({ port: 0 }),
      );
      try {
        expect(handle.orchestrator).toBeInstanceOf(PPEROrchestratorImpl);
        expect(handle.orchestrator).not.toBeInstanceOf(MockOrchestrator);
        expect(handle.llmClient).toBeInstanceOf(OpenAICompatibleLLMClient);
        expect(handle.guardrail).toBeInstanceOf(GuardrailEngineImpl);
      } finally {
        await handle.stop();
      }
    } finally {
      await llm.close();
    }
  });

  it('adapter snapshots report live getPhase() values (not static)', async () => {
    const llm = await startScriptedLLMServer();
    // Hold the first plan response so the cycle is observable mid-plan.
    llm.holdPlanResponses = true;
    try {
      const handle = await withEnv({ USE_REAL_LLM: 'true', LLM_BASE_URL: llm.url }, async () =>
        startVisualizerDemo({ port: 0 }),
      );
      try {
        // Fire a cycle without awaiting — the plan phase blocks on the gate.
        const cycle = handle.orchestrator.runCycle('agent-alice');
        // The adapter must report the orchestrator's live (non-static) phase.
        await waitFor(
          () =>
            handle.adapter.getSnapshot().agents.find((a) => a.agentId === 'agent-alice')
              ?.pperPhase === 'plan',
          8000,
          'adapter snapshot never reported the live plan phase',
        );
        // Stop holding BEFORE releasing: a request still in flight may arrive
        // after this point — it must be answered directly, not held forever
        // (the phase is set before the fetch hits the wire, so the poll can
        // observe 'plan' before the stub has even received the request).
        llm.holdPlanResponses = false;
        llm.release();
        await cycle;
      } finally {
        llm.holdPlanResponses = false;
        llm.release();
        await handle.stop();
      }
    } finally {
      await llm.close();
    }
  }, 20_000);
});

// ── AC-3: Coffee-shop scene loaded from YAML via loadSceneFile ───────────────

describe('AC-3: YAML scene loading', () => {
  it('visualizer-demo.ts does not import COFFEE_SHOP_SCENE from coffee-shop', () => {
    const source = readFileSync(new URL('../visualizer-demo.ts', import.meta.url), 'utf-8');
    expect(source).not.toContain("from './coffee-shop.js'");
    expect(source).not.toContain('COFFEE_SHOP_SCENE');
    expect(source).toMatch(/loadSceneFile\(/);
  });

  it('buildSceneMap builds the coffee-shop scene from the YAML file', async () => {
    const scenes = await buildSceneMap();
    const scene = scenes.get('coffee-shop');
    expect(scene).toBeDefined();
    expect(scene!.id).toBe('coffee-shop');
    expect(scene!.name).toBe('Coffee Shop');

    // The 4 YAML rooms.
    const roomIds = scene!.rooms.map((r) => r.id);
    expect(roomIds).toEqual(['kitchen', 'living_room', 'bathroom', 'garden']);

    // The YAML object set: 7 declared objects + auto-generated doorways.
    const declared = scene!.objects
      .filter((o) => o.type !== 'doorway')
      .map((o) => o.id)
      .sort();
    expect(declared).toEqual(
      ['bench-1', 'bookshelf-1', 'coffee-1', 'flowerbed-1', 'sink-1', 'sofa-1', 'toilet-1'].sort(),
    );
    // Doorways are auto-generated from room connections.
    const doorwayIds = scene!.objects.filter((o) => o.type === 'doorway').map((o) => o.id);
    expect(doorwayIds).toEqual(
      expect.arrayContaining([
        'doorway-kitchen',
        'doorway-living_room',
        'doorway-bathroom',
        'doorway-garden',
      ]),
    );

    // 3 agents as in the YAML.
    expect(scene!.agents.map((a) => a.id).sort()).toEqual([
      'agent-alice',
      'agent-bob',
      'agent-carol',
    ]);
  });

  it('deep-equals a direct loadSceneFile of examples/coffee-shop.scene.yaml', async () => {
    const scenes = await buildSceneMap();
    const direct = await loadSceneFile(
      new URL('../coffee-shop.scene.yaml', import.meta.url).pathname,
    );
    expect(scenes.get('coffee-shop')).toEqual(direct);
  });
});

// ── AC-4: Demo scene map integrity ──────────────────────────────────────────

describe('AC-4: demo scene map contains all three scenes', () => {
  it('exposes minimal, morning-routine, and coffee-shop', async () => {
    const scenes = await buildSceneMap();
    expect([...scenes.keys()].sort()).toEqual(['coffee-shop', 'minimal', 'morning-routine']);
    expect(scenes.get('minimal')!.id).toBe('minimal');
    expect(scenes.get('morning-routine')!.id).toBe('morning-routine');
  });

  it('minimal and morning-routine keep their inline definitions (rooms/objects/agents)', async () => {
    const scenes = await buildSceneMap();
    const minimal = scenes.get('minimal')!;
    expect(minimal.rooms.map((r) => r.id)).toEqual(['kitchen']);
    expect(minimal.objects.map((o) => o.id)).toEqual(['coffee-1']);
    expect(minimal.agents.map((a) => a.id)).toEqual(['agent-1']);

    const morning = scenes.get('morning-routine')!;
    expect(morning.rooms.map((r) => r.id).sort()).toEqual(['bedroom', 'kitchen']);
    expect(morning.objects.map((o) => o.id).sort()).toEqual(['bed-1', 'coffee-1']);
    expect(morning.agents.map((a) => a.id)).toEqual(['agent-2']);
  });
});

// ── AC-5: Real PPER cycles mutate state the visualizer renders ───────────────

describe('AC-5: executed PPER cycles drive live visualizer state', () => {
  it('agents move kitchen↔living_room, water_level drops below 5, and drives change', async () => {
    const llm = await startScriptedLLMServer();
    try {
      const handle = await withEnv({ USE_REAL_LLM: 'true', LLM_BASE_URL: llm.url }, async () =>
        startVisualizerDemo({ port: 0 }),
      );
      try {
        const { core } = handle;
        const initial = new Map<string, Record<string, number>>();
        for (const agent of core.agentManager.getActiveAgents()) {
          initial.set(agent.agentId, { ...agent.drives });
        }

        const observedLocations = new Map<string, Set<string>>();
        let minWaterLevel = Number.POSITIVE_INFINITY;
        let driveIncreaseObserved = false;
        let phaseValuesObserved = new Set<string>();

        const movedBetweenKitchenAndLivingRoom = (): boolean =>
          [...observedLocations.values()].some(
            (locs) => locs.has('kitchen') && locs.has('living_room'),
          );

        // Run the game loop: inject deterministic ticks and sample state while
        // fired-and-forgotten cycles complete against the scripted server.
        for (
          let burst = 0;
          burst < 60 &&
          !(minWaterLevel < 5 && driveIncreaseObserved && movedBetweenKitchenAndLivingRoom());
          burst++
        ) {
          core.gameLoop.injectElapsed(0.25); // 15 ticks at 60 FPS
          // Let in-flight cycles (HTTP to the local stub) settle, sampling state.
          for (let sample = 0; sample < 12; sample++) {
            for (const agent of core.agentManager.getActiveAgents()) {
              const locs = observedLocations.get(agent.agentId) ?? new Set<string>();
              locs.add(agent.location);
              observedLocations.set(agent.agentId, locs);
              for (const [drive, value] of Object.entries(agent.drives)) {
                if (value > (initial.get(agent.agentId)?.[drive] ?? -Infinity)) {
                  driveIncreaseObserved = true;
                }
              }
            }
            const coffee = core.smartObjectRegistry.get('coffee-1');
            if (coffee) {
              const water = coffee.state['water_level'];
              if (typeof water === 'number') minWaterLevel = Math.min(minWaterLevel, water);
            }
            const snap = handle.adapter.getSnapshot();
            for (const a of snap.agents) phaseValuesObserved.add(a.pperPhase);
            await new Promise((r) => setTimeout(r, 10));
          }
        }

        // At least one agent moved between kitchen and living_room (AC-5a).
        expect(movedBetweenKitchenAndLivingRoom()).toBe(true);

        // The coffee machine's water_level dropped below its initial 5 (AC-5b).
        expect(minWaterLevel).toBeLessThan(5);

        // At least one agent's drives changed via executed driveChanges (AC-5c).
        expect(driveIncreaseObserved).toBe(true);

        // The real orchestrator reported phases through the adapter (AC-2/Req 8).
        expect(phaseValuesObserved.size).toBeGreaterThan(0);
        expect(llm.requests.some((r) => r.isPlanPhase)).toBe(true);
      } finally {
        await handle.stop();
      }
    } finally {
      await llm.close();
    }
  }, 30_000);
});

// ── AC-7: Startup LLM health check ──────────────────────────────────────────

describe('AC-7: startup LLM health check', () => {
  it('fails loudly (non-zero message incl. URL + model) when the backend is unreachable', async () => {
    await withEnv(
      {
        USE_REAL_LLM: 'true',
        LLM_BASE_URL: 'http://127.0.0.1:9/v1',
        LLM_MODEL: 'llama3.1',
      },
      async () => {
        await expect(startVisualizerDemo({ port: 0, healthCheckTimeoutMs: 500 })).rejects.toThrow(
          /http:\/\/127\.0\.0\.1:9\/v1/,
        );
        await expect(checkLLMHealth({ timeoutMs: 500 })).rejects.toThrow(
          /http:\/\/127\.0\.0\.1:9\/v1.*llama3\.1|llama3\.1.*http:\/\/127\.0\.0\.1:9\/v1/s,
        );
      },
    );
    // The failing demo must not leave a server behind.
  });

  it('checkLLMHealth succeeds against the scripted server', async () => {
    const llm = await startScriptedLLMServer();
    try {
      await withEnv({ LLM_BASE_URL: llm.url, LLM_MODEL: 'llama3.1' }, async () => {
        await expect(checkLLMHealth({ timeoutMs: 2000 })).resolves.toBeUndefined();
      });
    } finally {
      await llm.close();
    }
  });

  it('mock mode starts with no network activity (no socket connections attempted)', async () => {
    const socketConnect = vi.spyOn(net.Socket.prototype, 'connect');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const handle = await startVisualizerDemo({ port: 0 });
    try {
      expect(handle.orchestrator).toBeInstanceOf(MockOrchestrator);
      // Give the (non-thinking) demo a moment — still no network.
      await new Promise((r) => setTimeout(r, 100));
      expect(socketConnect).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await handle.stop();
    }
  });
});

// ── AC-9: Env-var parity between buildCoffeeShopEngine and the demo ──────────

describe('AC-9: env-var parity of the shared assembly', () => {
  it('produces llmClients with the same baseUrl and model in both entry points', async () => {
    const llm = await startScriptedLLMServer();
    try {
      const env = {
        USE_REAL_LLM: 'true',
        LLM_BASE_URL: llm.url,
        LLM_MODEL: 'test-model-106',
        LLM_API_KEY: 'sk-parity-test',
      };

      const coffeeClient = await withEnv(env, () => buildCoffeeShopEngine().llmClient);
      const demoHandle = await withEnv(env, async () => startVisualizerDemo({ port: 0 }));
      try {
        const demoClient = demoHandle.llmClient;
        expect(demoClient).toBeDefined();
        expect(demoClient).toBeInstanceOf(OpenAICompatibleLLMClient);
        expect(coffeeClient).toBeInstanceOf(OpenAICompatibleLLMClient);

        const readConfig = (c: unknown): { baseUrl: string; model: string } =>
          c as unknown as { baseUrl: string; model: string };

        const coffeeCfg = readConfig(coffeeClient);
        const demoCfg = readConfig(demoClient);
        expect(demoCfg.baseUrl).toBe(coffeeCfg.baseUrl);
        expect(demoCfg.model).toBe(coffeeCfg.model);
        expect(demoCfg.baseUrl).toBe(llm.url);
        expect(demoCfg.model).toBe('test-model-106');
      } finally {
        await demoHandle.stop();
      }
    } finally {
      await llm.close();
    }
  });
});

// ── Type-level guard: scenes map type ────────────────────────────────────────

describe('scene map type', () => {
  it('returns Map<string, SceneDefinition>', async () => {
    const scenes: Map<string, SceneDefinition> = await buildSceneMap();
    expect(scenes).toBeInstanceOf(Map);
  });
});
