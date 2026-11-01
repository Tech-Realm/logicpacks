const FAVICON = `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#181818"/><rect x="6.5" y="6.5" width="19" height="19" rx="5" fill="none" stroke="#ececea" stroke-width="2"/><circle cx="16" cy="16" r="3.5" fill="#ececea"/></svg>',
)}">`;

// The LogicPacks look (apps/web/DESIGN.md): pill actions, a soft pack-frame card, regular-weight
// display headings in Inter's optical sizes, ink focus rings.
const PAGE_STYLE = `<style>
  :root { color-scheme: light dark; --bg: #ededed; --card: #fafafa; --text: #0a0a0a; --muted: #6b6b6b; --line: #e6e6e6; --field: #fff; --primary: #0a0a0a; --on-primary: #fff; --glow: rgb(0 0 0 / 4%); --ring: #a3a3a3; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0b0b0b; --card: #151515; --text: #f5f5f5; --muted: #9a9a9a; --line: rgb(255 255 255 / 9%); --field: rgb(255 255 255 / 3%); --primary: #fafafa; --on-primary: #0a0a0a; --glow: rgb(255 255 255 / 6%); --ring: rgb(255 255 255 / 45%); } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--text); font: 15px/1.5 "Inter Variable", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
  main { width: 100%; max-width: 400px; background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 32px; animation: rise 420ms cubic-bezier(0.22, 1, 0.36, 1) both; }
  @keyframes rise { from { opacity: 0; transform: translateY(6px); } }
  @media (prefers-reduced-motion: reduce) { main { animation: none; } }
  .brand { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 600; letter-spacing: -0.03em; margin: 0 0 28px; }
  .mark { width: 20px; height: 20px; }
  h1 { font-size: 26px; font-weight: 400; letter-spacing: -0.03em; line-height: 1.15; margin: 0 0 6px; font-optical-sizing: auto; }
  p { margin: 0 0 20px; color: var(--muted); }
  label { display: block; font-size: 13px; margin: 12px 0 4px; }
  input { width: 100%; padding: 9px 10px; border: 1px solid var(--line); border-radius: 10px; background: var(--field); color: inherit; font: inherit; outline: none; transition: border-color 150ms ease-out, box-shadow 150ms ease-out; }
  input:focus { border-color: var(--ring); box-shadow: 0 0 0 1px var(--ring); }
  :focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }
  button { width: 100%; margin-top: 20px; padding: 10px; border: 1px solid var(--primary); border-radius: 999px; background: var(--primary); color: var(--on-primary); font: inherit; font-weight: 500; cursor: pointer; transition: opacity 150ms ease-out, transform 150ms ease-out; }
  button:hover { opacity: 0.9; }
  button:active { opacity: 0.75; }
  .switch { margin-top: 14px; text-align: center; font-size: 13px; color: var(--muted); }
  .switch a { color: var(--text); cursor: pointer; text-decoration: underline; text-decoration-color: var(--line); text-underline-offset: 3px; }
  .error { color: #e5484d; font-size: 13px; min-height: 18px; margin-top: 10px; }
  .name-only { display: none; }
  .tabs { display: flex; gap: 4px; padding: 3px; border: 1px solid var(--line); border-radius: 9px; margin-bottom: 4px; }
  .tabs a { flex: 1; text-align: center; padding: 6px 0; border-radius: 6px; font-size: 13px; cursor: pointer; color: var(--muted); }
  .tabs a[aria-selected="true"] { background: var(--primary); color: var(--on-primary); font-weight: 600; }
  .quick { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--line); }
  .quick label { margin-top: 0; color: var(--muted); }
  h2 { font-size: 15px; font-weight: 500; letter-spacing: -0.01em; margin: 24px 0 6px; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { padding: 8px 0; border-top: 1px solid var(--line); font-size: 14px; }
  .row { display: flex; gap: 8px; align-items: center; }
  .row input { flex: 1; }
  .row button { width: auto; margin-top: 0; padding: 8px 12px; }
  .muted { color: var(--muted); font-size: 13px; }
  .ok { color: var(--text); }
  a { color: var(--text); }
  pre { white-space: pre-wrap; word-break: break-all; font-size: 12px; padding: 10px; border: 1px solid var(--line); border-radius: 10px; }
  .code { font: 600 24px/1.2 ui-monospace, monospace; letter-spacing: 2px; margin: 8px 0 16px; }
  .badges { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px 6px; margin-top: 8px; }
  .badge { display: flex; flex-direction: column; align-items: center; gap: 4px; text-align: center; font-size: 11px; line-height: 1.2; }
  .badge i { width: 26px; height: 26px; transform: rotate(45deg); border: 1px solid var(--text); border-radius: 6px; display: block; margin: 4px; }
  .badge[data-tier="silver"] i { background: color-mix(in srgb, var(--text) 15%, transparent); }
  .badge[data-tier="gold"] i { background: color-mix(in srgb, var(--text) 35%, transparent); }
  .badge[data-tier="platinum"] i { background: var(--text); }
  .badge.locked { color: var(--muted); }
  .badge.locked i { border-style: dashed; border-color: var(--line); background: transparent; }
  .meter { height: 4px; border-radius: 4px; background: var(--line); overflow: hidden; margin: 6px 0 2px; }
  .meter span { display: block; height: 100%; background: var(--text); }
  .check { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; margin-top: 10px; }
  .check input { width: auto; margin-top: 3px; }
  .agents { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .agents button, button.secondary { margin-top: 0; background: transparent; color: var(--text); border-color: var(--line); font-weight: 500; }
  .agents button:hover { border-color: var(--ring); opacity: 1; }
  .flow { margin-top: 10px; padding: 12px; border: 1px solid var(--line); border-radius: 10px; font-size: 14px; }
  .flow-title { font-weight: 600; margin-bottom: 6px; }
  .flow .code { font-size: 18px; margin: 0 0 0 6px; }
  .agent-list li { display: flex; justify-content: space-between; gap: 8px; }
  .agent-list code { font-size: 12px; }
  .providers { display: grid; gap: 8px; margin: 16px 0 6px; }
  a.provider { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 9px 10px; border: 1px solid var(--line); border-radius: 999px; color: var(--text); text-decoration: none; font-weight: 500; transition: border-color 150ms ease-out, opacity 150ms ease-out; }
  a.provider:hover { border-color: var(--ring); }
  a.provider:active { opacity: 0.75; }
  a.provider svg { width: 16px; height: 16px; flex: none; }
  .or { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 12px; margin: 14px 0 2px; }
  .or::before, .or::after { content: ""; flex: 1; border-top: 1px solid var(--line); }
  .notice { font-size: 13px; color: #e5484d; margin: 0 0 12px; }
</style>`;

