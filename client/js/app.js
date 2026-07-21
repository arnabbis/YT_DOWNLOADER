document.addEventListener('DOMContentLoaded', () => {
  initializeTheme();
  initializeDownloadUI();
  document.getElementById('themeToggle').addEventListener('click', toggleTheme);
  setToast('NovaTube is ready.');
});
