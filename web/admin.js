'use strict';

/* =========================================================
 * 관리자 화면 — 카운터 태블릿(직원) · 사장님 휴대폰/PC 공용
 * 직원: 대기 / 완료 탭    사장님: + 통계 / 설정 탭
 * ========================================================= */

const app = document.getElementById('app');
const ROLE_LABEL = { owner: '사장님', staff: '카운터', kiosk: '입구 태블릿' };
const STATUS_LABEL = { seated: '입장', canceled: '취소', noshow: '노쇼', expired: '만료' };
const DOW = ['', '월', '화', '수', '목', '금', '토', '일'];

const ui = {
  view: 'loading',     // loading | setup | login | norole | main
  role: null,
  tab: 'active',       // active | done | stats | settings
  entries: [],
  sms: {},
  smsQueued: false,
  settings: null,
  offline: false,
  loginError: '',
  noRoleMessage: '',
  statsDays: 7,
  statsMetric: 'wait',
  stats: null,
  keyInfo: null,
  accounts: null,
};

/* ---------- 시작 ---------- */

async function boot() {
  if (!IS_CONFIGURED) { ui.view = 'setup'; render(); return; }
  const { loggedIn, role } = await currentRole();
  if (!loggedIn) { ui.view = 'login'; render(); return; }
  if (!['owner', 'staff'].includes(role)) {
    ui.noRoleMessage = role === 'kiosk'
      ? '입구 태블릿 계정입니다. 관리자 화면은 카운터 또는 사장님 계정으로 로그인해 주세요.'
      : '이 계정에는 관리자 권한이 없습니다. 사장님 계정의 설정 → 기기 관리에서 권한을 켜 주세요.';
    ui.view = 'norole'; render(); return;
  }
  ui.role = role;
  ui.view = 'main';
  await refresh();
  subscribe();
}

/* ---------- 데이터 ---------- */

async function loadEntries() {
  const { data, error } = await sb.from('entries')
    .select('id,no,sort_key,adults,kids,phone,source,status,canceled_by,created_at,called_at,call_count,done_at')
    .eq('day', kstDate())
    .order('sort_key');
  if (error) throw error;
  ui.entries = data;
}

async function loadSms() {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data, error } = await sb.from('sms_log')
    .select('id,entry_id,kind,status,error')
    .gte('created_at', since)
    .order('id');
  if (error) throw error;
  ui.sms = {};
  for (const l of data) if (l.entry_id) ui.sms[l.entry_id] = l; // 손님별 가장 최근 문자
  ui.smsQueued = data.some(l => l.status === 'queued');
}

async function loadSettings() {
  const { data, error } = await sb.from('settings').select('*').eq('id', 1).single();
  if (error) throw error;
  ui.settings = data;
}

async function refresh() {
  try {
    await Promise.all([loadEntries(), loadSms(), loadSettings()]);
    ui.offline = false;
  } catch (err) {
    ui.offline = true;
    if (/권한|JWT/.test(friendlyError(err))) { boot(); return; }
  }
  render();
}

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 250);
}

// 새 접수·변경을 실시간으로 받고, 연결이 끊겨도 15초마다 다시 확인
function subscribe() {
  sb.channel('entries-live')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'entries' }, payload => {
      if (payload.eventType === 'INSERT') chime();
      scheduleRefresh();
    })
    .subscribe();
  setInterval(refresh, 15 * 1000);
  setInterval(async () => {
    if (!ui.smsQueued) return;
    try { await rpc('sync_sms'); await loadSms(); render(); } catch (_) { /* 다음 주기에 재시도 */ }
  }, 4000);
}

const activeList = () => ui.entries.filter(e => e.status === 'waiting' || e.status === 'called');
const doneList = () => ui.entries.filter(e => e.status !== 'waiting' && e.status !== 'called')
  .sort((a, b) => new Date(b.done_at || b.created_at) - new Date(a.done_at || a.created_at));
const findEntry = id => ui.entries.find(e => e.id === id);
const party = e => e.adults + e.kids;

/* ---------- 렌더링 ---------- */

function render() {
  if (ui.view !== 'main') {
    const views = {
      loading: () => '<main class="screen center-screen"><p class="muted">불러오는 중…</p></main>',
      setup: setupNeededHtml,
      login: () => loginHtml('관리자 로그인', '카운터 태블릿은 직원 계정, 사장님은 사장님 계정으로 로그인해 주세요.', ui.loginError),
      norole: () => noRoleHtml(ui.noRoleMessage),
    };
    app.innerHTML = views[ui.view]();
    if (ui.view === 'login') focusLogin();
    return;
  }
  // 설정 탭은 입력 중인 내용이 지워지지 않도록 본문을 다시 그리지 않음
  const keepBody = ui.tab === 'settings' && document.getElementById('admin-body')?.dataset.tab === 'settings';
  if (!app.querySelector('.admin')) {
    app.innerHTML = `<main class="screen admin"><header class="admin-bar" id="admin-bar"></header>
      <div class="admin-stats" id="admin-stats"></div><section class="admin-body" id="admin-body"></section></main>`;
  }
  document.getElementById('admin-bar').innerHTML = headerHtml();
  document.getElementById('admin-stats').innerHTML = statsLineHtml();
  if (!keepBody) {
    const body = document.getElementById('admin-body');
    body.dataset.tab = ui.tab;
    body.innerHTML = { active: activeHtml, done: doneHtml, stats: statsHtml, settings: settingsHtml }[ui.tab]();
  }
}

