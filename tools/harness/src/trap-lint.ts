// SPDX-License-Identifier: MPL-2.0
// The trap linter: static checks for the mistakes that cost this project hours or open it to
// attack. TypeScript, JavaScript and the scripts of Vue files are parsed with TypeScript's own
// parser, so strings and comments never match; Vue templates and the renderer's HTML are read as
// text, and the CI workflows as YAML. Every finding names its trap (T01…) and the agent-skill rule
// that explains it (.claude/skills/flatchat/rules/<rule>.md). One line can opt out, with a reason,
// by a comment on it or on the line above:  trap-lint: allow T11 because <reason>
//
//   node tools/harness/src/trap-lint.ts [--root DIR] [--strict] [--json]
//   exit 0 = clean, 1 = errors (or warnings with --strict), 2 = bad arguments
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';

export type Severity = 'error' | 'warning';

export interface Trap {
  severity: Severity;
  rule: string;
  title: string;
  fix: string;
}

export interface Finding {
  trap: TrapId;
  severity: Severity;
  file: string;
  line: number;
  message: string;
}

export interface Source {
  rel: string;
  text: string;
}

export const TRAPS = {
  T01: { severity: 'error', rule: 'client-electron', title: 'Node.js reachable from web content', fix: 'keep nodeIntegration and its Worker and SubFrames variants off; give the page what it needs through the preload bridge' },
  T02: { severity: 'error', rule: 'client-electron', title: 'context isolation turned off', fix: 'keep contextIsolation: true, so page scripts cannot reach the preload script\'s Electron objects' },
  T03: { severity: 'error', rule: 'client-electron', title: 'renderer sandbox turned off', fix: 'keep sandbox: true; a renderer that needs Node.js is a design error' },
  T04: { severity: 'error', rule: 'client-electron', title: 'web security weakened', fix: 'never set webSecurity: false, allowRunningInsecureContent, experimentalFeatures or enableBlinkFeatures' },
  T05: { severity: 'error', rule: 'security-untrusted-input', title: 'code built from strings', fix: 'no eval, new Function or string timers: parse data, never run it' },
  T06: { severity: 'error', rule: 'security-untrusted-input', title: 'HTML built from data', fix: 'render text with Vue\'s {{ }} or textContent; never innerHTML, outerHTML, insertAdjacentHTML, document.write or v-html' },
  T07: { severity: 'error', rule: 'client-electron', title: 'renderer page without a strict content security policy', fix: 'keep the Content-Security-Policy meta tag with script-src \'self\' and no \'unsafe-eval\' or \'unsafe-inline\' for scripts' },
  T08: { severity: 'error', rule: 'client-electron', title: 'Electron or Node.js imported in the renderer', fix: 'the renderer is a sandboxed web page: ask the main process through the preload bridge' },
  T09: { severity: 'error', rule: 'client-electron', title: 'raw IPC handed to the page', fix: 'expose one named function per channel; never ipcRenderer itself or a channel chosen at run time' },
  T10: { severity: 'error', rule: 'client-electron', title: 'default application menu left in place', fix: 'call Menu.setApplicationMenu(null) outside development: its Alt toggle fights the game\'s controls' },
  T11: { severity: 'warning', rule: 'security-untrusted-input', title: 'raw asset loader in the client', fix: 'the client loads only the platform\'s own validated format, through the content package; raw loaders belong to the converter' },
  T12: { severity: 'error', rule: 'security-untrusted-input', title: 'node:vm used', fix: 'vm is not a security boundary: run untrusted code in its own process with no ambient authority' },
  T13: { severity: 'warning', rule: 'security-untrusted-input', title: 'shell command run through exec', fix: 'use execFile or spawn with an argument array; exec and execSync start a shell' },
  T14: { severity: 'error', rule: 'ci-github-actions', title: 'CI job without a time limit', fix: 'give every job timeout-minutes, so a hung step fails in minutes, not after six hours' },
  T15: { severity: 'error', rule: 'ci-github-actions', title: 'Linux client smoke test that cannot draw', fix: 'on Ubuntu runners, lift the AppArmor user-namespace limit in an earlier step and pass --enable-unsafe-swiftshader' },
  T16: { severity: 'warning', rule: 'client-electron', title: 'external link opened unchecked', fix: 'pass shell.openExternal only URLs built in code or checked against an allow-list of https hosts' },
  T17: { severity: 'error', rule: 'protocol-and-codecs', title: 'Node.js API in a shared package', fix: 'packages/ also run in the client\'s sandboxed renderer: use what Node.js and browsers both have (Uint8Array, DataView, TextEncoder, crypto.subtle), never Node built-ins, Buffer, process or __dirname' },
  T18: { severity: 'error', rule: 'core-service', title: 'SQL text built at run time', fix: 'pass values as query parameters ($1, $2, …); a template may only splice in an ALL_CAPS constant such as a column list' },
  T19: { severity: 'error', rule: 'core-service', title: 'markup made from data in the core\'s pages', fix: 'raw() takes only literal markup written in the code; everything else goes through html`…`, which escapes it' },
} as const satisfies Record<string, Trap>;

