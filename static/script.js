const listEl = document.getElementById("anime-list");
const addForm = document.getElementById("add-form");
const statsOutput = document.getElementById("stats-output");
const typeFilterButtons = document.querySelectorAll(".type-filter-btn");
const claimBanner = document.getElementById("claim-banner");
const claimBtn = document.getElementById("claim-btn");

let currentAnimeData = [];
let currentTypeFilter = "all";

function statusClass(status) {
  return "status-" + status;
}

/** fetch() wrapper that attaches the signed-in user's access token. */
async function authFetch(url, options = {}) {
  const token = getAccessToken();
  const headers = { ...(options.headers || {}) };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return fetch(url, { ...options, headers });
}

async function loadAnime() {
  try {
    const res = await authFetch("/api/anime");
    if (!res.ok) {
      console.warn("loadAnime response not ok:", res.status);
      return;
    }
    const data = await res.json();
    currentAnimeData = Array.isArray(data) ? data : [];
    renderList(applyTypeFilter(currentAnimeData));
  } catch (err) {
    console.error("Failed to load anime list:", err);
  }
}

function applyTypeFilter(data) {
  if (currentTypeFilter === "all") return data;
  return data.filter(entry => (entry.type || "TV") === currentTypeFilter);
}

typeFilterButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    currentTypeFilter = btn.dataset.type;
    typeFilterButtons.forEach(b => b.classList.toggle("active", b === btn));
    renderList(applyTypeFilter(currentAnimeData));
  });
});

function renderList(data) {
  if (!data.length) {
    listEl.innerHTML = '<p class="empty-state">Nothing logged yet. Add your first anime up there ↑</p>';
    return;
  }
  const tiers = ["S", "A", "B", "C"];
  const statusDisplay = {
    "watching": "ON AIR",
    "completed": "COMPLETE",
    "on-hold": "STANDBY",
    "plan-to-watch": "QUEUE",
    "dropped": "DROPPED"
  };

  listEl.innerHTML = data.map(entry => `
    <div class="anime-card" data-id="${entry.id}">
      <div class="ep-counter">EP ${String(entry.episode).padStart(2, '0')}</div>
      <div class="anime-info">
        <div class="anime-title-row">
          <div class="anime-title">${escapeHtml(entry.title)}</div>
          <span class="type-badge">${entry.type === "Movie" ? "FILM" : "TV"}</span>
        </div>
        ${entry.genre
          ? `<div class="anime-genre">${escapeHtml(entry.genre)}</div>`
          : `<button class="genre-refresh-btn" title="Look up genre">► fetch genre</button>`}
        ${entry.notes ? `<div class="anime-notes">${escapeHtml(entry.notes)}</div>` : ""}
        <div class="tier-selector">
          ${tiers.map(t => `<button class="tier-btn tier-${t} ${entry.tier === t ? "active" : ""}" data-tier="${t}">${t}</button>`).join("")}
        </div>
      </div>
      <div class="card-footer">
        <div class="status-tag ${statusClass(entry.status)}">${statusDisplay[entry.status] || entry.status}</div>
        <div class="card-actions">
          <button class="icon-btn btn-inc" title="Next episode">+1 EP</button>
          <button class="icon-btn btn-del" title="Remove">DELETE</button>
        </div>
      </div>
    </div>
  `).join("");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

async function loadStats() {
  try {
    const res = await authFetch("/api/stats");
    const data = await res.json();

    if (!data.total_shows) {
      statsOutput.innerHTML = '<p class="empty-state">No stats yet — add a show to get started.</p>';
      return;
    }

    const genresHtml = data.top_genres.length
      ? data.top_genres.map(g => `<span class="genre-pill">${escapeHtml(g.genre)} <span class="genre-count">${g.count}</span></span>`).join("")
      : '<span class="empty-state">No genre data yet</span>';

    const statusOrder = ["watching", "completed", "on-hold", "plan-to-watch", "dropped"];
    const statusLabels = {
      "watching": "Watching",
      "completed": "Completed",
      "on-hold": "On hold",
      "plan-to-watch": "Plan to watch",
      "dropped": "Dropped"
    };
    const maxStatusCount = Math.max(1, ...Object.values(data.status_breakdown));
    const statusBarsHtml = statusOrder
      .filter(s => data.status_breakdown[s])
      .map(s => {
        const count = data.status_breakdown[s];
        const pct = Math.round((count / maxStatusCount) * 100);
        return `
          <div class="status-bar-row">
            <div class="status-bar-label">${statusLabels[s]}</div>
            <div class="status-bar-track">
              <div class="status-bar-fill ${statusClass(s)}" style="width: ${pct}%"></div>
            </div>
            <div class="status-bar-count">${count}</div>
          </div>
        `;
      }).join("");

    statsOutput.innerHTML = `
      <div class="stats-row">
        <div class="stat-block">
          <div class="stat-value">${data.total_shows}</div>
          <div class="stat-label">shows tracked</div>
        </div>
        <div class="stat-block">
          <div class="stat-value">${data.total_episodes}</div>
          <div class="stat-label">episodes watched</div>
        </div>
        <div class="stat-block">
          <div class="stat-value">${data.estimated_hours}</div>
          <div class="stat-label">hours (est.)</div>
        </div>
      </div>
      <div class="stats-status">
        <div class="stats-subheading">Watch status</div>
        <div class="status-bars">${statusBarsHtml}</div>
      </div>
      <div class="stats-genres">
        <div class="stats-subheading">Top genres</div>
        <div class="genre-pills">${genresHtml}</div>
      </div>
    `;
  } catch (err) {
    statsOutput.innerHTML = '<p class="empty-state">Couldn\'t load stats.</p>';
  }
}

async function refreshAll() {
  await Promise.all([loadAnime(), loadStats()]);
}

addForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = document.getElementById("f-title").value;
  const episode = document.getElementById("f-episode").value;
  const status = document.getElementById("f-status").value;
  const notes = document.getElementById("f-notes").value;

  const submitBtn = addForm.querySelector("button[type=submit]");
  const originalLabel = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = "⏺ RECORDING…";

  try {
    await authFetch("/api/anime", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, episode, status, notes })
    });

    addForm.reset();
    document.getElementById("f-episode").value = 0;
    refreshAll();
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
  }
});

