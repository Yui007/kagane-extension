// Kagane Downloader — API Bridge
// Runs on kagane.moe pages and performs API requests from the page origin,
// so Cloudflare's partitioned clearance cookies are included.
//
// MUST be plain JavaScript (no import/export) per MV3 content script rules.

(function () {
  'use strict';

  chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    if (!message) return false;

    if (message.type === 'kagane:api-ping') {
      sendResponse({ ok: true });
      return false;
    }

    if (message.type !== 'kagane:api') return false;

    var payload = message.payload || {};
    if (!payload.url) {
      sendResponse({ ok: false, status: 0, error: 'Missing URL' });
      return false;
    }

    var controller = new AbortController();
    var timer = setTimeout(function () {
      controller.abort();
    }, 25000);

    fetch(payload.url, {
      method: payload.method || 'GET',
      headers: payload.headers || {},
      body: payload.body,
      credentials: 'same-origin',
      signal: controller.signal,
    })
      .then(function (response) {
        if (payload.binary) {
          return response.blob().then(function (blob) {
            return blob.arrayBuffer().then(function (buffer) {
              var bytes = new Uint8Array(buffer);
              var binary = '';
              var chunkSize = 8192;
              for (var i = 0; i < bytes.length; i += chunkSize) {
                binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
              }
              sendResponse({
                ok: true,
                status: response.status,
                statusText: response.statusText,
                contentType: blob.type || 'image/jpeg',
                body: btoa(binary),
              });
            });
          });
        }

        return response.text().then(function (text) {
          sendResponse({
            ok: true,
            status: response.status,
            statusText: response.statusText,
            contentType: response.headers.get('content-type') || '',
            body: text,
          });
        });
      })
      .catch(function (err) {
        sendResponse({ ok: false, status: 0, error: String(err) });
      })
      .finally(function () {
        clearTimeout(timer);
      });

    return true; // Async response
  });
})();
