/**
 * Kagane Downloader — Popup Script
 *
 * Full popup controller for Browse, Downloads, and Settings tabs.
 * Communicates exclusively via chrome.runtime.sendMessage to background.ts.
 */

import type { BgMessage, BgResponse } from '../src/background';
import type { Series } from '../src/api/types';
import type { QueueProgress, ChapterStatus } from '../src/background/download-queue';

// ══════════════════════════════════════════
// DOM refs
// ══════════════════════════════════════════

const swStatusDot = document.getElementById('sw-status')!;
const swStatusText = document.getElementById('sw-status-text')!;
const tabButtons = document.querySelectorAll<HTMLButtonElement>('.tab');
const tabPanels = document.querySelectorAll<HTMLElement>('.tab-panel');

// ─── Error / Notification bar ───
const errorBar = document.getElementById('error-bar')!;
const errorText = document.getElementById('error-text')!;
const errorDismiss = document.getElementById('error-dismiss')!;

// ─── Loading overlay ───
const loadingOverlay = document.getElementById('loading-overlay')!;
const loadingText = document.getElementById('loading-text')!;

// ─── Browse Tab ───
const seriesUrlInput = document.getElementById('series-url') as HTMLInputElement;
const pasteBtn = document.getElementById('paste-btn') as HTMLButtonElement;
const loadBtn = document.getElementById('load-btn') as HTMLButtonElement;
const seriesCard = document.getElementById('series-card')!;
const browseError = document.getElementById('browse-error')!;
const chapterSection = document.getElementById('chapter-section')!;
const chapterListContainer = document.getElementById('chapter-list')!;
const selectAllCheckbox = document.getElementById('select-all') as HTMLInputElement;
const chapterCount = document.getElementById('chapter-count')!;
const rangeInput = document.getElementById('range-input') as HTMLInputElement;
const rangeSelectBtn = document.getElementById('range-select-btn') as HTMLButtonElement;
const formatSelect = document.getElementById('format-select') as HTMLSelectElement;
const downloadBtn = document.getElementById('download-btn') as HTMLButtonElement;
const clearHistoryBtn = document.getElementById('clear-history-btn') as HTMLButtonElement;

// ─── Settings Tab ───
const formatRadios = document.querySelectorAll<HTMLInputElement>('input[name="format"]');
const maxChaptersInput = document.getElementById('max-chapters') as HTMLInputElement;
const maxImagesInput = document.getElementById('max-images') as HTMLInputElement;

// ══════════════════════════════════════════
// State
// ══════════════════════════════════════════

let currentSeries: Series | null = null;
let selectedBookIds: Set<string> = new Set();
let currentProgress: QueueProgress | null = null;
let settingsLoaded = false;
let activeTab = 'browse';

async function savePopupState(): Promise<void> {
  const state = {
    url: seriesUrlInput.value.trim(),
    series: currentSeries,
    selectedBookIds: Array.from(selectedBookIds),
    activeTab,
  };
  await chrome.storage.local.set({ popupState: state });
}

async function restorePopupState(): Promise<void> {
  try {
    const result = await chrome.storage.local.get('popupState');
    if (!result.popupState) return;

    const state = result.popupState;

    if (state.url) {
      seriesUrlInput.value = state.url;
      loadBtn.disabled = false;
    }

    if (state.series) {
      currentSeries = state.series;
      renderSeriesCard(currentSeries!);
      renderChapterList(currentSeries!);

      // Restore selection
      selectedBookIds = new Set(state.selectedBookIds || []);
      const checkboxes = chapterListContainer.querySelectorAll<HTMLInputElement>('.chapter-checkbox');
      checkboxes.forEach((cb) => {
        if (selectedBookIds.has(cb.dataset.bookId!)) {
          cb.checked = true;
        }
      });
      selectAllCheckbox.checked = selectedBookIds.size === checkboxes.length && checkboxes.length > 0;

      // Update button display without triggering save again
      const count = selectedBookIds.size;
      downloadBtn.textContent = `Download Selected (${count})`;
      downloadBtn.disabled = count === 0;

      seriesCard.style.display = 'flex';
      chapterSection.style.display = 'block';
    }

    if (state.activeTab) {
      switchTab(state.activeTab);
      if (state.activeTab === 'downloads') {
        renderHistory();
      }
      if (state.activeTab === 'settings') {
        loadSettings();
      }
    }
  } catch (err) {
    console.warn('[Kagane] Failed to restore popup state:', err);
  }
}

