# Morning Mirror

Morning Mirror is a minimal chat system with an LLM agent that opens by asking how your morning is going, accepts a voice recording, transcribes it, and responds with a follow-up question.

## What it does

- Starts the conversation with a morning check-in prompt.
- Supports per-user sign up and login.
- Records the user's answer in the browser with `MediaRecorder`.
- Sends the audio to a Node server.
- Uses the OpenAI transcription API to turn the recording into text.
- Sends the transcript and prior chat history to an OpenAI chat model.
- Logs which user opened the app, when each question is asked, how long the user takes to respond, and which audio file was saved for that response.

## Run it

1. Make sure you are using a recent version of Node.js with built-in `fetch`, `Blob`, and `FormData`.
2. Export your API key:

   ```bash
   export OPENAI_API_KEY=your_key_here
   ```

3. Start the app:

   ```bash
   npm start
   ```

4. Open `http://localhost:3000`.

## Logging output

- Session events are appended to `data/logs/session-events.jsonl`.
- Audio recordings are saved in `data/audio/`.
- Registered users are stored in `data/users.json`.
- Each log row includes user identity, session id, timestamps, response latency, transcript, and the saved recording filename.

## Optional model overrides

```bash
export OPENAI_CHAT_MODEL=gpt-4.1-mini
export OPENAI_TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe
```
