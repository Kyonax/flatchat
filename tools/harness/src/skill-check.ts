// SPDX-License-Identifier: MPL-2.0
// Checks the agent skill in .claude/skills/flatchat against the shape agents rely on: SKILL.md's
// frontmatter (its name, and a one-line description under 1024 characters), its size (under 500
// lines), a routing row and a Quick Reference row for every rule file and none for a missing one,
// each rule's frontmatter (title, impact, impactDescription, tags), every trap of the trap linter
// explained in the rule it names, and AGENTS.md pointing agents to the skill.
//
//   node tools/harness/src/skill-check.ts [--root DIR]     exit 0 = pass, 1 = problems
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { TRAPS } from './trap-lint.ts';

export const SKILL_DIR = '.claude/skills/flatchat';
const IMPACTS = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

export function frontmatter(text: string): { data: Record<string, unknown> | undefined; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { data: undefined, body: text };
  try {
    return { data: (parseYaml(m[1] ?? '') ?? {}) as Record<string, unknown>, body: text.slice(m[0].length) };
  } catch {
    return { data: undefined, body: text.slice(m[0].length) };
  }
}

/** The text of one "## Heading" section of a Markdown body, up to the next heading of that level. */
function section(body: string, heading: string): string {
  const start = body.indexOf(`\n## ${heading}`);
  if (start < 0) return '';
  const next = body.indexOf('\n## ', start + 4);
  return body.slice(start, next < 0 ? undefined : next);
}

export function checkSkill(root: string): string[] {
  const problems: string[] = [];
  const dir = join(root, SKILL_DIR);
  const skillPath = join(dir, 'SKILL.md');
  if (!existsSync(skillPath)) return [`missing ${SKILL_DIR}/SKILL.md`];
  const skill = readFileSync(skillPath, 'utf8');
  const { data, body } = frontmatter(skill);
  if (!data) {
    problems.push('SKILL.md: no YAML frontmatter');
  } else {
    if (data['name'] !== 'flatchat') problems.push(`SKILL.md: name must be "flatchat", the folder's name; got ${JSON.stringify(data['name'])}`);
    const d = data['description'];
    if (typeof d !== 'string' || !d.trim()) {
      problems.push('SKILL.md: the description is missing');
    } else {
      if (d.length > 1024) problems.push(`SKILL.md: the description has ${d.length} characters (at most 1024)`);
      if (d.includes('\n')) problems.push('SKILL.md: the description must be one line');
    }
  }
  const lines = skill.split('\n').length;
  if (lines >= 500) problems.push(`SKILL.md: ${lines} lines (keep it under 500)`);

  const rulesDir = join(dir, 'rules');
  const rules = existsSync(rulesDir) ? readdirSync(rulesDir).filter((f) => f.endsWith('.md')).sort() : [];
  if (rules.length === 0) problems.push('no rule files in rules/');
  const routed = new Set([...section(body, 'When to Read Which Rules').matchAll(/`rules\/([\w.-]+\.md)`/g)].map((m) => m[1]));
  const quick = new Set([...section(body, 'Quick Reference').matchAll(/^\|\s*`([\w-]+)`\s*\|/gm)].map((m) => m[1]));
  for (const file of rules) {
    const name = file.replace(/\.md$/, '');
    if (!routed.has(file)) problems.push(`SKILL.md: no routing row reads rules/${file}`);
    if (!quick.has(name)) problems.push(`SKILL.md: no Quick Reference row for ${name}`);
    const { data: fm } = frontmatter(readFileSync(join(rulesDir, file), 'utf8'));
    if (!fm) {
      problems.push(`rules/${file}: no YAML frontmatter`);
      continue;
    }
    for (const key of ['title', 'impact', 'impactDescription', 'tags']) {
      const v = fm[key];
      if (typeof v !== 'string' || !v.trim()) problems.push(`rules/${file}: the frontmatter needs ${key}`);
    }
    if (typeof fm['impact'] === 'string' && !IMPACTS.includes(fm['impact'])) {
      problems.push(`rules/${file}: impact must be one of ${IMPACTS.join(', ')}`);
    }
  }
  for (const file of routed) if (file && !rules.includes(file)) problems.push(`SKILL.md: routes to rules/${file}, which does not exist`);
  for (const name of quick) if (name && !rules.includes(`${name}.md`)) problems.push(`SKILL.md: Quick Reference lists ${name}, which has no rule file`);

  for (const [id, trap] of Object.entries(TRAPS)) {
    const file = join(rulesDir, `${trap.rule}.md`);
    if (!existsSync(file)) problems.push(`trap ${id} names the rule ${trap.rule}, which does not exist`);
    else if (!readFileSync(file, 'utf8').includes(id)) problems.push(`rules/${trap.rule}.md does not explain trap ${id}`);
  }

  const agents = join(root, 'AGENTS.md');
  if (!existsSync(agents)) problems.push('missing AGENTS.md at the repository root');
  else if (!readFileSync(agents, 'utf8').includes(`${SKILL_DIR}/SKILL.md`)) problems.push(`AGENTS.md does not point to ${SKILL_DIR}/SKILL.md`);
  return problems;
}

function main(): number {
  let root: string | undefined;
  try {
    ({ values: { root } } = parseArgs({ options: { root: { type: 'string' } } }));
  } catch (err) {
    console.error(`skill-check: ${(err as Error).message}`);
    return 2;
  }
  const repo = root ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const problems = checkSkill(repo);
  if (problems.length === 0) {
    const rules = readdirSync(join(repo, SKILL_DIR, 'rules')).filter((f) => f.endsWith('.md')).length;
    console.log(`skill-check: OK · ${SKILL_DIR} · ${rules} rules · ${Object.keys(TRAPS).length} traps explained`);
    return 0;
  }
  console.log(`skill-check: ${problems.length} problem(s)`);
  for (const p of problems) console.log(`  - ${p}`);
  return 1;
}

if (import.meta.main) process.exitCode = main();
