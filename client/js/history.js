function renderHistory() {
  const history = getHistory();
  const progressList = document.getElementById('progressList');
  if (!progressList) return;

  let historySection = progressList.querySelector('[data-history-section]');
  if (!historySection) {
    historySection = document.createElement('div');
    historySection.className = 'history-list';
    historySection.dataset.historySection = 'true';
    progressList.appendChild(historySection);
  }

  historySection.innerHTML = history.length ? history.map((item) => `
    <div class="progress-item history-item">
      <strong>${escapeHtml(item.title)}</strong>
      <div class="details">${escapeHtml(item.type)} - ${escapeHtml(formatQualityLabel(item.quality))}</div>
      <div class="details">${new Date(item.createdAt).toLocaleString()}</div>
    </div>
  `).join('') : '<div class="details" data-empty-state="true">No downloads yet. Your recent jobs will appear here.</div>';
}

function addHistoryItem(entry) {
  updateHistory(entry);
  renderHistory();
}
