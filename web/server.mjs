import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";
import { createHash, randomBytes } from "node:crypto";
import { createNoteStore } from "./lib/note-store.mjs";
import { attachmentLines, extensionOf, attachmentUrl, canonicalUploadPath, cleanFileName, guessType, isBlockedName } from "./lib/files.mjs";
import { createZulipFiles } from "./lib/zulip-files.mjs";
import { ConfigError, loadConfig } from "./lib/runtime-config.mjs";
import { createSessionStore } from "./lib/session-store.mjs";
import {
  RECALLED_TEXT, URGENT_LINE, applyMentions, excerptOf, messageFields, neutralizeSyntax, replyPrefix, splitRaw, widgetContent, widgetFields,
} from "./lib/message-format.mjs";
import { createAuditLog } from "./lib/audit-log.mjs";
import { createAdminMetaStore, createNoticeStore, createPolicyStore, createPrefsStore } from "./lib/json-store.mjs";
import { ACTIVITY_ID, createActivityStore } from "./lib/activity-store.mjs";
import { AVATAR_ERRORS, AVATAR_MAX_BYTES, imageType, multipartBody, singleFilePart } from "./lib/avatar.mjs";
import {
  KEYWORD_ERRORS, KEYWORD_MAX, POLICY_BLOCKED_ERROR, applyPolicyPatch, applyPrefsPatch, blockedBy, blockedExtensionsDotted, cleanKeyword,
  presentPolicy, presentPrefs,
} from "./lib/settings.mjs";

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
const noticeStore = createNoticeStore(path.join(dataDir, "notices.json"));
const prefsStore = createPrefsStore(path.join(dataDir, "prefs.json"));
const adminMeta = createAdminMetaStore(path.join(dataDir, "admin-meta.json"));
// P3 (docs/p3-contract.md): N6 replies / reactions, D1 admin policy.
const activityStore = createActivityStore(path.join(dataDir, "activity.json"));
const policyStore = createPolicyStore(path.join(dataDir, "policy.json"));
let WEB_VERSION = null;
try {
  WEB_VERSION = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8")).version || null;
} catch {
  WEB_VERSION = null;
}
const auditLog = createAuditLog({
  dir: path.join(dataDir, "audit"),
  keepMonths: config.auditKeepMonths,
  log: (message) => console.error(`[sangsang] ${message}`),
});
const UNLOCK_TRIES = 5; // C4: wrong passwords on the lock screen before the session is signed out
const NOTES_ERROR = "쪽지 기록을 읽지 못했습니다. 다시 시도하세요.";
const STORE_ERROR = "저장된 설정을 읽지 못했습니다. 다시 시도하세요.";
// P2 (docs/p2-contract.md)
const EDIT_LIMIT_SECONDS = 600; // A4: same as the realm's message_content_edit_limit_seconds (web/dev/apply-p2-settings.mjs)
const RECEIPT_RECENT = 30; // A1: unreadCount on my 30 most recent messages in a 1:1/group
const RECEIPT_CACHE_MS = 15 * 1000;
const SEARCH_PAGE = 50; // A2
// A6: department rooms are group channels whose description starts with this (set by dept-sync, 2-C).
const DEPT_MARK = "[상상톡 부서 대화방]";
// B1: the six reactions the app offers, by Zulip unicode code point (names stay stable if Zulip adds aliases).
const REACTIONS = { thumbs_up: "1f44d", check: "2705", smile: "1f604", clap: "1f44f", pray: "1f64f", open_mouth: "1f62e" };
const REACTION_BY_CODE = new Map(Object.entries(REACTIONS).map(([name, code]) => [code, name]));
// B2: manual status code <-> the Zulip status emoji that carries it (status_text is the free text).
const STATUS_EMOJI = { meeting: "calendar", trip: "airplane", leave: "palm_tree", outside: "walking", training: "books" };
const STATUS_BY_EMOJI = new Map(Object.entries(STATUS_EMOJI).map(([code, emoji]) => [emoji, code]));
const STATUS_TEXT_MAX = 60; // Zulip's limit
const STARRED_PAGE = 100;
const FILES_PAGE = 100;
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
  // C1 admin screen assets (the page itself, /admin, is served only to administrators).
  ["/admin.js", "admin.js"],
  ["/admin.css", "admin.css"],
]);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

// raw: { body: Buffer, contentType } instead of form (P1 avatar upload, multipart).
function zulip(method, apiPath, { auth, form, raw, timeoutMs = 20000, signal } = {}) {
  const body = raw ? raw.body : form ? new URLSearchParams(form).toString() : null;
  const headers = {
    accept: "application/json",
    "user-agent": "SangsangTalk/0.1",
  };
  if (auth) headers.authorization = auth;
  if (body) {
    headers["content-type"] = raw ? raw.contentType : "application/x-www-form-urlencoded";
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

// Zulip reactions -> [{ emoji, count, userIds, mine }], in the order each emoji first appeared.
// Only the six app reactions are shown (others, e.g. added in Zulip's own web UI, are left out).
function reactionList(reactions, myId) {
  const byEmoji = new Map();
  for (const reaction of Array.isArray(reactions) ? reactions : []) {
    const emoji = reaction.reaction_type === "unicode_emoji" ? REACTION_BY_CODE.get(String(reaction.emoji_code || "")) : null;
    if (!emoji || !Number.isInteger(reaction.user_id)) continue;
    if (!byEmoji.has(emoji)) byEmoji.set(emoji, []);
    const ids = byEmoji.get(emoji);
    if (!ids.includes(reaction.user_id)) ids.push(reaction.user_id);
  }
  return [...byEmoji].map(([emoji, userIds]) => ({ emoji, count: userIds.length, userIds, mine: userIds.includes(myId) }));
}

// flags: Zulip's per-user flags (on the message from GET /messages, on the event for new-message events).
function normalize(message, session, flags = message.flags) {
  const fields = messageFields(typeof message.content === "string" ? message.content : "", {
    edited: Boolean(message.last_edit_timestamp),
    flags: Array.isArray(flags) ? flags : [],
    myId: session?.userId,
  });
  // C5: a poll / todo message is drawn from its widget; the "/poll ..." text is not shown.
  const widget = fields.recalled ? { poll: null, todo: null } : widgetFields(message.submessages);
  const content = widget.poll || widget.todo ? "" : fields.content;
  const attachments = fields.attachments;
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
    edited: fields.edited,
    recalled: fields.recalled,
    replyTo: fields.replyTo,
    mentions: fields.mentions,
    mentionedMe: fields.mentionedMe,
    reactions: fields.recalled ? [] : reactionList(message.reactions, session?.userId),
    starred: fields.starred,
    unreadCount: null, // handleMessages fills it for my recent 1:1/group messages
    poll: widget.poll,
    todo: widget.todo,
    // N4: Zulip's alert-word flag (set when the message arrived; my own messages never have it).
    alerted: !fields.recalled && Array.isArray(flags) && flags.includes("has_alert_word") && message.sender_id !== session?.userId,
    urgent: fields.urgent, // N7
    avatarUrl: avatarUrlFor(message.sender_id, message.avatar_url), // P1: sender's photo, "" for none
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
      // update_message / reaction / submessage / starred flags become `updated` (P2: edit, recall,
      // reactions, stars, polls); typing becomes `typing`; user_status keeps the status cache current.
      event_types: JSON.stringify([
        "message", "subscription", "stream", "update_message", "reaction", "submessage",
        "update_message_flags", "typing", "user_status",
      ]),
    },
  });
  if (response.json?.result !== "success" || !response.json.queue_id) {
    const error = new Error("queue");
    error.zulipStatus = response.status;
    error.zulipCode = response.json?.code;
    throw error;
  }
  // Registering returns everyone's current status: a full refresh of the shared cache.
  if (response.json.user_status && typeof response.json.user_status === "object") {
    userStatuses.clear();
    for (const [userId, status] of Object.entries(response.json.user_status)) setUserStatus(Number(userId), status);
    statusesLoaded = true;
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
    createdAt: session.createdAt || null,
    lastSeenAt: session.lastSeenAt || null,
    client: session.client || null,
    ip: session.ip || null,
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
      createdAt: Number.isFinite(record.createdAt) ? record.createdAt : null,
      lastSeenAt: Number.isFinite(record.lastSeenAt) ? record.lastSeenAt : null,
      client: record.client === "desktop" ? "desktop" : "browser",
      ip: typeof record.ip === "string" ? record.ip.slice(0, 64) : "",
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
    // P2: Zulip role, for showing admin-only menus. Every admin action re-checks it with Zulip.
    role: session.role || "member",
    isAdmin: isAdminRole(session.role),
    department: session.department || "",
    position: session.position || "",
    // C1: set by an administrator (new account / reset by the server operator); the browser asks for a new password.
    mustChangePassword: Boolean(session.mustChangePassword),
    // C4: set by POST /api/session/lock, cleared by a successful unlock (memory only, not across restarts).
    locked: Boolean(session.locked),
    // The browser checks files against the same limits before uploading (the server re-checks).
    // D1: the built-in list plus the administrator's additions (policy.json).
    limits: { maxUploadMb: MAX_UPLOAD_MB, blockedExtensions: blockedExtensionsDotted(currentPolicy()) },
    // C3 / C4 settings for the browser (WATERMARK, AUTO_LOCK_MINUTES).
    watermark: config.watermark,
    autoLockMinutes: config.autoLockMinutes,
    // Internal mail domain for login IDs (<employee no.>@<domain>), so the login form can fill it in. null = not set.
    loginDomain: config.loginDomain,
    // P3: web version (web/package.json) and the policy values the browser applies.
    version: WEB_VERSION,
    policy: { forcePreviewHidden: Boolean(currentPolicy().forcePreviewHidden) },
    avatarUrl: session.avatarUrl || "", // P1: my photo ("" for none)
  };
}

// ---- D1 policy (web/data/policy.json). Read at startup and after each change; a broken file keeps
// the last good value (or the defaults) for display, and only the policy API answers 503. ----
function currentPolicy() {
  return policyStore.cached() || { version: 1, forcePreviewHidden: false, blockedExtensions: [] };
}

// policy.json unreadable (main file and .bak): uploads are refused until it reads again (fail closed),
// and the admin policy API says what is wrong.
const POLICY_UPLOAD_ERROR = "파일 정책을 읽지 못해 파일 올리기를 막았습니다. 서버 관리자에게 알려 주세요.";
const POLICY_FILE_ERROR = "관리자 정책 파일(policy.json)을 읽지 못했습니다. 서버 관리자에게 알려 주세요. 그동안 파일 올리기는 막힙니다.";
let policyBroken = false;

// Reads policy.json again; false (and policyBroken) when it cannot be read.
async function reloadPolicy() {
  try {
    await policyStore.get();
    policyBroken = false;
    return true;
  } catch (error) {
    if (error.code !== "JSON_STORE") throw error;
    if (!policyBroken) console.error(`[sangsang] 관리자 정책 파일을 읽지 못했습니다 (${error.message}). 파일 올리기를 막습니다.`);
    policyBroken = true;
    return false;
  }
}

function announceAll(flag) {
  for (const session of sessions.values()) {
    session[flag] = true;
    session.wake?.();
  }
}

function announceUser(userId, flag) {
  for (const session of sessions.values()) {
    if (session.userId !== userId) continue;
    session[flag] = true;
    session.wake?.();
  }
}

// C2: the client's address. Behind the HTTPS proxy (PUBLIC_ORIGIN set) every request comes from the
// proxy on loopback, so the last X-Forwarded-For entry (added by our own proxy) is used; otherwise
// the header is ignored because any client could write it.
function clientIp(request) {
  const remote = String(request.socket?.remoteAddress || "").replace(/^::ffff:/, "");
  if (config.publicOrigin && /^(127\.|::1$)/.test(remote)) {
    const forwarded = String(request.headers["x-forwarded-for"] || "").split(",").map((part) => part.trim()).filter(Boolean);
    if (forwarded.length) return forwarded[forwarded.length - 1].slice(0, 64);
  }
  return remote;
}

function audit(request, session, action, target, ok = true) {
  auditLog.write({ userId: session?.userId ?? null, ip: clientIp(request), action, target, ok });
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

// appOnly: APP_ONLY_LOGIN is on and the request is not from the desktop app. Then only Zulip
// administrators / owners may sign in (C1: the admin screen is used from a browser).
async function handleLogin(request, response, { appOnly = false } = {}) {
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
    audit(request, null, "login_fail", email.slice(0, 100), false);
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
    // P4: shown in "내 로그인 목록". The client header can be forged; it is only a label.
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    client: request.headers["x-sangsangtalk-client"] === "desktop" ? "desktop" : "browser",
    ip: clientIp(request),
  };
  try {
    const me = await zulip("GET", "/api/v1/users/me", { auth: basic(session) });
    if (me.json?.result === "success") {
      if (me.json.full_name) session.fullName = me.json.full_name;
      if (me.json.user_id) session.userId = me.json.user_id;
      session.role = roleName(me.json.role);
      await loadSessionDetails(session);
    }
  } catch {
    // The API key is enough to enter. The email local-part stands in for the name.
  }
  if (appOnly && !isAdminRole(session.role)) {
    audit(request, session, "login_fail", "app_only", false);
    sendJson(response, 403, { error: APP_ONLY_LOGIN_MESSAGE });
    return;
  }
  try {
    session.peer = await findPeer(session);
  } catch {
    session.peer = null;
  }
  const sid = randomBytes(32).toString("hex");
  sessions.set(sid, session);
  persistSessions();
  audit(request, session, "login", appOnly ? "browser_admin" : "");
  sendJson(response, 200, publicUser(session), [sessionCookie(sid, SESSION_TTL_MS / 1000)]);
}

// Zulip PATCH /settings checks the current password and the new one's strength itself.
async function changeMyPassword(request, session) {
  const body = await readJson(request);
  const oldPassword = typeof body.oldPassword === "string" ? body.oldPassword : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  if (!oldPassword || newPassword.length < 8 || newPassword.length > 100) {
    throw httpError(400, "현재 비밀번호와 8자 이상의 새 비밀번호를 입력하세요.", "password");
  }
  if (oldPassword === newPassword) throw httpError(400, "새 비밀번호는 지금과 달라야 합니다.", "password");
  let result;
  try {
    result = await zulip("PATCH", "/api/v1/settings", {
      auth: basic(session),
      form: { old_password: oldPassword, new_password: newPassword },
    });
  } catch (error) {
    // 429: Zulip's wrong-password limit (or the API rate limit) — still a failed attempt to record.
    if (error.status === 429) audit(request, session, "password_change", "rate_limited", false);
    throw error;
  }
  if (result.json?.result !== "success") {
    const message = String(result.json?.msg || "");
    audit(request, session, "password_change", "", false);
    if (/wrong password|incorrect/i.test(message)) throw httpError(400, "현재 비밀번호가 올바르지 않습니다.", "password");
    if (/too weak|strength/i.test(message)) throw httpError(400, "새 비밀번호가 너무 약합니다. 더 길고 복잡하게 정하세요.", "password");
    throw zulipFailure(result, "비밀번호를 바꾸지 못했습니다.");
  }
  // The password did change in Zulip: a failed flag write is logged, not reported as a failure.
  try {
    await adminMeta.set(session.userId, { mustChangePassword: false });
  } catch (error) {
    console.error(`[sangsang] 비밀번호 변경 표시를 지우지 못했습니다 (${error.code || error.message}).`);
  }
  for (const other of sessions.values()) if (other.userId === session.userId) other.mustChangePassword = false;
  audit(request, session, "password_change", "");
  return { ok: true };
}

// Drops one session and its Zulip event queue (logout, lock-screen sign-out, administrator action).
function closeSession(sid, session) {
  if (session.queueId) {
    zulip("DELETE", `/api/v1/events?${new URLSearchParams({ queue_id: session.queueId })}`, { auth: basic(session), timeoutMs: 5000 }).catch(() => {});
  }
  dropSession(sid);
}

