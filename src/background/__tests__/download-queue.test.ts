/**
 * Unit tests for DownloadQueue — Semaphore, state machine, progress, cancellation.
 *
 * Phase 4, Sub-Task 4.6
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Semaphore, DownloadQueue, type ChapterJob } from '../download-queue';

// ──────────────────────────────────────────
// Mock chrome API (not available in Node.js test environment)
// ──────────────────────────────────────────

function mockChrome() {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const onChangedListeners: Array<(delta: any) => void> = [];

  const removeListener = (listener: any) => {
    const idx = onChangedListeners.indexOf(listener);
    if (idx !== -1) onChangedListeners.splice(idx, 1);
  };

  // Simulate a completed download
  function fireDownloadComplete(downloadId: number) {
    setTimeout(() => {
      for (const listener of onChangedListeners) {
        listener({ id: downloadId, state: { current: 'complete' } });
      }
    }, 5);
  }

  (globalThis as any).chrome = {
    runtime: {
      sendMessage,
      lastError: undefined,
    },
    downloads: {
      download: vi.fn().mockImplementation((options: any, callback?: (id: number) => void) => {
        const downloadId = 123;
        if (callback) callback(downloadId);
        fireDownloadComplete(downloadId);
      }),
      onChanged: {
        addListener: vi.fn((listener: any) => onChangedListeners.push(listener)),
        removeListener: vi.fn(removeListener),
      },
      erase: vi.fn().mockResolvedValue(undefined),
      search: vi.fn().mockImplementation((_query: any, callback: (results: any[]) => void) => {
        callback([{ url: 'file:///tmp/test.bin', finalUrl: 'file:///tmp/test.bin' }]);
      }),
    },
  };

  return { sendMessage, mockDownload: globalThis.chrome.downloads.download };
}

let chromeMocks: ReturnType<typeof mockChrome>;

beforeEach(() => {
  chromeMocks = mockChrome();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as any).chrome;
});

// ══════════════════════════════════════════
// Semaphore Tests
// ══════════════════════════════════════════

describe('Semaphore', () => {
  it('acquires within limit immediately', async () => {
    const sem = new Semaphore(3);
    await sem.acquire();
    expect(sem.running).toBe(1);
  });

  it('blocks when at capacity', async () => {
    const sem = new Semaphore(1);
    await sem.acquire(); // takes the single slot

    let acquired = false;
    const acquirePromise = sem.acquire().then(() => {
      acquired = true;
    });

    // Should still be blocked
    expect(acquired).toBe(false);
    expect(sem.pending).toBe(1);

    // Release the slot — acquire should resolve
    sem.release();
    await acquirePromise;
    expect(acquired).toBe(true);
  });

  it('releases correctly with waiting queue', async () => {
    const sem = new Semaphore(2);

    await sem.acquire();
    await sem.acquire();
    expect(sem.running).toBe(2);

    let acquiredA = false;
    let acquiredB = false;

    const pA = sem.acquire().then(() => { acquiredA = true; });
    const pB = sem.acquire().then(() => { acquiredB = true; });

    expect(sem.pending).toBe(2);
    expect(acquiredA).toBe(false);
    expect(acquiredB).toBe(false);

    // Release one => first waiter runs
    sem.release();
    await pA;
    expect(acquiredA).toBe(true);
    expect(acquiredB).toBe(false);
    expect(sem.pending).toBe(1);

    // Release another => second waiter runs
    sem.release();
    await pB;
    expect(acquiredB).toBe(true);
    expect(sem.pending).toBe(0);
    expect(sem.running).toBe(2); // both waiters now hold slots
  });

  it('release without waiters decrements counter', () => {
    const sem = new Semaphore(3);
    sem.release(); // current is 0, should stay at 0
    expect(sem.running).toBe(0);

    // Acquire then release
    sem.acquire().then(() => {
      sem.release();
      expect(sem.running).toBe(0);
    });
  });

  it('supports multiple concurrent operations up to max', async () => {
    const sem = new Semaphore(5);
    const acquired: number[] = [];

    const ops = Array.from({ length: 10 }, async (_, i) => {
      await sem.acquire();
      acquired.push(i);
      await new Promise((r) => setTimeout(r, 10));
      sem.release();
    });

    await Promise.all(ops);

    // All 10 operations should have run
    expect(acquired).toHaveLength(10);
    expect(sem.running).toBe(0);
    expect(sem.pending).toBe(0);
  });
});

// ══════════════════════════════════════════
// DownloadQueue Tests
// ══════════════════════════════════════════

describe('DownloadQueue', () => {
  let queue: DownloadQueue;

  beforeEach(() => {
    queue = new DownloadQueue(3, 5);
  });

  afterEach(() => {
    queue.cancel();
  });

  function makeJob(overrides: Partial<ChapterJob> = {}): ChapterJob {
    return {
      bookId: 'book-1',
      seriesId: 'series-42',
      seriesTitle: 'Test Series',
      chapterNo: '1',
      title: 'Chapter 1',
      pageCount: 0,
      format: 'images',
      status: 'queued',
      progress: 0,
      imageUrls: [],
      downloadedImages: [],
      ...overrides,
    };
  }

  describe('addChapters', () => {
    it('adds a job and it enters extracting_urls state', async () => {
      const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(new ArrayBuffer(100), {
          status: 200,
          headers: { 'Content-Type': 'image/jpeg' },
        }),
      );

      const job = makeJob({ imageUrls: ['https://example.com/img.jpg'] });
      queue.addChapters([job]);

      // Give the async process a moment to start
      await new Promise((r) => setTimeout(r, 100));

      // Since we mock sendMessage, we can check progress
      const progress = queue.getProgress();
      expect(progress.total).toBe(1);
      expect(job.status).toBe('done'); // single image, should complete quickly

      mockFetch.mockRestore();
    });

    it('skips invalid jobs without bookId', () => {
      const invalid = makeJob({ bookId: '' });
      queue.addChapters([invalid]);

      const progress = queue.getProgress();
      expect(progress.total).toBe(0);
    });
  });

  describe('getProgress', () => {
    it('returns zero counts when empty', () => {
      const progress = queue.getProgress();
      expect(progress.total).toBe(0);
      expect(progress.completed).toBe(0);
      expect(progress.failed).toBe(0);
      expect(progress.chapters).toEqual([]);
    });

    it('returns correct counts after jobs are done', async () => {
      // Mock fetch to return valid images
      const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(new ArrayBuffer(100), {
          status: 200,
          headers: { 'Content-Type': 'image/jpeg' },
        }),
      );

      const job = makeJob({ imageUrls: ['https://example.com/img.jpg'] });
      queue.addChapters([job]);

      await new Promise((r) => setTimeout(r, 100));

      const progress = queue.getProgress();
      expect(progress.total).toBe(1);
      expect(progress.completed).toBe(1); // should succeed with mocked fetch

      mockFetch.mockRestore();
    });
  });

  describe('cancel', () => {
    it('cancels queued chapters and marks them as failed', () => {
      const job = makeJob({ imageUrls: ['https://slow.example/img.jpg'] });
      queue.addChapters([job]);

      // Immediately cancel
      queue.cancel();

      const progress = queue.getProgress();
      // The job may have already started, but if still queued/extracting, it's failed
      if (job.status === 'queued' || job.status === 'extracting_urls') {
        expect(job.status).toBe('failed');
        expect(job.error).toContain('Cancelled');
      }
    });
  });

  describe('onProgress', () => {
    it('calls progress listeners on status changes', async () => {
      const listener = vi.fn();
      queue.onProgress(listener);

      const job = makeJob({ imageUrls: ['https://example.com/img.jpg'] });
      queue.addChapters([job]);

      await new Promise((r) => setTimeout(r, 100));

      expect(listener).toHaveBeenCalled();
      const lastCall = listener.mock.calls[listener.mock.calls.length - 1][0];
      expect(lastCall).toHaveProperty('total');
      expect(lastCall).toHaveProperty('chapters');
    });

    it('returns unsubscribe function that works', () => {
      const listener = vi.fn();
      const unsubscribe = queue.onProgress(listener);

      unsubscribe();

      // Simulate a progress call
      queue['notifyProgress']();
      expect(listener).not.toHaveBeenCalled();
    });

    it('calls onComplete once when every chapter has finished', async () => {
      const mockFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
        () => Promise.resolve(new Response(new ArrayBuffer(100), {
          status: 200,
          headers: { 'Content-Type': 'image/jpeg' },
        })),
      );
      const onComplete = vi.fn();
      queue.onComplete = onComplete;

      queue.addChapters([makeJob({ imageUrls: ['https://example.com/img.jpg'] })]);
      await new Promise((r) => setTimeout(r, 150));
      queue['notifyProgress']();

      expect(onComplete).toHaveBeenCalledTimes(1);
      mockFetch.mockRestore();
    });
  });

  describe('state machine transitions', () => {
    it('chapter with no imageUrls fails with appropriate error', async () => {
      const job = makeJob({ imageUrls: [] });
      queue.addChapters([job]);

      await new Promise((r) => setTimeout(r, 100));

      expect(job.status).toBe('failed');
      expect(job.error).toBe('No image URLs provided');
    });

    it('resolves image URLs with loadImageUrls before downloading', async () => {
      const mockFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
        () => Promise.resolve(new Response(new ArrayBuffer(100), {
          status: 200,
          headers: { 'Content-Type': 'image/jpeg' },
        })),
      );
      const loadImageUrls = vi.fn().mockResolvedValue(['https://example.com/page1.jpg']);

      const job = makeJob({ imageUrls: [], loadImageUrls });
      queue.addChapters([job]);

      await new Promise((r) => setTimeout(r, 100));

      expect(loadImageUrls).toHaveBeenCalledTimes(1);
      expect(job.imageUrls).toEqual(['https://example.com/page1.jpg']);
      expect(job.status).toBe('done');

      mockFetch.mockRestore();
    });

    it('fails the chapter when loadImageUrls throws', async () => {
      const job = makeJob({
        imageUrls: [],
        loadImageUrls: vi.fn().mockRejectedValue(new Error('API unavailable')),
      });
      queue.addChapters([job]);

      await new Promise((r) => setTimeout(r, 100));

      expect(job.status).toBe('failed');
      expect(job.error).toBe('API unavailable');
    });

    it('chapter with imageUrls goes through extracting→downloading→done', async () => {
      // Mock fetch to return a fresh Response per call (body stream is consumed once)
      const mockFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
        () => Promise.resolve(new Response(new ArrayBuffer(100), {
          status: 200,
          headers: { 'Content-Type': 'image/jpeg' },
        })),
      );

      const job = makeJob({
        imageUrls: ['https://example.com/page1.jpg', 'https://example.com/page2.jpg'],
      });
      queue.addChapters([job]);

      await new Promise((r) => setTimeout(r, 300));

      expect(job.status).toBe('done');
      expect(job.progress).toBe(100);
      // downloadedImages is not populated for images format (saved directly to disk)

      mockFetch.mockRestore();
    });

    it('format cbz triggers conversion stage', async () => {
      // Mock fetch to return valid image
      const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(new ArrayBuffer(100), {
          status: 200,
          headers: { 'Content-Type': 'image/jpeg' },
        }),
      );

      // chrome.downloads.download is already mocked in beforeEach

      const job = makeJob({
        format: 'cbz',
        imageUrls: ['https://example.com/img.jpg'],
      });
      queue.addChapters([job]);

      await new Promise((r) => setTimeout(r, 300));

      // Should go through downloading→converting→done
      expect(job.status).toBe('done');
      expect(job.progress).toBe(100);

      // CBZ download should have been triggered
      expect(chromeMocks.mockDownload).toHaveBeenCalled();

      mockFetch.mockRestore();
    });

    it('format pdf triggers conversion stage via offscreen', async () => {
      const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(new ArrayBuffer(100), {
          status: 200,
          headers: { 'Content-Type': 'image/jpeg' },
        }),
      );

      let hasDoc = false;
      (globalThis as any).chrome.offscreen = {
        Reason: { DOM_PARSER: 'DOM_PARSER' },
        createDocument: vi.fn().mockImplementation(() => {
          hasDoc = true;
          return Promise.resolve();
        }),
        closeDocument: vi.fn().mockImplementation(() => {
          hasDoc = false;
          return Promise.resolve();
        }),
        hasDocument: vi.fn().mockImplementation(() => Promise.resolve(hasDoc)),
      };

      chromeMocks.sendMessage.mockResolvedValue({
        ok: true,
        data: 'c29tZSBwZGY=',
      });

      const job = makeJob({
        format: 'pdf',
        imageUrls: ['https://example.com/img.jpg'],
      });
      queue.addChapters([job]);

      await new Promise((r) => setTimeout(r, 300));

      expect(job.status).toBe('done');
      expect(job.progress).toBe(100);

      expect(chromeMocks.mockDownload).toHaveBeenCalled();
      expect(globalThis.chrome.offscreen.createDocument).toHaveBeenCalled();
      expect(globalThis.chrome.offscreen.closeDocument).toHaveBeenCalled();

      mockFetch.mockRestore();
      delete (globalThis as any).chrome.offscreen;
    });
  });
});
