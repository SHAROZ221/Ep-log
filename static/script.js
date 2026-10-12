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
const personalitySelect = document.getElementById("personality-select");
const spoilerToggle = document.getElementById("spoiler-toggle");
const chatClearBtn = document.getElementById("chat-clear");
const quickBtns = document.querySelectorAll(".quick-btn");
const copilotToggleBtn = document.getElementById("copilot-toggle-btn");
const copilotCloseBtn = document.getElementById("copilot-close-btn");
const copilotDrawer = document.getElementById("copilot-drawer");
const copilotBackdrop = document.getElementById("copilot-backdrop");
const openCopilotShortcut = document.getElementById("open-copilot-shortcut");

let chatHistory = [];
let spoilerGuard = true;
let chatBusy = false;

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
if (openCopilotShortcut) openCopilotShortcut.addEventListener("click", openCopilot);

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
    .map((msg) => {
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
          <div class="chat-bubble-content">${formatAiMessage(msg.content)}</div>
          ${addedNotice}
        </div>
      `;
    })
    .join("");

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ── Send Chat Message ──
async function sendChatMessage(message, action = null, mood = null) {
  if (chatBusy || !message || !message.trim()) return;
  chatBusy = true;

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