/* Barcode-Scanner + Produktsammlung für den Ernährungs-Zähler.
   Ablauf: Kamera (nur nach Tippen) → Barcode auf dem Gerät erkennen → eigene Sammlung → Open Food Facts
   → Produkt prüfen → Menge → „Übernehmen“. Erst dann entsteht ein Eintrag. */
(function () {
  "use strict";
  const N = window.Nutri;
  const OFF_BASE = "https://world.openfoodfacts.org/api/v2/product/";
  const OFF_FIELDS = "code,product_name,product_name_de,brands,quantity,product_quantity,product_quantity_unit,serving_size,serving_quantity,serving_quantity_unit,nutriments,image_front_small_url";
  const TIMEOUT_MS = 10000;
  const RATE_MAX = 10, RATE_WINDOW = 60000;   // OFF erlaubt 15/Min – wir bleiben darunter
  const FORMATS = ["ean_13", "ean_8", "upc_a"];

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const LABEL = { kcal: "Kalorien", p: "Eiweiß", c: "Kohlenhydrate", f: "Fett", sugar: "davon Zucker", fiber: "Ballaststoffe", salt: "Salz" };
  const UNIT = { kcal: "kcal", p: "g", c: "g", f: "g", sugar: "g", fiber: "g", salt: "g" };

  let db = null;
  const st = { view: "idle", code: null, prod: null, unitKey: "base", prepared: false, busy: false, stream: null, timer: null, lastHit: null, hits: 0, reqTimes: [], adding: false, editFor: null };

  /* ---------- Gerüst ---------- */
  function sheetHTML() {
    return `<div id="scanSheet" hidden role="dialog" aria-modal="true" aria-labelledby="scanTitle">
  <div class="sc-sheet">
    <div class="sc-head"><b id="scanTitle">Barcode scannen</b><button type="button" class="sc-x" data-act="close" aria-label="Schließen">✕</button></div>
    <div id="scanBody" class="sc-body" aria-live="polite"></div>
    <div id="scanFoot" class="sc-foot"></div>
  </div>
  <input type="file" id="scanPhoto" accept="image/*" capture="environment" hidden>
</div>`;
  }

  function setView(view, body, foot, title) {
    st.view = view;
    $("scanTitle").textContent = title || "Barcode scannen";
    $("scanBody").innerHTML = body;
    $("scanFoot").innerHTML = foot || "";
  }
  const btn = (act, label, cls) => `<button type="button" class="sc-btn ${cls || ""}" data-act="${act}">${label}</button>`;
  const cancelRow = (extra) => `<div class="sc-row">${extra || ""}${btn("close", "Abbrechen", "ghost")}</div>`;

  function open() {
    $("scanSheet").hidden = false; document.body.style.overflow = "hidden";
    startCamera();
  }
  function close() {
    stopCamera();
    $("scanSheet").hidden = true; document.body.style.overflow = "";
    st.view = "idle"; st.busy = false; st.adding = false; st.code = null; st.prod = null;
  }

  /* ---------- Kamera ---------- */
  let detectorP = null;
  function getDetector() {
    if (detectorP) return detectorP;
    detectorP = (async () => {
      try {
        if ("BarcodeDetector" in window) {
          const f = await window.BarcodeDetector.getSupportedFormats();
          if (f.includes("ean_13") && f.includes("ean_8")) return new window.BarcodeDetector({ formats: FORMATS });
        }
      } catch (_) {}
      const API = window.BarcodeDetectionAPI;
      if (!API) throw new Error("scanner_missing");
      // WASM-Datei liegt in der App selbst (funktioniert offline, kein fremder Server).
      API.setZXingModuleOverrides({ locateFile: (p, prefix) => (p.endsWith(".wasm") ? new URL(p, document.baseURI).href : prefix + p) });
      return new API.BarcodeDetector({ formats: FORMATS });
    })();
    detectorP.catch(() => { detectorP = null; });
    return detectorP;
  }

  function camView(status) {
    setView("cam",
      `<div class="sc-cam"><video id="scanVideo" playsinline muted autoplay></video><div class="sc-frame" aria-hidden="true"></div></div>
       <p class="sc-status" id="scanStatus">${status || "Kamera wird gestartet …"}</p>`,
      `<div class="sc-row">${btn("photo", "Foto aufnehmen", "ghost")}${btn("manual", "Nummer eintippen", "ghost")}</div>${cancelRow()}`);
  }

  async function startCamera() {
    st.hits = 0; st.lastHit = null; st.busy = false;
    camView();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return camProblem("nocam");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } } });
      if (st.view !== "cam") { stream.getTracks().forEach((t) => t.stop()); return; } // inzwischen geschlossen
      st.stream = stream;
      const v = $("scanVideo"); v.srcObject = stream; await v.play().catch(() => {});
      $("scanStatus").textContent = "Barcode in den Rahmen halten";
      getDetector().catch(() => { $("scanStatus").textContent = "Scanner konnte nicht geladen werden. Nutze „Nummer eintippen“."; });
      loop();
    } catch (e) {
      const n = e && e.name;
      camProblem(n === "NotAllowedError" || n === "SecurityError" ? "denied" : n === "NotReadableError" ? "busy" : "nocam");
    }
  }

  function camProblem(kind) {
    stopCamera();
    const msg = {
      denied: `<b>Kein Zugriff auf die Kamera.</b><br>Du hast die Kamera abgelehnt oder sie ist gesperrt. So erlaubst du sie: <i>Einstellungen → Apps → Safari → Kamera → „Fragen“ oder „Erlauben“</i>. Danach die App schließen und neu öffnen.`,
      busy: `<b>Die Kamera ist gerade belegt.</b><br>Schließe andere Apps, die die Kamera nutzen, und versuch es nochmal.`,
      nocam: `<b>Live-Kamera nicht verfügbar.</b><br>Du kannst stattdessen ein Foto vom Barcode machen oder die Nummer eintippen.`,
      paused: `<b>Kamera pausiert.</b><br>Die App war im Hintergrund, deshalb wurde die Kamera ausgeschaltet.`
    }[kind];
    setView("camerr", `<div class="sc-msg">${msg}</div>`,
      `${kind !== "nocam" ? `<div class="sc-row">${btn("retrycam", "Kamera erneut versuchen", "ghost")}</div>` : ""}<div class="sc-row">${btn("photo", "Foto aufnehmen", "ghost")}${btn("manual", "Nummer eintippen", "ghost")}</div>${cancelRow()}`);
  }

  function stopCamera() {
    clearTimeout(st.timer); st.timer = null;
    if (st.stream) { st.stream.getTracks().forEach((t) => t.stop()); st.stream = null; }
    const v = $("scanVideo"); if (v) { try { v.pause(); } catch (_) {} v.srcObject = null; }
  }

  async function loop() {
    if (st.view !== "cam" || !st.stream) return;
    const v = $("scanVideo");
    try {
      if (v && v.readyState >= 2) {
        const det = await getDetector();
        const res = await det.detect(v);
        const hit = pickCode(res);
        if (hit) {
          // Zweimal hintereinander dieselbe Nummer = sicher gelesen. Danach sofort Kamera aus → keine Mehrfachtreffer.
          if (hit === st.lastHit) st.hits++; else { st.lastHit = hit; st.hits = 1; }
          if (st.hits >= 2 && st.view === "cam") { stopCamera(); return lookup(hit); }
        }
      }
    } catch (_) { /* einzelner Fehlversuch – weiter */ }
    if (st.view === "cam" && st.stream) st.timer = setTimeout(loop, 180);
  }

  function pickCode(results) {
    for (const r of results || []) {
      const c = N.cleanCode(r.rawValue);
      if ([8, 12, 13].includes(c.length) && N.eanValid(c)) return c;
    }
    return null;
  }

  async function fromPhoto(file) {
    if (!file) return;
    setView("loading", `<div class="sc-load"><span class="sc-spin" aria-hidden="true"></span>Foto wird ausgewertet …</div>`, cancelRow());
    try {
      const det = await getDetector();
      const img = await createImageBitmap(file);
      const code = pickCode(await det.detect(img));
      if (img.close) img.close();
      if (code) return lookup(code);
      setView("photofail", `<div class="sc-msg"><b>Kein Barcode erkannt.</b><br>Tipp: näher ran, Barcode gerade und scharf, gutes Licht, keine Spiegelung.</div>`,
        `<div class="sc-row">${btn("photo", "Neues Foto", "primary")}${btn("manual", "Nummer eintippen", "ghost")}</div>${cancelRow()}`);
    } catch (_) {
      setView("photofail", `<div class="sc-msg"><b>Das Foto konnte nicht gelesen werden.</b></div>`, `<div class="sc-row">${btn("manual", "Nummer eintippen", "primary")}</div>${cancelRow()}`);
    }
  }

  function manualView(prefill, err) {
    stopCamera();
    setView("manual",
      `<label class="sc-lbl" for="scanCode">Barcode-Nummer (unter den Strichen)</label>
       <input id="scanCode" class="sc-in" inputmode="numeric" autocomplete="off" placeholder="z. B. 4006381333931" value="${esc(prefill || "")}">
       ${err ? `<p class="sc-err">${err}</p>` : ""}`,
      `${btn("manualgo", "Suchen", "primary")}<div class="sc-row">${btn("rescan", "Doch scannen", "ghost")}${btn("close", "Abbrechen", "ghost")}</div>`);
    setTimeout(() => { const i = $("scanCode"); if (i) i.focus(); }, 50);
  }

  /* ---------- Suche ---------- */
  async function lookup(code, opts) {
    opts = opts || {};
    code = N.cleanCode(code);
    if (code.length < 6 || code.length > 14) return manualView(code, "Bitte 8 oder 13 Ziffern eingeben.");
    if ([8, 12, 13].includes(code.length) && !N.eanValid(code)) return manualView(code, "Die Prüfziffer passt nicht – vermutlich vertippt oder falsch gelesen.");
    if (st.busy) return;                  // läuft schon eine Suche → nichts doppelt
    st.busy = true; st.code = code;
    try {
      // 1. eigene Sammlung (offline, eigene Produkte/Korrekturen haben Vorrang)
      if (!opts.refresh && db) {
        const snap = await db.collection("products").doc(code).get();
        if (snap.exists) { st.busy = false; return productView(snap.data()); }
      }
      // 2. Open Food Facts
      if (!navigator.onLine) { st.busy = false; return netError("offline"); }
      const now = Date.now(); st.reqTimes = st.reqTimes.filter((t) => now - t < RATE_WINDOW);
      if (st.reqTimes.length >= RATE_MAX) { st.busy = false; return netError("rate"); }
      st.reqTimes.push(now);
      setView("loading", `<div class="sc-load"><span class="sc-spin" aria-hidden="true"></span>Suche Produkt <span class="mono">${esc(code)}</span> …</div>`, cancelRow());
      const r = await fetchOff(code);
      st.busy = false;
      if (st.view !== "loading") return;  // inzwischen abgebrochen
      if (r.kind === "found") {
        const fresh = N.normalizeOff(code, r.product);
        let prev = null;
        if (db) { const s = await db.collection("products").doc(code).get(); prev = s.exists ? s.data() : null; }
        if (prev && prev.custom) fresh.custom = prev.custom;            // Korrekturen bleiben
        if (prev && prev.source === "own") return productView(prev);   // eigenes Produkt nie überschreiben
        fresh.fetchedAt = new Date().toISOString();
        if (db) await db.collection("products").doc(code).set(fresh);
        return productView(fresh);
      }
      if (r.kind === "notfound") return notFound(code);
      return netError(r.kind, r.status);
    } catch (e) {
      st.busy = false;
      return netError("net");
    }
  }

  async function fetchOff(code) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(OFF_BASE + encodeURIComponent(code) + ".json?fields=" + OFF_FIELDS, { signal: ctrl.signal, headers: { Accept: "application/json" } });
      if (res.status === 404) return { kind: "notfound" };
      if (res.status === 429) return { kind: "rate", status: 429 };
      if (!res.ok) return { kind: "server", status: res.status };
      const body = await res.json();
      const found = body && body.product && (body.status === 1 || body.status === "success" || body.status === "success_with_warnings");
      if (found) return { kind: "found", product: body.product };
      if (body && (body.status === 0 || body.status === "failure")) return { kind: "notfound" };
      return { kind: "server", status: res.status };
    } catch (e) {
      return { kind: e && e.name === "AbortError" ? "timeout" : "net" };
    } finally { clearTimeout(t); }
  }

  function netError(kind, status) {
    const msg = {
      offline: "Du bist offline. Dieses Produkt ist noch nicht in deiner Sammlung gespeichert, deshalb kann es gerade nicht nachgeschlagen werden.",
      net: "Open Food Facts ist gerade nicht erreichbar (Verbindungsproblem). Das heißt <b>nicht</b>, dass das Produkt unbekannt ist.",
      timeout: "Open Food Facts antwortet gerade nicht (Zeitüberschreitung). Das Produkt ist deshalb nicht unbedingt unbekannt.",
      rate: "Zu viele Abfragen in kurzer Zeit. Bitte eine Minute warten und dann erneut versuchen.",
      server: "Open Food Facts hat einen Fehler gemeldet" + (status ? " (" + status + ")" : "") + ". Bitte später erneut versuchen."
    }[kind] || "Unbekannter Fehler.";
    setView("neterr", `<div class="sc-msg warn"><b>Keine Antwort von der Produktdatenbank</b><br>${msg}</div><p class="sc-code">Barcode: <span class="mono">${esc(st.code)}</span></p>`,
      `${btn("retry", "Erneut versuchen", "primary")}<div class="sc-row">${btn("create", "Selbst anlegen", "ghost")}${btn("rescan", "Erneut scannen", "ghost")}</div>${cancelRow()}`, "Nicht erreichbar");
  }

  function notFound(code) {
    setView("notfound", `<div class="sc-msg"><b>Produkt nicht gefunden</b><br>Open Food Facts kennt diesen Barcode nicht. Du kannst das Produkt selbst anlegen – mit den Werten von der Packung. Beim nächsten Scan wird es dann sofort erkannt.</div><p class="sc-code">Barcode: <span class="mono">${esc(code)}</span></p>`,
      `${btn("create", "Eigenes Produkt anlegen", "primary")}<div class="sc-row">${btn("rescan", "Erneut scannen", "ghost")}${btn("close", "Abbrechen", "ghost")}</div>`, "Nicht gefunden");
  }

  /* ---------- Produktansicht ---------- */
  function productView(prod, keepAmount) {
    st.prod = prod;
    const e = N.effective(prod);
    st.prepared = !e.per100 && !!e.prepared100 ? true : (keepAmount ? st.prepared : false);
    const opts = N.unitOptions(prod, st.prepared);
    if (!opts.find((o) => o.key === st.unitKey)) st.unitKey = opts.length ? opts[0].key : "base";
    const per = st.prepared ? e.prepared100 : e.per100;
    const bw = e.basis === "ml" ? "100 ml" : "100 g";
    const rows = (set) => ["kcal", "p", "c", "f", "sugar", "fiber", "salt"].map((k) => {
      const v = set ? set[k] : null; const main = N.KEYS.includes(k);
      if (!main && v == null) return "";
      return `<tr class="${main ? "" : "sub"}"><th>${LABEL[k]}</th><td class="${v == null ? "miss" : ""}">${v == null ? "fehlt" : N.fmt(v, k === "kcal" ? 0 : 1) + " " + UNIT[k]}</td></tr>`;
    }).join("");
    const warn = [];
    if (e.kcalFromKj) warn.push("Kalorien waren nur in kJ angegeben und wurden umgerechnet (1 kcal = 4,184 kJ).");
    if (!e.basisSure) warn.push("Unklar, ob sich die Werte auf 100 g oder 100 ml beziehen – angenommen: 100 g. Bei Getränken bitte unter „Werte korrigieren“ auf ml stellen.");
    if (per) { const miss = N.KEYS.filter((k) => per[k] == null).map((k) => LABEL[k]); if (miss.length) warn.push("Fehlende Angaben: " + miss.join(", ") + ". Sie zählen nicht als 0 – du kannst sie unter „Werte korrigieren“ ergänzen."); }
    if (!per && !e.perServing) warn.push("Für dieses Produkt sind keine Nährwerte hinterlegt. Bitte unter „Werte korrigieren“ von der Packung ergänzen.");
    if (!e.per100 && e.prepared100) warn.push("Es gibt nur Werte für das <b>zubereitete</b> Produkt.");
    const src = prod.source === "own" ? "Eigenes Produkt" : e.corrected ? "Open Food Facts · von dir korrigiert" : "Open Food Facts";
    const img = e.imageUrl && navigator.onLine ? `<img class="sc-img" src="${esc(e.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : "";
    const toggle = e.per100 && e.prepared100 ? `<div class="sc-seg" role="group" aria-label="Werte für">
        <button type="button" data-act="prep0" aria-pressed="${!st.prepared}">Wie verkauft</button><button type="button" data-act="prep1" aria-pressed="${st.prepared}">Zubereitet</button></div>` : "";
    const canCalc = opts.length > 0;
    setView("product",
      `<div class="sc-prod">${img}<div><div class="sc-name">${esc(e.name || "Ohne Namen")}</div><div class="sc-brand">${esc(e.brand || "")}</div><div class="sc-src">${src} · <span class="mono">${esc(e.code)}</span></div></div></div>
       ${toggle}
       <table class="sc-tbl"><caption>${per ? "pro " + bw + (st.prepared ? " (zubereitet)" : "") : e.perServing ? "pro Portion" + (e.servingLabel ? " (" + esc(e.servingLabel) + ")" : "") : "Nährwerte"}</caption>${rows(per || e.perServing)}</table>
       ${warn.map((w) => `<p class="sc-warn">${w}</p>`).join("")}
       ${canCalc ? `<div class="sc-amount">
         <label class="sc-lbl" for="scanAmt">Wie viel hast du gegessen?</label>
         <div class="sc-amt-row"><input id="scanAmt" class="sc-in" inputmode="decimal" autocomplete="off" placeholder="${st.unitKey === "base" ? "z. B. 150" : "z. B. 1"}" value="${keepAmount ? esc($("scanAmt") ? $("scanAmt").value : "") : ""}">
         <div class="sc-seg" role="group" aria-label="Einheit">${opts.map((o) => `<button type="button" data-unit="${o.key}" aria-pressed="${o.key === st.unitKey}">${esc(o.label)}</button>`).join("")}</div></div>
         <div id="scanCalc" class="sc-calc"></div></div>` : ""}
       <p class="sc-attr">${prod.source === "own" ? "" : "Daten: Open Food Facts (ODbL), Bild: CC BY-SA. "}Werte vor dem Übernehmen kurz mit der Packung vergleichen.</p>`,
      `${canCalc ? btn("add", "Übernehmen", "primary") : ""}<div class="sc-row">${btn("edit", "Werte korrigieren", "ghost")}${btn("rescan", "Erneut scannen", "ghost")}</div>${cancelRow(prod.source !== "own" ? btn("refresh", "Daten neu laden", "ghost small") : "")}`,
      "Produkt prüfen");
    updateCalc();
  }

  function currentAmount() { const i = $("scanAmt"); return i ? N.parseNum(i.value) : null; }

  function updateCalc() {
    const box = $("scanCalc"); if (!box || !st.prod) return;
    const amt = currentAmount(); const addBtn = document.querySelector('#scanFoot [data-act="add"]');
    if (amt == null) { box.innerHTML = `<span class="muted">Menge eingeben – die Werte werden sofort berechnet.</span>`; if (addBtn) addBtn.disabled = true; return; }
    const r = N.calc(st.prod, st.unitKey, amt, st.prepared);
    if (!r.ok) { box.innerHTML = `<span class="sc-err">${r.error}</span>`; if (addBtn) addBtn.disabled = true; return; }
    const day = window.__food ? window.__food.dateLabel() : "";
    box.innerHTML = `<div class="sc-res">${["kcal", "p", "c", "f"].map((k) => `<div><b class="${r.values[k] == null ? "miss" : ""}">${r.values[k] == null ? "fehlt" : N.fmt(r.values[k], k === "kcal" ? 0 : 1)}</b><span>${{kcal:"kcal",p:"Eiweiß g",c:"KH g",f:"Fett g"}[k]}</span></div>`).join("")}</div>
      <span class="muted">${r.qty != null ? "= " + N.fmtQty(r.qty) + " " + r.unit + " · " : ""}wird ${esc(day)} hinzugefügt</span>`;
    if (addBtn) addBtn.disabled = false;
  }

  async function add() {
    if (st.adding) return;               // Doppeltippen → nur ein Eintrag
    const amt = currentAmount();
    const res = N.makeEntry(st.prod, st.unitKey, amt, st.prepared);
    if (!res.ok) return updateCalc();
    st.adding = true;
    const b = document.querySelector('#scanFoot [data-act="add"]'); if (b) { b.disabled = true; b.textContent = "Wird gespeichert …"; }
    try {
      await window.__food.add(res.entry);
      // Zuletzt verwendete Menge am Produkt merken (verändert keine alten Einträge)
      if (db) await db.collection("products").doc(st.prod.code).update({ lastUsed: { unitKey: st.unitKey, amount: amt, prepared: st.prepared, at: new Date().toISOString() } }).catch(() => {});
      close();
      window.__food.toast("Hinzugefügt: " + res.entry.name + " – " + (res.entry.kcal == null ? "kcal fehlen" : Math.round(res.entry.kcal) + " kcal"));
    } catch (_) {
      st.adding = false; if (b) { b.disabled = false; b.textContent = "Übernehmen"; }
      $("scanCalc").insertAdjacentHTML("beforeend", `<p class="sc-err">Speichern hat nicht geklappt – bitte nochmal tippen.</p>`);
    }
  }

  /* ---------- Eigenes Produkt / Korrektur ---------- */
  function editView(forNew) {
    const p = forNew ? null : st.prod; const e = p ? N.effective(p) : null;
    const per = e ? (e.per100 || {}) : {};
    const basis = e ? e.basis : "g";
    st.editFor = forNew ? "new" : "fix";
    const f = (id, label, v, hint) => `<label class="sc-f"><span>${label}</span><input id="${id}" class="sc-in" inputmode="decimal" autocomplete="off" value="${v == null ? "" : esc(String(N.r1(v)).replace(".", ","))}" placeholder="${hint || "fehlt"}"></label>`;
    setView("edit",
      `<p class="sc-code">Barcode: <span class="mono">${esc(st.code)}</span></p>
       <label class="sc-f wide"><span>Name</span><input id="ed-name" class="sc-in" autocomplete="off" value="${esc(e ? e.name || "" : "")}" placeholder="z. B. Skyr Natur"></label>
       <label class="sc-f wide"><span>Marke (optional)</span><input id="ed-brand" class="sc-in" autocomplete="off" value="${esc(e ? e.brand || "" : "")}"></label>
       <div class="sc-lbl">Werte auf der Packung gelten pro</div>
       <div class="sc-seg" role="group" aria-label="Bezugsmenge" id="ed-basis"><button type="button" data-basis="g" aria-pressed="${basis === "g"}">100 g</button><button type="button" data-basis="ml" aria-pressed="${basis === "ml"}">100 ml</button></div>
       <div class="sc-grid">${f("ed-kcal", "Kalorien (kcal)", per.kcal)}${f("ed-p", "Eiweiß (g)", per.p)}${f("ed-c", "Kohlenhydrate (g)", per.c)}${f("ed-f", "Fett (g)", per.f)}</div>
       <p class="muted small">Nur kJ auf der Packung? Teile durch 4,184. Leere Felder bleiben „fehlt“.</p>
       <div class="sc-grid">${f("ed-serv", "Portion (g/ml, optional)", e ? e.servingQty : null, "z. B. 30")}${f("ed-pack", "Packung (g/ml, optional)", e ? e.packQty : null, "z. B. 500")}</div>
       <p id="ed-err" class="sc-err" hidden></p>`,
      `${btn("save", forNew ? "Produkt speichern" : "Korrektur speichern", "primary")}${cancelRow(btn("back", "Zurück", "ghost"))}`,
      forNew ? "Eigenes Produkt" : "Werte korrigieren");
  }

  async function saveEdit() {
    const g = (id) => ($(id).value || "").trim();
    const nums = {}; let bad = null;
    [["kcal", "ed-kcal"], ["p", "ed-p"], ["c", "ed-c"], ["f", "ed-f"], ["servingQty", "ed-serv"], ["packQty", "ed-pack"]].forEach(([k, id]) => {
      const raw = g(id); if (raw === "") { nums[k] = null; return; }
      const n = N.parseNum(raw); if (n == null || n < 0 || n > (k === "kcal" ? 1000 : k.endsWith("Qty") ? 10000 : 100)) bad = bad || id; nums[k] = n;
    });
    const name = g("ed-name");
    const basis = document.querySelector('#ed-basis [aria-pressed="true"]').dataset.basis;
    const err = $("ed-err");
    if (!name) { err.hidden = false; err.textContent = "Bitte einen Namen eingeben."; return; }
    if (bad) { err.hidden = false; err.textContent = "Ein Wert ist ungültig (pro 100 g: max. 100 g Nährstoff bzw. 1000 kcal)."; $(bad).focus(); return; }
    if (nums.kcal == null && nums.p == null) { err.hidden = false; err.textContent = "Bitte mindestens Kalorien oder Eiweiß eintragen."; return; }
    const per100 = { kcal: nums.kcal, p: nums.p, c: nums.c, f: nums.f };
    let prod;
    if (st.editFor === "new" || (st.prod && st.prod.source === "own")) {
      prod = { code: st.code, name, brand: g("ed-brand") || null, basis, basisSure: true, per100, perServing: null, prepared100: null,
        kcalFromKj: false, servingQty: nums.servingQty, packQty: nums.packQty, source: "own", createdAt: (st.prod && st.prod.createdAt) || new Date().toISOString(), updatedAt: new Date().toISOString() };
    } else {
      // Korrektur: nur Abweichungen von den Open-Food-Facts-Werten speichern
      const base = Object.assign({}, st.prod); delete base.custom;
      const e0 = N.effective(base); const custom = {}; const cp = {};
      ["kcal", "p", "c", "f"].forEach((k) => { const o = e0.per100 ? e0.per100[k] : null; if (per100[k] !== (o == null ? null : N.r1(o))) cp[k] = per100[k]; });
      if (Object.keys(cp).length) custom.per100 = cp;
      if (name !== (e0.name || "")) custom.name = name;
      const br = g("ed-brand") || null; if (br !== (e0.brand || null)) custom.brand = br;
      if (basis !== e0.basis || !e0.basisSure) custom.basis = basis;
      if (nums.servingQty !== (e0.servingQty == null ? null : N.r1(e0.servingQty))) custom.servingQty = nums.servingQty;
      if (nums.packQty !== (e0.packQty == null ? null : N.r1(e0.packQty))) custom.packQty = nums.packQty;
      prod = Object.assign({}, base, { custom: Object.keys(custom).length ? Object.assign({ at: new Date().toISOString() }, custom) : null, updatedAt: new Date().toISOString() });
      if (!prod.custom) delete prod.custom;
    }
    if (db) await db.collection("products").doc(st.code).set(prod);
    productView(prod);
    window.__food.toast(st.editFor === "new" ? "Produkt gespeichert – beim nächsten Scan sofort da" : "Korrektur gespeichert");
  }

  /* ---------- Ereignisse ---------- */
  function onClick(ev) {
    const t = ev.target.closest("[data-act],[data-unit],[data-basis]"); if (!t) { if (ev.target.id === "scanSheet") close(); return; }
    if (t.dataset.unit) { st.unitKey = t.dataset.unit; productView(st.prod, true); return; }
    if (t.dataset.basis) { document.querySelectorAll("#ed-basis button").forEach((b) => b.setAttribute("aria-pressed", String(b === t))); return; }
    const a = t.dataset.act;
    if (a === "close") close();
    else if (a === "photo") { stopCamera(); $("scanPhoto").value = ""; $("scanPhoto").click(); }
    else if (a === "manual") manualView();
    else if (a === "manualgo") lookup($("scanCode").value);
    else if (a === "rescan" || a === "retrycam") { st.busy = false; startCamera(); }
    else if (a === "retry") { st.busy = false; lookup(st.code); }
    else if (a === "refresh") { st.busy = false; lookup(st.code, { refresh: true }); }
    else if (a === "create") editView(true);
    else if (a === "edit") editView(false);
    else if (a === "back") { if (st.prod) productView(st.prod); else notFound(st.code); }
    else if (a === "save") saveEdit().catch(() => { const e = $("ed-err"); e.hidden = false; e.textContent = "Speichern hat nicht geklappt."; });
    else if (a === "add") add();
    else if (a === "prep0" || a === "prep1") { st.prepared = a === "prep1"; productView(st.prod, true); }
  }

  /* Von außen: Produkt aus „Zuletzt hinzugefügt“ öffnen (ohne Internet). */
  async function openProduct(code) {
    $("scanSheet").hidden = false; document.body.style.overflow = "hidden";
    st.code = String(code); st.busy = false; st.adding = false;
    const snap = db ? await db.collection("products").doc(st.code).get() : null;
    if (snap && snap.exists) {
      const p = snap.data();
      if (p.lastUsed) { st.unitKey = p.lastUsed.unitKey; st.prepared = !!p.lastUsed.prepared; }
      productView(p);
      if (p.lastUsed && $("scanAmt")) { $("scanAmt").value = String(p.lastUsed.amount).replace(".", ","); st.prepared = !!p.lastUsed.prepared; st.unitKey = p.lastUsed.unitKey; productView(p, true); }
    } else lookup(st.code);
  }

  function init() {
    document.body.insertAdjacentHTML("beforeend", sheetHTML());
    const sheet = $("scanSheet");
    sheet.addEventListener("click", onClick);
    sheet.addEventListener("input", (e) => { if (e.target.id === "scanAmt") updateCalc(); });
    sheet.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.id === "scanCode") lookup(e.target.value);
      if (e.key === "Enter" && e.target.id === "scanAmt") add();
      if (e.key === "Escape") close();
    });
    $("scanPhoto").addEventListener("change", (e) => fromPhoto(e.target.files && e.target.files[0]));
    // Kamera freigeben, sobald die App in den Hintergrund geht
    document.addEventListener("visibilitychange", () => { if (document.hidden && st.stream) { stopCamera(); if (st.view === "cam") camProblem("paused"); } });
    window.addEventListener("pagehide", stopCamera);
    window.claude.use("db").then((d) => { db = d; });
  }

  window.Scanner = { init, open, close, openProduct, lookup, _state: st };
})();
