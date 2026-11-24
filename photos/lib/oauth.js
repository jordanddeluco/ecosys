// Signing in to the cloud providers from the browser, with no server and no client secret.
//   OneDrive: authorization code + PKCE (a "single-page application" registration), refresh tokens that
//             renew themselves for as long as Photos is used at least once a day.
//   Google:   the token flow (Google gives browser apps no refresh token), so a sign-in lasts an hour;
//             after that, backing up asks for one click to continue (Google skips the account screen).
// The page goes to the provider and comes back to photos/auth.html, which finishes here and returns to
// Cloud backup. Full-page redirects, not popups: ecosys pages are cross-origin isolated (COOP), which cuts
// a popup off from its opener.

import { kvGet, kvSet } from './library.js';
import { CLOUD_CONFIG } from '../cloud-config.js';

export const PROVIDERS = {
  onedrive: {
    id: 'onedrive',
    name: 'OneDrive',
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'Files.ReadWrite offline_access User.Read',
    configKey: 'onedriveClientId',
  },
  gdrive: {
    id: 'gdrive',
    name: 'Google Drive',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    scope: 'https://www.googleapis.com/auth/drive.file',
    configKey: 'googleClientId',
  },
};

const PENDING = 'ecosys:photos:oauth'; // sessionStorage: survives the trip to the provider, in this tab only
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const random = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

/** Where the provider sends the browser back: photos/auth.html next to this module's app. */
export const redirectUri = () => new URL('../auth.html', import.meta.url).href;

/** The client ID to use: one entered in this browser wins over cloud-config.js. */
export async function clientId(provider) {
  const own = (await kvGet('clientIds')) || {};
  return String(own[provider] || CLOUD_CONFIG[PROVIDERS[provider].configKey] || '').trim();
}

export async function setClientId(provider, value) {
  const own = (await kvGet('clientIds')) || {};
  own[provider] = String(value || '').trim();
  await kvSet('clientIds', own);
}

/** Leave for the provider's sign-in page. `silent` (Google) skips the account picker when it can. */
export async function beginSignIn(provider, { silent = false, loginHint = '' } = {}) {
  const p = PROVIDERS[provider];
  const id = await clientId(provider);
  if (!p || !id) throw new Error('missing_client_id');
  const state = random(16);
  const pending = { provider, state, at: Date.now() };
  const q = new URLSearchParams({ client_id: id, redirect_uri: redirectUri(), scope: p.scope, state });
  if (provider === 'onedrive') {
    pending.verifier = random(48);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pending.verifier)));
    q.set('response_type', 'code');
    q.set('response_mode', 'query');
    q.set('code_challenge', b64url(digest));
    q.set('code_challenge_method', 'S256');
    if (!silent) q.set('prompt', 'select_account');
  } else {
    q.set('response_type', 'token');
    q.set('include_granted_scopes', 'true');
    if (!silent) q.set('prompt', 'select_account consent');
  }
  if (loginHint) q.set('login_hint', loginHint);
  sessionStorage.setItem(PENDING, JSON.stringify(pending));
  location.assign(`${p.authorize}?${q}`);
}

/**
 * On photos/auth.html: read the provider's answer, check it belongs to the sign-in this tab started,
 * and store the tokens. Returns { provider } or throws with a message for the person.
 */
export async function finishSignIn(loc = location) {
  let pending = null;
  try {
    pending = JSON.parse(sessionStorage.getItem(PENDING) || 'null');
  } catch {}
  sessionStorage.removeItem(PENDING);
  const query = new URLSearchParams(loc.search);
  const frag = new URLSearchParams(String(loc.hash || '').replace(/^#/, ''));
  const got = query.has('state') ? query : frag;
  if (!pending || !got.get('state') || got.get('state') !== pending.state || Date.now() - pending.at > 30 * 60000) {
    throw new Error('This sign-in link is out of date or wasn’t started here. Try connecting again.');
  }
  const err = got.get('error');
  if (err) throw new Error(got.get('error_description') || (err === 'access_denied' ? 'Access wasn’t allowed.' : err));
  const provider = pending.provider;
  if (provider === 'onedrive') {
    const code = got.get('code');
    if (!code) throw new Error('OneDrive didn’t send a sign-in code.');
    const tok = await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: pending.verifier, redirect_uri: redirectUri() });
    await saveTokens('onedrive', tok);
  } else {
    const access = got.get('access_token');
    if (!access) throw new Error('Google didn’t send a sign-in token.');
    await saveTokens('gdrive', { access_token: access, expires_in: Number(got.get('expires_in')) || 3600 });
  }
  return { provider };
}

async function tokenRequest(params) {
  const body = new URLSearchParams({ client_id: await clientId('onedrive'), scope: PROVIDERS.onedrive.scope, ...params });
  const res = await fetch(PROVIDERS.onedrive.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    const e = new Error(json.error_description?.split('\r\n')[0] || 'OneDrive sign-in failed.');
    e.code = json.error || 'token_error';
    throw e;
  }
  return json;
}

async function saveTokens(provider, t) {
  const prev = (await kvGet(`tokens:${provider}`)) || {};
  await kvSet(`tokens:${provider}`, {
    access: t.access_token,
    refresh: t.refresh_token || prev.refresh || null,
    expiresAt: Date.now() + (Number(t.expires_in) || 3600) * 1000 - 60000,
  });
}

/**
 * A valid access token, renewed when possible. Throws an error with code 'reauth' when the person has to
 * sign in again (Google after an hour, OneDrive after a day unused or a revoked consent).
 */
export async function accessToken(provider, { force = false } = {}) {
  const t = await kvGet(`tokens:${provider}`);
  if (!t?.access) throw reauth();
  if (!force && t.expiresAt > Date.now()) return t.access;
  if (provider === 'onedrive' && t.refresh) {
    try {
      await saveTokens('onedrive', await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh }));
      return (await kvGet('tokens:onedrive')).access;
    } catch (err) {
      if (err.code === 'invalid_grant' || err.code === 'interaction_required') throw reauth();
      throw err;
    }
  }
  throw reauth();
}

export const forgetTokens = (provider) => kvSet(`tokens:${provider}`, undefined);
export const hasTokens = async (provider) => !!(await kvGet(`tokens:${provider}`))?.access;

function reauth() {
  const e = new Error('Sign in again to keep backing up.');
  e.code = 'reauth';
  return e;
}
