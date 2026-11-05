import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";
import { randomBytes } from "node:crypto";
import { createNoteStore } from "./lib/note-store.mjs";

// The browser talks only to this process. Zulip is served with a self-signed
// certificate and does not allow this origin via CORS, so API calls are proxied
// here. rejectUnauthorized is disabled only for that upstream request.
const PORT = Number(process.env.PORT || 43123);
const HOSTS = ["127.0.0.1", "::1"];
const CHANNEL = "general";
const TOPIC = "대화";
const zulipUrl = new URL(process.env.ZULIP_ORIGIN || "https://localhost.localdomain:9991");
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const sessions = new Map();
const noteStore = createNoteStore(path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "notes.json"));
const NOTES_ERROR = "쪽지 기록을 읽지 못했습니다. 다시 시도하세요.";

function asNotesError(error) {
  if (error?.code !== "NOTES_STORE") return error;
  error.status = 503;
  error.publicMessage = NOTES_ERROR;
  return error;
}

async function noteRecords(session) {
  try {
    return await noteStore.listForUser(session.userId);
  } catch (error) {
    throw asNotesError(error);
  }
}


const PUBLIC_FILES = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/styles.css", "styles.css"],
  ["/app.js", "app.js"],
  ["/favicon.svg", "favicon.svg"],
]);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

function zulip(method, apiPath, { auth, form, timeoutMs = 20000, signal } = {}) {
  const body = form ? new URLSearchParams(form).toString() : null;
  const headers = {
    accept: "application/json",
    "user-agent": "SangsangTalk/0.1",
  };
  if (auth) headers.authorization = auth;
  if (body) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    headers["content-length"] = Buffer.byteLength(body);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const request = https.request({
      hostname: zulipUrl.hostname,
      port: zulipUrl.port || 443,
      servername: zulipUrl.hostname,
      method,
      path: apiPath,
      headers,
      rejectUnauthorized: false,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        settle(resolve, { status: response.statusCode, json });
      });
    });
    timer = setTimeout(() => {
      settle(reject, Object.assign(new Error("timeout"), { timeout: true }));
      request.destroy();
    }, timeoutMs);
    request.on("error", (error) => {
      if (signal?.aborted) {
        settle(reject, Object.assign(new Error("aborted"), { aborted: true }));
        return;
      }
      settle(reject, error);
    });
    if (signal) {
      if (signal.aborted) {
        request.destroy();
        settle(reject, Object.assign(new Error("aborted"), { aborted: true }));
        return;
      }
      signal.addEventListener("abort", () => {
        request.destroy();
        settle(reject, Object.assign(new Error("aborted"), { aborted: true }));
      }, { once: true });
    }
    if (body) request.write(body);
    request.end();
  });
}

function basic(session) {
  return `Basic ${Buffer.from(`${session.email}:${session.apiKey}`).toString("base64")}`;
}

function enqueue(session, task) {
  const previous = session.tail || Promise.resolve();
  const run = previous.then(task, task);
  session.tail = run.then(() => undefined, () => undefined);
  return run;
}

function normalize(message, session) {
  const base = {
    id: message.id,
    senderId: message.sender_id,
    senderName: message.sender_full_name || message.sender_email || "\uC54C \uC218 \uC5C6\uC74C",
    senderEmail: message.sender_email || "",
    topic: message.subject || "",
    content: typeof message.content === "string" ? message.content : "",
    timestamp: message.timestamp,
    kind: null,
    peerId: null,
  };
  if (isGeneral(message)) {
    base.kind = "channel";
    return base;
  }
  if (Array.isArray(message.display_recipient) && session) {
    const ids = message.display_recipient.map((person) => person.id);
    if (ids.length === 2 && ids.includes(session.userId)) {
      base.kind = "dm";
      base.peerId = ids.find((id) => id !== session.userId);
      return base;
    }
  }
  return null;
}

function isGeneral(message) {
  return typeof message.display_recipient === "string"
    && message.display_recipient.toLowerCase() === CHANNEL;
}