const GOOGLE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.8Z"/><path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24Z"/><path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6h-4a12 12 0 0 0 0 10.8l4-3.1Z"/><path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.9 3.6-4.9 6.7-4.9Z"/></svg>`;
const GITHUB_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 .5a11.5 11.5 0 0 0-3.6 22.4c.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.9 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.2c0 .3.2.7.8.6A11.5 11.5 0 0 0 12 .5Z"/></svg>`;

/** Which "Continue with ..." buttons a host shows: only providers it has turned on. */
export interface SignInProviders {
  readonly google: boolean;
  readonly github: boolean;
}

const providerButtons = (
  providers: SignInProviders,
  /** A workspace invite or a project invite/share-link token the sign-in should honour. */
  token: { readonly invite?: string; readonly project?: string } = {},
) => {
  const params = new URLSearchParams();
  if (token.invite !== undefined) params.set("invite", token.invite);
  if (token.project !== undefined) params.set("project", token.project);
  const query = params.size === 0 ? "" : `?${params.toString().replace(/&/g, "&amp;")}`;
  const buttons = [
    providers.google
      ? `<a class="provider" id="continue-google" href="/lp/auth/google/start${query}">${GOOGLE_ICON}Continue with Google</a>`
      : "",
    providers.github
      ? `<a class="provider" id="continue-github" href="/lp/auth/github/start${query}">${GITHUB_ICON}Continue with GitHub</a>`
      : "",
  ].filter(Boolean);
  return buttons.length === 0
    ? ""
    : `<div class="providers">${buttons.join("")}</div><div class="or">or with email</div>`;
};

/**
 * "Have an access code?": optional, never needed to sign in. The code rides in a short-lived
 * cookie that the sign-in (password, quick, invite, or any provider) redeems on the server.
 */
const ACCESS_CODE_FIELD = `<div class="switch"><a id="access-code-toggle" data-testid="lp-access-code-toggle">Have an access code?</a></div>
  <div id="access-code-row" hidden><label for="access-code">Access code</label><input id="access-code" autocomplete="off" placeholder="LP-XXXX-XXXX" data-testid="lp-access-code-input"></div>`;

