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
| ⛔ | Superseded | Replaced by a newer spec |

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
| [008](008-pper-error-recovery.md) | PPER Loop Error Recovery & Edge Cases | §6, §9, §10, §3 | 🔍 In Review | [#23](https://github.com/Redna/evol-hive/issues/23) | [#33](https://github.com/Redna/evol-hive/pull/33) | shared, cognition, engine |
| [008](008-multi-agent-multi-room-integration-tests.md) | Multi-Agent & Multi-Room Integration Tests | §2, §3, §4, §6, §9 | 📝 Drafted | [#22](https://github.com/Redna/evol-hive/issues/22) | — | engine, shared |
| [009](009-llm-json-recovery.md) | LLM JSON Response Recovery & Provider-Aware Structured Output | §6, §7, §9 | ⛔ Superseded by 011 | [#34](https://github.com/Redna/evol-hive/issues/34) | [#36](https://github.com/Redna/evol-hive/pull/36) | cognition, shared, examples |
| [010](010-llm-schema-in-prompt-and-field-aliasing.md) | LLM Schema-in-Prompt & Field Name Aliasing | §6, §7, §9 | ⛔ Superseded by 011 | [#37](https://github.com/Redna/evol-hive/issues/37) | [#39](https://github.com/Redna/evol-hive/pull/39) | cognition, shared |
| [011](011-structured-output-to-tool-calling.md) | Replace Structured Output with Tool Calling | §6, §7, §8, §9 | 📝 Drafted | [#40](https://github.com/Redna/evol-hive/issues/40) | — | cognition, shared, examples |

## Architecture Coverage

| Section | Topic | Spec(s) | Status |
|---------|-------|---------|--------|
| [§1](../architecture/01-vision.md) | Vision & Philosophy | — | ✅ Documented |
| [§2](../architecture/02-system-overview.md) | System Overview | 008 (integration tests) | ✅ Documented |
| [§3](../architecture/03-agent-state-schema.md) | Agent State Schema | 001, 002 (partial), 008 (multi-agent isolation) | 📝 Partial — full spec needed |
| [§4](../architecture/04-smart-objects.md) | Smart Objects & Affordances | 001 (partial), 003 (execution), 008 (room scoping) | 📝 Partial — full spec needed |
| [§5](../architecture/05-fast-path-classifier.md) | Fast-Path Classifier (System 0) | 001 (partial), 006 (EmbeddingProvider reuse), 007 (ONNX provider) | 📝 Partial — full spec needed |
| [§6](../architecture/06-pper-loop.md) | PPER Loop | 001 (Perceive), 002 (Plan), 003 (Execute), 004 (Reflect), 006 (LLM client), 008 (concurrent cycles) | 🔍 Perceive in review; 🔍 Plan in review; 🔍 Execute in review; 🔍 Reflect in review |
| [§7](../architecture/07-structured-outputs.md) | Structured Outputs | 002 (partial), 004 (reflectSchema), 006 (OpenAI response_format → superseded), 009 (superseded by 011), 010 (superseded by 011), 011 (tool calling) | 🔍 Spec 011 drafted |
| [§8](../architecture/08-cognitive-tools.md) | Cognitive Tools | 002 (formulate_plan), 004 (update_internal_state), 011 (cognitive tools as native tool definitions) | 📝 Partial — spec 011 adds native tool def support |
| [§9](../architecture/09-engine-routing.md) | Engine Routing | 002 (partial — isThinking), 003 (isThinking, feedback), 004 (isThinking), 006 (LLM error propagation), 008 (contention feedback), 009 (LLM JSON recovery error path) | 📝 Partial — full spec needed |
| [§10](../architecture/10-cognitive-guardrails.md) | Cognitive Guardrails | — | 📝 Needs spec |
| [§11](../architecture/11-memory-architecture.md) | Memory Architecture | 001 (partial), 004 (MemoryStore, EmbeddingProvider), 006 (completeReflection, memoryConsolidationSchema), 007 (real embeddings) | 📝 Partial — full spec needed |

## Spec Status Summary

```
Total specs:      12
✅ Done:          0
🔨 In Development: 0
🔍 In Review:     6
📝 Drafted:       4
🚫 Blocked:       0
⛔ Superseded:    2

Architecture sections with specs: 8/11 (partial coverage)
Architecture sections needing specs: 3/11
```
