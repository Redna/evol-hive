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
| [001](001-perceive-phase.md) | Perceive Phase (PPER) | §3, §4, §5, §6, §11 | 🔨 In Development | [#1](https://github.com/Redna/evol-hive/issues/1) | — | engine, cognition, shared |

## Architecture Coverage

| Section | Topic | Spec(s) | Status |
|---------|-------|---------|--------|
| [§1](../architecture/01-vision.md) | Vision & Philosophy | — | ✅ Documented |
| [§2](../architecture/02-system-overview.md) | System Overview | — | ✅ Documented |
| [§3](../architecture/03-agent-state-schema.md) | Agent State Schema | 001 (partial) | 📝 Partial — full spec needed |
| [§4](../architecture/04-smart-objects.md) | Smart Objects & Affordances | 001 (partial) | 📝 Partial — full spec needed |
| [§5](../architecture/05-fast-path-classifier.md) | Fast-Path Classifier (System 0) | 001 (partial) | 📝 Partial — full spec needed |
| [§6](../architecture/06-pper-loop.md) | PPER Loop | 001 (Perceive) | 🔨 Perceive in development |
| [§7](../architecture/07-structured-outputs.md) | Structured Outputs | — | 📝 Needs spec |
| [§8](../architecture/08-cognitive-tools.md) | Cognitive Tools | — | 📝 Needs spec |
| [§9](../architecture/09-engine-routing.md) | Engine Routing | — | 📝 Needs spec |
| [§10](../architecture/10-cognitive-guardrails.md) | Cognitive Guardrails | — | 📝 Needs spec |
| [§11](../architecture/11-memory-architecture.md) | Memory Architecture | 001 (partial) | 📝 Partial — full spec needed |

## Spec Status Summary

```
Total specs:      1
✅ Done:          0
🔨 In Development: 1
📝 Drafted:       0
🚫 Blocked:       0

Architecture sections with specs: 5/11 (partial coverage)
Architecture sections needing specs: 6/11
```