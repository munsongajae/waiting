'use strict';

/* =========================================================
 * 입구 태블릿 — 손님 웨이팅 접수 화면
 * ========================================================= */

const IDLE_MS = 60 * 1000;
const DONE_SECONDS = 10;
const POLL_MS = 10 * 1000;

const app = document.getElementById('app');

const ui = {
  view: 'loading',  // loading | setup | login | norole | home | party | phone | done
  summary: null,
  offline: false,
  draft: null,
  result: null,
  doneLeft: DONE_SECONDS,
  lastInput: Date.now(),
  submitting: false,
  loginError: '',
  noRoleMessage: '',
};

let doneTimer = null;

/* ---------- 시작 ---------- */

async function boot() {
  if (!IS_CONFIGURED) { ui.view = 'setup'; render(); return; }
  const { loggedIn, role } = await currentRole();
  if (!loggedIn) { ui.view = 'login'; render(); return; }
  if (!['kiosk', 'owner', 'staff'].includes(role)) {
    ui.noRoleMessage = '이 계정에는 입구 태블릿 권한이 없습니다. 사장님 화면 → 설정 → 기기 관리에서 권한을 켜 주세요.';
    ui.view = 'norole'; render(); return;
  }
  await loadSummary();
  go('home');
}

async function loadSummary() {
  try {
    ui.summary = await rpc('queue_summary');
    ui.offline = false;
  } catch (err) {
    ui.offline = true;
    if (/권한/.test(err.message)) {
      ui.noRoleMessage = '이 태블릿의 권한이 꺼졌습니다. 사장님께 문의해 주세요.';
      ui.view = 'norole';
      render();
    }
  }
}

setInterval(async () => {
  if (!['home', 'party', 'phone', 'done'].includes(ui.view)) return;
  await loadSummary();
  if (ui.view === 'home') render();
  if (['party', 'phone'].includes(ui.view) && Date.now() - ui.lastInput > IDLE_MS) go('home');
}, POLL_MS);

['pointerdown', 'keydown'].forEach(t => document.addEventListener(t, () => { ui.lastInput = Date.now(); }, { passive: true }));

/* ---------- 화면 전환 ---------- */

function go(view) {
  ui.view = view;
  clearInterval(doneTimer);
  if (view === 'party') ui.draft = { adults: 2, kids: 0, phone: '010', agree: false };
  if (view === 'home') ui.draft = null;
  if (view === 'done') {
    ui.doneLeft = DONE_SECONDS;
    doneTimer = setInterval(() => {
      ui.doneLeft -= 1;
      if (ui.doneLeft <= 0) go('home');
      else { const el = document.getElementById('done-left'); if (el) el.textContent = ui.doneLeft; }
    }, 1000);
  }
  render();
}

function render() {
  const views = {
    loading: () => '<main class="screen center-screen"><p class="muted">불러오는 중…</p></main>',
    setup: setupNeededHtml,
    login: () => loginHtml('입구 태블릿 로그인', '처음 한 번만 로그인하면 계속 유지됩니다.<br>입구 태블릿용 계정으로 로그인해 주세요.', ui.loginError),
    norole: () => noRoleHtml(ui.noRoleMessage),
    home: viewHome, party: viewParty, phone: viewPhone, done: viewDone,
  };
  app.innerHTML = views[ui.view]();
  app.dataset.view = ui.view;
  if (ui.view === 'login') focusLogin();
}

/* ---------- 화면 ---------- */

function viewHome() {
  const s = ui.summary || { store_name: '그리운보리밥', waiting: 0, est_minutes: 0, calling: [] };
  const calling = s.calling || [];
  let action;
  if (ui.offline) {
    action = `<div class="paused-box">인터넷 연결을 확인하는 중입니다.<br>잠시 후 다시 시도해 주세요.</div>`;
  } else if (s.closed) {
    action = `<div class="paused-box">${esc(s.closed)}.<br>직원에게 문의해 주세요.</div>`;
  } else {
    action = `<button class="btn btn-hero" data-action="start">웨이팅 등록하기</button>
              <p class="hint">화면을 눌러 인원과 연락처를 입력해 주세요</p>`;
  }
  return `
  <main class="screen home">
    <section class="home-brand">
      <h1 class="logo-card" data-longpress="menu"><img src="/logo.gif" alt="${esc(s.store_name)}" draggable="false"></h1>
      <p class="tagline">방문해 주셔서 감사합니다</p>
    </section>
    <section class="home-panel">
      ${calling.length ? `
      <div class="now-calling" aria-live="polite">
        <span class="label">지금 입장 안내</span>
        <div class="numbers">${calling.map(n => `<b>${n}</b>`).join('')}</div>
      </div>` : ''}
      <div class="queue-card">
        <div class="queue-stat">
          <span class="label">현재 대기</span>
          <span class="value"><b>${s.waiting}</b>팀</span>
        </div>
        <div class="queue-divider"></div>
        <div class="queue-stat">
          <span class="label">예상 대기시간</span>
          <span class="value">${s.waiting ? `약 <b>${s.est_minutes}</b>분` : '<b>바로</b> 입장'}</span>
        </div>
      </div>
      ${s.waiting ? `<p class="est-note">${EST_NOTE}</p>` : ''}
      ${action}
    </section>
    <button class="kiosk-gear" data-longpress="menu" aria-label="태블릿 메뉴 (2초 길게 누르기)">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7zm7.4-2.5a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3h-4l-.3 2.9a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.7 1.7 1L11 21h4l.3-2.9c.6-.3 1.2-.6 1.7-1l2.5 1 2-3.5-2.1-1.6z" fill="currentColor"/></svg>
    </button>
  </main>`;
}