const ACCESS_CODE_SCRIPT = `
  (() => {
    const toggle = document.getElementById("access-code-toggle");
    const row = document.getElementById("access-code-row");
    const input = document.getElementById("access-code");
    if (!toggle || !row || !input) return;
    const fromLink = new URLSearchParams(location.search).get("code");
    if (fromLink) { row.hidden = false; input.value = fromLink; }
    toggle.addEventListener("click", () => { row.hidden = !row.hidden; if (!row.hidden) input.focus(); });
    const remember = () => {
      const code = input.value.trim();
      document.cookie = code
        ? "lp_access_code=" + encodeURIComponent(code) + "; path=/; max-age=600; samesite=lax"
        : "lp_access_code=; path=/; max-age=0";
    };
    input.addEventListener("input", remember);
    if (fromLink) remember();
  })();`;

/**
 * The sign-in page a shared host serves to people with no session: email and password,
 * or by name where quick login is on, with pairing one link away. Plain HTML, so it works
 * before (or without) the web client bundle.
 */
export const loginPageHtml = (options: {
  readonly quickLogin: boolean;
  readonly mode?: "login" | "signup";
  readonly providers?: SignInProviders;
  /** Why the last sign-in did not finish, from a provider callback. */
  readonly error?: string | null;
}) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in to LogicPacks</title>
${PAGE_STYLE}
${FAVICON}
</head>
<body>
<main>
  <div class="brand"><svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><rect x="6.5" y="6.5" width="19" height="19" rx="5" fill="none" stroke="currentColor" stroke-width="2.5"/><circle cx="16" cy="16" r="3.5" fill="currentColor"/></svg>LogicPacks</div>
  <p>Where agents and people work together.</p>
  ${options.error ? `<p class="notice" role="alert">${escapeHtml(options.error)}</p>` : ""}
  <div class="tabs" role="tablist">
    <a role="tab" id="tab-login" data-mode="login">Log in</a>
    <a role="tab" id="tab-signup" data-mode="signup">Sign up</a>
  </div>
  ${providerButtons(options.providers ?? { google: false, github: false })}
  <form id="form">
    <div class="name-only" id="name-row"><label for="name">Your name</label><input id="name" autocomplete="name"></div>
    <label for="email">Email</label><input id="email" type="email" autocomplete="email" required>
    <label for="password">Password</label><input id="password" type="password" autocomplete="current-password" minlength="8" required>
    <button id="submit" type="submit">Log in</button>
    <div class="error" id="error" role="alert"></div>
  </form>
  <div class="switch"><a id="toggle"></a></div>
  ${ACCESS_CODE_FIELD}
  ${
    options.quickLogin
      ? `<form id="quick-form" class="quick">
    <label for="quick-name">Or sign in by name on this internal host</label>
    <div class="row"><input id="quick-name" autocomplete="username" placeholder="yourname" pattern="[a-z0-9][a-z0-9-]{0,31}"><button type="submit">Go</button></div>
  </form>`
      : ""
  }
  <div class="switch"><a id="pairing" href="/pair?manual=1">Have a pairing token?</a></div>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  let mode = params.get("mode") === "signup" ? "signup" : ${JSON.stringify(options.mode ?? "login")};
  const render = () => {
    $("name-row").style.display = mode === "signup" ? "block" : "none";
    $("submit").textContent = mode === "signup" ? "Create account" : "Log in";
    $("password").autocomplete = mode === "signup" ? "new-password" : "current-password";
    for (const tab of ["login", "signup"]) {
      $("tab-" + tab).setAttribute("aria-selected", String(tab === mode));
    }
    $("toggle").textContent = mode === "signup" ? "Already have an account? Log in" : "New here? Create an account";
    $("error").textContent = "";
  };
  $("toggle").addEventListener("click", () => { mode = mode === "signup" ? "login" : "signup"; render(); });
  for (const tab of ["login", "signup"]) {
    $("tab-" + tab).addEventListener("click", () => { mode = tab; render(); });
  }
  render();
  // After auth: home, where a member without an agent gets "Connect your agent" first.
  const next = () => { location.href = "/"; };
  $("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("error").textContent = "";
    const body = { mode, email: $("email").value, password: $("password").value };
    if (mode === "signup" && $("name").value.trim()) body.displayName = $("name").value.trim();
    const response = await fetch("/api/lp/auth/password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    if (response.ok) { document.cookie = "lp_access_code=; path=/; max-age=0"; next(); return; }
    const payload = await response.json().catch(() => ({}));
    $("error").textContent = payload.message || (mode === "signup" ? "Sign up failed. Try again." : "Log in failed. Try again.");
  });
  const quick = $("quick-form");
  if (quick) quick.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = $("quick-name").value.trim().toLowerCase();
    if (name) location.href = "/api/lp/auth/quick?name=" + encodeURIComponent(name);
  });
