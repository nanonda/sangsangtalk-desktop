// N6 activity centre records that Zulip cannot answer by search: replies (made through POST /api/messages
// with replyToId) and reactions (made through our reaction API) to someone's message.
// web/data/activity.json:
// { version: 1, users: { "<ownerId>": { seenAt: <seconds>, seenIds?: [itemId], items: [{ id, kind, at, view, userId?, groupId?, messageId, actorId, emoji? }] } } }
// seenAt: everything up to then is seen ("모두 확인" / upTo). seenIds: single items seen after that (any kind,
// mention / keyword / notice included), newest SEEN_IDS_MAX kept.
// ownerId is the person the activity is for (the author of the original message). No message text is stored:
// the server reads the excerpt from Zulip when the list is asked for.
// notices?: [{ key, messageId, setBy, setAt, ackRequired }] — every notice set (one record per room, not per person;
// who sees it is decided when the list is read: current room members except the setter). Kept when the notice is
// replaced or removed; ACTIVITY_DAYS days and ACTIVITY_PER_KIND per room.
import { createJsonStore } from "./json-store.mjs";

export const ACTIVITY_DAYS = 30;
export const ACTIVITY_PER_KIND = 200;
const STORED_KINDS = ["reply", "reaction"];
const ITEM_ID = /^(reply|reaction):[0-9a-z_:]{1,80}$/;
export const ACTIVITY_ID = /^(mention|keyword|reply|reaction|notice):[0-9a-z_:]{1,80}$/;
const SEEN_IDS_MAX = 1000;
const NOTICE_KEY = /^(general|dm:\d{1,15}-\d{1,15}|group:\d{1,15})$/;

function validNotice(notice) {
  return notice && typeof notice === "object" && typeof notice.key === "string" && NOTICE_KEY.test(notice.key)
    && ["messageId", "setBy", "setAt"].every((field) => Number.isSafeInteger(notice[field]) && notice[field] > 0)
    && typeof notice.ackRequired === "boolean";
}

function pruneNotices(notices, nowSec) {
  const cutoff = nowSec - ACTIVITY_DAYS * 86400;
  const perRoom = {};
  return notices.filter((notice) => notice.setAt >= cutoff).sort((a, b) => b.setAt - a.setAt).filter((notice) => {
    perRoom[notice.key] = (perRoom[notice.key] || 0) + 1;
    return perRoom[notice.key] <= ACTIVITY_PER_KIND;
  });
}

function validItem(item) {
  return item && typeof item === "object" && STORED_KINDS.includes(item.kind) && typeof item.id === "string" && ITEM_ID.test(item.id)
    && Number.isSafeInteger(item.at) && item.at > 0 && ["general", "dm", "group"].includes(item.view)
    && Number.isSafeInteger(item.messageId) && item.messageId > 0 && Number.isSafeInteger(item.actorId) && item.actorId > 0
    && (item.userId === undefined || Number.isSafeInteger(item.userId))
    && (item.groupId === undefined || Number.isSafeInteger(item.groupId))
    && (item.emoji === undefined || (typeof item.emoji === "string" && /^[a-z_]{1,40}$/.test(item.emoji)));
}

function validate(data) {
  if (!data || data.version !== 1 || !data.users || typeof data.users !== "object" || Array.isArray(data.users)) {
    throw new Error("invalid activity store");
  }
  if (data.notices !== undefined && (!Array.isArray(data.notices) || !data.notices.every(validNotice))) throw new Error("invalid activity notices");
  for (const [userId, record] of Object.entries(data.users)) {
    if (!/^\d{1,15}$/.test(userId) || !record || !Number.isSafeInteger(record.seenAt) || record.seenAt < 0 || !Array.isArray(record.items)) {
      throw new Error("invalid activity user");
    }
    if (!record.items.every(validItem)) throw new Error("invalid activity item");
    if (record.seenIds !== undefined && (!Array.isArray(record.seenIds) || !record.seenIds.every((id) => typeof id === "string" && ACTIVITY_ID.test(id)))) {
      throw new Error("invalid activity seenIds");
    }
  }
  return data;
}

