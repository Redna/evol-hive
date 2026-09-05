/**
 * Spec 035 — Salience-weighted identity hook tests (Req 16, 17 / AC-8).
 * AC-8: dream-pass delta weighting scales with accumulated salience (fixture:
 * high-salience session → larger weighted delta than quiet session); a
 * mid-session trigger fires when accumulated salience crosses the threshold,
 * within spec 033's pass budget; `update_self_model` still overrides.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { IdentityChangeDelta, MemorySnippet } from '@evol-hive/shared';
import {
  IdentityConsolidationServiceImpl,
  type IdentityProposalProvider,
} from '../src/identity/index.js';
import {
  SalienceWeightedIdentityService,
  SalienceAccumulator,
  computeSalienceNorm,
  defaultSalienceConfig,
} from '../src/system1/index.js';

/** Provider proposing a fixed number of deltas. */
function fixedProvider(count: number): IdentityProposalProvider {
  return {
    async proposeIdentityDeltas(): Promise<{ deltas: IdentityChangeDelta[] }> {
      const deltas: IdentityChangeDelta[] = [];
      for (let i = 0; i < count; i++) {
        deltas.push({ type: 'trait_add', value: `trait-${i}` });
      }
      return { deltas };
    },
  };
}

/** A self-model bridge that records applied deltas (mirrors the engine's audited bridge). */
class RecordingBridge {
  applied: { agentId: string; deltas: IdentityChangeDelta[] }[] = [];
  applySelfModelDeltas(agentId: string, deltas: IdentityChangeDelta[]) {
    this.applied.push({ agentId, deltas });
    return { success: true, applied: deltas.length, message: 'ok' };
  }
}

function memories(count: number): MemorySnippet[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    content: `memory ${i}`,
    importance: 5,
    timestamp: i,
  }));
}

describe('Spec 035 — salience accumulation (Req 16)', () => {
  it('accumulates salience across recorded samples and resets cleanly', () => {
    const acc = new SalienceAccumulator();
    acc.record('a1', 0.8);
    acc.record('a1', 0.6);
    expect(acc.getAccumulated('a1')).toBeCloseTo(1.4, 12);
    acc.reset('a1');
    expect(acc.getAccumulated('a1')).toBe(0);
  });

  it('keeps per-agent accumulators independent (shared head, per-agent salience)', () => {
    const acc = new SalienceAccumulator();
    acc.record('a1', 1.0);
    acc.record('a2', 0.2);
    expect(acc.getAccumulated('a1')).toBeCloseTo(1.0, 12);
    expect(acc.getAccumulated('a2')).toBeCloseTo(0.2, 12);
  });

  it('computeSalienceNorm saturates at 1 and maps 0 → 0', () => {
    const cfg = defaultSalienceConfig();
    expect(computeSalienceNorm(0, cfg)).toBe(0);
    expect(computeSalienceNorm(cfg.salienceNormalization, cfg)).toBe(1);
    expect(computeSalienceNorm(cfg.salienceNormalization * 5, cfg)).toBe(1);
  });
});

describe('Spec 035 — salience-weighted dream pass (Req 16 / AC-8)', () => {
  let bridge: RecordingBridge;
  let service: SalienceWeightedIdentityService;
  let inner: IdentityConsolidationServiceImpl;

  beforeEach(() => {
    bridge = new RecordingBridge();
    inner = new IdentityConsolidationServiceImpl({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      selfModelBridge: bridge as any,
      provider: fixedProvider(5), // always proposes 5 deltas
      config: { maxDeltasPerSession: 10, maxConsolidationsPerSession: 3 },
    });
    service = new SalienceWeightedIdentityService(inner, {
      accumulator: new SalienceAccumulator(),
      config: defaultSalienceConfig(),
    });
  });

  it('fixture: a high-salience session applies a larger weighted delta than a quiet session', async () => {
    // High-salience session: accumulated 8.0 (→ norm 0.8 with normalization 10).
    service.recordSalience('high', 8.0);
    const highResult = await service.consolidateWithSalience('high', memories(3), []);

    // Quiet session: accumulated 1.0 (→ norm 0.1).
    service.recordSalience('quiet', 1.0);
    const quietResult = await service.consolidateWithSalience('quiet', memories(3), []);

    expect(highResult.applied).toBeGreaterThan(quietResult.applied);
    expect(highResult.applied).toBe(8); // round(10 × 0.8)
    expect(quietResult.applied).toBe(1); // round(10 × 0.1)
  });

  it('never exceeds the spec 033 delta bound even at maximal salience', async () => {
    service.recordSalience('a1', 1000); // norm saturates at 1
    const result = await service.consolidateWithSalience('a1', memories(3), []);
    expect(result.applied).toBeLessThanOrEqual(10); // maxDeltasPerSession
    expect(result.applied).toBe(5); // provider only proposed 5
  });

  it('deltas still flow through the audited, guarded bridge (spec 033 R13 intact)', async () => {
    service.recordSalience('a1', 8.0);
    await service.consolidateWithSalience('a1', memories(2), []);
    expect(bridge.applied).toHaveLength(1);
    expect(bridge.applied[0]!.agentId).toBe('a1');
    expect(bridge.applied[0]!.deltas.length).toBeGreaterThan(0);
    expect(bridge.applied[0]!.deltas[0]!.type).toBe('trait_add');
  });

  it('a zero-salience (perfectly quiet) session applies zero deltas', async () => {
    const result = await service.consolidateWithSalience('a1', memories(2), []);
    expect(result.applied).toBe(0);
    expect(bridge.applied).toHaveLength(0);
  });

  it('respects the spec 033 pass budget across mid-session + session-end passes', async () => {
    service.recordSalience('a1', 10);
    await service.consolidateWithSalience('a1', memories(2), []); // pass 1
    await service.consolidateWithSalience('a1', memories(2), []); // pass 2
    const third = await service.consolidateWithSalience('a1', memories(2), []); // pass 3
    expect(third.success).toBe(true);
    const fourth = await service.consolidateWithSalience('a1', memories(2), []); // budget = 3 → blocked
    expect(fourth.success).toBe(false);
    expect(fourth.message).toMatch(/Rate limit/);
  });
});

