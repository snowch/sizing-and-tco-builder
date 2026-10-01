/*
 * The page linked to a solution on the server: `?solution=NAME` in the address. The state then
 * lives in the server's folder, not in this browser; every change the page makes is sent back
 * with the version it was read at, and the page asks every couple of seconds whether an
 * assistant has moved the record on. When it has, the page takes the new state and redraws,
 * keeping only where the engineer is (the view, the open steps).
 *
 * Without `?solution=`, nothing here runs and the page keeps its state in this browser as before.
 */

export function remoteFor(location = globalThis.location) {
  let name = "";
  try { name = new URL(location.href).searchParams.get("solution") ?? ""; } catch { return null; }
  if (!name) return null;
  const api = new URL(`../api/solutions/${encodeURIComponent(name)}`, location.href).href;
  let version = 0;
  let timer = null;
  let saving = null, queued = false;
  const listeners = { change: [], status: [] };
  const say = (status, detail = "") => { for (const f of listeners.status) f(status, detail); };

  async function load() {
    const r = await fetch(api, { cache: "no-store" });
    if (r.status === 404) throw new Error(`There is no solution called "${name}" on the server.`);
    if (!r.ok) throw new Error(`The server answered ${r.status}.`);
    const rec = await r.json();
    version = rec.version;
    say("linked");
    return rec.state;
  }

  /* Send the state; a conflict means the assistant wrote first, and the newer record wins. */
  async function save(state) {
    if (saving) { queued = true; return saving; }
    say("saving");
    saving = (async () => {
      try {
        const r = await fetch(api, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ version, state }) });
        if (r.status === 400 && /changed meanwhile/.test((await r.clone().json().catch(() => ({}))).error ?? "")) { await poll(true); return; }
        if (!r.ok) throw new Error(`${r.status}`);
        version = (await r.json()).version;
        say("linked");
      } catch (e) {
        say("offline", e.message);
      } finally {
        saving = null;
        if (queued) { queued = false; save(state); }
      }
    })();
    return saving;
  }

  async function poll(force = false) {
    if (saving && !force) return;
    try {
      const r = await fetch(`${api}?since=${version}`, { cache: "no-store" });
      if (r.status === 304) { say("linked"); return; }
      if (!r.ok) { say("offline", `${r.status}`); return; }
      const rec = await r.json();
      if (rec.version === version) return;
      version = rec.version;
      say("linked");
      for (const f of listeners.change) f(rec.state);
    } catch (e) {
      say("offline", e.message);
    }
  }

  return {
    name, api,
    get version() { return version; },
    load, save, poll,
    on: (event, f) => { listeners[event].push(f); },
    start: (ms = 2000) => { if (!timer) timer = setInterval(poll, ms); },
    stop: () => { clearInterval(timer); timer = null; },
  };
}
