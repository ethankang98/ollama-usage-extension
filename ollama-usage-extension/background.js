// Ollama 사용 한도 - background service worker
// ollama.com/settings 페이지를 로그인된 브라우저 세션으로 읽어
// 세션/주간 사용률, 초기화 시각, 모델별 요청 수, 사용 크레딧 잔액을 뽑아냅니다.

const SETTINGS_URL = 'https://ollama.com/settings';
const ALARM_NAME = 'refresh-usage';

const DEFAULTS = {
  intervalMinutes: 5, // 자동 갱신 주기(분)
  warnThreshold: 90, // 이 비율을 넘으면 알림
  notify: true,
  badgeMetric: 'session', // session | weekly | max
  showAs: 'badge', // badge = 숫자 뱃지 | ring = 아이콘을 감싸는 원형 게이지
};

async function loadOptions() {
  const { options } = await chrome.storage.local.get('options');
  return { ...DEFAULTS, ...(options || {}) };
}

/* ------------------------------ 파싱 ------------------------------ */

function unescapeHtml(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function parseUsage(html) {
  const signedIn = /href="\/signout"/.test(html);
  const account = (html.match(/id="settings-account-name"[^>]*>\s*([^<]+?)\s*</) || [])[1];
  const plan = (html.match(/Cloud usage[\s\S]{0,600}?capitalize"\s*>\s*([a-z]+)\s*</i) || [])[1];
  const credits = (html.match(/id="extra-usage-balance"[^>]*>([^<]+)</) || [])[1];
  const creditsRaw = credits ? unescapeHtml(credits) : null;

  const meters = [];
  const blocks = html.split('data-usage-track').slice(1);
  for (const block of blocks) {
    const label = (block.slice(0, 400).match(/aria-label="([^"]+)"/) || [])[1];
    if (!label) continue;
    const parsed = label.match(/^(.+?) usage ([\d.]+)% used$/i);
    if (!parsed) continue;

    const key = parsed[1].trim().toLowerCase().replace(/\s+/g, '-');
    const percent = parseFloat(parsed[2]);
    const resetsAt = (block.slice(0, 4000).match(/data-time="([^"]+)"/) || [])[1] || null;
    const resetsText = (block.slice(0, 4000).match(/(Resets in [^<]+)/) || [])[1];

    const models = [];
    for (const seg of block.matchAll(
      /style="width: ([\d.]+)%; background: (#[0-9a-fA-F]{6})"[\s\S]{0,300}?data-model="([^"]+)"[\s\S]{0,200}?data-requests="(\d+)"/g
    )) {
      models.push({
        share: parseFloat(seg[1]),
        color: seg[2],
        model: unescapeHtml(seg[3]),
        requests: Number(seg[4]),
      });
    }

    meters.push({
      key,
      label: parsed[1].trim(),
      percent,
      resetsAt,
      resets: resetsText ? unescapeHtml(resetsText) : null,
      models,
    });
  }

  // 주간 목록(#weekly-usage-models)이 있으면 모델 표는 그쪽을 우선 사용
  const weeklyList = html.split('id="weekly-usage-models"')[1] || '';
  const listedModels = weeklyList
    .split('flex min-w-0 items-center gap-2 text-xs')
    .slice(1)
    .map((chunk) => {
      const name = (chunk.match(/title="([^"]+)"/) || [])[1];
      const req = (chunk.match(/([\d,]+)\s*requests/) || [])[1];
      const color = (chunk.match(/background: (#[0-9a-fA-F]{6})/) || [])[1];
      return name && req
        ? { model: unescapeHtml(name), requests: Number(req.replace(/,/g, '')), color }
        : null;
    })
    .filter(Boolean);

  const weekly = meters.find((m) => m.key === 'weekly');
  if (weekly && listedModels.length) {
    const byModel = new Map(weekly.models.map((m) => [m.model, m]));
    weekly.models = listedModels.map((m) => ({ ...(byModel.get(m.model) || {}), ...m }));
  }

  return {
    ok: meters.length > 0,
    signedIn,
    account: account ? unescapeHtml(account) : null,
    plan: plan || null,
    meters,
    credits: creditsRaw,
    checkedAt: Date.now(),
    error: meters.length > 0 ? null : signedIn ? 'unexpected-page' : 'signed-out',
  };
}

/* ------------------------------ 조회 ------------------------------ */

async function refresh() {
  let data;
  try {
    const res = await fetch(SETTINGS_URL, {
      credentials: 'include',
      cache: 'no-store',
      headers: { accept: 'text/html' },
    });
    const html = await res.text();
    if (!html || html.length < 500) {
      data = {
        ok: false,
        signedIn: false,
        error: 'empty-response',
        httpStatus: res.status,
        checkedAt: Date.now(),
      };
    } else {
      data = parseUsage(html);
      data.httpStatus = res.status;
      if (!data.ok && !data.error) data.error = 'unexpected-page';
    }
  } catch (err) {
    data = { ok: false, signedIn: false, error: 'network', detail: String(err), checkedAt: Date.now() };
  }

  await chrome.storage.local.set({ usage: data });
  await updateBadge(data);
  await maybeNotify(data);
  return data;
}

/* ------------------------------ 뱃지 ------------------------------ */

function pickPercent(data, metric) {
  const get = (k) => {
    const m = (data.meters || []).find((x) => x.key === k);
    return m ? m.percent : null;
  };
  const session = get('session');
  const weekly = get('weekly');
  if (metric === 'weekly') return weekly ?? session;
  if (metric === 'max') return Math.max(session ?? 0, weekly ?? 0);
  return session ?? weekly;
}

/* ------------------------------ 아이콘 표시 방식 ------------------------------ */
// showAs = 'badge' : 아이콘 위에 숫자 뱃지
// showAs = 'ring'  : 아이콘을 감싸는 원형 게이지 (숫자 뱃지 숨김)

const ICON_PATHS = { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' };

function ringColor(percent) {
  if (percent == null) return '#9ca3af';
  if (percent >= 85) return '#dc2626';
  if (percent >= 60) return '#f59e0b';
  return '#16a34a';
}

let appliedIconMode = null; // 'badge' | 'ring'
let baseIconBitmap = null;

async function loadBaseIcon() {
  if (baseIconBitmap) return baseIconBitmap;
  const res = await fetch(chrome.runtime.getURL('icons/icon48.png'));
  baseIconBitmap = await createImageBitmap(await res.blob());
  return baseIconBitmap;
}

// 16px/32px용 원형 게이지 이미지를 만들어 돌려줍니다.
async function ringIconImageData(percent) {
  const bmp = await loadBaseIcon();
  const color = ringColor(percent);
  const progress = Math.max(0, Math.min(100, percent || 0)) / 100;
  const out = {};
  // 툴바 슬롯을 최대한 채우기 위해 48px 자산도 같이 만듭니다.
  for (const size of [16, 32, 48]) {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');
    const k = size / 32;
    // 링 두께 (중간 사이즈): 32px에서 6px, 16px에서 3px
    const ringWidth = Math.max(2.5, 6 * k);
    const radius = size / 2 - ringWidth / 2 - 0.15 * k; // 캔버스를 거의 꽉 채움

    // 바탕 트랙
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, radius, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(165,165,165,0.55)';
    ctx.lineWidth = ringWidth;
    ctx.stroke();

    // 사용률 호 (12시 방향에서 시계방향)
    if (progress > 0) {
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
      ctx.strokeStyle = color;
      ctx.lineWidth = ringWidth;
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    // 안쪽에 아이콘
    const inner = (radius - ringWidth / 2) * 2 * 0.97;
    const offset = (size - inner) / 2;
    ctx.drawImage(bmp, offset, offset, inner, inner);

    out[size] = ctx.getImageData(0, 0, size, size);
  }
  return out;
}

// 아이콘을 원하는 모드로 맞춥니다. showAs:'ring'이면 원형 게이지를 그리고 true를 돌려줍니다.
async function applyIconMode(percent, showAs) {
  if (showAs === 'ring' && percent != null) {
    try {
      await chrome.action.setIcon({ imageData: await ringIconImageData(percent) });
      appliedIconMode = 'ring';
      return true;
    } catch (err) {
      // OffscreenCanvas를 쓸 수 없으면 숫자 뱃지로 떨어집니다.
    }
  }
  if (appliedIconMode !== 'badge') {
    await chrome.action.setIcon({ path: ICON_PATHS });
    appliedIconMode = 'badge';
  }
  return false;
}

async function updateBadge(data) {
  const { badgeMetric, showAs } = await loadOptions();

  if (!data || !data.ok) {
    await applyIconMode(null, 'badge');
    const text = data && data.error === 'signed-out' ? 'OFF' : '!';
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: '#9ca3af' });
    await chrome.action.setTitle({
      title: data && data.error === 'signed-out'
        ? 'Ollama 사용 한도 - ollama.com에 로그인이 필요합니다'
        : 'Ollama 사용 한도 - 사용량을 읽지 못했습니다',
    });
    return;
  }

  const percent = pickPercent(data, badgeMetric);
  const rounded = percent == null ? null : Math.min(999, Math.round(percent));

  // showAs: 'badge' = 숫자만, 'ring' = 원형 게이지만, 'both' = 둘 다
  const wantsRing = showAs === 'ring' || showAs === 'both';
  const drawnRing = await applyIconMode(rounded, wantsRing ? 'ring' : 'badge');
  const showNumber = !drawnRing || showAs === 'both';
  if (showNumber) {
    await chrome.action.setBadgeText({ text: rounded == null ? '?' : `${rounded}` });
    await chrome.action.setBadgeBackgroundColor({ color: ringColor(percent) });
  } else {
    await chrome.action.setBadgeText({ text: '' }); // 원형 게이지만 보일 땐 숫자를 숨깁니다.
  }

  const parts = (data.meters || []).map((m) => `${m.label}: ${m.percent}%${m.resets ? ` (${m.resets})` : ''}`);
  await chrome.action.setTitle({
    title: [`Ollama 사용 한도 (${data.plan || 'plan?'}${data.account ? ` · ${data.account}` : ''})`, ...parts].join('\n'),
  });
}

/* ------------------------------ 알림 ------------------------------ */

async function maybeNotify(data) {
  const { notify, warnThreshold } = await loadOptions();
  if (!notify || !data || !data.ok) return;

  const session = (data.meters || []).find((m) => m.key === 'session');
  if (!session || session.percent < warnThreshold) return;

  // 같은 초기화 구간에서는 한 번만 알림
  const key = `${session.resetsAt || 'na'}:${Math.floor(session.percent / 10)}`;
  const { lastNotified } = await chrome.storage.local.get('lastNotified');
  if (lastNotified === key) return;
  await chrome.storage.local.set({ lastNotified: key });

  const reset = session.resetsAt ? new Date(session.resetsAt).toLocaleString('ko-KR') : '곧';
  try {
    await chrome.notifications.create(`ollama-usage-${Date.now()}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: `Ollama 세션 사용 한도 ${session.percent}%`,
      message: `세션 사용률이 경고 기준(${warnThreshold}%)을 넘었습니다. 초기화: ${reset}`,
    });
  } catch (err) {
    // 알림 권한 문제는 무시
  }
}

/* ------------------------------ 스케줄 ------------------------------ */

async function schedule() {
  const { intervalMinutes } = await loadOptions();
  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 1,
    periodInMinutes: Math.max(1, Number(intervalMinutes) || 5),
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  await schedule();
  await refresh();
});

chrome.runtime.onStartup.addListener(async () => {
  await schedule();
  await refresh();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) refresh();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'refresh') {
    refresh().then((data) => sendResponse(data));
    return true;
  }
  if (msg && msg.type === 'options-changed') {
    schedule().then(() => refresh()).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.usage) updateBadge(changes.usage.newValue);
});
