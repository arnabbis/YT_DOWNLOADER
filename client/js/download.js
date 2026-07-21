let currentAnalysis = null;
let analysisProgressTimer = null;
let analysisProgressValue = 0;

const activeDownloads = new Map();
const downloadWatchers = new Map();
const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);
const cancellableDownloadStatuses = new Set(['queued', 'preparing', 'downloading', 'processing']);

const analysisStages = [
  { at: 0, label: 'Checking link...' },
  { at: 22, label: 'Contacting YouTube...' },
  { at: 48, label: 'Reading video metadata...' },
  { at: 72, label: 'Finding available formats...' },
  { at: 92, label: 'Preparing results...' },
];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  })[char]);
}

function populateQualities(formats) {
  const qualitySelect = document.getElementById('qualitySelect');
  if (!qualitySelect) return;
  const qualities = [...new Set((formats || [])
    .filter((f) => f.vcodec !== 'none' && Number(f.height) >= 144)
    .map((f) => `${f.height}p`))]
    .sort((a, b) => Number(b.slice(0, -1)) - Number(a.slice(0, -1)));
  qualitySelect.innerHTML = qualities.length
    ? qualities.map((quality) => `<option value="${quality}">${quality}</option>`).join('')
    : '<option value="1080p">Best available</option>';
}

function getAnalysisStage(percent) {
  return analysisStages.reduce((current, stage) => (percent >= stage.at ? stage : current), analysisStages[0]).label;
}

function setAnalysisControls(disabled) {
  const analyzeBtn = document.getElementById('analyzeBtn');
  const urlInput = document.getElementById('urlInput');
  if (analyzeBtn) {
    analyzeBtn.disabled = disabled;
    analyzeBtn.textContent = disabled ? 'Analyzing...' : 'Analyze';
  }
  if (urlInput) urlInput.disabled = disabled;
}

function setAnalysisProgress(percent, label) {
  const fill = document.getElementById('analysisProgressFill');
  const status = document.getElementById('analysisStatus');
  const percentLabel = document.getElementById('analysisPercent');
  const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
  if (fill) fill.style.width = `${safePercent}%`;
  if (status) status.textContent = label || getAnalysisStage(safePercent);
  if (percentLabel) percentLabel.textContent = `${safePercent}%`;
}

function startAnalysisProgress() {
  window.clearInterval(analysisProgressTimer);
  analysisProgressValue = 8;
  const panel = document.getElementById('analysisProgress');
  if (panel) {
    panel.hidden = false;
    panel.classList.remove('is-error');
    panel.classList.add('fade-in');
  }
  setAnalysisControls(true);
  setAnalysisProgress(analysisProgressValue);

  analysisProgressTimer = window.setInterval(() => {
    const distance = 94 - analysisProgressValue;
    const step = distance > 28 ? 5 : distance > 12 ? 2.5 : 0.9;
    analysisProgressValue = Math.min(94, analysisProgressValue + step);
    setAnalysisProgress(analysisProgressValue);
  }, 420);
}

function finishAnalysisProgress(success, message) {
  window.clearInterval(analysisProgressTimer);
  const panel = document.getElementById('analysisProgress');
  if (success) {
    setAnalysisProgress(100, 'Analysis complete.');
    window.setTimeout(() => {
      if (panel) panel.hidden = true;
    }, 900);
  } else {
    if (panel) panel.classList.add('is-error');
    setAnalysisProgress(Math.max(analysisProgressValue, 12), message || 'Analysis failed.');
  }
  setAnalysisControls(false);
}

function renderAnalysisResult(data) {
  const panel = document.getElementById('resultsPanel');
  document.getElementById('resultTitle').textContent = data.title;
  document.getElementById('resultChannel').textContent = data.channel;
  document.getElementById('resultDuration').textContent = data.duration;
  document.getElementById('resultViews').textContent = toReadableNumber(data.views);
  document.getElementById('resultUploadDate').textContent = data.uploadDate;
  document.getElementById('resultDescription').textContent = data.description || 'No description available.';
  document.getElementById('resultThumbnail').src = data.thumbnail || 'assets/images/placeholder.png';
  populateQualities(data.formats || []);
  applySettings();
  resetTrimControls();
  hidePreview();
  panel.hidden = false;
  panel.classList.add('fade-in');
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function parseTimeToSeconds(value) {
  if (!value) return 0;
  const parts = String(value).trim().split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) return null;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) {
    if (parts[1] >= 60) return null;
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3) {
    if (parts[1] >= 60 || parts[2] >= 60) return null;
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return null;
}

