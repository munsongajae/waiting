'use strict';

/* =========================================================
 * 손님 휴대폰 — 문자 링크로 여는 '내 순서 확인' 화면 (로그인 없음)
 * ========================================================= */

const app = document.getElementById('app');
const token = (location.pathname.match(/\/s\/([A-Za-z0-9]+)/) || [])[1]
  || new URLSearchParams(location.search).get('t');

let info = null;
let lastStatus = null;
let busy = false;

async function load() {
  if (!IS_CONFIGURED || !token) { info = null; render(); return; }
  try {
    info = await rpc('entry_status', { p_token: token });
    app.classList.remove('stale');
  } catch (_) {
    app.classList.add('stale'); // 연결이 끊겨도 마지막 정보는 계속 보여줌
    return;
  }
  if (info && lastStatus === 'waiting' && info.status === 'called' && navigator.vibrate) {
    navigator.vibrate([300, 150, 300]);
  }
  lastStatus = info?.status;
  render();
}

function render() {
  if (!info) {
    app.innerHTML = `
      <main class="status-page">
        <div class="status-card">
          <h1>웨이팅 정보를 찾을 수 없습니다</h1>
          <p class="muted">링크는 접수한 당일에만 확인할 수 있습니다.<br>궁금한 점은 매장 직원에게 문의해 주세요.</p>
        </div>
      </main>`;
    return;
  }
  const i = info;
  let body;
  if (i.status === 'waiting') {
    body = `
      <div class="status-ahead">
        ${i.ahead ? `내 앞에 <b>${i.ahead}</b>팀` : '<b>다음 차례</b>입니다'}
      </div>
      <p class="status-sub">${i.ahead ? `예상 대기 약 <b>${i.est_minutes}</b>분 · ` : ''}차례가 되면 문자로 알려드립니다</p>
      <div class="status-actions">
        ${i.can_postpone ? '<button class="btn btn-outline btn-lg" data-action="postpone">순서 한 칸 미루기</button>' : ''}
        <button class="btn btn-ghost btn-lg" data-action="cancel">웨이팅 취소</button>
      </div>`;
  } else if (i.status === 'called') {
    body = `
      <div class="status-called">지금 입장해 주세요!</div>
      <p class="status-sub"><b>${i.noshow_minutes}분</b> 안에 매장 입구로 와주세요.<br>늦으시면 다음 순서로 넘어갈 수 있습니다.</p>
      <div class="status-actions">
        <button class="btn btn-ghost btn-lg" data-action="cancel">웨이팅 취소</button>
      </div>`;
  } else if (i.status === 'seated') {
    body = `<div class="status-done">입장하셨습니다</div><p class="status-sub">맛있게 드세요. 방문해 주셔서 감사합니다.</p>`;
  } else {
    body = `<div class="status-done">취소된 웨이팅입니다</div><p class="status-sub">다시 이용하시려면 매장 입구 태블릿에서 접수해 주세요.</p>`;
  }
  app.innerHTML = `
    <main class="status-page">
      <div class="status-card ${i.status}">
        <p class="status-store">${esc(i.store_name)}</p>
        <div class="status-no"><b>${i.no}</b><span>번</span></div>
        <p class="status-party">${i.party}명</p>
        ${body}
      </div>
      <p class="status-foot muted">이 화면은 자동으로 새로고침됩니다</p>
    </main>`;
}

document.addEventListener('click', async ev => {
  const el = ev.target.closest('[data-action]');
  if (!el || busy) return;
  const action = el.dataset.action;
  const confirmText = action === 'cancel'
    ? { title: '웨이팅을 취소할까요?', message: '취소하면 되돌릴 수 없고, 다시 접수하면 맨 뒤 순서가 됩니다.', ok: '웨이팅 취소' }
    : { title: '순서를 한 칸 미룰까요?', message: '바로 뒤 손님과 순서를 바꿉니다. 일행이 아직 도착하지 않았을 때 사용하세요. (최대 2번)', ok: '미루기' };
  const ok = await modal({
    title: confirmText.title,
    message: confirmText.message,
    buttons: [{ label: '닫기', value: false }, { label: confirmText.ok, cls: action === 'cancel' ? 'btn-danger' : 'btn-primary', value: true }],
  });
  if (!ok) return;
  busy = true;
  try {
    const done = await rpc(action === 'cancel' ? 'customer_cancel' : 'customer_postpone', { p_token: token });
    toast(done ? (action === 'cancel' ? '웨이팅을 취소했습니다' : '순서를 한 칸 미뤘습니다') : '처리할 수 없는 상태입니다', done ? 'ok' : 'error');
  } catch (err) {
    toast(err.message, 'error');
  }
  busy = false;
  load();
});

load();
setInterval(load, 15 * 1000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(); });
