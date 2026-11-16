// Streaming upload/download between the browser and Zulip.
// Uploads use Zulip's tus endpoint (/api/v1/tus): the plain /api/v1/user_uploads
// route sits behind nginx's 25 MB body limit, while tus streams up to the
// server's MAX_FILE_UPLOAD_SIZE. The request body is piped chunk by chunk and
// never buffered whole.
import https from "node:https";
import { INLINE_IMAGE_TYPES, contentDisposition, downloadName } from "./files.mjs";

const RATE_LIMITED = "요청이 너무 많습니다. 잠시 후 다시 시도하세요.";
const BLOCKED = "이 형식의 파일은 내려받을 수 없습니다.";

function failure(status, publicMessage, name) {
  return Object.assign(new Error(name), { status, publicMessage });
}

export function createZulipFiles(zulipUrl) {
  function request(method, apiPath, headers, { timeoutMs = 30000 } = {}) {
    return https.request({
      hostname: zulipUrl.hostname,
      port: zulipUrl.port || 443,
      servername: zulipUrl.hostname,
      method,
      path: apiPath,
      headers: { "user-agent": "SangsangTalk/0.1", ...headers },
      rejectUnauthorized: false,
      timeout: timeoutMs,
    });
  }

  function simple(method, apiPath, headers) {
    return new Promise((resolve, reject) => {
      const req = request(method, apiPath, headers);
      req.on("response", (res) => {
        if (res.statusCode === 429) {
          res.resume();
          reject(failure(429, RATE_LIMITED, "rate"));
          return;
        }
        const chunks = [];
        res.on("data", (c) => { if (chunks.length < 64) chunks.push(c); });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { timeout: true })));
      req.on("error", reject);
      req.end();
    });
  }

  function tusPath(location) {
    try {
      const target = new URL(location, zulipUrl);
      if (target.hostname !== zulipUrl.hostname) return "";
      return target.pathname.startsWith("/api/v1/tus/") ? target.pathname : "";
    } catch {
      return "";
    }
  }

  // Resolves { status, json } from Zulip, or { status: 413 } when `limit` is exceeded mid-stream.
  async function upload(browserRequest, { auth, name, type, size, limit }) {
    // Watch for the browser giving up from the very start: a cancel during the tus
    // "create" round trip would otherwise leave the PATCH waiting for a body that never comes.
    let cancelled = browserRequest.destroyed;
    let onCancel = () => {};
    const markCancelled = () => {
      if (browserRequest.complete) return;
      cancelled = true;
      onCancel();
    };
    browserRequest.on("aborted", markCancelled);
    browserRequest.on("close", markCancelled);
    const cancelledError = () => Object.assign(new Error("aborted"), { aborted: true });

    const b64 = (text) => Buffer.from(text, "utf8").toString("base64");
    const created = await simple("POST", "/api/v1/tus", {
      authorization: auth,
      "tus-resumable": "1.0.0",
      "upload-length": String(size),
      "upload-metadata": `filename ${b64(name)},filetype ${b64(type)}`,
      "content-length": "0",
    });
    if (created.status !== 201) {
      let message = "";
      try { message = JSON.parse(created.text).message || ""; } catch { message = created.text.slice(0, 200); }
      return { status: created.status, error: message };
    }
    const location = tusPath(created.headers.location || "");
    if (!location) return { status: 502 };
    const terminate = () => {
      simple("DELETE", location, { authorization: auth, "tus-resumable": "1.0.0" }).catch(() => {});
    };
    if (cancelled) {
      terminate();
      throw cancelledError();
    }

    return await new Promise((resolve, reject) => {
      let done = false;
      let sent = 0;
      const finish = (fn, value) => {
        if (done) return;
        done = true;
        fn(value);
      };
      const upstream = request("PATCH", location, {
        authorization: auth,
        "tus-resumable": "1.0.0",
        "upload-offset": "0",
        "content-type": "application/offset+octet-stream",
        "content-length": String(size),
      }, { timeoutMs: 10 * 60 * 1000 });
      upstream.on("response", (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { json = null; }
          finish(resolve, { status: res.statusCode, json });
        });
      });
      upstream.on("timeout", () => upstream.destroy(Object.assign(new Error("timeout"), { timeout: true })));
      upstream.on("error", (error) => {
        terminate();
        finish(reject, error);
      });
      browserRequest.on("data", (chunk) => {
        sent += chunk.length;
        if (sent > limit || sent > size) {
          browserRequest.pause();
          upstream.destroy();
          terminate();
          finish(resolve, { status: 413 });
          return;
        }
        if (!upstream.write(chunk)) {
          browserRequest.pause();
          upstream.once("drain", () => browserRequest.resume());
        }
      });
      browserRequest.on("end", () => upstream.end());
      onCancel = () => {
        upstream.destroy();
        terminate();
        finish(reject, cancelledError());
      };
      browserRequest.on("error", (error) => {
        upstream.destroy();
        terminate();
        finish(reject, error);
      });
    });
  }

  // Streams /user_uploads/... to the browser. Returns false if Zulip has no such file for this user.
  async function download(uploadPath, { auth, inline, name }, response) {
    const fileName = downloadName(uploadPath, name);
    if (!fileName) throw failure(415, BLOCKED, "blocked");
    const signed = await simple("GET", `/api/v1${uploadPath}`, { authorization: auth, accept: "application/json" });
    if (signed.status === 401) throw Object.assign(new Error("auth"), { status: 401 });
    let temporary = "";
    try {
      const url = JSON.parse(signed.text).url;
      const target = new URL(url, zulipUrl);
      if (target.hostname === zulipUrl.hostname && target.pathname.startsWith("/user_uploads/temporary/")) {
        temporary = `${target.pathname}${target.search}`;
      }
    } catch {
      temporary = "";
    }
    if (signed.status !== 200 || !temporary) return false;

    return await new Promise((resolve, reject) => {
      const upstream = request("GET", temporary, { accept: "*/*" }, { timeoutMs: 10 * 60 * 1000 });
      upstream.on("response", (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(false);
          return;
        }
        const type = String(res.headers["content-type"] || "application/octet-stream").split(";")[0].trim().toLowerCase();
        const showInline = inline && INLINE_IMAGE_TYPES.has(type);
        const headers = {
          "content-type": showInline ? type : (res.headers["content-type"] || "application/octet-stream"),
          "content-disposition": contentDisposition(showInline ? "inline" : "attachment", fileName),
          "x-content-type-options": "nosniff",
          "content-security-policy": "sandbox; default-src 'none'",
          "cache-control": "private, max-age=300",
        };
        if (res.headers["content-length"]) headers["content-length"] = res.headers["content-length"];
        response.writeHead(200, headers);
        res.pipe(response);
        res.on("end", () => resolve(true));
        // Headers are already sent: the only honest signal left is to cut the connection
        // (the browser sees an incomplete download). Never reject here — the caller can't reply anymore.
        res.on("error", () => {
          response.destroy();
          resolve(true);
        });
        res.on("aborted", () => {
          response.destroy();
          resolve(true);
        });
        response.on("close", () => {
          if (!response.writableEnded) upstream.destroy();
          resolve(true);
        });
      });
      upstream.on("timeout", () => upstream.destroy(Object.assign(new Error("timeout"), { timeout: true })));
      upstream.on("error", (error) => {
        if (response.headersSent) {
          response.destroy();
          resolve(true);
        } else reject(error);
      });
      upstream.end();
    });
  }

  return { upload, download };
}
