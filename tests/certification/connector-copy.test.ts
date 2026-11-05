import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

/**
 * The browser catalog is the only source of user-facing copy, so a status this
 * ticket introduces that the catalog cannot name falls back to a raw English
 * identifier on screen. Every such status must therefore have Simplified
 * Chinese copy, while the governed identifiers themselves stay ASCII.
 */
const REQUIRED = [
  'value.state.queued',
  'value.state.running',
  'value.state.complete',
  'value.state.failed',
  'value.state.cancelled',
  'value.state.intervention_required',
  'value.state.valid',
  'value.state.invalid',
  'value.pacing.fifo',
  'value.pacing.serialization',
  'value.pacing.concurrency',
  'value.pacing.interval',
  'value.pacing.rate',
  'value.window.fixed',
  'value.window.incremental',
  'value.window.backfill',
  // The role-aware activity centre reports durable background work and required
  // attention; each state the server emits has to read in Chinese.
  'value.activity.queued',
  'value.activity.running',
  'value.activity.failed',
  'value.activity.generated',
  'value.activity.reused',
  'value.activity.paused',
  'value.activity.pending_review',
];

const SOURCE = new URL('../../../web/src/i18n/zh-CN.ts', import.meta.url);

function catalog(): Map<string, string> {
  const text = readFileSync(SOURCE, 'utf8');
  const start = text.indexOf('export const catalog = {');
  const end = text.indexOf('} as const;', start);
  assert.ok(start >= 0 && end > start, 'the Simplified Chinese catalog is where the console reads its copy');
  const entries = new Map<string, string>();
  for (const match of text.slice(start, end).matchAll(/'([^']+)':\s*'([^']*)'/gu)) {
    entries.set(match[1]!, match[2]!);
  }
  return entries;
}

const CJK = /[\u4e00-\u9fff]/u;

test('every status this ticket introduces reads in Simplified Chinese while governed values stay ASCII', () => {
  const entries = catalog();
  assert.ok(entries.size > 90, 'the catalog is the console copy, not an empty shell');

  const missing = REQUIRED.filter((key) => !entries.has(key));
  assert.deepEqual(missing, [], 'a governed status with no catalog entry would render as raw English');

  const englishOnly = REQUIRED.filter((key) => !CJK.test(entries.get(key) ?? ''));
  assert.deepEqual(englishOnly, [], 'Simplified Chinese, not an untranslated English label');

  // No English-only copy anywhere in the catalog, and no translated identifier:
  // the keys are the governed values the API and the CLI speak, so they stay
  // ASCII. A governed value may itself carry a colon (`mcp:read`,
  // `contract:valid`) or a hyphen (`import-license`), which is part of the
  // identifier rather than a translation. A pure format template
  // (`{username}（{role}）：{status}`) carries no English prose either: every
  // word it renders comes from the governed values it names.
  const prose = (value: string): boolean => /[A-Za-z]{2}/u.test(value.replace(/\{[a-z_]+\}/gu, ''));
  const untranslated = [...entries].filter(([, value]) => prose(value) && !CJK.test(value)).map(([key]) => key);
  assert.deepEqual(untranslated, [], 'no English-only user-facing copy remains');
  const translated = [...entries.keys()].filter((key) => !/^[A-Za-z0-9_.:-]+$/u.test(key));
  assert.deepEqual(translated, [], 'identifiers and governed values are never translated');
});

/**
 * The one catalog is only the source of copy if presentation code cannot smuggle
 * a literal past it. These are the surfaces where a literal reaches the screen:
 * JSX text, copy-bearing attributes, copy-bearing object fields, and string
 * literals rendered straight from a JSX expression.
 */
const COPY_ATTRIBUTES = new Set([
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'title',
  'placeholder',
  'alt',
  'label',
  'hint',
  'description',
  'tagline',
  'empty',
  'message',
  'text',
  'confirmLabel',
  'consequence',
  'summary',
  'caption',
  'note',
]);

const COPY_PROPERTIES = new Set([
  'label',
  'title',
  'description',
  'hint',
  'text',
  'message',
  'empty',
  'term',
  'note',
  'tagline',
  'confirmLabel',
  'consequence',
  'summary',
  'caption',
  'placeholder',
  'alt',
]);

/**
 * Governed values and machine tokens that legitimately look like English prose.
 * They are sent to the server or used as element names; the catalog never
 * translates them, and no screen renders them as prose.
 */
const GOVERNED_LITERALS = new Set([
  'Deployment Administrator',
  'Workspace Administrator',
  'Consumer',
  'application/json,.json',
  'x-api-key',
  'current-password',
  'new-password',
  'confirm-password',
]);

interface PresentationFile {
  file: string;
  source: ts.SourceFile;
}

function htmlFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...htmlFiles(path));
    else if (/\.tsx?$/u.test(entry)) files.push(path);
  }
  return files;
}