function headerHtml() {
  const s = ui.settings || {};
  const tabs = [['active', `대기 <b>${activeList().length}</b>`], ['done', '완료']];
  if (ui.role === 'owner') tabs.push(['stats', '통계'], ['settings', '설정']);
  return `
    <div class="admin-title">${esc(s.store_name || '')} <span>${ROLE_LABEL[ui.role]}</span></div>
    <nav class="tabs">
      ${tabs.map(([k, label]) => `<button class="tab ${ui.tab === k ? 'on' : ''}" data-action="tab" data-key="${k}">${label}</button>`).join('')}
    </nav>
    <div class="admin-actions">
      <button class="toggle ${s.paused ? 'off' : 'on'}" data-action="toggle-pause">
        <span class="dot"></span>${s.paused ? '접수 중지됨' : '접수 중'}
      </button>
      <button class="btn btn-primary" data-action="add">+ 직접 등록</button>
      <button class="btn btn-outline icon-btn" data-action="menu" aria-label="메뉴">⋯</button>
    </div>`;
}

function statsLineHtml() {
  const s = ui.settings || {};
  const all = ui.entries;
  const seated = all.filter(e => e.status === 'seated').length;
  const warns = [];
  if (ui.offline) warns.push('<span class="warn-chip bad">인터넷 연결 끊김 — 다시 연결 중</span>');
  if (!s.sms_enabled) warns.push('<span class="warn-chip">문자 발송 꺼짐</span>');
  return `
    <span>오늘 접수 <b>${all.length}</b>팀</span>
    <span>입장 <b>${seated}</b>팀</span>
    <span>다음 번호 <b>${all.length ? Math.max(...all.map(e => e.no)) + 1 : 1}</b>번</span>
    ${warns.join('')}`;
}

function smsBadge(e) {
  const l = ui.sms[e.id];
  if (!l) return '';
  const kind = { register: '접수', soon: '앞 대기 알림', call: '호출' }[l.kind] || '';
  const label = { ok: `${kind} 문자 전송됨`, fail: `${kind} 문자 실패`, queued: `${kind} 문자 보내는 중` }[l.status];
  return `<span class="sms-badge sms-${l.status}" ${l.error ? `data-tip="${esc(l.error)}"` : ''}>${label}${l.status === 'fail' && l.error ? ` · ${esc(l.error)}` : ''}</span>`;
}

function phoneHtml(e) {
  if (!e.phone) return '<span class="muted">번호 없음</span>';
  const f = fmtPhone(e.phone);
  return `${f.slice(0, -4)}<b>${f.slice(-4)}</b>`;
}

function activeHtml() {
  const list = activeList();
  if (!list.length) return `<div class="empty">대기 중인 손님이 없습니다</div>`;
  const limit = ui.settings?.noshow_minutes ?? 5;
  return `<div class="rows">${list.map((e, i) => {
    const overdue = e.status === 'called' && minsSince(e.called_at) >= limit;
    const main = overdue
      ? `<button class="btn btn-danger" data-action="noshow" data-id="${e.id}">노쇼</button>`
      : `<button class="btn ${e.status === 'called' ? 'btn-outline' : 'btn-call'}" data-action="call" data-id="${e.id}">${e.status === 'called' ? '재호출' : '호출'}</button>`;
    return `
    <article class="row ${e.status} ${overdue ? 'overdue' : ''}">
      <div class="row-no"><b>${e.no}</b><span>${i === 0 ? '다음 차례' : `${i}팀 뒤`}</span></div>
      <div class="row-info">
        <div class="row-top"><b class="row-party">${party(e)}명</b><span class="row-phone">${phoneHtml(e)}</span></div>
        <div class="row-meta">
          <span>${fmtTime(e.created_at)} 접수 · <b>${minsSince(e.created_at)}분</b> 대기</span>
          ${e.status === 'called' ? `<span class="called-badge">${overdue ? `호출 후 ${minsSince(e.called_at)}분 · 미도착` : `호출 ${e.call_count}회 · ${minsSince(e.called_at)}분 전`}</span>` : ''}
          ${e.kids ? `<span>어린이 ${e.kids}</span>` : ''}
          ${e.source === 'staff' ? '<span class="chip">직원 등록</span>' : ''}
          ${e.sort_key !== e.no ? '<span class="chip warn">순서 변경</span>' : ''}
          ${smsBadge(e)}
        </div>
      </div>
      <div class="row-actions">
        ${main}
        <button class="btn btn-seat" data-action="seat" data-id="${e.id}">입장</button>
        <button class="btn btn-outline icon-btn" data-action="more" data-id="${e.id}" aria-label="더보기">⋯</button>
      </div>
    </article>`;
  }).join('')}</div>`;
}