${ACCESS_CODE_SCRIPT}
</script>
</body>
</html>`;

/**
 * Where a member connects their own agent (Claude, Codex, ...) and shares projects. Signing up
 * lands here first: on a shared host a turn runs on the member's own account.
 */
export const accountPageHtml = () => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your LogicPacks account</title>
${PAGE_STYLE}
${FAVICON}
</head>
<body>
<main>
  <div class="brand"><svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><rect x="6.5" y="6.5" width="19" height="19" rx="5" fill="none" stroke="currentColor" stroke-width="2.5"/><circle cx="16" cy="16" r="3.5" fill="currentColor"/></svg>LogicPacks</div>
  <h1>Your account</h1>
  <p id="who">Loading your account.</p>
  <section id="claude-section" hidden>
    <h2>Connect your agent</h2>
    <p class="muted" id="agent-status">Your turns run on your own plan.</p>
    <div class="agents" id="agent-buttons">
      <button type="button" class="secondary" id="login-claude" data-provider="claude">Log in with Claude</button>
      <button type="button" class="secondary" id="login-codex" data-provider="codex">Log in with Codex</button>
    </div>
    <div id="login-flow" class="flow" hidden>
      <div id="login-title" class="flow-title"></div>
      <a id="login-link" target="_blank" rel="noreferrer">Open the sign-in page</a>
      <div id="login-code-row" hidden>Enter this code there: <span class="code" id="login-code"></span></div>
      <form id="login-code-form" class="row" hidden>
        <input id="login-code-input" autocomplete="off" placeholder="Paste the code Claude shows you" aria-label="Code from Claude">
        <button type="submit">Connect</button>
      </form>
      <p class="muted" id="login-wait" hidden>Waiting for you to approve the code.</p>
      <div class="switch"><a id="login-cancel">Cancel</a></div>
    </div>
    <ul id="agent-list" class="agent-list"></ul>
    <div class="switch"><a id="paste-toggle">Paste a token instead</a></div>
    <form id="claude-form" hidden>
      <label for="token">Token from <code>claude setup-token</code></label>
      <div class="row"><input id="token" type="password" autocomplete="off" placeholder="sk-ant-oat01-..."><button type="submit">Connect</button></div>
    </form>
  </section>
  <section id="connections-section" hidden>
    <h2>Connections</h2>
    <p class="muted">Sync pushes to GitHub as you once it is connected. Cloudflare is kept for deploys and custom domains.</p>
    <ul id="connections" class="agent-list"></ul>
  </section>
  <section id="work-section" hidden>
    <h2>How you work</h2>
    <div class="agents">
      <button type="button" class="secondary" id="work-pro" data-choice="pro">Developer</button>
      <button type="button" class="secondary" id="work-beginner" data-choice="beginner">Just let me start</button>
    </div>
  </section>
  <h2>Add from GitHub</h2>
  <form id="import-form">
    <label for="remote">Repository URL</label>
    <input id="remote" placeholder="https://github.com/team/app" required>
    <label for="share-with">Share with (emails or names, comma separated)</label>
    <div class="row"><input id="share-with"><button type="submit">Add</button></div>
  </form>
  <h2>Use with your agent</h2>
  <p class="muted">Keep Claude Code or Codex in your own terminal. The LogicPacks helper streams each session into its project so your team sees it live.</p>
  <button id="helper-connect" type="button">Connect a terminal</button>
  <pre id="helper-command" hidden></pre>
  <h2>Projects</h2>
  <ul id="projects"><li class="muted">No projects yet.</li></ul>
  <section id="achievements-section" hidden>
    <h2>Achievements</h2>
    <p class="muted" id="rank"></p>
    <div class="muted" id="level"></div>
    <div class="meter"><span id="level-meter" style="width:0%"></span></div>
    <div class="badges" id="badges"></div>
    <label class="check"><input type="checkbox" id="share-usage"> <span id="share-usage-text">Share my usage and badges with the team.</span></label>
  </section>
  <div class="error" id="error" role="alert"></div>
  <button id="open" type="button">Open the workspace</button>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  const api = async (path, body) => {
    const response = await fetch(path, body === undefined ? { credentials: "same-origin" } : {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || payload.error || "Request failed.");
    return payload;
  };
  const show = (error) => { $("error").textContent = error ? error.message : ""; };
  $("open").addEventListener("click", () => { location.href = "/"; });

  // Connect your agent: the CLI login runs on the host in this member's own home.
  const renderAgents = async () => {
    const { providers } = await api("/api/lp/providers/status");
    const list = $("agent-list");
    list.replaceChildren();
    let any = false;
    for (const agent of providers) {
      any = any || agent.connected;
      const item = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = agent.label;
      const state = document.createElement("span");
      state.className = agent.connected ? "ok" : "muted";
      if (agent.connected) state.textContent = "Connected";
      else if (!agent.installed) { state.innerHTML = "Not installed. <code></code>"; state.querySelector("code").textContent = agent.installHint; }
      else state.textContent = agent.kind === "claude" || agent.kind === "codex" ? "Not connected" : "Connect in the app with an API key";
      item.append(name, state);
      list.append(item);
      const button = $("login-" + agent.kind);
      if (button) {
        button.disabled = agent.connected || !agent.installed;
        button.textContent = agent.connected ? agent.label + " connected" : "Log in with " + agent.label;
      }
    }
    $("agent-status").textContent = any ? "Connected. Your turns run on your own account." : "Your turns run on your own plan. Sign in once.";
    $("agent-status").className = any ? "ok" : "muted";
  };
  let currentLogin = null;
  let poll = null;
  const endFlow = () => { if (poll) clearInterval(poll); poll = null; currentLogin = null; $("login-flow").hidden = true; };
  const startLogin = async (provider) => {
    show(null);
    endFlow();
    try {
      const login = await api("/api/lp/providers/login/start", { provider });
      if (!login.url) throw new Error(login.output || "The login did not start. Try again.");
      currentLogin = login;
      $("login-flow").hidden = false;
      $("login-title").textContent = provider === "claude" ? "Sign in to Claude" : "Sign in to ChatGPT for Codex";
      $("login-link").href = login.url;
      $("login-code-row").hidden = provider !== "codex";
      $("login-code").textContent = login.code || "";
      $("login-code-form").hidden = provider !== "claude";
      $("login-wait").hidden = provider !== "codex";
      if (provider === "codex") {
        poll = setInterval(async () => {
          const status = await api("/api/lp/providers/login/status?provider=codex").catch(() => null);
          if (status && status.connected) { endFlow(); await renderAgents(); }
          else if (status && !status.running) { endFlow(); show(new Error("The Codex login ended before it was approved. Start it again.")); }
        }, 2500);
      }
    } catch (error) { show(error); }
  };
  $("login-claude").addEventListener("click", () => startLogin("claude"));
  $("login-codex").addEventListener("click", () => startLogin("codex"));
  $("login-cancel").addEventListener("click", () => {
    if (currentLogin) api("/api/lp/providers/login/cancel", { provider: currentLogin.provider }).catch(() => {});
    endFlow();
  });
  $("login-code-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    show(null);
    try {
      const result = await api("/api/lp/providers/login/code", { provider: "claude", code: $("login-code-input").value, loginId: currentLogin && currentLogin.loginId });
      if (!result.connected) throw new Error(result.failed ? "Claude did not accept that code. Start again." : "No token came back yet. Check the code and try again.");
      $("login-code-input").value = "";
      endFlow();
      await renderAgents();
    } catch (error) { show(error); }
  });
  $("paste-toggle").addEventListener("click", () => { $("claude-form").hidden = !$("claude-form").hidden; });

  const renderProjects = async (projects) => {
    const list = $("projects");
    if (projects.length === 0) return;
    list.replaceChildren();
    for (const project of projects) {
      const item = document.createElement("li");
      const title = document.createElement("div");
      title.innerHTML = "<strong></strong> <span class=muted></span>";
      title.querySelector("strong").textContent = project.title;
      title.querySelector("span").textContent =
        project.role + ", " + (project.synced ? "Synced" : "on this host only");
      item.append(title);
      const members = document.createElement("div");
      members.className = "muted";
      item.append(members);
      const refresh = async () => {
        const { members: rows } = await api("/api/lp/members?projectId=" + encodeURIComponent(project.id));
        members.textContent = rows.length === 0 ? "Not shared yet." :
          "Shared with " + rows.map((row) => row.user.displayName + (row.role === "owner" ? " (owner)" : "")).join(", ");
      };
      if (project.role !== "member") {
        const form = document.createElement("form");
        form.className = "row";
        form.innerHTML = '<input placeholder="Teammate email or name" aria-label="Teammate"><button type="submit">Share</button>';
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          show(null);
          try {
            await api("/api/lp/members", { projectId: project.id, user: form.querySelector("input").value });
            form.querySelector("input").value = "";
            await refresh();
          } catch (error) { show(error); }
        });
        item.append(form);
      }
      list.append(item);
      refresh().catch(show);
    }
  };

  (async () => {
    try {
      const me = await api("/api/lp/me");
      if (!me.user && !me.operator) { location.href = "/lp/login"; return; }
      $("who").textContent = me.user
        ? "Signed in as " + me.user.displayName + " (" + me.user.email + ")."
        : "Signed in as the host operator.";
      if (me.user) {
        $("claude-section").hidden = false;
        await renderAgents();
        await renderConnections();
      }
      await renderProjects((await api("/api/lp/projects")).projects);
      await renderAchievements();
    } catch (error) { show(error); }
  })();

  // The profile: level, badges and leaderboard place, from the same API the app reads.
  const renderAchievements = async () => {
    const [mine, board] = await Promise.all([
      api("/api/lp/achievements"),
      api("/api/lp/leaderboard?range=30d"),
    ]);
    $("achievements-section").hidden = false;
    const me = board.entries.find((entry) => entry.isYou);
    $("rank").textContent = me && me.tokens > 0
      ? "#" + me.rank + " of " + board.entries.length + " on this host in the last 30 days, " +
        me.turns + (me.turns === 1 ? " turn" : " turns") + (me.currentStreakDays > 1 ? ", " + me.currentStreakDays + " day streak." : ".")
      : "No turns in the last 30 days yet.";
    $("level").textContent = "Level " + mine.level + ", " + mine.points + " points";
    $("level-meter").style.width = Math.round(mine.levelProgress * 100) + "%";
    const badges = $("badges");
    badges.replaceChildren();
    const ordered = [...mine.achievements].sort((a, b) => Number(b.unlocked) - Number(a.unlocked));
    for (const achievement of ordered) {
      const badge = document.createElement("div");
      badge.className = "badge" + (achievement.unlocked ? "" : " locked");
      badge.dataset.tier = achievement.tier;
      badge.title = achievement.description;
      badge.append(document.createElement("i"), achievement.name);
      badges.append(badge);
    }
    const sharing = board.viewer.sharing;
    $("share-usage").checked = sharing.shareUsage;
    $("share-usage-text").textContent = sharing.shareUsage
      ? "Share my usage and badges with the team." + (sharing.isDecided ? "" : " This is the default.")
      : "Share my usage and badges with the team. Hidden now: you still see your own, and the host owner still sees them.";
  };
  $("share-usage").addEventListener("change", async (event) => {
    show(null);
    try {
      await api("/api/lp/usage-sharing", { shareUsage: event.target.checked });
      await renderAchievements();
    } catch (error) { show(error); }
  });

  // GitHub and Cloudflare: the member's own accounts, connected through each provider's OAuth.
  const renderConnections = async () => {
    const [{ connections, onboarding }] = await Promise.all([api("/api/lp/connections")]);
    const list = $("connections");
    list.replaceChildren();
    for (const provider of ["github", "cloudflare"]) {
      const entry = connections[provider];
      if (!entry.available && !entry.connected) continue;
      const item = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = provider === "github" ? "GitHub" : "Cloudflare";
      const action = document.createElement("span");
      if (entry.connected) {
        action.innerHTML = '<span class="ok"></span> <a role="button"></a>';
        action.querySelector("span").textContent = "Connected" + (entry.account ? " as " + entry.account : "");
        const remove = action.querySelector("a");
        remove.textContent = "Disconnect";
        remove.addEventListener("click", async () => {
          show(null);
          try { await api("/api/lp/connections/disconnect", { provider }); await renderConnections(); }
          catch (error) { show(error); }
        });
      } else {
        const link = document.createElement("a");
        link.href = "/lp/auth/" + provider + "/connect?next=" + encodeURIComponent("/lp/account");
        link.textContent = "Connect";
        action.append(link);
      }
      item.append(name, action);
      list.append(item);
    }
    $("connections-section").hidden = list.children.length === 0;
    $("work-section").hidden = false;
    for (const choice of ["pro", "beginner"]) {
      $("work-" + choice).setAttribute("aria-pressed", String(onboarding === choice));
      $("work-" + choice).style.borderColor = onboarding === choice ? "var(--text)" : "";
    }
  };
  for (const choice of ["pro", "beginner"]) {
    $("work-" + choice).addEventListener("click", async () => {
      show(null);
      try { await api("/api/lp/onboarding", { choice, setupOnly: true }); await renderConnections(); }
      catch (error) { show(error); }
    });
  }
  const failure = new URLSearchParams(location.search).get("error");
  if (failure) show(new Error(failure));

  $("import-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    show(null);
    try {
      const shareWith = $("share-with").value.split(",").map((name) => name.trim()).filter(Boolean);
      await api("/api/lp/sync/import", { remoteUrl: $("remote").value.trim(), shareWith });
      $("remote").value = "";
      $("share-with").value = "";
      await renderProjects((await api("/api/lp/projects")).projects);
    } catch (error) { show(error); }
  });

  $("claude-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    show(null);
    try {
      await api("/api/lp/providers/claude", { token: $("token").value });
      $("token").value = "";
      $("claude-form").hidden = true;
      await renderAgents();
    } catch (error) { show(error); }
  });
  $("helper-connect").addEventListener("click", async () => {
    show(null);
    try {
      const { token } = await api("/api/lp/helper/token", {});
      $("helper-command").textContent =
        "curl -fsSL https://logicpacks.io/helper.sh | bash\\nlp login --server " + location.origin + " --token " + token;
      $("helper-command").hidden = false;
    } catch (error) { show(error); }
  });
</script>
</body>
</html>`;

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/**
 * Where an invite link lands for someone who is not signed in yet. One form:
 * create an account (the default) or sign in, and they are in the workspace.
 */
