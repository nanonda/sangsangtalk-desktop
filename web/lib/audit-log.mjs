import { appendFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

// C2 audit log: one JSON line per action in <dir>/YYYY-MM.jsonl (UTC month).
//   { at, userId, ip, action, target, ok }
// Never message text or passwords: callers pass ids and login ids only.
// Writes are serialised and never throw (a failed write is reported through `log`).

const FILE = /^(\d{4})-(\d{2})\.jsonl$/;
const ACTION = /^[a-z_]{1,40}$/;

function monthOf(date) {
  return date.toISOString().slice(0, 7);
}

export function createAuditLog({ dir, keepMonths = 12, log = () => {} }) {
  let chain = Promise.resolve();
  const exclusive = (task) => {
    const run = chain.then(task, task);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };

  function write(entry) {
    const record = {
      at: new Date().toISOString(),
      userId: Number.isSafeInteger(entry.userId) ? entry.userId : null,
      ip: String(entry.ip || "").slice(0, 64),
      action: ACTION.test(entry.action) ? entry.action : "unknown",
      target: entry.target === undefined || entry.target === null ? "" : String(entry.target).replace(/[\r\n]/g, " ").slice(0, 200),
      ok: entry.ok !== false,
    };
    return exclusive(async () => {
      try {
        await mkdir(dir, { recursive: true });
        await appendFile(path.join(dir, `${monthOf(new Date(record.at))}.jsonl`), `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
      } catch (error) {
        log(`감사 로그를 쓰지 못했습니다 (${error.code || error.message}).`);
      }
    });
  }

  // Deletes month files older than keepMonths (the current month counts as one). Run at startup.
  async function prune(now = new Date()) {
    const oldest = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (keepMonths - 1), 1));
    const oldestMonth = monthOf(oldest);
    let names = [];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (error.code === "ENOENT") return 0;
      throw error;
    }
    let removed = 0;
    for (const name of names) {
      const match = name.match(FILE);
      if (!match || `${match[1]}-${match[2]}` >= oldestMonth) continue;
      await rm(path.join(dir, name), { force: true });
      removed += 1;
    }
    return removed;
  }

  // from / to: "YYYY-MM-DD" (inclusive, UTC). action: exact, or a prefix ending in "*" ("admin_*").
  // Newest first, at most `limit`.
  async function query({ from = "", to = "", userId = null, action = "", limit = 1000 } = {}) {
    let names = [];
    try {
      names = (await readdir(dir)).filter((name) => FILE.test(name)).sort().reverse();
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const entries = [];
    for (const name of names) {
      const month = name.slice(0, 7);
      if (from && month < from.slice(0, 7)) break;
      if (to && month > to.slice(0, 7)) continue;
      const lines = (await readFile(path.join(dir, name), "utf8")).split("\n").filter(Boolean).reverse();
      for (const line of lines) {
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        const day = String(entry.at || "").slice(0, 10);
        if ((from && day < from) || (to && day > to)) continue;
        if (userId !== null && entry.userId !== userId) continue;
        if (action && (action.endsWith("*") ? !String(entry.action).startsWith(action.slice(0, -1)) : entry.action !== action)) continue;
        entries.push(entry);
        if (entries.length >= limit) return entries;
      }
    }
    return entries;
  }

  return { write, prune, query, flush: () => exclusive(async () => {}) };
}
