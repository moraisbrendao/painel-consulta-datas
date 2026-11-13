// Conferência SSW: lê o arquivo de transações da Intelipost em segundo plano e devolve só os pedidos
// que NÃO estão Entregue/Cancelado (pedido, NF-série, transportadora, status e previsão do cliente).
// Nome, endereço, telefone e e-mail do cliente não saem daqui.
/* global XLSX */
importScripts("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js");

const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
const texto = (c) => (!c || c.v === undefined || c.v === null ? "" : c.t === "n" && Number.isInteger(c.v) ? String(c.v) : String(c.w ?? c.v).trim());
const dataISO = (c) => {
  if (!c || c.v == null || c.v === "") return null;
  if (c.t === "n") return new Date(Math.round((c.v - 25569) * 86400000)).toISOString().slice(0, 10);
  const m = String(c.w ?? c.v).match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

self.onmessage = (e) => {
  try {
    self.postMessage({ etapa: "Abrindo o arquivo… (pode levar uns 30 segundos)" });
    const wb = XLSX.read(e.data, { type: "array", dense: true, cellDates: false, cellNF: false, cellText: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    let linhas = ws["!data"] || (Array.isArray(ws) ? ws : null);
    if (!linhas) {
      const rng = XLSX.utils.decode_range(ws["!ref"]);
      linhas = [];
      for (let r = rng.s.r; r <= rng.e.r; r++) { const l = []; for (let c = rng.s.c; c <= rng.e.c; c++) l.push(ws[XLSX.utils.encode_cell({ r, c })]); linhas.push(l); }
    }
    self.postMessage({ etapa: "Separando os pedidos em aberto…" });
    let rCab = -1, cab = [];
    for (let r = 0; r < Math.min(linhas.length, 15); r++) {
      const l = (linhas[r] || []).map((c) => norm(texto(c)));
      if (l.includes("PEDIDO") && l.includes("STATUS TRANSPORTADOR")) { rCab = r; cab = l; break; }
    }
    if (rCab < 0) throw new Error('Não achei as colunas "Pedido" e "Status Transportador". Use o arquivo de transações da Intelipost (transactions_….xlsx).');
    const c = (n) => cab.indexOf(n);
    const cPed = c("PEDIDO"), cSt = c("STATUS TRANSPORTADOR"), cNf = c("NOTA FISCAL"), cSer = c("SERIE NOTA"), cT = c("TRANSPORTADORA"), cPrev = c("PREVISAO ENTREGA CLIENTE");
    const abertos = new Map(); let total = 0, fechados = 0;
    for (let r = rCab + 1; r < linhas.length; r++) {
      const l = linhas[r]; if (!l) continue;
      const pedido = texto(l[cPed]); if (!pedido) continue;
      total++;
      const st = texto(l[cSt]);
      if (/^(ENTREGUE|CANCELADO)$/.test(norm(st))) { fechados++; continue; }
      const num = cNf >= 0 ? texto(l[cNf]) : "", ser = cSer >= 0 ? texto(l[cSer]) : "";
      abertos.set(pedido, { pedido, nf: num && ser ? `${num}-${ser}` : "", transportadora: cT >= 0 ? texto(l[cT]) : "", status_intelipost: st, prev_cliente: cPrev >= 0 ? dataISO(l[cPrev]) : null });
    }
    self.postMessage({ fim: true, total, fechados, abertos: [...abertos.values()] });
  } catch (err) {
    self.postMessage({ erro: err.message || String(err) });
  }
};