function formatTimecode(totalSeconds) {
  const safeTotal = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = String(Math.floor(safeTotal / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((safeTotal % 3600) / 60)).padStart(2, '0');
  const seconds = String(safeTotal % 60).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function normalizeTimeInput(input) {
  const parsed = parseTimeToSeconds(input.value);
  if (parsed === null) return false;
  input.value = formatTimecode(parsed);
  return true;
}

function getAnalysisDurationSeconds() {
  return parseTimeToSeconds(currentAnalysis?.duration) || 0;
}

function getDefaultPreviewEndSeconds() {
  const duration = getAnalysisDurationSeconds();
  return duration ? Math.min(duration, 30) : 30;
}

function resetTrimControls() {
  [
    ['trimVideo', 'videoStart', 'videoEnd'],
    ['trimAudio', 'audioStart', 'audioEnd'],
  ].forEach(([toggleId, startId, endId]) => {
    const toggle = document.getElementById(toggleId);
    const startInput = document.getElementById(startId);
    const endInput = document.getElementById(endId);
    if (!toggle || !startInput || !endInput) return;
    toggle.checked = false;
    startInput.value = '00:00:00';
    endInput.value = formatTimecode(getDefaultPreviewEndSeconds());
    startInput.disabled = true;
    endInput.disabled = true;
  });
}

function getTrimControls(type) {
  const isVideo = type === 'video';
  return {
    enabled: document.getElementById(isVideo ? 'trimVideo' : 'trimAudio').checked,
    startInput: document.getElementById(isVideo ? 'videoStart' : 'audioStart'),
    endInput: document.getElementById(isVideo ? 'videoEnd' : 'audioEnd'),
  };
}

function getTrimRange(type, requireEnd = true) {
  const { enabled, startInput, endInput } = getTrimControls(type);
  if (!enabled) return { start: 0, end: null, label: 'Full source preview' };

  if (!normalizeTimeInput(startInput) || (endInput.value && !normalizeTimeInput(endInput))) {
    setToast('Use time like 00:01:30, 01:30, or 90.');
    return null;
  }

  const start = parseTimeToSeconds(startInput.value) || 0;
  const end = parseTimeToSeconds(endInput.value);
  const duration = getAnalysisDurationSeconds();

  if (requireEnd && !end) {
    setToast('Enter an end time for the crop.');
    return null;
  }
  if (end && end <= start) {
    setToast('End time must be later than start time.');
    return null;
  }
  if (duration && start >= duration) {
    setToast('Start time is past the end of the video.');
    return null;
  }
  if (duration && end && end > duration) {
    endInput.value = formatTimecode(duration);
    return { start, end: duration, label: `${formatTimecode(start)} to ${formatTimecode(duration)}` };
  }

  return {
    start,
    end: end || null,
    label: end ? `${formatTimecode(start)} to ${formatTimecode(end)}` : `Starting at ${formatTimecode(start)}`,
  };
}

function getPreviewRange(type) {
  const { enabled } = getTrimControls(type);
  if (enabled) return getTrimRange(type, true);

  const end = getDefaultPreviewEndSeconds();
  return {
    start: 0,
    end,
    label: `${formatTimecode(0)} to ${formatTimecode(end)}`,
  };
}

function hidePreview() {
  const panel = document.getElementById('sourcePreviewPanel');
  const video = document.getElementById('sourcePreviewVideo');
  const audio = document.getElementById('sourcePreviewAudio');
  const loading = document.getElementById('previewLoading');
  const frame = document.getElementById('previewFrameWrap');
  if (panel) panel.hidden = true;
  if (loading) loading.hidden = true;
  if (frame) frame.classList.remove('is-audio');
  [video, audio].forEach((player) => {
    if (!player) return;
    player.pause();
    player.removeAttribute('src');
    player.load();
    player.hidden = true;
  });
}

function setPreviewBusy(type, busy) {
  const targetId = type === 'video' ? 'previewVideoBtn' : 'previewAudioBtn';
  ['previewVideoBtn', 'previewAudioBtn'].forEach((id) => {
    const button = document.getElementById(id);
    if (!button) return;
    button.disabled = busy;
    button.textContent = busy && id === targetId ? 'Building preview...' : 'Preview';
  });
}

function waitForPreviewMedia(player) {
  if (player.readyState >= 1) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('Preview loaded slowly. Try the preview again.'));
    }, 15000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      player.removeEventListener('loadedmetadata', handleReady);
      player.removeEventListener('error', handleError);
    };
    const handleReady = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error('The preview file could not be played by this browser.'));
    };
    player.addEventListener('loadedmetadata', handleReady);
    player.addEventListener('error', handleError);
  });
}

