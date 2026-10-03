'use strict';

/* 입구·관리자·손님 화면이 함께 쓰는 기능 */

const CFG = window.WAITING_CONFIG || {};
const IS_CONFIGURED = !!CFG.supabaseUrl && !CFG.supabaseUrl.includes('YOUR_') && !!window.supabase;
const sb = IS_CONFIGURED ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey) : null;

const EST_NOTE = '예상 시간은 참고용이며, 매장 상황에 따라 달라질 수 있습니다.';

/* ---------- 형식 ---------- */

function pad(n) { return String(n).padStart(2, '0'); }

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtPhone(p) {
  if (!p) return '';
  if (p.length === 11) return `${p.slice(0, 3)}-${p.slice(3, 7)}-${p.slice(7)}`;
  if (p.length === 10) return `${p.slice(0, 3)}-${p.slice(3, 6)}-${p.slice(6)}`;
  return p;
}

function fmtTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function minsSince(ts) { return Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 60000)); }

// 한국 날짜 (YYYY-MM-DD) — 태블릿 시간대 설정과 무관하게
function kstDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(d);
}

// 문자 요금 기준 바이트 (한글 2바이트). 90바이트 초과 시 장문(LMS)
function smsBytes(text) {
  let n = 0;
  for (const ch of text) n += ch.charCodeAt(0) > 127 ? 2 : 1;
  return n;
}

/* ---------- 서버 호출 ---------- */

function friendlyError(err) {
  const msg = (err && (err.message || err.error_description)) || String(err);
  if (/Failed to fetch|NetworkError|network|Load failed/i.test(msg)) return '인터넷 연결을 확인해 주세요';
  if (/Invalid login credentials/i.test(msg)) return '이메일 또는 비밀번호가 맞지 않습니다';
  if (/JWT|not authenticated/i.test(msg)) return '로그인이 만료되었습니다. 다시 로그인해 주세요';
  return msg;
}

async function rpc(name, args) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw new Error(friendlyError(error));
  return data;
}

/* ---------- 토스트 / 모달 ---------- */

function toastRoot() {
  let el = document.getElementById('toasts');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toasts';
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  return el;
}

// opts: { type: 'info'|'ok'|'error', action: { label, fn }, ms }
function toast(msg, opts = {}) {
  const type = typeof opts === 'string' ? opts : (opts.type || 'info');
  const ms = opts.ms || (type === 'error' ? 6000 : opts.action ? 5000 : 2500);
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span>${esc(msg)}</span>`;
  if (opts.action) {
    const b = document.createElement('button');
    b.className = 'toast-action';
    b.textContent = opts.action.label;
    b.onclick = () => { el.remove(); opts.action.fn(); };
    el.appendChild(b);
  }
  toastRoot().appendChild(el);
  setTimeout(() => el.classList.add('hide'), ms);
  setTimeout(() => el.remove(), ms + 500);
}

// buttons: [{ label, cls, value }] — 누른 버튼의 value로 resolve. stack: 버튼을 세로로 한 줄씩
function modal({ title, message, body, buttons, stack }) {
  let root = document.getElementById('modal-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'modal-root';
    document.body.appendChild(root);
  }
  return new Promise(resolve => {
    root.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal" role="dialog" aria-modal="true">
          ${title ? `<h3>${title}</h3>` : ''}
          ${message ? `<p>${message}</p>` : ''}
          ${body || ''}
          <div class="modal-actions${stack ? ' stack' : ''}">
            ${buttons.map((b, i) => `<button type="button" class="btn ${b.cls || 'btn-outline'} btn-lg" data-modal="${i}">${b.label}</button>`).join('')}
          </div>
        </div>
      </div>`;
    root.onclick = ev => {
      const b = ev.target.closest('[data-modal]');
      if (!b) return;
      const form = root.querySelector('.modal');
      const value = buttons[Number(b.dataset.modal)].value;
      let result = value;
      if (typeof value === 'function') {
        result = value(form);
        if (result === false) return; // 입력 검증 실패 시 모달 유지 (함수 버튼에만 해당)
      }
      root.innerHTML = '';
      root.onclick = null;
      resolve(result);
    };
  });
}

/* ---------- 태블릿 운영 보조 ---------- */

let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && !wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (_) { /* 지원하지 않거나 거부됨 */ }
}
document.addEventListener('visibilitychange', keepAwake);
document.addEventListener('pointerdown', keepAwake, { passive: true });

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => toast('이 브라우저에서는 전체화면을 지원하지 않습니다', 'error'));
}

