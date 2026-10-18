// SPDX-License-Identifier: Apache-2.0
// The rules and policies a core serves (S7.02): each page's path, the same list for the core that
// serves them and the client that links to them (the client opens only these, on its own core).

export const POLICY_PAGES = {
  rules: '/rules',
  terms: '/terms',
  privacy: '/privacy',
  dataPolicy: '/data-policy',
  teens: '/teens',
  guardians: '/guardians',
  lawEnforcement: '/law-enforcement',
  hostAgreement: '/host-agreement',
  report: '/report',
  takedown: '/takedown',
} as const;
export type PolicyPage = keyof typeof POLICY_PAGES;
export const POLICY_PAGE_IDS = Object.keys(POLICY_PAGES) as PolicyPage[];
