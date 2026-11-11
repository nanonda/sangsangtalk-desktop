const state = {
  me: null,
  messages: [],
  loading: false,
  loadError: "",
  sending: false,
  sendError: "",
  authBusy: false,
  pollToken: null,
  view: "directory",
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
};

let pollAbort = null;
let personClickTimer = 0;
let restoreChooserFocus = true;

const $ = (selector) => document.querySelector(selector);

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
  node.textContent = message;
  node.classList.toggle("is-error", Boolean(isError));
}

function roleLabel(role) {
  return {
    owner: "\uC18C\uC720\uC790",
    admin: "\uAD00\uB9AC\uC790",
    moderator: "\uC911\uC7AC\uC790",
    guest: "\uC190\uB2D8",
    member: "\uAD6C\uC131\uC6D0",
  }[role] || "\uAD6C\uC131\uC6D0";
}

function personTitle(person) {
  const title = typeof person?.title === "string" ? person.title.trim() : "";
  return title || roleLabel(person?.role);
}

function initial(name) {
  const text = (name || "?").trim();
  return [...text][0] || "?";
}

function avatarColor(name) {
  const palette = ["#23473d", "#d84a2f", "#8a5a2b", "#3d5a80", "#6b3f69"];
  let hash = 0;
  for (const char of name || "?") hash = (hash + char.codePointAt(0)) % palette.length;
  return palette[hash];
}

function formatTime(unix) {
  return new Intl.DateTimeFormat("ko-KR", { hour: "numeric", minute: "2-digit" }).format(new Date(unix * 1000));
}

function formatDay(unix) {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(new Date(unix * 1000));
}

