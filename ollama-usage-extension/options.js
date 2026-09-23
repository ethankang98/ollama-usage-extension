const DEFAULTS = { intervalMinutes: 5, warnThreshold: 90, notify: true, badgeMetric: 'session', showAs: 'badge' };

const fields = {
  interval: document.getElementById('interval'),
  threshold: document.getElementById('threshold'),
  showAs: document.getElementById('showAs'),
  badge: document.getElementById('badge'),
  notify: document.getElementById('notify'),
  save: document.getElementById('save'),
  saved: document.getElementById('saved'),
};

async function load() {
  const { options } = await chrome.storage.local.get('options');
  const o = { ...DEFAULTS, ...(options || {}) };
  fields.interval.value = o.intervalMinutes;
  fields.threshold.value = o.warnThreshold;
  fields.showAs.value = o.showAs;
  fields.badge.value = o.badgeMetric;
  fields.notify.checked = !!o.notify;
}

fields.save.addEventListener('click', async () => {
  const options = {
    intervalMinutes: Math.min(120, Math.max(1, Number(fields.interval.value) || DEFAULTS.intervalMinutes)),
    warnThreshold: Math.min(100, Math.max(50, Number(fields.threshold.value) || DEFAULTS.warnThreshold)),
    showAs: fields.showAs.value,
    badgeMetric: fields.badge.value,
    notify: fields.notify.checked,
  };
  await chrome.storage.local.set({ options });
  fields.interval.value = options.intervalMinutes;
  fields.threshold.value = options.warnThreshold;
  fields.saved.textContent = '저장했습니다. 사용량을 다시 읽는 중…';
  await chrome.runtime.sendMessage({ type: 'options-changed' });
  fields.saved.textContent = '저장했습니다.';
  setTimeout(() => (fields.saved.textContent = ''), 2500);
});

load();
