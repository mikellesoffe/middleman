import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || "gpt-5";

export async function analyzeWithAI({ from, subject, text }) {
  const systemPrompt = `
You summarize co-parenting emails.
Remove manipulation or insults.
Extract only logistics and required actions.
Return STRICT JSON only with this shape:
{
  "summary": string,
  "responseNeeded": boolean,
  "neededToKnow": string[],
  "replyOptions": { "boundary": string, "cooperative": string },
  "flags": { "type": string, "severity": number }[]
}
`;

  const userPrompt = `
From: ${from}
Subject: ${subject}

${text}
`;

  const response = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.2
  });

  const raw = response.choices[0].message.content;

  try {
    return JSON.parse(raw);
  } catch {
    return {
      summary: raw,
      responseNeeded: true,
      neededToKnow: [],
      replyOptions: {
        boundary: "Noted.",
        cooperative: "Thanks for the update."
      },
      flags: [{ type: "non_json_output", severity: 2 }]
    };
  }
}
