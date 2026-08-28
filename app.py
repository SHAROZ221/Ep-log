import os
import uuid

from flask import Flask, jsonify, request, render_template
from dotenv import load_dotenv
from supabase import create_client, Client

load_dotenv()

app = Flask(__name__)

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

STATUSES = {"watching", "on-hold", "dropped", "completed", "plan-to-watch"}


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

    entry = {
        "id": str(uuid.uuid4()),
        "title": title,
        "episode": int(body.get("episode", 0) or 0),
        "status": body.get("status") if body.get("status") in STATUSES else "watching",
        "notes": body.get("notes", "").strip(),
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

    if not updates:
        return jsonify({"error": "No valid fields to update."}), 400

    response = supabase.table("anime").update(updates).eq("id", anime_id).execute()
    if not response.data:
        return jsonify({"error": "Not found. Did you drop this one and forget?"}), 404
    return jsonify(response.data[0])


@app.route("/api/anime/<anime_id>", methods=["DELETE"])
def delete_anime(anime_id):
    response = supabase.table("anime").delete().eq("id", anime_id).execute()
    if not response.data:
        return jsonify({"error": "Not found"}), 404
    return jsonify({"deleted": anime_id})


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