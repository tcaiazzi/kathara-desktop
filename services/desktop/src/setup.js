// The script of setup.html, the page the shell shows while it starts and when it can't: a file of
// its own because the page's Content-Security-Policy runs no inline script.

// macOS keeps its native traffic lights (titleBarStyle: "hidden" only hides the bar, not
// the buttons); everywhere else this window has none at all.
if (window.katharaDesktop.platform !== "darwin") {
  document.body.classList.add("kt-has-captions");
  const captions = document.createElement("div");
  captions.className = "kt-captions";
  captions.innerHTML = `
    <button type="button" class="kt-caption-btn" aria-label="Minimize" title="Minimize">&#x2212;</button>
    <button type="button" class="kt-caption-btn close" aria-label="Close" title="Close">&#x2715;</button>`;
  captions.children[0].onclick = () => void window.katharaDesktop.minimizeWindow();
  captions.children[1].onclick = () => void window.katharaDesktop.closeWindow();
  document.body.prepend(captions);
}

const app = document.getElementById("app");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// KEEP IN SYNC with the BootPhase union in main.ts. Order matters: it's the ladder below.
const MAIN_PHASES = ["environment", "frontend", "docker", "python", "backend"];
const PHASE_LABEL = {
  environment: "Reading your shell environment",
  frontend: "Preparing the interface",
  docker: "Contacting Docker",
  python: "Looking for Python and the Kathara packages",
  backend: "Starting the local Kathara API",
};

// Same repo pyproject.toml lists under "Bug Reports" — the canonical upstream, not the
// fork updateCheck.ts polls for releases (see that file's own comment on the difference).
const ISSUES_URL = "https://github.com/KatharaFramework/kathara-desktop/issues/new";

// Phase-specific reassurance once a step has been running a while, so a slow step reads as
// "still working" instead of "stuck". Purely client-side: computed from status.startedAt,
// which is set once per boot attempt and doesn't change between polls.
const PATIENCE_HINTS = [
  { phase: "docker", afterSec: 6, text: "Docker is taking a while to answer. If you just started Docker Desktop, it may still be warming up." },
  { phase: "python", afterSec: 8, text: "Still checking the bundled Python environment." },
  { phase: "backend", afterSec: 12, text: "The first start is the slowest one — Python is loading Kathara." },
];

function ladderHtml(phase) {
  const currentIdx = MAIN_PHASES.indexOf(phase);
  const items = MAIN_PHASES.map((id, i) => {
    const state = i < currentIdx ? "done" : i === currentIdx ? "current" : "pending";
    const mark = state === "done" ? "✓" : state === "current" ? '<span class="spinner"></span>' : "·";
    return `<li class="ladder-${state}"><span class="mark">${mark}</span> ${esc(PHASE_LABEL[id])}…</li>`;
  }).join("");
  return `<ul class="ladder">${items}</ul>`;
}

// The checks list grows incrementally as runPreflight decides each one (see prereqs.ts's
// onProgress) — this is the same rendering used later on the failure screens, so a check
// that appears while still "starting" looks exactly like it will if the run ends up failing.
//
// showRemedy is false while still "starting": preflight decides checks one at a time, so a
// check can be momentarily un-decided while the run is still perfectly on track. Telling the
// user to reinstall the app on the strength of a check the run hasn't finished evaluating is
// exactly the alarming, premature state this avoids — remedies belong on the failure screen,
// which is what renderChecks() is.
function checksHtml(checks, showRemedy = true) {
  if (!checks || checks.length === 0) return "";
  const items = checks.map((c) => {
    // Three states, not two: a failed check with severity "advisory" (only ever a stopped
    // Docker daemon — see prereqs.ts) doesn't block startup, so it shouldn't wear the same
    // ✕ as one that does. It still needs fixing eventually, hence "!" rather than "✓".
    const cls = c.ok ? "ok" : c.severity === "advisory" ? "warn" : "bad";
    const mark = c.ok ? "✓" : c.severity === "advisory" ? "!" : "✕";
    const advisoryNote = !c.ok && c.severity === "advisory"
      ? " Kathara Desktop can still start; you just won't be able to deploy until Docker is running."
      : "";
    return `
    <li class="${cls}">
      <span class="mark">${mark}</span>
      <div>
        <div class="name">${esc(c.label)}</div>
        <div class="detail">${esc(c.detail)}</div>
        ${c.remedy && showRemedy ? `<div class="remedy">${esc(c.remedy)}${esc(advisoryNote)}${
          c.docsUrl ? ` <a href="#" data-url="${esc(c.docsUrl)}">Learn more</a>` : ""
        }</div>` : ""}
      </div>
    </li>`;
  }).join("");
  return `<ul>${items}</ul>`;
}

