#!/usr/bin/env node
import { readdirSync, writeFileSync } from "node:fs";

const AUDIO_EXT = /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|webm)$/i;
const DIR = "Music";

const files = readdirSync(DIR)
  .filter((f) => AUDIO_EXT.test(f))
  .sort();

writeFileSync(
  "manifest.js",
  "const MANIFEST = [\n" +
    files.map((f) => "  " + JSON.stringify(f) + ",").join("\n") +
    "\n];\n"
);

console.log("manifest.js written with " + files.length + " song(s)");