function dayKey(unix) {
  const date = new Date(unix * 1000);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function renderLog() {
  const log = $("#log");
  log.replaceChildren();

  if (state.loadError) {
    log.dataset.state = "error";
    const wrap = document.createElement("div");
    wrap.className = "state";
    const title = document.createElement("p");
    title.className = "state-title";
    title.textContent = "\uBA54\uC2DC\uC9C0\uB97C \uBD88\uB7EC\uC624\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4";
    const detail = document.createElement("p");
    detail.textContent = state.loadError;
    const retry = document.createElement("button");
    retry.id = "retry";
    retry.type = "button";
    retry.className = "button-primary";
    retry.textContent = "\uB2E4\uC2DC \uC2DC\uB3C4";
    retry.addEventListener("click", () => loadMessages());
    wrap.append(title, detail, retry);
    log.append(wrap);
    return;
  }

  if (state.loading) {
    log.dataset.state = "loading";
    const wrap = document.createElement("div");
    wrap.className = "state";
    const title = document.createElement("p");
    title.className = "state-title";
    title.textContent = "\uBA54\uC2DC\uC9C0\uB97C \uBD88\uB7EC\uC624\uB294 \uC911\u2026";
    wrap.append(title);
    log.append(wrap);
    return;
  }

  if (state.messages.length === 0) {
    log.dataset.state = "empty";
    const wrap = document.createElement("div");
    wrap.className = "state";
    const title = document.createElement("p");
    title.className = "state-title";
    title.textContent = state.view === "dm"
      ? "\uC544\uC9C1 \uB300\uD654\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4"
      : "\uC544\uC9C1 \uBA54\uC2DC\uC9C0\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4";
    const detail = document.createElement("p");
    detail.textContent = state.view === "dm"
      ? "\uCCAB \uBA54\uC2DC\uC9C0\uB97C \uBCF4\uB0B4 \uB300\uD654\uB97C \uC2DC\uC791\uD558\uC138\uC694."
      : "\uCCAB \uBA54\uC2DC\uC9C0\uB97C \uBCF4\uB0B4 \uB300\uD654\uB97C \uC2DC\uC791\uD558\uC138\uC694.";
    wrap.append(title, detail);
    log.append(wrap);
    return;
  }

  log.dataset.state = "ready";
  let lastDay = "";
  let lastTopic = "";
  let previous = null;

  for (const message of state.messages) {
    const day = dayKey(message.timestamp);
    if (day !== lastDay) {
      const divider = document.createElement("p");
      divider.className = "day";
      divider.textContent = formatDay(message.timestamp);
      log.append(divider);
      lastDay = day;
      previous = null;
    }
    if (state.view !== "dm" && message.topic !== lastTopic) {
      const divider = document.createElement("p");
      divider.className = "topic";
      divider.textContent = message.topic ? `\uC8FC\uC81C \u00B7 ${message.topic}` : "\uC8FC\uC81C \uC5C6\uC74C";
      log.append(divider);
      lastTopic = message.topic;
      previous = null;
    }

    const mine = message.senderId === state.me.userId;
    const grouped = previous
      && previous.senderId === message.senderId
      && message.timestamp - previous.timestamp < 300;

    const row = document.createElement("article");
    row.className = mine ? "row mine" : "row";
    row.dataset.id = String(message.id);

    const avatar = document.createElement("div");
    avatar.className = grouped ? "avatar spacer" : "avatar";
    avatar.style.background = avatarColor(message.senderName);
    avatar.textContent = grouped ? "" : initial(message.senderName);
    if (!grouped) avatar.title = message.senderName;

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    if (!grouped) {
      const meta = document.createElement("div");
      meta.className = "meta";
      if (!mine) {
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = message.senderName;
        meta.append(name);
      }
      const time = document.createElement("time");
      time.className = "time";
      time.dateTime = new Date(message.timestamp * 1000).toISOString();
      time.textContent = formatTime(message.timestamp);
      meta.append(time);
      bubble.append(meta);
    }
    const content = document.createElement("p");
    content.className = "content";
    content.textContent = message.content;
    bubble.append(content);
    row.append(avatar, bubble);
    log.append(row);
    previous = message;
  }
}

function turtleMarkup() {
  return '<svg viewBox="0 0 64 64" aria-hidden="true"><ellipse cx="34" cy="46" rx="16" ry="13" fill="#3cb85a"/><ellipse cx="34" cy="48" rx="9.5" ry="8" fill="#f4fff6"/><path d="M16 38c-7 2-9 8-5 10 4 1 9-2 11-6" fill="#3cb85a"/><path d="M50 34c7 0 11 4 10 7-4 2-9 0-11-4" fill="#3cb85a"/><circle cx="30" cy="28" r="13" fill="#37b154"/><path d="M18 26c2-12 20-16 26-5-3-7-12-10-18-6-5 3-8 7-8 11z" fill="#2f7de0"/><ellipse cx="30" cy="17" rx="11" ry="6.2" fill="#3d86e4"/><circle cx="25.2" cy="27.2" r="1.5" fill="#17324d"/><circle cx="33.4" cy="27.2" r="1.5" fill="#17324d"/><path d="M24.6 33.2c2.2 2.2 6.4 2.2 8.6 0" fill="none" stroke="#17324d" stroke-width="1.4" stroke-linecap="round"/></svg>';
}
function visibleStaff() {
  const query = (state.staffQuery || "").trim().toLowerCase();
  if (!query) return state.people;
  return state.people.filter((person) => {
    const label = personTitle(person).toLowerCase();
    return person.fullName.toLowerCase().includes(query) || label.includes(query);
  });
}
function renderStaff() {
  const list = $("#staff-list");
  const count = $("#staff-count");
  const status = $("#staff-status");
  if (!list) return;
  if (status) status.textContent = state.noteStatus || "";
  const people = visibleStaff();
  if (count) count.textContent = "전체 직원 (" + state.people.length + "명)";
  list.replaceChildren();
  if (state.directoryError) {
    list.append(errorState(state.directoryError, () => loadDirectory()));
    return;
  }
  if (state.directoryLoading) {
    list.append(loadingState("직원 목록을 불러오는 중…"));
    return;
  }
  if (people.length === 0) {
    list.append(emptyState(state.people.length ? "검색 결과가 없습니다" : "다른 구성원이 없습니다"));
    return;
  }
  for (const person of people) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "staff-row";
    button.id = "person-" + person.userId;
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-label", person.fullName + ", " + personTitle(person) + ", 대화 또는 쪽지");
    const avatar = document.createElement("span");
    avatar.className = "avatar turtle-avatar";
    if (person.avatarUrl) {
      const img = document.createElement("img");
      img.alt = "";
      img.src = person.avatarUrl;
      avatar.append(img);
    } else {
      avatar.innerHTML = turtleMarkup();
    }
    const idline = document.createElement("span");
    idline.className = "staff-idline";
    const name = document.createElement("span");
    name.className = "staff-name";
    name.textContent = person.fullName;
    const dept = document.createElement("span");
    dept.className = "staff-dept";
    dept.textContent = personTitle(person);
    idline.append(name, dept);
    const presence = document.createElement("span");
    presence.className = "staff-status";
    presence.textContent = "온라인";
    button.append(avatar, idline, presence);
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
    button.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      window.clearTimeout(personClickTimer);
      openChooser(person);
    });
    list.append(button);
  }
}
function renderDirectory() {
  const root = $("#directory");
  const list = $("#directory-list");
  const status = $("#directory-status");
  if (!root || !list || !status) return;
  status.textContent = state.noteStatus || "";
  list.replaceChildren();

  if (state.directoryError) {
    root.dataset.state = "error";
    const wrap = document.createElement("div");
    wrap.className = "state";
    const title = document.createElement("p");
    title.className = "state-title";
    title.textContent = "\uC870\uC9C1\uB3C4\uB97C \uBD88\uB7EC\uC624\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4";
    const detail = document.createElement("p");
    detail.textContent = state.directoryError;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "button-primary";
    retry.textContent = "\uB2E4\uC2DC \uC2DC\uB3C4";
    retry.addEventListener("click", () => loadDirectory());
    wrap.append(title, detail, retry);
    list.append(wrap);
    return;
  }

  if (state.directoryLoading) {
    root.dataset.state = "loading";
    const wrap = document.createElement("div");
    wrap.className = "state";
    const title = document.createElement("p");
    title.className = "state-title";
    title.textContent = "\uC870\uC9C1\uB3C4\uB97C \uBD88\uB7EC\uC624\uB294 \uC911\u2026";
    wrap.append(title);
    list.append(wrap);
    return;
  }

  if (state.people.length === 0) {
    root.dataset.state = "empty";
    const wrap = document.createElement("div");
    wrap.className = "state";
    const title = document.createElement("p");
    title.className = "state-title";
    title.textContent = "\uB2E4\uB978 \uAD6C\uC131\uC6D0\uC774 \uC5C6\uC2B5\uB2C8\uB2E4";
    wrap.append(title);
    list.append(wrap);
    return;
  }

  root.dataset.state = "ready";
  for (const person of state.people) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "person";
    button.id = `person-${person.userId}`;
    button.dataset.userId = String(person.userId);
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-label", `${person.fullName}, ${personTitle(person)}, \uB300\uD654 \uB610\uB294 \uCABD\uC9C0`);

    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.setAttribute("aria-hidden", "true");
    if (person.avatarUrl) {
      avatar.classList.add("has-photo");
      const img = document.createElement("img");
      img.alt = "";
      img.src = person.avatarUrl;
      avatar.append(img);
    } else {
      avatar.style.background = avatarColor(person.fullName);
      avatar.textContent = initial(person.fullName);
    }

    const text = document.createElement("span");
    text.className = "person-text";
    const name = document.createElement("span");
    name.className = "person-name";
    name.textContent = person.fullName;
    const role = document.createElement("span");
    role.className = "person-role";
    role.textContent = personTitle(person);
    text.append(name, role);
    button.append(avatar, text);

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
    button.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      window.clearTimeout(personClickTimer);
      openChooser(person);
    });
    list.append(button);
  }
}

