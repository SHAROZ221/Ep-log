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
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

STATUSES = {"watching", "on-hold", "dropped", "completed", "plan-to-watch"}
TIERS = {"S", "A", "B", "C"}


def get_current_user():
    """Validate the Bearer token from the Authorization header against
    Supabase Auth and return the user object, or None if missing/invalid."""
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return None
    token = auth_header.split(" ", 1)[1]
    try:
        user_response = supabase.auth.get_user(token)
        return user_response.user
    except Exception:
        return None


def require_user():
    """Helper for routes: returns (user, None) or (None, error_response)."""
    user = get_current_user()
    if not user:
        return None, (jsonify({"error": "Not signed in."}), 401)
    return user, None

# Rough average episode runtime used to estimate hours watched.
AVG_EPISODE_MINUTES = 24

ANILIST_API_URL = "https://graphql.anilist.co"

ANILIST_QUERY = """
query ($search: String) {
  Media(search: $search, type: ANIME) {
    genres
    format
  }
}
"""

# Map AniList's format values to a simple TV / Movie label. Anything not
# explicitly a movie is treated as TV (covers TV, OVA, ONA, Special, Music).
ANILIST_FORMAT_MAP = {
    "MOVIE": "Movie",
}


def fetch_metadata(title, retries=3):
    """Look up an anime title on AniList and return (genre_str, type_str) for
    the best match. Retries on transient errors (timeouts, 5xx). Returns
    ('', '') if nothing is found or all attempts fail (never blocks adding
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
                print(f"[metadata-lookup] No AniList results for title: {title!r}")
                return "", ""
            genres = media.get("genres") or []
            genre_str = ", ".join(genres)
            type_str = ANILIST_FORMAT_MAP.get(media.get("format"), "TV")
            print(f"[metadata-lookup] {title!r} -> genre={genre_str!r} type={type_str!r}")
            return genre_str, type_str
        except Exception as e:
            print(f"[metadata-lookup] attempt {attempt}/{retries} FAILED for {title!r}: {type(e).__name__}: {e}")
            if attempt < retries:
                time.sleep(1.5 * attempt)  # backoff: 1.5s, 3s
    return "", ""


@app.route("/")
def index():
    return render_template(
        "index.html",
        supabase_url=SUPABASE_URL,
        supabase_anon_key=SUPABASE_ANON_KEY,
    )


@app.route("/api/legacy-count", methods=["GET"])
def legacy_count():
    """Returns how many rows still have no user_id, so the frontend only
    shows the claim banner when there's actually something to claim."""
    user, err = require_user()
    if err:
        return err

    response = supabase.table("anime").select("id").is_("user_id", "null").execute()
    return jsonify({"count": len(response.data)})


@app.route("/api/claim-legacy", methods=["POST"])
def claim_legacy():
    """One-time migration helper: assigns any pre-auth entries (user_id is
    null) to the currently signed-in user. Safe to call multiple times —
    once claimed, rows won't match the null filter again."""
    user, err = require_user()
    if err:
        return err

    response = (
        supabase.table("anime")
        .update({"user_id": user.id})
        .is_("user_id", "null")
        .execute()
    )
    return jsonify({"claimed": len(response.data)})


@app.route("/api/anime", methods=["GET"])
def get_anime():
    user, err = require_user()
    if err:
        return err
    response = supabase.table("anime").select("*").eq("user_id", user.id).execute()
    return jsonify(response.data)


@app.route("/api/anime", methods=["POST"])
def add_anime():
    user, err = require_user()
    if err:
        return err

    body = request.get_json(force=True)
    title = (body.get("title") or "").strip()
    if not title:
        return jsonify({"error": "Title is required. Even side quests need a name."}), 400

    genre, media_type = fetch_metadata(title)

    entry = {
        "id": str(uuid.uuid4()),
        "user_id": user.id,
        "title": title,
        "episode": int(body.get("episode", 0) or 0),
        "status": body.get("status") if body.get("status") in STATUSES else "watching",
        "notes": body.get("notes", "").strip(),
        "genre": genre,
        "tier": body.get("tier") if body.get("tier") in TIERS else None,
        "type": media_type or None,
    }
    response = supabase.table("anime").insert(entry).execute()
    return jsonify(response.data[0]), 201


@app.route("/api/anime/<anime_id>", methods=["PATCH"])
def update_anime(anime_id):
    user, err = require_user()
    if err:
        return err

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
    if "type" in body and body["type"] in {"TV", "Movie"}:
        updates["type"] = body["type"]

    if not updates:
        return jsonify({"error": "No valid fields to update."}), 400

    response = (
        supabase.table("anime")
        .update(updates)
        .eq("id", anime_id)
        .eq("user_id", user.id)
        .execute()
    )
    if not response.data:
        return jsonify({"error": "Not found. Did you drop this one and forget?"}), 404
    return jsonify(response.data[0])


@app.route("/api/anime/<anime_id>/refresh-genre", methods=["POST"])
def refresh_genre(anime_id):
    user, err = require_user()
    if err:
        return err

    response = (
        supabase.table("anime").select("*").eq("id", anime_id).eq("user_id", user.id).execute()
    )
    if not response.data:
        return jsonify({"error": "Not found"}), 404

    title = response.data[0]["title"]
    genre, media_type = fetch_metadata(title)
    if not genre and not media_type:
        return jsonify({"error": "Could not find a match right now. Try again later."}), 502

    updates = {}
    if genre:
        updates["genre"] = genre
    if media_type:
        updates["type"] = media_type

    update_response = (
        supabase.table("anime")
        .update(updates)
        .eq("id", anime_id)
        .eq("user_id", user.id)
        .execute()
    )
    return jsonify(update_response.data[0])


@app.route("/api/anime/<anime_id>", methods=["DELETE"])
def delete_anime(anime_id):
    user, err = require_user()
    if err:
        return err

    response = (
        supabase.table("anime")
        .delete()
        .eq("id", anime_id)
        .eq("user_id", user.id)
        .execute()
    )
    if not response.data:
        return jsonify({"error": "Not found"}), 404
    return jsonify({"deleted": anime_id})


@app.route("/api/stats", methods=["GET"])
def stats():
    user, err = require_user()
    if err:
        return err

    response = supabase.table("anime").select("*").eq("user_id", user.id).execute()
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
    user, err = require_user()
    if err:
        return err

    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key:
        return jsonify({
            "error": "No GROQ_API_KEY set. Add one to your .env file to unlock recommendations."
        }), 400

    response = supabase.table("anime").select("*").eq("user_id", user.id).execute()
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