// ══════════════════════════════════════════
// Ping service worker on load
// ══════════════════════════════════════════

async function checkServiceWorker(): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage<BgMessage, BgResponse>({ type: 'ping' });
    if (response.ok) {
      swStatusDot.className = 'status-dot status-dot--ok';
      swStatusText.textContent = 'Service worker active';
    } else {
      throw new Error(response.error);
    }
  } catch (err) {
    swStatusDot.className = 'status-dot status-dot--error';
    swStatusText.textContent = `SW error: ${err instanceof Error ? err.message : 'Unknown'}`;
  }
}

// Re-check SW every 30s
setInterval(checkServiceWorker, 30_000);

// ══════════════════════════════════════════
// Tab switching
// ══════════════════════════════════════════

function switchTab(tabId: string): void {
  activeTab = tabId;
  tabButtons.forEach((btn) => {
    const isActive = btn.dataset.tab === tabId;
    btn.classList.toggle('tab--active', isActive);
  });
  tabPanels.forEach((panel) => {
    const isActive = panel.id === `tab-${tabId}`;
    panel.classList.toggle('tab-panel--active', isActive);
  });
  savePopupState();
}

tabButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    const tabId = btn.dataset.tab;
    if (tabId) switchTab(tabId);
    if (tabId === 'downloads') {
      renderHistory();
    }
    if (tabId === 'settings') {
      loadSettings();
    }
  });
});

// ══════════════════════════════════════════
// Error / Notification display
// ══════════════════════════════════════════

function showError(message: string): void {
  errorText.textContent = message;
  errorBar.className = 'error-bar error-bar--error';
  errorBar.style.display = 'flex';
}

function showNotification(message: string, type: 'success' | 'warning' | 'error' = 'success'): void {
  errorText.textContent = message;
  errorBar.className = `error-bar error-bar--${type}`;
  errorBar.style.display = 'flex';
  // Auto-hide after 4s
  setTimeout(() => { errorBar.style.display = 'none'; }, 4000);
}

function dismissError(): void {
  errorBar.style.display = 'none';
}

errorDismiss.addEventListener('click', dismissError);

// ══════════════════════════════════════════
// Loading helpers
// ══════════════════════════════════════════

function showLoading(text: string): void {
  loadingText.textContent = text;
  loadingOverlay.style.display = 'flex';
}

function hideLoading(): void {
  loadingOverlay.style.display = 'none';
}

// ══════════════════════════════════════════
// Background → Popup messages
// ══════════════════════════════════════════

chrome.runtime.onMessage.addListener((message) => {
  const msg = message as Record<string, unknown>;
  console.log('[Kagane Popup] Received:', msg.type);

  switch (msg.type) {
    case 'download:progress': {
      const payload = msg.payload as QueueProgress;
      renderDownloadsTab(payload);
      break;
    }
    case 'download:complete': {
      const payload = msg.payload as { total: number; completed: number; failed: number };
      showNotification(
        `Download complete: ${payload.completed}/${payload.total} chapters succeeded` +
        (payload.failed > 0 ? `, ${payload.failed} failed` : ''),
        payload.failed > 0 ? 'warning' : 'success',
      );
      // Save history and re-render
      if (currentProgress) {
        saveToHistory(currentProgress);
      }
      break;
    }
  }
});

// ══════════════════════════════════════════
// Browse Tab — URL Input & Series Loading
// ══════════════════════════════════════════

// Paste button
pasteBtn.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    seriesUrlInput.value = text.trim();
    loadBtn.disabled = false;
  } catch {
    showError('Could not read clipboard. Paste manually.');
  }
});

// Enable load button when input has content
seriesUrlInput.addEventListener('input', () => {
  loadBtn.disabled = seriesUrlInput.value.trim().length === 0;
  savePopupState();
});

// Enter key triggers load
seriesUrlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !loadBtn.disabled) loadBtn.click();
});

