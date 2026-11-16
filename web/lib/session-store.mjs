// M3: keeps signed-in sessions across server restarts in web/data/sessions.json,
// encrypted with AES-256-GCM (key: SESSION_KEY). Nothing in the file is readable without
// the key; a wrong key or a damaged file is ignored (start with no sessions), never fatal.
// Event-queue ids are not stored: a restarted server registers a new Zulip queue.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const AAD = Buffer.from("sangsangtalk-sessions-v1");
const FIELDS = ["sid", "email", "userId", "fullName", "apiKey", "expiresAt", "peer"];

export function encryptSessions(key, records) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const data = Buffer.concat([cipher.update(JSON.stringify(records), "utf8"), cipher.final()]);
  return {
    version: 1,
    alg: "AES-256-GCM",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

export function decryptSessions(key, payload) {
  if (payload?.version !== 1 || payload.alg !== "AES-256-GCM") throw new Error("format");
  const iv = Buffer.from(String(payload.iv), "base64");
  const tag = Buffer.from(String(payload.tag), "base64");
  // Fixed sizes: a truncated tag must not be accepted as a weaker check.
  if (iv.length !== 12 || tag.length !== 16) throw new Error("format");
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  decipher.setAAD(AAD);
  decipher.setAuthTag(tag);
  const text = Buffer.concat([decipher.update(Buffer.from(payload.data, "base64")), decipher.final()]).toString("utf8");
  const records = JSON.parse(text);
  if (!Array.isArray(records)) throw new Error("format");
  return records;
}

function validRecord(record, now) {
  return record
    && typeof record.sid === "string" && /^[a-f0-9]{64}$/.test(record.sid)
    && typeof record.email === "string" && typeof record.apiKey === "string"
    && Number.isInteger(record.userId) && Number.isFinite(record.expiresAt) && record.expiresAt > now;
}

export function createSessionStore({ file, key, log = () => {} }) {
  let tail = Promise.resolve();

  // Returns valid, unexpired records. Any failure means "no saved sessions".
  async function load() {
    if (!key) return [];
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") log(`세션 파일을 읽지 못해 새로 시작합니다 (${error.code || error.message}).`);
      return [];
    }
    try {
      const now = Date.now();
      return decryptSessions(key, JSON.parse(text)).filter((record) => validRecord(record, now));
    } catch {
      log("세션 파일을 풀 수 없어(키가 다르거나 파일이 손상됨) 무시하고 새로 시작합니다.");
      return [];
    }
  }

  // Writes are queued and atomic (temporary file, then rename), owner-only where the OS supports it.
  // Resolves { ok, invalid, error }: `invalid` counts unexpired records left out because they
  // failed validation (expired ones are dropped silently); the caller logs and retries on !ok.
  function save(records) {
    if (!key) return Promise.resolve({ ok: true, invalid: 0 });
    const now = Date.now();
    const unexpired = records.filter((record) => !(Number.isFinite(record?.expiresAt) && record.expiresAt <= now));
    const kept = unexpired
      .filter((record) => validRecord(record, now))
      .map((record) => Object.fromEntries(FIELDS.map((field) => [field, record[field] ?? null])));
    const invalid = unexpired.length - kept.length;
    const run = async () => {
      const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      try {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(temporary, `${JSON.stringify(encryptSessions(key, kept))}\n`, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, file);
        return { ok: true, invalid };
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {});
        return { ok: false, invalid, error: error.code || error.message };
      }
    };
    const result = tail.then(run, run);
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  return { enabled: Boolean(key), load, save };
}