export const joinPageHtml = (options: {
  readonly workspaceName: string | null;
  readonly quickLogin: boolean;
  readonly invite?: string;
  readonly providers?: SignInProviders;
  /** A project invite or share link (ProjectShares) instead of a workspace invite. */
  readonly project?: {
    readonly title: string | null;
    readonly closedMessage?: string | undefined;
    readonly email?: string | undefined;
    readonly domain?: string | null | undefined;
  };
}) => {
  const project = options.project;
  const name = project ? project.title : options.workspaceName;
  const noun = project ? "project" : "workspace";
  const closed =
    project?.closedMessage ?? "This invite link has expired. Ask whoever sent it for a new one.";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Join ${name === null ? "LogicPacks" : escapeHtml(name)}</title>
${PAGE_STYLE}
${FAVICON}
</head>
<body>
<main>
  <div class="brand"><svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><rect x="6.5" y="6.5" width="19" height="19" rx="5" fill="none" stroke="currentColor" stroke-width="2.5"/><circle cx="16" cy="16" r="3.5" fill="currentColor"/></svg>LogicPacks</div>
  <h1>Join the ${noun}</h1>
  ${
    name === null
      ? `<p>${escapeHtml(closed)}</p>`
      : `<p>You're invited to <strong>${escapeHtml(name)}</strong>. Create an account or sign in to join.${
          project?.domain ? ` Use your ${escapeHtml(project.domain)} email.` : ""
        }</p>
  ${providerButtons(
    options.providers ?? { google: false, github: false },
    project ? { project: options.invite ?? "" } : { invite: options.invite ?? "" },
  )}
  <form id="form">
    <div id="name-row"><label for="name">Your name</label><input id="name" autocomplete="name"></div>
    <label for="email">Email</label><input id="email" type="email" autocomplete="email" required${project?.email ? ` value="${escapeHtml(project.email)}"` : ""}>
    <label for="password">Password</label><input id="password" type="password" autocomplete="new-password" minlength="8" required>
    <button id="submit" type="submit">Join ${noun}</button>
    <div class="error" id="error" role="alert"></div>
  </form>
  <div class="switch"><a id="toggle">Already have an account? Sign in</a></div>
  ${ACCESS_CODE_FIELD}
  ${
    options.quickLogin
      ? `<form id="quick-form" class="row" style="margin-top:16px"><input id="quick-name" placeholder="or join by name" aria-label="Name"><button type="submit">Join</button></form>`
      : ""
  }`
  }
</main>
<script>
  const $ = (id) => document.getElementById(id);
  const invite = new URLSearchParams(location.search).get("invite") || "";
  let mode = "signup";
  const join = async (body) => {
    $("error").textContent = "";
    const response = await fetch("${project ? "/api/lp/join/project" : "/api/lp/join"}", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ invite, ...body }),
    });
    if (response.ok) { document.cookie = "lp_access_code=; path=/; max-age=0"; location.href = "/"; return; }
    const payload = await response.json().catch(() => ({}));
    $("error").textContent = payload.message || "Could not join. Try again.";
  };
  if ($("form")) {
    $("toggle").addEventListener("click", () => {
      mode = mode === "signup" ? "login" : "signup";
      $("name-row").style.display = mode === "signup" ? "block" : "none";
      $("toggle").textContent = mode === "signup" ? "Already have an account? Sign in" : "New here? Create an account";
      $("password").autocomplete = mode === "signup" ? "new-password" : "current-password";
    });
    $("form").addEventListener("submit", (event) => {
      event.preventDefault();
      const body = { mode, email: $("email").value, password: $("password").value };
      if (mode === "signup" && $("name").value.trim()) body.displayName = $("name").value.trim();
      void join(body);
    });
  }
  if ($("quick-form")) {
    $("quick-form").addEventListener("submit", (event) => {
      event.preventDefault();
      void join({ mode: "quick", name: $("quick-name").value });
    });
  }