async function loadSeries(url: string): Promise<void> {
  // Hide previous results
  seriesCard.style.display = 'none';
  chapterSection.style.display = 'none';
  browseError.style.display = 'none';
  showLoading('Fetching series data...');

  try {
    const response = await chrome.runtime.sendMessage<BgMessage, BgResponse>({
      type: 'fetch-series',
      url,
    });

    if (!response.ok) {
      throw new Error(response.error);
    }

    currentSeries = response.data as Series;
    renderSeriesCard(currentSeries);
    renderChapterList(currentSeries);
    seriesCard.style.display = 'flex';
    chapterSection.style.display = 'block';
    savePopupState();
  } catch (err) {
    browseError.textContent = err instanceof Error ? err.message : 'Failed to load series';
    browseError.style.display = 'block';
  } finally {
    hideLoading();
  }
}

loadBtn.addEventListener('click', () => {
  loadSeries(seriesUrlInput.value.trim());
});

// ══════════════════════════════════════════
// Browse Tab — Series Info Card Renderer
// ══════════════════════════════════════════

function renderSeriesCard(series: Series): void {
  // Cover — fetch via SW so CDN Referer/cookie requirements are handled
  // server-side, then display the result as a data URL.
  const coverImg = document.getElementById('series-cover') as HTMLImageElement;
  if (series.coverUrl) {
    coverImg.style.display = 'block';
    coverImg.removeAttribute('src');
    chrome.runtime
      .sendMessage<BgMessage, BgResponse>({
        type: 'fetch-cover',
        url: series.coverUrl,
      })
      .then((resp) => {
        if (resp.ok && resp.data && typeof resp.data === 'object' && 'dataUrl' in resp.data) {
          coverImg.src = (resp.data as { dataUrl: string }).dataUrl;
        } else {
          coverImg.style.display = 'none';
        }
      })
      .catch(() => {
        coverImg.style.display = 'none';
      });
  } else {
    coverImg.style.display = 'none';
  }

  // Title
  document.getElementById('series-title')!.textContent = series.title;

  // Badges
  const formatBadge = document.getElementById('series-format')!;
  formatBadge.textContent = series.format || 'Manga';
  formatBadge.className = `badge badge--${(series.format || 'manga').toLowerCase()}`;

  const statusBadge = document.getElementById('series-status')!;
  const status = series.publicationStatus || series.uploadStatus || 'Unknown';
  statusBadge.textContent = status;
  statusBadge.className = `badge badge--status`;

  // Genres
  const genresContainer = document.getElementById('series-genres')!;
  genresContainer.innerHTML = '';
  for (const genre of (series.genres || []).slice(0, 8)) {
    const tag = document.createElement('span');
    tag.className = 'genre-tag';
    tag.textContent = genre.genreName;
    genresContainer.appendChild(tag);
  }

  // Description (truncated to 3 lines)
  const desc = document.getElementById('series-description')!;
  desc.textContent = series.description || 'No description available.';

  // Stats
  const chaptersEl = document.getElementById('series-chapters')!;
  chaptersEl.textContent = `📖 ${series.currentBooks || series.totalBooks || series.seriesBooks?.length || 0} chapters`;

  const viewsEl = document.getElementById('series-views')!;
  viewsEl.textContent = `👁 ${formatCount(series.totalViews || 0)} views`;
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

// ══════════════════════════════════════════
// Browse Tab — Chapter List & Download Initiation
// ══════════════════════════════════════════

function renderChapterList(series: Series): void {
  const books = series.seriesBooks || [];
  chapterListContainer.innerHTML = '';
  selectedBookIds.clear();
  selectAllCheckbox.checked = false;

  if (books.length === 0) {
    chapterListContainer.innerHTML = '<p class="placeholder-text">No chapters found.</p>';
    chapterCount.textContent = '0 chapters';
    updateDownloadBtn();
    return;
  }

  // Sort by sortNo ascending
  const sorted = [...books].sort((a, b) => a.sortNo - b.sortNo);

  chapterCount.textContent = `${sorted.length} chapters`;

  for (const book of sorted) {
    const row = document.createElement('label');
    row.className = 'chapter-row';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'chapter-checkbox';
    cb.dataset.bookId = book.bookId;
    cb.addEventListener('change', () => {
      if (cb.checked) {
        selectedBookIds.add(book.bookId);
      } else {
        selectedBookIds.delete(book.bookId);
        selectAllCheckbox.checked = false;
      }
      updateDownloadBtn();
    });

    const numberSpan = document.createElement('span');
    numberSpan.className = 'chapter-number';
    numberSpan.textContent = `Ch. ${book.chapterNo}`;

    const titleSpan = document.createElement('span');
    titleSpan.className = 'chapter-title';
    titleSpan.textContent = book.title || '';

    const metaSpan = document.createElement('span');
    metaSpan.className = 'chapter-meta';
    metaSpan.textContent = `${book.pageCount}p`;

    row.appendChild(cb);
    row.appendChild(numberSpan);
    row.appendChild(titleSpan);
    row.appendChild(metaSpan);
    chapterListContainer.appendChild(row);
  }
}

// Select All / Deselect All
selectAllCheckbox.addEventListener('change', () => {
  const checkboxes = chapterListContainer.querySelectorAll<HTMLInputElement>('.chapter-checkbox');
  for (const cb of checkboxes) {
    cb.checked = selectAllCheckbox.checked;
    if (selectAllCheckbox.checked) {
      selectedBookIds.add(cb.dataset.bookId!);
    } else {
      selectedBookIds.delete(cb.dataset.bookId!);
    }
  }
  updateDownloadBtn();
});

// Range selection
rangeSelectBtn.addEventListener('click', () => {
  const rangeText = rangeInput.value.trim();
  if (!rangeText) return;

  const checkboxes = chapterListContainer.querySelectorAll<HTMLInputElement>('.chapter-checkbox');
  const rows = chapterListContainer.querySelectorAll('.chapter-row');
  const range = parseRange(rangeText, rows.length);

  selectedBookIds.clear();
  for (let i = 0; i < checkboxes.length; i++) {
    const shouldSelect = range.includes(i + 1);
    checkboxes[i].checked = shouldSelect;
    if (shouldSelect) {
      selectedBookIds.add(checkboxes[i].dataset.bookId!);
    } else {
      selectedBookIds.delete(checkboxes[i].dataset.bookId!);
    }
  }
  selectAllCheckbox.checked = selectedBookIds.size === checkboxes.length;
  updateDownloadBtn();
});

function parseRange(input: string, max: number): number[] {
  const result: number[] = [];
  const parts = input.split(',');
  for (const part of parts) {
    const trimmed = part.trim();
    const match = trimmed.match(/^(\d+)(?:-(\d+))?$/);
    if (match) {
      const start = parseInt(match[1], 10) || 1;
      const end = match[2] ? parseInt(match[2], 10) : start;
      for (let i = start; i <= Math.min(end, max); i++) {
        result.push(i);
      }
    }
  }
  return [...new Set(result)].sort((a, b) => a - b);
}

function updateDownloadBtn(): void {
  const count = selectedBookIds.size;
  downloadBtn.textContent = `Download Selected (${count})`;
  downloadBtn.disabled = count === 0;
  savePopupState();
}

// Download button
downloadBtn.addEventListener('click', async () => {
  if (!currentSeries || selectedBookIds.size === 0) return;

  const format = formatSelect.value as 'images' | 'cbz' | 'pdf';
  const bookIds = Array.from(selectedBookIds);

  showLoading('Starting download...');

  try {
    const response = await (chrome.runtime.sendMessage({
      type: 'start-download',
      seriesId: currentSeries.seriesId,
      bookIds,
      format,
    }) as Promise<BgResponse>);

    if (!response.ok) {
      throw new Error(response.error);
    }

    showNotification(`Download started: ${bookIds.length} chapters queued`, 'success');
    // Switch to Downloads tab
    switchTab('downloads');
  } catch (err) {
    showError(err instanceof Error ? err.message : 'Failed to start download');
  } finally {
    hideLoading();
  }
});

// ══════════════════════════════════════════
// Downloads Tab — Progress UI & History
// ══════════════════════════════════════════

interface DownloadHistoryItem {
  bookId: string;
  seriesTitle: string;
  chapterNo: string;
  title: string;
  status: 'done' | 'failed';
  error?: string;
  timestamp: number;
}

function renderDownloadsTab(progress: QueueProgress): void {
  currentProgress = progress;
  const container = document.getElementById('download-list')!;

  if (progress.total === 0) {
    container.innerHTML = '<p class="placeholder-text">No active downloads.</p>';
    return;
  }

  container.innerHTML = '';

  for (const chapter of progress.chapters) {
    const item = document.createElement('div');
    item.className = `download-item download-item--${chapter.status}`;

    // Header row
    const header = document.createElement('div');
    header.className = 'download-item__header';
    header.innerHTML = `
      <span class="download-item__chapter">Ch. ${chapter.chapterNo}</span>
      <span class="download-item__title">${chapter.title || ''}</span>
      <span class="download-item__status">${getStatusLabel(chapter.status)}</span>
    `;

    // Progress bar (only for downloading/extracting/converting)
    const barContainer = document.createElement('div');
    if (chapter.status === 'downloading' || chapter.status === 'extracting_urls' || chapter.status === 'converting') {
      barContainer.className = 'progress-bar';
      let label = `${chapter.progress}%`;
      // @ts-ignore
      if (chapter.status === 'downloading' && chapter.processedPages !== undefined && chapter.totalPages !== undefined) {
        // @ts-ignore
        label = `${chapter.progress}% (${chapter.processedPages}/${chapter.totalPages} pages)`;
      } else if (chapter.status === 'converting') {
        label = 'Converting...';
      } else if (chapter.status === 'extracting_urls') {
        label = 'Extracting image URLs...';
      }
      barContainer.innerHTML = `
        <div class="progress-bar__fill" style="width:${chapter.progress}%"></div>
        <span class="progress-bar__label">${label}</span>
      `;
    }

    // Error message (for failed)
    if (chapter.status === 'failed' && chapter.error) {
      const errorMsg = document.createElement('div');
      errorMsg.className = 'download-item__error';
      errorMsg.textContent = chapter.error;
      item.appendChild(errorMsg);
    }

    // Retry button (for failed)
    if (chapter.status === 'failed') {
      const retryBtn = document.createElement('button');
      retryBtn.className = 'btn btn--sm btn--primary';
      retryBtn.textContent = 'Retry';
      retryBtn.dataset.bookId = chapter.bookId;
      retryBtn.addEventListener('click', () => retryChapter(chapter.bookId));
      item.appendChild(retryBtn);
    }

    item.appendChild(header);
    if (barContainer.innerHTML) item.appendChild(barContainer);
    container.appendChild(item);
  }
}

function getStatusLabel(status: ChapterStatus): string {
  const labels: Record<ChapterStatus, string> = {
    queued: '⏳ Queued',
    extracting_urls: '🔍 Extracting',
    downloading: '⬇️ Downloading',
    converting: '📦 Converting',
    done: '✅ Done',
    failed: '❌ Failed',
  };
  return labels[status] || status;
}

async function retryChapter(bookId: string): Promise<void> {
  if (!currentProgress) return;
  const chapter = currentProgress.chapters.find(c => c.bookId === bookId);
  if (!chapter || !currentSeries) return;

  const format = formatSelect.value as 'images' | 'cbz' | 'pdf';
  showLoading('Retrying chapter...');

  try {
    const response = await (chrome.runtime.sendMessage({
      type: 'start-download',
      seriesId: currentSeries.seriesId,
      bookIds: [bookId],
      format,
    }) as Promise<BgResponse>);
    if (!response.ok) throw new Error(response.error);
    showNotification('Retrying chapter...', 'success');
  } catch (err) {
    showError(err instanceof Error ? err.message : 'Failed to retry');
  } finally {
    hideLoading();
  }
}

// ─── History persistence ───

async function saveToHistory(progress: QueueProgress): Promise<void> {
  const doneOrFailed = progress.chapters.filter(
    (c) => c.status === 'done' || c.status === 'failed',
  );

  const items: DownloadHistoryItem[] = doneOrFailed.map((c) => ({
    bookId: c.bookId,
    seriesTitle: currentSeries?.title || 'Unknown',
    chapterNo: c.chapterNo,
    title: c.title,
    status: c.status as 'done' | 'failed',
    error: c.error,
    timestamp: Date.now(),
  }));

  // Merge with existing history, keep last 50
  const result = await chrome.storage.local.get('downloadHistory');
  const existing: DownloadHistoryItem[] = result.downloadHistory || [];
  const merged = [...items, ...existing].slice(0, 50);
  await chrome.storage.local.set({ downloadHistory: merged });

  renderHistory();
}

async function renderHistory(): Promise<void> {
  const result = await chrome.storage.local.get('downloadHistory');
  const items: DownloadHistoryItem[] = result.downloadHistory || [];
  const container = document.getElementById('history-list')!;

  if (items.length === 0) {
    container.innerHTML = '<p class="placeholder-text">No download history yet.</p>';
    return;
  }

  container.innerHTML = items
    .slice(0, 20) // show last 20
    .map(
      (item) => `
        <div class="history-item history-item--${item.status}">
          <span class="history-item__chapter">Ch. ${item.chapterNo}</span>
          <span class="history-item__status">${item.status === 'done' ? '✅' : '❌'}</span>
          <span class="history-item__time">${new Date(item.timestamp).toLocaleTimeString()}</span>
        </div>
      `,
    )
    .join('');
}

// ══════════════════════════════════════════
// Settings Tab — Persisted Settings
// ══════════════════════════════════════════

async function loadSettings(): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage<BgMessage, BgResponse>({
      type: 'get-settings',
    });

    if (!response.ok || !response.data) return;

    const settings = response.data as Record<string, unknown>;

    // Format radio
    const format = String(settings.format || 'images');
    for (const radio of formatRadios) {
      radio.checked = radio.value === format;
    }

    // Concurrency inputs
    if (settings.maxConcurrentChapters != null) {
      maxChaptersInput.value = String(settings.maxConcurrentChapters);
    }
    if (settings.maxConcurrentImages != null) {
      maxImagesInput.value = String(settings.maxConcurrentImages);
    }

    settingsLoaded = true;
  } catch (err) {
    console.warn('[Kagane] Could not load settings:', err);
  }
}

