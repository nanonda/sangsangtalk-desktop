// 데스크톱 연결 파일을 못 읽어도(예: 서버에 아직 등록 안 됨) 화면은 떠야 하므로 동적으로 불러온다.
const bridge = await import("./desktop-bridge.js").catch(() => null);
const notify = bridge?.notify || (() => {});
const setUnread = bridge?.setUnread || (() => {});
const askNotifyPermission = bridge?.askNotifyPermission || (() => {});
const isDesktopApp = () => Boolean(bridge?.isDesktop?.());

/* P2 화면: <html data-theme data-font data-density>. data-theme에는 light|dark만 넣는다(system은 matchMedia로 푼다).
 * 마지막 값은 localStorage에 둔다(개인정보 아님). 로그인 전 화면도 이 값으로 그린다. */
const DISPLAY_KEY = "sangsangtalk.display";
const darkQuery = window.matchMedia?.("(prefers-color-scheme: dark)") || null;
let displayNow = (() => {
  try {
    const value = JSON.parse(localStorage.getItem(DISPLAY_KEY) || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
})();

function applyDisplay(display = displayNow) {
  const pick = (value, list, fallback) => (list.includes(value) ? value : fallback);
  displayNow = {
    theme: pick(display?.theme, ["system", "light", "dark"], "light"),
    fontSize: pick(display?.fontSize, ["small", "normal", "large"], "normal"),
    density: pick(display?.density, ["comfortable", "compact"], "comfortable"),
  };
  const root = document.documentElement;
  root.dataset.theme = displayNow.theme === "system" ? (darkQuery?.matches ? "dark" : "light") : displayNow.theme;
  root.dataset.font = displayNow.fontSize;
  root.dataset.density = displayNow.density;
  try {
    localStorage.setItem(DISPLAY_KEY, JSON.stringify(displayNow));
  } catch {
    // 저장하지 못하면 다음 시작 때 기본값으로 그린다.
  }
}
darkQuery?.addEventListener?.("change", () => applyDisplay());
applyDisplay();

const state = {
  me: null,
  messages: [],
  hasOlder: false,
  loadingOlder: false,
  olderError: "",
  loading: false,
  loadError: "",
  sendingKeys: new Set(),
  sendErrors: {},
  drafts: {},
  sessionGen: 0,
  authBusy: false,
  pollToken: null,
  view: "talk",
  selectedUser: null,
  selectedGroup: null,
  people: [],
  groups: [],
  directoryLoading: false,
  directoryError: "",
  noteStatus: "",
  chooserUser: null,
  noteUser: null,
  noteSending: false,
  noteRecords: [],
  noteRecordsLoaded: false,
  noteMessages: [],
  notesError: "",
  dmCache: {},
  readCursor: {},
  groupCache: {},
  groupRead: {},
  previewGeneration: 0,
  selectedNotePeer: null,
  noteFilter: "all",
  talkFilter: "all",
  query: "",
  generalLast: null,
  generalUnread: 0,
  generalRead: null,
  live: false,
  presence: {},
  presenceLoaded: false,
  myStatus: "active",
  groupDialog: { mode: "create", picked: new Set() },
  // 2-A
  hasNewer: false,
  loadingNewer: false,
  pendingJump: null,
  jump: null, // { id, words } 검색 결과로 연 메시지
  notice: null, // 열린 대화의 공지 { message, setByName, setAt }
  noticeOpen: false,
  noticeHidden: new Set(), // 내 화면에서만 닫은 공지
  compose: null, // { mode: "reply" | "edit", message, key, draft }
  generalMention: false,
  search: { tab: null, results: [], hasOlder: false, loading: false, error: "", gen: 0, activeId: null, roomCount: 0, ran: "" },
  inSearch: { open: false, query: "", hits: [], hasOlder: false, index: -1, loading: false, error: "", gen: 0, ran: "" },
  // 2-B
  statuses: {}, // userId -> { code, text } 수동 상태
  // 3단계 필드는 normalizePrefs가 채운다(여기는 첫 응답 전 값).
  prefs: {
    favorites: [], muted: [], dnd: { enabled: false, from: "18:00", to: "09:00", weekends: true },
    notify: { preview: "full", sound: "default", flash: true, snoozeUntil: null, replyBypassMute: true }, locked: [],
  },
  scheduled: [],
  schedOpen: false,
  starredOpen: false,
  starred: { messages: [], hasOlder: false, loading: false, error: "", gen: 0 },
  drawer: { open: false, tab: "photos", files: [], hasOlder: false, loading: false, error: "", gen: 0 },
  // 2-C
  locked: false,
  pwForced: false,
};

const TURTLE = "/assets/turtle-front.png";
const GENERAL_NAME = "general";
const GROUP_TOPIC = "대화";
const MAX_UPLOAD_MB = 100;
const BLOCKED_EXT = new Set(["exe", "bat", "cmd", "ps1", "js", "vbs", "msi", "scr", "com", "jar"]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
const IDLE_AFTER_MS = 10 * 60 * 1000;
const EDIT_LIMIT_SEC = 600; // 수정·회수는 보낸 뒤 10분 안(Zulip 수정 제한과 같음)
const RECALLED_TEXT = "회수된 메시지입니다";
const RECEIPT_EVERY_MS = 30 * 1000;
const PRESENCE_EVERY_MS = 60 * 1000;
const PRESENCE = {
  active: { label: "사용 중", cls: "" },
  idle: { label: "자리비움", cls: "idle" },
  offline: { label: "오프라인", cls: "off" },
};

let pollAbort = null;
let personClickTimer = 0;
let restoreChooserFocus = true;
let pendingHash = "";
let groupsReloadTimer = 0;

const $ = (selector) => document.querySelector(selector);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function iconUse(id) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "i");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#${id}`);
  svg.append(use);
  return svg;
}

function setMode(mode) {
  document.body.classList.toggle("mode-chat", mode === "chat");
  document.body.classList.toggle("mode-login", mode === "login");
  $("#login-view").hidden = mode !== "login";
  $("#chat-view").hidden = mode !== "chat";
}

function stopPoll() {
  state.pollToken = null;
  if (pollAbort) pollAbort.abort();
  pollAbort = null;
}

function setLoginError(message) {
  $("#login-error").textContent = message || "";
}

function setLive(message, isError) {
  const node = $("#live-status");
  if (!node) return;
  $("#live-text").textContent = message;
  node.classList.toggle("is-error", Boolean(isError));
  state.live = !isError && message === "실시간";
  state.liveError = Boolean(isError);
  renderMyPresence();
  if (state.me) updateHead();
}

function renderMyPresence() {
  const dot = $("#me-dot");
  const status = state.liveError ? "offline" : state.myStatus;
  if (dot) dot.className = `dot ${PRESENCE[status].cls}`.trim();
  const label = state.liveError ? "연결 안 됨" : PRESENCE[status].label;
  const me = $("#me");
  const manual = state.me ? manualStatus(state.me.userId) : null;
  const def = STATUS_CODES.find((item) => item.code === manual?.code);
  if (me && state.me) {
    me.title = [state.me.fullName || state.me.email, label, def?.label, manual?.text].filter(Boolean).join(" · ");
    me.setAttribute("aria-label", `내 상태 바꾸기, ${me.title}`);
  }
  const text = $("#me-label");
  if (text) {
    text.replaceChildren();
    // B2: 수동 상태가 있으면 "사용 중" 자리를 상태 칩으로 바꾼다.
    const chip = state.me && def && !state.liveError ? statusChip(state.me.userId) : null;
    if (chip) text.append(chip);
    else text.textContent = state.me ? label : "";
  }
}

/* 서버 호출: 401이면 로그인 화면으로 돌아가고 오류를 던진다. */
class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function api(method, path, body) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers["content-type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    showLogin("다시 로그인해 주세요.");
    throw new ApiError("다시 로그인해 주세요.", 401);
  }
  if (guardResponse(response.status, data)) throw new ApiError(data.error || "", response.status);
  if (!response.ok) throw new ApiError(data.error || "요청을 처리하지 못했습니다.", response.status);
  return data;
}

/* 서버가 잠김(423)이나 비밀번호 변경 필요(403 mustChangePassword)로 막았으면 그 화면을 띄운다. 막혔으면 true. */
function guardResponse(status, data) {
  if (!state.me) return false;
  if (status === 423 && data?.locked) {
    lockScreen({ fromServer: true });
    return true;
  }
  if (status === 403 && data?.mustChangePassword) {
    state.me.mustChangePassword = true;
    if (!state.pwForced) openPasswordChange({ forced: true });
    return true;
  }
  return false;
}

function roleLabel(role) {
  return {
    owner: "소유자",
    admin: "관리자",
    moderator: "중재자",
    guest: "손님",
    member: "구성원",
  }[role] || "구성원";
}

function personTitle(person) {
  const title = typeof person?.title === "string" ? person.title.trim() : "";
  return title || roleLabel(person?.role);
}

function personById(userId) {
  return state.people.find((person) => person.userId === userId) || null;
}

function groupById(groupId) {
  return state.groups.find((group) => group.groupId === groupId) || null;
}

function nameOf(userId) {
  if (userId === state.me?.userId) return state.me.fullName || "나";
  return personById(userId)?.fullName || "알 수 없음";
}

/* ───────── 근무 상태 ───────── */

function presenceOf(userId) {
  if (!state.presenceLoaded || !userId) return null;
  if (userId === state.me?.userId) return state.liveError ? "offline" : state.myStatus;
  const value = state.presence[String(userId)];
  return PRESENCE[value] ? value : "offline";
}

function presenceDot(userId, small) {
  const status = presenceOf(userId);
  if (!status) return null;
  const dot = el("span", `dot ${PRESENCE[status].cls}${small ? " sm" : ""}`.replace(/\s+/g, " ").trim());
  // 색만으로 구분하지 않도록 점 가까이에 상태 글자(statusText)를 함께 쓴다.
  dot.setAttribute("aria-hidden", "true");
  return dot;
}

function statusText(userId) {
  const status = presenceOf(userId);
  if (!status) return null;
  return el("span", `st ${PRESENCE[status].cls}`.trim(), PRESENCE[status].label);
}

/* 아바타: 프로필 사진이 있으면 사진, 없으면 거북이(시안 규칙). 상태를 알면 오른쪽 아래 점. */
function avatar(person, { small = false, size = "" } = {}) {
  const node = el("span", `av ${size || (small ? "sm" : "")}`.trim());
  node.setAttribute("aria-hidden", "true");
  const img = document.createElement("img");
  img.alt = "";
  if (person?.avatarUrl) {
    node.classList.add("photo");
    img.src = person.avatarUrl;
    img.addEventListener("error", () => {
      node.classList.replace("photo", "turtle");
      img.src = TURTLE;
    }, { once: true });
  } else {
    node.classList.add("turtle");
    img.src = TURTLE;
  }
  node.append(img);
  return node;
}

function personAvatar(person, { small = false, size = "" } = {}) {
  const face = avatar(person, { small, size });
  const dot = person ? presenceDot(person.userId, small || Boolean(size)) : null;
  if (!dot) return face;
  const wrap = el("span", `avwrap ${size || (small ? "sm" : "")}`.trim());
  wrap.append(face, dot);
  return wrap;
}

function groupAvatar(small) {
  const node = el("span", small ? "av sm group" : "av group");
  node.setAttribute("aria-hidden", "true");
  node.append(iconUse("ico-group"));
  return node;
}

function deptAvatar() {
  const node = el("span", "av dept");
  node.setAttribute("aria-hidden", "true");
  node.append(iconUse("ico-dept"));
  return node;
}

function formatTime(unix) {
  return new Intl.DateTimeFormat("ko-KR", { hour: "numeric", minute: "2-digit" }).format(new Date(unix * 1000));
}

function formatDay(unix) {
  return new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "long", day: "numeric", weekday: "long" }).format(new Date(unix * 1000));
}

function dayKey(unix) {
  const date = new Date(unix * 1000);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function formatListTime(unix) {
  const date = new Date(unix * 1000);
  const now = new Date();
  if (dayKey(unix) === dayKey(now.getTime() / 1000)) return formatTime(unix);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (dayKey(unix) === dayKey(yesterday.getTime() / 1000)) return "어제";
  return new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric" }).format(date);
}

function timeNode(unix, className) {
  const time = el("time", className, formatTime(unix));
  time.dateTime = new Date(unix * 1000).toISOString();
  return time;
}

function formatSize(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes === 0) return "0KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
}

function extOf(name) {
  const match = /\.([^.\\/]+)$/.exec(name || "");
  return match ? match[1].toLowerCase() : "";
}

function isImage(name, type) {
  return IMAGE_EXT.has(extOf(name)) || /^image\/(png|jpe?g|gif|webp|bmp)$/.test(type || "");
}

/* 시안 v2 6절: 형식 → 배지 색(class)과 종류 글자 */
function fileKind(name) {
  const ext = extOf(name);
  if (ext === "pdf") return { cls: "pdf", label: "PDF" };
  if (ext === "hwp" || ext === "hwpx") return { cls: "hwp", label: "한글" };
  if (["xlsx", "xls", "csv"].includes(ext)) return { cls: "xlsx", label: "엑셀" };
  if (ext === "docx" || ext === "doc") return { cls: "docx", label: "워드" };
  if (ext === "zip" || ext === "7z") return { cls: "zip", label: "압축" };
  return { cls: "", label: "기타" };
}

function fileTypeBadge(name) {
  const ext = extOf(name);
  const badge = el("span", `ext ${fileKind(name).cls}`.trim(), (ext || "file").slice(0, 4).toUpperCase());
  badge.setAttribute("aria-hidden", "true");
  return badge;
}

function attachmentsOf(message) {
  return Array.isArray(message?.attachments) ? message.attachments : [];
}

/* 목록 미리보기·알림용 한 줄 요약. 첨부만 있으면 "파일: 이름". */
function previewText(message) {
  if (message?.recalled) return RECALLED_TEXT;
  if (message?.poll) return `투표: ${message.poll.question || ""}`;
  if (message?.todo) return `할 일: ${message.todo.title || ""}`;
  const text = (message?.content || "").replace(/\s+/g, " ").trim();
  if (text) return text;
  const files = attachmentsOf(message);
  if (!files.length) return "";
  if (files.length > 1) return `파일 ${files.length}개`;
  const name = files[0].name || "이름 없음";
  return `${isImage(name, files[0].type) ? "사진" : "파일"}: ${name}`;
}

function loadingState(text) {
  const wrap = el("div", "state");
  wrap.append(el("p", "state-title", text));
  return wrap;
}
function emptyState(text, detail) {
  const wrap = el("div", "state");
  wrap.append(el("p", "state-title", text));
  if (detail) wrap.append(el("p", "", detail));
  return wrap;
}
function errorState(text, retry) {
  const wrap = el("div", "state");
  wrap.append(el("p", "state-title", text));
  const button = el("button", "button-primary", "다시 시도");
  button.type = "button";
  button.addEventListener("click", retry);
  wrap.append(button);
  return wrap;
}

/* ───────── 해시 경로 ───────── */

function hashFor() {
  if (state.view === "general") return "#/general";
  if (state.view === "dm" && state.selectedUser) return `#/dm/${state.selectedUser.userId}`;
  if (state.view === "group" && state.selectedGroup) return `#/group/${state.selectedGroup.groupId}`;
  if (state.view === "notes" && state.selectedNotePeer) return `#/notes/${state.selectedNotePeer.userId}`;
  return "";
}

function syncHash() {
  if (pendingHash) return;
  const want = hashFor();
  if (location.hash === want || (!want && !location.hash)) return;
  if (want) history.pushState(null, "", want);
  else history.replaceState(null, "", location.pathname + location.search);
}

function parseHash(hash) {
  const match = /^#\/(general|dm|group|notes)(?:\/(\d+))?\/?$/.exec(hash || "");
  if (!match) return null;
  const id = match[2] ? Number(match[2]) : null;
  if (match[1] !== "general" && !id) return null;
  return { kind: match[1], id };
}

/* 해시가 가리키는 화면을 연다. 열었으면 true. */
function routeTo(hash) {
  const route = parseHash(hash);
  if (!route || !state.me) return false;
  if (route.kind === "general") {
    setView("general");
    return true;
  }
  if (route.kind === "dm") {
    const person = personById(route.id);
    if (!person) return false;
    openTalk(person);
    return true;
  }
  if (route.kind === "group") {
    const group = groupById(route.id);
    if (!group) return false;
    setView("group", group);
    return true;
  }
  if (route.kind === "notes") {
    openNoteThread(route.id);
    return true;
  }
  return false;
}

let hashDeferred = false;
window.addEventListener("hashchange", () => {
  if (!state.me || pendingHash) return;
  if (state.locked || state.pwForced) {
    hashDeferred = true; // 확인 창 등이 잠금 위에 뜨지 않게 풀린 뒤 처리한다
    return;
  }
  handleHash();
});

function runDeferredHash() {
  if (!hashDeferred || state.locked || state.pwForced) return;
  hashDeferred = false;
  handleHash();
}

function handleHash() {
  if (location.hash && location.hash !== hashFor()) routeTo(location.hash);
  else if (!location.hash && hashFor()) {
    if (isTalkView()) setView("talk");
    else if (state.view === "notes") selectNotePeer(null).then(() => updateChrome());
  }
}

/* ───────── 메시지 로그 ───────── */

function safeFileUrl(url) {
  return typeof url === "string" && url.startsWith("/api/files/") ? url : "";
}

function inlineUrl(url) {
  return url + (url.includes("?") ? "&" : "?") + "inline=1";
}

const shownImages = new Set(); // 사진 자동 표시를 껐을 때 "사진 보기"로 연 사진

function fileCard(file, { onOpen = null } = {}) {
  const url = safeFileUrl(file.url);
  const name = file.name || "이름 없음";
  const size = formatSize(file.size);
  if (url && isImage(name, file.type) && state.prefs?.chat?.autoShowImages === false && !shownImages.has(url)) {
    const hold = el("button", "thumb hold");
    hold.type = "button";
    hold.setAttribute("aria-label", `${name} 사진 보기${size ? `, ${size}` : ""}`);
    const face = el("span", "hold-face");
    face.append(iconUse("ico-eye"), el("b", "", "사진 보기"));
    const caption = el("span", "cap");
    caption.append(el("span", "", name));
    if (size) caption.append(el("small", "", size));
    hold.append(face, caption);
    hold.addEventListener("click", () => {
      shownImages.add(url);
      const shown = fileCard(file, { onOpen });
      hold.replaceWith(shown);
      shown.focus?.();
    });
    return hold;
  }
  if (url && isImage(name, file.type)) {
    const link = el(onOpen ? "button" : "a", "thumb");
    if (onOpen) {
      link.type = "button";
      link.setAttribute("aria-label", `${name} 크게 보기`);
      link.addEventListener("click", onOpen);
    } else {
      link.href = url;
      link.download = name;
      link.setAttribute("aria-label", `${name} 내려받기`);
    }
    const img = document.createElement("img");
    img.src = inlineUrl(url);
    img.alt = "";
    img.loading = "lazy";
    img.width = 240;
    img.height = 160;
    img.addEventListener("error", () => link.classList.add("broken"), { once: true });
    const caption = el("span", "cap");
    caption.append(el("span", "", name));
    if (size) caption.append(el("small", "", size));
    link.append(img, caption);
    return link;
  }
  const card = el("div", "file");
  const info = el("span", "fx");
  const title = el("b", "", name);
  title.title = name;
  info.append(title, el("small", "", size ? `${size} · ${fileKind(name).label}` : fileKind(name).label));
  card.append(fileTypeBadge(name), info);
  if (url) {
    const down = el("a", "icon-btn");
    down.href = url;
    down.download = name;
    down.setAttribute("aria-label", `${name} 내려받기`);
    down.title = "내려받기";
    down.append(iconUse("ico-down"));
    card.append(down);
  }
  return card;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wordsOf(query) {
  return String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
}

/* 검색어를 <mark>로 감싸 붙인다(글자는 textContent로만). */
function appendMarked(parent, text, words, className) {
  if (!words?.length || !text) {
    parent.append(text);
    return;
  }
  const pattern = new RegExp(words.map(escapeRegExp).join("|"), "gi");
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (!match[0]) continue;
    if (match.index > last) parent.append(text.slice(last, match.index));
    parent.append(el("mark", className, match[0]));
    last = match.index + match[0].length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

/* 본문: "@이름"(멘션한 사람)은 강조, 나는 따로, 검색어는 표시. */
function richText(text, { mentionIds = [], words = [], markClass = "" } = {}) {
  const frag = document.createDocumentFragment();
  const meName = state.me?.fullName || "";
  const names = [...new Set(mentionIds.map(nameOf).filter((name) => name && name !== "알 수 없음"))]
    .sort((a, b) => b.length - a.length);
  if (!names.length) {
    appendMarked(frag, text, words, markClass);
    return frag;
  }
  const pattern = new RegExp(`@(${names.map(escapeRegExp).join("|")})`, "g");
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) appendMarked(frag, text.slice(last, match.index), words, markClass);
    const at = el("span", match[1] === meName ? "at me" : "at");
    appendMarked(at, match[0], words, markClass);
    frag.append(at);
    last = match.index + match[0].length;
  }
  if (last < text.length) appendMarked(frag, text.slice(last), words, markClass);
  return frag;
}

function quoteButton(reply) {
  const original = state.messages.find((message) => message.id === reply.id);
  const gone = Boolean(reply.recalled || original?.recalled);
  const button = el("button", gone ? "quote gone" : "quote");
  button.type = "button";
  const sender = reply.senderName || "알 수 없음";
  button.setAttribute("aria-label", `${sender}의 원문으로 이동`);
  button.append(el("b", "", sender), el("span", "", gone ? RECALLED_TEXT : reply.excerpt || ""));
  button.addEventListener("click", () => jumpTo(reply.id, { flash: true }));
  return button;
}

/* 이 메시지에 표시할 검색어: 대화방 안 검색(k2) 또는 검색 결과로 연 메시지(k1). */
function marksFor(message) {
  const inSearch = state.inSearch;
  if (inSearch.open && inSearch.query.trim()) {
    const current = inSearch.hits[inSearch.index]?.id === message.id;
    return { words: wordsOf(inSearch.query), markClass: current ? "k2 cur" : "k2" };
  }
  if (state.jump?.id === message.id && state.jump.words?.length) return { words: state.jump.words, markClass: "k1" };
  // N4: 서버가 키워드가 들었다고 표시한 메시지(alerted)는 내 키워드 목록으로 강조한다.
  if (message.alerted && keywordState.list.length) return { words: keywordState.list, markClass: "kwh" };
  return { words: [], markClass: "" };
}

function editSecondsLeft(message) {
  return EDIT_LIMIT_SEC - (Date.now() / 1000 - message.timestamp);
}

function messageRow(message, { mine, grouped, who, kindLabel }) {
  const row = el("div", "msg");
  if (mine) row.classList.add("mine");
  if (grouped) row.classList.add("cont");
  row.dataset.id = String(message.id);
  const recalled = Boolean(message.recalled);
  const mentioned = !mine && !recalled && Boolean(message.mentionedMe);
  if (!mine && !grouped) {
    row.append(avatar(personById(message.senderId), { small: true }));
  }
  const body = el("div", "body");
  if (!mine && !grouped) {
    const name = el("span", "who", who);
    const person = personById(message.senderId);
    if (person) name.append(el("small", "", personTitle(person)));
    if (mentioned) name.append(el("span", "for-me", "나를 멘션"));
    body.append(name);
  }
  // 시안 v2 6절: 첨부 묶음(세로 6px) 다음에 글 말풍선을 잇고, 시간은 마지막 덩어리 바로 옆에 붙인다.
  const files = recalled ? [] : attachmentsOf(message);
  const hasText = Boolean((message.content || "").trim());
  const blocks = [];
  if (files.length) {
    const stack = el("div", "files");
    for (const file of files) stack.append(fileCard(file, { onOpen: () => openViewerFromMessage(message, file) }));
    blocks.push(stack);
  }
  if (recalled) {
    const bubble = el("div", "bubble recalled");
    bubble.append(iconUse("ico-ban"), RECALLED_TEXT);
    blocks.push(bubble);
  } else if (message.poll || message.todo) {
    blocks.push(widgetCard(message));
  } else if (hasText || !files.length || message.replyTo) {
    const bubble = el("div", "bubble");
    if (mentioned) bubble.classList.add("mention");
    if (message.urgent) {
      bubble.classList.add("urgent");
      const tag = el("span", "urg");
      tag.append(iconUse("ico-warn"), "중요");
      bubble.append(tag);
    }
    if (state.compose?.mode === "edit" && state.compose.message.id === message.id) bubble.classList.add("editing");
    if (message.replyTo && message.replyTo.id) bubble.append(quoteButton(message.replyTo));
    const { words, markClass } = marksFor(message);
    bubble.append(richText(message.content || "", { mentionIds: Array.isArray(message.mentions) ? message.mentions : [], words, markClass }));
    blocks.push(bubble);
  }
  const stamp = el("span", "stamp");
  if (kindLabel) stamp.append(el("span", "kind", kindLabel));
  if (mine && !recalled && Number.isInteger(message.unreadCount) && message.unreadCount > 0) {
    const count = el("button", "unread", String(message.unreadCount));
    count.type = "button";
    count.setAttribute("aria-label", `안 읽은 사람 ${message.unreadCount}명 · 읽은 사람 보기`);
    count.addEventListener("click", (event) => {
      event.stopPropagation();
      openReaders(message.id, count);
    });
    stamp.append(count);
  }
  if (message.edited && !recalled) stamp.append(el("span", "ed", "수정됨"));
  stamp.append(timeNode(message.timestamp));
  blocks.forEach((block, index) => {
    const line = el("div", "row");
    line.append(block);
    if (index === blocks.length - 1) {
      line.append(stamp);
      if (!recalled && isTalkView()) line.append(actsBar(message));
    }
    body.append(line);
  });
  const reacts = isTalkView() ? reactionChips(message) : null;
  if (reacts) body.append(reacts);
  row.append(body);
  return row;
}

function actsBar(message) {
  const bar = el("div", "acts-bar");
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "메시지 동작");
  const react = el("button", "icon-btn react");
  react.type = "button";
  react.setAttribute("aria-label", "반응 남기기");
  react.title = "반응 남기기";
  react.setAttribute("aria-haspopup", "true");
  react.append(iconUse("ico-smile"));
  react.addEventListener("click", (event) => {
    event.stopPropagation();
    openPicker(message.id);
  });
  const reply = el("button", "icon-btn");
  reply.type = "button";
  reply.setAttribute("aria-label", "답장");
  reply.title = "답장";
  reply.append(iconUse("ico-reply"));
  reply.addEventListener("click", () => startReply(message.id));
  const more = el("button", "icon-btn more");
  more.type = "button";
  more.setAttribute("aria-label", "더보기");
  more.title = "더보기";
  more.setAttribute("aria-haspopup", "menu");
  more.setAttribute("aria-expanded", "false");
  more.append(iconUse("ico-more"));
  more.addEventListener("click", (event) => {
    event.stopPropagation();
    openMsgMenu(message.id, more);
  });
  bar.append(react, reply, more);
  return bar;
}

function dayDivider(unix) {
  const wrap = el("div", "day");
  wrap.append(el("span", "", formatDay(unix)));
  return wrap;
}

function olderMarker() {
  if (state.loadingOlder) {
    const wrap = el("div", "history older loading");
    wrap.setAttribute("role", "status");
    wrap.append(el("span", "spin"), "이전 메시지를 불러오는 중…");
    wrap.firstChild.setAttribute("aria-hidden", "true");
    return wrap;
  }
  if (state.olderError) {
    const wrap = el("div", "history older is-error");
    wrap.append(el("span", "", state.olderError));
    const retry = el("button", "txt-btn", "다시 시도");
    retry.type = "button";
    retry.addEventListener("click", () => loadOlder());
    wrap.append(retry);
    return wrap;
  }
  if (!state.hasOlder) {
    const wrap = el("div", "history older start");
    const img = document.createElement("img");
    img.src = "/assets/turtle-side.png";
    img.alt = "";
    img.width = 54;
    img.height = 80; // 원본 230×340 비율
    img.addEventListener("error", () => img.remove(), { once: true });
    wrap.append(img, el("b", "", "대화의 처음입니다"));
    return wrap;
  }
  return el("div", "history older more", "");
}

function renderLog() {
  const log = $("#log");
  log.replaceChildren();

  if (state.loadError) {
    log.dataset.state = "error";
    const wrap = errorState("메시지를 불러오지 못했습니다", () => loadMessages());
    wrap.querySelector("button").id = "retry";
    wrap.insertBefore(el("p", "", state.loadError), wrap.lastChild);
    log.append(wrap);
    return;
  }
  if (state.loading) {
    log.dataset.state = "loading";
    log.append(loadingState("메시지를 불러오는 중…"));
    return;
  }
  if (state.messages.length === 0) {
    log.dataset.state = "empty";
    // 대화가 없는 방(새 그룹·첫 1:1)은 대화창 첫 화면처럼 거돌이와 함께 보여 준다.
    const empty = el("div", "thread-empty chat-empty");
    const img = document.createElement("img");
    img.src = "/assets/turtle-jump.png";
    img.alt = "";
    img.width = 132;
    img.height = 182; // 원본 240×330 비율
    empty.append(img, el("p", "", state.view === "general" ? "아직 메시지가 없습니다" : "아직 대화가 없습니다"), el("small", "", "첫 메시지를 보내 대화를 시작하세요."));
    log.append(empty);
    return;
  }

  log.dataset.state = "ready";
  log.append(olderMarker());
  const showTopics = state.view === "general";
  let lastDay = "";
  let lastTopic = null;
  state.messages.forEach((message, index) => {
    const day = dayKey(message.timestamp);
    if (day !== lastDay) {
      log.append(dayDivider(message.timestamp));
      lastDay = day;
    }
    if (showTopics && message.topic !== lastTopic) {
      log.append(el("p", "sys", message.topic ? `주제 · ${message.topic}` : "주제 없음"));
      lastTopic = message.topic;
    }
    log.append(rowAt(index));
  });
  if (state.hasNewer) log.append(newerMarker());
  reattachPopovers();
}

/* 같은 사람이 5분 안에 이어 보낸 말풍선은 묶는다(날짜·주제가 바뀌면 끊는다). */
function groupedAt(index) {
  const message = state.messages[index];
  const previous = state.messages[index - 1];
  if (!message || !previous) return false;
  if (dayKey(previous.timestamp) !== dayKey(message.timestamp)) return false;
  if (state.view === "general" && previous.topic !== message.topic) return false;
  // 나를 멘션한 메시지는 이름 줄에 "나를 멘션"을 보이도록 묶지 않는다.
  if (message.mentionedMe && !message.recalled && message.senderId !== state.me?.userId) return false;
  return previous.senderId === message.senderId && message.timestamp - previous.timestamp < 300;
}

function rowAt(index) {
  const message = state.messages[index];
  return messageRow(message, { mine: message.senderId === state.me?.userId, grouped: groupedAt(index), who: message.senderName });
}

/* 말풍선 하나만 다시 그린다(수정·회수·읽음 숫자). 열린 메뉴·팝오버는 새 말풍선에 다시 붙인다. */
function replaceRow(id) {
  const log = $("#log");
  const index = state.messages.findIndex((message) => message.id === id);
  const old = log?.querySelector(`.msg[data-id="${id}"]`);
  if (index < 0 || !old) return;
  old.replaceWith(rowAt(index));
  const next = state.messages[index + 1];
  if (next) log.querySelector(`.msg[data-id="${next.id}"]`)?.replaceWith(rowAt(index + 1));
  reattachPopovers();
}

function newerMarker() {
  const wrap = el("div", "history newer");
  if (state.loadingNewer) {
    wrap.classList.add("loading");
    wrap.setAttribute("role", "status");
    const spin = el("span", "spin");
    spin.setAttribute("aria-hidden", "true");
    wrap.append(spin, "다음 메시지를 불러오는 중…");
    return wrap;
  }
  const button = el("button", "txt-btn", "최근 메시지로 이동");
  button.type = "button";
  button.addEventListener("click", () => loadMessages());
  wrap.append(button);
  return wrap;
}

/* ───────── 목록: 대화 ───────── */

function latestDm(personId) {
  const messages = state.dmCache[personId] || [];
  return messages.length ? messages[messages.length - 1] : null;
}

function latestGroup(groupId) {
  const messages = state.groupCache[groupId] || [];
  return messages.length ? messages[messages.length - 1] : null;
}

function unreadCount(personId) {
  const seen = state.readCursor[personId] || 0;
  return (state.dmCache[personId] || []).filter((message) => message.senderId !== state.me?.userId && message.id > seen).length;
}

function groupUnread(groupId) {
  const seen = state.groupRead[groupId] || 0;
  return (state.groupCache[groupId] || []).filter((message) => message.senderId !== state.me?.userId && message.id > seen).length;
}

/* 안 읽은 메시지 가운데 나를 멘션한 것이 있으면 목록에 "@" 배지를 단다. */
function dmMention(personId) {
  const seen = state.readCursor[personId] || 0;
  return (state.dmCache[personId] || []).some((message) => message.senderId !== state.me?.userId && message.id > seen && message.mentionedMe && !message.recalled);
}

function groupMention(groupId) {
  const seen = state.groupRead[groupId] || 0;
  return (state.groupCache[groupId] || []).some((message) => message.senderId !== state.me?.userId && message.id > seen && message.mentionedMe && !message.recalled);
}

function totalUnread() {
  return state.people.reduce((sum, person) => sum + unreadCount(person.userId), 0)
    + state.groups.reduce((sum, group) => sum + groupUnread(group.groupId), 0)
    + state.generalUnread;
}

function rememberDm(personId, messages, markRead) {
  const sorted = messages.slice().sort((a, b) => a.id - b.id);
  state.dmCache[personId] = sorted;
  if (markRead) {
    const last = sorted[sorted.length - 1];
    state.readCursor[personId] = last ? last.id : (state.readCursor[personId] || 0);
  }
}

function rememberGroup(groupId, messages, markRead) {
  const byId = new Map((state.groupCache[groupId] || []).map((message) => [message.id, message]));
  for (const message of messages) byId.set(message.id, message);
  const sorted = [...byId.values()].sort((a, b) => a.id - b.id).slice(-100);
  state.groupCache[groupId] = sorted;
  if (markRead) {
    const last = sorted[sorted.length - 1];
    state.groupRead[groupId] = Math.max(state.groupRead[groupId] || 0, last ? last.id : 0);
  }
}

function viewingGroup(groupId) {
  return state.view === "group" && state.selectedGroup?.groupId === groupId;
}

function absorbDmPreviews(messages) {
  for (const message of messages) {
    if (!message || message.kind !== "dm" || !message.peerId || isClassifiedNote(message.id)) continue;
    const list = state.dmCache[message.peerId] || [];
    if (!list.some((item) => item.id === message.id)) {
      list.push(message);
      list.sort((a, b) => a.id - b.id);
      state.dmCache[message.peerId] = list;
    }
    if (state.view === "dm" && state.selectedUser?.userId === message.peerId && attentive()) {
      state.readCursor[message.peerId] = message.id;
    }
  }
}

function absorbGroupMessages(messages) {
  let unknown = false;
  for (const message of messages) {
    if (!message || message.kind !== "group" || !message.groupId) continue;
    if (!groupById(message.groupId)) {
      unknown = true;
      // 새로 초대된 그룹: 이 메시지부터 안읽음으로 센다(지난 기록은 미리보기 때 읽음 처리하지 않게).
      if (!(message.groupId in state.groupRead)) state.groupRead[message.groupId] = message.id - 1;
    }
    rememberGroup(message.groupId, [message], viewingGroup(message.groupId) && attentive());
  }
  if (unknown) scheduleGroupsReload();
}

function absorbChannelMessages(messages) {
  const channel = messages.filter((message) => message && (message.kind || "channel") === "channel");
  if (!channel.length) return;
  const last = channel[channel.length - 1];
  if (!state.generalLast || last.id > state.generalLast.id) state.generalLast = last;
  if (state.view !== "general" || !attentive()) {
    const fresh = channel.filter((message) => message.senderId !== state.me?.userId && message.id > (state.generalRead || 0));
    state.generalUnread += fresh.length;
    if (fresh.some((message) => message.mentionedMe)) state.generalMention = true;
  } else {
    state.generalRead = Math.max(state.generalRead || 0, last.id);
  }
}

/* 읽은 위치는 서버에 없으므로 이 브라우저(계정별)에 남긴다. 처음 보는 대화의 지난 기록은 읽은 것으로 친다. */
function readKey() {
  return state.me ? `sangsangtalk.read.${state.me.userId}` : "";
}

function loadReadState() {
  state.readCursor = {};
  state.groupRead = {};
  state.generalRead = null;
  try {
    const saved = JSON.parse(localStorage.getItem(readKey()) || "null");
    if (saved && typeof saved === "object") {
      state.readCursor = saved.dm && typeof saved.dm === "object" ? saved.dm : {};
      state.groupRead = saved.group && typeof saved.group === "object" ? saved.group : {};
      state.generalRead = Number.isFinite(saved.general) ? saved.general : null;
    }
  } catch {
    // 저장소를 못 쓰면 이번 실행 동안만 기억한다.
  }
}

let savedRead = "";
function saveReadState() {
  if (!state.me) return;
  const value = JSON.stringify({ dm: state.readCursor, group: state.groupRead, general: state.generalRead });
  if (value === savedRead) return;
  savedRead = value;
  try {
    localStorage.setItem(readKey(), value);
  } catch {
    // 저장 실패는 무시한다(다음 실행에서 지난 기록을 읽은 것으로 친다).
  }
}

async function loadTalkPreviews() {
  const generation = ++state.previewGeneration;
  const people = state.people.slice();
  const groups = state.groups.slice();
  const fetchList = async (params) => {
    const response = await fetch("/api/messages?" + new URLSearchParams(params));
    if (!response.ok || generation !== state.previewGeneration) return null;
    const data = await response.json().catch(() => ({}));
    if (generation !== state.previewGeneration) return null;
    return Array.isArray(data.messages) ? data.messages : [];
  };
  const general = (async () => {
    try {
      const list = await fetchList({ view: "general" });
      const last = list?.[list.length - 1];
      if (last && (!state.generalLast || last.id > state.generalLast.id)) state.generalLast = last;
      if (list && last) {
        if (state.generalRead === null || (state.view === "general" && attentive())) state.generalRead = Math.max(state.generalRead || 0, last.id);
        else {
          const unread = list.filter((message) => message.senderId !== state.me?.userId && message.id > state.generalRead);
          state.generalUnread = unread.length;
          state.generalMention = unread.some((message) => message.mentionedMe);
        }
      }
    } catch {
      // The general preview can stay blank.
    }
  })();
  await Promise.all([
    general,
    ...people.map(async (person) => {
      try {
        const list = await fetchList({ view: "dm", userId: String(person.userId) });
        if (list) {
          const viewing = state.view === "dm" && state.selectedUser?.userId === person.userId;
          const sorted = list.filter((message) => !isClassifiedNote(message.id));
          if (!(person.userId in state.readCursor) && !viewing) {
            state.readCursor[person.userId] = sorted.length ? sorted[sorted.length - 1].id : 0;
          }
          rememberDm(person.userId, sorted, viewing && attentive());
        }
      } catch {
        // A preview can stay blank until the next refresh.
      }
    }),
    ...groups.map(async (group) => {
      try {
        const list = await fetchList({ view: "group", groupId: String(group.groupId) });
        if (list) {
          if (!(group.groupId in state.groupRead) && !viewingGroup(group.groupId)) {
            // 처음 본 그룹은 지난 기록을 안읽음으로 세지 않는다.
            state.groupRead[group.groupId] = list.length ? list[list.length - 1].id : 0;
          }
          rememberGroup(group.groupId, list, viewingGroup(group.groupId) && attentive());
        }
      } catch {
        // A preview can stay blank until the next refresh.
      }
    }),
  ]);
  if (generation === state.previewGeneration) renderList();
}

function matchesQuery(...texts) {
  const query = state.query.trim().toLowerCase();
  if (!query) return true;
  return texts.some((text) => (text || "").toLowerCase().includes(query));
}

function roomButton({ avatarNode, name, sub, num, tag, status, preview, unix, unread, mention, muted, current, onClick, label, title, urgent = false }) {
  const button = el("button", "room");
  button.type = "button";
  if (current) button.setAttribute("aria-current", "true");
  if (label) {
    // aria-label은 안의 글자를 가리므로, 대화방 행이면 알림 끔·안읽음·멘션·미리보기·시간을 라벨에 함께 넣는다.
    const parts = [label];
    if (unread !== undefined) {
      if (muted) parts.push("알림 꺼짐");
      if (unread > 0) parts.push(`안 읽은 메시지 ${unread > 99 ? "99개 이상" : `${unread}개`}`);
      if (unread > 0 && mention) parts.push("나를 멘션함");
      if (unread > 0 && urgent) parts.push("중요 메시지");
      if (preview) parts.push(preview);
      if (unix) parts.push(formatListTime(unix));
    }
    button.setAttribute("aria-label", parts.join(", "));
  }
  if (title) button.title = title;
  const text = el("span", "room-text");
  const top = el("span", "t");
  top.append(el("b", "", name));
  if (muted) {
    button.classList.add("muted");
    const icon = iconUse("ico-bell-off");
    icon.setAttribute("class", "i mute");
    icon.removeAttribute("aria-hidden");
    icon.setAttribute("role", "img");
    icon.setAttribute("aria-label", "알림 꺼짐");
    top.append(icon);
  }
  if (num !== undefined) top.append(el("span", "num", String(num)));
  if (tag) top.append(el("span", "tag-dept", tag));
  if (status) top.append(status);
  if (sub) top.append(el("em", "", sub));
  const line = el("p", "");
  if (urgent && unread > 0) line.append(el("span", "urg-tag", "중요"));
  line.append(preview || "");
  text.append(top, line);
  const meta = el("span", "meta");
  if (unix) {
    const time = el("time", "", formatListTime(unix));
    time.dateTime = new Date(unix * 1000).toISOString();
    meta.append(time);
  }
  if (unread > 0) {
    const count = el("span", muted ? "badge off" : "badge", unread > 99 ? "99+" : String(unread));
    if (mention) {
      const badges = el("span", "badges");
      const at = el("span", "badge mbadge", "@");
      at.setAttribute("aria-label", "나를 멘션함");
      badges.append(at, count);
      meta.append(badges);
    } else {
      meta.append(count);
    }
  }
  button.append(avatarNode, text, meta);
  button.addEventListener("click", onClick);
  return button;
}

function groupMemberNames(group) {
  return (group.memberIds || []).map(nameOf).join(", ");
}

function renderTalk() {
  const list = $("#talk-list");
  if (!list) return;
  list.replaceChildren();
  updateUnreadBadges();
  if (state.directoryError || state.notesError) {
    list.append(errorState(state.notesError || state.directoryError, () => reloadAll()));
    return;
  }
  if (state.directoryLoading && state.people.length === 0) {
    list.append(loadingState("대화 목록을 불러오는 중…"));
    return;
  }

  const filter = state.talkFilter;
  const showGeneral = (filter === "all" || filter === "group" || (filter === "unread" && state.generalUnread > 0))
    && matchesQuery(GENERAL_NAME, "전체", "채널");
  const byName = state.prefs?.chat?.roomSort === "name";
  const allGroups = filter === "dm" ? [] : state.groups
    .filter((group) => filter !== "unread" || groupUnread(group.groupId) > 0)
    .filter((group) => matchesQuery(group.name, groupMemberNames(group), group.dept ? "부서" : ""))
    .sort((a, b) => (byName ? 0 : (latestGroup(b.groupId)?.id || 0) - (latestGroup(a.groupId)?.id || 0)) || (a.name || "").localeCompare(b.name || "", "ko"));
  const depts = allGroups.filter((group) => group.dept);
  const groups = allGroups.filter((group) => !group.dept);
  const people = filter === "group" ? [] : state.people
    .filter((person) => filter !== "unread" || unreadCount(person.userId) > 0)
    .filter((person) => matchesQuery(person.fullName, personTitle(person)))
    .sort((a, b) => (byName ? 0 : (latestDm(b.userId)?.timestamp || 0) - (latestDm(a.userId)?.timestamp || 0)) || a.fullName.localeCompare(b.fullName, "ko"));

  state.search.roomCount = (showGeneral ? 1 : 0) + allGroups.length + people.length;
  if (!showGeneral && allGroups.length === 0 && people.length === 0) {
    list.append(emptyState(
      state.query ? "검색 결과가 없습니다"
        : filter === "unread" ? "읽지 않은 대화가 없습니다"
          : filter === "group" ? "아직 그룹 대화방이 없습니다" : "대화할 구성원이 없습니다",
      !state.query && filter === "group" ? "새 대화(+)에서 그룹을 만들 수 있어요." : "",
    ));
    return;
  }

  // B4: 즐겨찾기한 대화방은 맨 위 "즐겨찾기" 구역에만 보인다.
  const rows = [];
  if (showGeneral) {
    const last = state.generalLast;
    rows.push({
      key: "general", section: "pinned", unix: last?.timestamp || 0, title: GENERAL_NAME,
      build: () => roomButton({
        avatarNode: groupAvatar(),
        name: GENERAL_NAME,
        sub: "전체 채널",
        preview: last ? `${last.senderName}: ${previewText(last)}` : "모든 구성원이 함께 쓰는 채널",
        unix: last?.timestamp,
        unread: state.generalUnread,
        mention: state.generalMention,
        urgent: Boolean(last?.urgent && last.senderId !== state.me?.userId),
        muted: isMuted("general"),
        title: isMuted("general") ? "전체 채널 · 알림 꺼짐" : "",
        current: state.view === "general",
        onClick: () => setView("general"),
      }),
    });
  }
  for (const group of allGroups) {
    const key = `group:${group.groupId}`;
    const last = latestGroup(group.groupId);
    rows.push({
      key, section: group.dept ? "dept" : "group", unix: last?.timestamp || 0, title: group.name || "",
      build: () => {
        const count = (group.memberIds || []).length;
        const who = last ? (last.senderId === state.me?.userId ? "나" : last.senderName) : "";
        const name = group.name || (group.dept ? "부서 대화방" : "이름 없는 그룹");
        return roomButton({
          avatarNode: group.dept ? deptAvatar() : groupAvatar(),
          name,
          num: count,
          tag: group.dept ? "부서" : undefined,
          label: group.dept ? `${name} 부서 대화방, 참여자 ${count}명` : `${name}, 참여자 ${count}명`,
          title: [group.dept ? `${name} 부서 대화방 · ${count}명` : "", isMuted(key) ? "알림 꺼짐" : ""].filter(Boolean).join(" · "),
          preview: last ? `${who}: ${previewText(last)}` : "아직 대화가 없습니다",
          unix: last?.timestamp,
          unread: groupUnread(group.groupId),
          mention: groupMention(group.groupId),
          urgent: Boolean(last?.urgent && last.senderId !== state.me?.userId),
          muted: isMuted(key),
          current: viewingGroup(group.groupId),
          onClick: () => setView("group", group),
        });
      },
    });
  }
  for (const person of people) {
    const key = `dm:${person.userId}`;
    const last = latestDm(person.userId);
    rows.push({
      key, section: "dm", unix: last?.timestamp || 0, title: person.fullName || "",
      build: () => {
        const unread = unreadCount(person.userId);
        const line = manualStatus(person.userId)?.text || "";
        const summary = statusTitle(person.userId);
        return roomButton({
          avatarNode: personAvatar(person),
          name: person.fullName,
          status: statusChips(person.userId),
          // B2: 상태 문구가 있으면 미리보기 대신 보여 준다(읽지 않은 새 메시지가 있으면 메시지가 먼저).
          preview: line && !unread ? line : last ? previewText(last) : line || "아직 대화가 없습니다",
          unix: last?.timestamp,
          unread,
          mention: dmMention(person.userId),
          urgent: Boolean(last?.urgent && last.senderId !== state.me?.userId),
          muted: isMuted(key),
          current: state.view === "dm" && state.selectedUser?.userId === person.userId,
          onClick: () => openTalk(person),
          title: [person.fullName, summary, isMuted(key) ? "알림 꺼짐" : ""].filter(Boolean).join(" · "),
        });
      },
    });
  }
  const favorites = rows.filter((row) => isFavorite(row.key))
    .sort((a, b) => (byName ? a.title.localeCompare(b.title, "ko") : b.unix - a.unix));
  if (favorites.length) {
    const sec = el("div", "sec");
    const star = iconUse("ico-star");
    star.setAttribute("class", "i fav");
    sec.append(star, "즐겨찾기");
    list.append(sec);
    for (const row of favorites) list.append(row.build());
  }
  const rest = rows.filter((row) => !isFavorite(row.key));
  for (const section of ["pinned", "dept", "group", "dm"]) {
    const items = rest.filter((row) => row.section === section);
    if (!items.length) continue;
    if (section === "pinned") {
      const sec = el("div", "sec");
      sec.append(iconUse("ico-pin"), "고정됨");
      list.append(sec);
    } else if (section === "group") {
      const sec = el("div", "sec", "그룹 ");
      sec.append(el("span", "cnt", String(items.length)));
      list.append(sec);
    } else {
      list.append(el("div", "sec", section === "dept" ? "내 부서" : "1:1 대화"));
    }
    for (const row of items) list.append(row.build());
  }
}

function updateUnreadBadges() {
  const total = totalUnread();
  const text = total > 99 ? "99+" : String(total);
  const badge = $("#talk-badge");
  if (badge) {
    badge.hidden = total === 0;
    badge.textContent = text;
  }
  const chip = $("#chip-unread");
  if (chip) chip.textContent = total ? text : "";
  if (state.me) {
    setUnread(total);
    saveReadState();
  }
  const hour = new Date().getHours();
  $("#hello-title").textContent = hour >= 5 && hour < 11 ? "좋은 아침이에요!" : hour >= 11 && hour < 18 ? "좋은 오후예요!" : "좋은 저녁이에요!";
  const hello = $("#hello-text");
  hello.replaceChildren();
  if (total) {
    hello.append("읽지 않은 대화가 ");
    hello.append(el("strong", "", `${total}건`));
    hello.append(" 있어요.");
  } else {
    hello.append("새 대화를 모두 확인했어요.");
  }
}

/* ───────── 목록: 직원 ───────── */

function bindPersonOpen(button, person) {
  button.addEventListener("click", (event) => {
    if (event.detail > 1) return;
    if (event.detail === 0) {
      openChooser(person);
      return;
    }
    window.clearTimeout(personClickTimer);
    personClickTimer = window.setTimeout(() => openChooser(person), 250);
  });
  button.addEventListener("dblclick", (event) => {
    event.preventDefault();
    window.clearTimeout(personClickTimer);
    openChooser(person);
  });
}

function renderStaff() {
  const list = $("#staff-list");
  if (!list) return;
  list.replaceChildren();
  if (state.directoryError) {
    list.append(errorState(state.directoryError, () => reloadAll()));
    return;
  }
  if (state.directoryLoading && state.people.length === 0) {
    list.append(loadingState("직원 목록을 불러오는 중…"));
    return;
  }
  const people = state.people.filter((person) => matchesQuery(person.fullName, personTitle(person)));
  if (people.length === 0) {
    list.append(emptyState(state.people.length ? "검색 결과가 없습니다" : "다른 구성원이 없습니다"));
    return;
  }
  list.append(el("div", "sec", `전체 직원 ${state.people.length}명`));
  for (const person of people) {
    const status = presenceOf(person.userId);
    const label = status ? PRESENCE[status].label : "";
    const button = roomButton({
      avatarNode: personAvatar(person),
      name: person.fullName,
      status: statusChips(person.userId),
      preview: personTitle(person),
      onClick: () => {},
      label: `${person.fullName}, ${personTitle(person)}${label ? `, ${label}` : ""}, 대화 또는 쪽지`,
      title: label ? `${person.fullName} · ${label}` : person.fullName,
    });
    button.id = `person-${person.userId}`;
    button.setAttribute("aria-haspopup", "dialog");
    bindPersonOpen(button, person);
    list.append(button);
  }
}

/* ───────── 목록·대화창: 쪽지 ───────── */

function noteGroups() {
  const groups = new Map();
  for (const message of state.noteMessages) {
    if (state.noteFilter !== "all" && message.direction !== state.noteFilter) continue;
    const id = message.peerId;
    if (!groups.has(id)) groups.set(id, { userId: id, fullName: message.counterpartName || "쪽지", messages: [] });
    groups.get(id).messages.push(message);
  }
  return [...groups.values()]
    .map((group) => {
      group.messages.sort((a, b) => a.id - b.id);
      return group;
    })
    .sort((a, b) => (b.messages[b.messages.length - 1]?.timestamp || 0) - (a.messages[a.messages.length - 1]?.timestamp || 0));
}

function renderNoteThread() {
  const log = $("#note-log");
  if (!log) return;
  log.replaceChildren();
  const peer = state.selectedNotePeer;
  if (!peer) return;
  updateHead();
  const messages = state.noteMessages
    .filter((message) => message.peerId === peer.userId)
    .filter((message) => state.noteFilter === "all" || message.direction === state.noteFilter)
    .sort((a, b) => a.id - b.id);
  if (messages.length === 0) {
    log.append(emptyState("표시할 쪽지가 없습니다", "아래에서 쪽지를 보낼 수 있어요."));
    return;
  }
  let lastDay = "";
  for (const message of messages) {
    const day = dayKey(message.timestamp);
    if (day !== lastDay) {
      log.append(dayDivider(message.timestamp));
      lastDay = day;
    }
    const mine = message.direction === "sent" || message.senderId === state.me?.userId;
    const row = messageRow(
      { ...message, senderId: mine ? state.me?.userId : message.peerId },
      { mine, grouped: false, who: message.counterpartName || message.senderName, kindLabel: mine ? "보낸 쪽지" : "받은 쪽지" },
    );
    row.style.marginTop = "14px";
    log.append(row);
  }
  log.scrollTop = log.scrollHeight;
}

function renderNotes() {
  const list = $("#notes-list");
  if (!list) return;
  list.replaceChildren();
  if (state.loadError || state.notesError) {
    list.append(errorState(state.loadError || state.notesError, () => loadNotes()));
    renderNoteThread();
    return;
  }
  if (state.loading) {
    list.append(loadingState("쪽지함을 불러오는 중…"));
    return;
  }
  const groups = noteGroups();
  const visible = groups.filter((group) => matchesQuery(group.fullName));
  if (visible.length === 0) {
    list.append(emptyState(groups.length ? "검색 결과가 없습니다" : "아직 쪽지가 없습니다", groups.length ? "" : "직원 목록에서 쪽지를 보낼 수 있어요."));
  } else {
    for (const group of visible) {
      const last = group.messages[group.messages.length - 1];
      list.append(roomButton({
        avatarNode: personAvatar(personById(group.userId)),
        name: group.fullName,
        sub: `${group.messages.length}통`,
        preview: (last.direction === "sent" ? "보냄 · " : "받음 · ") + previewText(last),
        unix: last.timestamp,
        current: state.selectedNotePeer?.userId === group.userId,
        onClick: () => {
          selectNotePeer({ userId: group.userId, fullName: group.fullName }).then((moved) => {
            if (moved !== false) $("#note-thread-input")?.focus();
          });
        },
      }));
    }
  }
  renderNoteThread();
  updateChrome();
}

async function selectNotePeer(peer) {
  if (state.selectedNotePeer?.userId !== peer?.userId) {
    if (!(await confirmLeaveUploads(`notes:${peer?.userId || ""}`))) return false;
    noteUploader.clear();
    $("#note-thread-error").textContent = "";
    const field = $("#note-thread-input");
    if (field) field.value = "";
  }
  state.selectedNotePeer = peer;
  renderNotes();
  syncHash();
}

function renderList() {
  if (state.view === "home") renderStaff();
  else if (state.view === "notes") renderNotes();
  else renderTalk();
  updateUnreadBadges();
  const status = $("#list-status");
  if (status) status.textContent = state.noteStatus || "";
  renderSearchChrome();
}

/* ───────── 데이터 ───────── */

function isTalkView(view = state.view) {
  return view === "dm" || view === "general" || view === "group";
}

function convKey(view = state.view) {
  if (view === "dm") return `dm:${state.selectedUser?.userId || ""}`;
  if (view === "group") return `group:${state.selectedGroup?.groupId || ""}`;
  return view;
}

/** 로그아웃·재로그인 뒤에 도착한 응답을 버리기 위한 키(세션 세대 + 대화). */
function liveKey() {
  return `${state.sessionGen}|${convKey()}`;
}

function viewParams() {
  const params = new URLSearchParams({ view: state.view });
  if (state.view === "dm") params.set("userId", String(state.selectedUser?.userId));
  if (state.view === "group") params.set("groupId", String(state.selectedGroup?.groupId));
  return params;
}

/* N7: 지금 대화방이 중요 메시지 쓰기 상태인가 */
function urgentMode() {
  return Boolean(state.urgent && state.urgent.key === convKey() && state.compose?.mode !== "edit");
}

/* 전체 대화방은 관리자만 중요 메시지를 보낼 수 있다(계약 N7). */
function canSendUrgent() {
  return state.view !== "general" || Boolean(state.me?.isAdmin);
}

function setUrgent(on, { focus = true } = {}) {
  state.urgent = on ? { key: convKey(), error: "" } : null;
  updateComposer();
  if (focus) $("#composer-input")?.focus();
}

function renderUrgent() {
  const on = urgentMode();
  $("#composer").classList.toggle("urgent", on);
  const ctx = $("#urgent-ctx");
  ctx.hidden = !on;
  ctx.classList.toggle("err", Boolean(on && state.urgent.error));
  // 남은 횟수는 서버가 알려 주지 않으므로 그 문장은 뺀다(계약 "구현 중 확정된 변경").
  $("#urgent-ctx-text").textContent = on && state.urgent.error ? state.urgent.error : "방해 금지·알림 끄기와 관계없이 소리와 함께 알립니다.";
  // 보내기 메뉴의 중요 메시지 항목
  const item = $("#send-urgent");
  const editing = state.compose?.mode === "edit";
  item.hidden = editing;
  $("#send-urgent-sep").hidden = editing;
  item.disabled = !on && !canSendUrgent();
  $("#send-urgent-why").hidden = editing || on || canSendUrgent();
  $("#send-urgent-label").textContent = on ? "보통 메시지로 보내기" : "중요 메시지로 보내기";
  $("#send-urgent-sub").textContent = on ? "중요 표시를 끕니다" : "방해 금지 중에도 소리와 함께 알립니다";
  // 예약 메시지는 중요 메시지로 보낼 수 없다(서버 400).
  $("#send-later").disabled = on;
}

function updateComposer() {
  const button = $("#send-button");
  const input = $("#composer-input");
  if (!button || !input) return;
  renderUrgent();
  const hasText = Boolean(input.value.trim());
  const sending = state.sendingKeys.has(convKey());
  if (state.compose?.mode === "edit") {
    // 수정은 글만 고친다(첨부는 그대로). 첨부가 있는 메시지는 글을 비워도 저장할 수 있다.
    button.disabled = sending || (!hasText && !attachmentsOf(state.compose.message).length);
    button.querySelector("span").textContent = sending ? "저장하는 중…" : "저장";
    button.title = "";
    $("#send-error").textContent = state.sendErrors[convKey()] || "";
    return;
  }
  button.disabled = sending || composerUploader.busy() || (!hasText && !composerUploader.ready().length);
  const narrow = window.matchMedia?.("(max-width: 480px)").matches;
  button.querySelector("span").textContent = sending ? (narrow ? "보내는 중" : "보내는 중…") : urgentMode() ? (narrow ? "중요" : "중요 전송") : "전송";
  button.title = composerUploader.busy() ? "올리는 중인 파일이 끝나면 보낼 수 있어요" : "";
  $("#send-error").textContent = state.sendErrors[convKey()] || "";
}

/* 창이 보이고 포커스가 있을 때만 읽음 처리한다(숨었거나 다른 창을 보고 있으면 트레이 안읽음에 남긴다). */
function attentive() {
  return !document.hidden && document.hasFocus() && !state.locked;
}

/* 상대 쪽 읽음 숫자가 줄도록 서버에 읽음을 알린다. 대화마다 이미 알린 곳까지는 다시 보내지 않는다. */
let readReported = {};
function reportRead() {
  if (!state.me || !isTalkView() || !attentive() || state.loading || state.loadError) return;
  const key = convKey();
  const floor = readReported[key] || 0;
  const ids = state.messages
    .filter((message) => message.id > floor && message.senderId !== state.me.userId)
    .map((message) => message.id)
    .slice(-1000);
  if (!ids.length) return;
  readReported[key] = Math.max(floor, ...ids);
  const session = state.sessionGen;
  api("POST", "/api/messages/read", { messageIds: ids }).catch(() => {
    if (session === state.sessionGen && readReported[key] === Math.max(floor, ...ids)) readReported[key] = floor;
  });
}

function afterLogChange() {
  reportRead();
  if (state.hasNewer) return;
  const read = attentive();
  if (state.view === "dm" && state.selectedUser) rememberDm(state.selectedUser.userId, state.messages, read);
  if (state.view === "group" && state.selectedGroup) rememberGroup(state.selectedGroup.groupId, state.messages.slice(-100), read);
  if (state.view === "general" && state.messages.length) {
    state.generalLast = state.messages[state.messages.length - 1];
    if (read) {
      state.generalRead = Math.max(state.generalRead || 0, state.generalLast.id);
      state.generalUnread = 0;
      state.generalMention = false;
    } else {
      state.generalUnread = state.messages.filter((message) => message.senderId !== state.me?.userId && message.id > (state.generalRead || 0)).length;
    }
  }
}

/* 창이 다시 보이거나 포커스를 얻으면 열려 있는 대화를 읽음 처리한다. */
function markOpenRead() {
  if (!state.me || !attentive() || !isTalkView()) return;
  afterLogChange();
  renderList();
}
window.addEventListener("focus", markOpenRead);
document.addEventListener("visibilitychange", markOpenRead);

function addMessages(incoming, { forceBottom = false } = {}) {
  if (state.hasNewer) return;
  const known = new Set(state.messages.map((message) => message.id));
  const fresh = incoming.filter((message) => message && !known.has(message.id));
  const log = $("#log");
  if (fresh.length === 0) {
    if (forceBottom && log) log.scrollTop = log.scrollHeight;
    return;
  }
  const distance = log.scrollHeight - log.scrollTop - log.clientHeight;
  const stick = forceBottom || distance < 160 || state.messages.length === 0;
  const wasEmpty = state.messages.length === 0;
  state.messages.push(...fresh);
  state.messages.sort((a, b) => a.id - b.id);
  if (wasEmpty) state.hasOlder = false;
  state.loading = false;
  state.loadError = "";
  renderLog();
  if (stick) log.scrollTop = log.scrollHeight;
  afterLogChange();
  renderList();
}

async function loadGroups() {
  const session = state.sessionGen;
  try {
    const data = await api("GET", "/api/groups");
    if (session !== state.sessionGen) return;
    state.groups = (Array.isArray(data.groups) ? data.groups : []).filter((group) => group && group.groupId);
    if (state.selectedGroup) {
      const fresh = groupById(state.selectedGroup.groupId);
      if (fresh) {
        state.selectedGroup = fresh;
      } else if (state.view === "group") {
        state.selectedGroup = null;
        composerUploader.clear();
        await setView("talk");
        state.noteStatus = "그룹 대화방에서 빠졌습니다.";
        renderList();
        return;
      }
    }
    if (state.view === "group") updateHead();
    renderList();
  } catch (error) {
    if (error.status === 401) return;
    // 그룹 목록을 못 읽어도 1:1·general은 계속 쓸 수 있다. 다음 이벤트 때 다시 읽는다.
  }
}

function scheduleGroupsReload() {
  window.clearTimeout(groupsReloadTimer);
  groupsReloadTimer = window.setTimeout(async () => {
    const before = new Set(state.groups.map((group) => group.groupId));
    await loadGroups();
    if (state.groups.some((group) => !before.has(group.groupId))) loadTalkPreviews();
  }, 300);
}

async function loadDirectory() {
  state.directoryLoading = true;
  state.directoryError = "";
  renderList();
  try {
    const session = state.sessionGen;
    const response = await fetch("/api/directory");
    if (session !== state.sessionGen) return;
    if (response.status === 401) {
      showLogin("다시 로그인해 주세요.");
      return;
    }
    const data = await response.json().catch(() => ({}));
    if (session !== state.sessionGen) return;
    if (!response.ok) throw new Error(data.error || "directory");
    state.people = Array.isArray(data.people) ? data.people : [];
    await loadGroups();
    // 그사이 로그아웃했으면 폴링·상태 보내기를 다시 켜지 않는다.
    if (session !== state.sessionGen || !state.me) return;
    state.directoryLoading = false;
    renderList();
    startPoll();
    startPresence();
    loadTalkPreviews();
  } catch {
    if (!state.me) return;
    state.directoryLoading = false;
    state.directoryError = "직원 목록을 가져오지 못했습니다.";
    renderList();
  }
}

/* 대화창이 스크롤되지 않을 만큼 짧으면 이전 기록을 더 채운다. */
function fillIfShort() {
  const log = $("#log");
  if (!log || log.hidden || !state.hasOlder || state.loadingOlder || state.olderError) return;
  if (log.scrollHeight <= log.clientHeight + 40) loadOlder();
}

async function loadMessages({ quiet = false } = {}) {
  const requestedKey = liveKey();
  if (!isTalkView()) {
    await loadDirectory();
    return;
  }
  const around = quiet ? null : state.pendingJump;
  state.pendingJump = null;
  if (!quiet) {
    state.loading = true;
    state.loadError = "";
    state.olderError = "";
    renderLog();
  }
  try {
    const params = viewParams();
    if (around) params.set("around", String(around));
    const response = await fetch(`/api/messages?${params}`);
    if (response.status === 401) {
      showLogin("다시 로그인해 주세요.");
      return;
    }
    const data = await response.json().catch(() => ({}));
    if (liveKey() !== requestedKey) return;
    if (!response.ok) throw new Error(data.error || "load");
    const latest = Array.isArray(data.messages) ? data.messages : [];
    setNotice(data.notice || null);
    if (quiet && state.messages.length && !state.hasNewer) {
      // 이미 불러온 이전 기록은 남기고 최신 묶음만 합친다.
      const oldestLatest = latest[0]?.id ?? Infinity;
      const kept = state.messages.filter((message) => message.id < oldestLatest);
      state.messages = [...kept, ...latest];
      if (!kept.length) state.hasOlder = Boolean(data.hasOlder);
    } else {
      state.messages = latest;
      state.hasOlder = Boolean(data.hasOlder);
    }
    state.hasNewer = Boolean(around && data.hasNewer);
    state.loadingNewer = false;
    if (state.view === "general") {
      state.generalUnread = 0;
      state.generalMention = false;
    }
    state.loading = false;
    state.loadError = "";
    const log = $("#log");
    const distance = log.scrollHeight - log.scrollTop - log.clientHeight;
    const stick = !quiet || distance < 160;
    renderLog();
    if (around && scrollToMessage(around, { flash: true })) {
      // 검색 결과·인용으로 연 메시지를 가운데에 둔다.
    } else if (stick) log.scrollTop = log.scrollHeight;
    afterLogChange();
    renderList();
    startPoll();
    fillIfShort();
  } catch {
    if (liveKey() !== requestedKey) return;
    state.loading = false;
    state.loadError = state.view === "general" ? "채널 메시지를 가져오지 못했습니다." : "대화를 불러오지 못했습니다.";
    renderLog();
  }
}

/* A. 맨 위에서 이전 100개를 불러와 위에 붙이고 보던 위치를 유지한다. */
async function loadOlder() {
  if (!isTalkView() || !state.hasOlder || state.loadingOlder || !state.messages.length) return;
  const requestedKey = liveKey();
  const log = $("#log");
  state.loadingOlder = true;
  state.olderError = "";
  const marker = log.querySelector(".older");
  if (marker) marker.replaceWith(olderMarker());
  try {
    const params = viewParams();
    params.set("before", String(state.messages[0].id));
    const data = await api("GET", `/api/messages?${params}`);
    if (liveKey() !== requestedKey) return;
    const known = new Set(state.messages.map((message) => message.id));
    const older = (Array.isArray(data.messages) ? data.messages : []).filter((message) => message && !known.has(message.id));
    const previousHeight = log.scrollHeight;
    const previousTop = log.scrollTop;
    state.messages = [...older, ...state.messages].sort((a, b) => a.id - b.id);
    state.hasOlder = Boolean(data.hasOlder) && older.length > 0;
    state.loadingOlder = false;
    renderLog();
    log.scrollTop = log.scrollHeight - previousHeight + previousTop;
  } catch (error) {
    if (error.status === 401 || liveKey() !== requestedKey) return;
    state.loadingOlder = false;
    state.olderError = "이전 메시지를 불러오지 못했습니다.";
    const current = log.querySelector(".older");
    if (current) current.replaceWith(olderMarker());
    return;
  } finally {
    if (liveKey() === requestedKey) state.loadingOlder = false;
  }
  fillIfShort();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startPoll() {
  if (state.pollToken) return;
  const token = Symbol();
  state.pollToken = token;
  pollLoop(token);
}

function isClassifiedNote(id) {
  return state.noteRecords.some((note) => note.messageId === id);
}
function messageMatchesView(message) {
  const kind = message?.kind || "channel";
  if (state.view === "dm") {
    return kind === "dm" && message.peerId === state.selectedUser?.userId && !isClassifiedNote(message.id);
  }
  if (state.view === "group") return kind === "group" && message.groupId === state.selectedGroup?.groupId;
  if (state.view === "general") return kind === "channel";
  return false;
}

/* E. 남이 보낸 새 메시지 + (창이 안 보이거나 포커스 없음, 또는 그 대화가 열려 있지 않음) → 알림. */
function clipBody(text) {
  const chars = Array.from(text);
  return chars.length > 80 ? `${chars.slice(0, 79).join("")}…` : text;
}

/* 서버가 쪽지를 messages에서 빼고 notes 배열로만 보내므로(11/16 백엔드), 쪽지 알림은 새로 생긴 쪽지 기록으로 낸다. */
function notifyNewNotes(previousIds, notes) {
  if (dndActive() || snoozed()) return;
  const fresh = notes.filter((note) => note && !previousIds.has(note.messageId) && note.senderId !== state.me?.userId);
  for (const note of fresh.slice(-5)) {
    const open = state.view === "notes" && state.selectedNotePeer?.userId === note.senderId;
    if (open && !document.hidden && document.hasFocus()) continue;
    const name = personById(note.senderId)?.fullName || "새 쪽지";
    sendNotify({ title: `쪽지 · ${name}`, body: "새 쪽지가 왔습니다.", target: `#/notes/${note.senderId}` });
  }
}

function notifyIncoming(messages) {
  const others = messages.filter((message) => message && message.senderId !== state.me?.userId);
  for (const message of others.slice(-5)) {
    const kind = message.kind || "channel";
    let open = false;
    let target = "#/general";
    let title = `${GENERAL_NAME} · ${message.senderName}`;
    if (kind === "dm") {
      target = `#/dm/${message.peerId}`;
      title = message.senderName || "새 메시지";
      open = messageMatchesView(message);
    } else if (kind === "group") {
      const group = groupById(message.groupId);
      target = `#/group/${message.groupId}`;
      title = `${group?.name || "그룹"} · ${message.senderName}`;
      open = messageMatchesView(message);
    } else {
      open = messageMatchesView(message);
    }
    const attention = !attentive(); // 잠긴 동안은 보고 있지 않은 것으로 친다
    if (open && !attention) continue;
    const urgent = message.urgent === true;
    if (urgent) {
      // 중요 메시지(N7)는 방해 금지·알림 끄기·잠시 끄기와 관계없이 알린다. 미리 보기 설정은 따른다.
      title = `중요 · ${title}`;
    } else {
      if (snoozed()) continue; // 잠시 끄기(N3): 멘션도 알리지 않는다
      if (message.mentionedMe) {
        // 나를 멘션한 메시지는 대화방 알림을 꺼도(2-B) 알린다.
        title = `@ ${title}`;
      } else {
        // 키워드(N4)·내 글에 단 답장은 알림 끈 방에서도 알리지만, 방해 금지 중에는 알리지 않는다.
        const bypassMute = message.alerted === true || (state.prefs.notify.replyBypassMute && isReplyToMe(message));
        if ((isMuted(messageKey(message)) && !bypassMute) || dndActive()) continue;
      }
    }
    sendNotify({ title, body: clipBody(previewText(message) || "새 메시지"), target, sender: message.senderName, urgent });
  }
}

/* 내 메시지에 단 답장인가. 서버가 replyTo.senderId를 주면 그것을, 아니면 불러온 원문을 본다. */
function isReplyToMe(message) {
  const reply = message?.replyTo;
  if (!reply?.id || !state.me) return false;
  if (reply.senderId !== undefined && reply.senderId !== null) return reply.senderId === state.me.userId;
  return state.messages.some((item) => item.id === reply.id && item.senderId === state.me.userId);
}

/* N1 미리 보기: 기관 정책(D1)이 숨김을 강제하면 그것을 따른다. */
function previewMode() {
  if (state.me?.policy?.forcePreviewHidden) return "none";
  return state.prefs.notify.preview;
}

/* 모든 알림은 여기를 거친다. 미리 보기·소리·깜박임 설정을 적용한다(p3-contract N1·N2·N5). */
function sendNotify({ title, body, target, sender = "", urgent = false }) {
  const settings = state.prefs.notify;
  let mode = previewMode();
  // 잠긴 동안은 내용을 보이지 않는다(2-C).
  if (state.locked && mode === "full") mode = "name";
  let shownTitle = title;
  let shownBody = body;
  if (mode === "name") {
    if (state.locked && sender) shownTitle = urgent ? `중요 · ${sender}` : sender;
    shownBody = "새 메시지";
  } else if (mode === "none") {
    shownTitle = urgent ? "상상톡 · 중요" : "상상톡";
    shownBody = "새 메시지가 왔습니다";
  }
  notify({ title: shownTitle, body: shownBody, target, sound: settings.sound, flash: settings.flash, urgent });
}

async function pollLoop(token) {
  while (state.pollToken === token) {
    try {
      pollAbort = new AbortController();
      const timeout = setTimeout(() => pollAbort.abort(), 70000);
      const response = await fetch("/api/events", { signal: pollAbort.signal });
      clearTimeout(timeout);
      if (state.pollToken !== token) return;
      if (response.status === 401) {
        showLogin("다시 로그인해 주세요.");
        return;
      }
      const started = Date.now();
      const data = await response.json().catch(() => ({}));
      if (guardResponse(response.status, data)) {
        await delay(5000);
        continue;
      }
      if (!response.ok) throw new Error(data.error || "poll");
      setLive("실시간", false);
      const incoming = Array.isArray(data.messages) ? data.messages : [];
      if (data.notesError) applyNotesError(data.error || "쪽지 기록을 읽지 못했습니다. 다시 시도하세요.");
      else applyNoteRecords(Array.isArray(data.notes) ? data.notes : []);
      if (data.groupsChanged) scheduleGroupsReload();
      if (Array.isArray(data.updated) && data.updated.length) applyUpdated(data.updated);
      if (Array.isArray(data.typing) && data.typing.length) applyTyping(data.typing);
      if (incoming.length) clearTypingFor(incoming);
      if (incoming.some((message) => message.senderId === state.me?.userId) && state.scheduled.length) scheduleScheduledReload();
      if (data.noticesChanged) refreshOpenConversation({ force: true });
      if (data.prefsChanged) {
        if (settingsSaving) prefsReloadPending = true;
        else loadPrefs();
      }
      if (data.policyChanged) refreshPolicy();
      if (data.activity && typeof data.activity === "object") {
        setActivityUnseen(data.activity.unseen, data.activity.unseenByKind);
        if (!$("#center").hidden && !activity.loading) {
          if (activity.loadedOlder) {
            activity.fresh = true;
            renderCenter();
          } else loadActivity();
        }
      }
      const usable = data.notesError ? incoming.filter((message) => message.kind !== "dm") : incoming;
      absorbDmPreviews(usable);
      absorbGroupMessages(usable);
      absorbChannelMessages(usable);
      notifyIncoming(usable);
      if (data.reset && !data.notesError) {
        if (state.hasNewer) loadTalkPreviews();
        else await loadMessages({ quiet: true });
      }
      else if (isTalkView()) {
        const visible = usable.filter(messageMatchesView);
        if (visible.length) addMessages(visible);
      }
      renderList();
      if (Date.now() - started < 800) await delay(800);
    } catch (error) {
      if (state.pollToken !== token) return;
      if (error.name !== "AbortError") {
        setLive("연결이 잠시 끊겼습니다. 다시 시도하는 중…", true);
        await delay(1000);
      }
    }
  }
}

function applyNoteRecords(notes) {
  const previous = state.noteRecords.map((note) => note.messageId).join(",");
  const known = new Set(state.noteRecords.map((note) => note.messageId));
  // 처음 받은 쪽지 목록은 지난 기록이므로 알리지 않는다.
  if (state.noteRecordsLoaded) notifyNewNotes(known, notes);
  state.noteRecordsLoaded = true;
  state.noteRecords = notes;
  state.notesError = "";
  let cacheChanged = false;
  for (const [peerId, list] of Object.entries(state.dmCache)) {
    const kept = list.filter((message) => !isClassifiedNote(message.id));
    if (kept.length !== list.length) {
      state.dmCache[peerId] = kept;
      cacheChanged = true;
    }
  }
  if (cacheChanged && state.me) renderList();
  if (state.view === "dm") {
    const filtered = state.messages.filter((message) => !isClassifiedNote(message.id));
    if (filtered.length !== state.messages.length) {
      state.messages = filtered;
      renderLog();
    }
  }
  const next = notes.map((note) => note.messageId).join(",");
  if (state.view === "notes" && previous !== next) loadNotes({ quiet: true });
}
function applyNotesError(message) {
  state.notesError = message;
  if (state.view === "dm") {
    state.loading = false;
    state.loadError = message;
    state.messages = [];
    renderLog();
  }
  if (state.view === "notes") {
    state.loading = false;
    state.loadError = message;
    renderNotes();
  }
}
let notesTimer = null;
function startNotesWatch() {
  if (notesTimer) return;
  notesTimer = setInterval(() => {
    if (!state.locked && !state.pwForced) refreshNoteIndex();
  }, 1500);
  refreshNoteIndex();
}
function stopNotesWatch() {
  clearInterval(notesTimer);
  notesTimer = null;
}
async function refreshNoteIndex() {
  if (!state.me || state.locked || state.pwForced) return;
  const session = state.sessionGen;
  try {
    const response = await fetch("/api/notes");
    if (response.status === 401 || session !== state.sessionGen) return;
    const data = await response.json().catch(() => ({}));
    if (session !== state.sessionGen) return;
    if (!response.ok) {
      if (response.status === 503) applyNotesError(data.error || "쪽지 기록을 읽지 못했습니다. 다시 시도하세요.");
      return;
    }
    applyNoteRecords(Array.isArray(data.notes) ? data.notes : []);
  } catch {
    if (session === state.sessionGen && state.me) applyNotesError("쪽지 기록을 읽지 못했습니다. 다시 시도하세요.");
  }
}
async function loadNotes({ quiet = false } = {}) {
  if (!quiet) {
    state.loading = true;
    state.loadError = "";
    state.noteMessages = [];
    renderNotes();
  }
  try {
    const session = state.sessionGen;
    const response = await fetch("/api/notes/messages");
    if (response.status === 401) {
      showLogin("다시 로그인해 주세요.");
      return;
    }
    const data = await response.json().catch(() => ({}));
    if (state.view !== "notes" || session !== state.sessionGen) return;
    if (!response.ok) throw new Error(data.error || "notes");
    state.noteMessages = Array.isArray(data.messages) ? data.messages : [];
    state.loading = false;
    state.loadError = "";
    state.notesError = "";
    renderNotes();
    startPoll();
  } catch (error) {
    if (state.view !== "notes") return;
    state.loading = false;
    state.loadError = error.message && error.message !== "notes" ? error.message : "쪽지 기록을 읽지 못했습니다. 다시 시도하세요.";
    renderNotes();
  }
}

/* ───────── D. 근무 상태 보내기·읽기 ───────── */

let presenceTimer = 0;
let lastInputAt = Date.now();

function currentActivity() {
  const minutes = state.prefs?.presence?.awayMinutes;
  const after = Number.isInteger(minutes) && minutes > 0 ? minutes * 60 * 1000 : IDLE_AFTER_MS;
  return Date.now() - lastInputAt >= after ? "idle" : "active";
}

async function sendPresence() {
  if (!state.me) return;
  state.myStatus = currentActivity();
  renderMyPresence();
  try {
    await api("POST", "/api/presence", { status: state.myStatus });
  } catch {
    // 상태 보내기가 한 번 실패해도 다음 주기에 다시 보낸다.
  }
}

async function readPresence() {
  if (!state.me) return;
  const session = state.sessionGen;
  try {
    const data = await api("GET", "/api/presence");
    if (session !== state.sessionGen) return;
    const raw = data && typeof data.presence === "object" && data.presence ? data.presence : {};
    const presence = {};
    const statuses = {};
    for (const [id, value] of Object.entries(raw)) {
      if (typeof value === "string") presence[id] = value;
      else if (value && typeof value === "object") {
        presence[id] = value.presence;
        if (value.status && typeof value.status === "object") statuses[id] = { code: String(value.status.code || ""), text: String(value.status.text || "") };
      }
    }
    state.presence = presence;
    state.statuses = statuses;
    state.presenceLoaded = true;
    renderList();
    updateHead();
  } catch {
    // 상태를 못 읽으면 점을 바꾸지 않는다.
  }
}

function presenceTick() {
  sendPresence();
  readPresence();
}

function startPresence() {
  if (presenceTimer) return;
  lastInputAt = Date.now();
  presenceTimer = window.setInterval(presenceTick, PRESENCE_EVERY_MS);
  presenceTick();
}

function stopPresence() {
  window.clearInterval(presenceTimer);
  presenceTimer = 0;
  state.presence = {};
  state.presenceLoaded = false;
}

function noteInput() {
  const wasIdle = state.myStatus === "idle";
  lastInputAt = Date.now();
  if (wasIdle && state.me && presenceTimer) sendPresence();
}

let lastMoveAt = 0;
for (const type of ["keydown", "mousedown", "wheel", "touchstart", "focus"]) {
  window.addEventListener(type, noteInput, { passive: true, capture: true });
}
window.addEventListener("mousemove", () => {
  const now = Date.now();
  if (now - lastMoveAt < 5000) return;
  lastMoveAt = now;
  noteInput();
}, { passive: true });

/* ───────── 화면 전환 ───────── */

function updateHead() {
  const title = $("#channel-name");
  const kicker = $("#channel-kicker");
  const slot = $("#chat-avatar");
  const view = state.view;
  let name = "대화";
  let sub = "";
  let node = null;
  let chip = null;
  let presence = null;
  if (view === "dm" && state.selectedUser) {
    const person = personById(state.selectedUser.userId) || state.selectedUser;
    name = state.selectedUser.fullName;
    sub = personTitle(person);
    node = personAvatar(person);
    const dot = presenceDot(person.userId, true);
    if (dot) {
      presence = el("span", "head-st");
      const chip = statusChip(person.userId);
      if (chip) presence.append(chip);
      presence.append(dot, statusText(person.userId));
      const line = manualStatus(person.userId)?.text;
      if (line) presence.title = line;
    }
  } else if (view === "group" && state.selectedGroup) {
    const group = state.selectedGroup;
    const ids = group.memberIds || [];
    name = group.name || "이름 없는 그룹";
    chip = el("span", "count-chip");
    chip.title = `참여자 ${ids.length}명`;
    chip.append(iconUse("ico-person"), String(ids.length));
    const others = ids.filter((id) => id !== state.me?.userId).map(nameOf);
    sub = [...others, ...(ids.includes(state.me?.userId) ? ["나"] : [])].join(", ");
    node = group.dept ? deptAvatar() : groupAvatar();
  } else if (view === "general") {
    name = GENERAL_NAME;
    sub = `전체 채널 · ${state.people.length + 1}명`;
    node = groupAvatar();
  } else if (view === "notes" && state.selectedNotePeer) {
    name = state.selectedNotePeer.fullName;
    sub = "쪽지";
    node = personAvatar(personById(state.selectedNotePeer.userId));
  } else if (view === "notes") {
    name = "쪽지";
  } else if (view === "home") {
    name = "직원";
  }
  title.textContent = name;
  if (chip) title.append(chip);
  kicker.replaceChildren();
  if (presence) kicker.append(presence);
  if (sub) kicker.append(el("span", "head-sub", sub));
  kicker.title = view === "group" ? sub : "";
  // 1:1·그룹 머리글의 둘째 줄은 상태·참여자 자리. 연결이 끊겼을 때만 연결 상태를 보인다.
  $("#live-status").hidden = (view === "dm" || view === "group") && !state.liveError;
  slot.replaceChildren();
  slot.hidden = !node;
  slot.className = "head-av";
  if (node) slot.append(node);
  const talk = isTalkView(view) && (view !== "group" || Boolean(state.selectedGroup));
  $("#group-actions").hidden = !talk;
  updateRoomMenu();
}

function updateChrome() {
  const view = state.view;
  const talkLike = view === "talk" || isTalkView(view);
  const noteOpen = view === "notes" && Boolean(state.selectedNotePeer);
  const showLog = isTalkView(view);
  document.body.dataset.view = view;
  document.body.classList.toggle("show-thread", showLog || noteOpen);

  $("#list-title").textContent = view === "home" ? "직원" : view === "notes" ? "쪽지함" : "대화";
  $("#list-search").placeholder = view === "home" ? "이름, 직책 검색" : view === "notes" ? "보낸 사람, 받는 사람 검색" : "대화방, 이름, 메시지 검색";
  $("#talk-chips").hidden = !talkLike;
  $("#note-chips").hidden = view !== "notes";
  $("#talk-list").hidden = !talkLike;
  $("#staff-list").hidden = view !== "home";
  $("#notes-list").hidden = view !== "notes";

  $("#log").hidden = !showLog;
  $("#composer").hidden = !showLog;
  $("#note-log").hidden = !noteOpen;
  $("#note-composer").hidden = !noteOpen;
  $("#thread-empty").hidden = showLog || noteOpen;
  $("#thread-empty-text").textContent = view === "notes"
    ? "왼쪽에서 쪽지를 선택하세요."
    : view === "home" ? "직원을 눌러 대화나 쪽지를 시작하세요." : "왼쪽에서 대화를 선택하세요.";
  $("#log").setAttribute("aria-label", view === "general" ? "general 채널 메시지" : view === "group" ? "그룹 대화" : "대화");

  const input = $("#composer-input");
  if (input) {
    input.placeholder = view === "dm" && state.selectedUser
      ? `${state.selectedUser.fullName}님에게 메시지 보내기`
      : view === "group" && state.selectedGroup ? `${state.selectedGroup.name || "그룹"}에 메시지 보내기`
        : view === "general" ? `${GENERAL_NAME}에 메시지 보내기` : "메시지를 입력하세요";
    input.dataset.placeholder = input.placeholder;
  }
  renderCompose();
  const noteField = $("#note-thread-input");
  if (noteField && state.selectedNotePeer) noteField.placeholder = `${state.selectedNotePeer.fullName}님에게 쪽지 보내기`;

  for (const [id, on] of [["#rail-talk", talkLike], ["#rail-people", view === "home"], ["#rail-notes", view === "notes"]]) {
    const node = $(id);
    if (on) node.setAttribute("aria-current", "page");
    else node.removeAttribute("aria-current");
  }
  updateHead();
  renderSearchChrome();
  renderTyping();
  renderSched();
  renderStarredChrome();
  renderWatermark();
}

function listGroup(view) {
  return view === "home" ? "home" : view === "notes" ? "notes" : "talk";
}

let confirmResolve = null;

/** 확인 대화상자. 확인이면 true, 취소·Esc면 false. 닫히면 열기 전 포커스로 돌아간다. */
function askConfirm({ title, text, note = "", confirm = "확인", cancel = "머무르기", danger = false, image = false }) {
  const dialog = $("#confirm-dialog");
  if (confirmResolve) confirmResolve(false);
  const opener = document.activeElement;
  $("#confirm-title").textContent = title;
  $("#confirm-text").textContent = text;
  if (note) $("#confirm-text").append("\n", el("small", "note", note));
  $("#confirm-ok").textContent = confirm;
  $("#confirm-ok").className = danger ? "btn danger" : "btn primary";
  $("#confirm-img").hidden = !image;
  $("#confirm-cancel").textContent = cancel;
  return new Promise((resolve) => {
    confirmResolve = (value) => {
      confirmResolve = null;
      if (dialog.open) dialog.close();
      if (opener?.isConnected && !value) opener.focus();
      resolve(value);
    };
    dialog.showModal();
    $("#confirm-cancel").focus();
  });
}
$("#confirm-form").addEventListener("submit", (event) => {
  event.preventDefault();
  confirmResolve?.(true);
});
$("#confirm-cancel").addEventListener("click", () => confirmResolve?.(false));
$("#confirm-dialog").addEventListener("close", () => confirmResolve?.(false));

/* PM 결정: 올리는 중인 파일이 있는 대화를 떠나면 확인을 받는다. 머무르면 해시도 되돌린다. */
async function confirmLeaveUploads(nextKey) {
  const uploader = isTalkView() ? composerUploader : state.view === "notes" && state.selectedNotePeer ? noteUploader : null;
  const current = state.view === "notes" ? `notes:${state.selectedNotePeer?.userId || ""}` : convKey();
  if (!uploader || nextKey === current) return true;
  const count = uploader.uploadingCount();
  if (!count) return true;
  const ok = await askConfirm({
    title: "대화를 옮길까요?",
    text: `올리는 중인 파일 ${count}개가 취소됩니다. 이동할까요?`,
    confirm: "이동",
  });
  if (!ok) {
    // 해시·알림으로 들어온 이동이면 주소를 지금 대화로 되돌린다.
    const want = hashFor();
    if (location.hash !== want) history.replaceState(null, "", want || location.pathname + location.search);
  }
  return ok;
}

function nextKeyFor(view, target) {
  if (view === "dm") return `dm:${(target || state.selectedUser)?.userId || ""}`;
  if (view === "group") return `group:${(target || state.selectedGroup)?.groupId || ""}`;
  if (view === "notes") return `notes:${state.selectedNotePeer?.userId || ""}`;
  return view;
}

function stashDraft(key) {
  const input = $("#composer-input");
  if (!input || !key) return;
  const text = input.value;
  if (text.trim()) state.drafts[key] = text;
  else delete state.drafts[key];
}

function restoreDraft(key) {
  const input = $("#composer-input");
  if (!input) return;
  input.value = state.drafts[key] || "";
  input.style.height = "auto";
  if (input.value) input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

async function setView(view, target) {
  if (!["home", "talk", "notes", "general", "dm", "group"].includes(view)) return;
  if (!(await confirmLeaveUploads(nextKeyFor(view, target)))) return;
  const previousKey = convKey();
  const previousView = state.view;
  if (view === "dm") {
    if (target) state.selectedUser = target;
    if (!state.selectedUser) return;
  }
  if (view === "group") {
    if (target) state.selectedGroup = groupById(target.groupId) || target;
    if (!state.selectedGroup) return;
  }
  state.view = view;
  const sameKey = convKey() === previousKey;
  if (sameKey && !state.loadError && !state.directoryError && !state.notesError) {
    syncHash();
    return;
  }
  if (listGroup(view) !== listGroup(previousView)) {
    state.query = "";
    $("#list-search").value = "";
    resetListSearch();
  }
  if (!sameKey) leaveConversation();
  if (!sameKey && isTalkView(previousView)) {
    stashDraft(previousKey);
    composerUploader.clear();
    state.messages = [];
    state.hasOlder = false;
    state.loadingOlder = false;
    state.olderError = "";
  }
  if (!sameKey && isTalkView(view)) restoreDraft(convKey());
  if (previousView === "notes" && view !== "notes") noteUploader.clear();
  state.noteStatus = "";
  if (view === "general") state.generalUnread = 0;
  if (view !== "notes") state.selectedNotePeer = null;
  updateComposer();
  updateChrome();
  syncHash();
  if (view === "home" || view === "talk") {
    await loadDirectory();
    return;
  }
  if (view === "notes") {
    await loadNotes();
    return;
  }
  renderList();
  await loadMessages();
}

function openChooser(person) {
  if (!person) return;
  const dialog = $("#chooser");
  if (dialog.open && state.chooserUser?.userId === person.userId) return;
  if (dialog.open) dialog.close();
  state.chooserUser = person;
  $("#chooser-title").textContent = person.fullName;
  $("#chooser-role").textContent = personTitle(person);
  dialog.showModal();
  $("#chooser-talk").focus();
}

function openTalk(person) {
  restoreChooserFocus = false;
  if ($("#chooser").open) $("#chooser").close();
  setView("dm", person).then(() => {
    if (state.view === "dm") $("#composer-input")?.focus();
  });
}

async function openNoteThread(userId) {
  const person = personById(userId);
  const peer = { userId, fullName: person?.fullName || state.noteMessages.find((note) => note.peerId === userId)?.counterpartName || "쪽지" };
  if (state.view !== "notes") {
    if (!(await confirmLeaveUploads(`notes:${userId}`))) return;
    // 쪽지 화면으로 옮기기 전에 상대를 정해 두어야 해시 기록이 한 번만 쌓인다.
    noteUploader.clear();
    stashDraft(convKey());
    composerUploader.clear();
    state.selectedNotePeer = peer;
    await setView("notes");
    return;
  }
  await selectNotePeer(peer);
}

function openNote(person) {
  restoreChooserFocus = false;
  if ($("#chooser").open) $("#chooser").close();
  state.noteUser = person;
  state.noteSending = false;
  $("#note-target").textContent = `${person.fullName} · ${personTitle(person)}`;
  $("#note-input").value = "";
  $("#note-error").textContent = "";
  $("#note-send").disabled = false;
  $("#note-send").textContent = "보내기";
  $("#note-dialog").showModal();
  $("#note-input").focus();
}

function showLogin(message) {
  state.sessionGen += 1;
  state.previewGeneration += 1;
  stopPoll();
  stopNotesWatch();
  stopPresence();
  composerUploader.clear();
  noteUploader.clear();
  window.clearTimeout(personClickTimer);
  window.clearTimeout(groupsReloadTimer);
  window.clearTimeout(scheduledTimer);
  window.clearTimeout(typingTimer);
  window.clearTimeout(typingIdleTimer);
  window.clearTimeout(searchTimer);
  window.clearTimeout(inSearchTimer);
  window.clearTimeout(lockSyncTimer);
  window.clearInterval(snoozeTimer);
  snoozeTimer = 0;
  hashDeferred = false;
  blockedStartHash = "";
  closeNewMenu();
  for (const id of ["#chooser", "#note-dialog", "#group-dialog", "#leave-dialog", "#confirm-dialog"]) {
    const dialog = $(id);
    if (dialog?.open) dialog.close();
  }
  closeGroupMenu();
  leaveConversation();
  resetListSearch();
  stopReceipts();
  closeStatusPop();
  state.urgent = null;
  closeAckPop();
  for (const id of ["#viewer", "#sched-dialog", "#settings", "#notice-dialog"]) {
    const dialog = $(id);
    if (dialog?.open) dialog.close();
  }
  closeMenu("#send-menu", "#send-more");
  closeMenu("#plus-menu", "#composer-plus");
  if ($("#widget-dialog").open) $("#widget-dialog").close();
  clearLock();
  closePasswordChange();
  $("#watermark").hidden = true;
  typingState.clear();
  state.statuses = {};
  state.prefs = normalizePrefs({});
  settingsSeq += 1;
  prefsReloadPending = false;
  sessionList.items = null;
  sessionList.error = "";
  privacyState.data = null;
  Object.assign(appSettings, { autostart: null, closeAction: null, hotkey: null, captureBlock: null, capturing: false, hotkeyInactiveShown: false });
  shownImages.clear();
  window.clearTimeout(snoozeEndTimer);
  closeSnoozeMenu();
  closeCenter();
  activity.items = [];
  activity.hasOlder = false;
  activity.loaded = false;
  activity.error = "";
  activity.unseen = 0;
  activity.byKind = null;
  keywordState.list = [];
  keywordState.available = false;
  keywordState.gen += 1;
  renderSnooze();
  state.scheduled = [];
  state.starredOpen = false;
  state.starred = { messages: [], hasOlder: false, loading: false, error: "", gen: state.starred.gen + 1 };
  renderStarredChrome();
  setUnread(0);
  state.me = null;
  state.messages = [];
  state.hasOlder = false;
  state.loadingOlder = false;
  state.olderError = "";
  state.view = "talk";
  state.selectedUser = null;
  state.selectedGroup = null;
  state.selectedNotePeer = null;
  state.people = [];
  state.groups = [];
  state.dmCache = {};
  state.readCursor = {};
  state.groupCache = {};
  state.groupRead = {};
  state.generalLast = null;
  state.generalUnread = 0;
  state.generalRead = null;
  state.generalMention = false;
  state.pendingJump = null;
  state.jump = null;
  state.noticeHidden = new Set();
  state.noteRecords = [];
  state.noteRecordsLoaded = false;
  state.noteMessages = [];
  state.notesError = "";
  state.directoryError = "";
  state.directoryLoading = false;
  state.loading = false;
  state.loadError = "";
  state.sendingKeys = new Set();
  state.sendErrors = {};
  state.drafts = {};
  state.authBusy = false;
  state.noteStatus = "";
  setMode("login");
  setLoginError(message || "");
  $("#login-button").disabled = false;
  $("#login-button").textContent = "로그인";
  $("#email").disabled = false;
  $("#password").disabled = false;
}

async function showChat() {
  state.sessionGen += 1;
  setMode("chat");
  state.selectedUser = null;
  state.selectedGroup = null;
  state.selectedNotePeer = null;
  state.noteStatus = "";
  state.view = "";
  $("#me-name").textContent = state.me.fullName || state.me.email;
  renderMyAvatar();
  setLive("연결하는 중…", false);
  $("#send-error").textContent = "";
  loadReadState();
  loadNoticeHidden();
  readReported = {};
  savedRead = "";
  startNotesWatch();
  startReceipts();
  loadPrefs();
  loadActivityCount();
  loadKeywords();
  loadScheduled();
  lastInputAt = Date.now();
  startLockWatch();
  state.startBlocked = Boolean(state.me?.mustChangePassword || state.me?.locked);
  if (state.me?.mustChangePassword) openPasswordChange({ forced: true });
  if (state.me?.locked) lockScreen({ fromServer: true });
  else {
    try {
      if (localStorage.getItem(lockKey()) === "1") {
        state.startBlocked = true;
        lockScreen();
      }
    } catch {
      // 저장소를 못 쓰면 잠금 기록을 이어 가지 않는다.
    }
  }
  pendingHash = parseHash(location.hash) ? location.hash : "";
  await setView("talk");
  const hash = pendingHash;
  pendingHash = "";
  if (!hash || !state.me) return;
  // 강제 비밀번호·잠금으로 막힌 채 시작했으면 목록을 못 읽었으므로, 풀린 뒤 처음 주소를 연다.
  if (state.pwForced || state.locked) {
    blockedStartHash = hash;
    return;
  }
  if (!routeTo(hash)) syncHash();
}

/* 처음 로드와 같은 다시 읽기(잠금·비밀번호 강제가 풀린 뒤, "다시 시도"). */
async function reloadAll() {
  if (!state.me || state.locked || state.pwForced) return;
  state.startBlocked = false;
  refreshNoteIndex();
  refreshPolicy(); // 세션 policy·limits와 prefs
  loadActivityCount();
  loadKeywords();
  loadScheduled();
  await loadDirectory();
}

let blockedStartHash = "";
/* 막혀 있던 처음 주소: 직원·그룹 목록을 다시 읽은 뒤 연다. */
async function openBlockedStartHash() {
  const hash = blockedStartHash;
  if (!hash || state.pwForced || state.locked) return false;
  blockedStartHash = "";
  await reloadAll();
  if (state.me && !routeTo(hash)) syncHash();
  return true;
}

async function boot() {
  try {
    const response = await fetch("/api/session");
    if (!response.ok) {
      showLogin();
      return;
    }
    state.me = await response.json();
    showChat();
  } catch {
    showLogin("서버에 연결하지 못했습니다.");
  }
}

/* ───────── C. 첨부 ───────── */

/* 서버가 /api/session에 limits를 주면 그 값으로, 없으면 기본값으로 미리 검사한다(서버도 다시 검사). */
function uploadLimits() {
  const limits = state.me?.limits || {};
  const mb = Number.isFinite(limits.maxUploadMb) && limits.maxUploadMb > 0 ? limits.maxUploadMb : MAX_UPLOAD_MB;
  const blocked = Array.isArray(limits.blockedExtensions)
    ? new Set(limits.blockedExtensions.map((ext) => String(ext).replace(/^\./, "").toLowerCase()).filter(Boolean))
    : BLOCKED_EXT;
  return { mb, blocked };
}
const tooBigText = () => `파일이 너무 큽니다. 파일당 ${uploadLimits().mb}MB까지 보낼 수 있어요.`;
const UPLOAD_NETWORK = "올리지 못했습니다. 연결을 확인하고 다시 시도하세요.";
const blockedText = (name) => `기관 정책으로 막힌 파일 형식입니다(.${extOf(name) || "?"}).`;

function precheck(file) {
  const { mb, blocked } = uploadLimits();
  if (blocked.has(extOf(file.name))) return blockedText(file.name);
  if (file.size > mb * 1024 * 1024) return tooBigText();
  if (file.size === 0) return "빈 파일은 보낼 수 없습니다.";
  return "";
}

function pastedName(file) {
  if (file.name && file.name !== "image.png") return file.name;
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const ext = extOf(file.name) || (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
  return `붙여넣은 이미지 ${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.${ext}`;
}

function createUploader({ listEl, fileInput, attachButton, onChange }) {
  const items = [];
  let nextId = 1;

  function changed() {
    listEl.hidden = items.length === 0;
    onChange();
  }

  function paint(item) {
    const node = item.node;
    const uploading = item.status === "uploading";
    node.classList.toggle("fail", item.status === "error");
    const percent = item.status === "done" ? 100 : Math.round(item.progress * 100);
    item.bar.firstChild.style.width = `${percent}%`;
    item.bar.setAttribute("aria-valuenow", String(percent));
    item.bar.hidden = !uploading;
    const total = formatSize(item.file.size);
    item.meta.textContent = uploading
      ? `${total} 중 ${formatSize(Math.round(item.file.size * item.progress))} · ${percent}%`
      : total;
    item.err.textContent = item.status === "error" ? item.error : "";
    item.err.hidden = item.status !== "error";
    item.ok.hidden = item.status !== "done";
    item.retry.hidden = item.status !== "error" || !item.canRetry;
    item.remove.setAttribute("aria-label", uploading ? `${item.name} 올리기 취소` : `${item.name} 빼기`);
    item.remove.title = uploading ? "올리기 취소" : "빼기";
  }

  function build(item) {
    const node = el("div", "up");
    const info = el("div", "");
    const line = el("div", "nm");
    const name = el("b", "", item.name);
    name.title = item.name;
    item.meta = el("small", "", "");
    line.append(name, item.meta);
    item.bar = el("div", "bar");
    item.bar.setAttribute("role", "progressbar");
    item.bar.setAttribute("aria-label", `${item.name} 올리는 중`);
    item.bar.setAttribute("aria-valuemin", "0");
    item.bar.setAttribute("aria-valuemax", "100");
    item.bar.append(el("i"));
    item.err = el("div", "err");
    item.err.setAttribute("role", "alert");
    info.append(line, item.bar, item.err);
    const acts = el("div", "acts");
    item.ok = el("span", "ok");
    item.ok.append(iconUse("ico-check"), "준비됨");
    item.retry = el("button", "txt-btn", "다시 시도");
    item.retry.type = "button";
    item.retry.addEventListener("click", () => start(item));
    item.remove = el("button", "icon-btn");
    item.remove.type = "button";
    item.remove.append(iconUse("ico-x"));
    item.remove.addEventListener("click", () => drop(item));
    acts.append(item.ok, item.retry, item.remove);
    node.append(fileTypeBadge(item.name), info, acts);
    item.node = node;
    listEl.append(node);
    paint(item);
  }

  function fail(item, message, canRetry = true) {
    item.status = "error";
    item.error = message;
    item.canRetry = canRetry;
    item.xhr = null;
    paint(item);
    changed();
  }

  function start(item) {
    item.status = "uploading";
    item.progress = 0;
    item.error = "";
    const xhr = new XMLHttpRequest();
    item.xhr = xhr;
    xhr.open("POST", "/api/files");
    xhr.setRequestHeader("content-type", item.file.type || "application/octet-stream");
    xhr.setRequestHeader("x-file-name", encodeURIComponent(item.name));
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      item.progress = Math.min(0.99, event.loaded / event.total);
      paint(item);
    };
    xhr.onload = () => {
      if (item.xhr !== xhr) return;
      let data = {};
      try {
        data = JSON.parse(xhr.responseText || "{}");
      } catch {
        data = {};
      }
      if (xhr.status === 401) {
        showLogin("다시 로그인해 주세요.");
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300 && data.file && data.file.path) {
        item.status = "done";
        item.result = {
          name: data.file.name || item.name,
          path: data.file.path,
          size: typeof data.file.size === "number" ? data.file.size : item.file.size,
          type: data.file.type || item.file.type || "",
        };
        item.xhr = null;
        paint(item);
        changed();
        return;
      }
      if (xhr.status === 413) fail(item, data.error || tooBigText(), false);
      else if (xhr.status === 415) fail(item, blockedText(item.name), false);
      else fail(item, data.error || UPLOAD_NETWORK, true);
    };
    xhr.onerror = () => {
      if (item.xhr === xhr) fail(item, UPLOAD_NETWORK);
    };
    xhr.send(item.file);
    paint(item);
    changed();
  }

  function drop(item) {
    const index = items.indexOf(item);
    if (index < 0) return;
    if (item.xhr) {
      const xhr = item.xhr;
      item.xhr = null;
      xhr.abort();
    }
    items.splice(index, 1);
    item.node.remove();
    changed();
  }

  function add(fileList, { pasted = false } = {}) {
    for (const raw of fileList) {
      if (!raw) continue;
      const item = { id: nextId++, file: raw, name: pasted ? pastedName(raw) : raw.name || "이름 없음", status: "uploading", progress: 0, error: "", xhr: null, result: null, canRetry: true };
      items.push(item);
      build(item);
      const problem = precheck(raw);
      if (problem) fail(item, problem, false);
      else start(item);
    }
    changed();
  }

  attachButton.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    add([...fileInput.files]);
    fileInput.value = "";
  });

  return {
    add,
    busy: () => items.some((item) => item.status === "uploading"),
    ready: () => items.filter((item) => item.status === "done").map((item) => item.result),
    uploadingCount: () => items.filter((item) => item.status === "uploading").length,
    /** 보낸 첨부(ready()가 돌려준 객체)만 뺀다. 보내는 동안 새로 준비된 파일은 남는다. */
    remove(results) {
      const sent = new Set(results || []);
      for (const item of items.filter((entry) => entry.status === "done" && sent.has(entry.result))) drop(item);
    },
    clear() {
      for (const item of items.slice()) drop(item);
    },
  };
}

const composerUploader = createUploader({
  listEl: $("#composer-uploads"),
  fileInput: $("#composer-file"),
  attachButton: $("#composer-attach"),
  onChange: () => updateComposer(),
});

const noteUploader = createUploader({
  listEl: $("#note-uploads"),
  fileInput: $("#note-file"),
  attachButton: $("#note-attach"),
  onChange: () => updateNoteComposer(),
});

function updateNoteComposer() {
  const input = $("#note-thread-input");
  const button = $("#note-thread-send");
  if (!input || !button) return;
  button.disabled = state.noteSending || noteUploader.busy() || (!input.value.trim() && !noteUploader.ready().length);
  button.title = noteUploader.busy() ? "올리는 중인 파일이 끝나면 보낼 수 있어요" : "";
}

function dropRoomName() {
  if (state.view === "dm" && state.selectedUser) return state.selectedUser.fullName;
  if (state.view === "group" && state.selectedGroup) return state.selectedGroup.name || "그룹";
  if (state.view === "general") return GENERAL_NAME;
  if (state.view === "notes" && state.selectedNotePeer) return `${state.selectedNotePeer.fullName} 쪽지`;
  return "";
}

function activeUploader() {
  if (!$("#composer").hidden) return composerUploader;
  if (!$("#note-composer").hidden) return noteUploader;
  return null;
}

function hasFiles(event) {
  return [...(event.dataTransfer?.types || [])].includes("Files");
}

let dragDepth = 0;
const chatPane = $("#thread-pane");
chatPane.addEventListener("dragenter", (event) => {
  if (!hasFiles(event) || !activeUploader()) return;
  event.preventDefault();
  dragDepth += 1;
  if (!chatPane.classList.contains("dragging")) {
    const room = dropRoomName();
    $("#drop-room").textContent = `${room ? `${room} · ` : ""}여러 개를 한 번에 놓아도 됩니다`;
    $("#drop-limit").textContent = `파일당 최대 ${uploadLimits().mb}MB · 실행 파일(.exe .bat .msi 등)은 보낼 수 없어요`;
  }
  chatPane.classList.add("dragging");
});
chatPane.addEventListener("dragover", (event) => {
  if (!hasFiles(event) || !activeUploader()) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
});
chatPane.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) chatPane.classList.remove("dragging");
});
chatPane.addEventListener("drop", (event) => {
  dragDepth = 0;
  chatPane.classList.remove("dragging");
  const uploader = activeUploader();
  if (!hasFiles(event) || !uploader) return;
  event.preventDefault();
  uploader.add([...event.dataTransfer.files]);
});
// 대화창 밖에 떨어뜨려도 브라우저가 파일을 열어 버리지 않게 한다.
window.addEventListener("dragover", (event) => { if (hasFiles(event)) event.preventDefault(); });
window.addEventListener("drop", (event) => { if (hasFiles(event)) event.preventDefault(); });

function wirePaste(input, uploader) {
  input.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.files || [])];
    if (!files.length) return;
    event.preventDefault();
    uploader.add(files, { pasted: true });
  });
}
wirePaste($("#composer-input"), composerUploader);
wirePaste($("#note-thread-input"), noteUploader);

/* ───────── B. 그룹 ───────── */

function closeMenu(menuId, buttonId) {
  const menu = $(menuId);
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  $(buttonId).setAttribute("aria-expanded", "false");
}

function openMenu(menuId, buttonId) {
  const menu = $(menuId);
  menu.hidden = false;
  $(buttonId).setAttribute("aria-expanded", "true");
  menu.querySelector("button:not([hidden])")?.focus();
}

/* 대화방 메뉴(시안 v3): 숨긴 공지가 있으면 "공지 보기", 일반 그룹이면 이름 바꾸기·초대·나가기.
 * 부서방·1:1·전체 채널은 그룹 항목을 아예 뺀다. 보일 항목이 없으면 메뉴 버튼도 숨긴다. */
function updateRoomMenu() {
  const button = $("#group-menu-btn");
  if (!button) return;
  const talk = isTalkView() && (state.view !== "group" || Boolean(state.selectedGroup));
  const noticeHidden = talk && Boolean(state.notice) && state.noticeHidden.has(noticeId(state.notice));
  const groupItems = talk && state.view === "group" && !state.selectedGroup?.dept;
  const key = convKey();
  const fav = $("#room-fav");
  fav.hidden = !talk;
  fav.querySelector("span").textContent = talk && isFavorite(key) ? "즐겨찾기에서 빼기" : "즐겨찾기에 추가";
  const mute = $("#room-mute");
  mute.hidden = !talk;
  const muted = talk && isMuted(key);
  mute.querySelector("span").textContent = muted ? "알림 켜기" : "알림 끄기";
  mute.querySelector("use").setAttribute("href", muted ? "#ico-bell" : "#ico-bell-off");
  $("#room-files").hidden = !talk;
  $("#room-search").hidden = !talk;
  $("#room-sched").hidden = !talk;
  $("#room-notice").hidden = !noticeHidden;
  $("#room-notice-sep").hidden = !(talk && groupItems);
  for (const node of document.querySelectorAll("[data-group-action], [data-group-action-sep]")) node.hidden = !groupItems;
  button.hidden = !talk;
  if (button.hidden) closeGroupMenu();
}

function closeGroupMenu() {
  closeMenu("#group-menu", "#group-menu-btn");
}

function closeNewMenu() {
  closeMenu("#new-menu", "#new-talk");
}

function wireMenu(menuId, buttonId) {
  $(buttonId).addEventListener("click", (event) => {
    event.stopPropagation();
    if ($(menuId).hidden) openMenu(menuId, buttonId);
    else closeMenu(menuId, buttonId);
  });
  $(menuId).addEventListener("keydown", (event) => {
    const items = [...$(menuId).querySelectorAll("button:not([hidden])")];
    const index = items.indexOf(document.activeElement);
    if (event.key === "Escape") {
      closeMenu(menuId, buttonId);
      $(buttonId).focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      items[(index + step + items.length) % items.length]?.focus();
    } else if (event.key === "Tab") {
      closeMenu(menuId, buttonId);
    }
  });
}
wireMenu("#group-menu", "#group-menu-btn");
wireMenu("#new-menu", "#new-talk");
document.addEventListener("click", (event) => {
  if (!event.target.closest?.("#group-actions")) closeGroupMenu();
  if (!event.target.closest?.("#new-menu")) closeNewMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  closeGroupMenu();
  closeNewMenu();
});

/* 계약서 B + PM 결정(11/16): 자동 이름은 나를 빼고 참여자 3명 + "외 N명". */
function defaultGroupName(ids) {
  const names = ids.filter((id) => id !== state.me?.userId).map(nameOf);
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} 외 ${names.length - 3}명`;
}

function splitTitle(person) {
  const parts = (typeof person?.title === "string" ? person.title : "").split("·").map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) return { position: parts.slice(0, -1).join(" · "), dept: parts[parts.length - 1] };
  return { position: parts[0] || roleLabel(person?.role), dept: "" };
}

function pickRow({ person, checked, disabled, tag }) {
  const row = el(disabled ? "div" : "label", disabled ? "person disabled" : "person");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.className = "cb";
  box.checked = checked;
  box.disabled = disabled;
  if (disabled) box.setAttribute("aria-label", `${person.fullName} (${tag})`);
  const text = el("span", "");
  text.append(el("b", "", person.fullName), el("em", "", splitTitle(person).position));
  row.append(box, personAvatar(person, { small: true }), text);
  if (tag) row.append(el("span", "tag", tag));
  else {
    const status = statusChips(person.userId);
    if (status) row.append(status);
  }
  if (!disabled) {
    box.addEventListener("change", () => {
      if (box.checked) state.groupDialog.picked.add(person.userId);
      else state.groupDialog.picked.delete(person.userId);
      renderPickedChips();
    });
  }
  return row;
}

function renderGroupPicker() {
  const dialog = state.groupDialog;
  const list = $("#group-pick");
  const query = $("#group-search").value.trim().toLowerCase();
  const members = new Set(dialog.mode === "invite" ? state.selectedGroup?.memberIds || [] : []);
  const matches = (person) => !query || [person.fullName, person.title || ""].some((text) => text.toLowerCase().includes(query));
  list.replaceChildren();
  if (state.me && dialog.mode === "create" && (!query || (state.me.fullName || "").toLowerCase().includes(query))) {
    list.append(pickRow({ person: { ...state.me, fullName: state.me.fullName || "나" }, checked: true, disabled: true, tag: "나" }));
  }
  const depts = new Map();
  for (const person of state.people.filter(matches)) {
    const dept = splitTitle(person).dept || "기타";
    if (!depts.has(dept)) depts.set(dept, []);
    depts.get(dept).push(person);
  }
  const names = [...depts.keys()].sort((a, b) => (a === "기타") - (b === "기타") || a.localeCompare(b, "ko"));
  for (const dept of names) {
    const people = depts.get(dept).sort((a, b) => a.fullName.localeCompare(b.fullName, "ko"));
    const head = el("div", "dept");
    head.append(el("span", "", dept), el("span", "", `${people.length}명`));
    list.append(head);
    for (const person of people) {
      const joined = members.has(person.userId);
      list.append(pickRow({ person, checked: joined || dialog.picked.has(person.userId), disabled: joined, tag: joined ? "참여 중" : "" }));
    }
  }
  if (!names.length) list.append(el("p", "pick-empty", "검색 결과가 없습니다"));
  renderPickedChips();
}

function renderPickedChips() {
  const dialog = state.groupDialog;
  const ids = [...dialog.picked];
  const wrap = $("#group-picked");
  wrap.replaceChildren(el("span", "lbl", `선택 ${ids.length}명`));
  for (const id of ids) {
    const person = personById(id);
    if (!person) continue;
    const chip = el("span", "pchip");
    const remove = el("button");
    remove.type = "button";
    remove.setAttribute("aria-label", `${person.fullName} 빼기`);
    remove.append(iconUse("ico-x"));
    remove.addEventListener("click", () => {
      dialog.picked.delete(id);
      renderGroupPicker();
      $("#group-search").focus();
    });
    chip.append(avatar(person, { small: true }), person.fullName, remove);
    wrap.append(chip);
  }
  const submit = $("#group-submit");
  if (dialog.mode === "create") {
    submit.textContent = `만들기 (${ids.length + 1}명)`;
    $("#group-name").placeholder = ids.length ? defaultGroupName(ids) : "참여자를 고르면 이름이 정해집니다";
  } else if (dialog.mode === "invite") {
    submit.textContent = `초대 (${ids.length}명)`;
  }
  if (!dialog.busy) submit.disabled = dialog.mode !== "rename" && ids.length === 0;
}

let groupDialogOpener = null;

function openGroupDialog(mode, opener) {
  const dialog = state.groupDialog;
  const group = state.selectedGroup;
  if (mode !== "create" && !group) return;
  groupDialogOpener = opener || document.activeElement;
  dialog.mode = mode;
  dialog.picked = new Set();
  dialog.busy = false;
  const box = $("#group-dialog");
  box.classList.toggle("small", mode === "rename");
  $("#group-title").textContent = mode === "create" ? "그룹 대화 만들기" : mode === "rename" ? "이름 바꾸기" : "참여자 초대";
  $("#group-sub").textContent = mode === "create" ? "함께 대화할 직원을 고르세요. 나는 자동으로 들어갑니다."
    : mode === "invite" ? `${group.name || "이 대화방"}에 초대할 직원을 고르세요.` : group.name || "";
  $("#group-name-field").hidden = mode === "invite";
  $("#group-name-help").hidden = mode !== "create";
  $("#group-pick-field").hidden = mode === "rename";
  $("#group-name").value = mode === "rename" ? group.name || "" : "";
  $("#group-name").placeholder = mode === "rename" ? "새 이름" : "";
  $("#group-search").value = "";
  $("#group-error").textContent = "";
  const submit = $("#group-submit");
  submit.disabled = false;
  submit.textContent = mode === "rename" ? "저장" : "";
  if (mode !== "rename") renderGroupPicker();
  box.showModal();
  (mode === "invite" ? $("#group-search") : $("#group-name")).focus();
  if (mode === "rename") $("#group-name").select();
}

function replaceGroup(group) {
  if (!group || !group.groupId) return null;
  const index = state.groups.findIndex((item) => item.groupId === group.groupId);
  if (index >= 0) state.groups[index] = group;
  else state.groups.push(group);
  if (state.selectedGroup?.groupId === group.groupId) state.selectedGroup = group;
  return group;
}

$("#group-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const dialog = state.groupDialog;
  if (dialog.busy) return;
  const ids = [...dialog.picked];
  const name = $("#group-name").value.trim();
  const error = $("#group-error");
  if (dialog.mode !== "rename" && !ids.length) {
    error.textContent = dialog.mode === "create" ? "함께 대화할 직원을 고르세요." : "초대할 직원을 고르세요.";
    return;
  }
  if (dialog.mode === "rename" && !name) {
    error.textContent = "새 이름을 입력하세요.";
    return;
  }
  dialog.busy = true;
  setDialogBusy("#group-dialog", true);
  error.textContent = "";
  const submit = $("#group-submit");
  const label = submit.textContent;
  submit.disabled = true;
  submit.textContent = "처리하는 중…";
  try {
    let group = null;
    if (dialog.mode === "create") {
      const data = await api("POST", "/api/groups", { name, memberIds: ids });
      group = replaceGroup(data.group);
      if (group) state.groupRead[group.groupId] = 0;
    } else if (dialog.mode === "rename") {
      const data = await api("PATCH", `/api/groups/${state.selectedGroup.groupId}`, { name });
      group = replaceGroup(data.group);
    } else {
      const data = await api("POST", `/api/groups/${state.selectedGroup.groupId}/members`, { userIds: ids });
      group = replaceGroup(data.group);
    }
    groupDialogOpener = null;
    $("#group-dialog").close();
    if (dialog.mode === "create" && group) {
      await setView("group", group);
      $("#composer-input")?.focus();
    } else {
      updateChrome();
      renderList();
      $("#group-menu-btn").focus();
    }
  } catch (failure) {
    if (failure.status === 401) return;
    error.textContent = failure.message || "처리하지 못했습니다.";
  } finally {
    dialog.busy = false;
    setDialogBusy("#group-dialog", false);
    if ($("#group-dialog").open) {
      submit.textContent = label;
      submit.disabled = false;
      if (dialog.mode !== "rename") renderPickedChips();
    }
  }
});

$("#group-search").addEventListener("input", () => renderGroupPicker());
$("#group-search").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229) event.preventDefault();
});
$("#group-name").addEventListener("keydown", (event) => {
  // 한글 조합 중 Enter는 글자 확정이므로 제출하지 않는다.
  if (event.key === "Enter" && (event.isComposing || event.keyCode === 229)) event.preventDefault();
});
for (const id of ["#group-cancel", "#group-close"]) {
  $(id).addEventListener("click", () => $("#group-dialog").close());
}
$("#group-dialog").addEventListener("cancel", (event) => {
  if (state.groupDialog.busy) event.preventDefault();
});
$("#group-dialog").addEventListener("close", () => {
  const opener = groupDialogOpener;
  groupDialogOpener = null;
  if (opener?.isConnected && !opener.closest("[hidden]")) opener.focus();
});

for (const button of document.querySelectorAll("[data-group-action]")) {
  button.addEventListener("click", () => {
    closeGroupMenu();
    const action = button.dataset.groupAction;
    if (action === "leave") openLeaveDialog();
    else openGroupDialog(action, $("#group-menu-btn"));
  });
}

function openLeaveDialog() {
  const group = state.selectedGroup;
  if (!group) return;
  $("#leave-title").textContent = `‘${group.name || "이 대화방"}’에서 나갈까요?`;
  $("#leave-error").textContent = "";
  $("#leave-confirm").disabled = false;
  $("#leave-confirm").textContent = "나가기";
  $("#leave-dialog").showModal();
  $("#leave-cancel").focus();
}

$("#leave-cancel").addEventListener("click", () => $("#leave-dialog").close());
let leftGroup = false;
$("#leave-dialog").addEventListener("close", () => {
  if (leftGroup) {
    leftGroup = false;
    return;
  }
  if (state.view === "group" && !$("#group-actions").hidden) $("#group-menu-btn").focus();
});
$("#leave-dialog").addEventListener("cancel", (event) => {
  if ($("#leave-dialog").dataset.busy) event.preventDefault();
});

/** 처리 중엔 취소·닫기 버튼과 Esc 닫기를 막는다. */
function setDialogBusy(selector, busy) {
  const dialog = $(selector);
  if (!dialog) return;
  if (busy) dialog.dataset.busy = "1";
  else delete dialog.dataset.busy;
  for (const button of dialog.querySelectorAll("button[type=button]")) button.disabled = busy;
}
$("#leave-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const group = state.selectedGroup;
  if (!group) return;
  const button = $("#leave-confirm");
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = "나가는 중…";
  setDialogBusy("#leave-dialog", true);
  try {
    await api("DELETE", `/api/groups/${group.groupId}/members/me`);
    state.groups = state.groups.filter((item) => item.groupId !== group.groupId);
    delete state.groupCache[group.groupId];
    delete state.groupRead[group.groupId];
    state.selectedGroup = null;
    composerUploader.clear(); // 나간 방의 업로드는 이어 갈 수 없으므로 확인 없이 취소한다.
    await setView("talk");
    setDialogBusy("#leave-dialog", false);
    leftGroup = true;
    $("#leave-dialog").close();
    state.noteStatus = `‘${group.name || "그룹"}’에서 나왔습니다.`;
    renderList();
    // 나간 대화방의 메뉴 버튼은 사라지므로 목록의 새 대화 버튼으로 포커스를 옮긴다.
    $("#new-talk").focus();
  } catch (failure) {
    setDialogBusy("#leave-dialog", false);
    if (failure.status === 401) return;
    $("#leave-error").textContent = failure.message || "나가지 못했습니다.";
    button.disabled = false;
    button.textContent = "나가기";
  }
});

/* ───────── 2-A: 공지·검색·답장·멘션·수정·회수·읽음 확인 (docs/p2-contract.md) ───────── */

function announce(text) {
  const node = $("#chat-status");
  if (!node) return;
  node.textContent = "";
  window.setTimeout(() => {
    node.textContent = text;
  }, 30);
}

/* 대화를 떠날 때(다른 대화·로그아웃) 그 대화에만 걸린 상태를 정리한다. */
function leaveConversation() {
  closeMsgMenu();
  closeReaders();
  closePicker();
  closeDrawer();
  stopTyping();
  state.schedOpen = false;
  closeMentionPop();
  closeInSearch({ render: false });
  if (state.compose) {
    const input = $("#composer-input");
    if (state.compose.mode === "edit" && input) input.value = state.compose.draft || "";
    state.compose = null;
    renderCompose();
  }
  // pendingJump·jump는 지우지 않는다: 검색 결과를 눌러 다른 대화로 옮길 때 그 대화에서 쓴다.
  state.hasNewer = false;
  state.loadingNewer = false;
  state.noticeOpen = false;
  setNotice(null);
}

/* ── A5 공지 ── */

function noticeHiddenKey() {
  return state.me ? `sangsangtalk.notice.${state.me.userId}` : "";
}

function loadNoticeHidden() {
  state.noticeHidden = new Set();
  try {
    const saved = JSON.parse(localStorage.getItem(noticeHiddenKey()) || "[]");
    if (Array.isArray(saved)) state.noticeHidden = new Set(saved.filter((item) => typeof item === "string").slice(-200));
  } catch {
    // 저장소를 못 쓰면 이번 실행 동안만 기억한다.
  }
}

function saveNoticeHidden() {
  try {
    localStorage.setItem(noticeHiddenKey(), JSON.stringify([...state.noticeHidden].slice(-200)));
  } catch {
    // 저장 실패는 무시한다.
  }
}

function noticeId(notice) {
  return `${convKey()}|${notice?.message?.id || 0}|${notice?.setAt || 0}`;
}

function setNotice(notice) {
  const next = notice && notice.message && notice.message.id ? notice : null;
  if (noticeId(next) !== noticeId(state.notice)) state.noticeOpen = false;
  state.notice = next;
  renderNotice();
}

function formatStamp(unix) {
  return new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(unix * 1000));
}

function canChangeNotice() {
  return state.view !== "general" || Boolean(state.me?.isAdmin);
}

function renderNotice() {
  const bar = $("#notice-bar");
  if (!bar) return;
  const notice = state.notice;
  const show = Boolean(notice) && isTalkView() && !state.noticeHidden.has(noticeId(notice));
  bar.hidden = !show;
  updateRoomMenu();
  if (!show) {
    closeAckPop();
    return;
  }
  const message = notice.message;
  const line = previewText(message) || "(내용 없음)";
  $("#notice-text").textContent = line;
  $("#notice-full").textContent = message.recalled ? RECALLED_TEXT : (message.content || "").trim() || line;
  $("#notice-meta").textContent = `${notice.setByName || "알 수 없음"} 님이 ${notice.setAt ? formatStamp(notice.setAt) : ""}에 등록`;
  $("#notice-clear").hidden = !canChangeNotice();
  $("#notice-error").textContent = "";
  // N8: 확인 요청
  const asks = Boolean(notice.ackRequired);
  $("#notice-ack-tag").hidden = !asks;
  const canView = asks && Boolean(notice.canViewAcks);
  // 관리자는 확인 대상이면서 목록도 볼 수 있다: 그때는 "확인"과 "확인 N/M명"을 함께 둔다.
  $("#notice-ack").hidden = !asks || !notice.ackTarget || Boolean(notice.ackedByMe);
  $("#notice-acked").hidden = !asks || !notice.ackedByMe;
  $("#notice-acks").hidden = !canView;
  if (canView) {
    const total = Number(notice.ackTotal) || 0;
    const count = Number(notice.ackCount) || 0;
    const text = $("#notice-acks-text");
    text.replaceChildren("확인 ", el("b", "", String(count)), `/${total}명`);
    $("#notice-acks").setAttribute("aria-label", `확인 ${count}명, 전체 ${total}명 · 확인 현황 보기`);
    const signature = `${count}/${total}`;
    if (ackPop && ackPop.key === liveKey() && ackPop.signature !== signature) {
      ackPop.signature = signature;
      loadAcks();
    }
  }
  if (ackPop && (!canView || ackPop.key !== liveKey())) closeAckPop();
  bar.classList.toggle("open", state.noticeOpen);
  for (const id of ["#notice-text", "#notice-toggle"]) $(id).setAttribute("aria-expanded", String(state.noticeOpen));
  $("#notice-toggle").setAttribute("aria-label", state.noticeOpen ? "공지 접기" : "공지 펼치기");
}

function toggleNotice() {
  state.noticeOpen = !state.noticeOpen;
  renderNotice();
}

function noticeTarget() {
  const target = { view: state.view };
  if (state.view === "dm") target.userId = state.selectedUser?.userId;
  if (state.view === "group") target.groupId = state.selectedGroup?.groupId;
  return target;
}

let noticeDraft = null; // { key, messageId }

function roomTitle() {
  if (state.view === "dm") return state.selectedUser?.fullName || "이 대화방";
  if (state.view === "group") return state.selectedGroup?.name || "이 대화방";
  return GENERAL_NAME;
}

function setNoticeFrom(messageId) {
  const message = state.messages.find((item) => item.id === messageId);
  if (!message) return;
  noticeDraft = { key: liveKey(), messageId };
  const replacing = Boolean(state.notice && state.notice.message.id !== messageId);
  $("#notice-dlg-sub").textContent = `${roomTitle()} 위쪽에 고정됩니다.${replacing ? " 지금 공지는 바뀝니다." : ""}`;
  $("#notice-dlg-preview").textContent = (message.content || "").trim() || previewText(message) || "(내용 없음)";
  $("#notice-dlg-ack").checked = false; // 기본 꺼짐(디자이너 확정)
  $("#notice-dlg-error").textContent = "";
  $("#notice-dlg-submit").disabled = false;
  $("#notice-dialog").showModal();
  $("#notice-dlg-ack").focus();
}

$("#notice-dlg-close").addEventListener("click", () => $("#notice-dialog").close());
$("#notice-dlg-cancel").addEventListener("click", () => $("#notice-dialog").close());
$("#notice-dialog").addEventListener("close", () => {
  noticeDraft = null;
  if (state.me && isTalkView() && !state.locked) $("#composer-input")?.focus();
});
$("#notice-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const draft = noticeDraft;
  if (!draft || draft.key !== liveKey()) {
    $("#notice-dialog").close();
    return;
  }
  const submit = $("#notice-dlg-submit");
  submit.disabled = true;
  $("#notice-dlg-error").textContent = "";
  const body = { ...noticeTarget(), messageId: draft.messageId };
  if ($("#notice-dlg-ack").checked) body.ackRequired = true;
  try {
    const data = await api("POST", "/api/notices", body);
    if (draft !== noticeDraft) return;
    $("#notice-dialog").close();
    if (draft.key !== liveKey()) return;
    if (data.notice) state.noticeHidden.delete(noticeId(data.notice));
    setNotice(data.notice || null);
    announce(body.ackRequired ? "확인 요청 공지로 등록했습니다." : "공지로 등록했습니다.");
  } catch (error) {
    if (error.status === 401 || draft !== noticeDraft) return;
    $("#notice-dlg-error").textContent = error.message || "공지로 등록하지 못했습니다.";
    submit.disabled = false;
  }
});

/* 받는 사람: 확인 → 확인함. 등록한 사람·관리자: 확인 N/M명 ▾ → 현황 */
async function ackNotice() {
  const key = liveKey();
  const button = $("#notice-ack");
  button.disabled = true;
  $("#notice-error").textContent = "";
  try {
    const data = await api("POST", "/api/notices/ack", noticeTarget());
    if (key !== liveKey()) return;
    if (data.notice) setNotice(data.notice);
    else if (state.notice) setNotice({ ...state.notice, ackedByMe: true });
    announce("공지를 확인했습니다.");
    const acked = $("#notice-acked");
    (acked.hidden ? $("#notice-acks") : acked).focus?.();
  } catch (error) {
    if (error.status === 401 || key !== liveKey()) return;
    $("#notice-error").textContent = error.message || "확인하지 못했습니다.";
    state.noticeOpen = true;
    renderNotice();
  } finally {
    button.disabled = false;
  }
}

let ackPop = null; // { node, tab, data, error, key }

function closeAckPop({ focus = false } = {}) {
  if (!ackPop) return;
  ackPop.node.remove();
  ackPop = null;
  $("#notice-acks").setAttribute("aria-expanded", "false");
  if (focus) $("#notice-acks").focus();
}

function openAckPop() {
  if (ackPop) {
    closeAckPop({ focus: true });
    return;
  }
  const node = el("div", "readers ack-pop");
  node.setAttribute("role", "dialog");
  node.setAttribute("aria-label", "공지 확인 현황");
  node.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeAckPop({ focus: true });
    }
  });
  ackPop = { node, tab: "acked", data: null, error: "", key: liveKey(), signature: `${Number(state.notice?.ackCount) || 0}/${Number(state.notice?.ackTotal) || 0}` };
  $("#notice-bar").append(node);
  $("#notice-acks").setAttribute("aria-expanded", "true");
  renderAckPop();
  node.querySelector("[role=tab][aria-selected=true]")?.focus();
  loadAcks();
}

async function loadAcks() {
  const pop = ackPop;
  if (!pop) return;
  const params = new URLSearchParams(Object.entries(noticeTarget()).filter(([, value]) => value !== undefined && value !== null).map(([name, value]) => [name, String(value)]));
  try {
    const data = await api("GET", `/api/notices/acks?${params}`);
    if (ackPop !== pop) return;
    const list = (value) => (Array.isArray(value) ? value.filter((item) => item && item.userId !== undefined) : []);
    pop.data = { acked: list(data.acked), pending: list(data.pending) };
    pop.error = "";
  } catch (error) {
    if (error.status === 401 || ackPop !== pop) return;
    pop.error = error.message || "확인 현황을 가져오지 못했습니다.";
  }
  const focused = pop.node.contains(document.activeElement) ? document.activeElement.dataset.tab || "" : "";
  renderAckPop();
  if (focused) pop.node.querySelector(`[data-tab="${focused}"]`)?.focus();
}

function renderAckPop() {
  const pop = ackPop;
  if (!pop) return;
  const node = pop.node;
  node.replaceChildren();
  const head = el("h3", "", "공지 확인 현황");
  const close = el("button", "icon-btn");
  close.type = "button";
  close.setAttribute("aria-label", "닫기");
  close.append(iconUse("ico-x"));
  close.addEventListener("click", () => closeAckPop({ focus: true }));
  head.append(close);
  const seg = el("div", "seg");
  seg.setAttribute("role", "tablist");
  const counts = { acked: pop.data?.acked.length, pending: pop.data?.pending.length };
  for (const [tab, label] of [["acked", "확인"], ["pending", "미확인"]]) {
    const button = el("button", "", label);
    button.type = "button";
    button.dataset.tab = tab;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(pop.tab === tab));
    button.tabIndex = pop.tab === tab ? 0 : -1;
    if (counts[tab] !== undefined) button.append(el("span", tab === "acked" ? "n ok" : "n", String(counts[tab])));
    button.addEventListener("click", () => {
      pop.tab = tab;
      renderAckPop();
      node.querySelector(`[data-tab="${tab}"]`)?.focus();
    });
    seg.append(button);
  }
  seg.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    pop.tab = pop.tab === "acked" ? "pending" : "acked";
    renderAckPop();
    node.querySelector(`[data-tab="${pop.tab}"]`)?.focus();
  });
  const list = el("div", "plist");
  list.setAttribute("role", "tabpanel");
  if (pop.error) list.append(el("p", "none", pop.error));
  else if (!pop.data) list.append(el("p", "none", "불러오는 중…"));
  else {
    const rows = pop.tab === "acked" ? pop.data.acked : pop.data.pending;
    if (!rows.length) list.append(el("p", "none", pop.tab === "acked" ? "아직 아무도 확인하지 않았습니다." : "모두 확인했습니다."));
    for (const row of rows) {
      const person = personById(row.userId);
      const line = el("div", "pl");
      const who = el("span");
      const mine = row.userId === state.me?.userId;
      who.append(el("b", "", row.name || person?.fullName || "알 수 없음"), el("em", "", mine ? mySubtitle() || (person ? personTitle(person) : "") : person ? personTitle(person) : ""));
      const at = Number(row.at);
      const tail = pop.tab === "acked"
        ? el("em", "", Number.isFinite(at) && at > 0 ? formatListTime(at) : "")
        : el("span", "pend", "미확인");
      line.append(avatar(person || { fullName: row.name }, { size: "xs" }), who, tail);
      list.append(line);
    }
  }
  node.append(head, seg, list, el("div", "foot", "등록할 때 대화방 인원 기준(등록한 사람 제외). 공지를 해제해도 확인 기록은 감사 로그에 남습니다."));
}

$("#notice-ack").addEventListener("click", ackNotice);
$("#notice-acks").addEventListener("click", (event) => {
  event.stopPropagation();
  openAckPop();
});
document.addEventListener("click", (event) => {
  if (!ackPop || !event.target.isConnected || event.target.closest?.(".ack-pop, #notice-acks")) return;
  closeAckPop();
});

async function clearNotice() {
  const key = liveKey();
  const params = new URLSearchParams(Object.entries(noticeTarget()).filter(([, value]) => value !== undefined && value !== null).map(([name, value]) => [name, String(value)]));
  try {
    const data = await api("DELETE", `/api/notices?${params}`);
    if (key !== liveKey()) return;
    setNotice(data.notice || null);
    announce("공지를 내렸습니다.");
    $("#composer-input")?.focus();
  } catch (error) {
    if (error.status === 401 || key !== liveKey()) return;
    $("#notice-error").textContent = error.message || "공지를 내리지 못했습니다.";
  }
}

$("#notice-text").addEventListener("click", toggleNotice);
$("#notice-toggle").addEventListener("click", toggleNotice);
$("#notice-dismiss").addEventListener("click", () => {
  if (!state.notice) return;
  state.noticeHidden.add(noticeId(state.notice));
  saveNoticeHidden();
  renderNotice();
  announce("공지를 내 화면에서 닫았습니다.");
  $("#composer-input")?.focus();
});
$("#notice-jump").addEventListener("click", () => {
  if (state.notice) jumpTo(state.notice.message.id, { flash: true });
});
$("#notice-clear").addEventListener("click", clearNotice);
$("#room-notice").addEventListener("click", () => {
  closeGroupMenu();
  if (!state.notice) return;
  state.noticeHidden.delete(noticeId(state.notice));
  saveNoticeHidden();
  state.noticeOpen = true;
  renderNotice();
  $("#notice-text").focus();
});

/* ── 열린 대화 다시 읽기: 읽음 숫자(30초마다)·공지 바뀜 ── */

let receiptTimer = 0;
function startReceipts() {
  stopReceipts();
  receiptTimer = window.setInterval(() => refreshOpenConversation(), RECEIPT_EVERY_MS);
}
function stopReceipts() {
  window.clearInterval(receiptTimer);
  receiptTimer = 0;
}

async function refreshOpenConversation({ force = false } = {}) {
  if (!state.me || !isTalkView() || state.loading) return;
  if (!force && (document.hidden || (state.view === "general" && !readersPop))) return;
  const key = liveKey();
  try {
    const data = await api("GET", `/api/messages?${viewParams()}`);
    if (key !== liveKey()) return;
    if ("notice" in data) setNotice(data.notice || null);
    const fresh = Array.isArray(data.messages) ? data.messages : [];
    for (const message of fresh) {
      const index = state.messages.findIndex((item) => item.id === message.id);
      if (index < 0) continue;
      const current = state.messages[index];
      if (current.unreadCount !== message.unreadCount || current.edited !== message.edited || current.recalled !== message.recalled || current.content !== message.content) {
        state.messages[index] = { ...current, ...message };
        replaceRow(message.id);
      }
    }
    if (readersPop) loadReaders();
  } catch {
    // 다음 차례에 다시 읽는다.
  }
}

/* ── A4 수정·회수가 이벤트(updated)로 올 때 ── */

function mergeUpdate(current, update) {
  const merged = { ...current, ...update };
  // 이벤트로 온 사본에는 읽음 숫자가 없을 수 있다(서버가 대화 단위로만 채움).
  if (update.unreadCount == null && current.unreadCount != null && !update.recalled) merged.unreadCount = current.unreadCount;
  return merged;
}

function applyUpdated(updates) {
  let listChanged = false;
  for (const update of updates) {
    if (!update || !update.id) continue;
    for (const cache of [state.dmCache, state.groupCache]) {
      for (const list of Object.values(cache)) {
        const index = list.findIndex((message) => message.id === update.id);
        if (index >= 0) {
          list[index] = mergeUpdate(list[index], update);
          listChanged = true;
        }
      }
    }
    if (state.generalLast?.id === update.id) {
      state.generalLast = mergeUpdate(state.generalLast, update);
      listChanged = true;
    }
    if (state.notice?.message?.id === update.id) {
      state.notice = { ...state.notice, message: mergeUpdate(state.notice.message, update) };
      renderNotice();
    }
    const index = state.messages.findIndex((message) => message.id === update.id);
    if (index >= 0) {
      state.messages[index] = mergeUpdate(state.messages[index], update);
      if (state.compose?.message.id === update.id) {
        if (update.recalled) cancelCompose();
        else state.compose.message = state.messages[index];
      }
      replaceRow(update.id);
    }
    // 이 메시지를 인용한 답장의 인용 상자도 회수 표시로 바꾼다(원문이 화면에 없어도. 답장 쪽에는 이벤트가 오지 않는다).
    if (update.recalled) {
      for (const reply of state.messages.filter((message) => message.replyTo?.id === update.id)) {
        reply.replyTo = { ...reply.replyTo, recalled: true, excerpt: RECALLED_TEXT };
        replaceRow(reply.id);
      }
    }
  }
  if (listChanged) renderList();
}

/* ── 메시지로 이동(검색 결과·인용·공지 원문) ── */

function scrollToMessage(id, { flash = false } = {}) {
  const row = $("#log")?.querySelector(`.msg[data-id="${id}"]`);
  if (!row) return false;
  row.scrollIntoView({ block: "center" });
  if (flash) {
    for (const other of document.querySelectorAll(".msg.jump")) other.classList.remove("jump");
    row.classList.add("jump");
    window.setTimeout(() => row.classList.remove("jump"), 3000);
  }
  return true;
}

async function jumpTo(id, { flash = false } = {}) {
  if (!isTalkView()) return;
  if (state.messages.some((message) => message.id === id)) {
    renderLog();
    scrollToMessage(id, { flash });
    return;
  }
  const key = liveKey();
  try {
    const params = viewParams();
    params.set("around", String(id));
    const data = await api("GET", `/api/messages?${params}`);
    if (key !== liveKey()) return;
    state.messages = Array.isArray(data.messages) ? data.messages : [];
    state.hasOlder = Boolean(data.hasOlder);
    state.hasNewer = Boolean(data.hasNewer);
    state.olderError = "";
    renderLog();
    if (!scrollToMessage(id, { flash })) {
      state.sendErrors[convKey()] = "원래 메시지를 찾지 못했습니다.";
      updateComposer();
    }
  } catch (error) {
    if (error.status === 401 || key !== liveKey()) return;
    state.sendErrors[convKey()] = error.message || "메시지를 불러오지 못했습니다.";
    updateComposer();
  }
}

/* 아래쪽(더 최근) 기록을 이어 붙인다. 다 불러오면 평소처럼 새 메시지를 실시간으로 붙인다. */
async function loadNewer() {
  if (!isTalkView() || !state.hasNewer || state.loadingNewer || !state.messages.length) return;
  const key = liveKey();
  const log = $("#log");
  state.loadingNewer = true;
  log.querySelector(".history.newer")?.replaceWith(newerMarker());
  try {
    const params = viewParams();
    params.set("after", String(state.messages[state.messages.length - 1].id));
    const data = await api("GET", `/api/messages?${params}`);
    if (key !== liveKey()) return;
    const known = new Set(state.messages.map((message) => message.id));
    const newer = (Array.isArray(data.messages) ? data.messages : []).filter((message) => message && !known.has(message.id));
    const top = log.scrollTop;
    state.messages = [...state.messages, ...newer].sort((a, b) => a.id - b.id);
    state.hasNewer = Boolean(data.hasNewer) && newer.length > 0;
    state.loadingNewer = false;
    renderLog();
    log.scrollTop = top;
    if (!state.hasNewer) {
      afterLogChange();
      renderList();
    }
  } catch (error) {
    if (error.status === 401 || key !== liveKey()) return;
    state.loadingNewer = false;
    log.querySelector(".history.newer")?.replaceWith(newerMarker());
  }
}

/* ── A2 메시지 검색(목록) ── */

function talkSearching() {
  return Boolean(state.me) && listGroup(state.view) === "talk" && state.query.trim().length > 0;
}

function searchTab() {
  return state.search.tab || (state.search.roomCount > 0 ? "rooms" : "messages");
}

function resetListSearch() {
  window.clearTimeout(searchTimer);
  state.search = { tab: null, results: [], hasOlder: false, loading: false, error: "", gen: state.search.gen + 1, activeId: null, roomCount: 0, ran: "" };
  const box = $("#search-results");
  if (box) box.replaceChildren();
}

let searchTimer = 0;
function scheduleSearch() {
  window.clearTimeout(searchTimer);
  if (!talkSearching()) return;
  searchTimer = window.setTimeout(() => runSearch(), 300);
}

async function runSearch({ more = false } = {}) {
  const query = state.query.trim();
  if (!query || listGroup(state.view) !== "talk") return;
  const search = state.search;
  if (more && (search.loading || !search.hasOlder || !search.results.length)) return;
  const gen = more ? search.gen : ++search.gen;
  const session = state.sessionGen;
  search.loading = true;
  if (!more) {
    search.results = [];
    search.hasOlder = false;
    search.activeId = null;
  }
  search.error = "";
  search.ran = query;
  renderSearchResults();
  renderSearchChrome();
  try {
    const params = new URLSearchParams({ q: query, view: "all" });
    if (more) params.set("before", String(search.results[search.results.length - 1].id));
    const data = await api("GET", `/api/search?${params}`);
    if (gen !== state.search.gen || session !== state.sessionGen) return;
    const found = (Array.isArray(data.messages) ? data.messages : []).filter((message) => message && message.id && !message.recalled);
    search.results = more ? [...search.results, ...found.filter((message) => !search.results.some((known) => known.id === message.id))] : found;
    search.hasOlder = Boolean(data.hasOlder);
  } catch (error) {
    if (error.status === 401 || gen !== state.search.gen || session !== state.sessionGen) return;
    search.error = error.message || "메시지를 검색하지 못했습니다.";
  }
  search.loading = false;
  renderSearchResults();
  renderSearchChrome();
}

function renderSearchChrome() {
  const searching = talkSearching();
  const talkLike = state.view === "talk" || isTalkView();
  document.body.classList.toggle("searching", searching);
  $("#list-search-clear").hidden = !state.query;
  $("#search-tabs").hidden = !searching;
  const tab = searchTab();
  $("#talk-list").hidden = !talkLike || (searching && tab !== "rooms");
  $("#search-results").hidden = !searching || tab !== "messages";
  $("#stab-rooms").setAttribute("aria-selected", String(tab === "rooms"));
  $("#stab-msgs").setAttribute("aria-selected", String(tab === "messages"));
  $("#stab-rooms-n").textContent = String(state.search.roomCount);
  const search = state.search;
  $("#stab-msgs-n").textContent = search.loading && !search.results.length ? "" : search.error ? "!" : `${search.results.length}${search.hasOlder ? "+" : ""}`;
}

/* 받침이 있으면 "과", 없으면 "와" */
function particleOf(word) {
  const last = word.charCodeAt(word.length - 1);
  if (last >= 0xac00 && last <= 0xd7a3) return (last - 0xac00) % 28 ? "과" : "와";
  return "와(과)";
}

function roomNameOf(message) {
  if (message.kind === "dm") {
    return `${nameOf(message.peerId)} · 1:1`;
  }
  if (message.kind === "group") {
    const group = groupById(message.groupId);
    if (!group) return "그룹";
    return group.dept ? `${group.name} · 부서` : group.name || "그룹";
  }
  return "전체 채널";
}

/* 검색어가 뒤쪽에 있으면 앞부분을 잘라 두 줄 안에 보이게 한다. */
function snippetOf(text, words) {
  const lower = text.toLowerCase();
  const first = Math.min(...words.map((word) => lower.indexOf(word)).filter((index) => index >= 0));
  if (Number.isFinite(first) && first > 36) return `…${text.slice(first - 18)}`;
  return text;
}

/* 글에 검색어가 없고 첨부 이름에서 찾았으면 그 파일 이름을 덧붙인다. */
function hitText(message, words) {
  const text = previewText(message);
  const lower = text.toLowerCase();
  if (!words.length || words.some((word) => lower.includes(word))) return text;
  const file = attachmentsOf(message).find((item) => words.some((word) => (item.name || "").toLowerCase().includes(word)));
  return file && !text.includes(file.name) ? `${text} · 파일: ${file.name}` : text;
}

function textHasWords(message, words) {
  const lower = (message.content || "").toLowerCase();
  return words.some((word) => lower.includes(word));
}

function searchHit(message, words) {
  const button = el("button", "hit");
  button.type = "button";
  if (state.search.activeId === message.id) button.setAttribute("aria-current", "true");
  const mine = message.senderId === state.me?.userId;
  const face = avatar(mine ? state.me : personById(message.senderId), { size: "xs" });
  const text = el("span");
  const top = el("span", "top");
  top.append(el("b", "", mine ? "나" : message.senderName || "알 수 없음"), el("span", "room-n", roomNameOf(message)));
  const time = el("time", "", formatListTime(message.timestamp));
  time.dateTime = new Date(message.timestamp * 1000).toISOString();
  top.append(time);
  const line = el("p");
  appendMarked(line, snippetOf(hitText(message, words), words), words, "");
  text.append(top, line);
  button.append(face, text);
  button.addEventListener("click", () => {
    state.search.activeId = message.id;
    renderSearchResults();
    openMessage(message, words);
  });
  return button;
}

function renderSearchResults() {
  const box = $("#search-results");
  if (!box) return;
  const search = state.search;
  const query = search.ran || state.query.trim();
  const words = wordsOf(query);
  box.replaceChildren();
  if (search.loading && !search.results.length) {
    box.append(loadingState("메시지를 찾는 중…"));
    return;
  }
  if (search.error && !search.results.length) {
    box.append(errorState(search.error, () => runSearch()));
    return;
  }
  if (!search.results.length) {
    if (!search.ran) return;
    const empty = el("div", "empty");
    const img = document.createElement("img");
    img.src = "/assets/turtle-side.png";
    img.alt = "";
    empty.append(img, el("b", "", `‘${query}’${particleOf(query)} 맞는 메시지가 없어요`), el("span", "", "낱말을 줄이거나 다른 낱말로 찾아보세요.\n쪽지는 검색되지 않습니다."));
    box.append(empty);
    return;
  }
  box.append(el("div", "sum", `‘${query}’ 메시지 ${search.results.length}개${search.hasOlder ? " 이상" : ""} · 최신순`));
  for (const message of search.results) box.append(searchHit(message, words));
  if (search.hasOlder) {
    const more = el("button", "more", search.loading ? "불러오는 중…" : "이전 결과 더 보기");
    more.type = "button";
    more.disabled = search.loading;
    more.addEventListener("click", () => runSearch({ more: true }));
    box.append(more);
  }
  if (search.error) box.append(el("p", "alert", search.error));
}

/* 검색 결과를 눌렀을 때: 그 대화를 열고 그 메시지로 간다. */
async function openMessage(message, words) {
  let view = "general";
  let target = null;
  if (message.kind === "dm") {
    view = "dm";
    target = personById(message.peerId);
  } else if (message.kind === "group") {
    view = "group";
    target = groupById(message.groupId);
  }
  if (view !== "general" && !target) {
    state.noteStatus = "그 대화방을 찾지 못했습니다.";
    renderList();
    return;
  }
  state.jump = { id: message.id, words: words || [] };
  if (nextKeyFor(view, target) === convKey()) {
    await jumpTo(message.id, { flash: true });
    return;
  }
  state.pendingJump = message.id;
  await setView(view, target);
  state.jump = { id: message.id, words: words || [] };
  if (state.pendingJump === message.id) state.pendingJump = null;
}

$("#list-search-clear").addEventListener("click", () => {
  const input = $("#list-search");
  input.value = "";
  state.query = "";
  resetListSearch();
  renderList();
  input.focus();
});
for (const [id, tab] of [["#stab-rooms", "rooms"], ["#stab-msgs", "messages"]]) {
  $(id).addEventListener("click", () => {
    state.search.tab = tab;
    renderSearchChrome();
  });
}
$("#search-tabs").addEventListener("keydown", (event) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  const next = searchTab() === "rooms" ? "messages" : "rooms";
  state.search.tab = next;
  renderSearchChrome();
  $(next === "rooms" ? "#stab-rooms" : "#stab-msgs").focus();
});

/* ── 말풍선 메뉴 ── */

let msgMenu = null; // { id, node }

function closeMsgMenu({ focus = false } = {}) {
  if (!msgMenu) return;
  const { id, node } = msgMenu;
  msgMenu = null;
  node.remove();
  const row = $("#log")?.querySelector(`.msg[data-id="${id}"]`);
  row?.classList.remove("focus");
  const button = row?.querySelector(".acts-bar .more");
  button?.setAttribute("aria-expanded", "false");
  if (focus) button?.focus();
}

function menuItem(icon, label, onClick, { disabled = false, danger = false, hint = "" } = {}) {
  const button = el("button", danger ? "danger" : "");
  button.type = "button";
  button.setAttribute("role", "menuitem");
  button.append(iconUse(icon), label);
  if (hint) button.append(el("kbd", "", hint));
  if (disabled) {
    button.disabled = true;
    button.setAttribute("aria-disabled", "true");
  } else {
    button.addEventListener("click", () => {
      closeMsgMenu();
      onClick();
    });
  }
  return button;
}

function openMsgMenu(id, button) {
  if (msgMenu?.id === id) {
    closeMsgMenu({ focus: true });
    return;
  }
  closeMsgMenu();
  closeReaders();
  const message = state.messages.find((item) => item.id === id);
  if (!message || message.recalled) return;
  const mine = message.senderId === state.me?.userId;
  const menu = el("div", "menu compact msg-menu");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "메시지 메뉴");
  menu.append(menuItem("ico-reply", "답장", () => startReply(id)));
  menu.append(menuItem("ico-star", message.starred ? "별표 빼기" : "나중에 보기 (별표)", () => toggleStar(id)));
  if ((message.content || "").trim()) menu.append(menuItem("ico-copy", "복사", () => copyMessage(id)));
  if (canChangeNotice()) {
    if (state.notice?.message?.id === id) menu.append(menuItem("ico-notice", "공지 해제", () => clearNotice()));
    else menu.append(menuItem("ico-notice", "공지로 등록", () => setNoticeFrom(id)));
  }
  if (mine) {
    menu.append(menuItem("ico-eye", "읽은 사람 보기", () => {
      const row = $("#log").querySelector(`.msg[data-id="${id}"]`);
      openReaders(id, row?.querySelector(".unread") || row?.querySelector(".acts-bar .more"));
    }));
    if (!message.poll && !message.todo) menu.append(document.createElement("hr"));
    const left = editSecondsLeft(message);
    if (message.poll || message.todo) {
      // 투표·할 일은 고치거나 회수할 수 없다.
    } else if (left > 0) {
      menu.append(menuItem("ico-edit", "수정", () => startEdit(id), { hint: `${Math.max(1, Math.ceil(left / 60))}분 남음` }));
      menu.append(menuItem("ico-recall", "회수", () => recallMessage(id), { danger: true }));
    } else {
      menu.append(menuItem("ico-edit", "수정", () => {}, { disabled: true }));
      menu.append(menuItem("ico-recall", "회수", () => {}, { disabled: true }));
      menu.append(el("div", "why", "보낸 지 10분이 지나 수정·회수할 수 없어요."));
    }
  }
  menu.addEventListener("keydown", (event) => {
    const items = [...menu.querySelectorAll("button:not(:disabled)")];
    const index = items.indexOf(document.activeElement);
    if (event.key === "Escape") {
      event.stopPropagation();
      closeMsgMenu({ focus: true });
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      items[(index + step + items.length) % items.length]?.focus();
    } else if (event.key === "Tab") {
      closeMsgMenu();
    }
  });
  msgMenu = { id, node: menu };
  placeMsgMenu(true);
  menu.querySelector("button:not(:disabled)")?.focus();
}

function placeMsgMenu(fit = false) {
  if (!msgMenu) return;
  const row = $("#log").querySelector(`.msg[data-id="${msgMenu.id}"]`);
  const anchor = row?.querySelector(".acts-bar")?.parentElement;
  if (!anchor) {
    closeMsgMenu();
    return;
  }
  anchor.append(msgMenu.node);
  row.classList.add("focus");
  row.querySelector(".acts-bar .more")?.setAttribute("aria-expanded", "true");
  if (fit) fitPopover(msgMenu.node);
}

/* 말풍선 위에 띄우는 메뉴·팝오버를 대화창 안에 맞춘다.
 * 위가 모자라면 먼저 대화창을 조금 내려 보고, 그래도 안 되면 아래로 띄운다. 좌우는 밀어서 맞춘다. */
function fitPopover(node) {
  const log = $("#log");
  node.classList.remove("below");
  node.style.transform = "";
  const margin = 6;
  let logBox = log.getBoundingClientRect();
  let box = node.getBoundingClientRect();
  if (box.top < logBox.top + margin) {
    const need = logBox.top + margin - box.top;
    if (log.scrollTop >= need) {
      log.scrollTop -= need;
    } else {
      node.classList.add("below");
      box = node.getBoundingClientRect();
      logBox = log.getBoundingClientRect();
      if (box.bottom > logBox.bottom - margin) log.scrollTop += box.bottom - (logBox.bottom - margin);
    }
  }
  box = node.getBoundingClientRect();
  logBox = log.getBoundingClientRect();
  let shift = 0;
  if (box.right > logBox.right - margin) shift = logBox.right - margin - box.right;
  if (box.left + shift < logBox.left + margin) shift = logBox.left + margin - box.left;
  if (shift) node.style.transform = `translateX(${Math.round(shift)}px)`;
}

async function copyMessage(id) {
  const message = state.messages.find((item) => item.id === id);
  if (!message) return;
  try {
    await navigator.clipboard.writeText(message.content || "");
    announce("복사했습니다.");
  } catch {
    state.sendErrors[convKey()] = "복사하지 못했습니다.";
    updateComposer();
  }
}

/* ── A1 읽은 사람 보기 ── */

let readersPop = null; // { id, node, tab, data, error }

function closeReaders({ focus = false } = {}) {
  if (!readersPop) return;
  const { id, node } = readersPop;
  readersPop = null;
  node.remove();
  if (focus) {
    const row = $("#log")?.querySelector(`.msg[data-id="${id}"]`);
    (row?.querySelector(".unread") || row?.querySelector(".acts-bar .more"))?.focus();
  }
}

function openReaders(id) {
  if (readersPop?.id === id) {
    closeReaders({ focus: true });
    return;
  }
  closeMsgMenu();
  closeReaders();
  const node = el("div", "readers");
  node.setAttribute("role", "dialog");
  node.setAttribute("aria-label", "읽음 확인");
  node.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeReaders({ focus: true });
    }
  });
  readersPop = { id, node, tab: "unread", data: null, error: "" };
  renderReaders();
  placeReaders(true);
  node.querySelector("[role=tab][aria-selected=true]")?.focus();
  loadReaders();
}

async function loadReaders() {
  const pop = readersPop;
  if (!pop) return;
  try {
    const data = await api("GET", `/api/messages/${pop.id}/readers`);
    if (readersPop !== pop) return;
    pop.data = { readIds: Array.isArray(data.readIds) ? data.readIds : [], unreadIds: Array.isArray(data.unreadIds) ? data.unreadIds : [] };
    pop.error = "";
  } catch (error) {
    if (error.status === 401 || readersPop !== pop) return;
    pop.error = error.message || "읽음 정보를 가져오지 못했습니다.";
  }
  const focused = pop.node.contains(document.activeElement) ? document.activeElement.dataset.tab || "" : "";
  renderReaders();
  if (focused) pop.node.querySelector(`[data-tab="${focused}"]`)?.focus();
}

function renderReaders() {
  const pop = readersPop;
  if (!pop) return;
  const node = pop.node;
  node.replaceChildren();
  const head = el("h3", "", "읽음 확인");
  const close = el("button", "icon-btn");
  close.type = "button";
  close.setAttribute("aria-label", "닫기");
  close.append(iconUse("ico-x"));
  close.addEventListener("click", () => closeReaders({ focus: true }));
  head.append(close);
  const seg = el("div", "seg");
  seg.setAttribute("role", "tablist");
  const counts = { unread: pop.data?.unreadIds.length, read: pop.data?.readIds.length };
  for (const [tab, label] of [["unread", "안 읽음"], ["read", "읽음"]]) {
    const button = el("button", "", label);
    button.type = "button";
    button.dataset.tab = tab;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(pop.tab === tab));
    if (counts[tab] !== undefined) button.append(el("span", tab === "read" ? "n ok" : "n", String(counts[tab])));
    button.addEventListener("click", () => {
      pop.tab = tab;
      renderReaders();
      node.querySelector(`[data-tab="${tab}"]`)?.focus();
    });
    seg.append(button);
  }
  seg.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    pop.tab = pop.tab === "unread" ? "read" : "unread";
    renderReaders();
    node.querySelector(`[data-tab="${pop.tab}"]`)?.focus();
  });
  const list = el("div", "plist");
  list.setAttribute("role", "tabpanel");
  if (pop.error) list.append(el("p", "none", pop.error));
  else if (!pop.data) list.append(el("p", "none", "불러오는 중…"));
  else {
    const ids = pop.tab === "unread" ? pop.data.unreadIds : pop.data.readIds;
    if (!ids.length) list.append(el("p", "none", pop.tab === "unread" ? "모두 읽었습니다." : "아직 아무도 읽지 않았습니다."));
    for (const userId of ids) {
      const person = personById(userId);
      const line = el("div", "pl");
      const who = el("span");
      who.append(el("b", "", person?.fullName || nameOf(userId)));
      if (person) who.append(el("em", "", personTitle(person)));
      line.append(avatar(person, { size: "xs" }), who, statusText(userId) || el("span"));
      list.append(line);
    }
  }
  node.append(head, seg, list, el("div", "foot", "나는 세지 않습니다. 30초마다 새로 고칩니다."));
}

function placeReaders(fit = false) {
  if (!readersPop) return;
  const row = $("#log").querySelector(`.msg[data-id="${readersPop.id}"]`);
  const stamp = row?.querySelector(".stamp");
  if (!stamp) {
    closeReaders();
    return;
  }
  stamp.append(readersPop.node);
  if (fit) fitPopover(readersPop.node);
}

/* 로그를 다시 그린 뒤 열려 있던 메뉴·팝오버를 같은 말풍선에 다시 붙인다(포커스도 유지). */
function reattachPopovers() {
  const active = document.activeElement;
  const keepFocus = (msgMenu && msgMenu.node.contains(active)) || (readersPop && readersPop.node.contains(active)) || (picker && picker.node.contains(active)) ? active : null;
  if (msgMenu) placeMsgMenu();
  if (readersPop) placeReaders();
  if (picker) placePicker();
  if (keepFocus?.isConnected) keepFocus.focus();
}

document.addEventListener("click", (event) => {
  // 메뉴 항목을 누르면 메뉴가 먼저 사라지므로, 떨어져 나간 요소의 클릭은 "바깥 클릭"으로 치지 않는다.
  if (!event.target.isConnected) return;
  if (msgMenu &&!event.target.closest?.(".msg-menu, .acts-bar")) closeMsgMenu();
  if (readersPop && !event.target.closest?.(".readers, .unread")) closeReaders();
});

/* ── A3·A4 답장·수정(입력창 맥락 줄) ── */

function setCompose(next) {
  const previous = state.compose;
  state.compose = next;
  renderCompose();
  if (previous?.mode === "edit") replaceRow(previous.message.id);
  if (next?.mode === "edit") replaceRow(next.message.id);
  updateComposer();
}

function renderCompose() {
  const compose = state.compose;
  const box = $("#compose-ctx");
  const input = $("#composer-input");
  if (!box || !input) return;
  box.hidden = !compose;
  const hint = $("#composer-hint");
  if (!compose) {
    if (input.dataset.placeholder) input.placeholder = input.dataset.placeholder;
    hint.textContent = `끌어다 놓거나 붙여넣어도 됩니다 · ${sendKeyLabel()} 전송`;
    $("#composer-attach").disabled = false;
    return;
  }
  const edit = compose.mode === "edit";
  $("#compose-ctx-icon").setAttribute("href", edit ? "#ico-edit" : "#ico-reply");
  $("#compose-ctx-title").textContent = edit ? "메시지 수정 중" : `${compose.message.senderName || "알 수 없음"} 님에게 답장`;
  $("#compose-ctx-text").textContent = previewText(compose.message);
  $("#compose-ctx-cancel").setAttribute("aria-label", edit ? "수정 취소" : "답장 취소");
  if (!edit) input.placeholder = "답장 입력";
  else if (input.dataset.placeholder) input.placeholder = input.dataset.placeholder;
  hint.textContent = edit ? `${sendKeyLabel()} 저장 · Esc 취소` : `${sendKeyLabel()} 전송 · Esc 답장 취소`;
  $("#composer-attach").disabled = edit;
}

function autosize(input) {
  input.style.height = "auto";
  if (input.value) input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

function startReply(id) {
  const message = state.messages.find((item) => item.id === id);
  if (!message || message.recalled) return;
  closeMsgMenu();
  if (state.compose?.mode === "edit") cancelCompose();
  setCompose({ mode: "reply", message, key: convKey() });
  $("#composer-input").focus();
}

function startEdit(id) {
  const message = state.messages.find((item) => item.id === id);
  if (!message || message.recalled || message.senderId !== state.me?.userId) return;
  const input = $("#composer-input");
  const draft = state.compose?.mode === "edit" ? state.compose.draft : input.value;
  delete state.sendErrors[convKey()];
  setCompose({ mode: "edit", message, key: convKey(), draft });
  input.value = message.content || "";
  autosize(input);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  updateComposer();
}

function cancelCompose() {
  const compose = state.compose;
  if (!compose) return;
  if (compose.mode === "edit") {
    const input = $("#composer-input");
    input.value = compose.draft || "";
    autosize(input);
  }
  setCompose(null);
}

async function saveEdit(content) {
  const compose = state.compose;
  if (!compose || compose.mode !== "edit") return;
  const key = convKey();
  const message = compose.message;
  if (!content && !attachmentsOf(message).length) {
    state.sendErrors[key] = "메시지를 입력하세요.";
    updateComposer();
    return;
  }
  if (content === (message.content || "").trim()) {
    cancelCompose();
    return;
  }
  const session = state.sessionGen;
  state.sendingKeys.add(key);
  delete state.sendErrors[key];
  updateComposer();
  try {
    const data = await api("PATCH", `/api/messages/${message.id}`, { content, mentions: mentionIdsIn(content) });
    if (session !== state.sessionGen) return;
    if (data.message) applyUpdated([data.message]);
    if (state.compose === compose) cancelCompose();
    announce("메시지를 고쳤습니다.");
  } catch (error) {
    if (error.status === 401 || session !== state.sessionGen) return;
    state.sendErrors[key] = lateText(error) || error.message || "메시지를 고치지 못했습니다.";
  } finally {
    state.sendingKeys.delete(key);
    updateComposer();
  }
}

/* 메뉴를 연 사이 10분이 지나 서버가 거절한 경우 */
function lateText(error) {
  return error?.status === 403 && /10분/.test(error.message || "") ? "보낸 지 10분이 지나 수정·회수할 수 없어요." : "";
}

async function recallMessage(id) {
  const message = state.messages.find((item) => item.id === id);
  if (!message) return;
  const key = liveKey();
  const ok = await askConfirm({
    title: "이 메시지를 회수할까요?",
    text: "모든 참여자에게 ‘회수된 메시지입니다’로 보입니다.\n첨부한 파일도 대화에서 빠집니다.",
    note: "원문은 보존 규정에 따라 관리자 기록에 남습니다.",
    confirm: "회수",
    cancel: "취소",
    danger: true,
    image: true,
  });
  if (!ok || key !== liveKey()) return;
  try {
    const data = await api("POST", `/api/messages/${id}/recall`);
    if (key !== liveKey()) return;
    if (data.message) applyUpdated([data.message]);
    announce("메시지를 회수했습니다.");
  } catch (error) {
    if (error.status === 401 || key !== liveKey()) return;
    state.sendErrors[convKey()] = lateText(error) || error.message || "메시지를 회수하지 못했습니다.";
    updateComposer();
  }
  $("#composer-input").focus();
}

$("#compose-ctx-cancel").addEventListener("click", () => {
  cancelCompose();
  $("#composer-input").focus();
});

/* ── A3 @멘션 자동완성 ── */

const mention = { open: false, start: -1, items: [], index: 0 };

function mentionCandidates() {
  let ids = [];
  if (state.view === "group") ids = state.selectedGroup?.memberIds || [];
  else if (state.view === "dm") ids = state.selectedUser ? [state.selectedUser.userId] : [];
  else if (state.view === "general") ids = state.people.map((person) => person.userId);
  return ids.filter((id) => id !== state.me?.userId).map(personById).filter(Boolean);
}

/* 보낼 글에 남아 있는 "@이름"만 멘션으로 보낸다. */
function mentionIdsIn(content) {
  if (!content.includes("@")) return [];
  return mentionCandidates()
    .filter((person) => new RegExp(`@${escapeRegExp(person.fullName)}(?![\\p{L}\\p{N}])`, "u").test(content))
    .map((person) => person.userId);
}

function closeMentionPop() {
  if (!mention.open) return;
  mention.open = false;
  $("#mention-pop").hidden = true;
  const input = $("#composer-input");
  input.setAttribute("aria-expanded", "false");
  input.removeAttribute("aria-activedescendant");
}

function updateMentionPop() {
  const input = $("#composer-input");
  if (!isTalkView() || document.activeElement !== input) {
    closeMentionPop();
    return;
  }
  const caret = input.selectionStart;
  const before = input.value.slice(0, caret);
  const match = /(^|\s)@([^\s@]{0,20})$/.exec(before);
  if (!match) {
    closeMentionPop();
    return;
  }
  const query = match[2].toLowerCase();
  mention.start = caret - match[2].length - 1;
  const people = mentionCandidates().filter((person) => !query
    || person.fullName.toLowerCase().includes(query)
    || personTitle(person).toLowerCase().includes(query));
  people.sort((a, b) => Number(!a.fullName.toLowerCase().startsWith(query)) - Number(!b.fullName.toLowerCase().startsWith(query))
    || a.fullName.localeCompare(b.fullName, "ko"));
  if (state.view === "general") {
    people.sort((a, b) => (splitTitle(a).dept || "").localeCompare(splitTitle(b).dept || "", "ko"));
  }
  mention.items = people.slice(0, state.view === "general" ? 30 : 8);
  mention.index = Math.min(mention.index, Math.max(0, mention.items.length - 1));
  if (!mention.open) mention.index = 0;
  mention.open = true;
  renderMentionPop();
}

function renderMentionPop() {
  const input = $("#composer-input");
  const list = $("#mention-list");
  $("#mention-pop").hidden = false;
  $("#mention-head").textContent = state.view === "general" ? "직원" : "이 대화방 참여자";
  list.replaceChildren();
  input.setAttribute("aria-expanded", "true");
  if (!mention.items.length) {
    list.append(el("p", "none", "맞는 직원이 없습니다."));
    input.removeAttribute("aria-activedescendant");
    return;
  }
  let lastDept = null;
  mention.items.forEach((person, index) => {
    if (state.view === "general") {
      const dept = splitTitle(person).dept || "부서 없음";
      if (dept !== lastDept) {
        const head = el("div", "dept-h", dept);
        head.setAttribute("role", "presentation");
        list.append(head);
        lastDept = dept;
      }
    }
    const option = el("div", "opt");
    option.id = `mention-opt-${person.userId}`;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(index === mention.index));
    const who = el("span");
    who.append(el("b", "", person.fullName), el("em", "", personTitle(person)));
    option.append(personAvatar(person, { size: "xs" }), who, statusText(person.userId) || el("span"));
    option.addEventListener("mousedown", (event) => {
      event.preventDefault(); // 입력창 포커스를 지킨다.
      insertMention(person);
    });
    list.append(option);
  });
  const active = mention.items[mention.index];
  input.setAttribute("aria-activedescendant", `mention-opt-${active.userId}`);
  $(`#mention-opt-${active.userId}`)?.scrollIntoView({ block: "nearest" });
}

function insertMention(person) {
  const input = $("#composer-input");
  const caret = input.selectionStart;
  const start = mention.start >= 0 ? mention.start : caret;
  const token = `@${person.fullName} `;
  input.value = input.value.slice(0, start) + token + input.value.slice(caret);
  const at = start + token.length;
  input.setSelectionRange(at, at);
  closeMentionPop();
  autosize(input);
  updateComposer();
}

$("#composer-input").addEventListener("input", updateMentionPop);
$("#composer-input").addEventListener("click", updateMentionPop);
$("#composer-input").addEventListener("blur", () => window.setTimeout(closeMentionPop, 120));
// 입력창의 Enter(보내기)보다 먼저 받아야 하므로 폼에서 캡처 단계로 듣는다.
$("#composer").addEventListener("keydown", (event) => {
  if (event.target !== $("#composer-input") || event.isComposing || event.keyCode === 229) return;
  if (mention.open) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!mention.items.length) return;
      event.preventDefault();
      event.stopPropagation();
      const step = event.key === "ArrowDown" ? 1 : -1;
      mention.index = (mention.index + step + mention.items.length) % mention.items.length;
      renderMentionPop();
      return;
    }
    if ((event.key === "Enter" || event.key === "Tab") && mention.items.length) {
      event.preventDefault();
      event.stopPropagation();
      insertMention(mention.items[mention.index]);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMentionPop();
      return;
    }
  }
  if (event.key === "Escape" && state.compose) {
    event.preventDefault();
    event.stopPropagation();
    cancelCompose();
  }
}, true);
$("#composer-input").addEventListener("keyup", (event) => {
  if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) updateMentionPop();
});
$("#composer-at").addEventListener("click", () => {
  const input = $("#composer-input");
  input.focus();
  const caret = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, caret);
  const token = before && !/\s$/.test(before) ? " @" : "@";
  input.value = before + token + input.value.slice(caret);
  input.setSelectionRange(caret + token.length, caret + token.length);
  autosize(input);
  updateComposer();
  updateMentionPop();
});

/* ── A2 이 대화방에서 검색 ── */

function openInSearch() {
  if (!isTalkView() || !state.me) return;
  state.inSearch.open = true;
  $("#in-search").hidden = false;
  const input = $("#in-search-input");
  input.value = state.inSearch.query;
  input.focus();
  input.select();
  renderInSearch();
}

function closeInSearch({ render = true, focus = false } = {}) {
  window.clearTimeout(inSearchTimer);
  const wasOpen = state.inSearch.open;
  state.inSearch = { open: false, query: "", hits: [], hasOlder: false, index: -1, loading: false, error: "", gen: state.inSearch.gen + 1 };
  const bar = $("#in-search");
  if (bar) bar.hidden = true;
  if (wasOpen && render && isTalkView()) {
    const log = $("#log");
    const top = log.scrollTop;
    renderLog();
    log.scrollTop = top;
  }
  if (focus) $("#in-search-btn")?.focus();
}

function renderInSearch() {
  const search = state.inSearch;
  const count = $("#in-search-count");
  if (!search.query.trim()) count.textContent = "";
  else if (search.loading && !search.hits.length) count.textContent = "찾는 중…";
  else if (search.error) count.textContent = "오류";
  else if (!search.hits.length) count.textContent = "결과 없음";
  else count.textContent = `${search.hits.length}${search.hasOlder ? "+" : ""}개 중 ${search.index + 1}`;
  count.title = search.error || "";
  $("#in-search-prev").disabled = !search.hits.length || search.index <= 0;
  $("#in-search-next").disabled = !search.hits.length || (search.index >= search.hits.length - 1 && !search.hasOlder);
}

let inSearchTimer = 0;
async function runInSearch({ more = false } = {}) {
  const search = state.inSearch;
  const query = search.query.trim();
  if (!query) {
    search.hits = [];
    search.index = -1;
    search.hasOlder = false;
    renderInSearch();
    const log = $("#log");
    const top = log.scrollTop;
    renderLog();
    log.scrollTop = top;
    return false;
  }
  if (more && (search.loading || !search.hasOlder)) return false;
  const gen = more ? search.gen : ++search.gen;
  const key = liveKey();
  search.loading = true;
  search.error = "";
  search.ran = query;
  renderInSearch();
  try {
    const params = new URLSearchParams({ q: query, view: state.view });
    if (state.view === "dm") params.set("userId", String(state.selectedUser?.userId));
    if (state.view === "group") params.set("groupId", String(state.selectedGroup?.groupId));
    if (more) params.set("before", String(search.hits[search.hits.length - 1].id));
    const data = await api("GET", `/api/search?${params}`);
    if (gen !== state.inSearch.gen || key !== liveKey()) return false;
    const found = (Array.isArray(data.messages) ? data.messages : []).filter((message) => message && message.id);
    search.hits = more ? [...search.hits, ...found] : found;
    search.hasOlder = Boolean(data.hasOlder);
    search.loading = false;
    if (!more) {
      search.index = search.hits.length ? 0 : -1;
      if (search.hits.length) await jumpTo(search.hits[0].id, { flash: !textHasWords(search.hits[0], wordsOf(query)) });
      else {
        const log = $("#log");
        const top = log.scrollTop;
        renderLog();
        log.scrollTop = top;
      }
    }
    renderInSearch();
    return found.length > 0;
  } catch (error) {
    if (error.status === 401 || gen !== state.inSearch.gen) return false;
    search.loading = false;
    search.error = error.message || "검색하지 못했습니다.";
    renderInSearch();
    return false;
  }
}

/* 위(이전·더 예전) / 아래(다음·더 최근)로 옮겨 간다. 결과는 최신순이다. */
async function stepInSearch(direction) {
  const search = state.inSearch;
  if (!search.hits.length) return;
  let index = search.index + (direction === "older" ? 1 : -1);
  if (index >= search.hits.length) {
    if (!(await runInSearch({ more: true }))) return;
    index = Math.min(index, state.inSearch.hits.length - 1);
  }
  if (index < 0) return;
  state.inSearch.index = index;
  renderInSearch();
  const hit = state.inSearch.hits[index];
  // 첨부 이름으로 찾은 메시지는 글에 표시할 곳이 없으므로 테두리를 잠깐 밝힌다.
  await jumpTo(hit.id, { flash: !textHasWords(hit, wordsOf(state.inSearch.query)) });
}

$("#in-search-btn").addEventListener("click", () => {
  if (state.inSearch.open) $("#in-search-input").focus();
  else openInSearch();
});
$("#in-search-close").addEventListener("click", () => closeInSearch({ focus: true }));
$("#in-search-prev").addEventListener("click", () => stepInSearch("newer"));
$("#in-search-next").addEventListener("click", () => stepInSearch("older"));
$("#in-search-input").addEventListener("input", (event) => {
  state.inSearch.query = event.currentTarget.value;
  window.clearTimeout(inSearchTimer);
  inSearchTimer = window.setTimeout(() => runInSearch(), 300);
  renderInSearch();
});
$("#in-search-input").addEventListener("keydown", (event) => {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeInSearch({ focus: true });
  } else if (event.key === "Enter") {
    event.preventDefault();
    window.clearTimeout(inSearchTimer);
    state.inSearch.query = event.currentTarget.value;
    // 입력이 바뀐 뒤 아직 찾지 않았으면 먼저 찾는다.
    if (state.inSearch.ran !== state.inSearch.query.trim()) runInSearch();
    else if (!state.inSearch.loading) stepInSearch(event.shiftKey ? "newer" : "older"); // Enter 다음, Shift+Enter 이전
  }
});
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f" && state.me && isTalkView() && !state.locked) {
    event.preventDefault();
    openInSearch();
  }
});

/* ───────── 2-B: 반응·상태·사진 보기·즐겨찾기·별표·알림 끄기·입력 중·예약·파일 모아 보기 ───────── */

const REACTIONS = [
  { key: "thumbs_up", emoji: "👍", label: "좋아요" },
  { key: "check", emoji: "✅", label: "확인" },
  { key: "smile", emoji: "😊", label: "웃음" },
  { key: "clap", emoji: "👏", label: "박수" },
  { key: "pray", emoji: "🙏", label: "감사" },
  { key: "open_mouth", emoji: "😮", label: "놀람" },
];
const STATUS_CODES = [
  { code: "meeting", label: "회의 중" },
  { code: "trip", label: "출장" },
  { code: "outside", label: "외근" },
  { code: "training", label: "교육" },
  { code: "leave", label: "휴가" },
];
const DEFAULT_DND = { enabled: false, from: "18:00", to: "09:00", weekends: true };
const TYPING_TTL_MS = 15 * 1000;

/* ── B2 수동 상태 ── */

function manualStatus(userId) {
  const status = state.statuses?.[String(userId)];
  return status && (status.code || status.text) ? status : null;
}

function statusChip(userId) {
  const status = manualStatus(userId);
  const def = STATUS_CODES.find((item) => item.code === status?.code);
  if (!def) return null;
  const chip = el("span", `mst ${def.code}`);
  chip.append(iconUse(`st-${def.code}`), def.label);
  if (status.text) chip.title = status.text;
  return chip;
}

/* 수동 상태 칩 + 자동 상태 글자(시안: 칩을 자동 상태 앞에 붙인다) */
function statusChips(userId) {
  const frag = document.createDocumentFragment();
  const chip = statusChip(userId);
  if (chip) frag.append(chip);
  const text = statusText(userId);
  if (text) frag.append(text);
  return frag.childNodes.length ? frag : null;
}

function statusTitle(userId) {
  const presence = presenceOf(userId);
  const status = manualStatus(userId);
  const def = STATUS_CODES.find((item) => item.code === status?.code);
  return [presence ? PRESENCE[presence].label : "", def?.label || "", status?.text || ""].filter(Boolean).join(" · ");
}

function dndSummary(dnd) {
  if (!dnd.enabled) return "꺼짐";
  const range = dnd.from < dnd.to ? `매일 ${dnd.from} ~ ${dnd.to}` : `매일 ${dnd.from} ~ 다음 날 ${dnd.to}`;
  return dnd.from === dnd.to ? (dnd.weekends ? "주말 종일" : "시간을 고르세요") : `${range}${dnd.weekends ? " · 주말 종일" : ""}`;
}

let statusDraft = null;

function openStatusPop() {
  if (!state.me) return;
  if (!$("#status-pop").hidden) {
    closeStatusPop({ focus: true });
    return;
  }
  const mine = state.statuses?.[String(state.me.userId)] || { code: "", text: "" };
  statusDraft = { code: mine.code || "", text: mine.text || "" };
  $("#sp-error").textContent = "";
  renderStatusPop();
  $("#status-pop").hidden = false;
  $("#me").setAttribute("aria-expanded", "true");
  ($("#sp-codes [aria-checked=true]") || $("#sp-codes button"))?.focus();
}

function closeStatusPop({ focus = false } = {}) {
  const pop = $("#status-pop");
  if (!pop || pop.hidden) return;
  pop.hidden = true;
  statusDraft = null;
  $("#me").setAttribute("aria-expanded", "false");
  if (focus) $("#me").focus();
}

function renderStatusPop() {
  const draft = statusDraft;
  if (!draft) return;
  const me = state.me;
  const self = personById(me.userId);
  $("#sp-name").textContent = me.fullName || me.email || "";
  $("#sp-title").textContent = mySubtitle() || (self ? personTitle(self) : "");
  $("#sp-admin").hidden = !me.isAdmin;
  const auto = state.liveError ? "offline" : state.myStatus;
  $("#sp-dot").className = `dot ${PRESENCE[auto].cls}`.trim();
  $("#sp-auto").className = `st ${PRESENCE[auto].cls}`.trim();
  $("#sp-auto").textContent = PRESENCE[auto].label;
  const codes = $("#sp-codes");
  codes.replaceChildren();
  for (const def of [...STATUS_CODES, { code: "", label: "없음" }]) {
    const button = el("button", def.code ? "sopt" : "sopt none");
    button.type = "button";
    button.setAttribute("role", "radio");
    const checked = draft.code === def.code;
    button.setAttribute("aria-checked", String(checked));
    button.tabIndex = checked ? 0 : -1;
    button.dataset.code = def.code;
    if (def.code) {
      const icon = el("span", "ic");
      icon.style.background = `var(--ms-${def.code}-bg)`;
      icon.style.color = `var(--ms-${def.code})`;
      icon.append(iconUse(`st-${def.code}`));
      button.append(icon);
    }
    button.append(def.label);
    button.addEventListener("click", () => {
      draft.code = def.code;
      renderStatusPop();
      $(`#sp-codes [data-code="${def.code}"]`)?.focus();
    });
    codes.append(button);
  }
  const text = $("#sp-text");
  if (text.value !== draft.text) text.value = draft.text;
  $("#sp-count").textContent = `${Array.from(draft.text).length}/40`;
  $("#sp-dnd-sum").textContent = dndSummary(state.prefs.dnd);
}

$("#me").addEventListener("click", (event) => {
  event.stopPropagation();
  openStatusPop();
});
$("#sp-codes").addEventListener("keydown", (event) => {
  if (!statusDraft || !["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) return;
  event.preventDefault();
  const codes = [...STATUS_CODES.map((item) => item.code), ""];
  const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
  statusDraft.code = codes[(codes.indexOf(statusDraft.code) + step + codes.length) % codes.length];
  renderStatusPop();
  $(`#sp-codes [data-code="${statusDraft.code}"]`)?.focus();
});
$("#sp-text").addEventListener("input", (event) => {
  if (!statusDraft) return;
  statusDraft.text = event.currentTarget.value;
  $("#sp-count").textContent = `${Array.from(statusDraft.text).length}/40`;
});
$("#sp-notify-settings").addEventListener("click", () => {
  closeStatusPop();
  openSettings("notify");
});
$("#sp-cancel").addEventListener("click", () => closeStatusPop({ focus: true }));
$("#status-pop").addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.stopPropagation();
    closeStatusPop({ focus: true });
  }
});
$("#sp-save").addEventListener("click", async () => {
  const draft = statusDraft;
  if (!draft) return;
  const button = $("#sp-save");
  const session = state.sessionGen;
  button.disabled = true;
  $("#sp-error").textContent = "";
  try {
    const text = draft.text.replace(/\s+/g, " ").trim();
    const data = await api("POST", "/api/status", { code: draft.code, text });
    if (session !== state.sessionGen) return;
    state.statuses = { ...(state.statuses || {}), [String(state.me.userId)]: data.status || { code: draft.code, text } };
    closeStatusPop({ focus: true });
    renderMyPresence();
    renderList();
    updateHead();
    announce("내 상태를 저장했습니다.");
  } catch (error) {
    if (error.status === 401 || session !== state.sessionGen) return;
    $("#sp-error").textContent = error.message || "상태를 저장하지 못했습니다.";
  } finally {
    button.disabled = false;
  }
});

/* ── B4·B5 설정: 즐겨찾기·알림 끄기·방해 금지 ── */

const PREVIEW_MODES = ["full", "name", "none"];
const NOTIFY_SOUNDS = ["default", "im", "mail", "reminder", "none"];

/* 서버가 아직 주지 않는 필드(3단계)는 계약서 기본값으로 채운다. */
function normalizePrefs(data) {
  const keys = (list) => (Array.isArray(list) ? list.filter((key) => typeof key === "string") : []);
  const part = (value) => (value && typeof value === "object" ? value : {});
  const pick = (value, list, fallback) => (list.includes(value) ? value : fallback);
  const flag = (value, fallback) => (value === undefined || value === null ? fallback : Boolean(value));
  const dnd = part(data?.dnd);
  const notifyPart = part(data?.notify);
  const display = part(data?.display);
  const chat = part(data?.chat);
  const snoozeAt = Date.parse(notifyPart.snoozeUntil || "");
  return {
    favorites: keys(data?.favorites),
    muted: keys(data?.muted),
    dnd: {
      enabled: Boolean(dnd.enabled),
      from: /^\d\d:\d\d$/.test(dnd.from) ? dnd.from : DEFAULT_DND.from,
      to: /^\d\d:\d\d$/.test(dnd.to) ? dnd.to : DEFAULT_DND.to,
      weekends: dnd.weekends === undefined ? DEFAULT_DND.weekends : Boolean(dnd.weekends),
    },
    notify: {
      preview: pick(notifyPart.preview, PREVIEW_MODES, "full"),
      sound: pick(notifyPart.sound, NOTIFY_SOUNDS, "default"),
      flash: flag(notifyPart.flash, true),
      snoozeUntil: Number.isFinite(snoozeAt) ? notifyPart.snoozeUntil : null,
      replyBypassMute: flag(notifyPart.replyBypassMute, true),
    },
    display: {
      theme: pick(display.theme, ["system", "light", "dark"], "light"),
      fontSize: pick(display.fontSize, ["small", "normal", "large"], "normal"),
      density: pick(display.density, ["comfortable", "compact"], "comfortable"),
    },
    chat: {
      enterSends: flag(chat.enterSends, true),
      autoShowImages: flag(chat.autoShowImages, true),
      roomSort: pick(chat.roomSort, ["recent", "name"], "recent"),
    },
    presence: { awayMinutes: [5, 10, 15, 30, 60].includes(data?.presence?.awayMinutes) ? data.presence.awayMinutes : 10 },
    lock: { minutes: Number.isInteger(data?.lock?.minutes) ? data.lock.minutes : null },
    locked: keys(data?.locked), // 관리자 정책으로 고정된 설정(예: "notify.preview")
  };
}

/* 설정 값을 화면 전체에 적용한다(P2 화면, P3 보내기 키 안내, P4 자동 잠금). */
function applyPrefs() {
  applyDisplay(state.prefs.display);
  renderSendHints();
  if (state.me && !state.locked) startLockWatch();
}

/* 관리자 정책이 바뀌었다(D1): 세션의 policy·limits를 다시 읽고 설정도 다시 읽는다(고정 항목이 바뀐다). */
async function refreshPolicy() {
  const session = state.sessionGen;
  try {
    const data = await api("GET", "/api/session");
    if (session !== state.sessionGen || !state.me) return;
    if (data?.policy && typeof data.policy === "object") state.me.policy = data.policy;
    if (data?.limits && typeof data.limits === "object") state.me.limits = data.limits;
  } catch {
    // 다음 이벤트나 새로 고침 때 다시 맞춘다.
  }
  await loadPrefs();
}

async function loadPrefs() {
  const session = state.sessionGen;
  try {
    const data = await api("GET", "/api/prefs");
    if (session !== state.sessionGen) return;
    if (settingsSaving) {
      // 저장 중이면 읽은 값이 바꾸는 중인 값을 덮지 않게, 저장이 끝난 뒤 다시 읽는다.
      prefsReloadPending = true;
      return;
    }
    state.prefs = normalizePrefs(data);
    applyPrefs();
    renderList();
    updateRoomMenu();
    renderSnooze();
    if ($("#settings").open) renderSettings();
  } catch {
    // 설정을 못 읽으면 기본값(즐겨찾기·알림 끄기 없음)으로 쓴다.
  }
}

function isFavorite(key) {
  return state.prefs.favorites.includes(key);
}

function isMuted(key) {
  return state.prefs.muted.includes(key);
}

/* 대화방 메뉴(즐겨찾기·알림 끄기): 설정 창과 같은 저장 길(순번·병합 규칙)을 쓰고, 오류는 목록에 보인다. */
function savePrefs(patch, done) {
  return patchPrefs(patch, {
    done,
    onError: (error) => {
      state.noteStatus = error.message || "설정을 저장하지 못했습니다.";
      renderList();
    },
  });
}

function toggleListPref(name, key, onText, offText) {
  const on = state.prefs[name].includes(key);
  const next = on ? state.prefs[name].filter((item) => item !== key) : [...state.prefs[name], key];
  savePrefs({ [name]: next }, on ? offText : onText);
}

/* ── 3단계 S1 설정 창(design/main-screen-v4.html) ── */

const SETTINGS_TABS = ["me", "notify", "display", "chat", "security", "app"];
const SETTINGS_TITLES = { me: "내 정보", notify: "알림", display: "화면", chat: "대화", security: "보안·개인정보", app: "PC 앱" };
let settingsTab = "notify";
let settingsSaving = 0; // 진행 중인 저장 수
let settingsSeq = 0; // 마지막으로 보낸 저장의 순번(그 응답만 화면에 반영한다)
let prefsReloadPending = false; // 저장 중에 온 prefsChanged·읽기는 저장이 끝난 뒤 한 번 다시 읽는다
let settingsReturnFocus = null;

function settingsTabsShown() {
  return SETTINGS_TABS.filter((tab) => tab !== "app" || isDesktopApp());
}

function openSettings(tab = settingsTab, { returnFocus = document.activeElement } = {}) {
  if (!state.me || state.locked || state.pwForced) return;
  closeStatusPop();
  closeSnoozeMenu();
  closeCenter();
  settingsTab = settingsTabsShown().includes(tab) ? tab : "notify";
  settingsReturnFocus = returnFocus instanceof HTMLElement ? returnFocus : null;
  setSaved("");
  setPicError("");
  $("#set-snooze-custom").hidden = true;
  resetSettingsPassword();
  const dialog = $("#settings");
  if (!dialog.open) dialog.showModal();
  renderSettings();
  renderSettingsVersion();
  loadKeywords();
  loadPrivacy();
  loadSessions();
  loadAppSettings();
  $(`#set-tab-${settingsTab}`).focus();
}

function selectSettingsTab(tab, { focus = false } = {}) {
  if (tab === settingsTab) return;
  cancelHotkeyCapture();
  settingsTab = tab;
  setSaved("");
  renderSettings();
  if (tab === "app") loadAppSettings();
  if (focus) $(`#set-tab-${tab}`).focus();
}

/* 머리글의 "저장됨"·저장 실패 표시. kind: "" | "ok" | "err" */
function setSaved(kind, text = "") {
  const node = $("#set-saved");
  node.replaceChildren();
  node.hidden = !kind;
  node.classList.toggle("err", kind === "err");
  if (!kind) return;
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("class", "i");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", kind === "err" ? "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM12 7.5v5M12 16v.5" : "m5 12.5 4 4L19 7");
  icon.append(path);
  node.append(icon, kind === "err" ? text || "저장하지 못해 이전 값으로 되돌렸습니다" : "저장됨");
}

function renderSettings() {
  if (!state.me) return;
  $("#set-tab-app").hidden = !isDesktopApp();
  $("#set-tabs").setAttribute("aria-orientation", window.matchMedia?.("(max-width: 720px)").matches ? "horizontal" : "vertical");
  for (const tab of SETTINGS_TABS) {
    const button = $(`#set-tab-${tab}`);
    const current = tab === settingsTab;
    button.setAttribute("aria-selected", String(current));
    button.tabIndex = current ? 0 : -1;
    $(`#set-${tab}`).hidden = !current;
  }
  $("#set-pane-title").textContent = SETTINGS_TITLES[settingsTab];
  // 내 정보
  const me = state.me;
  $("#set-name").textContent = me.fullName || me.email || "";
  $("#set-org").textContent = mySubtitle() || "";
  $("#set-kv-name").textContent = me.fullName || "-";
  $("#set-kv-dept").textContent = me.department || "-";
  $("#set-kv-pos").textContent = me.position || "-";
  $("#set-kv-id").textContent = me.email || "-";
  renderMyAvatar();
  // 알림
  const prefs = state.prefs;
  const n = prefs.notify;
  renderSnoozeChoices();
  const forced = Boolean(me.policy?.forcePreviewHidden) || prefs.locked.includes("notify.preview");
  const mode = previewMode();
  const cards = $("#set-preview");
  cards.classList.toggle("locked", forced);
  for (const card of cards.querySelectorAll(".rcard")) {
    const checked = card.dataset.pv === mode;
    card.setAttribute("aria-checked", String(checked));
    card.setAttribute("aria-disabled", String(forced));
    card.tabIndex = checked ? 0 : -1;
  }
  $("#set-preview-lock").hidden = !forced;
  $("#set-preview-desc").textContent = forced
    ? "관리자가 알림 내용을 숨기도록 정했습니다. 바꾸려면 관리자에게 문의하세요."
    : "Windows 알림 팝업에 무엇을 보여 줄지 고릅니다.";
  $("#set-sound-row").hidden = !isDesktopApp();
  $("#set-sound-web").hidden = isDesktopApp();
  $("#set-flash-row").hidden = !isDesktopApp();
  $("#set-sound").value = n.sound;
  $("#set-flash").setAttribute("aria-checked", String(n.flash));
  $("#set-reply").setAttribute("aria-checked", String(n.replyBypassMute));
  $("#set-dnd").setAttribute("aria-checked", String(prefs.dnd.enabled));
  $("#set-dnd-sum").textContent = prefs.dnd.enabled
    ? `${dndSummary(prefs.dnd)} · 나를 멘션한 메시지와 중요 메시지는 방해 금지 중에도 알립니다.`
    : "나를 멘션한 메시지와 중요 메시지는 방해 금지 중에도 알립니다.";
  $("#set-from").value = prefs.dnd.from;
  $("#set-to").value = prefs.dnd.to;
  $("#set-weekends").checked = prefs.dnd.weekends;
  for (const id of ["#set-from", "#set-to", "#set-weekends"]) $(id).disabled = !prefs.dnd.enabled;
  renderMutedSettings();
  renderKeywords();
  renderPrefRadios();
  renderChatSettings();
  renderSecuritySettings();
}

/* 알림 끈 대화방. 이름을 모르는 대화방(나간 그룹 등)도 지울 수 있게 남긴다. */
function mutedRoom(key) {
  if (key === "general") {
    const node = el("span", "av notice");
    node.setAttribute("aria-hidden", "true");
    node.append(iconUse("ico-notice"));
    return { name: GENERAL_NAME, sub: "전체 대화방", avatar: node };
  }
  const [kind, id] = key.split(":");
  if (kind === "dm") {
    const person = personById(Number(id));
    return { name: person?.fullName || "알 수 없는 직원", sub: person ? personTitle(person) || "1:1 대화" : "1:1 대화", avatar: avatar(person) };
  }
  if (kind === "group") {
    const group = groupById(Number(id));
    const count = Array.isArray(group?.memberIds) ? group.memberIds.length : 0;
    return {
      name: group ? group.name || (group.dept ? "부서 대화방" : "이름 없는 그룹") : "나간 대화방",
      sub: group ? [group.dept ? "부서 대화방" : "그룹", count ? `${count}명` : ""].filter(Boolean).join(" · ") : "더는 참여하지 않는 대화방",
      avatar: group?.dept ? deptAvatar() : groupAvatar(false),
    };
  }
  return { name: key, sub: "", avatar: groupAvatar(false) };
}

function renderMutedSettings() {
  const list = $("#set-muted");
  list.replaceChildren();
  const keys = state.prefs.muted;
  list.hidden = !keys.length;
  $("#set-muted-empty").hidden = Boolean(keys.length);
  $("#set-muted-n").textContent = keys.length ? String(keys.length) : "";
  for (const key of keys) {
    const room = mutedRoom(key);
    const row = el("div", "mroom");
    row.setAttribute("role", "listitem");
    const text = el("span", "");
    text.append(el("b", "", room.name), el("small", "", room.sub));
    const button = el("button", "txt-btn", "알림 켜기");
    button.type = "button";
    button.setAttribute("aria-label", `${room.name} 알림 켜기`);
    button.addEventListener("click", () => {
      saveSettings({ muted: state.prefs.muted.filter((item) => item !== key) }, `${room.name} 알림을 켰습니다.`);
    });
    row.append(room.avatar, text, button);
    list.append(row);
  }
}

/* 바꾸면 바로 저장한다. 실패하면 서버 값을 다시 읽어 되돌리고 머리글에 알린다. */
function saveSettings(patch, done) {
  return patchPrefs(patch, {
    done,
    onSaved: () => setSaved("ok"),
    // 정책 고정(403)은 서버 문구를, 그 밖에는 시안 문구를 보인다.
    onError: (error) => setSaved("err", error.status === 403 && error.message ? error.message : ""),
  });
}

/* prefs 저장의 유일한 길.
 * - 화면 상태는 바로 바꾼다(묶음은 보낸 필드만 합치고, 목록은 통째로 바꾼다).
 * - 요청마다 순번을 매기고, 묶음마다 "마지막으로 그 묶음을 바꾼 요청"을 기억한다.
 * - 응답은 마지막 요청이면 전체를, 아니면 그 요청이 바꾼 묶음 중 뒤에 다른 요청이 건드리지 않은 것만 반영한다. */
const prefsGroupSeq = {};

async function patchPrefs(patch, { done = "", onSaved = null, onError = null } = {}) {
  if (!state.me) return false;
  const session = state.sessionGen;
  const previous = {};
  for (const name of Object.keys(patch)) previous[name] = state.prefs[name];
  // 묶음(notify·dnd·display…)은 보낸 필드만 덮고, 목록(favorites·muted)은 통째로 바꾼다.
  const merged = {};
  for (const [name, value] of Object.entries(patch)) {
    const current = state.prefs[name];
    merged[name] = value && typeof value === "object" && !Array.isArray(value) && current && typeof current === "object" && !Array.isArray(current)
      ? { ...current, ...value }
      : value;
  }
  state.prefs = { ...state.prefs, ...merged };
  settingsSaving += 1;
  const seq = ++settingsSeq;
  for (const name of Object.keys(patch)) prefsGroupSeq[name] = seq;
  // 응답(서버의 전체 값)에서 이 요청이 반영해도 되는 묶음만 가져온다.
  const adopt = (data) => {
    const fresh = normalizePrefs(data);
    if (seq === settingsSeq) {
      state.prefs = fresh;
      return;
    }
    const next = { ...state.prefs };
    for (const name of Object.keys(patch)) if (prefsGroupSeq[name] === seq) next[name] = fresh[name];
    next.locked = fresh.locked;
    state.prefs = next;
  };
  applyPrefs();
  renderSettings();
  renderSnooze();
  renderList();
  updateRoomMenu();
  try {
    const data = await api("PATCH", "/api/prefs", patch);
    if (session !== state.sessionGen) return false;
    adopt(data);
    onSaved?.();
    if (done) announce(done);
    return true;
  } catch (error) {
    if (error.status === 401 || session !== state.sessionGen) return false;
    onError?.(error);
    // 되돌리기: 서버 값을 다시 읽어, 이 요청이 마지막으로 바꾼 묶음(마지막 요청이면 전체)을 맞춘다.
    try {
      const data = await api("GET", "/api/prefs");
      if (session !== state.sessionGen) return false;
      adopt(data);
    } catch {
      const next = { ...state.prefs };
      for (const name of Object.keys(patch)) if (prefsGroupSeq[name] === seq) next[name] = previous[name];
      state.prefs = next;
    }
    return false;
  } finally {
    settingsSaving -= 1;
    if (!settingsSaving && prefsReloadPending && session === state.sessionGen) {
      prefsReloadPending = false;
      loadPrefs();
    }
    if (session === state.sessionGen) {
      applyPrefs();
      if ($("#settings").open) renderSettings();
      renderSnooze();
      renderList();
      updateRoomMenu();
    }
  }
}

function saveNotify(change, done) {
  return saveSettings({ notify: { ...change } }, done);
}

function saveDnd(change, done) {
  return saveSettings({ dnd: { ...change } }, done);
}

/* 버전: 웹은 /api/session의 version, PC 앱은 app_info. 모르는 값은 쓰지 않는다. */
async function renderSettingsVersion() {
  const web = state.me?.version ? `웹 ${state.me.version}` : "";
  const show = (desktop) => {
    $("#set-version").textContent = [desktop, web].filter(Boolean).join(" · ") || "버전 정보 없음";
  };
  show("");
  if (!isDesktopApp() || !bridge?.appInfo) return;
  const info = await bridge.appInfo();
  if (info?.version && $("#settings").open) show(`PC 앱 ${info.version}`);
}

/* ── P2·P3 고르기(카드·분할 버튼): data-pref="묶음.필드", 각 단추 data-v ── */
function prefValue(path) {
  const [group, field] = path.split(".");
  return state.prefs?.[group]?.[field];
}

function savePrefValue(path, value, done) {
  const [group, field] = path.split(".");
  if (prefValue(path) === value) return;
  saveSettings({ [group]: { [field]: value } }, done);
}

const PREF_DONE = {
  "display.theme": "테마를 바꿨습니다.",
  "display.fontSize": "글자 크기를 바꿨습니다.",
  "display.density": "대화창 밀도를 바꿨습니다.",
  "chat.roomSort": "대화방 목록 정렬을 바꿨습니다.",
};

function renderPrefRadios() {
  for (const group of document.querySelectorAll("#settings [data-pref]")) {
    const value = prefValue(group.dataset.pref);
    for (const button of group.querySelectorAll("[data-v]")) {
      const checked = button.dataset.v === value;
      button.setAttribute("aria-checked", String(checked));
      button.tabIndex = checked ? 0 : -1;
    }
  }
}

for (const group of document.querySelectorAll("#settings [data-pref]")) {
  group.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-v]");
    if (button) savePrefValue(group.dataset.pref, button.dataset.v, PREF_DONE[group.dataset.pref]);
  });
  group.addEventListener("keydown", (event) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const buttons = [...group.querySelectorAll("[data-v]")];
    const index = buttons.findIndex((button) => button.dataset.v === prefValue(group.dataset.pref));
    const next = buttons[(index + step + buttons.length) % buttons.length];
    savePrefValue(group.dataset.pref, next.dataset.v, PREF_DONE[group.dataset.pref]);
    next.focus();
  });
}

/* ── P3 대화 ── */
function renderChatSettings() {
  const chat = state.prefs.chat;
  for (const input of document.querySelectorAll('#set-enter input[name="set-enter"]')) input.checked = (input.value === "enter") === chat.enterSends;
  $("#set-autoimg").setAttribute("aria-checked", String(chat.autoShowImages));
}

$("#set-enter").addEventListener("change", (event) => {
  const enter = event.target.value === "enter";
  saveSettings({ chat: { enterSends: enter } }, enter ? "Enter로 보냅니다." : "Ctrl+Enter로 보냅니다.");
});
$("#set-autoimg").addEventListener("click", () => {
  const next = !state.prefs.chat.autoShowImages;
  saveSettings({ chat: { autoShowImages: next } }, next ? "사진을 자동으로 보여 줍니다." : "사진은 눌러야 보입니다.")
    .then(() => {
      if (isTalkView()) renderLog();
    });
});

/* ── P4 보안·개인정보 ── */
const LOCK_CHOICES = [1, 3, 5, 10, 15, 30, 60, 120, 240, 480];

function renderSecuritySettings() {
  const admin = adminLockMinutes();
  const mine = state.prefs.lock.minutes;
  const select = $("#set-lock");
  const options = [{ value: "", label: admin ? `기관 설정 따르기 (${admin}분)` : "기관 설정 따르기 (끔)" }];
  const choices = admin ? LOCK_CHOICES.filter((minutes) => minutes < admin) : LOCK_CHOICES.filter((minutes) => minutes >= 5 && minutes <= 60);
  if (Number.isInteger(mine) && mine > 0 && !choices.includes(mine)) choices.push(mine);
  choices.sort((a, b) => a - b);
  for (const minutes of choices) options.push({ value: String(minutes), label: `${minutes}분` });
  if (!admin && mine === 0) options.push({ value: "0", label: "끄기" });
  select.replaceChildren(...options.map((option) => {
    const node = document.createElement("option");
    node.value = option.value;
    node.textContent = option.label;
    return node;
  }));
  select.value = Number.isInteger(mine) ? String(mine) : "";
  $("#set-lock-desc").textContent = admin
    ? `기관 설정 ${admin}분보다 짧게만 고를 수 있습니다.`
    : "기관 설정은 자동 잠금을 쓰지 않습니다. 직접 고를 수 있습니다.";
  $("#set-away").value = String(state.prefs.presence.awayMinutes);
  renderPrivacy();
  renderSessions();
}

$("#set-lock").addEventListener("change", (event) => {
  const value = event.currentTarget.value;
  const minutes = value === "" ? null : Number(value);
  saveSettings({ lock: { minutes } }, minutes === null ? "자동 잠금은 기관 설정을 따릅니다." : `${minutes}분 동안 입력이 없으면 잠급니다.`);
});
$("#set-away").addEventListener("change", (event) => {
  const minutes = Number(event.currentTarget.value);
  saveSettings({ presence: { awayMinutes: minutes } }, `${minutes}분 동안 입력이 없으면 자리 비움으로 바꿉니다.`);
});

const privacyState = { data: null, busy: false, gen: 0 };

async function loadPrivacy() {
  const gen = ++privacyState.gen;
  const session = state.sessionGen;
  try {
    const data = await api("GET", "/api/me/privacy");
    if (gen !== privacyState.gen || session !== state.sessionGen) return;
    privacyState.data = { readReceipts: data?.readReceipts !== false, presence: data?.presence !== false, typing: data?.typing !== false };
  } catch {
    if (gen !== privacyState.gen) return;
    privacyState.data = null;
  }
  renderPrivacy();
}

function renderPrivacy() {
  $("#set-privacy-group").hidden = !privacyState.data;
  if (!privacyState.data) return;
  for (const button of document.querySelectorAll("#set-privacy-group [data-privacy]")) {
    button.setAttribute("aria-checked", String(privacyState.data[button.dataset.privacy]));
    button.disabled = privacyState.busy;
  }
}

const PRIVACY_DONE = {
  readReceipts: ["읽음 확인을 보냅니다.", "읽음 확인을 보내지 않습니다."],
  presence: ["접속 상태를 공개합니다.", "접속 상태를 공개하지 않습니다."],
  typing: ["입력 중 표시를 보냅니다.", "입력 중 표시를 보내지 않습니다."],
};

$("#set-privacy-group").addEventListener("click", async (event) => {
  const button = event.target.closest?.("[data-privacy]");
  if (!button || !privacyState.data || privacyState.busy) return;
  const name = button.dataset.privacy;
  const next = !privacyState.data[name];
  const before = privacyState.data;
  const session = state.sessionGen;
  privacyState.data = { ...before, [name]: next };
  privacyState.busy = true;
  renderPrivacy();
  try {
    const data = await api("PATCH", "/api/me/privacy", { [name]: next });
    if (session !== state.sessionGen) return;
    privacyState.data = { readReceipts: data?.readReceipts !== false, presence: data?.presence !== false, typing: data?.typing !== false };
    setSaved("ok");
    announce(PRIVACY_DONE[name][next ? 0 : 1]);
  } catch (error) {
    if (error.status === 401 || session !== state.sessionGen) return;
    privacyState.data = before;
    setSaved("err", error.status === 403 && error.message ? error.message : "");
  } finally {
    privacyState.busy = false;
    renderPrivacy();
    button.focus();
  }
});

const sessionList = { items: null, error: "", busy: false, gen: 0 };

async function loadSessions() {
  const gen = ++sessionList.gen;
  const session = state.sessionGen;
  try {
    const data = await api("GET", "/api/me/sessions");
    if (gen !== sessionList.gen || session !== state.sessionGen) return;
    sessionList.items = Array.isArray(data?.sessions) ? data.sessions.filter((item) => item && item.id) : [];
    sessionList.error = "";
  } catch (error) {
    if (gen !== sessionList.gen || error.status === 401) return;
    sessionList.items = null;
    sessionList.error = error.message || "로그인 목록을 불러오지 못했습니다.";
  }
  renderSessions();
}

function sessionWhen(value) {
  const ms = typeof value === "number" ? (value > 1e12 ? value : value * 1000) : Date.parse(value || "");
  if (!Number.isFinite(ms)) return "";
  const minutes = Math.floor((Date.now() - ms) / 60000);
  if (minutes < 2) return "지금 사용 중";
  if (minutes < 60) return `${minutes}분 전 사용`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}시간 전 사용`;
  return `${formatListTime(ms / 1000)} 사용`;
}

function renderSessions() {
  const box = $("#set-sessions");
  box.replaceChildren();
  const error = $("#set-sess-error");
  error.hidden = !sessionList.error;
  error.querySelector("span").textContent = sessionList.error;
  const items = sessionList.items || [];
  box.hidden = !items.length;
  const others = items.filter((item) => !item.current);
  $("#set-sess-others").hidden = !sessionList.items;
  $("#set-sess-others").disabled = sessionList.busy || !others.length;
  // 지금 이 기기를 맨 위에
  for (const item of [...items].sort((a, b) => Number(Boolean(b.current)) - Number(Boolean(a.current)))) {
    const row = el("div", "ses");
    row.setAttribute("role", "listitem");
    const icon = el("span", "ic");
    icon.setAttribute("aria-hidden", "true");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "i");
    svg.setAttribute("viewBox", "0 0 24 24");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", item.client === "desktop"
      ? "M5.5 4.5h13a2 2 0 0 1 2 2V14a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2ZM9 20h6M12 16v4"
      : "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM3.5 12h17M12 3.5c2.5 2.6 2.5 14.4 0 17M12 3.5c-2.5 2.6-2.5 14.4 0 17");
    svg.append(path);
    icon.append(svg);
    const text = el("span", "");
    const title = el("b", "", item.client === "desktop" ? "PC 앱" : "브라우저");
    if (item.current) title.append(el("span", "cur", "지금 이 기기"));
    text.append(title, el("small", "", [item.ip, item.current ? "지금 사용 중" : sessionWhen(item.lastSeenAt)].filter(Boolean).join(" · ")));
    row.append(icon, text);
    if (item.current) row.append(el("span", ""));
    else {
      const out = el("button", "btn line sm danger", "로그아웃");
      out.type = "button";
      out.disabled = sessionList.busy;
      out.setAttribute("aria-label", `${item.client === "desktop" ? "PC 앱" : "브라우저"} ${item.ip || ""} 로그아웃`.replace(/\s+/g, " "));
      out.addEventListener("click", () => endSessions(`/api/me/sessions/${encodeURIComponent(item.id)}`));
      row.append(out);
    }
    box.append(row);
  }
}

async function endSessions(path) {
  const session = state.sessionGen;
  sessionList.busy = true;
  sessionList.error = "";
  renderSessions();
  try {
    const data = await api("DELETE", path);
    if (session !== state.sessionGen) return;
    const ended = Number(data?.ended) || 0;
    announce(ended ? `${ended}곳에서 로그아웃했습니다.` : "로그아웃할 곳이 없습니다.");
  } catch (error) {
    if (error.status === 401 || session !== state.sessionGen) return;
    sessionList.error = error.message || "로그아웃하지 못했습니다.";
  } finally {
    sessionList.busy = false;
    await loadSessions();
    $("#set-sess-others").focus();
  }
}

$("#set-sess-others").addEventListener("click", async () => {
  const ok = await askConfirm({ title: "다른 곳에서 모두 로그아웃할까요?", text: "지금 이 기기를 뺀 모든 로그인이 끝납니다.", confirm: "모두 로그아웃", cancel: "취소" });
  if (ok) endSessions("/api/me/sessions?others=1");
});

/* ── P5 PC 앱(데스크톱만). 명령이 실패하면 데스크톱이 준 한국어 문장을 보인다. ── */
const appSettings = { autostart: null, closeAction: null, hotkey: null, captureBlock: null, capturing: false };

function setAppError(text, id = "#set-app-error") {
  const box = $(id);
  box.hidden = !text;
  box.querySelector("span").textContent = text || "";
}

async function loadAppSettings() {
  if (!isDesktopApp() || !bridge?.getAutostart) return;
  setAppError("");
  setAppError("", "#set-hk-error");
  const [autostart, closeAction, hotkey, info] = await Promise.all([
    bridge.getAutostart().catch(() => null),
    bridge.getCloseAction().catch(() => null),
    bridge.getHotkey().catch(() => null),
    bridge.appInfo?.().catch(() => null),
  ]);
  Object.assign(appSettings, { autostart, closeAction, hotkey, captureBlock: info ? info.captureBlock : null });
  renderAppSettings();
}

/* "Ctrl+Shift+Space" → [Ctrl] + [Shift] + [Space] */
function renderHotkeyKeys(accelerator) {
  const box = $("#set-hk-keys");
  box.replaceChildren();
  const parts = String(accelerator || "").split("+").filter(Boolean);
  parts.forEach((part, index) => {
    if (index) box.append(el("span", "plus", "+"));
    const label = /^(super|meta|cmd|command)$/i.test(part) ? "Win" : /^(commandorcontrol|cmdorctrl|control)$/i.test(part) ? "Ctrl" : part;
    box.append(el("kbd", "k", label));
  });
  if (!parts.length) box.append(el("span", "note", "지정한 키가 없습니다"));
}

function renderAppSettings() {
  const ready = appSettings.autostart !== null;
  $("#set-autostart").setAttribute("aria-checked", String(Boolean(appSettings.autostart)));
  $("#set-autostart").disabled = !ready;
  for (const input of document.querySelectorAll('#set-close-action input[name="set-close-action"]')) {
    input.checked = input.value === (appSettings.closeAction || "tray");
    input.disabled = appSettings.closeAction === null;
  }
  const hotkey = appSettings.hotkey;
  $("#set-hk-on").setAttribute("aria-checked", String(Boolean(hotkey?.enabled)));
  $("#set-hk-on").disabled = !hotkey;
  $("#set-hk-change").disabled = !hotkey;
  if (!appSettings.capturing) renderHotkeyKeys(hotkey?.accelerator || "");
  const inactive = Boolean(hotkey?.enabled && hotkey.active === false);
  if (inactive && !appSettings.capturing) {
    setAppError("다른 프로그램이 이 단축키를 쓰고 있어 지금은 동작하지 않습니다. 다른 키를 골라 주세요.", "#set-hk-error");
  } else if (!inactive && appSettings.hotkeyInactiveShown) {
    setAppError("", "#set-hk-error");
  }
  appSettings.hotkeyInactiveShown = inactive;
  const capture = appSettings.captureBlock;
  $("#set-capture").setAttribute("aria-checked", String(Boolean(capture)));
  $("#set-capture-text").textContent = capture === null ? "확인하지 못했습니다" : capture ? "캡처 막기 켜짐" : "캡처 막기 꺼짐";
}

async function runAppSetting(action, done, errorId = "#set-app-error") {
  setAppError("", errorId);
  try {
    await action();
    setSaved("ok");
    if (done) announce(done);
    return true;
  } catch (error) {
    setAppError(error.message || "PC 앱 설정을 바꾸지 못했습니다.", errorId);
    setSaved("err", error.message || "");
    return false;
  } finally {
    renderAppSettings();
  }
}

$("#set-autostart").addEventListener("click", () => {
  const next = !appSettings.autostart;
  runAppSetting(async () => {
    appSettings.autostart = await bridge.setAutostart(next);
  }, next ? "Windows 시작 시 실행합니다." : "Windows 시작 시 실행하지 않습니다.");
});
$("#set-close-action").addEventListener("change", (event) => {
  const action = event.target.value === "quit" ? "quit" : "tray";
  runAppSetting(async () => {
    appSettings.closeAction = await bridge.setCloseAction(action);
  }, action === "quit" ? "창을 닫으면 상상톡을 끝냅니다." : "창을 닫으면 트레이로 숨깁니다.");
});
$("#set-hk-on").addEventListener("click", () => {
  const next = !appSettings.hotkey?.enabled;
  runAppSetting(async () => {
    appSettings.hotkey = await bridge.setHotkey(next);
  }, next ? "창 불러오기 단축키를 켰습니다." : "창 불러오기 단축키를 껐습니다.", "#set-hk-error");
});

/* 단축키 바꾸기: 버튼을 누른 뒤 새 조합을 누른다(Esc 취소). Ctrl·Alt·Win 중 하나가 있어야 한다. */
const HOTKEY_KEYS = { Escape: "Escape", Space: "Space", Enter: "Enter", Tab: "Tab", Backspace: "Backspace", Delete: "Delete", Insert: "Insert", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right" };

function hotkeyFromEvent(event) {
  const code = event.code || "";
  let key = "";
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code;
  else if (HOTKEY_KEYS[code]) key = HOTKEY_KEYS[code];
  if (!key) return "";
  const parts = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Super");
  parts.push(key);
  return parts.join("+");
}

function cancelHotkeyCapture() {
  if (!appSettings.capturing) return;
  appSettings.capturing = false;
  $("#set-hk-change").textContent = "바꾸기";
  $("#set-hk-change").setAttribute("aria-pressed", "false");
  $("#set-hk-hint").hidden = true;
  renderHotkeyKeys(appSettings.hotkey?.accelerator || "");
}

$("#set-hk-change").addEventListener("click", () => {
  if (appSettings.capturing) {
    cancelHotkeyCapture();
    return;
  }
  appSettings.capturing = true;
  setAppError("", "#set-hk-error");
  const button = $("#set-hk-change");
  button.textContent = "키를 누르세요…";
  button.setAttribute("aria-pressed", "true");
  $("#set-hk-hint").hidden = false;
  $("#set-hk-keys").replaceChildren(el("span", "note", "새 단축키를 기다리는 중"));
});
$("#set-hk-change").addEventListener("blur", () => cancelHotkeyCapture());
$("#set-hk-change").addEventListener("keydown", async (event) => {
  if (!appSettings.capturing) return;
  if (event.key === "Escape" && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
    event.preventDefault();
    event.stopPropagation();
    cancelHotkeyCapture();
    return;
  }
  if (event.key === "Tab") {
    cancelHotkeyCapture();
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  if (["Control", "Shift", "Alt", "Meta", "OS"].includes(event.key)) return; // 조합을 다 누를 때까지 기다린다
  const accelerator = hotkeyFromEvent(event);
  if (!accelerator) {
    setAppError("이 키는 단축키로 쓸 수 없습니다. 다른 키를 골라 주세요.", "#set-hk-error");
    return;
  }
  const modifiers = [event.ctrlKey, event.altKey, event.shiftKey].filter(Boolean).length;
  if (!event.metaKey && modifiers < 2) {
    setAppError("단축키에는 Ctrl·Alt·Shift 중 두 개 이상 또는 Windows 키가 들어가야 합니다.", "#set-hk-error");
    return;
  }
  if (/^Ctrl\+(Alt\+Delete|Shift\+Escape)$/.test(accelerator)) {
    setAppError("Windows가 쓰는 단축키는 지정할 수 없습니다.", "#set-hk-error");
    return;
  }
  appSettings.capturing = false;
  $("#set-hk-change").textContent = "바꾸기";
  $("#set-hk-change").setAttribute("aria-pressed", "false");
  $("#set-hk-hint").hidden = true;
  await runAppSetting(async () => {
    appSettings.hotkey = await bridge.setHotkey(true, accelerator);
  }, `창 불러오기 단축키를 ${accelerator}(으)로 바꿨습니다.`, "#set-hk-error");
});

/* P1 내 사진: 레일·상태 창·설정에 같은 사진. 주소가 ""면 기본 거북이(목업). 실서버는 자동 그림 주소를 준다. */
function renderMyAvatar() {
  const url = state.me?.avatarUrl || "";
  const set = (img, onTurtle) => {
    if (!img) return;
    img.onerror = null;
    if (url) {
      img.onerror = () => {
        img.onerror = null;
        img.src = TURTLE;
        onTurtle?.(true);
      };
      img.src = url;
      onTurtle?.(false);
    } else {
      img.src = TURTLE;
      onTurtle?.(true);
    }
  };
  set($("#me-avatar img"), (turtle) => $("#me-avatar").classList.toggle("turtle", turtle));
  set($("#sp-pic"));
  set($("#set-pic"), (turtle) => $("#set-pic").classList.toggle("turtle", turtle));
  if ($("#set-pic-reset")) $("#set-pic-reset").hidden = !url;
}

const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

function setPicError(text) {
  $("#set-pic-error").hidden = !text;
  $("#set-pic-error span").textContent = text;
}

/* 내 사진이 바뀌면 사람 목록의 내 항목도 맞춘다(목록·대화의 내 아바타). */
function applyMyAvatar(url) {
  if (!state.me) return;
  state.me.avatarUrl = url || "";
  const self = personById(state.me.userId);
  if (self) self.avatarUrl = url || "";
  renderMyAvatar();
  renderList();
  if (isTalkView()) renderLog();
}

async function changeAvatar(file) {
  setPicError("");
  if (!file) return;
  const typeOk = file.type ? /^image\/(png|jpeg)$/.test(file.type) : /\.(png|jpe?g)$/i.test(file.name);
  if (!typeOk) {
    setPicError("사진은 PNG나 JPG 파일만 올릴 수 있습니다.");
    return;
  }
  if (file.size > AVATAR_MAX_BYTES) {
    setPicError("사진은 5MB까지 올릴 수 있습니다.");
    return;
  }
  const session = state.sessionGen;
  const button = $("#set-pic-change");
  button.disabled = true;
  button.textContent = "올리는 중…";
  try {
    const form = new FormData();
    form.append("file", file, file.name);
    const response = await fetch("/api/me/avatar", { method: "POST", body: form });
    const data = await response.json().catch(() => ({}));
    if (session !== state.sessionGen) return;
    if (response.status === 401) {
      showLogin("다시 로그인해 주세요.");
      return;
    }
    if (guardResponse(response.status, data)) return;
    if (!response.ok) throw Object.assign(new Error(data.error || "사진을 바꾸지 못했습니다."), { status: response.status });
    applyMyAvatar(data.avatarUrl || "");
    setSaved("ok");
    announce("내 사진을 바꿨습니다.");
  } catch (error) {
    if (session !== state.sessionGen) return;
    setPicError(error.message || "사진을 바꾸지 못했습니다.");
  } finally {
    button.disabled = false;
    button.textContent = "사진 바꾸기";
  }
}

async function resetAvatar() {
  setPicError("");
  const session = state.sessionGen;
  const button = $("#set-pic-reset");
  button.disabled = true;
  try {
    const data = await api("DELETE", "/api/me/avatar");
    if (session !== state.sessionGen) return;
    applyMyAvatar(data.avatarUrl || "");
    setSaved("ok");
    announce("기본 사진으로 되돌렸습니다.");
    $("#set-pic-change").focus();
  } catch (error) {
    if (error.status === 401 || session !== state.sessionGen) return;
    setPicError(error.message || "사진을 되돌리지 못했습니다.");
  } finally {
    button.disabled = false;
  }
}

$("#set-pic-change").addEventListener("click", () => $("#set-pic-file").click());
$("#set-pic-file").addEventListener("change", (event) => {
  const file = event.currentTarget.files?.[0];
  event.currentTarget.value = "";
  changeAvatar(file);
});
$("#set-pic-reset").addEventListener("click", resetAvatar);

/* 내 정보 > 비밀번호 바꾸기(설정 안에서 바로) */
function resetSettingsPassword() {
  $("#set-pw-form").hidden = true;
  $("#set-pw-closed").hidden = false;
  for (const id of ["#set-pw-old", "#set-pw-new", "#set-pw-confirm"]) {
    $(id).value = "";
    $(id).classList.remove("bad");
    $(id).removeAttribute("aria-invalid");
  }
  setPwError("");
}

function setPwError(text, id = "") {
  const box = $("#set-pw-error");
  box.hidden = !text;
  box.querySelector("span").textContent = text;
  if (id) {
    $(id).classList.add("bad");
    $(id).setAttribute("aria-invalid", "true");
    $(id).focus();
  }
}

$("#set-pw-open").addEventListener("click", () => {
  $("#set-pw-closed").hidden = true;
  $("#set-pw-form").hidden = false;
  $("#set-pw-old").focus();
});
$("#set-pw-cancel").addEventListener("click", () => {
  resetSettingsPassword();
  $("#set-pw-open").focus();
});
$("#set-pw-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  for (const id of ["#set-pw-old", "#set-pw-new", "#set-pw-confirm"]) {
    $(id).classList.remove("bad");
    $(id).removeAttribute("aria-invalid");
  }
  setPwError("");
  const oldPassword = $("#set-pw-old").value;
  const newPassword = $("#set-pw-new").value;
  if (!oldPassword) return setPwError("현재 비밀번호를 입력하세요.", "#set-pw-old");
  if (newPassword.length < 8) return setPwError("새 비밀번호는 8자 이상이어야 합니다.", "#set-pw-new");
  if (newPassword === oldPassword) return setPwError("새 비밀번호는 지금과 달라야 합니다.", "#set-pw-new");
  if ($("#set-pw-confirm").value !== newPassword) return setPwError("새 비밀번호와 같지 않습니다.", "#set-pw-confirm");
  const button = $("#set-pw-submit");
  const session = state.sessionGen;
  button.disabled = true;
  button.textContent = "바꾸는 중…";
  try {
    await api("POST", "/api/session/password", { oldPassword, newPassword });
    if (session !== state.sessionGen) return;
    resetSettingsPassword();
    showToast("비밀번호를 바꿨습니다.");
    $("#set-pw-open").focus();
  } catch (error) {
    if (error.status === 401 || session !== state.sessionGen) return;
    setPwError(error.message || "비밀번호를 바꾸지 못했습니다.", error.status === 400 || error.status === 403 ? "#set-pw-old" : "");
  } finally {
    button.disabled = false;
    button.textContent = "비밀번호 바꾸기";
  }
});

$("#rail-settings").addEventListener("click", (event) => openSettings(undefined, { returnFocus: event.currentTarget }));
$("#set-close").addEventListener("click", () => $("#settings").close());
$("#settings").addEventListener("close", () => {
  cancelHotkeyCapture();
  $("#set-snooze-custom").hidden = true;
  resetSettingsPassword();
  const back = settingsReturnFocus;
  settingsReturnFocus = null;
  if (back?.isConnected && !state.locked && !state.pwForced) back.focus();
});
// 바깥(배경)을 누르면 닫는다.
$("#settings").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});
$("#set-tabs").addEventListener("click", (event) => {
  const tab = event.target.closest?.("[role=tab]")?.dataset.tab;
  if (tab) selectSettingsTab(tab);
});
$("#set-tabs").addEventListener("keydown", (event) => {
  if (!event.target.closest?.("[role=tab]")) return;
  const tabs = settingsTabsShown();
  let index = tabs.indexOf(settingsTab);
  if (event.key === "ArrowDown" || event.key === "ArrowRight") index = (index + 1) % tabs.length;
  else if (event.key === "ArrowUp" || event.key === "ArrowLeft") index = (index - 1 + tabs.length) % tabs.length;
  else if (event.key === "Home") index = 0;
  else if (event.key === "End") index = tabs.length - 1;
  else return;
  event.preventDefault();
  selectSettingsTab(tabs[index], { focus: true });
});

function choosePreview(value, { focus = false } = {}) {
  if (!PREVIEW_MODES.includes(value) || $("#set-preview").classList.contains("locked")) return;
  if (value !== previewMode()) saveNotify({ preview: value }, "알림 미리 보기를 바꿨습니다.");
  if (focus) $(`#set-preview [data-pv="${value}"]`)?.focus();
}
$("#set-preview").addEventListener("click", (event) => {
  const card = event.target.closest?.(".rcard");
  if (card) choosePreview(card.dataset.pv);
});
$("#set-preview").addEventListener("keydown", (event) => {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
  if (!step) return;
  event.preventDefault();
  const index = PREVIEW_MODES.indexOf(previewMode());
  choosePreview(PREVIEW_MODES[(index + step + PREVIEW_MODES.length) % PREVIEW_MODES.length], { focus: true });
});
$("#set-sound").addEventListener("change", (event) => {
  const value = event.currentTarget.value;
  if (NOTIFY_SOUNDS.includes(value)) saveNotify({ sound: value }, "알림음을 바꿨습니다.");
});
$("#set-sound-test").addEventListener("click", () => {
  notify({ title: "상상톡", body: "알림 소리를 확인합니다.", sound: $("#set-sound").value, flash: false });
});
$("#set-flash").addEventListener("click", () => {
  const next = !state.prefs.notify.flash;
  saveNotify({ flash: next }, next ? "작업표시줄 깜박임을 켰습니다." : "작업표시줄 깜박임을 껐습니다.");
});
$("#set-reply").addEventListener("click", () => {
  const next = !state.prefs.notify.replyBypassMute;
  saveNotify({ replyBypassMute: next }, next ? "내 글에 단 답장은 알림을 끈 대화방에서도 받습니다." : "내 글에 단 답장도 대화방 알림 설정을 따릅니다.");
});
$("#set-dnd").addEventListener("click", () => {
  const next = !state.prefs.dnd.enabled;
  saveDnd({ enabled: next }, next ? "방해 금지를 켰습니다." : "방해 금지를 껐습니다.");
});
for (const [id, field] of [["#set-from", "from"], ["#set-to", "to"]]) {
  $(id).addEventListener("change", (event) => {
    const value = event.currentTarget.value;
    if (!/^\d\d:\d\d$/.test(value)) {
      event.currentTarget.value = state.prefs.dnd[field];
      return;
    }
    if (value !== state.prefs.dnd[field]) saveDnd({ [field]: value }, "방해 금지 시간을 바꿨습니다.");
  });
}
$("#set-weekends").addEventListener("change", (event) => {
  saveDnd({ weekends: event.currentTarget.checked }, "방해 금지 주말 설정을 바꿨습니다.");
});

/* ── N4 키워드 알림. API가 없으면(아직 목업 전) 이 묶음을 숨긴다. ── */

const KEYWORD_MAX = 20;
const keywordState = { list: [], available: false, busy: false, gen: 0, drawn: "" };

async function loadKeywords() {
  const gen = ++keywordState.gen;
  const session = state.sessionGen;
  try {
    const data = await api("GET", "/api/keywords");
    if (gen !== keywordState.gen || session !== state.sessionGen) return;
    keywordState.list = Array.isArray(data?.keywords) ? data.keywords.filter((item) => typeof item === "string") : [];
    keywordState.available = true;
  } catch (error) {
    if (gen !== keywordState.gen || session !== state.sessionGen) return;
    keywordState.available = false;
  }
  renderKeywords();
}

function renderKeywords() {
  const signature = keywordState.list.join("\u0000");
  if (signature !== keywordState.drawn) {
    keywordState.drawn = signature;
    if (isTalkView() && state.messages.length) renderLog();
  }
  $("#set-kw-group").hidden = !keywordState.available;
  if (!keywordState.available) return;
  const box = $("#set-kws");
  box.replaceChildren();
  for (const word of keywordState.list) {
    const chip = el("span", "kw", word);
    chip.setAttribute("role", "listitem");
    const remove = el("button", "");
    remove.type = "button";
    remove.setAttribute("aria-label", `${word} 빼기`);
    remove.append(iconUse("ico-x"));
    remove.disabled = keywordState.busy;
    remove.addEventListener("click", () => removeKeyword(word));
    chip.append(remove);
    box.append(chip);
  }
  const full = keywordState.list.length >= KEYWORD_MAX;
  $("#set-kw-count").textContent = `${keywordState.list.length}/${KEYWORD_MAX}`;
  $("#set-kw-input").disabled = full || keywordState.busy;
  $("#set-kw-add").disabled = full || keywordState.busy;
  $("#set-kw-input").placeholder = full ? "키워드는 20개까지 둘 수 있습니다" : "키워드 입력 (2~30자)";
}

function setKeywordError(text) {
  $("#set-kw-error").hidden = !text;
  $("#set-kw-error span").textContent = text;
}

async function changeKeywords(request, done) {
  const session = state.sessionGen;
  keywordState.busy = true;
  setKeywordError("");
  renderKeywords();
  try {
    const data = await request();
    if (session !== state.sessionGen) return false;
    if (Array.isArray(data?.keywords)) keywordState.list = data.keywords.filter((item) => typeof item === "string");
    else await loadKeywords();
    announce(done);
    return true;
  } catch (error) {
    if (error.status === 401 || session !== state.sessionGen) return false;
    setKeywordError(error.message || "키워드를 저장하지 못했습니다.");
    return false;
  } finally {
    keywordState.busy = false;
    renderKeywords();
  }
}

$("#set-kw-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#set-kw-input");
  const word = input.value.replace(/\s+/g, " ").trim();
  const length = Array.from(word).length;
  if (length < 2 || length > 30) {
    setKeywordError("키워드는 2~30자로 입력하세요.");
    input.focus();
    return;
  }
  if (keywordState.list.includes(word)) {
    input.value = "";
    setKeywordError("");
    return;
  }
  const ok = await changeKeywords(() => api("POST", "/api/keywords", { keyword: word }), `키워드 "${word}"를 추가했습니다.`);
  if (ok) {
    input.value = "";
    if (!input.disabled) input.focus();
  }
});

function removeKeyword(word) {
  changeKeywords(() => api("DELETE", `/api/keywords?keyword=${encodeURIComponent(word)}`), `키워드 "${word}"를 뺐습니다.`)
    .then(() => $("#set-kw-input").focus());
}

/* ── N3 잠시 알림 끄기 ── */

const SNOOZE_MAX_MS = 7 * 86400000;
let snoozeTimer = 0;
let snoozeEndTimer = 0;

function snoozeUntilMs() {
  const at = Date.parse(state.prefs?.notify?.snoozeUntil || "");
  return Number.isFinite(at) && at > Date.now() ? at : 0;
}

function snoozed() {
  return snoozeUntilMs() > 0;
}

/* 계약서 예시처럼 내 시간대의 오프셋을 붙인 ISO 문자열(예: 2026-11-18T18:00:00+09:00). */
function isoLocal(date) {
  const pad = (value) => String(value).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function snoozeLeftText(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  if (minutes < 60) return `${minutes}분`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours >= 24) return `${Math.floor(hours / 24)}일 ${hours % 24}시간`;
  return rest ? `${hours}시간 ${rest}분` : `${hours}시간`;
}

/* 종의 알약은 좁으므로 짧게: 58분, 2시간, 3일 */
function snoozePillText(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  if (minutes < 60) return `${minutes}분`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}시간`;
  return `${Math.floor(minutes / 1440)}일`;
}

function snoozeEndText(at) {
  const date = new Date(at);
  const sameDay = date.toDateString() === new Date().toDateString();
  const day = sameDay ? "" : `${date.getMonth() + 1}월 ${date.getDate()}일 (${weekdayOf(date)}) `;
  return `${day}${clockOf(date)}`;
}

function snoozeTargets(now = new Date()) {
  const today = new Date(now);
  today.setHours(23, 59, 0, 0);
  return {
    "1h": new Date(now.getTime() + 3600000),
    "3h": new Date(now.getTime() + 3 * 3600000),
    today: today.getTime() > now.getTime() + 60000 ? today : null,
  };
}

/* 레일의 종: 끈 동안 "꺼짐"과 남은 시간 알약. 안 본 개수 배지는 숨긴다(PM 확정). 시간이 지나면 표시를 지운다. */
function renderSnooze() {
  const at = snoozeUntilMs();
  const bell = $("#rail-bell");
  bell.classList.toggle("snoozed", Boolean(at));
  bell.querySelector("use").setAttribute("href", at ? "#ico-bell-off" : "#ico-bell");
  $("#bell-label").textContent = at ? "꺼짐" : "알림";
  const left = $("#bell-left");
  left.hidden = !at;
  left.textContent = at ? snoozePillText(at - Date.now()) : "";
  renderBellBadge();
  window.clearInterval(snoozeTimer);
  snoozeTimer = 0;
  window.clearTimeout(snoozeEndTimer);
  snoozeEndTimer = 0;
  if (at) {
    // 끝나는 순간에 지운다(30초 간격 갱신을 기다리지 않는다).
    snoozeEndTimer = window.setTimeout(() => {
      state.prefs = { ...state.prefs, notify: { ...state.prefs.notify, snoozeUntil: null } };
      renderSnooze();
      if ($("#settings").open && settingsTab === "notify") renderSnoozeChoices();
      if (!$("#snooze-menu").hidden) renderSnoozeMenu();
    }, Math.min(at - Date.now() + 200, 2 ** 31 - 1));
    snoozeTimer = window.setInterval(() => {
      if (!snoozed()) state.prefs = { ...state.prefs, notify: { ...state.prefs.notify, snoozeUntil: null } };
      renderSnooze();
      if ($("#settings").open && settingsTab === "notify") renderSnoozeChoices();
      if (!$("#snooze-menu").hidden) renderSnoozeMenu();
    }, 30000);
  }
}

function renderBellBadge() {
  const at = snoozeUntilMs();
  const unseen = activity.unseen;
  const bell = $("#rail-bell");
  const badge = $("#bell-badge");
  badge.hidden = Boolean(at) || !unseen;
  badge.textContent = unseen > 99 ? "99+" : String(unseen || "");
  let label = unseen ? `알림 ${unseen}개 안 봄` : "알림";
  if (at) label = `알림 꺼짐, ${snoozeEndText(at)}까지(${snoozeLeftText(at - Date.now())} 남음)${unseen ? `, 안 본 알림 ${unseen}개` : ""}`;
  bell.setAttribute("aria-label", label);
  bell.title = at ? `${snoozeEndText(at)}까지 알림 꺼짐 · 우클릭하면 다시 켜기` : "알림 · 우클릭하면 잠시 끄기";
}

function renderSnoozeChoices() {
  const at = snoozeUntilMs();
  $("#set-snz-on").hidden = !at;
  $("#set-snz-pick").hidden = Boolean(at);
  $("#set-snooze-state").textContent = at ? `${snoozeEndText(at)}까지 꺼짐 (${snoozeLeftText(at - Date.now())} 남음)` : "";
  if (at) $("#set-snooze-custom").hidden = true;
  const targets = snoozeTargets();
  $("#set-snz-1h").title = `${clockOf(targets["1h"])}까지`;
  $("#set-snz-3h").title = `${clockOf(targets["3h"])}까지`;
  $("#set-snz-today").disabled = !targets.today;
  $('#set-snooze [data-snooze="custom"]').setAttribute("aria-expanded", String(!$("#set-snooze-custom").hidden));
}

function snoozeTo(date) {
  const until = date ? isoLocal(date) : null;
  const text = date ? `${snoozeEndText(date.getTime())}까지 알림을 끕니다.` : "알림을 다시 켰습니다.";
  return saveNotify({ snoozeUntil: until }, text);
}

function openSnoozeCustom() {
  const box = $("#set-snooze-custom");
  box.hidden = false;
  const now = new Date();
  const input = $("#set-snooze-at");
  const local = (date) => isoLocal(date).slice(0, 16);
  input.min = local(new Date(now.getTime() + 60000));
  input.max = local(new Date(now.getTime() + SNOOZE_MAX_MS));
  input.value = local(new Date(now.getTime() + 2 * 3600000));
  renderSnoozeChoices();
  input.focus();
}

$("#set-snooze").addEventListener("click", (event) => {
  const kind = event.target.closest?.("[data-snooze]")?.dataset.snooze;
  if (!kind) return;
  if (kind === "custom") {
    if ($("#set-snooze-custom").hidden) openSnoozeCustom();
    else {
      $("#set-snooze-custom").hidden = true;
      renderSnoozeChoices();
    }
    return;
  }
  const target = snoozeTargets()[kind];
  if (target) snoozeTo(target);
});
$("#set-snooze-apply").addEventListener("click", async () => {
  const value = $("#set-snooze-at").value;
  const date = value ? new Date(value) : null;
  const now = Date.now();
  if (!date || Number.isNaN(date.getTime())) {
    setSaved("err", "다시 켤 시각을 고르세요.");
    return;
  }
  if (date.getTime() < now + 60000 || date.getTime() > now + SNOOZE_MAX_MS) {
    setSaved("err", "지금부터 7일 안의 시각을 고르세요.");
    return;
  }
  if (await snoozeTo(date)) {
    $("#set-snooze-custom").hidden = true;
    renderSnoozeChoices();
    $("#set-snooze-off").focus();
  }
});
$("#set-snooze-off").addEventListener("click", async () => {
  if (await snoozeTo(null)) $('#set-snooze [data-snooze="1h"]').focus();
});

/* 잠시 끄기 메뉴: 종 우클릭(또는 길게 누르기, 메뉴 키), 알림 센터의 끄기 단추 */
let snoozeMenuOpener = null;

function renderSnoozeMenu() {
  const at = snoozeUntilMs();
  const now = $("#snz-menu-now");
  now.hidden = !at;
  now.textContent = at ? `${snoozeEndText(at)}까지 꺼짐 (${snoozeLeftText(at - Date.now())} 남음)` : "";
  $("#snz-menu-off").hidden = !at;
  const targets = snoozeTargets();
  $("#snz-menu-1h").textContent = `${clockOf(targets["1h"])}까지`;
  $("#snz-menu-3h").textContent = `${clockOf(targets["3h"])}까지`;
  $('#snooze-menu [data-snooze="today"]').disabled = !targets.today;
}

function openSnoozeMenu(opener) {
  if (!state.me || state.locked || state.pwForced) return;
  const menu = $("#snooze-menu");
  snoozeMenuOpener = opener;
  renderSnoozeMenu();
  menu.hidden = false;
  opener.setAttribute("aria-expanded", "true");
  // 종이면 오른쪽에 아래 끝을 맞추고, 알림 센터의 단추면 그 아래에 둔다.
  const rect = opener.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  let left = opener.id === "rail-bell" ? rect.right + 8 : rect.right - width;
  let top = opener.id === "rail-bell" ? rect.bottom - height : rect.bottom + 6;
  left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
  top = Math.max(8, Math.min(top, window.innerHeight - height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.querySelector("button:not([hidden]):not(:disabled)")?.focus();
}

function closeSnoozeMenu({ focus = false } = {}) {
  const menu = $("#snooze-menu");
  if (menu.hidden) return;
  menu.hidden = true;
  const opener = snoozeMenuOpener;
  snoozeMenuOpener = null;
  if (opener?.id === "center-snooze") opener.setAttribute("aria-expanded", "false");
  if (opener?.id === "rail-bell") opener.setAttribute("aria-expanded", String(!$("#center").hidden));
  if (focus && opener?.isConnected) opener.focus();
}

$("#snooze-menu").addEventListener("click", (event) => {
  const button = event.target.closest?.("button");
  if (!button || button.disabled) return;
  const opener = snoozeMenuOpener;
  closeSnoozeMenu();
  if (button.id === "snz-menu-off") {
    snoozeTo(null);
    opener?.focus();
    return;
  }
  const kind = button.dataset.snooze;
  if (kind === "custom") {
    openSettings("notify", { returnFocus: opener });
    if (!snoozed()) openSnoozeCustom();
    return;
  }
  const target = snoozeTargets()[kind];
  if (target) snoozeTo(target);
  opener?.focus();
});
$("#snooze-menu").addEventListener("keydown", (event) => {
  const items = [...$("#snooze-menu").querySelectorAll("button:not([hidden]):not(:disabled)")];
  const index = items.indexOf(document.activeElement);
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeSnoozeMenu({ focus: true });
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(index + step + items.length) % items.length]?.focus();
  } else if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    items[event.key === "Home" ? 0 : items.length - 1]?.focus();
  } else if (event.key === "Tab") {
    closeSnoozeMenu();
  }
});
document.addEventListener("click", (event) => {
  if ($("#snooze-menu").hidden || !event.target.isConnected) return;
  if (event.target.closest?.("#snooze-menu, #center-snooze")) return;
  closeSnoozeMenu();
});

const bell = $("#rail-bell");
let bellPressTimer = 0;
let bellLongPressed = false;
bell.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  openSnoozeMenu(bell);
});
// 터치: 길게 누르면 잠시 끄기 메뉴
bell.addEventListener("pointerdown", (event) => {
  if (event.pointerType !== "touch") return;
  bellLongPressed = false;
  window.clearTimeout(bellPressTimer);
  bellPressTimer = window.setTimeout(() => {
    bellLongPressed = true;
    openSnoozeMenu(bell);
  }, 550);
});
for (const type of ["pointerup", "pointercancel", "pointerleave"]) {
  bell.addEventListener(type, () => window.clearTimeout(bellPressTimer));
}
bell.addEventListener("click", (event) => {
  if (bellLongPressed) {
    bellLongPressed = false;
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  toggleCenter();
});
$("#center-snooze").addEventListener("click", (event) => {
  event.stopPropagation();
  if ($("#snooze-menu").hidden) openSnoozeMenu(event.currentTarget);
  else closeSnoozeMenu({ focus: true });
});

/* ── N6 알림 센터 ── */

const ACTIVITY_TABS = { all: null, mention: ["mention"], reply: ["reply", "reaction"], notice: ["notice"] };
const activity = { items: [], hasOlder: false, olderByKind: {}, unseen: 0, byKind: null, loading: false, error: "", tab: "all", gen: 0, loaded: false };
const ACTIVITY_KINDS = ["mention", "reply", "reaction", "notice", "keyword"];

function activityTime(item) {
  if (typeof item?.at === "number") return item.at > 1e12 ? item.at / 1000 : item.at;
  const ms = Date.parse(item?.at || "");
  return Number.isFinite(ms) ? ms / 1000 : 0;
}

function setActivityUnseen(count, byKind) {
  activity.unseen = Math.max(0, Math.floor(Number(count) || 0));
  if (byKind && typeof byKind === "object") {
    activity.byKind = Object.fromEntries(ACTIVITY_KINDS.map((kind) => [kind, Math.max(0, Math.floor(Number(byKind[kind]) || 0))]));
  }
  renderBellBadge();
  if (!$("#center").hidden) renderCenterHead();
}

/* 로그인 직후 배지만 맞춘다(서랍을 열면 다시 읽는다). API가 없으면 조용히 넘어간다. */
async function loadActivityCount() {
  const session = state.sessionGen;
  try {
    const data = await api("GET", "/api/activity?kind=all");
    if (session !== state.sessionGen) return;
    setActivityUnseen(data?.unseen, data?.unseenByKind);
  } catch {
    // 3-B 서버 전에는 배지가 없다.
  }
}

async function loadActivity({ older = false } = {}) {
  const gen = ++activity.gen;
  const session = state.sessionGen;
  activity.loading = true;
  activity.error = "";
  renderCenter();
  try {
    const tab = activity.tab;
    const kinds = ACTIVITY_TABS[tab] || ["all"];
    // 더 받기: 종류마다 그 종류의 마지막 항목 다음부터(그 종류에 더 받을 것이 있을 때만)
    const requests = kinds
      .filter((kind) => !older || activity.olderByKind[kind])
      .map((kind) => {
        const query = new URLSearchParams({ kind });
        if (older) {
          const last = [...activity.items].reverse().find((item) => kind === "all" || item.kind === kind);
          if (last?.id !== undefined) query.set("before", String(last.id));
        }
        return api("GET", `/api/activity?${query}`).then((data) => ({ kind, data }));
      });
    const results = await Promise.all(requests);
    if (gen !== activity.gen || session !== state.sessionGen || tab !== activity.tab) return;
    const olderByKind = older ? { ...activity.olderByKind } : {};
    let merged = older ? [...activity.items] : [];
    let last = null;
    for (const { kind, data } of results) {
      const items = Array.isArray(data?.items) ? data.items.filter((item) => item && item.id !== undefined) : [];
      merged = [...merged, ...items.filter((item) => !merged.some((have) => have.id === item.id))];
      olderByKind[kind] = Boolean(data?.hasOlder);
      last = data;
    }
    // 두 종류를 합쳤으면 시각순(최신 먼저)으로 다시 세운다.
    if (kinds.length > 1) merged.sort((a, b) => activityTime(b) - activityTime(a));
    activity.items = merged;
    activity.olderByKind = olderByKind;
    activity.loadedOlder = older;
    if (!older) activity.fresh = false;
    activity.hasOlder = Object.values(olderByKind).some(Boolean);
    activity.loaded = true;
    if (last) setActivityUnseen(last.unseen, last.unseenByKind);
  } catch (error) {
    if (gen !== activity.gen || session !== state.sessionGen || error.status === 401) return;
    activity.error = error.message || "알림을 불러오지 못했습니다.";
  } finally {
    if (gen === activity.gen) {
      activity.loading = false;
      renderCenter();
    }
  }
}

function toggleCenter() {
  if ($("#center").hidden) openCenter();
  else closeCenter({ focus: true });
}

function openCenter() {
  if (!state.me || state.locked || state.pwForced) return;
  closeSnoozeMenu();
  closeStatusPop();
  $("#center").hidden = false;
  $("#rail-bell").setAttribute("aria-expanded", "true");
  activity.tab = "all";
  activity.items = [];
  activity.loaded = false;
  activity.olderByKind = {};
  renderCenter();
  loadActivity();
  $(`#ctab-${activity.tab}`).focus();
}

function closeCenter({ focus = false } = {}) {
  const drawer = $("#center");
  if (drawer.hidden) return;
  drawer.hidden = true;
  closeSnoozeMenu();
  activity.gen += 1;
  activity.loading = false;
  $("#rail-bell").setAttribute("aria-expanded", "false");
  if (focus) $("#rail-bell").focus();
}

function activityInTab(item, tab) {
  const kinds = ACTIVITY_TABS[tab];
  return !kinds || kinds.includes(item.kind);
}

function renderCenterHead() {
  const count = $("#center-count");
  count.hidden = !activity.unseen;
  count.textContent = activity.unseen > 99 ? "99+" : String(activity.unseen || "");
  $("#center-seen").disabled = !activity.unseen && !activity.items.some((item) => !item.seen);
  for (const tab of Object.keys(ACTIVITY_TABS)) {
    const button = $(`#ctab-${tab}`);
    const current = tab === activity.tab;
    button.setAttribute("aria-selected", String(current));
    button.tabIndex = current ? 0 : -1;
    // 탭 숫자: 서버의 종류별 안 본 수(서랍 안에서는 잠시 끄기와 관계없이 보인다). 전체는 키워드를 포함한 합계.
    const kinds = ACTIVITY_TABS[tab];
    const unseen = activity.byKind
      ? kinds ? kinds.reduce((sum, kind) => sum + (activity.byKind[kind] || 0), 0) : activity.unseen
      : activity.items.filter((item) => !item.seen && activityInTab(item, tab)).length;
    button.querySelector(".n").textContent = unseen ? String(unseen) : "";
  }
  $("#center-body").setAttribute("aria-labelledby", `ctab-${activity.tab}`);
  const at = snoozeUntilMs();
  $("#center-snooze").setAttribute("aria-label", at ? `알림 잠시 끄기 (${snoozeEndText(at)}까지 꺼짐)` : "알림 잠시 끄기");
}

function activityRoomName(item) {
  if (item.view === "dm") return personById(item.userId)?.fullName || item.actorName || "1:1 대화";
  if (item.view === "group") return groupById(item.groupId)?.name || "그룹";
  return GENERAL_NAME;
}

function activityDayLabel(unix) {
  if (!unix) return "";
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (dayKey(unix) === dayKey(today.getTime() / 1000)) return "오늘";
  if (dayKey(unix) === dayKey(yesterday.getTime() / 1000)) return "어제";
  return new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", weekday: "short" }).format(new Date(unix * 1000));
}

const KIND_LINES = {
  mention: "님이 나를 멘션했습니다",
  reply: "님이 내 글에 답장했습니다",
  reaction: "님이 내 글에 반응을 남겼습니다",
  notice: "님이 공지를 등록했습니다",
};

function activityItem(item) {
  const button = el("button", item.seen ? "nitem" : "nitem unseen");
  button.type = "button";
  const kind = item.kind;
  const actor = personById(item.actorId);
  const face = item.view === "group" && kind === "notice"
    ? (groupById(item.groupId)?.dept ? deptAvatar() : groupAvatar(false))
    : avatar(actor || { fullName: item.actorName });
  const mark = el("span", `kind ${kind}`);
  mark.setAttribute("aria-hidden", "true");
  if (kind === "mention") mark.textContent = "@";
  else if (kind === "keyword") mark.textContent = "#";
  else if (kind === "reaction") mark.textContent = REACTIONS.find((def) => def.key === item.emoji)?.emoji || "👍";
  else mark.append(iconUse(kind === "reply" ? "ico-reply" : "ico-notice"));
  face.append(mark);
  const text = el("span", "");
  const line = el("span", "nl");
  const name = item.actorName || actor?.fullName || "알 수 없는 직원";
  if (kind === "keyword") {
    line.append("키워드가 들어간 메시지");
    if (item.keyword) {
      line.replaceChildren("키워드 ", el("b", "", item.keyword), "이 들어간 메시지");
    }
  } else {
    line.append(el("b", "", name), ` ${KIND_LINES[kind] || "님의 새 알림"}`);
  }
  if (kind === "notice" && item.ackRequired) line.append(el("span", "ack-tag", "확인 요청"));
  // 공지가 바뀌거나 내려가도 항목은 남는다(current:false). 누르면 원문으로 가는 것은 같다.
  if (kind === "notice" && item.current === false) line.append(el("span", "past-tag", "지난 공지"));
  const unix = activityTime(item);
  const meta = el("span", "nmeta");
  // 키워드는 보낸 사람도 함께 보인다(1:1이면 대화방 이름이 곧 그 사람이라 한 번만).
  const where = kind === "keyword" && item.view !== "dm" ? `${name} · ${activityRoomName(item)}` : activityRoomName(item);
  meta.append(el("span", "", where), "·");
  const time = el("time", "", unix ? formatTime(unix) : "");
  if (unix) time.dateTime = new Date(unix * 1000).toISOString();
  meta.append(time);
  const gone = item.excerpt === RECALLED_TEXT;
  const excerpt = el("span", `nex ${kind === "reaction" ? "reply" : kind}${gone ? " gone" : ""}`, item.excerpt || "");
  text.append(line, meta);
  if (item.excerpt) text.append(excerpt);
  button.append(face, text);
  button.setAttribute("aria-label", [item.seen ? "" : "안 봄", line.textContent, activityRoomName(item), time.textContent, item.excerpt || ""].filter(Boolean).join(", "));
  button.addEventListener("click", () => openActivity(item));
  return button;
}

function renderCenter() {
  if ($("#center").hidden) return;
  renderCenterHead();
  const body = $("#center-body");
  body.setAttribute("aria-busy", String(activity.loading));
  body.replaceChildren();
  const items = activity.items.filter((item) => activityInTab(item, activity.tab));
  if (activity.fresh) {
    const fresh = el("button", "nfresh", "새 알림이 있습니다 · 다시 읽기");
    fresh.type = "button";
    fresh.addEventListener("click", () => {
      $("#center-body").scrollTop = 0;
      loadActivity();
    });
    body.append(fresh);
  }
  if (activity.error && !items.length) {
    const box = el("div", "empty");
    const img = document.createElement("img");
    img.src = TURTLE;
    img.alt = "";
    const retry = el("button", "txt-btn", "다시 시도");
    retry.type = "button";
    retry.addEventListener("click", () => loadActivity());
    box.append(img, el("b", "", "알림을 불러오지 못했습니다"), el("span", "", activity.error), retry);
    body.append(box);
    return;
  }
  if (!items.length) {
    if (activity.loading || !activity.loaded) {
      body.append(el("p", "nfoot", "불러오는 중…"));
      return;
    }
    const box = el("div", "empty");
    const img = document.createElement("img");
    img.src = TURTLE;
    img.alt = "";
    box.append(img, el("b", "", "새 알림이 없습니다"), el("span", "", "멘션, 내 글에 단 답장·반응, 공지가 여기에 모입니다."));
    body.append(box);
    if (activity.hasOlder) body.append(moreActivityButton());
    return;
  }
  let day = "";
  for (const item of items) {
    const label = activityDayLabel(activityTime(item));
    if (label && label !== day) {
      day = label;
      body.append(el("div", "ngrp", label));
    }
    body.append(activityItem(item));
  }
  if (activity.hasOlder) body.append(moreActivityButton());
  if (activity.error) body.append(el("p", "nfoot err", activity.error));
  body.append(el("p", "nfoot", "최근 30일 알림을 보여 줍니다."));
}

function moreActivityButton() {
  const button = el("button", "more", activity.loading ? "불러오는 중…" : "이전 알림 더 보기");
  button.type = "button";
  button.disabled = activity.loading;
  button.addEventListener("click", () => loadActivity({ older: true }));
  return button;
}

async function openActivity(item) {
  // 누른 항목만 본 것으로 표시한다(서버에는 ids로 알린다. 실패해도 이동은 한다).
  if (!item.seen) {
    item.seen = true;
    renderCenter();
    const session = state.sessionGen;
    api("POST", "/api/activity/seen", { ids: [String(item.id)] })
      .then((data) => {
        if (session === state.sessionGen) setActivityUnseen(data?.unseen, data?.unseenByKind);
      })
      .catch(() => {
        // 다음에 서랍을 열면 서버 값으로 다시 맞춘다.
      });
  }
  closeCenter();
  const message = { id: item.messageId, kind: item.view === "dm" ? "dm" : item.view === "group" ? "group" : "channel", peerId: item.userId, groupId: item.groupId };
  if (item.view === "dm" && !personById(item.userId)) {
    state.noteStatus = "그 대화방을 찾지 못했습니다.";
    renderList();
    return;
  }
  await openMessage(message, []);
}

async function markActivitySeen() {
  const session = state.sessionGen;
  const button = $("#center-seen");
  button.disabled = true;
  try {
    const data = await api("POST", "/api/activity/seen", { upTo: "all" });
    if (session !== state.sessionGen) return;
    for (const item of activity.items) item.seen = true;
    setActivityUnseen(data?.unseen ?? 0, data?.unseenByKind);
    announce("알림을 모두 확인했습니다.");
  } catch (error) {
    if (error.status === 401 || session !== state.sessionGen) return;
    activity.error = error.message || "확인 표시를 하지 못했습니다.";
  }
  renderCenter();
}

$("#center-seen").addEventListener("click", markActivitySeen);
$("#center-close").addEventListener("click", () => closeCenter({ focus: true }));
$("#center-tabs").addEventListener("click", (event) => {
  const tab = event.target.closest?.("[role=tab]")?.dataset.tab;
  if (!tab || tab === activity.tab) return;
  switchActivityTab(tab);
});

function switchActivityTab(tab) {
  activity.tab = tab;
  activity.items = [];
  activity.loaded = false;
  activity.hasOlder = false;
  activity.olderByKind = {};
  activity.fresh = false;
  renderCenter();
  loadActivity();
}
$("#center-tabs").addEventListener("keydown", (event) => {
  const tabs = Object.keys(ACTIVITY_TABS);
  let index = tabs.indexOf(activity.tab);
  if (event.key === "ArrowRight") index = (index + 1) % tabs.length;
  else if (event.key === "ArrowLeft") index = (index - 1 + tabs.length) % tabs.length;
  else if (event.key === "Home") index = 0;
  else if (event.key === "End") index = tabs.length - 1;
  else return;
  event.preventDefault();
  switchActivityTab(tabs[index]);
  $(`#ctab-${activity.tab}`).focus();
});
$("#center").addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !$("#snooze-menu").hidden) return;
  event.stopPropagation();
  closeCenter({ focus: true });
});
// 서랍 밖을 누르면 닫는다(종·잠시 끄기 메뉴·대화상자는 빼고).
document.addEventListener("click", (event) => {
  if ($("#center").hidden || !event.target.isConnected) return;
  if (event.target.closest?.("#center, #rail-bell, #snooze-menu, dialog")) return;
  closeCenter();
});

/* 방해 금지 시간인가(주말 종일 포함). 시작 > 끝이면 자정을 넘긴다. */
function dndActive(now = new Date()) {
  const dnd = state.prefs?.dnd;
  if (!dnd?.enabled) return false;
  const day = now.getDay();
  if (dnd.weekends && (day === 0 || day === 6)) return true;
  const toMin = (text) => {
    const [h, m] = text.split(":").map(Number);
    return h * 60 + m;
  };
  const minutes = now.getHours() * 60 + now.getMinutes();
  const from = toMin(dnd.from);
  const to = toMin(dnd.to);
  if (from === to) return false;
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

function messageKey(message) {
  const kind = message?.kind || "channel";
  if (kind === "dm") return `dm:${message.peerId}`;
  if (kind === "group") return `group:${message.groupId}`;
  return "general";
}

/* ── B1 반응 ── */

function reactionChips(message) {
  const list = (Array.isArray(message.reactions) ? message.reactions : [])
    .filter((reaction) => REACTIONS.some((def) => def.key === reaction.emoji))
    .filter((reaction) => (reaction.count ?? reaction.userIds?.length ?? 0) > 0);
  if (message.recalled || !list.length) return null;
  const wrap = el("div", "reacts");
  for (const reaction of list) {
    const def = REACTIONS.find((item) => item.key === reaction.emoji);
    const ids = Array.isArray(reaction.userIds) ? reaction.userIds : [];
    const count = reaction.count ?? ids.length;
    const mine = reaction.mine ?? ids.includes(state.me?.userId);
    const chip = el("button", "rc");
    chip.type = "button";
    chip.setAttribute("aria-pressed", String(mine));
    chip.setAttribute("aria-label", `${def.label} ${count}명${mine ? ", 나 포함" : ""}`);
    const emoji = el("span", "e", def.emoji);
    emoji.setAttribute("aria-hidden", "true");
    chip.append(emoji, String(count));
    const names = ids.map((id) => (id === state.me?.userId ? "나" : nameOf(id)));
    if (names.length) {
      const tip = el("span", "tip", names.slice(0, 10).join(", ") + (names.length > 10 ? ` 외 ${names.length - 10}명` : ""));
      tip.setAttribute("aria-hidden", "true");
      chip.append(tip);
    }
    chip.addEventListener("click", () => toggleReaction(message.id, def.key, mine));
    wrap.append(chip);
  }
  const add = el("button", "rc add");
  add.type = "button";
  add.setAttribute("aria-label", "반응 남기기");
  add.title = "반응 남기기";
  add.append(iconUse("ico-smile-add"));
  add.addEventListener("click", (event) => {
    event.stopPropagation();
    openPicker(message.id);
  });
  wrap.append(add);
  return wrap;
}

async function toggleReaction(id, emoji, mine) {
  const key = liveKey();
  try {
    const data = mine
      ? await api("DELETE", `/api/messages/${id}/reactions?emoji=${encodeURIComponent(emoji)}`)
      : await api("POST", `/api/messages/${id}/reactions`, { emoji });
    if (key !== liveKey()) return;
    if (data.message) applyUpdated([data.message]);
  } catch (error) {
    if (error.status === 401 || key !== liveKey()) return;
    state.sendErrors[convKey()] = error.message || "반응을 남기지 못했습니다.";
    updateComposer();
  }
}

let picker = null; // { id, node }

function closePicker({ focus = false } = {}) {
  if (!picker) return;
  const { id, node } = picker;
  picker = null;
  node.remove();
  const row = $("#log")?.querySelector(`.msg[data-id="${id}"]`);
  if (!msgMenu || msgMenu.id !== id) row?.classList.remove("focus");
  if (focus) row?.querySelector(".acts-bar .react")?.focus();
}

function openPicker(id) {
  if (picker?.id === id) {
    closePicker({ focus: true });
    return;
  }
  closeMsgMenu();
  closeReaders();
  closePicker();
  const message = state.messages.find((item) => item.id === id);
  if (!message || message.recalled) return;
  const node = el("div", "picker");
  node.setAttribute("role", "toolbar");
  node.setAttribute("aria-label", "반응 고르기");
  for (const def of REACTIONS) {
    const reaction = (message.reactions || []).find((item) => item.emoji === def.key);
    const mine = Boolean(reaction && (reaction.mine ?? reaction.userIds?.includes(state.me?.userId)));
    const button = el("button", "", def.emoji);
    button.type = "button";
    button.setAttribute("aria-label", def.label);
    button.setAttribute("aria-pressed", String(mine));
    button.title = def.label;
    button.addEventListener("click", () => {
      closePicker({ focus: true });
      toggleReaction(id, def.key, mine);
    });
    node.append(button);
  }
  node.addEventListener("keydown", (event) => {
    const items = [...node.querySelectorAll("button")];
    const index = items.indexOf(document.activeElement);
    if (event.key === "Escape") {
      event.stopPropagation();
      closePicker({ focus: true });
    } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const step = event.key === "ArrowRight" ? 1 : -1;
      items[(index + step + items.length) % items.length]?.focus();
    } else if (event.key === "Tab") {
      closePicker();
    }
  });
  picker = { id, node };
  placePicker(true);
  node.querySelector("button")?.focus();
}

function placePicker(fit = false) {
  if (!picker) return;
  const row = $("#log").querySelector(`.msg[data-id="${picker.id}"]`);
  const anchor = row?.querySelector(".acts-bar")?.parentElement;
  if (!anchor) {
    closePicker();
    return;
  }
  anchor.append(picker.node);
  row.classList.add("focus");
  if (fit) fitPopover(picker.node);
}

/* ── B4 별표 ── */

async function toggleStar(id) {
  const message = state.messages.find((item) => item.id === id) || state.starred.messages.find((item) => item.id === id);
  if (!message) return;
  const on = Boolean(message.starred);
  const session = state.sessionGen;
  try {
    const data = await api(on ? "DELETE" : "POST", `/api/messages/${id}/star`);
    if (session !== state.sessionGen) return;
    if (data.message) applyUpdated([data.message]);
    announce(on ? "별표를 뺐습니다." : "나중에 보기에 넣었습니다.");
    if (state.starredOpen) loadStarred();
  } catch (error) {
    if (error.status === 401 || session !== state.sessionGen) return;
    state.sendErrors[convKey()] = error.message || "별표를 바꾸지 못했습니다.";
    updateComposer();
  }
}

function renderStarredChrome() {
  const open = Boolean(state.starredOpen && state.me);
  document.body.classList.toggle("starred-mode", open);
  $("#starred-head").hidden = !open;
  $("#starred-list").hidden = !open;
  const rail = $("#rail-star");
  if (open) rail.setAttribute("aria-current", "page");
  else rail.removeAttribute("aria-current");
  if (open) {
    for (const id of ["#rail-talk", "#rail-people", "#rail-notes"]) $(id).removeAttribute("aria-current");
  }
}

async function openStarred() {
  if (!state.me) return;
  // 좁은 창에서는 목록이 가려져 있으므로 목록 화면으로 돌아간다.
  if (window.matchMedia("(max-width: 900px)").matches && document.body.classList.contains("show-thread")) await setView("talk");
  state.starredOpen = true;
  renderStarredChrome();
  $("#starred-back").focus();
  loadStarred();
}

function closeStarred() {
  if (!state.starredOpen) return;
  state.starredOpen = false;
  renderStarredChrome();
  updateChrome();
}

async function loadStarred({ more = false } = {}) {
  const starred = state.starred;
  if (more && (starred.loading || !starred.hasOlder || !starred.messages.length)) return;
  const session = state.sessionGen;
  const gen = ++starred.gen;
  starred.loading = true;
  starred.error = "";
  renderStarred();
  try {
    const params = new URLSearchParams();
    if (more) params.set("before", String(starred.messages[starred.messages.length - 1].id));
    const data = await api("GET", `/api/starred${params.size ? `?${params}` : ""}`);
    if (session !== state.sessionGen || gen !== starred.gen) return;
    const found = (Array.isArray(data.messages) ? data.messages : []).filter((message) => message && message.id);
    starred.messages = more ? [...starred.messages, ...found.filter((message) => !starred.messages.some((known) => known.id === message.id))] : found;
    starred.hasOlder = Boolean(data.hasOlder);
  } catch (error) {
    if (error.status === 401 || session !== state.sessionGen || gen !== starred.gen) return;
    starred.error = error.message || "별표 메시지를 가져오지 못했습니다.";
  }
  starred.loading = false;
  renderStarred();
}

function renderStarred() {
  const box = $("#starred-list");
  if (!box) return;
  const starred = state.starred;
  box.replaceChildren();
  $("#starred-count").textContent = starred.messages.length ? `${starred.messages.length}${starred.hasOlder ? "개 이상" : "개"}` : "";
  if (starred.loading && !starred.messages.length) {
    box.append(loadingState("별표 메시지를 불러오는 중…"));
    return;
  }
  if (starred.error && !starred.messages.length) {
    box.append(errorState(starred.error, () => loadStarred()));
    return;
  }
  if (!starred.messages.length) {
    const empty = el("div", "empty");
    const img = document.createElement("img");
    img.src = "/assets/turtle-side.png";
    img.alt = "";
    empty.append(img, el("b", "", "별표한 메시지가 없어요"), el("span", "", "말풍선 메뉴의 ‘나중에 보기’로 모아 둘 수 있습니다."));
    box.append(empty);
    return;
  }
  for (const message of starred.messages) {
    const row = el("div", "starrow");
    const hit = searchHit(message, []);
    const unstar = el("button", "icon-btn unstar");
    unstar.type = "button";
    unstar.setAttribute("aria-label", "별표 빼기");
    unstar.title = "별표 빼기";
    unstar.append(iconUse("ico-star"));
    unstar.addEventListener("click", () => toggleStar(message.id));
    row.append(hit, unstar);
    box.append(row);
  }
  if (starred.hasOlder) {
    const more = el("button", "more", starred.loading ? "불러오는 중…" : "이전 별표 더 보기");
    more.type = "button";
    more.disabled = starred.loading;
    more.addEventListener("click", () => loadStarred({ more: true }));
    box.append(more);
  }
}

$("#rail-star").addEventListener("click", () => {
  if (state.starredOpen) closeStarred();
  else openStarred();
});
$("#starred-back").addEventListener("click", () => {
  closeStarred();
  $("#rail-talk").focus();
});

/* ── B6 입력 중 ── */

const typingState = new Map(); // 대화 키 -> Map(senderId -> 끝나는 시각)
let typingTimer = 0;

function typingKeyOf(entry) {
  if (entry.view === "dm") return `dm:${entry.senderId}`;
  if (entry.view === "group") return `group:${entry.groupId}`;
  return "general";
}

function applyTyping(entries) {
  const now = Date.now();
  for (const entry of entries) {
    if (!entry || !entry.senderId || entry.senderId === state.me?.userId) continue;
    const key = typingKeyOf(entry);
    if (!typingState.has(key)) typingState.set(key, new Map());
    if (entry.op === "stop") typingState.get(key).delete(entry.senderId);
    else typingState.get(key).set(entry.senderId, now + TYPING_TTL_MS);
  }
  renderTyping();
}

function clearTypingFor(messages) {
  let changed = false;
  for (const message of messages) {
    const senders = typingState.get(messageKey(message));
    if (senders?.delete(message.senderId)) changed = true;
  }
  if (changed) renderTyping();
}

function renderTyping() {
  window.clearTimeout(typingTimer);
  const line = $("#typing");
  if (!line) return;
  const talk = Boolean(state.me) && isTalkView();
  line.hidden = !talk;
  if (!talk) return;
  const now = Date.now();
  let next = Infinity;
  for (const senders of typingState.values()) {
    for (const [id, until] of senders) {
      if (until <= now) senders.delete(id);
      else next = Math.min(next, until);
    }
  }
  const names = [...(typingState.get(convKey())?.keys() || [])].map(nameOf);
  line.classList.toggle("idle", !names.length);
  $("#typing-text").textContent = !names.length ? ""
    : names.length === 1 ? `${names[0]} 님이 입력 중…`
      : names.length === 2 ? `${names[0]}, ${names[1]} 님이 입력 중…` : "여러 명이 입력 중…";
  if (Number.isFinite(next)) typingTimer = window.setTimeout(renderTyping, next - now + 50);
}

let typingSent = null; // { key, target, at }
let typingIdleTimer = 0;

function postTyping(target, op) {
  api("POST", "/api/typing", { ...target, op }).catch(() => {});
}

function noteTyping() {
  const input = $("#composer-input");
  if (!state.me || !isTalkView() || state.compose?.mode === "edit") return;
  if (!input.value.trim()) {
    stopTyping();
    return;
  }
  const key = convKey();
  const now = Date.now();
  window.clearTimeout(typingIdleTimer);
  typingIdleTimer = window.setTimeout(stopTyping, 6000);
  if (typingSent && typingSent.key === key && now - typingSent.at < 10000) return;
  if (typingSent && typingSent.key !== key) stopTyping();
  const target = noticeTarget();
  typingSent = { key, target, at: now };
  postTyping(target, "start");
}

function stopTyping() {
  window.clearTimeout(typingIdleTimer);
  if (!typingSent) return;
  const { target } = typingSent;
  typingSent = null;
  if (state.me) postTyping(target, "stop");
}

$("#composer-input").addEventListener("input", noteTyping);

/* ── B7 예약 메시지 ── */

function schedKey(item) {
  if (item.view === "dm") return `dm:${item.userId}`;
  if (item.view === "group") return `group:${item.groupId}`;
  return "general";
}

function schedForConv() {
  return state.scheduled.filter((item) => schedKey(item) === convKey());
}

let scheduledTimer = 0;
async function loadScheduled() {
  const session = state.sessionGen;
  try {
    const data = await api("GET", "/api/scheduled");
    if (session !== state.sessionGen) return;
    state.scheduled = Array.isArray(data.scheduled) ? data.scheduled : [];
  } catch {
    // 예약 목록은 다음에 다시 읽는다.
  }
  renderSched();
}

function scheduleScheduledReload() {
  window.clearTimeout(scheduledTimer);
  scheduledTimer = window.setTimeout(loadScheduled, 600);
}

function weekdayOf(date) {
  return new Intl.DateTimeFormat("ko-KR", { weekday: "short" }).format(date);
}

function clockOf(date) {
  return new Intl.DateTimeFormat("ko-KR", { hour: "numeric", minute: "2-digit" }).format(date);
}

function formatSchedule(unix) {
  const date = new Date(unix * 1000);
  const now = new Date();
  const days = Math.round((new Date(date.getFullYear(), date.getMonth(), date.getDate()) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
  if (days === 0) return `오늘 ${clockOf(date)}`;
  if (days === 1) return `내일 ${clockOf(date)}`;
  return `${date.getMonth() + 1}월 ${date.getDate()}일 (${weekdayOf(date)}) ${clockOf(date)}`;
}

function schedText(item) {
  const text = (item.content || "").replace(/\s+/g, " ").trim();
  const files = Array.isArray(item.attachments) ? item.attachments : [];
  if (text) return files.length ? `${text} · 파일 ${files.length}개` : text;
  return files.length === 1 ? `파일: ${files[0].name}` : `파일 ${files.length}개`;
}

function renderSched() {
  const talk = Boolean(state.me) && isTalkView();
  const items = talk ? schedForConv() : [];
  $("#sched-bar").hidden = !talk || !items.length;
  $("#sched-bar-text").textContent = `이 대화방에 예약한 메시지 ${items.length}개`;
  const count = items.length ? String(items.length) : "";
  $("#room-sched-n").textContent = count;
  $("#send-list-n").textContent = count;
  // 마지막 예약을 취소하면 빈 목록은 닫는다.
  if (!items.length) state.schedOpen = false;
  const list = $("#sched-list");
  list.hidden = !talk || !state.schedOpen;
  $("#sched-bar-btn").setAttribute("aria-expanded", String(talk && state.schedOpen));
  $("#sched-bar-btn").textContent = state.schedOpen ? "접기" : "보기";
  list.replaceChildren();
  if (list.hidden) return;
  if (!items.length) {
    list.append(el("p", "none", "이 대화방에 예약한 메시지가 없습니다."));
    return;
  }
  for (const item of items.sort((a, b) => a.scheduledAt - b.scheduledAt)) {
    const row = el("div", "sl");
    const time = el("time", "", formatSchedule(item.scheduledAt));
    time.dateTime = new Date(item.scheduledAt * 1000).toISOString();
    const acts = el("span", "acts");
    if (!(item.attachments || []).length) {
      const edit = el("button", "txt-btn", "수정");
      edit.type = "button";
      edit.addEventListener("click", () => editScheduled(item));
      acts.append(edit);
    }
    const cancel = el("button", "txt-btn cancel", "예약 취소");
    cancel.type = "button";
    cancel.addEventListener("click", () => cancelScheduled(item));
    acts.append(cancel);
    row.append(time, el("p", "", schedText(item)), acts);
    list.append(row);
  }
}

function toggleSchedList(open = !state.schedOpen) {
  if (open && !schedForConv().length) {
    state.schedOpen = false;
    renderSched();
    state.sendErrors[convKey()] = "이 대화방에 예약한 메시지가 없습니다.";
    updateComposer();
    return false;
  }
  state.schedOpen = open;
  renderSched();
  return open;
}

document.addEventListener("click", (event) => {
  if (!state.schedOpen || !event.target.isConnected) return;
  if (event.target.closest?.("#sched-list, #sched-bar, #send-menu, #send-more, #group-menu, #group-menu-btn, dialog")) return;
  toggleSchedList(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !state.schedOpen || document.querySelector("dialog[open]")) return;
  if (!event.target.closest?.("#sched-list, #sched-bar")) return;
  toggleSchedList(false);
  $("#sched-bar-btn").focus();
});

async function cancelScheduled(item) {
  const ok = await askConfirm({ title: "예약을 취소할까요?", text: `${formatSchedule(item.scheduledAt)}에 보낼 메시지를 보내지 않습니다.`, confirm: "예약 취소", cancel: "그대로 두기", danger: true });
  if (!ok) return;
  try {
    await api("DELETE", `/api/scheduled/${item.id}`);
    announce("예약을 취소했습니다.");
  } catch (error) {
    if (error.status === 401) return;
    state.sendErrors[convKey()] = error.message || "예약을 취소하지 못했습니다.";
    updateComposer();
  }
  loadScheduled();
}

/* 수정: 글을 입력창에 옮기고 같은 시각으로 예약 창을 연다. 새 예약이 되면 예전 것을 지운다. */
async function editScheduled(item) {
  const input = $("#composer-input");
  if (input.value.trim() && input.value.trim() !== (item.content || "").trim()) {
    const ok = await askConfirm({ title: "입력 중인 글을 바꿀까요?", text: "입력창의 글 대신 예약 메시지 내용을 불러옵니다.", confirm: "불러오기", cancel: "취소" });
    if (!ok) return;
  }
  if (state.compose) cancelCompose();
  input.value = item.content || "";
  autosize(input);
  updateComposer();
  openSchedDialog({ at: item.scheduledAt, replace: item.id });
}

let schedReplace = null;
let schedPick = null; // 고른 빠른 선택 키

function schedRoomText() {
  if (state.view === "dm") return `${state.selectedUser?.fullName || "상대"}님에게`;
  if (state.view === "group") return `‘${state.selectedGroup?.name || "그룹"}’에`;
  return `${GENERAL_NAME}에`;
}

function quickOptions() {
  const now = new Date();
  const at = (days, hour) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour, 0, 0);
  const toMonday = ((8 - now.getDay()) % 7) || 7;
  const monday = at(toMonday, 9);
  return [
    { key: "today", title: "오늘 오후", sub: "4:00", date: at(0, 16) },
    { key: "tomorrow", title: "내일 아침", sub: `${at(1, 9).getMonth() + 1}월 ${at(1, 9).getDate()}일 9:00`, date: at(1, 9) },
    { key: "monday", title: "다음 주 월요일", sub: `${monday.getMonth() + 1}월 ${monday.getDate()}일 9:00`, date: monday },
  ];
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function setSchedInputs(date) {
  $("#sched-date").value = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  $("#sched-time").value = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function schedDate() {
  const day = $("#sched-date").value;
  const time = $("#sched-time").value;
  if (!day || !time) return null;
  const [y, m, d] = day.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const date = new Date(y, m - 1, d, hh, mm, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function renderSchedDialog() {
  const quick = $("#sched-quick");
  quick.replaceChildren();
  const now = Date.now();
  const chosen = schedDate();
  for (const option of quickOptions()) {
    const button = el("button", "qopt");
    button.type = "button";
    button.setAttribute("role", "radio");
    const checked = Boolean(chosen && chosen.getTime() === option.date.getTime());
    button.setAttribute("aria-checked", String(checked));
    button.disabled = option.date.getTime() < now + 60000;
    button.append(el("b", "", option.title), el("small", "", option.sub));
    button.addEventListener("click", () => {
      setSchedInputs(option.date);
      renderSchedDialog();
    });
    quick.append(button);
  }
  const submit = $("#sched-submit");
  const valid = chosen && chosen.getTime() >= now + 60000 && chosen.getTime() <= now + 365 * 86400000;
  submit.disabled = !valid;
  submit.textContent = chosen
    ? `${chosen.getMonth() + 1}월 ${chosen.getDate()}일 (${weekdayOf(chosen)}) ${clockOf(chosen)}에 보내기`
    : "보내기";
  $("#sched-error").textContent = chosen && !valid
    ? chosen.getTime() < now + 60000 ? "지난 시각이나 1분 안쪽은 고를 수 없습니다." : "1년 안으로 고르세요."
    : "";
}

function openSchedDialog({ at = null, replace = null } = {}) {
  closeMenu("#send-menu", "#send-more");
  const input = $("#composer-input");
  const content = input.value.trim();
  const files = composerUploader.ready();
  if (state.compose?.mode === "edit") {
    state.sendErrors[convKey()] = "수정을 마친 뒤에 예약할 수 있습니다.";
    updateComposer();
    return;
  }
  if (composerUploader.busy()) {
    state.sendErrors[convKey()] = "올리는 중인 파일이 끝나면 예약할 수 있어요.";
    updateComposer();
    return;
  }
  if (!content && !files.length) {
    state.sendErrors[convKey()] = "예약할 내용을 먼저 입력하세요.";
    updateComposer();
    input.focus();
    return;
  }
  delete state.sendErrors[convKey()];
  updateComposer();
  schedReplace = replace;
  $("#sched-sub").textContent = `정한 시간에 ${schedRoomText()} 보냅니다.`;
  const line = content.replace(/\s+/g, " ");
  $("#sched-preview").textContent = line ? (files.length ? `${line} · 파일 ${files.length}개` : line) : `파일 ${files.length}개`;
  const today = new Date();
  $("#sched-date").min = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;
  setSchedInputs(at ? new Date(at * 1000) : quickOptions()[1].date);
  $("#sched-error").textContent = "";
  renderSchedDialog();
  $("#sched-dialog").showModal();
  ($("#sched-quick [aria-checked=true]") || $("#sched-date")).focus();
}

$("#sched-date").addEventListener("input", renderSchedDialog);
$("#sched-time").addEventListener("input", renderSchedDialog);
$("#sched-close").addEventListener("click", () => $("#sched-dialog").close());
$("#sched-cancel").addEventListener("click", () => $("#sched-dialog").close());
$("#sched-dialog").addEventListener("close", () => {
  schedReplace = null;
  $("#composer-input")?.focus();
});
$("#sched-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const date = schedDate();
  const submit = $("#sched-submit");
  if (!date || submit.disabled) return;
  const key = convKey();
  const session = state.sessionGen;
  const input = $("#composer-input");
  const content = input.value.trim();
  const files = composerUploader.ready();
  const body = { ...noticeTarget(), content, attachments: files, scheduledAt: Math.floor(date.getTime() / 1000) };
  const mentions = mentionIdsIn(content);
  if (mentions.length) body.mentions = mentions;
  submit.disabled = true;
  submit.textContent = "예약하는 중…";
  try {
    await api("POST", "/api/scheduled", body);
    if (session !== state.sessionGen) return;
    if (schedReplace) await api("DELETE", `/api/scheduled/${schedReplace}`).catch(() => {});
    if (convKey() === key) {
      input.value = "";
      autosize(input);
      composerUploader.remove(files);
      stopTyping();
      updateComposer();
    }
    $("#sched-dialog").close();
    announce(`${formatSchedule(body.scheduledAt)}에 보내도록 예약했습니다.`);
    loadScheduled();
  } catch (error) {
    if (error.status === 401 || session !== state.sessionGen) return;
    $("#sched-error").textContent = error.message || "예약하지 못했습니다.";
    renderSchedDialog();
    $("#sched-error").textContent = error.message || "예약하지 못했습니다.";
  }
});

wireMenu("#send-menu", "#send-more");
$("#send-later").addEventListener("click", () => openSchedDialog());
$("#send-urgent").addEventListener("click", () => {
  closeMenu("#send-menu", "#send-more");
  if (urgentMode()) setUrgent(false);
  else if (canSendUrgent()) setUrgent(true);
});
$("#urgent-cancel").addEventListener("click", () => setUrgent(false));
$("#send-list").addEventListener("click", () => {
  closeMenu("#send-menu", "#send-more");
  if (toggleSchedList(true)) $("#sched-list").querySelector("button")?.focus();
  else $("#composer-input").focus();
});
$("#sched-bar-btn").addEventListener("click", () => toggleSchedList());

/* ── B8 파일 모아 보기 ── */

function resetDrawer() {
  state.drawer = { open: false, tab: "photos", files: [], hasOlder: false, loading: false, error: "", gen: (state.drawer?.gen || 0) + 1 };
}

function openDrawer() {
  if (!isTalkView()) return;
  closeGroupMenu();
  const gen = (state.drawer?.gen || 0) + 1;
  state.drawer = { open: true, tab: "photos", files: [], hasOlder: false, loading: false, error: "", gen };
  $("#files-drawer").hidden = false;
  $("#files-btn").setAttribute("aria-expanded", "true");
  renderDrawer();
  $("#files-close").focus();
  loadDrawer();
}

function closeDrawer({ focus = false } = {}) {
  const drawer = $("#files-drawer");
  if (!drawer || drawer.hidden) return;
  resetDrawer();
  drawer.hidden = true;
  $("#files-btn").setAttribute("aria-expanded", "false");
  if (focus) $("#files-btn").focus();
}

async function loadDrawer({ more = false } = {}) {
  const drawer = state.drawer;
  if (!drawer.open || drawer.loading || (more && (!drawer.hasOlder || !drawer.files.length))) return;
  const key = liveKey();
  const gen = drawer.gen;
  drawer.loading = true;
  drawer.error = "";
  renderDrawer();
  try {
    const params = viewParams();
    if (more) params.set("before", String(drawer.files[drawer.files.length - 1].messageId));
    const data = await api("GET", `/api/files/list?${params}`);
    if (key !== liveKey() || gen !== state.drawer.gen) return;
    const found = (Array.isArray(data.files) ? data.files : []).filter((file) => file && safeFileUrl(file.url));
    drawer.files = more ? [...drawer.files, ...found] : found;
    drawer.hasOlder = Boolean(data.hasOlder);
  } catch (error) {
    if (error.status === 401 || key !== liveKey() || gen !== state.drawer.gen) return;
    drawer.error = error.message || "파일 목록을 가져오지 못했습니다.";
  }
  drawer.loading = false;
  renderDrawer();
}

function monthLabel(unix) {
  const date = new Date(unix * 1000);
  return date.getFullYear() === new Date().getFullYear() ? `${date.getMonth() + 1}월` : `${date.getFullYear()}년 ${date.getMonth() + 1}월`;
}

function renderDrawer() {
  const drawer = state.drawer;
  const body = $("#files-body");
  if (!body || !drawer?.open) return;
  const photos = drawer.files.filter((file) => isImage(file.name, file.type));
  const docs = drawer.files.filter((file) => !isImage(file.name, file.type));
  const plus = drawer.hasOlder ? "+" : "";
  $("#ftab-photos-n").textContent = drawer.files.length || !drawer.loading ? `${photos.length}${plus}` : "";
  $("#ftab-docs-n").textContent = drawer.files.length || !drawer.loading ? `${docs.length}${plus}` : "";
  $("#ftab-photos").setAttribute("aria-selected", String(drawer.tab === "photos"));
  $("#ftab-docs").setAttribute("aria-selected", String(drawer.tab === "docs"));
  body.replaceChildren();
  const list = drawer.tab === "photos" ? photos : docs;
  if (drawer.loading && !drawer.files.length) {
    body.append(loadingState("파일을 불러오는 중…"));
    return;
  }
  if (drawer.error && !drawer.files.length) {
    body.append(errorState(drawer.error, () => loadDrawer()));
    return;
  }
  if (!list.length) {
    body.append(emptyState(drawer.tab === "photos" ? "주고받은 사진이 없습니다" : "주고받은 문서가 없습니다", drawer.hasOlder ? "이전 파일을 더 불러와 보세요." : ""));
  } else if (drawer.tab === "photos") {
    let month = "";
    let grid = null;
    photos.forEach((file, index) => {
      const label = monthLabel(file.timestamp);
      if (label !== month) {
        month = label;
        body.append(el("div", "month", label));
        grid = el("div", "ggrid");
        body.append(grid);
      }
      const button = el("button");
      button.type = "button";
      button.setAttribute("aria-label", `${file.name || "사진"} 크게 보기`);
      const img = document.createElement("img");
      img.src = inlineUrl(file.url);
      img.alt = "";
      img.loading = "lazy";
      button.append(img);
      button.addEventListener("click", () => {
        // 서랍은 최신순이지만, 크게 보기는 대화창과 같이 오래된 것부터 넘긴다.
        const ordered = photos.slice().reverse().map((item) => ({ file: item, message: { id: item.messageId, senderName: item.senderName, timestamp: item.timestamp } }));
        openViewer(ordered, photos.length - 1 - index);
      });
      grid.append(button);
    });
  } else {
    const stack = el("div", "files");
    for (const file of docs) {
      const card = fileCard(file);
      const small = card.querySelector(".fx small");
      const when = file.timestamp ? `${new Date(file.timestamp * 1000).getMonth() + 1}월 ${new Date(file.timestamp * 1000).getDate()}일` : "";
      if (small) small.textContent = [formatSize(file.size) || fileKind(file.name).label, file.senderName, when].filter(Boolean).join(" · ");
      stack.append(card);
    }
    body.append(stack);
  }
  if (drawer.hasOlder) {
    const more = el("button", "more", drawer.loading ? "불러오는 중…" : "이전 파일 더 보기");
    more.type = "button";
    more.disabled = drawer.loading;
    more.addEventListener("click", () => loadDrawer({ more: true }));
    body.append(more);
  }
  if (drawer.error && drawer.files.length) body.append(el("p", "alert", drawer.error));
}

$("#files-btn").addEventListener("click", () => {
  if ($("#files-drawer").hidden) openDrawer();
  else closeDrawer({ focus: true });
});
$("#files-close").addEventListener("click", () => closeDrawer({ focus: true }));
$("#files-drawer").addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.stopPropagation();
    closeDrawer({ focus: true });
  }
});
for (const [id, tab] of [["#ftab-photos", "photos"], ["#ftab-docs", "docs"]]) {
  $(id).addEventListener("click", () => {
    state.drawer.tab = tab;
    renderDrawer();
  });
}

/* ── B3 사진 크게 보기 ── */

const viewer = { items: [], index: 0 };

function openViewerFromMessage(message, file) {
  const pool = isTalkView() ? state.messages : [message];
  const items = [];
  for (const item of pool) {
    if (item.recalled) continue;
    for (const attachment of attachmentsOf(item)) {
      if (safeFileUrl(attachment.url) && isImage(attachment.name, attachment.type)) items.push({ file: attachment, message: item });
    }
  }
  const index = Math.max(0, items.findIndex((item) => item.message.id === message.id && item.file.url === file.url));
  openViewer(items.length ? items : [{ file, message }], items.length ? index : 0);
}

function openViewer(items, index) {
  viewer.items = items;
  viewer.index = index;
  renderViewer();
  const dialog = $("#viewer");
  if (!dialog.open) dialog.showModal();
  $("#viewer-close").focus();
}

function renderViewer() {
  const item = viewer.items[viewer.index];
  if (!item) return;
  const { file, message } = item;
  const url = safeFileUrl(file.url);
  const img = $("#viewer-img");
  if (url) shownImages.add(url);
  img.src = url ? inlineUrl(url) : "";
  img.alt = file.name || "사진";
  $("#viewer-name").textContent = file.name || "사진";
  const sender = message.senderId === state.me?.userId ? "나" : message.senderName || nameOf(message.senderId);
  $("#viewer-meta").textContent = [sender, message.timestamp ? formatStamp(message.timestamp) : "", formatSize(file.size)].filter(Boolean).join(" · ");
  $("#viewer-count").textContent = viewer.items.length > 1 ? `${viewer.index + 1} / ${viewer.items.length}` : "";
  const down = $("#viewer-down");
  down.href = url;
  down.download = file.name || "";
  $("#viewer-av").replaceChildren(avatar(message.senderId === state.me?.userId ? state.me : personById(message.senderId)));
  $("#viewer-prev").disabled = viewer.index <= 0;
  $("#viewer-next").disabled = viewer.index >= viewer.items.length - 1;
  $("#viewer-goto").hidden = !message.id || !isTalkView();
  const strip = $("#viewer-strip");
  strip.replaceChildren();
  if (viewer.items.length > 1) {
    viewer.items.forEach((entry, index) => {
      const button = el("button");
      button.type = "button";
      button.setAttribute("aria-label", `${index + 1}번째 사진`);
      if (index === viewer.index) button.setAttribute("aria-current", "true");
      const entryUrl = safeFileUrl(entry.file.url);
      if (state.prefs?.chat?.autoShowImages === false && !shownImages.has(entryUrl)) {
        // 아직 열지 않은 사진은 받지 않고 자리만 둔다(누르면 그 사진을 연다).
        button.classList.add("hold");
        button.append(iconUse("ico-eye"));
      } else {
        const thumb = document.createElement("img");
        thumb.src = inlineUrl(entry.file.url);
        thumb.alt = "";
        thumb.loading = "lazy";
        button.append(thumb);
      }
      button.addEventListener("click", () => stepViewer(index - viewer.index));
      strip.append(button);
    });
    strip.querySelector("[aria-current]")?.scrollIntoView({ block: "nearest", inline: "center" });
  }
}

function stepViewer(step) {
  const next = viewer.index + step;
  if (next < 0 || next >= viewer.items.length) return;
  viewer.index = next;
  renderViewer();
}

$("#viewer-prev").addEventListener("click", () => stepViewer(-1));
$("#viewer-next").addEventListener("click", () => stepViewer(1));
$("#viewer-close").addEventListener("click", () => $("#viewer").close());
$("#viewer").addEventListener("keydown", (event) => {
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    stepViewer(-1);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    stepViewer(1);
  }
});
$("#viewer").addEventListener("close", () => {
  $("#viewer-img").removeAttribute("src");
});
$("#viewer-goto").addEventListener("click", () => {
  const item = viewer.items[viewer.index];
  $("#viewer").close();
  closeDrawer();
  if (item?.message?.id) jumpTo(item.message.id, { flash: true });
});

/* ── 대화방 메뉴(2-B 항목) ── */

$("#room-fav").addEventListener("click", () => {
  closeGroupMenu();
  toggleListPref("favorites", convKey(), "즐겨찾기에 넣었습니다.", "즐겨찾기에서 뺐습니다.");
});
$("#room-mute").addEventListener("click", () => {
  closeGroupMenu();
  toggleListPref("muted", convKey(), "이 대화방 알림을 껐습니다.", "이 대화방 알림을 켰습니다.");
});
$("#room-search").addEventListener("click", () => {
  closeGroupMenu();
  openInSearch();
});
$("#room-files").addEventListener("click", () => {
  closeGroupMenu();
  openDrawer();
});
$("#room-sched").addEventListener("click", () => {
  closeGroupMenu();
  if (toggleSchedList(true)) $("#sched-list").querySelector("button")?.focus();
  else $("#composer-input").focus();
});

document.addEventListener("click", (event) => {
  if (!event.target.isConnected) return;
  if (picker && !event.target.closest?.(".picker, .acts-bar, .rc")) closePicker();
  if (!event.target.closest?.("#status-pop, #me")) closeStatusPop();
  if (!event.target.closest?.("#send-menu, #send-more")) closeMenu("#send-menu", "#send-more");
});

/* ───────── 2-C: 워터마크·자동 잠금·투표·할 일 ───────── */

/* ── C3 워터마크: "이름 · 로그인 ID 앞 7자 · 날짜"를 대화 기록 뒤에 옅게 반복 ── */

let watermarkText = "";

function todayText() {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function renderWatermark() {
  const layer = $("#watermark");
  if (!layer) return;
  const log = !$("#log").hidden ? $("#log") : !$("#note-log").hidden ? $("#note-log") : null;
  const on = Boolean(state.me?.watermark) && Boolean(log);
  layer.hidden = !on;
  if (!on) return;
  layer.style.top = `${log.offsetTop}px`;
  layer.style.height = `${log.offsetHeight}px`;
  const loginId = String(state.me.email || "").split("@")[0].slice(0, 7);
  const text = [state.me.fullName || "", loginId, todayText()].filter(Boolean).join(" · ");
  if (text === watermarkText && layer.childElementCount) return;
  watermarkText = text;
  layer.replaceChildren();
  for (let y = -40, row = 0; y < 1600; y += 140, row += 1) {
    for (let x = -120 + (row % 2) * 130; x < 2400; x += 260) {
      const span = el("span", "", text);
      span.style.left = `${x}px`;
      span.style.top = `${y + 120}px`;
      layer.append(span);
    }
  }
}

if ("ResizeObserver" in window) {
  const observer = new ResizeObserver(() => renderWatermark());
  observer.observe($("#log"));
  observer.observe($("#note-log"));
}
window.addEventListener("resize", () => renderWatermark());

/* ── C4 자동 잠금 ── */

let lockTimer = 0;

function lockKey() {
  return state.me ? `sangsangtalk.lock.${state.me.userId}` : "";
}

function adminLockMinutes() {
  const minutes = Number(state.me?.autoLockMinutes);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
}

function autoLockMinutes() {
  const admin = adminLockMinutes();
  const mine = state.prefs?.lock?.minutes;
  if (!Number.isInteger(mine)) return admin;
  if (admin > 0) return mine > 0 ? Math.min(admin, mine) : admin;
  return mine > 0 ? mine : 0;
}

function startLockWatch() {
  stopLockWatch();
  if (!autoLockMinutes()) return;
  lockTimer = window.setInterval(() => {
    if (!state.me || state.locked) return;
    if (Date.now() - lastInputAt >= autoLockMinutes() * 60 * 1000) lockScreen({ reason: "idle" });
  }, 15 * 1000);
}

function stopLockWatch() {
  window.clearInterval(lockTimer);
  lockTimer = 0;
}

/* reason: "idle"(자동 잠금)일 때만 "N분 동안 사용하지 않아" 문구. 직접·서버·다른 탭 잠금은 일반 문구. */
function lockScreen({ fromServer = false, reason = "other" } = {}) {
  if (!state.me || state.locked || state.pwForced) return;
  state.locked = true;
  // 서버가 잠긴 동안 다른 API를 막는다(여러 탭·관리자 화면도 같은 상태가 된다).
  if (!fromServer) fetch("/api/session/lock", { method: "POST" }).catch(() => {});
  try {
    localStorage.setItem(lockKey(), "1");
  } catch {
    // 저장소를 못 쓰면 새로 고침하면 풀린다(서버 세션은 그대로).
  }
  // 대화상자는 맨 위 층이라 잠금 화면 위에 뜨므로 모두 닫는다.
  confirmResolve?.(false);
  for (const id of ["#chooser", "#note-dialog", "#group-dialog", "#leave-dialog", "#confirm-dialog", "#viewer", "#sched-dialog", "#widget-dialog", "#settings", "#notice-dialog"]) {
    const dialog = $(id);
    if (dialog?.open) dialog.close();
  }
  closeStatusPop();
  closeSnoozeMenu();
  closeCenter();
  closeMsgMenu();
  closeReaders();
  closePicker();
  closeMentionPop();
  closeNewMenu();
  closeGroupMenu();
  closeMenu("#send-menu", "#send-more");
  closeMenu("#plus-menu", "#composer-plus");
  $("#chat-view").inert = true;
  const minutes = autoLockMinutes();
  $("#lock-why").textContent = reason === "idle" && minutes
    ? `${minutes}분 동안 사용하지 않아 화면을 잠갔습니다.\n비밀번호를 입력하면 이어서 쓸 수 있어요.`
    : "화면이 잠겼습니다.\n비밀번호를 입력해 잠금을 푸세요.";
  const self = personById(state.me.userId);
  $("#lock-name").textContent = state.me.fullName || state.me.email || "";
  $("#lock-sub").textContent = mySubtitle() || (self ? personTitle(self) : "");
  $("#lock-password").value = "";
  $("#lock-password").classList.remove("bad");
  $("#lock-password").removeAttribute("aria-invalid");
  $("#lock-error").textContent = "";
  $("#lock-submit").disabled = false;
  $("#lock").hidden = false;
  $("#lock-password").focus();
}

function unlockScreen() {
  state.locked = false;
  try {
    localStorage.removeItem(lockKey());
  } catch {
    // 무시한다.
  }
  $("#lock").hidden = true;
  const pwOpen = !$("#pwchange").hidden;
  $("#chat-view").inert = pwOpen;
  $("#lock-password").value = "";
  lastInputAt = Date.now();
  if (pwOpen) {
    $("#pw-old").focus();
    return;
  }
  resumeAfterBlock();
  if (isTalkView()) $("#composer-input")?.focus();
}

/* 잠금·비밀번호 변경으로 막혀 있던 동안 실패한 읽기를 다시 하고, 미룬 이동을 처리한다. */
function resumeAfterBlock() {
  if (blockedStartHash) {
    openBlockedStartHash();
    return;
  }
  // 막힌 채 시작했으면 아무것도 읽지 못했으므로 처음 로드를 다시 한다.
  if (state.startBlocked) {
    reloadAll().then(() => runDeferredHash());
    return;
  }
  // 잠긴 동안 바뀌었을 수 있는 설정·알림 수는 다시 맞춘다.
  loadPrefs();
  loadActivityCount();
  refreshNoteIndex();
  markOpenRead();
  if (isTalkView()) loadMessages({ quiet: true });
  loadTalkPreviews();
  runDeferredHash();
}

/* 다른 탭에서 풀었으면 이 탭도 푼다(창에 돌아올 때 서버 상태 확인). */
let lockSyncTimer = 0;
window.addEventListener("focus", () => {
  if (!state.me || !state.locked) return;
  window.clearTimeout(lockSyncTimer);
  lockSyncTimer = window.setTimeout(async () => {
    try {
      const response = await fetch("/api/session");
      if (!response.ok) return;
      const data = await response.json().catch(() => ({}));
      if (state.locked && data.locked === false) unlockScreen();
    } catch {
      // 다음에 다시 확인한다.
    }
  }, 300);
});

/* 로그아웃 때: 잠금 표시만 걷는다(다음 로그인에 잠금이 남지 않게 기록도 지운다). */
function clearLock() {
  try {
    if (state.me) localStorage.removeItem(lockKey());
  } catch {
    // 무시한다.
  }
  state.locked = false;
  stopLockWatch();
  $("#lock").hidden = true;
  $("#chat-view").inert = false;
}

$("#lock-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#lock-password");
  const button = $("#lock-submit");
  const password = input.value;
  if (!password) {
    $("#lock-error").textContent = "비밀번호를 입력하세요.";
    input.focus();
    return;
  }
  button.disabled = true;
  button.textContent = "확인하는 중…";
  try {
    // api()를 쓰지 않는다: 잠금 풀기 실패의 401은 로그아웃이 아니다(signedOut으로 구분).
    const response = await fetch("/api/session/unlock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok) {
      unlockScreen();
      return;
    }
    if (response.status === 401 && data.signedOut !== false) {
      clearLock();
      const base = data.error || "비밀번호를 여러 번 틀려 로그아웃했습니다.";
      // 서버 문구에 이미 30분 안내가 있으면 다시 붙이지 않는다.
      showLogin(/30분/.test(base) ? base : `${base} 30분 동안 다시 로그인할 수 없습니다.`);
      return;
    }
    input.value = "";
    input.classList.add("bad");
    input.setAttribute("aria-invalid", "true");
    const left = Number(data.remaining);
    $("#lock-error").textContent = response.status === 401
      // Zulip은 5번 틀리면 30분 동안 로그인을 막는다.
      ? `비밀번호가 맞지 않습니다. ${Number.isFinite(left) && left > 0 ? `${left}번 더 틀리면` : "5번 틀리면"} 로그아웃되고 30분 동안 로그인할 수 없습니다.`
      : data.error || "잠금을 풀지 못했습니다. 다시 시도하세요.";
    input.focus();
  } catch {
    $("#lock-error").textContent = "서버에 연결하지 못했습니다. 다시 시도하세요.";
  } finally {
    button.disabled = false;
    button.textContent = "잠금 해제";
  }
});
$("#lock-password").addEventListener("input", (event) => {
  event.currentTarget.classList.remove("bad");
  event.currentTarget.removeAttribute("aria-invalid");
});
$("#lock").addEventListener("keydown", (event) => {
  // Esc로 닫히지 않는다.
  if (event.key === "Escape") event.preventDefault();
});
$("#lock-logout").addEventListener("click", () => $("#logout").click());

/* 화면 아래 잠깐 뜨는 안내(화면 읽기에도 알린다). */
let appToastTimer = 0;
function showToast(text) {
  const node = $("#app-toast");
  window.clearTimeout(appToastTimer);
  node.textContent = text;
  node.hidden = false;
  appToastTimer = window.setTimeout(() => {
    node.hidden = true;
    node.textContent = "";
  }, 3500);
}

/* ── 비밀번호 바꾸기(첫 로그인 강제 + 내 프로필 메뉴) ── */

function mySubtitle() {
  return [state.me?.position, state.me?.department].filter(Boolean).join(" · ");
}

function openPasswordChange({ forced = false } = {}) {
  if (!state.me) return;
  closeStatusPop();
  state.pwForced = forced;
  for (const id of ["#chooser", "#note-dialog", "#group-dialog", "#leave-dialog", "#viewer", "#sched-dialog", "#widget-dialog", "#settings", "#notice-dialog"]) {
    const dialog = $(id);
    if (dialog?.open) dialog.close();
  }
  $("#pw-title").textContent = forced ? "비밀번호를 바꿔 주세요" : "비밀번호 바꾸기";
  $("#pw-why").textContent = forced
    ? "관리자가 처음 만들어 준 비밀번호입니다.\n새 비밀번호로 바꾼 뒤 상상톡을 쓸 수 있어요."
    : "지금 비밀번호를 확인한 뒤 새 비밀번호로 바꿉니다.";
  for (const id of ["#pw-old", "#pw-new", "#pw-confirm"]) {
    $(id).value = "";
    $(id).classList.remove("bad");
    $(id).removeAttribute("aria-invalid");
  }
  $("#pw-error").textContent = "";
  $("#pw-submit").disabled = false;
  $("#pw-submit").textContent = "비밀번호 바꾸기";
  // 강제일 때는 취소 대신 로그아웃만 둔다.
  $("#pw-cancel").textContent = forced ? "로그아웃" : "취소";
  $("#chat-view").inert = true;
  $("#pwchange").hidden = false;
  $("#pw-old").focus();
}

function closePasswordChange() {
  const screen = $("#pwchange");
  if (!screen || screen.hidden) return;
  screen.hidden = true;
  for (const id of ["#pw-old", "#pw-new", "#pw-confirm"]) $(id).value = "";
  const forced = state.pwForced;
  state.pwForced = false;
  if (!state.locked) $("#chat-view").inert = false;
  return forced;
}

function badField(id, message) {
  const input = $(id);
  input.classList.add("bad");
  input.setAttribute("aria-invalid", "true");
  $("#pw-error").textContent = message;
  input.focus();
}

$("#pw-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  for (const id of ["#pw-old", "#pw-new", "#pw-confirm"]) {
    $(id).classList.remove("bad");
    $(id).removeAttribute("aria-invalid");
  }
  const oldPassword = $("#pw-old").value;
  const newPassword = $("#pw-new").value;
  if (!oldPassword) return badField("#pw-old", "현재 비밀번호를 입력하세요.");
  if (newPassword.length < 8) return badField("#pw-new", "새 비밀번호는 8자 이상이어야 합니다.");
  if (newPassword === oldPassword) return badField("#pw-new", "새 비밀번호는 지금과 달라야 합니다.");
  if ($("#pw-confirm").value !== newPassword) return badField("#pw-confirm", "새 비밀번호 확인이 맞지 않습니다.");
  const button = $("#pw-submit");
  const session = state.sessionGen;
  button.disabled = true;
  button.textContent = "바꾸는 중…";
  $("#pw-error").textContent = "";
  try {
    await api("POST", "/api/session/password", { oldPassword, newPassword });
    if (session !== state.sessionGen) return;
    if (state.me) state.me.mustChangePassword = false;
    const forced = closePasswordChange();
    showToast("비밀번호를 바꿨습니다.");
    if (forced) {
      lastInputAt = Date.now();
      if (!(await openBlockedStartHash())) await reloadAll();
      runDeferredHash();
      if (isTalkView()) $("#composer-input")?.focus();
      else $("#rail-talk").focus();
    } else {
      $("#me").focus();
    }
  } catch (error) {
    if (error.status === 401 || session !== state.sessionGen) return;
    // 서버 문구(현재 비밀번호 틀림, 강도 부족 등)를 그대로 보인다.
    $("#pw-error").textContent = error.message || "비밀번호를 바꾸지 못했습니다.";
    if (/현재/.test(error.message || "")) {
      $("#pw-old").classList.add("bad");
      $("#pw-old").focus();
    } else {
      $("#pw-new").focus();
    }
  } finally {
    button.disabled = false;
    button.textContent = "비밀번호 바꾸기";
  }
});
for (const id of ["#pw-old", "#pw-new", "#pw-confirm"]) {
  $(id).addEventListener("input", (event) => {
    event.currentTarget.classList.remove("bad");
    event.currentTarget.removeAttribute("aria-invalid");
  });
}
$("#pw-cancel").addEventListener("click", () => {
  if (state.pwForced) {
    $("#logout").click();
    return;
  }
  closePasswordChange();
  $("#me").focus();
});
$("#pwchange").addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  if (!state.pwForced) {
    closePasswordChange();
    $("#me").focus();
  }
});
$("#sp-password").addEventListener("click", () => openPasswordChange({ forced: false }));

/* ── C5 투표·할 일 ── */

function roomSize() {
  if (state.view === "group") return (state.selectedGroup?.memberIds || []).length;
  if (state.view === "dm") return 2;
  return state.people.length + 1;
}

function voterName(id) {
  return id === state.me?.userId ? "나" : nameOf(id);
}

function widgetCard(message) {
  return message.poll ? pollCard(message) : todoCard(message);
}

function pollCard(message) {
  const poll = message.poll;
  const options = Array.isArray(poll.options) ? poll.options : [];
  const voters = new Set(options.flatMap((option) => option.voterIds || []));
  const card = el("div", "wcard poll");
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", `투표: ${poll.question || ""}`);
  const head = el("div", "ch");
  const icon = el("span", "ic");
  icon.append(iconUse("ico-poll"));
  head.append(icon, "투표 · 한 개 고르기");
  const list = el("div", "opts");
  list.setAttribute("role", "radiogroup");
  list.setAttribute("aria-label", "항목");
  for (const option of options) {
    const ids = option.voterIds || [];
    const mine = ids.includes(state.me?.userId);
    const button = el("button", "popt");
    button.type = "button";
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String(mine));
    button.setAttribute("aria-label", `${option.text}, ${ids.length}표${mine ? ", 내가 고름" : ""}`);
    const fill = el("span", "fill");
    fill.style.width = `${voters.size ? Math.round((ids.length / voters.size) * 100) : 0}%`;
    const text = el("span");
    text.append(el("b", "", option.text || ""));
    if (ids.length) text.append(el("small", "", ids.map(voterName).join(", ")));
    button.append(fill, el("span", "mk"), text, el("span", "n", String(ids.length)));
    button.addEventListener("click", () => votePoll(message.id, option.key));
    list.append(button);
  }
  const size = roomSize();
  card.append(head, el("h3", "", poll.question || ""), list, el("div", "cf", `${size > voters.size ? `${size}명 중 ` : ""}${voters.size}명 참여 · 누르면 바꿀 수 있어요`));
  return card;
}

function todoCard(message) {
  const todo = message.todo;
  const items = Array.isArray(todo.items) ? todo.items : [];
  const done = items.filter((item) => item.done).length;
  const card = el("div", "wcard todo");
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", `할 일: ${todo.title || ""}`);
  const head = el("div", "ch");
  const icon = el("span", "ic");
  icon.append(iconUse("ico-todo"));
  head.append(icon, "할 일");
  const bar = el("div", "prog");
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", String(items.length));
  bar.setAttribute("aria-valuenow", String(done));
  bar.setAttribute("aria-label", `${items.length}개 중 ${done}개 완료`);
  const fill = el("i");
  fill.style.width = `${items.length ? Math.round((done / items.length) * 100) : 0}%`;
  bar.append(fill);
  card.append(head, el("h3", "", todo.title || ""), bar);
  for (const item of items) {
    const row = el("label", item.done ? "titem done" : "titem");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cb";
    box.checked = Boolean(item.done);
    box.addEventListener("change", () => {
      row.classList.add("busy");
      box.disabled = true;
      toggleTodo(message.id, item.key);
    });
    const text = el("span");
    text.append(el("b", "", item.text || ""));
    if (item.done && item.doneBy) text.append(el("small", "", `${voterName(item.doneBy)} 완료`));
    row.append(box, text);
    card.append(row);
  }
  card.append(el("div", "cf", `${items.length}개 중 ${done}개 완료 · 누구나 체크할 수 있어요`));
  return card;
}

async function widgetAction(id, path, body) {
  const key = liveKey();
  const data = await api("POST", `/api/messages/${id}/${path}`, body);
  if (key === liveKey() && data.message) applyUpdated([data.message]);
  return data.message;
}

/* 한 개 고르기: 다른 항목을 고르면 내 예전 표를 빼고 새 항목에 넣는다. 같은 항목을 다시 누르면 뺀다. */
async function votePoll(id, key) {
  const message = state.messages.find((item) => item.id === id);
  if (!message?.poll) return;
  const mine = (option) => (option.voterIds || []).includes(state.me?.userId);
  const target = message.poll.options.find((option) => option.key === key);
  const others = message.poll.options.filter((option) => option.key !== key && mine(option));
  try {
    for (const option of others) await widgetAction(id, "poll", { key: option.key });
    await widgetAction(id, "poll", { key });
    announce(target && !mine(target) ? `‘${target.text}’에 투표했습니다.` : "투표를 바꿨습니다.");
  } catch (error) {
    if (error.status === 401) return;
    state.sendErrors[convKey()] = error.message || "투표하지 못했습니다.";
    updateComposer();
    replaceRow(id);
  }
}

async function toggleTodo(id, key) {
  try {
    await widgetAction(id, "todo", { key });
  } catch (error) {
    if (error.status === 401) return;
    state.sendErrors[convKey()] = error.message || "할 일을 바꾸지 못했습니다.";
    updateComposer();
    replaceRow(id);
  }
}

/* 만들기 대화상자 */
const widgetForm = { mode: "poll" };
const WIDGET = {
  poll: { title: "투표 만들기", q: "질문", items: "항목 (2~10개)", add: "항목 추가", submit: "투표 보내기", placeholder: "항목 입력", min: 2, max: 10, start: 3 },
  todo: { title: "할 일 만들기", q: "제목", items: "할 일", add: "할 일 추가", submit: "할 일 보내기", placeholder: "할 일 입력 · Enter로 다음 줄", min: 1, max: 30, start: 3 },
};

function widgetRows() {
  return [...$("#widget-items").querySelectorAll(".optrow")];
}

function renumberWidget() {
  const def = WIDGET[widgetForm.mode];
  const rows = widgetRows();
  rows.forEach((row, index) => {
    const noun = widgetForm.mode === "poll" ? "항목" : "할 일";
    row.querySelector(".num").textContent = String(index + 1);
    row.querySelector("input").setAttribute("aria-label", `${noun} ${index + 1}`);
    const remove = row.querySelector("button");
    remove.setAttribute("aria-label", `${noun} ${index + 1} 빼기`);
    remove.disabled = rows.length <= def.min;
  });
  $("#widget-add").disabled = rows.length >= def.max;
}

function addWidgetRow(value = "", focus = false) {
  const def = WIDGET[widgetForm.mode];
  if (widgetRows().length >= def.max) return null;
  const row = el("div", "optrow");
  const input = document.createElement("input");
  input.maxLength = 100;
  input.autocomplete = "off";
  input.placeholder = def.placeholder;
  input.value = value;
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    const rows = widgetRows();
    const next = rows[rows.indexOf(row) + 1];
    if (next) next.querySelector("input").focus();
    else if (input.value.trim()) addWidgetRow("", true);
  });
  const remove = el("button", "icon-btn");
  remove.type = "button";
  remove.append(iconUse("ico-x"));
  remove.addEventListener("click", () => {
    const rows = widgetRows();
    const index = rows.indexOf(row);
    row.remove();
    renumberWidget();
    const after = widgetRows();
    (after[Math.min(index, after.length - 1)]?.querySelector("input") || $("#widget-q")).focus();
  });
  row.append(el("span", "num"), input, remove);
  $("#widget-items").append(row);
  renumberWidget();
  if (focus) input.focus();
  return row;
}

function openWidgetDialog(mode) {
  closeMenu("#plus-menu", "#composer-plus");
  if (!isTalkView()) return;
  const def = WIDGET[mode];
  widgetForm.mode = mode;
  $("#widget-title").textContent = def.title;
  const room = state.view === "dm" ? `${state.selectedUser?.fullName || "상대"}님에게` : state.view === "group" ? `‘${state.selectedGroup?.name || "그룹"}’에` : `${GENERAL_NAME}에`;
  $("#widget-sub").textContent = mode === "poll"
    ? `${room} 보냅니다. 참여자는 누가 어디에 투표했는지 볼 수 있습니다.`
    : `${room} 보냅니다. 대화방 참여자 누구나 체크할 수 있습니다.`;
  $("#widget-q-label").textContent = def.q;
  $("#widget-q").value = "";
  $("#widget-items-label").textContent = def.items;
  $("#widget-add").querySelector("span").textContent = def.add;
  $("#widget-items").replaceChildren();
  for (let i = 0; i < def.start; i += 1) addWidgetRow();
  $("#widget-submit").textContent = def.submit;
  $("#widget-submit").disabled = false;
  $("#widget-error").textContent = "";
  $("#widget-dialog").showModal();
  $("#widget-q").focus();
}

$("#widget-add").addEventListener("click", () => addWidgetRow("", true));
$("#widget-close").addEventListener("click", () => $("#widget-dialog").close());
$("#widget-cancel").addEventListener("click", () => $("#widget-dialog").close());
$("#widget-dialog").addEventListener("close", () => {
  if (state.me && isTalkView() && !state.locked) $("#composer-input")?.focus();
});
$("#widget-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const mode = widgetForm.mode;
  const def = WIDGET[mode];
  const question = $("#widget-q").value.replace(/\s+/g, " ").trim();
  const items = widgetRows().map((row) => row.querySelector("input").value.replace(/\s+/g, " ").trim()).filter(Boolean);
  const error = $("#widget-error");
  if (!question) {
    error.textContent = mode === "poll" ? "질문을 입력하세요." : "제목을 입력하세요.";
    $("#widget-q").focus();
    return;
  }
  if (items.length < def.min) {
    error.textContent = mode === "poll" ? "항목을 두 개 이상 입력하세요." : "할 일을 한 개 이상 입력하세요.";
    (widgetRows().find((row) => !row.querySelector("input").value.trim())?.querySelector("input") || $("#widget-add")).focus();
    return;
  }
  const key = convKey();
  const session = state.sessionGen;
  const body = { ...noticeTarget(), content: "" };
  body[mode] = mode === "poll" ? { question, options: items } : { title: question, items };
  const submit = $("#widget-submit");
  submit.disabled = true;
  submit.textContent = "보내는 중…";
  error.textContent = "";
  try {
    const data = await api("POST", "/api/messages", body);
    if (session !== state.sessionGen) return;
    $("#widget-dialog").close();
    if (convKey() === key && data.message) {
      if (state.hasNewer) await loadMessages();
      else addMessages([data.message], { forceBottom: true });
    }
  } catch (failure) {
    if (failure.status === 401 || session !== state.sessionGen) return;
    error.textContent = failure.message || "보내지 못했습니다.";
  } finally {
    submit.disabled = false;
    submit.textContent = def.submit;
  }
});

wireMenu("#plus-menu", "#composer-plus");
$("#make-poll").addEventListener("click", () => openWidgetDialog("poll"));
$("#make-todo").addEventListener("click", () => openWidgetDialog("todo"));
document.addEventListener("click", (event) => {
  if (!event.target.isConnected) return;
  if (!event.target.closest?.("#plus-menu, #composer-plus")) closeMenu("#plus-menu", "#composer-plus");
});

/* ───────── 이벤트 ───────── */

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.authBusy) return;
  const email = $("#email").value.trim();
  const password = $("#password").value;
  if (!email || !password) {
    setLoginError("이메일과 비밀번호를 입력하세요.");
    return;
  }
  state.authBusy = true;
  setLoginError("");
  $("#login-button").disabled = true;
  $("#login-button").textContent = "로그인 중…";
  $("#email").disabled = true;
  $("#password").disabled = true;
  try {
    // 데스크톱 앱(Tauri) 안에서는 앱 표시 헤더를 붙인다. APP_ONLY_LOGIN=1이면 서버가 이 헤더 없는 로그인을 403으로 거부한다.
    const headers = { "content-type": "application/json" };
    if (window.__TAURI_INTERNALS__) headers["x-sangsangtalk-client"] = "desktop";
    const response = await fetch("/api/login", {
      method: "POST",
      headers,
      body: JSON.stringify({ email, password }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setLoginError(data.error || "로그인하지 못했습니다.");
      $("#login-button").disabled = false;
      $("#login-button").textContent = "로그인";
      $("#email").disabled = false;
      $("#password").disabled = false;
      state.authBusy = false;
      return;
    }
    $("#password").value = "";
    try {
      // 비밀번호로 새로 들어왔으면 예전 잠금 기록은 지운다(새로 고침으로 잠금을 우회하는 것만 막으면 된다).
      localStorage.removeItem(`sangsangtalk.lock.${data.userId}`);
    } catch {
      // 무시한다.
    }
    state.me = data;
    state.authBusy = false;
    showChat();
  } catch {
    setLoginError("서버에 연결하지 못했습니다.");
    $("#login-button").disabled = false;
    $("#login-button").textContent = "로그인";
    $("#email").disabled = false;
    $("#password").disabled = false;
    state.authBusy = false;
  }
});

let notifyAsked = false;
function askNotifyOnGesture() {
  // 권한 창은 사용자 동작 이벤트 안에서 바로 불러야 뜬다. 로그인 전 동작은 세지 않는다.
  if (notifyAsked || !state.me) return;
  notifyAsked = true;
  askNotifyPermission();
  document.removeEventListener("pointerdown", askNotifyOnGesture, true);
  document.removeEventListener("keydown", askNotifyOnGesture, true);
}
document.addEventListener("pointerdown", askNotifyOnGesture, true);
document.addEventListener("keydown", askNotifyOnGesture, true);

for (const button of document.querySelectorAll("[data-view]")) {
  button.addEventListener("click", () => {
    closeStarred();
    setView(button.dataset.view);
  });
}
$("#new-dm").addEventListener("click", () => {
  closeNewMenu();
  setView("home");
  $("#list-search").focus();
});
$("#new-group").addEventListener("click", () => {
  closeNewMenu();
  openGroupDialog("create", $("#new-talk"));
});

$("#logout").addEventListener("click", async () => {
  stopPoll();
  try {
    await fetch("/api/logout", { method: "POST" });
  } catch {
    // The local screen still returns to login if the request fails.
  }
  showLogin();
});

$("#list-search").addEventListener("input", (event) => {
  state.query = event.currentTarget.value || "";
  if (!state.query.trim()) resetListSearch();
  renderList();
  scheduleSearch();
});

for (const button of document.querySelectorAll("[data-talk-filter]")) {
  button.addEventListener("click", () => {
    state.talkFilter = button.dataset.talkFilter || "all";
    for (const item of document.querySelectorAll("[data-talk-filter]")) {
      item.setAttribute("aria-pressed", String(item === button));
    }
    renderTalk();
  });
}

for (const button of document.querySelectorAll("[data-note-filter]")) {
  button.addEventListener("click", () => {
    state.noteFilter = button.dataset.noteFilter || "all";
    for (const item of document.querySelectorAll("[data-note-filter]")) {
      item.setAttribute("aria-pressed", String(item === button));
    }
    renderNotes();
  });
}

function enterSends() {
  return state.prefs?.chat?.enterSends !== false;
}

function sendKeyLabel() {
  return enterSends() ? "Enter" : "Ctrl+Enter";
}

/* 입력창 아래 안내 문구도 보내기 키를 따른다. */
function renderSendHints() {
  if (!state.compose) $("#composer-hint").textContent = `끌어다 놓거나 붙여넣어도 됩니다 · ${sendKeyLabel()} 전송`;
  else renderCompose();
  const note = $("#note-hint");
  if (note) note.textContent = `끌어다 놓거나 붙여넣어도 됩니다 · ${sendKeyLabel()} 전송`;
}

function wireComposer(form, input, refresh) {
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
    // P3: Enter로 보내기(Shift+Enter 줄 바꿈) 또는 Ctrl+Enter로 보내기(Enter 줄 바꿈)
    const send = enterSends() ? !event.shiftKey && !event.ctrlKey && !event.metaKey : event.ctrlKey || event.metaKey;
    if (send) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
    refresh();
  });
}
wireComposer($("#composer"), $("#composer-input"), updateComposer);
wireComposer($("#note-composer"), $("#note-thread-input"), updateNoteComposer);

$("#log").addEventListener("scroll", () => {
  const log = $("#log");
  // 이전 기록을 못 불러왔으면 스크롤로 다시 요청하지 않는다("다시 시도" 버튼으로만).
  if (log.scrollTop < 120 && !state.olderError) loadOlder();
  if (state.hasNewer && log.scrollHeight - log.scrollTop - log.clientHeight < 120) loadNewer();
}, { passive: true });

$("#composer").addEventListener("submit", (event) => {
  event.preventDefault();
  const content = $("#composer-input").value.trim();
  if (state.compose?.mode === "edit") {
    if (!state.sendingKeys.has(convKey())) saveEdit(content);
    return;
  }
  const attachments = composerUploader.ready();
  if ((!content && !attachments.length) || state.sendingKeys.has(convKey()) || composerUploader.busy()) return;
  sendMessage(content, attachments);
});

$("#chooser").addEventListener("close", () => {
  const userId = state.chooserUser?.userId;
  state.chooserUser = null;
  if (!restoreChooserFocus) {
    restoreChooserFocus = true;
    return;
  }
  if (userId && state.view === "home") document.getElementById(`person-${userId}`)?.focus();
});

$("#chooser-talk").addEventListener("click", () => {
  const person = state.chooserUser;
  if (person) openTalk(person);
});

$("#chooser-note").addEventListener("click", () => {
  const person = state.chooserUser;
  if (person) openNote(person);
});

$("#note-cancel").addEventListener("click", () => {
  if ($("#note-dialog").open) $("#note-dialog").close();
});

$("#note-dialog").addEventListener("cancel", (event) => {
  if (state.noteSending) event.preventDefault();
});

$("#note-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const person = state.noteUser;
  const content = $("#note-input").value.trim();
  if (!person || !content || state.noteSending) return;
  state.noteSending = true;
  $("#note-send").disabled = true;
  $("#note-send").textContent = "보내는 중…";
  $("#note-error").textContent = "";
  try {
    const response = await fetch("/api/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, view: "dm", userId: person.userId, note: true }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      showLogin("다시 로그인해 주세요.");
      return;
    }
    if (!response.ok) {
      $("#note-error").textContent = data.error || "쪽지를 보내지 못했습니다.";
      return;
    }
    if ($("#note-dialog").open) $("#note-dialog").close();
    if (state.view !== "home") await setView("home");
    state.noteStatus = `${person.fullName}님에게 쪽지를 보냈습니다.`;
    renderList();
    document.getElementById(`person-${person.userId}`)?.focus();
  } catch {
    $("#note-error").textContent = "쪽지를 보내지 못했습니다.";
  } finally {
    state.noteSending = false;
    if ($("#note-dialog").open) {
      $("#note-send").disabled = false;
      $("#note-send").textContent = "보내기";
    }
  }
});

/* 보내는 동안 대화를 옮겨도 글·오류는 보낸 대화에 남는다.
 * 보내기 시작할 때 입력창을 비우고, 실패하면 원래 대화(지금 열려 있으면 입력창, 아니면 초안)로 되돌린다. */
async function sendMessage(content, attachments) {
  const view = state.view;
  const body = { content, view, attachments };
  if (view === "dm") body.userId = state.selectedUser?.userId;
  if (view === "group") body.groupId = state.selectedGroup?.groupId;
  const requestedKey = convKey();
  const reply = state.compose?.mode === "reply" && state.compose.key === requestedKey ? state.compose.message : null;
  if (reply) body.replyToId = reply.id;
  const mentions = mentionIdsIn(content);
  if (mentions.length) body.mentions = mentions;
  const urgent = urgentMode();
  if (urgent) {
    body.urgent = true;
    state.urgent.error = "";
  }
  const session = state.sessionGen;
  const input = $("#composer-input");
  const typed = input.value;
  stopTyping();
  input.value = "";
  input.style.height = "auto";
  delete state.drafts[requestedKey];
  state.sendingKeys.add(requestedKey);
  delete state.sendErrors[requestedKey];
  updateComposer();
  try {
    const data = await api("POST", "/api/messages", body);
    if (session !== state.sessionGen) return;
    if (state.compose?.mode === "reply" && state.compose.key === requestedKey) setCompose(null);
    // 보내고 나면 보통으로 돌아온다.
    if (urgent && state.urgent?.key === requestedKey) state.urgent = null;
    if (convKey() === requestedKey) {
      composerUploader.remove(attachments);
      const echoed = data.message && state.messages.find((message) => message.id === data.message.id);
      if (state.hasNewer) await loadMessages();
      else if (echoed) {
        echoed.unreadCount = data.message.unreadCount;
        replaceRow(echoed.id);
        $("#log").scrollTop = $("#log").scrollHeight;
      } else if (data.message) addMessages([data.message], { forceBottom: true });
    }
  } catch (error) {
    if (error.status === 401 || session !== state.sessionGen) return;
    if (urgent && state.urgent?.key === requestedKey && (error.status === 429 || error.status === 403)) {
      state.urgent.error = error.message || "중요 메시지를 보내지 못했습니다.";
    } else {
      state.sendErrors[requestedKey] = error.message || "메시지를 보내지 못했습니다.";
    }
    if (convKey() === requestedKey) {
      if (!input.value.trim()) {
        input.value = typed;
        input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
      }
    } else if (!state.drafts[requestedKey]) {
      state.drafts[requestedKey] = typed;
    }
  } finally {
    state.sendingKeys.delete(requestedKey);
    updateComposer();
    if (state.me && convKey() === requestedKey) input.focus();
  }
}

$("#thread-back").addEventListener("click", () => {
  if (isTalkView()) setView("talk");
  else if (state.view === "notes") {
    selectNotePeer(null).then(() => updateChrome());
  }
});

$("#note-composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  const person = state.selectedNotePeer;
  const input = $("#note-thread-input");
  const content = input?.value.trim() || "";
  const attachments = noteUploader.ready();
  if (!person || (!content && !attachments.length) || state.noteSending || noteUploader.busy()) return;
  state.noteSending = true;
  updateNoteComposer();
  $("#note-thread-error").textContent = "";
  const session = state.sessionGen;
  const samePeer = () => session === state.sessionGen && state.view === "notes" && state.selectedNotePeer?.userId === person.userId;
  try {
    await api("POST", "/api/messages", { content, view: "dm", userId: person.userId, note: true, attachments });
    if (samePeer()) {
      if (input.value.trim() === content) {
        input.value = "";
        input.style.height = "auto";
      }
      noteUploader.remove(attachments);
    }
    if (session === state.sessionGen && state.view === "notes") {
      await loadNotes({ quiet: true });
      renderNoteThread();
    }
  } catch (error) {
    if (error.status === 401) return;
    if (samePeer()) $("#note-thread-error").textContent = error.message || "쪽지를 보내지 못했습니다.";
  } finally {
    state.noteSending = false;
    updateNoteComposer();
  }
});

boot();
