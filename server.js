import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import multer from "multer";
import crypto from "crypto";
import { analyzeWithAI } from "./aiAnalyzer.js";
// import { makePushClient, sendPushSafe } from "./sendPush.js";

const app = express();
app.use(helmet());
app.use(morgan("combined"));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const upload = multer();

const BASIC_USER = process.env.INBOUND_USER;
const BASIC_PASS = process.env.INBOUND_PASS;

function basicAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [type, encoded] = header.split(" ");
  if (type !== "Basic" || !encoded) return res.status(401).send("Unauthorized");
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const [user, pass] = decoded.split(":");
  if (user === BASIC_USER && pass === BASIC_PASS) return next();
  return res.status(401).send("Unauthorized");
}

const messages = [];
// const pushClient = makePushClient();

app.post("/email/inbound", basicAuth, upload.any(), async (req, res) => {
  try {
    const body = req.body || {};
    const from = body.from || "";
    const subject = body.subject || "";
    const text = body.text || "";

    if (!text) {
      return res.status(400).json({ ok: false, error: "Missing text body" });
    }

    const parsed = await analyzeWithAI({ from, subject, text });

    const msg = {
      id: crypto.randomUUID(),
      channel: "email",
      receivedAt: new Date().toISOString(),
      ...parsed
    };

    messages.unshift(msg);

    return res.json({ ok: true });
  } catch (err) {
    console.error("❌ /email/inbound error:", err?.stack || err);
    // IMPORTANT: return JSON so we don't crash and Render doesn't 502
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

app.get("/messages", (req, res) => {
  res.json({ messages });
});

app.listen(process.env.PORT || 3000, () =>
  console.log("Server running")
);