function doneHtml() {
  const list = doneList();
  if (!list.length) return `<div class="empty">오늘 처리된 손님이 없습니다</div>`;
  return `<div class="rows">${list.map(e => {
    const label = e.status === 'canceled' && e.canceled_by === 'customer' ? '손님 취소' : STATUS_LABEL[e.status];
    const waited = e.done_at ? Math.round((new Date(e.done_at) - new Date(e.created_at)) / 60000) : null;
    return `
    <article class="row done-row">
      <div class="row-no"><b>${e.no}</b></div>
      <div class="row-info">
        <div class="row-top"><b class="row-party">${party(e)}명</b><span class="status-chip s-${e.status}">${label}</span><span class="row-phone">${phoneHtml(e)}</span></div>
        <div class="row-meta"><span>${fmtTime(e.created_at)} 접수${e.done_at ? ` → ${fmtTime(e.done_at)} ${label}` : ''}${waited !== null ? ` · ${waited}분` : ''}</span></div>
      </div>
      <div class="row-actions">
        ${e.status !== 'expired' ? `<button class="btn btn-outline" data-action="restore" data-id="${e.id}">대기로 되돌리기</button>` : ''}
      </div>
    </article>`;
  }).join('')}</div>`;
}

/* ---------- 통계 (사장님) ---------- */

const SEQ = ['#f4ebdc', '#e5cfa9', '#cfa76c', '#a57a41', '#6b4f2a']; // 한 가지 색(갈색)의 밝음→어두움

function seqColor(v, max) {
  if (v == null || !max) return null;
  const i = Math.min(SEQ.length - 1, Math.floor((v / max) * SEQ.length));
  return { bg: SEQ[i], ink: i >= 3 ? '#fff' : 'var(--ink)' };
}

function rangeDates(days) {
  const to = kstDate();
  const from = kstDate(new Date(Date.now() - (days - 1) * 86400000));
  return { from, to };
}

async function loadStats() {
  const { from, to } = rangeDates(ui.statsDays);
  try {
    ui.stats = await rpc('stats', { p_from: from, p_to: to });
  } catch (err) {
    ui.stats = { error: err.message };
  }
  if (ui.tab === 'stats') render();
}

function statsHtml() {
  const ranges = [[1, '오늘'], [7, '최근 7일'], [30, '최근 30일'], [90, '최근 90일']];
  const controls = `
    <div class="stats-controls">
      <div class="seg">${ranges.map(([d, l]) => `<button class="${ui.statsDays === d ? 'on' : ''}" data-action="stats-range" data-key="${d}">${l}</button>`).join('')}</div>
      <button class="btn btn-outline" data-action="csv">엑셀(CSV) 내려받기</button>
    </div>`;
  const st = ui.stats;
  if (!st) { loadStats(); return controls + '<div class="empty">불러오는 중…</div>'; }
  if (st.error) return controls + `<div class="empty">${esc(st.error)}</div>`;
  const s = st.summary;
  if (!s.teams) return controls + '<div class="empty">이 기간에는 웨이팅 기록이 없습니다</div>';

  const noshowRate = s.teams ? Math.round((s.noshow / s.teams) * 100) : 0;
  const tiles = [
    ['웨이팅 팀', `${s.teams}<small>팀</small>`, `${s.people}명`],
    ['평균 대기 (입장 손님)', s.avg_wait != null ? `${s.avg_wait}<small>분</small>` : '-', s.max_wait != null ? `가장 길게 ${s.max_wait}분` : ''],
    ['노쇼', `${noshowRate}<small>%</small>`, `${s.noshow}팀 · 취소 ${s.canceled}팀`],
    ['호출 후 도착', s.avg_arrive != null ? `${s.avg_arrive}<small>분</small>` : '-', '호출 문자를 받고 오기까지 평균'],
  ];

  return controls + `
    <div class="tiles">${tiles.map(([label, value, sub]) => `
      <div class="tile"><span class="tile-label">${label}</span><span class="tile-value">${value}</span><span class="tile-sub">${sub}</span></div>`).join('')}
    </div>
    <section class="chart-card">
      <header class="chart-head">
        <div><h3>요일 · 시간대별 ${ui.statsMetric === 'wait' ? '평균 대기시간(분)' : '웨이팅 팀 수'}</h3>
        <p class="muted">접수한 시각 기준. 칸이 진할수록 ${ui.statsMetric === 'wait' ? '오래 기다렸습니다' : '손님이 많았습니다'}.</p></div>
        <div class="seg">
          <button class="${ui.statsMetric === 'wait' ? 'on' : ''}" data-action="stats-metric" data-key="wait">대기시간</button>
          <button class="${ui.statsMetric === 'teams' ? 'on' : ''}" data-action="stats-metric" data-key="teams">팀 수</button>
        </div>
      </header>
      ${heatmapHtml(st.hourly)}
    </section>
    <section class="chart-card">
      <header class="chart-head"><div><h3>날짜별 웨이팅 팀 수</h3></div></header>
      ${dailyChartHtml(st.daily)}
    </section>
    <section class="chart-card">
      <header class="chart-head"><div><h3>인원수별</h3><p class="muted">큰 테이블이 필요한 팀이 더 오래 기다리는지 확인할 수 있습니다.</p></div></header>
      <table class="table">
        <thead><tr><th>인원</th><th>팀 수</th><th>평균 대기</th><th>노쇼</th></tr></thead>
        <tbody>${st.party.map(p => `<tr><td>${p.size >= 5 ? '5명 이상' : `${p.size}명`}</td><td>${p.teams}팀</td><td>${p.avg_wait != null ? `${p.avg_wait}분` : '-'}</td><td>${p.noshow}팀</td></tr>`).join('')}</tbody>
      </table>
    </section>`;
}

