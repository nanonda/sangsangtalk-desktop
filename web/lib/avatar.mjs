// P1 profile photo (docs/p3-contract.md): POST /api/me/avatar is multipart/form-data with one file,
// png or jpg, at most 5MB. Pure helpers shared by web/server.mjs and web/dev/mock-server.mjs.
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024; // Zulip MAX_AVATAR_FILE_SIZE_MIB = 5
export const AVATAR_ERRORS = {
  type: "사진은 PNG나 JPG 파일만 올릴 수 있습니다.",
  size: "사진은 5MB까지 올릴 수 있습니다.",
  missing: "사진 파일을 하나 고르세요.",
  disabled: "기관 설정으로 사진을 바꿀 수 없습니다.",
};

// The file's own bytes decide the type (the browser's declared type is not trusted).
export function imageType(data) {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  return null;
}

// Body + Content-Type header -> the single file part's bytes, or null. Exactly one part with a filename.
export function singleFilePart(body, contentType) {
  const match = String(contentType || "").match(/^multipart\/form-data;.*boundary=(?:"([^"]{1,70})"|([^\s;]{1,70}))/i);
  if (!match) return null;
  const delimiter = Buffer.from(`--${match[1] || match[2]}`);
  const files = [];
  let start = body.indexOf(delimiter);
  while (start !== -1) {
    const next = body.indexOf(delimiter, start + delimiter.length);
    if (next === -1) break;
    // part = "\r\n" headers "\r\n\r\n" data "\r\n"
    const part = body.subarray(start + delimiter.length + 2, next - 2);
    const split = part.indexOf("\r\n\r\n");
    if (split !== -1) {
      const headers = part.subarray(0, split).toString("utf8");
      if (/content-disposition:[^\r\n]*filename=/i.test(headers)) files.push(part.subarray(split + 4));
    }
    start = next;
  }
  return files.length === 1 ? files[0] : null;
}

// A multipart body for Zulip (one file field).
export function multipartBody(field, filename, type, data) {
  const boundary = `----sangsang${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([head, data, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}
