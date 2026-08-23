const listEl = document.getElementById("anime-list");
const addForm = document.getElementById("add-form");
const recommendBtn = document.getElementById("recommend-btn");
const recommendOutput = document.getElementById("recommend-output");

function statusClass(status) {
  return "status-" + status;
}

async function loadAnime() {
  const res = await fetch("/api/anime");
  const data = await res.json();
  renderList(data);
}

function renderList(data) {
  if (!data.length) {
    listEl.innerHTML = '<p class="empty-state">Nothing logged yet. Add your first anime up there ↑</p>';
    return;
  }
  listEl.innerHTML = data.map(entry => `
    <div class="anime-card" data-id="${entry.id}">
      <div class="ep-counter">EP ${entry.episode}</div>
      <div class="anime-info">
        <div class="anime-title">${escapeHtml(entry.title)}</div>
        ${entry.notes ? `<div class="anime-notes">${escapeHtml(entry.notes)}</div>` : ""}
      </div>
      <div class="status-tag ${statusClass(entry.status)}">${entry.status}</div>
      <div class="card-actions">
        <button class="icon-btn btn-inc" title="Next episode">+1</button>
        <button class="icon-btn btn-del" title="Remove">delete</button>
      </div>
    </div>
  `).join("");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

addForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = document.getElementById("f-title").value;
  const episode = document.getElementById("f-episode").value;
  const status = document.getElementById("f-status").value;
  const notes = document.getElementById("f-notes").value;

  await fetch("/api/anime", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, episode, status, notes })
  });

  addForm.reset();
  document.getElementById("f-episode").value = 0;
  loadAnime();
});

listEl.addEventListener("click", async (e) => {
  const card = e.target.closest(".anime-card");
  if (!card) return;
  const id = card.dataset.id;

  if (e.target.classList.contains("btn-del")) {
    await fetch(`/api/anime/${id}`, { method: "DELETE" });
    loadAnime();
  }

  if (e.target.classList.contains("btn-inc")) {
    const currentEp = parseInt(card.querySelector(".ep-counter").textContent.replace("EP ", ""), 10);
    await fetch(`/api/anime/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ episode: currentEp + 1 })
    });
    loadAnime();
  }
});

recommendBtn.addEventListener("click", async () => {
  recommendOutput.className = "recommend-output loading";
  recommendOutput.textContent = "Thinking about what you'd like next…";
  recommendBtn.disabled = true;

  try {
    const res = await fetch("/api/recommend", { method: "POST" });
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

loadAnime();