function heatmapHtml(rows) {
  const key = ui.statsMetric === 'wait' ? 'avg_wait' : 'teams';
  const hours = rows.map(r => r.hr);
  const minH = Math.min(...hours), maxH = Math.max(...hours);
  const cols = [];
  for (let h = minH; h <= maxH; h++) cols.push(h);
  const byKey = new Map(rows.map(r => [`${r.dow}-${r.hr}`, r]));
  const max = Math.max(...rows.map(r => r[key] ?? 0));
  const days = [1, 2, 3, 4, 5, 6, 7].filter(d => rows.some(r => r.dow === d));
  return `
    <div class="heatmap" style="grid-template-columns: 32px repeat(${cols.length}, minmax(34px, 1fr))">
      <span></span>${cols.map(h => `<span class="hm-col">${h}시</span>`).join('')}
      ${days.map(d => `
        <span class="hm-row">${DOW[d]}</span>
        ${cols.map(h => {
          const r = byKey.get(`${d}-${h}`);
          const v = r ? r[key] : null;
          const c = seqColor(v, max);
          const tip = r ? `${DOW[d]}요일 ${h}시 · ${r.teams}팀 · 평균 대기 ${r.avg_wait ?? '-'}분` : `${DOW[d]}요일 ${h}시 · 기록 없음`;
          return `<span class="hm-cell ${c ? '' : 'hm-none'}" style="${c ? `background:${c.bg};color:${c.ink}` : ''}" data-tip="${tip}">${v ?? ''}</span>`;
        }).join('')}`).join('')}
    </div>
    <div class="legend-seq"><span>적음</span>${SEQ.map(c => `<i style="background:${c}"></i>`).join('')}<span>많음</span></div>`;
}

function dailyChartHtml(rows) {
  if (!rows.length) return '';
  const W = 720, H = 200, padL = 32, padB = 26, padT = 18;
  const max = Math.max(...rows.map(r => r.teams), 1);
  const niceMax = max > 10 ? Math.ceil(max / 10) * 10 : Math.ceil(max / 2) * 2; // 가운데 눈금도 정수가 되도록
  const slot = (W - padL) / rows.length;
  const bw = Math.max(2, Math.min(28, slot - 2));
  const y = v => padT + (H - padT - padB) * (1 - v / niceMax);
  const labelEvery = Math.ceil(rows.length / 10);
  const peak = rows.reduce((a, b) => (b.teams > a.teams ? b : a));
  const grid = [0, niceMax / 2, niceMax].map(v => `
    <line x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}" class="grid"/>
    <text x="${padL - 6}" y="${y(v) + 4}" class="axis" text-anchor="end">${v}</text>`).join('');
  const bars = rows.map((r, i) => {
    const x = padL + i * slot + (slot - bw) / 2;
    const top = y(r.teams), h = Math.max(0, H - padB - top);
    const d = new Date(`${r.day}T00:00:00+09:00`);
    const dayLabel = `${d.getMonth() + 1}/${d.getDate()}`;
    const dowLabel = '일월화수목금토'[d.getDay()];
    const tip = `${dayLabel}(${dowLabel}) · ${r.teams}팀 · 입장 ${r.seated} · 노쇼 ${r.noshow} · 평균 대기 ${r.avg_wait ?? '-'}분`;
    const rr = Math.min(4, bw / 2, h);
    return `
      <g data-tip="${tip}">
        <rect x="${padL + i * slot}" y="${padT}" width="${slot}" height="${H - padT - padB}" fill="transparent"/>
        <path class="bar" d="M${x},${H - padB} V${top + rr} Q${x},${top} ${x + rr},${top} H${x + bw - rr} Q${x + bw},${top} ${x + bw},${top + rr} V${H - padB} Z"/>
        ${r === peak ? `<text x="${x + bw / 2}" y="${top - 5}" class="bar-label" text-anchor="middle">${r.teams}</text>` : ''}
        ${i % labelEvery === 0 ? `<text x="${x + bw / 2}" y="${H - 8}" class="axis" text-anchor="middle">${dayLabel}</text>` : ''}
      </g>`;
  }).join('');
  return `<svg class="bar-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="날짜별 웨이팅 팀 수">${grid}${bars}</svg>`;
}

