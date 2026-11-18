/* 상상톡 관리 화면(/admin) — docs/p2-contract.md C1·C2, 시안 design/admin.html.
 * 사용자 데이터는 textContent로만 넣는다(innerHTML 금지). */

const $ = (selector) => document.querySelector(selector);
const PAGE_USERS = 20;
const PAGE_AUDIT = 50;
const ROLE_LABEL = { owner: "소유자", admin: "관리자", moderator: "중재자", member: "일반", guest: "손님" };
const ACTION_LABEL = {
  login: "로그인",
  login_fail: "로그인 실패",
  logout: "로그아웃",
  file_download: "파일 내려받기",
  file_upload: "파일 올리기",
  recall: "메시지 회수",
  admin_users_list: "직원 목록 보기",
  admin_user_create: "직원 추가",
  admin_user_update: "직원 정보 수정",
  admin_user_deactivate: "퇴직 처리",
  admin_user_reactivate: "복귀 처리",
  admin_password: "비밀번호 초기화 요청",
  admin_dept_sync: "부서방 동기화",
  admin_dept_sync_preview: "부서방 미리 보기",
  admin_audit_view: "감사 로그 보기",
  admin_user_logout: "세션 끊기",
  password_change: "비밀번호 변경",
};

const state = {
  me: null,
  users: [],
  preview: null, // 부서방 동기화 미리 보기(GET dryRun=1)
  audit: [],
  userPage: 1,
  auditPage: 1,
  auditGen: 0,
  editing: null, // 수정 중인 직원(null이면 추가)
  pending: null, // 퇴직·복귀 확인 중인 { user, action }
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(id) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "i");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#${id}`);
  svg.append(use);
  return svg;
}

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
    showGate("로그인이 끝났습니다. 상상톡에서 다시 로그인하세요.", true);
    throw new ApiError("다시 로그인해 주세요.", 401);
  }
  // 잠겼거나(423) 비밀번호를 먼저 바꿔야 하면(403) 메신저에서 처리한다.
  if ((response.status === 423 && data.locked) || (response.status === 403 && data.mustChangePassword)) {
    location.href = "/";
    throw new ApiError("", response.status);
  }
  if (!response.ok) throw new ApiError(data.error || "요청을 처리하지 못했습니다.", response.status);
  return data;
}

function showGate(text, link) {
  $("#adm").hidden = true;
  $("#gate").hidden = false;
  $("#gate-text").textContent = text;
  $("#gate-link").hidden = !link;
}

let toastTimer = 0;
function toast(text, { error = false } = {}) {
  const node = $("#toast");
  window.clearTimeout(toastTimer);
  node.textContent = text;
  node.classList.toggle("err", error);
  toastTimer = window.setTimeout(() => {
    node.textContent = "";
  }, error ? 8000 : 4000);
}

function localId(loginId) {
  return String(loginId || "").split("@")[0];
}

function domainOf(loginId) {
  const parts = String(loginId || "").split("@");
  return parts.length > 1 ? parts.slice(1).join("@") : "";
}

function loginDomain() {
  return (typeof state.me?.loginDomain === "string" && state.me.loginDomain.trim()) || domainOf(state.me?.email) || "";
}

function nameOf(userId) {
  return state.users.find((user) => user.userId === userId)?.fullName || (userId ? `#${userId}` : "—");
}

