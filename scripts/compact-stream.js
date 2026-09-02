const fs = require('fs');
const readline = require('readline');
const inputFile = process.argv[2] || 'events.jsonl';
const outputFile = process.argv[3] || 'events-compacted.jsonl';
async function compact() {
  const nodes = new Map();
  const links = new Map();
  const other = [];
  const stream = fs.createReadStream(inputFile, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNum = 0;
  for await (const line of rl) {
    lineNum++;
    if (lineNum % 500000 === 0) process.stderr.write(`  ${lineNum} lines...\n`);
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.event_type === 'UPSERT_NODE') nodes.set(event.payload.id, line);
      else if (event.event_type === 'DELETE_NODE') nodes.delete(event.payload.id);
      else if (event.event_type === 'LINK_NODES') {
        const key = `${event.payload.from_id}|${event.payload.to_id}|${event.payload.relationship}`;
        links.set(key, line);
      } else if (event.event_type === 'DELETE_EDGES') {
        for (const [key] of links) {
          const [from] = key.split('|');
          if (from === event.payload.from_id) links.delete(key);
        }
      } else other.push(line);
    } catch (e) {}
  }
  process.stderr.write(`  Nodes: ${nodes.size}, Links: ${links.size}, Other: ${other.length}\n`);
  const out = fs.createWriteStream(outputFile);
  for (const line of nodes.values()) out.write(line + '\n');
  for (const line of links.values()) out.write(line + '\n');
  for (const line of other) out.write(line + '\n');
  out.end();
  process.stderr.write(`  Written to ${outputFile}\n`);
}
compact().catch(console.error);
