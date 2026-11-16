// Zulip 없이 UI를 확인하는 가짜 API 서버. web/public을 그대로 제공하고 /api/*는 예시 데이터로 답한다.
// 실행: node web/dev/mock-server.mjs [public 경로] [포트]  (기본: ../public, 43190)
// 실제 서버(web/server.mjs)의 응답 형태가 바뀌면 이 파일도 맞춘다.
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.argv[2] || fileURLToPath(new URL("../public/", import.meta.url));
const port = Number(process.argv[3] || 43190);
const now = Math.floor(Date.now() / 1000);
const me = { userId: 1, email: "me@localhost.localdomain", fullName: "홍길동" };
const people = [
  { userId: 2, fullName: "김민준", role: "member", title: "주무관 · 기획예산과", avatarUrl: "" },
  { userId: 3, fullName: "이지은", role: "member", title: "팀장 · 문화체육과", avatarUrl: "" },
  { userId: 4, fullName: "박서연", role: "admin", title: "", avatarUrl: "" },
  { userId: 5, fullName: "정하윤", role: "member", title: "주무관 · 민원과", avatarUrl: "" },
];
let nextId = 500;
const general = [
  { id: 101, senderId: 4, senderName: "박서연", content: "좋은 아침입니다! 오늘 오후 회의 자료 공유드릴게요.", timestamp: now - 86400 - 3000, topic: "회의", kind: "channel" },
  { id: 102, senderId: 2, senderName: "김민준", content: "3쪽 예산 항목은 어제 수정본 기준인가요?", timestamp: now - 3600, topic: "회의", kind: "channel" },
  { id: 103, senderId: 1, senderName: "홍길동", content: "네, 어제 오후 6시 수정본 기준으로 반영했어요.", timestamp: now - 3500, topic: "회의", kind: "channel" },
  { id: 104, senderId: 1, senderName: "홍길동", content: "회의실은 2층 소회의실로 잡아두었습니다.", timestamp: now - 3450, topic: "회의", kind: "channel" },
  { id: 105, senderId: 4, senderName: "박서연", content: "회의실 예약 확인했습니다 🙂", timestamp: now - 1200, topic: "회의", kind: "channel" },
];
const dms = {
  2: [
    { id: 201, senderId: 2, senderName: "김민준", content: "예산서 수정본 보내드렸습니다.", timestamp: now - 2000, kind: "dm", peerId: 2 },
    { id: 202, senderId: 2, senderName: "김민준", content: "확인 부탁드려요.", timestamp: now - 1900, kind: "dm", peerId: 2 },
  ],
  3: [{ id: 301, senderId: 1, senderName: "홍길동", content: "오후 2시에 뵙겠습니다.", timestamp: now - 90000, kind: "dm", peerId: 3 }],
};
const notes = [
  { id: 401, senderId: 5, senderName: "정하윤", content: "현장 사진 4장 메일로 보냈습니다.", timestamp: now - 7200, kind: "dm", peerId: 5, note: true, direction: "received", counterpartName: "정하윤" },
  { id: 402, senderId: 1, senderName: "홍길동", content: "받았습니다. 고맙습니다.", timestamp: now - 7000, kind: "dm", peerId: 5, note: true, direction: "sent", counterpartName: "정하윤" },
];
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png" };

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
async function body(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw || "{}");
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  if (p === "/api/session" || p === "/api/login") return json(res, 200, me);
  if (p === "/api/logout") return json(res, 200, { ok: true });
  if (p === "/api/directory") return json(res, 200, { people });
  if (p === "/api/notes") return json(res, 200, { notes: notes.map((n) => ({ messageId: n.id, senderId: n.senderId })) });
  if (p === "/api/notes/messages") return json(res, 200, { messages: notes });
  if (p === "/api/events") return setTimeout(() => json(res, 200, { messages: [], notes: notes.map((n) => ({ messageId: n.id })) }), 20000);
  if (p === "/api/messages" && req.method === "GET") {
    const view = url.searchParams.get("view");
    const list = view === "dm" ? dms[url.searchParams.get("userId")] || [] : general;
    return json(res, 200, { messages: list, hasOlder: false });
  }
  if (p === "/api/messages" && req.method === "POST") {
    const b = await body(req);
    const message = { id: nextId++, senderId: 1, senderName: me.fullName, content: b.content, timestamp: Math.floor(Date.now() / 1000), topic: "회의", kind: b.view === "dm" ? "dm" : "channel", peerId: b.userId };
    if (b.note) notes.push({ ...message, note: true, direction: "sent", counterpartName: people.find((x) => x.userId === b.userId)?.fullName });
    else if (b.view === "dm") (dms[b.userId] ||= []).push(message);
    else general.push(message);
    return json(res, 200, { message });
  }
  const file = p === "/" ? "index.html" : p.slice(1);
  try {
    const data = await readFile(path.join(root, file));
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
}).listen(port, "127.0.0.1", () => console.log(`mock on ${port}`));
