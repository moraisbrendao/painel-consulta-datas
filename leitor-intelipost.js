// Lê o arquivo de transações da Intelipost em segundo plano (para a tela não travar)
// e devolve só o número do pedido e o status dos ENTREGUES e CANCELADOS.
// Nome, endereço e telefone do cliente não saem daqui.
/* global XLSX */
importScripts("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js");

const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
const texto = (c) => (!c || c.v === undefined || c.v === null ? "" : c.t === "n" && Number.isInteger(c.v) ? String(c.v) : String(c.w ?? c.v).trim());

self.onmessage = (e) => {
  try {
    self.postMessage({ etapa: "Abrindo o arquivo… (pode levar uns 30 segundos)" });
    const wb = XLSX.read(e.data, { type: "array", dense: true, cellDates: false, cellNF: false, cellText: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    let linhas = ws["!data"] || (Array.isArray(ws) ? ws : null);
    if (!linhas) {
      const rng = XLSX.utils.decode_range(ws["!ref"]);
      linhas = [];
      for (let r = rng.s.r; r <= rng.e.r; r++) {
        const l = [];
        for (let c = rng.s.c; c <= rng.e.c; c++) l.push(ws[XLSX.utils.encode_cell({ r, c })]);
        linhas.push(l);
      }
    }
    self.postMessage({ etapa: "Separando entregues e cancelados…" });
    let rCab = -1, cab = [];
    for (let r = 0; r < Math.min(linhas.length, 15); r++) {
      const l = (linhas[r] || []).map((c) => norm(texto(c)));
      if (l.includes("PEDIDO") && l.includes("STATUS TRANSPORTADOR")) { rCab = r; cab = l; break; }
    }
    if (rCab < 0) throw new Error('Não achei as colunas "Pedido" e "Status Transportador". Confira se é o arquivo de transações da Intelipost.');
    const cPed = cab.indexOf("PEDIDO"), cSt = cab.indexOf("STATUS TRANSPORTADOR");
    const fechados = new Map();
    let total = 0;
    for (let r = rCab + 1; r < linhas.length; r++) {
      const l = linhas[r]; if (!l) continue;
      const pedido = texto(l[cPed]); if (!pedido) continue;
      total++;
      const st = norm(texto(l[cSt]));
      if (st === "ENTREGUE" || st === "CANCELADO") fechados.set(pedido, st === "ENTREGUE" ? "Entregue" : "Cancelado");
    }
    self.postMessage({ fim: true, total, fechados: [...fechados].map(([pedido, status]) => ({ pedido, status })) });
  } catch (err) {
    self.postMessage({ erro: err.message || String(err) });
  }
};
