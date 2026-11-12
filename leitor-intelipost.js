// Lê o arquivo de transações da Intelipost em segundo plano (para a tela não travar)
// e devolve: (1) número do pedido e status dos ENTREGUES e CANCELADOS (tiram do Preventivo);
// (2) uma versão enxuta de TODOS os pedidos para a Visão Gerencial (canal, UF, transportadora, datas, situação).
// Nome, endereço, e-mail, telefone e CEP do cliente não saem daqui.
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
    const col = (n) => cab.indexOf(n);
    const C = { nf: col("NOTA FISCAL"), serie: col("SERIE NOTA"), canal: col("CANAL DE VENDAS"), uf: col("UF"), transp: col("TRANSPORTADORA"),
      micro: col("MICROSTATUS"), perf: col("PERFORMANCE"), criado: col("DATA CRIACAO"), despacho: col("DATA DESPACHO"), entrega: col("DATA ENTREGA"),
      prev: col("PREVISAO ENTREGA CLIENTE"), prevOrig: col("PREVISAO ENTREGA CLIENTE ORIGINAL"), ult: col("DATA DO ULTIMO STATUS") };
    const p2 = (n) => String(n).padStart(2, "0");
    const data = (c) => {
      if (!c || c.v === undefined || c.v === null || c.v === "") return "";
      if (typeof c.v === "number") { const d = XLSX.SSF.parse_date_code(c.v); return d && d.y >= 2000 ? `${d.y}-${p2(d.m)}-${p2(d.d)}` : ""; }
      const s = String(c.v).trim(); let m;
      if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
      if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/))) return `${m[3]}-${p2(m[2])}-${p2(m[1])}`;
      return "";
    };
    const tx = (i, l) => (i >= 0 ? texto(l[i]) : "");
    const dt = (i, l) => (i >= 0 ? data(l[i]) : "");
    const todos = new Map();
    const fechados = new Map();
    let total = 0;
    for (let r = rCab + 1; r < linhas.length; r++) {
      const l = linhas[r]; if (!l) continue;
      const pedido = texto(l[cPed]); if (!pedido) continue;
      total++;
      const st = norm(texto(l[cSt]));
      // [pedido, nf, serie, canal, uf, transp, status, micro, perf, criado, despacho, entrega, prev, prevOrig, ult]
      todos.set(pedido, [pedido, tx(C.nf, l), tx(C.serie, l), tx(C.canal, l), tx(C.uf, l), tx(C.transp, l), texto(l[cSt]), tx(C.micro, l), tx(C.perf, l),
        dt(C.criado, l), dt(C.despacho, l), dt(C.entrega, l), dt(C.prev, l), dt(C.prevOrig, l), dt(C.ult, l)]);
      if (st === "ENTREGUE" || st === "CANCELADO") fechados.set(pedido, st === "ENTREGUE" ? "Entregue" : "Cancelado");
    }
    self.postMessage({ fim: true, total, todos: [...todos.values()], fechados: [...fechados].map(([pedido, status]) => ({ pedido, status })) });
  } catch (err) {
    self.postMessage({ erro: err.message || String(err) });
  }
};
