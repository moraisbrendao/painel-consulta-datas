// Lê a planilha da BASE (BI, aba Export) em segundo plano, para a tela não travar (mesma ideia do E-loggia antigo).
// Devolve as linhas já no formato de colunas (cols + rows), que é bem menor para enviar ao banco,
// e uma "impressão digital" (h) de cada linha: no envio só vão os pedidos que mudaram desde a última base.
/* global XLSX */
importScripts("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js");

const norm = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
const p2 = (n) => String(n).padStart(2, "0");
function dataCelula(v, comHora) {
  if (v === null || v === undefined || v === "") return null;
  let y, m, d, H = 0, M = 0, S = 0;
  if (typeof v === "number") {
    const c = XLSX.SSF.parse_date_code(v); if (!c) return null;
    ({ y, m, d, H, M } = c); S = Math.floor(c.S || 0);
  } else {
    const s = String(v).trim(); let r;
    if ((r = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/))) [, y, m, d, H = 0, M = 0, S = 0] = r;
    else if ((r = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?: (\d{1,2}):(\d{2})(?::(\d{2}))?)?/))) [, d, m, y, H = 0, M = 0, S = 0] = r;
    else return null;
  }
  if (Number(y) < 2000) return null;   // datas inválidas (ex.: 1926)
  const dt = `${y}-${p2(m)}-${p2(d)}`;
  return comHora ? `${dt}T${p2(H)}:${p2(M)}:${p2(S)}` : dt;
}
// hash rápido (cyrb53) do texto da linha
function hash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) { const ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

self.onmessage = (e) => {
  try {
    const { buf, COLUNAS, EXTRA, DATAS, rodape } = e.data;
    self.postMessage({ etapa: "Abrindo a planilha…" });
    const wb = XLSX.read(buf, { type: "array", dense: true, cellDates: false, cellNF: false, cellText: false, cellHTML: false, cellFormula: false, cellStyles: false });
    const nomeAba = wb.SheetNames.find((n) => norm(n) === "EXPORT") || wb.SheetNames[0];
    self.postMessage({ etapa: "Lendo os pedidos…" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[nomeAba], { header: 1, raw: true, defval: null });
    const iCab = rows.findIndex((r) => r && r.some((c) => norm(c) === "PEDIDO INTELIPOST") && r.some((c) => norm(c) === "MICRO STATUS INTELIPOST"));
    if (iCab < 0) throw new Error('Não achei as colunas "Pedido Intelipost" e "Micro Status Intelipost". Confira se é a planilha exportada.');
    const cab = rows[iCab].map(norm), DT = new Set(DATAS), RODAPE = new RegExp(rodape, "i");
    const campos = Object.keys(COLUNAS), idx = campos.map((k) => cab.indexOf(COLUNAS[k]));
    const ex = Object.entries(EXTRA).map(([k, [nome, tipo]]) => [k, cab.indexOf(nome), tipo]).filter(([, i]) => i >= 0);
    const cols = campos.concat(ex.map(([k]) => "x:" + k)), iPed = campos.indexOf("pedido");
    const vistos = new Set(), out = [], hs = [];
    let nTp = 0;
    for (const r of rows.slice(iCab + 1)) {
      if (!r) continue;
      const ped = r[idx[iPed]] == null ? "" : String(r[idx[iPed]]).trim();
      if (!ped || vistos.has(ped) || RODAPE.test(ped)) continue;   // rodapé do BI ("Filtros aplicados: …") não é pedido
      vistos.add(ped);
      const o = new Array(cols.length).fill(null);
      for (let j = 0; j < campos.length; j++) {
        const k = campos[j], v = idx[j] >= 0 ? r[idx[j]] : null;
        if (k === "ultima_atualizacao") o[j] = dataCelula(v, true);
        else if (DT.has(k)) o[j] = dataCelula(v, false);
        else if (k === "qtd_tickets" || k === "dias_atraso") o[j] = v == null || v === "" || isNaN(Number(v)) ? null : Math.round(Number(v));
        else o[j] = v == null || v === "" ? null : String(v).trim();
      }
      o[iPed] = ped;
      for (let j = 0; j < ex.length; j++) {
        const [k, i, tipo] = ex[j], v = r[i]; if (v == null || v === "") continue;
        let x = null;
        if (tipo === "d") x = dataCelula(v, false);
        else if (tipo === "n") { const n = Number(String(v).replace(",", ".")); if (!isNaN(n)) x = n; }
        else x = String(v).trim();
        o[campos.length + j] = x;
        if (k === "transp_promob" && x) nTp++;
      }
      let fim = o.length; while (fim > 1 && o[fim - 1] === null) fim--;   // corta os vazios do fim (menos bytes)
      const linha = o.slice(0, fim);
      out.push(linha); hs.push(hash(JSON.stringify(linha)));
    }
    if (!out.length) throw new Error("A planilha não tem pedidos.");
    self.postMessage({ cols, rows: out, hs, nTp, semPromob: !ex.some(([k]) => k === "transp_promob") });
  } catch (err) {
    self.postMessage({ erro: err.message || String(err) });
  }
};
