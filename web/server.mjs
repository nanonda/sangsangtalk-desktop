import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";
import { createHash, randomBytes } from "node:crypto";
import { createNoteStore } from "./lib/note-store.mjs";
import { BLOCKED_EXTENSIONS, attachmentLines, attachmentUrl, canonicalUploadPath, cleanFileName, guessType, isBlockedName, splitAttachments } from "./lib/files.mjs";
import { createZulipFiles } from "./lib/zulip-files.mjs";
import { ConfigError, loadConfig } from "./lib/runtime-config.mjs";
import { createSessionStore } from "./lib/session-store.mjs";

// The browser talks only to this process; Zulip API calls are proxied here (Zulip does not
// allow this origin via CORS). All settings come from the environment (lib/runtime-config.mjs):
// with none set this is the development setup — loopback 43123 and the local self-signed Zulip.
let config;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(`[sangsang] 설정 오류: ${error.message}`);
  process.exit(1);
}
for (const warning of config.warnings) console.warn(`[sangsang] 경고: ${warning}`);
const PORT = config.port;
const HOSTS = config.hosts;
const CHANNEL = "general";
const TOPIC = "대화";
const zulipUrl = config.zulipUrl;
// TLS options for every request to Zulip (certificate verification per M4).
const ZULIP_TLS = { rejectUnauthorized: config.tls.rejectUnauthorized, ...(config.tls.ca ? { ca: config.tls.ca } : {}) };
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "data");
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const sessions = new Map();
const sessionStore = createSessionStore({
  file: path.join(dataDir, "sessions.json"),
  key: config.sessionKey,
  log: (message) => console.warn(`[sangsang] 경고: ${message}`),
});
const noteStore = createNoteStore(path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "notes.json"));
const NOTES_ERROR = "쪽지 기록을 읽지 못했습니다. 다시 시도하세요.";
const APP_ONLY_LOGIN_MESSAGE = "상상톡 로그인은 데스크톱 앱에서만 할 수 있습니다.";
const PAGE_SIZE = 100;
const MAX_EMPTY_PAGES = 20; // up to 2,000 hidden (note) messages skipped per request
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) > 0 ? Number(process.env.MAX_UPLOAD_MB) : 100;
const MAX_UPLOAD_BYTES = Math.floor(MAX_UPLOAD_MB * 1024 * 1024);
// Zulip treats a client as offline when its last presence report is older than this.
const PRESENCE_OFFLINE_SECONDS = 140;
const zulipFiles = createZulipFiles(zulipUrl, ZULIP_TLS);

function httpError(status, publicMessage, name = "request") {
  return Object.assign(new Error(name), { status, publicMessage });
}

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
  ["/desktop-bridge.js", "desktop-bridge.js"],
  ["/favicon.svg", "favicon.svg"],
  ["/assets/turtle-front.png", "assets/turtle-front.png"],
  ["/assets/turtle-thumbs.png", "assets/turtle-thumbs.png"],
  ["/assets/turtle-jump.png", "assets/turtle-jump.png"],
  ["/assets/turtle-side.png", "assets/turtle-side.png"],
  ["/assets/emblem.png", "assets/emblem.png"],
]);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
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
      ...ZULIP_TLS,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        if (response.statusCode === 429) {
          // Zulip's per-user API rate limit; tell the browser to back off instead of a generic 502.
          settle(reject, httpError(429, "요청이 너무 많습니다. 잠시 후 다시 시도하세요.", "rate"));
          return;
        }
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


function zulipBinary(method, apiPath, { timeoutMs = 20000, redirects = 1 } = {}) {
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
      headers: { accept: "image/*,*/*", "user-agent": "SangsangTalk/0.1" },
      ...ZULIP_TLS,
    }, (response) => {
      const location = response.headers.location || "";
      if (response.statusCode >= 300 && response.statusCode < 400 && redirects > 0 && location) {
        response.resume();
        let next = "";
        try {
          const target = new URL(location, zulipUrl);
          if (target.hostname === zulipUrl.hostname) next = `${target.pathname}${target.search}`;
        } catch {
          next = "";
        }
        if (!next.startsWith("/user_avatars/") && !next.startsWith("/avatar/")) {
          settle(resolve, { status: response.statusCode, contentType: "", body: Buffer.alloc(0) });
          return;
        }
        zulipBinary("GET", next, { timeoutMs, redirects: redirects - 1 }).then(
          (value) => settle(resolve, value),
          (error) => settle(reject, error),
        );
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > 5 * 1024 * 1024) {
          request.destroy();
          settle(resolve, { status: 502, contentType: "", body: Buffer.alloc(0) });
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        settle(resolve, {
          status: response.statusCode,
          contentType: String(response.headers["content-type"] || "").split(";")[0].trim(),
          body: Buffer.concat(chunks),
        });
      });
    });
    timer = setTimeout(() => {
      settle(reject, Object.assign(new Error("timeout"), { timeout: true }));
      request.destroy();
    }, timeoutMs);
    request.on("error", (error) => settle(reject, error));
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
  const { content, attachments } = splitAttachments(typeof message.content === "string" ? message.content : "");
  const base = {
    id: message.id,
    senderId: message.sender_id,
    senderName: message.sender_full_name || message.sender_email || "\uC54C \uC218 \uC5C6\uC74C",
    senderEmail: message.sender_email || "",
    topic: message.subject || "",
    content,
    timestamp: message.timestamp,
    kind: null,
    peerId: null,
    groupId: null,
    attachments,
  };
  if (isGeneral(message)) {
    base.kind = "channel";
    return base;
  }
  // Only invite-only channels I belong to are group rooms (session.groupIds, from listGroups).
  // Messages from any other channel are not part of this app and are dropped.
  if (message.type === "stream") {
    if (!Number.isInteger(message.stream_id) || !session?.groupIds?.has(message.stream_id)) return null;
    base.kind = "group";
    base.groupId = message.stream_id;
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
      // subscription/stream events tell the browser to re-read /api/groups.
      event_types: JSON.stringify(["message", "subscription", "stream"]),
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

// Past `limit` the rest of the body is read and thrown away, and 413 is answered only
// once it has all arrived: closing the socket while the client is still sending makes it
// see a connection reset instead of the JSON error. Beyond `discardLimit` we stop being polite.
function readBody(request, limit = 65536, discardLimit = 1024 * 1024) {
  const tooLarge = () => Object.assign(new Error("too large"), {
    status: 413,
    publicMessage: "요청이 너무 큽니다.",
  });
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit + discardLimit) {
        reject(tooLarge());
        request.destroy();
        return;
      }
      if (size <= limit) chunks.push(chunk);
    });
    request.on("end", () => {
      if (size > limit) reject(tooLarge());
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
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

function sendJson(response, status, payload, cookies = [], { close = false } = {}) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  if (cookies.length) headers["set-cookie"] = cookies;
  if (close) headers.connection = "close";
  response.writeHead(status, headers);
  response.end(JSON.stringify(payload));
}

function cookieValue(request, name) {
  const header = request.headers.cookie || "";
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      // A malformed cookie (bad %-escape) counts as no cookie: the request is simply signed out.
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return "";
      }
    }
  }
  return "";
}

