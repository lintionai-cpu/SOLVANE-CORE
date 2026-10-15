/* SOLVANE CORE page guard. Redirects to the hub's passcode screen unless signed in.
   Loaded synchronously in <head> so the page is stopped before it renders or runs.
   TOKEN must equal sha256("session:" + HASH) from index.html (set-passcode.js keeps them in sync). */
(function () {
  var TOKEN = "b30a01e0bec770e1d0b885bc1e95cd6250360168782bacbaca53b1adde01d2ea";
  var KEY = "sc_auth";
  if (document.cookie.split("; ").indexOf(KEY + "=" + TOKEN) !== -1) return;
  var src = document.currentScript && document.currentScript.src;
  var hub = src ? src.replace(/guard\.js(\?.*)?$/, "index.html") : "/index.html";
  try { window.stop(); } catch (e) {}
  document.documentElement.style.display = "none";
  location.replace(hub);
})();
