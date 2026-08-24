const fs = require('fs');
const path = require('path');

const inputFile = process.argv[2] || 'events.jsonl';
const outputFile = process.argv[3] || 'events-compacted.jsonl';

async function compact() {
    if (!fs.existsSync(inputFile)) {
        console.log("No input file found.");
        return;
    }
    const lines = fs.readFileSync(inputFile, 'utf-8').split('\n').filter(l => l.trim());
    const nodes = new Map();
    const other = [];

    for (const line of lines) {
        try {
            const event = JSON.parse(line);
            if (event.event_type === 'UPSERT_NODE') {
                nodes.set(event.payload.id, line);
            } else if (event.event_type === 'DELETE_NODE') {
                nodes.delete(event.payload.id);
            } else {
                other.push(line);
            }
        } catch (e) {}
    }

    const out = fs.createWriteStream(outputFile);
    for (const line of nodes.values()) {
        out.write(line + '\n');
    }
    for (const line of other) {
        out.write(line + '\n');
    }
    out.end();
}
compact();
