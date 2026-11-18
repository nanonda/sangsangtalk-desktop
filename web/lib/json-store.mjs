import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

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
  }
  return data;
}

// ---- B4·B5 per-user prefs: web/data/prefs.json ----
// { version: 1, users: { "<userId>": { favorites: [key], muted: [key], dnd: { enabled, from, to, weekends } } } }
// key: "general" | "dm:<userId>" | "group:<groupId>". Zulip has no equivalent that also works for 1:1 rooms.
export const PREF_KEY = /^(general|dm:\d{1,15}|group:\d{1,15})$/;
export const DND_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DEFAULT_DND = Object.freeze({ enabled: false, from: "18:00", to: "09:00", weekends: true });
const PREF_LIST_MAX = 200;

export function validPrefKeys(list) {
  return Array.isArray(list) && list.length <= PREF_LIST_MAX && list.every((key) => typeof key === "string" && PREF_KEY.test(key));
}

export function validDnd(dnd) {
  return Boolean(dnd) && typeof dnd === "object" && typeof dnd.enabled === "boolean" && typeof dnd.weekends === "boolean"
    && DND_TIME.test(dnd.from) && DND_TIME.test(dnd.to);
}

function validatePrefs(data) {
  if (!data || data.version !== 1 || !data.users || typeof data.users !== "object" || Array.isArray(data.users)) {
    throw new Error("invalid prefs store");
  }
  for (const [userId, prefs] of Object.entries(data.users)) {
    if (!/^\d{1,15}$/.test(userId)) throw new Error("invalid prefs user");
    if (!validPrefKeys(prefs?.favorites) || !validPrefKeys(prefs?.muted) || !validDnd(prefs?.dnd)) throw new Error("invalid prefs");
  }
  return data;
}

function prefsOf(record) {
  return {
    favorites: [...(record?.favorites || [])],
    muted: [...(record?.muted || [])],
    dnd: record?.dnd ? { ...record.dnd } : { ...DEFAULT_DND },
  };
}

export function createPrefsStore(filePath) {
  const store = createJsonStore(filePath, { empty: () => ({ version: 1, users: {} }), validate: validatePrefs });
  return {
    async get(userId) {
      return prefsOf((await store.read()).users[String(userId)]);
    },
    // change: { favorites?, muted?, dnd? }, already validated by the caller.
    async update(userId, change) {
      return store.update((data) => {
        const next = prefsOf(data.users[String(userId)]);
        if (change.favorites) next.favorites = [...new Set(change.favorites)];
        if (change.muted) next.muted = [...new Set(change.muted)];
        if (change.dnd) next.dnd = { enabled: change.dnd.enabled, from: change.dnd.from, to: change.dnd.to, weekends: change.dnd.weekends };
        data.users[String(userId)] = next;
        return { changed: true, prefs: prefsOf(next) };
      });
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
      return (await store.read()).notices[key] || null;
    },
    async set(key, notice) {
      return store.update((data) => {
        data.notices[key] = { messageId: notice.messageId, setBy: notice.setBy, setAt: notice.setAt };
        return { changed: true };
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