${ACCESS_CODE_SCRIPT}
</script>
</body>
</html>`;
};

/** Where `lp login` sends people: approve this computer's helper for the signed-in account. */
export const helperApprovePageHtml = () => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect the LogicPacks helper</title>
${PAGE_STYLE}
${FAVICON}
</head>
<body>
<main>
  <div class="brand"><svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><rect x="6.5" y="6.5" width="19" height="19" rx="5" fill="none" stroke="currentColor" stroke-width="2.5"/><circle cx="16" cy="16" r="3.5" fill="currentColor"/></svg>LogicPacks</div>
  <h1>Connect a terminal</h1>
  <p id="intro">Checking the code.</p>
  <div class="code" id="code"></div>
  <p class="muted" id="who"></p>
  <button id="approve" type="button" hidden>Approve</button>
  <div class="switch" id="signin" hidden><a href="/lp/login">Sign in</a>, then open this link again.</div>
  <div class="error" id="error" role="alert"></div>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  const code = new URLSearchParams(location.search).get("code") || "";
  $("code").textContent = code;
  const fail = (message) => { $("error").textContent = message; };
  (async () => {
    const pending = await fetch("/api/lp/helper/pair?code=" + encodeURIComponent(code), { credentials: "same-origin" });
    if (!pending.ok) { $("intro").textContent = "This code expired. Run lp login again in your terminal."; return; }
    const info = await pending.json();
    if (info.approved) { $("intro").textContent = "Already approved. You can close this tab."; return; }
    $("intro").textContent = "Approve only if this code matches the one in your terminal" + (info.device ? " on " + info.device : "") + ".";
    const me = await fetch("/api/lp/me", { credentials: "same-origin" }).then((r) => r.json()).catch(() => ({}));
    if (!me.user && !me.operator) { $("signin").hidden = false; return; }
    $("who").textContent = "Sessions will stream as " + (me.user ? me.user.displayName : "the host owner") + ".";
    $("approve").hidden = false;
  })().catch((error) => fail(error.message));
  $("approve").addEventListener("click", async () => {
    fail("");
    const response = await fetch("/api/lp/helper/pair/approve", {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ code }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { fail(body.message || "Could not approve this code."); return; }
    $("approve").hidden = true;
    $("intro").textContent = "Connected. Go back to your terminal.";
  });
</script>
</body>
</html>`;

