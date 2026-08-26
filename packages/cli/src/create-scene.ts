/**
 * create-scene command — interactive wizard for creating a .scene.yaml file (spec 022, Req 14)
 * ────────────────────────────────────────────────────────────────────────────
 * Uses Node.js built-in `readline` to prompt the user for scene name, rooms,
 * objects, and agents. Produces a valid `.scene.yaml` file that passes
 * `validate-scene`.
 *
 * When stdin is piped (non-TTY), all input lines are buffered upfront and
 * consumed in order. This makes the wizard testable via piped stdin.
 */

import * as yaml from 'js-yaml';
import { writeFileSync } from 'node:fs';
import * as readline from 'node:readline';

interface CreatedRoom {
  id: string;
  name: string;
  description: string;
  connections: string[];
  objectIds: string[];
}

interface CreatedObject {
  id: string;
  name: string;
  type: string;
  state: Record<string, unknown>;
  roomId: string;
  affordances: {
    id: string;
    label: string;
    engineEffect: string;
    preconditions: string[];
    effects: Record<string, number>;
  }[];
}

interface CreatedAgent {
  id: string;
  name: string;
  description: string;
  traits: string[];
  initialDrives: Record<string, number>;
  startRoomId?: string;
}

/** Read all lines from stdin (piped mode) into a buffer. */
function readStdinLines(): Promise<string[]> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    const rl = readline.createInterface({
      input: process.stdin,
      terminal: false,
    });
    rl.on('line', (line) => {
      lines.push(line);
    });
    rl.on('close', () => {
      resolve(lines);
    });
  });
}

/** Interactive question function backed by readline (TTY) or buffered lines (piped). */
interface Questioner {
  ask: (prompt: string) => Promise<string>;
  close: () => void;
}

async function createQuestioner(): Promise<Questioner> {
  // If stdin is a TTY, use interactive readline.
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    return {
      ask: (prompt: string) =>
        new Promise((resolve) => {
          rl.question(prompt, (answer) => resolve(answer ?? ''));
        }),
      close: () => rl.close(),
    };
  }

  // Piped stdin: buffer all lines, then answer from the buffer.
  const lines = await readStdinLines();
  let idx = 0;
  return {
    ask: (prompt: string) => {
      // Print the prompt for visibility
      process.stdout.write(prompt);
      const line = idx < lines.length ? lines[idx]! : '';
      idx++;
      process.stdout.write(line + '\n');
      return Promise.resolve(line);
    },
    close: () => {},
  };
}

/**
 * Interactive scene creation wizard.
 *
 * @param args - Command arguments. Supports `--output <path>` to specify the output file.
 * @returns Exit code (0 = success, 1 = failure).
 */
export async function createSceneCommand(args: string[]): Promise<number> {
  // Parse --output flag
  let outputFile = 'my-scene.scene.yaml';
  const outputIdx = args.indexOf('--output');
  if (outputIdx >= 0 && args[outputIdx + 1]) {
    outputFile = args[outputIdx + 1]!;
  }

  const questioner = await createQuestioner();

  try {
    console.log('🎨 evol-hive scene creator');
    console.log('This wizard will guide you through creating a scene definition.');
    console.log('');

    // ── Scene name ──
    const sceneName = (await questioner.ask('Scene name: ')).trim() || 'Untitled Scene';
    const sceneId =
      sceneName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'scene';

    // ── Rooms ──
    const rooms: CreatedRoom[] = [];
    console.log('');
    console.log('── Rooms ──');

    while (true) {
      const roomName = (await questioner.ask('Room name (or leave empty to finish): ')).trim();
      if (!roomName) {
        if (rooms.length === 0) {
          console.log('At least one room is required.');
          continue;
        }
        break;
      }

      const roomId = roomName.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      const roomDescription = (await questioner.ask('Room description: ')).trim();

      const connectionsInput = (
        await questioner.ask('Connections (comma-separated room IDs, or empty): ')
      ).trim();
      const connections = connectionsInput
        ? connectionsInput
            .split(',')
            .map((c) => c.trim())
            .filter(Boolean)
        : [];

      rooms.push({
        id: roomId,
        name: roomName,
        description: roomDescription,
        connections,
        objectIds: [],
      });

      const more = (await questioner.ask('Add another room? (y/n): ')).trim().toLowerCase();
      if (more !== 'y' && more !== 'yes') break;
    }

    // ── Objects ──
    const objects: CreatedObject[] = [];
    console.log('');
    console.log('── Objects ──');

    while (true) {
      const objName = (await questioner.ask('Object name (or leave empty to finish): ')).trim();
      if (!objName) break;

      const objId = objName.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'object';
      const objType =
        (await questioner.ask('Object type (e.g., furniture, appliance): ')).trim() || 'furniture';
      const roomIdInput = (await questioner.ask('Room ID: ')).trim() || rooms[0]!.id;
      const affIdInput = (await questioner.ask('Affordance ID (e.g., relax): ')).trim();
      const affLabel = (await questioner.ask('Affordance label: ')).trim() || affIdInput;

      objects.push({
        id: objId,
        name: objName,
        type: objType,
        state: {},
        roomId: roomIdInput,
        affordances: affIdInput
          ? [
              {
                id: affIdInput,
                label: affLabel,
                engineEffect: affIdInput,
                preconditions: [],
                effects: {},
              },
            ]
          : [],
      });

      // Add the object to the room's objectIds
      const room = rooms.find((r) => r.id === roomIdInput);
      if (room && !room.objectIds.includes(objId)) {
        room.objectIds.push(objId);
      }

      const more = (await questioner.ask('Add another object? (y/n): ')).trim().toLowerCase();
      if (more !== 'y' && more !== 'yes') break;
    }

    // ── Agents ──
    const agents: CreatedAgent[] = [];
    console.log('');
    console.log('── Agents ──');

    while (true) {
      const agentName = (await questioner.ask('Agent name (or leave empty to finish): ')).trim();
      if (!agentName) break;

      const agentId = `agent-${agentName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      const agentDesc = (await questioner.ask('Agent description: ')).trim();
      const traitsInput = (await questioner.ask('Traits (comma-separated): ')).trim();
      const traits = traitsInput ? traitsInput.split(',').map((t) => t.trim()) : [];
      const startRoom = (await questioner.ask('Start room ID (or empty for first room): ')).trim();

      const agent: CreatedAgent = {
        id: agentId,
        name: agentName,
        description: agentDesc,
        traits,
        initialDrives: {},
      };
      if (startRoom) {
        agent.startRoomId = startRoom;
      }
      agents.push(agent);

      const more = (await questioner.ask('Add another agent? (y/n): ')).trim().toLowerCase();
      if (more !== 'y' && more !== 'yes') break;
    }

    // ── Build and write YAML ──
    const scene = {
      id: sceneId,
      name: sceneName,
      rooms,
      objects,
      agents,
    };

    const yamlContent = yaml.dump(scene, { indent: 2, lineWidth: 120 });
    writeFileSync(outputFile, yamlContent, 'utf-8');
    console.log('');
    console.log(`✅ Scene written to ${outputFile}`);
    console.log(`   Validate with: npx evol-hive validate-scene ${outputFile}`);

    return 0;
  } catch (err) {
    console.error(`❌ Error: ${(err as Error).message}`);
    return 1;
  } finally {
    questioner.close();
  }
}
