/**
 * Download Queue — orchestrates chapter downloads with concurrency control.
 *
 * Phase 4, Sub-Tasks 4.2–4.4
 *
 * Types (4.2) + Semaphore (4.2) + Queue State Machine (4.3) + Progress (4.4)
 */

import { fetchImage, saveDirectImage, arrayBufferToBase64, type FetchedImage } from './image-downloader';
import { createCbz, sanitizeFilename } from './formats/cbz';

// ══════════════════════════════════════════
// 4.2 — Types
// ══════════════════════════════════════════

export type ChapterStatus =
  | 'queued'
  | 'extracting_urls'
  | 'downloading'
  | 'converting'
  | 'done'
  | 'failed';

export interface ChapterJob {
  bookId: string;
  seriesId: string;
  seriesTitle: string;
  chapterNo: string;
  title: string;
  pageCount: number;
  format: 'images' | 'cbz' | 'pdf';
  status: ChapterStatus;
  progress: number; // 0–100
  imageUrls: string[]; // filled after extraction
  /** Optional API loader run under chapter concurrency. */
  loadImageUrls?: () => Promise<string[]>;
  downloadedImages: FetchedImage[];
  error?: string;
  processedPages?: number;
}

export interface ChapterProgress {
  bookId: string;
  chapterNo: string;
  title: string;
  status: ChapterStatus;
  progress: number;
  processedPages?: number;
  totalPages?: number;
  error?: string;
}

export interface QueueProgress {
  total: number;
  completed: number;
  failed: number;
  chapters: ChapterProgress[];
}

export type ProgressListener = (progress: QueueProgress) => void;

// ══════════════════════════════════════════
// 4.2 — Semaphore
// ══════════════════════════════════════════

export class Semaphore {
  private current = 0;
  private queue: Array<() => void> = [];

  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else if (this.current > 0) {
      this.current--;
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  get running(): number {
    return this.current;
  }
}

// ══════════════════════════════════════════
// 4.3–4.4 — DownloadQueue
// ══════════════════════════════════════════

export class DownloadQueue {
  private chapters: Map<string, ChapterJob> = new Map();
  private chapterSemaphore: Semaphore;
  private imageSemaphore: Semaphore;
  private listeners: Set<ProgressListener> = new Set();
  private abortController = new AbortController();
  private aborted = false;
  private activePdfConversions = 0;
  private completionNotified = false;

  /** Called once when every chapter has finished (done or failed). */
  onComplete?: () => void;

  constructor(
    maxConcurrentChapters: number = 3,
    maxConcurrentImages: number = 5,
  ) {
    this.chapterSemaphore = new Semaphore(maxConcurrentChapters);
    this.imageSemaphore = new Semaphore(maxConcurrentImages);
  }

  // ──────────────────────────────────────
  // Public API
  // ──────────────────────────────────────

  /**
   * Add one or more chapter jobs and start processing.
   * Returns immediately (non-blocking).
   */
  addChapters(jobs: ChapterJob[]): void {
    this.completionNotified = false;
    for (const job of jobs) {
      if (!job.bookId || !job.seriesId) {
        console.warn('[Kagane] Invalid job — missing bookId or seriesId', job);
        continue;
      }
      job.status = 'queued';
      job.progress = 0;
      job.downloadedImages = [];
      this.chapters.set(job.bookId, job);

      // Fire-and-forget: process each chapter under the semaphore
      this.processChapter(job).catch((err) => {
        console.error('[Kagane] Unexpected error in processChapter:', err);
      });
    }
    this.notifyProgress();
  }

  /**
   * Cancel all downloads.
   */
  cancel(): void {
    this.aborted = true;
    this.abortController.abort();

    for (const job of this.chapters.values()) {
      if (job.status === 'queued' || job.status === 'extracting_urls') {
        this.failJob(job, 'Cancelled by user');
      }
    }
    this.notifyProgress();
  }

