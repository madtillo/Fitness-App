/* Foto-Tracking für Mahlzeiten.
   Ablauf: Foto wählen → Vorschau → (erst nach Tippen) Analyse bei Google Gemini → Prüfen/Korrigieren → Speichern.
   - Der API-Schlüssel liegt nur auf diesem Gerät (IndexedDB, Sammlung "settings"), nie im Code und nicht in Sicherungen.
   - Gesendet wird nur ein verkleinertes JPEG ohne Metadaten + der Auftragstext. Das Foto wird nicht gespeichert.
   - Nährwerte pro 100 g kommen aus der BLS-Datenbank (bls.js), KI-Richtwerte nur als gekennzeichneter Ersatz. */
(function () {
  "use strict";
  const N = window.Nutri;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const API = "https://generativelanguage.googleapis.com/v1beta/models/";
  const DEFAULT_MODEL = "gemini-3.8-flash", FALLBACK_MODEL = "gemini-3.5-flash-lite";
  const TIMEOUT_MS = 45000, MAX_EDGE = 1280, MAX_FILE = 30 * 1024 * 1024, DEFAULT_DAILY = 25;
  const CATS = [["fruehstueck", "Frühstück"], ["mittag", "Mittag"], ["abend", "Abend"], ["snack", "Snack"]];
  const FRACTIONS = [[1, "Alles"], [0.75, "¾"], [0.5, "½"], [0.25, "¼"]];

  let db = null, cfg = null, blsP = null;
  const st = { view: "idle", blob: null, url: null, busy: false, meal: null, editing: null, answered: {}, saving: false, ctrl: null };

  /* ---------- Einstellungen ---------- */
  async function loadCfg() {
    if (cfg) return cfg;
    const s = db ? await db.collection("settings").doc("ai").get() : null;
    cfg = Object.assign({ workerUrl: "", appToken: "", model: DEFAULT_MODEL, dailyLimit: DEFAULT_DAILY, usage: { date: "", count: 0 } }, s && s.exists ? s.data() : {});
    return cfg;
  }
  async function saveCfg(patch) { cfg = Object.assign(await loadCfg(), patch); if (db) await db.collection("settings").doc("ai").set(cfg); }
  const today = () => { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()); };

  /* ---------- Nährwert-Datenbank (BLS) – wird erst bei Bedarf geladen ---------- */
  function loadBLS() {
    if (window.BLS) return Promise.resolve(window.BLS);
    if (blsP) return blsP;
    blsP = new Promise((res) => {
      const s = document.createElement("script"); s.src = "bls.js"; s.async = true;
      s.onload = () => res(window.BLS || null); s.onerror = () => { blsP = null; res(null); };
      document.head.appendChild(s);
    });
    return blsP;
  }

  /* ---------- Gerüst ---------- */
  function shell() {
    return `<div id="photoSheet" hidden role="dialog" aria-modal="true" aria-labelledby="phTitle"><div class="sc-sheet">
  <div class="sc-head"><b id="phTitle">Mahlzeit fotografieren</b><button type="button" class="sc-x" data-ph="close" aria-label="Schließen">✕</button></div>
  <div id="phBody" class="sc-body ph-body" aria-live="polite"></div><div id="phFoot" class="sc-foot"></div></div>
  <input type="file" id="phCam" accept="image/*" capture="environment" hidden><input type="file" id="phLib" accept="image/*" hidden></div>`;
  }
  const btn = (act, label, cls, extra) => `<button type="button" class="sc-btn ${cls || ""}" data-ph="${act}" ${extra || ""}>${label}</button>`;
  function view(name, body, foot, title) { st.view = name; $("phTitle").textContent = title || "Mahlzeit fotografieren"; $("phBody").innerHTML = body; $("phFoot").innerHTML = foot || ""; $("phBody").scrollTop = 0; }

  async function open(editEntry, editDate) {
    $("photoSheet").hidden = false; document.body.style.overflow = "hidden";
    await loadCfg();
    if (editEntry) { st.editing = { date: editDate, mealId: editEntry.mealId }; return editView(editEntry, editDate); }
    st.editing = null;
    if (!cfg.workerUrl || !cfg.appToken) return keyView();
    pickView();
  }
  function close() {
    if (st.ctrl) { try { st.ctrl.abort(); } catch (_) {} }
    $("photoSheet").hidden = true; document.body.style.overflow = "";
    dropPhoto(); st.meal = null; st.busy = false; st.saving = false; st.editing = null; st.view = "idle";
  }
  function dropPhoto() { if (st.url) URL.revokeObjectURL(st.url); st.url = null; st.blob = null; }

  /* ---------- Verbindung zum eigenen Cloudflare Worker einrichten ----------
     Der Gemini-Schlüssel liegt nur im Worker. Die App kennt nur die Worker-Adresse und ein App-Passwort. */
  function newToken() { const a = new Uint8Array(30); crypto.getRandomValues(a); return Array.from(a, (b) => "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"[b % 57]).join(""); }
  function keyView(msg, vals) {
    vals = vals || { url: cfg.workerUrl || cfg.draftUrl || "", token: cfg.appToken || cfg.draftToken || "" };
    view("key", `<div class="sc-msg"><b>Verbindung zur Fotoanalyse</b><br>Die App spricht mit deinem eigenen Cloudflare Worker. Der Gemini-Schlüssel liegt nur dort. Hier stehen nur die Worker-Adresse und dein App-Passwort – beides nur auf diesem iPhone, nicht in Sicherungen.</div>
      <label class="sc-lbl" for="phUrl">Worker-Adresse</label>
      <input id="phUrl" class="sc-in" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://fitness-ki.….workers.dev" value="${esc(vals.url)}">
      <label class="sc-lbl" for="phTok">App-Passwort (APP_TOKEN)</label>
      <input id="phTok" class="sc-in mono" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="mind. 24 Zeichen" value="${esc(vals.token)}">
      <div class="sc-row">${btn("gentok", "Neues Passwort erzeugen", "ghost small")}${btn("copytok", "Passwort kopieren", "ghost small")}</div>
      <p class="muted small" style="margin:0">Dasselbe Passwort trägst du im Worker als geheime Variable <b>APP_TOKEN</b> ein.</p>
      ${msg ? `<p class="sc-err">${msg}</p>` : ""}`,
      `${btn("savekey", "Verbindung prüfen und speichern", "primary")}<div class="sc-row">${btn("close", "Abbrechen", "ghost")}</div>`, "Fotoanalyse einrichten");
  }
  const curVals = () => ({ url: ($("phUrl").value || "").trim().replace(/\/+$/, ""), token: ($("phTok").value || "").trim() });
  async function saveKey() {
    const v = curVals();
    if (!/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(v.url) && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(v.url)) return keyView("Bitte die vollständige Worker-Adresse eintragen (beginnt mit https://).", v);
    if (v.token.length < 24) return keyView("Das App-Passwort muss mindestens 24 Zeichen lang sein. Tipp: „Neues Passwort erzeugen“.", v);
    view("loading", `<div class="sc-load"><span class="sc-spin" aria-hidden="true"></span>Verbindung wird geprüft …</div>`, "");
    try {
      const r = await fetchT(v.url + "/check", { headers: { "X-App-Token": v.token } }, 15000);
      let j = null; try { j = await r.json(); } catch (_) {}
      if (r.status === 401) return keyView("Der Worker kennt dieses App-Passwort nicht. Ist es im Worker als APP_TOKEN gespeichert (und danach „Bereitstellen“)?", v);
      if (r.status === 403) return keyView("Der Worker lehnt diese App-Adresse ab. Steht im Worker-Code ALLOWED_ORIGIN = \"https://madtillo.github.io\"?", v);
      if (r.status === 500 && j && j.error === "not_configured") return keyView("Im Worker fehlen noch die geheimen Variablen GEMINI_API_KEY und/oder APP_TOKEN.", v);
      if (r.status === 502) return keyView("Der Worker läuft, aber Google lehnt den Gemini-Schlüssel ab (" + esc(j && j.gemini) + "). Bitte GEMINI_API_KEY im Worker prüfen.", v);
      if (!r.ok) return keyView("Unerwartete Antwort vom Worker (" + r.status + ").", v);
    } catch (_) { return keyView(navigator.onLine ? "Der Worker ist nicht erreichbar. Stimmt die Adresse, und ist er bereitgestellt?" : "Du bist offline.", v); }
    await saveCfg({ workerUrl: v.url, appToken: v.token, apiKey: undefined, draftToken: undefined, draftUrl: undefined });
    window.appToast && window.appToast("Verbindung gespeichert");
    pickView();
  }

  /* ---------- Foto wählen + Vorschau ---------- */
  function pickView(msg) {
    dropPhoto();
    view("pick", `${msg ? `<div class="sc-msg warn">${msg}</div>` : ""}
      <p class="muted" style="margin:0">Fotografiere den Teller möglichst von schräg oben, mit allem drauf. Das Foto wird erst analysiert, wenn du auf „Analysieren“ tippst.</p>
      <div class="ph-pick">${btn("cam", "📷 Foto aufnehmen", "primary")}${btn("lib", "🖼️ Aus Galerie wählen", "")}</div>`,
      `<div class="sc-row">${btn("manual", "Lieber manuell eintragen", "ghost")}${btn("close", "Abbrechen", "ghost")}</div>`);
  }

  async function onFile(file) {
    if (!file) return;
    if (file.size > MAX_FILE) return pickView("Das Foto ist zu groß (max. 30 MB).");
    view("loading", `<div class="sc-load"><span class="sc-spin" aria-hidden="true"></span>Foto wird vorbereitet …</div>`, "");
    try {
      st.blob = await shrink(file);
      st.url = URL.createObjectURL(st.blob);
      previewView();
    } catch (_) {
      pickView("Dieses Bildformat kann nicht gelesen werden. Bitte ein normales Foto (JPEG/HEIC/PNG) wählen.");
    }
  }

  /* Verkleinern auf max. 1280 px, Ausrichtung übernehmen, als JPEG neu speichern (entfernt Standort- und Kameradaten). */
  async function shrink(file) {
    let src, w, h;
    try { src = await createImageBitmap(file, { imageOrientation: "from-image" }); w = src.width; h = src.height; }
    catch (_) {
      src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
      w = src.naturalWidth; h = src.naturalHeight;
    }
    if (!w || !h) throw new Error("decode");
    const s = Math.min(1, MAX_EDGE / Math.max(w, h));
    const c = document.createElement("canvas"); c.width = Math.round(w * s); c.height = Math.round(h * s);
    c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
    if (src.close) src.close();
    const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.82));
    if (!blob) throw new Error("encode");
    return blob;
  }

  function previewView() {
    view("preview", `<img class="ph-prev" src="${st.url}" alt="Vorschau der Mahlzeit">
      <p class="muted small" style="margin:0">Beim Analysieren wird dieses verkleinerte Foto über deinen Worker an Google Gemini geschickt. Gespeichert wird es nicht.</p>`,
      `${btn("analyze", "Analysieren", "primary")}<div class="sc-row">${btn("replace", "Anderes Foto", "ghost")}${btn("close", "Abbrechen", "ghost")}</div>`, "Vorschau");
  }

  /* ---------- Analyse ---------- */
  const PROMPT = `Du bist ein Ernährungsassistent. Analysiere das Foto einer Mahlzeit.
Regeln:
- Liste jeden sichtbaren Bestandteil einzeln auf (deutscher, allgemeiner Lebensmittelname, z. B. "Reis", "Hähnchenbrust", "Brokkoli").
- Schätze die Menge in Gramm (grams_estimate) und eine realistische Spanne (grams_min, grams_max). Es sind Schätzungen – keine Scheingenauigkeit, runde auf 5 oder 10 g.
- state: "roh", "gegart" (gekocht/gebraten/gebacken) oder "zubereitet" (fertige Mischung), sonst "unbekannt". Mengen beziehen sich immer auf den Zustand auf dem Teller.
- search_terms: 2–4 Suchwörter in der Schreibweise des Bundeslebensmittelschlüssels (Grundlebensmittel zuerst, dann Teil/Zustand), z. B. ["Reis", "gekocht"], ["Teigwaren", "gekocht"], ["Broccoli", "gedünstet"], ["Rind", "Hackfleisch", "gebraten"], ["Hähnchen", "Brust", "gebraten"].
- Gib pro Bestandteil Richtwerte pro 100 g im Zustand auf dem Teller an (kcal_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g).
- confidence: "hoch", "mittel" oder "niedrig". visible=false für Dinge, die du nur vermutest.
- Nicht sichtbare Zutaten (Öl, Butter, Zucker, Zusammensetzung einer Sauce) NICHT als sicher auflisten. Wenn sie das Ergebnis deutlich beeinflussen (mehr als ca. 80 kcal), stelle dazu maximal 3 kurze Fragen mit 2–4 Antwortoptionen; eine Option darf mit add_item eine Zutat mit Gramm und Richtwerten pro 100 g hinzufügen.
- Wenn kein Essen erkennbar ist: is_food=false und message mit kurzer Begründung auf Deutsch.
Antworte nur mit JSON nach dem Schema.`;
  const NUM = { type: "NUMBER" }, S = { type: "STRING" };
  const SCHEMA = {
    type: "OBJECT", required: ["is_food", "items"],
    properties: {
      is_food: { type: "BOOLEAN" }, dish: S, message: S,
      items: { type: "ARRAY", items: { type: "OBJECT", required: ["name", "state", "grams_estimate", "confidence"], properties: {
        name: S, state: { type: "STRING", enum: ["roh", "gegart", "zubereitet", "unbekannt"] }, grams_estimate: NUM, grams_min: NUM, grams_max: NUM,
        confidence: { type: "STRING", enum: ["hoch", "mittel", "niedrig"] }, visible: { type: "BOOLEAN" }, search_terms: { type: "ARRAY", items: S },
        kcal_per_100g: NUM, protein_per_100g: NUM, carbs_per_100g: NUM, fat_per_100g: NUM } } },
      questions: { type: "ARRAY", items: { type: "OBJECT", required: ["text", "options"], properties: {
        text: S, options: { type: "ARRAY", items: { type: "OBJECT", required: ["label"], properties: {
          label: S, add_item: { type: "OBJECT", properties: { name: S, grams: NUM, kcal_per_100g: NUM, protein_per_100g: NUM, carbs_per_100g: NUM, fat_per_100g: NUM } } } } } } } }
    }
  };

  function fetchT(url, opts, ms) {
    const ctrl = new AbortController(); st.ctrl = ctrl;
    const t = setTimeout(() => ctrl.abort(), ms || TIMEOUT_MS);
    return fetch(url, Object.assign({}, opts, { signal: ctrl.signal })).finally(() => clearTimeout(t));
  }
  const b64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(blob); });

  async function callGemini(model, data) {
    const body = { contents: [{ role: "user", parts: [{ text: PROMPT }, { inlineData: { mimeType: "image/jpeg", data } }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA, temperature: 0.2 } };
    const r = await fetchT(cfg.workerUrl + "/analyze", { method: "POST", headers: { "Content-Type": "application/json", "X-App-Token": cfg.appToken }, body: JSON.stringify({ model, request: body }) });
    let j = null; try { j = await r.json(); } catch (_) {}
    if (!r.ok) return { err: r.status, detail: j && (j.error && j.error.status || j.error) };
    if (j && j.promptFeedback && j.promptFeedback.blockReason) return { err: "blocked" };
    const cand = j && j.candidates && j.candidates[0];
    const text = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts.map((p) => p.text || "").join("") : "";
    if (!text) return { err: cand && cand.finishReason === "SAFETY" ? "blocked" : "empty" };
    return { text };
  }

  async function analyze() {
    if (st.busy || !st.blob) return;           // kein Doppel-Tippen
    st.busy = true;
    await loadCfg();
    const d = today(); const usage = cfg.usage && cfg.usage.date === d ? cfg.usage : { date: d, count: 0 };
    if (usage.count >= (cfg.dailyLimit || DEFAULT_DAILY)) { st.busy = false; return errorView("Tageslimit erreicht (" + (cfg.dailyLimit || DEFAULT_DAILY) + " Analysen). Morgen geht es wieder – oder trag die Mahlzeit manuell ein."); }
    if (!navigator.onLine) { st.busy = false; return errorView("Du bist offline. Die Fotoanalyse braucht Internet – manuelle Eingabe und Barcode-Scanner funktionieren weiterhin."); }
    view("analyzing", `<img class="ph-prev dim" src="${st.url}" alt=""><div class="sc-load"><span class="sc-spin" aria-hidden="true"></span>Mahlzeit wird analysiert … (meist 5–15 s)</div>`, btn("close", "Abbrechen", "ghost"), "Analyse läuft");
    const blsLoad = loadBLS();
    try {
      const data = await b64(st.blob);
      await saveCfg({ usage: { date: d, count: usage.count + 1 } });
      let r = await callGemini(cfg.model || DEFAULT_MODEL, data);
      if ((r.err === 404 || r.err === 429 || r.err === 503) && (cfg.model || DEFAULT_MODEL) !== FALLBACK_MODEL) r = await callGemini(FALLBACK_MODEL, data);
      st.busy = false;
      if (st.view !== "analyzing") return;     // inzwischen abgebrochen
      if (r.err) return errorView(errText(r.err, r.detail), r.err === 400 || r.err === 401 || r.err === 403 || r.err === 500);
      const v = N.mealValidate(r.text);
      if (!v.ok) return errorView(v.error + " Bitte nochmal versuchen.");
      if (!v.isFood) return errorView((v.message ? esc(v.message) + "<br>" : "") + "Es wurde kein Essen erkannt. Mach ein neues Foto oder trag die Mahlzeit manuell ein.", false, true);
      const bls = await blsLoad;
      st.answered = {};
      st.meal = { mealId: "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), dish: v.dish, items: v.items.map((it) => matchItem(it, bls)), questions: v.questions,
        fraction: 1, cat: guessCat(), date: window.__food ? window.__food.date() : today() };
      dropPhoto();                              // Foto wird nicht mehr gebraucht
      reviewView();
    } catch (e) {
      st.busy = false;
      if (st.view !== "analyzing") return;
      errorView(e && e.name === "AbortError" ? "Die Analyse hat zu lange gedauert (Zeitüberschreitung). Bitte nochmal versuchen." : "Keine Verbindung zu Google Gemini. Bitte nochmal versuchen.");
    }
  }
  function errText(code, detail) {
    if (code === 401) return "Der Worker hat das App-Passwort abgelehnt. Bitte die Verbindung neu einrichten.";
    if (code === 403 && detail === "origin") return "Der Worker lehnt diese App-Adresse ab.";
    if (code === 400 || code === 403) return "Google hat den Gemini-Schlüssel im Worker abgelehnt" + (detail ? " (" + esc(detail) + ")" : "") + ". Bitte GEMINI_API_KEY im Worker prüfen.";
    if (code === 500 && detail === "not_configured") return "Im Worker fehlen noch die geheimen Variablen.";
    if (code === 429) return "Das kostenlose Kontingent bei Google ist gerade ausgeschöpft. Bitte in einigen Minuten nochmal versuchen – oder manuell eintragen.";
    if (code === "blocked") return "Google hat die Analyse dieses Fotos abgelehnt. Bitte ein anderes Foto versuchen.";
    if (code === "empty") return "Google hat keine Antwort geliefert. Bitte nochmal versuchen.";
    if (code >= 500) return "Google Gemini ist gerade nicht erreichbar (" + code + "). Bitte später nochmal versuchen.";
    return "Die Analyse ist fehlgeschlagen (" + esc(code) + ").";
  }
  function errorView(msg, keyProblem, notFood) {
    view("error", `<div class="sc-msg warn">${msg}</div>`,
      `${st.blob && !notFood && !keyProblem ? btn("analyze", "Erneut versuchen", "primary") : btn("replace", "Neues Foto", "primary")}<div class="sc-row">${keyProblem ? btn("rekey", "Verbindung ändern", "ghost") : ""}${btn("manual", "Manuell eintragen", "ghost")}${btn("close", "Abbrechen", "ghost")}</div>`, notFood ? "Kein Essen erkannt" : "Analyse nicht möglich");
  }
  function guessCat() { const h = new Date().getHours(); return h < 11 ? "fruehstueck" : h < 15 ? "mittag" : h < 18 ? "snack" : "abend"; }

  /* Bestandteil → Nährwerte: zuerst BLS, sonst KI-Richtwert (gekennzeichnet). */
  function matchItem(it, bls) {
    const hit = bls ? N.foodSearch(bls, it.name, { state: it.state, terms: it.terms, limit: 1 })[0] : null;
    const base = { name: it.name, state: it.state, grams: it.grams, gramsMin: it.gramsMin, gramsMax: it.gramsMax, confidence: it.confidence, visible: it.visible, terms: it.terms, aiPer100: it.aiPer100 };
    if (hit) return Object.assign(base, { source: "bls", blsCode: hit[0], blsName: hit[1], per100: { kcal: hit[2], p: hit[3], f: hit[4], c: hit[5] } });
    return Object.assign(base, { source: it.aiPer100 ? "ki" : "fehlt", per100: it.aiPer100 || null });
  }

  /* ---------- Prüfen & Korrigieren ---------- */
  const SRC = { bls: "BLS-Datenbank", ki: "KI-Richtwert", manuell: "eigene Werte", fehlt: "Werte fehlen" };
  const f0 = (v) => (v == null ? "–" : N.fmt(v, 0)), f1 = (v) => (v == null ? "–" : N.fmt(v, 1));

  function reviewView() {
    const m = st.meal; const tot = N.mealTotals(m.items, m.fraction);
    const qs = (m.questions || []).filter((q) => !st.answered[q.id]);
    const body = `
      <div class="sc-msg small"><b>Alle Mengen sind Schätzungen aus dem Foto.</b> Bitte prüfen und bei Bedarf anpassen. Mengen gelten für den Zustand auf dem Teller (z. B. Reis gekocht, nicht roh).</div>
      ${qs.map((q) => `<div class="ph-q"><b>${esc(q.text)}</b><div class="sc-seg">${q.options.map((o, oi) => `<button type="button" data-q="${q.id}" data-o="${oi}">${esc(o.label)}</button>`).join("")}</div></div>`).join("")}
      <div class="ph-items">${m.items.map((it, i) => itemCard(it, i)).join("")}</div>
      ${btn("additem", "+ Zutat hinzufügen", "ghost")}
      <div class="ph-block"><div class="sc-lbl">Wie viel davon hast du gegessen?</div><div class="sc-seg">${FRACTIONS.map(([f, l]) => `<button type="button" data-frac="${f}" aria-pressed="${m.fraction === f}">${l}</button>`).join("")}</div></div>
      <div class="ph-block ph-row2"><label class="sc-f"><span>Datum</span><input type="date" id="phDate" class="sc-in" value="${esc(m.date)}"></label>
        <div class="sc-f"><span>Mahlzeit</span><div class="sc-seg">${CATS.map(([k, l]) => `<button type="button" data-cat="${k}" aria-pressed="${m.cat === k}">${l}</button>`).join("")}</div></div></div>`;
    const foot = `<div class="ph-total ${tot.complete ? "" : "warn"}">${["kcal", "p", "c", "f"].map((k) => `<div><b>${k === "kcal" ? f0(tot.values[k]) : f1(tot.values[k])}</b><span>${{ kcal: "kcal", p: "Eiweiß g", c: "KH g", f: "Fett g" }[k]}</span></div>`).join("")}</div>
      ${tot.complete ? "" : `<p class="sc-err small" style="margin:0">Bei ${tot.missing.length === 1 ? "einem Bestandteil" : tot.missing.length + " Bestandteilen"} fehlen Werte – bitte ergänzen oder entfernen.</p>`}
      ${btn("save", st.editing ? "Änderungen speichern" : "Mahlzeit speichern", "primary", tot.complete && !st.saving ? "" : "disabled")}<div class="sc-row">${st.editing ? "" : btn("replace", "Neues Foto", "ghost")}${btn("close", "Abbrechen", "ghost")}</div>`;
    const keepScroll = $("phBody").scrollTop;
    view("review", body, foot, st.editing ? "Mahlzeit bearbeiten" : "Ergebnis prüfen");
    if (st.view === "review") $("phBody").scrollTop = keepScroll;
  }

  function itemCard(it, i) {
    const v = N.mealItemValues(it);
    const range = it.gramsMin != null && it.gramsMax != null ? ` · Spanne ${it.gramsMin}–${it.gramsMax} g` : "";
    const conf = it.confidence ? ` · Sicherheit: ${it.confidence}` : "";
    return `<div class="ph-item ${it.per100 ? "" : "miss"}">
      <div class="ph-ihead"><b>${esc(it.name)}</b>${it.visible === false ? `<span class="ph-tag">vermutet</span>` : ""}<span class="ph-tag">${esc(it.state || "unbekannt")}</span><button type="button" class="ph-del" data-del="${i}" aria-label="${esc(it.name)} entfernen">✕</button></div>
      <div class="ph-irow"><label class="ph-g"><input class="sc-in" inputmode="decimal" data-grams="${i}" value="${it.grams == null ? "" : String(it.grams).replace(".", ",")}" aria-label="Menge ${esc(it.name)} in Gramm"><span>g</span></label>
        <div class="ph-ival">${f0(v.kcal)} kcal · ${f1(v.p)} g E · ${f1(v.c)} g KH · ${f1(v.f)} g F</div></div>
      <div class="ph-src"><span class="${it.source === "bls" ? "" : "warnc"}">${esc(SRC[it.source] || "")}${it.blsName ? ": " + esc(it.blsName) : ""}</span>${it.per100 ? ` (${f0(it.per100.kcal)} kcal/100 g)` : ""}${it.confidence ? `<span class="muted">${range}${conf}</span>` : ""}</div>
      <div class="sc-row ph-iact">${btn("swap", "Lebensmittel ändern", "ghost small", `data-i="${i}"`)}${btn("values", "Werte ändern", "ghost small", `data-i="${i}"`)}</div>
    </div>`;
  }

  /* Lebensmittel ersetzen / hinzufügen: Suche in der BLS-Datenbank */
  async function swapView(i) {
    const bls = await loadBLS();
    const it = i == null ? null : st.meal.items[i];
    st.swap = i;
    view("swap", `<label class="sc-lbl" for="phSearch">${it ? "Ersetzen: " + esc(it.name) : "Zutat hinzufügen"}</label>
      <input id="phSearch" class="sc-in" autocomplete="off" placeholder="z. B. Reis gekocht, Olivenöl, Brokkoli" value="${it ? esc(it.name) : ""}">
      ${bls ? "" : `<p class="sc-warn">Die Nährwert-Datenbank ist noch nicht installiert. Du kannst die Werte selbst eintragen.</p>`}
      <div id="phResults" class="ph-results"></div>`,
      `${btn("ownvals", "Eigene Werte eingeben", "ghost")}<div class="sc-row">${btn("back", "Zurück", "ghost")}</div>`, it ? "Lebensmittel ändern" : "Zutat hinzufügen");
    const run = () => {
      const q = $("phSearch").value;
      const res = bls ? N.foodSearch(bls, q, { state: it ? it.state : null, limit: 12 }) : [];
      $("phResults").innerHTML = res.length ? res.map((r) => `<button type="button" class="ph-res" data-code="${esc(r[0])}"><b>${esc(r[1])}</b><span>${f0(r[2])} kcal · ${f1(r[3])} E · ${f1(r[5])} KH · ${f1(r[4])} F pro 100 g</span></button>`).join("")
        : q.trim() ? `<p class="muted small">Nichts gefunden. Anderes Wort versuchen oder eigene Werte eingeben.</p>` : "";
    };
    $("phSearch").addEventListener("input", run); run();
    setTimeout(() => $("phSearch") && $("phSearch").focus(), 50);
  }
  function pickFood(code) {
    const r = (window.BLS || []).find((x) => x[0] === code); if (!r) return;
    const per100 = { kcal: r[2], p: r[3], f: r[4], c: r[5] };
    const cooked = /gekocht|gegart|gebraten|gedünstet|gegrillt|gebacken/i.test(r[1]);
    if (st.swap == null) st.meal.items.push({ name: r[1].split(",")[0], state: cooked ? "gegart" : "unbekannt", grams: 100, source: "bls", blsCode: r[0], blsName: r[1], per100, confidence: null, visible: true });
    else Object.assign(st.meal.items[st.swap], { name: r[1].split(",")[0], source: "bls", blsCode: r[0], blsName: r[1], per100 });
    reviewView();
  }

  /* Werte selbst eintragen (pro 100 g) */
  function valuesView(i) {
    const it = i == null ? { name: ($("phSearch") && $("phSearch").value) || "", per100: null, grams: 100 } : st.meal.items[i];
    st.valIdx = i;
    const p = it.per100 || {};
    const fld = (id, l, v) => `<label class="sc-f"><span>${l}</span><input id="${id}" class="sc-in" inputmode="decimal" value="${v == null ? "" : String(N.r1(v)).replace(".", ",")}" placeholder="fehlt"></label>`;
    view("values", `<label class="sc-f wide"><span>Name</span><input id="phVName" class="sc-in" value="${esc(it.name)}"></label>
      <div class="sc-lbl">Nährwerte pro 100 g</div>
      <div class="sc-grid">${fld("phVk", "Kalorien (kcal)", p.kcal)}${fld("phVp", "Eiweiß (g)", p.p)}${fld("phVc", "Kohlenhydrate (g)", p.c)}${fld("phVf", "Fett (g)", p.f)}</div>
      ${i == null ? `<div class="sc-grid">${fld("phVg", "Menge (g)", it.grams)}</div>` : ""}
      ${it.aiPer100 ? `<p class="muted small">KI-Richtwert: ${f0(it.aiPer100.kcal)} kcal · ${f1(it.aiPer100.p)} E · ${f1(it.aiPer100.c)} KH · ${f1(it.aiPer100.f)} F</p>` : ""}
      <p id="phVErr" class="sc-err" hidden></p>`,
      `${btn("savevals", "Übernehmen", "primary")}<div class="sc-row">${btn("back", "Zurück", "ghost")}</div>`, "Werte ändern");
  }
  function saveVals() {
    const g = (id) => N.parseNum($(id).value);
    const per = N.validPer100({ kcal: g("phVk"), p: g("phVp"), c: g("phVc"), f: g("phVf") });
    const name = ($("phVName").value || "").trim();
    const err = $("phVErr");
    if (!name) { err.hidden = false; err.textContent = "Bitte einen Namen eingeben."; return; }
    if (!per) { err.hidden = false; err.textContent = "Bitte alle vier Werte plausibel eintragen (pro 100 g: max. 900 kcal, Nährstoffe zusammen max. 100 g)."; return; }
    if (st.valIdx == null) {
      const grams = g("phVg");
      if (!N.validAmount(grams)) { err.hidden = false; err.textContent = "Bitte eine gültige Menge in Gramm eingeben."; return; }
      st.meal.items.push({ name, state: "unbekannt", grams, source: "manuell", per100: per, visible: true, confidence: null });
    } else Object.assign(st.meal.items[st.valIdx], { name, source: "manuell", per100: per, blsCode: null, blsName: null });
    reviewView();
  }

  function answer(qid, oi) {
    const q = st.meal.questions.find((x) => x.id === qid); if (!q) return;
    const o = q.options[+oi]; st.answered[qid] = true;
    if (o && o.add) {
      const bls = window.BLS;
      st.meal.items.push(matchItem({ name: o.add.name, state: "zubereitet", grams: o.add.grams, terms: o.add.terms, aiPer100: o.add.aiPer100, confidence: "mittel", visible: false }, bls));
    }
    reviewView();
  }

  async function save() {
    if (st.saving) return;
    const m = st.meal;
    const date = ($("phDate") && $("phDate").value) || m.date;
    const r = N.makeMealEntry(Object.assign({}, m, { title: m.dish }));
    if (!r.ok) return reviewView();
    st.saving = true;
    try {
      if (st.editing) await window.__food.replaceMeal(st.editing.date, st.editing.mealId, date, r.entry);
      else await window.__food.addTo(date, r.entry);
      const msg = (st.editing ? "Mahlzeit aktualisiert: " : "Gespeichert: ") + Math.round(r.entry.kcal) + " kcal · " + N.fmt(r.entry.p, 0) + " g Eiweiß";
      close(); window.appToast && window.appToast(msg);
    } catch (_) { st.saving = false; window.appToast && window.appToast("Speichern hat nicht geklappt – bitte nochmal."); reviewView(); }
  }

  /* Bestehende Foto-Mahlzeit bearbeiten */
  function editView(entry, date) {
    st.meal = { mealId: entry.mealId, dish: (entry.name || "").replace(/^📷\s*/, "").replace(/ · \d+ %$/, ""), fraction: entry.fraction || 1, cat: entry.cat || guessCat(), date,
      questions: [], items: (entry.items || []).map((i) => Object.assign({ visible: true, confidence: null }, i)) };
    st.answered = {};
    reviewView();
  }

  /* ---------- Ereignisse ---------- */
  function onClick(e) {
    const t = e.target.closest("[data-ph],[data-q],[data-frac],[data-cat],[data-del],[data-code]");
    if (!t) { if (e.target.id === "photoSheet") close(); return; }
    if (t.dataset.q) return answer(t.dataset.q, t.dataset.o);
    if (t.dataset.frac) { st.meal.fraction = +t.dataset.frac; return reviewView(); }
    if (t.dataset.cat) { st.meal.cat = t.dataset.cat; return reviewView(); }
    if (t.dataset.del) { st.meal.items.splice(+t.dataset.del, 1); return reviewView(); }
    if (t.dataset.code) return pickFood(t.dataset.code);
    const a = t.dataset.ph, i = t.dataset.i == null ? null : +t.dataset.i;
    if (a === "close") close();
    else if (a === "cam") { $("phCam").value = ""; $("phCam").click(); }
    else if (a === "lib") { $("phLib").value = ""; $("phLib").click(); }
    else if (a === "replace") pickView();
    else if (a === "analyze") analyze();
    else if (a === "savekey") saveKey();
    else if (a === "rekey") keyView();
    else if (a === "gentok") { const v = curVals(); v.token = newToken(); saveCfg({ draftToken: v.token, draftUrl: v.url }); keyView("", v); }
    else if (a === "copytok") { const cv = curVals(); saveCfg({ draftToken: cv.token, draftUrl: cv.url }); const t = ($("phTok").value || "").trim(); if (t && navigator.clipboard) navigator.clipboard.writeText(t).then(() => window.appToast && window.appToast("Passwort kopiert"), () => {}); }
    else if (a === "manual") { close(); window.__food && window.__food.focusManual(); }
    else if (a === "additem") swapView(null);
    else if (a === "swap") swapView(i);
    else if (a === "values") valuesView(i);
    else if (a === "ownvals") valuesView(st.swap);
    else if (a === "savevals") saveVals();
    else if (a === "back") reviewView();
    else if (a === "save") save();
  }

  function init() {
    document.body.insertAdjacentHTML("beforeend", shell());
    const sh = $("photoSheet");
    sh.addEventListener("click", onClick);
    sh.addEventListener("change", (e) => {
      if (e.target.id === "phCam" || e.target.id === "phLib") onFile(e.target.files && e.target.files[0]);
      if (e.target.id === "phDate" && st.meal) st.meal.date = e.target.value;
    });
    sh.addEventListener("input", (e) => {
      const gi = e.target.dataset && e.target.dataset.grams;
      if (gi != null && st.meal) {
        const v = N.parseNum(e.target.value); const it = st.meal.items[+gi];
        it.grams = N.validAmount(v) ? v : null;
        // Nur Zahlen aktualisieren, Eingabefeld behalten (Fokus/Tastatur bleibt)
        const card = e.target.closest(".ph-item"); const val = N.mealItemValues(it);
        card.querySelector(".ph-ival").textContent = `${f0(val.kcal)} kcal · ${f1(val.p)} g E · ${f1(val.c)} g KH · ${f1(val.f)} g F`;
        const tot = N.mealTotals(st.meal.items, st.meal.fraction);
        const cells = document.querySelectorAll("#phFoot .ph-total b");
        ["kcal", "p", "c", "f"].forEach((k, j) => { if (cells[j]) cells[j].textContent = k === "kcal" ? f0(tot.values[k]) : f1(tot.values[k]); });
        const sb = document.querySelector('#phFoot [data-ph="save"]'); if (sb) sb.disabled = !tot.complete;
        document.querySelector("#phFoot .ph-total").classList.toggle("warn", !tot.complete);
      }
    });
    sh.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
    window.claude.use("db").then((d) => { db = d; });
  }

  async function openKey() { $("photoSheet").hidden = false; document.body.style.overflow = "hidden"; await loadCfg(); st.editing = null; keyView(); }
  async function clearKey() { await saveCfg({ workerUrl: "", appToken: "", apiKey: undefined }); }
  window.PhotoMeal = { init, open, close, openKey, clearKey, _state: st };
})();
