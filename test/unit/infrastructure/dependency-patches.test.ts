import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';

const requireDependency = createRequire(__filename);
interface Braces {
  (pattern: string): string[];
  parse(this: void, pattern: string): unknown;
  compile(this: void, pattern: unknown): string;
  expand(this: void, pattern: unknown): string[];
  stringify(this: void, pattern: unknown): string;
}
const braces = requireDependency('braces') as Braces;
const { sprintf } = requireDependency('sprintf-js') as {
  sprintf(this: void, format: string, value: number | string): string;
};

describe('Pinned dependency security patches', () => {
  test('braces rejects deeply nested braces and parentheses before recursive traversal', () => {
    for (const [left, right] of [
      ['{', '}'],
      ['(', ')'],
    ]) {
      const hostile = left!.repeat(4000) + 'a,b' + right!.repeat(4000);
      for (const method of [braces.parse, braces.compile, braces.expand, braces.stringify]) {
        expect(() => method(hostile)).toThrow('Brace nesting exceeds the supported depth');
      }
    }
  });

  test('braces also bounds traversal when passed an AST directly', () => {
    let ast: unknown = { type: 'text', value: 'leaf' };
    for (let depth = 0; depth < 256; depth += 1) ast = { type: 'root', nodes: [ast] };
    for (const method of [braces.compile, braces.expand, braces.stringify]) {
      expect(() => method(ast)).toThrow('Brace nesting exceeds the supported depth');
    }
  });

  test('ordinary brace patterns retain compile and expansion behavior', () => {
    expect(braces.compile('src/{api,worker}.ts')).toBe('src/(api|worker).ts');
    expect(braces.expand('src/{api,worker}.ts')).toEqual(['src/api.ts', 'src/worker.ts']);
    expect(braces.expand('v{1..3}')).toEqual(['v1', 'v2', 'v3']);
  });

  test('sprintf clamps hostile float precision to the ECMAScript bounds', () => {
    for (const type of ['e', 'f', 'g']) {
      expect(() => sprintf(`%.999999999999999999999999999${type}`, 1)).not.toThrow();
      expect(sprintf(`%.999999999999999999999999999${type}`, 1).length).toBeLessThan(110);
    }
    expect(sprintf('%.0g', 1)).toBe('1');
    expect(sprintf('%.2f', 1.25)).toBe('1.25');
    expect(sprintf('%s', 'migration')).toBe('migration');
  });
});
