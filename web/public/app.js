const state = {
  me: null,
  messages: [],
  loading: false,
  loadError: "",
  sending: false,
  sendError: "",
  authBusy: false,
  pollToken: null,
  view: "talk",
  selectedUser: null,
  people: [],
  directoryLoading: false,
  directoryError: "",
  noteStatus: "",
  chooserUser: null,
  noteUser: null,
  noteSending: false,
  noteRecords: [],
  noteMessages: [],
  notesError: "",
  dmCache: {},
  readCursor: {},
  previewGeneration: 0,
  selectedNotePeer: null,
  noteFilter: "all",
  talkFilter: "all",
  query: "",
  generalLast: null,
  generalUnread: 0,
  live: false,
};

const TURTLE = "/assets/turtle-front.png";
const GENERAL_NAME = "general";

let pollAbort = null;
let personClickTimer = 0;
let restoreChooserFocus = true;

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
  const dot = $("#me-dot");
  if (dot) dot.classList.toggle("off", !state.live);
  const me = $("#me");
  if (me && state.me) me.title = `${state.me.fullName || state.me.email} · ${state.live ? "온라인" : "연결 안 됨"}`;
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

/* 아바타: 프로필 사진이 있으면 사진, 없으면 거북이(시안 규칙). */
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

/* ───────── 메시지 로그 ───────── */

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
  const line = el("div", "row");
  const bubble = el("div", "bubble", message.content);
  const stamp = el("span", "stamp");
  if (kindLabel) stamp.append(el("span", "kind", kindLabel));
  stamp.append(timeNode(message.timestamp));
  line.append(bubble, stamp);
  body.append(line);
  row.append(body);
  return row;
}

function dayDivider(unix) {
  const wrap = el("div", "day");
  wrap.append(el("span", "", formatDay(unix)));
  return wrap;
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
    log.append(emptyState(state.view === "dm" ? "아직 대화가 없습니다" : "아직 메시지가 없습니다", "첫 메시지를 보내 대화를 시작하세요."));
    return;
  }

  log.dataset.state = "ready";
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
    if (state.view !== "dm" && message.topic !== lastTopic) {
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

function unreadCount(personId) {
  const seen = state.readCursor[personId] || 0;
  return (state.dmCache[personId] || []).filter((message) => message.senderId !== state.me?.userId && message.id > seen).length;
}

function totalUnread() {
  return state.people.reduce((sum, person) => sum + unreadCount(person.userId), 0) + state.generalUnread;
}

function rememberDm(personId, messages, markRead) {
  const sorted = messages.slice().sort((a, b) => a.id - b.id);
  state.dmCache[personId] = sorted;
  if (markRead) {
    const last = sorted[sorted.length - 1];
    state.readCursor[personId] = last ? last.id : (state.readCursor[personId] || 0);
  }
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
    if (state.view === "dm" && state.selectedUser?.userId === message.peerId) {
      state.readCursor[message.peerId] = message.id;
    }
  }
}

function absorbChannelMessages(messages) {
  const channel = messages.filter((message) => message && (message.kind || "channel") === "channel");
  if (!channel.length) return;
  const last = channel[channel.length - 1];
  if (!state.generalLast || last.id > state.generalLast.id) state.generalLast = last;
  if (state.view !== "general") {
    state.generalUnread += channel.filter((message) => message.senderId !== state.me?.userId).length;
  }
}

