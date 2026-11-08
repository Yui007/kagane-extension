/**
 * Kagane API Client — fetch-based HTTP client with retry logic.
 *
 * Port of the Python KaganeAPIClient using the Web Fetch API
 * (no curl-cffi dependency needed in a browser extension).
 */

import { type Book, type Series, normalizeSeries, parseBooks } from './types';

// ──────────────────────────────────────────
// Config
// ──────────────────────────────────────────

export type ApiFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ApiConfig {
  baseUrl: string;
  /** Request timeout in milliseconds */
  timeout: number;
  /** Maximum number of retry attempts on failure */
  maxRetries: number;
  /** Optional transport (e.g. proxy through a kagane.moe tab). Defaults to fetch. */
  fetchImpl?: ApiFetch;
}

export const DEFAULT_API_CONFIG: ApiConfig = {
  baseUrl: 'https://kagane.moe/api/v2',
  timeout: 15_000,
  maxRetries: 3,
};

interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface IntegrityResponse {
  token: string;
}

interface PageManifestResponse {
  cache_url?: string;
  access_token: string;
  manifest: {
    pages: Array<{ page_id: string; page_no: number; ext: string }>;
  };
}

/**
 * Extract a series ID from a Kagane URL or bare ID.
 * Accepts the current slug + UUID URLs as well as plain IDs:
 *   https://kagane.moe/series/some-title-{uuid}
 *   https://kagane.moe/series/{slug}/reader/{bookId}
 *   {uuid}
 */
export function extractSeriesId(url: string): string | null {
  if (!url) return null;

  const candidate = url.match(/kagane\.(?:to|moe|net|cx)\/series\/([^/?#]+)/i)?.[1] ?? url.trim();
  const uuid = candidate.match(
    /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i,
  )?.[0];

  if (uuid) return uuid;

  // Bare non-UUID ID
  if (/^[\w-]+$/.test(candidate)) return candidate;

  return null;
}

// ──────────────────────────────────────────
// API Client
// ──────────────────────────────────────────

export class KaganeApiClient {
  private config: ApiConfig;

  constructor(config?: Partial<ApiConfig>) {
    this.config = { ...DEFAULT_API_CONFIG, ...config };
  }

  /**
   * Core request method with retry logic.
   * Uses AbortController for timeout and fetch for HTTP.
   * Retries up to `maxRetries` times on any failure.
   */
  private async request<T>(endpoint: string, init: RequestOptions = {}): Promise<T> {
    const url = endpoint.startsWith('http') ? endpoint : `${this.config.baseUrl}${endpoint}`;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

      try {
        const doFetch = this.config.fetchImpl ?? fetch;
        const response = await doFetch(url, {
          method: init.method,
          body: init.body,
          credentials: 'include',
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            ...init.headers,
          },
        });

        if (!response.ok) {
          const detail = (await response.text())
            .replace(/<[^>]*>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120);
          throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
        }

        return (await response.json()) as T;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Don't delay on the last attempt
        if (attempt < this.config.maxRetries - 1) {
          // Exponential backoff: 1s, 2s, 4s...
          const delay = Math.min(1000 * Math.pow(2, attempt), 10_000);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      } finally {
        clearTimeout(timeoutId);
      }
    }

    throw lastError ?? new Error(`Request to ${url} failed after ${this.config.maxRetries} attempts`);
  }

  /**
   * Fetch a series by its ID and return a normalized Series object.
   */
  async getSeries(seriesId: string): Promise<Series> {
    const data = await this.request<Record<string, unknown>>(`/series/${seriesId}`);
    const series = normalizeSeries(data);
    series.seriesBooks = await this.getBooks(seriesId);
    return series;
  }

  /**
   * Fetch the packed chapter list for a series.
   * Response shape: { fields: string[], books: unknown[][] }
   */
  async getBooks(seriesId: string): Promise<Book[]> {
    const data = await this.request<Record<string, unknown>>(
      `/series/${seriesId}/books/index?fields=List`,
    );
    return parseBooks(data);
  }

  /**
   * Fetch ordered page image URLs for a chapter.
   *
   * The API requires a short-lived integrity token, then returns the
   * chapter manifest plus an access token used in each image URL.
   */
  async getPageUrls(bookId: string): Promise<string[]> {
    const origin = this.config.baseUrl.replace(/\/api\/v2\/?$/, '');

    const integrity = await this.request<IntegrityResponse>(`${origin}/api/integrity`, {
      method: 'POST',
    });

    const data = await this.request<PageManifestResponse>(`/books/${bookId}?intent=Read`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Integrity-Token': integrity.token,
      },
      body: '{}',
    });

    const cacheUrl = (data.cache_url || 'https://kstatic.to').replace(/\/$/, '');
    return [...data.manifest.pages]
      .sort((a, b) => a.page_no - b.page_no)
      .map(
        (page) =>
          `${cacheUrl}/api/v2/books/page/${bookId}/${page.page_id}.${page.ext}?token=${data.access_token}`,
      );
  }
}
