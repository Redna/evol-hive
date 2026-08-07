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
| [003](003-execute-phase.md) | Execute Phase (PPER) | §3, §4, §6, §9, §10 | 📝 Drafted | [#8](https://github.com/Redna/evol-hive/issues/8) | — | engine, cognition, shared |

## Architecture Coverage

| Section | Topic | Spec(s) | Status |
|---------|-------|---------|--------|
| [§1](../architecture/01-vision.md) | Vision & Philosophy | — | ✅ Documented |
| [§2](../architecture/02-system-overview.md) | System Overview | — | ✅ Documented |
| [§3](../architecture/03-agent-state-schema.md) | Agent State Schema | 001, 002, 003 (partial) | 📝 Partial — full spec needed |
| [§4](../architecture/04-smart-objects.md) | Smart Objects & Affordances | 001 (partial), 003 (affordance execution, preconditions) | 📝 Partial — full spec needed |
| [§5](../architecture/05-fast-path-classifier.md) | Fast-Path Classifier (System 0) | 001 (partial) | 📝 Partial — full spec needed |
| [§6](../architecture/06-pper-loop.md) | PPER Loop | 001 (Perceive), 002 (Plan), 003 (Execute) | 🔍 Perceive in review; 🔍 Plan in review; 📝 Execute drafted |
| [§7](../architecture/07-structured-outputs.md) | Structured Outputs | 002 (partial) | 📝 Partial — full spec needed |
| [§8](../architecture/08-cognitive-tools.md) | Cognitive Tools | 002 (formulate_plan) | 📝 Partial — full spec needed |
| [§9](../architecture/09-engine-routing.md) | Engine Routing | 002 (partial — isThinking), 003 (isThinking, action feedback) | 📝 Partial — full spec needed |
| [§10](../architecture/10-cognitive-guardrails.md) | Cognitive Guardrails | — | 📝 Needs spec |
| [§11](../architecture/11-memory-architecture.md) | Memory Architecture | 001 (partial) | 📝 Partial — full spec needed |

## Spec Status Summary

```
Total specs:      3
✅ Done:          0
🔨 In Development: 0
🔍 In Review:     2
📝 Drafted:       1
🚫 Blocked:       0

Architecture sections with specs: 8/11 (partial coverage)
Architecture sections needing specs: 3/11
```