function formatListTime(unix) {
  const date = new Date(unix * 1000);
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  if (sameDay) return formatTime(unix);
  return new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric" }).format(date);
}

function latestDm(personId) {
  const messages = state.dmCache[personId] || [];
  return messages.length ? messages[messages.length - 1] : null;
}

function unreadCount(personId) {
  const seen = state.readCursor[personId] || 0;
  return (state.dmCache[personId] || []).filter((message) => message.senderId !== state.me?.userId && message.id > seen).length;
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

async function loadTalkPreviews() {
  const generation = ++state.previewGeneration;
  const people = state.people.slice();
  await Promise.all(people.map(async (person) => {
    try {
      const response = await fetch("/api/messages?" + new URLSearchParams({ view: "dm", userId: String(person.userId) }));
      if (!response.ok || generation !== state.previewGeneration) return;
      const data = await response.json().catch(() => ({}));
      if (generation !== state.previewGeneration) return;
      rememberDm(person.userId, Array.isArray(data.messages) ? data.messages : [], state.view === "dm" && state.selectedUser?.userId === person.userId);
    } catch {
      // A preview can stay blank until the next refresh.
    }
  }));
  if (generation === state.previewGeneration && (state.view === "talk" || state.view === "dm")) renderTalk();
}

function renderTalk() {
  const list = $("#talk-list");
  const root = $("#talk");
  if (!list || !root) return;
  list.replaceChildren();
  if (state.directoryError || state.notesError) {
    root.dataset.state = "error";
    list.append(errorState(state.notesError || state.directoryError, () => loadDirectory()));
    return;
  }
  if (state.directoryLoading) {
    root.dataset.state = "loading";
    list.append(loadingState("대화함을 불러오는 중…"));
    return;
  }
  if (state.people.length === 0) {
    root.dataset.state = "empty";
    list.append(emptyState("대화할 구성원이 없습니다"));
    return;
  }
  root.dataset.state = "ready";
  for (const person of state.people) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "conv";
    if (state.view === "dm" && state.selectedUser?.userId === person.userId) {
      button.setAttribute("aria-current", "true");
    }
    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.style.background = avatarColor(person.fullName);
    avatar.textContent = initial(person.fullName);
    avatar.setAttribute("aria-hidden", "true");
    const body = document.createElement("span");
    body.className = "conv-body";
    const top = document.createElement("span");
    top.className = "conv-top";
    const name = document.createElement("span");
    name.className = "conv-name";
    name.textContent = person.fullName;
    const time = document.createElement("time");
    time.className = "conv-time";
    const last = latestDm(person.userId);
    if (last) {
      time.dateTime = new Date(last.timestamp * 1000).toISOString();
      time.textContent = formatListTime(last.timestamp);
    }
    top.append(name, time);
    const bottom = document.createElement("span");
    bottom.className = "conv-bottom";
    const preview = document.createElement("span");
    preview.className = "conv-preview";
    preview.textContent = last ? last.content : "아직 대화가 없습니다";
    bottom.append(preview);
    const unread = unreadCount(person.userId);
    if (unread > 0) {
      const badge = document.createElement("span");
      badge.className = "unread";
      badge.textContent = unread > 99 ? "99+" : String(unread);
      bottom.append(badge);
    }
    body.append(top, bottom);
    button.append(avatar, body);
    button.addEventListener("click", () => openTalk(person));
    list.append(button);
  }
}

