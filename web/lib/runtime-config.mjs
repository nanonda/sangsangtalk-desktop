// Environment settings for web/server.mjs (docs/migration-prep.md M2–M4).
// Every value is optional; with none set the server behaves exactly as in development:
// 127.0.0.1 + ::1 on 43123, Host-header origin check, local Zulip with its self-signed certificate.
// Pure apart from reading ZULIP_CA_FILE, so it can be checked without starting the server.
import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";

export const DEV_ZULIP_HOST = "localhost.localdomain";

class ConfigError extends Error {}

function parseHosts(value) {
  const hosts = String(value || "127.0.0.1,::1").split(",").map((host) => host.trim()).filter(Boolean);
  if (!hosts.length) throw new ConfigError("HOST에 주소가 없습니다.");
  for (const host of hosts) {
    if (!/^[A-Za-z0-9.:-]+$/.test(host)) throw new ConfigError(`HOST 값이 올바르지 않습니다: ${host}`);
  }
  return [...new Set(hosts)];
}

function parsePort(value) {
  const port = Number(value || 43123);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError(`PORT 값이 올바르지 않습니다: ${value}`);
  return port;
}

// "https://talk.eumseong.local" — scheme + host (+ port) only.
function parsePublicOrigin(value) {
  if (!value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`PUBLIC_ORIGIN 값이 올바르지 않습니다: ${value}`);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
    || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new ConfigError(`PUBLIC_ORIGIN은 https://이름[:포트] 형식이어야 합니다(경로 없음): ${value}`);
  }
  return url.origin;
}

// Same shape rule as PUBLIC_ORIGIN: https, host (+ port), nothing else.
function parseZulipOrigin(value) {
  let url;
  try {
    url = new URL(value || `https://${DEV_ZULIP_HOST}:9991`);
  } catch {
    throw new ConfigError(`ZULIP_ORIGIN 값이 올바르지 않습니다: ${value}`);
  }
  if (url.protocol !== "https:" || url.username || url.password
    || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new ConfigError(`ZULIP_ORIGIN은 https://이름[:포트] 형식이어야 합니다(경로·사용자 정보·쿼리 없음): ${value}`);
  }
  return url;
}

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|localhost)$/i;

// Every certificate in the PEM bundle must parse, so a wrong file fails at startup, not at the first request.
function parseCaBundle(ca, caFile) {
  const blocks = ca.toString("utf8").match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
  if (!blocks.length) throw new ConfigError(`ZULIP_CA_FILE이 PEM 인증서가 아닙니다: ${caFile}`);
  blocks.forEach((block, index) => {
    try {
      new X509Certificate(block);
    } catch (error) {
      throw new ConfigError(`ZULIP_CA_FILE의 ${index + 1}번째 인증서를 읽지 못했습니다: ${caFile} (${error.message})`);
    }
  });
  return blocks.length;
}

// M4: an explicit CA verifies; ZULIP_TLS_INSECURE=1 turns checks off; otherwise only the
// default development address skips verification (its self-signed certificate).
function zulipTls(zulipUrl, caFile, insecure, warnings) {
  const insecureOn = insecure === "1" || String(insecure).toLowerCase() === "true";
  if (caFile) {
    let ca;
    try {
      ca = readFileSync(caFile);
    } catch (error) {
      throw new ConfigError(`ZULIP_CA_FILE을 읽지 못했습니다: ${caFile} (${error.code || error.message})`);
    }
    parseCaBundle(ca, caFile);
    if (insecureOn) warnings.push("ZULIP_CA_FILE과 ZULIP_TLS_INSECURE가 함께 있어 CA 검증을 사용합니다.");
    return { rejectUnauthorized: true, ca, mode: `verify (CA ${caFile})` };
  }
  if (insecureOn) {
    warnings.push("ZULIP_TLS_INSECURE=1: Zulip 인증서를 검증하지 않습니다(개발용).");
    return { rejectUnauthorized: false, ca: undefined, mode: "insecure (ZULIP_TLS_INSECURE)" };
  }
  if (zulipUrl.hostname === DEV_ZULIP_HOST) {
    return { rejectUnauthorized: false, ca: undefined, mode: "insecure (local development Zulip)" };
  }
  return { rejectUnauthorized: true, ca: undefined, mode: "verify (system CA)" };
}

