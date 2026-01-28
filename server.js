import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import crypto from "crypto";
import nodemailer from "nodemailer";
import { analyzeWithAI } from "./aiAnalyzer.js";

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const REPLY_FROM_NAME = process.env.REPLY_FROM_NAME || "MiddleMan";

// IMPORTANT: only allow replying to known addresses (prevents abuse)
const ALLOWED_RECIPIENTS = new Set([
  "jeremybnewman@gmail.com",
  "jklinenewman@gmail.com"
]);

const app = express();

// ===== Middleware =====
app.use(helmet());
app.use(morgan("combined"));

// IMPORTANT: Apps Script sends JSON, so we must parse it
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ===== Mail Transporter (Nodemailer) =====
const mailer =
  (GMAIL_USER && GMAIL_APP_PASSWORD)
    ? nodemailer.createTransport({
        service: "gmail",
        auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD }
      })
    : null;

// ===== In-memory store (MVP) =====
const messages = [];

// ===== Basic Auth middleware =====
function basicAuth(req, res, next) {
  const user = process.env.INBOUND_USER || "";
  const pass = process.env.INBOUND_PASS || "";

  // If you forgot to set these, fail loudly
  if (!user || !pass) {
    return res.status(500).json({
      ok: false,
      error: "Server misconfigured: missing INBOUND_USER/INBOUND_PASS"
    });
  }

  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="MiddleMan"');
    return res.status(401).json({ ok: false, error: "Missing auth" });
  }

  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const [u, p] = decoded.split(":");

  if (u !== user || p !== pass) {
    res.setHeader("WWW-Authenticate", 'Basic realm="MiddleMan"');
    return res.status(401).json({ ok: false, error: "Invalid auth" });
  }

  next();
}

// ===== Helpers =====
function extractEmail(str = "") {
  const m = str.match(/<([^>]+)>/);
  if (m && m[1]) return m[1].trim();
  // fallback: first email-like token
  const m2 = str.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m2 ? m2[0] : str.trim();
}

function normalizeParsed(parsed) {
  // Ensure the object always has the fields your app expects
  const safe = {
    summary: typeof parsed?.summary === "string" ? parsed.summary : "",
    responseNeeded: !!parsed?.responseNeeded,
    neededToKnow: Array.isArray(parsed?.neededToKnow) ? parsed.neededToKnow : [],
    replyOptions:
      parsed?.replyOptions &&
      typeof parsed.replyOptions.boundary === "string" &&
      typeof parsed.replyOptions.cooperative === "string"
        ? parsed.replyOptions
        : { boundary: "Noted.", cooperative: "Thanks for the update." },
    flags: Array.isArray(parsed?.flags) ? parsed.flags : []
  };

  // Optional extras if your earlier schema used these fields
  safe.requestedChanges = Array.isArray(parsed?.requestedChanges) ? parsed.requestedChanges : [];
  safe.dates = Array.isArray(parsed?.dates) ? parsed.dates : [];
  safe.times = Array.isArray(parsed?.times) ? parsed.times : [];
  safe.locations = Array.isArray(parsed?.locations) ? parsed.locations : [];
  safe.deadlines = Array.isArray(parsed?.deadlines) ? parsed.deadlines : [];

  return safe;
}

function buildFallbackMessage({ from, subject, text }, reasonType = "ai_unavailable") {
  return {
    summary: "(AI unavailable) Message received.",
    responseNeeded: true,
    neededToKnow: [
      subject ? `Subject: ${subject}` : "Subject: (none)",
      from ? `From: ${from}` : "From: (unknown)",
      text ? `Body preview: ${text.slice(0, 180)}` : "Body preview: (empty)"
    ],
    replyOptions: {
      boundary: "Noted.",
      cooperative: "Thanks for the update."
    },
    flags: [{ type: reasonType, severity: 3 }],
    requestedChanges: [],
    dates: [],
    times: [],
    locations: [],
    deadlines: []
  };
}

// ===== Routes =====
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// The app polls this
app.get("/messages", (req, res) => {
  res.json({ messages });
});

// Inbound email webhook target (Apps Script POSTs here)
app.post("/email/inbound", basicAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const from = body.from || "";
    const subject = body.subject || "";
    const text = body.text || "";

    if (!text) {
      return res.status(400).json({ ok: false, error: "Missing text body" });
    }

    let parsed;
    try {
      parsed = await analyzeWithAI({ from, subject, text });
      parsed = normalizeParsed(parsed);
    } catch (aiErr) {
      // If OpenAI fails (429 quota, etc.), we still store the message
      const msg = {
        id: crypto.randomUUID(),
        channel: "email",
        receivedAt: new Date().toISOString(),
        from,
        subject,
        rawText: text,
        ...buildFallbackMessage({ from, subject, text }, "ai_error")
      };
      messages.unshift(msg);

      console.error("❌ AI error (stored fallback):", aiErr?.stack || aiErr);

      // 202 Accepted = received and stored, but processing incomplete
      return res.status(202).json({ ok: true, warning: "AI unavailable, stored fallback" });
    }

    const msg = {
      id: crypto.randomUUID(),
      channel: "email",
      receivedAt: new Date().toISOString(),
      from,
      subject,
      rawText: text,
      ...parsed
    };

    messages.unshift(msg);
    return res.json({ ok: true });
  } catch (err) {
    console.error("❌ /email/inbound error:", err?.stack || err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Nodemailer
app.post("/reply", basicAuth, express.json(), async (req, res) => {
  try {
    if (!mailer) {
      return res.status(500).json({ ok: false, error: "Email not configured" });
    }

    const { messageId, body } = req.body || {};
    if (!messageId || !body) {
      return res.status(400).json({ ok: false, error: "Missing messageId or body" });
    }

    const msg = messages.find(m => m.id === messageId); // adapt if your storage differs
    if (!msg) {
      return res.status(404).json({ ok: false, error: "Message not found" });
    }

    const to = msg.fromEmail || extractEmail(msg.fromRaw || msg.from || "");
    if (!to || !ALLOWED_RECIPIENTS.has(to)) {
      return res.status(403).json({ ok: false, error: "Recipient not allowed" });
    }

    const subject = msg.subject ? `Re: ${msg.subject}` : "Re:";

    await mailer.sendMail({
      from: `${REPLY_FROM_NAME} <${GMAIL_USER}>`,
      to,
      subject,
      text: body
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("❌ /reply error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});


// ===== Start =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