// C4: the lock screen re-checks the password with Zulip. UNLOCK_TRIES wrong answers sign the session out.
// 401 here does not mean "signed out" unless signedOut is true (the browser keeps the session otherwise).
async function handleUnlock(request, response, session) {
  const body = await readJson(request);
  const password = typeof body.password === "string" ? body.password : "";
  const sid = cookieValue(request, "sangsang_sid");
  let ok = false;
  if (password && password.length <= 200) {
    let result;
    try {
      result = await zulip("POST", "/api/v1/fetch_api_key", { form: { username: session.email, password } });
    } catch (error) {
      if (error.status !== 429) throw error;
      // Zulip blocks this user name after repeated wrong passwords (30 minutes): sign out now.
      closeSession(sid, session);
      audit(request, session, "logout", "unlock_rate_limited", false);
      sendJson(response, 401, { error: "비밀번호를 여러 번 틀려 로그아웃했습니다. 30분 동안 로그인할 수 없습니다.", signedOut: true, remaining: 0 }, [sessionCookie("", 0)]);
      return;
    }
    ok = result.json?.result === "success" && result.json.user_id === session.userId;
  }
  if (ok) {
    session.unlockFails = 0;
    session.locked = false;
    sendJson(response, 200, { ok: true });
    return;
  }
  session.unlockFails = (session.unlockFails || 0) + 1;
  audit(request, session, "unlock_fail", String(session.unlockFails), false);
  if (session.unlockFails >= UNLOCK_TRIES) {
    closeSession(sid, session);
    audit(request, session, "logout", "unlock_failed", false);
    sendJson(response, 401, { error: "비밀번호를 5번 틀려 로그아웃했습니다. 다시 로그인하세요.", signedOut: true, remaining: 0 }, [sessionCookie("", 0)]);
    return;
  }
  sendJson(response, 401, { error: "비밀번호가 올바르지 않습니다.", signedOut: false, remaining: UNLOCK_TRIES - session.unlockFails });
}

function roleName(role) {
  if (role === 100) return "owner";
  if (role === 200) return "admin";
  if (role === 300) return "moderator";
  if (role === 600) return "guest";
  return "member";
}

function isAdminRole(role) {
  return role === "owner" || role === "admin";
}

// The role as Zulip has it now (restored sessions and role changes since login are covered).
// Used for permission checks; the cached session.role only drives what the browser shows.
// Also refreshes the department / position shown by /api/session (same profile fields as the directory).
async function currentRole(session) {
  const me = await zulip("GET", `/api/v1/users/${session.userId}?include_custom_profile_fields=true`, { auth: basic(session) });
  if (me.json?.result !== "success" || !me.json.user) throw zulipFailure(me, "사용자 정보를 읽지 못했습니다.");
  session.role = roleName(me.json.user.role);
  session.avatarUrl = avatarUrlFor(session.userId, me.json.user.avatar_url);
  const fieldIds = await titleFieldIds(session);
  const data = me.json.user.profile_data || {};
  session.department = fieldIds.department ? profileText(data[String(fieldIds.department)]) : "";
  session.position = fieldIds.position ? profileText(data[String(fieldIds.position)]) : "";
  return session.role;
}

