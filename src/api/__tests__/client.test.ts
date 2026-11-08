/**
 * Unit tests for client.ts — KaganeApiClient
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KaganeApiClient, extractSeriesId } from '../client';

// ──────────────────────────────────────────
// Mock data
// ──────────────────────────────────────────

const MOCK_SERIES_RESPONSE: Record<string, unknown> = {
  series_id: '019c2b2c-eaa0-7f30-ba25-61a2e4c4df0f',
  title: 'Mock Series',
  description: 'A mocked series for testing',
  format: 'Manhwa',
  content_rating: 'Safe',
  publication_status: 'Ongoing',
  upload_status: 'Active',
  original_language: 'ko',
  translated_language: 'en',
  title_language: 'en',
  current_books: 15,
  total_views: 500000,
  created_at: '2023-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  source_id: '',
  tracker_id: '',
  genres: [],
  tags: [],
  series_alternate_titles: [],
  series_covers: [],
  series_links: [],
  series_staff: [],
};

const MOCK_BOOKS_RESPONSE: Record<string, unknown> = {
  fields: ['book_id', 'chapter_no', 'title', 'sort_no', 'page_count', 'published_on'],
  books: [
    ['b1', '1', 'Chapter 1', 1.0, 20, '2023-06-01T00:00:00Z'],
    ['b2', '2', 'Chapter 2', 2.0, 22, '2023-06-02T00:00:00Z'],
  ],
};

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ──────────────────────────────────────────
// Tests
// ──────────────────────────────────────────

describe('extractSeriesId()', () => {
  const uuid = '019c2b2c-eaa0-7f30-ba25-61a2e4c4df0f';

  it('extracts the UUID from slug series URLs', () => {
    expect(extractSeriesId(`https://kagane.moe/series/some-title-${uuid}`)).toBe(uuid);
  });

  it('extracts the UUID from reader URLs', () => {
    expect(extractSeriesId(`https://kagane.moe/series/${uuid}/reader/book-1`)).toBe(uuid);
  });

  it('accepts a bare UUID or plain ID', () => {
    expect(extractSeriesId(uuid)).toBe(uuid);
    expect(extractSeriesId('42')).toBe('42');
  });

  it('rejects unrelated URLs', () => {
    expect(extractSeriesId('https://example.com/series/foo')).toBeNull();
  });
});

describe('KaganeApiClient', () => {
  let client: KaganeApiClient;

  beforeEach(() => {
    client = new KaganeApiClient({
      baseUrl: 'https://kagane.moe/api/v2',
      timeout: 5000,
      maxRetries: 3,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getSeries()', () => {
    it('returns a normalized Series with the packed chapter list', async () => {
      const mockFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes('/books/index?fields=List')) {
          return jsonResponse(MOCK_BOOKS_RESPONSE);
        }
        return jsonResponse(MOCK_SERIES_RESPONSE);
      });

      const series = await client.getSeries('019c2b2c-eaa0-7f30-ba25-61a2e4c4df0f');

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(series.seriesId).toBe('019c2b2c-eaa0-7f30-ba25-61a2e4c4df0f');
      expect(series.title).toBe('Mock Series');
      expect(series.format).toBe('Manhwa');
      expect(series.currentBooks).toBe(15);
      expect(series.seriesBooks).toHaveLength(2);
      expect(series.seriesBooks[0].bookId).toBe('b1');
      expect(series.seriesBooks[0].createdAt).toBe('2023-06-01T00:00:00Z');
    });

    it('retries on network failure up to maxRetries and succeeds', async () => {
      let seriesAttempts = 0;

      const mockFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes('/books/index?fields=List')) {
          return jsonResponse(MOCK_BOOKS_RESPONSE);
        }
        seriesAttempts++;
        if (seriesAttempts < 3) {
          throw new Error('Network error');
        }
        return jsonResponse(MOCK_SERIES_RESPONSE);
      });

      const series = await client.getSeries('019c2b2c-eaa0-7f30-ba25-61a2e4c4df0f');

      expect(seriesAttempts).toBe(3);
      expect(series.seriesId).toBe('019c2b2c-eaa0-7f30-ba25-61a2e4c4df0f');
      expect(mockFetch).toHaveBeenCalled();
    });

    it('throws after exhausting all retry attempts', async () => {
      const mockFetch = vi.spyOn(globalThis, 'fetch');
      mockFetch.mockRejectedValue(new Error('Persistent failure'));

      await expect(
        client.getSeries('019c2b2c-eaa0-7f30-ba25-61a2e4c4df0f'),
      ).rejects.toThrow('Persistent failure');

      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('uses a custom fetch implementation when provided', async () => {
      const customFetch = vi.fn(async (input: string | URL | Request) => {
        return String(input).includes('/books/index')
          ? jsonResponse(MOCK_BOOKS_RESPONSE)
          : jsonResponse(MOCK_SERIES_RESPONSE);
      });
      const proxied = new KaganeApiClient({
        baseUrl: 'https://kagane.moe/api/v2',
        fetchImpl: customFetch,
      });

      const series = await proxied.getSeries('019c2b2c-eaa0-7f30-ba25-61a2e4c4df0f');

      expect(customFetch).toHaveBeenCalledTimes(2);
      expect(series.title).toBe('Mock Series');
      expect(series.seriesBooks).toHaveLength(2);
    });
  });

  describe('getPageUrls()', () => {
    it('fetches an integrity token, then builds sorted page URLs from the manifest', async () => {
      const requests: Array<{ url: string; init?: RequestInit }> = [];

      const mockFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = String(input);
        requests.push({ url, init });

        if (url === 'https://kagane.moe/api/integrity') {
          return jsonResponse({ token: 'integrity-token' });
        }
        return jsonResponse({
          cache_url: 'https://kstatic.to/',
          access_token: 'access-token',
          manifest: {
            pages: [
              { page_id: 'page-2', page_no: 2, ext: 'jpg' },
              { page_id: 'page-1', page_no: 1, ext: 'webp' },
            ],
          },
        });
      });

      const urls = await client.getPageUrls('book-1');

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(requests[0].url).toBe('https://kagane.moe/api/integrity');
      expect(requests[0].init?.method).toBe('POST');
      expect(requests[1].url).toBe('https://kagane.moe/api/v2/books/book-1?intent=Read');
      expect(requests[1].init?.method).toBe('POST');
      expect((requests[1].init?.headers as Record<string, string>)['X-Integrity-Token']).toBe(
        'integrity-token',
      );
      expect(requests[1].init?.body).toBe('{}');

      expect(urls).toEqual([
        'https://kstatic.to/api/v2/books/page/book-1/page-1.webp?token=access-token',
        'https://kstatic.to/api/v2/books/page/book-1/page-2.jpg?token=access-token',
      ]);
    });
  });
});
