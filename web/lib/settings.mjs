// P3 settings rules shared by web/server.mjs and web/dev/mock-server.mjs (docs/p3-contract.md).
// Pure: no I/O. Per-user prefs (web/data/prefs.json), the admin policy (web/data/policy.json), keywords.
import { BLOCKED_EXTENSIONS } from "./files.mjs";

// ---- prefs ----
export const PREF_KEY = /^(general|dm:\d{1,15}|group:\d{1,15})$/;
export const DND_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DEFAULT_DND = Object.freeze({ enabled: false, from: "18:00", to: "09:00", weekends: true });
const PREF_LIST_MAX = 200;
export const SNOOZE_MAX_MS = 7 * 24 * 60 * 60 * 1000;
export const AWAY_MINUTES = [5, 10, 15, 30, 60];
export const POLICY_LOCKED = "기관 정책으로 고정된 설정입니다.";

// Every section with its default. Arrays are copied by defaultPrefs().
const SECTIONS = {
  notify: { preview: "full", sound: "default", flash: true, snoozeUntil: null, replyBypassMute: true },
  display: { theme: "light", fontSize: "normal", density: "comfortable" },
  chat: { enterSends: true, autoShowImages: true, roomSort: "recent" },
  presence: { awayMinutes: 10 },
  lock: { minutes: null },
};
const oneOf = (...values) => (value) => values.includes(value);
const bool = (value) => typeof value === "boolean";
// Field checks. snoozeUntil and lock.minutes need context and are checked separately.
const FIELDS = {
  notify: {
    preview: oneOf("full", "name", "none"),
    sound: oneOf("default", "im", "mail", "reminder", "none"),
    flash: bool,
    snoozeUntil: (value) => value === null || (typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value))),
    replyBypassMute: bool,
  },
  display: {
    theme: oneOf("system", "light", "dark"),
    fontSize: oneOf("small", "normal", "large"),
    density: oneOf("comfortable", "compact"),
  },
  chat: { enterSends: bool, autoShowImages: bool, roomSort: oneOf("recent", "name") },
  presence: { awayMinutes: oneOf(...AWAY_MINUTES) },
  lock: { minutes: (value) => value === null || (Number.isInteger(value) && value >= 0 && value <= 1440) },
};
const SECTION_ERRORS = {
  notify: "알림 설정을 확인하세요.",
  display: "화면 설정을 확인하세요.",
  chat: "대화 설정을 확인하세요.",
  presence: "자리 비움 시간은 5, 10, 15, 30, 60분 중에서 고르세요.",
  lock: "자동 잠금 시간을 확인하세요.",
};

export function validPrefKeys(list) {
  return Array.isArray(list) && list.length <= PREF_LIST_MAX && list.every((key) => typeof key === "string" && PREF_KEY.test(key));
}

export function validDnd(dnd) {
  return Boolean(dnd) && typeof dnd === "object" && typeof dnd.enabled === "boolean" && typeof dnd.weekends === "boolean"
    && DND_TIME.test(dnd.from) && DND_TIME.test(dnd.to);
}

export function defaultPrefs() {
  const out = { favorites: [], muted: [], dnd: { ...DEFAULT_DND } };
  for (const [name, fields] of Object.entries(SECTIONS)) out[name] = { ...fields };
  return out;
}

// Stored record (any older shape) -> full prefs. Unknown or bad stored fields fall back to the default.
export function fullPrefs(record) {
  const out = defaultPrefs();
  if (!record || typeof record !== "object") return out;
  if (validPrefKeys(record.favorites)) out.favorites = [...record.favorites];
  if (validPrefKeys(record.muted)) out.muted = [...record.muted];
  if (validDnd(record.dnd)) out.dnd = { enabled: record.dnd.enabled, from: record.dnd.from, to: record.dnd.to, weekends: record.dnd.weekends };
  for (const [name, fields] of Object.entries(FIELDS)) {
    const stored = record[name];
    if (!stored || typeof stored !== "object") continue;
    for (const [field, valid] of Object.entries(fields)) {
      if (stored[field] !== undefined && valid(stored[field])) out[name][field] = stored[field];
    }
  }
  return out;
}

