# Feature: System 1 Exploration Factor — Curiosity-Modulated Exploration (Issue #138)

## Context

- Architecture: [§5 — Fast-Path Classifier](../architecture/05-fast-path-classifier.md) (System 0/1 gate), [ADR-0002](../adr/0002-trainable-heads-python-train-ts-serve.md) (linear probes, sleep-time updates)
- Related specs: [035 — System 1 Trainable Heads](035-system1-trainable-heads.md) (the gate this spec amends — Req 7 gating, Req 9 outcome labeling, AC-14 determinism), [018/024 — Social hints](024-social-tool-invocation-fix.md) (hint pattern precedent), [033 — Identity Evolution](033-conversations-identity-evolution.md) (guardrail pattern: bounded, reverted-if-worse)
- Package: `cognition` (react-gate, gate-service), `shared` (decision type), `engine` (scheduler port)
- Issue: [#138 — curiosity-modulated exploration factor](https://github.com/Redna/evol-hive/issues/138)

## Problem

The spec-035 gate is **purely greedy**: `react = p(react) >= threshold || hardTrigger`. A greedy gate suffers **counterfactual data starvation**: skipped cycles produce no outcome labels (we never observe what would have happened), so if the head learns to ignore a class of events it was wrong about, the mistake is self-reinforcing — no exploration means no disconfirming samples, ever. Behaviorally, agents also never exhibit curiosity-driven serendipity.

## Requirements

### Exploration mechanism

- **Req 1 — Curiosity-modulated epsilon**: `ε = ε_base × (curiosity / 100)` where curiosity is the agent's live curiosity drive (0–100). A high-curiosity agent (80, ε_base=0.1) explores low-p(react) situations ~8% of ticks; a low-curiosity agent (10) ~1%; curiosity=0 disables exploration entirely.
- **Req 2 — Seeded deterministic draw**: the exploration decision uses a seeded PRNG (mulberry32) keyed on `(agentId, tickNumber, headVersion)`. Save/replay reproduces identical exploration decisions (spec 035 determinism, AC-14). No unseeded `Math.random()` anywhere in the gate.
- **Req 3 — Hard-trigger precedence**: hard triggers override exploration. An alarmed cycle is `hardTrigger=true`, never `explored=true` — alarms are never attributed to curiosity.
- **Req 4 — `explored` audit flag**: the gate decision carries an optional `explored: boolean` so samples can distinguish exploration-started cycles (they are labeled by outcome like any cycle — their samples populate the low-p(react) region of the training set, fixing the counterfactual starvation).
- **Req 5 — Default off**: `epsilonBase` defaults to 0; without a `curiositySource` the gate behaves exactly as spec 035 (pure threshold + hard triggers). Existing scenes/tests are unaffected.
- **Req 6 — Wiring**: the gate service passes `(agentId, tickNumber)` through to the head; the scheduler port signature gains `tickNumber`; the exploration config (epsilonBase + curiosity source) is provided in assembly from the live drive state.

## Acceptance Criteria

- [ ] **AC-1**: With `epsilonBase = 0` (default), decisions are byte-identical to spec 035 behavior for the same inputs (pure threshold + hard triggers).
- [ ] **AC-2**: `explorationEpsilon(80, 0.1) === 0.08` and `explorationEpsilon(0, 0.1) === 0`; ε scales linearly with curiosity and clamps to [0, 100].
- [ ] **AC-3**: `seededDraw` is deterministic: same seed string → same value; different (agentId, tick, headVersion) → effectively independent draws.
- [ ] **AC-4**: With ε > 0 and a fixed seed sequence, low-p(react) ticks with draws below ε yield `react: true, explored: true`; draws above ε follow the threshold rule.
- [ ] **AC-5**: A hard trigger on the same tick yields `react: true, explored: false` (precedence).
- [ ] **AC-6**: Fail-open decisions never explore (`failOpen: true, explored` unset).
- [ ] **AC-7**: Determinism under replay: running the same tick sequence twice produces identical decision traces.

## Constraints

- No LLM calls; the exploration draw is pure arithmetic on a seeded PRNG.
- `ReactGateDecision.explored` is optional (backward compatibility for existing constructions).
- The scheduler port signature change (`decide(agentId, tickNumber, hardTriggers)`) is coordinated across `shared` (port), `cognition` (gate service), and `engine` (scheduler) in one commit.
- Default-off: no scene or assembly change is _required_ — enabling exploration is an assembly-level configuration choice.

## Notes

- Exploration-started cycles are labeled by outcome exactly like gate-started cycles (spec 035 Req 9) — their samples populate the low-p(react) region, fixing the counterfactual starvation.
- The identity link (spec 033): per-agent exploration rates are a candidate per-agent System 1 personalization (the adapter personalization path in ADR-002), not part of this spec.