function shortDate(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : `${date.getMonth() + 1}월 ${date.getDate()}일`;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function dateInput(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function avatarNode(user) {
  const node = el("span", "av turtle");
  node.setAttribute("aria-hidden", "true");
  const img = document.createElement("img");
  img.src = "/assets/turtle-front.png";
  img.alt = "";
  node.append(img);
  return node;
}

function pager(container, total, size, page, onPage) {
  container.replaceChildren();
  const pages = Math.max(1, Math.ceil(total / size));
  if (pages <= 1) return;
  const button = (label, target, { current = false, aria = "" } = {}) => {
    const node = el("button", "", label);
    node.type = "button";
    if (aria) node.setAttribute("aria-label", aria);
    if (current) node.setAttribute("aria-current", "page");
    node.disabled = target < 1 || target > pages;
    node.addEventListener("click", () => onPage(target));
    return node;
  };
  container.append(button("‹", page - 1, { aria: "이전 쪽" }));
  const shown = new Set([1, pages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pages));
  let last = 0;
  for (const n of [...shown].sort((a, b) => a - b)) {
    if (n - last > 1) container.append(el("span", "gap", "…"));
    container.append(button(String(n), n, { current: n === page, aria: `${n}쪽` }));
    last = n;
  }
  container.append(button("›", page + 1, { aria: "다음 쪽" }));
}

/* ── 화면 전환(#users #dept #audit) ── */

function currentView() {
  const view = location.hash.slice(1);
  return ["users", "dept", "audit"].includes(view) ? view : "users";
}

function route() {
  const view = currentView();
  for (const name of ["users", "dept", "audit"]) {
    $(`#view-${name}`).hidden = name !== view;
    const link = $(`#nav-${name}`);
    if (name === view) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  if (view === "users") renderUsers();
  if (view === "dept") {
    loadPreview();
    loadSyncInfo();
  }
  if (view === "audit") loadAudit();
}

window.addEventListener("hashchange", route);

/* ── C1 직원 관리 ── */

async function loadUsers() {
  const data = await api("GET", "/api/admin/users");
  state.users = Array.isArray(data.users) ? data.users : [];
  renderFilters();
  renderNavCounts();
}

function departments() {
  return [...new Set(state.users.map((user) => user.department).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko"));
}

function renderFilters() {
  const select = $("#user-dept");
  const keep = select.value;
  select.replaceChildren(new Option("모든 부서", ""));
  for (const dept of departments()) select.append(new Option(dept, dept));
  select.value = departments().includes(keep) ? keep : "";
  const datalist = $("#dept-options");
  datalist.replaceChildren(...departments().map((dept) => new Option(dept)));
  const auditUser = $("#audit-user");
  const keepUser = auditUser.value;
  auditUser.replaceChildren(new Option("모든 직원", ""));
  for (const user of [...state.users].sort((a, b) => a.fullName.localeCompare(b.fullName, "ko"))) auditUser.append(new Option(user.fullName, String(user.userId)));
  auditUser.value = keepUser;
}

function renderNavCounts() {
  $("#nav-users-n").textContent = String(state.users.filter((user) => user.active).length);
  $("#nav-dept-n").textContent = String(departments().length);
}

function filteredUsers() {
  const query = $("#user-q").value.trim().toLowerCase();
  const dept = $("#user-dept").value;
  const which = $("#user-state").value;
  return state.users
    .filter((user) => which === "all" || (which === "active" ? user.active : !user.active))
    .filter((user) => !dept || user.department === dept)
    .filter((user) => !query || user.fullName.toLowerCase().includes(query) || String(user.loginId).toLowerCase().includes(query))
    .sort((a, b) => Number(b.active) - Number(a.active) || (a.department || "").localeCompare(b.department || "", "ko") || a.fullName.localeCompare(b.fullName, "ko"));
}

function renderUsers() {
  const rows = $("#user-rows");
  const list = filteredUsers();
  const active = state.users.filter((user) => user.active).length;
  $("#user-count").textContent = `재직 ${active}명 · 퇴직 ${state.users.length - active}명`;
  const pages = Math.max(1, Math.ceil(list.length / PAGE_USERS));
  state.userPage = Math.min(state.userPage, pages);
  rows.replaceChildren();
  if (!list.length) {
    const tr = el("tr");
    const td = el("td", "empty", state.users.length ? "조건에 맞는 직원이 없습니다." : "직원이 없습니다.");
    td.colSpan = 7;
    tr.append(td);
    rows.append(tr);
  }
  for (const user of list.slice((state.userPage - 1) * PAGE_USERS, state.userPage * PAGE_USERS)) {
    const tr = el("tr", user.active ? "" : "inactive");
    const name = el("span", "pn");
    name.append(avatarNode(user), el("b", "", user.fullName));
    if (user.userId === state.me.userId) name.append(el("span", "pill member", "나"));
    const id = el("code", "", localId(user.loginId));
    id.title = user.loginId;
    const role = el("span", `pill ${user.role || "member"}`, ROLE_LABEL[user.role] || "일반");
    const status = el("span");
    status.append(el("span", user.active ? "pill on" : "pill off", user.active ? "재직" : user.deactivatedAt ? `퇴직 · ${shortDate(user.deactivatedAt)}` : "퇴직"));
    if (user.active && user.mustChangePassword) {
      const wait = el("span", "pill warn", "비밀번호 변경 대기");
      wait.title = "다음 로그인 때 새 비밀번호를 정해야 합니다.";
      status.append(" ", wait);
    }
    const acts = el("span", "ra");
    const action = (label, handler, danger) => {
      const button = el("button", danger ? "txt-btn danger" : "txt-btn", label);
      button.type = "button";
      button.setAttribute("aria-label", `${user.fullName} ${label}`);
      button.addEventListener("click", () => handler(user, button));
      acts.append(button);
    };
    if (user.active) {
      action("수정", openUserDialog);
      action("비밀번호", openPasswordDialog);
      if (user.userId !== state.me.userId) action("세션 끊기", (target) => askState(target, "logout"));
      // 관리자·소유자는 권한부터 내려야 퇴직 처리할 수 있다. 나 자신도 안 된다.
      if (user.role !== "admin" && user.role !== "owner" && user.userId !== state.me.userId) action("퇴직 처리", (target) => askState(target, "deactivate"), true);
    } else {
      action("복귀 처리", (target) => askState(target, "reactivate"));
    }
    const cells = [name, id, user.department || "—", user.position || "—", role, status, acts];
    cells.forEach((cell, index) => {
      const td = el("td", index === 6 ? "r" : "");
      td.append(cell);
      tr.append(td);
    });
    rows.append(tr);
  }
  pager($("#user-pager"), list.length, PAGE_USERS, state.userPage, (page) => {
    state.userPage = page;
    renderUsers();
  });
}

for (const id of ["#user-q", "#user-dept", "#user-state"]) {
  $(id).addEventListener("input", () => {
    state.userPage = 1;
    renderUsers();
  });
}

/* 추가·수정 패널 */
let dialogOpener = null;

function openUserDialog(user = null, opener = null) {
  state.editing = user;
  dialogOpener = opener || document.activeElement;
  const editing = Boolean(user);
  $("#user-dialog-title").textContent = editing ? `직원 정보 수정 · ${user.fullName}` : "직원 추가";
  $("#user-info").hidden = editing;
  $("#f-name").value = user?.fullName || "";
  $("#f-id-field").hidden = editing;
  $("#f-id").value = "";
  $("#f-domain").textContent = loginDomain() ? `@${loginDomain()}` : "@(도메인 없음)";
  $("#f-dept").value = user?.department || "";
  $("#f-pos").value = user?.position || "";
  $("#f-role-field").hidden = !editing;
  $("#f-role").value = user?.role || "member";
  const self = editing && user.userId === state.me.userId;
  // 소유자 권한은 소유자만 주거나 바꿀 수 있다.
  const iAmOwner = state.me.role === "owner";
  const targetOwner = user?.role === "owner";
  $("#f-role").querySelector('option[value="owner"]').hidden = !iAmOwner && !targetOwner;
  $("#f-role").disabled = self || (targetOwner && !iAmOwner);
  $("#f-role-help").textContent = self ? "내 권한은 바꿀 수 없습니다."
    : targetOwner && !iAmOwner ? "소유자 권한은 소유자만 바꿀 수 있습니다."
      : "관리자·소유자는 관리 화면에 들어올 수 있습니다.";
  $("#f-pw-field").hidden = editing;
  $("#f-pw").value = "";
  const must = $("#f-must");
  $("#f-must-field").hidden = !editing || self;
  must.checked = Boolean(user?.mustChangePassword);
  // 계약은 켜기만 한다(끄는 것은 직원이 비밀번호를 바꾸면 서버가 한다).
  must.disabled = Boolean(user?.mustChangePassword);
  $("#f-must-help").textContent = user?.mustChangePassword
    ? "이미 요청했습니다. 직원이 비밀번호를 바꾸면 자동으로 풀립니다."
    : "켜면 이 직원은 다음에 로그인할 때 새 비밀번호를 정해야 메신저를 쓸 수 있습니다.";
  $("#f-note").hidden = false;
  $("#f-note").textContent = editing ? "부서를 바꾸면 다음 동기화 때 부서 대화방도 옮겨집니다." : "저장하면 부서 대화방에도 자동으로 들어갑니다(다음 동기화 때).";
  $("#user-error").textContent = "";
  $("#user-submit").textContent = editing ? "저장" : "직원 추가";
  $("#user-submit").disabled = false;
  $("#user-dialog").showModal();
  $("#f-name").focus();
}

$("#user-add").addEventListener("click", (event) => openUserDialog(null, event.currentTarget));
$("#user-close").addEventListener("click", () => $("#user-dialog").close());
$("#user-cancel").addEventListener("click", () => $("#user-dialog").close());
$("#user-dialog").addEventListener("close", () => {
  if (dialogOpener?.isConnected) dialogOpener.focus();
});

$("#user-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const editing = state.editing;
  const error = $("#user-error");
  const fullName = $("#f-name").value.trim();
  const department = $("#f-dept").value.trim();
  const position = $("#f-pos").value.trim();
  if (!fullName) {
    error.textContent = "이름을 입력하세요.";
    $("#f-name").focus();
    return;
  }
  let body;
  if (editing) {
    body = { fullName, department, position };
    if (!$("#f-role").disabled && $("#f-role").value !== editing.role) body.role = $("#f-role").value;
    if (!$("#f-must-field").hidden && !$("#f-must").disabled && $("#f-must").checked) body.mustChangePassword = true;
  } else {
    const id = $("#f-id").value.trim();
    const password = $("#f-pw").value;
    if (!loginDomain()) {
      error.textContent = "로그인 ID 도메인을 알 수 없습니다. 서버의 LOGIN_DOMAIN 설정을 확인하세요.";
      return;
    }
    if (!id || /[\s@]/.test(id)) {
      error.textContent = "로그인 ID(사번)를 공백·@ 없이 입력하세요.";
      $("#f-id").focus();
      return;
    }
    if (password.length < 8) {
      error.textContent = "첫 비밀번호는 8자 이상이어야 합니다.";
      $("#f-pw").focus();
      return;
    }
    body = { fullName, loginId: `${id}@${loginDomain()}`, department, position, password };
  }
  const submit = $("#user-submit");
  submit.disabled = true;
  submit.textContent = "저장하는 중…";
  error.textContent = "";
  try {
    const data = editing
      ? await api("PATCH", `/api/admin/users/${editing.userId}`, body)
      : await api("POST", "/api/admin/users", body);
    $("#f-pw").value = "";
    await loadUsers();
    $("#user-dialog").close();
    renderUsers();
    toast(editing ? `${data.user?.fullName || fullName} 님 정보를 고쳤습니다.` : `${data.user?.fullName || fullName} 님을 추가했습니다.`);
  } catch (failure) {
    if (failure.status === 401) return;
    error.textContent = failure.message || "저장하지 못했습니다.";
  } finally {
    submit.disabled = false;
    submit.textContent = editing ? "저장" : "직원 추가";
  }
});

/* 비밀번호(방식 결정 전: 서버 관리자에게 요청) */
function openPasswordDialog(user, opener) {
  dialogOpener = opener || document.activeElement;
  $("#pw-title").textContent = `비밀번호 초기화 · ${user.fullName}`;
  $("#pw-text").value = `${user.fullName} · ${localId(user.loginId)} · ${user.department || "부서 없음"} — 비밀번호 초기화`;
  $("#pw-copied").textContent = "";
  $("#pw-dialog").showModal();
  $("#pw-copy").focus();
}

$("#pw-copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("#pw-text").value);
    $("#pw-copied").textContent = "복사했습니다. 서버 관리자에게 전달하세요.";
  } catch {
    $("#pw-text").select();
    $("#pw-copied").textContent = "복사하지 못했습니다. 글을 직접 복사하세요.";
  }
});
$("#pw-dialog").addEventListener("close", () => {
  if (dialogOpener?.isConnected) dialogOpener.focus();
});

/* 퇴직·복귀 확인 */
function askState(user, action) {
  state.pending = { user, action };
  dialogOpener = document.activeElement;
  const deactivate = action === "deactivate";
  const logout = action === "logout";
  $("#state-title").textContent = logout ? `${user.fullName} 님의 세션을 끊을까요?` : deactivate ? `${user.fullName} 님을 퇴직 처리할까요?` : `${user.fullName} 님을 복귀 처리할까요?`;
  $("#state-text").textContent = logout
    ? "열려 있는 상상톡 창이 모두 로그아웃됩니다.\n다시 로그인하면 계속 쓸 수 있습니다.\n도용이 의심되면 비밀번호도 바꾸고, 서버 관리자에게 API 키 재발급을 요청하세요."
    : deactivate
      ? "바로 로그아웃되고 다시 로그인할 수 없습니다.\n주고받은 대화와 파일은 그대로 남습니다.\n부서 대화방에서는 다음 동기화 때 빠집니다.\n나중에 복귀 처리로 되살릴 수 있습니다."
      : "다시 로그인할 수 있게 됩니다.\n부서 대화방에는 다음 동기화 때 들어갑니다.";
  $("#state-ok").textContent = logout ? "세션 끊기" : deactivate ? "퇴직 처리" : "복귀 처리";
  $("#state-ok").className = deactivate || logout ? "btn danger" : "btn primary";
  $("#state-ok").disabled = false;
  $("#state-error").textContent = "";
  $("#state-dialog").showModal();
  $("#state-cancel").focus();
}

$("#state-cancel").addEventListener("click", () => $("#state-dialog").close());
$("#state-dialog").addEventListener("close", () => {
  state.pending = null;
  if (dialogOpener?.isConnected) dialogOpener.focus();
});
$("#state-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const pending = state.pending;
  if (!pending) return;
  const button = $("#state-ok");
  button.disabled = true;
  try {
    const data = await api("POST", `/api/admin/users/${pending.user.userId}/${pending.action}`);
    if (pending.action === "logout") {
      $("#state-dialog").close();
      const ended = Number(data.ended) || 0;
      toast(ended ? `${pending.user.fullName} 님의 세션 ${ended}개를 끊었습니다.` : `${pending.user.fullName} 님은 열린 세션이 없었습니다.`);
      return;
    }
    await loadUsers();
    $("#state-dialog").close();
    renderUsers();
    toast(pending.action === "deactivate" ? `${pending.user.fullName} 님을 퇴직 처리했습니다.` : `${pending.user.fullName} 님을 복귀 처리했습니다.`);
  } catch (failure) {
    if (failure.status === 401) return;
    $("#state-error").textContent = failure.message || "처리하지 못했습니다.";
    button.disabled = false;
  }
});

/* ── C1 부서 대화방 ── */

/* 미리 보기(GET dryRun=1): 관리자가 들어 있지 않은 부서방도 정확하다. 바꾸지 않는다. */
async function loadPreview() {
  $("#dept-rows").replaceChildren(emptyRow(4, "미리 보기를 불러오는 중…"));
  try {
    state.preview = await api("GET", "/api/admin/dept-sync?dryRun=1");
  } catch (failure) {
    if (failure.status === 401) return;
    state.preview = null;
    $("#dept-rows").replaceChildren(emptyRow(4, failure.message || "미리 보기를 가져오지 못했습니다."));
    return;
  }
  renderDept();
}

function emptyRow(span, text) {
  const tr = el("tr");
  const td = el("td", "empty", text);
  td.colSpan = span;
  tr.append(td);
  return tr;
}

function namesText(ids, sign) {
  const names = ids.slice(0, 3).map((id) => {
    const user = state.users.find((item) => item.userId === id);
    return user && !user.active ? `${user.fullName}(퇴직)` : nameOf(id);
  });
  return `${sign}${ids.length} ${names.join(", ")}${ids.length > 3 ? " 외" : ""}`;
}

function renderDept() {
  const rows = $("#dept-rows");
  rows.replaceChildren();
  const details = Array.isArray(state.preview?.details) ? state.preview.details : [];
  $("#nav-dept-n").textContent = String(details.length || departments().length);
  if (!details.length) {
    rows.append(emptyRow(4, "부서가 적힌 직원이 없습니다."));
  }
  for (const item of details) {
    const add = Array.isArray(item.add) ? item.add : [];
    const remove = Array.isArray(item.remove) ? item.remove : [];
    const members = state.users.filter((user) => user.active && user.department === item.name).length;
    const tr = el("tr");
    const nameCell = el("td");
    nameCell.append(el("b", "", item.name));
    const missing = item.action === "create" || item.action === "conflict";
    const roomCell = el("td", "", item.action === "restore" ? `${item.name} (보관됨)` : missing ? "없음" : item.name);
    if (missing) roomCell.style.color = "var(--ink-3)";
    const diffCell = el("td");
    if (item.action === "create") diffCell.append(el("span", "diff new", `새로 만듦 · ${add.length}명`));
    else if (item.action === "restore") diffCell.append(el("span", "diff new", `다시 열기 · ${add.length ? `+${add.length}명` : "인원 그대로"}`));
    else if (item.action === "conflict") diffCell.append(el("span", "diff rm", "같은 이름의 일반 그룹이 있어 만들 수 없음"));
    if (item.action === "update" || item.action === "restore") {
      if (add.length && item.action === "update") diffCell.append(el("span", "diff add", namesText(add, "+")));
      if (remove.length) diffCell.append(el("span", "diff rm", namesText(remove, "−")));
    }
    if (item.action === "none") diffCell.append(el("span", "diff same", "바뀌는 것 없음"));
    tr.append(nameCell, roomCell, el("td", "", `${members}명`), diffCell);
    rows.append(tr);
  }
  const conflicts = Array.isArray(state.preview?.conflicts) ? state.preview.conflicts : [];
  const note = $("#dept-note");
  note.hidden = !conflicts.length;
  note.textContent = conflicts.length ? `이름이 겹치는 일반 그룹(${conflicts.join(", ")})의 이름을 바꾼 뒤 다시 동기화하세요.` : "";
}

function formatTime(iso, { seconds = false } = {}) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const day = `${date.getMonth() + 1}월 ${date.getDate()}일`;
  if (seconds) return `${day} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
  return `${day} ${new Intl.DateTimeFormat("ko-KR", { hour: "numeric", minute: "2-digit" }).format(date)}`;
}

/* 마지막 동기화는 감사 로그의 최근 admin_dept_sync로 보여 준다. */
async function loadSyncInfo() {
  try {
    const data = await api("GET", "/api/admin/audit?action=admin_dept_sync");
    const last = (Array.isArray(data.entries) ? data.entries : []).find((entry) => entry.ok !== false);
    $("#sync-last").textContent = last ? `마지막 동기화: ${formatTime(last.at)} (${nameOf(last.userId)})` : "마지막 동기화: 기록 없음";
  } catch {
    // 표시만 못 한다.
  }
}

$("#sync-run").addEventListener("click", async () => {
  const button = $("#sync-run");
  button.disabled = true;
  button.querySelector("span").textContent = "동기화하는 중…";
  $("#sync-error").textContent = "";
  try {
    const data = await api("POST", "/api/admin/dept-sync");
    $("#sync-result-title").textContent = `동기화를 마쳤습니다 · ${new Intl.DateTimeFormat("ko-KR", { hour: "numeric", minute: "2-digit" }).format(new Date())}`;
    const restored = Number(data.restored) || 0;
    $("#sync-created").textContent = `${Number(data.created) || 0}개${restored ? ` (다시 연 대화방 ${restored}개)` : ""}`;
    $("#sync-added").textContent = `${Number(data.added) || 0}명`;
    $("#sync-removed").textContent = `${Number(data.removed) || 0}명`;
    $("#sync-result").hidden = false;
    if (Array.isArray(data.conflicts) && data.conflicts.length) $("#sync-error").textContent = `만들지 못한 부서: ${data.conflicts.join(", ")} (같은 이름의 일반 그룹이 있음)`;
    await loadUsers();
    loadPreview();
    loadSyncInfo();
  } catch (failure) {
    if (failure.status === 401) return;
    $("#sync-error").textContent = failure.message || "동기화하지 못했습니다.";
  } finally {
    button.disabled = false;
    button.querySelector("span").textContent = "지금 동기화";
  }
});

/* ── C2 감사 로그 ── */

function auditTarget(entry) {
  const target = String(entry.target ?? "");
  if (!target) return "—";
  if (entry.action === "recall" || entry.action === "file_upload") return /^\d+$/.test(target) ? `메시지 #${target}` : target;
  if (entry.action === "file_download") {
    const last = target.split("/").pop() || target;
    try {
      return decodeURIComponent(last);
    } catch {
      return last;
    }
  }
  if (entry.action === "admin_dept_sync") {
    const [made, added, removed] = target.split("/");
    const [created, restored] = String(made || "0").split("+");
    return `대화방 ${created || 0}${Number(restored) ? `(+다시 연 ${restored})` : ""} · +${added || 0} · −${removed || 0}`;
  }
  if (entry.action === "admin_user_logout") {
    const [id, ended] = target.split(":");
    return `${nameOf(Number(id))} · 세션 ${Number(ended) || 0}개`;
  }
  if (entry.action === "logout" && target === "unlock_failed") return "잠금 해제 5회 실패";
  if (entry.action.startsWith("admin_") && /^\d+$/.test(target)) return nameOf(Number(target));
  return target;
}