function noteGroups() {
  const groups = new Map();
  for (const message of state.noteMessages) {
    if (state.noteFilter !== "all" && message.direction !== state.noteFilter) continue;
    const id = message.peerId;
    if (!groups.has(id)) {
      groups.set(id, { userId: id, fullName: message.counterpartName || "쪽지", messages: [] });
    }
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
  const title = $("#channel-name");
  if (title) title.textContent = peer.fullName || "쪽지";
  const messages = state.noteMessages
    .filter((message) => message.peerId === peer.userId)
    .filter((message) => state.noteFilter === "all" || message.direction === state.noteFilter)
    .sort((a, b) => a.id - b.id);
  if (messages.length === 0) {
    log.append(emptyState("표시할 쪽지가 없습니다"));
    return;
  }
  for (const message of messages) {
    const mine = message.direction === "sent" || message.senderId === state.me?.userId;
    const row = document.createElement("article");
    row.className = mine ? "row mine" : "row";
    row.dataset.id = String(message.id);
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.style.background = avatarColor(message.counterpartName || message.senderName);
    avatar.textContent = initial(mine ? state.me?.fullName : (message.counterpartName || message.senderName));
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    const meta = document.createElement("div");
    meta.className = "meta";
    const label = document.createElement("span");
    label.textContent = mine ? "보낸 쪽지" : "받은 쪽지";
    const time = document.createElement("time");
    time.dateTime = new Date(message.timestamp * 1000).toISOString();
    time.textContent = formatTime(message.timestamp);
    meta.append(label, time);
    const content = document.createElement("p");
    content.className = "content";
    content.textContent = message.content;
    bubble.append(meta, content);
    row.append(avatar, bubble);
    log.append(row);
  }
  log.scrollTop = log.scrollHeight;
}

function renderNotes() {
  const list = $("#notes-list");
  const root = $("#notes");
  if (!list || !root) return;
  list.replaceChildren();
  if (state.loadError || state.notesError) {
    root.dataset.state = "error";
    list.append(errorState(state.loadError || state.notesError, () => loadNotes()));
    renderNoteThread();
    return;
  }
  if (state.loading) {
    root.dataset.state = "loading";
    list.append(loadingState("메시지함을 불러오는 중…"));
    return;
  }
  const groups = noteGroups();
  if (state.selectedNotePeer && !groups.some((group) => group.userId === state.selectedNotePeer.userId) && state.noteFilter !== "all") {
    // Keep the open thread even when a filter hides its latest row.
  } else if (state.selectedNotePeer && state.noteFilter === "all" && !state.noteMessages.some((message) => message.peerId === state.selectedNotePeer.userId)) {
    state.selectedNotePeer = null;
  }
  if (groups.length === 0) {
    root.dataset.state = "empty";
    list.append(emptyState("아직 쪽지가 없습니다"));
    renderNoteThread();
    updateChrome();
    return;
  }
  root.dataset.state = "ready";
  for (const group of groups) {
    const last = group.messages[group.messages.length - 1];
    const button = document.createElement("button");
    button.type = "button";
    button.className = "conv";
    if (state.selectedNotePeer?.userId === group.userId) button.setAttribute("aria-current", "true");
    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.style.background = avatarColor(group.fullName);
    avatar.textContent = initial(group.fullName);
    avatar.setAttribute("aria-hidden", "true");
    const body = document.createElement("span");
    body.className = "conv-body";
    const top = document.createElement("span");
    top.className = "conv-top";
    const name = document.createElement("span");
    name.className = "conv-name";
    name.textContent = group.fullName;
    const time = document.createElement("time");
    time.className = "conv-time";
    time.dateTime = new Date(last.timestamp * 1000).toISOString();
    time.textContent = formatListTime(last.timestamp);
    top.append(name, time);
    const preview = document.createElement("span");
    preview.className = "conv-preview";
    preview.textContent = (last.direction === "sent" ? "보낸 쪽지 · " : "받은 쪽지 · ") + last.content;
    body.append(top, preview);
    button.append(avatar, body);
    button.addEventListener("click", () => {
      state.selectedNotePeer = { userId: group.userId, fullName: group.fullName };
      renderNotes();
    });
    list.append(button);
  }
  renderNoteThread();
  updateChrome();
}

function loadingState(text) {
  const wrap = document.createElement("div");
  wrap.className = "state";
  const title = document.createElement("p");
  title.className = "state-title";
  title.textContent = text;
  wrap.append(title);
  return wrap;
}
function emptyState(text) {
  const wrap = document.createElement("div");
  wrap.className = "state";
  const title = document.createElement("p");
  title.className = "state-title";
  title.textContent = text;
  wrap.append(title);
  return wrap;
}
function errorState(text, retry) {
  const wrap = document.createElement("div");
  wrap.className = "state";
  const title = document.createElement("p");
  title.className = "state-title";
  title.textContent = text;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "button-primary";
  button.textContent = "\uB2E4\uC2DC \uC2DC\uB3C4";
  button.addEventListener("click", retry);
  wrap.append(title, button);
  return wrap;
}

function updateComposer() {
  const button = $("#send-button");
  const input = $("#composer-input");
  if (!button || !input) return;
  button.disabled = state.sending;
  input.disabled = state.sending;
  button.textContent = state.sending ? "보내는 중…" : "전송";
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
    renderTalk();
  }
}