// Stored file check (json-store validate): only the shape that every reader relies on.
export function validStoredPrefs(record) {
  if (!record || typeof record !== "object") return false;
  if (!validPrefKeys(record.favorites) || !validPrefKeys(record.muted) || !validDnd(record.dnd)) return false;
  return Object.keys(SECTIONS).every((name) => record[name] === undefined || (record[name] && typeof record[name] === "object" && !Array.isArray(record[name])));
}

// Snooze in the past reads as null.
function liveSnooze(value, nowMs) {
  return value && Date.parse(value) > nowMs ? value : null;
}

// What GET/PATCH return: defaults filled, expired snooze cleared, policy-fixed values applied, `locked` listed.
export function presentPrefs(record, { policy = {}, now = Date.now() } = {}) {
  const prefs = fullPrefs(record);
  prefs.notify.snoozeUntil = liveSnooze(prefs.notify.snoozeUntil, now);
  const locked = [];
  if (policy.forcePreviewHidden) {
    prefs.notify.preview = "none";
    locked.push("notify.preview");
  }
  return { ...prefs, locked };
}

// PATCH body -> { change } (a full prefs record to store) or { status, error }.
// adminLockMinutes: AUTO_LOCK_MINUTES (0 = off). Sections may be partial: only the fields sent change.
export function applyPrefsPatch(record, body, { adminLockMinutes, policy = {}, now = Date.now() }) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { status: 400, error: "설정 값을 확인하세요." };
  const next = fullPrefs(record);
  for (const name of ["favorites", "muted"]) {
    if (body[name] === undefined) continue;
    if (!validPrefKeys(body[name])) return { status: 400, error: "설정 값을 확인하세요." };
    next[name] = [...new Set(body[name])];
  }
  if (body.dnd !== undefined) {
    const dnd = body.dnd && typeof body.dnd === "object" && !Array.isArray(body.dnd) ? { ...next.dnd, ...body.dnd } : null;
    if (!dnd || Object.keys(dnd).length !== 4 || !validDnd(dnd)) return { status: 400, error: "방해 금지 설정을 확인하세요." };
    next.dnd = { enabled: dnd.enabled, from: dnd.from, to: dnd.to, weekends: dnd.weekends };
  }
  for (const [name, fields] of Object.entries(FIELDS)) {
    const sent = body[name];
    if (sent === undefined) continue;
    if (!sent || typeof sent !== "object" || Array.isArray(sent)) return { status: 400, error: SECTION_ERRORS[name] };
    for (const [field, value] of Object.entries(sent)) {
      // Own fields only: "constructor" / "__proto__" are not settings.
      if (!Object.hasOwn(fields, field) || !fields[field](value)) return { status: 400, error: SECTION_ERRORS[name] };
    }
    // A policy-fixed field may be sent with the fixed value (a whole notify section); any other value is 403.
    if (name === "notify" && sent.preview !== undefined && sent.preview !== "none" && policy.forcePreviewHidden) return { status: 403, error: POLICY_LOCKED, locked: true };
    if (name === "notify" && sent.snoozeUntil) {
      const at = Date.parse(sent.snoozeUntil);
      if (at > now + SNOOZE_MAX_MS) return { status: 400, error: "잠시 끄기는 7일 안으로 고르세요." };
    }
    if (name === "lock" && sent.minutes !== undefined && sent.minutes !== null) {
      const admin = Number(adminLockMinutes) || 0;
      if (admin > 0 && sent.minutes === 0) return { status: 400, error: "기관 설정으로 자동 잠금을 끌 수 없습니다." };
      if (admin > 0 && sent.minutes > admin) return { status: 400, error: `자동 잠금은 기관 설정(${admin}분)보다 길게 할 수 없습니다.` };
    }
    Object.assign(next[name], sent);
  }
  // A past snooze is stored as null (it would read as null anyway).
  next.notify.snoozeUntil = liveSnooze(next.notify.snoozeUntil, now);
  return { change: next };
}

// ---- N4 keywords (Zulip alert words) ----
export const KEYWORD_MAX = 20;
export function cleanKeyword(value) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length >= 2 && text.length <= 30 ? text : "";
}
export const KEYWORD_ERRORS = {
  invalid: "키워드는 2~30자로 입력하세요.",
  full: `키워드는 ${KEYWORD_MAX}개까지 등록할 수 있습니다.`,
};

