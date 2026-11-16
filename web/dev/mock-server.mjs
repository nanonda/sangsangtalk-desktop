// Zulip 없이 UI를 확인하는 가짜 API 서버. web/public을 그대로 제공하고 /api/*는 예시 데이터로 답한다.
// 실행: node web/dev/mock-server.mjs [public 경로] [포트]  (기본: ../public, 43190)
// 실제 서버(web/server.mjs)의 응답 형태가 바뀌면 이 파일도 맞춘다. 기준: docs/p0-contract.md
//
// 개발용 흉내 요청(실제 서버에는 없음) — 다른 사람이 한 일처럼 이벤트를 만든다:
//   POST /api/dev/simulate  { "type": "dm" | "general" | "group" | "groupsChanged", "from"?: userId, "groupId"?: n }
//   예) curl -X POST localhost:43190/api/dev/simulate -H "content-type: application/json" -d "{\"type\":\"group\"}"
import http from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
// 내려받기 이름 규칙(?name= 검증)은 실제 서버와 같은 함수를 쓴다.
import { BLOCKED_EXTENSIONS, cleanFileName, contentDisposition, downloadName, isBlockedName } from "../lib/files.mjs";

const root = process.argv[2] || fileURLToPath(new URL("../public/", import.meta.url));
const port = Number(process.argv[3] || 43190);
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) > 0 ? Number(process.env.MAX_UPLOAD_MB) : 100;
// 실제 서버와 같은 규칙: 정확히 "1"일 때만 켠다.
const APP_ONLY_LOGIN = process.env.APP_ONLY_LOGIN === "1";
const PAGE = 100;
const now = Math.floor(Date.now() / 1000);

const me = { userId: 1, email: "me@localhost.localdomain", fullName: "홍길동" };
// web/dev/seed-test-org.mjs가 로컬 Zulip에 만드는 테스트 조직과 같은 10명. title은 "직위 · 부서".
const people = [
  { userId: 2, fullName: "김도윤", role: "member", title: "홍보실장 · 홍보실", avatarUrl: "" },
  { userId: 3, fullName: "이서준", role: "member", title: "홍보기획팀장 · 홍보실", avatarUrl: "" },
  { userId: 4, fullName: "박지민", role: "member", title: "주무관 · 홍보실", avatarUrl: "" },
  { userId: 5, fullName: "최유나", role: "member", title: "주무관 · 홍보실", avatarUrl: "" },
  { userId: 6, fullName: "정하람", role: "member", title: "주무관 · 홍보실", avatarUrl: "" },
  { userId: 7, fullName: "윤성호", role: "member", title: "자치행정과장 · 자치행정과", avatarUrl: "" },
  { userId: 8, fullName: "한지수", role: "member", title: "자치행정팀장 · 자치행정과", avatarUrl: "" },
  { userId: 9, fullName: "오민재", role: "member", title: "주무관 · 자치행정과", avatarUrl: "" },
  { userId: 10, fullName: "강예린", role: "member", title: "주무관 · 자치행정과", avatarUrl: "" },
  { userId: 11, fullName: "서다온", role: "member", title: "주무관 · 자치행정과", avatarUrl: "" },
];
const nameOf = (id) => (id === me.userId ? me.fullName : people.find((p) => p.userId === id)?.fullName || "알 수 없음");
const emailOf = (id) => (id === me.userId ? me.email : `user${id}@localhost.localdomain`);