function paintPeople() {
  if (state.view === "talk" || state.view === "dm") renderTalk();
  else if (state.view === "home") renderStaff();
  else if (state.view === "directory") renderDirectory();
}

async function loadDirectory() {
  state.directoryLoading = true;
  state.directoryError = "";
  paintPeople();
  try {
    const response = await fetch("/api/directory");
    if (response.status === 401) {
      showLogin("\uB2E4\uC2DC \uB85C\uADF8\uC778\uD574 \uC8FC\uC138\uC694.");
      return;
    }
    const data = await response.json().catch(() => ({}));
    if (state.view !== "home" && state.view !== "directory" && state.view !== "talk") return;
    if (!response.ok) throw new Error(data.error || "directory");
    state.people = Array.isArray(data.people) ? data.people : [];
    state.directoryLoading = false;
    paintPeople();
    startPoll();
    if (state.view === "talk" || state.view === "dm") loadTalkPreviews();
  } catch {
    if (state.view !== "home" && state.view !== "directory" && state.view !== "talk") return;
    state.directoryLoading = false;
    state.directoryError = "\uC870\uC9C1\uB3C4\uB97C \uAC00\uC838\uC624\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.";
    paintPeople();
  }
}

async function loadMessages({ quiet = false } = {}) {
  const requestedView = state.view;
  const requestedUser = state.selectedUser?.userId || null;
  if (requestedView === "home" || requestedView === "directory") {
    await loadDirectory();
    return;
  }
  if (!quiet) {
    state.loading = true;
    state.loadError = "";
    renderLog();
  }
  try {
    const params = new URLSearchParams({ view: requestedView === "dm" ? "dm" : "general" });
    if (requestedView === "dm") params.set("userId", String(requestedUser));
    const response = await fetch(`/api/messages?${params}`);
    if (response.status === 401) {
      showLogin("\uB2E4\uC2DC \uB85C\uADF8\uC778\uD574 \uC8FC\uC138\uC694.");
      return;
    }
    const data = await response.json().catch(() => ({}));
    if (state.view !== requestedView || (requestedView === "dm" && state.selectedUser?.userId !== requestedUser)) return;
    if (!response.ok) {
      const failure = new Error(data.error || "load");
      failure.status = response.status;
      throw failure;
    }
    state.messages = Array.isArray(data.messages) ? data.messages : [];
    if (requestedView === "dm" && requestedUser) rememberDm(requestedUser, state.messages, true);
    state.loading = false;
    state.loadError = "";
    const note = $("#history-note");
    if (note) note.hidden = !data.hasOlder;
    const log = $("#log");
    const distance = log.scrollHeight - log.scrollTop - log.clientHeight;
    const stick = !quiet || distance < 160;
    renderLog();
    if (stick) log.scrollTop = log.scrollHeight;
    if (requestedView === "dm") renderTalk();
    startPoll();
  } catch (error) {
    if (state.view !== requestedView || (requestedView === "dm" && state.selectedUser?.userId !== requestedUser)) return;
    state.loading = false;
    state.loadError = requestedView === "dm"
      ? "\uB300\uD654\uB97C \uBD88\uB7EC\uC624\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4."
      : "\uCC44\uB110 \uBA54\uC2DC\uC9C0\uB97C \uAC00\uC838\uC624\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.";
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
      setLive("\uC2E4\uC2DC\uAC04", false);
      pollAbort = new AbortController();
      const timeout = setTimeout(() => pollAbort.abort(), 70000);
      const response = await fetch("/api/events", { signal: pollAbort.signal });
      clearTimeout(timeout);
      if (state.pollToken !== token) return;
      if (response.status === 401) {
        showLogin("\uB2E4\uC2DC \uB85C\uADF8\uC778\uD574 \uC8FC\uC138\uC694.");
        return;
      }
      const started = Date.now();
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "poll");
      const incoming = Array.isArray(data.messages) ? data.messages : [];
      if (data.notesError) applyNotesError(data.error || "쪽지 기록을 읽지 못했습니다. 다시 시도하세요.");
      else applyNoteRecords(Array.isArray(data.notes) ? data.notes : []);
      const usable = data.notesError ? incoming.filter((message) => message.kind !== "dm") : incoming;
      absorbDmPreviews(usable);
      if (state.view === "talk" || state.view === "dm") renderTalk();
      if (data.reset && !data.notesError) await loadMessages({ quiet: true });
      else if (state.view === "dm" || state.view === "general") {
        const visible = usable.filter(messageMatchesView);
        if (visible.length) addMessages(visible);
      }
      setLive("\uC2E4\uC2DC\uAC04", false);
      if (Date.now() - started < 800) await delay(800);
    } catch (error) {
      if (state.pollToken !== token) return;
      if (error.name !== "AbortError") {
        setLive("\uC5F0\uACB0\uC774 \uC7A0\uC2DC \uB04A\uACBC\uC2B5\uB2C8\uB2E4. \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uB294 \uC911\u2026", true);
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
      showLogin("\uB2E4\uC2DC \uB85C\uADF8\uC778\uD574 \uC8FC\uC138\uC694.");
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
function markCurrent(selector, on) {
  const node = document.querySelector(selector);
  if (!node) return;
  if (on) node.setAttribute("aria-current", "page");
  else node.removeAttribute("aria-current");
}

function updateChrome() {
  const home = state.view === "home";
  const directory = state.view === "directory";
  const talk = state.view === "talk";
  const notes = state.view === "notes";
  const dm = state.view === "dm";
  const general = state.view === "general";
  const noteOpen = notes && Boolean(state.selectedNotePeer);
  const showLog = dm || general;
  document.body.dataset.view = state.view;
  const homePanel = $("#home");
  const workPanel = $("#work");
  if (homePanel) homePanel.hidden = !home;
  if (workPanel) workPanel.hidden = home;
  const orders = $("#rail-orders");
  if (orders) {
    if (home) orders.setAttribute("aria-current", "page");
    else orders.removeAttribute("aria-current");
  }
  document.body.classList.toggle("show-thread", dm || general || noteOpen);
  $("#directory").hidden = !directory;
  $("#talk").hidden = !(talk || dm);
  $("#notes").hidden = !notes;
  $("#log").hidden = !showLog;
  $("#composer").hidden = !showLog;
  $("#note-log").hidden = !noteOpen;
  $("#note-composer").hidden = !noteOpen;
  const empty = $("#thread-empty");
  if (empty) {
    empty.hidden = showLog || noteOpen || directory || general || home;
    empty.textContent = notes ? "쪽지를 선택하세요." : "왼쪽에서 대화를 선택하세요.";
  }
  const kicker = $("#channel-kicker");
  if (kicker) kicker.textContent = directory ? "조직" : notes ? "메시지함" : general ? "채널" : "대화함";
  const title = $("#channel-name");
  if (title && !noteOpen) {
    title.textContent = directory ? "조직도" : talk ? "대화함" : notes ? "메시지함" : dm ? (state.selectedUser?.fullName || "대화") : "general";
  }
  if ($("#log")) $("#log").setAttribute("aria-label", dm ? "대화" : "general 채널 메시지");
  const input = $("#composer-input");
  if (input) input.placeholder = "메시지를 입력하세요";
  const history = $("#history-note");
  if (history && !showLog) history.hidden = true;
  const back = $("#thread-back");
  if (back) back.hidden = !(dm || noteOpen);
  markCurrent("#rail-directory", directory);
  markCurrent("#nav-directory", directory);
  markCurrent("#rail-talk", talk || dm);
  markCurrent("#nav-talk", talk || dm);
  markCurrent("#rail-notes", notes);
  markCurrent("#nav-notes", notes);
  markCurrent("#rail-general", general);
  markCurrent("#nav-general", general);
  const peopleNav = $("#nav-people");
  if (peopleNav) {
    if (home) peopleNav.setAttribute("aria-current", "page");
    else peopleNav.removeAttribute("aria-current");
  }
}

async function setView(view, person) {
  if (!["home", "directory", "talk", "notes", "general", "dm"].includes(view)) return;
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
  state.view = view;
  if (view !== "directory" && view !== "home") state.noteStatus = "";
  state.sendError = "";
  updateChrome();
  if (view === "home" || view === "directory" || view === "talk") {
    await loadDirectory();
    return;
  }
  if (view === "notes") {
    await loadNotes();
    return;
  }
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
  $("#note-target").textContent = person.fullName;
  $("#note-input").value = "";
  $("#note-error").textContent = "";
  $("#note-send").disabled = false;
  $("#note-send").textContent = "\uBCF4\uB0B4\uAE30";
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
  state.view = "directory";
  state.selectedUser = null;
  state.people = [];
  state.sending = false;
  state.authBusy = false;
  state.noteStatus = "";
  setMode("login");
  setLoginError(message || "");
  $("#login-button").disabled = false;
  $("#login-button").textContent = "\uB85C\uADF8\uC778";
  $("#email").disabled = false;
  $("#password").disabled = false;
}

function showChat() {
  setMode("chat");
  state.selectedUser = null;
  state.selectedNotePeer = null;
  state.noteStatus = "";
  $("#me-name").textContent = state.me.fullName || state.me.email;
  const mail = $("#me-mail");
  if (mail) mail.textContent = "온라인";
  const avatar = $("#me-avatar");
  if (avatar) avatar.innerHTML = turtleMarkup();
  setLive("연결하는 중…", false);
  $("#send-error").textContent = "";
  startNotesWatch();
  setView("home");
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
    showLogin("\uC11C\uBC84\uC5D0 \uC5F0\uACB0\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.");
  }
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.authBusy) return;
  const email = $("#email").value.trim();
  const password = $("#password").value;
  if (!email || !password) {
    setLoginError("\uC774\uBA54\uC77C\uACFC \uBE44\uBC00\uBC88\uD638\uB97C \uC785\uB825\uD558\uC138\uC694.");
    return;
  }
  state.authBusy = true;
  setLoginError("");
  $("#login-button").disabled = true;
  $("#login-button").textContent = "\uB85C\uADF8\uC778 \uC911\u2026";
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
      setLoginError(data.error || "\uB85C\uADF8\uC778\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.");
      $("#login-button").disabled = false;
      $("#login-button").textContent = "\uB85C\uADF8\uC778";
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
    setLoginError("\uC11C\uBC84\uC5D0 \uC5F0\uACB0\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.");
    $("#login-button").disabled = false;
    $("#login-button").textContent = "\uB85C\uADF8\uC778";
    $("#email").disabled = false;
    $("#password").disabled = false;
    state.authBusy = false;
  }
});

