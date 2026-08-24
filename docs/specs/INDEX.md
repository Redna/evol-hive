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
| [001](001-perceive-phase.md) | Perceive Phase (PPER) | §3, §4, §5, §6, §11 | ✅ Done | [#1](https://github.com/Redna/evol-hive/issues/1) | [#3](https://github.com/Redna/evol-hive/pull/3), [#7](https://github.com/Redna/evol-hive/pull/7) | engine, cognition, shared |
| [002](002-plan-phase.md) | Plan Phase (PPER) | §3, §6, §7, §8, §9, §10 | ✅ Done | [#4](https://github.com/Redna/evol-hive/issues/4) | [#7](https://github.com/Redna/evol-hive/pull/7) | engine, cognition, shared |
| [003](003-execute-phase.md) | Execute Phase (PPER) | §2, §3, §4, §6, §9 | ✅ Done | [#8](https://github.com/Redna/evol-hive/issues/8) | [#17](https://github.com/Redna/evol-hive/pull/17) | engine, cognition, shared |
| [004](004-reflect-phase.md) | Reflect Phase (PPER) | §2, §3, §6, §7, §8, §11 | ✅ Done | [#9](https://github.com/Redna/evol-hive/issues/9) | [#17](https://github.com/Redna/evol-hive/pull/17) | shared, cognition, memory, engine |
| [005](005-game-loop-integration.md) | Game Loop Integration & Minimal Scene | §2, §3, §4, §6, §9, §11 | ✅ Done | [#10](https://github.com/Redna/evol-hive/issues/10) | [#19](https://github.com/Redna/evol-hive/pull/19) | shared, engine, cognition, memory |
| [006](006-openai-compatible-llm-client.md) | Real OpenAI-Compatible LLM Client | §5, §6, §7, §9, §11 | ✅ Done | [#20](https://github.com/Redna/evol-hive/issues/20) | [#25](https://github.com/Redna/evol-hive/pull/25) | cognition, shared, examples |
| [007](007-onnx-embedding-provider.md) | Real ONNX Embedding Provider | §5, §11 | ✅ Done | [#21](https://github.com/Redna/evol-hive/issues/21) | [#31](https://github.com/Redna/evol-hive/pull/31) | cognition, shared, memory, examples |
| [008](008-pper-error-recovery.md) | PPER Loop Error Recovery & Edge Cases | §6, §9, §10, §3 | ✅ Done | [#23](https://github.com/Redna/evol-hive/issues/23) | [#33](https://github.com/Redna/evol-hive/pull/33) | shared, cognition, engine |
| [008](008-multi-agent-multi-room-integration-tests.md) | Multi-Agent & Multi-Room Integration Tests | §2, §3, §4, §6, §9 | ✅ Done | [#22](https://github.com/Redna/evol-hive/issues/22) | [#32](https://github.com/Redna/evol-hive/pull/32) | engine, shared |
| [009](009-llm-json-recovery.md) | LLM JSON Response Recovery & Provider-Aware Structured Output | §6, §7, §9 | ⛔ Superseded by 011 | [#34](https://github.com/Redna/evol-hive/issues/34) | [#36](https://github.com/Redna/evol-hive/pull/36) | cognition, shared, examples |
| [010](010-llm-schema-in-prompt-and-field-aliasing.md) | LLM Schema-in-Prompt & Field Name Aliasing | §6, §7, §9 | ⛔ Superseded by 011 | [#37](https://github.com/Redna/evol-hive/issues/37) | [#39](https://github.com/Redna/evol-hive/pull/39) | cognition, shared |
| [011](011-structured-output-to-tool-calling.md) | Replace Structured Output with Tool Calling | §6, §7, §8, §9 | ✅ Done | [#40](https://github.com/Redna/evol-hive/issues/40) | [#42](https://github.com/Redna/evol-hive/pull/42) | cognition, shared, examples |
| [012](012-agent-persona-system.md) | Agent Persona System | §3, §6, §8, §11, §2 | ✅ Done | [#44](https://github.com/Redna/evol-hive/issues/44) | [#48](https://github.com/Redna/evol-hive/pull/48), [#52](https://github.com/Redna/evol-hive/pull/52) | shared, cognition, engine |
| [013](013-richer-prototype-scenes.md) | Richer Prototype Scenes — Multi-Room, Multi-Object, Multi-Agent | §2, §3, §4, §6, §8 | ✅ Done | [#45](https://github.com/Redna/evol-hive/issues/45) | [#49](https://github.com/Redna/evol-hive/pull/49) | shared, engine, examples |
| [014](014-memory-consolidation-decay-retrieval.md) | Memory Consolidation — Background Reflection, Importance Scoring, Memory Decay, Weighted Retrieval | §11, §6, §9, §2 | ✅ Done | [#50](https://github.com/Redna/evol-hive/issues/50) | [#53](https://github.com/Redna/evol-hive/pull/53) | shared, memory, cognition, engine |
| [015](015-full-cognitive-tools.md) | Full Cognitive Tools — query_memory and update_internal_state as Real Tool Calls | §8, §6, §11 | ✅ Done | [#55](https://github.com/Redna/evol-hive/issues/55) | [#60](https://github.com/Redna/evol-hive/pull/60) | cognition, shared, examples |
| [016](016-cognitive-guardrails.md) | Cognitive Guardrails — Affordance Masking, Contextual Forcing, Plan Validation | §10, §6, §9 | ✅ Done | [#54](https://github.com/Redna/evol-hive/issues/54) | [#59](https://github.com/Redna/evol-hive/pull/59) | shared, cognition, engine |
| [017](017-persistence-save-load-game-state.md) | Persistence — Save/Load Game State and Agent Memory Across Sessions | §2, §3, §6, §11 | ✅ Done | [#61](https://github.com/Redna/evol-hive/issues/61) | [#67](https://github.com/Redna/evol-hive/pull/67) | shared, memory, engine |
| [018](018-object-interactions.md) | Object Interactions — Multi-Step Affordances, Object State Changes, Dependencies | §4, §5, §6, §9 | ✅ Done | [#63](https://github.com/Redna/evol-hive/issues/63) | [#69](https://github.com/Redna/evol-hive/pull/69) | shared, engine, cognition |
| [018](018-multi-agent-social.md) | Multi-Agent Social — Agent-to-Agent Perception, Communication, Relationships | §3, §6, §8 | ✅ Done | [#62](https://github.com/Redna/evol-hive/issues/62) | [#70](https://github.com/Redna/evol-hive/pull/70) | shared, engine, cognition |
| [019](019-affordance-as-tools.md) | Affordance-as-Tools — Replace `choose_action` with Per-Affordance Tool Definitions | §4, §6, §7, §8, §10 | 📝 Drafted | [#71](https://github.com/Redna/evol-hive/issues/71) | — | shared, cognition, examples |

## Architecture Coverage

| Section | Topic | Spec(s) | Status |
|---------|-------|---------|--------|
| [§1](../architecture/01-vision.md) | Vision & Philosophy | — | ✅ Documented |
| [§2](../architecture/02-system-overview.md) | System Overview | 008, 013, 017 | ✅ Documented |
| [§3](../architecture/03-agent-state-schema.md) | Agent State Schema | 001, 002, 008, 012, 017 | ✅ Implemented |
| [§4](../architecture/04-smart-objects.md) | Smart Objects & Affordances | 001, 003, 008, 013, 018, 019 | ✅ Implemented |
| [§5](../architecture/05-fast-path-classifier.md) | Fast-Path Classifier (System 0) | 001, 006, 007, 018 | ✅ Implemented |
| [§6](../architecture/06-pper-loop.md) | PPER Loop | 001-004, 006, 008, 012, 017 | ✅ Implemented |
| [§7](../architecture/07-structured-outputs.md) | Structured Outputs | 011 (tool calling), 019 (affordance-as-tools) | ✅ Implemented |
| [§8](../architecture/08-cognitive-tools.md) | Cognitive Tools | 002, 011, 015 | ✅ Implemented |
| [§9](../architecture/09-engine-routing.md) | Engine Routing | 002, 003, 004, 006, 008, 009 | ✅ Implemented |
| [§10](../architecture/10-cognitive-guardrails.md) | Cognitive Guardrails | 016, 019 | ✅ Implemented |
| [§11](../architecture/11-memory-architecture.md) | Memory Architecture | 004, 007, 014, 017 | ✅ Implemented |

## Spec Status Summary

```
Total specs:      21
✅ Done:          17
🔨 In Development: 0
🔍 In Review:      0
📝 Drafted:        1
🚫 Blocked:        0
⛔ Superseded:     2

Architecture sections fully implemented: 11/11
```
| [019](019-configurable-drive-decay-rate.md) | Configurable Drive Decay Rate | §3, §6, §9 | 📝 Drafted | [#72](https://github.com/Redna/evol-hive/issues/72) | — | shared, engine, examples |