  /**
   * Subscribe to progress updates. Returns an unsubscribe function.
   */
  onProgress(listener: ProgressListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Get the current overall progress.
   */
  getProgress(): QueueProgress {
    const chapters = Array.from(this.chapters.values());
    const done = chapters.filter((c) => c.status === 'done').length;
    const failed = chapters.filter((c) => c.status === 'failed').length;
    return {
      total: chapters.length,
      completed: done,
      failed,
      chapters: chapters.map((c) => ({
        bookId: c.bookId,
        chapterNo: c.chapterNo,
        title: c.title,
        status: c.status,
        progress: c.progress,
        processedPages: c.processedPages || 0,
        totalPages: c.imageUrls?.length || c.pageCount || 0,
        error: c.error,
      })),
    };
  }

  // ──────────────────────────────────────
  // 4.3 — State Machine
  // ──────────────────────────────────────

  /**
   * Process a single chapter through its lifecycle.
   */
  private async processChapter(job: ChapterJob): Promise<void> {
    await this.chapterSemaphore.acquire();

    if (this.aborted) {
      this.failJob(job, 'Download cancelled');
      this.chapterSemaphore.release();
      return;
    }

    try {
      // --- Stage: extracting_urls ---
      job.status = 'extracting_urls';
      this.notifyProgress();

      if ((!job.imageUrls || job.imageUrls.length === 0) && job.loadImageUrls) {
        try {
          job.imageUrls = await job.loadImageUrls();
        } catch (err) {
          this.failJob(job, err instanceof Error ? err.message : String(err));
          return;
        }
      }

      if (!job.imageUrls || job.imageUrls.length === 0) {
        this.failJob(job, 'No image URLs provided');
        return;
      }

      if (this.aborted) {
        this.failJob(job, 'Download cancelled');
        return;
      }

      // --- Stage: downloading ---
      job.status = 'downloading';
      job.progress = 0;
      this.notifyProgress();

      const successCount = await this.downloadAllImages(job);

      // If all images failed, mark as failed
      if (successCount === 0) {
        this.failJob(job, 'No images could be downloaded');
        return;
      }

      // --- Stage: converting (if format is cbz or pdf) ---
      if (job.format === 'cbz' && job.downloadedImages.length > 0) {
        job.status = 'converting';
        this.notifyProgress();
        await this.convertToCbz(job);
      } else if (job.format === 'pdf' && job.downloadedImages.length > 0) {
        job.status = 'converting';
        this.notifyProgress();
        await this.convertToPdf(job);
      }

      // --- Stage: done ---
      job.status = 'done';
      job.progress = 100;
      this.notifyProgress();
    } catch (err) {
      this.failJob(job, err instanceof Error ? err.message : String(err));
    } finally {
      this.chapterSemaphore.release();
    }
  }

  /**
   * Download all images for a chapter.
   * For 'images' format: saves directly to disk via chrome.downloads.download
   * (uses Chrome's full browser stack, bypassing fetch() TLS fingerprint issues).
   * For 'cbz' format: fetches into memory for zip assembly.
   * Returns the number of successfully downloaded images.
   */
  private async downloadAllImages(job: ChapterJob): Promise<number> {
    const total = job.imageUrls.length;
    let successCount = 0;
    const results: Array<{ index: number; image: FetchedImage } | null> = new Array(total).fill(null);

    if (job.format === 'images') {
      // ── Images format: save directly to disk ──────────────
      let processedCount = 0;
      const downloadOne = async (url: string, index: number): Promise<void> => {
        await this.imageSemaphore.acquire();
        try {
          if (this.aborted) return;
          await saveDirectImage(url, job.seriesTitle, job.chapterNo, index + 1, urlExtension(url));
          successCount++;
        } catch (err) {
          console.warn(`[Kagane] Failed to download image ${index + 1}/${total}:`, err);
        } finally {
          this.imageSemaphore.release();
          processedCount++;
          job.processedPages = processedCount;
          job.progress = Math.round((processedCount / total) * 100);
          this.notifyProgress();
        }
      };
      const promises = job.imageUrls.map((url, i) => downloadOne(url, i));
      await Promise.all(promises);
    } else {
      // ── CBZ/PDF format: fetch into memory ─────────────────────
      let processedCount = 0;
      const downloadOne = async (url: string, index: number): Promise<void> => {
        await this.imageSemaphore.acquire();
        try {
          if (this.aborted) return;
          const pageNum = String(index + 1).padStart(3, '0');
          const ext = urlExtension(url);
          const fetched = await fetchImage(url, `${pageNum}.${ext}`, {
            signal: this.getAbortSignal(),
            ext,
          });
          results[index] = { index, image: fetched };
          successCount++;
        } catch (err) {
          console.warn(`[Kagane] Failed to download image ${index + 1}/${total}:`, err);
        } finally {
          this.imageSemaphore.release();
          processedCount++;
          job.processedPages = processedCount;
          job.progress = Math.round((processedCount / total) * 100);
          this.notifyProgress();
        }
      };
      const promises = job.imageUrls.map((url, i) => downloadOne(url, i));
      await Promise.all(promises);

      job.downloadedImages = results
        .filter((r): r is NonNullable<typeof r> => r !== null)
        .sort((a, b) => a.index - b.index)
        .map((r) => r.image);
    }

    return successCount;
  }

  // ──────────────────────────────────────
  // 4.5 — CBZ conversion (delegates to formats/cbz.ts)
  // ──────────────────────────────────────

  private async convertToCbz(job: ChapterJob): Promise<void> {
    try {
      const base64Data = await createCbz({
        images: job.downloadedImages,
        seriesTitle: job.seriesTitle,
        chapterNo: job.chapterNo,
        chapterTitle: job.title,
        seriesId: job.seriesId,
        bookId: job.bookId,
      });

      const dataUrl = `data:application/zip;base64,${base64Data}`;
      const safeDir = sanitizeFilename(job.seriesTitle);
      const filename = `Kagane/${safeDir}/Chapter_${job.chapterNo}.cbz`;

      await chrome.downloads.download({
        url: dataUrl,
        filename,
        saveAs: false,
      });
    } catch (err) {
      console.error('[Kagane] CBZ conversion failed:', err);
      throw new Error(`CBZ conversion failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async createOffscreenDocument(): Promise<void> {
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: [chrome.offscreen.Reason.DOM_PARSER],
      justification: 'PDF generation from downloaded image buffers',
    });
  }

  private async closeOffscreenDocument(): Promise<void> {
    if (await chrome.offscreen.hasDocument()) {
      await chrome.offscreen.closeDocument();
    }
  }

  private async convertToPdf(job: ChapterJob): Promise<void> {
    try {
      this.activePdfConversions++;
      await this.createOffscreenDocument();

      const imagesPayload = job.downloadedImages.map((img) => ({
        base64: arrayBufferToBase64(img.buffer),
        mimeType: img.mimeType,
      }));

      const response = await chrome.runtime.sendMessage({
        type: 'offscreen:generate-pdf',
        payload: {
          images: imagesPayload,
          title: `${job.seriesTitle} - Ch.${job.chapterNo}`,
        },
      });

      if (!response || !response.ok) {
        throw new Error(response?.error || 'PDF generation failed in offscreen document');
      }

      const base64Data = response.data as string;
      const dataUrl = `data:application/pdf;base64,${base64Data}`;

      const safeDir = sanitizeFilename(job.seriesTitle);
      const filename = `Kagane/${safeDir}/Chapter_${job.chapterNo}.pdf`;

      await chrome.downloads.download({
        url: dataUrl,
        filename,
        saveAs: false,
      });
    } catch (err) {
      console.error('[Kagane] PDF conversion failed:', err);
      throw new Error(`PDF conversion failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.activePdfConversions--;
      if (this.activePdfConversions <= 0) {
        this.activePdfConversions = 0;
        await this.closeOffscreenDocument();
      }
    }
  }

  // ──────────────────────────────────────
  // 4.4 — Progress Reporting
  // ──────────────────────────────────────

  private notifyProgress(): void {
    const progress = this.getProgress();

    // Notify local listeners
    for (const listener of this.listeners) {
      try {
        listener(progress);
      } catch {
        /* ignore */
      }
    }

    // Send to popup via chrome.runtime.sendMessage
    chrome.runtime.sendMessage({
      type: 'download:progress',
      payload: progress,
    }).catch(() => {
      // Popup may not be open — that's fine
    });

    // Check if all chapters are done
    const total = this.chapters.size;
    const doneCount = [...this.chapters.values()].filter(
      (c) => c.status === 'done' || c.status === 'failed',
    ).length;
    if (total > 0 && doneCount === total && !this.completionNotified) {
      this.completionNotified = true;
      this.onComplete?.();
      const succeeded = [...this.chapters.values()].filter((c) => c.status === 'done').length;
      chrome.runtime.sendMessage({
        type: 'download:complete',
        payload: { total, completed: succeeded, failed: total - succeeded },
      }).catch(() => {});
    }
  }

  // ──────────────────────────────────────
  // Internal Helpers
  // ──────────────────────────────────────

  private failJob(job: ChapterJob, error: string): void {
    job.status = 'failed';
    job.error = error;
    this.notifyProgress();
  }

  private getAbortSignal(): AbortSignal {
    return this.abortController.signal;
  }
}

/** Page URLs carry the real format: .../page-id.webp?token=... */
function urlExtension(url: string): string {
  return url.match(/\.([a-z0-9]+)(?:\?|$)/i)?.[1]?.toLowerCase() || 'webp';
}
