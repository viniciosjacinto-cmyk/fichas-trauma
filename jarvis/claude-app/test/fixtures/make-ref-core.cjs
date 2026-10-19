#!/usr/bin/env node
// Builds test/fixtures/out/ref-core.html: the reference port of the core (fixtures/ref-core.js) plus the
// sample notes, in the same shape as jarvis.html. Used to validate core.test.cjs itself:
//   node test/fixtures/make-ref-core.cjs && node test/core.test.cjs test/fixtures/out/ref-core.html
"use strict";
const fs = require("fs");
const path = require("path");
const here = __dirname;
const notes = fs.readFileSync(path.join(here, "..", "..", "ref", "notes.json"), "utf8");
const core = fs.readFileSync(path.join(here, "ref-core.js"), "utf8");
fs.mkdirSync(path.join(here, "out"), { recursive: true });
const out = path.join(here, "out", "ref-core.html");
fs.writeFileSync(out, "<title>JARVIS</title>\n<script type=\"application/json\" id=\"sample-notes\">" + notes.replace(/<\//g, "<\\/") +
  "</script>\n<script id=\"jarvis-core\">\n" + core + "\n</script>\n");
console.log("wrote " + path.relative(process.cwd(), out));