export type TrapId = keyof typeof TRAPS;

const CODE_EXT = new Set(['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx']);
const SKIP_DIRS = new Set(['node_modules', 'out', 'dist', 'build', 'release', 'coverage', '.cache', 'third_party', '.git']);
const SCAN_ROOTS = ['apps', 'packages', 'tools'];
const NODE_BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const NODE_GLOBALS = new Set(['Buffer', 'process', 'global', '__dirname', '__filename']);
const WEB_PREF_KEYS = new Set(['preload', 'contextIsolation', 'nodeIntegration', 'sandbox', 'webSecurity']);
const IPC_METHODS = new Set(['send', 'sendSync', 'invoke', 'on', 'once', 'postMessage', 'sendToHost']);
const ALLOW_RE = /trap-lint:\s*allow\s+((?:T\d\d[\s,]*)+)/;

const isRenderer = (rel: string): boolean => rel.startsWith('apps/client/src/renderer/');
const isPreload = (rel: string): boolean => rel.startsWith('apps/client/src/preload/');
const isClient = (rel: string): boolean => rel.startsWith('apps/client/');
/** The shared libraries' code, which runs in Node.js and in the client's renderer alike. */
const isShared = (rel: string): boolean => /^packages\/[^/]+\/src\//.test(rel);
const isCore = (rel: string): boolean => rel.startsWith('apps/core/src/');
const CONSTANT = /^[A-Z][A-Z0-9_]*$/;

/** SQL that is not one piece of text: a template splicing in anything but an ALL_CAPS constant,
 *  or a + with a non-literal side. A variable holding SQL is not judged. */
function dynamicSql(arg: ts.Expression): boolean {
  if (ts.isTemplateExpression(arg)) return arg.templateSpans.some((span) => !(ts.isIdentifier(span.expression) && CONSTANT.test(span.expression.text)));
  if (ts.isBinaryExpression(arg) && arg.operatorToken.kind === ts.SyntaxKind.PlusToken) return !(isStringLike(arg.left) && isStringLike(arg.right));
  if (ts.isParenthesizedExpression(arg)) return dynamicSql(arg.expression);
  return false;
}

/** Is this identifier a use of the global (Buffer.from, process.env, f(__dirname)), not a property name? */
function usesGlobal(id: ts.Identifier): boolean {
  const p = id.parent;
  if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === id) return true;
  if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
    const args: readonly ts.Node[] = p.arguments ?? [];
    return p.expression === id || args.includes(id);
  }
  return false;
}

function scriptKind(rel: string): ts.ScriptKind {
  const ext = extname(rel);
  if (ext === '.tsx') return ts.ScriptKind.TSX;
  if (ext === '.jsx') return ts.ScriptKind.JSX;
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function propName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return undefined;
}