describe('Spec 035 — mid-session consolidation trigger (Req 17 / AC-8)', () => {
  it('fires when accumulated salience crosses the threshold, then re-arms', () => {
    const cfg = { ...defaultSalienceConfig(), midSessionThreshold: 3.0 };
    const service = new SalienceWeightedIdentityService(
      new IdentityConsolidationServiceImpl({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        selfModelBridge: new RecordingBridge() as any,
        provider: fixedProvider(2),
      }),
      { accumulator: new SalienceAccumulator(), config: cfg },
    );

    service.recordSalience('a1', 1.0);
    expect(service.shouldConsolidateMidSession('a1')).toBe(false);
    service.recordSalience('a1', 1.5);
    expect(service.shouldConsolidateMidSession('a1')).toBe(false);
    service.recordSalience('a1', 0.6); // total 3.1 ≥ 3.0
    expect(service.shouldConsolidateMidSession('a1')).toBe(true);
    // Triggering consumes the accumulation (re-arms for the next window).
    service.consumeMidSessionTrigger('a1');
    expect(service.shouldConsolidateMidSession('a1')).toBe(false);
  });

  it('the trigger stays within the pass budget (calls the same bounded consolidation)', async () => {
    const cfg = { ...defaultSalienceConfig(), midSessionThreshold: 3.0 };
    const bridge = new RecordingBridge();
    const inner = new IdentityConsolidationServiceImpl({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      selfModelBridge: bridge as any,
      provider: fixedProvider(4),
      config: { maxDeltasPerSession: 10, maxConsolidationsPerSession: 2 },
    });
    const service = new SalienceWeightedIdentityService(inner, {
      accumulator: new SalienceAccumulator(),
      config: cfg,
    });
    service.recordSalience('a1', 10);
    await service.consolidateMidSession('a1', memories(2)); // mid-session pass 1
    await service.consolidateMidSession('a1', memories(2)); // pass 2
    const blocked = await service.consolidateMidSession('a1', memories(2)); // budget exhausted
    expect(blocked.success).toBe(false);
    expect(bridge.applied).toHaveLength(2);
  });
});

describe('Spec 035 — update_self_model remains the conscious override (Req 17)', () => {
  it('the salience service never touches the bridge outside a consolidation pass', async () => {
    const bridge = new RecordingBridge();
    const service = new SalienceWeightedIdentityService(
      new IdentityConsolidationServiceImpl({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        selfModelBridge: bridge as any,
        provider: fixedProvider(5),
      }),
      { accumulator: new SalienceAccumulator(), config: defaultSalienceConfig() },
    );
    service.recordSalience('a1', 1000);
    service.recordSalience('a1', 1000);
    // No consolidation requested → no bridge writes, regardless of salience.
    expect(bridge.applied).toHaveLength(0);
    expect(service.shouldConsolidateMidSession('a1')).toBe(true);
    // The conscious `update_self_model` path (spec 033) is untouched — it
    // applies deltas through the same bridge directly, independent of this
    // service (verified by spec-033-update-self-model.test.ts).
  });
});