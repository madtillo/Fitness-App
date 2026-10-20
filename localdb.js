/* Lokaler Speicher auf dem iPhone (IndexedDB).
   Bildet genau die kleine Datenbank-Schnittstelle nach, die die App aus der Claude-Version kennt
   (collection().doc().get/set/update/delete/onSnapshot, orderBy().limit().get/onSnapshot).
   So bleibt der bestehende App-Code unverändert. Daten verlassen das Gerät nie automatisch. */
(function () {
  "use strict";
  const DB_NAME = "tills-fitness", STORE = "docs", VERSION = 1;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, VERSION);
      r.onupgradeneeded = () => {
        const s = r.result.createObjectStore(STORE, { keyPath: "key" });
        s.createIndex("col", "col");
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  function tx(mode, fn) {
    return open().then((db) => new Promise((res, rej) => {
      const t = db.transaction(STORE, mode), s = t.objectStore(STORE);
      let out; Promise.resolve(fn(s, (v) => (out = v))).catch(rej);
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    }));
  }
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

  /* Änderungen melden: im selben Fenster und in anderen offenen Fenstern der App. */
  const listeners = new Set();
  let bc = null; try { bc = new BroadcastChannel("tills-fitness-db"); bc.onmessage = (e) => fire(e.data, true); } catch (_) {}
  function fire(col, remote) { listeners.forEach((l) => { if (l.col === col) l.run(); }); if (!remote && bc) try { bc.postMessage(col); } catch (_) {} }

  const docSnap = (id, data) => ({ id, exists: data != null, data: () => clone(data) });
  const querySnap = (rows) => ({ empty: rows.length === 0, size: rows.length, docs: rows.map((r) => docSnap(r.id, r.data)) });

  async function getDoc(col, id) {
    const row = await tx("readonly", (s, out) => req(s.get(col + "/" + id)).then(out));
    return row ? row.data : null;
  }
  async function putDoc(col, id, data) {
    if (data == null || typeof data !== "object") throw new Error("invalid_document");
    await tx("readwrite", (s) => req(s.put({ key: col + "/" + id, col, id: String(id), data: clone(data) })));
    fire(col);
  }
  async function delDoc(col, id) {
    await tx("readwrite", (s) => req(s.delete(col + "/" + id)));
    fire(col);
  }
  async function allDocs(col) {
    return tx("readonly", (s, out) => req(s.index("col").getAll(col)).then(out));
  }

  function cmp(a, b) { return a == null ? (b == null ? 0 : -1) : b == null ? 1 : a < b ? -1 : a > b ? 1 : 0; }

  function makeQuery(col, opts) {
    const run = async () => {
      let rows = await allDocs(col);
      (opts.where || []).forEach(([f, op, v]) => {
        rows = rows.filter((r) => { const x = r.data[f];
          return op === "==" || op === "eq" ? x === v : op === "!=" ? x !== v : op === "<" ? x < v : op === "<=" ? x <= v : op === ">" ? x > v : op === ">=" ? x >= v : op === "in" ? v.includes(x) : true; });
      });
      if (opts.order) { const [f, dir] = opts.order; rows.sort((a, b) => cmp(a.data[f], b.data[f]) * (dir === "desc" ? -1 : 1)); }
      if (opts.limit) rows = rows.slice(0, opts.limit);
      return querySnap(rows);
    };
    return {
      where: (f, op, v) => makeQuery(col, Object.assign({}, opts, { where: (opts.where || []).concat([[f, op, v]]) })),
      orderBy: (f, dir) => makeQuery(col, Object.assign({}, opts, { order: [f, dir || "asc"] })),
      limit: (n) => makeQuery(col, Object.assign({}, opts, { limit: n })),
      get: run,
      onSnapshot(next, err) {
        let alive = true;
        const l = { col, run: () => run().then((s) => alive && next(s)).catch((e) => err && err(e)) };
        listeners.add(l); l.run();
        return () => { alive = false; listeners.delete(l); };
      }
    };
  }

  function collection(col) {
    const q = makeQuery(col, {});
    return Object.assign(q, {
      doc(id) {
        id = String(id);
        return {
          id,
          get: async () => docSnap(id, await getDoc(col, id)),
          set: (data) => putDoc(col, id, data),
          update: async (patch) => { const cur = (await getDoc(col, id)) || {}; return putDoc(col, id, Object.assign(cur, patch)); },
          delete: () => delDoc(col, id),
          onSnapshot(next, err) {
            let alive = true;
            const l = { col, run: () => getDoc(col, id).then((d) => alive && next(docSnap(id, d))).catch((e) => err && err(e)) };
            listeners.add(l); l.run();
            return () => { alive = false; listeners.delete(l); };
          }
        };
      }
    });
  }

  /* Sicherung & Umzug */
  const COLLECTIONS = ["sessions", "daily", "weekly", "food", "products"];
  async function exportAll() {
    const out = { app: "tills-fitness", format: 1, exportedAt: new Date().toISOString(), collections: {} };
    for (const c of COLLECTIONS) out.collections[c] = (await allDocs(c)).map((r) => ({ id: r.id, data: r.data }));
    return out;
  }
  /* Import: vorhandene Einträge auf dem Gerät werden nie überschrieben, nur Fehlendes ergänzt. */
  async function importAll(json, { overwrite = false } = {}) {
    if (!json || json.app !== "tills-fitness" || !json.collections) throw new Error("Das ist keine Sicherungsdatei dieser App.");
    const stats = {};
    for (const c of COLLECTIONS) {
      const rows = json.collections[c] || []; let added = 0, kept = 0;
      for (const r of rows) {
        if (!r || r.id == null || typeof r.data !== "object") continue;
        const cur = await getDoc(c, r.id);
        if (cur && !overwrite) { kept++; continue; }
        await tx("readwrite", (s) => req(s.put({ key: c + "/" + r.id, col: c, id: String(r.id), data: r.data }))); added++;
      }
      stats[c] = { added, kept };
      fire(c);
    }
    return stats;
  }
  async function persist() {
    try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch (_) {}
    return false;
  }

  const db = Object.freeze({ collection, doc: (path) => { const i = path.lastIndexOf("/"); return collection(path.slice(0, i)).doc(path.slice(i + 1)); } });
  window.LocalDB = { db, exportAll, importAll, persist, COLLECTIONS };
  // Gleiche Einstiegsstelle wie in der Claude-Version: claude.use("db")
  window.claude = { use: async (name) => (name === "db" ? db : null) };
})();
