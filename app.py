import os
import time
import uuid

import requests
from flask import Flask, jsonify, request, render_template
from dotenv import load_dotenv
from supabase import create_client, Client

load_dotenv()

app = Flask(__name__)

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

STATUSES = {"watching", "on-hold", "dropped", "completed", "plan-to-watch"}
TIERS = {"S", "A", "B", "C"}

# Rough average episode runtime used to estimate hours watched.
AVG_EPISODE_MINUTES = 24

ANILIST_API_URL = "https://graphql.anilist.co"

ANILIST_QUERY = """
query ($search: String) {
  Media(search: $search, type: ANIME) {
    genres
  }
}
"""


def fetch_genres(title, retries=3):
    """Look up an anime title on AniList and return a comma-separated genre
    string for the best match. Retries on transient errors (timeouts, 5xx).
    Returns '' if nothing is found or all attempts fail (never blocks adding
    the anime)."""
    for attempt in range(1, retries + 1):
        try:
            resp = requests.post(
                ANILIST_API_URL,
                json={"query": ANILIST_QUERY, "variables": {"search": title}},
                timeout=8,
                headers={"Content-Type": "application/json", "Accept": "application/json"},
            )
            resp.raise_for_status()
            payload = resp.json()
            media = (payload.get("data") or {}).get("Media")
            if not media:
                print(f"[genre-lookup] No AniList results for title: {title!r}")
                return ""
            genres = media.get("genres") or []
            genre_str = ", ".join(genres)
            print(f"[genre-lookup] {title!r} -> {genre_str!r}")
            return genre_str
        except Exception as e:
            print(f"[genre-lookup] attempt {attempt}/{retries} FAILED for {title!r}: {type(e).__name__}: {e}")
            if attempt < retries:
                time.sleep(1.5 * attempt)  # backoff: 1.5s, 3s
    return ""


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/anime", methods=["GET"])
def get_anime():
    response = supabase.table("anime").select("*").execute()
    return jsonify(response.data)


@app.route("/api/anime", methods=["POST"])
def add_anime():
    body = request.get_json(force=True)
    title = (body.get("title") or "").strip()
    if not title:
        return jsonify({"error": "Title is required. Even side quests need a name."}), 400

    genre = fetch_genres(title)

    entry = {
        "id": str(uuid.uuid4()),
        "title": title,
        "episode": int(body.get("episode", 0) or 0),
        "status": body.get("status") if body.get("status") in STATUSES else "watching",
        "notes": body.get("notes", "").strip(),
        "genre": genre,
        "tier": body.get("tier") if body.get("tier") in TIERS else None,
    }
    response = supabase.table("anime").insert(entry).execute()
    return jsonify(response.data[0]), 201


@app.route("/api/anime/<anime_id>", methods=["PATCH"])
def update_anime(anime_id):
    body = request.get_json(force=True)
    updates = {}
    if "episode" in body:
        updates["episode"] = int(body["episode"])
    if "status" in body and body["status"] in STATUSES:
        updates["status"] = body["status"]
    if "notes" in body:
        updates["notes"] = body["notes"]
    if "title" in body and body["title"].strip():
        updates["title"] = body["title"].strip()
    if "genre" in body:
        updates["genre"] = (body["genre"] or "").strip()
    if "tier" in body:
        updates["tier"] = body["tier"] if body["tier"] in TIERS else None

    if not updates:
        return jsonify({"error": "No valid fields to update."}), 400

    response = supabase.table("anime").update(updates).eq("id", anime_id).execute()
    if not response.data:
        return jsonify({"error": "Not found. Did you drop this one and forget?"}), 404
    return jsonify(response.data[0])


@app.route("/api/anime/<anime_id>/refresh-genre", methods=["POST"])
def refresh_genre(anime_id):
    response = supabase.table("anime").select("*").eq("id", anime_id).execute()
    if not response.data:
        return jsonify({"error": "Not found"}), 404

    title = response.data[0]["title"]
    genre = fetch_genres(title)
    if not genre:
        return jsonify({"error": "Could not find a genre match right now. Try again later."}), 502

    update_response = supabase.table("anime").update({"genre": genre}).eq("id", anime_id).execute()
    return jsonify(update_response.data[0])


@app.route("/api/anime/<anime_id>", methods=["DELETE"])
def delete_anime(anime_id):
    response = supabase.table("anime").delete().eq("id", anime_id).execute()
    if not response.data:
        return jsonify({"error": "Not found"}), 404
    return jsonify({"deleted": anime_id})


@app.route("/api/stats", methods=["GET"])
def stats():
    response = supabase.table("anime").select("*").execute()
    data = response.data

    total_shows = len(data)
    total_episodes = sum(e.get("episode", 0) or 0 for e in data)
    estimated_minutes = total_episodes * AVG_EPISODE_MINUTES
    estimated_hours = round(estimated_minutes / 60, 1)

    genre_counts = {}
    for e in data:
        raw = (e.get("genre") or "")
        for g in raw.split(","):
            g = g.strip()
            if g:
                genre_counts[g] = genre_counts.get(g, 0) + 1

    top_genres = sorted(genre_counts.items(), key=lambda x: x[1], reverse=True)[:5]

    status_counts = {}
    for e in data:
        s = e.get("status", "watching")
        status_counts[s] = status_counts.get(s, 0) + 1

    return jsonify({
        "total_shows": total_shows,
        "total_episodes": total_episodes,
        "estimated_hours": estimated_hours,
        "top_genres": [{"genre": g, "count": c} for g, c in top_genres],
        "status_breakdown": status_counts,
    })


@app.route("/api/recommend", methods=["POST"])
def recommend():
    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key:
        return jsonify({
            "error": "No GROQ_API_KEY set. Add one to your .env file to unlock recommendations."
        }), 400

    response = supabase.table("anime").select("*").execute()
    data = response.data
    if not data:
        return jsonify({
            "error": "Your list is empty. Add a few anime first so it has something to work with."
        }), 400

    try:
        from groq import Groq
    except ImportError:
        return jsonify({"error": "groq is not installed. Run: pip install groq"}), 500

    watchlist_summary = "\n".join(
        f"- {e['title']} (episode {e['episode']}, status: {e['status']})"
        for e in data
    )

    prompt = f"""You are a sharp, funny anime-recommendation buddy.
Here is my current watchlist:
{watchlist_summary}

Based on this, recommend 3 anime I have NOT already listed above. For each one, give:
1. The title
2. One punchy sentence on why it fits my taste based on my list
3. A rough genre tag

Keep it short, casual, and a little witty. No long paragraphs. Format as a simple numbered list."""

    try:
        client = Groq(api_key=api_key)
    except Exception as e:
        return jsonify({"error": f"Couldn't set up Groq client: {str(e)}"}), 500

    try:
        response = client.chat.completions.create(
            model="openai/gpt-oss-120b",
            messages=[{"role": "user", "content": prompt}],
        )
        return jsonify({"recommendation": response.choices[0].message.content})
    except Exception as e:
        return jsonify({"error": f"Groq call failed: {str(e)}"}), 500


if __name__ == "__main__":
    app.run(debug=True, port=5000)