listEl.addEventListener("click", async (e) => {
  const card = e.target.closest(".anime-card");
  if (!card) return;
  const id = card.dataset.id;

  if (e.target.classList.contains("btn-del")) {
    await authFetch(`/api/anime/${id}`, { method: "DELETE" });
    refreshAll();
  }

  if (e.target.classList.contains("btn-inc")) {
    const currentEp = parseInt(card.querySelector(".ep-counter").textContent.replace(/[^0-9]/g, ""), 10) || 0;
    await authFetch(`/api/anime/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ episode: currentEp + 1 })
    });
    refreshAll();
  }

  if (e.target.classList.contains("genre-refresh-btn")) {
    e.target.disabled = true;
    e.target.textContent = "looking up…";
    const res = await authFetch(`/api/anime/${id}/refresh-genre`, { method: "POST" });
    if (!res.ok) {
      e.target.disabled = false;
      e.target.textContent = "retry fetch genre";
    } else {
      refreshAll();
    }
  }

  if (e.target.classList.contains("tier-btn")) {
    const clickedTier = e.target.dataset.tier;
    const isActive = e.target.classList.contains("active");
    // clicking the active tier again clears it, otherwise set the new tier
    const newTier = isActive ? null : clickedTier;
    await authFetch(`/api/anime/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier: newTier })
    });
    refreshAll();
  }
});


claimBtn.addEventListener("click", async () => {
  claimBtn.disabled = true;
  claimBtn.textContent = "Claiming…";
  try {
    const res = await authFetch("/api/claim-legacy", { method: "POST" });
    const data = await res.json();
    claimBanner.style.display = "none";
    if (data.claimed > 0) {
      refreshAll();
    }
  } catch (err) {
    claimBtn.disabled = false;
    claimBtn.textContent = "Claim my old entries";
  }
});