function calleeName(expr: ts.Expression): string {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return `${calleeName(expr.expression)}.${expr.name.text}`;
  return '?';
}

const isStringLike = (n: ts.Node | undefined): boolean =>
  n !== undefined && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n));

/** Does this object literal look like Electron's webPreferences? */
function isWebPreferences(obj: ts.ObjectLiteralExpression): boolean {
  const parent = obj.parent;
  if (parent && ts.isPropertyAssignment(parent) && propName(parent.name) === 'webPreferences') return true;
  return obj.properties.some((p) => p.name !== undefined && WEB_PREF_KEYS.has(propName(p.name as ts.PropertyName) ?? ''));
}

interface CodeScan {
  findings: Finding[];
  createsWindow: number | undefined;
  removesMenu: boolean;
}

function scanCode(rel: string, text: string, kind = scriptKind(rel), lineOffset = 0): CodeScan {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
  const findings: Finding[] = [];
  const scan: CodeScan = { findings, createsWindow: undefined, removesMenu: false };
  const childProcessNames = new Set<string>();
  const at = (node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 + lineOffset;
  const add = (trap: TrapId, node: ts.Node, message: string): void => {
    findings.push({ trap, severity: TRAPS[trap].severity, file: rel, line: at(node), message });
  };

  const checkSpecifier = (spec: string, node: ts.Node, named: readonly string[] = [], typeOnly = false): void => {
    if (isRenderer(rel) && !typeOnly && (spec === 'electron' || NODE_BUILTINS.has(spec))) {
      add('T08', node, `the renderer imports '${spec}'`);
    }
    if (isShared(rel) && !typeOnly && (spec === 'electron' || NODE_BUILTINS.has(spec))) {
      add('T17', node, `a shared package imports '${spec}'`);
    }
    if (isClient(rel) && /^three\/(addons|examples\/jsm)\/loaders\//.test(spec)) {
      add('T11', node, `the client imports the raw loader '${spec}'`);
    }
    if (spec === 'vm' || spec === 'node:vm') add('T12', node, `imports '${spec}'`);
    if (spec === 'child_process' || spec === 'node:child_process') {
      for (const n of named) if (n === 'exec' || n === 'execSync') add('T13', node, `imports ${n} from '${spec}'`);
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      const named: string[] = [];
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) named.push((el.propertyName ?? el.name).text);
      }
      if (bindings && ts.isNamespaceImport(bindings) && /child_process$/.test(spec)) childProcessNames.add(bindings.name.text);
      if (node.importClause?.name && /child_process$/.test(spec)) childProcessNames.add(node.importClause.name.text);
      checkSpecifier(spec, node, named, node.importClause?.isTypeOnly ?? false);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      checkSpecifier(node.moduleSpecifier.text, node, [], node.isTypeOnly);
    } else if (ts.isCallExpression(node)) {
      const callee = calleeName(node.expression);
      const first = node.arguments[0];
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && first && ts.isStringLiteral(first)) {
        checkSpecifier(first.text, node);
      } else if (callee === 'require' && first && ts.isStringLiteral(first)) {
        checkSpecifier(first.text, node);
      } else if (callee === 'eval' || callee === 'Function') {
        add('T05', node, `${callee}(…) runs a string as code`);
      } else if ((callee === 'setTimeout' || callee === 'setInterval' || callee.endsWith('.setTimeout') || callee.endsWith('.setInterval')) && isStringLike(first)) {
        add('T05', node, `${callee} with a string runs it as code`);
      } else if (callee.endsWith('.insertAdjacentHTML')) {
        add('T06', node, 'insertAdjacentHTML parses its argument as HTML');
      } else if (callee === 'document.write' || callee === 'document.writeln') {
        add('T06', node, `${callee} parses its argument as HTML`);
      } else if (callee === 'Menu.setApplicationMenu') {
        scan.removesMenu = true;
      } else if (callee.endsWith('shell.openExternal') && !(first && ts.isStringLiteral(first))) {
        add('T16', node, 'shell.openExternal gets a URL built at run time');
      } else if (isPreload(rel) && /(^|\.)ipcRenderer\.\w+$/.test(callee) && IPC_METHODS.has(callee.split('.').pop() ?? '')) {
        if (!(first && ts.isStringLiteral(first))) add('T09', node, `${callee} gets a channel chosen at run time`);
      }
      if (/(^|\.)query$/.test(callee) && first && dynamicSql(first)) add('T18', node, `${callee} gets SQL text built at run time`);
      if (isCore(rel) && callee === 'raw' && first && !ts.isStringLiteral(first) && !ts.isNoSubstitutionTemplateLiteral(first)) {
        add('T19', node, 'raw(…) marks text built at run time as markup');
      }
      const [base, method] = [callee.split('.').slice(0, -1).join('.'), callee.split('.').pop()];
      if ((method === 'exec' || method === 'execSync') && childProcessNames.has(base)) {
        add('T13', node, `${callee} runs a shell`);
      }
    } else if (ts.isNewExpression(node)) {
      const callee = calleeName(node.expression);
      if (callee === 'Function') add('T05', node, 'new Function(…) runs a string as code');
      if ((callee === 'BrowserWindow' || callee.endsWith('.BrowserWindow')) && scan.createsWindow === undefined) {
        scan.createsWindow = at(node);
      }
    } else if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.EqualsToken || node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)) {
      const left = node.left;
      if (ts.isPropertyAccessExpression(left) && (left.name.text === 'innerHTML' || left.name.text === 'outerHTML')) {
        add('T06', node, `assigning ${left.name.text} parses the value as HTML`);
      }
    } else if (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.parent)) {
      const name = propName(node.name);
      const value = node.initializer.kind;
      const isTrue = value === ts.SyntaxKind.TrueKeyword;
      const isFalse = value === ts.SyntaxKind.FalseKeyword;
      if (name && isWebPreferences(node.parent)) {
        if ((name === 'nodeIntegration' || name === 'nodeIntegrationInWorker' || name === 'nodeIntegrationInSubFrames') && isTrue) {
          add('T01', node, `${name}: true`);
        } else if (name === 'contextIsolation' && isFalse) {
          add('T02', node, 'contextIsolation: false');
        } else if (name === 'sandbox' && isFalse) {
          add('T03', node, 'sandbox: false');
        } else if ((name === 'webSecurity' && isFalse) || ((name === 'allowRunningInsecureContent' || name === 'experimentalFeatures') && isTrue) || name === 'enableBlinkFeatures') {
          add('T04', node, `${name}: ${node.initializer.getText(sf)}`);
        }
      }
      if (isPreload(rel) && ts.isIdentifier(node.initializer) && node.initializer.text === 'ipcRenderer') {
        add('T09', node, 'ipcRenderer itself is handed to the page');
      }
    } else if (ts.isShorthandPropertyAssignment(node) && isPreload(rel) && node.name.text === 'ipcRenderer') {
      add('T09', node, 'ipcRenderer itself is handed to the page');
    } else if (ts.isIdentifier(node) && isShared(rel) && NODE_GLOBALS.has(node.text) && usesGlobal(node)) {
      add('T17', node, `a shared package uses Node.js's ${node.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return scan;
}

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

function scanVue(rel: string, text: string): CodeScan {
  const findings: Finding[] = [];
  let createsWindow: number | undefined;
  let removesMenu = false;
  for (const m of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    const attrs = m[1] ?? '';
    const body = m[2] ?? '';
    const offset = lineOf(text, (m.index ?? 0) + m[0].indexOf(body)) - 1;
    const kind = /lang=["']tsx?["']/.test(attrs) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    const scan = scanCode(rel, body, kind, offset);
    findings.push(...scan.findings);
    createsWindow ??= scan.createsWindow;
    removesMenu ||= scan.removesMenu;
  }
  const template = /<template\b[^>]*>([\s\S]*)<\/template>/.exec(text);
  if (template) {
    const start = (template.index ?? 0) + template[0].indexOf(template[1] ?? '');
    for (const v of (template[1] ?? '').matchAll(/\sv-html\s*=/g)) {
      findings.push({ trap: 'T06', severity: TRAPS.T06.severity, file: rel, line: lineOf(text, start + (v.index ?? 0) + 1), message: 'v-html renders its value as HTML' });
    }
  }
  return { findings, createsWindow, removesMenu };
}

function attrs(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    out.set((a[1] ?? '').toLowerCase(), a[2] ?? a[3] ?? '');
  }
  return out;
}

function scanHtml(rel: string, text: string): Finding[] {
  if (!isRenderer(rel)) return [];
  const finding = (line: number, message: string): Finding => ({ trap: 'T07', severity: TRAPS.T07.severity, file: rel, line, message });
  for (const m of text.matchAll(/<meta\b[^>]*>/gis)) {
    const a = attrs(m[0]);
    if ((a.get('http-equiv') ?? '').toLowerCase() !== 'content-security-policy') continue;
    const directives = new Map(
      (a.get('content') ?? '').split(';').map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map((d) => [d[0]!.toLowerCase(), d.slice(1)] as const),
    );
    const scripts = directives.get('script-src') ?? directives.get('default-src');
    const line = lineOf(text, m.index ?? 0);
    if (!scripts) return [finding(line, 'the policy sets neither script-src nor default-src')];
    const loose = scripts.filter((s) => s === "'unsafe-eval'" || s === "'unsafe-inline'" || s === '*');
    return loose.length ? [finding(line, `scripts allow ${loose.join(' ')}`)] : [];
  }
  return [finding(1, 'no Content-Security-Policy meta tag')];
}

interface Step {
  name?: string;
  run?: string;
}

function scanWorkflow(rel: string, text: string): Finding[] {
  const findings: Finding[] = [];
  let doc: { jobs?: Record<string, { 'timeout-minutes'?: unknown; steps?: Step[] }> };
  try {
    doc = parseYaml(text) ?? {};
  } catch (err) {
    return [{ trap: 'T14', severity: 'error', file: rel, line: 1, message: `not valid YAML: ${(err as Error).message.split('\n')[0]}` }];
  }
  const lines = text.split('\n');
  const keyLine = (key: string): number => Math.max(1, lines.findIndex((l) => l.startsWith(`  ${key}:`)) + 1);
  for (const [id, job] of Object.entries(doc.jobs ?? {})) {
    if (job?.['timeout-minutes'] === undefined) {
      findings.push({ trap: 'T14', severity: 'error', file: rel, line: keyLine(id), message: `job ${id} has no timeout-minutes` });
    }
    const steps = job?.steps ?? [];
    steps.forEach((step, i) => {
      const run = step.run ?? '';
      if (!/xvfb-run/.test(run) || !/--(smoke|bench)\b/.test(run) || /--disable-gpu\b/.test(run)) return;
      const first = run.split('\n').find((l) => l.includes('xvfb-run'))?.trim() ?? 'xvfb-run';
      const line = Math.max(1, lines.findIndex((l) => l.includes(first)) + 1);
      if (!/--enable-unsafe-swiftshader\b/.test(run)) {
        findings.push({ trap: 'T15', severity: 'error', file: rel, line, message: `job ${id}: the smoke run lacks --enable-unsafe-swiftshader (no GPU on the runner)` });
      }
      if (!steps.slice(0, i).some((s) => /apparmor_restrict_unprivileged_userns=0/.test(s.run ?? ''))) {
        findings.push({ trap: 'T15', severity: 'error', file: rel, line, message: `job ${id}: no earlier step lifts the AppArmor user-namespace limit Chromium's sandbox needs` });
      }
    });
  }
  return findings;
}

