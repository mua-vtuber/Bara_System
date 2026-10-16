/** Named timeouts for every install step (`runCaptured` call in `index.ts`/`remote.ts`).
 * Values are unchanged from the literals they replace; only the names are new.
 * See docs/decisions/2026-09-27-audit-fix-plan-native-install.md WP-P1-12. */

/** `managed-prepare.ts` (local and remote): create the memory data directory and settings file. */
export const INSTALL_PREPARE_TIMEOUT_MS = 120_000;
/** `managed-models.ts` (local and remote): download the Korean dictionary model. */
export const INSTALL_MODEL_DICTIONARY_TIMEOUT_MS = 600_000;
/** `prefetch-core-models.ts` (local and remote): idle-based, not total. Any output byte on
 * stdout or stderr resets the idle clock; the process is stopped only after this many ms with
 * no output at all. The core script must keep emitting output periodically during a transfer
 * for this to bound a single stalled download instead of the whole prefetch step. */
export const MODEL_PREFETCH_IDLE_MS = 1_200_000;
/** `client-token.ts` (local): mint or read back the client/owner token pair. */
export const INSTALL_TOKEN_TIMEOUT_MS = 120_000;
/** A single `ssh`/`scp` control command (preflight probes, `sha256sum`, `ln -sfn`, ...). */
export const SSH_COMMAND_TIMEOUT_MS = 30_000;
/** `ssh-keyscan` probing a host's public key (`ssh.ts` `scanHost`). */
export const SSH_KEYSCAN_TIMEOUT_MS = 12_000;
/** The authentication-disabled `ssh` fallback probe when `ssh-keyscan` finds no ed25519 key
 * (`ssh.ts` `discoverWithoutAuthentication`). */
export const SSH_KEY_DISCOVERY_TIMEOUT_MS = 12_000;
/** `ssh-keygen -lf` computing a host key fingerprint from the scanned key (`ssh.ts` `scanHost`). */
export const SSH_FINGERPRINT_TIMEOUT_MS = 10_000;
/** `scp` of the server source tarball or bundled Bun binary. */
export const SSH_TRANSFER_TIMEOUT_MS = 300_000;
/** Remote `tar -xzf` + `cp` + `chmod` of the transferred release. */
export const REMOTE_EXTRACT_TIMEOUT_MS = 120_000;
/** Remote `bun install --frozen-lockfile --production`. */
export const REMOTE_DEPENDENCIES_TIMEOUT_MS = 600_000;
/** Remote `systemctl daemon-reload && enable && restart` of the managed unit. */
export const REMOTE_SERVICE_TIMEOUT_MS = 180_000;
/** After that restart, how long the remote command waits for the managed unit to report `active`.
 * The unit is `Type=simple`, active as soon as its process runs, so this only has to outlast systemd's
 * own start; a unit that crashes on start is still `activating (auto-restart)` when it ends. Together
 * with a restart that waits out the default 90-second stop timeout it stays below `REMOTE_SERVICE_TIMEOUT_MS`. */
export const REMOTE_SERVICE_ACTIVE_WAIT_MS = 30_000;
/** `client-token.ts` (remote): mint or read back the client/owner token pair over SSH. */
export const REMOTE_TOKEN_TIMEOUT_MS = 30_000;
/** Wait for the local memory server's authenticated `/client-info` to report ready. */
export const LOCAL_SERVER_READY_TIMEOUT_MS = 120_000;
/** Wait for an SSH-tunneled memory server's authenticated or health endpoint to report ready. */
export const TUNNEL_READY_TIMEOUT_MS = 45_000;
/** After a remote install, wait through the new SSH tunnel for the freshly started remote server's
 * authenticated `/client-info`. Its first start loads models, hence longer than `TUNNEL_READY_TIMEOUT_MS`. */
export const REMOTE_INSTALL_READY_TIMEOUT_MS = 120_000;
/** One readiness request (`/client-info` or `/health`) inside those waits. A request with no answer in
 * this time counts as "not ready yet" and the wait asks again. */
export const READY_REQUEST_TIMEOUT_MS = 2_500;
/** Pause between readiness requests while a memory server or SSH tunnel is still starting. */
export const READY_POLL_INTERVAL_MS = 500;
/** Unauthenticated `/health` probe deciding whether a Bara core already runs on this PC's default core
 * port, connect and answer together. A refused loopback connect returns at once, and a running core
 * answers `/health` without touching its database. */
