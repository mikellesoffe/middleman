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

export async function analyzeWithAI({ from, subject, text }) {
  const input = `From: ${from}\nSubject: ${subject}\n\n${text}`.trim();

  const resp = await client.responses.create({
    model: MODEL,
    reasoning: { effort: "low" },
    instructions: [
      "You are a communication firewall for high-conflict co-parenting.",
      "Return ONLY JSON matching the schema.",
      "Do not quote insults or abusive language.",
      "Extract only logistics and decisions.",
      "If response is required, set responseNeeded true.",
      "Provide two one-sentence replies if responseNeeded is true."
    ].join("\n"),
    input,
    text: {
      format: {
        type: "json_schema",
        json_schema: SCHEMA,
        strict: true
      }
    }
  });

  return JSON.parse(resp.output_text);
}