// Role, department, position and the first-login password flag, after login or restore.
async function loadSessionDetails(session) {
  await currentRole(session);
  try {
    session.mustChangePassword = Boolean((await adminMeta.get(session.userId)).mustChangePassword);
  } catch {
    session.mustChangePassword = false;
  }
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

// P1: our proxy address for the photo Zulip serves locally (uploaded, or Zulip 12's generated default),
// "" when Zulip has none here (gravatar). Zulip's file name is a hash that changes with every new photo
// (/user_avatars/2/<hash>.png), so its start is ?v= and a changed photo is not taken from the browser cache.
function avatarUrlFor(userId, zulipAvatarUrl) {
  const avatarPath = localAvatarPath(zulipAvatarUrl);
  if (!avatarPath || !Number.isSafeInteger(userId)) return "";
  const version = avatarPath.split("?")[0].match(/\/([0-9a-f]{12})[0-9a-f]*\.[a-z]+$/i)
    || avatarPath.match(/[?&]version=(\d{1,10})/);
  return `/api/avatar/${userId}${version ? `?v=${version[1].toLowerCase()}` : ""}`;
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
        avatarUrl: title && avatarPath ? avatarUrlFor(user.user_id, user.avatar_url) : "",
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

// before (older), after (newer) or around (half each side): at most one, each a positive message id.
function parseAnchor(params) {
  const anchor = {};
  for (const name of ["before", "after", "around"]) {
    const value = params.get(name);
    if (value === null || value === "") continue;
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0 || String(id) !== value) {
      throw httpError(400, "불러올 위치가 올바르지 않습니다.", "anchor");
    }
    anchor[name] = id;
  }
  if (Object.keys(anchor).length > 1) throw httpError(400, "불러올 위치가 올바르지 않습니다.", "anchor");
  return anchor;
}

function conversationNarrow(peer, group) {
  if (peer) return [{ operator: "dm", operand: [peer.userId] }];
  if (group) return [{ operator: "channel", operand: group.groupId }];
  return [{ operator: "channel", operand: CHANNEL }];
}

async function fetchZulipMessages(session, narrow, { anchor, numBefore, numAfter, includeAnchor = false }) {
  const query = new URLSearchParams({
    anchor: String(anchor),
    num_before: String(numBefore),
    num_after: String(numAfter),
    include_anchor: includeAnchor ? "true" : "false",
    apply_markdown: "false",
    narrow: JSON.stringify(narrow),
  });
  const result = await zulip("GET", `/api/v1/messages?${query}`, { auth: basic(session) });
  if (result.json?.result !== "success" || !Array.isArray(result.json.messages)) {
    const error = new Error("messages");
    error.status = result.status === 401 ? 401 : 502;
    throw error;
  }
  return result.json;
}

// One message as this user sees it (null when it is not part of this app or not visible).
async function fetchOne(session, messageId) {
  const one = await zulip("GET", `/api/v1/messages/${messageId}?apply_markdown=false`, { auth: basic(session) });
  if (one.status === 401) throw httpError(401, "", "auth");
  if (one.json?.result !== "success" || !one.json.message) return null;
  return { raw: one.json.message, message: normalize(one.json.message, session) };
}

// "general" | "dm:<small>-<big>" | "group:<id>" — notice keys (A5) and same-conversation checks.
function conversationKey(session, message) {
  if (message.kind === "group") return `group:${message.groupId}`;
  if (message.kind === "dm") {
    const [a, b] = [session.userId, message.peerId].sort((x, y) => x - y);
    return `dm:${a}-${b}`;
  }
  return "general";
}

async function handleMessages(session, view, params) {
  const anchor = parseAnchor(params);
  const peer = view === "dm" ? await personById(session, params.get("userId")) : null;
  const group = view === "group" ? await groupById(session, params.get("groupId")) : null;
  await enqueue(session, () => ensureQueue(session));
  const narrow = conversationNarrow(peer, group);
  const noteIds = view === "dm" ? new Set((await noteRecords(session)).map((note) => note.messageId)) : new Set();
  const visible = (raw) => {
    // Also hide notes still in flight (sent, index not yet written).
    if (view === "dm") for (const message of raw) if (pendingNoteRecord(message)) noteIds.add(message.id);
    return raw
      .map((message) => normalize(message, session))
      .filter((message) => message && !noteIds.has(message.id))
      .sort((a, b) => a.id - b.id);
  };
  let messages = [];
  let hasOlder = false;
  let hasNewer = false;
  if (anchor.around || anchor.after) {
    // A2: open a search result in place (around), then fill the newer side (after).
    const data = anchor.around
      ? await fetchZulipMessages(session, narrow, { anchor: anchor.around, numBefore: PAGE_SIZE / 2, numAfter: PAGE_SIZE / 2 - 1, includeAnchor: true })
      : await fetchZulipMessages(session, narrow, { anchor: anchor.after, numBefore: 0, numAfter: PAGE_SIZE });
    messages = visible(data.messages);
    hasOlder = anchor.after ? true : data.found_oldest === false;
    hasNewer = data.found_newest === false;
  } else {
    // Notes are hidden from the 1:1 view. A page made only of notes would come back empty with
    // hasOlder:true and leave the browser no `before` to continue from, so keep reading older
    // pages (bounded) until something is visible or the start of the conversation is reached.
    let from = anchor.before ? String(anchor.before) : "newest";
    for (let round = 0; round < MAX_EMPTY_PAGES; round += 1) {
      const data = await fetchZulipMessages(session, narrow, { anchor: from, numBefore: PAGE_SIZE, numAfter: 0 });
      const raw = data.messages;
      hasOlder = data.found_oldest === false && raw.length > 0;
      messages = visible(raw);
      if (messages.length || !hasOlder) break;
      from = String(Math.min(...raw.map((message) => message.id)));
    }
  }
  // A1: only a page that reaches the newest message holds my most recent messages.
  if ((peer || group) && !anchor.before && !hasNewer) {
    const recipients = peer ? [peer.userId] : group.memberIds.filter((id) => id !== session.userId);
    await fillUnreadCounts(session, messages, recipients);
  }
  const key = peer ? conversationKey(session, { kind: "dm", peerId: peer.userId }) : group ? `group:${group.groupId}` : "general";
  await markRecalledReplies(session, messages);
  return {
    view,
    channel: view === "general" ? CHANNEL : null,
    peer,
    group,
    hasOlder,
    hasNewer,
    messages,
    notice: await noticeFor(session, key),
  };
}

// ---- A3: a reply whose original was recalled ----
// The reply's own text still quotes the old original, so the original's state is looked up
// (cached briefly; a recall through this server updates the cache at once).
const RECALL_CACHE_MS = 60 * 1000;
const recallCache = new Map(); // messageId -> { recalled, at }

function rememberRecalled(messageId, recalled) {
  if (recallCache.size > 5000) {
    const now = Date.now();
    for (const [id, entry] of recallCache) if (now - entry.at >= RECALL_CACHE_MS) recallCache.delete(id);
  }
  recallCache.set(messageId, { recalled, at: Date.now() });
}

async function originalRecalled(session, messageId) {
  const hit = recallCache.get(messageId);
  if (hit && (hit.recalled || Date.now() - hit.at < RECALL_CACHE_MS)) return hit.recalled;
  let recalled = false;
  try {
    const found = await fetchOne(session, messageId);
    recalled = Boolean(found?.message?.recalled);
  } catch (error) {
    if (error.status === 401) throw error;
    return false; // unknown: leave the quote as it is
  }
  rememberRecalled(messageId, recalled);
  return recalled;
}

// Changes replyTo in place to { id, senderId, senderName, excerpt: RECALLED_TEXT, recalled: true } where needed.
async function markRecalledReplies(session, messages) {
  const ids = [...new Set(messages.filter((message) => message?.replyTo).map((message) => message.replyTo.id))];
  const recalled = new Set();
  for (const id of ids) if (await originalRecalled(session, id)) recalled.add(id);
  for (const message of messages) {
    if (message?.replyTo && recalled.has(message.replyTo.id)) {
      message.replyTo = {
        id: message.replyTo.id, senderId: message.replyTo.senderId, senderName: message.replyTo.senderName, excerpt: RECALLED_TEXT, recalled: true,
      };
    }
  }
  return messages;
}

// ---- A1 read receipts ----
const receiptCache = new Map(); // `${viewerId}:${messageId}` -> { at, readIds }

async function readReceipts(session, messageId) {
  const key = `${session.userId}:${messageId}`;
  const hit = receiptCache.get(key);
  if (hit && Date.now() - hit.at < RECEIPT_CACHE_MS) return hit.readIds;
  const result = await zulip("GET", `/api/v1/messages/${messageId}/read_receipts`, { auth: basic(session) });
  if (result.json?.result !== "success" || !Array.isArray(result.json.user_ids)) {
    throw zulipFailure(result, "읽은 사람을 읽지 못했습니다.");
  }
  const readIds = result.json.user_ids.filter(Number.isInteger);
  if (receiptCache.size > 5000) {
    const now = Date.now();
    for (const [cacheKey, entry] of receiptCache) if (now - entry.at >= RECEIPT_CACHE_MS) receiptCache.delete(cacheKey);
  }
  receiptCache.set(key, { at: Date.now(), readIds });
  return readIds;
}

// Newest first. Messages are read in order (opening a conversation marks it read), so once every
// recipient has read one of my messages the older ones count as read too: usually 1-2 Zulip calls,
// not 30. A failure (rate limit, receipts off) leaves the counts null instead of failing the page.
async function fillUnreadCounts(session, messages, recipients) {
  const mine = messages
    .filter((message) => message.senderId === session.userId && !message.recalled)
    .sort((a, b) => b.id - a.id)
    .slice(0, RECEIPT_RECENT);
  let allRead = false;
  for (const message of mine) {
    if (allRead) {
      message.unreadCount = 0;
      continue;
    }
    let read;
    try {
      read = new Set(await readReceipts(session, message.id));
    } catch (error) {
      if (error.status === 401) throw error;
      return;
    }
    message.unreadCount = recipients.filter((id) => !read.has(id)).length;
    if (message.unreadCount === 0) allRead = true;
  }
}

// Everyone who can read the message apart from me: 1:1 peer, group members, or all active staff.
async function messageRecipients(session, message) {
  if (message.kind === "dm") return [message.peerId];
  if (message.kind === "group") {
    const group = await groupById(session, message.groupId);
    return group.memberIds.filter((id) => id !== session.userId);
  }
  const members = await fetchMembers(session);
  return members.filter((user) => !user.is_bot && user.is_active !== false && user.user_id !== session.userId).map((user) => user.user_id);
}

async function handleReaders(session, messageId) {
  const found = await fetchOne(session, messageId);
  if (!found?.message) throw httpError(404, "메시지를 찾지 못했습니다.", "message");
  const { message } = found;
  const recipients = await messageRecipients(session, message);
  const read = new Set(await readReceipts(session, message.id));
  // The sender has always read their own message (Zulip leaves the sender out of receipts).
  const isRead = (id) => id === message.senderId || read.has(id);
  return { readIds: recipients.filter(isRead), unreadIds: recipients.filter((id) => !isRead(id)) };
}

// Marks messages read in Zulip so senders see the receipts. The browser calls this for the
// conversation on screen; ids it cannot see are ignored by Zulip.
async function markRead(session, body) {
  const ids = Array.isArray(body.messageIds) ? [...new Set(body.messageIds.map(Number))] : [];
  if (!ids.length || ids.length > 1000 || !ids.every((id) => Number.isSafeInteger(id) && id > 0)) {
    throw httpError(400, "읽은 메시지를 확인하세요.", "read");
  }
  const result = await zulip("POST", "/api/v1/messages/flags", {
    auth: basic(session),
    form: { messages: JSON.stringify(ids), op: "add", flag: "read" },
  });
  if (result.json?.result !== "success") throw zulipFailure(result, "읽음 표시를 하지 못했습니다.");
  return { ok: true };
}

// ---- A5 notices ----
// Reading a page never fails because of the notice file: a broken / unreadable file shows no notice
// (logged); only the notice write API answers 503.
async function noticeFor(session, key) {
  let record;
  try {
    record = await noticeStore.get(key);
  } catch (error) {
    if (error.code !== "JSON_STORE") throw error;
    console.error(`[sangsang] 공지 파일을 읽지 못했습니다 (${error.message}). 공지 없이 보여 줍니다.`);
    return null;
  }
  if (!record) return null;
  const found = await fetchOne(session, record.messageId);
  if (!found?.message || conversationKey(session, found.message) !== key) return null;
  const setter = await zulip("GET", `/api/v1/users/${record.setBy}`, { auth: basic(session) });
  const ackIds = record.ackRequired ? record.ackUserIds : [];
  const acks = record.acks || {};
  return {
    message: (await markRecalledReplies(session, [found.message]))[0],
    setByName: setter.json?.user?.full_name || "알 수 없음",
    setAt: record.setAt,
    // N8: ackTotal is the room minus the setter when it was set. ackTarget / canViewAcks drive the buttons.
    ackRequired: Boolean(record.ackRequired),
    ackCount: ackIds.filter((id) => acks[String(id)]).length,
    ackTotal: ackIds.length,
    ackedByMe: Boolean(record.ackRequired && acks[String(session.userId)]),
    ackTarget: ackIds.includes(session.userId),
    canViewAcks: Boolean(record.ackRequired && (record.setBy === session.userId || isAdminRole(session.role))),
  };
}

// N8: who must acknowledge a notice set now: everyone in the conversation except the setter.
async function noticeAudience(session, key) {
  if (key.startsWith("dm:")) return key.slice(3).split("-").map(Number).filter((id) => id !== session.userId);
  if (key.startsWith("group:")) {
    const group = await groupById(session, key.slice(6));
    return group.memberIds.filter((id) => id !== session.userId);
  }
  return (await fetchMembers(session))
    .filter((user) => !user.is_bot && user.is_active !== false && user.user_id !== session.userId)
    .map((user) => user.user_id);
}

// POST /api/notices/ack. Acking twice is fine (same answer).
async function ackNotice(request, session, source) {
  const key = await noticeTarget(session, source);
  const record = await noticeStore.get(key);
  if (!record) throw httpError(404, "공지가 없습니다.", "notice");
  const result = await noticeStore.ack(key, record.messageId, session.userId, Math.floor(Date.now() / 1000));
  if (result.status === "missing") throw httpError(404, "공지가 없습니다.", "notice");
  if (result.status === "notRequired") throw httpError(400, "확인 요청이 없는 공지입니다.", "notice");
  if (result.status === "notTarget") throw httpError(403, "이 공지의 확인 대상이 아닙니다.", "notice");
  if (result.status === "done") {
    audit(request, session, "notice_ack", `${key}:${record.messageId}`);
    announceAckChange(key, record.setBy);
  }
  return { notice: await noticeFor(session, key) };
}

// GET /api/notices/acks: the setter and administrators only.
async function noticeAcks(session, source) {
  const key = await noticeTarget(session, source);
  const record = await noticeStore.get(key);
  if (!record) throw httpError(404, "공지가 없습니다.", "notice");
  if (!record.ackRequired) throw httpError(400, "확인 요청이 없는 공지입니다.", "notice");
  if (record.setBy !== session.userId && !isAdminRole(await currentRole(session))) {
    throw httpError(403, "공지를 등록한 사람과 관리자만 볼 수 있습니다.", "notice");
  }
  const names = new Map((await fetchMembers(session)).map((user) => [user.user_id, user.full_name || user.email]));
  const name = (id) => names.get(id) || "알 수 없음";
  return {
    acked: record.ackUserIds.filter((id) => record.acks[String(id)])
      .map((id) => ({ userId: id, name: name(id), at: record.acks[String(id)] }))
      .sort((a, b) => a.at - b.at),
    pending: record.ackUserIds.filter((id) => !record.acks[String(id)]).map((id) => ({ userId: id, name: name(id) })),
  };
}

// view/userId/groupId -> notice key, after checking this user is in that conversation.
async function noticeTarget(session, source) {
  if (source.view === "general") return "general";
  if (source.view === "dm") {
    const peer = await personById(session, source.userId);
    return conversationKey(session, { kind: "dm", peerId: peer.userId });
  }
  if (source.view === "group") {
    const group = await groupById(session, source.groupId);
    return `group:${group.groupId}`;
  }
  throw httpError(400, "대화방을 확인하세요.", "view");
}

async function changeNotice(session, method, source) {
  const key = await noticeTarget(session, source);
  // Default (p2-contract): anyone in a 1:1/group, administrators only in the all-staff room.
  if (key === "general" && !isAdminRole(await currentRole(session))) {
    throw httpError(403, "전체 대화방 공지는 관리자만 바꿀 수 있습니다.", "notice");
  }
  if (method === "DELETE") {
    await noticeStore.remove(key);
  } else {
    const found = await fetchOne(session, Number(source.messageId));
    const isNote = found?.message?.kind === "dm" && (await isNoteMessage(session, found.raw));
    if (!found?.message || conversationKey(session, found.message) !== key || isNote) {
      throw httpError(404, "이 대화방의 메시지를 찾지 못했습니다.", "notice");
    }
    if (found.message.recalled) throw httpError(400, "회수된 메시지는 공지로 등록할 수 없습니다.", "notice");
    if (source.ackRequired !== undefined && typeof source.ackRequired !== "boolean") throw httpError(400, "확인 요청 값을 확인하세요.", "notice");
    const notice = { messageId: found.message.id, setBy: session.userId, setAt: Math.floor(Date.now() / 1000) };
    if (source.ackRequired) Object.assign(notice, { ackRequired: true, ackUserIds: await noticeAudience(session, key) });
    await noticeStore.set(key, notice);
    // N6: the activity record stays when this notice is later replaced or removed. A failed write is logged.
    try {
      await activityStore.addNotice({ key, ...notice, ackRequired: Boolean(notice.ackRequired) });
    } catch (error) {
      if (error.code !== "JSON_STORE") throw error;
      console.error(`[sangsang] 공지 활동을 기록하지 못했습니다 (${error.message}).`);
    }
  }
  announceNotice(key, method === "DELETE" ? null : session.userId);
  return { notice: await noticeFor(session, key) };
}

// N7: the urgent slot is taken before sending (concurrent requests cannot pass the hourly limit together)
// and given back when the message was not sent.
async function handleSend(session, request) {
  const urgentSlot = { release: null };
  try {
    return await sendMessage(session, request, urgentSlot);
  } catch (error) {
    urgentSlot.release?.();
    throw error;
  }
}

async function sendMessage(session, request, urgentSlot) {
  const body = await readJson(request);
  const view = body.view === "dm" || body.view === "group" ? body.view : "general";
  // C5: a poll / todo replaces the text and files; it cannot be a note, a reply or carry mentions.
  const widget = widgetFrom(body);
  if (widget) {
    if (body.note === true) throw httpError(400, "\uCABD\uC9C0\uB85C\uB294 \uD22C\uD45C\u00B7\uD560 \uC77C\uC744 \uBCF4\uB0BC \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", "widget");
    if ((body.replyToId !== undefined && body.replyToId !== null) || (Array.isArray(body.mentions) && body.mentions.length)) {
      throw httpError(400, "\uD22C\uD45C\u00B7\uD560 \uC77C\uC5D0\uB294 \uB2F5\uC7A5\u00B7\uBA58\uC158\uC744 \uC4F8 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", "widget");
    }
    body.content = widgetContent(widget);
    body.attachments = [];
  }
  let text = typeof body.content === "string" ? body.content.trim() : "";
  // A typed message starting with "/poll" or "/todo" would turn into a widget in Zulip: keep it text
  // (a zero-width space in front stops Zulip's widget parser and is invisible).
  if (!widget && /^\/(poll|todo)(\s|$)/i.test(text)) text = `\u200B${text}`;
  const files = attachmentLines(body.attachments);
  if (!files) throw httpError(400, "\uCCA8\uBD80 \uD30C\uC77C\uC744 \uD655\uC778\uD558\uC138\uC694.", "attachments");
  if (!text && !files.lines.length) {
    throw httpError(400, "\uBA54\uC2DC\uC9C0\uB97C \uC785\uB825\uD558\uC138\uC694.", "empty");
  }
  const peer = view === "dm" ? await personById(session, body.userId) : null;
  const group = view === "group" ? await groupById(session, body.groupId) : null;
  if (body.note === true && !peer) throw httpError(400, "\uC0AC\uC6A9\uC790\uB97C \uC120\uD0DD\uD558\uC138\uC694.", "user");
  const hasReply = body.replyToId !== undefined && body.replyToId !== null;
  const mentioned = await mentionedPeople(session, body.mentions);
  if (body.note === true && (hasReply || mentioned.length)) throw httpError(400, "\uCABD\uC9C0\uC5D0\uB294 \uB2F5\uC7A5\u00B7\uBA58\uC158\uC744 \uC4F8 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", "note");
  // N7: urgent is a marker line after the reply quote (lib/message-format.mjs).
  if (body.urgent !== undefined && typeof body.urgent !== "boolean") throw httpError(400, "\uC911\uC694 \uBA54\uC2DC\uC9C0 \uAC12\uC744 \uD655\uC778\uD558\uC138\uC694.", "urgent");
  const urgent = body.urgent === true;
  if (urgent) {
    if (widget || body.note === true) throw httpError(400, "쪽지·투표·할 일은 중요 메시지로 보낼 수 없습니다.", "urgent");
    if (view === "general" && !isAdminRole(await currentRole(session))) {
      throw httpError(403, "\uC804\uCCB4 \uB300\uD654\uBC29\uC758 \uC911\uC694 \uBA54\uC2DC\uC9C0\uB294 \uAD00\uB9AC\uC790\uB9CC \uBCF4\uB0BC \uC218 \uC788\uC2B5\uB2C8\uB2E4.", "urgent");
    }
    urgentSlot.release = reserveUrgent(session); // after the 403 check, so a refused room never uses a slot
  }
  // A3: the quote goes in front, mentions become Zulip syntax; the reply target must be in this conversation.
  let prefix = "";
  let replyOriginal = null;
  if (hasReply) {
    const targetKey = peer ? conversationKey(session, { kind: "dm", peerId: peer.userId }) : group ? `group:${group.groupId}` : "general";
    const reply = await replyPrefixFor(session, body.replyToId, targetKey);
    prefix = reply.prefix;
    replyOriginal = reply.original;
  }
  if (urgent) prefix += `${URGENT_LINE}\n`;
  const content = [prefix + applyMentions(widget ? text : neutralizeSyntax(text), mentioned), ...files.lines].filter(Boolean).join("\n");
  if (content.length > 10000) {
    throw httpError(400, "\uBA54\uC2DC\uC9C0\uAC00 \uB108\uBB34 \uAE41\uB2C8\uB2E4.", "long");
  }
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
  urgentSlot.release = null; // sent: the urgent slot is used
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
    edited: false,
    recalled: false,
    replyTo: null,
    mentions: mentioned.map((person) => person.userId),
    mentionedMe: false,
    reactions: [],
    starred: false,
    unreadCount: null,
    poll: null,
    todo: null,
    alerted: false,
    urgent,
  };
  if (urgent) audit(request, session, "urgent_send", message.id);
  // N6: people mentioned here see it in their activity list at once (their event poll also marks it).
  for (const person of mentioned) invalidateActivity(person.userId);
  // N6: a reply to someone else's message is activity for that person.
  if (replyOriginal && replyOriginal.senderId !== session.userId && body.note !== true) {
    await recordActivity(replyOriginal.senderId, {
      id: `reply:${message.id}`, kind: "reply", at: message.timestamp, ...activityPlace(message, session.userId),
      messageId: message.id, actorId: session.userId,
    });
  }
  // A1: nobody has read it yet.
  if (!body.note && (peer || group)) {
    message.unreadCount = peer ? 1 : group.memberIds.filter((id) => id !== session.userId).length;
  }
  // The sender knows sizes and types that Zulip's message text does not carry.
  message.attachments = files.attachments;
  await markRecalledReplies(session, [message]);
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

// ---- C5 polls / todos ----
// { poll: { question, options } } | { todo: { title, items } } | null. Each line one line, as Zulip's
// widget parser reads one option / task per line ("- " / "* " at the start would be eaten, so it is dropped).
function widgetFrom(body) {
  const line = (value, max) => (typeof value === "string"
    ? value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").replace(/^[-*]\s+/, "").trim().slice(0, max)
    : "");
  if (body.poll !== undefined && body.poll !== null) {
    const question = line(body.poll?.question, 200);
    const options = Array.isArray(body.poll?.options) ? body.poll.options.slice(0, 11).map((option) => line(option, 100)).filter(Boolean) : [];
    if (!question || options.length < 2 || options.length > 10) throw httpError(400, "투표는 질문과 항목 2~10개가 필요합니다.", "poll");
    return { poll: { question, options } };
  }
  if (body.todo !== undefined && body.todo !== null) {
    const title = line(body.todo?.title, 200);
    const items = Array.isArray(body.todo?.items) ? body.todo.items.slice(0, 31).map((item) => line(item, 100)).filter(Boolean) : [];
    if (!title || items.length < 1 || items.length > 30) throw httpError(400, "할 일은 제목과 항목 1~30개가 필요합니다.", "todo");
    return { todo: { title, items } };
  }
  return null;
}

// type "poll": toggle my vote on `key`; type "todo": toggle `key` done. Sent as Zulip widget submessages.
async function widgetAction(session, messageId, type, key) {
  const found = await fetchOne(session, messageId);
  if (!found?.message) throw httpError(404, "메시지를 찾지 못했습니다.", "message");
  const { message } = found;
  let content;
  if (type === "poll") {
    if (!message.poll) throw httpError(400, "투표 메시지가 아닙니다.", "poll");
    const option = message.poll.options.find((item) => item.key === key);
    if (!option) throw httpError(400, "투표 항목을 확인하세요.", "poll");
    content = { type: "vote", key, vote: option.voterIds.includes(session.userId) ? -1 : 1 };
  } else {
    if (!message.todo) throw httpError(400, "할 일 메시지가 아닙니다.", "todo");
    if (!message.todo.items.some((item) => item.key === key)) throw httpError(400, "할 일 항목을 확인하세요.", "todo");
    content = { type: "strike", key };
  }
  const result = await zulip("POST", "/api/v1/submessage", {
    auth: basic(session),
    form: { message_id: String(messageId), msg_type: "widget", content: JSON.stringify(content) },
  });
  if (result.json?.result !== "success") throw zulipFailure(result, type === "poll" ? "투표하지 못했습니다." : "할 일을 바꾸지 못했습니다.");
  return { message: (await fetchOne(session, messageId))?.message || message };
}

async function isNoteMessage(session, raw) {
  const notes = await noteRecords(session);
  return notes.some((note) => note.messageId === raw.id) || Boolean(pendingNoteRecord(raw));
}

// A3: mentions are staff ids from the directory (not me); anything else is dropped.
async function mentionedPeople(session, value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 50) throw httpError(400, "멘션할 직원을 확인하세요.", "mentions");
  if (!value.length) return [];
  const { people } = await listDirectory(session);
  const ids = new Set(value.map(Number));
  return people.filter((person) => ids.has(person.userId) && person.userId !== session.userId);
}

async function replyPrefixFor(session, value, targetKey) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw httpError(400, "답장할 메시지를 확인하세요.", "reply");
  const found = await fetchOne(session, id);
  if (!found?.message || (found.message.kind === "dm" && (await isNoteMessage(session, found.raw)))) {
    throw httpError(404, "답장할 메시지를 찾지 못했습니다.", "reply");
  }
  if (conversationKey(session, found.message) !== targetKey) {
    throw httpError(400, "같은 대화방의 메시지에만 답장할 수 있습니다.", "reply");
  }
  return {
    prefix: replyPrefix({
      id: found.message.id,
      senderId: found.message.senderId,
      senderName: found.message.senderName,
      rawContent: found.raw.content,
    }),
    original: found.message,
  };
}

// ---- N7 urgent messages: at most URGENT_PER_HOUR per person per hour (kept in memory) ----
const URGENT_PER_HOUR = 10;
const urgentSent = new Map(); // userId -> [ms]

// Takes one of this hour's slots now (synchronously, so two requests cannot both see a free slot).
// Returns a function that gives it back.
function reserveUrgent(session) {
  const hourAgo = Date.now() - 3600 * 1000;
  const recent = (urgentSent.get(session.userId) || []).filter((at) => at > hourAgo);
  if (recent.length >= URGENT_PER_HOUR) {
    urgentSent.set(session.userId, recent);
    throw httpError(429, "중요 메시지는 1시간에 10번까지 보낼 수 있습니다.", "urgent");
  }
  const mark = { at: Date.now() };
  recent.push(mark.at);
  urgentSent.set(session.userId, recent);
  return () => {
    const list = urgentSent.get(session.userId) || [];
    const index = list.lastIndexOf(mark.at);
    if (index !== -1) list.splice(index, 1);
  };
}

// A4: my own message, within 10 minutes, not yet recalled. Zulip enforces the same limit.
async function editableMessage(session, value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw httpError(404, "메시지를 찾지 못했습니다.", "message");
  const found = await fetchOne(session, id);
  if (!found?.message) throw httpError(404, "메시지를 찾지 못했습니다.", "message");
  if (found.message.senderId !== session.userId) throw httpError(403, "내가 보낸 메시지만 고칠 수 있습니다.", "edit");
  if (found.message.recalled) throw httpError(400, "회수된 메시지입니다.", "edit");
  if (Date.now() / 1000 - found.message.timestamp > EDIT_LIMIT_SECONDS) {
    throw httpError(403, "보낸 지 10분이 지나 수정할 수 없습니다.", "edit");
  }
  return found;
}

