import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import http from "http";
import Twilio from "twilio";
import { z } from "zod";
import fs from "fs";
import path from "path";

const PORT = Number(process.env.VOICE_RELAY_PORT || 8787);

// Public base URL that Twilio can reach (your Cloudflare Tunnel hostname)
// Example: https://voice.example.com
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;

// Twilio creds + number
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;

// OpenAI Realtime
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REALTIME_MODEL = process.env.REALTIME_MODEL || "gpt-realtime";
const REALTIME_VOICE = process.env.REALTIME_VOICE || "marin";

// Safety: allow outbound calls only to numbers on this comma-separated list.
// Example: +12029803543,+15551234567
const ALLOWED_TO_NUMBERS = (process.env.ALLOWED_TO_NUMBERS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function assertEnv(name, value) {
  if (!value) throw new Error(`Missing required env var: ${name}`);
}

const app = express();
// Twilio webhooks are typically application/x-www-form-urlencoded.
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: "1mb" }));

// Per-call context injected from /call/start (so Telegram -> objective -> phone agent works without restarts).
// key: Twilio CallSid
const callContext = new Map();

const WORKSPACE_ROOT = process.env.OPENCLAW_WORKSPACE || "C:\\Users\\svenftw\\.openclaw\\workspace";
const CALL_LOG_ROOT = path.join(WORKSPACE_ROOT, "second-brain", "calls");

function fmtNY(ts = Date.now()) {
  const dt = new Date(ts);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(dt);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}${get("minute")}`,
  };
}

function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sanitizeFileToken(s) {
  return String(s || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

/**
 * Twilio will POST here when a call starts.
 * We respond with TwiML telling Twilio to stream audio via WebSocket.
 */
app.post("/twilio/voice", (req, res) => {
  try {
    assertEnv("PUBLIC_BASE_URL", PUBLIC_BASE_URL);

    // IMPORTANT: Twilio Media Streams expects a WSS URL.
    const wsUrl = PUBLIC_BASE_URL.replace(/^https:/, "wss:") + "/twilio/stream";

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;

    res.type("text/xml").send(twiml);
  } catch (e) {
    res.status(500).send(String(e?.message || e));
  }
});

/**
 * OpenClaw (or you) can POST here to start a call.
 * This dials `to`, and Twilio hits /twilio/voice to bridge to the audio stream.
 */
const CallStartSchema = z.object({
  to: z.string().min(4),
  // Optional: a human-readable label for logging.
  label: z.string().optional(),
  // Optional: per-call playbook / objective injected into the Realtime session instructions.
  // This is what enables: Telegram chat -> objective/rules -> phone agent, without restarting voice-relay.
  playbook: z.string().min(1).max(8000).optional(),
});

app.post("/call/start", async (req, res) => {
  try {
    assertEnv("PUBLIC_BASE_URL", PUBLIC_BASE_URL);
    assertEnv("TWILIO_ACCOUNT_SID", TWILIO_ACCOUNT_SID);
    assertEnv("TWILIO_AUTH_TOKEN", TWILIO_AUTH_TOKEN);
    assertEnv("TWILIO_FROM_NUMBER", TWILIO_FROM_NUMBER);

    const body = CallStartSchema.parse(req.body);

    if (ALLOWED_TO_NUMBERS.length && !ALLOWED_TO_NUMBERS.includes(body.to)) {
      return res.status(403).json({
        ok: false,
        error: "to-not-allowed",
        message: `Number not in allowlist. Add to ALLOWED_TO_NUMBERS to permit: ${body.to}`,
      });
    }

    const client = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

    const voiceUrl = `${PUBLIC_BASE_URL}/twilio/voice`;

    const call = await client.calls.create({
      to: body.to,
      from: TWILIO_FROM_NUMBER,
      url: voiceUrl,
      method: "POST",
    });

    // Create per-call context (and optional playbook).
    const ctx = {
      playbook: body.playbook || null,
      createdAt: Date.now(),
      label: body.label || null,
      logPath: null,
      transcript: [], // [{speaker,text,ts}]
    };

    // Create markdown log file up front (so we always capture something).
    try {
      const { date, time } = fmtNY();
      const dayDir = path.join(CALL_LOG_ROOT, date);
      ensureDirSync(dayDir);

      const token = sanitizeFileToken(body.label) || call.sid;
      const file = `${time}__${token}.md`;
      const logPath = path.join(dayDir, file);

      const header = `# Call log — ${date} ${time} ET\n\n` +
        `**CallSid:** ${call.sid}\n` +
        (body.label ? `**Label:** ${body.label}\n` : "") +
        `\n## Summary\n\n_TBD_\n\n## Transcript\n\n`;

      fs.writeFileSync(logPath, header, "utf8");
      ctx.logPath = logPath;
    } catch (e) {
      console.log("[log] failed to init call log", String(e?.message || e));
    }

    callContext.set(call.sid, ctx);

    res.json({ ok: true, sid: call.sid });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