async function loadAudit() {
  const gen = ++state.auditGen;
  const params = new URLSearchParams();
  const from = $("#audit-from").value;
  const to = $("#audit-to").value;
  const user = $("#audit-user").value;
  const action = $("#audit-action").value;
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (user) params.set("userId", user);
  // "관리 작업"은 서버의 접두어 필터(admin_*)로 거른다.
  if (action) params.set("action", action === "admin" ? "admin_*" : action);
  $("#audit-count").textContent = "불러오는 중…";
  try {
    const data = await api("GET", `/api/admin/audit?${params}`);
    if (gen !== state.auditGen) return;
    let entries = Array.isArray(data.entries) ? data.entries : [];
    state.audit = entries;
    state.auditPage = 1;
    renderAudit();
  } catch (failure) {
    if (failure.status === 401 || gen !== state.auditGen) return;
    $("#audit-count").textContent = "";
    state.audit = [];
    renderAudit(failure.message || "감사 로그를 가져오지 못했습니다.");
  }
}

function renderAudit(errorText = "") {
  const rows = $("#audit-rows");
  rows.replaceChildren();
  const list = state.audit;
  // 서버는 최신순 1000건까지만 준다.
  if (!errorText) $("#audit-count").textContent = list.length >= 1000 ? "최근 1000건만 표시 · 기간을 좁혀 보세요" : `${list.length}건`;
  if (!list.length) {
    const tr = el("tr");
    const td = el("td", "empty", errorText || "조건에 맞는 기록이 없습니다.");
    td.colSpan = 6;
    tr.append(td);
    rows.append(tr);
  }
  for (const entry of list.slice((state.auditPage - 1) * PAGE_AUDIT, state.auditPage * PAGE_AUDIT)) {
    const tr = el("tr");
    const who = entry.action === "login_fail" && !entry.userId ? localId(entry.target) || "—" : nameOf(entry.userId);
    const ip = el("code", "", entry.ip || "—");
    const action = el("span");
    action.append(el("span", "act", entry.action || ""), ACTION_LABEL[entry.action] || (String(entry.action).startsWith("admin_") ? "관리 작업" : ""));
    const ok = entry.ok !== false;
    const result = el("span", ok ? "pill ok" : "pill fail", ok ? "성공" : "실패");
    const cells = [el("span", "nowrap", formatTime(entry.at, { seconds: true })), who, ip, action, entry.action === "login_fail" ? "—" : auditTarget(entry), result];
    for (const cell of cells) {
      const td = el("td");
      td.append(cell);
      tr.append(td);
    }
    rows.append(tr);
  }
  pager($("#audit-pager"), list.length, PAGE_AUDIT, state.auditPage, (page) => {
    state.auditPage = page;
    renderAudit();
    $("#main").scrollTop = 0;
  });
}