function stepHeader(step, title) {
  return `
  <header class="step-header">
    <button class="btn btn-ghost" data-action="home">✕ 취소</button>
    <div class="steps">
      <span class="${step === 1 ? 'on' : 'past'}">1 인원</span>
      <span class="${step === 2 ? 'on' : ''}">2 연락처</span>
    </div>
    <span class="step-spacer"></span>
  </header>
  <h2 class="step-title">${title}</h2>`;
}

function stepper(label, sub, key, value, min, max) {
  return `
  <div class="stepper-card">
    <div class="stepper-label"><b>${label}</b><span>${sub}</span></div>
    <div class="stepper">
      <button class="step-btn" data-action="dec" data-key="${key}" ${value <= min ? 'disabled' : ''} aria-label="${label} 빼기">−</button>
      <output>${value}</output>
      <button class="step-btn" data-action="inc" data-key="${key}" ${value >= max ? 'disabled' : ''} aria-label="${label} 더하기">+</button>
    </div>
  </div>`;
}

function viewParty() {
  const d = ui.draft;
  return `
  <main class="screen flow">
    ${stepHeader(1, '몇 분이 오셨나요?')}
    <div class="party-grid">
      ${stepper('성인', '초등학생 이상', 'adults', d.adults, 1, 20)}
      ${stepper('어린이', '미취학 아동', 'kids', d.kids, 0, 10)}
    </div>
    <footer class="flow-footer">
      <div class="total">총 <b>${d.adults + d.kids}</b>명</div>
      <button class="btn btn-primary btn-lg" data-action="to-phone">다음</button>
    </footer>
  </main>`;
}

function viewPhone() {
  const d = ui.draft;
  const valid = /^01[016789]\d{7,8}$/.test(d.phone);
  const shown = d.phone.length > 3
    ? fmtPhone(d.phone.padEnd(11, '_')).replace(/_/g, '<i>_</i>')
    : `${d.phone}-<i>____</i>-<i>____</i>`;
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'];
  return `
  <main class="screen flow">
    ${stepHeader(2, '휴대폰 번호를 입력해 주세요')}
    <div class="phone-grid">
      <section class="phone-left">
        <div class="phone-display ${valid ? 'ok' : ''}">${shown}</div>
        <div class="keypad">
          ${keys.map(k => k === 'clear'
            ? `<button class="key key-sub" data-action="key" data-key="clear">전체삭제</button>`
            : k === 'back'
              ? `<button class="key key-sub" data-action="key" data-key="back" aria-label="지우기">⌫</button>`
              : `<button class="key" data-action="key" data-key="${k}">${k}</button>`).join('')}
        </div>
      </section>
      <section class="phone-right">
        <div class="consent">
          <h3>개인정보 수집·이용 동의 <em>(필수)</em></h3>
          <dl>
            <dt>수집 항목</dt><dd>휴대폰 번호</dd>
            <dt>수집 목적</dt><dd>웨이팅 접수 및 입장 순서 문자 안내</dd>
            <dt>보유 기간</dt><dd>접수 당일 영업 종료 시 즉시 파기</dd>
          </dl>
          <p>동의를 거부하실 수 있으며, 거부 시 웨이팅 등록이 제한됩니다.<br>휴대폰 번호 없이 등록을 원하시면 직원에게 말씀해 주세요.</p>
        </div>
        <button class="agree ${d.agree ? 'on' : ''}" data-action="agree" role="checkbox" aria-checked="${d.agree}">
          <span class="box">${d.agree ? '✓' : ''}</span> 위 내용에 동의합니다
        </button>
        <div class="phone-actions">
          <button class="btn btn-ghost btn-lg" data-action="to-party">이전</button>
          <button class="btn btn-primary btn-lg" data-action="submit" ${valid && d.agree && !ui.submitting ? '' : 'disabled'}>
            ${ui.submitting ? '접수 중…' : '접수하기'}
          </button>
        </div>
      </section>
    </div>
  </main>`;
}

