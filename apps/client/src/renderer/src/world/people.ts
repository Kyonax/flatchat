// SPDX-License-Identifier: MPL-2.0
// Who is in the world and their roles (S3.06), as the roster says: the People panel lists them,
// and an owner or an admin gives the roles below their own (the world checks it again).
import { ROLES } from '@flatchat/protocol';

export type Role = (typeof ROLES)[number];

export interface Person {
  entity: number;
  account: string;
  name: string;
  role: Role;
  /** This player. */
  me: boolean;
}

export function roleRank(role: Role): number {
  return ROLES.indexOf(role);
}

/** The roles someone with role `mine` may give: those below it, when it may give any (admin up). */
export function rolesToGive(mine: Role): Role[] {
  return roleRank(mine) >= roleRank('admin') ? ROLES.filter((r) => roleRank(r) < roleRank(mine)) : [];
}

/** Whether `mine` may change this person's role: someone else, below `mine`. */
export function canGiveTo(mine: Role, person: Person): boolean {
  return !person.me && rolesToGive(mine).length > 0 && roleRank(person.role) < roleRank(mine);
}

/** The list in the panel's order: this player first, then by role (highest first) and name. */
export function sortPeople(people: Iterable<Person>): Person[] {
  return [...people].sort((a, b) => Number(b.me) - Number(a.me) || roleRank(b.role) - roleRank(a.role) || a.name.localeCompare(b.name));
}