async function initData() {
  await refreshAll();
  try {
    const res = await authFetch("/api/legacy-count");
    if (res.ok) {
      const data = await res.json();
      if (claimBanner) claimBanner.style.display = data.count > 0 ? "flex" : "none";
    }
  } catch (err) {
    if (claimBanner) claimBanner.style.display = "none";
  }
}

// Wait for auth.js to confirm a signed-in session before loading any data.
window.addEventListener("auth-ready", () => {
  initData();
});

// Also trigger immediately if session is already active
if (typeof getAccessToken === "function" && getAccessToken()) {
  initData();
}


// ══════════════════════════════════════════════════════════════════════
// AI CHATBOT ENGINE
// ══════════════════════════════════════════════════════════════════════

const chatMessages = document.getElementById("chat-messages");
const chatInput = document.getElementById("chat-input");
const chatSend = document.getElementById("chat-send");
const voiceRecordBtn = document.getElementById("voice-record-btn");
const voiceLanguage = document.getElementById("voice-language");
const voiceStatus = document.getElementById("voice-status");
const personalitySelect = document.getElementById("personality-select");
const spoilerToggle = document.getElementById("spoiler-toggle");
const chatClearBtn = document.getElementById("chat-clear");
const quickBtns = document.querySelectorAll(".quick-btn");
const copilotToggleBtn = document.getElementById("copilot-toggle-btn");
const copilotCloseBtn = document.getElementById("copilot-close-btn");
const copilotDrawer = document.getElementById("copilot-drawer");
const copilotBackdrop = document.getElementById("copilot-backdrop");

let chatHistory = [];
let spoilerGuard = true;
let chatBusy = false;
let mediaRecorder = null;
let recordingStream = null;
let recordingChunks = [];
let recordingTimer = null;
let activeAudio = null;
let activeAudioUrl = null;
let activeSpeechButton = null;
let speechGeneration = 0;

// ── Drawer Open/Close Mechanics ──
function openCopilot() {
  if (copilotDrawer) {
    copilotDrawer.classList.add("active");
    copilotDrawer.setAttribute("aria-hidden", "false");
  }
  if (copilotBackdrop) copilotBackdrop.classList.add("active");
  if (copilotToggleBtn) copilotToggleBtn.classList.add("drawer-open");
  setTimeout(() => {
    if (chatInput) chatInput.focus();
    if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
  }, 150);
}

function closeCopilot() {
  if (copilotDrawer) {
    copilotDrawer.classList.remove("active");
    copilotDrawer.setAttribute("aria-hidden", "true");
  }
  if (copilotBackdrop) copilotBackdrop.classList.remove("active");
  if (copilotToggleBtn) copilotToggleBtn.classList.remove("drawer-open");
  cancelVoiceRecording();
  stopSpokenReply();
}

function toggleCopilot() {
  if (copilotDrawer && copilotDrawer.classList.contains("active")) {
    closeCopilot();
  } else {
    openCopilot();
  }
}

if (copilotToggleBtn) copilotToggleBtn.addEventListener("click", toggleCopilot);
if (copilotCloseBtn) copilotCloseBtn.addEventListener("click", closeCopilot);
if (copilotBackdrop) copilotBackdrop.addEventListener("click", closeCopilot);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && copilotDrawer && copilotDrawer.classList.contains("active")) {
    closeCopilot();
  }
});


// ── Persistence (localStorage) ──
function loadChatHistory() {
  try {
    const saved = localStorage.getItem("eplog_chat_history_v1");
    if (saved) {
      chatHistory = JSON.parse(saved);
      renderChatMessages();
    }
  } catch (_) {
    chatHistory = [];
  }
}

function saveChatHistory() {
  try {
    // Keep last 40 messages to avoid browser storage quotas
    localStorage.setItem("eplog_chat_history_v1", JSON.stringify(chatHistory.slice(-40)));
  } catch (_) {
    // quota exceeded — silently ignore
  }
}

