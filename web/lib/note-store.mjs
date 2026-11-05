import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// Local note index. Same methods can later be backed by PostgreSQL.
// Records contain only Zulip message ids and user ids, never message text or secrets.

function storeError(reason) {
  const error = new Error(reason || "notes store is unreadable");
  error.code = "NOTES_STORE";
  return error;
}

function validate(data) {
  if (!data || data.version !== 1 || !Array.isArray(data.notes)) throw storeError("invalid notes store");
  for (const note of data.notes) {
    if (!Number.isInteger(note.messageId) || note.messageId <= 0) throw storeError("invalid message id");
    if (!Number.isInteger(note.senderId) || !Number.isInteger(note.recipientId)) throw storeError("invalid participant");
    if (note.senderId === note.recipientId) throw storeError("invalid participant");
    if (!Number.isInteger(note.timestamp) || note.timestamp <= 0) throw storeError("invalid timestamp");
  }
  return data;
}

async function readOptional(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function createNoteStore(filePath) {
  let chain = Promise.resolve();
  const exclusive = (task) => {
    const run = chain.then(task, task);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };

  async function load() {
    const primary = await readOptional(filePath);
    const backup = await readOptional(`${filePath}.bak`);
    if (primary === null && backup === null) return { version: 1, notes: [] };
    try {
      return validate(JSON.parse(primary ?? backup));
    } catch (error) {
      if (error.code === "NOTES_STORE") throw error;
      throw storeError("corrupt notes store");
    }
  }

  async function save(data) {
    validate(data);
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp`;
    const backup = `${filePath}.bak`;
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
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
    async add(note) {
      return exclusive(async () => {
        const record = {
          messageId: note.messageId,
          senderId: note.senderId,
          recipientId: note.recipientId,
          timestamp: note.timestamp,
        };
        validate({ version: 1, notes: [record] });
        const data = await load();
        if (!data.notes.some((item) => item.messageId === record.messageId)) {
          data.notes.push(record);
          data.notes.sort((a, b) => a.messageId - b.messageId);
          await save(data);
        }
        return record;
      });
    },
    async listForUser(userId) {
      return exclusive(async () => {
        const data = await load();
        return data.notes.filter((note) => note.senderId === userId || note.recipientId === userId);
      });
    },
  };
}