async function showPreview(type) {
  if (!currentAnalysis) return setToast('Analyze a video first.');
  const range = getPreviewRange(type);
  if (!range) return;

  const panel = document.getElementById('sourcePreviewPanel');
  const video = document.getElementById('sourcePreviewVideo');
  const audio = document.getElementById('sourcePreviewAudio');
  const loading = document.getElementById('previewLoading');
  const title = document.getElementById('previewTitle');
  const rangeLabel = document.getElementById('previewRangeLabel');
  const frame = document.getElementById('previewFrameWrap');
  if (!panel || !video || !audio) return;

  if (title) title.textContent = `${type === 'audio' ? 'Audio' : 'Video'} preview`;
  if (rangeLabel) rangeLabel.textContent = range.label;
  panel.hidden = false;
  if (loading) {
    loading.hidden = false;
    loading.textContent = `Building ${type} preview...`;
  }
  if (frame) frame.classList.toggle('is-audio', type === 'audio');
  video.hidden = true;
  audio.hidden = true;
  video.pause();
  audio.pause();
  video.removeAttribute('src');
  audio.removeAttribute('src');
  panel.classList.add('fade-in');
  panel.scrollIntoView({ behavior: 'smooth', block: 'center' });

  setPreviewBusy(type, true);
  try {
    const preview = await createPreviewClip(type, {
      url: document.getElementById('urlInput').value.trim(),
      quality: document.getElementById('qualitySelect')?.value || '480p',
      startTime: formatTimecode(range.start),
      endTime: formatTimecode(range.end),
    });
    const player = type === 'audio' ? audio : video;
    const inactivePlayer = type === 'audio' ? video : audio;
    inactivePlayer.hidden = true;
    player.src = `${preview.previewUrl}?t=${Date.now()}`;
    player.hidden = false;
    player.load();
    await waitForPreviewMedia(player);
    if (loading) loading.hidden = true;
    await player.play().catch(() => {});
    setToast('Preview ready.');
  } catch (error) {
    if (loading) loading.hidden = true;
    video.hidden = true;
    audio.hidden = true;
    setToast(error.message);
  } finally {
    setPreviewBusy(type, false);
  }
}

function formatQualityLabel(value) {
  return value === 'source' ? 'Original audio' : value;
}

function getStatusLabel(status) {
  const labels = {
    queued: 'Queued',
    preparing: 'Preparing',
    downloading: 'Downloading',
    processing: 'Processing',
    cancelling: 'Cancelling',
    cancelled: 'Cancelled',
    completed: 'Completed',
    failed: 'Failed',
  };
  return labels[status] || status || 'Queued';
}

function clearDownloadWatcher(id) {
  const watcher = downloadWatchers.get(id);
  if (watcher) window.clearInterval(watcher);
  downloadWatchers.delete(id);
}

function resolveApiLink(url) {
  if (!url) return url;
  if (typeof API_BASE === 'string' && API_BASE && url.startsWith('/api')) {
    return `${API_BASE}${url}`;
  }
  return url;
}

