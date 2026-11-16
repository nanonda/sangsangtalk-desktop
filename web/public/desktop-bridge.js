/* 상상톡 웹 ↔ 데스크톱(Tauri) 연결 (docs/p0-contract.md E).
 * 데스크톱 셸이면 Tauri 명령(notify, set_unread)을 쓰고,
 * 아니면 브라우저 Notification(권한이 있을 때)으로 대신하며, 둘 다 없으면 아무것도 하지 않는다. */

const TITLE_MAX = 60;
const BODY_MAX = 200;
const TARGET_PATTERN = /^#\/[A-Za-z0-9/_-]{0,62}$/;

function tauriInvoke() {
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  return typeof invoke === "function" ? invoke : null;
}

/** 코드포인트 기준으로 자른다(서로게이트 쌍을 반으로 가르지 않는다). */
function clip(text, max) {
  const chars = Array.from(String(text || ""));
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
}

function call(invoke, command, args) {
  try {
    return Promise.resolve(invoke(command, args)).then(() => true, () => false);
  } catch {
    // 데스크톱 쪽 명령이 없거나 막혀 있어도 웹 화면은 그대로 동작한다.
    return Promise.resolve(false);
  }
}

export function isDesktop() {
  return Boolean(tauriInvoke());
}

/** Windows(또는 브라우저) 알림. target은 누르면 열 해시 경로(예: "#/dm/5"). 데스크톱이 받는 길이·형식으로 맞춘다. */
export function notify({ title, body, target }) {
  const rawTarget = String(target || "");
  const payload = {
    title: clip(title || "상상톡", TITLE_MAX),
    body: clip(body, BODY_MAX),
    target: TARGET_PATTERN.test(rawTarget) ? rawTarget : "",
  };
  const invoke = tauriInvoke();
  if (invoke) {
    call(invoke, "notify", payload);
    return;
  }
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const shown = new Notification(payload.title, { body: payload.body, tag: payload.target || undefined });
    shown.onclick = () => {
      window.focus();
      if (payload.target) location.hash = payload.target;
      shown.close();
    };
  } catch {
    // 일부 환경은 페이지에서 직접 Notification을 만들 수 없다.
  }
}

let lastUnread = null;
let pendingUnread = null;

/** 안읽음 수를 트레이(데스크톱) 또는 탭 제목(브라우저)에 알린다. 같은 값은 다시 보내지 않고, 실패하면 다음에 다시 보낸다. */
export function setUnread(count) {
  const value = Math.max(0, Math.floor(Number(count) || 0));
  if (value === lastUnread || value === pendingUnread) return;
  const invoke = tauriInvoke();
  if (invoke) {
    pendingUnread = value;
    call(invoke, "set_unread", { count: value }).then((ok) => {
      if (pendingUnread === value) pendingUnread = null;
      if (ok) lastUnread = value;
    });
    return;
  }
  lastUnread = value;
  document.title = value ? `(${value > 99 ? "99+" : value}) 상상톡` : "상상톡";
}

/** 브라우저에서만: 사용자 동작 이벤트 안에서 동기적으로 불러야 권한 창이 뜬다. 물을 필요가 없으면 false. */
export function askNotifyPermission() {
  if (tauriInvoke() || !("Notification" in window) || Notification.permission !== "default") return false;
  try {
    const asked = Notification.requestPermission();
    if (asked && typeof asked.catch === "function") asked.catch(() => {});
  } catch {
    // 오래된 브라우저는 권한 요청을 지원하지 않는다.
  }
  return true;
}

/** 로그인할 때 등에서 다시 보내도록 기억한 값을 지운다. */
export function resetUnread() {
  lastUnread = null;
  pendingUnread = null;
}
