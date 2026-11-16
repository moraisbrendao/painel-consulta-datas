// Lê o arquivo de transações da Intelipost em segundo plano (para a tela não travar)
// e devolve o número do pedido e o status dos ENTREGUES e CANCELADOS, e os dados de acompanhamento dos que estão EM ABERTO
// (para o painel mostrar também os pedidos em aberto que não vieram na base).
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
    const col = (n) => cab.indexOf(n);
    const C = { nf: col("NOTA FISCAL"), serie: col("SERIE NOTA"), canal: col("CANAL DE VENDAS"), uf: col("UF"), cidade: col("CIDADE DO DESTINATARIO"),
      transp: col("TRANSPORTADORA"), micro: col("MICROSTATUS"), desc: col("DESCRICAO TRANSPORTADOR"), desp: col("DATA DESPACHO"), ult: col("DATA DO ULTIMO STATUS"),
      prevO: col("PREVISAO ENTREGA CLIENTE ORIGINAL"), prev: col("PREVISAO ENTREGA CLIENTE"), cria: col("DATA CRIACAO"), link: col("PAGINA RASTREAMENTO"), ent: col("DATA ENTREGA") };
    const p2 = (n) => String(n).padStart(2, "0");
    const data = (c, hora) => {
      if (!c || c.v === undefined || c.v === null || c.v === "") return null;
      if (typeof c.v === "number") { const d = XLSX.SSF.parse_date_code(c.v); if (!d || d.y < 2000) return null;
        const dt = `${d.y}-${p2(d.m)}-${p2(d.d)}`; return hora ? `${dt}T${p2(d.H)}:${p2(d.M)}:${p2(Math.floor(d.S || 0))}` : dt; }
      const s = String(c.v).trim(); let r;
      if ((r = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/))) return hora && r[4] ? `${r[1]}-${r[2]}-${r[3]}T${r[4]}:${r[5]}:00` : `${r[1]}-${r[2]}-${r[3]}`;
      if ((r = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?: (\d{1,2}):(\d{2}))?/))) { const dt = `${r[3]}-${p2(r[2])}-${p2(r[1])}`; return hora && r[4] ? `${dt}T${p2(r[4])}:${r[5]}:00` : dt; }
      return null;
    };
    const tx = (i, l) => (i >= 0 ? texto(l[i]) || null : null);
    const abertos = new Map();
    const fechados = new Map();
    let total = 0;
    for (let r = rCab + 1; r < linhas.length; r++) {
      const l = linhas[r]; if (!l) continue;
      const pedido = texto(l[cPed]); if (!pedido) continue;
      total++;
      const st = norm(texto(l[cSt]));
      if (st === "ENTREGUE" || st === "CANCELADO") { fechados.set(pedido, st === "ENTREGUE" ? "Entregue" : "Cancelado"); abertos.delete(pedido); continue; }
      if (fechados.has(pedido)) continue;
      // em aberto: só dados de acompanhamento (nada de nome, endereço, e-mail ou telefone do cliente)
      const nf = tx(C.nf, l), serie = tx(C.serie, l);
      abertos.set(pedido, { pedido, nf: nf ? (serie ? `${nf}-${serie}` : nf) : null, canal: tx(C.canal, l), uf: tx(C.uf, l), cidade: tx(C.cidade, l),
        transportadora: tx(C.transp, l), status_intelipost: texto(l[cSt]) || null, micro_status: tx(C.micro, l), descricao: tx(C.desc, l),
        data_expedicao: data(l[C.desp]), ultima_atualizacao: data(l[C.ult], true), prev_original: data(l[C.prevO]), prev_atual: data(l[C.prev]),
        data_criacao: data(l[C.cria]), data_entrega: data(l[C.ent]), link_rastreio: tx(C.link, l), extra: { fonte: "intelipost" } });
    }
    self.postMessage({ fim: true, total, fechados: [...fechados].map(([pedido, status]) => ({ pedido, status })), abertos: [...abertos.values()] });
  } catch (err) {
    self.postMessage({ erro: err.message || String(err) });
  }
};
