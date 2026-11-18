// Zulip 없이 UI를 확인하는 가짜 API 서버. web/public을 그대로 제공하고 /api/*는 예시 데이터로 답한다.
// 실행: node web/dev/mock-server.mjs [public 경로] [포트]  (기본: ../public, 43190)
// 실제 서버(web/server.mjs)의 응답 형태가 바뀌면 이 파일도 맞춘다. 기준: docs/p0-contract.md, docs/p2-contract.md
//
// 개발용 흉내 요청(실제 서버에는 없음) — 다른 사람이 한 일처럼 이벤트를 만든다:
//   POST /api/dev/simulate  { "type": "dm" | "general" | "group" | "groupsChanged", "from"?: userId, "groupId"?: n }
//     2-A: "mention"(나를 멘션한 그룹 메시지), "read"(from이 그 대화의 내 메시지를 읽음 — 이벤트 없음, 숫자는 다시 읽어야 바뀜),
//          "edit" / "recall"(from이 보낸 최근 메시지를 고치거나 회수 → updated 이벤트), "notice"(그룹 공지 바뀜 → noticesChanged)
//     2-B: "typing"(from이 입력 중 — view "dm"|"group"|"general", groupId, op "start"|"stop"),
//          "reaction"(from이 그룹 12의 마지막 메시지에 thumbs_up → updated), "status"(from의 수동 상태를 "meeting"으로)
//   역할: MOCK_ROLE=member 로 띄우면 내가 관리자가 아니다(전체 대화방 공지 등록 403 확인용). 기본은 admin.
//   2-C: 잠금 풀기 비밀번호는 "test"(5번 틀리면 로그아웃 응답). MOCK_AUTO_LOCK=분(기본 30, 0은 끔), MOCK_WATERMARK=0이면 워터마크 끔.
//        관리자 화면 /admin 은 web/public/admin.html (관리자가 아니면 403).
//     simulate "vote"(from이 그룹 12 투표의 첫 항목에 투표 → updated)
//     simulate "rateLimit" { count }: 다음 /api 요청 count개(기본 1)를 Zulip 429처럼 거절(잠금 풀기면 30분 차단 로그아웃).
//   MOCK_MUST_CHANGE=1: 내가 비밀번호를 먼저 바꿔야 하는 상태로 시작(다른 /api는 403).
//   3단계(docs/p3-contract.md):
//     "reply"(from이 내 최근 메시지에 답장 → 활동), "keyword"(from이 키워드가 든 메시지를 보냄, alerted),
//     "urgent"(from이 그룹 중요 메시지를 보냄, groupId 선택), "reactMine"(from이 내 최근 메시지에 👏 → 활동),
//     "ack"(from이 확인 요청 공지를 확인 → noticesChanged), "prefs"(다른 기기에서 설정을 바꾼 것처럼 prefsChanged),
//     "policy"(관리자 정책이 바뀐 것처럼 policyChanged)
//   예) curl -X POST localhost:43190/api/dev/simulate -H "content-type: application/json" -d "{\"type\":\"group\"}"
import http from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
// 내려받기 이름 규칙(?name= 검증)은 실제 서버와 같은 함수를 쓴다.
import { cleanFileName, contentDisposition, downloadName, extensionOf } from "../lib/files.mjs";
// 3단계 설정·정책 검사도 실제 서버와 같은 함수를 쓴다.
import {
  applyPolicyPatch, applyPrefsPatch, blockedBy, blockedExtensionsDotted, cleanKeyword, emptyPolicy, KEYWORD_ERRORS, KEYWORD_MAX,
  POLICY_BLOCKED_ERROR, presentPolicy, presentPrefs,
} from "../lib/settings.mjs";
import { AVATAR_ERRORS, AVATAR_MAX_BYTES, imageType, singleFilePart } from "../lib/avatar.mjs";

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
    // 2단계 필드(docs/p2-contract.md). mentionedMe·starred·unreadCount·reactions[].mine은 응답 때 present()가 채운다.
    edited: false,
    recalled: false,
    replyTo: fields.replyTo ?? null,
    mentions: fields.mentions ?? [],
    reactions: [],
    poll: null,
    todo: null,
    // 3단계: alerted(키워드, 응답 때 present()가 채운다), urgent(중요 메시지)
    alerted: false,
    urgent: false,
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
// dept: true는 부서 대화방(A6). 사용자가 나가기·초대·이름 변경을 할 수 없다(403).
const groups = new Map([
  [12, { groupId: 12, name: "홍보 TF", memberIds: [1, 2, 3, 4], dept: false }],
  [13, { groupId: 13, name: "자치행정 협의", memberIds: [1, 7, 8, 9, 10, 11], dept: false }],
  [14, { groupId: 14, name: "홍보실", memberIds: [1, 2, 3, 4, 5, 6], dept: true }],
]);
const groupMessages = {
  12: [
    msg({ id: 501, senderId: 2, kind: "group", groupId: 12, content: "이번 주 보도자료 일정 공유합니다. 목요일 오전 배포 예정입니다.", timestamp: now - 5400, extra: { edited: true } }),
    msg({ id: 502, senderId: 4, kind: "group", groupId: 12, content: "현장 사진 첨부합니다.", attachments: [attachmentOf(samplePhoto)], timestamp: now - 5000 }),
    msg({ id: 503, senderId: 1, kind: "group", groupId: 12, content: "확인했습니다.", timestamp: now - 4800 }),
    msg({ id: 504, senderId: 3, kind: "group", groupId: 12, content: "회수된 메시지입니다", timestamp: now - 4700, extra: { recalled: true } }),
    msg({
      id: 505, senderId: 3, kind: "group", groupId: 12, content: "@홍길동 이 사진 보도자료에 써도 될까요?", timestamp: now - 4600,
      replyTo: { id: 502, senderId: 4, senderName: "박지민", excerpt: "현장 사진 첨부합니다." }, mentions: [1],
    }),
  ],
  13: [msg({ id: 511, senderId: 7, kind: "group", groupId: 13, content: "다음 주 협의 안건 올려 주세요.", timestamp: now - 9000 })],
  14: [msg({ id: 521, senderId: 2, kind: "group", groupId: 14, content: "홍보실 부서 대화방입니다.", timestamp: now - 20000 })],
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
// D1: 차단 목록은 서버 기본 + 관리자 정책 추가분(policy)
const limits = () => ({ maxUploadMb: MAX_UPLOAD_MB, blockedExtensions: blockedExtensionsDotted(policy) });
const MOCK_ROLE = ["owner", "admin", "moderator", "member", "guest"].includes(process.env.MOCK_ROLE) ? process.env.MOCK_ROLE : "admin";
const isAdmin = MOCK_ROLE === "owner" || MOCK_ROLE === "admin";

// ---- 2-A: 메시지 찾기·읽음·공지 ----
const EDIT_LIMIT_SEC = 600; // Zulip 수정 제한과 같은 10분
const RECALLED_TEXT = "회수된 메시지입니다";
const RECEIPT_RECENT = 30; // 내 메시지 중 최근 30개만 숫자를 채운다
// 대화마다의 메시지 목록. 쪽지는 검색·답장·공지 대상이 아니다.
function conversationOf(message) {
  if (message.kind === "group") return { key: `group:${message.groupId}`, list: groupMessages[message.groupId] || [] };
  if (message.kind === "dm") {
    const [a, b] = [me.userId, message.peerId].sort((x, y) => x - y);
    return { key: `dm:${a}-${b}`, list: dms[message.peerId] || [] };
  }
  return { key: "general", list: general };
}
function allConversations() {
  const lists = [{ view: "general", list: general }];
  for (const [peerId, list] of Object.entries(dms)) lists.push({ view: "dm", peerId: Number(peerId), list });
  for (const group of myGroups()) lists.push({ view: "group", groupId: group.groupId, list: groupMessages[group.groupId] || [] });
  return lists;
}
// 내가 볼 수 있는 메시지(쪽지 제외). 남의 그룹 메시지는 찾지 않는다.
function findMessage(id) {
  for (const { list } of allConversations()) {
    const found = list.find((m) => m.id === id);
    if (found) return found;
  }
  return null;
}
// 읽음: messageId -> Set(userId). 보낸 사람은 늘 읽은 것으로 친다.
const readBy = new Map([[311, new Set()], [503, new Set([2])], [249, new Set([2, 4, 7])]]);
function participants(message) {
  if (message.kind === "group") return groups.get(message.groupId)?.memberIds || [];
  if (message.kind === "dm") return [me.userId, message.peerId];
  return [me.userId, ...people.map((p) => p.userId)];
}
function readers(message) {
  const read = readBy.get(message.id) || new Set();
  const others = participants(message).filter((id) => id !== me.userId);
  const isRead = (id) => id === message.senderId || read.has(id) || message.senderId !== me.userId;
  return { readIds: others.filter(isRead), unreadIds: others.filter((id) => !isRead(id)) };
}
// 공지: key -> { messageId, setBy, setAt }
const notices = new Map([["group:12", { messageId: 501, setBy: 2, setAt: now - 5300 }]]);
function noticeKey(view, userId, groupId) {
  if (view === "general") return { key: "general" };
  if (view === "dm") {
    const id = Number(userId);
    if (!people.some((p) => p.userId === id)) return { status: 400, error: "대화 상대를 확인하세요." };
    const [a, b] = [me.userId, id].sort((x, y) => x - y);
    return { key: `dm:${a}-${b}` };
  }
  if (view === "group") {
    const found = myGroup(groupId);
    if (found.error) return found;
    return { key: `group:${found.group.groupId}` };
  }
  return { status: 400, error: "대화방을 확인하세요." };
}
function noticeFor(key) {
  const notice = notices.get(key);
  if (!notice) return null;
  const message = findMessage(notice.messageId);
  if (!message) return null;
  // N8: ackTotal은 등록 때 인원(등록한 사람 제외). ackTarget(내가 확인 대상)·canViewAcks(목록 볼 수 있음)는 화면용.
  const ackIds = notice.ackUserIds || [];
  return {
    message: present(message), setByName: nameOf(notice.setBy), setAt: notice.setAt,
    ackRequired: Boolean(notice.ackRequired),
    ackCount: notice.ackRequired ? ackIds.filter((id) => notice.acks.has(id)).length : 0,
    ackTotal: notice.ackRequired ? ackIds.length : 0,
    ackedByMe: Boolean(notice.ackRequired && notice.acks.has(me.userId)),
    ackTarget: Boolean(notice.ackRequired && ackIds.includes(me.userId)),
    canViewAcks: Boolean(notice.ackRequired && (notice.setBy === me.userId || isAdmin)),
  };
}
// 응답용 사본: 보는 사람(나) 기준 필드를 채운다. withReceipt면 1:1·그룹의 최근 내 메시지에 unreadCount를 넣는다.
function present(message, { receiptIds = null } = {}) {
  const out = {
    ...message, mentionedMe: message.mentions.includes(me.userId), starred: starredIds.has(message.id), unreadCount: null,
    alerted: isAlerted(message),
    avatarUrl: avatarOf(message.senderId), // P1: 보낸 사람 사진(없으면 "")
  };
  // 답장의 원문이 회수됐으면 인용도 회수 표시(실제 서버는 원문 상태를 확인한다).
  if (message.replyTo) {
    const original = findMessage(message.replyTo.id);
    out.replyTo = original?.recalled
      ? { id: message.replyTo.id, senderId: message.replyTo.senderId, senderName: message.replyTo.senderName, excerpt: RECALLED_TEXT, recalled: true }
      : { ...message.replyTo, recalled: false };
  }
  out.reactions = message.recalled ? [] : message.reactions
    .filter((r) => r.userIds.length)
    .map((r) => ({ emoji: r.emoji, count: r.userIds.length, userIds: [...r.userIds], mine: r.userIds.includes(me.userId) }));
  if (receiptIds?.has(message.id)) out.unreadCount = readers(message).unreadIds.length;
  return out;
}
function receiptIdsOf(list, kind) {
  if (kind !== "dm" && kind !== "group") return new Set();
  return new Set(list.filter((m) => m.senderId === me.userId && !m.recalled).sort((a, b) => b.id - a.id).slice(0, RECEIPT_RECENT).map((m) => m.id));
}
function pushUpdated(message) {
  broadcast((client) => client.updated.push(present(message)));
}
function noticesChanged() {
  broadcast((client) => { client.noticesChanged = true; });
}
// 실제 서버의 답장 인용 요약: 본문 앞 80자, 본문이 없으면 첫 첨부 이름.
function excerptOf(message) {
  if (message.recalled) return RECALLED_TEXT;
  const text = message.content.replace(/\s+/g, " ").trim();
  if (text) return text.length > 80 ? `${text.slice(0, 80)}…` : text;
  return message.attachments[0] ? `[파일] ${message.attachments[0].name}` : "";
}
// 내 메시지·10분 안·회수 전만 고칠 수 있다. 실제 서버와 같은 문구.
function editable(message) {
  if (message.senderId !== me.userId) return { status: 403, error: "내가 보낸 메시지만 고칠 수 있습니다." };
  if (message.recalled) return { status: 400, error: "회수된 메시지입니다." };
  if (Date.now() / 1000 - message.timestamp > EDIT_LIMIT_SEC) return { status: 403, error: "보낸 지 10분이 지나 수정할 수 없습니다." };
  return null;
}

// ---- 2-B 상태 ----
const REACTIONS = ["thumbs_up", "check", "smile", "clap", "pray", "open_mouth"];
const STATUS_CODES = ["meeting", "trip", "leave", "outside", "training"];
const starredIds = new Set([502]);
// 예시 반응: 사진(502)에 👍 2명, 일정(501)에 ✅ 나
for (const [id, emoji, userIds] of [[502, "thumbs_up", [2, 3]], [501, "check", [1]]]) {
  const target = groupMessages[12].find((m) => m.id === id);
  if (target) target.reactions.push({ emoji, userIds: [...userIds] });
}
const statuses = new Map([[7, { code: "meeting", text: "오후 2시 회의" }], [9, { code: "leave", text: "" }]]);
// 저장된 설정(3단계 필드는 없으면 기본값). 응답은 presentPrefs()로 만든다.
let prefsRecord = { favorites: ["group:12"], muted: [], dnd: { enabled: false, from: "18:00", to: "09:00", weekends: true } };
let nextScheduledId = 1;

// ---- 2-C 상태 ----
const AUTO_LOCK_MINUTES = Number.isInteger(Number(process.env.MOCK_AUTO_LOCK)) && Number(process.env.MOCK_AUTO_LOCK) >= 0 ? Number(process.env.MOCK_AUTO_LOCK) : 30;
const WATERMARK = process.env.MOCK_WATERMARK !== "0";
// 실제 서버의 LOGIN_DOMAIN과 같다(비우면 null).
const LOGIN_DOMAIN = (process.env.LOGIN_DOMAIN || "").trim().toLowerCase() || null;
const UNLOCK_PASSWORD = "test";
const UNLOCK_TRIES = 5;
let unlockFails = 0;
// 실제 서버처럼: 5번 틀리면 로그아웃(다시 POST /api/login 전까지 401), 잠금 중엔 423, 비밀번호 변경 전엔 403.
let signedIn = true;
let locked = false;
let rateLimitLeft = 0;
const RATE_LIMIT_ERROR = "요청이 너무 많습니다. 잠시 후 다시 시도하세요.";
const ALWAYS = ["/api/session", "/api/session/status", "/api/logout", "/api/login", "/api/health"];
// 관리자 화면용 직원 정보(실제 서버는 Zulip 사용자 + 부서·직위 프로필 칸). 로그인 ID는 <사번>@<내부도메인> 형식 예시.
const ROLE_NAMES = ["owner", "admin", "moderator", "member", "guest"];
const staff = new Map([[me.userId, { department: "홍보실", position: "주무관", role: MOCK_ROLE, active: true, mustChangePassword: process.env.MOCK_MUST_CHANGE === "1" }]]);
for (const person of people) {
  const [position, department] = person.title.split(" · ");
  staff.set(person.userId, { department, position, role: "member", active: true });
}
let nextUserId = 100;
const auditLog = []; // { at, userId, ip, action, target, ok }
function audit(action, target, ok = true) {
  auditLog.push({ at: new Date().toISOString(), userId: me.userId, ip: "127.0.0.1", action, target: target === undefined || target === null ? "" : String(target), ok });
}
function adminUser(userId) {
  const info = staff.get(userId);
  const person = userId === me.userId ? me : people.find((x) => x.userId === userId);
  return {
    userId, fullName: person.fullName, loginId: emailOf(userId), department: info.department, position: info.position, role: info.role, active: info.active,
    // 실제 서버는 상상톡에서 퇴직 처리한 경우만 시각을 안다(그 밖에는 null).
    deactivatedAt: info.active ? null : info.deactivatedAt || null,
    mustChangePassword: Boolean(info.mustChangePassword),
  };
}
// C5: 투표·할 일. 키 형식은 Zulip 위젯과 같다(투표 "canned,<번호>", 할 일 "<번호>,canned").
function pollOf(question, options) {
  return { question, options: options.map((text, index) => ({ key: `canned,${index}`, text, voterIds: [] })) };
}
function todoOf(title, items) {
  return { title, items: items.map((text, index) => ({ key: `${index},canned`, text, done: false, doneBy: null })) };
}
// 보낼 때의 검사(실제 서버와 같은 문구). 결과: { poll } | { todo } | { error } | null
function widgetFrom(b) {
  const clean = (value, max) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");
  if (b.poll !== undefined && b.poll !== null) {
    const question = clean(b.poll?.question, 200);
    const options = Array.isArray(b.poll?.options) ? b.poll.options.map((o) => clean(o, 100)).filter(Boolean) : [];
    if (!question || options.length < 2 || options.length > 10) return { error: "투표는 질문과 항목 2~10개가 필요합니다." };
    return { poll: pollOf(question, options) };
  }
  if (b.todo !== undefined && b.todo !== null) {
    const title = clean(b.todo?.title, 200);
    const items = Array.isArray(b.todo?.items) ? b.todo.items.map((o) => clean(o, 100)).filter(Boolean) : [];
    if (!title || items.length < 1 || items.length > 30) return { error: "할 일은 제목과 항목 1~30개가 필요합니다." };
    return { todo: todoOf(title, items) };
  }
  return null;
}
{
  const pollMessage = msg({ id: 506, senderId: 2, kind: "group", groupId: 12, content: "", timestamp: now - 4500 });
  pollMessage.poll = pollOf("다음 회의 날짜는?", ["화요일", "수요일", "목요일"]);
  pollMessage.poll.options[0].voterIds.push(2, 3);
  pollMessage.poll.options[1].voterIds.push(1);
  groupMessages[12].push(pollMessage);
  const todoMessage = msg({ id: 512, senderId: 7, kind: "group", groupId: 13, content: "", timestamp: now - 8900 });
  todoMessage.todo = todoOf("협의 준비", ["안건 정리", "회의실 예약", "자료 인쇄"]);
  Object.assign(todoMessage.todo.items[0], { done: true, doneBy: 8 });
  groupMessages[13].push(todoMessage);
}
const scheduled = []; // { id, view, userId, groupId, content, attachments, mentions, scheduledAt, timer }

// ---- 3단계 상태(docs/p3-contract.md) ----
let WEB_VERSION = null;
try {
  WEB_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version || null;
} catch {
  WEB_VERSION = null;
}
// N4 키워드(실제 서버는 Zulip alert words). 남이 보낸, 회수 안 된 메시지에 키워드가 들어 있으면 alerted.
const keywords = ["예산"];
function isAlerted(message) {
  if (message.senderId === me.userId || message.recalled || message.note) return false;
  const text = message.content.toLowerCase();
  return keywords.some((word) => text.includes(word.toLowerCase()));
}
// D1 관리자 정책
let policy = emptyPolicy();
// N7 중요 메시지: 내가 보낸 시각(초) 목록, 1시간 10번
const URGENT_PER_HOUR = 10;
let urgentSent = [];
// N6 활동: 반응(우리 API를 거친 것)은 시각을 따로 둔다. key "<messageId>:<userId>:<emoji>" -> 초
const reactionAt = new Map();
// N6 공지 기록(실제 서버 activity.json의 notices와 같음): 공지가 바뀌거나 내려가도 남는다.
const noticeLog = []; // { key, messageId, setBy, setAt, ackRequired }
function logNotice(key, notice) {
  const index = noticeLog.findIndex((one) => one.key === key && one.messageId === notice.messageId);
  if (index !== -1) noticeLog.splice(index, 1);
  noticeLog.push({ key, messageId: notice.messageId, setBy: notice.setBy, setAt: notice.setAt, ackRequired: Boolean(notice.ackRequired) });
}
let activitySeenAt = 0; // 이 시각(초)까지의 항목은 본 것으로 친다
const activitySeenIds = new Set(); // 하나씩 확인한 항목(POST /api/activity/seen { ids })
// { unseen, unseenByKind: { mention, reply, reaction, notice, keyword } }
function unseenCounts(items = activityItems()) {
  const unseenByKind = Object.fromEntries(ACTIVITY_KINDS.map((kind) => [kind, 0]));
  for (const item of items) if (!item.seen) unseenByKind[item.kind] += 1;
  return { unseen: items.filter((item) => !item.seen).length, unseenByKind };
}
// 예시: 김도윤이 내 메시지(249)에 👏, 그룹 12 공지는 확인 요청(이서준만 확인함)
{
  const mine = general.find((m) => m.id === 249);
  mine.reactions.push({ emoji: "clap", userIds: [2] });
  reactionAt.set("249:2:clap", now - 3000);
  Object.assign(notices.get("group:12"), { ackRequired: true, ackUserIds: [1, 3, 4], acks: new Map([[3, now - 5000]]) });
  logNotice("group:12", notices.get("group:12"));
}
const ACTIVITY_PAGE = 50;
const ACTIVITY_KINDS = ["mention", "reply", "reaction", "notice", "keyword"];
// P4 내 로그인 목록(예시). id는 세션 키가 아닌 짧은 해시.
const mySessions = [
  { id: "a1b2c3d4e5f6", current: true, client: "browser", createdAt: new Date(Date.now() - 3600e3).toISOString(), lastSeenAt: new Date().toISOString(), ip: "127.0.0.1" },
  { id: "0f9e8d7c6b5a", current: false, client: "desktop", createdAt: new Date(Date.now() - 86400e3).toISOString(), lastSeenAt: new Date(Date.now() - 600e3).toISOString(), ip: "10.0.20.31" },
];
// P4 공개 설정(실제 서버는 Zulip 개인 설정)
const privacy = { readReceipts: true, presence: true, typing: true };
// P1 내 사진(실제 서버는 Zulip /users/me/avatar). MOCK_AVATAR_DISABLED=1이면 조직 설정으로 막힌 것처럼 403.
const AVATAR_DISABLED = process.env.MOCK_AVATAR_DISABLED === "1";
let myAvatar = null; // { data, type, version }
let avatarVersion = 1;
// 사진이 없으면 "". 바꿀 때마다 ?v=가 바뀌어 캐시된 옛 사진을 쓰지 않는다.
const avatarOf = (userId) => (userId === me.userId && myAvatar ? `/api/avatar/${me.userId}?v=${myAvatar.version}` : "");

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
    client = { messages: [], updated: [], typing: [], groupsChanged: false, noticesChanged: false, activity: null, prefsChanged: false, policyChanged: false, waiter: null, lastSeen: Date.now() };
    clients.set(id, client);
  }
  client.lastSeen = Date.now();
  return client;
}
function flushClient(client) {
  // 대기 중인 /api/events가 없으면 다음 폴링 때까지 쌓아 둔다(폴링 사이 이벤트 유실 방지).
  if (!client.waiter) return;
  if (!client.messages.length && !client.updated.length && !client.typing.length && !client.groupsChanged && !client.noticesChanged
    && !client.activity && !client.prefsChanged && !client.policyChanged) return;
  const payload = {
    ...emptyEvents(),
    messages: client.messages,
    // 같은 메시지가 여러 번 바뀌었으면 마지막 것만 보낸다.
    updated: [...new Map(client.updated.map((m) => [m.id, m])).values()],
    typing: client.typing,
    groupsChanged: client.groupsChanged,
    noticesChanged: client.noticesChanged,
    activity: client.activity,
    prefsChanged: client.prefsChanged,
    policyChanged: client.policyChanged,
  };
  client.messages = [];
  client.updated = [];
  client.typing = [];
  client.groupsChanged = false;
  client.noticesChanged = false;
  client.activity = null;
  client.prefsChanged = false;
  client.policyChanged = false;
  const res = client.waiter;
  client.waiter = null;
  json(res, 200, payload);
}
// /api/events 응답의 모든 필드(빈 값). updated·noticesChanged는 2-A, typing은 2-B, activity·prefsChanged·policyChanged는 3단계.
function emptyEvents() {
  return { messages: [], updated: [], typing: [], notes: noteRecords(), notesError: false, reset: false, groupsChanged: false, noticesChanged: false, activity: null, prefsChanged: false, policyChanged: false };
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
  broadcast((client) => client.messages.push(present(message)));
}
function groupsChanged() {
  broadcast((client) => { client.groupsChanged = true; });
}
// ---- 3단계 이벤트·활동 ----
function prefsChanged() {
  broadcast((client) => { client.prefsChanged = true; });
}
function policyChanged() {
  broadcast((client) => { client.policyChanged = true; });
}
// 새 활동 항목이 생겼을 때만 보낸다.
function activityChanged() {
  const counts = unseenCounts();
  broadcast((client) => { client.activity = counts; });
}
function placeOf(message) {
  if (message.kind === "group") return { view: "group", groupId: message.groupId };
  if (message.kind === "dm") return { view: "dm", userId: message.peerId };
  return { view: "general" };
}
// 실제 서버와 같은 출처: 멘션·키워드(검색), 답장·반응(활동 저장소), 공지(공지 기록, current는 지금도 그 방 공지인지). 최근 30일, 최신순.
function activityItems() {
  const cutoff = Math.floor(Date.now() / 1000) - 30 * 86400;
  const items = [];
  const item = (kind, id, at, message, actorId, extra = {}) => items.push({
    id, kind, at, ...placeOf(message), messageId: message.id, actorId, actorName: nameOf(actorId), excerpt: excerptOf(message), ...extra, seen: at <= activitySeenAt || activitySeenIds.has(id),
  });
  for (const { list } of allConversations()) {
    for (const m of list) {
      if (m.senderId === me.userId) continue;
      if (!m.recalled && m.mentions.includes(me.userId)) item("mention", `mention:${m.id}`, m.timestamp, m, m.senderId);
      else if (isAlerted(m)) item("keyword", `keyword:${m.id}`, m.timestamp, m, m.senderId);
      const original = m.replyTo && !m.recalled ? findMessage(m.replyTo.id) : null;
      if (original?.senderId === me.userId) item("reply", `reply:${m.id}`, m.timestamp, m, m.senderId);
    }
    for (const m of list) {
      if (m.senderId !== me.userId) continue; // 회수된 내 메시지의 반응도 남긴다(요약은 "회수된 메시지입니다", 실제 서버와 같음)
      for (const r of m.reactions) {
        for (const userId of r.userIds) {
          const at = reactionAt.get(`${m.id}:${userId}:${r.emoji}`);
          if (userId !== me.userId && at) item("reaction", `reaction:${m.id}:${userId}:${r.emoji}`, at, m, userId, { emoji: r.emoji });
        }
      }
    }
  }
  for (const notice of noticeLog) {
    const message = findMessage(notice.messageId);
    if (!message || notice.setBy === me.userId) continue;
    const now = notices.get(notice.key);
    const current = Boolean(now && now.messageId === notice.messageId && now.setAt === notice.setAt);
    item("notice", `notice:${notice.key.replace(/[^0-9a-z:]/g, "_")}:${message.id}`, notice.setAt, message, notice.setBy, { ackRequired: notice.ackRequired, current });
  }
  return items.filter((one) => one.at >= cutoff).sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
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
// 한 대화의 한 페이지. before(더 예전), after(더 최근, A2 검색 결과에서 아래로), around(그 메시지 앞뒤 절반씩).
// 메시지는 오래된 것부터. 2-A부터 hasNewer도 준다(around·after가 아니면 늘 false).
function page(list, { before = 0, after = 0, around = 0 } = {}) {
  const sorted = [...list].sort((a, b) => a.id - b.id);
  let messages;
  let hasOlder = false;
  let hasNewer = false;
  if (around) {
    const older = sorted.filter((m) => m.id < around);
    const newer = sorted.filter((m) => m.id >= around);
    messages = [...older.slice(-PAGE / 2), ...newer.slice(0, PAGE / 2)];
    hasOlder = older.length > PAGE / 2;
    hasNewer = newer.length > PAGE / 2;
  } else if (after) {
    const newer = sorted.filter((m) => m.id > after);
    messages = newer.slice(0, PAGE);
    hasOlder = true;
    hasNewer = newer.length > PAGE;
  } else {
    const older = before ? sorted.filter((m) => m.id < before) : sorted;
    messages = older.slice(-PAGE);
    hasOlder = older.length > PAGE;
  }
  return { messages, hasOlder, hasNewer };
}
function presentPage(list, kind, options, key) {
  const result = page(list, options);
  const receiptIds = receiptIdsOf(list, kind);
  return { ...result, messages: result.messages.map((m) => present(m, { receiptIds })), notice: noticeFor(key) };
}
// before·after·around 중 하나만, 양의 정수로.
function anchorParams(params) {
  const out = {};
  let count = 0;
  for (const name of ["before", "after", "around"]) {
    const raw = params.get(name);
    if (!raw) continue;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0 || String(value) !== raw) return { error: "불러올 위치가 올바르지 않습니다." };
    out[name] = value;
    count += 1;
  }
  if (count > 1) return { error: "불러올 위치가 올바르지 않습니다." };
  return out;
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
    if (p.startsWith("/api/") && p !== "/api/dev/simulate") {
      // 429 흉내(simulate "rateLimit"). 잠금 풀기 중이면 실제 서버처럼 로그아웃.
      if (rateLimitLeft > 0) {
        rateLimitLeft -= 1;
        if (p === "/api/session/unlock") {
          signedIn = false;
          locked = false;
          audit("logout", "unlock_rate_limited", false);
          return json(res, 401, { error: "비밀번호를 여러 번 틀려 로그아웃했습니다. 30분 동안 로그인할 수 없습니다.", signedOut: true, remaining: 0 });
        }
        if (p === "/api/session/password") audit("password_change", "rate_limited", false);
        return json(res, 429, { error: RATE_LIMIT_ERROR });
      }
      if (!signedIn && !["/api/login", "/api/health", "/api/session/status"].includes(p)) {
        return json(res, 401, { error: "로그인이 필요합니다.", ...(p === "/api/session/unlock" ? { signedOut: true } : {}) });
      }
      if (locked && ![...ALWAYS, "/api/session/unlock", "/api/session/lock"].includes(p)) {
        return json(res, 423, { error: "화면이 잠겨 있습니다.", locked: true });
      }
      if (staff.get(me.userId)?.mustChangePassword && ![...ALWAYS, "/api/session/password", "/api/session/unlock", "/api/session/lock"].includes(p)) {
        return json(res, 403, { error: "비밀번호를 먼저 바꿔 주세요.", mustChangePassword: true });
      }
    }
    // M14: 실제 서버와 같이 APP_ONLY_LOGIN=1이면 데스크톱 앱 헤더 없는 로그인을 거부한다.
    // C1: 관리자·소유자는 브라우저 로그인도 받는다.
    if (p === "/api/login" && method === "POST" && APP_ONLY_LOGIN && req.headers["x-sangsangtalk-client"] !== "desktop" && !isAdmin) {
      audit("login_fail", me.email, false);
      return json(res, 403, { error: "상상톡 로그인은 데스크톱 앱에서만 할 수 있습니다." });
    }
    // role·isAdmin은 2-A부터(전체 대화방 공지·관리자 화면 표시용). 실제 권한 판정은 서버가 한다.
    // watermark·autoLockMinutes는 2-C(C3·C4).
    if (p === "/api/session" || p === "/api/login") {
      if (p === "/api/login") {
        unlockFails = 0;
        signedIn = true;
        locked = false;
        audit("login", me.email);
      }
      const mine = staff.get(me.userId);
      return json(res, 200, {
        ...me, role: MOCK_ROLE, isAdmin, peer: null, limits: limits(), watermark: WATERMARK, autoLockMinutes: AUTO_LOCK_MINUTES,
        department: mine.department, position: mine.position, mustChangePassword: Boolean(mine.mustChangePassword), locked, loginDomain: LOGIN_DOMAIN,
        // 3단계: 웹 버전(web/package.json), 관리자 정책 중 화면이 알아야 하는 값
        version: WEB_VERSION, policy: { forcePreviewHidden: policy.forcePreviewHidden }, avatarUrl: avatarOf(me.userId),
      });
    }
    // C1: 내 비밀번호 바꾸기(첫 로그인 등). 목업의 현재 비밀번호는 "test".
    if (p === "/api/session/password" && method === "POST") {
      const b = await body(req);
      const oldPassword = typeof b.oldPassword === "string" ? b.oldPassword : "";
      const newPassword = typeof b.newPassword === "string" ? b.newPassword : "";
      if (!oldPassword || newPassword.length < 8 || newPassword.length > 100) return json(res, 400, { error: "현재 비밀번호와 8자 이상의 새 비밀번호를 입력하세요." });
      if (oldPassword === newPassword) return json(res, 400, { error: "새 비밀번호는 지금과 달라야 합니다." });
      if (oldPassword !== UNLOCK_PASSWORD) {
        audit("password_change", "", false);
        return json(res, 400, { error: "현재 비밀번호가 올바르지 않습니다." });
      }
      staff.get(me.userId).mustChangePassword = false;
      audit("password_change", "");
      return json(res, 200, { ok: true });
    }
    // C4: 잠금 풀기. 401이어도 signedOut이 false면 아직 로그인 상태다.
    if (p === "/api/session/unlock" && method === "POST") {
      const b = await body(req);
      if (typeof b.password === "string" && b.password === UNLOCK_PASSWORD) {
        unlockFails = 0;
        locked = false;
        return json(res, 200, { ok: true });
      }
      unlockFails += 1;
      audit("unlock_fail", String(unlockFails), false);
      if (unlockFails >= UNLOCK_TRIES) {
        unlockFails = 0;
        signedIn = false;
        locked = false;
        audit("logout", "unlock_failed", false);
        return json(res, 401, { error: "비밀번호를 5번 틀려 로그아웃했습니다. 다시 로그인하세요.", signedOut: true, remaining: 0 });
      }
      return json(res, 401, { error: "비밀번호가 올바르지 않습니다.", signedOut: false, remaining: UNLOCK_TRIES - unlockFails });
    }
    if (p === "/api/session/status") return json(res, 200, { signedIn });
    // C4: 잠금 화면을 띄웠다고 서버에 알린다. 풀 때까지 다른 /api는 423.
    if (p === "/api/session/lock" && method === "POST") {
      locked = true;
      audit("lock", "");
      return json(res, 200, { ok: true, locked: true });
    }
    if (p === "/api/logout") {
      signedIn = false;
      locked = false;
      audit("logout", "");
      return json(res, 200, { ok: true });
    }
    if (p === "/api/directory") return json(res, 200, { people });
    if (p === "/api/notes") return json(res, 200, { notes: noteRecords() });
    if (p === "/api/notes/messages") return json(res, 200, { messages: notes.map((n) => present(n)) });

    if (p === "/api/events") {
      const client = clientFor(cid);
      // 같은 클라이언트의 이전 폴링이 아직 열려 있으면 빈 응답으로 닫고 새 폴링으로 바꾼다.
      if (client.waiter) json(client.waiter, 200, emptyEvents());
      client.waiter = res;
      const timer = setTimeout(() => {
        if (client.waiter === res) client.waiter = null;
        json(res, 200, emptyEvents());
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
      const anchor = anchorParams(url.searchParams);
      if (anchor.error) return json(res, 400, { error: anchor.error });
      if (view === "group") {
        const found = myGroup(url.searchParams.get("groupId"));
        if (found.error) return json(res, found.status, { error: found.error });
        const g = found.group;
        return json(res, 200, { view, group: g, ...presentPage(groupMessages[g.groupId] || [], "group", anchor, `group:${g.groupId}`) });
      }
      if (view === "dm") {
        const userId = Number(url.searchParams.get("userId"));
        const key = noticeKey("dm", userId).key || "";
        return json(res, 200, { view, peer: people.find((x) => x.userId === userId) || null, ...presentPage(dms[userId] || [], "dm", anchor, key) });
      }
      return json(res, 200, { view: "general", channel: "general", ...presentPage(general, "channel", anchor, "general") });
    }

    if (p === "/api/messages" && method === "POST") {
      const b = await body(req);
      const widget = widgetFrom(b); // C5
      if (widget?.error) return json(res, 400, { error: widget.error });
      if (widget && b.note) return json(res, 400, { error: "쪽지로는 투표·할 일을 보낼 수 없습니다." });
      // N7 중요 메시지: 쪽지·투표·할 일은 400, 전체 대화방은 관리자만, 1시간 10번
      if (b.urgent !== undefined && typeof b.urgent !== "boolean") return json(res, 400, { error: "중요 메시지 값을 확인하세요." });
      const urgent = b.urgent === true;
      if (urgent) {
        if (widget || b.note) return json(res, 400, { error: "쪽지·투표·할 일은 중요 메시지로 보낼 수 없습니다." });
        if (b.view !== "group" && b.view !== "dm" && !isAdmin) return json(res, 403, { error: "전체 대화방의 중요 메시지는 관리자만 보낼 수 있습니다." });
        const hourAgo = Date.now() / 1000 - 3600;
        urgentSent = urgentSent.filter((at) => at > hourAgo);
        if (urgentSent.length >= URGENT_PER_HOUR) return json(res, 429, { error: "중요 메시지는 1시간에 10번까지 보낼 수 있습니다." });
      }
      const content = widget ? "" : typeof b.content === "string" ? b.content.trim() : "";
      const attachments = widget ? [] : cleanAttachments(b.attachments, false);
      if (!content && !attachments.length && !widget) return json(res, 400, { error: "메시지를 입력하세요." });
      // A3: 답장은 같은 대화의 메시지만. 멘션은 직원 id만 남긴다(본문의 "@이름" 글자는 그대로).
      let replyTo = null;
      if (b.replyToId !== undefined && b.replyToId !== null) {
        const original = findMessage(Number(b.replyToId));
        if (!original) return json(res, 404, { error: "답장할 메시지를 찾지 못했습니다." });
        replyTo = { id: original.id, senderId: original.senderId, senderName: original.senderName, excerpt: excerptOf(original), _conversation: conversationOf(original).key };
      }
      const mentions = Array.isArray(b.mentions)
        ? [...new Set(b.mentions.map(Number).filter((id) => id === me.userId || people.some((x) => x.userId === id)))]
        : [];
      const extra = (target) => {
        if (replyTo && replyTo._conversation !== target) return { error: "같은 대화방의 메시지에만 답장할 수 있습니다." };
        return { replyTo: replyTo && { id: replyTo.id, senderId: replyTo.senderId, senderName: replyTo.senderName, excerpt: replyTo.excerpt }, mentions };
      };
      let message;
      if (b.view === "group") {
        const found = myGroup(b.groupId);
        if (found.error) return json(res, found.status, { error: found.error });
        const group = found.group;
        const more = extra(`group:${group.groupId}`);
        if (more.error) return json(res, 400, { error: more.error });
        message = msg({ senderId: me.userId, kind: "group", groupId: group.groupId, content, attachments, ...more });
        (groupMessages[group.groupId] ||= []).push(message);
      } else if (b.view === "dm") {
        const userId = Number(b.userId);
        if (b.note && (replyTo || mentions.length)) return json(res, 400, { error: "쪽지에는 답장·멘션을 쓸 수 없습니다." });
        const more = b.note ? {} : extra(noticeKey("dm", userId).key);
        if (more.error) return json(res, 400, { error: more.error });
        message = msg({ senderId: me.userId, kind: "dm", peerId: userId, content, attachments, ...more });
        if (b.note) {
          message.note = true;
          notes.push({ ...message, direction: "sent", counterpartName: nameOf(userId) });
        } else (dms[userId] ||= []).push(message);
      } else {
        const more = extra("general");
        if (more.error) return json(res, 400, { error: more.error });
        message = msg({ senderId: me.userId, kind: "channel", content, attachments, ...more });
        general.push(message);
      }
      if (widget) Object.assign(message, widget);
      if (urgent) {
        message.urgent = true;
        urgentSent.push(Date.now() / 1000);
        audit("urgent_send", message.id);
      }
      if (attachments.length) audit("file_upload", message.id);
      // 보낸 사람의 응답에만 크기가 들어간다(저장된 메시지는 size: null).
      const conversation = message.note ? null : conversationOf(message);
      const receiptIds = conversation ? receiptIdsOf(conversation.list, message.kind) : new Set();
      return json(res, 200, { message: { ...present(message, { receiptIds }), attachments: cleanAttachments(b.attachments, true) } });
    }

    // A1: 화면에 보이는 대화의 메시지를 읽음으로 표시(실제 서버는 Zulip read 플래그). 목업은 확인만 한다.
    if (p === "/api/messages/read" && method === "POST") {
      const b = await body(req);
      const ids = Array.isArray(b.messageIds) ? b.messageIds.map(Number) : [];
      if (!ids.length || ids.length > 1000 || !ids.every((id) => Number.isSafeInteger(id) && id > 0)) {
        return json(res, 400, { error: "읽은 메시지를 확인하세요." });
      }
      return json(res, 200, { ok: true });
    }

    // 2-A: 메시지 하나에 대한 요청(읽은 사람, 수정, 회수)
    const messageMatch = p.match(/^\/api\/messages\/(\d+)(\/readers|\/recall|\/reactions|\/star|\/poll|\/todo)?$/);
    if (messageMatch) {
      const message = findMessage(Number(messageMatch[1]));
      if (!message) return json(res, 404, { error: "메시지를 찾지 못했습니다." });
      if (messageMatch[2] === "/readers" && method === "GET") return json(res, 200, readers(message));
      if (!messageMatch[2] && method === "PATCH") {
        const denied = editable(message);
        if (denied) return json(res, denied.status, { error: denied.error });
        if (message.poll || message.todo) return json(res, 400, { error: "투표·할 일은 고칠 수 없습니다." });
        const b = await body(req);
        const content = typeof b.content === "string" ? b.content.trim() : "";
        if (!content && !message.attachments.length) return json(res, 400, { error: "메시지를 입력하세요." });
        message.content = content;
        message.edited = true;
        // 실제 서버처럼 수정 때 보낸 mentions로 바꾼다(없으면 멘션 없음).
        message.mentions = Array.isArray(b.mentions) ? [...new Set(b.mentions.map(Number).filter((id) => people.some((x) => x.userId === id)))] : [];
        pushUpdated(message);
        return json(res, 200, { message: present(message, { receiptIds: receiptIdsOf(conversationOf(message).list, message.kind) }) });
      }
      if (messageMatch[2] === "/reactions" && (method === "POST" || method === "DELETE")) {
        const emoji = method === "POST" ? (await body(req)).emoji : url.searchParams.get("emoji");
        if (!REACTIONS.includes(emoji)) return json(res, 400, { error: "쓸 수 없는 반응입니다." });
        if (message.recalled) return json(res, 400, { error: "회수된 메시지입니다." });
        let reaction = message.reactions.find((r) => r.emoji === emoji);
        if (method === "POST") {
          if (!reaction) message.reactions.push((reaction = { emoji, userIds: [] }));
          if (!reaction.userIds.includes(me.userId)) reaction.userIds.push(me.userId);
        } else if (reaction) {
          reaction.userIds = reaction.userIds.filter((id) => id !== me.userId);
          if (!reaction.userIds.length) message.reactions = message.reactions.filter((r) => r !== reaction);
        }
        pushUpdated(message);
        return json(res, 200, { message: present(message) });
      }
      // C5: 투표(누를 때마다 내 표 토글), 할 일(완료 토글)
      if (messageMatch[2] === "/poll" && method === "POST") {
        const key = (await body(req)).key;
        const option = message.poll?.options.find((o) => o.key === key);
        if (!message.poll || message.recalled) return json(res, 400, { error: "투표 메시지가 아닙니다." });
        if (!option) return json(res, 400, { error: "투표 항목을 확인하세요." });
        option.voterIds = option.voterIds.includes(me.userId) ? option.voterIds.filter((id) => id !== me.userId) : [...option.voterIds, me.userId];
        pushUpdated(message);
        return json(res, 200, { message: present(message) });
      }
      if (messageMatch[2] === "/todo" && method === "POST") {
        const key = (await body(req)).key;
        const item = message.todo?.items.find((i) => i.key === key);
        if (!message.todo || message.recalled) return json(res, 400, { error: "할 일 메시지가 아닙니다." });
        if (!item) return json(res, 400, { error: "할 일 항목을 확인하세요." });
        item.done = !item.done;
        item.doneBy = item.done ? me.userId : null;
        pushUpdated(message);
        return json(res, 200, { message: present(message) });
      }
      if (messageMatch[2] === "/star" && (method === "POST" || method === "DELETE")) {
        if (method === "POST") starredIds.add(message.id);
        else starredIds.delete(message.id);
        pushUpdated(message);
        return json(res, 200, { message: present(message) });
      }
      if (messageMatch[2] === "/recall" && method === "POST") {
        const denied = editable(message);
        if (denied) return json(res, denied.status, { error: denied.error });
        if (message.poll || message.todo) return json(res, 400, { error: "투표·할 일은 회수할 수 없습니다." });
        Object.assign(message, { content: RECALLED_TEXT, attachments: [], recalled: true, edited: true, replyTo: null, mentions: [], poll: null, todo: null });
        audit("recall", message.id);
        // 공지로 걸린 메시지가 회수되면 공지를 내린다.
        let noticeGone = false;
        for (const [key, notice] of notices) {
          if (notice.messageId === message.id) {
            notices.delete(key);
            noticeGone = true;
          }
        }
        if (noticeGone) noticesChanged();
        pushUpdated(message);
        return json(res, 200, { message: present(message) });
      }
    }

    // A5. 공지
    if (p === "/api/notices" && (method === "POST" || method === "DELETE")) {
      const b = method === "POST" ? await body(req) : Object.fromEntries(url.searchParams);
      const target = noticeKey(b.view, b.userId, b.groupId);
      if (target.error) return json(res, target.status, { error: target.error });
      if (target.key === "general" && !isAdmin) return json(res, 403, { error: "전체 대화방 공지는 관리자만 바꿀 수 있습니다." });
      if (method === "DELETE") {
        notices.delete(target.key);
      } else {
        const message = findMessage(Number(b.messageId));
        if (!message || conversationOf(message).key !== target.key) return json(res, 404, { error: "이 대화방의 메시지를 찾지 못했습니다." });
        if (message.recalled) return json(res, 400, { error: "회수된 메시지는 공지로 등록할 수 없습니다." });
        if (b.ackRequired !== undefined && typeof b.ackRequired !== "boolean") return json(res, 400, { error: "확인 요청 값을 확인하세요." });
        const notice = { messageId: message.id, setBy: me.userId, setAt: Math.floor(Date.now() / 1000) };
        // N8: 확인 대상은 등록 때의 대화방 인원(등록한 사람 제외)
        if (b.ackRequired) Object.assign(notice, { ackRequired: true, ackUserIds: participants(message).filter((id) => id !== me.userId), acks: new Map() });
        notices.set(target.key, notice);
        logNotice(target.key, notice);
      }
      noticesChanged();
      return json(res, 200, { notice: noticeFor(target.key) });
    }
    // N8 공지 확인. 같은 사람이 다시 확인해도 그대로(200).
    if (p === "/api/notices/ack" && method === "POST") {
      const b = await body(req);
      const target = noticeKey(b.view, b.userId, b.groupId);
      if (target.error) return json(res, target.status, { error: target.error });
      const notice = notices.get(target.key);
      if (!notice) return json(res, 404, { error: "공지가 없습니다." });
      if (!notice.ackRequired) return json(res, 400, { error: "확인 요청이 없는 공지입니다." });
      if (!notice.ackUserIds.includes(me.userId)) return json(res, 403, { error: "이 공지의 확인 대상이 아닙니다." });
      if (!notice.acks.has(me.userId)) {
        notice.acks.set(me.userId, Math.floor(Date.now() / 1000));
        audit("notice_ack", `${target.key}:${notice.messageId}`);
        noticesChanged();
      }
      return json(res, 200, { notice: noticeFor(target.key) });
    }
    if (p === "/api/notices/acks" && method === "GET") {
      const target = noticeKey(url.searchParams.get("view"), url.searchParams.get("userId"), url.searchParams.get("groupId"));
      if (target.error) return json(res, target.status, { error: target.error });
      const notice = notices.get(target.key);
      if (!notice) return json(res, 404, { error: "공지가 없습니다." });
      if (!notice.ackRequired) return json(res, 400, { error: "확인 요청이 없는 공지입니다." });
      if (notice.setBy !== me.userId && !isAdmin) return json(res, 403, { error: "공지를 등록한 사람과 관리자만 볼 수 있습니다." });
      const acked = notice.ackUserIds.filter((id) => notice.acks.has(id)).map((id) => ({ userId: id, name: nameOf(id), at: notice.acks.get(id) })).sort((a, b) => a.at - b.at);
      const pending = notice.ackUserIds.filter((id) => !notice.acks.has(id)).map((id) => ({ userId: id, name: nameOf(id) }));
      return json(res, 200, { acked, pending });
    }

    // ---- 3단계: 알림 센터 ----
    if (p === "/api/activity" && method === "GET") {
      const kind = url.searchParams.get("kind") || "all";
      if (kind !== "all" && !ACTIVITY_KINDS.includes(kind)) return json(res, 400, { error: "알림 종류를 확인하세요." });
      const all = activityItems();
      let list = kind === "all" ? all : all.filter((item) => item.kind === kind);
      const before = url.searchParams.get("before");
      if (before) {
        const index = list.findIndex((item) => item.id === before);
        if (index === -1) return json(res, 400, { error: "불러올 위치가 올바르지 않습니다." });
        list = list.slice(index + 1);
      }
      return json(res, 200, { items: list.slice(0, ACTIVITY_PAGE), hasOlder: list.length > ACTIVITY_PAGE, ...unseenCounts(all) });
    }
    if (p === "/api/activity/seen" && method === "POST") {
      const b = await body(req);
      const all = activityItems();
      // { ids: [...] }(최대 50): 그 항목만. 목록에 없는 id는 무시한다.
      if (b.ids !== undefined) {
        const ok = Array.isArray(b.ids) && b.ids.length && b.ids.length <= 50 && b.ids.every((id) => typeof id === "string" && /^(mention|keyword|reply|reaction|notice):[0-9a-z_:]{1,80}$/.test(id));
        if (!ok) return json(res, 400, { error: "확인할 알림을 확인하세요." });
        for (const id of b.ids) if (all.some((item) => item.id === id)) activitySeenIds.add(id);
        return json(res, 200, unseenCounts());
      }
      if (b.upTo === "all") activitySeenAt = Math.max(activitySeenAt, Math.floor(Date.now() / 1000));
      else {
        const found = typeof b.upTo === "string" ? all.find((item) => item.id === b.upTo) : null;
        if (!found) return json(res, 400, { error: "확인할 알림을 찾지 못했습니다." });
        activitySeenAt = Math.max(activitySeenAt, found.at);
      }
      return json(res, 200, unseenCounts());
    }

    // N4 키워드 알림
    if (p === "/api/keywords" && method === "GET") return json(res, 200, { keywords: [...keywords] });
    if (p === "/api/keywords" && (method === "POST" || method === "DELETE")) {
      const word = cleanKeyword(method === "POST" ? (await body(req)).keyword : url.searchParams.get("keyword"));
      if (!word) return json(res, 400, { error: KEYWORD_ERRORS.invalid });
      const index = keywords.findIndex((one) => one.toLowerCase() === word.toLowerCase());
      if (method === "POST" && index === -1) {
        if (keywords.length >= KEYWORD_MAX) return json(res, 400, { error: KEYWORD_ERRORS.full });
        keywords.push(word);
      }
      if (method === "DELETE" && index !== -1) keywords.splice(index, 1);
      return json(res, 200, { keywords: [...keywords] });
    }

    // P4 내 로그인 목록
    if (p === "/api/me/sessions" && method === "GET") {
      // 실제 서버처럼 지금 쓰는 로그인은 방금 쓴 것으로 보인다.
      for (const one of mySessions) if (one.current) one.lastSeenAt = new Date().toISOString();
      return json(res, 200, { sessions: mySessions.map((one) => ({ ...one })) });
    }
    if (p === "/api/me/sessions" && method === "DELETE") {
      if (url.searchParams.get("others") !== "1") return json(res, 400, { error: "로그아웃할 로그인을 고르세요." });
      const others = mySessions.filter((s) => !s.current);
      for (const s of others) mySessions.splice(mySessions.indexOf(s), 1);
      audit("session_revoke", `others:${others.length}`);
      return json(res, 200, { ended: others.length });
    }
    const mySessionMatch = p.match(/^\/api\/me\/sessions\/([a-f0-9]{12})$/);
    if (mySessionMatch && method === "DELETE") {
      const found = mySessions.find((s) => s.id === mySessionMatch[1]);
      if (!found) return json(res, 404, { error: "로그인 기록을 찾지 못했습니다." });
      if (found.current) return json(res, 400, { error: "지금 쓰는 로그인은 로그아웃 버튼으로 끝내세요." });
      mySessions.splice(mySessions.indexOf(found), 1);
      audit("session_revoke", found.id);
      return json(res, 200, { ended: 1 });
    }
    // P1 내 사진: multipart 파일 하나, PNG·JPG(파일 내용으로 판단), 5MB까지
    if (p === "/api/me/avatar" && (method === "POST" || method === "DELETE")) {
      if (AVATAR_DISABLED) {
        req.resume();
        return json(res, 403, { error: AVATAR_ERRORS.disabled });
      }
      if (method === "DELETE") {
        myAvatar = null;
        audit("avatar_change", "delete");
        return json(res, 200, { avatarUrl: "" });
      }
      if (Number(req.headers["content-length"]) > AVATAR_MAX_BYTES + 64 * 1024) {
        req.resume();
        return json(res, 413, { error: AVATAR_ERRORS.size });
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > AVATAR_MAX_BYTES + 64 * 1024) return json(res, 413, { error: AVATAR_ERRORS.size });
        chunks.push(chunk);
      }
      const file = singleFilePart(Buffer.concat(chunks), req.headers["content-type"]);
      if (!file) return json(res, 400, { error: AVATAR_ERRORS.missing });
      if (file.length > AVATAR_MAX_BYTES) return json(res, 413, { error: AVATAR_ERRORS.size });
      const type = imageType(file);
      if (!type) return json(res, 415, { error: AVATAR_ERRORS.type });
      avatarVersion += 1;
      myAvatar = { data: Buffer.from(file), type, version: avatarVersion };
      audit("avatar_change", "upload");
      return json(res, 200, { avatarUrl: avatarOf(me.userId) });
    }
    const avatarMatch = p.match(/^\/api\/avatar\/(\d+)$/);
    if (avatarMatch && method === "GET") {
      if (Number(avatarMatch[1]) !== me.userId || !myAvatar) return json(res, 404, { error: "아바타를 찾지 못했습니다." });
      res.writeHead(200, { "content-type": myAvatar.type, "cache-control": "private, max-age=300", "x-content-type-options": "nosniff" });
      return res.end(myAvatar.data);
    }
    // P4 공개 설정
    if (p === "/api/me/privacy" && method === "GET") return json(res, 200, { ...privacy });
    if (p === "/api/me/privacy" && method === "PATCH") {
      const b = await body(req);
      const keys = Object.keys(b || {});
      if (!keys.length || !keys.every((key) => Object.hasOwn(privacy, key) && typeof b[key] === "boolean")) return json(res, 400, { error: "공개 설정 값을 확인하세요." });
      Object.assign(privacy, b);
      return json(res, 200, { ...privacy });
    }

    // A2. 검색(쪽지 제외). 최신순 50개, before는 그보다 예전 것.
    if (p === "/api/search" && method === "GET") {
      const q = String(url.searchParams.get("q") || "").trim();
      if (!q) return json(res, 400, { error: "검색어를 입력하세요." });
      const scope = url.searchParams.get("view") || "all";
      const rawBefore = url.searchParams.get("before");
      const anchor = anchorParams(new URLSearchParams(rawBefore ? { before: rawBefore } : {}));
      if (anchor.error) return json(res, 400, { error: anchor.error });
      let lists;
      if (scope === "all") lists = allConversations();
      else if (scope === "general") lists = allConversations().filter((c) => c.view === "general");
      else if (scope === "dm") {
        const rawUser = url.searchParams.get("userId");
        lists = allConversations().filter((c) => c.view === "dm" && (!rawUser || c.peerId === Number(rawUser)));
      } else if (scope === "group") {
        const found = myGroup(url.searchParams.get("groupId"));
        if (found.error) return json(res, found.status, { error: found.error });
        lists = allConversations().filter((c) => c.view === "group" && c.groupId === found.group.groupId);
      } else return json(res, 400, { error: "검색 범위를 확인하세요." });
      const words = q.toLowerCase().split(/\s+/);
      const hits = lists
        .flatMap((c) => c.list)
        .filter((m) => !m.recalled && (!anchor.before || m.id < anchor.before))
        .filter((m) => words.every((w) => m.content.toLowerCase().includes(w) || m.attachments.some((a) => a.name.toLowerCase().includes(w))))
        .sort((a, b) => b.id - a.id);
      return json(res, 200, { messages: hits.slice(0, 50).map((m) => present(m)), hasOlder: hits.length > 50 });
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
      const group = { groupId: nextGroupId++, name, memberIds, dept: false };
      groups.set(group.groupId, group);
      groupMessages[group.groupId] = [];
      return json(res, 200, { group });
    }
    const groupMatch = p.match(/^\/api\/groups\/(\d+)(\/members(?:\/me)?)?$/);
    if (groupMatch) {
      const found = myGroup(groupMatch[1]);
      if (found.error) return json(res, found.status, { error: found.error });
      const group = found.group;
      // A6: 부서방은 관리자 동기화(2-C dept-sync)로만 바뀐다.
      if (group.dept && ["PATCH", "POST", "DELETE"].includes(method)) {
        return json(res, 403, { error: "부서 대화방은 이름을 바꾸거나 초대·나가기를 할 수 없습니다." });
      }
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
      const blocked = blockedBy(policy, extensionOf(name)); // D1: 서버 기본 목록 + 관리자 정책
      if (blocked) {
        req.resume();
        return json(res, 415, { error: blocked.builtIn ? "이 형식의 파일은 보낼 수 없습니다." : POLICY_BLOCKED_ERROR });
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
    // B8: 대화방 파일 모아 보기. 최신 메시지부터, 메시지 단위로 끊는다(before = messageId).
    if (p === "/api/files/list" && method === "GET") {
      const rawBefore = url.searchParams.get("before");
      const anchor = anchorParams(new URLSearchParams(rawBefore ? { before: rawBefore } : {}));
      if (anchor.error) return json(res, 400, { error: anchor.error });
      const scope = url.searchParams.get("view");
      let list;
      if (scope === "group") {
        const found = myGroup(url.searchParams.get("groupId"));
        if (found.error) return json(res, found.status, { error: found.error });
        list = groupMessages[found.group.groupId] || [];
      } else if (scope === "dm") list = dms[Number(url.searchParams.get("userId"))] || [];
      else list = general;
      const withFiles = list.filter((m) => !m.recalled && m.attachments.length && (!anchor.before || m.id < anchor.before)).sort((a, b) => b.id - a.id);
      const out = [];
      let used = 0;
      for (const m of withFiles) {
        if (out.length >= 100) break;
        used += 1;
        for (const a of m.attachments) out.push({ ...a, messageId: m.id, senderName: m.senderName, timestamp: m.timestamp });
      }
      return json(res, 200, { files: out, hasOlder: withFiles.length > used });
    }
    if (p.startsWith("/api/files/") && method === "GET") {
      const filePath = p.slice("/api/files".length);
      const file = filePath.startsWith("/user_uploads/") ? files.get(filePath) : null;
      if (!file) return json(res, 404, { error: "파일을 찾지 못했습니다." });
      const fileName = downloadName(filePath, url.searchParams.get("name"));
      if (!fileName) return json(res, 415, { error: "이 형식의 파일은 내려받을 수 없습니다." });
      audit("file_download", filePath);
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
    // B2: 항목이 { presence, status: { code, text } }로 넓어졌다(2-B). code ""는 수동 상태 없음.
    if (p === "/api/presence" && method === "GET") {
      const all = { ...presence, [me.userId]: myStatus };
      const out = {};
      for (const [id, value] of Object.entries(all)) out[id] = { presence: value, status: statuses.get(Number(id)) || { code: "", text: "" } };
      return json(res, 200, { presence: out });
    }
    if (p === "/api/status" && method === "POST") {
      const b = await body(req);
      const code = typeof b.code === "string" ? b.code : "";
      const text = typeof b.text === "string" ? b.text.replace(/\s+/g, " ").trim() : "";
      if (code && !STATUS_CODES.includes(code)) return json(res, 400, { error: "상태를 확인하세요." });
      if (text.length > 60) return json(res, 400, { error: "상태 문구는 60자까지 쓸 수 있습니다." });
      if (!code && !text) statuses.delete(me.userId);
      else statuses.set(me.userId, { code, text });
      return json(res, 200, { status: statuses.get(me.userId) || { code: "", text: "" } });
    }

    // B4·B5: 대화방 즐겨찾기·알림 끄기·방해 금지(상상톡 서버의 사용자 설정)
    // 3단계: notify·display·chat·presence·lock 추가(검사는 lib/settings.mjs, 실제 서버와 같음). 응답에 locked(정책으로 고정된 필드).
    if (p === "/api/prefs" && method === "GET") return json(res, 200, presentPrefs(prefsRecord, { policy }));
    if (p === "/api/prefs" && method === "PATCH") {
      const result = applyPrefsPatch(prefsRecord, await body(req), { adminLockMinutes: AUTO_LOCK_MINUTES, policy });
      if (!result.change) return json(res, result.status, { error: result.error });
      prefsRecord = result.change;
      prefsChanged();
      return json(res, 200, presentPrefs(prefsRecord, { policy }));
    }

    // B4: 별표 목록(최신순 100개, 쪽지 제외)
    if (p === "/api/starred" && method === "GET") {
      const rawBefore = url.searchParams.get("before");
      const anchor = anchorParams(new URLSearchParams(rawBefore ? { before: rawBefore } : {}));
      if (anchor.error) return json(res, 400, { error: anchor.error });
      const list = allConversations().flatMap((c) => c.list)
        .filter((m) => starredIds.has(m.id) && (!anchor.before || m.id < anchor.before))
        .sort((a, b) => b.id - a.id);
      return json(res, 200, { messages: list.slice(0, PAGE).map((m) => present(m)), hasOlder: list.length > PAGE });
    }

    // B6: 입력 중. 목업은 확인만 한다(다른 사람의 입력 중은 /api/dev/simulate "typing").
    if (p === "/api/typing" && method === "POST") {
      const b = await body(req);
      if (b.op !== "start" && b.op !== "stop") return json(res, 400, { error: "입력 상태를 확인하세요." });
      if (b.view === "group") {
        const found = myGroup(b.groupId);
        if (found.error) return json(res, found.status, { error: found.error });
      } else if (b.view === "dm") {
        if (!people.some((x) => x.userId === Number(b.userId))) return json(res, 400, { error: "대화 상대를 확인하세요." });
      } else if (b.view !== "general") return json(res, 400, { error: "대화방을 확인하세요." });
      return json(res, 200, { ok: true });
    }

    // B7: 예약 메시지
    if (p === "/api/scheduled" && method === "GET") {
      return json(res, 200, { scheduled: scheduled.map(({ timer, ...item }) => item).sort((a, b) => a.scheduledAt - b.scheduledAt) });
    }
    if (p === "/api/scheduled" && method === "POST") {
      const b = await body(req);
      if (b.urgent) return json(res, 400, { error: "예약 메시지는 중요 메시지로 보낼 수 없습니다." });
      const content = typeof b.content === "string" ? b.content.trim() : "";
      const attachments = cleanAttachments(b.attachments, false);
      if (!content && !attachments.length) return json(res, 400, { error: "메시지를 입력하세요." });
      const at = Number(b.scheduledAt);
      const nowSec = Math.floor(Date.now() / 1000);
      if (!Number.isSafeInteger(at) || at < nowSec + 60 || at > nowSec + 366 * 86400) {
        return json(res, 400, { error: "예약 시간은 1분 뒤부터 1년 안으로 고르세요." });
      }
      const target = { view: b.view, userId: null, groupId: null };
      if (b.view === "group") {
        const found = myGroup(b.groupId);
        if (found.error) return json(res, found.status, { error: found.error });
        target.groupId = found.group.groupId;
      } else if (b.view === "dm") {
        const userId = Number(b.userId);
        if (!people.some((x) => x.userId === userId)) return json(res, 400, { error: "대화 상대를 확인하세요." });
        target.userId = userId;
      } else if (b.view !== "general") return json(res, 400, { error: "대화방을 확인하세요." });
      const mentions = Array.isArray(b.mentions) ? [...new Set(b.mentions.map(Number).filter((id) => people.some((x) => x.userId === id)))] : [];
      const item = { id: nextScheduledId++, ...target, content, attachments, mentions, scheduledAt: at };
      // 목업은 실제로 그 시간에 보낸다(25일 안쪽만).
      const delay = (at - nowSec) * 1000;
      if (delay < 2 ** 31 - 1) {
        item.timer = setTimeout(() => {
          const index = scheduled.indexOf(item);
          if (index === -1) return;
          scheduled.splice(index, 1);
          const kind = item.view === "general" ? "channel" : item.view;
          const message = msg({ senderId: me.userId, kind, peerId: item.userId, groupId: item.groupId, content: item.content, attachments: item.attachments, mentions: item.mentions });
          if (kind === "group") (groupMessages[item.groupId] ||= []).push(message);
          else if (kind === "dm") (dms[item.userId] ||= []).push(message);
          else general.push(message);
          pushMessage(message);
        }, delay);
        item.timer.unref?.();
      }
      scheduled.push(item);
      const { timer, ...shown } = item;
      return json(res, 200, { scheduled: shown });
    }
    const scheduledMatch = p.match(/^\/api\/scheduled\/(\d+)$/);
    if (scheduledMatch && method === "DELETE") {
      const index = scheduled.findIndex((item) => item.id === Number(scheduledMatch[1]));
      if (index === -1) return json(res, 404, { error: "예약 메시지를 찾지 못했습니다." });
      clearTimeout(scheduled[index].timer);
      scheduled.splice(index, 1);
      return json(res, 200, { ok: true });
    }

    // 개발용 흉내
    if (p === "/api/dev/simulate" && method === "POST") {
      const b = await body(req);
      const from = Number(b.from) || 2;
      if (b.type === "groupsChanged") {
        const group = { groupId: nextGroupId++, name: "새로 초대된 그룹", memberIds: [me.userId, from, 3], dept: false };
        groups.set(group.groupId, group);
        groupMessages[group.groupId] = [];
        groupsChanged();
        return json(res, 200, { ok: true, group });
      }
      if (b.type === "rateLimit") {
        rateLimitLeft = Math.max(1, Math.min(20, Number(b.count) || 1));
        return json(res, 200, { ok: true, count: rateLimitLeft });
      }
      if (b.type === "vote") {
        const target = groupMessages[12].find((m) => m.poll);
        const option = target.poll.options[0];
        if (!option.voterIds.includes(from)) option.voterIds.push(from);
        pushUpdated(target);
        return json(res, 200, { ok: true, message: present(target) });
      }
      if (b.type === "typing") {
        const view = b.view === "group" || b.view === "general" ? b.view : "dm";
        const group = view === "group" ? groups.get(Number(b.groupId)) || myGroups()[0] : null;
        const sender = group ? group.memberIds.find((id) => id !== me.userId) : from;
        const entry = { view, userId: view === "dm" ? sender : null, groupId: group ? group.groupId : null, senderId: sender, op: b.op === "stop" ? "stop" : "start" };
        broadcast((client) => client.typing.push(entry));
        return json(res, 200, { ok: true, typing: entry });
      }
      if (b.type === "reaction") {
        const list = groupMessages[12];
        const target = list[list.length - 1];
        let reaction = target.reactions.find((r) => r.emoji === "thumbs_up");
        if (!reaction) target.reactions.push((reaction = { emoji: "thumbs_up", userIds: [] }));
        if (!reaction.userIds.includes(from)) reaction.userIds.push(from);
        pushUpdated(target);
        return json(res, 200, { ok: true, message: present(target) });
      }
      if (b.type === "status") {
        statuses.set(from, { code: "meeting", text: "회의 중" });
        return json(res, 200, { ok: true });
      }
      // ---- 3단계 흉내 ----
      if (b.type === "prefs") {
        prefsChanged();
        return json(res, 200, { ok: true });
      }
      if (b.type === "policy") {
        if (typeof b.forcePreviewHidden === "boolean") policy = { ...policy, forcePreviewHidden: b.forcePreviewHidden };
        policyChanged();
        return json(res, 200, { ok: true, policy: presentPolicy(policy, { maxUploadMb: MAX_UPLOAD_MB }) });
      }
      if (b.type === "reactMine") {
        const target = allConversations().flatMap((c) => c.list).filter((m) => m.senderId === me.userId && !m.recalled).sort((x, y) => y.id - x.id)[0];
        if (!target) return json(res, 400, { error: "내가 보낸 메시지가 없습니다." });
        let reaction = target.reactions.find((r) => r.emoji === "clap");
        if (!reaction) target.reactions.push((reaction = { emoji: "clap", userIds: [] }));
        if (!reaction.userIds.includes(from)) reaction.userIds.push(from);
        reactionAt.set(`${target.id}:${from}:clap`, Math.floor(Date.now() / 1000));
        pushUpdated(target);
        activityChanged();
        return json(res, 200, { ok: true, message: present(target) });
      }
      if (b.type === "ack") {
        const entry = [...notices.entries()].find(([, n]) => n.ackRequired && n.ackUserIds.includes(from) && !n.acks.has(from));
        if (!entry) return json(res, 400, { error: "그 직원이 확인할 확인 요청 공지가 없습니다." });
        entry[1].acks.set(from, Math.floor(Date.now() / 1000));
        noticesChanged();
        return json(res, 200, { ok: true, notice: noticeFor(entry[0]) });
      }
      if (b.type === "read") {
        // from이 자기가 속한 대화의 내 메시지를 모두 읽는다. 실제처럼 이벤트는 없다(화면이 30초마다 다시 읽음).
        let count = 0;
        for (const { list } of allConversations()) {
          for (const m of list) {
            if (m.senderId === me.userId && participants(m).includes(from)) {
              if (!readBy.has(m.id)) readBy.set(m.id, new Set());
              if (!readBy.get(m.id).has(from)) count += 1;
              readBy.get(m.id).add(from);
            }
          }
        }
        return json(res, 200, { ok: true, read: count });
      }
      if (b.type === "edit" || b.type === "recall") {
        const target = allConversations().flatMap((c) => c.list).filter((m) => m.senderId === from && !m.recalled).sort((x, y) => y.id - x.id)[0];
        if (!target) return json(res, 400, { error: "그 직원이 보낸 메시지가 없습니다." });
        if (b.type === "edit") Object.assign(target, { content: `${target.content} (고침)`, edited: true });
        else {
          Object.assign(target, { content: RECALLED_TEXT, attachments: [], recalled: true, edited: true, replyTo: null, mentions: [] });
          let noticeGone = false;
          for (const [key, notice] of notices) if (notice.messageId === target.id && notices.delete(key)) noticeGone = true;
          if (noticeGone) noticesChanged();
        }
        pushUpdated(target);
        return json(res, 200, { ok: true, message: present(target) });
      }
      if (b.type === "notice") {
        const group = groups.get(Number(b.groupId)) || myGroups()[0];
        const list = groupMessages[group.groupId] || [];
        const last = list[list.length - 1];
        if (!last) return json(res, 400, { error: "그룹에 메시지가 없습니다." });
        const setBy = group.memberIds.find((id) => id !== me.userId) || from;
        const notice = { messageId: last.id, setBy, setAt: Math.floor(Date.now() / 1000) };
        // { ackRequired: true }면 확인 요청 공지(나도 확인 대상)
        if (b.ackRequired) Object.assign(notice, { ackRequired: true, ackUserIds: group.memberIds.filter((id) => id !== setBy), acks: new Map() });
        notices.set(`group:${group.groupId}`, notice);
        logNotice(`group:${group.groupId}`, notice);
        noticesChanged();
        activityChanged();
        return json(res, 200, { ok: true, notice: noticeFor(`group:${group.groupId}`) });
      }
      let message;
      let activity = false;
      if (b.type === "reply") {
        const original = allConversations().flatMap((c) => c.list).filter((m) => m.senderId === me.userId && !m.recalled && m.kind !== "dm").sort((x, y) => y.id - x.id)[0];
        if (!original) return json(res, 400, { error: "내가 보낸 메시지가 없습니다." });
        const sender = original.kind === "group" ? groups.get(original.groupId).memberIds.find((id) => id !== me.userId) : from;
        message = msg({
          senderId: sender, kind: original.kind, groupId: original.groupId, content: "네, 확인했습니다.",
          replyTo: { id: original.id, senderId: original.senderId, senderName: original.senderName, excerpt: excerptOf(original) },
        });
        conversationOf(original).list.push(message);
        activity = true;
      } else if (b.type === "keyword") {
        const word = keywords[0] || "예산";
        message = msg({ senderId: from, kind: "channel", content: `${word} 관련 자료 확인 부탁드립니다.` });
        general.push(message);
        activity = true;
      } else if (b.type === "urgent") {
        const group = groups.get(Number(b.groupId)) || myGroups()[0];
        const sender = group.memberIds.find((id) => id !== me.userId) || from;
        message = msg({ senderId: sender, kind: "group", groupId: group.groupId, content: "긴급: 오늘 15시까지 회신 바랍니다.", extra: { urgent: true } });
        (groupMessages[group.groupId] ||= []).push(message);
      } else if (b.type === "mention") {
        activity = true;
        const group = groups.get(Number(b.groupId)) || myGroups()[0];
        const sender = group.memberIds.find((id) => id !== me.userId) || from;
        message = msg({ senderId: sender, kind: "group", groupId: group.groupId, content: `@${me.fullName} 확인 부탁드립니다.`, mentions: [me.userId] });
        (groupMessages[group.groupId] ||= []).push(message);
      } else if (b.type === "group") {
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
      if (activity) activityChanged();
      return json(res, 200, { ok: true, message: present(message) });
    }

    // ---- C1 관리자 화면·API(관리자·소유자만). 모든 관리 요청은 감사 로그에 남는다. ----
    if (p === "/admin" || p === "/admin.html") {
      if (!isAdmin) {
        res.writeHead(403, { "content-type": "text/html; charset=utf-8" });
        return res.end("<!doctype html><meta charset=utf-8><title>상상톡</title><p>관리자만 볼 수 있습니다.</p>");
      }
      const data = await readFile(path.join(root, "admin.html"));
      res.writeHead(200, { "content-type": types[".html"], "cache-control": "no-store" });
      return res.end(data);
    }
    if (p.startsWith("/api/admin/")) {
      if (!isAdmin) return json(res, 403, { error: "관리자만 할 수 있습니다." });
      if (p === "/api/admin/users" && method === "GET") {
        audit("admin_users_list", "");
        return json(res, 200, { users: [...staff.keys()].map(adminUser) });
      }
      if (p === "/api/admin/users" && method === "POST") {
        const b = await body(req);
        const fullName = typeof b.fullName === "string" ? b.fullName.trim() : "";
        const loginId = typeof b.loginId === "string" ? b.loginId.trim() : "";
        if (!fullName || !/^[^\s@]+@[^\s@]+$/.test(loginId) || typeof b.password !== "string" || b.password.length < 8) {
          audit("admin_user_create", loginId, false);
          return json(res, 400, { error: "이름, 로그인 ID(사번@도메인), 8자 이상 비밀번호를 입력하세요." });
        }
        const userId = nextUserId++;
        people.push({ userId, fullName, role: "member", title: [b.position, b.department].filter(Boolean).join(" · "), avatarUrl: "" });
        staff.set(userId, { department: String(b.department || ""), position: String(b.position || ""), role: "member", active: true, mustChangePassword: true });
        audit("admin_user_create", userId);
        return json(res, 200, { user: adminUser(userId) });
      }
      const adminMatch = p.match(/^\/api\/admin\/users\/(\d+)(\/deactivate|\/reactivate|\/password|\/logout)?$/);
      if (adminMatch) {
        const userId = Number(adminMatch[1]);
        const info = staff.get(userId);
        if (!info) return json(res, 404, { error: "직원을 찾지 못했습니다." });
        // 그 직원의 상상톡 세션을 모두 끊는다. Zulip API 키는 관리자 API로 바꿀 수 없다(apiKeyRenewed: false).
        if (adminMatch[2] === "/logout" && method === "POST") {
          audit("admin_user_logout", `${userId}:0`);
          return json(res, 200, { ended: 0, apiKeyRenewed: false });
        }
        if (adminMatch[2] === "/password" && method === "POST") {
          audit("admin_password", userId, false);
          return json(res, 501, { error: "비밀번호 초기화는 서버 관리자에게 요청하세요." });
        }
        if ((adminMatch[2] === "/deactivate" || adminMatch[2] === "/reactivate") && method === "POST") {
          if (userId === me.userId) return json(res, 400, { error: "나 자신은 퇴직 처리할 수 없습니다." });
          info.active = adminMatch[2] === "/reactivate";
          info.deactivatedAt = info.active ? null : new Date().toISOString();
          audit(info.active ? "admin_user_reactivate" : "admin_user_deactivate", userId);
          return json(res, 200, { user: adminUser(userId) });
        }
        if (!adminMatch[2] && method === "PATCH") {
          const b = await body(req);
          if (b.role !== undefined && !ROLE_NAMES.includes(b.role)) return json(res, 400, { error: "역할을 확인하세요." });
          if (b.role !== undefined && userId === me.userId) return json(res, 400, { error: "내 역할은 바꿀 수 없습니다." });
          const person = people.find((x) => x.userId === userId);
          if (typeof b.fullName === "string" && b.fullName.trim() && person) person.fullName = b.fullName.trim();
          if (typeof b.department === "string") info.department = b.department.trim();
          if (typeof b.position === "string") info.position = b.position.trim();
          if (b.role !== undefined) info.role = b.role;
          if (b.mustChangePassword !== undefined) {
            if (typeof b.mustChangePassword !== "boolean") return json(res, 400, { error: "비밀번호 변경 요청 값을 확인하세요." });
            info.mustChangePassword = b.mustChangePassword;
          }
          if (person) person.title = [info.position, info.department].filter(Boolean).join(" · ");
          audit("admin_user_update", userId);
          return json(res, 200, { user: adminUser(userId) });
        }
      }
      // 부서별 비공개 대화방을 만들고 인원을 부서 칸에 맞춘다(퇴직자는 뺀다). GET ?dryRun=1은 미리 보기만.
      // details: [{ name, action: "create"|"restore"|"update"|"none"|"conflict", add: [userId], remove: [userId] }]
      if (p === "/api/admin/dept-sync" && (method === "POST" || method === "GET")) {
        const dryRun = method === "GET";
        if (dryRun && url.searchParams.get("dryRun") !== "1") return json(res, 400, { error: "dryRun=1로 미리 보기만 할 수 있습니다." });
        const byDept = new Map();
        for (const [userId, info] of staff) if (info.active && info.department) (byDept.get(info.department) || byDept.set(info.department, []).get(info.department)).push(userId);
        const rooms = [...groups.values()].filter((g) => g.dept);
        const names = [...new Set([...byDept.keys(), ...rooms.map((g) => g.name)])].sort((a, b) => a.localeCompare(b, "ko"));
        const details = [];
        for (const name of names) {
          const memberIds = [...(byDept.get(name) || [])].sort((a, b) => a - b);
          const group = rooms.find((g) => g.name === name);
          if (!group) {
            if (!memberIds.length) continue;
            if ([...groups.values()].some((g) => !g.dept && g.name === name)) details.push({ name, action: "conflict", add: [], remove: [] });
            else details.push({ name, action: "create", add: memberIds, remove: [] });
            continue;
          }
          const add = memberIds.filter((id) => !group.memberIds.includes(id));
          const remove = group.memberIds.filter((id) => !memberIds.includes(id));
          details.push({ name, action: add.length || remove.length ? "update" : "none", add, remove });
        }
        if (!dryRun) {
          for (const item of details) {
            if (item.action === "conflict" || item.action === "none") continue;
            let group = rooms.find((g) => g.name === item.name);
            if (!group) {
              group = { groupId: nextGroupId++, name: item.name, memberIds: [], dept: true };
              groups.set(group.groupId, group);
              groupMessages[group.groupId] = [];
            }
            group.memberIds = [...group.memberIds.filter((id) => !item.remove.includes(id)), ...item.add].sort((a, b) => a - b);
          }
        }
        const count = (action) => details.filter((item) => item.action === action).length;
        const result = {
          dryRun,
          created: count("create"),
          restored: 0,
          added: details.reduce((sum, item) => sum + item.add.length, 0),
          removed: details.reduce((sum, item) => sum + item.remove.length, 0),
          conflicts: details.filter((item) => item.action === "conflict").map((item) => item.name),
          details,
        };
        if (dryRun) audit("admin_dept_sync_preview", "");
        else {
          audit("admin_dept_sync", `${result.created}+0/${result.added}/${result.removed}`);
          groupsChanged();
        }
        return json(res, 200, result);
      }
      // D1 관리자 정책. blockedExtensions는 합친 목록, builtInExtensions는 뺄 수 없는 서버 기본 목록.
      if (p === "/api/admin/policy" && method === "GET") return json(res, 200, presentPolicy(policy, { maxUploadMb: MAX_UPLOAD_MB }));
      if (p === "/api/admin/policy" && method === "PATCH") {
        const result = applyPolicyPatch(policy, await body(req));
        if (!result.change) {
          audit("admin_policy", "", false);
          return json(res, result.status, { error: result.error });
        }
        policy = result.change;
        audit("admin_policy", `preview:${policy.forcePreviewHidden ? 1 : 0},ext:${policy.blockedExtensions.length}`);
        policyChanged();
        return json(res, 200, presentPolicy(policy, { maxUploadMb: MAX_UPLOAD_MB }));
      }
      if (p === "/api/admin/audit" && method === "GET") {
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        const userId = url.searchParams.get("userId");
        const action = url.searchParams.get("action");
        const day = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
        if ((from && !day(from)) || (to && !day(to)) || (userId && !Number.isSafeInteger(Number(userId))) || (action && !/^[a-z_]{1,40}\*?$/.test(action))) {
          return json(res, 400, { error: "검색 조건을 확인하세요." });
        }
        audit("admin_audit_view", "");
        const entries = auditLog
          .filter((e) => (!from || e.at.slice(0, 10) >= from) && (!to || e.at.slice(0, 10) <= to))
          .filter((e) => (!userId || e.userId === Number(userId)) && (!action || (action.endsWith("*") ? e.action.startsWith(action.slice(0, -1)) : e.action === action)))
          .slice(-1000)
          .reverse();
        return json(res, 200, { entries });
      }
      return json(res, 404, { error: "없는 주소입니다." });
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