function sessionFrom(request) {
  const sid = cookieValue(request, "sangsang_sid");
  if (!sid) return null;
  const session = sessions.get(sid) || null;
  if (session && session.expiresAt <= Date.now()) {
    dropSession(sid);
    return null;
  }
  return session;
}

// ---- M3: sessions survive restarts when SESSION_KEY is set (encrypted web/data/sessions.json). ----
const SESSION_SAVE_RETRY_MS = 30 * 1000;
let sessionRetryTimer = null;

// Each call snapshots the current map, so a retry always writes the latest state (including a
// logout that a failed write had not yet recorded). Failures are logged and retried, never dropped.
function persistSessions() {
  if (!sessionStore.enabled) return;
  const records = [...sessions].map(([sid, session]) => ({
    sid,
    email: session.email,
    userId: session.userId,
    fullName: session.fullName,
    apiKey: session.apiKey,
    expiresAt: session.expiresAt,
    peer: session.peer || null,
  }));
  sessionStore.save(records).then((result) => {
    if (result.invalid) {
      console.warn(`[sangsang] 경고: 형식이 맞지 않는 세션 ${result.invalid}개를 저장에서 뺐습니다(해당 사용자는 서버 재시작 후 다시 로그인).`);
    }
    if (result.ok) return;
    console.error(`[sangsang] 세션 파일을 저장하지 못했습니다 (${result.error}). ${SESSION_SAVE_RETRY_MS / 1000}초 후 다시 시도합니다.`);
    if (!sessionRetryTimer) {
      sessionRetryTimer = setTimeout(() => {
        sessionRetryTimer = null;
        persistSessions();
      }, SESSION_SAVE_RETRY_MS);
      sessionRetryTimer.unref();
    }
  });
}

function dropSession(sid) {
  const session = sessions.get(sid);
  if (!session) return null;
  sessions.delete(sid);
  persistSessions();
  return session;
}

async function restoreSessions() {
  for (const record of await sessionStore.load()) {
    sessions.set(record.sid, {
      email: record.email,
      apiKey: record.apiKey,
      userId: record.userId,
      fullName: record.fullName,
      peer: record.peer || null,
      expiresAt: record.expiresAt,
      // Event queues are not saved: a restored session registers a new one on first use.
      queueId: null,
      lastEventId: -1,
      tail: Promise.resolve(),
    });
  }
  return sessions.size;
}

