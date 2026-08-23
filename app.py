import os
import json
import uuid
from pathlib import Path

from flask import Flask, jsonify, request, render_template
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)

DATA_FILE = Path(__file__).parent / "data.json"

STATUSES = {"watching", "on-hold", "dropped", "completed", "plan-to-watch"}


def load_data():
    if not DATA_FILE.exists():
        return []
    with open(DATA_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def save_data(data):
    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/anime", methods=["GET"])
def get_anime():
    return jsonify(load_data())


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
    data = load_data()
    data.append(entry)
    save_data(data)
    return jsonify(entry), 201


@app.route("/api/anime/<anime_id>", methods=["PATCH"])
def update_anime(anime_id):
    body = request.get_json(force=True)
    data = load_data()
    for entry in data:
        if entry["id"] == anime_id:
            if "episode" in body:
                entry["episode"] = int(body["episode"])
            if "status" in body and body["status"] in STATUSES:
                entry["status"] = body["status"]
            if "notes" in body:
                entry["notes"] = body["notes"]
            if "title" in body and body["title"].strip():
                entry["title"] = body["title"].strip()
            save_data(data)
            return jsonify(entry)
    return jsonify({"error": "Not found. Did you drop this one and forget?"}), 404


@app.route("/api/anime/<anime_id>", methods=["DELETE"])
def delete_anime(anime_id):
    data = load_data()
    new_data = [e for e in data if e["id"] != anime_id]
    if len(new_data) == len(data):
        return jsonify({"error": "Not found"}), 404
    save_data(new_data)
    return jsonify({"deleted": anime_id})


@app.route("/api/recommend", methods=["POST"])
def recommend():
    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key:
        return jsonify({
            "error": "No GROQ_API_KEY set. Add one to your .env file to unlock recommendations."
        }), 400

    data = load_data()
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