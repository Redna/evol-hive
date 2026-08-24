import json

events_file = '/home/anima/events.jsonl'
sample_entities = []

try:
    with open(events_file, 'r') as f:
        for line in f:
            if not line.strip(): continue
            try:
                event = json.loads(line)
                if event.get('event_type') == 'UPSERT_NODE':
                    payload = event.get('payload', {})
                    label = payload.get('label', 'Unknown')
                    
                    if label == 'Entity' and len(sample_entities) < 3:
                        # Remove embeddings to keep output clean
                        if 'properties' in payload and 'embedding' in payload['properties']:
                            del payload['properties']['embedding']
                        sample_entities.append(payload)
                        
            except json.JSONDecodeError:
                pass
except Exception as e:
    print(f"Error: {e}")

print("=== Sample Entity Nodes ===")
for i, entity in enumerate(sample_entities, 1):
    print(f"\n--- Entity {i} ---")
    print(json.dumps(entity, indent=2))
