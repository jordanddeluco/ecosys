// photos/auth.html: where OneDrive and Google send the browser back after signing in. It finishes the
// sign-in, remembers which cloud is connected, and returns to Cloud backup.
import { finishSignIn, PROVIDERS } from './lib/oauth.js';
import { getConfig, setConfig } from './lib/backup.js';

const msg = document.getElementById('msg');
const back = document.getElementById('back');

try {
  const { provider } = await finishSignIn();
  // Drop the token from the address bar and history before anything else happens.
  history.replaceState(null, '', location.pathname);
  const cfg = await getConfig();
  const switching = cfg.provider && cfg.provider !== provider;
  await setConfig({ provider, connectedAt: Date.now(), lastError: null, ...(switching || !cfg.rootId ? { rootId: null, folders: {}, account: null } : {}) });
  msg.textContent = `Connected to ${PROVIDERS[provider].name}. Taking you back…`;
  location.replace('./#/backup?connected=1');
} catch (err) {
  history.replaceState(null, '', location.pathname);
  msg.textContent = err?.message || 'Signing in didn’t work.';
  back.hidden = false;
}
