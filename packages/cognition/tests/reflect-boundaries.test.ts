/**
 * Architecture / package-boundary tests for the Reflect phase (spec 004).
 *
 * Covers AC-32 (package boundaries, cognition side):
 *  - `ReflectServiceImpl` (cognition) must import from `@evol-hive/shared` and
 *    cognition-internal modules only — it must NOT import from `@evol-hive/engine`
 *    or `@evol-hive/memory` implementations (per ADR-0001).
 *  - `ReflectBuilderImpl` (cognition) must likewise not import from engine or
 *    memory.
 *
 * These are static source-file import checks — the boundary is enforced by
 * inspecting the actual `import` statements in the implementation files.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readSrc(rel: string): string {
  return readFileSync(join(__dirname, '..', 'src', rel), 'utf8');
}

/** Extract all module specifiers from `import ... from '...'` / `import '...'` statements. */
function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  // Match: import ... from "spec"  OR  import "spec"  (covers type/value/bare imports).
  const re = /import\s(?:[^'"]+from\s*)?['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    specs.push(m[1]!);
  }
  return specs;
}

describe('Reflect phase package boundaries — cognition side (AC-32)', () => {
  it('ReflectServiceImpl does not import from @evol-hive/engine or @evol-hive/memory', () => {
    const src = readSrc('pper/reflect-service.ts');
    const specs = importSpecifiers(src);

    // Must import from @evol-hive/shared (types come from shared per ADR-0001).
    expect(specs.some((s) => s === '@evol-hive/shared')).toBe(true);

    // Must NOT import from engine or memory.
    expect(specs.some((s) => s.startsWith('@evol-hive/engine'))).toBe(false);
    expect(specs.some((s) => s.startsWith('@evol-hive/memory'))).toBe(false);
  });

  it('ReflectBuilderImpl does not import from @evol-hive/engine or @evol-hive/memory', () => {
    const src = readSrc('pper/reflect-builder.ts');
    const specs = importSpecifiers(src);

    expect(specs.some((s) => s === '@evol-hive/shared')).toBe(true);
    expect(specs.some((s) => s.startsWith('@evol-hive/engine'))).toBe(false);
    expect(specs.some((s) => s.startsWith('@evol-hive/memory'))).toBe(false);
  });

  it('cognition reflect modules only import from shared, cognition-internal, or node builtins', () => {
    const files = ['pper/reflect-service.ts', 'pper/reflect-builder.ts'];
    for (const f of files) {
      const specs = importSpecifiers(readSrc(f));
      for (const s of specs) {
        // Allowed: @evol-hive/shared, relative cognition-internal (./ or ../), node: builtins.
        const isShared = s === '@evol-hive/shared' || s.startsWith('@evol-hive/shared/');
        const isInternal = s.startsWith('./') || s.startsWith('../');
        const isNodeBuiltin = s.startsWith('node:');
        expect(isShared || isInternal || isNodeBuiltin).toBe(true);
      }
    }
  });
});