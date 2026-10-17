// SPDX-License-Identifier: AGPL-3.0-or-later
// One PostgreSQL server for the whole test run; each test file makes its own database in it.
import type { TestProject } from 'vitest/node';
import { startPostgres } from './postgres.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    pgUrl: string;
  }
}

export default function setup(project: TestProject): (() => void) | undefined {
  const external = process.env['FLATCHAT_TEST_DB'];
  if (external) {
    project.provide('pgUrl', external);
    return undefined;
  }
  const pg = startPostgres();
  project.provide('pgUrl', pg.url);
  return () => pg.stop();
}
