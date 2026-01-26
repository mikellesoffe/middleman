import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || "gpt-5";

const SCHEMA = {
  name: "middleman_summary",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: { type: "string" },
      responseNeeded: { type: "boolean" },
      neededToKnow: { type: "array", items: { type: "string" } },
      requestedChanges: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: {
              type: "string",
              enum: [
                "schedule_change",
                "pickup_dropoff",
                "holiday_trade",
                "expense",
                "info_request",
                "other"
              ]
            },
            details: { type: "string" }
          },
          required: ["type", "details"]
        }
      },
      dates: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            label: { type: "string" },
            isoDate: { type: "string" },
            originalText: { type: "string" }
          },
          required: ["label", "isoDate", "originalText"]
        }
      },
      times: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            label: { type: "string" },
            originalText: { type: "string" }
          },
          required: ["label", "originalText"]
        }
      },
      locations: { type: "array", items: { type: "string" } },
      deadlines: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            isoDate: { type: "string" },
            originalText: { type: "string" }
          },
          required: ["isoDate", "originalText"]
        }
      },
      replyOptions: {
        type: "object",
        additionalProperties: false,
        properties: {
          boundary: { type: "string" },
          cooperative: { type: "string" }
        },
        required: ["boundary", "cooperative"]
      },
      flags: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: { type: "string" },
            severity: { type: "integer", minimum: 1, maximum: 5 }
          },
          required: ["type", "severity"]
        }
      }
    },
    required: [
      "summary",
      "responseNeeded",
      "neededToKnow",
      "requestedChanges",
      "dates",
      "times",
      "locations",
      "deadlines",
      "replyOptions",
      "flags"
    ]
  }
};

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export async function analyzeWithAI({ from, subject, text }) {
  const model = process.env.OPENAI_MODEL || "gpt-5";

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
  "flags": string[]
}
`;

  const userPrompt = `
From: ${from}
Subject: ${subject}

${text}
`;

  const response = await client.chat.completions.create({
    model,
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
      flags: ["non_json_output"]
    };
  }
}

  return JSON.parse(resp.output_text);
}