function updateProgressList(entry) {
  const progressList = document.getElementById('progressList');
  if (!progressList) return;

  const historySection = progressList.querySelector('[data-history-section]');
  let item = progressList.querySelector(`[data-download-id="${entry.id}"]`);
  if (!item) {
    item = document.createElement('div');
    item.className = 'progress-item fade-in';
    item.dataset.downloadId = entry.id;
    progressList.insertBefore(item, historySection || progressList.firstChild);
  }

  const progress = Math.max(0, Math.min(100, Number(entry.progress || 0)));
  const isCancellable = cancellableDownloadStatuses.has(entry.status);
  const downloadUrl = resolveApiLink(entry.downloadUrl);
  const showSave = Boolean(downloadUrl);
  const statusClass = entry.status === 'failed'
    ? 'error-text'
    : entry.status === 'cancelled'
      ? 'cancelled-text'
      : '';

  item.innerHTML = `
    <div class="progress-item-head">
      <div>
        <strong>${escapeHtml(entry.title || 'Download')}</strong>
        <div class="details">${escapeHtml(entry.type || 'media')} - ${escapeHtml(formatQualityLabel(entry.quality || 'best'))}</div>
      </div>
      <div class="progress-actions">
        ${isCancellable ? `<button class="ghost-btn cancel-btn" type="button" data-cancel-id="${escapeHtml(entry.id)}">Cancel</button>` : ''}
        ${showSave ? `<a class="ghost-btn download-link" href="${escapeHtml(downloadUrl)}" download="${escapeHtml(entry.title || 'download')}">Save ${escapeHtml(entry.type)}</a>` : ''}
      </div>
    </div>
    <div class="details ${statusClass}">Status: ${getStatusLabel(entry.status)}</div>
    <div class="progress-bar"><span style="width:${progress}%"></span></div>
    ${entry.error ? `<div class="details ${statusClass || 'error-text'}">${escapeHtml(entry.error)}</div>` : ''}
  `;

  item.querySelector('[data-cancel-id]')?.addEventListener('click', () => {
    cancelActiveDownload(entry.id);
  });
}

function watchDownload(entry) {
  activeDownloads.set(entry.id, entry);
  clearDownloadWatcher(entry.id);

  const interval = window.setInterval(async () => {
    try {
      const update = await getDownloadStatus(entry.id);
      const next = { ...activeDownloads.get(entry.id), ...update };
      activeDownloads.set(entry.id, next);
      updateProgressList(next);
      if (terminalStatuses.has(update.status)) {
        clearDownloadWatcher(entry.id);
        setToast(update.status === 'completed'
          ? 'Your file is ready. Click Save to download it.'
          : getStatusLabel(update.status));
      }
    } catch (error) {
      clearDownloadWatcher(entry.id);
      setToast(error.message);
    }
  }, 1000);

  downloadWatchers.set(entry.id, interval);
}

async function cancelActiveDownload(id) {
  const current = activeDownloads.get(id) || { id, title: 'Download', progress: 0 };
  updateProgressList({ ...current, status: 'cancelling' });

  try {
    const result = await cancelDownload(id);
    clearDownloadWatcher(id);
    const next = {
      ...current,
      ...result,
      id,
      status: result.status || 'cancelled',
      error: result.message || 'Download cancelled.',
    };
    activeDownloads.set(id, next);
    updateProgressList(next);
    setToast('Download cancelled.');
  } catch (error) {
    updateProgressList(current);
    setToast(error.message);
  }
}

async function handleAnalyzeSubmit(event) {
  event.preventDefault();
  const url = document.getElementById('urlInput').value.trim();
  if (!isValidUrl(url)) return setToast('Please enter a valid YouTube link.');

  document.getElementById('resultsPanel').hidden = true;
  startAnalysisProgress();

  try {
    currentAnalysis = await analyzeVideo(url);
    renderAnalysisResult(currentAnalysis);
    finishAnalysisProgress(true);
    setToast('Analysis complete. Choose a format to continue.');
    addHistoryItem({ title: currentAnalysis.title, type: 'analyze', quality: 'metadata', createdAt: new Date().toISOString() });
  } catch (error) {
    finishAnalysisProgress(false, error.message);
    setToast(error.message);
  }
}