async function downloadCsv() {
  const { from, to } = rangeDates(ui.statsDays);
  const rows = [];
  for (let page = 0; ; page++) {
    const { data, error } = await sb.from('entries')
      .select('day,no,adults,kids,source,status,canceled_by,created_at,called_at,done_at,call_count')
      .gte('day', from).lte('day', to)
      .order('day').order('no')
      .range(page * 1000, page * 1000 + 999);
    if (error) { toast(friendlyError(error), 'error'); return; }
    rows.push(...data);
    if (data.length < 1000) break;
  }
  const t = ts => (ts ? new Date(ts).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }) : '');
  const head = ['날짜', '번호', '성인', '어린이', '인원', '접수경로', '결과', '접수시각', '호출시각', '처리시각', '대기(분)', '호출횟수'];
  const lines = rows.map(r => [
    r.day, r.no, r.adults, r.kids, r.adults + r.kids,
    r.source === 'staff' ? '직원' : '태블릿',
    r.status === 'canceled' && r.canceled_by === 'customer' ? '손님 취소' : (STATUS_LABEL[r.status] || r.status),
    t(r.created_at), t(r.called_at), t(r.done_at),
    r.done_at ? Math.round((new Date(r.done_at) - new Date(r.created_at)) / 60000) : '',
    r.call_count,
  ].join(','));
  const blob = new Blob(['﻿' + [head.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `웨이팅_${from}_${to}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------- 설정 (사장님) ---------- */

function sampleText(tpl, s) {
  const base = (s.site_url || location.origin).replace(/\/$/, '');
  return tpl
    .replaceAll('{매장}', s.store_name).replaceAll('{번호}', '12').replaceAll('{인원}', '2')
    .replaceAll('{순서안내}', '앞 대기 1팀 남았습니다').replaceAll('{앞팀}', '3').replaceAll('{제한분}', String(s.noshow_minutes)).replaceAll('{링크}', `${base}/s/abcdEFGH`);
}

function bytesLabel(n) { return `${n}/90바이트${n > 90 ? ' · 장문(LMS) 요금' : ''}`; }

function tplField(key, label, help) {
  const s = ui.settings;
  const n = smsBytes(sampleText(s[key], s));
  return `
  <label class="field field-wide">
    <span>${label} <small class="bytes ${n > 90 ? 'over' : ''}" data-bytes-for="${key}">${bytesLabel(n)}</small></span>
    <textarea name="${key}" rows="2" data-tpl>${esc(s[key])}</textarea>
    ${help ? `<small>${help}</small>` : ''}
  </label>`;
}

function settingsHtml() {
  const s = ui.settings;
  if (!ui.keyInfo) rpc('sms_key_info').then(v => { ui.keyInfo = v; rerenderSettingsPart('keys'); }).catch(() => {});
  if (!ui.accounts) loadAccounts();
  return `
  <div class="settings">
    <form class="card-form" data-form="settings" autocomplete="off">
      <fieldset>
        <legend>매장 운영</legend>
        <label class="field"><span>매장 이름</span><input name="store_name" value="${esc(s.store_name)}" required></label>
        <label class="field"><span>호출 후 노쇼 경고 (분)</span><input name="noshow_minutes" type="number" min="1" max="60" inputmode="numeric" value="${s.noshow_minutes}"></label>
        <label class="field"><span>최대 대기 팀 (넘으면 접수 마감, 0 = 제한 없음)</span><input name="max_teams" type="number" min="0" max="500" inputmode="numeric" value="${s.max_teams}"></label>
        <label class="field"><span>접수 마감 시각 (비우면 없음)</span><input name="close_time" type="time" value="${s.close_time ? s.close_time.slice(0, 5) : ''}"></label>
        <label class="field"><span>팀당 예상 대기 (분)</span><input name="minutes_per_team" type="number" min="1" max="60" inputmode="numeric" value="${s.minutes_per_team}"></label>
        <label class="check field"><input type="checkbox" name="auto_estimate" ${s.auto_estimate ? 'checked' : ''}><span>최근 입장 속도로 예상 시간 자동 계산<small>최근 90분 동안 4팀 이상 입장하면 실제 속도를 쓰고, 그 전에는 위 값을 씁니다.</small></span></label>
      </fieldset>

      <fieldset>
        <legend>문자 알림</legend>
        <label class="check field field-wide"><input type="checkbox" name="sms_enabled" ${s.sms_enabled ? 'checked' : ''}><span>문자 보내기<small>접수 완료·호출 문자를 솔라피로 보냅니다. 아래에 API 키와 발신번호가 있어야 합니다.</small></span></label>
        <label class="field"><span>발신번호 (솔라피에 등록한 번호)</span><input name="sms_from" inputmode="tel" value="${esc(s.sms_from)}" placeholder="0212345678"></label>
        <label class="field"><span>'앞 대기 알림' 문자</span>
          <select name="soon_at">
            ${[['', '보내지 않음'], [0, '다음 차례일 때 (앞 대기 0팀)'], ...[1, 2, 3, 4, 5].map(n => [n, `앞 대기 ${n}팀 이하일 때`])]
              .map(([v, label]) => `<option value="${v}" ${String(s.soon_at ?? '') === String(v) ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
        </label>
        <label class="field field-wide"><span>사이트 주소 (순서 확인 링크에 들어감)</span><input name="site_url" inputmode="url" value="${esc(s.site_url || location.origin)}"><small>지금 이 화면의 주소가 기본값입니다. 도메인을 바꾸면 여기도 바꿔 주세요.</small></label>
        <label class="field field-wide"><span>메뉴판 주소 (선택)</span><input name="menu_url" inputmode="url" value="${esc(s.menu_url || '')}" placeholder="https://"><small>손님의 순서 확인 화면에 '메뉴 미리 보기' 버튼으로 나옵니다. 비워 두면 버튼이 숨겨집니다. 문자에는 들어가지 않아 문자비가 늘지 않습니다.</small></label>
        ${tplField('tpl_register', '접수 완료 문자', '사용 가능: {매장} {번호} {인원} {앞팀} {링크} {제한분} — 바이트는 예시 값으로 계산합니다.')}
        ${tplField('tpl_soon', '앞 대기 알림 문자', '{순서안내}는 남은 팀 수에 따라 "앞 대기 N팀 남았습니다" 또는 "다음 순서입니다"로 바뀝니다.')}
        ${tplField('tpl_call', '입장 호출 문자')}
      </fieldset>
      <div class="form-footer"><button type="submit" class="btn btn-primary btn-lg">설정 저장</button></div>
    </form>

    <form class="card-form" data-form="keys" autocomplete="off">
      <fieldset>
        <legend>솔라피 API 키</legend>
        <div class="field field-wide" data-part="keys">${keysStatusHtml()}</div>
        <label class="field"><span>API Key</span><input name="key" spellcheck="false" autocomplete="off"></label>
        <label class="field"><span>API Secret</span><input name="secret" type="password" spellcheck="false" autocomplete="new-password"></label>
        <div class="field field-wide"><small>저장한 키는 서버에만 보관되고 화면에 다시 표시되지 않습니다. 바꿀 때만 새로 입력하세요.</small></div>
      </fieldset>
      <div class="form-footer">
        <button type="submit" class="btn btn-outline">키 저장</button>
        <span class="spacer"></span>
        <input name="test_to" class="inline-input" inputmode="tel" placeholder="테스트 받을 번호">
        <button type="button" class="btn btn-outline" data-action="test-sms">테스트 문자</button>
      </div>
    </form>

    <section class="card-form">
      <fieldset>
        <legend>기기 관리</legend>
        <div class="field field-wide"><small>
          계정은 Supabase 대시보드 → Authentication → Users 에서 만듭니다. 여기서는 각 계정의 역할을 정하고, 잃어버린 기기는 권한을 꺼서 바로 막을 수 있습니다.
        </small></div>
        <div class="field-wide" data-part="accounts">${accountsHtml()}</div>
      </fieldset>
      <div class="form-footer">
        <button type="button" class="btn btn-outline" data-action="signout-all">모든 기기에서 내 계정 로그아웃</button>
      </div>
    </section>
  </div>`;
}

function keysStatusHtml() {
  if (!ui.keyInfo) return '<small class="muted">확인 중…</small>';
  return ui.keyInfo.configured
    ? `<span class="chip ok-chip">저장됨 · ${esc(ui.keyInfo.key_hint)}</span>`
    : '<span class="chip warn">아직 저장된 키가 없습니다</span>';
}

function accountsHtml() {
  if (!ui.accounts) return '<small class="muted">불러오는 중…</small>';
  return `
  <table class="table accounts">
    <thead><tr><th>계정</th><th>역할</th><th>사용</th><th>마지막 로그인</th></tr></thead>
    <tbody>${ui.accounts.map(a => `
      <tr>
        <td>${esc(a.email)}</td>
        <td><select data-account="${a.user_id}" data-field="role">
          <option value="" ${!a.role ? 'selected' : ''}>권한 없음</option>
          ${['owner', 'staff', 'kiosk'].map(r => `<option value="${r}" ${a.role === r ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}
        </select></td>
        <td><label class="switch"><input type="checkbox" data-account="${a.user_id}" data-field="active" ${a.active ? 'checked' : ''} ${a.role ? '' : 'disabled'}><span></span></label></td>
        <td class="muted">${a.last_sign_in_at ? new Date(a.last_sign_in_at).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' }) : '-'}</td>
      </tr>`).join('')}
    </tbody>
  </table>`;
}

async function loadAccounts() {
  try { ui.accounts = await rpc('list_accounts'); } catch (err) { toast(err.message, 'error'); ui.accounts = []; }
  rerenderSettingsPart('accounts');
}

function rerenderSettingsPart(part) {
  const el = document.querySelector(`[data-part="${part}"]`);
  if (!el) return;
  el.innerHTML = part === 'keys' ? keysStatusHtml() : accountsHtml();
}

/* ---------- 동작 ---------- */

async function act(id, action) {
  const e = findEntry(id);
  try {
    if (action === 'top' || action === 'down') await rpc('entry_move', { p_id: id, p_dir: action });
    else await rpc('entry_action', { p_id: id, p_action: action });
  } catch (err) {
    toast(err.message, 'error');
    refresh();
    return;
  }
  const label = { call: '호출', seat: '입장 처리', cancel: '취소 처리', noshow: '노쇼 처리', restore: '대기로 되돌림', top: '맨 위로 올림', down: '한 칸 미룸' }[action];
  if (['seat', 'cancel', 'noshow'].includes(action)) {
    toast(`${e?.no}번 ${label}`, { action: { label: '되돌리기', fn: () => act(id, 'restore') } });
  } else {
    toast(`${e?.no}번 ${label}`, 'ok');
  }
  await refresh();
}

async function openEntryMenu(id) {
  const e = findEntry(id);
  if (!e) return;
  const list = activeList();
  const buttons = [];
  if (list[0]?.id !== id) buttons.push({ label: '⤒ 맨 위로 올리기', value: 'top' });
  if (list[list.length - 1]?.id !== id) buttons.push({ label: '↓ 한 칸 미루기', value: 'down' });
  if (e.status === 'called') buttons.push({ label: '재호출', value: 'call' });
  buttons.push(
    { label: '노쇼', value: 'noshow' },
    { label: '손님 요청 취소', cls: 'btn-danger', value: 'cancel' },
    { label: '닫기', cls: 'btn-ghost', value: null },
  );
  const v = await modal({
    stack: true,
    title: `${e.no}번 · ${party(e)}명`,
    message: `${e.phone ? fmtPhone(e.phone) : '번호 없음'} · ${fmtTime(e.created_at)} 접수${e.kids ? ` · 어린이 ${e.kids}명` : ''}`,
    buttons,
  });
  if (v) act(id, v);
}

async function addEntry() {
  const opts = (from, to, sel) => Array.from({ length: to - from + 1 }, (_, i) => from + i)
    .map(n => `<option value="${n}" ${n === sel ? 'selected' : ''}>${n}명</option>`).join('');
  const v = await modal({
    title: '직접 등록',
    message: '전화로 문의한 손님이나 번호 입력을 원하지 않는 손님을 등록합니다.',
    body: `
      <div class="modal-form">
        <label class="field"><span>성인</span><select name="adults">${opts(1, 20, 2)}</select></label>
        <label class="field"><span>어린이</span><select name="kids">${opts(0, 10, 0)}</select></label>
        <label class="field field-wide"><span>휴대폰 번호 (선택)</span><input name="phone" inputmode="tel" placeholder="비워 두면 문자 없이 등록"></label>
        <p class="form-error field-wide"></p>
      </div>`,
    buttons: [
      { label: '취소', value: null },
      {
        label: '등록', cls: 'btn-primary', value: form => {
          const phone = form.querySelector('[name="phone"]').value.replace(/\D/g, '');
          if (phone && !/^01[016789]\d{7,8}$/.test(phone)) {
            form.querySelector('.form-error').textContent = '휴대폰 번호를 확인해 주세요';
            return false;
          }
          return { adults: Number(form.querySelector('[name="adults"]').value), kids: Number(form.querySelector('[name="kids"]').value), phone };
        },
      },
    ],
  });
  if (!v) return;
  try {
    const r = await rpc('register_entry', { p_adults: v.adults, p_kids: v.kids, p_phone: v.phone || null });
    if (!r.ok) {
      toast(r.error === 'duplicate' ? `이미 ${r.no}번으로 대기 중인 번호입니다` : '등록하지 못했습니다', 'error');
      return;
    }
    await modal({
      title: `${r.no}번으로 등록했습니다`,
      message: `앞 대기 ${r.ahead}팀 · 예상 약 ${r.est_minutes}분${r.sms ? '<br>접수 문자를 보냈습니다.' : '<br>손님께 번호를 알려 주세요.'}`,
      buttons: [{ label: '확인', cls: 'btn-primary', value: true }],
    });
    refresh();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function openMenu() {
  const v = await modal({
    title: '메뉴',
    buttons: [
      { label: '닫기', value: null },
      { label: '새로고침', value: 'reload' },
      { label: '전체화면', value: 'fullscreen' },
      { label: '로그아웃', cls: 'btn-danger', value: 'logout' },
    ],
  });
  if (v === 'reload') location.reload();
  if (v === 'fullscreen') toggleFullscreen();
  if (v === 'logout') { await sb.auth.signOut({ scope: 'local' }); location.reload(); }
}

async function testSms() {
  const to = (document.querySelector('[name="test_to"]')?.value || '').replace(/\D/g, '');
  if (!/^01[016789]\d{7,8}$/.test(to)) { toast('테스트 받을 휴대폰 번호를 입력해 주세요', 'error'); return; }
  let id;
  try {
    id = await rpc('send_test_sms', { p_phone: to });
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  toast('테스트 문자를 보내는 중…');
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 1500));
    try { await rpc('sync_sms'); } catch (_) { /* 재시도 */ }
    const { data } = await sb.from('sms_log').select('status,error').eq('id', id).single();
    if (data && data.status === 'ok') { toast('테스트 문자를 보냈습니다. 휴대폰을 확인해 주세요.', 'ok'); return; }
    if (data && data.status === 'fail') { toast(`발송 실패 — ${data.error || '알 수 없는 오류'}`, 'error'); return; }
  }
  toast('발송 결과를 확인하지 못했습니다. 잠시 후 휴대폰을 확인해 주세요.', 'error');
}

const actions = {
  tab(el) {
    ui.tab = el.dataset.key;
    if (ui.tab === 'stats') ui.stats = null;
    if (ui.tab === 'settings') { ui.keyInfo = null; ui.accounts = null; }
    render();
  },
  async 'toggle-pause'() {
    const next = !ui.settings.paused;
    if (next) {
      const ok = await modal({
        title: '웨이팅 접수를 멈출까요?',
        message: '입구 태블릿에서 새 접수를 받지 않습니다. 이미 대기 중인 손님은 그대로입니다.',
        buttons: [{ label: '취소', value: false }, { label: '접수 중지', cls: 'btn-danger', value: true }],
      });
      if (!ok) return;
    }
    try {
      await rpc('set_paused', { p_paused: next });
      toast(next ? '웨이팅 접수를 중지했습니다' : '웨이팅 접수를 다시 시작했습니다', 'ok');
      refresh();
    } catch (err) { toast(err.message, 'error'); }
  },
  add() { addEntry(); },
  menu() { openMenu(); },
  call(el) { act(el.dataset.id, 'call'); },
  seat(el) { act(el.dataset.id, 'seat'); },
  noshow(el) { act(el.dataset.id, 'noshow'); },
  restore(el) { act(el.dataset.id, 'restore'); },
  more(el) { openEntryMenu(el.dataset.id); },
  'stats-range'(el) { ui.statsDays = Number(el.dataset.key); ui.stats = null; render(); },
  'stats-metric'(el) { ui.statsMetric = el.dataset.key; render(); },
  csv() { downloadCsv(); },
  'test-sms'() { testSms(); },
  async 'signout-all'() {
    const ok = await modal({
      title: '모든 기기에서 로그아웃할까요?',
      message: '이 사장님 계정으로 로그인한 모든 기기(이 기기 포함)가 로그아웃됩니다.<br>입구·카운터 태블릿은 위 표에서 권한을 끄면 바로 막을 수 있습니다.',
      buttons: [{ label: '취소', value: false }, { label: '모두 로그아웃', cls: 'btn-danger', value: true }],
    });
    if (ok) { await sb.auth.signOut({ scope: 'global' }); location.reload(); }
  },
  async logout() { await sb.auth.signOut({ scope: 'local' }); location.reload(); },
};

document.addEventListener('click', ev => {
  const el = ev.target.closest('[data-action]');
  if (!el || el.disabled) return;
  actions[el.dataset.action]?.(el, ev);
});

document.addEventListener('submit', async ev => {
  const form = ev.target;
  if (form.dataset.form === 'settings') {
    ev.preventDefault();
    const f = new FormData(form);
    const num = (k, min, max) => Math.min(max, Math.max(min, Number(f.get(k)) || 0));
    const patch = {
      store_name: String(f.get('store_name')).trim() || '그리운보리밥',
      noshow_minutes: num('noshow_minutes', 1, 60),
      max_teams: num('max_teams', 0, 500),
      close_time: f.get('close_time') || null,
      minutes_per_team: num('minutes_per_team', 1, 60),
      auto_estimate: f.get('auto_estimate') === 'on',
      sms_enabled: f.get('sms_enabled') === 'on',
      sms_from: String(f.get('sms_from')).replace(/\D/g, ''),
      soon_at: f.get('soon_at') === '' ? null : num('soon_at', 0, 5),
      site_url: String(f.get('site_url')).trim().replace(/\/$/, ''),
      menu_url: String(f.get('menu_url')).trim(),
      tpl_register: String(f.get('tpl_register')),
      tpl_soon: String(f.get('tpl_soon')),
      tpl_call: String(f.get('tpl_call')),
    };
    if (patch.menu_url && !/^https?:\/\//.test(patch.menu_url)) { toast('메뉴판 주소는 https:// 로 시작해야 합니다', 'error'); return; }
    if (patch.sms_enabled && !patch.sms_from) { toast('문자를 켜려면 발신번호를 입력해 주세요', 'error'); return; }
    const { data, error } = await sb.from('settings').update(patch).eq('id', 1).select();
    if (error || !data?.length) { toast(error ? friendlyError(error) : '저장 권한이 없습니다', 'error'); return; }
    ui.settings = data[0];
    toast('설정을 저장했습니다', 'ok');
    render();
  }
  if (form.dataset.form === 'keys') {
    ev.preventDefault();
    const key = form.key.value.trim(), secret = form.secret.value.trim();
    if (!key || !secret) { toast('API Key와 API Secret을 모두 입력해 주세요', 'error'); return; }
    try {
      await rpc('set_sms_keys', { p_key: key, p_secret: secret });
      form.key.value = ''; form.secret.value = '';
      ui.keyInfo = await rpc('sms_key_info');
      rerenderSettingsPart('keys');
      toast('API 키를 저장했습니다. 테스트 문자로 확인해 보세요.', 'ok');
    } catch (err) { toast(err.message, 'error'); }
  }
});

// 템플릿 바이트 수 실시간 표시, 계정 역할 변경
document.addEventListener('input', ev => {
  const t = ev.target;
  if (!t.matches('textarea[data-tpl]')) return;
  const form = t.closest('form');
  const s = { ...ui.settings, site_url: form.site_url.value, store_name: form.store_name.value, noshow_minutes: form.noshow_minutes.value };
  const n = smsBytes(sampleText(t.value, s));
  const out = document.querySelector(`[data-bytes-for="${t.name}"]`);
  out.textContent = bytesLabel(n);
  out.classList.toggle('over', n > 90);
});

document.addEventListener('change', async ev => {
  const t = ev.target;
  if (!t.dataset.account) return;
  const row = t.closest('tr');
  const role = row.querySelector('[data-field="role"]').value || null;
  const activeBox = row.querySelector('[data-field="active"]');
  const active = t.dataset.field === 'role' ? true : activeBox.checked;
  try {
    await rpc('set_account', { p_user: t.dataset.account, p_role: role, p_active: active });
    toast('기기 권한을 바꿨습니다', 'ok');
  } catch (err) {
    toast(err.message, 'error');
  }
  loadAccounts();
});

/* ---------- 차트 툴팁 ---------- */

const tip = document.createElement('div');
tip.className = 'chart-tip';
document.body.appendChild(tip);
document.addEventListener('pointerover', ev => {
  const el = ev.target.closest('[data-tip]');
  if (!el) { tip.classList.remove('show'); return; }
  tip.textContent = el.dataset.tip;
  tip.classList.add('show');
  const r = el.getBoundingClientRect();
  const x = Math.min(window.innerWidth - tip.offsetWidth - 8, Math.max(8, r.left + r.width / 2 - tip.offsetWidth / 2));
  const y = r.top - tip.offsetHeight - 8 < 8 ? r.bottom + 8 : r.top - tip.offsetHeight - 8;
  tip.style.transform = `translate(${x}px, ${y}px)`;
});

if (IS_CONFIGURED) bindLogin(app, () => { ui.loginError = ''; boot(); });
boot();
