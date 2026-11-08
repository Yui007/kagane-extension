/**
 * Image Downloader — download a single image using chrome.downloads.download.
 *
 * Phase 4, Sub-Task 4.1 (adapted)
 * Uses Chrome's native download manager which provides the full browser TLS
 * fingerprint, proper cookies, and respects DNR rules — unlike fetch() from
 * a service worker context which can trigger CDN 404s or SSL fingerprint checks.
 */

// ──────────────────────────────────────────
// Types
// ──────────────────────────────────────────

export interface FetchedImage {
  buffer: ArrayBuffer;
  filename: string;
  mimeType: string;
  bytes: number;
}

// ──────────────────────────────────────────
// fetchImage via chrome.downloads.download
// ──────────────────────────────────────────

/**
 * Download a single image by URL using Chrome's native download manager.
 *
 * We create a temporary download, capture the file content via a second
 * fetch from the local file blob, then cancel the visible download.
 * This gives us the ArrayBuffer in memory while having used Chrome's full
 * browser stack to perform the HTTP request.
 *
 * For the 'images' format, use saveDirectImage() which just downloads
 * the file directly to disk without keeping data in memory.
 */

const DOWNLOAD_DIR = 'Kagane';

/**
 * Download an image directly to disk using chrome.downloads.download.
 * This bypasses fetch() entirely and uses Chrome's full browser stack.
 *
 * Returns a Promise that resolves when the download completes or fails.
 */
export async function saveDirectImage(
  url: string,
  seriesTitle: string,
  chapterNo: string,
  pageIndex: number,
  ext: string = 'webp',
): Promise<void> {
  const pageNum = String(pageIndex).padStart(3, '0');
  
  // First, fetch the image to memory to get the correct buffer and mime type.
  // This bypasses Chrome's URL-based extension overriding/heuristics for .txt.
  const fetched = await fetchImage(url, `${pageNum}.${ext}`, { ext });
  
  // Detect extension based on the actual fetched contentType (or fallback to ext)
  const finalExt = detectExtension(fetched.mimeType, fetched.filename);
  
  const safeDir = sanitizePath(seriesTitle);
  const filename = `${DOWNLOAD_DIR}/${safeDir}/Chapter_${chapterNo}/${pageNum}.${finalExt}`;

  const base64Data = arrayBufferToBase64(fetched.buffer);
  const mime = fetched.mimeType || 'image/webp';
  const dataUrl = `data:${mime};base64,${base64Data}`;

  return new Promise<void>((resolve, reject) => {
    let downloadId = -1;

    const onChanged = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id === downloadId) {
        if (delta.state?.current === 'complete') {
          chrome.downloads.onChanged.removeListener(onChanged);
          resolve();
        } else if (delta.state?.current === 'interrupted') {
          chrome.downloads.onChanged.removeListener(onChanged);
          chrome.downloads.erase({ id: delta.id }).catch(() => {});
          reject(new Error(delta.error?.current || 'Download interrupted'));
        }
      }
    };

    chrome.downloads.onChanged.addListener(onChanged);

    chrome.downloads.download(
      {
        url: dataUrl,
        filename,
        saveAs: false,
        conflictAction: 'overwrite',
      },
      (id) => {
        if (chrome.runtime.lastError) {
          chrome.downloads.onChanged.removeListener(onChanged);
          reject(new Error(chrome.runtime.lastError.message || 'chrome.downloads.download failed'));
          return;
        }
        if (id === undefined) {
          chrome.downloads.onChanged.removeListener(onChanged);
          reject(new Error('Download blocked (no downloadId returned)'));
          return;
        }
        downloadId = id;
      },
    );
  });
}

// ──────────────────────────────────────────
// fetchImage (kept for CBZ format which needs ArrayBuffer in memory)
// ──────────────────────────────────────────

const DEFAULT_MAX_RETRIES = 3;

/**
 * Download a single image from a URL, returning the raw ArrayBuffer.
 * Uses chrome.downloads.download to leverage the full browser stack,
 * then reads the local file to get the data in memory.
 *
 * This is more complex but necessary for CBZ assembly where we need
 * ArrayBuffers. For the default 'images' format, use saveDirectImage().
 */
export async function fetchImage(
  url: string,
  filename: string,
  options?: { maxRetries?: number; signal?: AbortSignal; ext?: string },
): Promise<FetchedImage> {
  // Try standard fetch first (works for blob: URLs and same-origin)
  try {
    const fallback = await fetchFromUrl(url, filename, options);
    return fallback;
  } catch (err) {
    console.error('[Kagane] fetchFromUrl failed:', err);
    // If fetch fails, fall back to chrome.downloads → read file
    return fetchViaDownload(url, filename, options?.ext || 'webp');
  }
}

