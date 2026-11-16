// File helpers shared by the upload/download proxy and message normalization.
// No I/O here, so these can be checked without Zulip.
import path from "node:path";

export const BLOCKED_EXTENSIONS = new Set([
  ".exe", ".bat", ".cmd", ".ps1", ".js", ".vbs", ".msi", ".scr", ".com", ".jar",
]);

const TYPES_BY_EXT = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".zip": "application/zip",
  ".hwp": "application/x-hwp",
  ".hwpx": "application/hwp+zip",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

// Raster images only: SVG/HTML must never be served inline from our origin.
export const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function guessType(name) {
  return TYPES_BY_EXT[path.extname(String(name || "")).toLowerCase()] || "";
}

// One normalization for every extension decision: NFKC folds full-width letters
// ("a.ｅｘｅ" -> "a.exe"), and Windows drops trailing dots and spaces ("a.exe . " -> "a.exe").
function normalizedName(name) {
  return String(name || "").normalize("NFKC").replace(/[.\s]+$/u, "");
}

// A name that is only an extension (".exe", or Zulip's ".png" for a Korean-only name)
// counts as having that extension; path.extname() would say it has none.
export function extensionOf(name) {
  const base = normalizedName(name).toLowerCase();
  return base.lastIndexOf(".") === 0 ? base : path.extname(base);
}

export function isBlockedName(name) {
  return BLOCKED_EXTENSIONS.has(extensionOf(name));
}

// Bidirectional-text controls can make "gpj.exe" display as "exe.jpg".
const BIDI_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/g;

// x-file-name is encodeURIComponent(name). Strip path parts and control/markdown-breaking characters.
export function cleanFileName(header) {
  let name = "";
  try {
    name = decodeURIComponent(String(header || ""));
  } catch {
    return "";
  }
  name = name.normalize("NFKC").split(/[\\/]/).pop() || "";
  name = name.replace(/[\x00-\x1f\x7f]/g, "").replace(BIDI_CONTROLS, "").replace(/\[/g, "(").replace(/\]/g, ")");
  name = name.replace(/[:*?"<>|]/g, "_").trim();
  name = normalizedName(name).slice(0, 200).replace(/[.\s]+$/u, "");
  if (!name || name === "." || name === "..") return "";
  return name;
}

// Accepts "/user_uploads/<realm>/<seg>/.../<file>" with already-percent-encoded segments.
// Returns a canonical re-encoded path, or "" when the path is not a plain upload path.
export function canonicalUploadPath(raw) {
  if (typeof raw !== "string" || !raw.startsWith("/user_uploads/")) return "";
  if (raw.includes("?") || raw.includes("#") || raw.includes("\\")) return "";
  const parts = raw.slice("/user_uploads/".length).split("/");
  if (parts.length < 2 || !/^\d+$/.test(parts[0])) return "";
  const out = [];
  for (const part of parts) {
    let decoded;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      return "";
    }
    if (!decoded || decoded === "." || decoded === ".." || /[\\/\x00-\x1f]/.test(decoded)) return "";
    out.push(encodeURIComponent(decoded));
  }
  if (out[1] === "temporary") return "";
  return `/user_uploads/${out.join("/")}`;
}

export function fileNameFromPath(uploadPath) {
  const last = uploadPath.split("/").pop() || "file";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

// RFC 8187 ext-value: encodeURIComponent leaves ' ( ) * ! unescaped, but only attr-chars may appear raw.
function rfc8187(value) {
  return encodeURIComponent(value).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function contentDisposition(kind, name) {
  const ascii = String(name).replace(/[^\x20-\x7e]|["\\;]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${rfc8187(name)}`;
}

// Zulip strips non-ASCII characters from stored file names, so the original name
// rides along as ?name= and is used for the download only when its extension
// matches the stored file's (a crafted link cannot turn report.txt into report.exe).
export function attachmentUrl(uploadPath, name) {
  return `/api/files${uploadPath}?name=${encodeURIComponent(name)}`;
}

// Returns "" when the file must not be handed out at all (a blocked type, e.g. a .exe
// uploaded straight through Zulip's own UI, which bypasses our upload check).
export function downloadName(uploadPath, requested) {
  let stored = fileNameFromPath(uploadPath);
  if (isBlockedName(stored)) return "";
  if (stored.startsWith(".")) stored = `file${stored}`;
  const name = cleanFileName(encodeURIComponent(String(requested || "")));
  const chosen = name && extensionOf(name) === extensionOf(stored) ? name : stored;
  return isBlockedName(chosen) ? "" : chosen;
}

const ATTACHMENT_LINE =/^\[([^\]\n]+)\]\((\/user_uploads\/[^)\s]+)\)$/;

// Moves "[name](/user_uploads/...)" lines out of the message body.
export function splitAttachments(content) {
  const attachments = [];
  const kept = [];
  for (const line of String(content || "").split("\n")) {
    const match = line.trim().match(ATTACHMENT_LINE);
    const uploadPath = match ? canonicalUploadPath(match[2]) : "";
    if (uploadPath) {
      attachments.push({ name: match[1], url: attachmentUrl(uploadPath, match[1]), size: null, type: guessType(match[1]) });
    } else {
      kept.push(line);
    }
  }
  return { content: kept.join("\n").trim(), attachments };
}

// Validates attachments sent with POST /api/messages and renders the Zulip link lines.
export function attachmentLines(list) {
  if (list === undefined || list === null) return { lines: [], attachments: [] };
  if (!Array.isArray(list) || list.length > 20) return null;
  const lines = [];
  const attachments = [];
  for (const item of list) {
    const uploadPath = canonicalUploadPath(item?.path);
    const name = cleanFileName(encodeURIComponent(String(item?.name || ""))) || fileNameFromPath(uploadPath || "/x");
    if (!uploadPath) return null;
    lines.push(`[${name}](${uploadPath})`);
    const size = Number.isInteger(item.size) && item.size >= 0 ? item.size : null;
    const type = typeof item.type === "string" && item.type.length < 200 ? item.type : guessType(name);
    attachments.push({ name, url: attachmentUrl(uploadPath, name), size, type });
  }
  return { lines, attachments };
}