async function startDownload(type) {
  if (!currentAnalysis) return setToast('Analyze a video first.');
  const isVideo = type === 'video';
  const trimEnabled = document.getElementById(isVideo ? 'trimVideo' : 'trimAudio').checked;
  const trimRange = getTrimRange(type, true);
  if (trimEnabled && !trimRange) return;
  const payload = {
    url: document.getElementById('urlInput').value.trim(),
    title: currentAnalysis.title,
    [isVideo ? 'quality' : 'bitrate']: document.getElementById(isVideo ? 'qualitySelect' : 'bitrateSelect').value,
    startTime: trimEnabled ? formatTimecode(trimRange.start) : '',
    endTime: trimEnabled ? formatTimecode(trimRange.end) : '',
  };
  try {
    const result = await (isVideo ? downloadVideo(payload) : downloadAudio(payload));
    const entry = {
      id: result.downloadId,
      title: currentAnalysis.title,
      type,
      quality: payload[isVideo ? 'quality' : 'bitrate'],
      progress: 0,
      status: 'queued',
    };
    addHistoryItem({ title: currentAnalysis.title, type, quality: entry.quality, createdAt: new Date().toISOString() });
    activeDownloads.set(entry.id, entry);
    updateProgressList(entry);
    watchDownload(entry);
    setToast(`${isVideo ? 'Video' : 'Audio'} download queued.`);
  } catch (error) {
    setToast(error.message);
  }
}

function bindDownloadEvents() {
  document.getElementById('downloadVideoBtn').addEventListener('click', () => startDownload('video'));
  document.getElementById('downloadAudioBtn').addEventListener('click', () => startDownload('audio'));
  document.getElementById('previewVideoBtn').addEventListener('click', () => showPreview('video'));
  document.getElementById('previewAudioBtn').addEventListener('click', () => showPreview('audio'));
  // Bind analyze button click explicitly. The UI uses a non-form container
  // to avoid browser form submissions that use GET.
  const analyzeBtn = document.getElementById('analyzeBtn');
  if (analyzeBtn) analyzeBtn.addEventListener('click', (event) => handleAnalyzeSubmit(event));
  [['trimVideo', 'videoStart', 'videoEnd'], ['trimAudio', 'audioStart', 'audioEnd']].forEach(([toggleId, startId, endId]) => {
    document.getElementById(toggleId).addEventListener('change', (event) => {
      const startInput = document.getElementById(startId);
      const endInput = document.getElementById(endId);
      startInput.disabled = !event.target.checked;
      endInput.disabled = !event.target.checked;
      if (!event.target.checked) {
        startInput.value = '00:00:00';
        endInput.value = formatTimecode(getDefaultPreviewEndSeconds());
      } else if (!endInput.value) {
        endInput.value = formatTimecode(getDefaultPreviewEndSeconds());
      }
    });
    [startId, endId].forEach((inputId) => {
      document.getElementById(inputId).addEventListener('blur', (event) => {
        if (event.target.value && !normalizeTimeInput(event.target)) {
          setToast('Use time like 00:01:30, 01:30, or 90.');
        }
      });
    });
  });
  document.getElementById('clearHistoryBtn').addEventListener('click', () => {
    clearHistory();
    renderHistory();
    setToast('History cleared.');
  });
  document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((item) => item.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('videoTab').hidden = tab.dataset.tab !== 'video';
    document.getElementById('audioTab').hidden = tab.dataset.tab !== 'audio';
  }));
  document.getElementById('pasteBtn').addEventListener('click', async () => {
    try {
      document.getElementById('urlInput').value = await navigator.clipboard.readText();
      setToast('URL pasted from clipboard.');
    } catch {
      setToast('Clipboard access is unavailable.');
    }
  });
  document.getElementById('copyTitleBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(currentAnalysis?.title || '');
      setToast('Title copied.');
    } catch {
      setToast('Clipboard access is unavailable.');
    }
  });
  const qualitySelect = document.getElementById('qualitySelect');
  if (qualitySelect) {
    qualitySelect.addEventListener('change', saveDefaultSettings);
  }
  const bitrateSelect = document.getElementById('bitrateSelect');
  if (bitrateSelect) {
    bitrateSelect.addEventListener('change', saveDefaultSettings);
  }
  document.getElementById('dropZoneTrigger').addEventListener('click', () => {
    const url = window.prompt('Paste a URL here');
    if (url) document.getElementById('urlInput').value = url;
  });
}

function initializeDownloadUI() {
  renderHistory();
  applySettings();
  bindDownloadEvents();
}
