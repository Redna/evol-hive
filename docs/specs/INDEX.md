# Spec Index

Living index of all feature specifications. Updated by the Architect when creating specs and by the Developer when status changes.

## Status Legend

| Icon | Status | Meaning |
|------|--------|---------|
| 📝 | Drafted | Spec written, awaiting development |
| 🔨 | In Development | Developer is implementing (TDD) |
| 🔍 | In Review | PR opened, under review/QA |
| ✅ | Done | Merged and tested |
| 🚫 | Blocked | Blocked by dependency or decision needed |

## Specs

| # | Feature | Architecture | Status | Issue | PR | Package(s) |
|---|---------|-------------|--------|-------|-----|------------|
| [001](001-perceive-phase.md) | Perceive Phase (PPER) | §3, §4, §5, §6, §11 | 🔍 In Review | [#1](https://github.com/Redna/evol-hive/issues/1) | [#3](https://github.com/Redna/evol-hive/pull/3) | engine, cognition, shared |
| [002](002-plan-phase.md) | Plan Phase (PPER) | §3, §6, §7, §8, §9, §10 | 🔍 In Review | [#4](https://github.com/Redna/evol-hive/issues/4) | [#7](https://github.com/Redna/evol-hive/pull/7) | engine, cognition, shared |
| [003](003-execute-phase.md) | Execute Phase (PPER) | §2, §3, §4, §6, §9 | 🔍 In Review | [#8](https://github.com/Redna/evol-hive/issues/8) | [#17](https://github.com/Redna/evol-hive/pull/17) | engine, cognition, shared |
| [004](004-reflect-phase.md) | Reflect Phase (PPER) | §2, §3, §6, §7, §8, §11 | 🔍 In Review | [#9](https://github.com/Redna/evol-hive/issues/9) | [#17](https://github.com/Redna/evol-hive/pull/17) | shared, cognition, memory, engine |
| [005](005-game-loop-integration.md) | Game Loop Integration & Minimal Scene | §2, §3, §4, §6, §9, §11 | 🔍 In Review | [#10](https://github.com/Redna/evol-hive/issues/10) | — | shared, engine, cognition, memory |
| [006](006-openai-compatible-llm-client.md) | Real OpenAI-Compatible LLM Client | §5, §6, §7, §9, §11 | 🔍 In Review | [#20](https://github.com/Redna/evol-hive/issues/20) | [#25](https://github.com/Redna/evol-hive/pull/25) | cognition, shared, examples |
| [007](007-onnx-embedding-provider.md) | Real ONNX Embedding Provider | §5, §11 | 📝 Drafted | [#21](https://github.com/Redna/evol-hive/issues/21) | — | cognition, shared, memory, examples |
| [008](008-multi-agent-multi-room-integration-tests.md) | Multi-Agent & Multi-Room Integration Tests | §2, §4, §6, §9, §11 | 📝 Drafted | [#22](https://github.com/Redna/evol-hive/issues/22) | — | engine, cognition, shared, memory |

## Architecture Coverage

| Section | Topic | Spec(s) | Status |
|---------|-------|---------|--------|
| [§1](../architecture/01-vision.md) | Vision & Philosophy | — | ✅ Documented |
| [§2](../architecture/02-system-overview.md) | System Overview | 008 (integration tests) | ✅ Documented |
| [§3](../architecture/03-agent-state-schema.md) | Agent State Schema | 001, 002 (partial) | 📝 Partial — full spec needed |
| [§4](../architecture/04-smart-objects.md) | Smart Objects & Affordances | 001 (partial), 003 (execution), 008 (room scoping) | 📝 Partial — full spec needed |
| [§5](../architecture/05-fast-path-classifier.md) | Fast-Path Classifier (System 0) | 001 (partial), 006 (EmbeddingProvider reuse), 007 (ONNX provider) | 📝 Partial — full spec needed |
| [§6](../architecture/06-pper-loop.md) | PPER Loop | 001 (Perceive), 002 (Plan), 003 (Execute), 004 (Reflect), 006 (LLM client), 008 (multi-agent) | 🔍 Perceive in review; 🔍 Plan in review; 🔍 Execute in review; 🔍 Reflect in review |
| [§7](../architecture/07-structured-outputs.md) | Structured Outputs | 002 (partial), 004 (reflectSchema), 006 (OpenAI response_format, memoryConsolidationSchema) | 📝 Partial — full spec needed |
| [§8](../architecture/08-cognitive-tools.md) | Cognitive Tools | 002 (formulate_plan), 004 (update_internal_state) | 📝 Partial — full spec needed |
| [§9](../architecture/09-engine-routing.md) | Engine Routing | 002 (partial — isThinking), 003 (isThinking, feedback), 004 (isThinking), 006 (LLM error propagation), 008 (concurrency tests) | 📝 Partial — full spec needed |
| [§10](../architecture/10-cognitive-guardrails.md) | Cognitive Guardrails | — | 📝 Needs spec |
| [§11](../architecture/11-memory-architecture.md) | Memory Architecture | 001 (partial), 004 (MemoryStore, EmbeddingProvider), 006 (completeReflection, memoryConsolidationSchema), 007 (real embeddings), 008 (integration) | 📝 Partial — full spec needed |

## Spec Status Summary

```
Total specs:      8
✅ Done:          0
🔨 In Development: 0
🔍 In Review:     6
📝 Drafted:       2
📝 Drafted:       0
🚫 Blocked:       0

Architecture sections with specs: 8/11 (partial coverage)
Architecture sections needing specs: 3/11
```
