/**
 * Kagane Downloader — Service Worker (background.ts)
 *
 * MV3 background service worker entry point.
 * Built by Vite -> dist/assets/background.js
 *
 * Responsibilities (added in later phases):
 *   - Message routing from popup
 *   - API client calls (series metadata + chapter image URLs)
 *   - Download queue management
 *   - CBZ assembly via JSZip
 */

import { KaganeApiClient, extractSeriesId } from './api/client';
import { getSettings, updateSettings } from './background/settings';
import { DownloadQueue, type ChapterJob } from './background/download-queue';

/** Active download queue instance (null when idle). */
let activeQueue: DownloadQueue | null = null;

// ── API tab proxy (Cloudflare clearance cookies only exist in a tab) ──
let apiTabId: number | null = null;
let temporaryApiTab = false;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function pingApiTab(tabId: number): Promise<boolean> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'kagane:api-ping' });
    return Boolean(response?.ok);
  } catch {
    return false;
  }
}

async function findApiTab(): Promise<number | null> {
  if (apiTabId != null && (await pingApiTab(apiTabId))) return apiTabId;
  apiTabId = null;

  const tabs = await chrome.tabs.query({ url: ['https://kagane.moe/*'] });
  for (const tab of tabs) {
    if (tab.id != null && (await pingApiTab(tab.id))) {
      apiTabId = tab.id;
      temporaryApiTab = false;
      return apiTabId;
    }
  }
  return null;
}

async function createApiTab(): Promise<number | null> {
  try {
    const tab = await chrome.tabs.create({ url: 'https://kagane.moe/', active: false });
    if (tab.id == null) return null;

    for (let attempt = 0; attempt < 60; attempt++) {
      if (await pingApiTab(tab.id)) {
        apiTabId = tab.id;
        temporaryApiTab = true;
        return tab.id;
      }
      await sleep(250);
    }
    await chrome.tabs.remove(tab.id).catch(() => {});
  } catch (err) {
    console.warn('[Kagane] Could not open API tab:', err);
  }
  return null;
}

async function closeTemporaryApiTab(): Promise<void> {
  if (apiTabId != null && temporaryApiTab) {
    await chrome.tabs.remove(apiTabId).catch(() => {});
  }
  apiTabId = null;
  temporaryApiTab = false;
}

async function requestViaTab(
  tabId: number,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const result = await chrome.tabs.sendMessage(tabId, {
    type: 'kagane:api',
    payload: {
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
    },
  });

  if (!result?.ok) {
    throw new Error(result?.error || 'API tab request failed');
  }

  return new Response(result.body || '', {
    status: result.status || 200,
    statusText: result.statusText || '',
    headers: { 'Content-Type': result.contentType || 'application/json' },
  });
}

/**
 * Use the open kagane.moe tab when possible: its requests are same-origin and
 * carry Cloudflare's partitioned clearance cookie. Fall back to direct fetch
 * when no tab exists, and only open a temporary tab if that is also blocked.
 */
async function fetchViaTab(url: string, init: RequestInit): Promise<Response> {
  const existingTab = await findApiTab();
  if (existingTab != null) {
    return requestViaTab(existingTab, url, init);
  }

  let direct: Response | null = null;
  let directError: unknown;

  try {
    direct = await fetch(url, init);
    if (direct.status !== 403) return direct;
  } catch (err) {
    directError = err;
  }

  const tabId = await createApiTab();
  if (tabId != null) {
    try {
      return await requestViaTab(tabId, url, init);
    } catch (err) {
      directError = err;
    }
  }

  if (direct) return direct;
  throw directError instanceof Error ? directError : new Error(String(directError ?? 'API request failed'));
}

const apiClient = new KaganeApiClient({ fetchImpl: fetchViaTab });