// ---- D1 admin policy: web/data/policy.json ----
// { version: 1, forcePreviewHidden: boolean, blockedExtensions: ["hwp", ...] }  (admin additions only, no dot)
export const BUILT_IN_EXTENSIONS = Object.freeze([...BLOCKED_EXTENSIONS].map((ext) => ext.slice(1)).sort());
const EXTENSION = /^[a-z0-9]{1,10}$/;
const POLICY_EXTENSIONS_MAX = 50;
export const POLICY_BLOCKED_ERROR = "기관 정책으로 막힌 파일 형식입니다.";

export function emptyPolicy() {
  return { version: 1, forcePreviewHidden: false, blockedExtensions: [] };
}

export function validatePolicy(data) {
  if (!data || data.version !== 1 || typeof data.forcePreviewHidden !== "boolean" || !Array.isArray(data.blockedExtensions)
    || data.blockedExtensions.length > POLICY_EXTENSIONS_MAX || !data.blockedExtensions.every((ext) => typeof ext === "string" && EXTENSION.test(ext))) {
    throw new Error("invalid policy store");
  }
  return data;
}

// Built-in list first, then the admin additions (sorted, without duplicates).
export function blockedExtensionList(policy) {
  const extra = (policy?.blockedExtensions || []).filter((ext) => !BUILT_IN_EXTENSIONS.includes(ext));
  return [...BUILT_IN_EXTENSIONS, ...[...new Set(extra)].sort()];
}

// For /api/session limits.blockedExtensions (same ".exe" form as phase 1).
export function blockedExtensionsDotted(policy) {
  return blockedExtensionList(policy).map((ext) => `.${ext}`);
}

export function presentPolicy(policy, { maxUploadMb }) {
  return {
    forcePreviewHidden: Boolean(policy?.forcePreviewHidden),
    blockedExtensions: blockedExtensionList(policy),
    builtInExtensions: [...BUILT_IN_EXTENSIONS],
    maxUploadMb,
  };
}

// PATCH body -> { change } (policy record to store) or { status, error }.
export function applyPolicyPatch(policy, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { status: 400, error: "정책 값을 확인하세요." };
  if (body.maxUploadMb !== undefined) return { status: 400, error: "업로드 최대 크기는 서버 설정(MAX_UPLOAD_MB)에서만 바꿀 수 있습니다." };
  const unknown = Object.keys(body).filter((key) => !["forcePreviewHidden", "blockedExtensions"].includes(key));
  if (unknown.length) return { status: 400, error: "정책 값을 확인하세요." };
  const next = { version: 1, forcePreviewHidden: Boolean(policy?.forcePreviewHidden), blockedExtensions: [...(policy?.blockedExtensions || [])] };
  if (body.forcePreviewHidden !== undefined) {
    if (typeof body.forcePreviewHidden !== "boolean") return { status: 400, error: "정책 값을 확인하세요." };
    next.forcePreviewHidden = body.forcePreviewHidden;
  }
  if (body.blockedExtensions !== undefined) {
    const list = Array.isArray(body.blockedExtensions) ? body.blockedExtensions : null;
    const cleaned = list?.map((ext) => (typeof ext === "string" ? ext.trim().toLowerCase().replace(/^\./, "") : ""));
    const extra = cleaned ? [...new Set(cleaned.filter((ext) => !BUILT_IN_EXTENSIONS.includes(ext)))].sort() : null;
    if (!extra || !cleaned.every((ext) => EXTENSION.test(ext)) || extra.length > POLICY_EXTENSIONS_MAX) {
      return { status: 400, error: `확장자는 영문·숫자 1~10자로, ${POLICY_EXTENSIONS_MAX}개까지 추가할 수 있습니다.` };
    }
    next.blockedExtensions = extra;
  }
  return { change: next };
}

// Upload check: null (allowed), or { builtIn } when blocked.
export function blockedBy(policy, extension) {
  const ext = String(extension || "").toLowerCase().replace(/^\./, "");
  if (!ext) return null;
  if (BUILT_IN_EXTENSIONS.includes(ext)) return { builtIn: true };
  if ((policy?.blockedExtensions || []).includes(ext)) return { builtIn: false };
  return null;
}