async function loadTalkPreviews() {
  const generation = ++state.previewGeneration;
  const people = state.people.slice();
  const general = (async () => {
    try {
      const response = await fetch("/api/messages?" + new URLSearchParams({ view: "general" }));
      if (!response.ok || generation !== state.previewGeneration) return;
      const data = await response.json().catch(() => ({}));
      const list = Array.isArray(data.messages) ? data.messages : [];
      const last = list[list.length - 1];
      if (last && (!state.generalLast || last.id > state.generalLast.id)) state.generalLast = last;
    } catch {
      // The general preview can stay blank.
    }
  })();
  await Promise.all([general, ...people.map(async (person) => {
    try {
      const response = await fetch("/api/messages?" + new URLSearchParams({ view: "dm", userId: String(person.userId) }));
      if (!response.ok || generation !== state.previewGeneration) return;
      const data = await response.json().catch(() => ({}));
      if (generation !== state.previewGeneration) return;
      rememberDm(person.userId, Array.isArray(data.messages) ? data.messages : [], state.view === "dm" && state.selectedUser?.userId === person.userId);
    } catch {
      // A preview can stay blank until the next refresh.
    }
  })]);
  if (generation === state.previewGeneration) renderList();
}

function matchesQuery(...texts) {
  const query = state.query.trim().toLowerCase();
  if (!query) return true;
  return texts.some((text) => (text || "").toLowerCase().includes(query));
}