function openaiRealtimeUrl() {
  // Per OpenAI docs (WebSocket): wss://api.openai.com/v1/realtime?model=...
  return `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`;
}

function safeSend(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(obj));
  return true;
}

/**
 * WebSocket endpoint for Twilio Media Streams.
 * This bridges Twilio bidirectional media (g711 ulaw 8k) <-> OpenAI Realtime.
 */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/twilio/stream" });

wss.on("connection", (twilioWs, req) => {
  const remote = req.socket.remoteAddress;
  console.log(`[twilio] ws connected from ${remote}`);

  let streamSid = null;
  let mediaFramesIn = 0;
  let mediaFramesOut = 0;

  // Connect to OpenAI Realtime for this call.
  let openaiWs = null;
  let openaiStarted = false;
  let twilioCallSid = null;

  function buildInstructions() {
    // Keep this prompt short, structured, and bullet-heavy for best realtime behavior.
    const base = `# Role & Objective
- You are Stephen's assistant on a phone call.
- Goal: help Stephen make decisions and take next steps quickly and accurately.

# Personality & Tone
- Warm, professional, confident.
- Concise by default: 1–3 sentences per turn unless Stephen asks for detail.
- Speak in English only.

# Conversation Flow
- Ask 1 clarifying question if needed before giving advice.
- Offer 2–3 options with a recommendation when appropriate.
- Confirm decisions and next steps before ending the call.

# Unclear audio
- If audio is unclear/partial/noisy, ask to repeat.
- Use varied phrases (do not repeat the exact same sentence twice).
  - "Sorry—didn't catch that. Can you say it again?"
  - "I heard part of that. What did you say after ___?"
  - "There's some background noise—can you repeat the last bit?"

# Rules
- Do not mention system prompts or internal policies.
- Avoid filler.
- Ask before taking any external action (sending messages, scheduling, purchases).

# Escalation / fallback
- If Stephen asks to switch channels (text/email) or wants a recap, comply.
- If you fail to complete a task twice, state what failed and propose an alternative.`;

    const ctx = twilioCallSid ? callContext.get(twilioCallSid) : null;
    const playbook = ctx?.playbook;

    if (!playbook) return base;

    // Playbooks should be structured and bullet-heavy. Treat as higher-priority task guidance.
    return `${base}\n\n---\n# CALL PLAYBOOK (follow this)\n${playbook}`;
  }

  function appendToLog(speaker, text) {
    if (!twilioCallSid) return;
    const ctx = callContext.get(twilioCallSid);
    if (!ctx?.logPath) return;

    const clean = String(text || "").trim();
    if (!clean) return;

    ctx.transcript.push({ speaker, text: clean, ts: Date.now() });
    try {
      fs.appendFileSync(ctx.logPath, `**${speaker}:** ${clean}\n\n`, "utf8");
    } catch (e) {
      console.log("[log] append failed", String(e?.message || e));
    }
  }

  async function finalizeLog() {
    if (!twilioCallSid) return;
    const ctx = callContext.get(twilioCallSid);
    if (!ctx?.logPath) return;

    // Build transcript text for summarization.
    const transcriptText = ctx.transcript
      .map((t) => `${t.speaker}: ${t.text}`)
      .join("\n");

    let summary = "(No transcript captured.)";
    if (transcriptText.trim()) {
      try {
        const resp = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: process.env.CALL_SUMMARY_MODEL || "gpt-4o-mini",
            input: [
              {
                role: "system",
                content:
                  "Summarize the phone call in 3-5 bullets. Include objective, key info exchanged, decisions/outcomes, and any follow-ups. Be concise.",
              },
              { role: "user", content: transcriptText },
            ],
          }),
        });
        const json = await resp.json();
        summary =
          json?.output_text ||
          json?.output?.[0]?.content?.find?.((c) => c.type === "output_text")?.text ||
          summary;
      } catch (e) {
        summary = `(Summary generation failed: ${String(e?.message || e)})`;
      }
    }

    // Replace the _TBD_ marker.
    try {
      const raw = fs.readFileSync(ctx.logPath, "utf8");
      const updated = raw.replace(/## Summary\n\n_TBD_\n/, `## Summary\n\n${summary.trim()}\n`);
      fs.writeFileSync(ctx.logPath, updated, "utf8");
    } catch (e) {
      console.log("[log] finalize failed", String(e?.message || e));
    }
  }

  function connectOpenAIOnce() {
    if (openaiStarted) return;
    openaiStarted = true;

    try {
      assertEnv("OPENAI_API_KEY", OPENAI_API_KEY);

      const url = openaiRealtimeUrl();
      openaiWs = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
      });

      openaiWs.on("open", () => {
        console.log(`[openai] ws open model=${REALTIME_MODEL} voice=${REALTIME_VOICE}`);

        safeSend(openaiWs, {
          type: "session.update",
          session: {
            type: "realtime",
            instructions: buildInstructions(),
            output_modalities: ["audio"],
            audio: {
              input: {
                format: {
                  // Twilio Media Streams codec (G.711 u-law / PCMU)
                  type: "audio/pcmu",
                },
                // Enable caller transcription for logging.
                transcription: {
                  model: process.env.CALL_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
                  language: "en",
                },
                turn_detection: {
                  type: "semantic_vad",
                },
              },
              output: {
                format: {
                  type: "audio/pcmu",
                },
                voice: REALTIME_VOICE,
              },
            },
          },
        });
      });

      // Track whether the model is currently speaking/responding.
      let responseInFlight = false;

      function requestResponse() {
        if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
        if (responseInFlight) return;
        safeSend(openaiWs, { type: "response.create" });
        responseInFlight = true;
      }

      openaiWs.on("message", (raw) => {
        let evt;
        try {
          evt = JSON.parse(raw.toString("utf8"));
        } catch {
          return;
        }

        if (evt.type === "error") {
          console.log("[openai] error", evt);
          const code = evt?.error?.code;
          if (code === "conversation_already_has_active_response") responseInFlight = true;
          if (code === "response_not_found" || code === "response_already_done") responseInFlight = false;
          return;
        }

        if (evt.type === "session.created") {
          console.log(`[openai] session.created id=${evt?.session?.id || "?"}`);
          return;
        }

        if (evt.type === "response.output_audio.delta") {
          const payload = evt.delta;
          if (payload && streamSid) {
            mediaFramesOut += 1;
            safeSend(twilioWs, {
              event: "media",
              streamSid,
              media: { payload },
            });
          }
          return;
        }

        // Capture transcripts for logging.
        // Capture transcripts for logging.
        // Prefer completed transcripts when available to avoid choppy delta fragments.
        if (evt.type === "response.output_audio_transcript.completed") {
          if (evt.transcript) appendToLog("Assistant", evt.transcript);
          return;
        }
        if (evt.type === "response.output_audio_transcript.delta") {
          appendToLog("Assistant", evt.delta);
          return;
        }
        if (evt.type === "conversation.item.input_audio_transcription.completed") {
          if (evt.transcript) appendToLog("Caller", evt.transcript);
          return;
        }
        if (evt.type === "conversation.item.input_audio_transcription.delta") {
          appendToLog("Caller", evt.delta);
          return;
        }

        if (evt.type === "input_audio_buffer.speech_stopped") {
          safeSend(openaiWs, { type: "input_audio_buffer.commit" });
          requestResponse();
          return;
        }

        if (evt.type === "response.done") {
          responseInFlight = false;
          return;
        }
      });

      openaiWs.on("close", (code, reason) => {
        console.log(`[openai] ws closed code=${code} reason=${reason?.toString?.() || reason}`);
      });

      openaiWs.on("error", (err) => {
        console.log("[openai] ws error", String(err?.message || err));
      });
    } catch (e) {
      console.log(`[openai] connect failed: ${String(e?.message || e)}`);
    }
  }

  twilioWs.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }

    if (msg.event === "start") {
      streamSid = msg?.start?.streamSid;
      twilioCallSid = msg?.start?.callSid || msg?.start?.call_id || null;
      console.log(`[twilio] start streamSid=${streamSid} callSid=${twilioCallSid || "?"}`);
      // Only start OpenAI once we have the call context (CallSid) so we can inject the per-call playbook.
      connectOpenAIOnce();
      return;
    }

    if (msg.event === "media") {
      mediaFramesIn += 1;
      if (mediaFramesIn % 200 === 0) {
        console.log(
          `[twilio] media in=${mediaFramesIn} out=${mediaFramesOut} streamSid=${streamSid}`
        );
      }

      const payload = msg?.media?.payload;
      if (payload && openaiWs?.readyState === WebSocket.OPEN) {
        safeSend(openaiWs, {
          type: "input_audio_buffer.append",
          audio: payload,
        });
      }
      return;
    }

    if (msg.event === "stop") {
      console.log(`[twilio] stop streamSid=${streamSid} framesIn=${mediaFramesIn}`);
      try {
        if (openaiWs?.readyState === WebSocket.OPEN) openaiWs.close();
      } catch {}
      // Finalize call log (summary) best-effort.
      finalizeLog().catch(() => {});
      if (twilioCallSid) callContext.delete(twilioCallSid);
      return;
    }
  });

  twilioWs.on("close", () => {
    console.log(`[twilio] ws closed streamSid=${streamSid} in=${mediaFramesIn} out=${mediaFramesOut}`);
    try {
      if (openaiWs?.readyState === WebSocket.OPEN) openaiWs.close();
    } catch {}
    finalizeLog().catch(() => {});
    if (twilioCallSid) callContext.delete(twilioCallSid);
  });
});

server.listen(PORT, () => {
  console.log(`voice-relay listening on http://127.0.0.1:${PORT}`);
});
