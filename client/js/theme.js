function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const toggle = document.getElementById('themeToggle');
  if (toggle) toggle.textContent = theme === 'dark' ? '🌙' : '☀️';
}

function initializeTheme() {
  const settings = getStoredSettings();
  const theme = settings.theme || 'dark';
  applyTheme(theme);
}

function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  const settings = getStoredSettings();
  settings.theme = currentTheme;
  saveSettings(settings);
  applyTheme(currentTheme);
}
