// SPDX-License-Identifier: MPL-2.0
// The People panel's rules (S3.06): who may give which roles, and the list's order.
import { describe, expect, it } from 'vitest';
import { canGiveTo, type Person, rolesToGive, sortPeople } from '../src/renderer/src/world/people';

const person = (name: string, role: Person['role'], me = false): Person => ({ entity: name.length, account: `id-${name}`, name, role, me });

describe('roles in the People panel', () => {
  it('lets the owner give admin and below, an admin moderator and below, the rest nothing', () => {
    expect(rolesToGive('owner')).toEqual(['visitor', 'builder', 'moderator', 'admin']);
    expect(rolesToGive('admin')).toEqual(['visitor', 'builder', 'moderator']);
    expect(rolesToGive('moderator')).toEqual([]);
    expect(rolesToGive('visitor')).toEqual([]);
  });

  it('offers a change only for someone else below one’s own role', () => {
    expect(canGiveTo('admin', person('Bo', 'builder'))).toBe(true);
    expect(canGiveTo('admin', person('Al', 'admin'))).toBe(false);
    expect(canGiveTo('admin', person('Ow', 'owner'))).toBe(false);
    expect(canGiveTo('owner', person('Me', 'owner', true))).toBe(false);
    expect(canGiveTo('moderator', person('Vi', 'visitor'))).toBe(false);
  });

  it('lists this player first, then by role and name', () => {
    const list = sortPeople([person('Zed', 'visitor'), person('Ann', 'visitor'), person('Mo', 'moderator'), person('Me', 'visitor', true), person('Ow', 'owner')]);
    expect(list.map((p) => p.name)).toEqual(['Me', 'Ow', 'Mo', 'Ann', 'Zed']);
  });
});
