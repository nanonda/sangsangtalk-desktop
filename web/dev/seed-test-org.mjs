// Seeds the local Zulip stack (compose.yaml) with a test organization:
// custom profile fields "부서"/"직위" and ten test accounts.
//
//   node web/dev/seed-test-org.mjs          (run from anywhere; Zulip must be up)
//
// Safe to re-run: missing fields/users are created, existing ones are updated.
// Every run issues fresh random passwords for these ten accounts and rewrites
// .credentials/test-accounts.md (git-ignored). Passwords never go to stdout.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOMAIN = "localhost.localdomain";
const FIELDS = { department: "부서", position: "직위" };

const PEOPLE = [
  ["pr01", "김도윤", "홍보실", "홍보실장"],
  ["pr02", "이서준", "홍보실", "홍보기획팀장"],
  ["pr03", "박지민", "홍보실", "주무관"],
  ["pr04", "최유나", "홍보실", "주무관"],
  ["pr05", "정하람", "홍보실", "주무관"],
  ["ad01", "윤성호", "자치행정과", "자치행정과장"],
  ["ad02", "한지수", "자치행정과", "자치행정팀장"],
  ["ad03", "오민재", "자치행정과", "주무관"],
  ["ad04", "강예린", "자치행정과", "주무관"],
  ["ad05", "서다온", "자치행정과", "주무관"],
].map(([id, fullName, department, position]) => ({
  email: `${id}@${DOMAIN}`,
  fullName,
  department,
  position,
  password: randomBytes(12).toString("base64url"),
}));

const payload = Buffer.from(JSON.stringify({ fields: FIELDS, people: PEOPLE })).toString("base64");

const python = `
import base64, json
from zerver.models import CustomProfileField, UserProfile
from zerver.models.realms import get_realm
from zerver.actions.create_user import do_create_user
from zerver.actions.custom_profile_fields import (
    try_add_realm_custom_profile_field, do_update_user_custom_profile_data_if_changed)
from zerver.actions.user_settings import do_change_password, do_change_full_name

spec = json.loads(base64.b64decode("${payload}"))
realm = get_realm("")
field_ids = {}
for key, name in spec["fields"].items():
    field = CustomProfileField.objects.filter(realm=realm, name=name).first()
    if field is None:
        field = try_add_realm_custom_profile_field(
            realm, name, CustomProfileField.SHORT_TEXT, display_in_profile_summary=True)
    field_ids[key] = field.id

created, updated = [], []
for p in spec["people"]:
    user = UserProfile.objects.filter(realm=realm, delivery_email__iexact=p["email"]).first()
    if user is None:
        user = do_create_user(p["email"], p["password"], realm, p["fullName"], acting_user=None)
        created.append(p["email"])
    else:
        do_change_password(user, p["password"])
        if user.full_name != p["fullName"]:
            do_change_full_name(user, p["fullName"], acting_user=None, notify=True)
        updated.append(p["email"])
    do_update_user_custom_profile_data_if_changed(user, [
        {"id": field_ids["department"], "value": p["department"]},
        {"id": field_ids["position"], "value": p["position"]},
    ], acting_user=None, notify=True)

print("SEED_RESULT " + json.dumps({"fields": field_ids, "created": created, "updated": updated}))
`;

const run = spawnSync(
  "docker",
  ["compose", "exec", "-T", "-u", "zulip", "zulip", "/home/zulip/deployments/current/manage.py", "shell"],
  { cwd: root, input: python, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);
const line = (run.stdout || "").split(/\r?\n/).find((text) => text.startsWith("SEED_RESULT "));
if (run.status !== 0 || !line) {
  // stderr carries Python tracebacks; it never contains the generated passwords.
  console.error("시드 실패:", (run.stderr || run.error?.message || "").trim().split("\n").slice(-15).join("\n"));
  process.exit(1);
}
const result = JSON.parse(line.slice("SEED_RESULT ".length));

const credentialsDir = join(root, ".credentials");
mkdirSync(credentialsDir, { recursive: true });
const rows = PEOPLE.map((p) => `| ${p.department} | ${p.fullName} | ${p.position} | ${p.email} | \`${p.password}\` |`);
writeFileSync(
  join(credentialsDir, "test-accounts.md"),
  [
    "# 로컬 Zulip 테스트 계정",
    "",
    `생성: ${new Date().toISOString()} — \`node web/dev/seed-test-org.mjs\`로 다시 만들면 비밀번호가 바뀐다.`,
    "로컬 테스트 전용. 커밋 금지(.gitignore 대상).",
    "",
    "| 부서 | 이름 | 직위 | 이메일 | 비밀번호 |",
    "|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n"),
  "utf8",
);

console.log(`필드 id: 부서=${result.fields.department}, 직위=${result.fields.position}`);
console.log(`생성 ${result.created.length}명, 갱신 ${result.updated.length}명`);
console.log("비밀번호는 .credentials/test-accounts.md 에 기록했습니다.");
