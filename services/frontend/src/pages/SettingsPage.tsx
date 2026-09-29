import { ArrowLeft, ChevronDown, ChevronRight, FileText, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Collapse, Form, Tab, Tabs } from "react-bootstrap";
import { Link, useSearchParams } from "react-router-dom";
import { AutocompleteInput } from "../components/AutocompleteInput";
import { Panel } from "../components/Panel";
import { useToast } from "../context/ToastContext";
import { desktop, isDesktop } from "../desktop/bridge";
import { useDeployAuthorization } from "../desktop/ElevationContext";
import { useAvailableImageSections } from "../hooks/useAvailableImages";
import { useBusyAction } from "../hooks/useBusyAction";
import { useLabLifecycleActions } from "../hooks/useLabLifecycleActions";
import { useTheme } from "../hooks/useTheme";
import { api, ApiError } from "../services/api";
import {
  afterKatharaSave,
  afterLimitsSave,
  initialSettingsTab,
  toKatharaUpdate,
  toLimitsUpdate,
  type SettingsTab,
} from "../services/settings";
import type { SettingsView, SystemInfo } from "../services/types";

// Not settings: one-off actions and facts, so they sit outside every <Form> and are never tied to a
// save. "Wipe all labs" is the recovery tool for when the lab list disagrees with Docker
// (containers alive, list says undeployed), which is why it is offered unconditionally rather than
// only when some lab reads as deployed. Nothing to refresh afterwards: the workspace refetches the
// lab list when it mounts again. The log and the version exist only in the desktop app.
function TroubleshootSettings() {
  const { wipeAll } = useLabLifecycleActions();
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    desktop()
      ?.getAppInfo()
      .then((info) => {
        if (!cancelled) setVersion(info.version);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Panel title="Troubleshoot" className="mb-3">
      <div className="d-flex align-items-center gap-3">
        <div className="flex-grow-1">
          <div>Wipe all labs</div>
          <Form.Text className="text-muted">
            Force-undeploys every lab running in kathara-desktop. Lab files stay on disk, and
            scenarios started by other tools are left alone.
          </Form.Text>
        </div>
        <Button
          size="sm"
          variant="outline-danger"
          className="flex-shrink-0"
          disabled={busy}
          onClick={() => void wipeAll(setBusy)}
        >
          <Trash2 size={14} className="me-1" />
          Wipe all
        </Button>
      </div>
      {isDesktop() && (
        <div className="d-flex align-items-center gap-3 mt-3">
          <div className="flex-grow-1">
            <div>Backend log</div>
            <Form.Text className="text-muted">
              What the app&apos;s backend did, for reporting a problem.
              {version && <> Kathara Desktop {version}.</>}
            </Form.Text>
          </div>
          <Button
            size="sm"
            variant="outline-secondary"
            className="flex-shrink-0"
            onClick={() => void desktop()?.showBackendLog()}
          >
            <FileText size={14} className="me-1" />
            Show backend log
          </Button>
        </div>
      )}
    </Panel>
  );
}

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
    let cancelled = false;
    void Promise.all([shell.getLabsDir(), shell.getDefaultLabsDir()]).then(([dir, def]) => {
      if (cancelled) return;
      setLabsDirValue(dir);
      setDefaultDir(def);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
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
    <Panel title="Labs folder" className="mb-3">
      <Form.Group className="mb-2" controlId="settings-labs-dir">
        <Form.Label>Where new labs are created</Form.Label>
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

// The tab the viewer used last. Storage can be unavailable (a private window): the page then just
// opens on this app's tab.
const LS_TAB = "kt-settings-tab";

function readSavedTab(): string | null {
  try {
    return localStorage.getItem(LS_TAB);
  } catch {
    return null;
  }
}

function saveTab(tab: SettingsTab) {
  try {
    localStorage.setItem(LS_TAB, tab);
  } catch {
    // A remembered tab is a convenience only.
  }
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

interface BackToWorkspaceProps {
  className?: string;
}

// Settings is a full-page detour from the Workspace (no tab strip to click back through, and in
// the Electron shell no navbar "Workspace" link either), so the way back is spelled out — once at
// the top and again past the end of the form, which is long enough that the top one is scrolled
// well out of view by the time the user is done.
//
// Plain "/workspace" rather than history.back(): the Workspace restores the last-open lab on its
// own, so this lands where the user left off even when Settings was opened from the native menu or
// a kathara:// deep link, with nothing to go back to.
function BackToWorkspace({ className = "" }: BackToWorkspaceProps) {
  return (
    <Link
      to="/workspace"
      className={`btn btn-sm btn-outline-secondary rounded-pill ps-2 pe-3 d-inline-flex align-items-center gap-2 ${className}`}
    >
      <ArrowLeft size={16} />
      Back to Workspace
    </Link>
  );
}

// Two tabs, each saying where its values end up: this app's own settings (Appearance, the labs
// folder, the upload & import limits, troubleshooting), and Kathara's (GET/PUT /settings, saved to
// kathara.conf, which the Kathara CLI reads too). The two forms save separately, each sending only
// its own keys (services/settings.ts). Most Kathara settings can be changed at any time — the one
// exception is `manager_type`, which Kathara's own Kathara.get_instance() picks once and can't
// swap out afterward for this backend process's lifetime (see kathara_service.py's
// update_settings docstring); changing it once the manager has already initialized is rejected
// with a 409, surfaced below via an inline alert.
export function SettingsPage() {
  const [form, setForm] = useState<SettingsView | null>(null);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lockedError, setLockedError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savingLimits, setSavingLimits] = useState(false);
  const [cliOnlyOpen, setCliOnlyOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<SettingsTab>(() => initialSettingsTab(searchParams.get("tab"), readSavedTab()));
  const toast = useToast();
  const imageSections = useAvailableImageSections();
  const requestDeployAuth = useDeployAuthorization();
  const { run: runBusy } = useBusyAction();

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

  function selectTab(key: string | null) {
    const next = initialSettingsTab(key, null);
    setTab(next);
    saveTab(next);
    setSearchParams({ tab: next }, { replace: true });
  }

  function set<K extends keyof SettingsView>(key: K, value: SettingsView[K]) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    setLockedError(null);
    await runBusy(setBusy, "Save Kathara settings", async () => {
      // Mounting the operator's own $HOME into every future device is exactly the kind of thing a
      // lab's own host volumes already gate behind a password before a deploy — treated the same
      // way here, reusing that same check (verify-only: there is no deploy to grant, and every
      // later deploy is gated on its own). Only on the off→on transition: resubmitting the rest
      // of the form while it's already on shouldn't ask again.
      if (form.hosthome_mount && !loadedRef.current?.hosthome_mount) {
        const outcome = await requestDeployAuth({ privileged: false, volumeMachines: [], hosthomeMount: true });
        if (outcome !== "proceed") {
          toast.show("Settings were not saved.", "danger");
          return;
        }
      }
      let updated: SettingsView;
      try {
        updated = await api.updateSettings(toKatharaUpdate(form));
      } catch (err) {
        // The one error this page answers itself: a 409 means the backend has already initialized
        // the setting being changed, which has its own inline alert above the form. Everything
        // else is rethrown so `runBusy` reports it the way every other action does.
        if (err instanceof ApiError && err.status === 409) {
          setLockedError(err.message);
          return;
        }
        throw err;
      }
      setForm((prev) => afterKatharaSave(prev ?? updated, updated));
      loadedRef.current = updated;
      toast.show("Kathara settings saved.", "success");
    });
  }

  async function handleSaveLimits(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    await runBusy(setSavingLimits, "Save limits", async () => {
      // Applied by the backend at once; the desktop app also keeps them for every later backend.
      const updated = await api.updateSettings(toLimitsUpdate(form));
      setForm((prev) => afterLimitsSave(prev ?? updated, updated));
      await desktop()?.setUploadLimits(toLimitsUpdate(updated));
      toast.show("Limits saved.", "success");
    });
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
    /* pt-4: the top bar sits flush against the page, so without it the first element here reads as
       part of the bar rather than of the page. */
    <div className="container pt-4">
      <BackToWorkspace className="mb-4" />
      <h2>Settings</h2>

      <Tabs activeKey={tab} onSelect={selectTab} className="mb-3">
        <Tab eventKey="app" title="Kathara Desktop">
          <p className="text-muted">Saved by Kathara Desktop on this computer; the Kathara CLI doesn&apos;t use them.</p>

          <AppearanceSettings />
          <DesktopLabsDirSettings />

          <Form onSubmit={handleSaveLimits}>
            <Panel title="Upload &amp; import limits" className="mb-3">
              <p className="text-muted small">
                Caps applied when installing a gallery lab, importing a lab from JSON, or uploading a
                lab .zip.{" "}
                {isDesktop()
                  ? "They apply at once and are kept for the next start."
                  : "They apply at once, until the backend restarts: set KATHARA_API_MAX_* to keep them."}
              </p>
              <Form.Group className="mb-2" controlId="settings-max-files">
                <Form.Label>Max files per lab</Form.Label>
                <Form.Control
                  type="number"
                  min={1}
                  value={form.max_files_per_lab ?? ""}
                  onChange={(e) => set("max_files_per_lab", e.target.value === "" ? undefined : Number(e.target.value))}
                />
              </Form.Group>
              <Form.Group className="mb-2" controlId="settings-max-file-size">
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
              <Form.Group className="mb-3" controlId="settings-max-lab-size">
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
              <Button type="submit" size="sm" disabled={savingLimits}>
                {savingLimits ? "Saving..." : "Save limits"}
              </Button>
            </Panel>
          </Form>

          <TroubleshootSettings />
        </Tab>

        <Tab eventKey="kathara" title="Kathara">
          <p className="text-muted">
            Saved to {form.settings_file ? <code>{form.settings_file}</code> : "Kathara's settings file"}, the file the
            Kathara CLI uses too.
          </p>

          {system && (
            <Panel title="System info" className="mb-3">
              <div className="mb-1">
                <strong>Active manager:</strong> {system.manager}
              </div>
              <div className="mb-1">
                <strong>Docker version:</strong> {system.version ?? "unknown (Docker isn't reachable)"}
              </div>
              <div className="mb-0">
                <strong>Available managers:</strong>{" "}
                {Object.entries(managers)
                  .map(([key, label]) => `${label} (${key})`)
                  .join(", ")}
              </div>
            </Panel>
          )}

          {form.settings_file_error && (
            <Alert variant="warning">
              Kathara&apos;s settings file could not be read, so the defaults are in use and saving fails
              until the file is fixed or deleted — restart the app afterwards to load it.{" "}
              {form.settings_file_error}
            </Alert>
          )}
          {form.settings_warnings?.map((warning) => (
            <Alert key={warning} variant="warning">
              {warning}
            </Alert>
          ))}

          {lockedError && (
            <Alert variant="warning" dismissible onClose={() => setLockedError(null)}>
              {lockedError}
            </Alert>
          )}

          <Form onSubmit={handleSubmit}>
            <Panel title="General" className="mb-3">
              <Form.Group className="mb-2" controlId="settings-manager">
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
                  Kathara Desktop runs on Docker. Changing the manager needs an app restart.
                </Form.Text>
              </Form.Group>
              <Form.Group className="mb-2" controlId="settings-image">
                <Form.Label>Default image</Form.Label>
                <AutocompleteInput value={form.image} onChange={(v) => set("image", v)} options={imageSections} />
              </Form.Group>
              <Form.Group className="mb-2" controlId="settings-device-shell">
                <Form.Label>Device shell</Form.Label>
                <Form.Control value={form.device_shell ?? ""} onChange={(e) => set("device_shell", e.target.value)} />
              </Form.Group>
              <Form.Group className="mb-2" controlId="settings-net-prefix">
                <Form.Label>Network prefix</Form.Label>
                <Form.Control value={form.net_prefix ?? ""} onChange={(e) => set("net_prefix", e.target.value)} />
              </Form.Group>
              <Form.Group className="mb-2" controlId="settings-device-prefix">
                <Form.Label>Device prefix</Form.Label>
                <Form.Control value={form.device_prefix ?? ""} onChange={(e) => set("device_prefix", e.target.value)} />
              </Form.Group>
              <Form.Group className="mb-2" controlId="settings-debug-level">
                <Form.Label>Debug level</Form.Label>
                <Form.Select value={form.debug_level ?? "INFO"} onChange={(e) => set("debug_level", e.target.value)}>
                  {DEBUG_LEVELS.map((lvl) => (
                    <option key={lvl} value={lvl}>
                      {lvl}
                    </option>
                  ))}
                </Form.Select>
              </Form.Group>
              <Form.Group className="mb-2" controlId="settings-volume-policy">
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
                id="settings-ipv6"
                type="checkbox"
                label="Enable IPv6"
                checked={form.enable_ipv6 ?? false}
                onChange={(e) => set("enable_ipv6", e.target.checked)}
              />
            </Panel>

            {form.manager_type === "docker" && (
              <Panel title="Docker settings" className="mb-3">
                <Form.Check
                  id="settings-hosthome"
                  className="mb-2"
                  type="checkbox"
                  label="Mount host home directory"
                  checked={form.hosthome_mount ?? false}
                  onChange={(e) => set("hosthome_mount", e.target.checked)}
                />
                <Form.Check
                  id="settings-shared-mount"
                  className="mb-2"
                  type="checkbox"
                  label="Shared mount"
                  checked={form.shared_mount ?? true}
                  onChange={(e) => set("shared_mount", e.target.checked)}
                />
                <Form.Group className="mb-2" controlId="settings-image-update">
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
                <Form.Group className="mb-2" controlId="settings-shared-cds">
                  <Form.Label>Shared collision domains</Form.Label>
                  <Form.Select value={form.shared_cds ?? 1} onChange={(e) => set("shared_cds", Number(e.target.value))}>
                    {SHARED_CDS_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Form.Select>
                </Form.Group>
                <Form.Group className="mb-2" controlId="settings-network-plugin">
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
                  <div>
                    <Form.Label htmlFor="settings-remote-url">Remote Docker daemon</Form.Label>
                    {form.remote_url && (
                      <Form.Control
                        id="settings-remote-url"
                        readOnly
                        className="font-monospace mb-1"
                        value={form.remote_url}
                      />
                    )}
                    {form.cert_path && (
                      <Form.Control
                        readOnly
                        className="font-monospace"
                        aria-label="Remote Docker daemon certificate path"
                        value={form.cert_path}
                      />
                    )}
                    <Form.Text className="text-muted">
                      Every deploy, exec and wipe this backend performs targets this daemon instead of
                      the local one. Set outside this app, in Kathara&apos;s settings file — not editable
                      here; change it there and restart the app.
                    </Form.Text>
                  </div>
                )}
              </Panel>
            )}

            <Panel title="Kathara CLI only" className="mb-3">
              <Button
                variant="link"
                size="sm"
                className="p-0 d-inline-flex align-items-center gap-1"
                aria-expanded={cliOnlyOpen}
                aria-controls="settings-cli-only"
                onClick={() => setCliOnlyOpen((v) => !v)}
              >
                {cliOnlyOpen ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
                {cliOnlyOpen ? "Hide" : "Show"} Terminal, Open terminals on device start, Print startup log
              </Button>
              <Collapse in={cliOnlyOpen}>
                <div id="settings-cli-only">
                  <p className="text-muted small mt-2">
                    Used by the <code>kathara</code> command; Kathara Desktop ignores them.
                  </p>
                  <Form.Group className="mb-2" controlId="settings-terminal">
                    <Form.Label>Terminal</Form.Label>
                    <Form.Control value={form.terminal ?? ""} onChange={(e) => set("terminal", e.target.value)} />
                  </Form.Group>
                  <Form.Check
                    id="settings-open-terminals"
                    className="mb-2"
                    type="checkbox"
                    label="Open terminals on device start"
                    checked={form.open_terminals ?? false}
                    onChange={(e) => set("open_terminals", e.target.checked)}
                  />
                  <Form.Check
                    id="settings-print-startup-log"
                    type="checkbox"
                    label="Print startup log"
                    checked={form.print_startup_log ?? false}
                    onChange={(e) => set("print_startup_log", e.target.checked)}
                  />
                </div>
              </Collapse>
            </Panel>

            <Button type="submit" disabled={busy}>
              {busy ? "Saving..." : "Save Kathara settings"}
            </Button>
          </Form>
        </Tab>
      </Tabs>

      <div className="border-top mt-4 pt-4">
        <BackToWorkspace />
      </div>
    </div>
  );
}
