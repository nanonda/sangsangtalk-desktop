// Applies the 2단계(docs/p2-contract.md) organization settings to the local Zulip (compose.yaml):
//   - A1 read receipts: enable_read_receipts = true
//   - A4 edit/recall window: message_content_edit_limit_seconds = 600 (10 minutes, same as web/server.mjs)
//
//   node web/dev/apply-p2-settings.mjs        (Zulip must be up; safe to re-run)
//
// Same method as apply-retention-policy.mjs: Zulip's own actions inside the container, audited like the admin UI.
// Closed network: run the same Python through manage.py shell on the app server (ops/README.md).
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const python = `
import json
from zerver.models.realms import get_realm
from zerver.actions.realm_settings import do_set_realm_property

realm = get_realm("")
if not realm.enable_read_receipts:
    do_set_realm_property(realm, "enable_read_receipts", True, acting_user=None)
if realm.message_content_edit_limit_seconds != 600:
    do_set_realm_property(realm, "message_content_edit_limit_seconds", 600, acting_user=None)

realm.refresh_from_db()
print("P2_RESULT " + json.dumps({
    "enable_read_receipts": realm.enable_read_receipts,
    "message_content_edit_limit_seconds": realm.message_content_edit_limit_seconds,
}))
`;

const run = spawnSync(
  "docker",
  ["compose", "exec", "-T", "-u", "zulip", "zulip", "/home/zulip/deployments/current/manage.py", "shell"],
  { cwd: root, input: python, encoding: "utf8" },
);
const line = (run.stdout || "").split(/\r?\n/).find((text) => text.startsWith("P2_RESULT "));
if (run.status !== 0 || !line) {
  console.error("적용 실패:", (run.stderr || run.error?.message || "").trim().split("\n").slice(-15).join("\n"));
  process.exit(1);
}
const result = JSON.parse(line.slice("P2_RESULT ".length));
console.log(`읽음 확인: ${result.enable_read_receipts ? "켜짐" : "꺼짐"}`);
console.log(`수정·회수 제한: ${result.message_content_edit_limit_seconds}초`);
