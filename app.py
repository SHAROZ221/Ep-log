import io
import os
import time
import uuid
import wave

import requests
from flask import Flask, jsonify, request, render_template
from dotenv import load_dotenv
from supabase import create_client, Client

load_dotenv()

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 6 * 1024 * 1024

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


@app.errorhandler(413)
def request_too_large(_error):
    return jsonify({"error": "Audio upload is too large. Keep recordings under 30 seconds."}), 413


GNANI_API_KEY = os.environ.get("GNANI_API_KEY")
GNANI_STT_MODEL = os.environ.get("GNANI_STT_MODEL", "prisma-v3.0")
GNANI_TTS_MODEL = os.environ.get("GNANI_TTS_MODEL", "timbre-v3.0")
GNANI_TTS_VOICE = os.environ.get("GNANI_TTS_VOICE", "Shivani")
GNANI_TTS_LANGUAGE = os.environ.get("GNANI_TTS_LANGUAGE", "en-IN")
GNANI_STT_URL = "https://api.vachana.ai/stt/v3"
GNANI_TTS_URL = "https://api.vachana.ai/api/v1/tts/inference"
GNANI_LANGUAGES = {
    "en-IN", "hi-IN", "ta-IN", "te-IN", "kn-IN", "ml-IN", "mr-IN",
    "pa-IN", "bn-IN", "gu-IN", "indic-auto",
}
GNANI_TTS_LANGUAGES = GNANI_LANGUAGES - {"indic-auto"} | {"auto"}


@app.route("/api/voice/transcribe", methods=["POST"])
def transcribe_voice():
    user, err = require_user()
    if err:
        return err
    if not GNANI_API_KEY:
        return jsonify({"error": "Voice input is not configured. Set GNANI_API_KEY on the server."}), 503

    audio = request.files.get("audio")
    language = request.form.get("language", "en-IN")
    if language not in GNANI_LANGUAGES:
        return jsonify({"error": "Choose a supported transcription language."}), 400
    if not audio or not audio.filename:
        return jsonify({"error": "Record a short voice clip first."}), 400
    if audio.mimetype not in {"audio/wav", "audio/x-wav", "audio/wave"}:
        return jsonify({"error": "Upload a WAV recording."}), 400

    audio_bytes = audio.read(5 * 1024 * 1024 + 1)
    if not audio_bytes or len(audio_bytes) > 5 * 1024 * 1024:
        return jsonify({"error": "Audio must be non-empty and under 5 MB."}), 400
    try:
        with wave.open(io.BytesIO(audio_bytes), "rb") as wav_file:
            duration = wav_file.getnframes() / wav_file.getframerate()
            if wav_file.getnchannels() != 1 or wav_file.getsampwidth() != 2:
                return jsonify({"error": "Audio must be mono 16-bit PCM WAV."}), 400
            if duration <= 0 or duration > 30:
                return jsonify({"error": "Recording must be between 1 and 30 seconds."}), 400
    except (wave.Error, EOFError, ZeroDivisionError):
        return jsonify({"error": "The uploaded WAV recording is invalid."}), 400

    try:
        response = requests.post(
            GNANI_STT_URL,
            headers={"X-API-Key-ID": GNANI_API_KEY},
            files={"audio_file": ("voice.wav", audio_bytes, "audio/wav")},
            data={"model": GNANI_STT_MODEL, "language_code": language},
            timeout=45,
        )
        response.raise_for_status()
        result = response.json()
        transcript = (result.get("transcript") or "").strip()
        if not transcript:
            return jsonify({"error": "Gnani did not detect speech. Try recording again."}), 422
        return jsonify({
            "transcript": transcript,
            "detected_language": result.get("detected_language_code"),
        })
    except requests.RequestException as exc:
        status = getattr(getattr(exc, "response", None), "status_code", None)
        app.logger.warning("Gnani transcription request failed (status=%s).", status)
        return jsonify({"error": "Speech transcription is temporarily unavailable. Please try again."}), 502
    except (ValueError, AttributeError):
        return jsonify({"error": "Gnani returned an unreadable transcription response."}), 502


