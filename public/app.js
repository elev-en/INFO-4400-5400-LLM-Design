// ─── Screen refs ─────────────────────────────────────────────
const screens = {
  welcome:         document.getElementById("screen-welcome"),
  idReveal:        document.getElementById("screen-id-reveal"),
  home:            document.getElementById("screen-home"),
  chat:            document.getElementById("screen-chat"),
  morningComplete: document.getElementById("screen-morning-complete"),
  morningHome:     document.getElementById("screen-morning-home"),
  eveningEmoji:    document.getElementById("screen-evening-emoji"),
  eveningSlider:   document.getElementById("screen-evening-slider"),
  eveningText:     document.getElementById("screen-evening-text"),
  eveningComplete: document.getElementById("screen-evening-complete"),
};

// ─── Element refs ─────────────────────────────────────────────
// Welcome
const dayLabel        = document.getElementById("dayLabel");
const switchAccountBtn= document.getElementById("switchAccountBtn");
const participantId   = document.getElementById("participantId");
const authMessage     = document.getElementById("authMessage");
const startStudyBtn   = document.getElementById("startStudyBtn");
const generateIdBtn   = document.getElementById("generateIdBtn");
// ID reveal
const revealedId      = document.getElementById("revealedId");
const gotItBtn        = document.getElementById("gotItBtn");
// Home
const homeDayLabel    = document.getElementById("homeDayLabel");
const homeDate        = document.getElementById("homeDate");
const startRecordBtn  = document.getElementById("startRecordBtn");
// Chat
const chatDate        = document.getElementById("chatDate");
const chatLog         = document.getElementById("chatLog");
const endSessionBtn   = document.getElementById("endSessionBtn");
const micArea         = document.getElementById("micArea");
const micBtn          = document.getElementById("micBtn");
const micLabel        = document.getElementById("micLabel");
const concludeBtn     = document.getElementById("concludeBtn");
const reviewArea      = document.getElementById("reviewArea");
const playbackBtn     = document.getElementById("playbackBtn");
const recDuration     = document.getElementById("recDuration");
const confirmBtn      = document.getElementById("confirmBtn");
const rerecordBtn     = document.getElementById("rerecordBtn");
const processingArea  = document.getElementById("processingArea");
const hiddenAudio     = document.getElementById("hiddenAudio");
// Morning complete
const morningDayText  = document.getElementById("morningDayText");
const goToMorningHomeBtn = document.getElementById("goToMorningHomeBtn");
// Morning home
const startEveningBtn = document.getElementById("startEveningBtn");
const skipEveningBtn  = document.getElementById("skipEveningBtn");
// Evening emoji
const emojiGrid       = document.getElementById("emojiGrid");
const emojiNextBtn    = document.getElementById("emojiNextBtn");
// Evening slider
const intensitySlider = document.getElementById("intensitySlider");
const sliderNextBtn   = document.getElementById("sliderNextBtn");
// Evening text
const eveningTextInput= document.getElementById("eveningTextInput");
const skipTextBtn     = document.getElementById("skipTextBtn");
const submitEveningBtn= document.getElementById("submitEveningBtn");
// Evening complete
const eveningDoneBtn  = document.getElementById("eveningDoneBtn");

// ─── State ───────────────────────────────────────────────────
let currentUser        = null;
let sessionId          = null;
let currentDayNumber   = 1;
const conversation     = [];
let currentQuestion    = null;
let recordedBlob       = null;
let recordingStartedAt = null;
let mediaRecorder      = null;
let recordedChunks     = [];
let audioStream        = null;
let isRecording        = false;
let recTimer           = null;
let recSeconds         = 0;
// Evening state
let selectedEmoji      = null;
let selectedIntensity  = 3;

// ─── Boot ────────────────────────────────────────────────────
init();

function init() {
  setDateLabels();
  wireEvents();
  hydrateUser();
}