export const EXISTING_CORE_PROBE_TIMEOUT_MS = 2_500;
/** After the saved SSH tunnel closed by itself or failed to open, the first wait before the service opens it again
 * (`tunnel-keeper.ts`). Each failed attempt doubles the wait up to `TUNNEL_RECONNECT_MAX_DELAY_MS`. */
export const TUNNEL_RECONNECT_FIRST_DELAY_MS = 3_000;
/** The longest wait between two attempts to open the tunnel again: an unreachable server is asked once a minute. */
export const TUNNEL_RECONNECT_MAX_DELAY_MS = 60_000;
/** The tunnel's `ssh` asks the server every this many seconds whether the connection still lives (`ServerAliveInterval`),
 * and exits after `TUNNEL_KEEPALIVE_MAX_MISSED` unanswered asks. Without it a connection that died while the PC slept
 * or the network changed keeps its `ssh` running with nothing behind it, and the tunnel is never opened again. */
export const TUNNEL_KEEPALIVE_INTERVAL_S = 15;
export const TUNNEL_KEEPALIVE_MAX_MISSED = 3;
/** Wait for a started SSH tunnel to become the only listener on its local port. */
export const TUNNEL_OWNER_TIMEOUT_MS = 15_000;
/** One OS listener-table lookup (`port-owner.ts`). A warm Windows PowerShell CIM query takes under
 * one second; the limit leaves room for a cold PowerShell start right after login. */
export const PORT_OWNER_LOOKUP_TIMEOUT_MS = 15_000;
/** One loopback TCP connect that decides whether a listener lookup is needed at all; an unanswered one is
 * handed to the lookup. On Windows a connect to a closed port may be refused only after about 2 seconds
 * (the OS retries on a reset), and a probe cut off before that finds no listener in the lookup either,
 * which `LocalServer` reports as the port taken by another program. Hence well above those 2 seconds. */
export const LISTENER_PROBE_TIMEOUT_MS = 5_000;

/** Replace procedure (`release-swap.ts`): how long a started server may take to answer `/health` with the version its
 * release record names. Its first start after an update loads models, as after an install (`REMOTE_INSTALL_READY_TIMEOUT_MS`). */
export const RELEASE_HEALTH_WAIT_MS = 120_000;
/** Past `RELEASE_HEALTH_WAIT_MS`, a server that is still `active` and has not restarted since its start is still booting
 * (a slow ARM host loading the search model and taking the pre-migration snapshot before it listens). It is waited for
 * until this much time from its start; a stop, a restart or this cap ends the wait. */
export const RELEASE_HEALTH_SLOW_MAX_MS = 10 * 60_000;
/** How long a started adapter must stay `active` with no restart to count as started (spec 5.2 step 4). Longer than the
 * units' `RestartSec=5`, so a crash on start shows as a restart. */
export const ADAPTER_SURVIVE_MS = 20_000;
/** Pause between the replace procedure's state and health reads. */
export const RELEASE_POLL_INTERVAL_MS = 1_000;

/** Packing a chosen backup folder into one `tar.gz` on this PC (`remote-restore.ts` `packBackup`). `tar` prints nothing,
 * so this is a total limit sized for a multi-gigabyte attachment folder on a slow disk. */
export const RESTORE_PACK_TIMEOUT_MS = 30 * 60_000;
/** `scp` of that archive to the server. Larger than the release bundles `SSH_TRANSFER_TIMEOUT_MS` is sized for. */
export const RESTORE_UPLOAD_TIMEOUT_MS = 2 * 60 * 60_000;
/** `sha256sum` of that archive on the server. Sized for a 20 GB backup read once from a slow cloud volume at 20 MB/s
 * (about 17 minutes), with room to spare. */
export const RESTORE_DIGEST_TIMEOUT_MS = 30 * 60_000;
/** Unpacking that archive on the server: it is read and every file written again, twice the digest's disk work (about
 * 33 minutes for 20 GB at 20 MB/s), with room to spare. */
export const RESTORE_EXTRACT_TIMEOUT_MS = 60 * 60_000;