function sessionCookie(sid, maxAge) {
  // Behind an HTTPS proxy (PUBLIC_ORIGIN https://...) the cookie must never travel over plain HTTP.
  const secure = config.secureCookie ? "; Secure" : "";
  return `sangsang_sid=${encodeURIComponent(sid)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

function publicUser(session) {
  return {
    email: session.email,
    userId: session.userId,
    fullName: session.fullName,
    peer: session.peer || null,
    // The browser checks files against the same limits before uploading (the server re-checks).
    limits: { maxUploadMb: MAX_UPLOAD_MB, blockedExtensions: [...BLOCKED_EXTENSIONS] },
  };
}

// Behind a proxy the Host header is the proxy's upstream (127.0.0.1:43123), so with
// PUBLIC_ORIGIN set the browser's Origin must equal it exactly, and a missing Origin is refused
// (browsers always send it on POST/PATCH/DELETE). X-Forwarded-* headers are never trusted.
// Without PUBLIC_ORIGIN (development) the Host comparison and the "no Origin is fine" rule stay as before.
function sameOrigin(request) {
  const origin = request.headers.origin;
  if (config.publicOrigin) return origin === config.publicOrigin;
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
    expiresAt: Date.now() + SESSION_TTL_MS,
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
  persistSessions();
  sendJson(response, 200, publicUser(session), [sessionCookie(sid, SESSION_TTL_MS / 1000)]);
}

function roleName(role) {
  if (role === 100) return "owner";
  if (role === 200) return "admin";
  if (role === 300) return "moderator";
  if (role === 600) return "guest";
  return "member";
}

const TITLE_BY_EMAIL = new Map([
  ["gimsangsang@localhost.localdomain", "\uD300\uC7A5"],
  ["honggildong@localhost.localdomain", "\uD300\uC7A5"],
  ["jeonsani@localhost.localdomain", "\uC8FC\uBB34\uAD00"],
  ["tongsini@localhost.localdomain", "\uC8FC\uBB34\uAD00"],
  ["gwanjenam@localhost.localdomain", "\uC8FC\uBB34\uAD00"],
]);
// Directory title = "직위 · 부서" from Zulip custom profile fields.
// The older single "직책" field and TITLE_BY_EMAIL remain as fallbacks.
const TITLE_FIELD_NAMES = { position: "직위", department: "부서", legacy: "직책" };
let titleFieldIdCache = null;

function personEmail(user) {
  return String(user.delivery_email || user.email || "").trim().toLowerCase();
}

function profileText(entry) {
  if (!entry) return "";
  if (typeof entry === "string") return entry.trim();
  return typeof entry.value === "string" ? entry.value.trim() : "";
}

function localAvatarPath(url) {
  if (typeof url !== "string" || !url.startsWith("/user_avatars/")) return "";
  const pathOnly = url.split("?")[0];
  if (pathOnly.includes("..") || pathOnly.includes("\\")) return "";
  return url;
}

async function fetchMembers(session) {
  const result = await zulip(
    "GET",
    "/api/v1/users?include_custom_profile_fields=true&client_gravatar=false",
    { auth: basic(session) },
  );
  if (result.json?.result !== "success" || !Array.isArray(result.json.members)) {
    const error = new Error("directory");
    error.status = result.status === 401 ? 401 : 502;
    throw error;
  }
  return result.json.members;
}

async function titleFieldIds(session) {
  if (titleFieldIdCache) return titleFieldIdCache;
  const ids = {};
  try {
    const result = await zulip("GET", "/api/v1/realm/profile_fields", { auth: basic(session) });
    const fields = Array.isArray(result.json?.custom_fields) ? result.json.custom_fields : [];
    for (const [key, name] of Object.entries(TITLE_FIELD_NAMES)) {
      const field = fields.find((item) => item.type === 1 && item.name === name);
      if (field?.id) ids[key] = field.id;
    }
    // Cache only a successful read so a transient failure is retried next time.
    if (result.json?.result === "success") titleFieldIdCache = ids;
  } catch {
    // The email map below covers the case where the realm fields cannot be read.
  }
  return ids;
}

function directoryTitle(user, fieldIds) {
  const data = user.profile_data || {};
  const read = (id) => (id ? profileText(data[String(id)]) : "");
  const combined = [read(fieldIds.position), read(fieldIds.department)].filter(Boolean).join(" \u00B7 ");
  if (combined) return combined;
  const legacy = read(fieldIds.legacy);
  if (legacy) return legacy;
  return TITLE_BY_EMAIL.get(personEmail(user)) || "";
}

async function listDirectory(session) {
  const members = await fetchMembers(session);
  const fieldIds = await titleFieldIds(session);
  const people = members
    .filter((user) => !user.is_bot && user.is_active !== false)
    .map((user) => {
      const title = directoryTitle(user, fieldIds);
      const avatarPath = localAvatarPath(user.avatar_url);
      return {
        userId: user.user_id,
        fullName: user.full_name || "\uC774\uB984 \uC5C6\uC74C",
        role: roleName(user.role),
        title,
        avatarUrl: title && avatarPath ? `/api/avatar/${user.user_id}` : "",
      };
    })
    .sort((a, b) => a.fullName.localeCompare(b.fullName, "ko"));
  return { people };
}

async function handleAvatar(session, userId, response) {
  const id = Number(userId);
  if (!Number.isInteger(id) || String(id) !== String(userId)) {
    sendJson(response, 404, { error: "\uC544\uBC14\uD0C0\uB97C \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4." });
    return;
  }
  const members = await fetchMembers(session);
  const user = members.find((item) => item.user_id === id && !item.is_bot && item.is_active !== false);
  const avatarPath = user ? localAvatarPath(user.avatar_url) : "";
  if (!avatarPath) {
    sendJson(response, 404, { error: "\uC544\uBC14\uD0C0\uB97C \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4." });
    return;
  }
  const upstream = await zulipBinary("GET", avatarPath);
  if (upstream.status !== 200 || !upstream.body.length || !upstream.contentType.startsWith("image/")) {
    sendJson(response, 502, { error: "\uC544\uBC14\uD0C0\uB97C \uAC00\uC838\uC624\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4." });
    return;
  }
  response.writeHead(200, {
    "content-type": upstream.contentType,
    "cache-control": "private, max-age=300",
    "x-content-type-options": "nosniff",
  });
  response.end(upstream.body);
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

function parseBefore(value) {
  if (value === null || value === undefined || value === "") return null;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0 || String(id) !== String(value)) {
    throw httpError(400, "불러올 위치가 올바르지 않습니다.", "before");
  }
  return id;
}

async function handleMessages(session, view, params) {
  const before = parseBefore(params.get("before"));
  const peer = view === "dm" ? await personById(session, params.get("userId")) : null;
  const group = view === "group" ? await groupById(session, params.get("groupId")) : null;
  await enqueue(session, () => ensureQueue(session));
  let narrow = [{ operator: "channel", operand: CHANNEL }];
  if (peer) narrow = [{ operator: "dm", operand: [peer.userId] }];
  if (group) narrow = [{ operator: "channel", operand: group.groupId }];
  const noteIds = view === "dm" ? new Set((await noteRecords(session)).map((note) => note.messageId)) : new Set();
  // Notes are hidden from the 1:1 view. A page made only of notes would come back empty with
  // hasOlder:true and leave the browser no `before` to continue from, so keep reading older
  // pages (bounded) until something is visible or the start of the conversation is reached.
  let anchor = before ? String(before) : "newest";
  let messages = [];
  let hasOlder = false;
  for (let round = 0; round < MAX_EMPTY_PAGES; round += 1) {
    const query = new URLSearchParams({
      anchor,
      num_before: String(PAGE_SIZE),
      num_after: "0",
      include_anchor: "false",
      apply_markdown: "false",
      narrow: JSON.stringify(narrow),
    });
    const result = await zulip("GET", `/api/v1/messages?${query}`, { auth: basic(session) });
    if (result.json?.result !== "success" || !Array.isArray(result.json.messages)) {
      const error = new Error("messages");
      error.status = result.status === 401 ? 401 : 502;
      throw error;
    }
    const raw = result.json.messages;
    hasOlder = result.json.found_oldest === false && raw.length > 0;
    // Also hide notes still in flight (sent, index not yet written).
    if (view === "dm") for (const message of raw) if (pendingNoteRecord(message)) noteIds.add(message.id);
    messages = raw
      .map((message) => normalize(message, session))
      .filter((message) => message && !noteIds.has(message.id))
      .sort((a, b) => a.id - b.id);
    if (messages.length || !hasOlder) break;
    anchor = String(Math.min(...raw.map((message) => message.id)));
  }
  return {
    view,
    channel: view === "general" ? CHANNEL : null,
    peer,
    group,
    hasOlder,
    messages,
  };
}

async function handleSend(session, request) {
  const body = await readJson(request);
  const view = body.view === "dm" || body.view === "group" ? body.view : "general";
  const text = typeof body.content === "string" ? body.content.trim() : "";
  const files = attachmentLines(body.attachments);
  if (!files) throw httpError(400, "\uCCA8\uBD80 \uD30C\uC77C\uC744 \uD655\uC778\uD558\uC138\uC694.", "attachments");
  if (!text && !files.lines.length) {
    throw httpError(400, "\uBA54\uC2DC\uC9C0\uB97C \uC785\uB825\uD558\uC138\uC694.", "empty");
  }
  const content = [text, ...files.lines].filter(Boolean).join("\n");
  if (content.length > 10000) {
    throw httpError(400, "\uBA54\uC2DC\uC9C0\uAC00 \uB108\uBB34 \uAE41\uB2C8\uB2E4.", "long");
  }
  const peer = view === "dm" ? await personById(session, body.userId) : null;
  const group = view === "group" ? await groupById(session, body.groupId) : null;
  if (body.note === true && !peer) throw httpError(400, "\uC0AC\uC6A9\uC790\uB97C \uC120\uD0DD\uD558\uC138\uC694.", "user");
  let form = { type: "stream", to: CHANNEL, topic: TOPIC, content };
  if (peer) form = { type: "direct", to: JSON.stringify([peer.userId]), content };
  if (group) form = { type: "stream", to: String(group.groupId), topic: TOPIC, content };
  // Register the note before Zulip delivers it, so the receiver's event poll classifies it
  // as a note even if it arrives before the index write below finishes.
  const pendingKey = body.note === true ? addPendingNote(session.userId, peer.userId, content) : "";
  let sent;
  try {
    sent = await zulip("POST", "/api/v1/messages", { auth: basic(session), form });
  } catch (error) {
    dropPendingNote(pendingKey);
    throw error;
  }
  if (sent.json?.result !== "success" || !sent.json.id) {
    dropPendingNote(pendingKey);
    const error = new Error("send");
    error.status = sent.status === 401 ? 401 : 502;
    throw error;
  }
  bindPendingNote(pendingKey, sent.json.id);
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
    content: text,
    timestamp: Math.floor(Date.now() / 1000),
    kind: view === "dm" ? "dm" : view === "group" ? "group" : "channel",
    peerId: peer ? peer.userId : null,
    groupId: group ? group.groupId : null,
    attachments: [],
  };
  // The sender knows sizes and types that Zulip's message text does not carry.
  message.attachments = files.attachments;
  if (body.note === true) {
    try {
      await noteStore.add({
        messageId: message.id,
        senderId: session.userId,
        recipientId: peer.userId,
        timestamp: message.timestamp,
      });
    } catch (error) {
      throw asNotesError(error);
    } finally {
      // Indexed now (or failed): the index is the source of truth from here on.
      dropPendingNote(pendingKey);
    }
    message.note = true;
  }
  return message;
}

// ---- Notes in flight: sent to Zulip but not yet written to the note index. ----
const PENDING_NOTE_MS = 60 * 1000;
const pendingNotes = new Map(); // key -> { senderId, recipientId, hash, messageId, expires }

function contentHash(content) {
  return createHash("sha256").update(String(content)).digest("hex");
}

function addPendingNote(senderId, recipientId, content) {
  const now = Date.now();
  for (const [key, entry] of pendingNotes) if (entry.expires < now) pendingNotes.delete(key);
  const key = randomBytes(8).toString("hex");
  pendingNotes.set(key, { senderId, recipientId, hash: contentHash(content), messageId: null, expires: now + PENDING_NOTE_MS });
  return key;
}

function bindPendingNote(key, messageId) {
  const entry = key ? pendingNotes.get(key) : null;
  if (entry) entry.messageId = messageId;
}

function dropPendingNote(key) {
  if (key) pendingNotes.delete(key);
}

// For a raw Zulip 1:1 message: the note record it will get, if it is a note still in flight.
function pendingNoteRecord(message) {
  if (!Array.isArray(message?.display_recipient) || message.display_recipient.length !== 2) return null;
  const senderId = message.sender_id;
  const recipientId = message.display_recipient.map((person) => person.id).find((id) => id !== senderId);
  const hash = contentHash(message.content);
  const now = Date.now();
  for (const entry of pendingNotes.values()) {
    if (entry.expires < now || entry.senderId !== senderId || entry.recipientId !== recipientId) continue;
    if (entry.messageId !== null ? entry.messageId !== message.id : entry.hash !== hash) continue;
    return { messageId: message.id, senderId, recipientId, timestamp: message.timestamp };
  }
  return null;
}

async function classifyEvents(session, messages, reset, inFlight = []) {
  try {
    const indexed = await noteStore.listForUser(session.userId);
    const known = new Set(indexed.map((note) => note.messageId));
    // In-flight notes look exactly like indexed ones to the browser: listed in `notes`, absent from `messages`.
    const notes = [...indexed, ...inFlight.filter((note) => !known.has(note.messageId))];
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
    if (error.timeout) return { messages: [], reset: false, groupsChanged: false };
    throw error;
  }
  if (result.json?.code === "BAD_EVENT_QUEUE_ID") {
    await enqueue(session, async () => {
      if (session.queueId === queueId) {
        session.queueId = null;
        session.lastEventId = -1;
      }
    });
    // Events may have been missed while the queue was gone, so groups are stale too.
    return { ...(await classifyEvents(session, [], true)), groupsChanged: true };
  }
  if (result.json?.result !== "success") {
    const error = new Error("events");
    error.status = result.status === 401 ? 401 : 502;
    throw error;
  }
  const events = result.json.events || [];
  // Added/removed/renamed, or members joined/left one of my channels.
  const groupsChanged = events.some((event) => event.type === "subscription" || event.type === "stream");
  const unknownChannel = events.some((event) => event.type === "message"
    && event.message?.type === "stream" && !isGeneral(event.message)
    && !session.groupIds?.has(event.message.stream_id));
  // Refresh my group list first so a message in a group I was just added to is kept.
  if (groupsChanged || unknownChannel || !session.groupIds) {
    try {
      await listGroups(session);
    } catch (error) {
      if (error.status === 401) throw error;
    }
  }
  const messages = [];
  let maxId = lastEventId;
  const inFlight = [];
  for (const event of events) {
    if (Number.isInteger(event.id) && event.id > maxId) maxId = event.id;
    if (event.type === "message" && event.message) {
      const normalized = normalize(event.message, session);
      if (normalized) messages.push(normalized);
      const pending = normalized?.kind === "dm" ? pendingNoteRecord(event.message) : null;
      if (pending) inFlight.push(pending);
    }
  }
  await enqueue(session, async () => {
    if (session.queueId === queueId && maxId > session.lastEventId) session.lastEventId = maxId;
  });
  return { ...(await classifyEvents(session, messages, false, inFlight)), groupsChanged };
}

// ---- B. Group rooms: one invite-only Zulip channel per group, topic TOPIC. ----
const GROUP_NAME_MAX = 60;

function zulipFailure(result, fallback) {
  if (result.status === 401) return httpError(401, "", "auth");
  const message = typeof result.json?.msg === "string" ? result.json.msg : "";
  console.error("[sangsang] zulip refused", result.status, result.json?.code || "", message.slice(0, 200));
  return httpError(502, fallback, "zulip");
}

function groupFromSubscription(sub) {
  return {
    groupId: sub.stream_id,
    name: sub.name,
    memberIds: Array.isArray(sub.subscribers) ? [...sub.subscribers].sort((a, b) => a - b) : [],
  };
}

async function listGroups(session) {
  const result = await zulip("GET", "/api/v1/users/me/subscriptions?include_subscribers=true", { auth: basic(session) });
  if (result.json?.result !== "success" || !Array.isArray(result.json.subscriptions)) {
    throw zulipFailure(result, "그룹 목록을 읽지 못했습니다.");
  }
  const groups = result.json.subscriptions
    .filter((sub) => sub.invite_only && String(sub.name).toLowerCase() !== CHANNEL)
    .map(groupFromSubscription)
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));
  // normalize() uses this to show only my group rooms; other channels are ignored.
  session.groupIds = new Set(groups.map((group) => group.groupId));
  return { groups };
}

function forgetGroup(session, groupId) {
  session.groupIds?.delete(groupId);
}

async function groupById(session, value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw httpError(400, "그룹을 선택하세요.", "group");
  const { groups } = await listGroups(session);
  const group = groups.find((item) => item.groupId === id);
  if (!group) throw httpError(404, "그룹을 찾지 못했습니다.", "group");
  return group;
}

async function validPeopleIds(session, values) {
  if (!Array.isArray(values) || values.length > 200) return [];
  const { people } = await listDirectory(session);
  const known = new Set(people.map((person) => person.userId));
  return [...new Set(values.map(Number))].filter((id) => known.has(id) && id !== session.userId);
}

function cleanGroupName(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, GROUP_NAME_MAX);
}

async function defaultGroupName(session, memberIds) {
  const { people } = await listDirectory(session);
  const names = memberIds
    .filter((id) => id !== session.userId)
    .map((id) => people.find((person) => person.userId === id)?.fullName)
    .filter(Boolean);
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} 외 ${names.length - 3}명`;
}