// ──────────────────────────────────────────
// Install / Initialize
// ──────────────────────────────────────────
function registerDNRRules() {
  const headers = [
    { header: 'Referer', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: 'https://kagane.moe/' },
    { header: 'Origin', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: 'https://kagane.moe' },
  ];
  const allTypes = [
    chrome.declarativeNetRequest.ResourceType.MAIN_FRAME,
    chrome.declarativeNetRequest.ResourceType.SUB_FRAME,
    chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
    chrome.declarativeNetRequest.ResourceType.IMAGE,
    chrome.declarativeNetRequest.ResourceType.SCRIPT,
    chrome.declarativeNetRequest.ResourceType.OTHER,
  ];
  // Downloads/images only — don't touch API fetches or page navigations.
  const imageTypes = [
    chrome.declarativeNetRequest.ResourceType.IMAGE,
    chrome.declarativeNetRequest.ResourceType.OTHER,
  ];

  const rules = [
    {
      id: 1,
      priority: 1,
      action: {
        type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
        requestHeaders: headers,
      },
      condition: { urlFilter: '||kstatic.to/', resourceTypes: allTypes },
    },
    // Images served from kagane.moe itself still need a site referer.
    {
      id: 2,
      priority: 1,
      action: {
        type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
        requestHeaders: headers,
      },
      condition: { urlFilter: '||kagane.moe/', resourceTypes: imageTypes },
    },
  ];

  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1, 2, 3],
    addRules: rules,
  }).catch((err) => {
    console.error('[Kagane] Failed to update dynamic DNR rules:', err);
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  console.log(`[Kagane Downloader] Installed: ${details.reason}`);

  if (details.reason === 'install') {
    // Set default settings on first install
    chrome.storage.local.set({
      settings: {
        format: 'images', // 'images' | 'cbz'
        maxConcurrentChapters: 3,
        maxConcurrentImages: 5,
        maxRetries: 3,
      },
    });
  }

  // ─── DNR: Set Referer header for kagane.moe CDN domains ───
  registerDNRRules();
});

// ──────────────────────────────────────────
// Keep-Alive (prevent SW termination during long downloads)
// ──────────────────────────────────────────
chrome.alarms.get('keep-alive', (alarm) => {
  if (!alarm) {
    chrome.alarms.create('keep-alive', { periodInMinutes: 0.33 }); // ~20 seconds
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keep-alive') {
    // No-op keeps service worker alive
  }
});

// ─── DNR: Re-register at top level so rules apply on SW restart too ───
registerDNRRules();

// Keep DNR rules alive on browser start as well.
chrome.runtime.onStartup.addListener(() => {
  registerDNRRules();
});

// ──────────────────────────────────────────
// Message Router
// ──────────────────────────────────────────
export type BgMessage =
  | { type: 'ping' }
  | { type: 'fetch-series'; url: string }
  | { type: 'fetch-cover'; url: string }
  | { type: 'start-download'; seriesId: string; bookIds: string[]; format: 'images' | 'cbz' | 'pdf' }
  | { type: 'get-settings' }
  | { type: 'update-settings'; settings: Partial<Record<string, unknown>> }
  | { type: 'cancel-download' }
  | { type: 'get-progress' };

export type BgResponse =
  | { ok: true; data?: unknown }
  | { ok: false; error: string };