async function fetchFromUrl(
  url: string,
  filename: string,
  options?: { maxRetries?: number; signal?: AbortSignal },
): Promise<FetchedImage> {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const signal = options?.signal;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        signal,
        credentials: 'include',
        headers: { Accept: 'image/webp,image/*,*/*' },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const contentType = response.headers.get('content-type') || '';
      const isAllowedType =
        contentType.startsWith('image/') ||
        contentType.startsWith('text/plain') ||
        contentType.startsWith('application/octet-stream') ||
        contentType === '';

      if (!isAllowedType) {
        throw new Error(`Non-image content-type: ${contentType}`);
      }

      const buffer = await response.arrayBuffer();
      if (buffer.byteLength === 0) {
        throw new Error('Empty response body');
      }

      const ext = detectExtension(contentType, filename);
      const safeName = `${filename.replace(/\.[^.]+$/, '')}.${ext}`;

      return {
        buffer,
        filename: safeName,
        mimeType: contentType,
        bytes: buffer.byteLength,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries - 1) {
        await delay(Math.min(1000 * Math.pow(2, attempt), 10_000));
      }
    }
  }

  throw lastError ?? new Error(`Failed to fetch ${filename} after ${maxRetries} attempts`);
}

/**
 * Fallback: download the image via chrome.downloads.download which
 * uses Chrome's full browser stack, then read the local file.
 */
async function fetchViaDownload(
  url: string,
  filename: string,
  ext: string,
): Promise<FetchedImage> {
  const tmpFilename = `_kagane_tmp_${Date.now()}_${filename}`;

  return new Promise((resolve, reject) => {
    let downloadId = -1;

    const onChanged = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.state?.current === 'complete' && delta.id === downloadId) {
        chrome.downloads.onChanged.removeListener(onChanged);

        // Read the downloaded file
        chrome.downloads.search({ id: downloadId }, async (results) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!results || results.length === 0) {
            reject(new Error('Downloaded file not found'));
            return;
          }

          const fileUri = results[0]?.url || results[0]?.finalUrl || '';
          if (!fileUri) {
            reject(new Error('No file URL after download'));
            return;
          }

          try {
            // Read from the local file URL using fetch
            const response = await fetch(fileUri);
            if (!response.ok) {
              reject(new Error(`Failed to read downloaded file: HTTP ${response.status}`));
              return;
            }
            const buffer = await response.arrayBuffer();
            const contentType = response.headers.get('content-type') || `image/${ext}`;

            // Erase the temporary download from history
            chrome.downloads.erase({ id: downloadId }).catch(() => {});

            resolve({
              buffer,
              filename,
              mimeType: contentType,
              bytes: buffer.byteLength,
            });
          } catch (err) {
            reject(err);
          }
        });
      } else if (delta.state?.current === 'interrupted' && delta.id === downloadId) {
        chrome.downloads.onChanged.removeListener(onChanged);
        chrome.downloads.erase({ id: downloadId }).catch(() => {});
        reject(new Error(delta.error?.current || 'Download interrupted'));
      }
    };

    chrome.downloads.onChanged.addListener(onChanged);

    chrome.downloads.download(
      {
        url,
        filename: tmpFilename,
        saveAs: false,
        conflictAction: 'overwrite',
      },
      (id) => {
        if (chrome.runtime.lastError) {
          chrome.downloads.onChanged.removeListener(onChanged);
          reject(new Error(chrome.runtime.lastError.message || 'chrome.downloads.download failed'));
          return;
        }
        if (id === undefined) {
          chrome.downloads.onChanged.removeListener(onChanged);
          reject(new Error('Download blocked'));
          return;
        }
        downloadId = id;
      },
    );
  });
}

// ──────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────

function detectExtension(contentType: string, originalFilename: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
  };
  for (const [ct, ext] of Object.entries(map)) {
    if (contentType.startsWith(ct)) return ext;
  }
  const match = originalFilename.match(/\.(\w+)$/);
  return match ? match[1] : 'jpg';
}

function sanitizePath(name: string): string {
  return name.replace(/[<>:"/\\|?*~\x00-\x1f]/g, '_').replace(/_+/g, '_').replace(/^[ .]+|[ .]+$/g, '');
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const len = bytes.byteLength;
  const chunkSize = 8192; // 8KB chunks to prevent stack overflow in apply()
  for (let i = 0; i < len; i += chunkSize) {
    const sub = bytes.subarray(i, i + chunkSize);
    // @ts-ignore
    binary += String.fromCharCode.apply(null, sub);
  }
  return btoa(binary);
}
