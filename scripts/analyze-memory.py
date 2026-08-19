import json
from collections import Counter

events_file = '/home/anima/events.jsonl'
node_labels = Counter()
agent_mentions = Counter()
node_types_by_agent = {}
sample_memories = []

try:
    with open(events_file, 'r') as f:
        for i, line in enumerate(f):
            if not line.strip(): continue
            try:
                event = json.loads(line)
                if event.get('event_type') == 'UPSERT_NODE':
                    payload = event.get('payload', {})
                    label = payload.get('label', 'Unknown')
                    node_labels[label] += 1
                    
                    props = payload.get('properties', {})
                    content = props.get('content') or props.get('description') or ''
                    
                    if 'architect' in content.lower():
                        agent_mentions['architect'] += 1
                    if 'developer' in content.lower():
                        agent_mentions['developer'] += 1
                    if 'doctor' in content.lower():
                        agent_mentions['doctor'] += 1
                        
                    if len(sample_memories) < 5 and label == 'Scratchpad':
                        sample_memories.append(content[:200] + '...')
                        
            except json.JSONDecodeError:
                pass
except Exception as e:
    print(f"Error: {e}")

print("=== YAAM Graph Analysis ===")
print("Total events processed (approximate):", sum(node_labels.values()))
print("\nNode Labels Distribution:")
for label, count in node_labels.most_common():
    print(f" - {label}: {count}")

print("\nAgent Mentions in Memory:")
for agent, count in agent_mentions.most_common():
    print(f" - {agent}: {count}")

print("\nSample Scratchpad Memories:")
for i, mem in enumerate(sample_memories, 1):
    print(f"{i}. {mem}")