const pageShell = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${PAGE_STYLE}
${FAVICON}
</head>
<body>
<main>
  <div class="brand"><svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><rect x="6.5" y="6.5" width="19" height="19" rx="5" fill="none" stroke="currentColor" stroke-width="2.5"/><circle cx="16" cy="16" r="3.5" fill="currentColor"/></svg>LogicPacks</div>
  ${body}
</main>
</body>
</html>`;

/** Where a provider sign-in or connection that did not finish lands. */
export const oauthErrorPageHtml = (message: string) =>
  pageShell(
    "Sign-in did not finish",
    `<h1>That did not finish</h1>
  <p>${escapeHtml(message)}</p>
  <div class="switch"><a href="/lp/login">Back to sign in</a> or <a href="/">open LogicPacks</a></div>`,
  );

/**
 * The development stand-in for a provider's consent screen. Only served when that
 * provider runs on the mock, which is refused on any public host.
 */
export const mockConsentPageHtml = (options: {
  readonly providerLabel: string;
  readonly hidden: Readonly<Record<string, string>>;
  readonly askEmail: boolean;
}) =>
  pageShell(
    `Continue with ${options.providerLabel} (development)`,
    `<h1>Continue with ${escapeHtml(options.providerLabel)}</h1>
  <p>Development stand-in for ${escapeHtml(options.providerLabel)}'s consent screen.</p>
  <form method="get" id="mock-form">
    ${Object.entries(options.hidden)
      .map(
        ([name, value]) =>
          `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
      )
      .join("\n    ")}
    <label for="mock-email">${options.askEmail ? "Email" : "Account email"}</label><input id="mock-email" name="email" type="email" required autofocus>
    <label for="mock-name">Name</label><input id="mock-name" name="name">
    <label class="check"><input type="checkbox" name="verified" value="1" checked> Email is verified</label>
    <button type="submit" id="mock-continue">Continue</button>
  </form>`,
  );
