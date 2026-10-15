#!/usr/bin/env node
/* Usage: node set-passcode.js 12345678
   Rewrites SALT/HASH in index.html and TOKEN in guard.js. */
const fs = require("fs"), c = require("crypto");
const code = process.argv[2];
if (!/^\d{8}$/.test(code || "")) { console.error("Give an 8-digit code, e.g. node set-passcode.js 12345678"); process.exit(1); }
const sha = x => c.createHash("sha256").update(x).digest("hex");
const salt = c.randomBytes(8).toString("hex"), hash = sha(salt + ":" + code), token = sha("session:" + hash);
let i = fs.readFileSync("index.html", "utf8");
i = i.replace(/var SALT = "\w+"/, `var SALT = "${salt}"`).replace(/var HASH = "\w+"/, `var HASH = "${hash}"`);
fs.writeFileSync("index.html", i);
let g = fs.readFileSync("guard.js", "utf8");
fs.writeFileSync("guard.js", g.replace(/var TOKEN = "\w+"/, `var TOKEN = "${token}"`));
console.log("Passcode updated. Commit index.html and guard.js.");
