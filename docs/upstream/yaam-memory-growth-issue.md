## Evidence

Observed on a GitHub Actions runner (ubuntu-latest, 16GB) during an evol-hive agent session, with `topmem` sampling every 60s. The daemon RSS grows **monotonically and without bound** while the agent session runs:

```
yaam-engine RSS over time (T+0 to T+8min):
  1.4GB -> 2.4GB -> 3.3GB -> 3.4GB -> 4.7GB -> 5.3GB -> 5.6GB -> 8.7GB -> ...
```

Input: the agent `events.jsonl` starts at **41MB / ~15.4K events** (post-compaction memory branch). RSS reaches ~200x the input size, saturating the runner (~75% of 16GB), pegging CPU (~110%), and making RPC calls (`upsert_node`, `query`) time out after 30s — the agent loses all memory persistence for the rest of the session.

Second observation (independent run, same pattern): daemon at 2.8-3.2GB steady during a 12-minute session with moderate event volume.

## Repro

1. Start daemon on an events.jsonl of ~40MB / ~15K events (mix of UPSERT_NODE with 384-float embeddings, LINK_NODES, session-content upserts)
2. Let a pi-coding-agent session with the yaam extension record events (continuous upsert_node RPCs with session/tool-call content)
3. Watch RSS: grows several hundred MB per minute, never released
4. At ~5-8GB, RPC handlers exceed the 30s timeout; the pi extension logs:

```
[YAAM Reconciler] Error during GitHub context sync: Error: RPC 'upsert_node' timed out after 30s
```

## Suspects (from reading src-rust)

1. **`AppState::new` index build** — BM25 + ANN + graph all retain full copies of node content; with session-content upserts (each can carry hundreds of KB of tool-call output), three index copies plus the graph could multiply, but that alone should not reach 200x
2. **Unbounded per-event growth during the session** — every `upsert_node` from the pi extension adds to graph + BM25 + ANN; if superseded node versions are not dropped (or BM25 documents accumulate per-version rather than per-node-id), memory grows per event
3. **Embedding cache / ONNX session** — cache keyed by hash should dedupe, but worth checking `EmbeddingCache` is not retaining full vectors per text revision
4. **Allocator fragmentation** — if large event JSONs are parsed per RPC, glibc arenas may never shrink; RSS then ratchets upward even if logical usage is bounded

## Requested fix direction

- Profile ingestion + upsert paths (heaptrack / jemalloc) to find the retained-growth source
- Cap or compact BM25/ANN retention for superseded node versions
- Consider jemalloc with `background_thread:true` + `dirty_decay_ms` tuning as a stopgap
- Add a startup ingestion memory budget / streaming mode so a large events file cannot wedge the daemon before RPC serves

## Environment

- yaam-engine built from src-rust (release), CI runner, events.jsonl 41MB base + continuous session upserts
- Observed 2026-09-04 across multiple evol-hive agent runs