function presentationFiles(): PresentationFile[] {
  const files = [
    ...htmlFiles(fileURLToPath(new URL('../../../web/src/screens/', import.meta.url))),
    ...htmlFiles(fileURLToPath(new URL('../../../web/src/ui/', import.meta.url))),
    fileURLToPath(new URL('../../../web/src/App.tsx', import.meta.url)),
    fileURLToPath(new URL('../../../web/src/PlatformApp.tsx', import.meta.url)),
  ];
  return files.sort().map((file) => {
    const text = readFileSync(file, 'utf8');
    return {
      file,
      source: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS),
    };
  });
}

function eachNode(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => eachNode(child, visit));
}

function literalChunks(node: ts.Expression): string[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
  return [];
}

function renderedLiterals(node: ts.Expression): Array<{ text: string; node: ts.Node }> {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
    return literalChunks(node).map((text) => ({ text, node }));
  }
  return [];
}

/**
 * A dotted lowercase literal is a catalog key, a dynamic key prefix, or a
 * route/nav key, never prose.
 */
function looksLikeKey(value: string): boolean {
  return /^[a-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+\.?$/u.test(value);
}

/** Class names, DOM ids, autocomplete tokens, and URL fragments are not copy. */
function looksLikeToken(value: string): boolean {
  return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/u.test(value)
    || /^[a-z][a-z0-9_-]*(?:\s+[a-z][a-z0-9_-]*)+$/u.test(value)
    || /[/_:@\\]/u.test(value)
    || /^[A-Z0-9]+$/u.test(value);
}

/** Two or more English words in a literal are prose unless they are governed. */
function englishProse(value: string): boolean {
  const text = value.trim();
  if (text === '' || GOVERNED_LITERALS.has(text) || looksLikeKey(text) || looksLikeToken(text)) return false;
  const words = text.match(/[A-Za-z][A-Za-z'-]*/gu) ?? [];
  if (words.length < 2) return false;
  return words.some((word) => word.length >= 3 && /[a-z]/u.test(word));
}

/** A bare English word is still copy; a one-letter version prefix or symbol is not. */
function copyLike(value: string): boolean {
  return CJK.test(value) || englishProse(value) || /^[A-Za-z]{2,}$/u.test(value.trim());
}

/** Element and form plumbing: a literal here never reaches the screen as copy. */
const MACHINE_PROPERTIES = new Set(['className', 'id', 'htmlFor', 'name', 'href', 'key', 'type', 'value']);

function machineSink(node: ts.Node): boolean {
  let current: ts.Node = node;
  for (let depth = 0; depth < 6 && current.parent !== undefined; depth += 1) {
    const parent = current.parent;
    if (ts.isJsxAttribute(parent)) return !COPY_ATTRIBUTES.has(parent.name.getText());
    if (ts.isPropertyAssignment(parent)) {
      const property = parent.name.getText().replace(/^['"]|['"]$/gu, '');
      return MACHINE_PROPERTIES.has(property) && !COPY_PROPERTIES.has(property);
    }
    if (ts.isCallExpression(parent) || ts.isFunctionLike(parent) || ts.isStatement(parent)) return false;
    current = parent;
  }
  return false;
}

test('every user-facing string is externalized into the one Simplified Chinese catalog', () => {
  const entries = catalog();
  const violations: string[] = [];

  for (const { file, source } of presentationFiles()) {
    const name = relative(process.cwd(), file).replace(/\\/gu, '/');
    const report = (node: ts.Node, message: string): void => {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      violations.push(`${name}:${line}: ${message}`);
    };
    const checkCopy = (node: ts.Node, text: string, where: string): void => {
      if (text.trim() === '') return;
      if (CJK.test(text)) report(node, `${where} hardcodes Chinese copy; it belongs in the catalog`);
      else if (/[A-Za-z]/u.test(text)) report(node, `${where} hardcodes user-facing copy in English: ${JSON.stringify(text)}`);
    };

    eachNode(source, (node) => {
      if (ts.isJsxText(node)) {
        checkCopy(node, node.text, 'JSX text');
      }

      if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
        const attribute = node.name.getText(source);
        if (COPY_ATTRIBUTES.has(attribute)) checkCopy(node, node.initializer.text, `the ${attribute} attribute`);
      }

      if (ts.isPropertyAssignment(node)) {
        const property = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : '';
        if (COPY_PROPERTIES.has(property)) {
          for (const text of literalChunks(node.initializer)) checkCopy(node, text, `the ${property} field`);
        }
      }

      if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
        for (const rendered of renderedLiterals(node.expression)) {
          if (copyLike(rendered.text)) {
            report(rendered.node, `a rendered JSX expression hardcodes user-facing copy: ${JSON.stringify(rendered.text)}`);
          }
        }
      }

      // Chinese anywhere in a UI module outside the catalog is hardcoded copy,
      // whatever sink it later reaches. Comments are not string literals and are
      // deliberately not scanned.
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        if (CJK.test(node.text)) report(node, `hardcoded Chinese copy outside the catalog: ${JSON.stringify(node.text)}`);
      } else if (ts.isTemplateExpression(node)) {
        for (const text of literalChunks(node)) {
          if (CJK.test(text)) report(node, `hardcoded Chinese copy outside the catalog: ${JSON.stringify(text)}`);
        }
      }

      // No English prose literal may hide in a UI module, even if a later screen
      // renders it through a variable rather than an obvious JSX sink.
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && !machineSink(node)) {
        if (englishProse(node.text)) report(node, `English prose outside the catalog: ${JSON.stringify(node.text)}`);
      } else if (ts.isTemplateExpression(node) && !machineSink(node)) {
        for (const text of literalChunks(node)) {
          if (englishProse(text)) report(node, `English prose outside the catalog: ${JSON.stringify(text)}`);
        }
      }

      // Literal catalog keys must resolve; a missing key would surface as a raw
      // English identifier or an empty label at runtime.
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const call = node.expression.text;
        if (call === 't' || call === 'message' || call === 'optional') {
          const argument = node.arguments[0];
          if (argument && ts.isStringLiteral(argument) && !entries.has(argument.text)) {
            report(node, `${call}() names a missing catalog entry: ${argument.text}`);
          }
          if (call === 'optional' && argument && ts.isTemplateExpression(argument)) {
            const prefix = argument.head.text;
            if (prefix !== '' && ![...entries.keys()].some((key) => key.startsWith(prefix))) {
              report(node, `optional() builds keys under ${prefix} but the catalog has no such entry`);
            }
          }
        }
      }
    });
  }

  assert.deepEqual(violations, [], 'presentation code must read every user-facing string from the catalog');
});

