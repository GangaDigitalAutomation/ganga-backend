const fs = require('fs');
const http = require('http');
const { google } = require('googleapis');
const { decryptObject } = require('./secureStore');

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/drive.readonly',
];

function parseOAuthJson(oauthJsonPath, oauthJsonText) {
  let raw = '';
  if (oauthJsonPath && fs.existsSync(oauthJsonPath)) {
    raw = fs.readFileSync(oauthJsonPath, 'utf-8');
  } else if (oauthJsonText) {
    raw = oauthJsonText;
  } else {
    return null;
  }
  const parsed = JSON.parse(raw);
  return parsed.installed || parsed.web || parsed;
}

function createOAuthClient({ clientId, clientSecret, redirectUri }) {
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function resolveRedirectUri(oauthData = {}) {
  const redirectUris = Array.isArray(oauthData.redirect_uris) ? oauthData.redirect_uris : [];
  const exactCallback = redirectUris.find((uri) => uri === 'http://localhost:3000/auth/callback');
  if (exactCallback) return exactCallback;

  const localhostUri = redirectUris.find((uri) => {
    try {
      const parsed = new URL(uri);
      return parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
    } catch (err) {
      return false;
    }
  });

  return localhostUri || 'http://localhost:3000/auth/callback';
}

function startLocalAuthServer(redirectUri) {
  let resolver;
  let rejecter;
  const codePromise = new Promise((resolve, reject) => {
    resolver = resolve;
    rejecter = reject;
  });

  let callbackUrl;
  try {
    callbackUrl = new URL(redirectUri);
  } catch (err) {
    throw new Error('OAuth Error: Invalid redirect URI');
  }

  if (callbackUrl.protocol !== 'http:' || (callbackUrl.hostname !== 'localhost' && callbackUrl.hostname !== '127.0.0.1')) {
    throw new Error('OAuth Error: redirect_uri must use localhost callback');
  }

  const callbackPath = callbackUrl.pathname || '/';
  const listenPort = Number(callbackUrl.port) || 3000;
  const listenHost = callbackUrl.hostname === '127.0.0.1' ? '127.0.0.1' : 'localhost';

  const server = http.createServer((req, res) => {
    if (req.url) {
      const url = new URL(req.url, `http://${listenHost}:${listenPort}`);
      if (url.pathname !== callbackPath) {
        res.writeHead(404);
        res.end();
        return;
      }
      const code = url.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h2>Authentication successful. You can close this window.</h2>');
      server.close();
      resolver(code);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on('error', (err) => {
    rejecter(err);
  });

  return new Promise((resolve, reject) => {
    server.listen(listenPort, listenHost, () => {
      resolve({ server, port: listenPort, codePromise });
    });
    server.on('error', reject);
  });
}

async function runOAuthFlow({ clientId, clientSecret, oauthJsonPath, oauthJsonText, openUrl }) {
  const oauthData = parseOAuthJson(oauthJsonPath, oauthJsonText) || {};
  const resolvedClientId = clientId || oauthData.client_id;
  const resolvedClientSecret = clientSecret || oauthData.client_secret;

  if (!resolvedClientId || !resolvedClientSecret) {
    throw new Error('Missing client ID or client secret.');
  }

  const redirectUri = resolveRedirectUri(oauthData);
  const serverInfo = await startLocalAuthServer(redirectUri);
  const oauth2Client = createOAuthClient({
    clientId: resolvedClientId,
    clientSecret: resolvedClientSecret,
    redirectUri,
  });

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });

  try {
    await openUrl(authUrl);

    const code = await serverInfo.codePromise;
    if (!code) {
      throw new Error('OAuth authorization failed or canceled.');
    }

    const { tokens } = await oauth2Client.getToken(code);
    console.log('TOKEN SCOPES:', tokens?.scope || '');
    oauth2Client.setCredentials(tokens);

    return {
      oauth2Client,
      tokens,
      clientId: resolvedClientId,
      clientSecret: resolvedClientSecret,
      redirectUri,
    };
  } catch (error) {
    if (serverInfo?.server?.listening) {
      serverInfo.server.close();
    }
    throw error;
  }
}

async function getChannelInfo(oauth2Client) {
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
  const response = await youtube.channels.list({
    part: ['snippet'],
    mine: true,
  });
  const channel = response.data.items && response.data.items[0];
  if (!channel) {
    throw new Error('No channel found for this account.');
  }

  const thumbnail =
    channel.snippet.thumbnails?.high?.url ||
    channel.snippet.thumbnails?.medium?.url ||
    channel.snippet.thumbnails?.default?.url ||
    '';

  return {
    id: channel.id,
    title: channel.snippet.title,
    thumbnail,
  };
}

function safeDecrypt(val) {
  if (!val) return val;
  try {
    const result = decryptObject(val);
    return typeof result === 'string' ? result : val;
  } catch (err) {
    return val;
  }
}

function buildOAuthClientFromChannel(channel) {
  const oauth2Client = createOAuthClient({
    clientId: safeDecrypt(channel.clientId),
    clientSecret: safeDecrypt(channel.clientSecret),
    redirectUri: channel.redirectUri || 'http://localhost:3000/auth/callback',
  });
  const tokens = decryptObject(channel.tokensEncrypted);
  oauth2Client.setCredentials(tokens || {});
  return oauth2Client;
}

module.exports = {
  runOAuthFlow,
  getChannelInfo,
  buildOAuthClientFromChannel,
  SCOPES,
};