async function patchContent(session, id, content) {
  const result = await zulip("PATCH", `/api/v1/messages/${id}`, { auth: basic(session), form: { content } });
  if (result.json?.result === "success") return;
  // Zulip's own limit (clock differences, realm setting) answers 400 with this message.
  if (/time limit|limit for editing|편집.*시간/i.test(String(result.json?.msg || ""))) {
    throw httpError(403, "보낸 지 10분이 지나 수정할 수 없습니다.", "edit");
  }
  throw zulipFailure(result, "메시지를 고치지 못했습니다.");
}

async function editedMessage(session, id) {
  const found = await fetchOne(session, id);
  if (!found?.message) throw httpError(502, "메시지를 다시 읽지 못했습니다.", "message");
  const { message } = found;
  if (message.kind === "dm" || message.kind === "group") {
    const recipients = message.kind === "dm" ? [message.peerId] : await messageRecipients(session, message);
    await fillUnreadCounts(session, [message], recipients);
  }
  await markRecalledReplies(session, [message]);
  return message;
}

// The reply quote and file lines stay; only the text (and its mentions) changes.
async function editMessage(session, messageId, body) {
  const { raw, message } = await editableMessage(session, messageId);
  if (message.poll || message.todo) throw httpError(400, "투표·할 일은 고칠 수 없습니다.", "edit");
  const parts = splitRaw(raw.content);
  let text = typeof body.content === "string" ? body.content.trim() : "";
  if (/^\/(poll|todo)(\s|$)/i.test(text) && !parts.prefix) text = `​${text}`;
  if (!text && !parts.fileLines.length) throw httpError(400, "메시지를 입력하세요.", "empty");
  const mentioned = await mentionedPeople(session, body.mentions);
  const content = [parts.prefix + applyMentions(neutralizeSyntax(text), mentioned), ...parts.fileLines].filter(Boolean).join("\n");
  if (content.length > 10000) throw httpError(400, "메시지가 너무 깁니다.", "long");
  await patchContent(session, raw.id, content);
  return { message: await editedMessage(session, raw.id) };
}

// The text becomes RECALLED_TEXT and the reply quote goes. File lines stay in Zulip so the files
// are not cleaned up as unclaimed (retention policy); normalize() never shows them for a recalled
// message. The original stays in Zulip's edit history (administrators).
async function recallMessage(session, messageId) {
  const { raw, message } = await editableMessage(session, messageId);
  if (message.poll || message.todo) throw httpError(400, "투표·할 일은 회수할 수 없습니다.", "recall");
  const parts = splitRaw(raw.content);
  await patchContent(session, raw.id, [RECALLED_TEXT, ...parts.fileLines].join("\n"));
  // N6: a recalled reply is no longer activity for anyone.
  try {
    for (const owner of await activityStore.removeMessage(raw.id)) invalidateActivity(owner);
  } catch (error) {
    console.error(`[sangsang] 활동 기록을 지우지 못했습니다 (${error.message}).`);
  }
  return { message: await editedMessage(session, raw.id) };
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

async function classifyEvents(session, messages, reset, inFlight = [], updated = []) {
  try {
    const indexed = await noteStore.listForUser(session.userId);
    const known = new Set(indexed.map((note) => note.messageId));
    // In-flight notes look exactly like indexed ones to the browser: listed in `notes`, absent from `messages`.
    const notes = [...indexed, ...inFlight.filter((note) => !known.has(note.messageId))];
    const ids = new Set(notes.map((note) => note.messageId));
    const shown = (message) => message.kind !== "dm" || !ids.has(message.id);
    return {
      messages: messages.filter(shown),
      updated: updated.filter(shown),
      notes,
      notesError: false,
      reset,
    };
  } catch (error) {
    if (error.code !== "NOTES_STORE") throw error;
    return {
      messages: messages.filter((message) => message.kind !== "dm"),
      updated: updated.filter((message) => message.kind !== "dm"),
      notes: [],
      notesError: true,
      error: NOTES_ERROR,
      reset,
    };
  }
}

// ---- Local changes that are not Zulip events (A5 notices) wake the session's waiting poll. ----
function noticeConcerns(session, key) {
  if (key === "general") return true;
  if (key.startsWith("dm:")) return key.slice(3).split("-").map(Number).includes(session.userId);
  if (key.startsWith("group:")) return !session.groupIds || session.groupIds.has(Number(key.slice(6)));
  return false;
}

// setBy: who set it (N6: a notice set by someone else is new activity for everyone else in the room).
function announceNotice(key, setBy = null) {
  for (const session of sessions.values()) {
    if (!noticeConcerns(session, key)) continue;
    session.noticesChanged = true;
    if (setBy && setBy !== session.userId) markActivityChanged(session.userId);
    session.wake?.();
  }
}

// N8: a changed ack count matters only to those who may see the list (the setter, administrators).
// Several acks within ACK_ANNOUNCE_MS are told once.
const ACK_ANNOUNCE_MS = 3000;
const pendingAckAnnounce = new Map(); // key -> timer
function announceAckChange(key, setBy) {
  if (pendingAckAnnounce.has(key)) return;
  const timer = setTimeout(() => {
    pendingAckAnnounce.delete(key);
    for (const session of sessions.values()) {
      if (!noticeConcerns(session, key) || (session.userId !== setBy && !isAdminRole(session.role))) continue;
      session.noticesChanged = true;
      session.wake?.();
    }
  }, ACK_ANNOUNCE_MS);
  timer.unref?.();
  pendingAckAnnounce.set(key, timer);
}

const LOCAL_FLAGS = ["noticesChanged", "activityReady", "prefsChanged", "policyChanged"];
function hasLocal(session) {
  return LOCAL_FLAGS.some((flag) => session[flag]);
}

// Reads and clears the local flags for one events answer. Never waits for Zulip: activity counts are
// worked out in the background (markActivityChanged) and put on session.activityReady when ready.
async function takeLocal(session) {
  const out = {
    noticesChanged: Boolean(session.noticesChanged),
    prefsChanged: Boolean(session.prefsChanged),
    policyChanged: Boolean(session.policyChanged),
    activity: session.activityReady || null,
  };
  for (const flag of LOCAL_FLAGS) session[flag] = false;
  session.activityReady = null;
  return out;
}

// ---- N6 activity centre ----
// mention / keyword: Zulip search (is:mentioned, is:alerted); reply / reaction: activity.json;
// notice: notices.json. Last ACTIVITY_DAYS days, at most ACTIVITY_PER_KIND per kind, newest first.
const ACTIVITY_KINDS = ["mention", "reply", "reaction", "notice", "keyword"];
const ACTIVITY_PAGE = 50;

// Where the activity is, as the owner sees it. In a 1:1 the room is the one with the actor.
function activityPlace(message, actorId) {
  if (message.kind === "group") return { view: "group", groupId: message.groupId };
  if (message.kind === "dm") return { view: "dm", userId: actorId };
  return { view: "general" };
}

// Stores one reply / reaction item for its owner and wakes the owner's sessions when it is new.
// A failed write is logged; the send / reaction itself already happened.
// The same item (e.g. a reaction pressed, taken back and pressed again) is announced at most once a minute.
const ACTIVITY_REANNOUNCE_MS = 60 * 1000;
const activityAnnounced = new Map(); // "<ownerId>:<itemId>" -> ms
async function recordActivity(ownerId, item) {
  try {
    if (!(await activityStore.add(ownerId, item))) return;
    const key = `${ownerId}:${item.id}`;
    const now = Date.now();
    for (const [old, at] of activityAnnounced) if (now - at > ACTIVITY_REANNOUNCE_MS) activityAnnounced.delete(old);
    if (activityAnnounced.has(key)) {
      invalidateActivity(ownerId); // the list changed, but the badge is not rung again
      return;
    }
    activityAnnounced.set(key, now);
    markActivityChanged(ownerId);
  } catch (error) {
    if (error.code !== "JSON_STORE") throw error;
    console.error(`[sangsang] 활동 기록을 남기지 못했습니다 (${error.message}).`);
  }
}

function activityExcerpt(message) {
  if (message.recalled) return RECALLED_TEXT;
  if (message.poll) return `[투표] ${message.poll.question}`.slice(0, 80);
  if (message.todo) return `[할 일] ${message.todo.title}`.slice(0, 80);
  const text = String(message.content || "").replace(/\s+/g, " ").trim();
  if (text) return text.length > 80 ? `${text.slice(0, 80)}…` : text;
  return message.attachments?.[0] ? `[파일] ${message.attachments[0].name}`.slice(0, 80) : "";
}

// Messages for a narrow, newest first (at most `count`), normalized for this user. Notes are left out.
async function searchNarrow(session, narrow, count, noteIds) {
  const result = await zulip("GET", `/api/v1/messages?${new URLSearchParams({
    anchor: "newest", num_before: String(count), num_after: "0", apply_markdown: "false", narrow: JSON.stringify(narrow),
  })}`, { auth: basic(session) });
  if (result.json?.result !== "success") throw zulipFailure(result, "알림을 읽지 못했습니다.");
  return (result.json.messages || [])
    .map((raw) => normalize(raw, session))
    .filter((message) => message && !(message.kind === "dm" && noteIds.has(message.id)));
}

// Messages by id (Zulip 10+ message_ids), normalized; ids I cannot see are missing from the map.
async function messagesById(session, ids) {
  const out = new Map();
  const unique = [...new Set(ids)];
  for (let start = 0; start < unique.length; start += 400) {
    const chunk = unique.slice(start, start + 400);
    const result = await zulip("GET", `/api/v1/messages?${new URLSearchParams({
      message_ids: JSON.stringify(chunk), apply_markdown: "false",
    })}`, { auth: basic(session) });
    if (result.json?.result !== "success") throw zulipFailure(result, "알림을 읽지 못했습니다.");
    for (const raw of result.json.messages || []) {
      const message = normalize(raw, session);
      if (message) out.set(message.id, message);
    }
  }
  return out;
}

async function activityList(session) {
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = nowSec - 30 * 86400;
  const stored = await activityStore.get(session.userId);
  const names = new Map((await fetchMembers(session)).map((user) => [user.user_id, user.full_name || user.email]));
  const noteIds = new Set((await noteRecords(session)).map((note) => note.messageId)); // read once
  const items = [];
  const push = (kind, id, at, message, actorId, extra = {}) => {
    if (!message || at < cutoff) return;
    items.push({
      id, kind, at, ...activityPlace(message, actorId), messageId: message.id,
      actorId, actorName: names.get(actorId) || "알 수 없음", excerpt: activityExcerpt(message), ...extra, seen: at <= stored.seenAt || stored.seenIds.has(id),
    });
  };
  const mentioned = (await searchNarrow(session, [{ operator: "is", operand: "mentioned" }], 200, noteIds))
    .filter((message) => message.senderId !== session.userId);
  const mentionIds = new Set(mentioned.map((message) => message.id));
  for (const message of mentioned) push("mention", `mention:${message.id}`, message.timestamp, message, message.senderId);
  for (const message of await searchNarrow(session, [{ operator: "is", operand: "alerted" }], 200, noteIds)) {
    if (message.senderId === session.userId || mentionIds.has(message.id)) continue;
    push("keyword", `keyword:${message.id}`, message.timestamp, message, message.senderId);
  }
  // Notice activity is the record of notices set (activity.json), kept after a notice is replaced or removed.
  // current: it is still the room's notice (notices.json); an unreadable notices.json just leaves it false.
  let currentNotices = {};
  try {
    currentNotices = await noticeStore.all();
  } catch (error) {
    if (error.code !== "JSON_STORE") throw error;
    console.error(`[sangsang] 공지 파일을 읽지 못했습니다 (${error.message}). 알림 센터의 current를 false로 둡니다.`);
  }
  const noticeEntries = (await activityStore.notices())
    .filter((notice) => notice.setBy !== session.userId && notice.setAt >= cutoff && noticeConcerns(session, notice.key));
  const byId = await messagesById(session, [...stored.items.map((item) => item.messageId), ...noticeEntries.map((notice) => notice.messageId)]);
  for (const item of stored.items) {
    push(item.kind, item.id, item.at, byId.get(item.messageId), item.actorId, item.emoji ? { emoji: item.emoji } : {});
  }
  for (const notice of noticeEntries) {
    const { key } = notice;
    const message = byId.get(notice.messageId);
    if (!message || conversationKey(session, message) !== key) continue;
    const now = currentNotices[key];
    const current = Boolean(now && now.messageId === notice.messageId && now.setAt === notice.setAt);
    push("notice", `notice:${key.replace(/[^0-9a-z:]/g, "_")}:${message.id}`, notice.setAt, message, notice.setBy, { ackRequired: notice.ackRequired, current });
  }
  items.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
  return { items, ...unseenCounts(items), seenAt: stored.seenAt };
}

// { unseen, unseenByKind: { mention, reply, reaction, notice, keyword } }
function unseenCounts(items) {
  const unseenByKind = Object.fromEntries(ACTIVITY_KINDS.map((kind) => [kind, 0]));
  for (const item of items) if (!item.seen) unseenByKind[item.kind] += 1;
  return { unseen: items.filter((item) => !item.seen).length, unseenByKind };
}

// ---- Activity cache: one list per user, reused for ACTIVITY_CACHE_MS, one computation at a time per
// user (callers share it), at most ACTIVITY_CONCURRENCY users computed at once (an @all mention or an
// all-staff notice marks everyone). New items are counted ACTIVITY_DEBOUNCE_MS after the first change.
const ACTIVITY_CACHE_MS = 5000;
const ACTIVITY_DEBOUNCE_MS = 1500;
const ACTIVITY_CONCURRENCY = 4;
const activityCache = new Map(); // userId -> { list, at, stale, running, timer }
let activityRunning = 0;
const activityWaiters = [];

function activityEntry(userId) {
  if (!activityCache.has(userId)) activityCache.set(userId, { list: null, at: 0, stale: true, running: null, timer: null });
  return activityCache.get(userId);
}

async function activitySlot() {
  if (activityRunning < ACTIVITY_CONCURRENCY) {
    activityRunning += 1;
    return;
  }
  await new Promise((resolve) => activityWaiters.push(resolve)); // the slot is handed over as is
}

function activityRelease() {
  const next = activityWaiters.shift();
  if (next) next();
  else activityRunning -= 1;
}

function invalidateActivity(userId) {
  activityEntry(userId).stale = true;
}

function computeActivity(session) {
  const entry = activityEntry(session.userId);
  if (!entry.running) {
    entry.running = (async () => {
      await activitySlot();
      try {
        entry.stale = false;
        const list = await activityList(session);
        entry.list = list;
        entry.at = Date.now();
        return list;
      } finally {
        activityRelease();
        entry.running = null;
      }
    })();
  }
  return entry.running;
}

// The user's list: cached when fresh, otherwise computed (shared with any computation in progress).
async function cachedActivity(session) {
  const entry = activityEntry(session.userId);
  if (entry.list && !entry.stale && Date.now() - entry.at < ACTIVITY_CACHE_MS) return entry.list;
  const list = await computeActivity(session);
  // Changed while it was being computed: once more.
  return entry.stale ? computeActivity(session) : list;
}

// New activity for userId: recount in the background, then put the counts on each of the user's sessions.
function markActivityChanged(userId) {
  const entry = activityEntry(userId);
  entry.stale = true;
  if (entry.timer) return;
  entry.timer = setTimeout(async () => {
    entry.timer = null;
    const session = [...sessions.values()].find((one) => one.userId === userId && one.expiresAt > Date.now());
    if (!session) return;
    try {
      const counts = unseenCounts((await cachedActivity(session)).items);
      for (const one of sessions.values()) {
        if (one.userId !== userId) continue;
        one.activityReady = counts;
        one.wake?.();
      }
    } catch (error) {
      console.error(`[sangsang] 알림 센터 숫자를 세지 못했습니다 (${error.code || error.status || error.message}).`);
    }
  }, ACTIVITY_DEBOUNCE_MS);
  entry.timer.unref?.();
}

// After a seen change: mark the cached items so the answer needs no recount.
// The list is also marked stale: a recount already running read the old seen state and must not be reused.
function seenInCache(userId, isSeen) {
  const entry = activityEntry(userId);
  entry.stale = true;
  if (!entry.list) return null;
  for (const item of entry.list.items) if (!item.seen && isSeen(item)) item.seen = true;
  return unseenCounts(entry.list.items);
}

async function handleActivity(session, params) {
  const kind = params.get("kind") || "all";
  if (kind !== "all" && !ACTIVITY_KINDS.includes(kind)) throw httpError(400, "알림 종류를 확인하세요.", "activity");
  const { items, unseen, unseenByKind } = await cachedActivity(session);
  let list = kind === "all" ? items : items.filter((item) => item.kind === kind);
  const before = params.get("before");
  if (before) {
    const index = list.findIndex((item) => item.id === before);
    if (index === -1) throw httpError(400, "불러올 위치가 올바르지 않습니다.", "activity");
    list = list.slice(index + 1);
  }
  return { items: list.slice(0, ACTIVITY_PAGE), hasOlder: list.length > ACTIVITY_PAGE, unseen, unseenByKind };
}

// { upTo: "<id>" | "all" } (that item and everything older) or { ids: [...] } (only those, at most 50).
async function markActivitySeen(session, body) {
  if (body.ids !== undefined) {
    if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 50 || !body.ids.every((id) => typeof id === "string" && ACTIVITY_ID.test(id))) {
      throw httpError(400, "확인할 알림을 확인하세요.", "activity");
    }
    // Only the format is checked: an id that is not (or no longer) in the list changes nothing.
    const ids = [...new Set(body.ids)];
    await activityStore.seenIds(session.userId, ids);
    return seenInCache(session.userId, (item) => ids.includes(item.id)) || unseenCounts((await cachedActivity(session)).items);
  }
  let at;
  if (body.upTo === "all") at = Math.floor(Date.now() / 1000);
  else {
    const found = typeof body.upTo === "string" ? (await cachedActivity(session)).items.find((item) => item.id === body.upTo) : null;
    if (!found) throw httpError(400, "확인할 알림을 찾지 못했습니다.", "activity");
    at = found.at;
  }
  await activityStore.seen(session.userId, at);
  return seenInCache(session.userId, (item) => item.at <= at) || unseenCounts((await cachedActivity(session)).items);
}