@app.route("/api/voice/synthesize", methods=["POST"])
def synthesize_voice():
    user, err = require_user()
    if err:
        return err
    if not GNANI_API_KEY:
        return jsonify({"error": "Voice playback is not configured. Set GNANI_API_KEY on the server."}), 503

    body = request.get_json(silent=True) or {}
    if not isinstance(body, dict):
        return jsonify({"error": "A JSON object is required."}), 400
    text = body.get("text")
    if not isinstance(text, str) or not text.strip():
        return jsonify({"error": "Text is required."}), 400
    text = text.strip()
    if len(text) > 4000:
        return jsonify({"error": "That reply is too long to speak in one request."}), 400
    language = body.get("language", GNANI_TTS_LANGUAGE)
    if language == "indic-auto":
        language = "auto"
    if not isinstance(language, str) or language not in GNANI_TTS_LANGUAGES:
        return jsonify({"error": "Choose a supported speech language."}), 400

    try:
        response = requests.post(
            GNANI_TTS_URL,
            headers={"X-API-Key-ID": GNANI_API_KEY, "Content-Type": "application/json"},
            json={
                "text": text,
                "model": GNANI_TTS_MODEL,
                "voice": GNANI_TTS_VOICE,
                "language": language,
                "speed": 1.0,
                "audio_config": {
                    "sample_rate": 22050,
                    "num_channels": 1,
                    "sample_width": 2,
                    "encoding": "linear_pcm",
                    "container": "wav",
                },
            },
            timeout=60,
        )
        response.raise_for_status()
        if not response.content:
            return jsonify({"error": "Gnani returned empty audio."}), 502
        from flask import Response
        return Response(response.content, mimetype="audio/wav", headers={"Cache-Control": "no-store"})
    except requests.RequestException as exc:
        status = getattr(getattr(exc, "response", None), "status_code", None)
        app.logger.warning("Gnani speech synthesis failed (status=%s).", status)
        return jsonify({"error": "Speech playback is temporarily unavailable. Please try again."}), 502

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


# ══════════════════════════════════════════════════════════════════════
# AI CHATBOT — Conversational anime advisor with personalities, moods,
# spoiler guard, quick actions, auto-add, and more.
# ══════════════════════════════════════════════════════════════════════

import re

PERSONALITIES = {
    "mentor": {
        "name": "Shonen Mentor 🥊",
        "prompt": (
            "You are a passionate shonen-style anime mentor. Speak with intensity "
            "and encouragement, like a training-arc sensei. Use battle metaphors, "
            "hype language, and treat every recommendation like a power-up. "
            "Call the user 'young warrior' or 'student' occasionally."
        ),
    },
    "bestie": {
        "name": "Slice-of-Life Bestie 🍵",
        "prompt": (
            "You are a warm, cozy slice-of-life friend. Speak casually and gently, "
            "like chatting at a café after school. Appreciate the quiet beauty in "
            "anime and get genuinely excited about wholesome character moments and OSTs."
        ),
    },
    "analyst": {
        "name": "Mecha Analyst ⚙️",
        "prompt": (
            "You are a technical, analytical mecha-style tactical AI. Break things down "
            "systematically, rate on clear metrics (animation, story, sound, "
            "characters), and speak with precise, calculated language. Use terms "
            "like 'data suggests' and 'tactical analysis complete'."
        ),
    },
    "villain": {
        "name": "Villain Monologuer 😈",
        "prompt": (
            "You are a dramatic, theatrical anime villain. Speak with grandiose flair, "
            "dark humor, and dramatic monologues. Mock basic mainstream taste "
            "playfully, but ultimately give genuinely top-tier advice wrapped in villainy."
        ),
    },
}

MOOD_PROMPTS = {
    "sad": (
        "The user is feeling down/sad and wants something comforting, deeply emotional, or "
        "cathartic. Suggest anime that will help them have a good cry or warm their heart."
    ),
    "hype": (
        "The user wants maximum HYPE — adrenaline-pumping, action-packed anime with "
        "incredible animation, legendary fights, power-ups, or tournament arcs. Go all out!"
    ),
    "chill": (
        "The user wants something relaxing — cozy slice of life, iyashikei (healing anime), "
        "or anything with a peaceful, comforting vibe to unwind."
    ),
    "think": (
        "The user wants something intellectually stimulating — psychological thrillers, "
        "philosophical masterworks, mind-bending mysteries, or deep thematic explorations."
    ),
}

