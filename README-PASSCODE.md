# SOLVANE CORE passcode + page guard

**How it works**
- `index.html` shows an 8-digit lock screen. On success it sets a cookie (`sc_auth`) that is shared across tabs, so pages opened in new tabs from the hub stay unlocked. The cookie is a session cookie (cleared when the browser closes), or lasts 7 days if "keep me signed in" is ticked.
- `guard.js` is loaded first in the `<head>` of every other page. If the cookie is missing or wrong, it stops the page and redirects to the hub's lock screen.
- The hub's LOCK button clears the cookie.

**Change the passcode** (run in the repo root, then commit `index.html` and `guard.js`):

    node set-passcode.js 12345678

**Adding a new page later:** put `<script src="guard.js"></script>` as the first thing inside `<head>` (use `../guard.js` for pages in a subfolder).

**Limits:** this is browser-side protection on static hosting. It stops casual direct links, but anyone who reads the source can work out the token and set the cookie. For real protection, use server-side auth (Cloudflare Access, Netlify/Vercel password protection).