for (const button of document.querySelectorAll("[data-view]")) {
  button.addEventListener("click", () => setView(button.dataset.view));
}

$("#logout").addEventListener("click", async () => {
  stopPoll();
  try {
    await fetch("/api/logout", { method: "POST" });
  } catch {
    // The local screen still returns to login if the request fails.
  }
  showLogin();
});

$("#composer").addEventListener("submit", (event) => {
  event.preventDefault();
  const content = $("#composer-input").value.trim();
  if (!content || state.sending) return;
  sendMessage(content);
});

$("#composer-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("#composer").requestSubmit();
  }
});

$("#composer-input").addEventListener("input", (event) => {
  const field = event.currentTarget;
  field.style.height = "auto";
  field.style.height = `${Math.min(field.scrollHeight, 160)}px`;
});

$("#chooser").addEventListener("close", () => {
  const userId = state.chooserUser?.userId;
  state.chooserUser = null;
  if (!restoreChooserFocus) {
    restoreChooserFocus = true;
    return;
  }
  if (userId && (state.view === "directory" || state.view === "home")) document.getElementById("person-" + userId)?.focus();
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
  $("#note-send").textContent = "\uBCF4\uB0B4\uB294 \uC911\u2026";
  $("#note-error").textContent = "";
  try {
    const response = await fetch("/api/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, view: "dm", userId: person.userId, note: true }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      showLogin("\uB2E4\uC2DC \uB85C\uADF8\uC778\uD574 \uC8FC\uC138\uC694.");
      return;
    }
    if (!response.ok) {
      $("#note-error").textContent = data.error || "\uCABD\uC9C0\uB97C \uBCF4\uB0B4\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.";
      return;
    }
    state.noteStatus = `\uCABD\uC9C0\uB97C \uBCF4\uB0C8\uC2B5\uB2C8\uB2E4.`;
    state.view = "home";
    if ($("#note-dialog").open) $("#note-dialog").close();
    updateChrome();
    await loadDirectory();
    document.getElementById(`person-${person.userId}`)?.focus();
  } catch {
    $("#note-error").textContent = "\uCABD\uC9C0\uB97C \uBCF4\uB0B4\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.";
  } finally {
    state.noteSending = false;
    if ($("#note-dialog").open) {
      $("#note-send").disabled = false;
      $("#note-send").textContent = "\uBCF4\uB0B4\uAE30";
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
      showLogin("\uB2E4\uC2DC \uB85C\uADF8\uC778\uD574 \uC8FC\uC138\uC694.");
      return;
    }
    if (!response.ok) {
      state.sendError = data.error || "\uBA54\uC2DC\uC9C0\uB97C \uBCF4\uB0B4\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.";
      return;
    }
    $("#composer-input").value = "";
    $("#composer-input").style.height = "auto";
    if (data.message) addMessages([data.message], { forceBottom: true });
  } catch {
    state.sendError = "\uBA54\uC2DC\uC9C0\uB97C \uBCF4\uB0B4\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.";
  } finally {
    state.sending = false;
    updateComposer();
    if (state.me && state.view !== "directory") $("#composer-input").focus();
  }
}

$("#thread-back")?.addEventListener("click", () => {
  if (state.view === "dm") setView("talk");
  else if (state.view === "notes") {
    state.selectedNotePeer = null;
    renderNotes();
    updateChrome();
  }
});

for (const button of document.querySelectorAll("[data-note-filter]")) {
  button.addEventListener("click", () => {
    state.noteFilter = button.dataset.noteFilter || "all";
    for (const item of document.querySelectorAll("[data-note-filter]")) {
      item.setAttribute("aria-pressed", String(item === button));
    }
    renderNotes();
  });
}

$("#note-composer")?.addEventListener("submit", async (event) => {
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
    await loadNotes({ quiet: true });
    renderNoteThread();
  } catch {
    $("#note-thread-error").textContent = "쪽지를 보내지 못했습니다.";
  } finally {
    state.noteSending = false;
    if ($("#note-thread-send")) $("#note-thread-send").disabled = false;
  }
});

$("#staff-search")?.addEventListener("input", (event) => {
  state.staffQuery = event.currentTarget.value || "";
  if (state.view === "home") renderStaff();
});

boot();
