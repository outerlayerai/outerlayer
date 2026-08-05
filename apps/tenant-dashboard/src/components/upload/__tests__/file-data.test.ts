import { describe, expect, it } from 'vitest';

import { fileData, fileNameByUrl, fileTypeByUrl } from '../file-data';

describe('fileTypeByUrl', () => {
  it('returns the lowercase-preserving extension after the last dot', () => {
    expect(fileTypeByUrl('folder/report.final.PDF')).toBe('PDF');
    expect(fileTypeByUrl('photo.jpeg')).toBe('jpeg');
  });

  it('returns the whole string when there is no dot', () => {
    expect(fileTypeByUrl('noextension')).toBe('noextension');
  });

  it('returns an empty string for empty / missing input', () => {
    expect(fileTypeByUrl('')).toBe('');
    expect(fileTypeByUrl()).toBe('');
  });
});

describe('fileNameByUrl', () => {
  it('returns the last path segment', () => {
    expect(fileNameByUrl('a/b/c/report.pdf')).toBe('report.pdf');
    expect(fileNameByUrl('report.pdf')).toBe('report.pdf');
  });
});

describe('fileData', () => {
  it('derives key/name/type/preview from a string url', () => {
    expect(fileData('bucket/avatars/me.png')).toEqual({
      key: 'bucket/avatars/me.png',
      preview: 'bucket/avatars/me.png',
      name: 'me.png',
      type: 'png',
    });
  });

  it('extracts the descriptive fields from a File-like object', () => {
    const file = {
      name: 'resume.pdf',
      size: 2048,
      path: '/tmp/resume.pdf',
      type: 'application/pdf',
      preview: 'blob:resume',
      lastModified: 1700000000000,
      lastModifiedDate: '2023-11-14',
    } as unknown as File;

    expect(fileData(file)).toEqual({
      key: 'blob:resume',
      name: 'resume.pdf',
      size: 2048,
      path: '/tmp/resume.pdf',
      type: 'application/pdf',
      preview: 'blob:resume',
      lastModified: 1700000000000,
      lastModifiedDate: '2023-11-14',
    });
  });
});