// Channel names are unique per realm (including channels this user cannot see), so add " (2)" etc. on a clash.
function nameCandidates(name) {
  const list = [name];
  for (let n = 2; n <= 20; n += 1) {
    const suffix = ` (${n})`;
    list.push(`${name.slice(0, GROUP_NAME_MAX - suffix.length)}${suffix}`);
  }
  return list;
}

// "already exists": name taken; "Unable to access channel": a private channel this user cannot see has it.
const CHANNEL_EXISTS = /already exists|Unable to access channel|이미 존재/i;

// True when a channel with this name is visible to the user (own groups, any public channel).
// Subscribing to such a name would join that existing channel instead of creating a group.
async function channelNameVisible(session, name) {
  const result = await zulip("GET", `/api/v1/get_stream_id?${new URLSearchParams({ stream: name })}`, { auth: basic(session) });
  if (result.json?.result === "success") return true;
  if (result.status === 400) return false;
  throw zulipFailure(result, "그룹을 만들지 못했습니다.");
}

// Every member may rename and invite: the member list doubles as the channel's administrator group.
function adminGroup(memberIds) {
  return JSON.stringify({ direct_members: memberIds, direct_subgroups: [] });
}

async function createGroup(session, body) {
  const others = await validPeopleIds(session, body.memberIds);
  if (!others.length) throw httpError(400, "함께할 직원을 한 명 이상 고르세요.", "members");
  const memberIds = [session.userId, ...others];
  const name = cleanGroupName(body.name) || cleanGroupName(await defaultGroupName(session, memberIds));
  let created = "";
  for (const candidate of nameCandidates(name)) {
    if (await channelNameVisible(session, candidate)) continue;
    const result = await zulip("POST", "/api/v1/users/me/subscriptions", {
      auth: basic(session),
      form: {
        subscriptions: JSON.stringify([{ name: candidate, description: "" }]),
        principals: JSON.stringify(memberIds),
        invite_only: "true",
        history_public_to_subscribers: "true",
        announce: "false",
        can_administer_channel_group: adminGroup(memberIds),
        can_add_subscribers_group: adminGroup(memberIds),
      },
    });
    if (result.json?.result === "success") {
      // The pre-check passed, so this should be new. If the channel turned out to exist
      // (created in between), stop rather than treat someone else's channel as our group.
      const already = Object.values(result.json.already_subscribed || {}).some((names) => names.includes(candidate));
      if (already) throw httpError(409, "같은 이름의 대화방이 있습니다. 다시 시도하세요.", "name");
      created = candidate;
      break;
    }
    if (!CHANNEL_EXISTS.test(String(result.json?.msg || ""))) {
      throw zulipFailure(result, "그룹을 만들지 못했습니다.");
    }
  }
  if (!created) throw httpError(400, "같은 이름의 그룹이 많습니다. 다른 이름을 쓰세요.", "name");
  const { groups } = await listGroups(session);
  const group = groups.find((item) => item.name === created);
  if (!group) throw httpError(502, "그룹을 만들지 못했습니다.", "group");
  return group;
}

