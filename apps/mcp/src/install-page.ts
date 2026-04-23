export function installPage(publicUrl: string): Response {
  const mcpUrl = `${publicUrl}/mcp`;
  const desktopConfig = JSON.stringify(
    { "slashtalk-mcp": { transport: "http", url: mcpUrl } },
    null,
    2,
  );

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>slashtalk — install</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #0b0d10;
      --fg: #e8e8ea;
      --muted: #9aa0a6;
      --card: #15181c;
      --border: #2a2f36;
      --accent: #22c55e;
      --code: #0d1117;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #fafafa;
        --fg: #111;
        --muted: #666;
        --card: #fff;
        --border: #e4e4e7;
        --code: #f4f4f5;
      }
    }
    * { box-sizing: border-box }
    body {
      margin: 0;
      font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      background: var(--bg);
      color: var(--fg);
    }
    main {
      max-width: 640px;
      margin: 0 auto;
      padding: 3rem 1.25rem 6rem;
    }
    header {
      display: flex;
      align-items: center;
      gap: .75rem;
      margin-bottom: 2rem;
    }
    .dot {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: var(--accent);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent);
    }
    h1 { margin: 0; font-size: 1.5rem; font-weight: 600; letter-spacing: -.01em }
    .tagline { color: var(--muted); margin: 0 0 2.5rem; }
    h2 { font-size: 1rem; font-weight: 600; margin: 0 0 .5rem; letter-spacing: -.01em }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1rem 1.25rem;
      margin-bottom: 1rem;
    }
    .card p { margin: .25rem 0 .75rem; color: var(--muted); font-size: 14px }
    .card a { color: inherit }
    .code {
      position: relative;
      background: var(--code);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: .75rem 3rem .75rem .9rem;
      font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
      white-space: pre;
      overflow-x: auto;
      word-break: break-all;
    }
    .code pre { margin: 0; font: inherit }
    button.copy {
      position: absolute;
      top: .5rem;
      right: .5rem;
      padding: .3rem .55rem;
      border: 1px solid var(--border);
      border-radius: 5px;
      background: var(--card);
      color: var(--fg);
      font: 11px system-ui;
      cursor: pointer;
      opacity: .8;
    }
    button.copy:hover { opacity: 1 }
    button.copy.copied { color: var(--accent); border-color: var(--accent) }
    ol { padding-left: 1.25rem; margin: .25rem 0 .75rem; color: var(--muted); font-size: 14px }
    ol li { margin: .25rem 0 }
    ol a { color: inherit }
    footer {
      margin-top: 3rem;
      color: var(--muted);
      font-size: 13px;
      text-align: center;
    }
  </style>
</head>
<body>
<main>
  <header>
    <span class="dot" aria-hidden="true"></span>
    <h1>slashtalk</h1>
  </header>
  <p class="tagline">See when your teammates are working with AI.</p>

  <h2>Claude Code</h2>
  <div class="card">
    <p>Run this once in your terminal.</p>
    <div class="code" id="cc-cmd">claude mcp add slashtalk-mcp --transport http ${escapeHtml(mcpUrl)}<button class="copy" data-target="cc-cmd">Copy</button></div>
  </div>

  <h2>claude.ai</h2>
  <div class="card">
    <ol>
      <li><a href="https://claude.ai/settings/connectors" target="_blank" rel="noopener">Open connector settings</a> and click <em>Add custom connector</em>.</li>
      <li>Paste this URL as the Remote MCP server URL:</li>
    </ol>
    <div class="code" id="web-url">${escapeHtml(mcpUrl)}<button class="copy" data-target="web-url">Copy</button></div>
  </div>

  <h2>Claude Desktop</h2>
  <div class="card">
    <ol>
      <li>Open <code>~/Library/Application Support/Claude/claude_desktop_config.json</code></li>
      <li>Add this entry under <code>mcpServers</code>, then restart Claude Desktop:</li>
    </ol>
    <div class="code" id="desktop-cfg"><pre>${escapeHtml(desktopConfig)}</pre><button class="copy" data-target="desktop-cfg">Copy</button></div>
  </div>

  <footer>
    On first use, you'll sign in with GitHub.
  </footer>
</main>
<script>
  document.querySelectorAll('button.copy').forEach(btn => {
    btn.addEventListener('click', async () => {
      const el = document.getElementById(btn.dataset.target);
      if (!el) return;
      const text = el.textContent.replace(/Copy\\s*$/, '').trim();
      try {
        await navigator.clipboard.writeText(text);
        btn.classList.add('copied');
        const old = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = old; btn.classList.remove('copied') }, 1500);
      } catch {}
    });
  });
</script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=60",
    },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "\"" ? "&quot;" : "&#39;",
  );
}
