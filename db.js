/*************************************************************
 MiddleMan Database (Postgres via Render)
 Stores messages permanently so they survive restarts
*************************************************************/

import pg from "pg";

const { Pool } = pg;

/*
  Render provides DATABASE_URL automatically.
  We use SSL for safety (required on Render)
*/
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});


/*************************************************************
 Initialize database (runs once at server startup)
*************************************************************/
export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,

      channel TEXT DEFAULT 'email',
      received_at TIMESTAMPTZ DEFAULT NOW(),

      from_raw TEXT,
      from_email TEXT,
      subject TEXT,
      raw_text TEXT,

      summary TEXT,
      response_needed BOOLEAN,
      needed_to_know JSONB,
      reply_options JSONB,
      flags JSONB
    );
  `);

  console.log("📦 messages table ready");
}


/*************************************************************
 Insert new message
*************************************************************/
export async function insertMessage(m) {
  await pool.query(
    `
    INSERT INTO messages (
      id,
      channel,
      from_raw,
      from_email,
      subject,
      raw_text,
      summary,
      response_needed,
      needed_to_know,
      reply_options,
      flags
    )
    VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
    )
    `,
    [
      m.id,
      m.channel ?? "email",
      m.fromRaw ?? null,
      m.fromEmail ?? null,
      m.subject ?? null,
      m.rawText ?? null,
      m.summary ?? null,
      m.responseNeeded ?? false,
      JSON.stringify(m.neededToKnow ?? []),
      JSON.stringify(m.replyOptions ?? {}),
      JSON.stringify(m.flags ?? [])
    ]
  );
}


/*************************************************************
 Get messages for the app
*************************************************************/
export async function listMessages(limit = 200) {
  const { rows } = await pool.query(
    `
    SELECT
      id,
      channel,
      received_at AS "receivedAt",
      from_raw AS "fromRaw",
      from_email AS "fromEmail",
      subject,
      raw_text AS "rawText",
      summary,
      response_needed AS "responseNeeded",
      needed_to_know AS "neededToKnow",
      reply_options AS "replyOptions",
      flags
    FROM messages
    ORDER BY received_at DESC
    LIMIT $1
    `,
    [limit]
  );

  return rows;
}
