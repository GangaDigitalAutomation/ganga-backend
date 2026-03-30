import { google } from "googleapis";
import type { ChannelRecord } from "./automationDb.js";
import { decryptToken, encryptToken } from "./tokenCrypto.js";
import { updateChannel } from "./automationDb.js";

const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/drive.readonly",
];

function getOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI");
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function buildAuthUrl(state: string) {
  const oauth2 = getOAuthClient();
  return oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: OAUTH_SCOPES,
    state,
    include_granted_scopes: true,
  });
}

export async function exchangeCode(code: string) {
  const oauth2 = getOAuthClient();
  const { tokens } = await oauth2.getToken(code);
  console.log("TOKEN SCOPES:", tokens?.scope || "");
  if (!tokens.access_token) {
    throw new Error("Access token missing in OAuth exchange response");
  }
  if (!tokens.refresh_token) {
    throw new Error("Refresh token missing. Re-authorize with prompt=consent.");
  }

  oauth2.setCredentials(tokens);
  const youtube = google.youtube({ version: "v3", auth: oauth2 });
  const info = await youtube.channels.list({
    part: ["snippet"],
    mine: true,
  });
  const first = info.data.items?.[0];
  const channelName = first?.snippet?.title || "Connected Channel";

  return {
    channelName,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiryDate: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : new Date(Date.now() + 3500 * 1000).toISOString(),
  };
}

export async function ensureValidAccessToken(channel: ChannelRecord) {
  const expiry = new Date(channel.expiry_date).getTime();
  const now = Date.now();
  if (Number.isFinite(expiry) && now < expiry - 60_000) {
    return decryptToken(channel.access_token);
  }

  const oauth2 = getOAuthClient();
  oauth2.setCredentials({
    refresh_token: decryptToken(channel.refresh_token),
  });
  const refreshed = await oauth2.refreshAccessToken();
  const credentials = refreshed.credentials;
  const nextAccessToken = credentials.access_token;
  if (!nextAccessToken) {
    throw new Error("Failed to refresh Google access token");
  }

  const nextExpiry = credentials.expiry_date
    ? new Date(credentials.expiry_date).toISOString()
    : new Date(Date.now() + 3500 * 1000).toISOString();

  await updateChannel(channel.id, {
    access_token: encryptToken(nextAccessToken),
    expiry_date: nextExpiry,
  });

  return nextAccessToken;
}

export function oauthClientWithTokens(accessToken: string, refreshToken: string) {
  const oauth2 = getOAuthClient();
  oauth2.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken,
  });
  return oauth2;
}

export { OAUTH_SCOPES };