// SESSION_KEY: 32 bytes, standard base64. Empty -> sessions stay in memory (one warning).
// Set but wrong -> refuse to start, like any other bad setting (never silently fall back).
function parseSessionKey(value, warnings) {
  const text = String(value || "").trim();
  if (!text) {
    warnings.push("SESSION_KEY가 없어 세션을 메모리에만 둡니다(서버를 다시 켜면 다시 로그인해야 함).");
    return null;
  }
  // Buffer.from(..., "base64") skips invalid characters, so check the text itself first.
  const key = /^[A-Za-z0-9+/]+={0,2}$/.test(text) && text.length % 4 === 0 ? Buffer.from(text, "base64") : null;
  if (!key || key.length !== 32 || key.toString("base64") !== text) {
    throw new ConfigError("SESSION_KEY는 32바이트를 base64로 쓴 값이어야 합니다(44자). 비워 두면 메모리 세션을 씁니다.");
  }
  return key;
}

// Whole number in [min, max]; empty -> fallback.
function parseWhole(name, value, fallback, min, max) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const number = Number(String(value).trim());
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new ConfigError(`${name}는 ${min}~${max} 사이의 정수여야 합니다: ${value}`);
  }
  return number;
}

// "korea.local": a host name with at least one dot, letters / digits / hyphens only. Lowercased.
function parseLoginDomain(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return null;
  const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
  if (text.length > 190 || !new RegExp(`^${label}(?:\\.${label})+$`).test(text)) {
    throw new ConfigError(`LOGIN_DOMAIN은 korea.local 같은 도메인 이름이어야 합니다(@ 없이): ${value}`);
  }
  return text;
}

export function loadConfig(env = process.env) {
  const warnings = [];
  const zulipUrl = parseZulipOrigin(env.ZULIP_ORIGIN);
  const publicOrigin = parsePublicOrigin(env.PUBLIC_ORIGIN);
  const hosts = parseHosts(env.HOST);
  if (!publicOrigin && hosts.some((host) => !LOOPBACK.test(host))) {
    warnings.push("loopback이 아닌 HOST로 평문 HTTP를 외부에 노출합니다. 앞에 HTTPS 프록시를 두고 PUBLIC_ORIGIN을 설정하세요.");
  }
  return {
    port: parsePort(env.PORT),
    hosts,
    publicOrigin,
    secureCookie: Boolean(publicOrigin && publicOrigin.startsWith("https:")),
    zulipUrl,
    tls: zulipTls(zulipUrl, env.ZULIP_CA_FILE, env.ZULIP_TLS_INSECURE, warnings),
    sessionKey: parseSessionKey(env.SESSION_KEY, warnings),
    // M14: only exactly "1" turns it on. A guide for staff, not a security control (headers can be forged).
    appOnlyLogin: env.APP_ONLY_LOGIN === "1",
    // P2 C2: months of audit files kept (older ones are deleted at startup).
    auditKeepMonths: parseWhole("AUDIT_KEEP_MONTHS", env.AUDIT_KEEP_MONTHS, 12, 1, 120),
    // P2 C3: watermark on unless exactly "0".
    watermark: env.WATERMARK !== "0",
    // P2 C4: lock screen after this many idle minutes; 0 turns it off.
    autoLockMinutes: parseWhole("AUTO_LOCK_MINUTES", env.AUTO_LOCK_MINUTES, 30, 0, 1440),
    // P2 C1: internal domain of login IDs (<employee no.>@<domain>); empty -> null.
    loginDomain: parseLoginDomain(env.LOGIN_DOMAIN),
    warnings,
  };
}

export { ConfigError };