function allowed(text: string, line: number, trap: TrapId): boolean {
  const lines = text.split('\n');
  return [lines[line - 1], lines[line - 2]].some((l) => {
    const m = l === undefined ? null : ALLOW_RE.exec(l);
    return m !== null && (m[1] ?? '').includes(trap);
  });
}

/** Lint a set of files given by repository-relative path and text. */
export function lintSources(sources: readonly Source[]): Finding[] {
  const findings: Finding[] = [];
  let windowAt: { rel: string; line: number } | undefined;
  let menuRemoved = false;
  for (const { rel, text } of sources) {
    const ext = extname(rel);
    let found: Finding[] = [];
    if (CODE_EXT.has(ext) || ext === '.vue') {
      const scan = ext === '.vue' ? scanVue(rel, text) : scanCode(rel, text);
      found = scan.findings;
      if (rel.startsWith('apps/client/src/main/')) {
        if (scan.createsWindow !== undefined && !windowAt) windowAt = { rel, line: scan.createsWindow };
        menuRemoved ||= scan.removesMenu;
      }
    } else if (ext === '.html') {
      found = scanHtml(rel, text);
    } else if (rel.startsWith('.github/workflows/') && (ext === '.yml' || ext === '.yaml')) {
      found = scanWorkflow(rel, text);
    }
    findings.push(...found.filter((f) => !allowed(text, f.line, f.trap)));
  }
  if (windowAt && !menuRemoved) {
    findings.push({ trap: 'T10', severity: 'error', file: windowAt.rel, line: windowAt.line, message: 'the client opens a window but never calls Menu.setApplicationMenu' });
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.trap.localeCompare(b.trap));
}