// ── Markdown-ish Formatter ──
function formatAiMessage(text) {
  if (!text) return "";
  let clean = escapeHtml(text);
  // Bold **text**
  clean = clean.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  // Italic *text*
  clean = clean.replace(/\*(.+?)\*/g, "<em>$1</em>");
  // Bullet points
  clean = clean.replace(/^[\*\-]\s+(.+)$/gm, "<li>$1</li>");
  clean = clean.replace(/(<li>.*<\/li>)/s, "<ul>$1</ul>");
  // Numbered list items
  clean = clean.replace(/^(\d+)\.\s+(.+)$/gm, "<div class='list-num-item'><span class='num-bullet'>$1.</span> $2</div>");
  // Line breaks
  clean = clean.replace(/\n{2,}/g, "<br><br>").replace(/\n/g, "<br>");
  return clean;
}

function renderChatMessages() {
  if (!chatMessages) return;
  if (!chatHistory || chatHistory.length === 0) {
    chatMessages.innerHTML = `
      <div class="chat-welcome">
        <div class="chat-welcome-icon">🤖</div>
        <p class="chat-welcome-title">AI ANIME COPILOT ONLINE</p>
        <p class="chat-welcome-copy">Ask for recommendations, character debates, franchise watch orders, or tap any quick action above.</p>
        <p class="chat-welcome-tip">💡 <em>Tip: You can say "Add Steins;Gate" and I'll log it straight to your archive!</em></p>
      </div>`;
    return;
  }

  chatMessages.innerHTML = chatHistory
    .map((msg, index) => {
      if (msg.role === "user") {
        return `
          <div class="chat-bubble chat-user">
            <div class="chat-bubble-content">${escapeHtml(msg.content)}</div>
          </div>
        `;
      }
      const addedNotice =
        msg.auto_added && msg.auto_added.length
          ? `<div class="chat-auto-added">⚡ LOGGED TO ARCHIVE: <strong>${msg.auto_added.map(escapeHtml).join(", ")}</strong> (Queue status: Plan-to-watch)</div>`
          : "";
      return `
        <div class="chat-bubble chat-ai">
          <div class="chat-bubble-label">AI ADVISOR // 応答</div>
          <button type="button" class="chat-voice-play" data-chat-speak="${index}" aria-label="Speak this reply">🔊 SPEAK</button>
          <div class="chat-bubble-content">${formatAiMessage(msg.content)}</div>
          ${addedNotice}
        </div>
      `;
    })
    .join("");

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ── Send Chat Message ──
function setVoiceStatus(message) {
  if (voiceStatus) voiceStatus.textContent = message;
}

function stopVoiceRecording() {
  if (recordingTimer) clearTimeout(recordingTimer);
  recordingTimer = null;
  if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
}

function cancelVoiceRecording() {
  if (recordingTimer) clearTimeout(recordingTimer);
  recordingTimer = null;
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.onstop = null;
    mediaRecorder.stop();
  }
  recordingStream?.getTracks().forEach(track => track.stop());
  recordingStream = null;
  if (voiceRecordBtn) {
    voiceRecordBtn.disabled = false;
    voiceRecordBtn.classList.remove("is-recording");
    voiceRecordBtn.textContent = "🎙 VOICE";
    voiceRecordBtn.setAttribute("aria-label", "Start voice recording");
  }
}

