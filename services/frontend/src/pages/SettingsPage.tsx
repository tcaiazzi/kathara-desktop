import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Form } from "react-bootstrap";
import { AutocompleteInput } from "../components/AutocompleteInput";
import { Panel } from "../components/Panel";
import { useToast } from "../context/ToastContext";
import { desktop, isDesktop } from "../desktop/bridge";
import { useDeployAuthorization } from "../desktop/ElevationContext";
import { useAvailableImages } from "../hooks/useAvailableImages";
import { useTheme } from "../hooks/useTheme";
import { api, ApiError } from "../services/api";
import type { SettingsView, SystemInfo } from "../services/types";

// Client-only UI preference (localStorage, see useTheme) — not a Kathara framework setting, so it
// has no GET/PUT /settings field and lives in its own panel outside the <Form> below, applied
// immediately rather than through the "Save settings" flow.
function AppearanceSettings() {
  const { dark, toggle } = useTheme();
  return (
    <Panel title="Appearance" className="mb-3">
      <Form.Check
        type="switch"
        id="theme-switch"
        label="Dark theme"
        checked={dark}
        onChange={toggle}
      />
    </Panel>
  );
}

// This app's own storage location for lab data — a desktop-shell concept (services/desktop),
// not a Kathara framework setting, so it has no GET/PUT /settings field and lives in its own
// panel outside the <Form> below. Renders nothing in the browser build.
//
// Changing it restarts the backend process: labs_dir is read once at backend startup (see
// src/kathara_api/dependencies.py) and can't be swapped under a running process without
// desyncing already-registered labs' filesystem handles. A successful change therefore always
// ends with the window navigating to the freshly restarted backend (or, on failure, to the
// setup screen) — this component's "restarting" state is simply however long that takes to show
// before the page is torn down by that navigation; there is no "success" state to render here.
function DesktopLabsDirSettings() {
  const [labsDir, setLabsDirValue] = useState<string | null>(null);
  const [defaultDir, setDefaultDir] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const toast = useToast();

  useEffect(() => {
    const shell = desktop();
    if (!shell) return;
    void Promise.all([shell.getLabsDir(), shell.getDefaultLabsDir()]).then(([dir, def]) => {
      setLabsDirValue(dir);
      setDefaultDir(def);
    });
  }, []);

  async function handleChange() {
    const shell = desktop();
    if (!shell) return;
    const picked = await shell.pickLabsDir();
    if (!picked) return; // cancelled the native folder picker

    setRestarting(true);
    try {
      const applied = await shell.setLabsDir(picked);
      // `false` means the user backed out at the "labs are still deployed" prompt — nothing
      // changed, stay on this page. `true` means a restart is in flight; the window is about to
      // navigate away on its own, so there's nothing further to do here.
      if (!applied) setRestarting(false);
    } catch (err) {
      setRestarting(false);
      toast.reportError("Change labs folder", err);
    }
  }

  async function handleReset() {
    const shell = desktop();
    if (!shell) return;
    setRestarting(true);
    try {
      const applied = await shell.resetLabsDir();
      if (!applied) setRestarting(false);
    } catch (err) {
      setRestarting(false);
      toast.reportError("Reset labs folder", err);
    }
  }

  if (!isDesktop()) return null;

  const isDefault = defaultDir != null && labsDir === defaultDir;

  return (
    <Panel title="Desktop" className="mb-3">
      <Form.Group className="mb-2">
        <Form.Label>Labs folder</Form.Label>
        <Form.Control readOnly className="font-monospace" value={labsDir ?? "Loading…"} />
        <Form.Text className="text-muted">
          Existing labs stay on disk if you change this — nothing is moved automatically.
        </Form.Text>
      </Form.Group>
      <div className="d-flex gap-2">
        <Button type="button" size="sm" variant="outline-secondary" disabled={restarting} onClick={handleChange}>
          {restarting ? "Restarting…" : "Change…"}
        </Button>
        {!isDefault && (
          <Button type="button" size="sm" variant="outline-secondary" disabled={restarting} onClick={handleReset}>
            Reset to Default
          </Button>
        )}
      </div>
    </Panel>
  );
}

