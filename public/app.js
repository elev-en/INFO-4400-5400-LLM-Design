// ─── DOM refs ────────────────────────────────────────────────
const screenWelcome  = document.getElementById("screen-welcome");
const screenChat     = document.getElementById("screen-chat");
const screenComplete = document.getElementById("screen-complete");

// Welcome
const dayLabel        = document.getElementById("dayLabel");
const switchAccountBtn= document.getElementById("switchAccountBtn");
const participantId   = document.getElementById("participantId");
const authMessage     = document.getElementById("authMessage");
const startStudyBtn   = document.getElementById("startStudyBtn");
const generateIdBtn   = document.getElementById("generateIdBtn");

// Chat
const chatDate        = document.getElementById("chatDate");
const chatLog         = document.getElementById("chatLog");
const endSessionBtn   = document.getElementById("endSessionBtn");
const micArea         = document.getElementById("micArea");
const micBtn          = document.getElementById("micBtn");
const micLabel        = document.getElementById("micLabel");
const reviewArea      = document.getElementById("reviewArea");
const playbackBtn     = document.getElementById("playbackBtn");
const recDuration     = document.getElementById("recDuration");
const confirmBtn      = document.getElementById("confirmBtn");
const rerecordBtn     = document.getElementById("rerecordBtn");
const processingArea  = document.getElementById("processingArea");
const hiddenAudio     = document.getElementById("hiddenAudio");

// Complete
const studyDayText = document.getElementById("studyDayText");
const goHomeBtn    = document.getElementById("goHomeBtn");

// ─── State ───────────────────────────────────────────────────
let currentUser        = null;
let sessionId          = null;
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

// ─── Boot ────────────────────────────────────────────────────
init();

function init() {
  setChatDate();
  wireEvents();

  const stored = localStorage.getItem("morning-mirror-user");
  if (!stored) return;

  try {
    currentUser = JSON.parse(stored);
    const day = getStudyDay();
    dayLabel.textContent = `Day ${day}`;
    participantId.value = currentUser.username;
    startStudyBtn.textContent = `Start Day ${day}`;
    generateIdBtn.hidden = true;
    switchAccountBtn.hidden = false;
  } catch {
    localStorage.removeItem("morning-mirror-user");
  }
}

function wireEvents() {
  startStudyBtn.addEventListener("click", handleStartStudy);
  generateIdBtn.addEventListener("click", handleGenerateId);
  switchAccountBtn.addEventListener("click", handleSwitchAccount);
  micBtn.addEventListener("click", toggleRecording);
  playbackBtn.addEventListener("click", togglePlayback);
  confirmBtn.addEventListener("click", sendRecording);
  rerecordBtn.addEventListener("click", resetToMic);
  endSessionBtn.addEventListener("click", handleEndSession);
  goHomeBtn.addEventListener("click", handleGoHome);
  hiddenAudio.addEventListener("ended", resetPlaybackIcon);
}

// ─── Screen management ───────────────────────────────────────
function showScreen(name) {
  screenWelcome.hidden  = name !== "welcome";
  screenChat.hidden     = name !== "chat";
  screenComplete.hidden = name !== "complete";
}

// ─── Date display ─────────────────────────────────────────────
function setChatDate() {
  chatDate.textContent = new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric"
  });
}

// ─── Study-day tracking ──────────────────────────────────────
function studyDayKey() {
  return `morning-mirror-day-${currentUser?.id}`;
}
function getStudyDay() {
  return parseInt(localStorage.getItem(studyDayKey()) || "1", 10);
}
function incrementStudyDay() {
  localStorage.setItem(studyDayKey(), String(getStudyDay() + 1));
}

// ─── Auth helpers ─────────────────────────────────────────────
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

// ─── Welcome actions ─────────────────────────────────────────
async function handleStartStudy() {
  const id = participantId.value.trim();
  if (!id) { showMsg("Please enter your Participant ID."); return; }

  startStudyBtn.disabled = true;
  startStudyBtn.textContent = "Starting…";
  clearMsg();

  try {
    // Attempt login; password is always the same as the ID
    let data;
    try {
      data = await apiPost("/api/login", { username: id, password: id });
    } catch {
      // First-time user — auto-register
      data = await apiPost("/api/register", { username: id, password: id });
    }

    currentUser = data.user;
    localStorage.setItem("morning-mirror-user", JSON.stringify(currentUser));
    await launchSession();
  } catch (err) {
    showMsg(err.message);
    startStudyBtn.disabled = false;
    startStudyBtn.textContent = currentUser
      ? `Start Day ${getStudyDay()}`
      : "Start Study";
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
    participantId.value = id;
    showMsg(`Your ID is ${id} — save it so you can return to the study.`, "success");
    await launchSession();
  } catch (err) {
    showMsg(err.message);
  } finally {
    generateIdBtn.disabled = false;
    generateIdBtn.textContent = "Generate Participant ID";
  }
}

