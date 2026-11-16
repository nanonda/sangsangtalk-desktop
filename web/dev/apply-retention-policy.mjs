// Applies the 1단계 F record-keeping policy to the local Zulip organization (compose.yaml):
//   - message retention: unlimited
//   - deleting messages (own or anyone's): administrators only
//   - editing own messages: allowed, with full edit history visible
//
//   node web/dev/apply-retention-policy.mjs        (Zulip must be up; safe to re-run)
//
// It changes realm settings through Zulip's own actions inside the container, so
// the change is audited like one made in the Zulip admin UI.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const python = `
import json
from zerver.models import NamedUserGroup
from zerver.models.groups import SystemGroups
from zerver.models.realms import get_realm, MessageEditHistoryVisibilityPolicyEnum
from zerver.actions.realm_settings import do_set_realm_property, do_change_realm_permission_group_setting

realm = get_realm("")
admins = NamedUserGroup.objects.get(realm_for_sharding=realm, name=SystemGroups.ADMINISTRATORS, is_system_group=True)

if realm.message_retention_days != -1:
    do_set_realm_property(realm, "message_retention_days", -1, acting_user=None)
if not realm.allow_message_editing:
    do_set_realm_property(realm, "allow_message_editing", True, acting_user=None)
all_history = MessageEditHistoryVisibilityPolicyEnum.all.value
if realm.message_edit_history_visibility_policy != all_history:
    do_set_realm_property(realm, "message_edit_history_visibility_policy", all_history, acting_user=None)
for setting in ("can_delete_own_message_group", "can_delete_any_message_group"):
    if getattr(realm, setting + "_id") != admins.id:
        do_change_realm_permission_group_setting(realm, setting, admins, acting_user=None)

realm.refresh_from_db()
print("POLICY_RESULT " + json.dumps({
    "message_retention_days": realm.message_retention_days,
    "allow_message_editing": realm.allow_message_editing,
    "message_content_edit_limit_seconds": realm.message_content_edit_limit_seconds,
    "message_edit_history_visibility_policy": realm.message_edit_history_visibility_policy,
    "can_delete_own_message_group": NamedUserGroup.objects.get(id=realm.can_delete_own_message_group_id).name,
    "can_delete_any_message_group": NamedUserGroup.objects.get(id=realm.can_delete_any_message_group_id).name,
}))
`;

const run = spawnSync(
  "docker",
  ["compose", "exec", "-T", "-u", "zulip", "zulip", "/home/zulip/deployments/current/manage.py", "shell"],
  { cwd: root, input: python, encoding: "utf8" },
);
const line = (run.stdout || "").split(/\r?\n/).find((text) => text.startsWith("POLICY_RESULT "));
if (run.status !== 0 || !line) {
  console.error("적용 실패:", (run.stderr || run.error?.message || "").trim().split("\n").slice(-15).join("\n"));
  process.exit(1);
}
const result = JSON.parse(line.slice("POLICY_RESULT ".length));
console.log(`보존 기간: ${result.message_retention_days === -1 ? "무제한" : `${result.message_retention_days}일`}`);
console.log(`본인 메시지 삭제: ${result.can_delete_own_message_group}, 모든 메시지 삭제: ${result.can_delete_any_message_group}`);
console.log(`수정 허용: ${result.allow_message_editing} (제한 ${result.message_content_edit_limit_seconds ?? "없음"}초), 수정 이력 공개 정책: ${result.message_edit_history_visibility_policy}`);
