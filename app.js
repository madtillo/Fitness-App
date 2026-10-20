/* Rahmen der eigenständigen App: Rückmeldungen, Daten-Menü (Sicherung/Umzug), Offline-Betrieb. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const VERSION = "1.0.1";

  function toast(msg) {
    const t = $("appToast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2800);
  }
  window.appToast = toast;

  /* ---------- Daten-Menü ---------- */
  function dataSheet() {
    return `<div id="dataSheet" hidden role="dialog" aria-modal="true" aria-labelledby="dtTitle"><div class="sc-sheet">
  <div class="sc-head"><b id="dtTitle">Daten & Sicherung</b><button type="button" class="sc-x" data-dt="close" aria-label="Schließen">✕</button></div>
  <div class="sc-body">
    <div class="dt-card"><h3>Sicherung exportieren</h3>
      <p>Speichert alle Trainings, Morgen-/Wochen-Checks, Ernährung und deine Produktsammlung in einer Datei. Mach das ab und zu – und schick sie Claude für Auswertungen.</p>
      <button type="button" class="sc-btn primary" data-dt="export">Sicherung erstellen</button></div>
    <div class="dt-card"><h3>Sicherung / Umzugsdatei importieren</h3>
      <p>Ergänzt fehlende Einträge. Was schon auf dem Gerät ist, wird nicht überschrieben.</p>
      <button type="button" class="sc-btn" data-dt="import">Datei auswählen</button>
      <input type="file" id="dtFile" accept="application/json,.json" hidden>
      <p id="dtResult" role="status"></p></div>
    <div class="dt-card"><h3>Speicher</h3><p id="dtInfo">…</p></div>
    <div class="dt-card"><h3>Über die App</h3>
      <p>Version ${VERSION}. Deine Daten liegen nur auf diesem Gerät. Beim Scannen wird nur die Barcode-Nummer an Open Food Facts geschickt, nie ein Bild.</p>
      <p>Produktdaten: <a href="https://world.openfoodfacts.org" target="_blank" rel="noopener">Open Food Facts</a> – Datenbank unter ODbL, Produktbilder unter CC BY-SA. Scanner: zxing-cpp / barcode-detector (MIT/Apache-2.0).</p></div>
  </div></div></div>`;
  }

  async function showInfo() {
    const parts = [];
    try {
      const ex = await window.LocalDB.exportAll();
      const c = ex.collections;
      parts.push(`${c.sessions.length} Trainings · ${c.daily.length} Morgen-Checks · ${c.weekly.length} Wochen-Checks · ${c.food.length} Ernährungstage · ${c.products.length} Produkte`);
    } catch (_) {}
    try {
      if (navigator.storage && navigator.storage.persisted) parts.push((await navigator.storage.persisted()) ? "Dauerhafter Speicher: aktiv" : "Dauerhafter Speicher: nicht bestätigt – regelmäßig sichern");
    } catch (_) {}
    $("dtInfo").textContent = parts.join(" · ") || "–";
  }

  async function doExport() {
    const data = await window.LocalDB.exportAll();
    const d = new Date(); const pad = (n) => String(n).padStart(2, "0");
    const name = `tills-fitness-sicherung-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
    const file = new File([blob], name, { type: "application/json" });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: "Tills Fitness Sicherung" }); toast("Sicherung erstellt"); return; }
    } catch (e) { if (e && e.name === "AbortError") return; }
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast("Sicherung gespeichert");
  }

  async function doImport(file) {
    const out = $("dtResult"); out.textContent = "Wird importiert …";
    try {
      const json = JSON.parse(await file.text());
      const s = await window.LocalDB.importAll(json);
      const names = { sessions: "Trainings", daily: "Morgen-Checks", weekly: "Wochen-Checks", food: "Ernährungstage", products: "Produkte" };
      out.textContent = "Fertig: " + Object.entries(s).map(([k, v]) => `${v.added} ${names[k]} neu${v.kept ? ` (${v.kept} schon vorhanden)` : ""}`).join(" · ");
      showInfo();
    } catch (e) { out.textContent = "Import fehlgeschlagen: " + (e && e.message ? e.message : "Datei nicht lesbar"); }
  }

  function openData() { $("dataSheet").hidden = false; document.body.style.overflow = "hidden"; $("dtResult").textContent = ""; showInfo(); }
  function closeData() { $("dataSheet").hidden = true; document.body.style.overflow = ""; }

  /* ---------- Offline / Updates ---------- */
  function registerSW() {
    if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
    navigator.serviceWorker.register("sw.js").then((reg) => {
      reg.addEventListener("updatefound", () => {
        const nw = reg.installing; if (!nw) return;
        nw.addEventListener("statechange", () => {
          if (nw.state === "installed" && navigator.serviceWorker.controller) {
            if ($("updBar")) return;
            document.body.insertAdjacentHTML("beforeend", `<div id="updBar" role="status"><span>Neue Version verfügbar</span><button type="button" id="updGo">Neu laden</button></div>`);
            $("updGo").onclick = () => { nw.postMessage("skipWaiting"); };
          }
        });
      });
    }).catch(() => {});
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (!reloaded) { reloaded = true; location.reload(); } });
  }

  function init() {
    document.body.insertAdjacentHTML("beforeend", dataSheet() + `<div id="appToast" role="status" hidden></div>`);
    const top = document.querySelector(".shell-top");
    if (top) top.insertAdjacentHTML("beforeend", `<button type="button" class="topbtn" id="dtOpen" aria-label="Daten und Sicherung"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="5.5" rx="7.5" ry="2.8"/><path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8"/></svg></button>`);
    $("dtOpen").addEventListener("click", openData);
    $("dataSheet").addEventListener("click", (e) => {
      if (e.target.id === "dataSheet") return closeData();
      const b = e.target.closest("[data-dt]"); if (!b) return;
      if (b.dataset.dt === "close") closeData();
      else if (b.dataset.dt === "export") doExport().catch(() => toast("Export fehlgeschlagen"));
      else if (b.dataset.dt === "import") { $("dtFile").value = ""; $("dtFile").click(); }
    });
    $("dtFile").addEventListener("change", (e) => { const f = e.target.files && e.target.files[0]; if (f) doImport(f); });
    window.Scanner.init();
    window.LocalDB.persist();
    registerSW();
  }
  window.AppShell = { init, toast, VERSION };
})();
