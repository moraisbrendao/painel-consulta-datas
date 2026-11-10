// =====================================================================
// Lê a base de transações da Intelipost (xlsx/csv) fora da tela principal,
// para o navegador não travar. Devolve só os pedidos em aberto e um resumo.
// =====================================================================
/* global XLSX */
importScripts("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js");

function normalizar(s) {
  return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
}
function iso(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function paraData(c) {
  if (!c || c.v === undefined || c.v === null || c.v === "") return null;
  if (c.t === "d") return iso(new Date(c.v.getTime() - c.v.getTimezoneOffset() * 60000));
  if (c.t === "n") return c.v > 20000 && c.v < 80000 ? iso(new Date(Math.round((c.v - 25569) * 86400000))) : null;
  const s = String(c.v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[0];
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : null;
}
function texto(c) {
  if (!c || c.v === undefined || c.v === null) return "";
  if (c.t === "n" && Number.isInteger(c.v)) return String(c.v);
  return String(c.w ?? c.v).trim();
}

self.onmessage = (e) => {
  try {
    self.postMessage({ etapa: "Abrindo o arquivo…" });
    const wb = XLSX.read(e.data, { type: "array", dense: true, cellDates: false, cellNF: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    // modo "dense": cada linha é uma lista de células (formato muda entre versões da biblioteca)
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
    self.postMessage({ etapa: "Separando os pedidos em aberto…" });

    // acha o cabeçalho (linha que tem "Pedido" e "MicroStatus")
    let rCab = -1, cab = [];
    for (let r = 0; r < Math.min(linhas.length, 15); r++) {
      const l = (linhas[r] || []).map((c) => normalizar(texto(c)));
      if (l.includes("PEDIDO") && l.includes("MICROSTATUS")) { rCab = r; cab = l; break; }
    }
    if (rCab < 0) throw new Error('Não achei as colunas "Pedido" e "MicroStatus". Confira se é a base de transações da Intelipost.');
    const col = (nome) => cab.indexOf(normalizar(nome));
    const C = {
      pedido: col("Pedido"), nf: col("Nota Fiscal"), serie: col("Serie Nota"), pedido_venda: col("Pedido de Venda"),
      canal: col("Canal de Vendas"), transportadora: col("Transportadora"), status_transp: col("Status Transportador"),
      micro_status: col("MicroStatus"), descricao: col("Descrição Transportador"),
      data_ultimo_status: col("Data do último status"), data_despacho: col("Data Despacho"),
      prev_cliente: col("Previsão Entrega Cliente"), prev_cliente_original: col("Previsão Entrega Cliente Original"),
      prev_transp: col("Previsão Entrega Transp."), uf: col("UF"), cidade: col("Cidade do Destinatário"),
      link_rastreio: col("Pagina Rastreamento"), performance: col("Performance"), data_entrega: col("Data Entrega"),
    };
    const DATAS = ["data_ultimo_status", "data_despacho", "prev_cliente", "prev_cliente_original", "prev_transp"];

    const abertos = [];
    const resumo = { total: 0, entregues: 0, entregues_no_prazo: 0, cancelados: 0, em_aberto: 0 };
    for (let r = rCab + 1; r < linhas.length; r++) {
      const l = linhas[r];
      if (!l) continue;
      const pedido = texto(l[C.pedido]);
      if (!pedido) continue;
      resumo.total++;
      const st = normalizar(texto(l[C.status_transp]));
      if (st === "ENTREGUE" || (C.data_entrega >= 0 && paraData(l[C.data_entrega]))) {
        resumo.entregues++;
        if (normalizar(texto(l[C.performance])).includes("NO PRAZO")) resumo.entregues_no_prazo++;
        continue;
      }
      if (st === "CANCELADO") { resumo.cancelados++; continue; }
      resumo.em_aberto++;
      const nf = texto(l[C.nf]), serie = texto(l[C.serie]);
      const o = {
        pedido, nf: nf ? (serie ? `${nf}-${serie}` : nf) : null,
        pedido_venda: texto(l[C.pedido_venda]) || null, canal: texto(l[C.canal]) || null,
        transportadora: texto(l[C.transportadora]) || null, status_transp: texto(l[C.status_transp]) || null,
        micro_status: texto(l[C.micro_status]) || null, descricao: (texto(l[C.descricao]) || "").slice(0, 300) || null,
        uf: texto(l[C.uf]) || null, cidade: texto(l[C.cidade]) || null, link_rastreio: texto(l[C.link_rastreio]) || null,
      };
      DATAS.forEach((k) => (o[k] = C[k] >= 0 ? paraData(l[C[k]]) : null));
      abertos.push(o);
    }
    self.postMessage({ fim: true, abertos, resumo });
  } catch (err) {
    self.postMessage({ erro: err.message || String(err) });
  }
};
