const fs = require('fs');
const readline = require('readline');

const inputFile = process.argv[2] || 'events.jsonl';
const outputFile = process.argv[3] || 'events-compacted.jsonl';

async function compact() {
    if (!fs.existsSync(inputFile)) {
        console.log("No input file found.");
        return;
    }

    const nodes = new Map();
    const other = [];

    const fileStream = fs.createReadStream(inputFile);
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
    });

    for await (const line of rl) {
        if (!line.trim()) continue;
        try {
            const event = JSON.parse(line);
            if (event.event_type === 'UPSERT_NODE') {
                nodes.set(event.payload.id, line);
            } else if (event.event_type === 'DELETE_NODE') {
                nodes.delete(event.payload.id);
            } else {
                other.push(line);
            }
        } catch (e) {
            // Ignore malformed lines
        }
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

compact().catch(console.error);
