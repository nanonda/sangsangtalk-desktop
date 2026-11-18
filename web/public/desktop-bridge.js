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

/* 3단계(p3-contract N2·N5·N7): notify의 선택 인자 sound·flash·urgent.
 * 데스크톱 명령이 새 인자를 받는다(11/18 데스크톱 보고). 예전 앱과 맞춰야 하면 false로 되돌린다. */
const DESKTOP_NOTIFY_EXTRAS = true;
const SOUNDS = new Set(["default", "im", "mail", "reminder", "none"]);

/** Windows(또는 브라우저) 알림. target은 누르면 열 해시 경로(예: "#/dm/5"). 데스크톱이 받는 길이·형식으로 맞춘다.
 *  sound("default"|"im"|"mail"|"reminder"|"none"), flash(작업표시줄 깜박임), urgent(중요 메시지)는 모두 선택이다. */
export function notify({ title, body, target, sound = "default", flash = true, urgent = false }) {
  const rawTarget = String(target || "");
  const payload = {
    title: clip(title || "상상톡", TITLE_MAX),
    body: clip(body, BODY_MAX),
    target: TARGET_PATTERN.test(rawTarget) ? rawTarget : "",
  };
  const extras = { sound: SOUNDS.has(sound) ? sound : "default", flash: flash !== false, urgent: urgent === true };
  const invoke = tauriInvoke();
  if (invoke) {
    call(invoke, "notify", DESKTOP_NOTIFY_EXTRAS ? { ...payload, ...extras } : payload);
    return;
  }
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    // 브라우저: 소리는 고를 수 없고 끄기만 된다. 중요 메시지는 닫을 때까지 남긴다(지원하는 브라우저만).
    const shown = new Notification(payload.title, {
      body: payload.body,
      tag: payload.target || undefined,
      silent: extras.sound === "none" && !extras.urgent,
      requireInteraction: extras.urgent,
    });
    shown.onclick = () => {
      window.focus();
      if (payload.target) location.hash = payload.target;
      shown.close();
    };
  } catch {
    // 일부 환경은 페이지에서 직접 Notification을 만들 수 없다.
  }
}

/** 앱 정보(p3-contract P5 app_info). 데스크톱 명령이 없거나 브라우저면 null. */
export async function appInfo() {
  const invoke = tauriInvoke();
  if (!invoke) return null;
  try {
    const info = await invoke("app_info");
    return info && typeof info === "object" ? { version: String(info.version || ""), captureBlock: Boolean(info.captureBlock) } : null;
  } catch {
    return null;
  }
}

/* P5 PC 앱 설정. 데스크톱 명령은 실패하면 한국어 문장으로 거절한다 → 그 문장을 Error로 바꿔 던진다.
 * 브라우저에서는 null을 돌려준다(PC 앱 탭은 숨는다). */
async function desktopCall(command, args) {
  const invoke = tauriInvoke();
  if (!invoke) return null;
  try {
    return await invoke(command, args);
  } catch (error) {
    const text = typeof error === "string" ? error : error?.message;
    throw new Error(text || "PC 앱 설정을 바꾸지 못했습니다.");
  }
}

export async function getAutostart() {
  const value = await desktopCall("get_autostart", {});
  return value === null ? null : Boolean(value);
}

export async function setAutostart(enabled) {
  return Boolean(await desktopCall("set_autostart", { enabled: Boolean(enabled) }));
}

export async function getCloseAction() {
  const value = await desktopCall("get_close_action", {});
  return value === "quit" ? "quit" : value === null ? null : "tray";
}

export async function setCloseAction(action) {
  const value = await desktopCall("set_close_action", { action: action === "quit" ? "quit" : "tray" });
  return value === "quit" ? "quit" : "tray";
}

function hotkeyOf(value) {
  // active: 실제로 등록되어 동작하는지(시작할 때 다른 프로그램이 쓰고 있으면 false). 없으면 동작하는 것으로 본다.
  return value && typeof value === "object"
    ? { enabled: Boolean(value.enabled), accelerator: String(value.accelerator || ""), active: value.active !== false }
    : null;
}

export async function getHotkey() {
  return hotkeyOf(await desktopCall("get_hotkey", {}));
}

/** accelerator를 빼면 지금 키를 그대로 쓴다. 실패하면 이전 등록이 유지된다(데스크톱). */
export async function setHotkey(enabled, accelerator) {
  const args = { enabled: Boolean(enabled) };
  if (accelerator) args.accelerator = String(accelerator);
  return hotkeyOf(await desktopCall("set_hotkey", args));
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