async function ensureQueue(session) {
  if (session.queueId) return;
  const response = await zulip("POST", "/api/v1/register", {
    auth: basic(session),
    form: {
      event_types: JSON.stringify(["message"]),
    },
  });
  if (response.json?.result !== "success" || !response.json.queue_id) {
    const error = new Error("queue");
    error.zulipStatus = response.status;
    error.zulipCode = response.json?.code;
    throw error;
  }
  session.queueId = response.json.queue_id;
  session.lastEventId = response.json.last_event_id;
}

function readBody(request, limit = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("too large"), { status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

async function readJson(request) {
  const text = await readBody(request);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("json"), { status: 400 });
  }
}

function sendJson(response, status, payload, cookies = []) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  if (cookies.length) headers["set-cookie"] = cookies;
  response.writeHead(status, headers);
  response.end(JSON.stringify(payload));
}

function cookieValue(request, name) {
  const header = request.headers.cookie || "";
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return "";
}

function sessionFrom(request) {
  const sid = cookieValue(request, "sangsang_sid");
  if (!sid) return null;
  return sessions.get(sid) || null;
}

function sessionCookie(sid, maxAge) {
  return `sangsang_sid=${encodeURIComponent(sid)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function publicUser(session) {
  return {
    email: session.email,
    userId: session.userId,
    fullName: session.fullName,
    peer: session.peer || null,
  };
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function upstreamMessage(error) {
  if (error?.timeout) return "Zulip이 응답하지 않았습니다.";
  if (error?.code === "ECONNREFUSED" || error?.code === "ENOTFOUND" || error?.code === "EAI_AGAIN") {
    return "Zulip에 연결하지 못했습니다.";
  }
  return "Zulip 요청을 처리하지 못했습니다.";
}

async function findPeer(session) {
  const result = await zulip("GET", "/api/v1/users", { auth: basic(session) });
  const members = result.json?.members || [];
  const peer = members.find((user) => !user.is_bot && user.is_active !== false && user.user_id !== session.userId);
  if (!peer) return null;
  return {
    userId: peer.user_id,
    fullName: peer.full_name || peer.email,
    email: peer.email,
  };
}

async function handleLogin(request, response) {
  const body = await readJson(request);
  const email = String(body.email || "").trim();
  const password = String(body.password || "");
  if (!email.includes("@") || !password || password.length > 200) {
    sendJson(response, 400, { error: "이메일과 비밀번호를 입력하세요." });
    return;
  }
  const result = await zulip("POST", "/api/v1/fetch_api_key", {
    form: { username: email, password },
  });
  if (result.json?.result !== "success" || !result.json.api_key) {
    sendJson(response, 401, { error: "이메일 또는 비밀번호가 올바르지 않습니다." });
    return;
  }
  const session = {
    email: result.json.email || email,
    apiKey: result.json.api_key,
    userId: result.json.user_id,
    fullName: email.split("@")[0],
    queueId: null,
    lastEventId: -1,
    tail: Promise.resolve(),
    peer: null,
  };
  try {
    const me = await zulip("GET", "/api/v1/users/me", { auth: basic(session) });
    if (me.json?.result === "success") {
      if (me.json.full_name) session.fullName = me.json.full_name;
      if (me.json.user_id) session.userId = me.json.user_id;
    }
  } catch {
    // The API key is enough to enter. The email local-part stands in for the name.
  }
  try {
    session.peer = await findPeer(session);
  } catch {
    session.peer = null;
  }
  const sid = randomBytes(32).toString("hex");
  sessions.set(sid, session);
  sendJson(response, 200, publicUser(session), [sessionCookie(sid, 60 * 60 * 12)]);
}

function roleName(role) {
  if (role === 100) return "owner";
  if (role === 200) return "admin";
  if (role === 300) return "moderator";
  if (role === 600) return "guest";
  return "member";
}

async function listDirectory(session) {
  const result = await zulip("GET", "/api/v1/users", { auth: basic(session) });
  if (result.json?.result !== "success" || !Array.isArray(result.json.members)) {
    const error = new Error("directory");
    error.status = result.status === 401 ? 401 : 502;
    throw error;
  }
  const people = result.json.members
    .filter((user) => !user.is_bot && user.is_active !== false && user.user_id !== session.userId)
    .map((user) => ({
      userId: user.user_id,
      fullName: user.full_name || "\uC774\uB984 \uC5C6\uC74C",
      role: roleName(user.role),
    }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName, "ko"));
  return { people };
}

async function personById(session, userId) {
  const id = Number(userId);
  if (!Number.isInteger(id)) {
    const error = new Error("user");
    error.status = 400;
    error.publicMessage = "\uC0AC\uC6A9\uC790\uB97C \uC120\uD0DD\uD558\uC138\uC694.";
    throw error;
  }
  const { people } = await listDirectory(session);
  const person = people.find((item) => item.userId === id);
  if (!person) {
    const error = new Error("user");
    error.status = 400;
    error.publicMessage = "\uB300\uD654\uD560 \uC218 \uC5C6\uB294 \uC0AC\uC6A9\uC790\uC785\uB2C8\uB2E4.";
    throw error;
  }
  return person;
}

async function handleMessages(session, view, userId) {
  const peer = view === "dm" ? await personById(session, userId) : null;
  await enqueue(session, () => ensureQueue(session));
  const narrow = view === "dm"
    ? [{ operator: "dm", operand: [peer.userId] }]
    : [{ operator: "channel", operand: CHANNEL }];
  const query = new URLSearchParams({
    anchor: "newest",
    num_before: "100",
    num_after: "0",
    apply_markdown: "false",
    narrow: JSON.stringify(narrow),
  });
  const result = await zulip("GET", `/api/v1/messages?${query}`, { auth: basic(session) });
  if (result.json?.result !== "success" || !Array.isArray(result.json.messages)) {
    const error = new Error("messages");
    error.status = result.status === 401 ? 401 : 502;
    throw error;
  }
  let messages = result.json.messages
    .map((message) => normalize(message, session))
    .filter(Boolean)
    .sort((a, b) => a.id - b.id);
  if (view === "dm") {
    const notes = await noteRecords(session);
    const noteIds = new Set(notes.map((note) => note.messageId));
    messages = messages.filter((message) => !noteIds.has(message.id));
  }
  return {
    view,
    channel: view === "dm" ? null : CHANNEL,
    peer,
    hasOlder: result.json.found_oldest === false,
    messages,
  };
}

async function handleSend(session, request) {
  const body = await readJson(request);
  const view = body.view === "dm" ? "dm" : "general";
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!content) {
    const error = new Error("empty");
    error.status = 400;
    error.publicMessage = "\uBA54\uC2DC\uC9C0\uB97C \uC785\uB825\uD558\uC138\uC694.";
    throw error;
  }
  if (content.length > 10000) {
    const error = new Error("long");
    error.status = 400;
    error.publicMessage = "\uBA54\uC2DC\uC9C0\uAC00 \uB108\uBB34 \uAE41\uB2C8\uB2E4.";
    throw error;
  }
  const peer = view === "dm" ? await personById(session, body.userId) : null;
  const form = view === "dm"
    ? { type: "direct", to: JSON.stringify([peer.userId]), content }
    : { type: "stream", to: CHANNEL, topic: TOPIC, content };
  const sent = await zulip("POST", "/api/v1/messages", { auth: basic(session), form });
  if (sent.json?.result !== "success" || !sent.json.id) {
    const error = new Error("send");
    error.status = sent.status === 401 ? 401 : 502;
    throw error;
  }
  const one = await zulip("GET", `/api/v1/messages/${sent.json.id}?apply_markdown=false`, {
    auth: basic(session),
  });
  const normalized = one.json?.message ? normalize(one.json.message, session) : null;
  const message = normalized || {
    id: sent.json.id,
    senderId: session.userId,
    senderName: session.fullName,
    senderEmail: session.email,
    topic: view === "dm" ? "" : TOPIC,
    content,
    timestamp: Math.floor(Date.now() / 1000),
    kind: view === "dm" ? "dm" : "channel",
    peerId: view === "dm" ? peer.userId : null,
  };
  if (body.note === true) {
    if (!peer) {
      const error = new Error("user");
      error.status = 400;
      error.publicMessage = "사용자를 선택하세요.";
      throw error;
    }
    try {
      await noteStore.add({
        messageId: message.id,
        senderId: session.userId,
        recipientId: peer.userId,
        timestamp: message.timestamp,
      });
    } catch (error) {
      throw asNotesError(error);
    }
    message.note = true;
  }
  return message;
}

async function classifyEvents(session, messages, reset) {
  try {
    const notes = await noteStore.listForUser(session.userId);
    const ids = new Set(notes.map((note) => note.messageId));
    return {
      messages: messages.filter((message) => message.kind !== "dm" || !ids.has(message.id)),
      notes,
      notesError: false,
      reset,
    };
  } catch (error) {
    if (error.code !== "NOTES_STORE") throw error;
    return {
      messages: messages.filter((message) => message.kind !== "dm"),
      notes: [],
      notesError: true,
      error: NOTES_ERROR,
      reset,
    };
  }
}

async function handleEvents(session, signal) {
  let queueId;
  let lastEventId;
  await enqueue(session, async () => {
    await ensureQueue(session);
    queueId = session.queueId;
    lastEventId = session.lastEventId;
  });
  const query = new URLSearchParams({
    queue_id: queueId,
    last_event_id: String(lastEventId),
  });
  let result;
  try {
    result = await zulip("GET", `/api/v1/events?${query}`, {
      auth: basic(session),
      timeoutMs: 55000,
      signal,
    });
  } catch (error) {
    if (error.timeout) return { messages: [], reset: false };
    throw error;
  }
  if (result.json?.code === "BAD_EVENT_QUEUE_ID") {
    await enqueue(session, async () => {
      if (session.queueId === queueId) {
        session.queueId = null;
        session.lastEventId = -1;
      }
    });
    return await classifyEvents(session, [], true);
  }
  if (result.json?.result !== "success") {
    const error = new Error("events");
    error.status = result.status === 401 ? 401 : 502;
    throw error;
  }
  const messages = [];
  let maxId = lastEventId;
  for (const event of result.json.events || []) {
    if (Number.isInteger(event.id) && event.id > maxId) maxId = event.id;
    if (event.type === "message" && event.message) {
      const normalized = normalize(event.message, session);
      if (normalized) messages.push(normalized);
    }
  }
  await enqueue(session, async () => {
    if (session.queueId === queueId && maxId > session.lastEventId) session.lastEventId = maxId;
  });
  return await classifyEvents(session, messages, false);
}

async function handleNoteMessages(session) {
  const notes = await noteRecords(session);
  const messages = [];
  for (const note of notes) {
    const one = await zulip("GET", `/api/v1/messages/${note.messageId}?apply_markdown=false`, { auth: basic(session) });
    if (!one.json?.message) continue;
    const normalized = normalize(one.json.message, session);
    if (!normalized) continue;
    const people = one.json.message.display_recipient;
    const other = Array.isArray(people) ? people.find((person) => person.id !== session.userId) : null;
    messages.push({
      ...normalized,
      note: true,
      direction: note.senderId === session.userId ? "sent" : "received",
      counterpartName: other?.full_name || normalized.senderName,
    });
  }
  return { messages };
}

async function onRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
  try {
    if (request.method === "GET" && PUBLIC_FILES.has(url.pathname)) {
      const filename = PUBLIC_FILES.get(url.pathname);
      const file = path.join(publicDir, filename);
      const data = await readFile(file);
      const ext = path.extname(filename);
      response.writeHead(200, {
        "content-type": TYPES[ext] || "application/octet-stream",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(data);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, { ok: true, service: "sangsangtalk" });
      return;
    }

    if (request.method === "POST" && !sameOrigin(request)) {
      sendJson(response, 403, { error: "이 출처에서는 요청할 수 없습니다." });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/login") {
      await handleLogin(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/logout") {
      const sid = cookieValue(request, "sangsang_sid");
      const session = sid ? sessions.get(sid) : null;
      if (session) {
        sessions.delete(sid);
        if (session.queueId) {
          zulip("DELETE", `/api/v1/events?${new URLSearchParams({ queue_id: session.queueId })}`, {
            auth: basic(session),
            timeoutMs: 5000,
          }).catch(() => {});
        }
      }
      sendJson(response, 200, { ok: true }, [sessionCookie("", 0)]);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/session/status") {
      sendJson(response, 200, { signedIn: Boolean(sessionFrom(request)) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/session") {
      const session = sessionFrom(request);
      if (!session) {
        sendJson(response, 401, { error: "로그인이 필요합니다." });
        return;
      }
      sendJson(response, 200, publicUser(session));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/notes") {
      const session = sessionFrom(request);
      if (!session) {
        sendJson(response, 401, { error: "로그인이 필요합니다." });
        return;
      }
      sendJson(response, 200, { notes: await noteRecords(session) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/notes/messages") {
      const session = sessionFrom(request);
      if (!session) {
        sendJson(response, 401, { error: "로그인이 필요합니다." });
        return;
      }
      sendJson(response, 200, await handleNoteMessages(session));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/directory") {
      const session = sessionFrom(request);
      if (!session) {
        sendJson(response, 401, { error: "\uB85C\uADF8\uC778\uC774 \uD544\uC694\uD569\uB2C8\uB2E4." });
        return;
      }
      sendJson(response, 200, await listDirectory(session));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/messages") {
      const session = sessionFrom(request);
      if (!session) {
        sendJson(response, 401, { error: "로그인이 필요합니다." });
        return;
      }
      const view = url.searchParams.get("view") === "dm" ? "dm" : "general";
      sendJson(response, 200, await handleMessages(session, view, url.searchParams.get("userId")));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/messages") {
      const session = sessionFrom(request);
      if (!session) {
        sendJson(response, 401, { error: "로그인이 필요합니다." });
        return;
      }
      const message = await handleSend(session, request);
      sendJson(response, 200, { message });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/events") {
      const session = sessionFrom(request);
      if (!session) {
        sendJson(response, 401, { error: "로그인이 필요합니다." });
        return;
      }
      const controller = new AbortController();
      response.on("close", () => {
        if (!response.writableEnded) controller.abort();
      });
      const payload = await handleEvents(session, controller.signal);
      if (!response.writableEnded) sendJson(response, 200, payload);
      return;
    }

    sendJson(response, 404, { error: "없는 주소입니다." });
  } catch (error) {
    if (error?.aborted || response.writableEnded) return;
    const status = error.status || (error.zulipStatus === 401 ? 401 : 502);
    if (status === 401) {
      sendJson(response, 401, { error: "로그인이 필요합니다." }, [sessionCookie("", 0)]);
      return;
    }
    if (status === 503) {
      sendJson(response, 503, { error: error.publicMessage || NOTES_ERROR });
      return;
    }
    if (status === 400 || status === 413) {
      sendJson(response, status === 413 ? 413 : 400, { error: error.publicMessage || "요청을 확인하세요." });
      return;
    }
    console.error("[sangsang] request failed", request.method, url.pathname, error.code || error.message);
    sendJson(response, 502, { error: error.publicMessage || upstreamMessage(error) });
  }
}

const servers = [];
for (const host of HOSTS) {
  const server = createServer(onRequest);
  server.requestTimeout = 90000;
  server.headersTimeout = 90000;
  server.keepAliveTimeout = 75000;
  server.timeout = 0;
  server.on("error", (error) => {
    console.error(`[sangsang] ${host} listen failed: ${error.code || error.message}`);
  });
  server.listen(PORT, host, () => {
    const shown = host.includes(":") ? `http://[${host}]:${PORT}/` : `http://${host}:${PORT}/`;
    console.log(`[sangsang] ${shown}`);
  });
  servers.push(server);
}

if (servers.length === 0) process.exit(1);