// Messages changed by update_message / reaction / submessage events, as this user sees them now.
async function updatedMessages(session, events) {
  const ids = [];
  const add = (id) => {
    if (Number.isSafeInteger(id) && !ids.includes(id)) ids.push(id);
  };
  for (const event of events) {
    if (event.type === "update_message" || event.type === "reaction" || event.type === "submessage") add(event.message_id);
    // B4: my own star changes (from this or another of my sessions). Read flags are not sent.
    if (event.type === "update_message_flags" && event.flag === "starred" && Array.isArray(event.messages)) event.messages.forEach(add);
  }
  const updated = [];
  for (const id of ids.slice(-30)) {
    try {
      const found = await fetchOne(session, id);
      if (found?.message) updated.push(found.message);
    } catch (error) {
      // 401 ends the session; 429 fails the whole answer, so lastEventId stays and nothing is lost.
      if (error.status === 401 || error.status === 429) throw error;
    }
  }
  return updated;
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
  // The Zulip long poll ends early when the browser goes away or a local change arrives.
  // Registered before the flag check so a change in between is not missed.
  const wake = new AbortController();
  const onClientGone = () => wake.abort();
  signal.addEventListener("abort", onClientGone, { once: true });
  const wakeThis = () => wake.abort();
  session.wake = wakeThis;
  if (hasLocal(session)) wake.abort();
  let result;
  try {
    result = await zulip("GET", `/api/v1/events?${query}`, {
      auth: basic(session),
      timeoutMs: 55000,
      signal: wake.signal,
    });
  } catch (error) {
    if (error.aborted && !signal.aborted) {
      return { ...(await classifyEvents(session, [], false)), typing: [], groupsChanged: false, ...(await takeLocal(session)) };
    }
    if (error.timeout) return { ...(await classifyEvents(session, [], false)), typing: [], groupsChanged: false, ...(await takeLocal(session)) };
    throw error;
  } finally {
    signal.removeEventListener("abort", onClientGone);
    if (session.wake === wakeThis) session.wake = null;
  }
  if (result.json?.code === "BAD_EVENT_QUEUE_ID") {
    await enqueue(session, async () => {
      if (session.queueId === queueId) {
        session.queueId = null;
        session.lastEventId = -1;
      }
    });
    // Events may have been missed while the queue was gone, so groups (and notices) are stale too.
    const local = await takeLocal(session);
    return {
      ...(await classifyEvents(session, [], true)), typing: [], groupsChanged: true, noticesChanged: true,
      prefsChanged: true, policyChanged: true, activity: local.activity,
    };
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
  const typing = [];
  for (const event of events) {
    if (Number.isInteger(event.id) && event.id > maxId) maxId = event.id;
    if (event.type === "user_status" && Number.isInteger(event.user_id)) mergeUserStatus(event.user_id, event);
    if (event.type === "typing") {
      const entry = await typingEntry(session, event);
      if (entry) typing.push(entry);
    }
    if (event.type === "message" && event.message) {
      // New-message events carry the flags next to the message, not inside it.
      const normalized = normalize(event.message, session, event.flags);
      if (normalized) messages.push(normalized);
      // N6: a mention or keyword from someone else is new activity.
      if (normalized && normalized.senderId !== session.userId && (normalized.mentionedMe || normalized.alerted)) markActivityChanged(session.userId);
      const pending = normalized?.kind === "dm" ? pendingNoteRecord(event.message) : null;
      if (pending) inFlight.push(pending);
    }
  }
  // A message that arrived and changed in the same batch is sent once, already changed, in `messages`.
  const updated = [];
  for (const message of await updatedMessages(session, events)) {
    const index = messages.findIndex((item) => item.id === message.id);
    if (index === -1) updated.push(message);
    else messages[index] = message;
  }
  await enqueue(session, async () => {
    if (session.queueId === queueId && maxId > session.lastEventId) session.lastEventId = maxId;
  });
  for (const message of updated) if (message.recalled) rememberRecalled(message.id, true);
  await markRecalledReplies(session, [...messages, ...updated]);
  return { ...(await classifyEvents(session, messages, false, inFlight, updated)), typing, groupsChanged, ...(await takeLocal(session)) };
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
    // A6: department rooms are kept in step by the administrator's dept-sync only.
    dept: String(sub.description || "").startsWith(DEPT_MARK),
  };
}

function refuseDept(group) {
  if (group.dept) throw httpError(403, "부서 대화방은 이름을 바꾸거나 초대·나가기를 할 수 없습니다.", "dept");
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
  refuseDept(group);
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
  refuseDept(group);
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
  refuseDept(group);
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

// ---- A2 search (Zulip "search" narrow; Korean partial matches need PGroonga, compose.yaml) ----
// Newest first, SEARCH_PAGE at a time; notes, recalled messages and rooms outside this app are left out.
async function handleSearch(session, params) {
  const q = String(params.get("q") || "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  if (!q) throw httpError(400, "검색어를 입력하세요.", "search");
  if (q.length > 100) throw httpError(400, "검색어가 너무 깁니다.", "search");
  const { before } = parseAnchor(new URLSearchParams(params.get("before") ? { before: params.get("before") } : {}));
  const scope = params.get("view") || "all";
  const narrow = [{ operator: "search", operand: q }];
  if (scope === "general") {
    narrow.push({ operator: "channel", operand: CHANNEL });
  } else if (scope === "dm") {
    const userId = params.get("userId");
    if (userId) narrow.push({ operator: "dm", operand: [(await personById(session, userId)).userId] });
    else narrow.push({ operator: "is", operand: "dm" });
  } else if (scope === "group") {
    narrow.push({ operator: "channel", operand: (await groupById(session, params.get("groupId"))).groupId });
  } else if (scope !== "all") {
    throw httpError(400, "검색 범위를 확인하세요.", "search");
  }
  // normalize() needs my group list to keep group-room messages.
  if (!session.groupIds) await listGroups(session);
  const noteIds = scope === "all" || scope === "dm" ? new Set((await noteRecords(session)).map((note) => note.messageId)) : new Set();
  const found = [];
  let from = before ? String(before) : "newest";
  let hasOlder = false;
  for (let round = 0; round < 10 && found.length < SEARCH_PAGE; round += 1) {
    const data = await fetchZulipMessages(session, narrow, { anchor: from, numBefore: SEARCH_PAGE, numAfter: 0 });
    const raw = data.messages;
    hasOlder = data.found_oldest === false && raw.length > 0;
    for (const item of raw) {
      const message = normalize(item, session);
      if (!message || message.recalled) continue;
      if (message.kind === "dm" && (noteIds.has(message.id) || pendingNoteRecord(item))) continue;
      if (scope === "dm" && message.kind !== "dm") continue;
      found.push(message);
    }
    if (!hasOlder) break;
    from = String(Math.min(...raw.map((item) => item.id)));
  }
  found.sort((a, b) => b.id - a.id);
  const page = found.slice(0, SEARCH_PAGE);
  await markRecalledReplies(session, page);
  return { messages: page, hasOlder: hasOlder || found.length > SEARCH_PAGE };
}

// ---- 2-B ----
// B2: everyone's manual status, shared by all sessions (statuses are visible to the whole organization).
// Filled when any session registers its event queue and kept current by user_status events.
const userStatuses = new Map(); // userId -> { code, text }
let statusesLoaded = false;

function statusFromZulip(status) {
  const text = typeof status?.status_text === "string" ? status.status_text : "";
  const code = STATUS_BY_EMOJI.get(String(status?.emoji_name || "")) || "";
  return { code, text };
}

function setUserStatus(userId, status) {
  const value = statusFromZulip(status);
  if (value.code || value.text) userStatuses.set(userId, value);
  else userStatuses.delete(userId);
}

// A user_status event carries only the fields that changed.
function mergeUserStatus(userId, event) {
  const old = userStatuses.get(userId) || { code: "", text: "" };
  const emojiName = "emoji_name" in event ? event.emoji_name : STATUS_EMOJI[old.code] || "";
  const statusText = "status_text" in event ? event.status_text : old.text;
  setUserStatus(userId, { status_text: statusText, emoji_name: emojiName });
}

async function setMyStatus(session, body) {
  const code = typeof body.code === "string" ? body.code : "";
  const text = typeof body.text === "string" ? body.text.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim() : "";
  if (code && !STATUS_EMOJI[code]) throw httpError(400, "상태를 확인하세요.", "status");
  if (text.length > STATUS_TEXT_MAX) throw httpError(400, `상태 문구는 ${STATUS_TEXT_MAX}자까지 쓸 수 있습니다.`, "status");
  const result = await zulip("POST", "/api/v1/users/me/status", {
    auth: basic(session),
    form: { status_text: text, emoji_name: code ? STATUS_EMOJI[code] : "" },
  });
  if (result.json?.result !== "success") throw zulipFailure(result, "상태를 바꾸지 못했습니다.");
  setUserStatus(session.userId, { status_text: text, emoji_name: code ? STATUS_EMOJI[code] : "" });
  return { status: userStatuses.get(session.userId) || { code: "", text: "" } };
}

// B6: the general channel's id (typing in a channel is addressed by id).
let generalStreamId = null;
async function generalId(session) {
  if (generalStreamId) return generalStreamId;
  const result = await zulip("GET", `/api/v1/get_stream_id?${new URLSearchParams({ stream: CHANNEL })}`, { auth: basic(session) });
  if (result.json?.result !== "success" || !Number.isInteger(result.json.stream_id)) throw zulipFailure(result, "대화방을 찾지 못했습니다.");
  generalStreamId = result.json.stream_id;
  return generalStreamId;
}

async function sendTyping(session, body) {
  if (body.op !== "start" && body.op !== "stop") throw httpError(400, "입력 상태를 확인하세요.", "typing");
  let form;
  if (body.view === "dm") {
    const peer = await personById(session, body.userId);
    form = { type: "direct", to: JSON.stringify([peer.userId]) };
  } else if (body.view === "group") {
    const group = await groupById(session, body.groupId);
    form = { type: "stream", stream_id: String(group.groupId), topic: TOPIC };
  } else if (body.view === "general") {
    form = { type: "stream", stream_id: String(await generalId(session)), topic: TOPIC };
  } else {
    throw httpError(400, "대화방을 확인하세요.", "view");
  }
  const result = await zulip("POST", "/api/v1/typing", { auth: basic(session), form: { ...form, op: body.op } });
  if (result.json?.result !== "success") throw zulipFailure(result, "입력 상태를 보내지 못했습니다.");
  return { ok: true };
}

// Zulip typing event -> { view, userId, groupId, senderId, op }, or null for rooms outside the app / my own.
async function typingEntry(session, event) {
  const senderId = event.sender?.user_id;
  if (!Number.isInteger(senderId) || senderId === session.userId) return null;
  const op = event.op === "stop" ? "stop" : "start";
  if (event.message_type === "direct" || event.message_type === "private") {
    const ids = Array.isArray(event.recipients) ? event.recipients.map((person) => person.user_id) : [];
    if (ids.length !== 2 || !ids.includes(session.userId)) return null;
    return { view: "dm", userId: senderId, groupId: null, senderId, op };
  }
  if (event.message_type === "stream" && Number.isInteger(event.stream_id)) {
    if (session.groupIds?.has(event.stream_id)) return { view: "group", userId: null, groupId: event.stream_id, senderId, op };
    try {
      if (event.stream_id === (await generalId(session))) return { view: "general", userId: null, groupId: null, senderId, op };
    } catch (error) {
      if (error.status === 401) throw error;
    }
  }
  return null;
}

// B1
async function changeReaction(session, messageId, method, emoji) {
  if (!REACTIONS[emoji]) throw httpError(400, "쓸 수 없는 반응입니다.", "reaction");
  const found = await fetchOne(session, messageId);
  if (!found?.message) throw httpError(404, "메시지를 찾지 못했습니다.", "message");
  if (found.message.recalled) throw httpError(400, "회수된 메시지입니다.", "reaction");
  const form = { emoji_name: emoji, emoji_code: REACTIONS[emoji], reaction_type: "unicode_emoji" };
  const result = method === "POST"
    ? await zulip("POST", `/api/v1/messages/${messageId}/reactions`, { auth: basic(session), form })
    : await zulip("DELETE", `/api/v1/messages/${messageId}/reactions?${new URLSearchParams(form)}`, { auth: basic(session) });
  // Adding twice / removing what is not there is not an error for the browser (double clicks).
  if (result.json?.result !== "success" && !/already exists|doesn't exist|does not exist/i.test(String(result.json?.msg || ""))) {
    throw zulipFailure(result, "반응을 바꾸지 못했습니다.");
  }
  // N6: my reaction on someone else's message is activity for its author; taking it back removes it.
  const owner = found.message.senderId;
  if (owner !== session.userId) {
    const id = `reaction:${messageId}:${session.userId}:${emoji}`;
    if (method === "POST") {
      await recordActivity(owner, {
        id, kind: "reaction", at: Math.floor(Date.now() / 1000), ...activityPlace(found.message, session.userId),
        messageId: Number(messageId), actorId: session.userId, emoji,
      });
    } else {
      try {
        if (await activityStore.remove(owner, id)) invalidateActivity(owner);
      } catch (error) {
        if (error.code !== "JSON_STORE") throw error;
        console.error(`[sangsang] 활동 기록을 지우지 못했습니다 (${error.message}).`);
      }
    }
  }
  return { message: (await fetchOne(session, messageId))?.message || found.message };
}

// B4 stars (Zulip "starred" flag, per user)
async function changeStar(session, messageId, method) {
  const found = await fetchOne(session, messageId);
  if (!found?.message) throw httpError(404, "메시지를 찾지 못했습니다.", "message");
  const result = await zulip("POST", "/api/v1/messages/flags", {
    auth: basic(session),
    form: { messages: JSON.stringify([messageId]), op: method === "POST" ? "add" : "remove", flag: "starred" },
  });
  if (result.json?.result !== "success") throw zulipFailure(result, "별표를 바꾸지 못했습니다.");
  return { message: (await fetchOne(session, messageId))?.message || found.message };
}

async function listStarred(session, params) {
  const { before } = parseAnchor(new URLSearchParams(params.get("before") ? { before: params.get("before") } : {}));
  if (!session.groupIds) await listGroups(session);
  const noteIds = new Set((await noteRecords(session)).map((note) => note.messageId));
  const data = await fetchZulipMessages(session, [{ operator: "is", operand: "starred" }], {
    anchor: before ? String(before) : "newest", numBefore: STARRED_PAGE, numAfter: 0,
  });
  const messages = data.messages
    .map((item) => normalize(item, session))
    .filter((message) => message && !(message.kind === "dm" && noteIds.has(message.id)))
    .sort((a, b) => b.id - a.id);
  await markRecalledReplies(session, messages);
  return { messages, hasOlder: data.found_oldest === false && data.messages.length > 0 };
}

// B4·B5 prefs
// P3: rules in lib/settings.mjs. Only the fields sent change; every session of this user gets prefsChanged.
async function readPrefs(session) {
  return presentPrefs(await prefsStore.get(session.userId), { policy: currentPolicy() });
}

async function patchPrefs(session, body) {
  const result = await prefsStore.apply(session.userId, (current) => applyPrefsPatch(current, body, {
    adminLockMinutes: config.autoLockMinutes,
    policy: currentPolicy(),
  }));
  if (!result.changed) throw httpError(result.status || 400, result.error || "설정 값을 확인하세요.", "prefs");
  announceUser(session.userId, "prefsChanged");
  return presentPrefs(result.prefs, { policy: currentPolicy() });
}

// ---- N4 keywords = Zulip alert words ----
async function listKeywords(session) {
  const result = await zulip("GET", "/api/v1/users/me/alert_words", { auth: basic(session) });
  if (result.json?.result !== "success" || !Array.isArray(result.json.alert_words)) throw zulipFailure(result, "키워드를 읽지 못했습니다.");
  return result.json.alert_words;
}

async function changeKeyword(session, method, value) {
  const word = cleanKeyword(value);
  if (!word) throw httpError(400, KEYWORD_ERRORS.invalid, "keyword");
  const current = await listKeywords(session);
  const existing = current.find((one) => one.toLowerCase() === word.toLowerCase());
  if (method === "POST" && existing) return { keywords: current };
  if (method === "DELETE" && !existing) return { keywords: current };
  if (method === "POST" && current.length >= KEYWORD_MAX) throw httpError(400, KEYWORD_ERRORS.full, "keyword");
  const form = { alert_words: JSON.stringify([method === "POST" ? word : existing]) };
  const result = method === "POST"
    ? await zulip("POST", "/api/v1/users/me/alert_words", { auth: basic(session), form })
    : await zulip("DELETE", `/api/v1/users/me/alert_words?${new URLSearchParams(form)}`, { auth: basic(session) });
  if (result.json?.result !== "success" || !Array.isArray(result.json.alert_words)) throw zulipFailure(result, "키워드를 바꾸지 못했습니다.");
  return { keywords: result.json.alert_words };
}

// ---- P4 privacy = Zulip personal settings ----
const PRIVACY_FIELDS = {
  readReceipts: ["send_read_receipts"],
  presence: ["presence_enabled"],
  typing: ["send_private_typing_notifications", "send_stream_typing_notifications"],
};

async function readPrivacy(session) {
  const result = await zulip("POST", "/api/v1/register", {
    auth: basic(session),
    form: { fetch_event_types: JSON.stringify(["user_settings"]), event_types: JSON.stringify(["user_settings"]) },
  });
  const settings = result.json?.user_settings;
  if (result.json?.result !== "success" || !settings) throw zulipFailure(result, "공개 설정을 읽지 못했습니다.");
  if (result.json.queue_id) {
    zulip("DELETE", `/api/v1/events?${new URLSearchParams({ queue_id: result.json.queue_id })}`, { auth: basic(session), timeoutMs: 5000 }).catch(() => {});
  }
  return {
    readReceipts: settings.send_read_receipts !== false,
    presence: settings.presence_enabled !== false,
    typing: settings.send_private_typing_notifications !== false && settings.send_stream_typing_notifications !== false,
  };
}

async function patchPrivacy(session, body) {
  const keys = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : [];
  if (!keys.length || !keys.every((key) => Object.hasOwn(PRIVACY_FIELDS, key) && typeof body[key] === "boolean")) {
    throw httpError(400, "공개 설정 값을 확인하세요.", "privacy");
  }
  const form = {};
  for (const key of keys) for (const field of PRIVACY_FIELDS[key]) form[field] = JSON.stringify(body[key]);
  const result = await zulip("PATCH", "/api/v1/settings", { auth: basic(session), form });
  if (result.json?.result !== "success") throw zulipFailure(result, "공개 설정을 바꾸지 못했습니다.");
  return readPrivacy(session);
}

// ---- P4 my sessions. The id is a short hash of the session key, never the key itself. ----
function sessionHash(sid) {
  return createHash("sha256").update(sid).digest("hex").slice(0, 12);
}

function mySessions(request, session) {
  const currentSid = cookieValue(request, "sangsang_sid");
  const list = [];
  for (const [sid, other] of sessions) {
    if (other.userId !== session.userId || other.expiresAt <= Date.now()) continue;
    list.push({
      id: sessionHash(sid),
      current: sid === currentSid,
      client: other.client === "desktop" ? "desktop" : "browser",
      createdAt: other.createdAt ? new Date(other.createdAt).toISOString() : null,
      lastSeenAt: other.lastSeenAt ? new Date(other.lastSeenAt).toISOString() : null,
      ip: other.ip || "",
    });
  }
  list.sort((a, b) => Number(b.current) - Number(a.current) || String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));
  return { sessions: list };
}

function revokeMySessions(request, session, { id = null, others = false }) {
  const currentSid = cookieValue(request, "sangsang_sid");
  const targets = [];
  for (const [sid, other] of sessions) {
    if (other.userId !== session.userId) continue;
    if (others ? sid !== currentSid : sessionHash(sid) === id) targets.push([sid, other]);
  }
  if (!others) {
    if (!targets.length) throw httpError(404, "로그인 기록을 찾지 못했습니다.", "session");
    if (targets[0][0] === currentSid) throw httpError(400, "지금 쓰는 로그인은 로그아웃 버튼으로 끝내세요.", "session");
  }
  for (const [sid, other] of targets) closeSession(sid, other);
  audit(request, session, "session_revoke", others ? `others:${targets.length}` : id);
  return { ended: targets.length };
}

// ---- P1 my photo = Zulip /users/me/avatar (no API changes anyone else's photo). ----
const AVATAR_BODY_MAX = AVATAR_MAX_BYTES + 64 * 1024; // the file plus multipart headers

function readAvatarBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > AVATAR_BODY_MAX) over = true; // keep reading (discarded) so the 413 reaches the browser
      else chunks.push(chunk);
      if (size > AVATAR_BODY_MAX + 1024 * 1024) request.destroy();
    });
    request.on("end", () => (over ? reject(httpError(413, AVATAR_ERRORS.size, "avatar")) : resolve(Buffer.concat(chunks))));
    request.on("error", reject);
    request.on("close", () => over && reject(httpError(413, AVATAR_ERRORS.size, "avatar")));
  });
}