function roomButton({ avatarNode, name, sub, preview, unix, unread, current, onClick, label }) {
  const button = el("button", "room");
  button.type = "button";
  if (current) button.setAttribute("aria-current", "true");
  if (label) button.setAttribute("aria-label", label);
  const text = el("span", "room-text");
  const top = el("span", "t");
  top.append(el("b", "", name));
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
  const people = filter === "group" ? [] : state.people
    .filter((person) => filter !== "unread" || unreadCount(person.userId) > 0)
    .filter((person) => matchesQuery(person.fullName, personTitle(person)))
    .sort((a, b) => (latestDm(b.userId)?.timestamp || 0) - (latestDm(a.userId)?.timestamp || 0) || a.fullName.localeCompare(b.fullName, "ko"));

  if (!showGeneral && people.length === 0) {
    list.append(emptyState(state.query ? "검색 결과가 없습니다" : filter === "unread" ? "읽지 않은 대화가 없습니다" : "대화할 구성원이 없습니다"));
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
      preview: last ? `${last.senderName}: ${last.content}` : "모든 구성원이 함께 쓰는 채널",
      unix: last?.timestamp,
      unread: state.generalUnread,
      current: state.view === "general",
      onClick: () => setView("general"),
    }));
  }
  if (people.length) {
    list.append(el("div", "sec", "최근 대화"));
    for (const person of people) {
      const last = latestDm(person.userId);
      list.append(roomButton({
        avatarNode: avatar(person),
        name: person.fullName,
        sub: personTitle(person),
        preview: last ? last.content : "아직 대화가 없습니다",
        unix: last?.timestamp,
        unread: unreadCount(person.userId),
        current: state.view === "dm" && state.selectedUser?.userId === person.userId,
        onClick: () => openTalk(person),
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
    const button = roomButton({
      avatarNode: avatar(person),
      name: person.fullName,
      sub: "",
      preview: personTitle(person),
      onClick: () => {},
      label: `${person.fullName}, ${personTitle(person)}, 대화 또는 쪽지`,
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
    log.append(emptyState("표시할 쪽지가 없습니다"));
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
  if (state.selectedNotePeer && state.noteFilter === "all" && !state.noteMessages.some((message) => message.peerId === state.selectedNotePeer.userId)) {
    state.selectedNotePeer = null;
  }
  const visible = groups.filter((group) => matchesQuery(group.fullName));
  if (visible.length === 0) {
    list.append(emptyState(groups.length ? "검색 결과가 없습니다" : "아직 쪽지가 없습니다", groups.length ? "" : "직원 목록에서 쪽지를 보낼 수 있어요."));
  } else {
    for (const group of visible) {
      const last = group.messages[group.messages.length - 1];
      list.append(roomButton({
        avatarNode: avatar(personById(group.userId)),
        name: group.fullName,
        sub: `${group.messages.length}통`,
        preview: (last.direction === "sent" ? "보냄 · " : "받음 · ") + last.content,
        unix: last.timestamp,
        current: state.selectedNotePeer?.userId === group.userId,
        onClick: () => {
          state.selectedNotePeer = { userId: group.userId, fullName: group.fullName };
          renderNotes();
          $("#note-thread-input")?.focus();
        },
      }));
    }
  }
  renderNoteThread();
  updateChrome();
}

function renderList() {
  if (state.view === "home") renderStaff();
  else if (state.view === "notes") renderNotes();
  else renderTalk();
  updateUnreadBadges();
  const status = $("#list-status");
  if (status) status.textContent = state.view === "home" ? state.noteStatus || "" : "";
}

/* ───────── 데이터 ───────── */

function updateComposer() {
  const button = $("#send-button");
  const input = $("#composer-input");
  if (!button || !input) return;
  button.disabled = state.sending || !input.value.trim();
  input.disabled = state.sending;
  button.querySelector("span").textContent = state.sending ? "보내는 중…" : "전송";
  $("#send-error").textContent = state.sendError;
}

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
  state.messages.push(...fresh);
  state.messages.sort((a, b) => a.id - b.id);
  state.loading = false;
  state.loadError = "";
  renderLog();
  if (stick) log.scrollTop = log.scrollHeight;
  if (state.view === "dm" && state.selectedUser) {
    rememberDm(state.selectedUser.userId, state.messages, true);
  }
  if (state.view === "general") {
    state.generalLast = state.messages[state.messages.length - 1];
  }
  renderList();
}

async function loadDirectory() {
  state.directoryLoading = true;
  state.directoryError = "";
  renderList();
  try {
    const response = await fetch("/api/directory");
    if (response.status === 401) {
      showLogin("다시 로그인해 주세요.");
      return;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "directory");
    state.people = Array.isArray(data.people) ? data.people : [];
    state.directoryLoading = false;
    renderList();
    startPoll();
    loadTalkPreviews();
  } catch {
    if (!state.me) return;
    state.directoryLoading = false;
    state.directoryError = "직원 목록을 가져오지 못했습니다.";
    renderList();
  }
}

async function loadMessages({ quiet = false } = {}) {
  const requestedView = state.view;
  const requestedUser = state.selectedUser?.userId || null;
  if (requestedView !== "dm" && requestedView !== "general") {
    await loadDirectory();
    return;
  }
  if (!quiet) {
    state.loading = true;
    state.loadError = "";
    renderLog();
  }
  try {
    const params = new URLSearchParams({ view: requestedView });
    if (requestedView === "dm") params.set("userId", String(requestedUser));
    const response = await fetch(`/api/messages?${params}`);
    if (response.status === 401) {
      showLogin("다시 로그인해 주세요.");
      return;
    }
    const data = await response.json().catch(() => ({}));
    if (state.view !== requestedView || (requestedView === "dm" && state.selectedUser?.userId !== requestedUser)) return;
    if (!response.ok) throw new Error(data.error || "load");
    state.messages = Array.isArray(data.messages) ? data.messages : [];
    if (requestedView === "dm" && requestedUser) rememberDm(requestedUser, state.messages, true);
    if (requestedView === "general") {
      state.generalUnread = 0;
      if (state.messages.length) state.generalLast = state.messages[state.messages.length - 1];
    }
    state.loading = false;
    state.loadError = "";
    const note = $("#history-note");
    if (note) note.hidden = !data.hasOlder;
    const log = $("#log");
    const distance = log.scrollHeight - log.scrollTop - log.clientHeight;
    const stick = !quiet || distance < 160;
    renderLog();
    if (stick) log.scrollTop = log.scrollHeight;
    renderList();
    startPoll();
  } catch {
    if (state.view !== requestedView || (requestedView === "dm" && state.selectedUser?.userId !== requestedUser)) return;
    state.loading = false;
    state.loadError = requestedView === "dm" ? "대화를 불러오지 못했습니다." : "채널 메시지를 가져오지 못했습니다.";
    renderLog();
  }
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
  if (state.view === "general") return kind === "channel";
  return false;
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
      const usable = data.notesError ? incoming.filter((message) => message.kind !== "dm") : incoming;
      absorbDmPreviews(usable);
      absorbChannelMessages(usable);
      if (data.reset && !data.notesError) await loadMessages({ quiet: true });
      else if (state.view === "dm" || state.view === "general") {
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
  state.noteRecords = notes;
  state.notesError = "";
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
  try {
    const response = await fetch("/api/notes");
    if (response.status === 401) return;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 503) applyNotesError(data.error || "쪽지 기록을 읽지 못했습니다. 다시 시도하세요.");
      return;
    }
    applyNoteRecords(Array.isArray(data.notes) ? data.notes : []);
  } catch {
    applyNotesError("쪽지 기록을 읽지 못했습니다. 다시 시도하세요.");
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
    const response = await fetch("/api/notes/messages");
    if (response.status === 401) {
      showLogin("다시 로그인해 주세요.");
      return;
    }
    const data = await response.json().catch(() => ({}));
    if (state.view !== "notes") return;
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

/* ───────── 화면 전환 ───────── */

function updateHead() {
  const title = $("#channel-name");
  const kicker = $("#channel-kicker");
  const slot = $("#chat-avatar");
  const view = state.view;
  let name = "대화";
  let sub = "";
  let node = null;
  if (view === "dm" && state.selectedUser) {
    name = state.selectedUser.fullName;
    sub = personTitle(state.selectedUser);
    node = avatar(personById(state.selectedUser.userId) || state.selectedUser);
  } else if (view === "general") {
    name = GENERAL_NAME;
    sub = `전체 채널 · ${state.people.length + 1}명`;
    node = groupAvatar();
  } else if (view === "notes" && state.selectedNotePeer) {
    name = state.selectedNotePeer.fullName;
    sub = "쪽지";
    node = avatar(personById(state.selectedNotePeer.userId));
  } else if (view === "notes") {
    name = "쪽지";
  } else if (view === "home") {
    name = "직원";
  }
  title.textContent = name;
  kicker.textContent = sub;
  slot.replaceChildren();
  slot.hidden = !node;
  if (node) {
    slot.className = node.className;
    slot.append(...node.childNodes);
  }
}

function updateChrome() {
  const view = state.view;
  const talkLike = view === "talk" || view === "dm" || view === "general";
  const noteOpen = view === "notes" && Boolean(state.selectedNotePeer);
  const showLog = view === "dm" || view === "general";
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
  $("#log").setAttribute("aria-label", view === "dm" ? "대화" : "general 채널 메시지");
  const history = $("#history-note");
  if (history && !showLog) history.hidden = true;

  const input = $("#composer-input");
  if (input) {
    input.placeholder = view === "dm" && state.selectedUser
      ? `${state.selectedUser.fullName}님에게 메시지 보내기`
      : view === "general" ? `${GENERAL_NAME}에 메시지 보내기` : "메시지를 입력하세요";
  }
  const noteInput = $("#note-thread-input");
  if (noteInput && state.selectedNotePeer) noteInput.placeholder = `${state.selectedNotePeer.fullName}님에게 쪽지 보내기`;

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

async function setView(view, person) {
  if (!["home", "talk", "notes", "general", "dm"].includes(view)) return;
  if (view === "dm") {
    if (person) state.selectedUser = person;
    if (!state.selectedUser) return;
  }
  const sameDm = view === "dm"
    && state.view === "dm"
    && state.selectedUser?.userId === (person?.userId || state.selectedUser?.userId)
    && !state.loadError;
  if (view === state.view && view !== "dm" && !state.loadError && !state.directoryError && !state.notesError) return;
  if (sameDm) return;
  if (listGroup(view) !== listGroup(state.view)) {
    state.query = "";
    $("#list-search").value = "";
  }
  state.view = view;
  if (view !== "home") state.noteStatus = "";
  if (view === "general") state.generalUnread = 0;
  state.sendError = "";
  updateComposer();
  updateChrome();
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
  stopPoll();
  stopNotesWatch();
  window.clearTimeout(personClickTimer);
  for (const id of ["#chooser", "#note-dialog"]) {
    const dialog = $(id);
    if (dialog?.open) dialog.close();
  }
  state.me = null;
  state.messages = [];
  state.view = "talk";
  state.selectedUser = null;
  state.selectedNotePeer = null;
  state.people = [];
  state.dmCache = {};
  state.readCursor = {};
  state.generalLast = null;
  state.generalUnread = 0;
  state.sending = false;
  state.authBusy = false;
  state.noteStatus = "";
  setMode("login");
  setLoginError(message || "");
  $("#login-button").disabled = false;
  $("#login-button").textContent = "로그인";
  $("#email").disabled = false;
  $("#password").disabled = false;
}

function showChat() {
  setMode("chat");
  state.selectedUser = null;
  state.selectedNotePeer = null;
  state.noteStatus = "";
  state.view = "";
  $("#me-name").textContent = state.me.fullName || state.me.email;
  const pic = $("#me-avatar");
  pic.classList.add("turtle");
  setLive("연결하는 중…", false);
  $("#send-error").textContent = "";
  startNotesWatch();
  setView("talk");
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

for (const button of document.querySelectorAll("[data-view]")) {
  button.addEventListener("click", () => setView(button.dataset.view));
}
$("#new-talk").addEventListener("click", () => {
  setView("home");
  $("#list-search").focus();
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

function wireComposer(form, input, button) {
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
    button.disabled = !input.value.trim();
  });
}
wireComposer($("#composer"), $("#composer-input"), $("#send-button"));
wireComposer($("#note-composer"), $("#note-thread-input"), $("#note-thread-send"));

$("#composer").addEventListener("submit", (event) => {
  event.preventDefault();
  const content = $("#composer-input").value.trim();
  if (!content || state.sending) return;
  sendMessage(content);
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

async function sendMessage(content) {
  state.sending = true;
  state.sendError = "";
  updateComposer();
  try {
    const response = await fetch("/api/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content,
        view: state.view === "dm" ? "dm" : "general",
        userId: state.view === "dm" ? state.selectedUser?.userId : undefined,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      showLogin("다시 로그인해 주세요.");
      return;
    }
    if (!response.ok) {
      state.sendError = data.error || "메시지를 보내지 못했습니다.";
      return;
    }
    $("#composer-input").value = "";
    $("#composer-input").style.height = "auto";
    if (data.message) addMessages([data.message], { forceBottom: true });
  } catch {
    state.sendError = "메시지를 보내지 못했습니다.";
  } finally {
    state.sending = false;
    updateComposer();
    if (state.me && (state.view === "dm" || state.view === "general")) $("#composer-input").focus();
  }
}

$("#thread-back").addEventListener("click", () => {
  if (state.view === "dm" || state.view === "general") setView("talk");
  else if (state.view === "notes") {
    state.selectedNotePeer = null;
    renderNotes();
    updateChrome();
  }
});

$("#note-composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  const person = state.selectedNotePeer;
  const input = $("#note-thread-input");
  const content = input?.value.trim() || "";
  if (!person || !content || state.noteSending) return;
  state.noteSending = true;
  $("#note-thread-send").disabled = true;
  $("#note-thread-error").textContent = "";
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
      $("#note-thread-error").textContent = data.error || "쪽지를 보내지 못했습니다.";
      return;
    }
    input.value = "";
    input.style.height = "auto";
    await loadNotes({ quiet: true });
    renderNoteThread();
  } catch {
    $("#note-thread-error").textContent = "쪽지를 보내지 못했습니다.";
  } finally {
    state.noteSending = false;
    $("#note-thread-send").disabled = !input?.value.trim();
  }
});

boot();
