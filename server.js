import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import crypto from "crypto";
import sgMail from "@sendgrid/mail";
import { analyzeWithAI } from "./aiAnalyzer.js";

// DB helpers
import { pool, initDb, insertMessage, listMessages } from "./db.js";

/* ======================================================
   ENV
====================================================== */

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const MAIL_FROM = process.env.MAIL_FROM || "";
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || "MiddleMan";

const INBOUND_USER = process.env.INBOUND_USER || "";
const INBOUND_PASS = process.env.INBOUND_PASS || "";

// only allow sending to these addresses (safety)
const ALLOWED_RECIPIENTS = new Set([
  "jeremybnewman@gmail.com",
  "jklinenewman@gmail.com"
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
      error: "Missing INBOUND_USER / INBOUND_PASS env vars"
    });
  }

  const header = req.headers.authorization || "";

  if (!header.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="MiddleMan"');
    return res.status(401).json({ ok: false });
  }

  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const [u, p] = decoded.split(":");

  if (u !== INBOUND_USER || p !== INBOUND_PASS) {
    return res.status(401).json({ ok: false });
  }

  next();
}

/* ======================================================
   HELPERS
====================================================== */

function extractEmail(str = "") {
  const m = str.match(/<([^>]+)>/);
  if (m) return m[1];
  return str.trim();
}

async function sendEmail({ to, subject, text }) {
  if (!SENDGRID_API_KEY) throw new Error("SENDGRID_API_KEY missing");
  if (!MAIL_FROM) throw new Error("MAIL_FROM missing");

  const msg = {
    to,
    from: {
      email: MAIL_FROM,
      name: MAIL_FROM_NAME
    },
    subject,
    text
  };

  const [resp] = await sgMail.send(msg);

  console.log("📨 SendGrid:", {
    to,
    status: resp?.statusCode
  });
}

function normalizeParsed(parsed) {
  return {
    summary: parsed?.summary || "",
    responseNeeded: !!parsed?.responseNeeded,
    neededToKnow: parsed?.neededToKnow || [],
    replyOptions: parsed?.replyOptions || {
      boundary: "Noted.",
      cooperative: "Thanks for the update."
    },
    flags: parsed?.flags || [],
    requestedChanges: parsed?.requestedChanges || [],
    dates: parsed?.dates || [],
    times: parsed?.times || [],
    locations: parsed?.locations || [],
    deadlines: parsed?.deadlines || []
  };
}

/* ======================================================
   ROUTES
====================================================== */

app.get("/", (_, res) => {
  res.send("MiddleMan server running ✅");
});

app.get("/health", (_, res) => {
  res.json({ ok: true });
});

/* =========================
   LIST MESSAGES
========================= */

app.get("/messages", basicAuth, async (req, res) => {
  try {
    const messages = await listMessages(200);
    res.json({ messages });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});

/* =========================
   INBOUND EMAIL
========================= */

app.post("/email/inbound", basicAuth, async (req, res) => {
  try {
    const { from = "", subject = "", text = "" } = req.body;

    if (!text) {
      return res.status(400).json({ ok: false });
    }

    const id = crypto.randomUUID();
    const fromEmail = extractEmail(from);

    let parsed;

    try {
      parsed = await analyzeWithAI({ from, subject, text });
      parsed = normalizeParsed(parsed);
    } catch (e) {
      console.error("AI failed, storing raw only");
      parsed = normalizeParsed({});
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

/* =========================
   REPLY TO MESSAGE
========================= */

app.post("/reply", basicAuth, async (req, res) => {
  try {
    const { messageId, body } = req.body;

    const { rows } = await pool.query(
      "SELECT from_email, subject FROM messages WHERE id=$1",
      [messageId]
    );

    const msg = rows[0];
    if (!msg) return res.status(404).json({ ok: false });

    const to = msg.from_email;

    if (!ALLOWED_RECIPIENTS.has(to)) {
      return res.status(403).json({ ok: false });
    }

    await sendEmail({
      to,
      subject: `Re: ${msg.subject || ""}`,
      text: body
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});

/* =========================
   COMPOSE NEW MESSAGE
========================= */

app.post("/compose", basicAuth, async (req, res) => {
  try {
    const { to, subject, body } = req.body;

    if (!ALLOWED_RECIPIENTS.has(to)) {
      return res.status(403).json({ ok: false });
    }

    await sendEmail({
      to,
      subject,
      text: body
    });

    res.status(202).json({ ok: true });
  } catch (err) {
    console.error("❌ compose failed:", err);
    res.status(500).json({ ok: false });
  }
});

/* ======================================================
   START
====================================================== */

const PORT = process.env.PORT || 10000;

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);

  console.log("DATABASE_URL present?", !!process.env.DATABASE_URL);

  try {
    console.log("⏳ initializing DB...");
    await initDb();
    console.log("✅ DB initialized");
  } catch (e) {
    console.error("DB init failed:", e);
  }
});