function encodeWav(audioBuffer) {
  const targetRate = 16000;
  const sourceRate = audioBuffer.sampleRate;
  const outputLength = Math.ceil(audioBuffer.length * targetRate / sourceRate);
  const mono = new Float32Array(outputLength);
  const channels = Array.from({ length: audioBuffer.numberOfChannels }, (_, i) => audioBuffer.getChannelData(i));
  for (let i = 0; i < outputLength; i++) {
    const sourceIndex = i * sourceRate / targetRate;
    const left = Math.floor(sourceIndex);
    const right = Math.min(left + 1, audioBuffer.length - 1);
    const fraction = sourceIndex - left;
    let sample = 0;
    for (const channel of channels) sample += channel[left] * (1 - fraction) + channel[right] * fraction;
    mono[i] = sample / channels.length;
  }
  const wav = new ArrayBuffer(44 + mono.length * 2);
  const view = new DataView(wav);
  const writeText = (offset, value) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  writeText(0, "RIFF");
  view.setUint32(4, 36 + mono.length * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, mono.length * 2, true);
  for (let i = 0; i < mono.length; i++) {
    const sample = Math.max(-1, Math.min(1, mono[i]));
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Blob([wav], { type: "audio/wav" });
}

async function transcribeRecording(blob) {
  let audioContext;
  try {
    setVoiceStatus("Preparing audio…");
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await audioContext.decodeAudioData(await blob.arrayBuffer());
    const wavBlob = encodeWav(decoded);
    await audioContext.close();
    if (wavBlob.size > 5 * 1024 * 1024) throw new Error("Recording is too large. Try a shorter clip.");
    const form = new FormData();
    form.append("audio", wavBlob, "voice.wav");
    form.append("language", voiceLanguage.value);
    setVoiceStatus("Transcribing with Gnani…");
    const response = await authFetch("/api/voice/transcribe", { method: "POST", body: form });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Transcription failed.");
    setVoiceStatus("Heard you — sending to Copilot…");
    sendChatMessage(data.transcript, null, null, true);
  } catch (error) {
    setVoiceStatus(error.message || "Could not transcribe this recording.");
  } finally {
    if (audioContext && audioContext.state !== "closed") await audioContext.close();
  }
}

if (voiceRecordBtn) {
  voiceRecordBtn.addEventListener("click", async () => {
    if (chatBusy) {
      setVoiceStatus("Wait for the current Copilot reply before speaking again.");
      return;
    }
    if (mediaRecorder && mediaRecorder.state === "recording") {
      stopVoiceRecording();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setVoiceStatus("Microphone recording is not supported here.");
      return;
    }
    try {
      voiceRecordBtn.disabled = true;
      recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
        .find(candidate => MediaRecorder.isTypeSupported(candidate));
      mediaRecorder = type ? new MediaRecorder(recordingStream, { mimeType: type }) : new MediaRecorder(recordingStream);
      recordingChunks = [];
      mediaRecorder.ondataavailable = event => {
        if (event.data.size) recordingChunks.push(event.data);
      };
      mediaRecorder.onstop = async () => {
        recordingStream?.getTracks().forEach(track => track.stop());
        recordingStream = null;
        voiceRecordBtn.classList.remove("is-recording");
        voiceRecordBtn.textContent = "🎙 VOICE";
        voiceRecordBtn.setAttribute("aria-label", "Start voice recording");
        await transcribeRecording(new Blob(recordingChunks, { type: mediaRecorder.mimeType }));
      };
      mediaRecorder.start();
      voiceRecordBtn.disabled = false;
      voiceRecordBtn.classList.add("is-recording");
      voiceRecordBtn.textContent = "■ STOP";
      voiceRecordBtn.setAttribute("aria-label", "Stop voice recording");
      setVoiceStatus("Listening… max 30 seconds");
      recordingTimer = setTimeout(stopVoiceRecording, 30000);
    } catch (error) {
      voiceRecordBtn.disabled = false;
      recordingStream?.getTracks().forEach(track => track.stop());
      recordingStream = null;
      setVoiceStatus(error.name === "NotAllowedError" ? "Microphone permission denied." : "Could not access microphone.");
    }
  });
}

function stopSpokenReply() {
  speechGeneration++;
  if (activeAudio) {
    activeAudio.pause();
    activeAudio = null;
  }
  if (activeAudioUrl) {
    URL.revokeObjectURL(activeAudioUrl);
    activeAudioUrl = null;
  }
  if (activeSpeechButton) {
    activeSpeechButton.disabled = false;
    activeSpeechButton.textContent = "🔊 SPEAK";
    activeSpeechButton = null;
  }
}

function plainTextForSpeech(text) {
  return (text || "")
    .replace(/```[\s\S]*?```/g, " code omitted ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/^[\s]*[-+]\s+/gm, "")
    .replace(/^[\s]*\d+\.\s+/gm, "")
    .replace(/[\\*_~`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function speakAssistantReply(text, language, button = null) {
  stopSpokenReply();
  const requestGeneration = speechGeneration;
  activeSpeechButton = button;
  if (button) {
    button.disabled = true;
    button.textContent = "… GENERATING";
  }
  setVoiceStatus("Generating spoken reply with Gnani…");
  try {
    const response = await authFetch("/api/voice/synthesize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: plainTextForSpeech(text),
        language: language === "indic-auto" ? "auto" : language,
      }),
    });
    if (requestGeneration !== speechGeneration) return;
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || "Speech synthesis failed.");
    }
    activeAudioUrl = URL.createObjectURL(await response.blob());
    activeAudio = new Audio(activeAudioUrl);
    if (button) {
      button.textContent = "■ STOP";
      button.disabled = false;
    }
    setVoiceStatus("Copilot is speaking…");
    activeAudio.addEventListener("ended", () => {
      stopSpokenReply();
      setVoiceStatus("Voice ready");
    }, { once: true });
    await activeAudio.play();
  } catch (error) {
    if (requestGeneration !== speechGeneration) return;
    stopSpokenReply();
    setVoiceStatus(error.message || "Could not play this reply.");
  }
}

if (chatMessages) {
  chatMessages.addEventListener("click", async event => {
    const button = event.target.closest("[data-chat-speak]");
    if (!button) return;
    const entry = chatHistory[Number(button.dataset.chatSpeak)];
    if (!entry || entry.role !== "assistant") return;
    if (button === activeSpeechButton) {
      stopSpokenReply();
      setVoiceStatus("Speech stopped");
      return;
    }
    speakAssistantReply(entry.content, voiceLanguage.value, button);
  });
}

window.addEventListener("beforeunload", () => {
  cancelVoiceRecording();
  stopSpokenReply();
});

async function sendChatMessage(message, action = null, mood = null, speakReply = false) {
  if (chatBusy || !message || !message.trim()) return;
  chatBusy = true;
  let replyToSpeak = null;

  const userText = message.trim();
  chatHistory.push({ role: "user", content: userText });
  renderChatMessages();

  // Insert retro typing indicator
  const typingEl = document.createElement("div");
  typingEl.className = "chat-bubble chat-ai chat-typing";
  typingEl.innerHTML = `
    <div class="chat-bubble-label">SCANNING ARCHIVE…</div>
    <div class="typing-dots"><span></span><span></span><span></span></div>
  `;
  chatMessages.appendChild(typingEl);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  if (chatInput) chatInput.value = "";
  if (chatSend) {
    chatSend.disabled = true;
    chatSend.textContent = "…";
  }

  try {
    const personality = personalitySelect ? personalitySelect.value : "mentor";
    const res = await authFetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: userText,
        history: chatHistory.slice(0, -1),
        personality: personality,
        spoiler_guard: spoilerGuard,
        action: action,
        mood: mood,
      }),
    });

    const data = await res.json();
    typingEl.remove();

    if (!res.ok) {
      chatHistory.push({
        role: "assistant",
        content: `⚠️ Mission Warning: ${data.error || "Communication signal lost."}`,
      });
    } else {
      const entry = { role: "assistant", content: data.response };
      if (data.auto_added && data.auto_added.length > 0) {
        entry.auto_added = data.auto_added;
        // Refresh anime watchlist and mission stats live!
        refreshAll();
      }
      chatHistory.push(entry);
      if (speakReply) replyToSpeak = entry;
    }
  } catch (err) {
    typingEl.remove();
    chatHistory.push({
      role: "assistant",
      content: "⚠️ Failed to transmit to server. Ensure app.py is running on port 5000.",
    });
  } finally {
    chatBusy = false;
    if (chatSend) {
      chatSend.disabled = false;
      chatSend.textContent = "▶ SEND";
    }
    renderChatMessages();
    saveChatHistory();
    if (replyToSpeak) {
      const replyIndex = chatHistory.indexOf(replyToSpeak);
      const speakButton = chatMessages.querySelector(`[data-chat-speak="${replyIndex}"]`);
      speakAssistantReply(replyToSpeak.content, voiceLanguage.value, speakButton);
    }
  }
}

// ── Chat Input Listeners ──
if (chatSend) {
  chatSend.addEventListener("click", () => {
    if (chatInput) sendChatMessage(chatInput.value);
  });
}

if (chatInput) {
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage(chatInput.value);
    }
  });
}

// ── Spoiler Guard Toggle ──
if (spoilerToggle) {
  spoilerToggle.addEventListener("click", () => {
    spoilerGuard = !spoilerGuard;
    spoilerToggle.classList.toggle("spoiler-on", spoilerGuard);
    spoilerToggle.classList.toggle("spoiler-off", !spoilerGuard);
    spoilerToggle.innerHTML = spoilerGuard
      ? "🛡️ GUARD: ON"
      : "⚠️ SPOILERS OK";
  });
}

// ── Clear Chat ──
if (chatClearBtn) {
  chatClearBtn.addEventListener("click", () => {
    chatHistory = [];
    localStorage.removeItem("eplog_chat_history_v1");
    renderChatMessages();
  });
}

// ── Personality Selection Persistence ──
if (personalitySelect) {
  const savedPersona = localStorage.getItem("eplog_personality");
  if (savedPersona) personalitySelect.value = savedPersona;
  personalitySelect.addEventListener("change", () => {
    localStorage.setItem("eplog_personality", personalitySelect.value);
  });
}

// ── Quick Actions ──
quickBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    const action = btn.dataset.action;
    const mood = btn.dataset.mood || null;
    const customPrompt = chatInput ? chatInput.value.trim() : "";

    const moodPrompts = {
      sad: "I'm in a melancholy mood 😢 — recommend an anime that hits hard emotionally or offers comfort.",
      hype: "I need pure adrenaline and HYPE! 🔥 What should I watch right now?",
      chill: "Give me something ultra chill and relaxing to wind down with 🌊",
      think: "Recommend a mind-bending, philosophical, or psychological thriller that will make me think 🧠",
    };

    let msg = "";
    if (action === "mood") {
      msg = moodPrompts[mood] || "Recommend an anime to match my mood!";
    } else if (action === "roast") {
      msg = "Roast my anime watchlist! Give me your most brutally funny critique 📊";
    } else if (action === "quiz") {
      msg = "Quiz me! Generate an anime trivia challenge based on my archive 🧩";
    } else if (action === "hidden_gem") {
      msg = "Find me 3 hidden gems or underrated anime that match my taste 💎";
    } else if (action === "vibe_check") {
      msg = "Do a comprehensive VIBE CHECK on my taste based on my logged anime 🪞";
    } else if (action === "insights") {
      msg = "Analyze my archive and give me strategic insights: priorities, blindspots, and patterns 🌟";
    } else if (action === "compare") {
      msg = customPrompt
        ? `Compare: ${customPrompt} ⚔️`
        : "Compare two standout anime from my list (or suggest two iconic rivals to compare) ⚔️";
    } else if (action === "watch_order") {
      msg = customPrompt
        ? `What is the definitive watch order for ${customPrompt}? 📋`
        : "Explain the definitive watch order for a complex franchise (like Fate, Monogatari, or Gundam) 📋";
    }

    sendChatMessage(msg, action === "mood" ? null : action, mood);
  });
});

// Load saved history on auth or ready
window.addEventListener("auth-ready", () => {
  loadChatHistory();
});

if (typeof getAccessToken === "function" && getAccessToken()) {
  loadChatHistory();
}
