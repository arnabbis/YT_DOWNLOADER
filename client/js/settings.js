function applySettings() {
  const settings = getStoredSettings();
  const qualitySelect = document.getElementById('qualitySelect');
  if (qualitySelect && settings.defaultQuality) {
    qualitySelect.value = settings.defaultQuality;
  }
}

function saveDefaultSettings() {
  const settings = getStoredSettings();
  settings.defaultQuality = document.getElementById('qualitySelect')?.value || settings.defaultQuality;
  saveSettings(settings);
}