test('every server navigation key and built-in role has Chinese copy', () => {
  const entries = catalog();
  const navigation = readFileSync(new URL('../../../src/navigation.ts', import.meta.url), 'utf8');
  const keys = new Set([...navigation.matchAll(/'((?:workspace|deployment)\.[A-Za-z]+)'/gu)].map((match) => match[1]!));
  assert.ok(keys.size >= 20, 'the navigation keys are read from the server definition');
  const missing = [...keys].filter((key) => !entries.has(`nav.entry.${key}`));
  assert.deepEqual(missing, [], 'a navigation key without copy would drop a destination from the Chinese shell');

  const roles = ['value.role.deploymentAdministrator', 'value.role.workspaceAdministrator', 'value.role.consumer'];
  assert.deepEqual(roles.filter((key) => !entries.has(key)), [], 'every built-in Role reads in Chinese');
});

/**
 * Localization changes presentation only. A governed number, decimal, amount, or
 * timestamp is formatted by the settled formatters in `web/src/format.ts`, never
 * rounded, regrouped, or localized by a screen of its own.
 */
test('presentation formats governed values through the settled formatters only', () => {
  const forbidden = new Set(['toFixed', 'toPrecision', 'toLocaleString']);
  const violations: string[] = [];
  for (const { file, source } of presentationFiles()) {
    const name = relative(process.cwd(), file).replace(/\\/gu, '/');
    eachNode(source, (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        if (forbidden.has(node.expression.name.text)) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          violations.push(`${name}:${line}: ${node.expression.name.text}() reformats a governed value`);
        }
      }
      if (ts.isNewExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        if (node.expression.name.text === 'DateTimeFormat' || node.expression.name.text === 'NumberFormat') {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          violations.push(`${name}:${line}: an ad-hoc Intl formatter bypasses web/src/format.ts`);
        }
      }
    });
  }
  assert.deepEqual(violations, [], 'governed values keep their Contract representation');
});

interface CatalogModule {
  t(key: string): string;
  optional(key: string): string | undefined;
  message(key: string, values: Record<string, string>): string;
}

/**
 * Runs the real catalog module, so the development guard is exercised rather
 * than described: Node has no production flag, which is the development case.
 */
async function loadCatalogModule(): Promise<CatalogModule> {
  const output = ts.transpileModule(readFileSync(SOURCE, 'utf8'), {
    fileName: 'zh-CN.ts',
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const directory = mkdtempSync(join(tmpdir(), 'dc-catalog-'));
  try {
    const file = join(directory, 'catalog.mjs');
    writeFileSync(file, output);
    return (await import(pathToFileURL(file).href)) as unknown as CatalogModule;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('a missing catalog entry fails visibly instead of falling back to English', async () => {
  const module = await loadCatalogModule();
  assert.equal(module.t('app.name'), '数据中心运维控制台');
  assert.throws(() => module.t('definitely.missing'), /missing Simplified Chinese catalog entry: definitely\.missing/u);
  assert.throws(
    () => module.message('definitely.missing', {}),
    /missing Simplified Chinese catalog entry: definitely\.missing/u,
  );
  assert.equal(module.optional('definitely.missing'), '〔缺少文案：definitely.missing〕');
});