ACTION_PROMPTS = {
    "roast": (
        "The user wants you to ROAST their anime taste. Look at their watchlist and "
        "humorously critique their choices, call out basic picks, poke fun at drop/hold choices, "
        "and be playfully savage. Keep it humorous and friendly, ending with one genuine compliment."
    ),
    "quiz": (
        "Generate a fun anime trivia quiz with 3 questions based on shows in the "
        "user's watchlist (or anime classics if list is small). Format each question clearly with A/B/C/D options. "
        "Put the answers at the very bottom hidden under a '--- 🎯 SPOILER / ANSWERS ---' line. "
        "Challenge them from easy to hard!"
    ),
    "hidden_gem": (
        "Recommend 3 hidden gem / underwatched / underrated anime that match the "
        "user's taste based on their watchlist. These should NOT be mainstream blockbuster picks. "
        "Focus on lesser-known, high-quality gems. Explain why each fits them."
    ),
    "vibe_check": (
        "Analyze the user's complete watchlist and generate a fun 'Anime Taste Profile'. Provide:\n"
        "1. A creative honorary title (e.g., 'The Existential Shonen Pilot')\n"
        "2. Dominant vibes (3-4 punchy tags)\n"
        "3. Psychological profile: What their list reveals about their personality\n"
        "4. Biggest blindspot / genre they are sleeping on\n"
        "5. Percentage breakdown (e.g., 60% Adrenaline Junkie, 40% Emotional Masochist)\n"
        "Keep it witty, sharp, and tailored directly to their logged anime."
    ),
    "insights": (
        "Analyze the user's watchlist and provide smart observations:\n"
        "1. Priority Pick: Which show on their on-hold/watching list they should binge next and why\n"
        "2. Unexplored Territory: A genre/era they might love based on their favorites\n"
        "3. Watch habits trend\n"
        "4. Red Flag / Hot Take: One lighthearted hot take about their list\n"
        "Make it insightful and entertaining."
    ),
    "watch_order": (
        "The user is asking about watch order for an anime franchise. "
        "Provide the definitive watch order with clear reasoning. Include release order vs "
        "chronological order, mention movies/OVAs that are canon vs skippable filler, and give "
        "your recommendation for a first-timer."
    ),
    "compare": (
        "The user wants to compare two or more anime. Give a structured breakdown across:\n"
        "1. Story & Narrative Arc\n"
        "2. Character Development & Cast\n"
        "3. Animation, Art Direction & Fight Choreography\n"
        "4. Soundtrack & Sound Design\n"
        "5. Final Verdict & Who would enjoy which more."
    ),
}


def build_system_prompt(watchlist, personality_key, spoiler_guard, action=None, mood=None):
    """Assemble the system prompt from watchlist context, personality, and action."""
    persona = PERSONALITIES.get(personality_key, PERSONALITIES["mentor"])

    watchlist_summary = "\n".join(
        f"- {e.get('title')} (ep {e.get('episode', '?')}, status: {e.get('status', '?')}"
        f"{', tier: ' + e['tier'] if e.get('tier') else ''}"
        f"{', genre: ' + e['genre'] if e.get('genre') else ''})"
        for e in watchlist
    ) if watchlist else "(empty watchlist so far)"

    parts = [
        persona["prompt"],
        "",
        "You are an expert anime conversational chatbot inside the 90s retro-styled anime archive app 'EP. LOG'.",
        "You can discuss anything anime and manga related: recommendations, deep character analysis, plot theories, ",
        "studio comparisons, seasonal anime discussions, franchise watch orders, and friendly banter.",
        "",
        f"The user's current watchlist ({len(watchlist)} titles):",
        watchlist_summary,
        "",
        "Formatting guidelines:",
        "- Use markdown formatting (bold, bullet points) to make responses readable.",
        "- Keep replies punchy, engaging, and faithful to your personality.",
        "- Keep discussions grounded in anime, manga, animation, and Japanese pop culture.",
    ]

    if spoiler_guard:
        parts.append(
            "\n⚠️ SPOILER GUARD IS ACTIVE: Do NOT reveal major plot twists, character deaths, "
            "climax resolutions, or secrets. Keep recommendations and discussions strictly spoiler-free."
        )
    else:
        parts.append(
            "\n⚠️ SPOILER GUARD IS OFF: You may discuss spoilers, ending theories, and character fates "
            "freely if relevant to the user's query."
        )

    if action and action in ACTION_PROMPTS:
        parts.append(f"\n--- SPECIAL DIRECTIVE: {action.upper()} ---\n{ACTION_PROMPTS[action]}")

    if mood and mood in MOOD_PROMPTS:
        parts.append(f"\n--- USER MOOD: {mood.upper()} ---\n{MOOD_PROMPTS[mood]}")

    parts.append(
        "\n⚡ AUTO-ADD CAPABILITY:\n"
        "When you recommend an anime and the user asks to add it (or when you strongly recommend a standout title "
        "and suggest adding it), you can append:\n"
        "[[ADD_ANIME:Exact Official Anime Title]]\n"
        "at the very end of your response. The app will detect this tag, fetch metadata, and automatically insert it "
        "into the user's watchlist!"
    )

    return "\n".join(parts)


