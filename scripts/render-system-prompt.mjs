#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DISCORD_SYSTEM_PROMPT, DISCORD_SYSTEM_PROMPT_URL } from "../dist/discord-system-prompt.js";

const root = process.cwd();
const docsDir = resolve(root, "docs");
const siteDir = resolve(docsDir, "system-prompt-site");
await mkdir(siteDir, { recursive: true });

const markdown = [
  "# Pi Discord Thread Mode System Prompt",
  "",
  `Canonical review URL: ${DISCORD_SYSTEM_PROMPT_URL}`,
  "",
  "This document is generated from `src/discord-system-prompt.ts`.",
  "",
  DISCORD_SYSTEM_PROMPT,
  "",
].join("\n");

await writeFile(resolve(docsDir, "discord-thread-mode-system-prompt.md"), markdown, "utf8");

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex,nofollow" />
  <title>Pi Discord Thread Mode System Prompt</title>
  <style>
    :root { color-scheme: light dark; --bg:#0f1220; --panel:#171a2b; --text:#f6f7fb; --muted:#b7bdd6; --border:rgba(255,255,255,.14); --accent:#8ea4ff; }
    @media (prefers-color-scheme: light) { :root { --bg:#f7f8fc; --panel:#fff; --text:#151827; --muted:#566078; --border:rgba(20,24,39,.12); --accent:#4f63d9; } }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font:17px/1.6 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width:min(100%, 900px); margin:0 auto; padding:28px 16px 56px; }
    header, section { background:var(--panel); border:1px solid var(--border); border-radius:20px; padding:18px; margin:14px 0; }
    h1 { font-size:clamp(2rem, 7vw, 3.6rem); line-height:1.05; letter-spacing:-.03em; margin:.2rem 0 1rem; }
    p { margin:.4rem 0 1rem; }
    .muted { color:var(--muted); }
    pre { white-space:pre-wrap; overflow-wrap:anywhere; background:rgba(0,0,0,.18); border:1px solid var(--border); border-radius:14px; padding:1rem; font:14px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    textarea { width:100%; min-height:10rem; resize:vertical; border:1px solid var(--border); border-radius:14px; padding:.85rem; font:inherit; color:var(--text); background:rgba(0,0,0,.12); }
    button { min-height:44px; border:0; border-radius:12px; padding:.7rem 1rem; background:var(--accent); color:white; font:inherit; font-weight:700; cursor:pointer; margin-top:.75rem; }
    a { color:var(--accent); }
  </style>
</head>
<body>
<main>
  <header>
    <p class="muted">Generated from <code>src/discord-system-prompt.ts</code></p>
    <h1>Pi Discord Thread Mode System Prompt</h1>
    <p>This is the current system prompt appended to Pi sessions created by the Discord thread bridge.</p>
  </header>
  <section>
    <pre id="prompt">${escapeHtml(DISCORD_SYSTEM_PROMPT)}</pre>
    <button type="button" onclick="navigator.clipboard.writeText(document.getElementById('prompt').textContent)">Copy prompt</button>
  </section>
  <section>
    <h2>Review notes</h2>
    <p class="muted">Type feedback, copy it, and paste back into the agent session.</p>
    <textarea id="feedback" placeholder="Feedback on the Discord thread mode prompt..."></textarea>
    <br />
    <button type="button" onclick="navigator.clipboard.writeText(document.getElementById('feedback').value)">Copy feedback</button>
  </section>
</main>
</body>
</html>`;

await writeFile(resolve(siteDir, "index.html"), html, "utf8");
console.log(resolve(siteDir));

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
