/* Nährwert-Logik: reine Funktionen ohne Oberfläche, damit sie automatisch testbar sind.
   Grundregeln:
   - Fehlende Werte bleiben null (nie stillschweigend 0).
   - Gramm und Milliliter werden nie gleichgesetzt.
   - Portion/Packung nur, wenn die Menge dafür bekannt ist.
   - Gerundet wird erst für die Anzeige (Speicherung mit 1 Nachkommastelle). */
(function (root) {
  "use strict";

  const KEYS = ["kcal", "p", "c", "f"];            // Pflichtfelder der App
  const EXTRA = ["sugar", "fiber", "salt"];         // nur zur Anzeige im Produkt
  const ALL = KEYS.concat(EXTRA);
  const KJ_PER_KCAL = 4.184;
  const MAX_AMOUNT = 5000;                          // g/ml bzw. Stück – Schutz vor Tippfehlern

  /* Deutsche Eingabe: "125,5" → 125.5. Leer/ungültig → null. */
  function parseNum(v) {
    if (v == null) return null;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    let s = String(v).trim().replace(/\s/g, "");
    if (s === "") return null;
    if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, ""); // 1.250,5
    s = s.replace(",", ".");
    if (!/^-?\d*\.?\d+$/.test(s) && !/^-?\d+\.$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  /* Gültige verzehrte Menge: > 0 und nicht absurd groß. */
  function validAmount(n) {
    return typeof n === "number" && Number.isFinite(n) && n > 0 && n <= MAX_AMOUNT;
  }

  /* Prüfziffer für EAN-8, UPC-A (12) und EAN-13. Barcodes bleiben immer Strings. */
  function eanValid(code) {
    if (typeof code !== "string" || !/^\d+$/.test(code)) return false;
    if (![8, 12, 13].includes(code.length)) return false;
    const d = code.split("").map(Number);
    const check = d.pop();
    let sum = 0;
    // von rechts: Gewicht 3, 1, 3, …
    for (let i = d.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += d[i] * w;
    return (10 - (sum % 10)) % 10 === check;
  }

  function cleanCode(raw) {
    return String(raw == null ? "" : raw).replace(/\D/g, "");
  }

  const num = (v) => {
    if (v == null || v === "") return null;
    const n = typeof v === "number" ? v : parseNum(v);
    return n == null || !Number.isFinite(n) || n < 0 ? null : n;
  };

  /* Menge aus Texten wie "500 g", "1,5 l", "33 cl", "6 x 125 g" (nur Gesamtmenge, wenn eindeutig). */
  function parseQuantity(text) {
    if (!text) return null;
    const t = String(text).toLowerCase().replace(",", ".");
    const m = t.match(/(\d+(?:\.\d+)?)\s*(kg|g|mg|l|cl|ml)\b/);
    if (!m) return null;
    if (/\d\s*[x×*]\s*\d/.test(t)) return null; // Mehrfachpackung → nicht raten
    let q = Number(m[1]); const u = m[2];
    if (u === "kg") return { qty: q * 1000, unit: "g" };
    if (u === "g") return { qty: q, unit: "g" };
    if (u === "mg") return { qty: q / 1000, unit: "g" };
    if (u === "l") return { qty: q * 1000, unit: "ml" };
    if (u === "cl") return { qty: q * 10, unit: "ml" };
    return { qty: q, unit: "ml" };
  }

  function unitNorm(u, qty) {
    if (!u) return null;
    u = String(u).toLowerCase().trim();
    if (u === "g" || u === "gr" || u === "gramm") return { unit: "g", f: 1 };
    if (u === "kg") return { unit: "g", f: 1000 };
    if (u === "ml") return { unit: "ml", f: 1 };
    if (u === "cl") return { unit: "ml", f: 10 };
    if (u === "l" || u === "liter") return { unit: "ml", f: 1000 };
    return null;
  }

  /* Nährwertsatz aus OFF-nutriments mit Suffix (_100g, _serving, _prepared_100g). */
  function readSet(n, suffix) {
    const kcal = num(n["energy-kcal" + suffix]);
    const kj = num(n["energy-kj" + suffix]) ?? num(n["energy" + suffix]); // OFF: "energy" ist kJ
    const out = {
      kcal, p: num(n["proteins" + suffix]), c: num(n["carbohydrates" + suffix]), f: num(n["fat" + suffix]),
      sugar: num(n["sugars" + suffix]), fiber: num(n["fiber" + suffix]), salt: num(n["salt" + suffix])
    };
    let fromKj = false;
    if (out.kcal == null && kj != null) { out.kcal = kj / KJ_PER_KCAL; fromKj = true; }
    const any = ALL.some((k) => out[k] != null);
    return any ? { set: out, fromKj } : null;
  }

  /* Open-Food-Facts-Produkt → Produktmodell der App. Keine Werte werden erfunden. */
  function normalizeOff(code, p) {
    const n = (p && p.nutriments) || {};
    // Bezugseinheit: Getränke sind bei OFF "pro 100 ml", obwohl das Feld _100g heißt.
    let basis = null, basisSure = false;
    const pqU = unitNorm(p.product_quantity_unit);
    const q = parseQuantity(p.quantity);
    if (pqU) { basis = pqU.unit; basisSure = true; }
    else if (q) { basis = q.unit; basisSure = true; }
    else { basis = "g"; basisSure = false; }

    const s100 = readSet(n, "_100g");
    const sSrv = readSet(n, "_serving");
    const sPrep = readSet(n, "_prepared_100g");

    // Portionsgröße nur übernehmen, wenn sie in derselben Einheit wie die Bezugsmenge vorliegt.
    let servingQty = null;
    const sq = num(p.serving_quantity);
    const squ = unitNorm(p.serving_quantity_unit);
    const sParsed = parseQuantity(p.serving_size);
    if (sq && sq > 0 && squ) { if (squ.unit === basis) servingQty = sq * squ.f; }
    else if (sq && sq > 0 && sParsed && sParsed.unit === basis) servingQty = sq;   // OFF gibt serving_quantity in g bzw. ml an
    else if (!sq && sParsed && sParsed.unit === basis) servingQty = sParsed.qty;

    // Packungsgröße
    let packQty = null;
    const pq = num(p.product_quantity);
    if (pq && pq > 0 && pqU) { if (pqU.unit === basis) packQty = pq * pqU.f; }
    else if (q && q.unit === basis) packQty = q.qty;

    return {
      code: String(code),
      name: (p.product_name_de || p.product_name || "").trim() || null,
      brand: (p.brands || "").split(",")[0].trim() || null,
      imageUrl: p.image_front_small_url || null,
      basis, basisSure,
      per100: s100 ? s100.set : null,
      perServing: sSrv ? sSrv.set : null,
      prepared100: sPrep ? sPrep.set : null,
      kcalFromKj: !!((s100 && s100.fromKj) || (!s100 && sSrv && sSrv.fromKj)),
      servingQty, servingLabel: p.serving_size || null,
      packQty, quantityLabel: p.quantity || null,
      source: "off"
    };
  }

  /* Persönliche Korrekturen (custom) liegen über den OFF-Daten und werden nie überschrieben. */
  function effective(prod) {
    if (!prod) return null;
    const c = prod.custom || {};
    const e = Object.assign({}, prod);
    ["name", "brand", "basis", "servingQty", "packQty"].forEach((k) => { if (c[k] !== undefined) e[k] = c[k]; });
    if (c.basis !== undefined) e.basisSure = true;
    if (c.per100) {
      e.per100 = Object.assign({}, prod.per100 || {}, c.per100);
      if (c.per100.kcal !== undefined) e.kcalFromKj = false;
    }
    e.corrected = !!prod.custom;
    return e;
  }

  const unitWord = (b) => (b === "ml" ? "ml" : "g");

  /* Welche Mengeneinheiten sind sicher berechenbar? */
  function unitOptions(prod, usePrepared) {
    const e = effective(prod);
    const per = usePrepared ? e.prepared100 : e.per100;
    const opts = [];
    if (per) opts.push({ key: "base", label: unitWord(e.basis), size: 1 });
    if (e.servingQty && per) opts.push({ key: "portion", label: "Portion (" + fmtQty(e.servingQty) + " " + unitWord(e.basis) + ")", size: e.servingQty });
    else if (!usePrepared && e.perServing) opts.push({ key: "portion", label: "Portion" + (e.servingLabel ? " (" + e.servingLabel + ")" : ""), size: null });
    if (e.packQty && per) opts.push({ key: "pack", label: "Packung (" + fmtQty(e.packQty) + " " + unitWord(e.basis) + ")", size: e.packQty });
    return opts;
  }

  /* Kern der Berechnung. amount = Anzahl in der gewählten Einheit. */
  function calc(prod, unitKey, amount, usePrepared) {
    if (!validAmount(amount)) return { ok: false, error: "Bitte eine gültige Menge eingeben (größer als 0)." };
    const e = effective(prod);
    const per = usePrepared ? e.prepared100 : e.per100;
    const opt = unitOptions(prod, usePrepared).find((o) => o.key === unitKey);
    if (!opt) return { ok: false, error: "Diese Einheit ist für das Produkt nicht berechenbar." };
    let values, qty = null, factor;
    if (opt.size == null) {           // nur Werte pro Portion bekannt, Portionsgröße unbekannt
      values = e.perServing; factor = amount; qty = null;
    } else {
      qty = amount * opt.size;        // g bzw. ml
      values = per; factor = qty / 100;
    }
    const out = {};
    ALL.forEach((k) => { out[k] = values[k] == null ? null : values[k] * factor; });
    const missing = KEYS.filter((k) => out[k] == null);
    return { ok: true, qty, unit: unitWord(e.basis), values: out, missing, basis: opt.size == null ? "serving" : "100" + unitWord(e.basis) };
  }

  const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
  function fmtQty(v) { return v == null ? "–" : String(r1(v)).replace(".", ","); }
  function fmt(v, digits) {
    if (v == null) return "fehlt";
    const d = digits == null ? 1 : digits;
    return v.toLocaleString("de-DE", { minimumFractionDigits: 0, maximumFractionDigits: d });
  }

  /* Eintrag für den Tag: Werte als Momentaufnahme, damit spätere Korrekturen alte Tage nicht ändern. */
  function makeEntry(prod, unitKey, amount, usePrepared) {
    const e = effective(prod);
    const res = calc(prod, unitKey, amount, usePrepared);
    if (!res.ok) return res;
    const one = amount === 1;
    const inQty = res.qty != null ? " (" + fmtQty(res.qty) + " " + res.unit + ")" : "";
    const amountLabel = unitKey === "base" ? fmtQty(amount) + " " + res.unit
      : unitKey === "portion" ? fmtQty(amount) + (one ? " Portion" : " Portionen") + inQty
      : fmtQty(amount) + (one ? " Packung" : " Packungen") + inQty;
    const name = [e.brand, e.name].filter(Boolean).join(" ") || "Produkt " + e.code;
    return {
      ok: true,
      entry: {
        name: name + " · " + amountLabel + (usePrepared ? " · zubereitet" : ""),
        kcal: r1(res.values.kcal), p: r1(res.values.p), f: r1(res.values.f), c: r1(res.values.c),
        src: "barcode", code: e.code, amount, unitKey, qty: res.qty == null ? null : r1(res.qty), unit: res.unit,
        basis: res.basis, prepared: !!usePrepared, amountLabel
      }
    };
  }

  /* ================= Foto-Mahlzeiten =================
     Grundsatz: Die KI liefert nur WAS (Name, Zustand) und WIE VIEL (geschätzte Gramm).
     Nährwerte pro 100 g kommen bevorzugt aus der BLS-Datenbank; KI-Richtwerte nur als markierter Ersatz. */
  const STATES = ["roh", "gegart", "zubereitet", "unbekannt"];
  const CONF = ["hoch", "mittel", "niedrig"];
  const MAX_ITEMS = 12, MAX_Q = 3, MAX_OPT = 4;
  const str = (v, n) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n || 80) : "");
  const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" ? parseNum(v) : null);
  const clamp = (v, lo, hi) => (v == null || v < lo || v > hi ? null : v);

  /* Nährwerte pro 100 g plausibel? (kcal 0–900, Makros 0–100 g, Summe Makros ≤ 105 g) */
  function validPer100(o) {
    if (!o) return null;
    const v = { kcal: clamp(finite(o.kcal), 0, 900), p: clamp(finite(o.p), 0, 100), c: clamp(finite(o.c), 0, 100), f: clamp(finite(o.f), 0, 100) };
    if (KEYS.some((k) => v[k] == null)) return null;
    if (v.p + v.c + v.f > 105) return null;
    return v;
  }

  /* KI-Antwort prüfen und bereinigen. Alles Unplausible fliegt raus statt geraten zu werden. */
  function mealValidate(raw) {
    let o = raw;
    if (typeof o === "string") { try { o = JSON.parse(o); } catch (_) { return { ok: false, error: "Die Antwort der KI war nicht lesbar." }; } }
    if (!o || typeof o !== "object") return { ok: false, error: "Die Antwort der KI war leer." };
    const isFood = o.is_food === true;
    const items = [];
    (Array.isArray(o.items) ? o.items : []).slice(0, MAX_ITEMS).forEach((it) => {
      if (!it || typeof it !== "object") return;
      const name = str(it.name, 60); if (!name) return;
      let g = clamp(finite(it.grams_estimate), 1, 2000); if (g == null) return;
      let gmin = clamp(finite(it.grams_min), 0, 2000), gmax = clamp(finite(it.grams_max), 0, 3000);
      if (gmin == null || gmin > g) gmin = null; if (gmax == null || gmax < g) gmax = null;
      const state = STATES.includes(it.state) ? it.state : "unbekannt";
      items.push({
        name, state, grams: Math.round(g), gramsMin: gmin == null ? null : Math.round(gmin), gramsMax: gmax == null ? null : Math.round(gmax),
        confidence: CONF.includes(it.confidence) ? it.confidence : "niedrig",
        visible: it.visible !== false,
        terms: (Array.isArray(it.search_terms) ? it.search_terms : []).map((t) => str(t, 40)).filter(Boolean).slice(0, 5),
        aiPer100: validPer100({ kcal: it.kcal_per_100g, p: it.protein_per_100g, c: it.carbs_per_100g, f: it.fat_per_100g })
      });
    });
    const questions = [];
    (Array.isArray(o.questions) ? o.questions : []).slice(0, MAX_Q).forEach((q, qi) => {
      const text = str(q && q.text, 140); if (!text) return;
      const options = (Array.isArray(q.options) ? q.options : []).slice(0, MAX_OPT).map((op) => {
        const label = str(op && op.label, 50); if (!label) return null;
        const add = op.add_item && str(op.add_item.name, 60) ? {
          name: str(op.add_item.name, 60), grams: clamp(finite(op.add_item.grams), 1, 300),
          state: "zubereitet", terms: [str(op.add_item.name, 40)],
          aiPer100: validPer100({ kcal: op.add_item.kcal_per_100g, p: op.add_item.protein_per_100g, c: op.add_item.carbs_per_100g, f: op.add_item.fat_per_100g })
        } : null;
        if (add && add.grams == null) return null;
        return { label, add };
      }).filter(Boolean);
      if (options.length >= 2) questions.push({ id: "q" + qi, text, options });
    });
    if (isFood && !items.length) return { ok: true, isFood: false, message: "Auf dem Foto wurde kein Essen sicher erkannt.", items: [], questions: [] };
    return { ok: true, isFood: isFood && items.length > 0, dish: str(o.dish, 60), message: str(o.message, 200), items, questions };
  }

  /* Werte eines Bestandteils für seine Grammzahl. Fehlende Bezugswerte → null (nie 0). */
  function mealItemValues(item) {
    const g = typeof item.grams === "number" && item.grams > 0 ? item.grams : null;
    const per = item.per100;
    const out = {};
    KEYS.forEach((k) => { out[k] = g == null || !per || per[k] == null ? null : (per[k] * g) / 100; });
    return out;
  }

  /* Summe der Mahlzeit × gegessener Anteil. complete=false, sobald irgendwo ein Wert fehlt. */
  function mealTotals(items, fraction) {
    const fr = typeof fraction === "number" && fraction > 0 && fraction <= 1 ? fraction : 1;
    const t = { kcal: 0, p: 0, c: 0, f: 0 }; const missing = [];
    items.forEach((it, i) => { const v = mealItemValues(it); KEYS.forEach((k) => { if (v[k] == null) { if (!missing.includes(i)) missing.push(i); } else t[k] += v[k]; }); });
    KEYS.forEach((k) => (t[k] = t[k] * fr));
    return { values: t, complete: missing.length === 0 && items.length > 0, missing, fraction: fr };
  }

  /* Eintrag für die Tagesliste (Momentaufnahme inkl. aller Bestandteile, damit er später bearbeitbar ist). */
  function makeMealEntry(meal) {
    const tot = mealTotals(meal.items, meal.fraction);
    if (!meal.items.length) return { ok: false, error: "Die Mahlzeit hat keine Bestandteile." };
    if (!tot.complete) return { ok: false, error: "Bei mindestens einem Bestandteil fehlen Nährwerte oder die Menge." };
    const names = meal.items.map((i) => i.name);
    const title = (meal.title && meal.title.trim()) || (names.slice(0, 3).join(", ") + (names.length > 3 ? " …" : ""));
    const pct = Math.round(tot.fraction * 100);
    return { ok: true, entry: {
      name: "📷 " + title + (pct < 100 ? " · " + pct + " %" : ""),
      kcal: r1(tot.values.kcal), p: r1(tot.values.p), f: r1(tot.values.f), c: r1(tot.values.c),
      src: "photo", mealId: meal.mealId, cat: meal.cat || null, fraction: tot.fraction, estimated: true,
      items: meal.items.map((i) => ({ name: i.name, grams: i.grams, state: i.state || "unbekannt", per100: i.per100, source: i.source || "ki", blsCode: i.blsCode || null, blsName: i.blsName || null }))
    } };
  }

  /* Suche in der Nährwert-Datenbank (BLS). Zeilen: [code, name, kcal, p, f, c]. */
  const norm = (s) => String(s || "").toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const COOKED = ["gekocht", "gegart", "gebraten", "geduenstet", "gegrillt", "gebacken", "zubereitet", "gedaempft", "geschmort", "pochiert"];
  /* Alltagswörter → Schreibweise im BLS (z. B. "Nudeln" heißen dort "Teigwaren") */
  const SYN = {
    brokkoli: "broccoli", nudeln: "teigwaren", nudel: "teigwaren", pasta: "teigwaren", spaghetti: "teigwaren", penne: "teigwaren", fusilli: "teigwaren",
    haferflocken: "hafer flocken", hackfleisch: "rind hackfleisch", hack: "rind hackfleisch", rinderhack: "rind hackfleisch", rinderhackfleisch: "rind hackfleisch", schweinehack: "schwein hackfleisch", gemischtes: "schwein",
    magerquark: "speisequark magerstufe", quark: "speisequark", salat: "kopfsalat", blattsalat: "kopfsalat", gruener: "",
    haehnchenbrust: "haehnchen brust", haehnchenbrustfilet: "haehnchen brustfilet", huehnerbrust: "haehnchen brust", putenbrust: "pute brust",
    ei: "eier", eier: "eier", spiegelei: "spiegelei", ruehrei: "ruehrei", kartoffeln: "kartoffel", salzkartoffeln: "kartoffel gekocht",
    lachsfilet: "lachs", rindersteak: "rind", olivenoel: "olivenoel", sahne: "schlagsahne", joghurt: "joghurt", tomaten: "tomate", moehren: "moehre", karotten: "moehre", karotte: "moehre", paprika: "paprika"
  };
  const expand = (words) => words.flatMap((w) => (SYN[w] != null ? SYN[w].split(" ").filter(Boolean) : [w]));
  function foodSearch(rows, query, opts) {
    opts = opts || {};
    const qWords = expand(norm(query).split(" ").filter((w) => w.length > 1));
    if (!rows || !qWords.length) return [];
    const qFull = qWords.join(" ");
    const extra = expand((opts.terms || []).map(norm).join(" ").split(" ").filter((w) => w.length > 2));
    const out = [];
    for (const r of rows) {
      const n = r._n || (r._n = norm(r[1]));
      const toks = r._t || (r._t = n.split(" "));
      let s = 0, hits = 0;
      for (const w of qWords) { if (n.includes(w)) { hits++; s += toks[0].startsWith(w) ? 6 : 3; if (toks.includes(w)) s += 3; } }
      let xh = 0;
      for (const w of extra) if (n.includes(w)) { xh++; s += toks.includes(w) ? 3 : 2; }
      if (!hits && !xh) continue;
      if (hits === qWords.length) s += 4;
      if (n.startsWith(qFull)) s += 8;                       // Grundlebensmittel zuerst ("Reis ..." vor "Reisnudeln ...")
      if (toks[0] === qWords[0]) s += 4;
      const cooked = COOKED.some((c) => n.includes(c));
      if (opts.state === "gegart" || opts.state === "zubereitet") s += cooked ? 3 : 0;
      if (opts.state === "roh") s += cooked ? -3 : (n.includes("roh") ? 3 : 1);
      if (/ mit | in /.test(" " + n + " ") && !/ mit | in /.test(" " + qFull + " ")) s -= 5; // Gerichte nach hinten
      s -= n.length / 40;                                   // kürzere, allgemeinere Namen bevorzugen
      out.push([s, r]);
    }
    return out.sort((a, b) => b[0] - a[0]).slice(0, opts.limit || 8).map((x) => x[1]);
  }


  /* ================= Rezepte =================
     Zutat: { n, a, u, g, v:[kcal,p,f,c] pro 100 g bzw. 100 ml, basis, x }  g = Menge in g (bzw. ml bei basis "ml") für die Rechnung.
     x = 1: Gewürz/Kräuter in kleiner Menge – wird angezeigt, aber bewusst nicht eingerechnet.
     Fehlt g oder ein Wert in v, ist die Zutat „unvollständig“ – sie zählt NICHT als 0, das Rezept gilt dann als unvollständig. */
  const RKEYS = ["kcal", "p", "f", "c"];
  function ingValues(ing, factor) {
    if (!ing || ing.x) return null;
    const g = finite(ing.g);
    if (g == null || g < 0 || !Array.isArray(ing.v)) return { missing: true };
    const out = {}; let miss = false;
    RKEYS.forEach((k, i) => { const v = finite(ing.v[i]); if (v == null || v < 0) { out[k] = null; miss = true; } else out[k] = v * g * (factor || 1) / 100; });
    out.missing = miss; return out;
  }
  /* Gesamtwerte für das Rezept, skaliert mit factor (= zubereitete Portionen / Grundportionen). */
  function recipeTotals(recipe, factor) {
    const f = typeof factor === "number" && factor > 0 ? factor : 1;
    const t = { kcal: 0, p: 0, f: 0, c: 0 }; const missing = []; let counted = 0, spices = 0;
    (recipe && recipe.ing || []).forEach((ing, i) => {
      if (ing.x) { spices++; return; }
      const v = ingValues(ing, f);
      if (!v || v.missing) { missing.push(i); }
      if (v) RKEYS.forEach((k) => { if (v[k] != null) t[k] += v[k]; });
      counted++;
    });
    return { total: t, complete: missing.length === 0 && counted > 0, missing, counted, spices };
  }
  /* Werte für EINE Portion – unabhängig davon, wie viele Portionen zubereitet werden. */
  function recipePerServing(recipe) {
    const s = finite(recipe && recipe.s);
    const r = recipeTotals(recipe, 1);
    const per = {}; RKEYS.forEach((k) => (per[k] = s > 0 ? r.total[k] / s : null));
    return { per, complete: r.complete && s > 0, missing: r.missing };
  }
  /* Proteinreich: mind. 25 g Eiweiß pro Portion UND mind. 25 % der Kalorien aus Eiweiß (1 g Eiweiß = 4 kcal). */
  function isHighProtein(per) { return !!per && per.p >= 25 && per.kcal > 0 && (per.p * 4) / per.kcal >= 0.25; }

  /* Mengen sinnvoll runden: g/ml nach Größe, Stück/EL/TL auf Viertel. Keine Umrechnung zwischen Einheiten. */
  const FRAC = { 0.25: "¼", 0.5: "½", 0.75: "¾" };
  function roundAmount(a, unit) {
    const v = finite(a); if (v == null) return null;
    if (unit === "g" || unit === "ml") return v < 10 ? Math.round(v * 10) / 10 : v < 100 ? Math.round(v) : v < 500 ? Math.round(v / 5) * 5 : Math.round(v / 10) * 10;
    return Math.max(0.25, Math.round(v * 4) / 4);
  }
  function fmtAmount(a, unit) {
    const v = roundAmount(a, unit); if (v == null) return "";
    if (unit === "g" || unit === "ml") return String(v).replace(".", ",") + " " + unit;
    const whole = Math.floor(v), rest = Math.round((v - whole) * 100) / 100;
    const num = (whole ? String(whole) : "") + (FRAC[rest] ? (whole ? " " : "") + FRAC[rest] : rest ? String(rest).replace(".", ",") : "");
    return (num || "0") + (unit ? " " + unit : "");
  }
  function scaleIngredient(ing, factor) {
    const f = factor > 0 ? factor : 1;
    const a = finite(ing.a), g = finite(ing.g);
    return Object.assign({}, ing, { a: a == null ? null : a * f, g: g == null ? null : g * f });
  }

  /* Suche: Titel, Beschreibung und Zutaten; Umlaute und Groß-/Kleinschreibung egal. */
  function recipeText(r) { return r._s || (r._s = norm([r.t, r.d].concat((r.ing || []).map((i) => i.n)).join(" "))); }
  function recipeMatches(r, query) {
    const w = norm(query || "").split(" ").filter(Boolean);
    if (!w.length) return true;
    const txt = recipeText(r);
    return w.every((x) => txt.includes(x));
  }
  /* Ausgeschlossene Zutaten (kommagetrennt). Prüft nur Zutatennamen – keine Allergen-Garantie. */
  function recipeExcluded(r, excl) {
    const list = String(excl || "").split(/[,;]/).map((x) => norm(x)).filter((x) => x.length > 1);
    if (!list.length) return false;
    const names = (r.ing || []).map((i) => norm(i.n + " " + (i.bn || ""))).join(" | ");
    return list.some((x) => names.includes(x));
  }

  /* Tagebuch-Eintrag: Momentaufnahme der Werte. Spätere Rezeptänderungen ändern ihn nicht. */
  function makeRecipeEntry(recipe, portions, opts) {
    opts = opts || {};
    const n = finite(portions);
    if (n == null || n <= 0 || n > 20) return { ok: false, error: "Bitte eine gültige Portionszahl angeben (z. B. 1 oder 1,5)." };
    const ps = recipePerServing(recipe);
    if (!ps.complete) return { ok: false, error: "Bei mindestens einer Zutat fehlen Menge oder Nährwerte. Bitte im Rezept ergänzen." };
    const v = {}; RKEYS.forEach((k) => (v[k] = r1(ps.per[k] * n)));
    const per = {}; RKEYS.forEach((k) => (per[k] = r1(ps.per[k])));
    const pl = String(r1(n)).replace(".", ",") + (n === 1 ? " Portion" : " Portionen");
    return { ok: true, entry: Object.assign({ name: "🍽 " + recipe.t + " · " + pl, kcal: v.kcal, p: v.p, f: v.f, c: v.c, src: "recipe", recipeId: recipe.id, recipeTitle: recipe.t,
      portions: r1(n), per, mealId: opts.mealId || ("r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)) }, opts.cat ? { cat: opts.cat } : {}) };
  }

  /* Eigenes Rezept prüfen und bereinigen, bevor es gespeichert wird. */
  function cleanRecipe(r) {
    const t = str(r && r.t, 80);
    if (!t) return { ok: false, error: "Bitte einen Titel eingeben." };
    const s = finite(r.s); if (s == null || s <= 0 || s > 50) return { ok: false, error: "Bitte eine Portionszahl zwischen 1 und 50 angeben." };
    const ing = (Array.isArray(r.ing) ? r.ing : []).map((i) => {
      const o = { n: str(i.n, 80), a: finite(i.a), u: str(i.u, 20) || "g" };
      if (!o.n) return null;
      if (i.x) { o.x = 1; return o; }
      o.g = finite(i.g); if (o.g != null && (o.g < 0 || o.g > 20000)) o.g = null;
      o.basis = i.basis === "ml" ? "ml" : "g";
      o.v = Array.isArray(i.v) ? i.v.slice(0, 4).map((x) => { const v = finite(x); return v == null || v < 0 || v > 1000 ? null : v; }) : null;
      ["src", "b", "bn", "code"].forEach((k) => { if (i[k] != null) o[k] = String(i[k]).slice(0, 120); });
      return o;
    }).filter(Boolean);
    if (!ing.length) return { ok: false, error: "Bitte mindestens eine Zutat hinzufügen." };
    const st = (Array.isArray(r.st) ? r.st : []).map((x) => str(x, 600)).filter(Boolean);
    const cats = (Array.isArray(r.cat) ? r.cat : []).filter((c) => ["fruehstueck", "mittag", "abend", "snack"].includes(c));
    const num = (x) => { const v = finite(x); return v == null || v < 0 || v > 1440 ? null : Math.round(v); };
    return { ok: true, recipe: { id: String(r.id), t, d: str(r.d, 300), cat: cats, s, prep: num(r.prep), cook: num(r.cook), veg: !!r.veg, vegan: !!r.vegan, ing, st,
      own: true, basedOn: r.basedOn || null } };
  }

  const api = { KEYS, EXTRA, parseNum, validAmount, eanValid, cleanCode, parseQuantity, normalizeOff, effective, unitOptions, calc, makeEntry, fmt, fmtQty, r1, KJ_PER_KCAL,
    validPer100, mealValidate, mealItemValues, mealTotals, makeMealEntry, foodSearch, normText: norm,
    recipeTotals, recipePerServing, isHighProtein, roundAmount, fmtAmount, scaleIngredient, recipeMatches, recipeExcluded, makeRecipeEntry, cleanRecipe };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Nutri = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