function wireEvents() {
  // Welcome
  startStudyBtn.addEventListener("click", handleStartStudy);
  generateIdBtn.addEventListener("click", handleGenerateId);
  switchAccountBtn.addEventListener("click", handleSwitchAccount);
  // ID reveal
  gotItBtn.addEventListener("click", () => launchHome());
  // Home
  startRecordBtn.addEventListener("click", startChat);
  // Chat
  micBtn.addEventListener("click", toggleRecording);
  concludeBtn.addEventListener("click", handleConclude);
  playbackBtn.addEventListener("click", togglePlayback);
  confirmBtn.addEventListener("click", sendRecording);
  rerecordBtn.addEventListener("click", resetToMic);
  endSessionBtn.addEventListener("click", handleConclude);
  hiddenAudio.addEventListener("ended", resetPlaybackIcon);
  // Morning complete / home
  goToMorningHomeBtn.addEventListener("click", () => showScreen("morningHome"));
  startEveningBtn.addEventListener("click", () => showScreen("eveningEmoji"));
  skipEveningBtn.addEventListener("click", handleSkipEvening);
  // Evening emoji
  emojiGrid.addEventListener("click", handleEmojiSelect);
  emojiNextBtn.addEventListener("click", () => showScreen("eveningSlider"));
  // Evening slider
  intensitySlider.addEventListener("input", () => {
    selectedIntensity = parseInt(intensitySlider.value, 10);
  });
  sliderNextBtn.addEventListener("click", () => showScreen("eveningText"));
  // Evening text
  skipTextBtn.addEventListener("click", () => submitEvening(null));
  submitEveningBtn.addEventListener("click", () => submitEvening(eveningTextInput.value.trim() || null));
  // Evening complete
  eveningDoneBtn.addEventListener("click", handleEveningDone);
}

// ─── Screen management ───────────────────────────────────────
function showScreen(name) {
  Object.entries(screens).forEach(([key, el]) => { el.hidden = key !== name; });
}

// ─── Date labels ─────────────────────────────────────────────
function setDateLabels() {
  const now = new Date();
  const long = now.toLocaleDateString("en-US", { weekday:"long", month:"long", day:"numeric", year:"numeric" });
  if (chatDate)  chatDate.textContent  = long;
  if (homeDate)  homeDate.textContent  = long;
}

// ─── Day label helpers ────────────────────────────────────────
function setDayNumber(n) {
  currentDayNumber = n;
  dayLabel.textContent       = `Day ${n}`;
  homeDayLabel.textContent   = `DAY ${n}`;
  morningDayText.textContent = `Day ${n} of 14`;
}

// ─── User hydration ──────────────────────────────────────────
function hydrateUser() {
  const stored = localStorage.getItem("morning-mirror-user");
  if (!stored) return;
  try {
    currentUser = JSON.parse(stored);
    participantId.value = currentUser.username;
    startStudyBtn.textContent = "Continue study";
    generateIdBtn.hidden = true;
    switchAccountBtn.hidden = false;
  } catch {
    localStorage.removeItem("morning-mirror-user");
  }
}

// ─── Auth ────────────────────────────────────────────────────
function showMsg(text, type = "error") {
  authMessage.textContent = text;
  authMessage.className = `auth-message ${type}`;
  authMessage.hidden = false;
}
function clearMsg() { authMessage.hidden = true; }

