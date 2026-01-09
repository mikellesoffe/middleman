import { ApnsClient } from "apns2";

export function makePushClient() {
  return new ApnsClient({
    team: process.env.APNS_TEAM_ID,
    keyId: process.env.APNS_KEY_ID,
    signingKey: Buffer.from(process.env.APNS_KEY_P8_BASE64, "base64"),
    defaultTopic: process.env.APNS_BUNDLE_ID,
    host:
      process.env.APNS_ENV === "production"
        ? "api.push.apple.com"
        : "api.sandbox.push.apple.com"
  });
}

export async function sendPushSafe(client, bodyText) {
  const token = process.env.DEVICE_TOKEN;
  if (!token) return;

  await client.send({
    deviceToken: token,
    payload: {
      aps: {
        alert: { title: "MiddleMan", body: bodyText },
        sound: "default"
      }
    }
  });
}