const DEBUG_LEVELS = ["CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG", "EXCEPTION"];
const VOLUME_MOUNT_POLICIES = ["Always", "Prompt", "Never"];
const IMAGE_UPDATE_POLICIES = ["Prompt", "Always", "Never"];
const NETWORK_PLUGINS = ["kathara/katharanp_vde", "kathara/katharanp"];
const SHARED_CDS_OPTIONS = [
  { value: 1, label: "Not shared" },
  { value: 2, label: "Shared within lab" },
  { value: 3, label: "Shared within user" },
];

// max_bytes_per_file/max_bytes_per_lab are stored (and sent to the API) in raw bytes; shown here
// in MB since that's the unit an operator actually thinks in.
const BYTES_PER_MB = 1024 * 1024;

// Kathara framework settings (GET/PUT /settings), not this app's own config. Most settings can
// be changed at any time — the one exception is `manager_type`, which Kathara's own
// Kathara.get_instance() picks once and can't swap out afterward for this backend process's
// lifetime (see kathara_service.py's update_settings docstring); changing it once the manager
// has already initialized is rejected with a 409, surfaced below via an inline alert.
export function SettingsPage() {
  const [form, setForm] = useState<SettingsView | null>(null);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lockedError, setLockedError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const availableImages = useAvailableImages();
  const requestDeployAuth = useDeployAuthorization();

  // The last settings known to be on disk — what a save is a *transition away from*. Compared
  // against on submit to decide whether `hosthome_mount` is being turned on right now (see
  // handleSubmit) rather than merely resubmitted already-on, the same distinction a lab deploy
  // already makes for its own host-directory mounts.
  const loadedRef = useRef<SettingsView | null>(null);

  const load = useCallback(async () => {
    try {
      const [settings, sys] = await Promise.all([api.getSettings(), api.systemInfo()]);
      setForm(settings);
      loadedRef.current = settings;
      setSystem(sys);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function set<K extends keyof SettingsView>(key: K, value: SettingsView[K]) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    setLockedError(null);
    try {
      // Mounting the operator's own $HOME into every future device is exactly the kind of thing a
      // lab's own host volumes already gate behind a password before a deploy — treated the same
      // way here, reusing that same check (verify-only; hosthome_mount needs no backend restart,
      // just like a plain volume mount doesn't). Only on the off→on transition: resubmitting the
      // rest of the form while it's already on shouldn't ask again, the same way redeploying an
      // already-mounted lab doesn't.
      if (form.hosthome_mount && !loadedRef.current?.hosthome_mount) {
        const outcome = await requestDeployAuth({ privileged: false, volumeMachines: [], hosthomeMount: true });
        if (outcome !== "proceed") {
          toast.show("Settings were not saved.", "danger");
          return;
        }
      }
      // `last_checked` is Kathara's own "when did I last check for a release" bookkeeping: it is
      // shown above, never edited here, and PUTting it back would write a client-side echo over
      // whatever the backend has since recorded. `remote_url`/`cert_path` are read-only from this
      // app (see SettingsUpdate's own docstring) — the backend would 422 either back anyway, but
      // there is no reason to send fields the form only ever displays.
      const { last_checked: _lastChecked, remote_url: _remoteUrl, cert_path: _certPath, ...payload } = form;
      const updated = await api.updateSettings(payload);
      setForm(updated);
      loadedRef.current = updated;
      toast.show("Settings saved.", "success");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setLockedError(err.message);
      } else {
        toast.reportError("Update settings", err);
      }
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <div className="container">
        <p className="text-danger">Failed to load settings: {loadError}</p>
      </div>
    );
  }

  if (!form) {
    return (
      <div className="container">
        <p className="text-muted">Loading…</p>
      </div>
    );
  }

  const managers = system?.available_managers ?? {};

  return (
    <div className="container">
      <h2>Settings</h2>
      <p className="text-muted">Kathara framework settings for this backend session.</p>

      <AppearanceSettings />

      {system && (
        <Panel title="System info" className="mb-3">
          <div className="mb-1">
            <strong>Active manager:</strong> {system.manager}
          </div>
          <div className="mb-1">
            <strong>Kathara version:</strong> {system.version}
          </div>
          <div className="mb-1">
            <strong>Available managers:</strong>{" "}
            {Object.entries(managers)
              .map(([key, label]) => `${label} (${key})`)
              .join(", ")}
          </div>
          {form.last_checked != null && (
            <div className="mb-0">
              <strong>Settings last checked:</strong> {new Date(form.last_checked * 1000).toLocaleString()}
            </div>
          )}
        </Panel>
      )}

      <DesktopLabsDirSettings />

      {lockedError && (
        <Alert variant="warning" dismissible onClose={() => setLockedError(null)}>
          {lockedError}
        </Alert>
      )}

      <Form onSubmit={handleSubmit}>
        <Panel title="General" className="mb-3">
          <Form.Group className="mb-2">
            <Form.Label>Manager type</Form.Label>
            <Form.Select value={form.manager_type} onChange={(e) => set("manager_type", e.target.value)}>
              {Object.keys(managers).length ? (
                Object.entries(managers).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label} ({key})
                  </option>
                ))
              ) : (
                <option value={form.manager_type}>{form.manager_type}</option>
              )}
            </Form.Select>
            <Form.Text className="text-muted">
              Locked to the active manager above once it has initialized for this backend session
              (essentially always, since loading this page triggers that) — restart the backend to
              switch managers. Every other setting below can be changed at any time.
            </Form.Text>
          </Form.Group>
          <Form.Group className="mb-2">
            <Form.Label>Default image</Form.Label>
            <AutocompleteInput value={form.image} onChange={(v) => set("image", v)} options={availableImages} />
          </Form.Group>
          <Form.Group className="mb-2">
            <Form.Label>Device shell</Form.Label>
            <Form.Control value={form.device_shell ?? ""} onChange={(e) => set("device_shell", e.target.value)} />
          </Form.Group>
          <Form.Group className="mb-2">
            <Form.Label>Terminal</Form.Label>
            <Form.Control value={form.terminal ?? ""} onChange={(e) => set("terminal", e.target.value)} />
          </Form.Group>
          <Form.Group className="mb-2">
            <Form.Label>Network prefix</Form.Label>
            <Form.Control value={form.net_prefix ?? ""} onChange={(e) => set("net_prefix", e.target.value)} />
          </Form.Group>
          <Form.Group className="mb-2">
            <Form.Label>Device prefix</Form.Label>
            <Form.Control value={form.device_prefix ?? ""} onChange={(e) => set("device_prefix", e.target.value)} />
          </Form.Group>
          <Form.Group className="mb-2">
            <Form.Label>Debug level</Form.Label>
            <Form.Select value={form.debug_level ?? "INFO"} onChange={(e) => set("debug_level", e.target.value)}>
              {DEBUG_LEVELS.map((lvl) => (
                <option key={lvl} value={lvl}>
                  {lvl}
                </option>
              ))}
            </Form.Select>
          </Form.Group>
          <Form.Group className="mb-2">
            <Form.Label>Volume mount policy</Form.Label>
            <Form.Select
              value={form.volume_mount_policy ?? "Always"}
              onChange={(e) => set("volume_mount_policy", e.target.value)}
            >
              {VOLUME_MOUNT_POLICIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Form.Select>
          </Form.Group>
          <Form.Check
            className="mb-2"
            type="checkbox"
            label="Open terminals on device start"
            checked={form.open_terminals ?? false}
            onChange={(e) => set("open_terminals", e.target.checked)}
          />
          <Form.Check
            className="mb-2"
            type="checkbox"
            label="Print startup log"
            checked={form.print_startup_log ?? false}
            onChange={(e) => set("print_startup_log", e.target.checked)}
          />
          <Form.Check
            type="checkbox"
            label="Enable IPv6"
            checked={form.enable_ipv6 ?? false}
            onChange={(e) => set("enable_ipv6", e.target.checked)}
          />
        </Panel>

        <Panel title="Upload &amp; import limits" className="mb-3">
          <p className="text-muted small">
            Caps applied when installing a gallery lab, importing a lab from JSON, or uploading a
            lab .zip. Unlike every other setting on this page, these are this app's own — not part
            of Kathara — and changing them here only lasts for as long as this backend process
            keeps running: they revert to their configured default the next time it starts.
          </p>
          <Form.Group className="mb-2">
            <Form.Label>Max files per lab</Form.Label>
            <Form.Control
              type="number"
              min={1}
              value={form.max_files_per_lab ?? ""}
              onChange={(e) => set("max_files_per_lab", e.target.value === "" ? undefined : Number(e.target.value))}
            />
          </Form.Group>
          <Form.Group className="mb-2">
            <Form.Label>Max size per file (MB)</Form.Label>
            <Form.Control
              type="number"
              min={1}
              value={form.max_bytes_per_file != null ? form.max_bytes_per_file / BYTES_PER_MB : ""}
              onChange={(e) =>
                set(
                  "max_bytes_per_file",
                  e.target.value === "" ? undefined : Math.round(Number(e.target.value) * BYTES_PER_MB)
                )
              }
            />
          </Form.Group>
          <Form.Group>
            <Form.Label>Max total size per lab (MB)</Form.Label>
            <Form.Control
              type="number"
              min={1}
              value={form.max_bytes_per_lab != null ? form.max_bytes_per_lab / BYTES_PER_MB : ""}
              onChange={(e) =>
                set(
                  "max_bytes_per_lab",
                  e.target.value === "" ? undefined : Math.round(Number(e.target.value) * BYTES_PER_MB)
                )
              }
            />
          </Form.Group>
        </Panel>

        {form.manager_type === "docker" && (
          <Panel title="Docker settings" className="mb-3">
            <Form.Check
              className="mb-2"
              type="checkbox"
              label="Mount host home directory"
              checked={form.hosthome_mount ?? false}
              onChange={(e) => set("hosthome_mount", e.target.checked)}
            />
            <Form.Check
              className="mb-2"
              type="checkbox"
              label="Shared mount"
              checked={form.shared_mount ?? true}
              onChange={(e) => set("shared_mount", e.target.checked)}
            />
            <Form.Group className="mb-2">
              <Form.Label>Image update policy</Form.Label>
              <Form.Select
                value={form.image_update_policy ?? "Prompt"}
                onChange={(e) => set("image_update_policy", e.target.value)}
              >
                {IMAGE_UPDATE_POLICIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Form.Select>
            </Form.Group>
            <Form.Group className="mb-2">
              <Form.Label>Shared collision domains</Form.Label>
              <Form.Select
                value={form.shared_cds ?? 1}
                onChange={(e) => set("shared_cds", Number(e.target.value))}
              >
                {SHARED_CDS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Form.Select>
            </Form.Group>
            <Form.Group className="mb-2">
              <Form.Label>Network plugin</Form.Label>
              <Form.Select
                value={form.network_plugin ?? NETWORK_PLUGINS[0]}
                onChange={(e) => set("network_plugin", e.target.value)}
              >
                {NETWORK_PLUGINS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Form.Select>
            </Form.Group>
            {(form.remote_url || form.cert_path) && (
              <Form.Group>
                <Form.Label>Remote Docker daemon</Form.Label>
                {form.remote_url && (
                  <Form.Control readOnly className="font-monospace mb-1" value={form.remote_url} />
                )}
                {form.cert_path && <Form.Control readOnly className="font-monospace" value={form.cert_path} />}
                <Form.Text className="text-muted">
                  Every deploy, exec and wipe this backend performs targets this daemon instead of
                  the local one. Set outside this app (~/.config/kathara.conf) — not editable here;
                  change it there and restart the backend.
                </Form.Text>
              </Form.Group>
            )}
          </Panel>
        )}

        <Button type="submit" disabled={busy}>
          {busy ? "Saving..." : "Save Settings"}
        </Button>
      </Form>
    </div>
  );
}
