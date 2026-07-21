// Determine API base URL when running the static dev server (e.g. Live Server on :5500).
const API_BASE = (() => {
  try {
    const { hostname, port, protocol } = window.location;
    const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
    if (localHosts.has(hostname) && port && port !== '3000') {
      return `${protocol}//localhost:3000`;
    }
  } catch (e) {
    // ignore
  }
  return '';
})();
console.log('[client api] API_BASE is', API_BASE || 'relative /api');

async function fetchApi(url, options = {}) {
  const fetchOptions = {
    cache: 'no-store',
    ...options,
  };

  return fetch(`${API_BASE}${url}`, fetchOptions);
}

async function analyzeVideo(url) {
  const response = await fetchApi('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const data = await parseResponse(response);
  if (!response.ok) throw new Error(data.error || response.statusText || 'Unable to analyze the link.');
  return data;
}

async function downloadVideo(payload) {
  const response = await fetchApi('/api/download/video', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await parseResponse(response);
  if (!response.ok) throw new Error(data.error || response.statusText || 'Unable to start video download.');
  return data;
}

async function downloadAudio(payload) {
  const response = await fetchApi('/api/download/audio', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await parseResponse(response);
  if (!response.ok) throw new Error(data.error || response.statusText || 'Unable to start audio download.');
  return data;
}

async function getStatus() {
  const response = await fetchApi('/api/status');
  return parseResponse(response);
}

async function getDownloadStatus(id) {
  const response = await fetchApi(`/api/download/${encodeURIComponent(id)}/status`);
  const data = await parseResponse(response);
  if (!response.ok) throw new Error(data.error || response.statusText || 'Unable to check download status.');
  return data;
}

async function cancelDownload(id) {
  const response = await fetchApi(`/api/download/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
  });
  const data = await parseResponse(response);
  if (!response.ok) throw new Error(data.error || response.statusText || 'Unable to cancel download.');
  return data;
}

async function createPreviewClip(type, payload) {
  const response = await fetchApi(`/api/preview/${encodeURIComponent(type)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await parseResponse(response);
  if (!response.ok) throw new Error(data.error || response.statusText || 'Unable to create preview.');
  return data;
}

// Safely parse a response as JSON, falling back to text when empty or malformed.
async function parseResponse(response) {
  const text = await response.text();
  const meta = { _status: response.status, _statusText: response.statusText };
  if (!text) return meta;
  try {
    const parsed = JSON.parse(text);
    return Object.assign({}, meta, parsed);
  } catch (err) {
    return Object.assign({}, meta, { _raw: text });
  }
}
