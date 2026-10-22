/**
 * Static guard against floating-point money (`bun run check:money`).
 *
 * Uses the TypeScript type checker over src/ and migrations/ and fails when:
 *  1. parseFloat / Number.parseFloat is used anywhere;
 *  2. a money-named property, parameter or variable is typed `number`;
 *  3. arithmetic (+ - * / %) involves a money-named operand of type `number`;
 *  4. Number(...) / parseInt / unary + converts a money-named expression;
 *  5. .toFixed() is called outside the Money value object;
 *  6. a migration declares a float/real/double/money column, or a monetary
 *     column (…amount…, …balance…) that is not NUMERIC(20, 2).
 */
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import ts from 'typescript';

const ROOT = resolve(__dirname, '../..');
const MONEY_NAME = /(amount|balance|money|price|stake|payout|credit|debit|wager)/i;
const NON_MONEY_NAME =
  /(count|version|attempt|seconds|ms|length|size|index|limit|port|timeout|ratio|delay|lag|digits|scale|entries)/i;
const ALLOWED_TOFIXED = new Set(['src/domain/money/money.ts']);

interface Violation {
  file: string;
  line: number;
  rule: string;
  text: string;
}

const violations: Violation[] = [];

const configPath = ts.findConfigFile(ROOT, (file) => ts.sys.fileExists(file), 'tsconfig.json');
if (!configPath) throw new Error('tsconfig.json not found');
const parsed = ts.parseJsonConfigFileContent(
  ts.readConfigFile(configPath, (file) => ts.sys.readFile(file)).config,
  ts.sys,
  ROOT,
);
const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
const checker = program.getTypeChecker();

const isMoneyName = (name: string): boolean => MONEY_NAME.test(name) && !NON_MONEY_NAME.test(name);

function report(node: ts.Node, rule: string): void {
  const source = node.getSourceFile();
  const { line } = source.getLineAndCharacterOfPosition(node.getStart());
  violations.push({
    file: relative(ROOT, source.fileName).replaceAll('\\', '/'),
    line: line + 1,
    rule,
    text: node.getText().slice(0, 120),
  });
}

function isNumberType(node: ts.Node): boolean {
  const type = checker.getTypeAtLocation(node);
  return (type.flags & ts.TypeFlags.NumberLike) !== 0;
}

function nameOf(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression))
    return node.argumentExpression.text;
  return undefined;
}

function visit(node: ts.Node, file: string): void {
  // 1. parseFloat
  if (ts.isCallExpression(node)) {
    const callee = node.expression.getText();
    if (callee === 'parseFloat' || callee === 'Number.parseFloat') report(node, 'parseFloat is forbidden');
    // 4. numeric conversion of money-named expressions
    if (['Number', 'parseInt', 'Number.parseInt'].includes(callee)) {
      const argument = node.arguments[0];
      const name = argument ? nameOf(argument) : undefined;
      if (name && isMoneyName(name)) report(node, 'money converted to number');
    }
    // 5. toFixed outside Money
    if (
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'toFixed' &&
      !ALLOWED_TOFIXED.has(file)
    ) {
      report(node, '.toFixed() outside the Money value object');
    }
  }
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.PlusToken) {
    const name = nameOf(node.operand);
    if (name && isMoneyName(name)) report(node, 'money converted with unary +');
  }
  // 2. money-named declarations typed as number
  if (
    (ts.isPropertyDeclaration(node) ||
      ts.isPropertySignature(node) ||
      ts.isParameter(node) ||
      ts.isVariableDeclaration(node)) &&
    node.name &&
    ts.isIdentifier(node.name) &&
    isMoneyName(node.name.text) &&
    isNumberType(node.name)
  ) {
    report(node, 'money-named declaration typed as number');
  }
  // 3. arithmetic on money-named numbers
  if (ts.isBinaryExpression(node)) {
    const arithmetic = [
      ts.SyntaxKind.PlusToken,
      ts.SyntaxKind.MinusToken,
      ts.SyntaxKind.AsteriskToken,
      ts.SyntaxKind.SlashToken,
      ts.SyntaxKind.PercentToken,
    ];
    if (arithmetic.includes(node.operatorToken.kind)) {
      for (const operand of [node.left, node.right]) {
        const name = nameOf(operand);
        if (name && isMoneyName(name) && isNumberType(operand))
          report(node, 'floating-point arithmetic on money');
      }
    }
  }
  ts.forEachChild(node, (child) => visit(child, file));
}

for (const source of program.getSourceFiles()) {
  const file = relative(ROOT, source.fileName).replaceAll('\\', '/');
  if (!file.startsWith('src/') && !file.startsWith('migrations/')) continue;
  visit(source, file);
}

// 6. SQL types of the migrations
const FLOAT_TYPES = /\b(real|float4|float8|float|double\s+precision)\b/i;
for (const fileName of parsed.fileNames.filter((name) =>
  relative(ROOT, name).replaceAll('\\', '/').startsWith('migrations/'),
)) {
  const file = relative(ROOT, fileName).replaceAll('\\', '/');
  readFileSync(fileName, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      const code = line.replace(/--.*$/, '');
      if (FLOAT_TYPES.test(code))
        violations.push({ file, line: index + 1, rule: 'floating-point SQL type', text: line.trim() });
      if (/^\s*[a-z_]+\s+money\b/i.test(code))
        violations.push({ file, line: index + 1, rule: 'SQL money type', text: line.trim() });
      const column = /^\s*([a-z_]*(amount|balance)[a-z_]*)\s+([a-z]+(\s*\(\s*\d+\s*,\s*\d+\s*\))?)/i.exec(
        code,
      );
      if (column && !/^numeric\(\s*20\s*,\s*2\s*\)$/i.test(column[3] ?? '')) {
        violations.push({
          file,
          line: index + 1,
          rule: 'monetary column must be NUMERIC(20, 2)',
          text: line.trim(),
        });
      }
    });
}

if (violations.length > 0) {
  console.error(`check:money found ${violations.length} violation(s):`);
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line}  [${violation.rule}]  ${violation.text}`);
  }
  process.exit(1);
}
console.log(
  `check:money OK: ${program.getSourceFiles().filter((s) => /\/(src|migrations)\//.test(s.fileName)).length} files analysed, no floating-point money.`,
);
