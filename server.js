import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import crypto from "crypto";
import nodemailer from "nodemailer";

import { analyzeWithAI } from "./aiAnalyzer.js";
import { pool, initDb, insertMessage, listMessages } from "./db.js";

const app = express();

/* =========================================================
   ENV
========================================================= */

const INBOUND_USER = process.env.INBOUND_USER || "";
const INBOUND_PASS = process.env.INBOUND_PASS || "";

const GMAIL_USER = process.env.GMAIL_USER || "";
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || "";
const REPLY_FROM_NAME = process.env.REPLY_FROM_NAME || "MiddleMan";

/* =========================================================
   SECURITY
========================================================= */

// Only allow emailing these addresses (prevents abuse)
const ALLOWED_RECIPIENTS = new Set([
  "jeremybnewman@gmail.com",
  "jklinenewman@gmail.com",
  "mikellesoffe@gmail.com" // optional: remove if you don't want to allow sending to yourself
]);

function basicAuth(req, res, next) {
  // Fail loudly if missing env vars
  if (!INBOUND_USER || !INBOUND_PASS) {
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

  if (u !== INBOUND_USER || p !== INBOUND_PASS) {
    res.setHeader("WWW-Authenticate", 'Basic realm="MiddleMan"');
    return res.status(401).json({ ok: false, error: "Invalid auth" });
  }

  next();
}

/* =========================================================
   MIDDLEWARE
========================================================= */

app.use(helmet());
app.use(morgan("combined"));
app.use(express.json({ limit: "2mb" }));

/* =========================================================
   MAILER
========================================================= */

const mailer =
  GMAIL_USER && GMAIL_APP_PASSWORD
    ? nodemailer.createTransport({
        service: "gmail",
        auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD }
      })
    : null;

/* =========================================================
   HELPERS
========================================================= */

function extractEmail(str = "") {
  const m = str.match(/<([^>]+)>/);
  if (m && m[1]) return m[1].trim();
  const m2 = str.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m2 ? m2[0] : str.trim();
}

function normalizeParsed(parsed) {
  return {
    summary: typeof parsed?.summary === "string" ? parsed.summary : "",
    responseNeeded: !!parsed?.responseNeeded,
    neededToKnow: Array.isArray(parsed?.neededToKnow) ? parsed.neededToKnow : [],
    replyOptions:
      parsed?.replyOptions &&
      typeof parsed.replyOptions.boundary === "string" &&
      typeof parsed.replyOptions.cooperative === "string"
        ? parsed.replyOptions
        : { boundary: "Noted.", cooperative: "Thanks for the update." },
    flags: Array.isArray(parsed?.flags) ? parsed.flags : [{ type: "non_json_output", severity: 2 }]
  };
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
    replyOptions: { boundary: "Noted.", cooperative: "Thanks for the update." },
    flags: [{ type: reasonType, severity: 3 }]
  };
}

/* =========================================================
   ROUTES
========================================================= */

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/", (req, res) => {
  res.status(200).send("MiddleMan server is running ✅");
});

// DB-backed messages (app polls this)
app.get("/messages", basicAuth, async (req, res) => {
  try {
    const messages = await listMessages(200);
    res.json({ messages });
  } catch (err) {
    console.error("❌ /messages error:", err?.stack || err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
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

    const id = crypto.randomUUID();
    const fromEmail = extractEmail(from);

    let parsed;
    try {
      parsed = await analyzeWithAI({ from, subject, text });
      parsed = normalizeParsed(parsed);
    } catch (aiErr) {
      const fallback = buildFallbackMessage({ from, subject, text }, "ai_error");

      await insertMessage({
        id,
        channel: "email",
        receivedAt: new Date().toISOString(),
        fromRaw: from,
        fromEmail,
        subject,
        rawText: text,
        ...fallback
      });

      console.error("❌ AI error (stored fallback):", aiErr?.stack || aiErr);
      return res.status(202).json({ ok: true, id, warning: "AI unavailable, stored fallback" });
    }

    await insertMessage({
      id,
      channel: "email",
      receivedAt: new Date().toISOString(),
      fromRaw: from,
      fromEmail,
      subject,
      rawText: text,
      ...parsed
    });

    return res.json({ ok: true, id });
  } catch (err) {
    console.error("❌ /email/inbound error:", err?.stack || err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Reply to an existing stored message (DB-backed)
app.post("/reply", basicAuth, async (req, res) => {
  try {
    if (!mailer) {
      return res.status(500).json({ ok: false, error: "Email not configured" });
    }

    const { messageId, body } = req.body || {};
    if (!messageId || !body) {
      return res.status(400).json({ ok: false, error: "Missing messageId or body" });
    }

    const { rows } = await pool.query(
      `SELECT from_raw, from_email, subject FROM messages WHERE id = $1 LIMIT 1`,
      [messageId]
    );
    const msg = rows[0];
    if (!msg) return res.status(404).json({ ok: false, error: "Message not found" });

    const to = (msg.from_email || extractEmail(msg.from_raw || "") || "").trim().toLowerCase();
    if (!to || !ALLOWED_RECIPIENTS.has(to)) {
      return res.status(403).json({ ok: false, error: "Recipient not allowed" });
    }

    const subj = msg.subject ? `Re: ${msg.subject}` : "Re:";

    // Respond fast to avoid timeouts (optional)
    res.status(202).json({ ok: true });

    // Send async
    mailer
      .sendMail({
        from: `${REPLY_FROM_NAME} <${GMAIL_USER}>`,
        to,
        subject: subj,
        text: String(body)
      })
      .then(() => console.log(`✅ Sent reply to ${to} (messageId=${messageId})`))
      .catch(err => console.error("❌ /reply sendMail failed:", err?.stack || err));
  } catch (err) {
    console.error("❌ /reply error:", err?.stack || err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ✅ Compose a brand-new email (THIS fixes your timeout)
app.post("/compose", basicAuth, async (req, res) => {
  try {
    if (!mailer) {
      return res.status(500).json({ ok: false, error: "Email not configured" });
    }

    const { to, subject, body } = req.body || {};
    const cleanTo = String(to || "").trim().toLowerCase();

    if (!cleanTo || !body) {
      return res.status(400).json({ ok: false, error: "Missing to or body" });
    }

    if (!ALLOWED_RECIPIENTS.has(cleanTo)) {
      return res.status(403).json({ ok: false, error: "Recipient not allowed" });
    }

    // ✅ Respond immediately so the phone never times out
    res.status(202).json({ ok: true });

    // ✅ Send email async in the background
    mailer
      .sendMail({
        from: `${REPLY_FROM_NAME} <${GMAIL_USER}>`,
        to: cleanTo,
        subject: subject?.trim() ? String(subject).trim() : "(no subject)",
        text: String(body)
      })
      .then(() => console.log(`✅ Sent compose email to ${cleanTo}`))
      .catch(err => console.error("❌ /compose sendMail failed:", err?.stack || err));
  } catch (err) {
    console.error("❌ /compose error:", err?.stack || err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

/* =========================================================
   START
========================================================= */

const PORT = process.env.PORT || 10000;

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  console.log("DATABASE_URL present?", !!process.env.DATABASE_URL);

  try {
    console.log("⏳ initializing DB...");
    await initDb();
    console.log("✅ DB initialized");
  } catch (err) {
    console.error("❌ DB init failed:", err?.stack || err);
  }
});
