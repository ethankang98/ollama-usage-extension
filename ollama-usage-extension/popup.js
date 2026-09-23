const NAMES = { session: '세션 사용량', weekly: '주간 사용량' };

const el = {
  plan: document.getElementById('plan'),
  meters: document.getElementById('meters'),
  credits: document.getElementById('credits'),
  notice: document.getElementById('notice'),
  stamp: document.getElementById('stamp'),
  refresh: document.getElementById('refresh'),
  settings: document.getElementById('settings'),
};

let current = null;
let busy = false;

function colorFor(percent) {
  if (percent == null) return '#9ca3af';
  if (percent >= 85) return '#dc2626';
  if (percent >= 60) return '#f59e0b';
  return '#16a34a';
}

function clockText(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function remainText(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (!isFinite(ms)) return null;
  if (ms <= 0) return '초기화됨';
  const mins = Math.floor(ms / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days >= 1) return `${days}일 ${hours % 24}시간 남음`;
  if (hours >= 1) return `${hours}시간 ${mins % 60}분 남음`;
  return `${Math.max(1, mins)}분 남음`;
}

function meterNode(meter) {
  const wrap = document.createElement('section');
  wrap.className = 'meter';

  const row = document.createElement('div');
  row.className = 'row';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = NAMES[meter.key] || meter.label;
  const pct = document.createElement('span');
  pct.className = 'pct';
  pct.textContent = `${meter.percent}%`;
  pct.style.color = colorFor(meter.percent);
  row.append(name, pct);

  const track = document.createElement('div');
  track.className = 'track';
  const fill = document.createElement('div');
  fill.className = 'fill';
  fill.style.width = `${Math.min(100, meter.percent)}%`;
  fill.style.background = colorFor(meter.percent);

  // 모델별 비중은 "사용한 구간 대비 비율"이므로 fill 안쪽에 넣어야 폭이 맞습니다.
  // 모델이 하나뿐이어도(세션 구간 등) ollama.com과 같이 해당 모델 색으로 칠합니다.
  const models = meter.models || [];
  for (const m of models) {
    const share = m.share ?? 0;
    const seg = document.createElement('span');
    seg.style.width = `${share}%`;
    // ollama.com과 동일하게 0% 모델도 2px 슬라이버로 남깁니다.
    seg.style.minWidth = '2px';
    seg.style.background = m.color || '#4f46e5';
    seg.title = `${m.model}: ${(m.requests || 0).toLocaleString('ko-KR')} requests`;
    fill.append(seg);
  }

  track.append(fill);

  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.dataset.resetsAt = meter.resetsAt || '';
  sub.dataset.fallback = meter.resets || '';
  wrap.append(row, track, sub);

  // 색이 어떤 모델인지 알 수 있게 범례를 붙입니다.
  if (models.length) {
    const legend = document.createElement('div');
    legend.className = 'legend';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = meter.key === 'session' ? '이 세션 구간에서 사용한 모델' : '이번 주 사용한 모델';
    legend.append(title);
    for (const m of models) {
      const lrow = document.createElement('div');
      lrow.className = 'row';
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = m.color || '#4f46e5';
      const nm = document.createElement('span');
      nm.className = 'mname';
      nm.textContent = m.model;
      const rq = document.createElement('span');
      rq.className = 'mreq';
      rq.textContent = `${(m.requests || 0).toLocaleString('ko-KR')} requests`;
      lrow.append(sw, nm, rq);
      legend.append(lrow);
    }
    wrap.append(legend);
  }

  return wrap;
}

function render(data) {
  current = data;
  el.meters.textContent = '';
  el.credits.textContent = '';
  el.credits.hidden = true;
  el.notice.hidden = true;

  if (!data) {
    el.notice.hidden = false;
    el.notice.innerHTML = '<b>사용량을 불러오는 중…</b>';
    el.plan.hidden = true;
    el.stamp.textContent = '-';
    return;
  }

  if (!data.ok) {
    el.plan.hidden = true;
    el.notice.hidden = false;
    const reasons = {
      'signed-out': '<b>ollama.com 로그인이 필요합니다.</b><br />브라우저에서 ollama.com에 로그인한 뒤 새로고침하세요.',
      'unexpected-page': '<b>사용량 페이지 구조를 읽지 못했습니다.</b><br />ollama.com이 페이지를 바꿨을 수 있습니다.',
      'empty-response': '<b>응답이 비어 있습니다.</b><br />잠시 후 다시 시도해 보세요.',
      network: '<b>ollama.com에 연결하지 못했습니다.</b><br />네트워크 상태를 확인하세요.',
    };
    el.notice.innerHTML = (reasons[data.error] || '<b>사용량을 읽지 못했습니다.</b>') +
      (data.httpStatus ? `<br /><span class="muted">HTTP ${data.httpStatus}</span>` : '');
    el.stamp.textContent = data.checkedAt ? `확인 ${new Date(data.checkedAt).toLocaleTimeString('ko-KR')}` : '-';
    return;
  }

  if (data.plan) {
    el.plan.hidden = false;
    el.plan.textContent = data.plan;
  } else {
    el.plan.hidden = true;
  }

  for (const meter of data.meters) el.meters.append(meterNode(meter));

  if (data.credits) {
    const label = document.createElement('span');
    label.textContent = '구매한 사용 크레딧 잔액';
    const value = document.createElement('b');
    value.textContent = data.credits;
    el.credits.append(label, value);
    el.credits.hidden = false;
  }

  el.stamp.textContent = data.account
    ? `${data.account} · ${new Date(data.checkedAt).toLocaleTimeString('ko-KR')} 갱신`
    : `${new Date(data.checkedAt).toLocaleTimeString('ko-KR')} 갱신`;
  tick();
}

function tick() {
  for (const sub of el.meters.querySelectorAll('.sub')) {
    const iso = sub.dataset.resetsAt;
    if (!iso) {
      sub.textContent = sub.dataset.fallback || '';
      continue;
    }
    const clock = clockText(iso);
    const remain = remainText(iso);
    sub.textContent = [clock ? `${clock} 초기화` : null, remain].filter(Boolean).join(' · ');
  }
}

async function load({ force = false } = {}) {
  const { usage } = await chrome.storage.local.get('usage');
  if (!force) render(usage);
  if (busy) return;
  busy = true;
  el.refresh.textContent = '확인 중…';
  try {
    const data = await chrome.runtime.sendMessage({ type: 'refresh' });
    render(data);
  } catch (err) {
    render({ ok: false, error: 'network', detail: String(err), checkedAt: Date.now() });
  } finally {
    busy = false;
    el.refresh.textContent = '새로고침';
  }
}

el.refresh.addEventListener('click', () => load({ force: false }));
el.settings.addEventListener('click', () => chrome.runtime.openOptionsPage());

setInterval(tick, 1000);
load();