function avatarFailure(result, fallback) {
  const message = String(result.json?.msg || "");
  if (/disabled/i.test(message)) return httpError(403, AVATAR_ERRORS.disabled, "avatar");
  if (/larger than/i.test(message)) return httpError(413, AVATAR_ERRORS.size, "avatar");
  if (/decode|image|Unsupported/i.test(message)) return httpError(415, AVATAR_ERRORS.type, "avatar");
  return zulipFailure(result, fallback);
}

async function changeMyAvatar(request, session, method) {
  let result;
  if (method === "DELETE") {
    result = await zulip("DELETE", "/api/v1/users/me/avatar", { auth: basic(session) });
  } else {
    if (Number(request.headers["content-length"]) > AVATAR_BODY_MAX) {
      request.resume();
      throw httpError(413, AVATAR_ERRORS.size, "avatar");
    }
    const file = singleFilePart(await readAvatarBody(request), request.headers["content-type"]);
    if (!file) throw httpError(400, AVATAR_ERRORS.missing, "avatar");
    if (file.length > AVATAR_MAX_BYTES) throw httpError(413, AVATAR_ERRORS.size, "avatar");
    const type = imageType(file);
    if (!type) throw httpError(415, AVATAR_ERRORS.type, "avatar");
    const raw = multipartBody("file", type === "image/png" ? "avatar.png" : "avatar.jpg", type, file);
    result = await zulip("POST", "/api/v1/users/me/avatar", { auth: basic(session), raw, timeoutMs: 60000 });
  }
  if (result.json?.result !== "success") {
    audit(request, session, "avatar_change", method === "DELETE" ? "delete" : "upload", false);
    throw avatarFailure(result, "사진을 바꾸지 못했습니다.");
  }
  const avatarUrl = avatarUrlFor(session.userId, result.json.avatar_url);
  for (const other of sessions.values()) if (other.userId === session.userId) other.avatarUrl = avatarUrl;
  audit(request, session, "avatar_change", method === "DELETE" ? "delete" : "upload");
  return { avatarUrl };
}

// ---- D1 admin policy ----
async function patchPolicy(request, session, body) {
  const result = await policyStore.apply((current) => applyPolicyPatch(current, body));
  if (!result.changed) {
    audit(request, session, "admin_policy", "", false);
    throw httpError(result.status || 400, result.error || "정책 값을 확인하세요.", "policy");
  }
  audit(request, session, "admin_policy", `preview:${result.policy.forcePreviewHidden ? 1 : 0},ext:${result.policy.blockedExtensions.length}`);
  announceAll("policyChanged");
  return presentPolicy(result.policy, { maxUploadMb: MAX_UPLOAD_MB });
}

// B7 scheduled messages (Zulip /scheduled_messages; Zulip sends them at the time, attachments included)
const SCHEDULE_MIN_SECONDS = 60;
const SCHEDULE_MAX_SECONDS = 366 * 24 * 60 * 60;

async function scheduledItem(session, item) {
  let target = null;
  if (item.type === "private" && Array.isArray(item.to)) {
    const others = item.to.filter((id) => id !== session.userId);
    if (others.length === 1) target = { view: "dm", userId: others[0], groupId: null };
  } else if (item.type === "stream" && Number.isInteger(item.to)) {
    if (session.groupIds?.has(item.to)) target = { view: "group", userId: null, groupId: item.to };
    else if (item.to === (await generalId(session))) target = { view: "general", userId: null, groupId: null };
  }
  if (!target) return null;
  const fields = messageFields(String(item.content || ""), { edited: false, flags: [], myId: session.userId });
  return {
    id: item.scheduled_message_id,
    ...target,
    content: fields.content,
    attachments: fields.attachments,
    mentions: fields.mentions,
    scheduledAt: item.scheduled_delivery_timestamp,
  };
}

async function listScheduled(session) {
  if (!session.groupIds) await listGroups(session);
  const result = await zulip("GET", "/api/v1/scheduled_messages", { auth: basic(session) });
  if (result.json?.result !== "success" || !Array.isArray(result.json.scheduled_messages)) {
    throw zulipFailure(result, "예약 메시지를 읽지 못했습니다.");
  }
  const items = [];
  for (const item of result.json.scheduled_messages) {
    if (item.failed) continue;
    const shown = await scheduledItem(session, item);
    if (shown) items.push(shown);
  }
  return { scheduled: items.sort((a, b) => a.scheduledAt - b.scheduledAt) };
}

async function createScheduled(session, body) {
  if (body.urgent) throw httpError(400, "예약 메시지는 중요 메시지로 보낼 수 없습니다.", "urgent");
  const text = typeof body.content === "string" ? body.content.trim() : "";
  const files = attachmentLines(body.attachments);
  if (!files) throw httpError(400, "첨부 파일을 확인하세요.", "attachments");
  if (!text && !files.lines.length) throw httpError(400, "메시지를 입력하세요.", "empty");
  const at = Number(body.scheduledAt);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(at) || at < now + SCHEDULE_MIN_SECONDS || at > now + SCHEDULE_MAX_SECONDS) {
    throw httpError(400, "예약 시간은 1분 뒤부터 1년 안으로 고르세요.", "time");
  }
  let form;
  if (body.view === "dm") {
    const peer = await personById(session, body.userId);
    form = { type: "direct", to: JSON.stringify([peer.userId]) };
  } else if (body.view === "group") {
    const group = await groupById(session, body.groupId);
    form = { type: "stream", to: String(group.groupId), topic: TOPIC };
  } else if (body.view === "general") {
    form = { type: "stream", to: String(await generalId(session)), topic: TOPIC };
  } else {
    throw httpError(400, "대화방을 확인하세요.", "view");
  }
  const mentioned = await mentionedPeople(session, body.mentions);
  const content = [applyMentions(neutralizeSyntax(text), mentioned), ...files.lines].filter(Boolean).join("\n");
  if (content.length > 10000) throw httpError(400, "메시지가 너무 깁니다.", "long");
  const result = await zulip("POST", "/api/v1/scheduled_messages", {
    auth: basic(session),
    form: { ...form, content, scheduled_delivery_timestamp: String(at) },
  });
  if (result.json?.result !== "success" || !Number.isInteger(result.json.scheduled_message_id)) {
    throw zulipFailure(result, "예약하지 못했습니다.");
  }
  const { scheduled } = await listScheduled(session);
  const item = scheduled.find((entry) => entry.id === result.json.scheduled_message_id);
  if (!item) throw httpError(502, "예약을 확인하지 못했습니다.", "scheduled");
  // The sender knows sizes and types that Zulip's message text does not carry.
  item.attachments = files.attachments;
  return { scheduled: item };
}

async function deleteScheduled(session, id) {
  const result = await zulip("DELETE", `/api/v1/scheduled_messages/${id}`, { auth: basic(session) });
  if (result.json?.result === "success") return { ok: true };
  if (result.status === 400 || result.status === 404) throw httpError(404, "예약 메시지를 찾지 못했습니다.", "scheduled");
  throw zulipFailure(result, "예약을 취소하지 못했습니다.");
}

// B8: files of one conversation, newest first, whole messages per page (next page: before = last messageId).
async function listFiles(session, params) {
  const { before } = parseAnchor(new URLSearchParams(params.get("before") ? { before: params.get("before") } : {}));
  const view = params.get("view");
  const peer = view === "dm" ? await personById(session, params.get("userId")) : null;
  const group = view === "group" ? await groupById(session, params.get("groupId")) : null;
  const narrow = [...conversationNarrow(peer, group), { operator: "has", operand: "attachment" }];
  const noteIds = peer ? new Set((await noteRecords(session)).map((note) => note.messageId)) : new Set();
  const data = await fetchZulipMessages(session, narrow, { anchor: before ? String(before) : "newest", numBefore: FILES_PAGE, numAfter: 0 });
  const files = [];
  for (const item of [...data.messages].sort((a, b) => b.id - a.id)) {
    const message = normalize(item, session);
    if (!message || message.recalled || (peer && (noteIds.has(message.id) || pendingNoteRecord(item)))) continue;
    for (const attachment of message.attachments) {
      files.push({ ...attachment, messageId: message.id, senderName: message.senderName, timestamp: message.timestamp });
    }
  }
  return { files, hasOlder: data.found_oldest === false && data.messages.length > 0 };
}

// ---- 2-C C1 admin (Zulip administrators / owners only; every call re-checks the role with Zulip) ----
const ROLE_CODES = { owner: 100, admin: 200, moderator: 300, member: 400, guest: 600 };

async function requireAdmin(session) {
  if (!isAdminRole(await currentRole(session))) throw httpError(403, "관리자만 할 수 있습니다.", "admin");
}

