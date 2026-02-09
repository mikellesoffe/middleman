import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import crypto from "crypto";

import sgMail from "@sendgrid/mail";

import { analyzeWithAI } from "./aiAnalyzer.js";
import { pool, initDb, insertMessage, listMessages } from "./db.js";

const app = express();

/* =========================================================
   ENV
========================================================= */

const INBOUND_USER = process.env.INBOUND_USER || "";
const INBOUND_PASS = process.env.INBOUND_PASS || "";

const REPLY_FROM_NAME = process.env.REPLY_FROM_NAME || "MiddleMan";

// ✅ SendGrid (outbound email)
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const MAIL_FROM = process.env.MAIL_FROM || ""; // set to soffe.mikelle@gmail.com

if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY);
}

/* =========================================================
   SECURITY
========================================================= */

// Only allow emailing these addresses (prevents abuse)
const ALLOWED_RECIPIENTS = new Set([
  "jeremybnewman@gmail.com",
  "jklinenewman@gmail.com",
  "soffe.mikelle@gmail.com" // optional: allow sending test emails to yourself
]);

function basicAuth(req, res, next) {
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

async function sendEmail({ to, subject, text }) {
  if (!SENDGRID_API_KEY) throw new Error("Missing SENDGRID_API_KEY");
  if (!MAIL_FROM) throw new Error("Missing MAIL_FROM (set to soffe.mikelle@gmail.com)");

  const msg = {
    to,
    from: { email: MAIL_FROM, name: REPLY_FROM_NAME },
    subject,
    text
  };

  const [resp] = await sgMail.send(msg);
  return {
    statusCode: resp?.statusCode
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

// Reply to an existing stored message (SendGrid outbound)
app.post("/reply", basicAuth, async (req, res) => {
  try {
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

    // respond immediately (avoid client timeouts)
    res.status(202).json({ ok: true });

    sendEmail({ to, subject: subj, text: String(body) })
      .then((info) => console.log("✅ /reply sent via SendGrid:", { to, info }))
      .catch((err) => console.error("❌ /reply SendGrid failed:", err?.response?.body || err?.message || err));
  } catch (err) {
    console.error("❌ /reply error:", err?.stack || err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Compose a brand-new email (SendGrid outbound)
app.post("/compose", basicAuth, async (req, res) => {
  try {
    const { to, subject, body } = req.body || {};
    const cleanTo = String(to || "").trim().toLowerCase();

    if (!cleanTo || !body) {
      return res.status(400).json({ ok: false, error: "Missing to or body" });
    }

    if (!ALLOWED_RECIPIENTS.has(cleanTo)) {
      return res.status(403).json({ ok: false, error: "Recipient not allowed" });
    }

    const cleanSubject = subject?.trim() ? String(subject).trim() : "(no subject)";
    const cleanBody = String(body);

    // respond immediately (avoid client timeouts)
    res.status(202).json({ ok: true });

    sendEmail({ to: cleanTo, subject: cleanSubject, text: cleanBody })
      .then((info) => console.log("✅ /compose sent via SendGrid:", { to: cleanTo, info }))
      .catch((err) => console.error("❌ /compose SendGrid failed:", err?.response?.body || err?.message || err));
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
  console.log("SENDGRID_API_KEY present?", !!SENDGRID_API_KEY);
  console.log("MAIL_FROM:", MAIL_FROM || "(missing)");

  try {
    console.log("⏳ initializing DB...");
    await initDb();
    console.log("✅ DB initialized");
  } catch (err) {
    console.error("❌ DB init failed:", err?.stack || err);
  }
});