function handleSwitchAccount() {
  currentUser = null;
  localStorage.removeItem("morning-mirror-user");
  participantId.value = "";
  dayLabel.textContent = "Day 1";
  startStudyBtn.textContent = "Start Study";
  generateIdBtn.hidden = false;
  switchAccountBtn.hidden = true;
  clearMsg();
}

// ─── Session flow ────────────────────────────────────────────
async function launchSession() {
  const { sessionId: sid } = await apiPost("/api/session", {
    userAgent: navigator.userAgent,
    userId:    currentUser.id,
    username:  currentUser.username
  });
  sessionId = sid;

  // Reset conversation
  conversation.length = 0;
  chatLog.innerHTML = "";

  const day = getStudyDay();
  studyDayText.textContent = `Day ${day} of 14`;
  showScreen("chat");

  // Fetch opening question
  const { openingQuestion } = await apiPost("/api/session/start", { sessionId });
  currentQuestion = openingQuestion;
  conversation.push({ role: "assistant", content: openingQuestion });
  appendBubble("assistant", openingQuestion);
  setChatState("idle");
}

// ─── Chat UI states ──────────────────────────────────────────
function setChatState(state) {
  micArea.hidden       = state === "review" || state === "processing";
  reviewArea.hidden    = state !== "review";
  processingArea.hidden= state !== "processing";

  if (state === "idle") {
    micBtn.classList.remove("recording");
    micLabel.textContent = "TAP TO SPEAK";
  } else if (state === "recording") {
    micBtn.classList.add("recording");
  }
}

// ─── Recording ───────────────────────────────────────────────
async function toggleRecording() {
  if (isRecording) {
    stopRecording();
    return;
  }

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
    recordedBlob       = new Blob(recordedChunks, { type: mediaRecorder.mimeType });
    hiddenAudio.src    = URL.createObjectURL(recordedBlob);
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
  clearInterval(recTimer);
  recTimer = null;
  isRecording = false;
  if (mediaRecorder?.state !== "inactive") mediaRecorder.stop();
  audioStream?.getTracks().forEach((t) => t.stop());
}

function resetToMic() {
  recordedBlob       = null;
  recordingStartedAt = null;
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
    playbackBtn.innerHTML = pauseIconSvg();
  } else {
    hiddenAudio.pause();
    playbackBtn.innerHTML = playIconSvg();
  }
}

function resetPlaybackIcon() {
  playbackBtn.innerHTML = playIconSvg();
}

function playIconSvg() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="white" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
}
function pauseIconSvg() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="white" aria-hidden="true"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
}

// ─── Send recording ──────────────────────────────────────────
async function sendRecording() {
  if (!recordedBlob || !sessionId) return;

  setChatState("processing");

  try {
    const base64Audio = await blobToBase64(recordedBlob);
    const data = await apiPost("/api/chat", {
      audio:              base64Audio,
      mimeType:           recordedBlob.type || "audio/webm",
      messages:           conversation,
      sessionId,
      questionText:       currentQuestion,
      recordingStartedAt
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
    setChatState("review"); // let user retry
  }
}

// ─── End session ─────────────────────────────────────────────
function handleEndSession() {
  if (conversation.length < 2) {
    if (!confirm("End this session?")) return;
  }
  incrementStudyDay();
  showScreen("complete");
}

function handleGoHome() {
  sessionId = null;
  conversation.length = 0;
  chatLog.innerHTML = "";

  const day = getStudyDay();
  dayLabel.textContent = `Day ${day}`;
  startStudyBtn.textContent = `Start Day ${day}`;
  startStudyBtn.disabled = false;
  generateIdBtn.hidden = true;
  switchAccountBtn.hidden = false;
  clearMsg();
  showScreen("welcome");
}

// ─── Render bubble ───────────────────────────────────────────
function appendBubble(role, text) {
  const time = new Date().toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit"
  });
  const el = document.createElement("div");
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
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function blobToBase64(blob) {
  const buf   = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
