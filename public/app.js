const chatLog = document.getElementById("chatLog");
const startChatButton = document.getElementById("startChatButton");
const recordButton = document.getElementById("recordButton");
const sendButton = document.getElementById("sendButton");
const statusText = document.getElementById("statusText");
const playback = document.getElementById("playback");

const conversation = [];
let sessionId = null;
let mediaRecorder;
let recordedChunks = [];
let recordedBlob = null;
let stream;
let isRecording = false;
let currentQuestionText = null;
let recordingStartedAt = null;

initializeSession();
startChatButton.addEventListener("click", startConversation);
recordButton.addEventListener("click", toggleRecording);
sendButton.addEventListener("click", sendRecording);

async function initializeSession() {
  statusText.textContent = "Starting a tracked session...";

  try {
    const response = await fetch("/api/session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        userAgent: navigator.userAgent
      })
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Could not initialize the session.");
    }

    sessionId = data.sessionId;
    statusText.textContent = "Press Start chat to let the agent ask the first question.";
    startChatButton.disabled = false;
  } catch (error) {
    console.error(error);
    statusText.textContent = error.message || "Failed to initialize the session.";
  }
}

async function startConversation() {
  if (conversation.length > 0 || !sessionId) {
    return;
  }

  startChatButton.disabled = true;
  statusText.textContent = "Fetching the first prompt...";

  try {
    const response = await fetch("/api/session/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ sessionId })
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Could not start the conversation.");
    }

    currentQuestionText = data.openingQuestion;
    conversation.push({ role: "assistant", content: currentQuestionText });
    renderMessage("assistant", currentQuestionText);
    recordButton.disabled = false;
    statusText.textContent = "Record a voice response, then send it to the agent.";
  } catch (error) {
    console.error(error);
    startChatButton.disabled = false;
    statusText.textContent = error.message || "Failed to start the conversation.";
  }
}

async function toggleRecording() {
  if (isRecording) {
    mediaRecorder.stop();
    stream.getTracks().forEach((track) => track.stop());
    isRecording = false;
    recordButton.textContent = "Record again";
    statusText.textContent = "Recording captured. Review it or send it to the agent.";
    return;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream);

    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        recordedChunks.push(event.data);
      }
    });

    mediaRecorder.addEventListener("stop", () => {
      recordedBlob = new Blob(recordedChunks, { type: mediaRecorder.mimeType });
      playback.src = URL.createObjectURL(recordedBlob);
      playback.hidden = false;
      sendButton.disabled = false;
    });

    mediaRecorder.start();
    isRecording = true;
    recordingStartedAt = new Date().toISOString();
    sendButton.disabled = true;
    playback.hidden = true;
    recordButton.textContent = "Stop recording";
    statusText.textContent = "Recording in progress...";
  } catch (error) {
    statusText.textContent = "Microphone access failed. Check browser permissions and try again.";
    console.error(error);
  }
}

async function sendRecording() {
  if (!recordedBlob) {
    return;
  }

  sendButton.disabled = true;
  recordButton.disabled = true;
  statusText.textContent = "Transcribing your voice and generating the next reply...";

  try {
    const base64Audio = await blobToBase64(recordedBlob);
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        audio: base64Audio,
        mimeType: recordedBlob.type || "audio/webm",
        messages: conversation,
        sessionId,
        questionText: currentQuestionText,
        recordingStartedAt
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Request failed");
    }

    conversation.push({ role: "user", content: data.transcript });
    renderMessage("user", data.transcript);

    conversation.push({ role: "assistant", content: data.reply });
    renderMessage("assistant", data.reply);
    currentQuestionText = data.reply;
    recordedBlob = null;
    recordingStartedAt = null;
    playback.hidden = true;
    playback.removeAttribute("src");
    recordButton.disabled = false;
    sendButton.disabled = true;
    statusText.textContent = "Record another response whenever you're ready.";
  } catch (error) {
    console.error(error);
    statusText.textContent = error.message || "Something went wrong while sending the recording.";
    sendButton.disabled = false;
    recordButton.disabled = false;
  }
}

function renderMessage(role, text) {
  const message = document.createElement("article");
  message.className = `message ${role}`;
  message.innerHTML = `
    <span class="message-role">${role === "assistant" ? "Agent" : "You"}</span>
    <div>${escapeHtml(text)}</div>
  `;
  chatLog.appendChild(message);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function blobToBase64(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}
