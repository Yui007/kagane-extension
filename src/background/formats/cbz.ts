/**
 * CBZ Archive Builder — assembles CBZ files with ComicInfo.xml metadata.
 *
 * Phase 4, Sub-Task 4.5
 *
 * Mirrors the Python CBZ builder from src/converter/cbz.py
 * Uses JSZip with STORE compression (images are already compressed).
 */

import JSZip from 'jszip';
import type { FetchedImage } from '../image-downloader';

// ──────────────────────────────────────────
// Types
// ──────────────────────────────────────────

export interface CbzOptions {
  images: FetchedImage[];
  seriesTitle: string;
  chapterNo: string;
  chapterTitle?: string;
  seriesId: string;
  bookId: string;
  genres?: string[];
  publicationStatus?: string;
  contentRating?: string;
  description?: string;
}

// ──────────────────────────────────────────
// Main: createCbz
// ──────────────────────────────────────────

/**
 * Create a CBZ (Comic Book ZIP) base64 string from fetched images and metadata.
 * Uses STORE compression (no re-compression — images are already compressed).
 */
export async function createCbz(options: CbzOptions): Promise<string> {
  const zip = new JSZip();

  // 1. Generate and add ComicInfo.xml
  const comicInfoXml = generateComicInfoXml(options);
  zip.file('ComicInfo.xml', comicInfoXml);

  // 2. Add images sorted by filename (001.jpg, 002.jpg, ...)
  for (const img of options.images) {
    zip.file(img.filename, img.buffer, { binary: true });
  }

  // 3. Generate base64 (STORE method)
  const base64 = await zip.generateAsync({ type: 'base64', compression: 'STORE' });
  return base64;
}

// ──────────────────────────────────────────
// ComicInfo.xml Generator
// ──────────────────────────────────────────

/**
 * Generate ComicInfo.xml metadata string.
 * Port of Python's generate_comic_info_api() from src/converter/cbz.py
 */
export function generateComicInfoXml(options: CbzOptions): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="utf-8"?>');
  lines.push('<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">');

  // Title
  lines.push(`  <Title>${escapeXml(options.chapterTitle || `Chapter ${options.chapterNo}`)}</Title>`);
  // Series
  lines.push(`  <Series>${escapeXml(options.seriesTitle)}</Series>`);
  // Number
  lines.push(`  <Number>${escapeXml(options.chapterNo)}</Number>`);
  // Count (total chapters — omitted if not known)
  // Summary
  if (options.description) {
    lines.push(`  <Summary>${escapeXml(options.description)}</Summary>`);
  }
  // Genre
  if (options.genres && options.genres.length > 0) {
    lines.push(`  <Genre>${escapeXml(options.genres.join(', '))}</Genre>`);
  }
  // Page count
  lines.push(`  <PageCount>${options.images.length}</PageCount>`);
  // Web (reader URL)
  lines.push(`  <Web>https://kagane.moe/series/${escapeXml(options.seriesId)}/reader/${escapeXml(options.bookId)}</Web>`);
  // Manga reading direction (right-to-left for manga/manhwa)
  lines.push('  <Manga>Yes</Manga>');
  // Series status
  if (options.publicationStatus) {
    const statusMap: Record<string, string> = {
      Ongoing: 'Ongoing',
      Ended: 'Ended',
      Hiatus: 'Hiatus',
    };
    lines.push(`  <SeriesStatus>${escapeXml(statusMap[options.publicationStatus] || options.publicationStatus)}</SeriesStatus>`);
  }
  // Age rating
  if (options.contentRating && options.contentRating.toLowerCase() !== 'safe' && options.contentRating !== '') {
    lines.push('  <AgeRating>Adults Only 18+</AgeRating>');
  }

  lines.push('</ComicInfo>');
  return lines.join('\n');
}

// ──────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────

/**
 * Escape XML special characters.
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Sanitize a filename for safe filesystem usage.
 * - Replaces invalid characters (`<>:"/\|?*`) with `_`
 * - Trims whitespace
 * - Removes leading/trailing dots and spaces
 * - Truncates to `maxLength` (default 80)
 * - Returns 'untitled' if result is empty
 */
export function sanitizeFilename(name: string, maxLength = 80): string {
  const invalidChars = /[<>:"/\\|?*]/g;
  let sanitized = name.replace(invalidChars, '_').trim();
  sanitized = sanitized.replace(/^[._ ]+|[._ ]+$/g, '');
  if (!sanitized.replace(/[._ ]/g, '')) {
    return 'untitled';
  }
  if (sanitized.length > maxLength) {
    sanitized = sanitized.slice(0, maxLength).trimEnd();
  }
  return sanitized || 'untitled';
}
