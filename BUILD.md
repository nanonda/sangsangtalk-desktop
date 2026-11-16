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

## Production (closed-network) build

The app address is fixed at build time by `SANGSANGTALK_APP_URL`. It cannot be changed while the app runs. Without it the build uses `http://127.0.0.1:43123/` (the development default).

Format: `http://` or `https://`, a host, an optional `:port`, and a trailing `/`. Lowercase only. No path, query, `#`, or user info. Any other value fails the build.

`talk.eumseong.local` is only an example. `.local` is reserved for mDNS (RFC 6762), so Windows may try multicast DNS instead of the internal DNS server and resolve slowly or not at all. Use a name in the organization's real internal DNS domain.

PowerShell, from `desktop`:

```
$env:SANGSANGTALK_APP_URL='https://talk.eumseong.local/'
npm ci
npm run build -- --bundles nsis --no-sign
Remove-Item Env:SANGSANGTALK_APP_URL
```

The `web-bridge` capability (the remote URL allowed to call the shell) is generated during the build from this value. The result is recorded in `desktop/src-tauri/gen/schemas/capabilities.json`; check that it names the production origin before you ship the installer.

Certificates: the WebView2 window and the https status check use the Windows certificate store. Deploy the organization's root CA to staff PCs (for example by Group Policy). The app does not bundle a certificate.

The web server is different: Node uses its own CA list, not the OS store. Give it the internal CA with `ZULIP_CA_FILE` (preferred) or `NODE_EXTRA_CA_CERTS`, in `/etc/sangsangtalk/web.env`. Web server variables: `HOST`, `PORT`, `PUBLIC_ORIGIN`, `SESSION_KEY` (32-byte base64), `ZULIP_ORIGIN`, `ZULIP_CA_FILE`, `ZULIP_TLS_INSECURE` (development only), `MAX_UPLOAD_MB`. See `.env.example` and `ops/systemd/sangsangtalk-web.service`.

## Closed-network server files

`ops/README.md` lists the three-tier files and the deployment order:

- `ops/compose/compose.app.yaml` ([app]: Zulip, RabbitMQ, Redis, Memcached; outbound Internet features off) and `ops/compose/compose.db.yaml` ([DB]: PostgreSQL 14). Both use the project name `sangsangtalk`, so volume and secret names match the development stack. Run them with `docker compose --env-file /etc/sangsangtalk/zulip.env -f ops/compose/<file> up -d`.
- `ops/nginx/sangsangtalk.conf` and `ops/systemd/sangsangtalk-web.service` ([web]).
- `ops/firewall.md`: allowed ports per tier.

The development `compose.yaml` reads `ZULIP_EXTERNAL_HOST` (default `localhost.localdomain:9991`) and `ZULIP_HTTPS_PORT` (default `9991`). With both unset it renders exactly as before.

Checks run on the development PC:

```
docker compose config                                   # unchanged with defaults
docker compose --env-file <dummy.env> -f ops/compose/compose.app.yaml config
docker compose --env-file <dummy.env> -f ops/compose/compose.db.yaml config
bash -n ops/backup.sh ops/make-offline-bundle.sh
bash ops/make-offline-bundle.sh <commit> --dry-run
```

### Offline bundle

`ops/make-offline-bundle.sh <commit> [--out DIR] [--platform linux/amd64] [--dry-run]` runs on a PC with Internet access. It writes `sangsangtalk-offline-<commit>/` (default under `~/sangsangtalk-offline`, outside the repository) with:

- `source-<commit>.tar.gz` from `git archive` (committed files only, LF line endings). The script stops if the commit contains `.env` or `.env.*` at any path (except `.env.example`), `*.pem`, `*.key`, `*.pfx`, `*.p12`, anything under `.credentials/`, or anything under `web/data/`.
- `images/*.tar` from `docker save` for `ghcr.io/zulip/zulip-server:12.3-0`, `zulip/zulip-postgresql:14`, `memcached:alpine`, `rabbitmq:4.2`, `redis:alpine`. With the containerd image store it adds `--platform` when `docker save` supports it.
- `images.txt` (reference only: tag, registry digest, image ID, platform), `MANIFEST.txt`, `SHA256SUMS`

If any step fails, the script deletes the partial bundle folder.

Build the bundle from a commit that already contains the `.gitattributes` `export-ignore` rule. Older commits still put `.claude/` in the source archive; the script logs a note when the rule is missing.

On the closed network, `sha256sum -c SHA256SUMS` is the check that counts: every line must be OK. Then `docker load -i` each tar and extract the source with `tar -xzf source-<commit>.tar.gz -C /opt/sangsangtalk --strip-components=1`. Image IDs in `images.txt` are for reference only, because they depend on the Docker image store. With the containerd store the image ID is the registry (index/manifest) digest and `RepoDigests` survives `docker load`. With the classic overlay2 (graphdriver) store the image ID is the config digest and `RepoDigests` is empty after `docker load`. If the two machines use different stores, the IDs will differ even for the same image. `docker info -f '{{.DriverStatus}}'` shows which store a machine uses.

The Windows desktop installer is built separately (above) and carried with the bundle.

## Backup

`ops/backup.ps1` (Windows PowerShell 5.1) runs Zulip's own `manage.py backup` inside the running `zulip` container, copies the tarball to `C:\SangsangTalk-backup\<yyyyMMdd-HHmmss>\`, removes the temporary file in the container, deletes backup folders older than 30 days (`-RetentionDays`, `-BackupRoot`), and appends to `backup.log` in the backup root. It exits non-zero on failure. The tarball contains `/etc/zulip`, including `zulip-secrets.conf`, so keep the backup folder private. Restore steps and the Task Scheduler command are in `ops/restore.md`; nothing is scheduled automatically.

`ops/backup.sh` is the Linux (bash) version for the closed-network servers, with the same steps, logs and exit codes (`--compose-file`, `--env-file`, `--backup-root`, `--retention-days`, `--notes-only` for the web server, `--dry-run`). Linux restore steps and cron examples are in `ops/restore.md`.

## Notes

The shell loads `SANGSANGTALK_APP_URL` as set at build time (default `http://127.0.0.1:43123/`). It does not bundle the web server. `lib.rs` writes a diagnostic word to `C:\SangsangTalk\desktop\link-state.txt` and ignores write errors. That path is specific to the development PC and is not a credential. CI does not run the GUI.

Autostart stays off unless the tray item is checked. Notifications and an unread badge are not implemented.
