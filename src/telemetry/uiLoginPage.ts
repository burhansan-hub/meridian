/**
 * Sign-in page for the web UI when MERIDIAN_API_KEY is set (`GET /ui/login`).
 *
 * A browser cannot attach the key to a navigation, so without this page a
 * keyed instance — the normal case for a container on a shared host — has a
 * UI nobody can open. The page trades the key for an HttpOnly session cookie
 * (see auth.ts) and returns to the page that sent it here.
 *
 * Like the OAuth callback page it has no shared site header: the header polls
 * gated routes, which would render a broken chrome before sign-in. Theme
 * tokens only, per DESIGN.md.
 */

import { themeCss } from "./profileBar"

export const uiLoginPageHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Meridian — Sign in</title>
<style>
  ${themeCss}
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
         color: var(--text); line-height: 1.5; min-height: 100vh;
         display: flex; align-items: center; justify-content: center; padding: 24px 16px; }
  .card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
    padding: 28px 32px; width: 100%; max-width: 420px;
  }
  h1 { font-size: 18px; margin-bottom: 6px; }
  p { color: var(--muted); font-size: 13px; margin-bottom: 18px; }
  label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px; }
  input {
    width: 100%; font: inherit; font-family: var(--mono, ui-monospace, monospace); font-size: 13px;
    background: var(--bg); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 9px 11px;
  }
  input:focus { outline: none; border-color: var(--accent); }
  button {
    margin-top: 14px; width: 100%; font: inherit; font-size: 14px; font-weight: 600;
    background: var(--accent); color: #fff; border: 0; border-radius: 6px; padding: 9px 12px; cursor: pointer;
  }
  button:disabled { opacity: 0.6; cursor: default; }
  .error { color: var(--red); font-size: 13px; margin-top: 12px; min-height: 1.5em; }
</style>
</head>
<body>
<main class="card">
  <h1>Sign in to Meridian</h1>
  <p>This instance is protected by an API key. Enter it to open the dashboard; the browser keeps a session for 12 hours.</p>
  <form id="form">
    <label for="key">API key</label>
    <input id="key" name="key" type="password" autocomplete="current-password" spellcheck="false" autofocus required>
    <button id="submit" type="submit">Sign in</button>
    <div class="error" id="error" role="alert"></div>
  </form>
</main>
<script>
(function () {
  var form = document.getElementById('form');
  var input = document.getElementById('key');
  var submit = document.getElementById('submit');
  var error = document.getElementById('error');
  // Only a same-origin path is followed back, never a full URL.
  function nextPath() {
    var next = new URLSearchParams(location.search).get('next') || '/';
    return next.charAt(0) === '/' && next.charAt(1) !== '/' && next.charAt(1) !== '\\\\' ? next : '/';
  }
  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    submit.disabled = true;
    error.textContent = '';
    try {
      var res = await fetch('/ui/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: input.value.trim() })
      });
      if (res.ok) { location.replace(nextPath()); return; }
      var data = await res.json().catch(function () { return null; });
      error.textContent = (data && data.error) || 'Sign-in failed.';
    } catch (err) {
      error.textContent = 'Could not reach Meridian.';
    }
    submit.disabled = false;
    input.select();
  });
})();
</script>
</body>
</html>
`
