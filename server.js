import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import crypto from "crypto";
import sgMail from "@sendgrid/mail";

import { analyzeWithAI } from "./aiAnalyzer.js";
import { pool, initDb, insertMessage, listMessages } from "./db.js";

/* ======================================================
   ENV
====================================================== */

const INBOUND_USER = process.env.INBOUND_USER || "";
const INBOUND_PASS = process.env.INBOUND_PASS || "";

// SendGrid outbound
const SENDGRID_API_KEY = (process.env.SENDGRID_API_KEY || "").trim();
const MAIL_FROM = (process.env.MAIL_FROM || "").trim(); // set to soffe.mikelle@gmail.com
const MAIL_FROM_NAME = (process.env.MAIL_FROM_NAME || "Mikelle").trim(); // you can set to "Mikelle Soffe"

// Optional: used for reply/compose From name if you prefer
const REPLY_FROM_NAME = (process.env.REPLY_FROM_NAME || MAIL_FROM_NAME || "Mikelle").trim();

// IMPORTANT: only allow sending to specific addresses (prevents abuse)
const ALLOWED_RECIPIENTS = new Set([
  "jeremybnewman@gmail.com",
  "jklinenewman@gmail.com",
  "mikellesoffe@gmail.com" // optional for testing
]);

if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY);
}

/* ======================================================
   APP SETUP
====================================================== */

const app = express();

app.use(helmet());
app.use(morgan("combined"));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

/* ======================================================
   AUTH
====================================================== */

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

/* ======================================================
   HELPERS
====================================================== */

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
    flags: Array.isArray(parsed?.flags) ? parsed.flags : [{ type: "non_json_output", severity: 2 }],

    // extras (safe defaults)
    requestedChanges: Array.isArray(parsed?.requestedChanges) ? parsed.requestedChanges : [],
    dates: Array.isArray(parsed?.dates) ? parsed.dates : [],
    times: Array.isArray(parsed?.times) ? parsed.times : [],
    locations: Array.isArray(parsed?.locations) ? parsed.locations : [],
    deadlines: Array.isArray(parsed?.deadlines) ? parsed.deadlines : []
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
    flags: [{ type: reasonType, severity: 3 }],
    requestedChanges: [],
    dates: [],
    times: [],
    locations: [],
    deadlines: []
  };
}

async function sendEmail({ to, subject, text }) {
  if (!SENDGRID_API_KEY) throw new Error("SENDGRID_API_KEY missing");
  if (!MAIL_FROM) throw new Error("MAIL_FROM missing");

  const msg = {
    to,
    from: { email: MAIL_FROM, name: MAIL_FROM_NAME || REPLY_FROM_NAME || "Mikelle" },
    subject: subject || "(no subject)",
    text: text || ""
  };

  const [resp] = await sgMail.send(msg);

  console.log("📨 SendGrid sent:", {
    to,
    status: resp?.statusCode
  });

  return resp?.statusCode;
}

/* ======================================================
   ROUTES
====================================================== */

app.get("/health", (req, res) => res.json({ ok: true }));
app.get("/", (req, res) => res.status(200).send("MiddleMan server is running ✅"));

// The app polls this (DB-backed)
app.get("/messages", basicAuth, async (req, res) => {
  try {
    const messages = await listMessages(200);
    res.json({ messages });
  } catch (err) {
    console.error("❌ /messages error:", err?.stack || err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Inbound webhook target (Apps Script POSTs here)
app.post("/email/inbound", basicAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const fromRaw = body.from || "";
    const subject = body.subject || "";
    const text = body.text || "";

    if (!text) {
      return res.status(400).json({ ok: false, error: "Missing text body" });
    }

    const id = crypto.randomUUID();
    const fromEmail = extractEmail(fromRaw);

    let parsed;
    try {
      parsed = await analyzeWithAI({ from: fromRaw, subject, text });
      parsed = normalizeParsed(parsed);
    } catch (aiErr) {
      const fallback = buildFallbackMessage({ from: fromRaw, subject, text }, "ai_error");
      await insertMessage({
        id,
        channel: "email",
        receivedAt: new Date().toISOString(),
        fromRaw,
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
      fromRaw,
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

// Reply to existing message (DB-backed) — uses SendGrid
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

    // Respond immediately (avoid timeouts)
    res.status(202).json({ ok: true });

    sendEmail({ to, subject: subj, text: String(body) })
      .then(() => console.log("✅ /reply queued:", { to, messageId }))
      .catch((err) =>
        console.error("❌ /reply SendGrid failed:", err?.response?.body || err?.message || err)
      );
  } catch (err) {
    console.error("❌ /reply error:", err?.stack || err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ✅ NEW: Compose brand-new message — uses SendGrid
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

    // Respond immediately (avoid timeouts)
    res.status(202).json({ ok: true });

    sendEmail({
      to: cleanTo,
      subject: subject?.trim() ? String(subject).trim() : "(no subject)",
      text: String(body)
    })
      .then(() => console.log("✅ /compose queued:", { to: cleanTo }))
      .catch((err) =>
        console.error("❌ /compose SendGrid failed:", err?.response?.body || err?.message || err)
      );
  } catch (err) {
    console.error("❌ /compose error:", err?.stack || err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

/* ======================================================
   START
====================================================== */

const PORT = process.env.PORT || 10000;

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  console.log("DATABASE_URL present?", !!process.env.DATABASE_URL);
  console.log("SENDGRID_API_KEY present?", !!process.env.SENDGRID_API_KEY);
  console.log("MAIL_FROM:", process.env.MAIL_FROM || "(missing)");
  console.log("MAIL_FROM_NAME:", process.env.MAIL_FROM_NAME || "(missing)");

  try {
    console.log("⏳ initializing DB...");
    await initDb();
    console.log("✅ DB initialized");
  } catch (err) {
    console.error("❌ DB init failed:", err?.stack || err);
  }
});
