const listEl = document.getElementById("anime-list");
const addForm = document.getElementById("add-form");
const recommendBtn = document.getElementById("recommend-btn");
const recommendOutput = document.getElementById("recommend-output");
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

recommendBtn.addEventListener("click", async () => {
  recommendOutput.className = "recommend-output loading";
  recommendOutput.textContent = "Thinking about what you'd like next…";
  recommendBtn.disabled = true;

  try {
    const res = await authFetch("/api/recommend", { method: "POST" });
    const data = await res.json();

    if (!res.ok) {
      recommendOutput.className = "recommend-output error";
      recommendOutput.textContent = data.error || "Something went wrong.";
    } else {
      recommendOutput.className = "recommend-output";
      recommendOutput.textContent = data.recommendation;
    }
  } catch (err) {
    recommendOutput.className = "recommend-output error";
    recommendOutput.textContent = "Couldn't reach the server. Is app.py running?";
  } finally {
    recommendBtn.disabled = false;
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