for (const id of ["#audit-from", "#audit-to", "#audit-user", "#audit-action"]) {
  $(id).addEventListener("change", loadAudit);
}

/* ── 시작 ── */

async function boot() {
  let me;
  try {
    const response = await fetch("/api/session");
    if (response.status === 401) {
      showGate("로그인이 필요합니다. 상상톡에서 관리자 계정으로 로그인하세요.", true);
      return;
    }
    me = await response.json();
  } catch {
    showGate("서버에 연결하지 못했습니다.", false);
    return;
  }
  if (!me?.isAdmin) {
    showGate("관리자만 볼 수 있습니다.", true);
    return;
  }
  if (me.locked || me.mustChangePassword) {
    location.href = "/";
    return;
  }
  state.me = me;
  $("#me-role").textContent = ROLE_LABEL[me.role] || "관리자";
  const today = new Date();
  $("#audit-from").value = dateInput(new Date(today.getFullYear(), today.getMonth(), 1));
  $("#audit-to").value = dateInput(today);
  try {
    await loadUsers();
  } catch (failure) {
    if (failure.status === 401) return;
    showGate(failure.status === 403 ? "관리자만 볼 수 있습니다." : failure.message || "관리 정보를 가져오지 못했습니다.", true);
    return;
  }
  const self = state.users.find((user) => user.userId === me.userId);
  $("#me-who").textContent = [me.fullName, self?.position].filter(Boolean).join(" · ");
  $("#gate").hidden = true;
  $("#adm").hidden = false;
  route();
}

boot();
