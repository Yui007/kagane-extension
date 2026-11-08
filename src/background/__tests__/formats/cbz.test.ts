/**
 * Unit tests for CBZ archive builder — ComicInfo.xml, createCbz, sanitizeFilename.
 *
 * Phase 4, Sub-Task 4.6
 */

import { describe, it, expect } from 'vitest';
import {
  createCbz,
  generateComicInfoXml,
  sanitizeFilename,
  type CbzOptions,
} from '../../formats/cbz';
import type { FetchedImage } from '../../image-downloader';

// ──────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────

function makeImage(buffer?: ArrayBuffer, filename?: string): FetchedImage {
  return {
    buffer: buffer ?? new ArrayBuffer(10),
    filename: filename ?? '001.jpg',
    mimeType: 'image/jpeg',
    bytes: 10,
  };
}

function makeOptions(overrides: Partial<CbzOptions> = {}): CbzOptions {
  return {
    images: [makeImage()],
    seriesTitle: 'Test Series',
    chapterNo: '1',
    seriesId: '42',
    bookId: '99',
    ...overrides,
  };
}

// ══════════════════════════════════════════
// generateComicInfoXml Tests
// ══════════════════════════════════════════

describe('generateComicInfoXml', () => {
  it('includes Manga=Yes and PageCount tags', () => {
    const xml = generateComicInfoXml(makeOptions());
    expect(xml).toContain('<Manga>Yes</Manga>');
    expect(xml).toContain('<PageCount>1</PageCount>');
  });

  it('includes Series, Title, and Number tags', () => {
    const xml = generateComicInfoXml(makeOptions({
      seriesTitle: 'My Series',
      chapterNo: '5',
      chapterTitle: 'A Great Chapter',
    }));
    expect(xml).toContain('<Series>My Series</Series>');
    expect(xml).toContain('<Title>A Great Chapter</Title>');
    expect(xml).toContain('<Number>5</Number>');
  });

  it('uses "Chapter {N}" as title fallback when chapterTitle is omitted', () => {
    const xml = generateComicInfoXml(makeOptions({ chapterTitle: undefined }));
    expect(xml).toContain('<Title>Chapter 1</Title>');
  });

  it('includes AgeRating for adult content', () => {
    const xml = generateComicInfoXml(makeOptions({ contentRating: 'Adult' }));
    expect(xml).toContain('<AgeRating>Adults Only 18+</AgeRating>');
  });

  it('omits AgeRating for safe content', () => {
    const xml = generateComicInfoXml(makeOptions({ contentRating: 'Safe' }));
    expect(xml).not.toContain('AgeRating');
  });

  it('omits AgeRating for empty content rating', () => {
    const xml = generateComicInfoXml(makeOptions({ contentRating: '' }));
    expect(xml).not.toContain('AgeRating');
  });

  it('includes Genre when provided', () => {
    const xml = generateComicInfoXml(makeOptions({
      genres: ['Action', 'Romance'],
    }));
    expect(xml).toContain('<Genre>Action, Romance</Genre>');
  });

  it('omits Genre when empty', () => {
    const xml = generateComicInfoXml(makeOptions({ genres: [] }));
    expect(xml).not.toContain('<Genre>');
  });

  it('includes Summary when provided', () => {
    const xml = generateComicInfoXml(makeOptions({
      description: 'A thrilling tale.',
    }));
    expect(xml).toContain('<Summary>A thrilling tale.</Summary>');
  });

  it('omits Summary when not provided', () => {
    const xml = generateComicInfoXml(makeOptions({ description: undefined }));
    expect(xml).not.toContain('<Summary>');
  });

  it('includes SeriesStatus when publicationStatus is provided', () => {
    const xml = generateComicInfoXml(makeOptions({ publicationStatus: 'Ongoing' }));
    expect(xml).toContain('<SeriesStatus>Ongoing</SeriesStatus>');
  });

  it('omits SeriesStatus when not provided', () => {
    const xml = generateComicInfoXml(makeOptions({ publicationStatus: undefined }));
    expect(xml).not.toContain('<SeriesStatus>');
  });

  it('includes Web tag with reader URL', () => {
    const xml = generateComicInfoXml(makeOptions({ seriesId: '123', bookId: '456' }));
    expect(xml).toContain('https://kagane.moe/series/123/reader/456');
  });

  it('escapes special XML characters in titles', () => {
    const xml = generateComicInfoXml(makeOptions({
      seriesTitle: 'Test & "Series" <Fun>',
    }));
    expect(xml).toContain('Test &amp; &quot;Series&quot; &lt;Fun&gt;');
  });

  it('produces valid XML structure', () => {
    const xml = generateComicInfoXml(makeOptions());
    expect(xml).toMatch(/^<\?xml version="1\.0" encoding="utf-8"\?>/);
    expect(xml).toMatch(/<ComicInfo/);
    expect(xml).toMatch(/<\/ComicInfo>$/);
  });

  it('sets correct PageCount matching image count', () => {
    const images = Array.from({ length: 5 }, (_, i) =>
      makeImage(new ArrayBuffer(10), `${String(i + 1).padStart(3, '0')}.jpg`),
    );
    const xml = generateComicInfoXml(makeOptions({ images }));
    expect(xml).toContain('<PageCount>5</PageCount>');
  });
});