async function renameGroup(session, groupId, body) {
  const group = await groupById(session, groupId);
  const name = cleanGroupName(body.name);
  if (!name) throw httpError(400, "그룹 이름을 입력하세요.", "name");
  if (name !== group.name) {
    const result = await zulip("PATCH", `/api/v1/streams/${group.groupId}`, { auth: basic(session), form: { new_name: name } });
    if (result.json?.result !== "success") {
      if (CHANNEL_EXISTS.test(String(result.json?.msg || ""))) {
        throw httpError(400, "같은 이름의 대화방이 있습니다. 다른 이름을 쓰세요.", "name");
      }
      throw zulipFailure(result, "그룹 이름을 바꾸지 못했습니다.");
    }
  }
  return await groupById(session, group.groupId);
}

async function addGroupMembers(session, groupId, body) {
  const group = await groupById(session, groupId);
  const ids = (await validPeopleIds(session, body.userIds)).filter((id) => !group.memberIds.includes(id));
  if (!ids.length) throw httpError(400, "초대할 직원을 고르세요.", "members");
  const result = await zulip("POST", "/api/v1/users/me/subscriptions", {
    auth: basic(session),
    form: { subscriptions: JSON.stringify([{ name: group.name }]), principals: JSON.stringify(ids) },
  });
  if (result.json?.result !== "success") throw zulipFailure(result, "직원을 초대하지 못했습니다.");
  await setGroupAdmins(session, group.groupId, [...group.memberIds, ...ids]);
  return await groupById(session, group.groupId);
}

