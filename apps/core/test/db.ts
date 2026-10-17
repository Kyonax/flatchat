// SPDX-License-Identifier: AGPL-3.0-or-later
// A fresh, migrated database for one test file.
import { randomBytes } from 'node:crypto';
import { inject } from 'vitest';
import { Db, migrate } from '../src/db.ts';

export async function freshDb(): Promise<Db> {
  const base = inject('pgUrl');
  const admin = new Db(base, 1);
  const name = `t_${randomBytes(6).toString('hex')}`;
  // trap-lint: allow T18 because a database name cannot be a query parameter; it is random hex made above
  await admin.query(`create database ${name}`);
  await admin.close();
  const url = new URL(base.replace(/^postgresql:/, 'http:'));
  url.pathname = `/${name}`;
  const db = new Db(url.toString().replace(/^http:/, 'postgresql:'));
  await migrate(db);
  return db;
}