// Keeps the last ACTIVITY_DAYS days and at most ACTIVITY_PER_KIND per kind (newest kept).
function prune(items, nowSec) {
  const cutoff = nowSec - ACTIVITY_DAYS * 86400;
  const sorted = items.filter((item) => item.at >= cutoff).sort((a, b) => b.at - a.at);
  const counts = {};
  return sorted.filter((item) => {
    counts[item.kind] = (counts[item.kind] || 0) + 1;
    return counts[item.kind] <= ACTIVITY_PER_KIND;
  });
}

export function createActivityStore(filePath) {
  const store = createJsonStore(filePath, { empty: () => ({ version: 1, users: {} }), validate });
  const recordOf = (data, ownerId) => {
    const key = String(ownerId);
    data.users[key] ||= { seenAt: 0, items: [] };
    return data.users[key];
  };
  return {
    // { seenAt, items } for one person (items newest first, pruned).
    async get(ownerId) {
      const record = (await store.read()).users[String(ownerId)];
      return { seenAt: record?.seenAt || 0, seenIds: new Set(record?.seenIds || []), items: prune(record?.items || [], Math.floor(Date.now() / 1000)) };
    },
    // N6 notice records (newest first, pruned).
    async notices() {
      return pruneNotices((await store.read()).notices || [], Math.floor(Date.now() / 1000));
    },
    // Records a notice being set. The same message set again in the same room moves to the new time.
    async addNotice(notice) {
      const record = { key: notice.key, messageId: notice.messageId, setBy: notice.setBy, setAt: notice.setAt, ackRequired: Boolean(notice.ackRequired) };
      if (!validNotice(record)) throw Object.assign(new Error("invalid activity notice"), { code: "JSON_STORE" });
      return store.update((data) => {
        const others = (data.notices || []).filter((one) => !(one.key === record.key && one.messageId === record.messageId));
        data.notices = pruneNotices([...others, record], Math.floor(Date.now() / 1000));
        return { changed: true };
      });
    },
    // Adds (or replaces, same id) one item. Returns true when it is new.
    async add(ownerId, item) {
      if (!validItem(item)) throw Object.assign(new Error("invalid activity item"), { code: "JSON_STORE" });
      const result = await store.update((data) => {
        const record = recordOf(data, ownerId);
        const existed = record.items.some((one) => one.id === item.id);
        record.items = prune([...record.items.filter((one) => one.id !== item.id), { ...item }], Math.floor(Date.now() / 1000));
        return { changed: true, added: !existed };
      });
      return result.added;
    },
    async remove(ownerId, id) {
      const result = await store.update((data) => {
        const record = data.users[String(ownerId)];
        if (!record || !record.items.some((one) => one.id === id)) return { changed: false };
        record.items = record.items.filter((one) => one.id !== id);
        return { changed: true };
      });
      return Boolean(result.changed);
    },
    // Drops every item made by this message (a recalled reply). Returns the owner ids touched.
    async removeMessage(messageId) {
      const result = await store.update((data) => {
        const owners = [];
        for (const [ownerId, record] of Object.entries(data.users)) {
          const before = record.items.length;
          record.items = record.items.filter((one) => !(one.kind === "reply" && one.messageId === messageId));
          if (record.items.length !== before) owners.push(Number(ownerId));
        }
        return { changed: owners.length > 0, owners };
      });
      return result.owners;
    },
    // Single items seen (ids already checked by the caller).
    async seenIds(ownerId, ids) {
      return store.update((data) => {
        const record = recordOf(data, ownerId);
        const before = record.seenIds || [];
        const next = [...before.filter((id) => !ids.includes(id)), ...ids].slice(-SEEN_IDS_MAX);
        if (next.length === before.length && next.every((id, n) => id === before[n])) return { changed: false };
        record.seenIds = next;
        return { changed: true };
      });
    },
    // Everything up to and including `at` (seconds) counts as seen. Never moves backwards.
    async seen(ownerId, at) {
      return store.update((data) => {
        const record = recordOf(data, ownerId);
        if (at <= record.seenAt) return { changed: false, seenAt: record.seenAt };
        record.seenAt = at;
        return { changed: true, seenAt: at };
      });
    },
  };
}
