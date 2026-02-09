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

const {
  INBOUND_USER,
  INBOUND_PASS,
  GMAIL_USER,
  GMAIL_APP_PASSWORD,
  REPLY_FROM_NAME = "MiddleMan"
} = process.env;

/* =========================================================
   SECURITY
========================================================= */

const ALLOWED_RECIPIENTS = new Set([
  "jeremybnewman@gmail.com",
  "jklinenewman@gmail.com",
  "mikellesoffe@gmail.com"
]);

function basicAuth(req, res, next) {
  const header = req.headers.authorization || "";

  if (!header.startsWith("Basic ")) {
    return res.status(401).json({ ok: false, error: "Missing auth" });
  }

  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const [u, p] = decoded.split(":");

  if (u !== INBOUND_USER || p !== INBOUND_PASS) {
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
        auth: {
          user: GMAIL_USER,
          pass: GMAIL_APP_PASSWORD
        }
      })
    : null;

/* =========================================================
   HELPERS
========================================================= */

function extractEmail(str = "") {
  const m = str.match(/<([^>]+)>/);
  if (m) return m[1];
  return str;
}

function fallback({ from, subject, text }) {
  return {
    summary: "(AI unavailable) Message received.",
    responseNeeded: true,
    neededToKnow: [
      `From: ${from}`,
      `Subject: ${subject}`,
      `Preview: ${text.slice(0, 180)}`
    ],
    replyOptions: {
      boundary: "Noted.",
      cooperative: "Thanks for the update."
    },
    flags: [{ type: "ai_error", severity: 3 }]
  };
}

/* =========================================================
   ROUTES
========================================================= */

app.get("/", (_, res) => {
  res.send("MiddleMan server is running ✅");
});

app.get("/health", (_, res) => {
  res.json({ ok: true });
});

/* =========================================================
   GET MESSAGES (DB backed)
========================================================= */

app.get("/messages", basicAuth, async (_, res) => {
  try {
    const messages = await listMessages(200);
    res.json({ messages });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});

/* =========================================================
   INBOUND EMAIL → STORE IN DB
========================================================= */

app.post("/email/inbound", basicAuth, async (req, res) => {
  try {
    const { from = "", subject = "", text = "" } = req.body;

    const id = crypto.randomUUID();
    const fromEmail = extractEmail(from);

    let parsed;

    try {
      parsed = await analyzeWithAI({ from, subject, text });
    } catch {
      parsed = fallback({ from, subject, text });
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

    res.json({ ok: true, id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});

/* =========================================================
   REPLY TO EXISTING MESSAGE
========================================================= */

app.post("/reply", basicAuth, async (req, res) => {
  try {
    if (!mailer) return res.status(500).json({ ok: false });

    const { messageId, body } = req.body;

    const { rows } = await pool.query(
      `SELECT from_email, subject FROM messages WHERE id=$1`,
      [messageId]
    );

    const msg = rows[0];
    if (!msg) return res.status(404).json({ ok: false });

    if (!ALLOWED_RECIPIENTS.has(msg.from_email)) {
      return res.status(403).json({ ok: false });
    }

    await mailer.sendMail({
      from: `${REPLY_FROM_NAME} <${GMAIL_USER}>`,
      to: msg.from_email,
      subject: `Re: ${msg.subject}`,
      text: body
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});

/* =========================================================
   ✨ NEW — COMPOSE BRAND NEW EMAIL
========================================================= */

app.post("/compose", basicAuth, async (req, res) => {
  try {
    if (!mailer) return res.status(500).json({ ok: false });

    const { to, subject, body } = req.body;

    const clean = String(to).toLowerCase().trim();

    if (!ALLOWED_RECIPIENTS.has(clean)) {
      return res.status(403).json({ ok: false, error: "Recipient not allowed" });
    }

    await mailer.sendMail({
      from: `${REPLY_FROM_NAME} <${GMAIL_USER}>`,
      to: clean,
      subject: subject || "(no subject)",
      text: body
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});

/* =========================================================
   START SERVER
========================================================= */

const PORT = process.env.PORT || 10000;

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  console.log("DATABASE_URL present?", !!process.env.DATABASE_URL);

  await initDb();
  console.log("✅ DB initialized");
});
