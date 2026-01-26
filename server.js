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
  const from = req.body.from || "";
  const subject = req.body.subject || "";
  const text = req.body.text || "";

  if (!text) return res.status(400).json({ ok: false });

  const parsed = await analyzeWithAI({ from, subject, text });

  const msg = {
    id: crypto.randomUUID(),
    channel: "email",
    receivedAt: new Date().toISOString(),
    ...parsed
  };

  messages.unshift(msg);

  // await sendPushSafe(
  //   pushClient,
  //   msg.flags?.length ? "Message received (filtered)" : "New message received"
  // );

  res.json({ ok: true });
});

app.get("/messages", (req, res) => {
  res.json({ messages });
});

app.listen(process.env.PORT || 3000, () =>
  console.log("Server running")
);