// A stopped Docker daemon is advisory (prereqs.ts's canStart/severity split) and never reaches
// this page on its own — the app boots straight into the workspace and warns from there
// instead (DockerStatusContext.tsx). So Docker being the *only* thing still failing here
// means it's genuinely missing, not just unstarted: the callout points at installation, not
// at "open the app and wait". This is additive to checksHtml() above, not a replacement: the
// checklist still lists Docker (and its own remedy text) normally underneath, for anyone who
// scrolls past the callout.
function dockerCallout(checks) {
  const failing = checks.filter((c) => !c.ok);
  if (failing.length !== 1 || failing[0].id !== "docker") return "";
  const platform = window.katharaDesktop.platform;
  const product = platform === "darwin" || platform === "win32" ? "Docker Desktop" : "Docker Engine";
  return `
    <div class="callout">
      <span class="icon">🐳</span>
      <div>
        <h2>Install ${esc(product)}</h2>
        <p>${esc(failing[0].remedy ?? failing[0].detail)}</p>
      </div>
    </div>`;
}

function renderStarting(status) {
  const elapsedSec = Math.max(0, Math.round((Date.now() - status.startedAt) / 1000));
  const hint = PATIENCE_HINTS.find((h) => h.phase === status.phase && elapsedSec >= h.afterSec);

  const heading = status.firstRun ? "Welcome to Kathara Desktop" : "Starting Kathara Desktop";
  const lead = status.firstRun
    ? "Kathara Desktop ships with everything it needs to run — its own Python and the Kathara " +
      "packages — so there is nothing to install and nothing to download. The one thing it " +
      "doesn't bundle is the network emulator itself: it drives Docker, which must already be " +
      "installed on this computer (if it's installed but not running yet, that's fine — the " +
      "app starts anyway and reminds you inside). Checking that everything is in place…"
    : esc(status.message) || "Getting the local Kathara API ready…";

  app.innerHTML = `
    <h1>${heading}</h1>
    <p class="sub">${lead}</p>
    ${ladderHtml(status.phase)}
    ${elapsedSec >= 5 ? `<p class="sub">Working on it — ${elapsedSec}s</p>` : ""}
    ${hint ? `<p class="sub">${esc(hint.text)}</p>` : ""}
    ${checksHtml(status.checks, false)}`;

  app.querySelectorAll("a[data-url]").forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); window.katharaDesktop.openExternal(a.dataset.url); };
  });
}

// Shown once, on this machine's very first successful boot attempt, right before the
// backend would otherwise start (see promptForLabsDir() in main.ts). Kept polling every
// 500ms while this state is current, same as renderStarting() — "Continue"/"Choose a
// different folder…" both just fire an IPC call and let the next poll pick up wherever the
// boot attempt lands next, rather than each managing their own follow-up render. Drawn only
// when what it shows changes: redrawing on every poll would wipe the error "Choose…" leaves
// and take the focus and hover off its buttons twice a second.
let labsDirPromptKey = null;
function renderLabsDirPrompt(status) {
  if (labsDirPromptKey === status.defaultDir) return;
  labsDirPromptKey = status.defaultDir;
  const openShortcut = window.katharaDesktop.platform === "darwin" ? "⌘O" : "Ctrl+O";
  app.innerHTML = `
    <h1>Where should Kathara Desktop store your labs?</h1>
    <p class="sub">
      Labs are plain folders on disk, so you can browse and edit them outside the app too.
      You can change this later from Settings.
    </p>
    <div class="labs-dir-label">Default labs folder</div>
    <p class="detail labs-dir-path">${esc(status.defaultDir)}</p>
    <ul class="labs-dir-points">
      <li>
        <span class="mark">⌂</span>
        <div>
          <div class="name">Where the app keeps its labs</div>
          <div>Labs you create, upload or download from the gallery are saved here, and every
            folder you put here shows up in the app as a lab.</div>
        </div>
      </li>
      <li>
        <span class="mark">↗</span>
        <div>
          <div class="name">Labs elsewhere work too</div>
          <div>Open a lab folder from anywhere on disk with File › Open Lab from Folder…
            (${openShortcut}). It stays where it is, and the app remembers it for next time.</div>
        </div>
      </li>
    </ul>
    <div id="labs-dir-error"></div>
    <div class="actions">
      <button class="primary" id="labs-dir-continue">Continue</button>
      <button id="labs-dir-choose">Choose a different folder…</button>
    </div>`;

  document.getElementById("labs-dir-continue").onclick = () => {
    window.katharaDesktop.confirmLabsDir();
  };
  document.getElementById("labs-dir-choose").onclick = async () => {
    const picked = await window.katharaDesktop.pickLabsDir();
    if (!picked) return; // cancelled the native folder picker — stay on this screen
    try {
      // Resolves only once the resulting restart has fully finished — by which point this
      // page has already navigated away, same as SettingsPage.tsx's own handleChange(). A
      // throw here means it never got that far (an unwritable folder, e.g.), so there's
      // something to actually show.
      await window.katharaDesktop.setLabsDir(picked);
    } catch (err) {
      document.getElementById("labs-dir-error").innerHTML =
        `<p class="sub error-text">${esc(err && err.message ? err.message : String(err))}</p>`;
    }
  };
}

