// The script of splash.html, the page shown while the window first loads: a file of its own
// because the page's Content-Security-Policy runs no inline script.

// Purely decorative — no relation to the real boot phases shown later on setup.html if
// startup takes the slow path. Just something fun to look at while the window is blank.
const LOADING_MESSAGES = [
  "Waking up the routers…",
  "Untangling the cables…",
  "Counting the packets…",
  "Bribing the switches…",
  "Asking Docker nicely…",
  "Booting virtual routers…",
  "Warming up the terminals…",
  "Herding the interfaces…",
];
const loadingText = document.getElementById("loading-text");
let msgIndex = Math.floor(Math.random() * LOADING_MESSAGES.length);
loadingText.textContent = LOADING_MESSAGES[msgIndex];

// Crossfades rather than swapping instantly — the fade duration below must match the
// ".loading-text" opacity transition in the stylesheet, so the text swap lands exactly
// when it's fully invisible.
function showNextMessage() {
  msgIndex = (msgIndex + 1) % LOADING_MESSAGES.length;
  loadingText.classList.add("fading");
  setTimeout(() => {
    loadingText.textContent = LOADING_MESSAGES[msgIndex];
    loadingText.classList.remove("fading");
  }, 250);
}
setInterval(showNextMessage, 2200);

if (window.katharaDesktop.platform !== "darwin") {
  const captions = document.createElement("div");
  captions.className = "kt-captions";
  captions.innerHTML = `
    <button type="button" class="kt-caption-btn" aria-label="Minimize" title="Minimize">&#x2212;</button>
    <button type="button" class="kt-caption-btn close" aria-label="Close" title="Close">&#x2715;</button>`;
  captions.children[0].onclick = () => void window.katharaDesktop.minimizeWindow();
  captions.children[1].onclick = () => void window.katharaDesktop.closeWindow();
  document.body.prepend(captions);
}
