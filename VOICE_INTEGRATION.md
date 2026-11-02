# Gnani AI voice integration plan

This plan integrates Gnani AI speech-to-text (Prisma) and text-to-speech (Timbre) into EP. LOG’s existing anime Copilot. The browser captures a short voice clip; Flask sends it to Gnani for transcription, automatically passes the transcript through the existing `/api/chat` route, then requests Gnani audio for the assistant reply.

## Recommended first version

Use Gnani’s REST APIs for short, push-to-talk turns. This is simpler to add to the current Flask app than a live streaming voice agent and matches its request/response chat flow. Gnani documents REST transcription for clips up to 30 seconds and REST TTS for complete audio responses. Streaming STT (WebSocket) and TTS (SSE/WebSocket) can be a later upgrade if the extra latency is a problem.

Suggested initial settings:

- STT: `prisma-v3.0`, language selectable in the UI (for example `en-IN` or `hi-IN`; `indic-auto` is available with Prisma v3.0).
- TTS: `timbre-v3.0`, with a configurable voice such as `Shivani` or `Yashraj` and a selectable language.
- Audio: return WAV from TTS for straightforward browser playback.
- Auth: store Gnani’s API key ID in the Flask server environment, never in JavaScript or HTML.

Check the current voice catalog and language options in Gnani’s docs before choosing defaults. The model’s available voices and supported languages are model-specific.

## How it fits this project

- `templates/index.html`: add a microphone button and language selector to `.chat-input-area`; add a speaker/stop control to assistant messages.
- `static/script.js`: record a user turn, upload it to Flask, put the transcript into the existing chat flow, and play the returned audio.
- `static/style.css`: style recording, uploading, speaking, disabled, and error states to match the Copilot drawer.
- `app.py`: add authenticated voice endpoints that proxy requests to Gnani. The existing `/api/chat` remains the shared LLM conversation path.
- `.env`: configure Gnani credentials and voice defaults. Do not commit credentials.
- `requirements.txt`: `requests` is already present and can call the documented REST endpoints; no additional SDK is required for this approach.

## Request flow

```text
Microphone button
    ↓
Browser records one short clip and uploads it to Flask
    ↓
POST /api/voice/transcribe → Gnani Prisma → transcript
    ↓
Transcript is sent automatically through the existing chat flow
    ↓
Existing /api/chat → Groq reply
    ↓
POST /api/voice/synthesize → Gnani Timbre → WAV audio
    ↓
Browser plays reply; user can stop playback
```

Voice mode sends each transcript to the Copilot immediately and speaks the response. Typed chat remains available, and each assistant reply also has a Speak/Stop control. A later preference could add transcript review mode.

## Backend implementation

### Configuration

Add server-side configuration such as:

```text
GNANI_API_KEY=your-key-id
GNANI_STT_MODEL=prisma-v3.0
GNANI_TTS_MODEL=timbre-v3.0
GNANI_TTS_VOICE=Shivani
GNANI_TTS_LANGUAGE=en-IN
```

Use `X-API-Key-ID` for Gnani API authentication. Keep `.env` ignored by Git and add placeholder names (never real values) to a committed `.env.example` if the project adds one.

### `POST /api/voice/transcribe`

1. Require the same Supabase bearer-token authentication as `/api/chat`.
2. Accept one uploaded audio file and a supported language choice; do not accept arbitrary upstream URLs or headers from the client.
3. Enforce an upload-size limit and a short recording limit consistent with Gnani’s 30-second REST limit. Validate the file type and reject empty or oversized recordings.
4. Send multipart form data to `https://api.vachana.ai/stt/v3` with `X-API-Key-ID`, the audio file, configured model, and selected `language_code`.
5. Apply a request timeout, handle non-success responses without returning secrets, and respond with only the transcript and detected language when present.

The REST API documents WAV, MP3, OGG, FLAC, AAC, and M4A input. Browser `MediaRecorder` commonly creates WebM/Opus, which is not listed. For the first implementation, record PCM with the Web Audio API and encode a mono 16-bit WAV before upload, or add a vetted server-side conversion step. Do not send WebM to Gnani assuming it will be accepted.

### `POST /api/voice/synthesize`

1. Require Supabase authentication.
2. Accept assistant text plus an allowlisted voice/language selection (or use server configuration); enforce a reasonable text-length limit.
3. Send JSON to `https://api.vachana.ai/api/v1/tts/inference` with `X-API-Key-ID`, `text`, `model`, `voice`, `language`, and audio configuration (`container: wav`, mono, PCM).
4. Return the resulting bytes with `Content-Type: audio/wav`; handle Gnani errors and timeouts with a concise JSON error.
5. Never log credentials or raw audio. Avoid logging full user transcripts unless there is a clear product need and retention policy.

## Frontend implementation

1. Add a microphone button (`type="button"`) and language dropdown. Ask for microphone access only after an explicit click.
2. Record a single utterance, convert it to the WAV format accepted by Gnani, then upload it as `FormData` through the existing authenticated fetch wrapper. Do not manually set the multipart `Content-Type`; the browser supplies the boundary.
3. Show clear recording, transcription, and error states. On success, submit the transcript through the existing chat-send flow.
4. Once the reply is rendered, request `/api/voice/synthesize` and play the returned WAV using an object URL; retain a speaker control for replay and stop.
5. Revoke object URLs when playback ends or is stopped. Cancel previous playback before starting another; do not allow overlapping synthesis requests.
6. Keep typed chat fully usable when microphone access is unavailable or denied.

Use accessible names and an `aria-live="polite"` status. The recording state must be clear without relying only on color or animation. Respect reduced-motion preferences.

## Privacy, limits, and failure handling

- Microphone capture must be opt-in and visible. Do not record continuously or store audio in this app.
- Audio is uploaded to this Flask server and forwarded to Gnani for transcription. Chat text continues to be sent to the existing Groq-backed `/api/chat` endpoint.
- Keep Gnani credentials on the server. The browser should call only this app’s authenticated routes.
- Enforce file, duration, text, and request-rate limits. Consider the user’s account when applying limits.
- Handle unsupported recording formats, denied permissions, empty speech, upload failures, Gnani rate limits, and provider downtime with useful messages; preserve the typed-chat fallback.
- Confirm Gnani account access, quota, pricing, supported languages, and voice availability in the Gnani dashboard/docs before deployment.

## Implementation sequence

1. Confirm the desired input/output language and preferred Gnani voice; obtain an API key ID from Gnani.
2. Add environment configuration and the two authenticated Flask proxy endpoints.
3. Implement browser WAV recording and automatic transcription submission.
4. Speak each Copilot reply and keep replay/stop controls available.
5. Add TTS synthesis and audio playback controls.
6. Verify short clips, supported languages, permission denial, provider errors, playback stop/replay, and typed-chat fallback.
7. Consider streaming APIs only if measured turn latency warrants the added complexity.

## Official Gnani references

- [Gnani API quick start](https://docs.gnani.ai/api/introduction/quick-start)
- [Speech-to-text REST API](https://docs.gnani.ai/api/STT/speech-to-text)
- [Speech-to-text realtime WebSocket](https://docs.gnani.ai/api/STT/stt-websocket)
- [Text-to-speech REST API](https://docs.gnani.ai/api/TTS/tts-inference)
- [Text-to-speech streaming API](https://docs.gnani.ai/api/TTS/tts-sse)