function adminUserOf(user, fieldIds, meta = {}) {
  const data = user.profile_data || {};
  const read = (id) => (id ? profileText(data[String(id)]) : "");
  return {
    userId: user.user_id,
    fullName: user.full_name || "",
    loginId: String(user.delivery_email || user.email || ""),
    department: read(fieldIds.department),
    position: read(fieldIds.position),
    role: roleName(user.role),
    active: user.is_active !== false,
    // Known only for retirements done through this server; Zulip's API does not give the date.
    deactivatedAt: user.is_active === false ? meta.deactivatedAt || null : null,
    mustChangePassword: Boolean(meta.mustChangePassword),
  };
}

// All human accounts, deactivated ones included (retired staff stay listed as inactive).
async function adminUsers(session) {
  const members = await fetchMembers(session);
  const fieldIds = await titleFieldIds(session);
  const metas = await adminMeta.all();
  const users = members
    .filter((user) => !user.is_bot)
    .map((user) => adminUserOf(user, fieldIds, metas[String(user.user_id)]))
    .sort((a, b) => a.fullName.localeCompare(b.fullName, "ko"));
  return { users, fieldIds };
}

async function adminUser(session, userId) {
  const { users } = await adminUsers(session);
  const user = users.find((item) => item.userId === userId);
  if (!user) throw httpError(404, "직원을 찾지 못했습니다.", "user");
  return user;
}

function profileText100(value) {
  return typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 50) : null;
}

// Department / position are Zulip custom profile fields ("부서", "직위"; web/dev/seed-test-org.mjs makes them).
async function setProfile(session, userId, fieldIds, { department, position }) {
  const data = [];
  if (department !== null && department !== undefined) {
    if (!fieldIds.department) throw httpError(400, "조직에 '부서' 프로필 칸이 없습니다.", "profile");
    data.push({ id: fieldIds.department, value: department });
  }
  if (position !== null && position !== undefined) {
    if (!fieldIds.position) throw httpError(400, "조직에 '직위' 프로필 칸이 없습니다.", "profile");
    data.push({ id: fieldIds.position, value: position });
  }
  if (!data.length) return;
  const result = await zulip("PATCH", `/api/v1/users/${userId}`, { auth: basic(session), form: { profile_data: JSON.stringify(data) } });
  if (result.json?.result !== "success") throw zulipFailure(result, "부서·직위를 바꾸지 못했습니다.");
}

async function adminCreateUser(session, body) {
  const fullName = typeof body.fullName === "string" ? body.fullName.replace(/\s+/g, " ").trim().slice(0, 100) : "";
  const loginId = typeof body.loginId === "string" ? body.loginId.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!fullName || !/^[^\s@]{1,64}@[^\s@]{1,190}$/.test(loginId) || password.length < 8 || password.length > 100) {
    throw httpError(400, "이름, 로그인 ID(사번@도메인), 8자 이상 비밀번호를 입력하세요.", "create");
  }
  const result = await zulip("POST", "/api/v1/users", { auth: basic(session), form: { email: loginId, password, full_name: fullName } });
  if (result.json?.result !== "success" || !Number.isInteger(result.json.user_id)) {
    const message = String(result.json?.msg || "");
    if (/already (in use|exists)|이미/i.test(message)) throw httpError(409, "이미 있는 로그인 ID입니다.", "create");
    if (/password/i.test(message)) throw httpError(400, "비밀번호가 너무 약합니다. 더 길고 복잡하게 정하세요.", "create");
    if (result.status === 403 || /not allowed|permission|authorized|Insufficient/i.test(message)) {
      throw httpError(403, "관리 계정에 직원 생성 권한(can_create_users)이 없습니다. 서버 관리자에게 요청하세요.", "create");
    }
    throw zulipFailure(result, "직원 계정을 만들지 못했습니다.");
  }
  // The administrator chose the first password: the new user is asked to change it after signing in.
  await adminMeta.set(result.json.user_id, { mustChangePassword: true });
  const { fieldIds } = await adminUsers(session);
  await setProfile(session, result.json.user_id, fieldIds, { department: profileText100(body.department), position: profileText100(body.position) });
  return { user: await adminUser(session, result.json.user_id) };
}

async function adminUpdateUser(session, userId, body) {
  const before = await adminUser(session, userId);
  const form = {};
  if (typeof body.fullName === "string" && body.fullName.trim()) form.full_name = body.fullName.replace(/\s+/g, " ").trim().slice(0, 100);
  if (body.role !== undefined) {
    if (!ROLE_CODES[body.role]) throw httpError(400, "역할을 확인하세요.", "role");
    if (userId === session.userId) throw httpError(400, "내 역할은 바꿀 수 없습니다.", "role");
    form.role = String(ROLE_CODES[body.role]);
  }
  if (Object.keys(form).length) {
    const result = await zulip("PATCH", `/api/v1/users/${userId}`, { auth: basic(session), form });
    if (result.json?.result !== "success") {
      if (/owner/i.test(String(result.json?.msg || ""))) throw httpError(403, "소유자 역할은 소유자만 바꿀 수 있습니다.", "role");
      throw zulipFailure(result, "직원 정보를 바꾸지 못했습니다.");
    }
  }
  const { fieldIds } = await adminUsers(session);
  await setProfile(session, userId, fieldIds, { department: profileText100(body.department), position: profileText100(body.position) });
  // After the server operator resets a password (ops procedure), the administrator turns this on.
  if (body.mustChangePassword !== undefined) {
    if (typeof body.mustChangePassword !== "boolean") throw httpError(400, "비밀번호 변경 요청 값을 확인하세요.", "password");
    await adminMeta.set(userId, { mustChangePassword: body.mustChangePassword });
    for (const other of sessions.values()) if (other.userId === userId) other.mustChangePassword = body.mustChangePassword;
  }
  return { user: await adminUser(session, userId), before };
}

async function adminSetActive(session, userId, active) {
  await adminUser(session, userId);
  if (userId === session.userId) throw httpError(400, "나 자신은 퇴직 처리할 수 없습니다.", "active");
  const result = active
    ? await zulip("POST", `/api/v1/users/${userId}/reactivate`, { auth: basic(session) })
    : await zulip("DELETE", `/api/v1/users/${userId}`, { auth: basic(session) });
  if (result.json?.result !== "success" && !/already (deactivated|active)/i.test(String(result.json?.msg || ""))) {
    throw zulipFailure(result, active ? "복귀 처리를 하지 못했습니다." : "퇴직 처리를 하지 못했습니다.");
  }
  await adminMeta.set(userId, { deactivatedAt: active ? null : new Date().toISOString() });
  // A retired user's open sessions end now, not at their next request.
  if (!active) endSessions(userId);
  return { user: await adminUser(session, userId) };
}

// Ends every 상상톡 session of a user (retirement, suspected misuse). Returns how many.
// The user's Zulip API key stays valid: Zulip has no API for an administrator to replace someone
// else's key (only the server operator can). Zulip itself is reachable only from the web server on
// the closed network, so the key alone is not usable from staff PCs.
function endSessions(userId) {
  let ended = 0;
  for (const [sid, other] of sessions) {
    if (other.userId !== userId) continue;
    if (other.queueId) {
      zulip("DELETE", "/api/v1/events?" + new URLSearchParams({ queue_id: other.queueId }), { auth: basic(other), timeoutMs: 5000 }).catch(() => {});
    }
    dropSession(sid);
    ended += 1;
  }
  return ended;
}

// One department room of a sync. Throws with publicMessage on a Zulip refusal.
async function applyDeptItem(session, item, adminsGroupId) {
  if (item.action === "create") {
    const result = await zulip("POST", "/api/v1/users/me/subscriptions", {
      auth: basic(session),
      form: {
        subscriptions: JSON.stringify([{ name: item.name, description: `${DEPT_MARK} ${item.name}` }]),
        principals: JSON.stringify(item.add),
        invite_only: "true",
        history_public_to_subscribers: "true",
        announce: "false",
        can_administer_channel_group: String(adminsGroupId),
        can_add_subscribers_group: String(adminsGroupId),
      },
    });
    const already = Object.values(result.json?.already_subscribed || {}).some((names) => names.includes(item.name));
    if (result.json?.result !== "success" || already) {
      if (result.json?.result === "success" || CHANNEL_EXISTS.test(String(result.json?.msg || ""))) {
        Object.assign(item, { action: "conflict", add: [], remove: [] }); // a channel this admin cannot see
        return;
      }
      throw zulipFailure(result, "부서 대화방을 만들지 못했습니다.");
    }
    return;
  }
  if (item.action === "restore") {
    const result = await zulip("PATCH", `/api/v1/streams/${item.streamId}`, { auth: basic(session), form: { is_archived: "false" } });
    if (result.json?.result !== "success") throw zulipFailure(result, "부서 대화방을 되살리지 못했습니다.");
  }
  if (item.add.length) {
    const result = await zulip("POST", "/api/v1/users/me/subscriptions", {
      auth: basic(session),
      form: { subscriptions: JSON.stringify([{ name: item.name }]), principals: JSON.stringify(item.add) },
    });
    if (result.json?.result !== "success") throw zulipFailure(result, "부서 대화방에 직원을 넣지 못했습니다.");
  }
  if (item.remove.length) {
    const result = await zulip("DELETE", "/api/v1/users/me/subscriptions", {
      auth: basic(session),
      form: { subscriptions: JSON.stringify([item.name]), principals: JSON.stringify(item.remove) },
    });
    if (result.json?.result !== "success") throw zulipFailure(result, "부서 대화방에서 직원을 빼지 못했습니다.");
  }
}

// A6/C1: one invite-only channel per department (description starts with DEPT_MARK), members = active
// staff whose "부서" field is that name. Only administrators may rename / invite / leave them.
// dryRun: work out the same plan and change nothing. `details` lists every department room:
//   { name, action: "create" | "restore" | "update" | "none" | "conflict", add: [userId], remove: [userId] }
// Room membership is read with the administrator's rights, so rooms the administrator is not in are exact too.
async function deptSync(session, { dryRun = false } = {}) {
  const { users } = await adminUsers(session);
  const wanted = new Map(); // department -> [userId]
  for (const user of users) {
    if (!user.active || !user.department) continue;
    if (!wanted.has(user.department)) wanted.set(user.department, []);
    wanted.get(user.department).push(user.userId);
  }
  // Archived rooms too: Zulip keeps an archived channel's name, so a department whose room was archived
  // gets that room back (unarchived) instead of a name clash.
  const streams = await zulip("GET", "/api/v1/streams?include_all=true&exclude_archived=false", { auth: basic(session) });
  if (streams.json?.result !== "success" || !Array.isArray(streams.json.streams)) throw zulipFailure(streams, "대화방 목록을 읽지 못했습니다.");
  const deptRooms = new Map();
  const otherNames = new Set();
  for (const stream of streams.json.streams) {
    if (String(stream.description || "").startsWith(DEPT_MARK)) deptRooms.set(stream.name, stream);
    else otherNames.add(String(stream.name).toLowerCase());
  }
  let adminsGroupId = null;
  if (!dryRun) {
    const groups = await zulip("GET", "/api/v1/user_groups", { auth: basic(session) });
    const admins = (groups.json?.user_groups || []).find((group) => group.name === "role:administrators");
    if (!admins) throw zulipFailure(groups, "관리자 그룹을 찾지 못했습니다.");
    adminsGroupId = admins.id;
  }
  const details = [];
  const sorted = [...new Set([...wanted.keys(), ...deptRooms.keys()])].sort((a, b) => a.localeCompare(b, "ko"));
  for (const name of sorted) {
    const memberIds = [...(wanted.get(name) || [])].sort((a, b) => a - b);
    const room = deptRooms.get(name);
    if (!room) {
      if (!memberIds.length) continue;
      // A non-department channel (e.g. a group someone made) already has this name.
      if (otherNames.has(name.toLowerCase())) {
        details.push({ name, action: "conflict", add: [], remove: [] });
        continue;
      }
      details.push({ name, action: "create", add: memberIds, remove: [] });
      continue;
    }
    if (room.is_archived && !memberIds.length) continue; // department gone and room archived: leave it so
    const current = await zulip("GET", `/api/v1/streams/${room.stream_id}/members`, { auth: basic(session) });
    if (current.json?.result !== "success" || !Array.isArray(current.json.subscribers)) throw zulipFailure(current, "부서 대화방 인원을 읽지 못했습니다.");
    const now = new Set(current.json.subscribers);
    const add = memberIds.filter((id) => !now.has(id));
    const remove = [...now].filter((id) => !memberIds.includes(id)).sort((a, b) => a - b);
    const action = room.is_archived ? "restore" : add.length || remove.length ? "update" : "none";
    details.push({ name, action, add, remove, streamId: room.stream_id });
  }
  if (!dryRun) {
    // Each room on its own: one failure is reported in details (action "error") and the rest go on.
    for (const item of details) {
      if (item.action === "conflict" || item.action === "none") continue;
      try {
        await applyDeptItem(session, item, adminsGroupId);
      } catch (error) {
        if (error.status === 401) throw error;
        Object.assign(item, { action: "error", error: error.publicMessage || upstreamMessage(error) });
      }
    }
  }
  const count = (action) => details.filter((item) => item.action === action).length;
  return {
    dryRun,
    created: count("create"),
    restored: count("restore"),
    added: details.filter((item) => item.action !== "error").reduce((sum, item) => sum + item.add.length, 0),
    removed: details.filter((item) => item.action !== "error").reduce((sum, item) => sum + item.remove.length, 0),
    conflicts: details.filter((item) => item.action === "conflict").map((item) => item.name),
    errors: details.filter((item) => item.action === "error").map((item) => item.name),
    details: details.map(({ streamId, ...item }) => item),
  };
}

// "YYYY-MM-DD" that is a real calendar day.
function auditDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

async function adminAudit(params) {
  const from = params.get("from") || "";
  const to = params.get("to") || "";
  const userId = params.get("userId") ? Number(params.get("userId")) : null;
  const action = params.get("action") || "";
  if ((from && !auditDay(from)) || (to && !auditDay(to)) || (userId !== null && !Number.isSafeInteger(userId))
    || (action && !/^[a-z_]{1,40}\*?$/.test(action))) {
    throw httpError(400, "검색 조건을 확인하세요.", "audit");
  }
  return { entries: await auditLog.query({ from, to, userId, action, limit: 1000 }) };
}

async function handleAdmin(request, response, session, url) {
  await requireAdmin(session);
  const method = request.method;
  const route = url.pathname;
  const userMatch = route.match(/^\/api\/admin\/users\/(\d{1,15})(\/deactivate|\/reactivate|\/password|\/logout)?$/);
  // D1 policy: blockedExtensions is the merged list, builtInExtensions the part that cannot be removed.
  if (route === "/api/admin/policy" && (method === "GET" || method === "PATCH")) {
    if (!(await reloadPolicy())) throw httpError(503, POLICY_FILE_ERROR, "policy");
    if (method === "GET") return presentPolicy(currentPolicy(), { maxUploadMb: MAX_UPLOAD_MB });
    return patchPolicy(request, session, await readJson(request));
  }
  if (route === "/api/admin/users" && method === "GET") {
    const { users } = await adminUsers(session);
    audit(request, session, "admin_users_list", "");
    return { users };
  }
  if (route === "/api/admin/users" && method === "POST") {
    try {
      const created = await adminCreateUser(session, await readJson(request));
      audit(request, session, "admin_user_create", created.user.userId);
      return created;
    } catch (error) {
      audit(request, session, "admin_user_create", "", false);
      throw error;
    }
  }
  if (userMatch) {
    const userId = Number(userMatch[1]);
    if (userMatch[2] === "/logout" && method === "POST") {
      await adminUser(session, userId);
      const ended = endSessions(userId);
      audit(request, session, "admin_user_logout", userId + ":" + ended);
      return { ended, apiKeyRenewed: false };
    }
    if (userMatch[2] === "/password" && method === "POST") {
      // Pending decision (Zulip has no API for it): docs/p2-contract.md C1.
      audit(request, session, "admin_password", userId, false);
      throw httpError(501, "비밀번호 초기화는 서버 관리자에게 요청하세요.", "password");
    }
    if ((userMatch[2] === "/deactivate" || userMatch[2] === "/reactivate") && method === "POST") {
      const active = userMatch[2] === "/reactivate";
      const result = await adminSetActive(session, userId, active);
      audit(request, session, active ? "admin_user_reactivate" : "admin_user_deactivate", userId);
      return result;
    }
    if (!userMatch[2] && method === "PATCH") {
      const { user, before } = await adminUpdateUser(session, userId, await readJson(request));
      const changed = ["fullName", "department", "position", "role"].filter((key) => before[key] !== user[key]);
      audit(request, session, "admin_user_update", `${userId}:${changed.join(",")}`);
      return { user };
    }
  }
  // GET ?dryRun=1: what a sync would do, changing nothing.
  if (route === "/api/admin/dept-sync" && method === "GET") {
    if (url.searchParams.get("dryRun") !== "1") throw httpError(400, "dryRun=1로 미리 보기만 할 수 있습니다.", "dept");
    const result = await deptSync(session, { dryRun: true });
    audit(request, session, "admin_dept_sync_preview", "");
    return result;
  }
  if (route === "/api/admin/dept-sync" && method === "POST") {
    const result = await deptSync(session);
    audit(request, session, "admin_dept_sync", `${result.created}+${result.restored}/${result.added}/${result.removed}`, result.errors.length === 0);
    return result;
  }
  if (route === "/api/admin/audit" && method === "GET") {
    const result = await adminAudit(url.searchParams);
    audit(request, session, "admin_audit_view", "");
    return result;
  }
  throw httpError(404, "없는 주소입니다.", "admin");
}