async function saveSettings(): Promise<void> {
  if (!settingsLoaded) return;

  const format = Array.from(formatRadios).find((r) => r.checked)?.value || 'images';
  const maxConcurrentChapters = parseInt(maxChaptersInput.value, 10) || 3;
  const maxConcurrentImages = parseInt(maxImagesInput.value, 10) || 5;

  await chrome.runtime.sendMessage<BgMessage, BgResponse>({
    type: 'update-settings',
    settings: {
      format,
      maxConcurrentChapters: Math.max(1, Math.min(5, maxConcurrentChapters)),
      maxConcurrentImages: Math.max(1, Math.min(10, maxConcurrentImages)),
    },
  });
}

// Auto-save on change
formatRadios.forEach((radio) => radio.addEventListener('change', saveSettings));
maxChaptersInput.addEventListener('change', saveSettings);
maxImagesInput.addEventListener('change', saveSettings);

// ══════════════════════════════════════════
// Auto-detect: use active tab URL instead of prompting
// ══════════════════════════════════════════

async function autoDetectSeries(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (tab?.url) {
      // Only auto-detect on Kagane series pages
      const seriesMatch = tab.url.match(/https:\/\/kagane\.(?:moe|to|net|cx)\/series\/([^/]+)/);
      if (seriesMatch) {
        // Pre-fill the input and auto-load
        seriesUrlInput.value = tab.url;
        await loadSeries(tab.url);
        return;
      }
    }
  } catch (err) {
    // Silently fail — user can still paste a URL manually
    console.warn('[Kagane] Auto-detect failed:', err);
  }
  await restorePopupState();
}

// ══════════════════════════════════════════
// Init
// ══════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  checkServiceWorker();
  autoDetectSeries();

  // Query active downloads on popup open
  chrome.runtime.sendMessage<BgMessage, BgResponse>({ type: 'get-progress' }, (response) => {
    if (response && response.ok && response.data) {
      renderDownloadsTab(response.data as QueueProgress);
    }
  });

  // Clear history button handler
  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener('click', async () => {
      await chrome.storage.local.remove('downloadHistory');
      renderHistory();
    });
  }
});