function viewDone() {
  const r = ui.result;
  const notice = r.sms
    ? '접수 문자를 보내드렸어요.<br>문자 속 링크에서 <b>내 순서</b>를 확인할 수 있습니다.'
    : '입장 차례가 되면 <b>번호를 불러</b> 드립니다.<br>매장 근처에서 기다려 주세요.';
  return `
  <main class="screen done" data-action="home">
    <p class="done-label">웨이팅 접수 완료</p>
    <div class="done-no"><b>${r.no}</b><span>번</span></div>
    <p class="done-meta">앞 대기 <b>${r.ahead}</b>팀 · ${r.ahead ? `예상 약 <b>${r.est_minutes}</b>분` : '다음 차례'}</p>
    ${r.ahead ? `<p class="est-note">${EST_NOTE}</p>` : ''}
    <p class="done-notice">${notice}</p>
    <button class="btn btn-primary btn-lg">확인 <small>(<span id="done-left">${ui.doneLeft}</span>)</small></button>
  </main>`;
}

/* ---------- 동작 ---------- */

async function submit() {
  const d = ui.draft;
  ui.submitting = true;
  render();
  let r;
  try {
    r = await rpc('register_entry', { p_adults: d.adults, p_kids: d.kids, p_phone: d.phone });
  } catch (err) {
    ui.submitting = false;
    render();
    await modal({
      title: '접수하지 못했습니다',
      message: `${esc(err.message)}<br>잠시 후 다시 시도하시거나 직원에게 말씀해 주세요.`,
      buttons: [{ label: '확인', cls: 'btn-primary', value: true }],
    });
    return;
  }
  ui.submitting = false;

  if (!r.ok) {
    const messages = {
      duplicate: ['이미 대기 중인 번호입니다', `이 번호로 <b>${r.no}번</b> 웨이팅이 등록되어 있습니다.<br>변경이 필요하시면 직원에게 말씀해 주세요.`],
      closed: ['지금은 접수할 수 없습니다', esc(r.message || '')],
      invalid_phone: ['휴대폰 번호를 확인해 주세요', '010으로 시작하는 번호를 입력해 주세요.'],
    };
    const [title, message] = messages[r.error] || ['접수하지 못했습니다', '직원에게 말씀해 주세요.'];
    render();
    await modal({ title, message, buttons: [{ label: '확인', cls: 'btn-primary', value: true }] });
    if (r.error === 'closed') { await loadSummary(); go('home'); }
    return;
  }

  ui.result = r;
  go('done');
  loadSummary();
}

async function openMenu() {
  const v = await modal({
    title: '태블릿 메뉴',
    buttons: [
      { label: '닫기', value: null },
      { label: '새로고침', value: 'reload' },
      { label: '전체화면', value: 'fullscreen' },
      { label: '로그아웃', cls: 'btn-danger', value: 'logout' },
    ],
  });
  if (v === 'reload') location.reload();
  if (v === 'fullscreen') toggleFullscreen();
  if (v === 'logout') {
    const ok = await modal({
      title: '로그아웃할까요?',
      message: '다시 사용하려면 입구 태블릿 계정으로 로그인해야 합니다.',
      buttons: [{ label: '취소', value: false }, { label: '로그아웃', cls: 'btn-danger', value: true }],
    });
    if (ok) { await sb.auth.signOut({ scope: 'local' }); location.reload(); }
  }
}

const actions = {
  start() { if (ui.summary && !ui.summary.closed && !ui.offline) go('party'); },
  home() { go('home'); },
  'to-party'() { ui.view = 'party'; render(); },
  'to-phone'() { ui.view = 'phone'; render(); },
  inc(el) {
    const k = el.dataset.key;
    ui.draft[k] = Math.min(k === 'adults' ? 20 : 10, ui.draft[k] + 1);
    render();
  },
  dec(el) {
    const k = el.dataset.key;
    ui.draft[k] = Math.max(k === 'adults' ? 1 : 0, ui.draft[k] - 1);
    render();
  },
  key(el) {
    const k = el.dataset.key, d = ui.draft;
    if (k === 'back') d.phone = d.phone.slice(0, -1);
    else if (k === 'clear') d.phone = '';
    else if (d.phone.length < 11) d.phone += k;
    render();
  },
  agree() { ui.draft.agree = !ui.draft.agree; render(); },
  submit() { if (!ui.submitting) submit(); },
  async logout() { await sb.auth.signOut({ scope: 'local' }); location.reload(); },
};

document.addEventListener('click', ev => {
  const el = ev.target.closest('[data-action]');
  if (!el || el.disabled) return;
  actions[el.dataset.action]?.(el, ev);
});

// 왼쪽 아래 톱니바퀴(또는 매장 이름)를 2초 길게 누르면 태블릿 메뉴 — 짧게 누르면 반응 없음 (손님이 우연히 열지 않도록)
let pressTimer = null;
document.addEventListener('pointerdown', ev => {
  if (!ev.target.closest('[data-longpress="menu"]')) return;
  clearTimeout(pressTimer);
  pressTimer = setTimeout(openMenu, 2000);
});
['pointerup', 'pointercancel', 'pointerleave'].forEach(t => document.addEventListener(t, () => clearTimeout(pressTimer)));
// 길게 누를 때 안드로이드 기본 메뉴(복사·선택 등)가 뜨지 않도록
document.addEventListener('contextmenu', ev => ev.preventDefault());

if (IS_CONFIGURED) bindLogin(app, () => { ui.loginError = ''; boot(); });
boot();
