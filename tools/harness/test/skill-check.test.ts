// SPDX-License-Identifier: MPL-2.0
// The skill check on a throwaway skill folder: a complete one passes, each kind of gap is reported.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkSkill, SKILL_DIR } from '../src/skill-check.ts';
import { TRAPS } from '../src/trap-lint.ts';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function makeSkill(overrides: { skill?: string; agents?: string | null; dropRule?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'skill-check-'));
  roots.push(root);
  const dir = join(root, SKILL_DIR, 'rules');
  mkdirSync(dir, { recursive: true });
  const rules = [...new Set(Object.values(TRAPS).map((t) => t.rule))].filter((r) => r !== overrides.dropRule);
  for (const r of rules) {
    const ids = Object.entries(TRAPS).filter(([, t]) => t.rule === r).map(([id]) => id).join(', ');
    writeFileSync(join(dir, `${r}.md`), `---\ntitle: ${r} rule\nimpact: HIGH\nimpactDescription: Prevents ${r} mistakes.\ntags: ${r}\n---\n\nTraps ${ids}.\n`);
  }
  const routing = rules.map((r) => `| ${r} work | \`rules/${r}.md\` |`).join('\n');
  const quick = rules.map((r) => `| \`${r}\` | About ${r}. |`).join('\n');
  const skill = overrides.skill ?? `---\nname: flatchat\ndescription: One line.\n---\n\n# FlatChat\n\n## When to Read Which Rules\n\n| If working on... | Read these rules |\n|---|---|\n${routing}\n\n## Quick Reference\n\n| Rule | Description |\n|---|---|\n${quick}\n`;
  writeFileSync(join(root, SKILL_DIR, 'SKILL.md'), skill);
  if (overrides.agents !== null) writeFileSync(join(root, 'AGENTS.md'), overrides.agents ?? `Read ${SKILL_DIR}/SKILL.md first.\n`);
  return root;
}

describe('checkSkill', () => {
  it('passes a complete skill', () => {
    expect(checkSkill(makeSkill())).toEqual([]);
  });

  it('reports a wrong name, a missing AGENTS.md and a rule a trap needs', () => {
    const root = makeSkill({ agents: null, dropRule: 'ci-github-actions' });
    const problems = checkSkill(root).join('\n');
    expect(problems).toContain('missing AGENTS.md');
    expect(problems).toContain('names the rule ci-github-actions, which does not exist');
    const renamed = makeSkill({ skill: '---\nname: other\ndescription: x\n---\n' });
    expect(checkSkill(renamed).join('\n')).toContain('name must be "flatchat"');
  });
});