async function setGroupAdmins(session, groupId, memberIds) {
  const value = adminGroup([...new Set(memberIds)]);
  const result = await zulip("PATCH", `/api/v1/streams/${groupId}`, {
    auth: basic(session),
    form: {
      can_administer_channel_group: JSON.stringify({ new: JSON.parse(value) }),
      can_add_subscribers_group: JSON.stringify({ new: JSON.parse(value) }),
    },
  });
  // Not fatal: membership already changed; only rename/invite rights of the new members lag.
  if (result.json?.result !== "success") zulipFailure(result, "");
}

async function leaveGroup(session, groupId) {
  const group = await groupById(session, groupId);
  const result = await zulip("DELETE", "/api/v1/users/me/subscriptions", {
    auth: basic(session),
    form: { subscriptions: JSON.stringify([group.name]) },
  });
  if (result.json?.result !== "success") throw zulipFailure(result, "그룹에서 나가지 못했습니다.");
  // Only after leaving succeeded: drop my admin rights (channel admins may still edit after unsubscribing).
  await setGroupAdmins(session, group.groupId, group.memberIds.filter((id) => id !== session.userId));
  forgetGroup(session, group.groupId);
  return { ok: true };
}

// ---- C. Files ----
async function handleUpload(session, request, response) {
  const name = cleanFileName(request.headers["x-file-name"]);
  if (!name) throw httpError(400, "파일 이름이 없습니다.", "name");
  if (isBlockedName(name)) throw httpError(415, "이 형식의 파일은 보낼 수 없습니다.", "type");
  const sizeHeader = request.headers["content-length"];
  const size = Number(sizeHeader);
  if (sizeHeader === undefined || !Number.isSafeInteger(size)) {
    throw httpError(411, "파일 크기를 알 수 없습니다. 다시 시도하세요.", "length");
  }
  const tooLarge = `파일은 ${MAX_UPLOAD_MB}MB까지 보낼 수 있습니다.`;
  if (size > MAX_UPLOAD_BYTES) throw httpError(413, tooLarge, "size");
  if (size === 0) throw httpError(400, "빈 파일은 보낼 수 없습니다.", "empty");
  const declared = String(request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  const type = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(declared) ? declared : guessType(name) || "application/octet-stream";
  const result = await zulipFiles.upload(request, { auth: basic(session), name, type, size, limit: MAX_UPLOAD_BYTES });
  if (result.status === 413) throw httpError(413, tooLarge, "size");
  if (result.status === 401) throw httpError(401, "", "auth");
  const uploadPath = canonicalUploadPath(result.json?.url);
  if (result.status !== 200 || !uploadPath) {
    console.error("[sangsang] upload refused", result.status, String(result.error || "").slice(0, 200));
    throw httpError(502, "파일을 올리지 못했습니다.", "upload");
  }
  // Zulip's tus hook stores the file under sanitize_name(strict=True), which drops every
  // non-ASCII character ("회의 자료.txt" -> ".txt"). `url` carries the original name for downloads.
  return { file: { name, size, type, path: uploadPath, url: attachmentUrl(uploadPath, name) } };
}

// ---- D. Presence ----
async function reportPresence(session, body) {
  const status = body.status === "idle" ? "idle" : body.status === "active" ? "active" : "";
  if (!status) throw httpError(400, "상태 값을 확인하세요.", "status");
  const result = await zulip("POST", "/api/v1/users/me/presence", {
    auth: basic(session),
    form: { status, ping_only: "true" },
  });
  if (result.json?.result !== "success") throw zulipFailure(result, "상태를 보내지 못했습니다.");
  return { ok: true };
}

async function readPresence(session) {
  const [members, result] = await Promise.all([
    fetchMembers(session),
    zulip("GET", "/api/v1/realm/presence", { auth: basic(session) }),
  ]);
  if (result.json?.result !== "success") throw zulipFailure(result, "근무 상태를 읽지 못했습니다.");
  const presences = result.json.presences || {};
  const serverNow = Number(result.json.server_timestamp) || Date.now() / 1000;
  const presence = {};
  for (const user of members) {
    if (user.is_bot || user.is_active === false) continue;
    const entry = presences[user.email] || presences[String(user.user_id)];
    const aggregated = entry?.aggregated;
    const age = aggregated ? serverNow - Number(aggregated.timestamp) : Infinity;
    let status = "offline";
    if (age <= PRESENCE_OFFLINE_SECONDS) status = aggregated.status === "active" ? "active" : "idle";
    presence[String(user.user_id)] = status;
  }
  return { presence };
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
  // Parse against a fixed base: a request line like "//" or a bad Host header must not
  // throw outside the try below (that crashed the whole process).
  let url;
  try {
    url = new URL(request.url, "http://127.0.0.1");
  } catch {
    sendJson(response, 400, { error: "요청을 확인하세요." });
    return;
  }
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
      // M14: staff sign in from the desktop app only. The header can be forged — this guides, it does not secure.
      if (config.appOnlyLogin && request.headers["x-sangsangtalk-client"] !== "desktop") {
        sendJson(response, 403, { error: APP_ONLY_LOGIN_MESSAGE });
        return;
      }
      await handleLogin(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/logout") {
      const sid = cookieValue(request, "sangsang_sid");
      const session = sid ? dropSession(sid) : null;
      if (session) {
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

    if (request.method === "GET" && url.pathname.startsWith("/api/avatar/")) {
      const session = sessionFrom(request);
      if (!session) {
        sendJson(response, 401, { error: "\uB85C\uADF8\uC778\uC774 \uD544\uC694\uD569\uB2C8\uB2E4." });
        return;
      }
      let avatarId = "";
      try {
        avatarId = decodeURIComponent(url.pathname.slice("/api/avatar/".length));
      } catch {
        avatarId = ""; // bad %-escape -> handleAvatar answers 404
      }
      await handleAvatar(session, avatarId, response);
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
      const requested = url.searchParams.get("view");
      const view = requested === "dm" || requested === "group" ? requested : "general";
      sendJson(response, 200, await handleMessages(session, view, url.searchParams));
      return;
    }

    if (url.pathname === "/api/groups" || url.pathname.startsWith("/api/groups/")) {
      const session = sessionFrom(request);
      if (!session) {
        sendJson(response, 401, { error: "로그인이 필요합니다." });
        return;
      }
      if (request.method !== "GET" && !sameOrigin(request)) {
        sendJson(response, 403, { error: "이 출처에서는 요청할 수 없습니다." });
        return;
      }
      const match = url.pathname.match(/^\/api\/groups(?:\/(\d+)(\/members(?:\/me)?)?)?$/);
      const [, groupId, sub] = match || [];
      if (match && !groupId && request.method === "GET") {
        sendJson(response, 200, await listGroups(session));
        return;
      }
      if (match && !groupId && request.method === "POST") {
        sendJson(response, 200, { group: await createGroup(session, await readJson(request)) });
        return;
      }
      if (match && groupId && !sub && request.method === "PATCH") {
        sendJson(response, 200, { group: await renameGroup(session, groupId, await readJson(request)) });
        return;
      }
      if (match && groupId && sub === "/members" && request.method === "POST") {
        sendJson(response, 200, { group: await addGroupMembers(session, groupId, await readJson(request)) });
        return;
      }
      if (match && groupId && sub === "/members/me" && request.method === "DELETE") {
        sendJson(response, 200, await leaveGroup(session, groupId));
        return;
      }
      sendJson(response, 404, { error: "없는 주소입니다." });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/files") {
      const session = sessionFrom(request);
      if (!session) {
        sendJson(response, 401, { error: "로그인이 필요합니다." }, [], { close: true });
        return;
      }
      sendJson(response, 200, await handleUpload(session, request, response));
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/files/")) {
      const session = sessionFrom(request);
      if (!session) {
        sendJson(response, 401, { error: "로그인이 필요합니다." });
        return;
      }
      const raw = request.url.split("?")[0].slice("/api/files".length);
      const uploadPath = canonicalUploadPath(raw);
      const found = uploadPath
        && await zulipFiles.download(uploadPath, {
          auth: basic(session),
          inline: url.searchParams.get("inline") === "1",
          name: url.searchParams.get("name") || "",
        }, response);
      if (!found && !response.headersSent) sendJson(response, 404, { error: "파일을 찾지 못했습니다." });
      return;
    }

    if (url.pathname === "/api/presence" && (request.method === "GET" || request.method === "POST")) {
      const session = sessionFrom(request);
      if (!session) {
        sendJson(response, 401, { error: "로그인이 필요합니다." });
        return;
      }
      const payload = request.method === "POST"
        ? await reportPresence(session, await readJson(request))
        : await readPresence(session);
      sendJson(response, 200, payload);
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
    // A streamed response (file download) already started: no JSON error can follow.
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const status = error.status || (error.zulipStatus === 401 ? 401 : 502);
    if (status === 401) {
      // Zulip refused this session's API key (revoked, user deactivated): forget the saved session too.
      const sid = cookieValue(request, "sangsang_sid");
      if (sid) dropSession(sid);
      sendJson(response, 401, { error: "로그인이 필요합니다." }, [sessionCookie("", 0)]);
      return;
    }
    if (status === 503) {
      sendJson(response, 503, { error: error.publicMessage || NOTES_ERROR });
      return;
    }
    if ([400, 404, 409, 411, 413, 415, 429].includes(status)) {
      // An upload refused before its body was read: close the connection instead of draining it.
      const close = status === 413
        || (url.pathname === "/api/files" && request.method === "POST" && !request.readableEnded);
      sendJson(response, status, { error: error.publicMessage || "요청을 확인하세요." }, [], { close });
      return;
    }
    console.error("[sangsang] request failed", request.method, url.pathname, error.code || error.message);
    sendJson(response, 502, { error: error.publicMessage || upstreamMessage(error) });
  }
}

// Saved sessions are back before the first request is accepted.
const restored = await restoreSessions();
console.log(`[sangsang] Zulip ${zulipUrl.origin} — TLS ${config.tls.mode}; 세션 ${sessionStore.enabled ? `디스크 저장(복원 ${restored}개)` : "메모리"}${config.publicOrigin ? `; 공개 주소 ${config.publicOrigin}` : ""}`);
if (config.appOnlyLogin) console.log("[sangsang] APP_ONLY_LOGIN=1: 데스크톱 앱(X-SangsangTalk-Client: desktop)에서만 로그인을 받습니다(안내용, 보안 통제 아님).");
// Expired sessions leave memory and the file even if their owner never comes back.
setInterval(() => {
  const now = Date.now();
  let expired = 0;
  for (const [sid, session] of sessions) {
    if (session.expiresAt <= now) {
      sessions.delete(sid);
      expired += 1;
    }
  }
  if (expired) persistSessions();
}, 10 * 60 * 1000).unref();

const servers = [];
for (const host of HOSTS) {
  // Safety net: a rejection escaping onRequest must never take the whole process down.
  const server = createServer((request, response) => {
    onRequest(request, response).catch((error) => {
      console.error("[sangsang] unhandled request error", request.method, error?.code || error?.message);
      if (!response.headersSent) {
        try {
          sendJson(response, 500, { error: "요청을 처리하지 못했습니다." });
        } catch {
          response.destroy();
        }
      } else {
        response.destroy();
      }
    });
  });
  // No cap on total request time: a 100 MB upload on a slow link can take minutes.
  // Stalled connections are cut by the idle timeout instead (any bytes reset it;
  // /api/events answers within ~55 s, so it is never idle that long).
  server.requestTimeout = 0;
  server.headersTimeout = 90000;
  server.keepAliveTimeout = 75000;
  server.timeout = 120000;
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
