import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { emptyPolicy, fullPrefs, validatePolicy, validStoredPrefs } from "./settings.mjs";

// Small JSON file store for server-side records (notices, prefs). Same write method as
// note-store.mjs: temp file -> rename, with a .bak kept during the swap. Calls are serialised.
// `validate(data)` must throw on a bad shape; a missing file is `empty()`.
// Errors carry code "JSON_STORE" so callers can answer 503 instead of crashing.

function storeError(reason) {
  return Object.assign(new Error(reason), { code: "JSON_STORE" });
}

async function readOptional(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw storeError(`unreadable: ${error.code || error.message}`);
  }
}

export function createJsonStore(filePath, { empty, validate }) {
  let chain = Promise.resolve();
  const exclusive = (task) => {
    const run = chain.then(task, task);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };

  // The .bak only exists during a write (or after one was interrupted). It is used when the main file
  // is missing or damaged, so an interrupted save does not lose the data.
  async function load() {
    const primary = await readOptional(filePath);
    const parse = (text) => validate(JSON.parse(text));
    if (primary !== null) {
      try {
        return parse(primary);
      } catch (error) {
        const backup = await readOptional(`${filePath}.bak`);
        if (backup !== null) {
          try {
            return parse(backup);
          } catch {
            // fall through: both damaged
          }
        }
        throw storeError(`corrupt ${path.basename(filePath)}: ${error.message}`);
      }
    }
    const backup = await readOptional(`${filePath}.bak`);
    if (backup === null) return empty();
    try {
      return parse(backup);
    } catch (error) {
      throw storeError(`corrupt ${path.basename(filePath)}.bak: ${error.message}`);
    }
  }

  async function save(data) {
    validate(data);
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp`;
    const backup = `${filePath}.bak`;
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rm(backup, { force: true });
    try {
      await rename(filePath, backup);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      await rename(temporary, filePath);
    } catch (error) {
      try {
        await rename(backup, filePath);
      } catch {
        // The original file could not be restored; surface the rename failure.
      }
      throw error;
    }
    await rm(backup, { force: true });
  }

  return {
    read: () => exclusive(load),
    // fn(data) changes data in place and returns a result; the file is written only when fn returns
    // { changed: true, ... } (or anything truthy for `changed`).
    update: (fn) => exclusive(async () => {
      const data = await load();
      const result = await fn(data);
      if (result?.changed) {
        try {
          await save(data);
        } catch (error) {
          throw error.code === "JSON_STORE" ? error : storeError(`write failed: ${error.code || error.message}`);
        }
      }
      return result;
    }),
  };
}

// ---- A5 notices: web/data/notices.json ----
// { version: 1, notices: { "general" | "dm:<small>-<big>" | "group:<id>": { messageId, setBy, setAt } } }
// Message text is never stored.
const NOTICE_KEY = /^(general|dm:\d+-\d+|group:\d+)$/;

function validateNotices(data) {
  if (!data || data.version !== 1 || !data.notices || typeof data.notices !== "object" || Array.isArray(data.notices)) {
    throw new Error("invalid notices store");
  }
  for (const [key, notice] of Object.entries(data.notices)) {
    if (!NOTICE_KEY.test(key)) throw new Error("invalid notice key");
    for (const field of ["messageId", "setBy", "setAt"]) {
      if (!Number.isSafeInteger(notice?.[field]) || notice[field] <= 0) throw new Error(`invalid notice ${field}`);
    }
    if (notice.ackRequired !== undefined) {
      const ids = notice.ackUserIds;
      if (notice.ackRequired !== true || !Array.isArray(ids) || !ids.every((id) => Number.isSafeInteger(id) && id > 0)) throw new Error("invalid notice ack");
      if (!notice.acks || typeof notice.acks !== "object" || Array.isArray(notice.acks)) throw new Error("invalid notice acks");
      for (const [userId, at] of Object.entries(notice.acks)) {
        if (!/^\d{1,15}$/.test(userId) || !Number.isSafeInteger(at) || at <= 0) throw new Error("invalid notice ack entry");
      }
    }
  }
  return data;
}

// N8: notice record fields kept as they are (ack snapshot included).
function noticeRecord(notice) {
  const out = { messageId: notice.messageId, setBy: notice.setBy, setAt: notice.setAt };
  if (notice.ackRequired) {
    out.ackRequired = true;
    out.ackUserIds = [...notice.ackUserIds];
    out.acks = { ...(notice.acks || {}) };
  }
  return out;
}

// ---- B4·B5, P3 per-user prefs: web/data/prefs.json ----
// { version: 1, users: { "<userId>": { favorites: [key], muted: [key], dnd: {...}, notify?, display?, chat?, presence?, lock? } } }
// key: "general" | "dm:<userId>" | "group:<groupId>". Zulip has no equivalent that also works for 1:1 rooms.
// Field rules live in lib/settings.mjs (shared with the mock). Missing sections read as defaults.
export { PREF_KEY, DND_TIME, DEFAULT_DND, validPrefKeys, validDnd } from "./settings.mjs";

function validatePrefs(data) {
  if (!data || data.version !== 1 || !data.users || typeof data.users !== "object" || Array.isArray(data.users)) {
    throw new Error("invalid prefs store");
  }
  for (const [userId, prefs] of Object.entries(data.users)) {
    if (!/^\d{1,15}$/.test(userId)) throw new Error("invalid prefs user");
    if (!validStoredPrefs(prefs)) throw new Error("invalid prefs");
  }
  return data;
}

export function createPrefsStore(filePath) {
  const store = createJsonStore(filePath, { empty: () => ({ version: 1, users: {} }), validate: validatePrefs });
  return {
    // Full prefs (defaults filled), without the policy / snooze presentation (settings.presentPrefs).
    async get(userId) {
      return fullPrefs((await store.read()).users[String(userId)]);
    },
    // fn(current full prefs) -> { change } (full record to store) or { status, error } (nothing written).
    async apply(userId, fn) {
      return store.update((data) => {
        const result = fn(fullPrefs(data.users[String(userId)]));
        if (!result.change) return { changed: false, ...result };
        data.users[String(userId)] = result.change;
        return { changed: true, prefs: fullPrefs(result.change) };
      });
    },
  };
}

// ---- D1 admin policy: web/data/policy.json (see lib/settings.mjs) ----
export function createPolicyStore(filePath) {
  const store = createJsonStore(filePath, { empty: emptyPolicy, validate: validatePolicy });
  let cache = null; // read on every upload / session call, so keep the last good copy
  return {
    async get() {
      cache = await store.read();
      return cache;
    },
    // Last value read or written; null before the first read.
    cached: () => cache,
    async apply(fn) {
      const result = await store.update((data) => {
        const out = fn(data);
        if (!out.change) return { changed: false, ...out };
        Object.assign(data, out.change);
        return { changed: true, policy: { ...out.change } };
      });
      if (result.changed) cache = result.policy;
      return result;
    },
  };
}

// ---- C1 per-user admin data Zulip does not keep: web/data/admin-meta.json ----
// { version: 1, users: { "<userId>": { deactivatedAt?: ISO string, mustChangePassword?: true } } }
// deactivatedAt is known only for retirements done through this server (others stay null).
function validateAdminMeta(data) {
  if (!data || data.version !== 1 || !data.users || typeof data.users !== "object" || Array.isArray(data.users)) {
    throw new Error("invalid admin meta store");
  }
  for (const [userId, meta] of Object.entries(data.users)) {
    if (!/^\d{1,15}$/.test(userId) || !meta || typeof meta !== "object") throw new Error("invalid admin meta user");
    if (meta.deactivatedAt !== undefined && Number.isNaN(Date.parse(meta.deactivatedAt))) throw new Error("invalid deactivatedAt");
    if (meta.mustChangePassword !== undefined && meta.mustChangePassword !== true) throw new Error("invalid mustChangePassword");
  }
  return data;
}

export function createAdminMetaStore(filePath) {
  const store = createJsonStore(filePath, { empty: () => ({ version: 1, users: {} }), validate: validateAdminMeta });
  const clean = (data, userId) => {
    if (data.users[userId] && !Object.keys(data.users[userId]).length) delete data.users[userId];
  };
  return {
    async all() {
      return (await store.read()).users;
    },
    async get(userId) {
      return (await store.read()).users[String(userId)] || {};
    },
    // change: { deactivatedAt: ISO | null, mustChangePassword: boolean } — null / false removes the field.
    async set(userId, change) {
      return store.update((data) => {
        const key = String(userId);
        const meta = { ...(data.users[key] || {}) };
        if (change.deactivatedAt !== undefined) {
          if (change.deactivatedAt) meta.deactivatedAt = change.deactivatedAt;
          else delete meta.deactivatedAt;
        }
        if (change.mustChangePassword !== undefined) {
          if (change.mustChangePassword) meta.mustChangePassword = true;
          else delete meta.mustChangePassword;
        }
        data.users[key] = meta;
        clean(data, key);
        return { changed: true };
      });
    },
  };
}

export function createNoticeStore(filePath) {
  const store = createJsonStore(filePath, { empty: () => ({ version: 1, notices: {} }), validate: validateNotices });
  return {
    async get(key) {
      const notice = (await store.read()).notices[key];
      return notice ? noticeRecord(notice) : null;
    },
    // Every notice (for the activity centre).
    async all() {
      return (await store.read()).notices;
    },
    // notice: { messageId, setBy, setAt, ackRequired?, ackUserIds? } — a new notice starts with no acks.
    async set(key, notice) {
      return store.update((data) => {
        data.notices[key] = noticeRecord({ ...notice, acks: {} });
        return { changed: true };
      });
    },
    // N8: records userId's ack of the notice now at key (if it is still messageId). Result:
    // { status: "missing" | "notRequired" | "notTarget" | "already" | "done", notice }
    async ack(key, messageId, userId, at) {
      return store.update((data) => {
        const notice = data.notices[key];
        if (!notice || (messageId && notice.messageId !== messageId)) return { changed: false, status: "missing" };
        if (!notice.ackRequired) return { changed: false, status: "notRequired", notice: noticeRecord(notice) };
        if (!notice.ackUserIds.includes(userId)) return { changed: false, status: "notTarget", notice: noticeRecord(notice) };
        if (notice.acks[String(userId)]) return { changed: false, status: "already", notice: noticeRecord(notice) };
        notice.acks[String(userId)] = at;
        return { changed: true, status: "done", notice: noticeRecord(notice) };
      });
    },
    async remove(key) {
      return store.update((data) => {
        if (!data.notices[key]) return { changed: false };
        delete data.notices[key];
        return { changed: true };
      });
    },
    // Removes every notice pointing at this message; returns the keys removed.
    async removeMessage(messageId) {
      const result = await store.update((data) => {
        const keys = Object.keys(data.notices).filter((key) => data.notices[key].messageId === messageId);
        for (const key of keys) delete data.notices[key];
        return { changed: keys.length > 0, keys };
      });
      return result.keys;
    },
  };
}
