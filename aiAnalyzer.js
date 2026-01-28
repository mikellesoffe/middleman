import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || "gpt-5";

function extractJsonObject(text) {
  if (!text) return null;

  // Remove common markdown fences
  const cleaned = text
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  // Try direct parse first
  try {
    return JSON.parse(cleaned);
  } catch {
    // Fall through
  }

  // Try to find the first {...} JSON object in the response
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

export async function analyzeWithAI({ from, subject, text }) {
  const systemPrompt = `
You are a communication filter for co-parenting emails.

Goals:
- Remove manipulation, insults, guilt, threats, and unnecessary tone.
- Extract only necessary logistics and required actions.
- Decide if a response is needed.
- Provide two reply styles:
  1) boundary (low-reactivity)
  2) cooperative (neutral + helpful)

Return STRICT JSON ONLY. No markdown. No commentary.
Use exactly this shape:
{
  "summary": string,
  "responseNeeded": boolean,
  "neededToKnow": string[],
  "requestedChanges": string[],
  "dates": string[],
  "times": string[],
  "locations": string[],
  "deadlines": string[],
  "replyOptions": { "boundary": string, "cooperative": string },
  "flags": { "type": string, "severity": number }[]
}

Rules:
- summary: 1–2 sentences max, neutral.
- neededToKnow: bullet-style strings, logistics only.
- flags: include items like "insult", "threat", "guilt", "stonewalling", "legal_threat", "harassment", etc.
- severity: 1 (mild) to 5 (severe).
`.trim();

  const userPrompt = `
From: ${from}
Subject: ${subject}

Message:
${text}
`.trim();

  const response = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
  });

  const raw = response?.choices?.[0]?.message?.content || "";
  const parsed = extractJsonObject(raw);

  if (parsed) return parsed;

  // Fallback if model doesn't return usable JSON
  return {
    summary: raw || "(No content returned by model)",
    responseNeeded: true,
    neededToKnow: [],
    requestedChanges: [],
    dates: [],
    times: [],
    locations: [],
    deadlines: [],
    replyOptions: {
      boundary: "Noted.",
      cooperative: "Thanks for the update."
    },
    flags: [{ type: "non_json_output", severity: 2 }]
  };
}
