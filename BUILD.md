# Windows build

This archive builds the SangsangTalk Tauri shell and checks the web session-status contract. It does not contain the Zulip password file, note metadata, or dependency build output.

## Prerequisites

- Windows 10 or 11, 64-bit
- Node.js 24.20.0 and the npm that ships with it (11.19.0 on the development PC)
- Rust stable, installed with rustup for the `stable-x86_64-pc-windows-msvc` toolchain
- Visual Studio Build Tools 2022 with the `Microsoft.VisualStudio.Workload.VCTools` workload
- WebView2 Runtime

The Tauri CLI downloads NSIS while it builds the installer. GitHub `windows-latest` already provides the MSVC linker and WebView2.

## Commands

From the archive root:

```
node --check web/server.mjs
node --check web/lib/note-store.mjs
node --check web/session-status.check.mjs
node web/session-status.check.mjs
```

The check starts `web/server.mjs` on an ephemeral port. It does not need Zulip. `GET /api/session/status` must return HTTP 200 and JSON whose only field is `signedIn: false` for an anonymous request and for an unknown session cookie.

From `desktop`:

```
npm ci
npm run build -- --bundles nsis --no-sign
```

`npm ci` installs the locked `@tauri-apps/cli` 2.12.4. The app crate is Tauri 2.12.5. Unsigned outputs:

- `desktop/src-tauri/target/release/sangsangtalk-desktop.exe`
- `desktop/src-tauri/target/release/bundle/nsis/SangsangTalk_0.1.0_x64-setup.exe`

`web/package.json` has no dependencies and no lockfile.

## GitHub Actions

`.github/workflows/windows.yml` runs on `windows-latest` for `push`, `pull_request`, and `workflow_dispatch`. It installs Node.js 24.20.0 and Rust stable, runs `npm ci`, runs the checks above, builds the NSIS installer, and uploads:

- `sangsangtalk-windows-executable` — the standalone executable
- `sangsangtalk-windows-nsis` — the NSIS installer

The workflow action implementations are pinned to immutable commit SHAs. npm and Cargo dependency lockfiles are committed, and direct application dependencies use exact versions.

Signing is off unless the workflow is dispatched with `sign` set to true. The workflow file does not contain secret values.

## Signing secrets

Add these repository secrets only when you want signing. Names are placeholders; this archive has no values for them.

| Secret | Used when |
| --- | --- |
| `WINDOWS_CERTIFICATE` | `sign` is true. Base64-encoded Authenticode PFX. |
| `WINDOWS_CERTIFICATE_PASSWORD` | `sign` is true. Password for that PFX. An empty password is treated as incomplete. |
| `TAURI_SIGNING_PRIVATE_KEY` | `sign` is true and `bundle.createUpdaterArtifacts` is enabled. Tauri updater private key. Updater artifacts are off in the current config, so this secret is not required for the default build. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The updater private key is encrypted. Required in that case; otherwise omit it. |

If `sign` is true and a required secret is missing, not valid base64, or does not import a certificate, the job fails before or during the build and does not upload an installer it claimed to sign. A signed build also fails when the NSIS installer has no valid Authenticode signature.

The dispatch copies the imported certificate thumbprint into `tauri.conf.json` on the runner only. The committed config has no thumbprint.

## Backup

`ops/backup.ps1` (Windows PowerShell 5.1) runs Zulip's own `manage.py backup` inside the running `zulip` container, copies the tarball to `C:\SangsangTalk-backup\<yyyyMMdd-HHmmss>\`, removes the temporary file in the container, deletes backup folders older than 30 days (`-RetentionDays`, `-BackupRoot`), and appends to `backup.log` in the backup root. It exits non-zero on failure. The tarball contains `/etc/zulip`, including `zulip-secrets.conf`, so keep the backup folder private. Restore steps and the Task Scheduler command are in `ops/restore.md`; nothing is scheduled automatically.

## Notes

The shell loads `http://127.0.0.1:43123/`. It does not bundle the web server. `lib.rs` writes a diagnostic word to `C:\SangsangTalk\desktop\link-state.txt` and ignores write errors. That path is specific to the development PC and is not a credential. CI does not run the GUI.

Autostart stays off unless the tray item is checked. Notifications and an unread badge are not implemented.