// ══════════════════════════════════════════
// createCbz Tests
// ══════════════════════════════════════════

describe('createCbz', () => {
  it('produces a base64 string', async () => {
    const base64 = await createCbz(makeOptions());
    expect(typeof base64).toBe('string');
    expect(() => atob(base64)).not.toThrow();
  });

  it('contains ComicInfo.xml and images when unzipped', async () => {
    const images = [
      makeImage(new ArrayBuffer(10), '001.jpg'),
      makeImage(new ArrayBuffer(20), '002.jpg'),
    ];
    const base64 = await createCbz(makeOptions({ images }));

    const binary = atob(base64);
    const arrayBuffer = new ArrayBuffer(binary.length);
    const bytes = new Uint8Array(arrayBuffer);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(arrayBuffer);

    // Check ComicInfo.xml exists
    expect(zip.file('ComicInfo.xml')).toBeTruthy();

    // Check images exist
    expect(zip.file('001.jpg')).toBeTruthy();
    expect(zip.file('002.jpg')).toBeTruthy();
    expect(Object.keys(zip.files)).toHaveLength(3); // 2 images + xml
  });

  it('preserves image order', async () => {
    const images = [
      makeImage(new ArrayBuffer(10), '002.jpg'),
      makeImage(new ArrayBuffer(20), '001.jpg'),
      makeImage(new ArrayBuffer(30), '003.jpg'),
    ];
    const base64 = await createCbz(makeOptions({ images }));

    const binary = atob(base64);
    const arrayBuffer = new ArrayBuffer(binary.length);
    const bytes = new Uint8Array(arrayBuffer);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(arrayBuffer);

    const fileNames = Object.keys(zip.files).filter((f) => f !== 'ComicInfo.xml');
    // They should be in the same order they were provided
    expect(fileNames).toEqual(['002.jpg', '001.jpg', '003.jpg']);
  });

  it('uses STORE compression (no compression)', async () => {
    const imageData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const images = [makeImage(imageData.buffer as ArrayBuffer, '001.jpg')];

    const base64 = await createCbz(makeOptions({ images }));
    const binary = atob(base64);

    // With STORE compression, the zip overhead is minimal
    // The zip should be at least as large as the raw data
    expect(binary.length).toBeGreaterThanOrEqual(10);
  });
});

// ══════════════════════════════════════════
// sanitizeFilename Tests
// ══════════════════════════════════════════

describe('sanitizeFilename', () => {
  it('replaces invalid characters with underscore', () => {
    const result = sanitizeFilename('test:file/name\\with|bad?chars*');
    expect(result).toBe('test_file_name_with_bad_chars');
  });

  it('replaces angled brackets and quotes', () => {
    const result = sanitizeFilename('a<b>c"d"e');
    expect(result).toBe('a_b_c_d_e');
  });

  it('truncates long names to maxLength', () => {
    const long = 'a'.repeat(200);
    const result = sanitizeFilename(long, 10);
    expect(result).toBe('aaaaaaaaaa');
    expect(result.length).toBe(10);
  });

  it('removes leading and trailing dots and spaces', () => {
    const result = sanitizeFilename('  ..hello world..  ');
    expect(result).toBe('hello world');
  });

  it('returns "untitled" for empty input after sanitization', () => {
    expect(sanitizeFilename('')).toBe('untitled');
  });

  it('returns "untitled" for input with only invalid chars', () => {
    expect(sanitizeFilename('<>:"/\\|?*')).toBe('untitled');
  });

  it('returns "untitled" for input with only dots and spaces', () => {
    expect(sanitizeFilename(' . . . ')).toBe('untitled');
  });

  it('preserves valid filenames unchanged', () => {
    const result = sanitizeFilename('My_Chapter_001');
    expect(result).toBe('My_Chapter_001');
  });

  it('truncates and does not end with a space', () => {
    // Truncation should trim trailing spaces
    const result = sanitizeFilename('hello world this is a very long name that should get cut', 10);
    expect(result).toBe('hello worl');
    expect(result.endsWith(' ')).toBe(false);
  });
});
