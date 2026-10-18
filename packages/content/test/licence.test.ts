// SPDX-License-Identifier: Apache-2.0
// The gallery's licence fields (S5.06): every field required and read with every reason at once;
// a file's own terms, VRM 1.0's or VRM 0.x's; a publisher may be stricter than the file, never
// looser; and the gallery takes only what everyone may wear.
import { describe, expect, it } from 'vitest';
import { galleryProblems, LicenceError, licenceOfFile, looserThan, readLicence, STRICT_LICENCE } from '../src/index.ts';

describe('licence fields', () => {
  it('are all required, each one of its values, with every reason at once', () => {
    expect(readLicence(STRICT_LICENCE)).toEqual(STRICT_LICENCE);
    try {
      readLicence({ ...STRICT_LICENCE, avatarPermission: 'anyone', allowRedistribution: 'yes', licenseUrl: '', otherLicenseUrl: 'ftp://x' });
      throw new Error('it read');
    } catch (err) {
      expect(err).toBeInstanceOf(LicenceError);
      const problems = (err as LicenceError).problems.join(' | ');
      expect(problems).toMatch(/avatarPermission: one of/);
      expect(problems).toMatch(/allowRedistribution: true or false/);
      expect(problems).toMatch(/licenseUrl: a link to the licence/);
      expect(problems).toMatch(/otherLicenseUrl: a link, or empty/);
    }
    expect(() => readLicence({})).toThrow(LicenceError);
  });

  it('read a file’s own terms, VRM 1.0’s as they are and VRM 0.x’s by their names', () => {
    expect(licenceOfFile({ avatarPermission: 'everyone', modification: 'prohibited', allowRedistribution: false, name: 'x' })).toEqual({ avatarPermission: 'everyone', modification: 'prohibited', allowRedistribution: false });
    expect(licenceOfFile({ allowedUserName: 'OnlyAuthor', sexualUssageName: 'Disallow', licenseName: 'CC_BY_ND' })).toEqual({ avatarPermission: 'onlyAuthor', allowExcessivelySexualUsage: false, creditNotation: 'required', allowRedistribution: false, modification: 'prohibited' });
    expect(licenceOfFile({ licenseName: 'CC0' })).toMatchObject({ creditNotation: 'unnecessary', allowRedistribution: true, modification: 'allowModificationRedistribution' });
    expect(licenceOfFile({})).toEqual({});
  });

  it('let a publisher be stricter than the file, never looser', () => {
    const file = licenceOfFile({ avatarPermission: 'everyone', creditNotation: 'required', allowRedistribution: false, modification: 'allowModification', commercialUsage: 'personalProfit' });
    expect(looserThan(STRICT_LICENCE, file)).toEqual([]);
    expect(looserThan({ ...STRICT_LICENCE, creditNotation: 'unnecessary', allowRedistribution: true, modification: 'allowModificationRedistribution', commercialUsage: 'corporation' }, file)).toEqual(['commercialUsage', 'creditNotation', 'allowRedistribution', 'modification']);
    expect(looserThan(STRICT_LICENCE, licenceOfFile({ allowedUserName: 'OnlyAuthor' }))).toEqual(['avatarPermission']);
  });

  it('take into the gallery only what everyone may wear', () => {
    expect(galleryProblems(STRICT_LICENCE)).toEqual([]);
    expect(galleryProblems({ ...STRICT_LICENCE, avatarPermission: 'onlyAuthor' })).toHaveLength(1);
  });
});