def requested_add_title(message):
    """Extract a clear, direct add command; contextual references stay with the LLM."""
    pattern = re.compile(
        r"^(?:(?:hey[, ]+)?(?:please\s+)?(?:can|could|would)\s+you\s+|"
        r"i\s+(?:want|need)\s+you\s+to\s+|please\s+)?"
        r"add\s+(?:(?:the\s+)?anime\s+(?:called\s+)?)?(.+?)"
        r"(?:\s+to\s+(?:(?:my|the)\s+)?(?:archive|watchlist|list))?"
        r"(?:\s+please)?[.!?]*$",
        re.IGNORECASE,
    )
    match = pattern.match(message.strip())
    if not match:
        return None
    title = match.group(1).strip(" \t.,!?\"'")
    if not title or title.casefold() in {"this", "that", "this anime", "that anime", "it"}:
        return None
    return title[:150]


@app.route("/api/chat", methods=["POST"])
def chat():
    user, err = require_user()
    if err:
        return err

    body = request.get_json(force=True) or {}
    message = (body.get("message") or "").strip()
    history = body.get("history", [])
    personality = body.get("personality", "mentor")
    spoiler_guard = body.get("spoiler_guard", True)
    action = body.get("action")
    mood = body.get("mood")

    if not message:
        return jsonify({"error": "Message cannot be empty."}), 400

    # Execute an explicit add command directly so archive updates do not depend
    # on the model remembering to emit its internal auto-add marker.
    title_to_add = requested_add_title(message)
    if title_to_add:
        watchlist_response = (
            supabase.table("anime").select("id,title").eq("user_id", user.id).execute()
        )
        if any((row.get("title") or "").casefold() == title_to_add.casefold() for row in watchlist_response.data):
            return jsonify({
                "response": f"{title_to_add} is already in your archive.",
                "auto_added": [],
            })
        genre, media_type = fetch_metadata(title_to_add)
        entry = {
            "id": str(uuid.uuid4()),
            "user_id": user.id,
            "title": title_to_add,
            "episode": 0,
            "status": "plan-to-watch",
            "notes": "Added via Copilot request",
            "genre": genre,
            "tier": None,
            "type": media_type or None,
        }
        try:
            supabase.table("anime").insert(entry).execute()
        except Exception:
            app.logger.exception("Could not add anime through Copilot for user %s.", user.id)
            return jsonify({"error": "Could not add that anime to your archive. Please try again."}), 502
        return jsonify({
            "response": f"Added {title_to_add} to your archive as plan-to-watch.",
            "auto_added": [title_to_add],
        })

    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key:
        return jsonify({
            "error": "No GROQ_API_KEY set. Add one to your .env file to enable the AI Chatbot."
        }), 400

    # Fetch user's live watchlist for personalized context
    wl_response = supabase.table("anime").select("*").eq("user_id", user.id).execute()
    watchlist = wl_response.data or []

    system_prompt = build_system_prompt(watchlist, personality, spoiler_guard, action, mood)

    messages = [{"role": "system", "content": system_prompt}]
    # Add recent message history (last 16 messages for snappy response and context)
    for h in history[-16:]:
        role = "assistant" if h.get("role") == "assistant" else "user"
        content = h.get("content", "")
        if content:
            messages.append({"role": role, "content": content})
    messages.append({"role": "user", "content": message})

    try:
        from groq import Groq
    except ImportError:
        return jsonify({"error": "groq library is not installed. Run: pip install groq"}), 500

    try:
        client = Groq(api_key=api_key)
        response = client.chat.completions.create(
            model="openai/gpt-oss-120b",
            messages=messages,
        )
        ai_text = response.choices[0].message.content or ""

        # Auto-add detection
        auto_added = []
        add_matches = re.findall(r"\[\[ADD_ANIME:\s*(.+?)\s*\]\]", ai_text)
        for title in add_matches:
            title = title.strip()
            if not title:
                continue
            genre, media_type = fetch_metadata(title)
            entry = {
                "id": str(uuid.uuid4()),
                "user_id": user.id,
                "title": title,
                "episode": 0,
                "status": "plan-to-watch",
                "notes": "Added automatically via AI Chatbot",
                "genre": genre,
                "tier": None,
                "type": media_type or None,
            }
            try:
                supabase.table("anime").insert(entry).execute()
                auto_added.append(title)
            except Exception as insert_err:
                print(f"[auto-add] Failed inserting {title!r}: {insert_err}")

        # Strip the [[ADD_ANIME:...]] internal tags so user gets a clean message
        clean_text = re.sub(r"\[\[ADD_ANIME:\s*.+?\s*\]\]\s*", "", ai_text).strip()

        return jsonify({
            "response": clean_text,
            "auto_added": auto_added,
        })
    except Exception as e:
        return jsonify({"error": f"Groq chatbot failed: {str(e)}"}), 500


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000)