// ---- 파일 저장소(메모리) ----
const files = new Map(); // path -> { name, type, size, data }
function storeFile(name, type, data) {
  // 실제 Zulip처럼 경로 이름에서 비ASCII를 지운다("회의 자료.pdf" -> ".pdf"). 원래 이름은 ?name=으로만 남는다.
  const stored = name.replace(/[^A-Za-z0-9._ -]/g, "").trim().replace(/\s+/g, "-") || "uploaded-file";
  const filePath = `/user_uploads/2/${randomBytes(2).toString("hex")}/${randomBytes(12).toString("hex")}/${encodeURIComponent(stored)}`;
  files.set(filePath, { name, type, size: data.length, data });
  return { name, size: data.length, type, path: filePath, url: `/api/files${filePath}?name=${encodeURIComponent(name)}` };
}
function attachmentOf(file, { withSize = false } = {}) {
  // 실제 서버와 같이 원래 이름을 ?name=으로 붙인다. 썸네일은 url에 "&inline=1"을 덧붙인다.
  // 실제 서버는 받은 메시지의 크기를 모른다(size: null). 보낸 사람의 전송 응답에만 크기가 있다.
  return { name: file.name, url: `/api/files${file.path}?name=${encodeURIComponent(file.name)}`, size: withSize ? file.size : null, type: file.type };
}
let samplePhoto = null;
try {
  samplePhoto = storeFile("현장사진.png", "image/png", readFileSync(path.join(root, "assets", "turtle-front.png")));
} catch {
  samplePhoto = storeFile("현장사진.png", "image/png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
}
const sampleDoc = storeFile("회의자료.pdf", "application/pdf", Buffer.from("%PDF-1.4\n% 상상톡 mock 회의자료\n%%EOF\n"));

// ---- 메시지 ----
let nextId = 1000;
function msg(fields) {
  const senderId = fields.senderId;
  return {
    id: fields.id ?? nextId++,
    senderId,
    senderName: nameOf(senderId),
    senderEmail: emailOf(senderId),
    timestamp: fields.timestamp ?? Math.floor(Date.now() / 1000),
    topic: fields.topic ?? (fields.kind === "dm" ? "" : "대화"),
    content: fields.content ?? "",
    kind: fields.kind,
    peerId: fields.peerId ?? null,
    groupId: fields.groupId ?? null,
    attachments: fields.attachments ?? [],
    ...(fields.extra || {}),
  };
}

// general: 과거 기록 페이지 넘김을 확인할 수 있도록 250개를 만든다(id 1~250).
const general = [];
for (let i = 1; i <= 245; i += 1) {
  const senderId = 2 + (i % 10);
  general.push(msg({ id: i, senderId, kind: "channel", content: `예전 공지 ${i}번입니다.`, timestamp: now - 86400 * 3 - (250 - i) * 600 }));
}
general.push(
  msg({ id: 246, senderId: 4, kind: "channel", content: "좋은 아침입니다! 오늘 오후 회의 자료 공유드릴게요.", timestamp: now - 86400 - 3000 }),
  msg({ id: 247, senderId: 4, kind: "channel", content: "", attachments: [attachmentOf(sampleDoc)], timestamp: now - 86400 - 2900 }),
  msg({ id: 248, senderId: 2, kind: "channel", content: "3쪽 예산 항목은 어제 수정본 기준인가요?", timestamp: now - 3600 }),
  msg({ id: 249, senderId: 1, kind: "channel", content: "네, 어제 오후 6시 수정본 기준으로 반영했어요.", timestamp: now - 3500 }),
  msg({ id: 250, senderId: 4, kind: "channel", content: "회의실 예약 확인했습니다 🙂", timestamp: now - 1200 }),
);
const dms = {
  2: [
    msg({ id: 301, senderId: 2, kind: "dm", peerId: 2, content: "예산서 수정본 보내드렸습니다.", timestamp: now - 2000 }),
    msg({ id: 302, senderId: 2, kind: "dm", peerId: 2, content: "확인 부탁드려요.", attachments: [attachmentOf(sampleDoc)], timestamp: now - 1900 }),
  ],
  3: [msg({ id: 311, senderId: 1, kind: "dm", peerId: 3, content: "오후 2시에 뵙겠습니다.", timestamp: now - 90000 })],
};
const notes = [
  msg({ id: 401, senderId: 5, kind: "dm", peerId: 5, content: "현장 사진 보냈습니다.", attachments: [attachmentOf(samplePhoto)], timestamp: now - 7200, extra: { note: true, direction: "received", counterpartName: "최유나" } }),
  msg({ id: 402, senderId: 1, kind: "dm", peerId: 5, content: "받았습니다. 고맙습니다.", timestamp: now - 7000, extra: { note: true, direction: "sent", counterpartName: "최유나" } }),
];

// ---- 그룹 ----
let nextGroupId = 20;
const groups = new Map([
  [12, { groupId: 12, name: "홍보 TF", memberIds: [1, 2, 3, 4] }],
  [13, { groupId: 13, name: "자치행정 협의", memberIds: [1, 7, 8, 9, 10, 11] }],
]);
const groupMessages = {
  12: [
    msg({ id: 501, senderId: 2, kind: "group", groupId: 12, content: "이번 주 보도자료 일정 공유합니다.", timestamp: now - 5400 }),
    msg({ id: 502, senderId: 4, kind: "group", groupId: 12, content: "현장 사진 첨부합니다.", attachments: [attachmentOf(samplePhoto)], timestamp: now - 5000 }),
    msg({ id: 503, senderId: 1, kind: "group", groupId: 12, content: "확인했습니다.", timestamp: now - 4800 }),
  ],
  13: [msg({ id: 511, senderId: 7, kind: "group", groupId: 13, content: "다음 주 협의 안건 올려 주세요.", timestamp: now - 9000 })],
};
const myGroups = () => [...groups.values()].filter((g) => g.memberIds.includes(me.userId));
function defaultGroupName(memberIds) {
  const others = memberIds.filter((id) => id !== me.userId).map(nameOf);
  return others.length > 3 ? `${others.slice(0, 3).join(", ")} 외 ${others.length - 3}명` : others.join(", ");
}
// 실제 서버처럼 이름이 겹치면(남의 그룹 포함) " (2)", " (3)"…을 붙인다.
function uniqueGroupName(name) {
  const taken = new Set([...groups.values()].map((g) => g.name));
  if (!taken.has(name)) return name;
  for (let n = 2; n <= 20; n += 1) {
    const candidate = `${name.slice(0, 60 - ` (${n})`.length)} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
  return "";
}
const GROUP_ERRORS = {
  pick: "그룹을 선택하세요.",
  missing: "그룹을 찾지 못했습니다.",
  members: "함께할 직원을 한 명 이상 고르세요.",
  invite: "초대할 직원을 고르세요.",
  name: "그룹 이름을 입력하세요.",
  taken: "같은 이름의 그룹이 많습니다. 다른 이름을 쓰세요.",
};
// 실제 서버의 groupById와 같은 판정: 숫자가 아니면 400, 내가 속하지 않았으면 404.
function myGroup(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) return { status: 400, error: GROUP_ERRORS.pick };
  const group = groups.get(id);
  if (!group || !group.memberIds.includes(me.userId)) return { status: 404, error: GROUP_ERRORS.missing };
  return { group };
}
// 실제 서버의 쪽지 인덱스(web/lib/note-store.mjs) 레코드 형식.
const noteRecords = () => notes.map((n) => ({ messageId: n.id, senderId: n.senderId, recipientId: n.senderId === me.userId ? n.peerId : me.userId, timestamp: n.timestamp }));
const limits = { maxUploadMb: MAX_UPLOAD_MB, blockedExtensions: [...BLOCKED_EXTENSIONS] };

// ---- 근무 상태 ----
const presence = { 2: "active", 3: "idle", 4: "active", 5: "offline", 6: "idle", 7: "active", 8: "offline", 9: "offline", 10: "active", 11: "idle" };
let myStatus = "active";

// ---- 이벤트(긴 폴링) ----
// 클라이언트(쿠키 mock_cid)마다 큐를 따로 둔다. 실제 서버도 로그인 세션마다 Zulip 이벤트 큐가 하나다.
// 큐가 하나뿐이면 먼저 기다리던 클라이언트가 이벤트를 가져가 다른 클라이언트에서는 사라진다.
const CLIENT_IDLE_MS = 10 * 60 * 1000;
const clients = new Map(); // id -> { messages, groupsChanged, waiter, lastSeen }
function clientFor(id) {
  let client = clients.get(id);
  if (!client) {
    client = { messages: [], groupsChanged: false, waiter: null, lastSeen: Date.now() };
    clients.set(id, client);
  }
  client.lastSeen = Date.now();
  return client;
}
function flushClient(client) {
  // 대기 중인 /api/events가 없으면 다음 폴링 때까지 쌓아 둔다(폴링 사이 이벤트 유실 방지).
  if (!client.waiter) return;
  if (!client.messages.length && !client.groupsChanged) return;
  const payload = { messages: client.messages, notes: noteRecords(), notesError: false, reset: false, groupsChanged: client.groupsChanged };
  client.messages = [];
  client.groupsChanged = false;
  const res = client.waiter;
  client.waiter = null;
  json(res, 200, payload);
}
function broadcast(change) {
  const now = Date.now();
  for (const [id, client] of clients) {
    if (!client.waiter && now - client.lastSeen > CLIENT_IDLE_MS) {
      clients.delete(id); // 오래 안 온 클라이언트는 버린다(메모리 상한)
      continue;
    }
    change(client);
    setImmediate(() => flushClient(client));
  }
}
function pushMessage(message) {
  broadcast((client) => client.messages.push(message));
}
function groupsChanged() {
  broadcast((client) => { client.groupsChanged = true; });
}
function clientId(req, res) {
  const match = String(req.headers.cookie || "").match(/(?:^|;\s*)mock_cid=([a-f0-9]{16})(?:;|$)/);
  if (match) return match[1];
  const id = randomBytes(8).toString("hex");
  res.setHeader("set-cookie", `mock_cid=${id}; HttpOnly; SameSite=Lax; Path=/`);
  return id;
}

// ---- 도움 함수 ----
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png" };
function json(res, status, body) {
  if (res.writableEnded) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
async function body(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw || "{}");
}
function page(list, before) {
  const sorted = [...list].sort((a, b) => a.id - b.id);
  const older = before ? sorted.filter((m) => m.id < before) : sorted;
  return { messages: older.slice(-PAGE), hasOlder: older.length > PAGE };
}
function cleanAttachments(list, withSize) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((a) => a && typeof a.path === "string" && files.has(a.path))
    .map((a) => attachmentOf({ ...files.get(a.path), path: a.path }, { withSize }));
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const method = req.method;
  // 모든 응답(첫 페이지 포함)에서 쿠키를 심어, 브라우저가 첫 /api/events 전에 자기 큐를 갖게 한다.
  const cid = clientId(req, res);
  clientFor(cid);
  try {
    // M14: 실제 서버와 같이 APP_ONLY_LOGIN=1이면 데스크톱 앱 헤더 없는 로그인을 거부한다.
    if (p === "/api/login" && method === "POST" && APP_ONLY_LOGIN && req.headers["x-sangsangtalk-client"] !== "desktop") {
      return json(res, 403, { error: "상상톡 로그인은 데스크톱 앱에서만 할 수 있습니다." });
    }
    if (p === "/api/session" || p === "/api/login") return json(res, 200, { ...me, peer: null, limits });
    if (p === "/api/session/status") return json(res, 200, { signedIn: true });
    if (p === "/api/logout") return json(res, 200, { ok: true });
    if (p === "/api/directory") return json(res, 200, { people });
    if (p === "/api/notes") return json(res, 200, { notes: noteRecords() });
    if (p === "/api/notes/messages") return json(res, 200, { messages: notes });

    if (p === "/api/events") {
      const client = clientFor(cid);
      // 같은 클라이언트의 이전 폴링이 아직 열려 있으면 빈 응답으로 닫고 새 폴링으로 바꾼다.
      if (client.waiter) json(client.waiter, 200, { messages: [], notes: noteRecords(), notesError: false, reset: false, groupsChanged: false });
      client.waiter = res;
      const timer = setTimeout(() => {
        if (client.waiter === res) client.waiter = null;
        json(res, 200, { messages: [], notes: noteRecords(), notesError: false, reset: false, groupsChanged: false });
      }, 20000);
      res.on("close", () => {
        clearTimeout(timer);
        if (client.waiter === res) client.waiter = null;
      });
      flushClient(client); // 폴링 사이에 쌓인 이벤트를 바로 넘긴다.
      return;
    }

    // A. 과거 기록
    if (p === "/api/messages" && method === "GET") {
      const view = url.searchParams.get("view");
      const rawBefore = url.searchParams.get("before");
      const before = rawBefore ? Number(rawBefore) : 0;
      if (rawBefore && (!Number.isSafeInteger(before) || before <= 0 || String(before) !== rawBefore)) {
        return json(res, 400, { error: "불러올 위치가 올바르지 않습니다." });
      }
      if (view === "group") {
        const found = myGroup(url.searchParams.get("groupId"));
        if (found.error) return json(res, found.status, { error: found.error });
        return json(res, 200, { view, group: found.group, ...page(groupMessages[found.group.groupId] || [], before) });
      }
      if (view === "dm") {
        const userId = Number(url.searchParams.get("userId"));
        return json(res, 200, { view, peer: people.find((x) => x.userId === userId) || null, ...page(dms[userId] || [], before) });
      }
      return json(res, 200, { view: "general", channel: "general", ...page(general, before) });
    }

    if (p === "/api/messages" && method === "POST") {
      const b = await body(req);
      const content = typeof b.content === "string" ? b.content.trim() : "";
      const attachments = cleanAttachments(b.attachments, false);
      if (!content && !attachments.length) return json(res, 400, { error: "메시지를 입력하세요." });
      let message;
      if (b.view === "group") {
        const found = myGroup(b.groupId);
        if (found.error) return json(res, found.status, { error: found.error });
        const group = found.group;
        message = msg({ senderId: me.userId, kind: "group", groupId: group.groupId, content, attachments });
        (groupMessages[group.groupId] ||= []).push(message);
      } else if (b.view === "dm") {
        const userId = Number(b.userId);
        message = msg({ senderId: me.userId, kind: "dm", peerId: userId, content, attachments });
        if (b.note) {
          message.note = true;
          notes.push({ ...message, direction: "sent", counterpartName: nameOf(userId) });
        } else (dms[userId] ||= []).push(message);
      } else {
        message = msg({ senderId: me.userId, kind: "channel", content, attachments });
        general.push(message);
      }
      // 보낸 사람의 응답에만 크기가 들어간다(저장된 메시지는 size: null).
      return json(res, 200, { message: { ...message, attachments: cleanAttachments(b.attachments, true) } });
    }

    // B. 그룹
    if (p === "/api/groups" && method === "GET") return json(res, 200, { groups: myGroups() });
    if (p === "/api/groups" && method === "POST") {
      const b = await body(req);
      const ids = Array.isArray(b.memberIds) ? b.memberIds.map(Number).filter((id) => people.some((x) => x.userId === id)) : [];
      if (!ids.length) return json(res, 400, { error: GROUP_ERRORS.members });
      const memberIds = [...new Set([me.userId, ...ids])];
      const wanted = typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 60) : defaultGroupName(memberIds);
      const name = uniqueGroupName(wanted);
      if (!name) return json(res, 400, { error: GROUP_ERRORS.taken });
      const group = { groupId: nextGroupId++, name, memberIds };
      groups.set(group.groupId, group);
      groupMessages[group.groupId] = [];
      return json(res, 200, { group });
    }
    const groupMatch = p.match(/^\/api\/groups\/(\d+)(\/members(?:\/me)?)?$/);
    if (groupMatch) {
      const found = myGroup(groupMatch[1]);
      if (found.error) return json(res, found.status, { error: found.error });
      const group = found.group;
      if (!groupMatch[2] && method === "PATCH") {
        const b = await body(req);
        const name = typeof b.name === "string" ? b.name.trim().slice(0, 60) : "";
        if (!name) return json(res, 400, { error: GROUP_ERRORS.name });
        if (name !== group.name && [...groups.values()].some((g) => g.name === name)) {
          return json(res, 400, { error: "같은 이름의 대화방이 있습니다. 다른 이름을 쓰세요." });
        }
        group.name = name;
        return json(res, 200, { group });
      }
      if (groupMatch[2] === "/members" && method === "POST") {
        const b = await body(req);
        const ids = Array.isArray(b.userIds)
          ? b.userIds.map(Number).filter((id) => people.some((x) => x.userId === id) && !group.memberIds.includes(id))
          : [];
        if (!ids.length) return json(res, 400, { error: GROUP_ERRORS.invite });
        group.memberIds = [...new Set([...group.memberIds, ...ids])];
        return json(res, 200, { group });
      }
      if (groupMatch[2] === "/members/me" && method === "DELETE") {
        group.memberIds = group.memberIds.filter((id) => id !== me.userId);
        return json(res, 200, { ok: true });
      }
    }

    // C. 파일
    if (p === "/api/files" && method === "POST") {
      const name = cleanFileName(req.headers["x-file-name"]); // 실제 서버와 같은 정리 규칙
      if (!name) return json(res, 400, { error: "파일 이름이 없습니다." });
      if (isBlockedName(name)) {
        req.resume();
        return json(res, 415, { error: "이 형식의 파일은 보낼 수 없습니다." });
      }
      // 실제 서버는 Zulip tus 업로드에 크기가 필요해 content-length 없는 요청을 411로 거절한다.
      if (req.headers["content-length"] === undefined) {
        req.resume();
        return json(res, 411, { error: "파일 크기를 알 수 없습니다. 다시 시도하세요." });
      }
      const limit = MAX_UPLOAD_MB * 1024 * 1024;
      if (Number(req.headers["content-length"]) > limit) {
        req.resume();
        return json(res, 413, { error: `파일은 ${MAX_UPLOAD_MB}MB까지 보낼 수 있습니다.` });
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) return json(res, 413, { error: `파일은 ${MAX_UPLOAD_MB}MB까지 보낼 수 있습니다.` });
        chunks.push(chunk);
      }
      if (!size) return json(res, 400, { error: "빈 파일은 보낼 수 없습니다." });
      const type = String(req.headers["content-type"] || "").split(";")[0].trim() || "application/octet-stream";
      return json(res, 200, { file: storeFile(name, type, Buffer.concat(chunks)) });
    }
    if (p.startsWith("/api/files/") && method === "GET") {
      const filePath = p.slice("/api/files".length);
      const file = filePath.startsWith("/user_uploads/") ? files.get(filePath) : null;
      if (!file) return json(res, 404, { error: "파일을 찾지 못했습니다." });
      const fileName = downloadName(filePath, url.searchParams.get("name"));
      if (!fileName) return json(res, 415, { error: "이 형식의 파일은 내려받을 수 없습니다." });
      const inline = url.searchParams.get("inline") === "1" && /^image\/(png|jpeg|gif|webp)$/.test(file.type);
      res.writeHead(200, {
        "content-type": file.type || "application/octet-stream",
        "content-length": file.size,
        "content-disposition": contentDisposition(inline ? "inline" : "attachment", fileName),
        "x-content-type-options": "nosniff",
        "cache-control": "private, max-age=300",
      });
      return res.end(file.data);
    }

    // D. 근무 상태
    if (p === "/api/presence" && method === "POST") {
      const b = await body(req);
      if (b.status !== "active" && b.status !== "idle") return json(res, 400, { error: "상태 값을 확인하세요." });
      myStatus = b.status;
      return json(res, 200, { ok: true });
    }
    if (p === "/api/presence" && method === "GET") return json(res, 200, { presence: { ...presence, [me.userId]: myStatus } });

    // 개발용 흉내
    if (p === "/api/dev/simulate" && method === "POST") {
      const b = await body(req);
      const from = Number(b.from) || 2;
      if (b.type === "groupsChanged") {
        const group = { groupId: nextGroupId++, name: "새로 초대된 그룹", memberIds: [me.userId, from, 3] };
        groups.set(group.groupId, group);
        groupMessages[group.groupId] = [];
        groupsChanged();
        return json(res, 200, { ok: true, group });
      }
      let message;
      if (b.type === "group") {
        const group = groups.get(Number(b.groupId)) || myGroups()[0];
        if (!group) return json(res, 400, { error: "그룹이 없습니다." });
        const sender = group.memberIds.find((id) => id !== me.userId) || from;
        message = msg({ senderId: sender, kind: "group", groupId: group.groupId, content: "그룹에 새 메시지가 왔습니다." });
        (groupMessages[group.groupId] ||= []).push(message);
      } else if (b.type === "dm") {
        message = msg({ senderId: from, kind: "dm", peerId: from, content: "1:1 새 메시지입니다.", attachments: b.file ? [attachmentOf(sampleDoc)] : [] });
        (dms[from] ||= []).push(message);
      } else {
        message = msg({ senderId: from, kind: "channel", content: "전체 대화방 새 메시지입니다." });
        general.push(message);
      }
      pushMessage(message);
      return json(res, 200, { ok: true, message });
    }

    if (p.startsWith("/api/")) return json(res, 404, { error: "없는 주소입니다." });
    const file = p === "/" ? "index.html" : p.slice(1);
    if (file.includes("..")) throw new Error("path");
    const data = await readFile(path.join(root, file));
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(data);
  } catch {
    if (res.headersSent) return res.end();
    if (p.startsWith("/api/")) return json(res, 400, { error: "요청을 확인하세요." });
    res.writeHead(404);
    res.end();
  }
}).listen(port, "127.0.0.1", () => console.log(`mock on ${port} (MAX_UPLOAD_MB=${MAX_UPLOAD_MB}${APP_ONLY_LOGIN ? ", APP_ONLY_LOGIN=1" : ""})`));
