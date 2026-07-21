const STORAGE_KEYS = {
  history: 'nova_history',
  settings: 'nova_settings',
};

function setToast(message) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 2800);
}

function isValidUrl(value) {
  return /(?:youtube\.com|youtu\.be)\//.test(value || '');
}

function toReadableNumber(value) {
  return new Intl.NumberFormat().format(Number(value || 0));
}

function getStoredSettings() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.settings) || '{}');
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
}

function updateHistory(entry) {
  const next = [entry, ...JSON.parse(localStorage.getItem(STORAGE_KEYS.history) || '[]')].slice(0, 8);
  localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(next));
}

function getHistory() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.history) || '[]');
  } catch {
    return [];
  }
}

function clearHistory() {
  localStorage.removeItem(STORAGE_KEYS.history);
}
