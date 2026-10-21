/* Rezeptbereich: Bibliothek (recipes-data.js, KI-erstellt, Nährwerte aus BLS), eigene Rezepte, Favoriten,
   Portionsrechner und „Zum Tagebuch“. Daten nur auf diesem Gerät (Sammlungen „recipes“ und „recipeFavs“, Teil der Sicherung).
   Grundsätze: fehlende Werte zählen nie als 0; Tagebuch-Einträge sind Momentaufnahmen; Bibliotheksrezepte werden nie überschrieben. */
(function () {
  "use strict";
  const N = window.Nutri;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const CATS = { fruehstueck: "Frühstück", mittag: "Mittag", abend: "Abend", snack: "Snack" };
  const ICON = { fruehstueck: "🥣", mittag: "🍲", abend: "🍽️", snack: "🍎" };
  const UNITS = ["g", "ml", "Stück", "EL", "TL", "Scheibe(n)", "Dose", "Packung", "Prise", "Handvoll"];
  const PAGE = 24;
  const today = () => { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()); };
  const guessCat = () => { const h = new Date().getHours(); return h < 11 ? "fruehstueck" : h < 15 ? "mittag" : h < 18 ? "snack" : "abend"; };
  const num = (v) => (v == null || !isFinite(v) ? "–" : String(Math.round(v)));
  const dec = (v) => String(Math.round(v * 10) / 10).replace(".", ",");
  const newId = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  let db = null, libP = null, lib = [], own = [], favs = new Set(), loaded = false, loadErr = null;
  const F = { q: "", cat: "", fav: false, own: false, veg: false, vegan: false, hp: false, time: 0, kcal: 0, excl: "", sort: "name" };
  let shown = PAGE;
  const st = { view: null, r: null, cookS: 1, eat: 1, date: null, cat: null, mealId: null, saving: false, edit: null, pickFor: null, wake: null, checked: new Set(), hideForScan: false };

  /* ---------- Laden ---------- */
  function loadLib() {
    if (window.RECIPE_LIB) return Promise.resolve(window.RECIPE_LIB);
    if (libP) return libP;
    libP = new Promise((res, rej) => {
      const s = document.createElement("script"); s.src = "recipes-data.js"; s.async = true;
      s.onload = () => (window.RECIPE_LIB ? res(window.RECIPE_LIB) : rej(new Error("leer")));
      s.onerror = () => { libP = null; s.remove(); rej(new Error("nicht geladen")); };
      document.head.appendChild(s);
    });
    return libP;
  }
  let blsP = null;
  function loadBLS() {
    if (window.BLS) return Promise.resolve(window.BLS);
    if (blsP) return blsP;
    blsP = new Promise((res) => { const s = document.createElement("script"); s.src = "bls.js"; s.async = true; s.onload = () => res(window.BLS || null); s.onerror = () => { blsP = null; res(null); }; document.head.appendChild(s); });
    return blsP;
  }
  function prep(r, isOwn) {
    r.own = !!isOwn; r._per = N.recipePerServing(r); r._time = r.prep == null && r.cook == null ? null : (r.prep || 0) + (r.cook || 0);
    r._hp = r._per.complete && N.isHighProtein(r._per.per); delete r._s; return r;
  }
  async function loadOwn() {
    if (!db) return;
    const [rs, fs] = await Promise.all([db.collection("recipes").get(), db.collection("recipeFavs").get()]);
    own = rs.docs.map((d) => prep(Object.assign({}, d.data(), { id: d.id }), true));
    favs = new Set(fs.docs.map((d) => d.id));
  }
  async function ensureLoaded() {
    if (loaded) return renderList();
    $("rzList").innerHTML = `<div class="sc-load"><span class="sc-spin" aria-hidden="true"></span>Rezepte werden geladen …</div>`;
    try { await loadOwn(); } catch (_) {}
    try { const L = await loadLib(); lib = L.recipes.map((r) => prep(r, false)); loadErr = null; }
    catch (e) { loadErr = e; }
    loaded = true; renderList();
  }
  const all = () => lib.concat(own);
  const byId = (id) => all().find((r) => r.id === id);

  /* ---------- Übersicht ---------- */
  function filtered() {
    const list = all().filter((r) => {
      if (F.cat && !(r.cat || []).includes(F.cat)) return false;
      if (F.fav && !favs.has(r.id)) return false;
      if (F.own && !r.own) return false;
      if (F.veg && !r.veg) return false;
      if (F.vegan && !r.vegan) return false;
      if (F.hp && !r._hp) return false;
      if (F.time && (r._time == null || r._time > F.time)) return false;
      if (F.kcal && (!r._per.complete || r._per.per.kcal > F.kcal)) return false;
      if (F.excl && N.recipeExcluded(r, F.excl)) return false;
      return N.recipeMatches(r, F.q);
    });
    const kc = (r) => (r._per.complete ? r._per.per.kcal : Infinity), pr = (r) => (r._per.complete ? r._per.per.p : -1);
    const cmp = {
      name: (a, b) => a.t.localeCompare(b.t, "de"),
      time: (a, b) => (a._time == null ? 1e9 : a._time) - (b._time == null ? 1e9 : b._time),
      kcal: (a, b) => kc(a) - kc(b),
      protein: (a, b) => pr(b) - pr(a),
      density: (a, b) => (b._per.complete ? b._per.per.p / b._per.per.kcal : -1) - (a._per.complete ? a._per.per.p / a._per.per.kcal : -1)
    }[F.sort] || ((a, b) => a.t.localeCompare(b.t, "de"));
    return list.sort((a, b) => cmp(a, b) || a.t.localeCompare(b.t, "de"));
  }
  function tags(r) {
    const t = [];
    if (r.vegan) t.push(r.own ? "Vegan (laut dir)" : "Vegan"); else if (r.veg) t.push(r.own ? "Vegetarisch (laut dir)" : "Vegetarisch");
    if (r._hp) t.push("Proteinreich");
    if (r.own) t.push(r.basedOn ? "Variante" : "Eigenes");
    if (!r._per.complete) t.push("Werte unvollständig");
    return t;
  }
  function card(r) {
    const c = (r.cat || [])[0] || "mittag"; const p = r._per;
    const meta = [r._time != null ? "⏱ " + r._time + " Min" : null, p.complete ? num(p.per.kcal) + " kcal" : "kcal ?", p.complete ? num(p.per.p) + " g Eiweiß" : null].filter(Boolean).join(" · ");
    return `<article class="rz-card"><button type="button" class="rz-open" data-open="${esc(r.id)}">
      <span class="rz-ph rz-c-${c}" aria-hidden="true">${ICON[c] || "🍽️"}</span>
      <span class="rz-info"><b class="rz-t">${esc(r.t)}</b><span class="rz-meta">${meta}</span><span class="rz-tags">${tags(r).map((t) => `<span class="${t.startsWith("Werte") ? "warn" : ""}">${esc(t)}</span>`).join("")}</span><span class="rz-pp">pro Portion</span></span></button>
      <button type="button" class="rz-fav" data-fav="${esc(r.id)}" aria-pressed="${favs.has(r.id)}" aria-label="${favs.has(r.id) ? "Aus Favoriten entfernen" : "Als Favorit merken"}">${favs.has(r.id) ? "★" : "☆"}</button></article>`;
  }
  function renderList() {
    if (!$("rzList")) return;
    const list = filtered();
    const anyFilter = F.q || F.cat || F.fav || F.own || F.veg || F.vegan || F.hp || F.time || F.kcal || F.excl;
    $("rzCount").textContent = loaded ? `${list.length} von ${all().length} Rezepten` + (loadErr ? "" : ` · Bibliothek: ${lib.length}, eigene: ${own.length}`) : "";
    let html = "";
    if (loadErr) html += `<div class="sc-msg warn">Die Rezeptbibliothek konnte nicht geladen werden${navigator.onLine ? "" : " (offline und noch nicht gespeichert)"}. Deine eigenen Rezepte und Favoriten sind weiter da. <button type="button" class="sc-btn small" data-retry="1">Nochmal versuchen</button></div>`;
    if (!list.length) html += `<p class="sc-msg">${anyFilter ? "Keine Rezepte passen zu Suche und Filtern." + (F.fav && !favs.size ? " Du hast noch keine Favoriten – tippe auf ☆ bei einem Rezept." : "") + ` <button type="button" class="sc-btn small" data-reset="1">Filter zurücksetzen</button>` : "Noch keine Rezepte vorhanden."}</p>`;
    html += list.slice(0, shown).map(card).join("");
    $("rzList").innerHTML = html;
    $("rzMore").hidden = list.length <= shown;
    $("rzMore").textContent = `Mehr anzeigen (${list.length - shown} weitere)`;
    syncFilterUI();
  }
  function syncFilterUI() {
    document.querySelectorAll("#rzCats [data-rcat]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.rcat === F.cat)));
    document.querySelectorAll("#rzTog [data-tog]").forEach((b) => b.setAttribute("aria-pressed", String(!!F[b.dataset.tog])));
  }
  function saveFilters() { try { localStorage.setItem("rzFilter", JSON.stringify({ excl: F.excl, sort: F.sort })); } catch (_) {} }
  function loadFilters() { try { const o = JSON.parse(localStorage.getItem("rzFilter") || "{}"); if (typeof o.excl === "string") F.excl = o.excl; if (o.sort) F.sort = o.sort; } catch (_) {} }

  async function toggleFav(id) {
    if (!db) return;
    const on = !favs.has(id);
    if (on) { favs.add(id); await db.collection("recipeFavs").doc(id).set({ at: new Date().toISOString() }); }
    else { favs.delete(id); await db.collection("recipeFavs").doc(id).delete(); }
    renderList(); if (st.view === "detail" && st.r && st.r.id === id) detailView();
  }

  /* ---------- Blatt (Details, Tagebuch, Bearbeiten) ---------- */
  function sheet() {
    return `<div id="rzSheet" hidden role="dialog" aria-modal="true" aria-labelledby="rzTitle"><div class="sc-sheet">
      <div class="sc-head"><b id="rzTitle">Rezept</b><button type="button" class="sc-x" data-rz="close" aria-label="Schließen">✕</button></div>
      <div id="rzBody" class="sc-body rz-body"></div><div id="rzFoot" class="sc-foot"></div></div></div>`;
  }
  const btn = (act, label, cls, extra) => `<button type="button" class="sc-btn ${cls || ""}" data-rz="${act}" ${extra || ""}>${label}</button>`;
  function view(name, title, body, foot) {
    st.view = name; $("rzTitle").textContent = title; $("rzBody").innerHTML = body; $("rzFoot").innerHTML = foot || "";
  }
  function openSheet() { $("rzSheet").hidden = false; document.body.style.overflow = "hidden"; }
  function close() {
    releaseWake();
    $("rzSheet").hidden = true; document.body.style.overflow = "";
    st.view = null; st.r = null; st.edit = null; st.saving = false; st.checked = new Set();
  }

  function openRecipe(id) {
    const r = byId(id); if (!r) return;
    st.r = r; st.cookS = r.s; st.checked = new Set(); openSheet(); detailView();
    $("rzBody").scrollTop = 0;
  }
  function amountLabel(i, factor) {
    const s = N.scaleIngredient(i, factor);
    const main = s.a != null ? N.fmtAmount(s.a, s.u) : "";
    const basis = i.basis === "ml" ? "ml" : "g";
    const eq = !i.x && s.g != null && s.u !== basis ? ` <span class="muted">(≈ ${N.fmtAmount(s.g, basis)})</span>` : "";
    return main + eq;
  }
  function srcLabel(i) {
    if (i.x) return "Gewürz – nicht eingerechnet";
    const base = i.basis === "ml" ? "100 ml" : "100 g";
    const vals = Array.isArray(i.v) ? `${num(i.v[0])} kcal · ${dec(i.v[1] || 0)} g E pro ${base}` : "";
    if (i.src === "product") return "Produkt (Open Food Facts/eigene Angaben) · " + vals;
    if (i.src === "own") return "eigene Werte · " + vals;
    if (i.b) return "BLS: " + esc(i.bn || i.b) + " · " + vals;
    return "keine Nährwerte zugeordnet";
  }
  function totalsBox(per, cls) {
    return `<div class="ph-total ${cls || ""}">${[["kcal", "kcal"], ["p", "Eiweiß"], ["c", "Kohlenh."], ["f", "Fett"]].map(([k, l]) => `<div><b>${per && per[k] != null ? (k === "kcal" ? num(per[k]) : num(per[k]) + " g") : "?"}</b><span>${l}</span></div>`).join("")}</div>`;
  }
  function detailView() {
    const r = st.r; const f = st.cookS / r.s; const ps = r._per; const tot = N.recipeTotals(r, f);
    const times = [r.prep != null ? "Vorbereitung " + r.prep + " Min" : null, r.cook ? "Kochen/Backen " + r.cook + " Min" : null, r._time != null ? "<b>Gesamt " + r._time + " Min</b>" : null].filter(Boolean).join(" · ");
    const badge = r.own ? (r.basedOn ? `Eigene Variante${byId(r.basedOn) ? " von „" + esc(byId(r.basedOn).t) + "“" : ""}` : "Eigenes Rezept") : "KI-erstellt";
    const miss = ps.missing.map((i) => esc(r.ing[i].n));
    const ings = r.ing.map((i, k) => `<li class="${st.checked.has(k) ? "done" : ""}"><button type="button" data-chk="${k}" aria-pressed="${st.checked.has(k)}"><span class="rz-amt">${amountLabel(i, f)}</span> <span>${esc(i.n)}</span>${i.note ? `<small>${esc(i.note)}</small>` : ""}${i.x ? `<small>nicht eingerechnet</small>` : ""}</button></li>`).join("");
    const wakeOk = "wakeLock" in navigator;
    view("detail", r.t, `
      <p class="rz-badges"><span class="rz-badge">${badge}</span>${tags(r).filter((t) => !/Eigenes|Variante/.test(t)).map((t) => `<span class="rz-badge ${t.startsWith("Werte") ? "warn" : "soft"}">${esc(t)}</span>`).join("")}</p>
      ${r.d ? `<p class="rz-desc">${esc(r.d)}</p>` : ""}
      ${times ? `<p class="muted small" style="margin:0">${times}</p>` : ""}
      <div class="rz-sec"><div class="sc-lbl">Pro Portion</div>${totalsBox(ps.complete ? ps.per : null, ps.complete ? "" : "warn")}
        ${ps.complete ? "" : `<p class="sc-warn">Unvollständig: Bei ${miss.join(", ")} fehlen Menge oder Nährwerte – diese zählen nicht als 0. ${r.own ? "Bitte im Rezept ergänzen." : ""}</p>`}</div>
      <div class="rz-sec"><div class="sc-lbl">Zubereiten für</div><div class="rz-portions"><button type="button" class="sc-btn small" data-rz="minus" aria-label="Eine Portion weniger" ${st.cookS <= 1 ? "disabled" : ""}>−</button><b id="rzCook">${st.cookS} ${st.cookS === 1 ? "Portion" : "Portionen"}</b><button type="button" class="sc-btn small" data-rz="plus" aria-label="Eine Portion mehr" ${st.cookS >= 24 ? "disabled" : ""}>+</button></div>
        <p class="muted small" style="margin:0">Rezept ist für ${r.s} ${r.s === 1 ? "Portion" : "Portionen"} geschrieben. Mengen werden umgerechnet, die Werte pro Portion bleiben gleich.</p>
        <div class="sc-lbl" style="margin-top:8px">Gesamt (${st.cookS} ${st.cookS === 1 ? "Portion" : "Portionen"})</div>${totalsBox(tot.complete ? tot.total : null, tot.complete ? "" : "warn")}</div>
      <div class="rz-sec"><div class="sc-lbl">Zutaten <span class="muted">(antippen zum Abhaken)</span></div><ul class="rz-ing">${ings}</ul></div>
      ${r.note ? `<p class="sc-warn">${esc(r.note)}</p>` : ""}
      <div class="rz-sec"><div class="sc-lbl">Zubereitung</div><ol class="rz-steps">${(r.st || []).map((s) => `<li>${esc(s)}</li>`).join("") || "<li class='muted'>Keine Schritte eingetragen.</li>"}</ol></div>
      ${wakeOk ? `<button type="button" class="sc-btn ghost" data-rz="wake" aria-pressed="${!!st.wake}">${st.wake ? "☀︎ Bildschirm bleibt an – ausschalten" : "☀︎ Bildschirm beim Kochen anlassen"}</button>` : ""}
      <details class="rz-src"><summary>Nährwert-Grundlage und Quelle</summary>
        <ul>${r.ing.map((i) => `<li><b>${esc(i.n)}</b>: ${srcLabel(i)}</li>`).join("")}</ul>
        <p>${r.own ? "Eigenes Rezept, gespeichert nur auf diesem Gerät (Teil der Sicherung)." : "KI-erstellt (Claude) für diese App: Zutaten und Zubereitung wurden generiert und nicht von einer Testküche geprüft. Nährwerte berechnet aus den Grammangaben und dem Bundeslebensmittelschlüssel BLS 4.0 (Max Rubner-Institut)."} Gewürze in kleinen Mengen sind nicht eingerechnet. Alle Werte sind Richtwerte – je nach Produkt ±10–15 %.</p>
        <p>Allergene: Es gibt keine geprüften Allergen-Daten. Die Bibliothek enthält keine Nüsse als Zutat, aber Fertigprodukte (Brühe, Gewürze, Soßen, Brot) bitte immer aufs Etikett prüfen.</p></details>`,
      `${btn("eat", "Zum Tagebuch hinzufügen", "primary", ps.complete ? "" : "disabled")}
       <div class="sc-row">${btn("fav", favs.has(r.id) ? "★ Favorit" : "☆ Favorit", "ghost", `aria-pressed="${favs.has(r.id)}"`)}${r.own ? btn("edit", "Bearbeiten", "ghost") : btn("variant", "Als Variante bearbeiten", "ghost")}</div>
       ${r.own ? `<div class="sc-row">${btn("dup", "Duplizieren", "ghost")}${btn("del", "Löschen", "ghost")}</div>` : ""}`);
  }

  /* ---------- Zum Tagebuch ---------- */
  function eatView() {
    const r = st.r; if (!r._per.complete) return;
    if (!st.mealId) { st.mealId = newId("r"); st.eat = 1; st.date = window.__food ? window.__food.date() : today(); st.cat = guessCat(); }
    const res = N.makeRecipeEntry(r, st.eat, { cat: st.cat, mealId: st.mealId });
    view("eat", "Zum Tagebuch", `
      <p style="margin:0"><b>${esc(r.t)}</b></p>
      <label class="sc-f"><span>Datum</span><input type="date" id="rzDate" class="sc-in" value="${esc(st.date)}" max="${today()}"></label>
      <div class="sc-lbl">Mahlzeit</div>
      <div class="sc-seg">${Object.entries(CATS).map(([k, l]) => `<button type="button" data-ecat="${k}" aria-pressed="${st.cat === k}">${l}</button>`).join("")}</div>
      <div class="sc-lbl">Gegessene Menge</div>
      <div class="sc-seg">${[0.5, 1, 1.5, 2].map((v) => `<button type="button" data-eat="${v}" aria-pressed="${st.eat === v}">${N.fmtAmount(v, "")}</button>`).join("")}</div>
      <div class="rz-portions"><button type="button" class="sc-btn small" data-rz="eminus" aria-label="Halbe Portion weniger" ${st.eat <= 0.5 ? "disabled" : ""}>−</button><b>${N.fmtAmount(st.eat, st.eat === 1 ? "Portion" : "Portionen")}</b><button type="button" class="sc-btn small" data-rz="eplus" aria-label="Halbe Portion mehr" ${st.eat >= 10 ? "disabled" : ""}>+</button></div>
      <div class="sc-lbl">Das wird eingetragen</div>${totalsBox(res.ok ? res.entry : null)}
      <p class="muted small" style="margin:0">1 Portion = ${num(r._per.per.kcal)} kcal · ${num(r._per.per.p)} g Eiweiß. Die Werte werden fest gespeichert – spätere Änderungen am Rezept ändern diesen Eintrag nicht.</p>
      ${res.ok ? "" : `<p class="sc-err">${esc(res.error)}</p>`}`,
      `${btn("save-eat", "Speichern", "primary", res.ok && !st.saving ? "" : "disabled")}<div class="sc-row">${btn("back", "Zurück", "ghost")}</div>`);
  }
  async function saveEat() {
    if (st.saving || !window.__food) return;
    const r = st.r; const res = N.makeRecipeEntry(r, st.eat, { cat: st.cat, mealId: st.mealId });
    if (!res.ok) return eatView();
    st.saving = true; const b = document.querySelector('#rzFoot [data-rz="save-eat"]'); if (b) { b.disabled = true; b.textContent = "Wird gespeichert …"; }
    try {
      await window.__food.addTo(st.date || today(), res.entry);
      st.mealId = null; st.saving = false;
      window.appToast && window.appToast("Eingetragen: " + r.t + " – " + num(res.entry.kcal) + " kcal");
      detailView();
    } catch (_) {
      st.saving = false; eatView();
      $("rzBody").insertAdjacentHTML("beforeend", `<p class="sc-err">Speichern hat nicht geklappt – bitte nochmal tippen.</p>`);
    }
  }

  /* ---------- Eigene Rezepte: Bearbeiten ---------- */
  const clone = (o) => JSON.parse(JSON.stringify(o));
  function stripRuntime(r) { const o = clone(r); Object.keys(o).forEach((k) => { if (k.startsWith("_")) delete o[k]; }); delete o.own; return o; }
  function startEdit(r, mode) {
    let d;
    if (!r) d = { id: newId("own-"), t: "", d: "", cat: [], s: 2, prep: null, cook: null, veg: false, vegan: false, ing: [], st: [], basedOn: null, isNew: true };
    else if (mode === "variant") { d = stripRuntime(r); d.id = newId("own-"); d.basedOn = r.id; d.t = r.t + " (Variante)"; d.isNew = true;
      d.ing = d.ing.map((i) => Object.assign(i, i.x ? {} : { src: i.src || (i.b ? "bls" : i.src), basis: i.basis || "g" })); }
    else { d = stripRuntime(r); d.isNew = false; }
    st.edit = d; editView();
  }
  function editTotals() {
    const d = st.edit; const s = N.parseNum(String(d.s)) || 0;
    const ps = N.recipePerServing({ s, ing: d.ing });
    return ps;
  }
  function ingRow(i, k) {
    const basis = i.basis === "ml" ? "ml" : "g";
    const needEq = !i.x && i.u !== basis;
    const src = i.x ? "Gewürz" : i.src === "product" ? "Produkt" : i.src === "own" ? "eigene Werte" : i.b ? "BLS" : "keine Werte";
    const bad = !i.x && (!Array.isArray(i.v) || i.v.some((x) => x == null) || i.g == null);
    return `<div class="rz-ei ${bad ? "miss" : ""}">
      <div class="rz-ei-top"><input class="sc-in" data-ei="${k}" data-ef="n" value="${esc(i.n)}" aria-label="Zutat"><button type="button" class="sc-x" data-rz="irm" data-i="${k}" aria-label="${esc(i.n)} entfernen">✕</button></div>
      <div class="rz-ei-row"><input class="sc-in" inputmode="decimal" data-ei="${k}" data-ef="a" value="${i.a == null ? "" : esc(String(i.a).replace(".", ","))}" aria-label="Menge" placeholder="Menge">
        <select class="sc-in" data-ei="${k}" data-ef="u" aria-label="Einheit">${UNITS.concat(UNITS.includes(i.u) ? [] : [i.u]).map((u) => `<option ${u === i.u ? "selected" : ""}>${esc(u)}</option>`).join("")}</select></div>
      ${needEq ? `<label class="sc-f"><span>Entspricht wie viel ${basis}? (für die Nährwerte)</span><input class="sc-in" inputmode="decimal" data-ei="${k}" data-ef="g" value="${i.g == null ? "" : esc(String(Math.round(i.g * 10) / 10).replace(".", ","))}" placeholder="z. B. 80"></label>` : ""}
      <div class="rz-ei-src"><span class="muted small">${esc(src)}${i.bn ? ": " + esc(i.bn) : ""}${bad ? " · <b class='sc-err'>Werte fehlen</b>" : ""}</span>
        <label class="small"><input type="checkbox" data-ei="${k}" data-ef="x" ${i.x ? "checked" : ""}> Gewürz, nicht einrechnen</label>
        ${i.x ? "" : `<button type="button" class="sc-btn small ghost" data-rz="remap" data-i="${k}">Zuordnung ändern</button>`}</div></div>`;
  }
  function editView() {
    const d = st.edit; const ps = editTotals();
    view("edit", d.isNew ? (d.basedOn ? "Variante bearbeiten" : "Neues Rezept") : "Rezept bearbeiten", `
      ${d.basedOn ? `<p class="sc-warn" style="margin:0">Du bearbeitest eine eigene Kopie. Das Original in der Bibliothek bleibt unverändert.</p>` : ""}
      <label class="sc-f"><span>Titel</span><input id="rzT" class="sc-in" data-ef="t" value="${esc(d.t)}" placeholder="z. B. Mamas Gulasch" maxlength="80"></label>
      <label class="sc-f"><span>Kurzbeschreibung (optional)</span><input class="sc-in" data-ef="d" value="${esc(d.d || "")}" maxlength="300"></label>
      <div class="sc-grid"><label class="sc-f"><span>Portionen</span><input class="sc-in" inputmode="decimal" data-ef="s" value="${esc(String(d.s ?? ""))}"></label>
        <label class="sc-f"><span>Vorbereitung (Min)</span><input class="sc-in" inputmode="numeric" data-ef="prep" value="${d.prep ?? ""}"></label>
        <label class="sc-f"><span>Kochen/Backen (Min)</span><input class="sc-in" inputmode="numeric" data-ef="cook" value="${d.cook ?? ""}"></label></div>
      <div class="sc-lbl">Mahlzeit</div><div class="sc-seg">${Object.entries(CATS).map(([k, l]) => `<button type="button" data-dcat="${k}" aria-pressed="${(d.cat || []).includes(k)}">${l}</button>`).join("")}</div>
      <div class="sc-seg"><button type="button" data-dflag="veg" aria-pressed="${!!d.veg}">Vegetarisch</button><button type="button" data-dflag="vegan" aria-pressed="${!!d.vegan}">Vegan</button></div>
      <p class="muted small" style="margin:0">Vegetarisch/vegan gibst du selbst an – die App prüft das nicht.</p>
      <div class="sc-lbl">Zutaten</div>
      <div class="rz-eis">${d.ing.map(ingRow).join("") || `<p class="muted" style="margin:0">Noch keine Zutaten.</p>`}</div>
      <div class="sc-row">${btn("add-search", "+ Suchen", "ghost")}${btn("add-scan", "+ Barcode", "ghost")}${btn("add-own", "+ Eigene Werte", "ghost")}</div>
      <label class="sc-f"><span>Zubereitung – ein Schritt pro Zeile</span><textarea class="sc-in rz-ta" data-ef="st" rows="6">${esc((d.st || []).join("\n"))}</textarea></label>
      <div class="sc-lbl">Pro Portion (berechnet)</div><div id="rzEditTot">${totalsBox(ps.complete ? ps.per : null, ps.complete ? "" : "warn")}${ps.complete ? "" : `<p class="sc-warn">Noch unvollständig – fehlende Werte zählen nicht als 0. Speichern geht trotzdem, „Zum Tagebuch“ erst wenn alles vollständig ist.</p>`}</div>
      <p id="rzEditErr" class="sc-err" hidden></p>`,
      `${btn("save-edit", "Rezept speichern", "primary")}<div class="sc-row">${btn("cancel-edit", "Abbrechen", "ghost")}</div>`);
  }
  function refreshEditTotals() {
    const ps = editTotals(); const el = $("rzEditTot");
    if (el) el.innerHTML = totalsBox(ps.complete ? ps.per : null, ps.complete ? "" : "warn") + (ps.complete ? "" : `<p class="sc-warn">Noch unvollständig – fehlende Werte zählen nicht als 0. Speichern geht trotzdem, „Zum Tagebuch“ erst wenn alles vollständig ist.</p>`);
  }
  function onEditInput(e) {
    const t = e.target; const d = st.edit; if (!d || !t.dataset || !t.dataset.ef) return;
    const f = t.dataset.ef;
    if (t.dataset.ei != null) {
      const i = d.ing[+t.dataset.ei]; if (!i) return;
      const basis = i.basis === "ml" ? "ml" : "g";
      if (f === "n") i.n = t.value;
      else if (f === "a") { i.a = N.parseNum(t.value); if (i.u === basis) i.g = i.a; }
      else if (f === "g") i.g = N.parseNum(t.value);
      else if (f === "u") { i.u = t.value; if (i.u === basis) i.g = i.a; else i.g = null; if (e.type === "change") return editView(); }
      else if (f === "x") { if (t.checked) { i.x = 1; } else delete i.x; return editView(); }
    } else if (f === "st") d.st = t.value.split("\n").map((s) => s.trim()).filter(Boolean);
    else if (f === "s") d.s = N.parseNum(t.value);
    else if (f === "prep" || f === "cook") d[f] = N.parseNum(t.value);
    else d[f] = t.value;
    refreshEditTotals();
  }
  async function saveEdit() {
    if (st.saving || !db) return;
    const d = st.edit; const c = N.cleanRecipe(d);
    if (!c.ok) { const e = $("rzEditErr"); e.textContent = c.error; e.hidden = false; e.scrollIntoView({ block: "center" }); return; }
    st.saving = true;
    const now = new Date().toISOString();
    const prev = own.find((r) => r.id === d.id);
    const data = Object.assign({}, c.recipe, { createdAt: prev && prev.createdAt || now, updatedAt: now }); delete data.own;
    try {
      await db.collection("recipes").doc(d.id).set(data);
      await loadOwn(); st.saving = false; st.edit = null; renderList();
      window.appToast && window.appToast("Rezept gespeichert");
      openRecipe(d.id);
    } catch (_) { st.saving = false; const e = $("rzEditErr"); e.textContent = "Speichern hat nicht geklappt – bitte nochmal tippen."; e.hidden = false; }
  }
  async function duplicate() {
    const r = st.r; if (!r || !r.own || !db || st.saving) return;
    st.saving = true;
    const d = stripRuntime(r); d.id = newId("own-"); d.t = (r.t + " (Kopie)").slice(0, 80); const now = new Date().toISOString(); d.createdAt = now; d.updatedAt = now;
    await db.collection("recipes").doc(d.id).set(d); await loadOwn(); st.saving = false; renderList(); openRecipe(d.id);
    window.appToast && window.appToast("Kopie angelegt");
  }
  async function remove() {
    const r = st.r; if (!r || !r.own || !db) return;
    if (!window.confirm("„" + r.t + "“ wirklich löschen? Bereits eingetragene Mahlzeiten bleiben im Tagebuch erhalten.")) return;
    await db.collection("recipes").doc(r.id).delete(); await db.collection("recipeFavs").doc(r.id).delete().catch(() => {});
    favs.delete(r.id); await loadOwn(); close(); renderList();
    window.appToast && window.appToast("Rezept gelöscht");
  }

  /* ---------- Zutat auswählen ---------- */
  let products = null;
  async function pickView(forIndex) {
    st.pickFor = forIndex == null ? null : forIndex;
    view("pick", forIndex == null ? "Zutat hinzufügen" : "Zuordnung ändern", `
      <input id="rzPickQ" class="sc-in" type="search" placeholder="Lebensmittel suchen, z. B. Magerquark" autocomplete="off" value="${forIndex != null ? esc(st.edit.ing[forIndex].n) : ""}">
      <div id="rzPickRes" class="rz-pick"><p class="muted" style="margin:0">Suche in deinen gescannten Produkten und in der Lebensmitteldatenbank (BLS).</p></div>`,
      `<div class="sc-row">${btn("add-own", "Eigene Werte eingeben", "ghost")}${btn("back-edit", "Zurück", "ghost")}</div>`);
    if (!products && db) { try { products = (await db.collection("products").get()).docs.map((d) => N.effective(d.data())).filter((p) => p && p.per100); } catch (_) { products = []; } }
    const q = $("rzPickQ"); if (q) { q.focus(); if (q.value) searchPick(q.value); }
  }
  let pickRows = [];
  async function searchPick(q) {
    const out = $("rzPickRes"); if (!out) return;
    const nq = N.normText(q); if (nq.length < 2) { out.innerHTML = ""; return; }
    out.innerHTML = `<div class="sc-load"><span class="sc-spin" aria-hidden="true"></span>Suche …</div>`;
    const bls = await loadBLS();
    if (!$("rzPickQ") || N.normText($("rzPickQ").value) !== nq) return;
    const prods = (products || []).filter((p) => N.normText([p.brand, p.name].join(" ")).includes(nq)).slice(0, 6);
    const hits = bls ? N.foodSearch(bls, q, { limit: 15 }) : [];
    pickRows = prods.map((p) => ({ t: "p", p })).concat(hits.map((h) => ({ t: "b", h })));
    if (!pickRows.length) { out.innerHTML = `<p class="sc-msg">Nichts gefunden. Versuch ein anderes Wort oder gib eigene Werte ein.${bls ? "" : " (Die Lebensmitteldatenbank ist gerade nicht verfügbar.)"}</p>`; return; }
    out.innerHTML = pickRows.map((r, k) => r.t === "p"
      ? `<button type="button" class="rz-hit" data-hit="${k}"><b>${esc([r.p.brand, r.p.name].filter(Boolean).join(" "))}</b><span>Dein Produkt · ${num(r.p.per100.kcal)} kcal · ${dec(r.p.per100.p || 0)} g E / 100 ${r.p.basis === "ml" ? "ml" : "g"}</span></button>`
      : `<button type="button" class="rz-hit" data-hit="${k}"><b>${esc(r.h[1])}</b><span>BLS · ${num(r.h[2])} kcal · ${r.h[3] == null ? "?" : dec(r.h[3])} g E / 100 g</span></button>`).join("");
  }
  function applyPick(ing) {
    const d = st.edit; if (!d) return;
    if (st.pickFor != null && d.ing[st.pickFor]) {
      const old = d.ing[st.pickFor]; const oldBasis = old.basis === "ml" ? "ml" : "g"; const nb = ing.basis === "ml" ? "ml" : "g";
      const keep = { n: old.n || ing.n, a: old.a, u: old.u === oldBasis ? nb : old.u, g: old.u === oldBasis ? old.a : (oldBasis === nb ? old.g : null) };
      ["b", "bn", "code", "src", "v", "basis"].forEach((k) => delete old[k]); delete old.x;
      Object.assign(old, ing, keep);
    } else d.ing.push(ing);
    st.pickFor = null; editView();
    const last = document.querySelectorAll(".rz-ei"); const el = last[last.length - 1]; if (el && !st.pickFor) el.scrollIntoView({ block: "center" });
  }
  function hitToIng(r) {
    if (r.t === "p") { const p = r.p; const b = p.basis === "ml" ? "ml" : "g"; return { n: [p.brand, p.name].filter(Boolean).join(" "), a: 100, u: b, g: 100, basis: b, v: [p.per100.kcal, p.per100.p, p.per100.f, p.per100.c].map((x) => (x == null ? null : x)), src: "product", code: p.code }; }
    const h = r.h; return { n: h[1].split(",")[0], a: 100, u: "g", g: 100, basis: "g", v: [h[2], h[3], h[4], h[5]], src: "bls", b: h[0], bn: h[1] };
  }
  function ownValuesView() {
    const cur = st.pickFor != null ? st.edit.ing[st.pickFor] : null;
    const v = cur && Array.isArray(cur.v) ? cur.v : [];
    const f = (id, l, val) => `<label class="sc-f"><span>${l}</span><input id="${id}" class="sc-in" inputmode="decimal" value="${val == null ? "" : esc(String(val).replace(".", ","))}" placeholder="fehlt"></label>`;
    view("own", "Eigene Werte", `
      <label class="sc-f"><span>Name</span><input id="rzON" class="sc-in" value="${esc(cur ? cur.n : "")}"></label>
      <div class="sc-lbl">Werte gelten pro</div>
      <div class="sc-seg"><button type="button" data-obasis="g" aria-pressed="${!cur || cur.basis !== "ml"}">100 g</button><button type="button" data-obasis="ml" aria-pressed="${!!cur && cur.basis === "ml"}">100 ml</button></div>
      <div class="sc-grid">${f("rzOK", "kcal", v[0])}${f("rzOP", "Eiweiß (g)", v[1])}${f("rzOC", "Kohlenhydrate (g)", v[3])}${f("rzOF", "Fett (g)", v[2])}</div>
      <p class="muted small" style="margin:0">Leere Felder bleiben „fehlt“ und zählen nicht als 0.</p><p id="rzOErr" class="sc-err" hidden></p>`,
      `${btn("own-save", "Übernehmen", "primary")}<div class="sc-row">${btn("back-edit", "Zurück", "ghost")}</div>`);
  }
  function ownValuesSave() {
    const n = ($("rzON").value || "").trim(); if (!n) { $("rzOErr").textContent = "Bitte einen Namen eingeben."; $("rzOErr").hidden = false; return; }
    const basis = document.querySelector('[data-obasis][aria-pressed="true"]').dataset.obasis;
    const val = (id) => { const x = N.parseNum($(id).value); return x == null || x < 0 || x > 1000 ? null : x; };
    applyPick({ n, a: 100, u: basis, g: 100, basis, v: [val("rzOK"), val("rzOP"), val("rzOF"), val("rzOC")], src: "own" });
  }
  function scanIngredient() {
    if (!window.Scanner || !window.Scanner.pick) return;
    st.hideForScan = true; $("rzSheet").hidden = true;
    window.Scanner.pick((ing) => { st.hideForScan = false; openSheet(); applyPick(ing); });
  }

  /* ---------- Bildschirm anlassen ---------- */
  async function toggleWake() {
    if (st.wake) { releaseWake(); return detailView(); }
    try { st.wake = await navigator.wakeLock.request("screen"); st.wake.addEventListener("release", () => { st.wake = null; }); } catch (_) { st.wake = null; window.appToast && window.appToast("Bildschirm anlassen wird hier nicht unterstützt"); }
    detailView();
  }
  function releaseWake() { if (st.wake) { try { st.wake.release(); } catch (_) {} st.wake = null; } }

  /* ---------- Ereignisse ---------- */
  function onSheetClick(e) {
    const t = e.target.closest("[data-rz],[data-chk],[data-eat],[data-ecat],[data-dcat],[data-dflag],[data-hit],[data-obasis]");
    if (!t) { if (e.target.id === "rzSheet") close(); return; }
    if (t.dataset.chk != null) { const k = +t.dataset.chk; st.checked.has(k) ? st.checked.delete(k) : st.checked.add(k); t.parentNode.classList.toggle("done"); t.setAttribute("aria-pressed", String(st.checked.has(k))); return; }
    if (t.dataset.eat) { st.eat = +t.dataset.eat; return eatView(); }
    if (t.dataset.ecat) { st.cat = t.dataset.ecat; return eatView(); }
    if (t.dataset.dcat) { const c = st.edit.cat || (st.edit.cat = []); const i = c.indexOf(t.dataset.dcat); i >= 0 ? c.splice(i, 1) : c.push(t.dataset.dcat); t.setAttribute("aria-pressed", String(i < 0)); return; }
    if (t.dataset.dflag) { const k = t.dataset.dflag; st.edit[k] = !st.edit[k]; if (k === "vegan" && st.edit.vegan) st.edit.veg = true; return editView(); }
    if (t.dataset.hit != null) { const r = pickRows[+t.dataset.hit]; if (r) applyPick(hitToIng(r)); return; }
    if (t.dataset.obasis) { document.querySelectorAll("[data-obasis]").forEach((b) => b.setAttribute("aria-pressed", String(b === t))); return; }
    const a = t.dataset.rz; const i = t.dataset.i == null ? null : +t.dataset.i;
    if (a === "close") close();
    else if (a === "minus") { st.cookS = Math.max(1, st.cookS - 1); detailView(); }
    else if (a === "plus") { st.cookS = Math.min(24, st.cookS + 1); detailView(); }
    else if (a === "eat") { st.mealId = null; eatView(); }
    else if (a === "eminus") { st.eat = Math.max(0.5, st.eat - 0.5); eatView(); }
    else if (a === "eplus") { st.eat = Math.min(10, st.eat + 0.5); eatView(); }
    else if (a === "save-eat") saveEat();
    else if (a === "back") { st.mealId = null; detailView(); }
    else if (a === "fav") toggleFav(st.r.id);
    else if (a === "edit") startEdit(st.r, "edit");
    else if (a === "variant") startEdit(st.r, "variant");
    else if (a === "dup") duplicate();
    else if (a === "del") remove();
    else if (a === "wake") toggleWake();
    else if (a === "save-edit") saveEdit();
    else if (a === "cancel-edit") { const d = st.edit; st.edit = null; if (!d.isNew && byId(d.id)) openRecipe(d.id); else if (d.basedOn && byId(d.basedOn)) openRecipe(d.basedOn); else close(); }
    else if (a === "irm") { st.edit.ing.splice(i, 1); editView(); }
    else if (a === "remap") pickView(i);
    else if (a === "add-search") pickView(null);
    else if (a === "add-scan") scanIngredient();
    else if (a === "add-own") { if (st.view !== "pick") st.pickFor = null; ownValuesView(); }
    else if (a === "own-save") ownValuesSave();
    else if (a === "back-edit") { st.pickFor = null; editView(); }
  }
  let pickTimer = null;
  function onSheetInput(e) {
    if (e.target.id === "rzPickQ") { clearTimeout(pickTimer); const v = e.target.value; pickTimer = setTimeout(() => searchPick(v), 200); return; }
    if (e.target.id === "rzDate") { st.date = e.target.value || today(); return; }
    if (st.view === "edit") onEditInput(e);
  }
  function onListClick(e) {
    const fav = e.target.closest("[data-fav]"); if (fav) return toggleFav(fav.dataset.fav);
    const o = e.target.closest("[data-open]"); if (o) return openRecipe(o.dataset.open);
    if (e.target.closest("[data-retry]")) { libP = null; loaded = false; return ensureLoaded(); }
    if (e.target.closest("[data-reset]")) { Object.assign(F, { q: "", cat: "", fav: false, own: false, veg: false, vegan: false, hp: false, time: 0, kcal: 0, excl: "" }); ["rzQ", "rzExcl"].forEach((id) => ($(id).value = "")); $("rzTime").value = "0"; $("rzKcal").value = "0"; saveFilters(); shown = PAGE; renderList(); }
  }

  function init() {
    if (!$("rezApp")) return;
    document.body.insertAdjacentHTML("beforeend", sheet());
    const sh = $("rzSheet");
    sh.addEventListener("click", onSheetClick);
    sh.addEventListener("input", onSheetInput);
    sh.addEventListener("change", (e) => { if (e.target.tagName === "SELECT" || e.target.type === "checkbox") onSheetInput(e); });
    sh.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
    loadFilters();
    $("rzQ").addEventListener("input", (e) => { F.q = e.target.value; shown = PAGE; renderList(); });
    $("rzCats").addEventListener("click", (e) => { const b = e.target.closest("[data-rcat]"); if (!b) return; F.cat = b.dataset.rcat === F.cat ? "" : b.dataset.rcat; shown = PAGE; renderList(); });
    $("rzTog").addEventListener("click", (e) => { const b = e.target.closest("[data-tog]"); if (!b) return; const k = b.dataset.tog; F[k] = !F[k]; if (k === "vegan" && F.vegan) F.veg = false; if (k === "veg" && F.veg) F.vegan = false; shown = PAGE; renderList(); });
    $("rzTime").addEventListener("change", (e) => { F.time = +e.target.value; shown = PAGE; renderList(); });
    $("rzKcal").addEventListener("change", (e) => { F.kcal = +e.target.value; shown = PAGE; renderList(); });
    $("rzSort").value = F.sort; $("rzSort").addEventListener("change", (e) => { F.sort = e.target.value; saveFilters(); renderList(); });
    $("rzExcl").value = F.excl; $("rzExcl").addEventListener("input", (e) => { F.excl = e.target.value; saveFilters(); shown = PAGE; renderList(); });
    $("rzMore").addEventListener("click", () => { shown += PAGE; renderList(); });
    $("rzNew").addEventListener("click", () => { openSheet(); startEdit(null); });
    $("rzList").addEventListener("click", onListClick);
    // Scanner geschlossen ohne Auswahl → Rezept-Blatt wieder zeigen
    const scan = $("scanSheet");
    if (scan) new MutationObserver(() => { if (scan.hidden && st.hideForScan) { st.hideForScan = false; openSheet(); } }).observe(scan, { attributes: true, attributeFilter: ["hidden"] });
    document.addEventListener("visibilitychange", () => { if (!document.hidden && st.wake === null && st.view === "detail" && $("rzSheet") && !$("rzSheet").hidden && document.querySelector('[data-rz="wake"][aria-pressed="true"]')) toggleWake(); });
    // Rezeptdaten erst laden, wenn der Tab geöffnet wird
    const tab = document.querySelector('#ftabs [data-t="rezepte"]');
    if (tab) tab.addEventListener("click", () => ensureLoaded());
    if (!$("s-rezepte").hidden) ensureLoaded();
    window.claude.use("db").then((d) => { db = d; if (loaded) loadOwn().then(renderList).catch(() => {}); });
  }

  window.Recipes = { init, open: openRecipe, ensureLoaded, _state: st, _filters: F };
})();