async function apiPost(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request to ${path} failed.`);
  return data;
}

async function handleStartStudy() {
  const id = participantId.value.trim();
  if (!id) { showMsg("Please enter your Participant ID."); return; }

  startStudyBtn.disabled = true;
  startStudyBtn.textContent = "Starting…";
  clearMsg();

  try {
    let data;
    try {
      data = await apiPost("/api/login", { username: id, password: id });
    } catch {
      data = await apiPost("/api/register", { username: id, password: id });
    }
    currentUser = data.user;
    localStorage.setItem("morning-mirror-user", JSON.stringify(currentUser));
    setDayNumber(data.dayNumber ?? 1);
    await launchSession();
  } catch (err) {
    showMsg(err.message);
    startStudyBtn.disabled = false;
    startStudyBtn.textContent = currentUser ? "Continue study" : "Start Study";
  }
}

async function handleGenerateId() {
  const id = `P-${Math.floor(1000 + Math.random() * 9000)}`;
  generateIdBtn.disabled = true;
  generateIdBtn.textContent = "Generating…";
  clearMsg();

  try {
    const data = await apiPost("/api/register", { username: id, password: id });
    currentUser = data.user;
    localStorage.setItem("morning-mirror-user", JSON.stringify(currentUser));
    setDayNumber(1);
    // Show ID reveal screen before going to home
    revealedId.textContent = id.toUpperCase();
    showScreen("idReveal");
    // Pre-create the session in background so home→chat is fast
    await createSession();
  } catch (err) {
    showMsg(err.message);
    generateIdBtn.disabled = false;
    generateIdBtn.textContent = "Generate Participant ID";
  }
}

function handleSwitchAccount() {
  currentUser = null;
  sessionId   = null;
  localStorage.removeItem("morning-mirror-user");
  participantId.value = "";
  dayLabel.textContent = "Day 1";
  startStudyBtn.textContent = "Start Study";
  startStudyBtn.disabled = false;
  generateIdBtn.hidden = false;
  switchAccountBtn.hidden = true;
  clearMsg();
  showScreen("welcome");
}

// ─── Session lifecycle ────────────────────────────────────────
async function createSession() {
  const { sessionId: sid, dayNumber } = await apiPost("/api/session", {
    userAgent: navigator.userAgent,
    userId:    currentUser.id,
    username:  currentUser.username
  });
  sessionId = sid;
  setDayNumber(dayNumber);
}

async function launchSession() {
  await createSession();
  launchHome();
}

function launchHome() {
  conversation.length = 0;
  chatLog.innerHTML   = "";
  showScreen("home");
}

// ─── Home → Chat ─────────────────────────────────────────────
async function startChat() {
  startRecordBtn.disabled = true;
  startRecordBtn.textContent = "Loading…";
  showScreen("chat");

  try {
    const { openingQuestion } = await apiPost("/api/session/start", { sessionId });
    currentQuestion = openingQuestion;
    conversation.push({ role: "assistant", content: openingQuestion });
    appendBubble("assistant", openingQuestion);
    setChatState("idle");
  } catch (err) {
    console.error(err);
  } finally {
    startRecordBtn.disabled = false;
    startRecordBtn.textContent = "Record";
  }
}

// ─── Chat UI states ──────────────────────────────────────────
function setChatState(state) {
  micArea.hidden       = state === "review" || state === "processing";
  reviewArea.hidden    = state !== "review";
  processingArea.hidden= state !== "processing";

  // Show conclude button after first complete exchange
  concludeBtn.hidden = conversation.length < 4;

  if (state === "idle") {
    micBtn.classList.remove("recording");
    micLabel.textContent = "TAP TO SPEAK";
  } else if (state === "recording") {
    micBtn.classList.add("recording");
  }
}

// ─── Recording ───────────────────────────────────────────────
async function toggleRecording() {
  if (isRecording) { stopRecording(); return; }

  try {
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    micLabel.textContent = "Microphone access denied.";
    return;
  }

  recordedChunks = [];
  mediaRecorder  = new MediaRecorder(audioStream);

  mediaRecorder.addEventListener("dataavailable", (e) => {
    if (e.data.size > 0) recordedChunks.push(e.data);
  });

  mediaRecorder.addEventListener("stop", () => {
    recordedBlob    = new Blob(recordedChunks, { type: mediaRecorder.mimeType });
    hiddenAudio.src = URL.createObjectURL(recordedBlob);
    recDuration.textContent = formatTime(recSeconds);
    setChatState("review");
  });

  mediaRecorder.start();
  isRecording        = true;
  recordingStartedAt = new Date().toISOString();
  recSeconds         = 0;
  recTimer = setInterval(() => {
    recSeconds++;
    micLabel.textContent = `TAP TO STOP  •  ${formatTime(recSeconds)}`;
  }, 1000);
  setChatState("recording");
}

function stopRecording() {
  clearInterval(recTimer); recTimer = null; isRecording = false;
  if (mediaRecorder?.state !== "inactive") mediaRecorder.stop();
  audioStream?.getTracks().forEach((t) => t.stop());
}

function resetToMic() {
  recordedBlob = null; recordingStartedAt = null;
  hiddenAudio.removeAttribute("src");
  resetPlaybackIcon();
  setChatState("idle");
}

function formatTime(s) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ─── Playback ────────────────────────────────────────────────
function togglePlayback() {
  if (hiddenAudio.paused) {
    hiddenAudio.play();
    playbackBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="white"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
  } else {
    hiddenAudio.pause();
    resetPlaybackIcon();
  }
}
function resetPlaybackIcon() {
  playbackBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
}

// ─── Send recording ──────────────────────────────────────────
async function sendRecording() {
  if (!recordedBlob || !sessionId) return;
  setChatState("processing");

  try {
    const base64Audio = await blobToBase64(recordedBlob);
    const data = await apiPost("/api/chat", {
      audio: base64Audio, mimeType: recordedBlob.type || "audio/webm",
      messages: conversation, sessionId,
      questionText: currentQuestion, recordingStartedAt
    });

    conversation.push({ role: "user",      content: data.transcript });
    appendBubble("user",      data.transcript);
    conversation.push({ role: "assistant", content: data.reply });
    appendBubble("assistant", data.reply);

    currentQuestion    = data.reply;
    recordedBlob       = null;
    recordingStartedAt = null;
    hiddenAudio.removeAttribute("src");
    resetPlaybackIcon();
    setChatState("idle");
  } catch (err) {
    console.error(err);
    setChatState("review");
  }
}

// ─── Conclude ────────────────────────────────────────────────
function handleConclude() {
  if (conversation.length < 2 && !confirm("End this session?")) return;
  showScreen("morningComplete");
}

// ─── Evening flow ────────────────────────────────────────────
function handleEmojiSelect(e) {
  const btn = e.target.closest(".emoji-btn");
  if (!btn) return;
  document.querySelectorAll(".emoji-btn").forEach((b) => b.classList.remove("selected"));
  btn.classList.add("selected");
  selectedEmoji = btn.dataset.emoji;
  emojiNextBtn.disabled = false;
}

async function submitEvening(text) {
  try {
    await apiPost("/api/evening", {
      sessionId,
      emoji:      selectedEmoji,
      intensity:  selectedIntensity,
      reflection: text
    });
  } catch (err) {
    console.error("Evening submit failed:", err);
  }
  showScreen("eveningComplete");
}

function handleSkipEvening() {
  showScreen("welcome");
  resetWelcome();
}

function handleEveningDone() {
  showScreen("welcome");
  resetWelcome();
}

function resetWelcome() {
  sessionId = null;
  conversation.length = 0;
  chatLog.innerHTML   = "";
  selectedEmoji       = null;
  selectedIntensity   = 3;
  eveningTextInput.value = "";
  document.querySelectorAll(".emoji-btn").forEach((b) => b.classList.remove("selected"));
  emojiNextBtn.disabled = true;
  intensitySlider.value = 3;
  startStudyBtn.disabled = false;
  startStudyBtn.textContent = "Continue study";
  generateIdBtn.hidden = true;
  switchAccountBtn.hidden = false;
  clearMsg();
}

// ─── Render bubble ───────────────────────────────────────────
function appendBubble(role, text) {
  const time = new Date().toLocaleTimeString("en-US", { hour:"numeric", minute:"2-digit" });
  const el   = document.createElement("div");
  el.className = `chat-bubble ${role}`;
  el.innerHTML = `
    <div class="bubble-body ${role === "user" ? "user-body" : ""}">
      <p>${escapeHtml(text)}</p>
    </div>
    <span class="bubble-time">${time}</span>
  `;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
}

// ─── Utilities ───────────────────────────────────────────────
function escapeHtml(str) {
  return str.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
}

async function blobToBase64(blob) {
  const buf   = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
