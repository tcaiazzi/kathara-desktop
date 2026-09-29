/**
 * What a privileged action reports — a sudo password check, a deploy authorization, a reclaim of
 * root-owned lab files — and the order a deploy authorization takes. Free of any `electron`
 * import, like safety.ts, so it can be checked without an Electron runtime. The result crosses IPC
 * to the renderer as is (services/frontend's desktop/bridge.ts mirrors it).
 */

/** Why a privileged action didn't happen. */
export type SudoFailureReason = "wrong-password" | "not-permitted" | "cancelled" | "timeout" | "error" | "rate-limited";

export type PrivilegedActionResult = { ok: true } | { ok: false; reason: SudoFailureReason; message: string };

/** What `authorizeDeployWith` needs from backend.ts, passed in so the decision below can be
 * checked without spawning `sudo` or reaching a backend. */
export interface DeployAuthorizationSteps {
  platform: NodeJS.Platform;
  /** `sudo -k -n true`: whether sudo runs for this account without a password (NOPASSWD). */
  sudoRunsWithoutPassword: () => Promise<boolean>;
  /** The password check proper (backend.ts's verifyCanElevate). */
  verifyPassword: (password?: string) => Promise<PrivilegedActionResult>;
  /** The backend's grant for `labId` (backend.ts's grantDeploy). */
  grant: (labId: string) => Promise<{ ok: true } | { ok: false; message: string }>;
}

/**
 * The single rule for granting a deploy: no grant is asked for until the user's say-so has been
 * checked. The say-so is their password — or, on Linux only, no password at all where sudo asks
 * for none: `password` is then undefined, and whether sudo really runs without one is checked
 * here rather than taken from the renderer, which is who leaves the password out.
 */
export async function authorizeDeployWith(
  steps: DeployAuthorizationSteps,
  labId: string,
  password?: string,
): Promise<PrivilegedActionResult> {
  if (steps.platform === "linux" && password === undefined) {
    if (!(await steps.sudoRunsWithoutPassword())) {
      return { ok: false, reason: "error", message: "sudo asks for a password on this system" };
    }
  } else {
    const check = await steps.verifyPassword(password);
    if (!check.ok) return check;
  }
  const granted = await steps.grant(labId);
  return granted.ok ? { ok: true } : { ok: false, reason: "error", message: granted.message };
}
