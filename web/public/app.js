// 데스크톱 연결 파일을 못 읽어도(예: 서버에 아직 등록 안 됨) 화면은 떠야 하므로 동적으로 불러온다.
const bridge = await import("./desktop-bridge.js").catch(() => null);
const notify = bridge?.notify || (() => {});
const setUnread = bridge?.setUnread || (() => {});
const askNotifyPermission = bridge?.askNotifyPermission || (() => {});

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
};

const TURTLE = "/assets/turtle-front.png";
const GENERAL_NAME = "general";
const GROUP_TOPIC = "대화";
const MAX_UPLOAD_MB = 100;
const BLOCKED_EXT = new Set(["exe", "bat", "cmd", "ps1", "js", "vbs", "msi", "scr", "com", "jar"]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
const IDLE_AFTER_MS = 10 * 60 * 1000;
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
  if (me && state.me) me.title = `${state.me.fullName || state.me.email} · ${label}`;
  const text = $("#me-label");
  if (text) text.textContent = state.me ? label : "";
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
  if (!response.ok) throw new ApiError(data.error || "요청을 처리하지 못했습니다.", response.status);
  return data;
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
function avatar(person, { small = false } = {}) {
  const node = el("span", small ? "av sm" : "av");
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

function personAvatar(person, { small = false } = {}) {
  const face = avatar(person, { small });
  const dot = person ? presenceDot(person.userId, small) : null;
  if (!dot) return face;
  const wrap = el("span", small ? "avwrap sm" : "avwrap");
  wrap.append(face, dot);
  return wrap;
}

function groupAvatar(small) {
  const node = el("span", small ? "av sm group" : "av group");
  node.setAttribute("aria-hidden", "true");
  node.append(iconUse("ico-group"));
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

window.addEventListener("hashchange", () => {
  if (!state.me || pendingHash) return;
  if (location.hash && location.hash !== hashFor()) routeTo(location.hash);
});

/* ───────── 메시지 로그 ───────── */

function safeFileUrl(url) {
  return typeof url === "string" && url.startsWith("/api/files/") ? url : "";
}

function inlineUrl(url) {
  return url + (url.includes("?") ? "&" : "?") + "inline=1";
}

function fileCard(file) {
  const url = safeFileUrl(file.url);
  const name = file.name || "이름 없음";
  const size = formatSize(file.size);
  if (url && isImage(name, file.type)) {
    const link = el("a", "thumb");
    link.href = url;
    link.download = name;
    link.setAttribute("aria-label", `${name} 내려받기`);
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

function messageRow(message, { mine, grouped, who, kindLabel }) {
  const row = el("div", "msg");
  if (mine) row.classList.add("mine");
  if (grouped) row.classList.add("cont");
  row.dataset.id = String(message.id);
  if (!mine && !grouped) {
    row.append(avatar(personById(message.senderId), { small: true }));
  }
  const body = el("div", "body");
  if (!mine && !grouped) {
    const name = el("span", "who", who);
    const person = personById(message.senderId);
    if (person) name.append(el("small", "", personTitle(person)));
    body.append(name);
  }
  // 시안 v2 6절: 첨부 묶음(세로 6px) 다음에 글 말풍선을 잇고, 시간은 마지막 덩어리 바로 옆에 붙인다.
  const files = attachmentsOf(message);
  const hasText = Boolean((message.content || "").trim());
  const blocks = [];
  if (files.length) {
    const stack = el("div", "files");
    for (const file of files) stack.append(fileCard(file));
    blocks.push(stack);
  }
  if (hasText || !files.length) blocks.push(el("div", "bubble", message.content || ""));
  const stamp = el("span", "stamp");
  if (kindLabel) stamp.append(el("span", "kind", kindLabel));
  stamp.append(timeNode(message.timestamp));
  blocks.forEach((block, index) => {
    const line = el("div", "row");
    line.append(block);
    if (index === blocks.length - 1) line.append(stamp);
    body.append(line);
  });
  row.append(body);
  return row;
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
  let previous = null;
  for (const message of state.messages) {
    const day = dayKey(message.timestamp);
    if (day !== lastDay) {
      log.append(dayDivider(message.timestamp));
      lastDay = day;
      previous = null;
    }
    if (showTopics && message.topic !== lastTopic) {
      log.append(el("p", "sys", message.topic ? `주제 · ${message.topic}` : "주제 없음"));
      lastTopic = message.topic;
      previous = null;
    }
    const mine = message.senderId === state.me.userId;
    const grouped = Boolean(previous
      && previous.senderId === message.senderId
      && message.timestamp - previous.timestamp < 300);
    log.append(messageRow(message, { mine, grouped, who: message.senderName }));
    previous = message;
  }
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
    state.generalUnread += channel.filter((message) => message.senderId !== state.me?.userId && message.id > (state.generalRead || 0)).length;
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
        else state.generalUnread = list.filter((message) => message.senderId !== state.me?.userId && message.id > state.generalRead).length;
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

function roomButton({ avatarNode, name, sub, num, status, preview, unix, unread, current, onClick, label, title }) {
  const button = el("button", "room");
  button.type = "button";
  if (current) button.setAttribute("aria-current", "true");
  if (label) button.setAttribute("aria-label", label);
  if (title) button.title = title;
  const text = el("span", "room-text");
  const top = el("span", "t");
  top.append(el("b", "", name));
  if (num !== undefined) top.append(el("span", "num", String(num)));
  if (status) top.append(status);
  if (sub) top.append(el("em", "", sub));
  text.append(top, el("p", "", preview));
  const meta = el("span", "meta");
  if (unix) {
    const time = el("time", "", formatListTime(unix));
    time.dateTime = new Date(unix * 1000).toISOString();
    meta.append(time);
  }
  if (unread > 0) meta.append(el("span", "badge", unread > 99 ? "99+" : String(unread)));
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
    list.append(errorState(state.notesError || state.directoryError, () => loadDirectory()));
    return;
  }
  if (state.directoryLoading && state.people.length === 0) {
    list.append(loadingState("대화 목록을 불러오는 중…"));
    return;
  }

  const filter = state.talkFilter;
  const showGeneral = (filter === "all" || filter === "group" || (filter === "unread" && state.generalUnread > 0))
    && matchesQuery(GENERAL_NAME, "전체", "채널");
  const groups = filter === "dm" ? [] : state.groups
    .filter((group) => filter !== "unread" || groupUnread(group.groupId) > 0)
    .filter((group) => matchesQuery(group.name, groupMemberNames(group)))
    .sort((a, b) => (latestGroup(b.groupId)?.id || 0) - (latestGroup(a.groupId)?.id || 0) || (a.name || "").localeCompare(b.name || "", "ko"));
  const people = filter === "group" ? [] : state.people
    .filter((person) => filter !== "unread" || unreadCount(person.userId) > 0)
    .filter((person) => matchesQuery(person.fullName, personTitle(person)))
    .sort((a, b) => (latestDm(b.userId)?.timestamp || 0) - (latestDm(a.userId)?.timestamp || 0) || a.fullName.localeCompare(b.fullName, "ko"));

  if (!showGeneral && groups.length === 0 && people.length === 0) {
    list.append(emptyState(
      state.query ? "검색 결과가 없습니다"
        : filter === "unread" ? "읽지 않은 대화가 없습니다"
          : filter === "group" ? "아직 그룹 대화방이 없습니다" : "대화할 구성원이 없습니다",
      !state.query && filter === "group" ? "새 대화(+)에서 그룹을 만들 수 있어요." : "",
    ));
    return;
  }

  if (showGeneral) {
    const sec = el("div", "sec");
    sec.append(iconUse("ico-pin"), "고정됨");
    list.append(sec);
    const last = state.generalLast;
    list.append(roomButton({
      avatarNode: groupAvatar(),
      name: GENERAL_NAME,
      sub: "전체 채널",
      preview: last ? `${last.senderName}: ${previewText(last)}` : "모든 구성원이 함께 쓰는 채널",
      unix: last?.timestamp,
      unread: state.generalUnread,
      current: state.view === "general",
      onClick: () => setView("general"),
    }));
  }
  if (groups.length) {
    const sec = el("div", "sec", "그룹 ");
    sec.append(el("span", "cnt", String(groups.length)));
    list.append(sec);
    for (const group of groups) {
      const last = latestGroup(group.groupId);
      const count = (group.memberIds || []).length;
      const who = last ? (last.senderId === state.me?.userId ? "나" : last.senderName) : "";
      list.append(roomButton({
        avatarNode: groupAvatar(),
        name: group.name || "이름 없는 그룹",
        num: count,
        label: `${group.name || "이름 없는 그룹"}, 참여자 ${count}명`,
        preview: last ? `${who}: ${previewText(last)}` : "아직 대화가 없습니다",
        unix: last?.timestamp,
        unread: groupUnread(group.groupId),
        current: viewingGroup(group.groupId),
        onClick: () => setView("group", group),
      }));
    }
  }
  if (people.length) {
    list.append(el("div", "sec", "1:1 대화"));
    for (const person of people) {
      const last = latestDm(person.userId);
      const status = presenceOf(person.userId);
      list.append(roomButton({
        avatarNode: personAvatar(person),
        name: person.fullName,
        status: statusText(person.userId),
        preview: last ? previewText(last) : "아직 대화가 없습니다",
        unix: last?.timestamp,
        unread: unreadCount(person.userId),
        current: state.view === "dm" && state.selectedUser?.userId === person.userId,
        onClick: () => openTalk(person),
        title: status ? `${person.fullName} · ${PRESENCE[status].label}` : person.fullName,
      }));
    }
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
    list.append(errorState(state.directoryError, () => loadDirectory()));
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
      status: statusText(person.userId),
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

function updateComposer() {
  const button = $("#send-button");
  const input = $("#composer-input");
  if (!button || !input) return;
  const hasText = Boolean(input.value.trim());
  const sending = state.sendingKeys.has(convKey());
  button.disabled = sending || composerUploader.busy() || (!hasText && !composerUploader.ready().length);
  button.querySelector("span").textContent = sending ? "보내는 중…" : "전송";
  button.title = composerUploader.busy() ? "올리는 중인 파일이 끝나면 보낼 수 있어요" : "";
  $("#send-error").textContent = state.sendErrors[convKey()] || "";
}

/* 창이 보이고 포커스가 있을 때만 읽음 처리한다(숨었거나 다른 창을 보고 있으면 트레이 안읽음에 남긴다). */
function attentive() {
  return !document.hidden && document.hasFocus();
}

function afterLogChange() {
  const read = attentive();
  if (state.view === "dm" && state.selectedUser) rememberDm(state.selectedUser.userId, state.messages, read);
  if (state.view === "group" && state.selectedGroup) rememberGroup(state.selectedGroup.groupId, state.messages.slice(-100), read);
  if (state.view === "general" && state.messages.length) {
    state.generalLast = state.messages[state.messages.length - 1];
    if (read) {
      state.generalRead = Math.max(state.generalRead || 0, state.generalLast.id);
      state.generalUnread = 0;
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
  if (!quiet) {
    state.loading = true;
    state.loadError = "";
    state.olderError = "";
    renderLog();
  }
  try {
    const response = await fetch(`/api/messages?${viewParams()}`);
    if (response.status === 401) {
      showLogin("다시 로그인해 주세요.");
      return;
    }
    const data = await response.json().catch(() => ({}));
    if (liveKey() !== requestedKey) return;
    if (!response.ok) throw new Error(data.error || "load");
    const latest = Array.isArray(data.messages) ? data.messages : [];
    if (quiet && state.messages.length) {
      // 이미 불러온 이전 기록은 남기고 최신 묶음만 합친다.
      const oldestLatest = latest[0]?.id ?? Infinity;
      const kept = state.messages.filter((message) => message.id < oldestLatest);
      state.messages = [...kept, ...latest];
      if (!kept.length) state.hasOlder = Boolean(data.hasOlder);
    } else {
      state.messages = latest;
      state.hasOlder = Boolean(data.hasOlder);
    }
    if (state.view === "general") state.generalUnread = 0;
    state.loading = false;
    state.loadError = "";
    const log = $("#log");
    const distance = log.scrollHeight - log.scrollTop - log.clientHeight;
    const stick = !quiet || distance < 160;
    renderLog();
    if (stick) log.scrollTop = log.scrollHeight;
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
  const fresh = notes.filter((note) => note && !previousIds.has(note.messageId) && note.senderId !== state.me?.userId);
  for (const note of fresh.slice(-5)) {
    const open = state.view === "notes" && state.selectedNotePeer?.userId === note.senderId;
    if (open && !document.hidden && document.hasFocus()) continue;
    const name = personById(note.senderId)?.fullName || "새 쪽지";
    notify({ title: `쪽지 · ${name}`, body: "새 쪽지가 왔습니다.", target: `#/notes/${note.senderId}` });
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
    const attention = document.hidden || !document.hasFocus();
    if (open && !attention) continue;
    notify({ title, body: clipBody(previewText(message) || "새 메시지"), target });
  }
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
      if (!response.ok) throw new Error(data.error || "poll");
      setLive("실시간", false);
      const incoming = Array.isArray(data.messages) ? data.messages : [];
      if (data.notesError) applyNotesError(data.error || "쪽지 기록을 읽지 못했습니다. 다시 시도하세요.");
      else applyNoteRecords(Array.isArray(data.notes) ? data.notes : []);
      if (data.groupsChanged) scheduleGroupsReload();
      const usable = data.notesError ? incoming.filter((message) => message.kind !== "dm") : incoming;
      absorbDmPreviews(usable);
      absorbGroupMessages(usable);
      absorbChannelMessages(usable);
      notifyIncoming(usable);
      if (data.reset && !data.notesError) await loadMessages({ quiet: true });
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
  notesTimer = setInterval(() => { refreshNoteIndex(); }, 1500);
  refreshNoteIndex();
}
function stopNotesWatch() {
  clearInterval(notesTimer);
  notesTimer = null;
}
async function refreshNoteIndex() {
  if (!state.me) return;
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
  return Date.now() - lastInputAt >= IDLE_AFTER_MS ? "idle" : "active";
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
    state.presence = data && typeof data.presence === "object" && data.presence ? data.presence : {};
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
      presence.append(dot, statusText(person.userId));
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
    node = groupAvatar();
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
  $("#group-actions").hidden = view !== "group" || !state.selectedGroup;
  if (view !== "group") closeGroupMenu();
}

function updateChrome() {
  const view = state.view;
  const talkLike = view === "talk" || isTalkView(view);
  const noteOpen = view === "notes" && Boolean(state.selectedNotePeer);
  const showLog = isTalkView(view);
  document.body.dataset.view = view;
  document.body.classList.toggle("show-thread", showLog || noteOpen);

  $("#list-title").textContent = view === "home" ? "직원" : view === "notes" ? "쪽지함" : "대화";
  $("#list-search").placeholder = view === "home" ? "이름, 직책 검색" : view === "notes" ? "보낸 사람, 받는 사람 검색" : "대화방, 이름 검색";
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
  }
  const noteField = $("#note-thread-input");
  if (noteField && state.selectedNotePeer) noteField.placeholder = `${state.selectedNotePeer.fullName}님에게 쪽지 보내기`;

  for (const [id, on] of [["#rail-talk", talkLike], ["#rail-people", view === "home"], ["#rail-notes", view === "notes"]]) {
    const node = $(id);
    if (on) node.setAttribute("aria-current", "page");
    else node.removeAttribute("aria-current");
  }
  updateHead();
}

function listGroup(view) {
  return view === "home" ? "home" : view === "notes" ? "notes" : "talk";
}

let confirmResolve = null;

/** 확인 대화상자. 확인이면 true, 취소·Esc면 false. 닫히면 열기 전 포커스로 돌아간다. */
function askConfirm({ title, text, confirm = "확인", cancel = "머무르기" }) {
  const dialog = $("#confirm-dialog");
  if (confirmResolve) confirmResolve(false);
  const opener = document.activeElement;
  $("#confirm-title").textContent = title;
  $("#confirm-text").textContent = text;
  $("#confirm-ok").textContent = confirm;
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
  }
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
  closeNewMenu();
  for (const id of ["#chooser", "#note-dialog", "#group-dialog", "#leave-dialog", "#confirm-dialog"]) {
    const dialog = $(id);
    if (dialog?.open) dialog.close();
  }
  closeGroupMenu();
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
  const pic = $("#me-avatar");
  pic.classList.add("turtle");
  setLive("연결하는 중…", false);
  $("#send-error").textContent = "";
  loadReadState();
  savedRead = "";
  startNotesWatch();
  pendingHash = parseHash(location.hash) ? location.hash : "";
  await setView("talk");
  const hash = pendingHash;
  pendingHash = "";
  if (hash && state.me && !routeTo(hash)) syncHash();
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
    ? new Set(limits.blockedExtensions.map((ext) => String(ext).replace(/^./, "").toLowerCase()).filter(Boolean))
    : BLOCKED_EXT;
  return { mb, blocked };
}
const tooBigText = () => `파일이 너무 큽니다. 파일당 ${uploadLimits().mb}MB까지 보낼 수 있어요.`;
const UPLOAD_NETWORK = "올리지 못했습니다. 연결을 확인하고 다시 시도하세요.";
const blockedText = (name) => `보낼 수 없는 형식입니다(.${extOf(name) || "?"}).`;

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
  menu.querySelector("button")?.focus();
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
    const items = [...$(menuId).querySelectorAll("button")];
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
    const status = statusText(person.userId);
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
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
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
  button.addEventListener("click", () => setView(button.dataset.view));
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
  renderList();
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

function wireComposer(form, input, refresh) {
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
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
  // 이전 기록을 못 불러왔으면 스크롤로 다시 요청하지 않는다("다시 시도" 버튼으로만).
  if ($("#log").scrollTop < 120 && !state.olderError) loadOlder();
}, { passive: true });

$("#composer").addEventListener("submit", (event) => {
  event.preventDefault();
  const content = $("#composer-input").value.trim();
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
  const session = state.sessionGen;
  const input = $("#composer-input");
  const typed = input.value;
  input.value = "";
  input.style.height = "auto";
  delete state.drafts[requestedKey];
  state.sendingKeys.add(requestedKey);
  delete state.sendErrors[requestedKey];
  updateComposer();
  try {
    const data = await api("POST", "/api/messages", body);
    if (session !== state.sessionGen) return;
    if (convKey() === requestedKey) {
      composerUploader.remove(attachments);
      if (data.message) addMessages([data.message], { forceBottom: true });
    }
  } catch (error) {
    if (error.status === 401 || session !== state.sessionGen) return;
    state.sendErrors[requestedKey] = error.message || "메시지를 보내지 못했습니다.";
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
