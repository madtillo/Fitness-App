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

  const api = { KEYS, EXTRA, parseNum, validAmount, eanValid, cleanCode, parseQuantity, normalizeOff, effective, unitOptions, calc, makeEntry, fmt, fmtQty, r1, KJ_PER_KCAL };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Nutri = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