chrome.runtime.onMessage.addListener(
  (message: BgMessage, _sender, sendResponse: (response: BgResponse) => void) => {
    console.log('[Kagane Downloader] SW received:', message.type);

    switch (message.type) {
      case 'ping':
        sendResponse({ ok: true, data: { version: '2.0.0' } });
        break;

      case 'fetch-series': {
        const seriesId = extractSeriesId(message.url);
        if (!seriesId) {
          sendResponse({ ok: false, error: `Could not extract series ID from URL: ${message.url}` });
          break;
        }
        apiClient
          .getSeries(seriesId)
          .then((series) => {
            sendResponse({ ok: true, data: series });
          })
          .catch((err) => {
            sendResponse({ ok: false, error: String(err) });
          })
          .finally(() => {
            // Give the popup's follow-up cover request a moment to reuse the tab.
            setTimeout(() => {
              if (!activeQueue) void closeTemporaryApiTab();
            }, 3000);
          });
        return true; // Keep channel open for async
      }

      case 'start-download': {
        (async () => {
          try {
            const { seriesId, bookIds, format } = message as {
              type: 'start-download';
              seriesId: string;
              bookIds: string[];
              format: 'images' | 'cbz' | 'pdf';
            };

            // Fetch series to get book metadata
            const series = await apiClient.getSeries(seriesId);
            const settings = await getSettings();

            // Build ChapterJob objects for the requested books
            const books = series.seriesBooks.filter((b) => bookIds.includes(b.bookId));
            if (books.length === 0) {
              sendResponse({ ok: false, error: 'No matching books found for the given bookIds' });
              return;
            }

            // Sort by sortNo to maintain chapter order
            books.sort((a, b) => a.sortNo - b.sortNo);

            const jobs: ChapterJob[] = books.map((book) => ({
              bookId: book.bookId,
              seriesId: series.seriesId,
              seriesTitle: series.title,
              chapterNo: book.chapterNo,
              title: book.title,
              pageCount: book.pageCount,
              format: format || settings.format,
              status: 'queued' as const,
              progress: 0,
              imageUrls: [],
              // Resolved inside the queue so chapter concurrency applies.
              loadImageUrls: () => apiClient.getPageUrls(book.bookId),
              downloadedImages: [],
            }));

            // Create new queue instance
            const queue = new DownloadQueue(
              settings.maxConcurrentChapters,
              settings.maxConcurrentImages,
            );
            queue.onComplete = () => {
              void closeTemporaryApiTab();
            };

            // Cancel any previous download first
            if (activeQueue) {
              activeQueue.cancel();
            }
            activeQueue = queue;

            // Start processing (fire-and-forget)
            queue.addChapters(jobs);

            sendResponse({ ok: true, data: { jobCount: jobs.length } });
          } catch (err) {
            sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
          }
        })();
        return true; // Keep channel open for async response
      }

      case 'get-settings': {
        getSettings()
          .then((settings) => sendResponse({ ok: true, data: settings }))
          .catch((err) => sendResponse({ ok: false, error: String(err) }));
        return true;
      }

      case 'update-settings': {
        const partial = (message as { type: 'update-settings'; settings: Partial<Record<string, unknown>> }).settings;
        updateSettings(partial as Partial<import('./background/settings').AppSettings>)
          .then((merged) => sendResponse({ ok: true, data: merged }))
          .catch((err) => sendResponse({ ok: false, error: String(err) }));
        return true;
      }

      case 'cancel-download': {
        if (activeQueue) {
          activeQueue.cancel();
          activeQueue = null;
          void closeTemporaryApiTab();
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: 'No active download to cancel' });
        }
        break;
      }

      case 'get-progress': {
        if (activeQueue) {
          sendResponse({ ok: true, data: activeQueue.getProgress() });
        } else {
          sendResponse({ ok: true, data: null });
        }
        break;
      }

      case 'fetch-cover': {
        (async () => {
          try {
            const url = (message as { type: 'fetch-cover'; url: string }).url;

            // Prefer the same-origin tab (Cloudflare cookies).
            const tabId = await findApiTab();
            if (tabId != null) {
              try {
                const result = await chrome.tabs.sendMessage(tabId, {
                  type: 'kagane:api',
                  payload: { url, binary: true },
                });
                if (result?.ok && result.body) {
                  const mime = result.contentType || 'image/jpeg';
                  sendResponse({ ok: true, data: { dataUrl: `data:${mime};base64,${result.body}` } });
                  return;
                }
              } catch {
                // Fall through to direct fetch.
              }
            }

            const response = await fetch(url, {
              credentials: 'include',
              headers: {
                Accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
              },
            });
            if (!response.ok) {
              throw new Error(`HTTP ${response.status} fetching cover`);
            }
            const blob = await response.blob();
            const buffer = await blob.arrayBuffer();
            const bytes = new Uint8Array(buffer);
            let binary = '';
            for (let i = 0; i < bytes.byteLength; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            const base64 = btoa(binary);
            const mime = blob.type || 'image/jpeg';
            const dataUrl = `data:${mime};base64,${base64}`;
            sendResponse({ ok: true, data: { dataUrl } });
          } catch (err) {
            sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
          }
        })();
        return true;
      }

      default:
        sendResponse({ ok: false, error: `Unknown message type: ${(message as { type: string }).type}` });
    }
  }
);

// Log SW startup (useful for debugging lifecycle)
console.log('[Kagane Downloader] Service worker started');