// 새 손님 알림음 (띵-동). 브라우저 정책상 화면을 한 번 누른 뒤부터 소리가 납니다.
let audioCtx = null;
document.addEventListener('pointerdown', () => {
  if (!audioCtx && (window.AudioContext || window.webkitAudioContext)) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
}, { passive: true });

function chime() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  [[880, 0], [660, 0.28]].forEach(([freq, at]) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = freq;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.0001, t + at);
    gain.gain.exponentialRampToValueAtTime(0.4, t + at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.6);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t + at);
    osc.stop(t + at + 0.65);
  });
}

/* ---------- 로그인 ---------- */

function setupNeededHtml() {
  return `
  <main class="screen center-screen">
    <div class="card narrow">
      <h2>Supabase 연결 정보가 필요합니다</h2>
      <p class="muted"><code>config.js</code> 파일에 Supabase 프로젝트 주소와 공개 키를 넣어 주세요.</p>
    </div>
  </main>`;
}

// 입구·관리자 화면별로 마지막 로그인 이메일을 기억 (비밀번호는 저장하지 않고 브라우저 비밀번호 관리자에 맡김)
const EMAIL_KEY = `waiting.email:${location.pathname.includes('admin') ? 'admin' : 'kiosk'}`;

function savedEmail() {
  try { return localStorage.getItem(EMAIL_KEY) || ''; } catch (_) { return ''; }
}

// 한 번이라도 로그인했는지 — 처음에는 '아이디 저장'을 기본으로 체크, 이후에는 마지막 선택을 따름
function localStorageUsed() {
  try { return localStorage.getItem('waiting.emailPref') === '1'; } catch (_) { return false; }
}

function loginHtml(title, hint, error) {
  const email = savedEmail();
  return `
  <main class="screen center-screen">
    <form class="card narrow login" data-form="login" autocomplete="on">
      <h2>${esc(title)}</h2>
      <p class="muted">${hint}</p>
      <label class="field"><span>이메일</span><input id="login-email" name="email" type="email" autocomplete="username" value="${esc(email)}" required></label>
      <label class="field"><span>비밀번호</span><input id="login-password" name="password" type="password" autocomplete="current-password" required></label>
      <label class="check remember"><input type="checkbox" name="remember" ${email || !localStorageUsed() ? 'checked' : ''}><span>아이디 저장</span></label>
      <p class="form-error">${error ? esc(error) : ''}</p>
      <button class="btn btn-primary btn-lg" type="submit">로그인</button>
    </form>
  </main>`;
}

function noRoleHtml(message) {
  return `
  <main class="screen center-screen">
    <div class="card narrow">
      <h2>이 계정으로는 사용할 수 없습니다</h2>
      <p class="muted">${message}</p>
      <button class="btn btn-outline btn-lg" data-action="logout">다른 계정으로 로그인</button>
    </div>
  </main>`;
}

// 저장된 이메일이 있으면 비밀번호 칸에 바로 커서 (화면을 그린 직후 호출)
function focusLogin() {
  const f = document.querySelector('form[data-form="login"]');
  if (f && f.email.value) f.password.focus();
}

// 로그인 폼 처리. 성공하면 onDone() 호출
function bindLogin(container, onDone) {
  container.addEventListener('submit', async ev => {
    if (ev.target.dataset.form !== 'login') return;
    ev.preventDefault();
    const f = new FormData(ev.target);
    const email = String(f.get('email')).trim();
    const password = String(f.get('password'));
    const btn = ev.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    const { error } = await sb.auth.signInWithPassword({ email, password });
    btn.disabled = false;
    if (error) {
      ev.target.querySelector('.form-error').textContent = friendlyError(error);
      return;
    }
    try {
      localStorage.setItem('waiting.emailPref', '1');
      if (f.get('remember')) localStorage.setItem(EMAIL_KEY, email);
      else localStorage.removeItem(EMAIL_KEY);
    } catch (_) { /* 저장공간을 쓸 수 없으면 기억하지 않음 */ }
    // 크롬 등에서 "비밀번호를 저장할까요?"를 띄움 — 저장 여부는 사용자가 결정하고, 비밀번호는 브라우저가 암호화해 보관
    if (window.PasswordCredential && navigator.credentials) {
      navigator.credentials.store(new PasswordCredential({ id: email, password, name: email })).catch(() => {});
    }
    onDone();
  });
}

async function currentRole() {
  const { data } = await sb.auth.getSession();
  if (!data.session) return { loggedIn: false, role: null };
  try {
    return { loggedIn: true, role: await rpc('my_role') };
  } catch (err) {
    return { loggedIn: true, role: null, error: err.message };
  }
}