// ---- C. Files ----
async function handleUpload(session, request, response) {
  const name = cleanFileName(request.headers["x-file-name"]);
  if (!name) throw httpError(400, "파일 이름이 없습니다.", "name");
  if (isBlockedName(name)) throw httpError(415, "이 형식의 파일은 보낼 수 없습니다.", "type");
  // D1: the administrator's extra extensions (built-in ones are caught above). Unknown policy -> refuse.
  if (policyBroken && !(await reloadPolicy())) throw httpError(503, POLICY_UPLOAD_ERROR, "policy");
  if (blockedBy(currentPolicy(), extensionOf(name))) throw httpError(415, POLICY_BLOCKED_ERROR, "type");
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

// B2: each entry is { presence, status: { code, text } }.
async function readPresence(session) {
  // Registering a queue loads everyone's status into the shared cache.
  if (!statusesLoaded) await enqueue(session, () => ensureQueue(session));
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
    presence[String(user.user_id)] = { presence: status, status: userStatuses.get(user.user_id) || { code: "", text: "" } };
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
      let data;
      try {
        data = await readFile(file);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        sendJson(response, 404, { error: "없는 주소입니다." }); // e.g. admin.js before the admin screen exists
        return;
      }
      const ext = path.extname(filename);
      response.writeHead(200, {
        "content-type": TYPES[ext] || "application/octet-stream",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(data);
      return;
    }

    // C1: the admin screen. Signed out -> the main page (sign in there first); not an administrator -> 403.
    if (request.method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin.html")) {
      const session = sessionFrom(request);
      if (!session) {
        response.writeHead(302, { location: "/", "cache-control": "no-store" });
        response.end();
        return;
      }
      let page = null;
      if (isAdminRole(await currentRole(session))) {
        try {
          page = await readFile(path.join(publicDir, "admin.html"));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      const status = page ? 200 : isAdminRole(session.role) ? 404 : 403;
      response.writeHead(status, { "content-type": TYPES[".html"], "cache-control": "no-store", "x-content-type-options": "nosniff" });
      response.end(page || `<!doctype html><meta charset="utf-8"><title>상상톡</title><p>${status === 403 ? "관리자만 볼 수 있습니다." : "관리자 화면이 아직 없습니다."}</p>`);
      return;
    }

    // C1 / C4 enforced on the server, not only on screen:
    //  - mustChangePassword: only the session, password change and logout APIs (403 otherwise);
    //  - locked: only the session, unlock, lock and logout APIs (423 otherwise, events included).
    if (url.pathname.startsWith("/api/")) {
      const gated = sessionFrom(request);
      // P4: last use, in memory, at most once a minute (saved with the next session-file write).
      const passive = ["/api/session/status", "/api/session/lock", "/api/session/unlock"].includes(url.pathname);
      if (gated && !gated.locked && !passive && Date.now() - (gated.lastSeenAt || 0) >= 60 * 1000) gated.lastSeenAt = Date.now();
      const always =["/api/session", "/api/session/status", "/api/logout", "/api/login", "/api/health"];
      if (gated?.locked && ![...always, "/api/session/unlock", "/api/session/lock"].includes(url.pathname)) {
        sendJson(response, 423, { error: "화면이 잠겨 있습니다.", locked: true });
        return;
      }
      if (gated?.mustChangePassword && ![...always, "/api/session/password", "/api/session/unlock", "/api/session/lock"].includes(url.pathname)) {
        sendJson(response, 403, { error: "비밀번호를 먼저 바꿔 주세요.", mustChangePassword: true });
        return;
      }
    }

    // C4: the browser reports its lock screen; the server then refuses everything but unlock (above).
    if (request.method === "POST" && url.pathname === "/api/session/lock") {
      if (!sameOrigin(request)) {
        sendJson(response, 403, { error: "이 출처에서는 요청할 수 없습니다." });
        return;
      }
      const session = sessionFrom(request);
      if (!session) {
        sendJson(response, 401, { error: "로그인이 필요합니다." });
        return;
      }
      session.locked = true;
      session.wake?.(); // end a waiting event poll now; the next one gets 423
      audit(request, session, "lock", "");
      sendJson(response, 200, { ok: true, locked: true });
      return;
    }

    if (url.pathname.startsWith("/api/admin/")) {
      if (request.method !== "GET" && request.method !== "HEAD" && !sameOrigin(request)) {
        sendJson(response, 403, { error: "이 출처에서는 요청할 수 없습니다." });
        return;
      }
      const session = sessionFrom(request);
      if (!session) {
        sendJson(response, 401, { error: "로그인이 필요합니다." });
        return;
      }
      sendJson(response, 200, await handleAdmin(request, response, session, url));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, { ok: true, service: "sangsangtalk" });
      return;
    }

    // Every state-changing method (POST, PATCH, DELETE) must come from this app's own page.
    if (request.method !== "GET" && request.method !== "HEAD" && !sameOrigin(request)) {
      sendJson(response, 403, { error: "이 출처에서는 요청할 수 없습니다." });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/login") {
      // M14: staff sign in from the desktop app only. The header can be forged — this guides, it does not secure.
      // C1: Zulip administrators / owners may still sign in from a browser (handleLogin checks the role).
      const appOnly = config.appOnlyLogin && request.headers["x-sangsangtalk-client"] !== "desktop";
      await handleLogin(request, response, { appOnly });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/session/unlock") {
      const session = sessionFrom(request);
      if (!session) {
        sendJson(response, 401, { error: "로그인이 필요합니다.", signedOut: true });
        return;
      }
      await handleUnlock(request, response, session);
      return;
    }

    // C1: change my own password (first login after an administrator set it, or any time).
    if (request.method === "POST" && url.pathname === "/api/session/password") {
      const session = sessionFrom(request);
      if (!session) {
        sendJson(response, 401, { error: "로그인이 필요합니다." });
        return;
      }
      sendJson(response, 200, await changeMyPassword(request, session));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/logout") {
      const sid = cookieValue(request, "sangsang_sid");
      const session = sid ? dropSession(sid) : null;
      if (session) audit(request, session, "logout", "");
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
      // Restored sessions (M3) do not carry the role; read it once.
      if (!session.role) {
        try {
          await loadSessionDetails(session);
        } catch (error) {
          if (error.status === 401) throw error;
        }
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
      const uploaded = await handleUpload(session, request, response);
      audit(request, session, "file_upload", uploaded.file.path);
      sendJson(response, 200, uploaded);
      return;
    }

    // B8 — before the download route, which would take "/api/files/list" as a file path.
    if (request.method === "GET" && url.pathname === "/api/files/list") {
      const session = sessionFrom(request);
      if (!session) {
        sendJson(response, 401, { error: "로그인이 필요합니다." });
        return;
      }
      sendJson(response, 200, await listFiles(session, url.searchParams));
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
      // Thumbnails (inline=1) are drawn by the browser on their own; only real downloads are logged.
      if (found && url.searchParams.get("inline") !== "1") audit(request, session, "file_download", uploadPath);
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

    // ---- P2 2-A ----
    const messageRoute = url.pathname.match(/^\/api\/messages\/(\d{1,15})(\/readers|\/recall|\/reactions|\/star|\/poll|\/todo)?$/);
    const scheduledRoute = url.pathname.match(/^\/api\/scheduled\/(\d{1,15})$/);
    const mySessionRoute = url.pathname.match(/^\/api\/me\/sessions\/([a-f0-9]{12})$/);
    const p2Route = messageRoute || scheduledRoute || mySessionRoute || [
      "/api/search", "/api/messages/read", "/api/notices", "/api/status", "/api/prefs", "/api/starred", "/api/typing", "/api/scheduled",
      // P3
      "/api/notices/ack", "/api/notices/acks", "/api/activity", "/api/activity/seen", "/api/keywords", "/api/me/sessions", "/api/me/privacy",
      "/api/me/avatar",
    ].includes(url.pathname);
    if (p2Route) {
      const session = sessionFrom(request);
      if (!session) {
        sendJson(response, 401, { error: "로그인이 필요합니다." });
        return;
      }
      const method = request.method;
      if (url.pathname === "/api/search" && method === "GET") {
        sendJson(response, 200, await handleSearch(session, url.searchParams));
        return;
      }
      if (url.pathname === "/api/messages/read" && method === "POST") {
        sendJson(response, 200, await markRead(session, await readJson(request)));
        return;
      }
      if (url.pathname === "/api/notices" && (method === "POST" || method === "DELETE")) {
        const source = method === "POST" ? await readJson(request) : Object.fromEntries(url.searchParams);
        sendJson(response, 200, await changeNotice(session, method, source));
        return;
      }
      if (messageRoute && messageRoute[2] === "/readers" && method === "GET") {
        sendJson(response, 200, await handleReaders(session, Number(messageRoute[1])));
        return;
      }
      if (messageRoute && !messageRoute[2] && method === "PATCH") {
        sendJson(response, 200, await editMessage(session, messageRoute[1], await readJson(request)));
        return;
      }
      if (messageRoute && messageRoute[2] === "/recall" && method === "POST") {
        const recalled = await recallMessage(session, messageRoute[1]);
        audit(request, session, "recall", recalled.message.id);
        rememberRecalled(recalled.message.id, true);
        // A recalled message stops being a notice (everyone in the room is told).
        // The recall itself succeeded; a notice file problem is logged only.
        try {
          for (const key of await noticeStore.removeMessage(recalled.message.id)) announceNotice(key);
        } catch (error) {
          console.error(`[sangsang] 회수된 메시지의 공지를 내리지 못했습니다 (${error.code || error.message}).`);
        }
        sendJson(response, 200, recalled);
        return;
      }
      // C5: vote (toggle my vote) / todo (toggle done)
      if (messageRoute && (messageRoute[2] === "/poll" || messageRoute[2] === "/todo") && method === "POST") {
        const { key } = await readJson(request);
        sendJson(response, 200, await widgetAction(session, Number(messageRoute[1]), messageRoute[2].slice(1), key));
        return;
      }
      // ---- 2-B ----
      if (messageRoute && messageRoute[2] === "/reactions" && (method === "POST" || method === "DELETE")) {
        const emoji = method === "POST" ? (await readJson(request)).emoji : url.searchParams.get("emoji");
        sendJson(response, 200, await changeReaction(session, Number(messageRoute[1]), method, emoji));
        return;
      }
      if (messageRoute && messageRoute[2] === "/star" && (method === "POST" || method === "DELETE")) {
        sendJson(response, 200, await changeStar(session, Number(messageRoute[1]), method));
        return;
      }
      if (url.pathname === "/api/starred" && method === "GET") {
        sendJson(response, 200, await listStarred(session, url.searchParams));
        return;
      }
      if (url.pathname === "/api/status" && method === "POST") {
        sendJson(response, 200, await setMyStatus(session, await readJson(request)));
        return;
      }
      if (url.pathname === "/api/prefs" && method === "GET") {
        sendJson(response, 200, await readPrefs(session));
        return;
      }
      // ---- P3 (docs/p3-contract.md) ----
      if (url.pathname === "/api/notices/ack" && method === "POST") {
        sendJson(response, 200, await ackNotice(request, session, await readJson(request)));
        return;
      }
      if (url.pathname === "/api/notices/acks" && method === "GET") {
        sendJson(response, 200, await noticeAcks(session, Object.fromEntries(url.searchParams)));
        return;
      }
      if (url.pathname === "/api/activity" && method === "GET") {
        sendJson(response, 200, await handleActivity(session, url.searchParams));
        return;
      }
      if (url.pathname === "/api/activity/seen" && method === "POST") {
        sendJson(response, 200, await markActivitySeen(session, await readJson(request)));
        return;
      }
      if (url.pathname === "/api/keywords" && method === "GET") {
        sendJson(response, 200, { keywords: await listKeywords(session) });
        return;
      }
      if (url.pathname === "/api/keywords" && (method === "POST" || method === "DELETE")) {
        const value = method === "POST" ? (await readJson(request)).keyword : url.searchParams.get("keyword");
        sendJson(response, 200, await changeKeyword(session, method, value));
        return;
      }
      if (url.pathname === "/api/me/sessions" && method === "GET") {
        sendJson(response, 200, mySessions(request, session));
        return;
      }
      if (url.pathname === "/api/me/sessions" && method === "DELETE") {
        if (url.searchParams.get("others") !== "1") throw httpError(400, "로그아웃할 로그인을 고르세요.", "session");
        sendJson(response, 200, revokeMySessions(request, session, { others: true }));
        return;
      }
      if (mySessionRoute && method === "DELETE") {
        sendJson(response, 200, revokeMySessions(request, session, { id: mySessionRoute[1] }));
        return;
      }
      if (url.pathname === "/api/me/avatar" && (method === "POST" || method === "DELETE")) {
        sendJson(response, 200, await changeMyAvatar(request, session, method));
        return;
      }
      if (url.pathname === "/api/me/privacy" && method === "GET") {
        sendJson(response, 200, await readPrivacy(session));
        return;
      }
      if (url.pathname === "/api/me/privacy" && method === "PATCH") {
        sendJson(response, 200, await patchPrivacy(session, await readJson(request)));
        return;
      }
      if (url.pathname === "/api/prefs" && method === "PATCH") {
        sendJson(response, 200, await patchPrefs(session, await readJson(request)));
        return;
      }
      if (url.pathname === "/api/typing" && method === "POST") {
        sendJson(response, 200, await sendTyping(session, await readJson(request)));
        return;
      }
      if (url.pathname === "/api/scheduled" && method === "GET") {
        sendJson(response, 200, await listScheduled(session));
        return;
      }
      if (url.pathname === "/api/scheduled" && method === "POST") {
        sendJson(response, 200, await createScheduled(session, await readJson(request)));
        return;
      }
      if (scheduledRoute && method === "DELETE") {
        sendJson(response, 200, await deleteScheduled(session, Number(scheduledRoute[1])));
        return;
      }
      sendJson(response, 404, { error: "없는 주소입니다." });
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
    if (error?.code === "JSON_STORE") {
      console.error("[sangsang] store failed", url.pathname, error.message);
      sendJson(response, 503, { error: STORE_ERROR });
      return;
    }
    if ([400, 403, 404, 409, 411, 413, 415, 429, 501].includes(status)) {
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

// C2: audit files older than AUDIT_KEEP_MONTHS go at startup and then once a day.
async function pruneAudit() {
  try {
    const pruned = await auditLog.prune();
    if (pruned) console.log(`[sangsang] 보존 기간(${config.auditKeepMonths}개월)이 지난 감사 로그 ${pruned}개를 지웠습니다.`);
  } catch (error) {
    console.error(`[sangsang] 지난 감사 로그를 지우지 못했습니다 (${error.code || error.message}).`);
  }
}
await pruneAudit();
setInterval(pruneAudit, 24 * 60 * 60 * 1000).unref();
// Saved sessions are back before the first request is accepted.
const restored = await restoreSessions();
// D1: policy.json (or its .bak) is read now; if neither reads, uploads stay refused until it does.
await reloadPolicy();
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
