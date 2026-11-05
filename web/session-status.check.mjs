import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function assertContract(payload) {
  const keys = Object.keys(payload);
  if (keys.length !== 1 || keys[0] !== "signedIn" || typeof payload.signedIn !== "boolean") {
    throw new Error("session status must be exactly { signedIn: boolean }");
  }
}

async function getStatus(port, cookie) {
  const headers = cookie ? { cookie } : {};
  const response = await fetch("http://127.0.0.1:" + port + "/api/session/status", { headers });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("session status response was not JSON (status " + response.status + ")");
  }
  if (response.status !== 200) {
    throw new Error("session status HTTP " + response.status);
  }
  assertContract(payload);
  return payload.signedIn;
}

const port = await freePort();
const child = spawn(process.execPath, ["server.mjs"], {
  cwd: here,
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk;
});
child.stderr.on("data", (chunk) => {
  output += chunk;
});

function stop() {
  if (!child.killed) child.kill();
}

try {
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not listen")), 8000);
    const onData = () => {
      if (output.includes("127.0.0.1:" + port)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error("server exited before listening (" + code + ")"));
    });
    onData();
  });
  void ready;
  const anonymous = await getStatus(port);
  const unknownCookie = await getStatus(port, "sangsang_sid=" + "ab".repeat(32));
  if (anonymous !== false || unknownCookie !== false) {
    throw new Error("signed-out session status was not false");
  }
  console.log("session-status contract ok");
} catch (error) {
  console.error(error instanceof Error ? error.message : "session-status check failed");
  process.exitCode = 1;
} finally {
  stop();
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
    setTimeout(resolve, 2000);
  });
}
