/*************************************************************
 MiddleMan Server
 Postgres + AI + Gmail + Basic Auth
*************************************************************/

import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import crypto from "crypto";
import nodemailer from "nodemailer";
import { analyzeWithAI } from "./aiAnalyzer.js";
import { pool, initDb, insertMessage, listMessages } from "./db.js";

/*************************************************************
 ENV
*************************************************************/
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const REPLY_FROM_NAME = process.env.REPLY_FROM_NAME || "MiddleMan";

/*************************************************************
 Only allow replying to known recipients
*************************************************************/
const ALLOWED_RECIPIENTS = new Set([
  "jeremybnewman@gmail.com",
  "jklinenewman@gmail.com"
]);

/*************************************************************
 App setup
*************************************************************/
const app = express();

app.use(helmet());
app.use(morgan("combined"));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

/*************************************************************
 Nodemailer
*************************************************************/
const mailer =
  (GMAIL_USER && GMAIL_APP_PASSWORD)
    ? nodemailer.createTransport({
        service: "gmail",
        auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD }
      })
    : null;

/*************************************************************
 Basic Auth
*************************************************************/
function basicAuth(req, res, next) {
  const user = process.env.INBOUND_USER || "";
  const pass = process.env.INBOUND_PASS || "";

  if (!user || !pass) {
    return res.status(500).json({
      ok: false,
      error: "Missing INBOUND_USER / INBOUND_PASS"
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

/*************************************************************
 Helpers
*************************************************************/
function extractEmail(str = "") {
  const m = str.match(/<([^>]+)>/);
  if (m && m[1]) return m[1].trim();

  const m2 = str.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m2 ? m2[0] : str.trim();
}

function normalizeParsed(parsed) {
  return {
    summary: parsed?.summary ?? "",
    responseNeeded: !!parsed?.responseNeeded,
    neededToKnow: parsed?.neededToKnow ?? [],
    replyOptions: parsed?.replyOptions ?? {
      boundary: "Noted.",
      cooperative: "Thanks for the update."
    },
    flags: parsed?.flags ?? []
  };
}

function buildFallbackMessage({ from, subject, text }) {
  return {
    summary: "(AI unavailable) Message received.",
    responseNeeded: true,
    neededToKnow: [
      subject ? `Subject: ${subject}` : "Subject: (none)",
      from ? `From: ${from}` : "From: (unknown)",
      text ? `Preview: ${text.slice(0, 180)}` : "Preview: (empty)"
    ],
    replyOptions: {
      boundary: "Noted.",
      cooperative: "Thanks for the update."
    },
    flags: [{ type: "ai_error", severity: 3 }]
  };
}

async function getMessageById(id) {
  const { rows } = await pool.query(
    `SELECT * FROM messages WHERE id = $1 LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

/*************************************************************
 Routes
*************************************************************/

app.get("/health", (_, res) => {
  res.json({ ok: true });
});

app.get("/", (_, res) => {
  res.status(200).send("MiddleMan server is running ✅");
});

/*************************************************************
 Fetch messages (DB-backed)
*************************************************************/
app.get("/messages", basicAuth, async (_, res) => {
  try {
    const messages = await listMessages(200);
    res.json({ messages });
  } catch (err) {
    console.error("❌ /messages error:", err);
    res.status(500).json({ ok: false });
  }
});

/*************************************************************
 Inbound email (Apps Script posts here)
*************************************************************/
app.post("/email/inbound", basicAuth, async (req, res) => {
  try {
    const { from = "", subject = "", text = "" } = req.body || {};

    if (!text) {
      return res.status(400).json({ ok: false, error: "Missing text" });
    }

    const id = crypto.randomUUID();
    const fromEmail = extractEmail(from);

    let parsed;

    try {
      parsed = await analyzeWithAI({ from, subject, text });
      parsed = normalizeParsed(parsed);
    } catch (err) {
      console.error("❌ AI failed — storing fallback");
      parsed = buildFallbackMessage({ from, subject, text });
    }

    await insertMessage({
      id,
      channel: "email",
      fromRaw: from,
      fromEmail,
      subject,
      rawText: text,
      ...parsed
    });

    return res.json({ ok: true, id });

  } catch (err) {
    console.error("❌ /email/inbound error:", err);
    return res.status(500).json({ ok: false });
  }
});

/*************************************************************
 Reply endpoint
*************************************************************/
app.post("/reply", basicAuth, async (req, res) => {
  try {
    if (!mailer) {
      return res.status(500).json({ ok: false, error: "Email not configured" });
    }

    const { messageId, body } = req.body || {};
    if (!messageId || !body) {
      return res.status(400).json({ ok: false });
    }

    const msg = await getMessageById(messageId);
    if (!msg) {
      return res.status(404).json({ ok: false });
    }

    const to = msg.from_email || extractEmail(msg.from_raw);
    if (!ALLOWED_RECIPIENTS.has(to)) {
      return res.status(403).json({ ok: false });
    }

    await mailer.sendMail({
      from: `${REPLY_FROM_NAME} <${GMAIL_USER}>`,
      to,
      subject: msg.subject ? `Re: ${msg.subject}` : "Re:",
      text: body
    });

    res.json({ ok: true });

  } catch (err) {
    console.error("❌ /reply error:", err);
    res.status(500).json({ ok: false });
  }
});

/*************************************************************
 Start server + DB init
*************************************************************/
const PORT = process.env.PORT || 10000;

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);

  console.log("DATABASE_URL present?", !!process.env.DATABASE_URL);

  try {
    console.log("⏳ initializing DB...");
    await initDb();
    console.log("✅ DB initialized");
  } catch (err) {
    console.error("❌ DB init failed:", err);
  }
});