function* walk(dir: string): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const name of names) {
    const full = join(dir, name);
    const st = statSync(full, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* walk(full);
    } else if (st.isFile()) {
      yield full;
    }
  }
}

/** Every file the linter reads in a repository, relative to its root, with forward slashes. */
export function collectSources(root: string): Source[] {
  const files = [...SCAN_ROOTS.flatMap((r) => [...walk(join(root, r))]), ...walk(join(root, '.github', 'workflows'))];
  return files
    .map((full) => relative(root, full).split(sep).join('/'))
    .filter((rel) => {
      const ext = extname(rel);
      return CODE_EXT.has(ext) || ext === '.vue' || ext === '.html' || (rel.startsWith('.github/workflows/') && (ext === '.yml' || ext === '.yaml'));
    })
    .map((rel) => ({ rel, text: readFileSync(join(root, rel), 'utf8') }));
}

export function formatFinding(f: Finding): string {
  const trap = TRAPS[f.trap];
  return `  ${f.severity.padEnd(7)} ${f.trap} ${f.file}:${f.line}  ${trap.title}: ${f.message}. Fix: ${trap.fix} (rule: ${trap.rule})`;
}

function main(): number {
  let values: { root?: string | undefined; strict?: boolean | undefined; json?: boolean | undefined };
  try {
    ({ values } = parseArgs({ options: { root: { type: 'string' }, strict: { type: 'boolean' }, json: { type: 'boolean' } } }));
  } catch (err) {
    console.error(`trap-lint: ${(err as Error).message}`);
    return 2;
  }
  const root = values.root ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const sources = collectSources(root);
  const findings = lintSources(sources);
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.length - errors;
  if (values.json) {
    console.log(JSON.stringify({ files: sources.length, errors, warnings, findings }, null, 2));
  } else if (findings.length === 0) {
    console.log(`trap-lint: OK · ${sources.length} file(s) · ${Object.keys(TRAPS).length} traps checked`);
  } else {
    console.log(`trap-lint: ${errors} error(s), ${warnings} warning(s) in ${sources.length} file(s)`);
    for (const f of findings) console.log(formatFinding(f));
  }
  return errors > 0 || (values.strict && warnings > 0) ? 1 : 0;
}

if (import.meta.main) process.exitCode = main();