// The backend stopped in the middle of a session, and had already been restarted once not
// long before (main.ts's onBackendExit): what happened, the log, and a way to try again.
function renderCrashed(status) {
  app.innerHTML = `
    <h1>The Kathara API stopped</h1>
    <p class="sub">It stopped while the app was in use, soon after being restarted once
      already, so it was left down. Unsaved editor changes are gone; everything saved is on
      disk. Restart it below — if it keeps stopping, the log usually says why.</p>
    <p class="sub">${esc(status.error)}</p>
    <p class="sub">If this looks like a bug, <a href="#" data-url="${ISSUES_URL}">open a GitHub issue</a>
      with the log below pasted in.</p>
    ${status.logTail ? `<details><summary>Technical details</summary><pre>${esc(status.logTail)}</pre></details>` : ""}
    <div class="actions">
      <button class="primary" id="restart">Restart</button>
      <button id="log">Open log</button>
      ${status.logTail ? '<button id="copy-log">Copy log</button>' : ""}
    </div>`;
  document.getElementById("restart").onclick = () => {
    const done = window.katharaDesktop.retryStartup();
    refresh();
    done.catch(() => {});
  };
  wireLogButtons(status);
}

function wireLogButtons(status) {
  document.getElementById("log").onclick = () => window.katharaDesktop.showBackendLog();
  const copyBtn = document.getElementById("copy-log");
  if (copyBtn) {
    // Copies the same tail already shown above under "Technical details" — good enough to
    // paste straight into a GitHub issue without a second round trip to read the full file.
    copyBtn.onclick = () => {
      window.katharaDesktop.copyToClipboard(status.logTail).then(() => {
        copyBtn.textContent = "Copied!";
        setTimeout(() => { copyBtn.textContent = "Copy log"; }, 2000);
      });
    };
  }
  app.querySelectorAll("a[data-url]").forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); window.katharaDesktop.openExternal(a.dataset.url); };
  });
}

function renderChecks(status) {
  const failed = status.state === "prereq-failed";

  app.innerHTML = `
    <h1>${failed ? "A few things are missing" : "Kathara Desktop couldn't start its local API"}</h1>
    <p class="sub">${failed
      ? "Kathara Desktop brings its own Python environment, so the one thing it can't provide " +
        "for you is Docker — that has to already be installed on this computer. (If Docker is " +
        "installed but not running, Kathara Desktop starts anyway and tells you inside the " +
        "app.) Sort out anything marked ✕ below, then choose “Check again”."
      : "Everything it needs is installed, but the API process didn't come up. The " +
        "technical details below usually say why."}</p>
    ${failed ? dockerCallout(status.checks) : ""}
    ${checksHtml(status.checks)}
    ${!failed && status.error ? `<p class="sub">${esc(status.error)}</p>` : ""}
    ${!failed && status.logTail ? `<p class="sub">If this looks like a bug, <a href="#" data-url="${ISSUES_URL}">open a GitHub issue</a> ` +
      `describing the steps that led here, with the log below pasted in — that's what actually gets it fixed.</p>` : ""}
    ${status.logTail ? `<details><summary>Technical details</summary><pre>${esc(status.logTail)}</pre></details>` : ""}
    <div class="actions">
      <button class="primary" id="retry">Check again</button>
      <button id="log">Open log</button>
      ${status.logTail ? '<button id="copy-log">Copy log</button>' : ""}
    </div>`;

  document.getElementById("retry").onclick = () => {
    const done = window.katharaDesktop.retryStartup();
    refresh();
    done.catch(() => {});
  };
  wireLogButtons(status);
}

async function refresh() {
  const status = await window.katharaDesktop.getStatus();
  if (status.theme === "light" || status.theme === "dark") {
    document.documentElement.dataset.theme = status.theme;
  } else {
    delete document.documentElement.dataset.theme;
  }
  if (status.state !== "labs-dir-prompt") labsDirPromptKey = null;
  if (status.state === "starting") {
    renderStarting(status);
    // The shell navigates away once the backend is healthy, so polling only continues
    // while this page is still the one on screen.
    setTimeout(refresh, 500);
  } else if (status.state === "labs-dir-prompt") {
    renderLabsDirPrompt(status);
    setTimeout(refresh, 500);
  } else if (status.state === "backend-crashed") {
    renderCrashed(status);
  } else {
    renderChecks(status);
  }
}

refresh();
