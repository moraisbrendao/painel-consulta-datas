// Sincronização dos tickets do 360 direto pela API (Brenda 27/11: "pegar os dados sem precisar subir o detalhamento").
// Roda EM PARALELO ao upload do detalhamento: grava só na tabela tk360 (parte 110) e não mexe em at_tk nem nas outras.
// Não guarda dados do cliente (nome, telefone, CPF, endereço) nem texto de comentários: só número da Nota AT e datas.
// Log público: só contagens.
const AT_RE = /assist|t[eé]cnic|reposi/i;   // AT e Reposições (Brenda 28/11: "para os outros pedidos também"): nota nova, peças/itens, transportadora, frete
const PAR = Number(process.env.TK360_PAR) || 8;   // chamadas ao mesmo tempo (15 derrubava as chamadas)

export async function rodarTk360({ chamar, log, ctx, limite = 1500 }) {
  const { entrarMulti360 } = await import("./multi360.mjs");
  let auth = null, raiz = null;
  ctx.on("request", (q) => { const h = q.headers(); if (/backend\./.test(q.url()) && /\/tickets/.test(q.url()) && h.authorization) { auth = h.authorization; const u = new URL(q.url()); raiz = u.origin + u.pathname.replace(/\/tickets.*$/, ""); } });
  const p = await entrarMulti360(ctx, log); await p.waitForTimeout(6000);
  if (!auth) { await p.reload().catch(() => {}); await p.waitForTimeout(6000); }
  if (!auth) throw new Error("não peguei o acesso da API do 360");
  // token novo quando o 360 devolve 401: um só recarregamento para todas as chamadas (antes zerava o token e todas falhavam)
  let renovando = null, primeiroErro = "";
  const renovar = () => renovando || (renovando = (async () => { const antes = auth; await p.reload().catch(() => {}); for (let k = 0; k < 30 && auth === antes; k++) await p.waitForTimeout(500); renovando = null; })());
  const get = async (cam, tent = 0) => {
    if (renovando) await renovando;
    let st = 0;
    const r = await ctx.request.get(raiz + cam, { headers: { authorization: auth, accept: "application/json" }, timeout: 45000 }).catch((e) => { if (!primeiroErro) primeiroErro = String(e.message).split("\n")[0].replace(/\d{4,}/g, "#").slice(0, 140); return null; });
    if (r) st = r.status();
    if (st === 401 && tent < 3) { await renovar(); return get(cam, tent + 1); }
    if ((st === 0 || st === 429 || st >= 500) && tent < 4) { await new Promise((ok) => setTimeout(ok, 3000 * (tent + 1))); return get(cam, tent + 1); }
    if (st !== 200) throw new Error(`API ${st}`);
    return r.json();
  };
  const pool = async (itens, n, fn) => { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < itens.length) { const x = itens[i++]; await fn(x); } })); };

  // 1) lista de todos os tickets em aberto (20 por página)
  const t0 = Date.now();
  const FILAS = new Map(); try { (await get("/parameters/queues")).forEach((q) => FILAS.set(String(q.id), q.label || q.name || q.value)); } catch (_) {}
  const p1 = await get("/tickets?page=1"); const paginas = p1.total_pages || 1;
  const lista = [...(p1.tickets || [])];
  await pool(Array.from({ length: paginas - 1 }, (_, k) => k + 2), PAR, async (pg) => { try { lista.push(...((await get(`/tickets?page=${pg}`)).tickets || [])); } catch (e) { log(`  página falhou: ${e.message}`); } });
  const porId = new Map(lista.map((t) => [String(t.ticket_id), t]));
  log(`tk360: ${porId.size} tickets em aberto no 360 (${paginas} páginas, ${Math.round((Date.now() - t0) / 1000)} s)`);
  if (porId.size < (p1.count || 0) * 0.95) log(`  atenção: a API diz ${p1.count}, li ${porId.size}`);

  // 2) o que já temos
  const ja = new Map(); let seco = false;
  try { await chamar("tk360?select=ticket_id&limit=1"); } catch (_) { seco = true; limite = Math.min(limite, 40); log("tk360: a tabela tk360 ainda não existe (parte 110): rodo só um teste de leitura, sem gravar nada"); }
  if (!seco) for (let de = 0; ; de += 1000) { const b = await chamar(`tk360?select=ticket_id,atualizado,detalhe_em,tipo,na_lista,rastreio:at->rastreio,rastreio_em:at->>rastreio_em,at_lido:at->>lido,tem_hist:datas->>filas&order=ticket_id&offset=${de}&limit=1000`); b.forEach((x) => ja.set(String(x.ticket_id), x)); if (b.length < 1000) break; }

  const agora = new Date().toISOString();
  const linhaLista = (t) => ({ ticket_id: Number(t.ticket_id), fila: t.queue && t.queue.name || null, fila_id: t.queue && t.queue.id || null, status: t.status && (t.status.label || t.status.value) || null,
    responsavel: t.assign_to && t.assign_to.name || null, transp: t.carrier || null, canal: t.channel || null, sub_canal: t.sub_channel || null,
    nf: t.erp_invoice_number ? `${t.erp_invoice_number}-${t.erp_invoice_serie ?? ""}` : null, pedido_mkt: t.marketplace_number || null, criado: t.created_date || null, atualizado: t.last_update_date || null,
    sla: t.sla || null, prioridade: t.priority || null, valor: t.total_value ?? null, reposicao: t.reposition ?? null, estornado: t.refunded_order ?? null, na_lista: true, visto_em: agora });

  // 3) detalhe só de quem é novo ou mudou (limite por rodada; o resto fica para a próxima)
  // AT primeiro: filas que o detalhamento de AT já mostrou + filas com "(AT)"/assistência no nome; o resto vai entrando aos poucos
  const atTk = await chamar("at_tk?select=ticket,fila&na_planilha=eq.true&limit=5000").catch(() => []);
  const idsAt = new Set(atTk.map((x) => String(x.ticket).replace(/\D/g, "")));
  const filasAt = new Set(atTk.map((x) => String(x.fila || "").trim().toLowerCase()).filter(Boolean));
  const ehFilaAt = (t) => { if (idsAt.has(String(t.ticket_id))) return 2; const f = String(t.queue && t.queue.name || "").trim().toLowerCase(); return /\(at\)|\bat\b|assist/i.test(f) ? 2 : filasAt.has(f) ? 1 : 0; };
  const fazer = [...porId.values()].filter((t) => { const a = ja.get(String(t.ticket_id)); return !a || !a.detalhe_em || a.atualizado !== t.last_update_date || (AT_RE.test(a.tipo || "") && !a.at_lido) || a.tem_hist == null; })
    .sort((a, b) => (ehFilaAt(b) - ehFilaAt(a)) || ((ja.has(String(a.ticket_id)) ? 1 : 0) - (ja.has(String(b.ticket_id)) ? 1 : 0))).slice(0, limite);
  log(`tk360: ${fazer.filter((t) => ehFilaAt(t) === 2).length} deles de AT conhecidos (vão primeiro)`);
  log(`tk360: ${fazer.length} para ler o detalhe agora (novos ou atualizados) · ${[...porId.keys()].filter((k) => !ja.has(k)).length} nunca vistos`);
  const linhas = [], tipos = {}, evGlobal = {}; let erros = 0, at = 0, comNota = 0, comPecas = 0, comFrete = 0;
  // o PostgREST exige as mesmas chaves em todas as linhas do lote
  const CHAVES = ["ticket_id", "fila", "fila_id", "status", "responsavel", "transp", "canal", "sub_canal", "nf", "pedido_mkt", "criado", "atualizado", "sla", "prioridade", "valor", "reposicao", "estornado", "na_lista", "visto_em",
    "tipo", "motivo", "grupo", "grupo_id", "redespacho", "carga", "datas", "pedido", "tags", "detalhe_em", "at", "detalhe_msg"];
  const norm = (r) => Object.fromEntries(CHAVES.map((k) => [k, r[k] === undefined ? null : r[k]]));
  const gravar = async (forcar) => { if (seco) { linhas.length = 0; return; } while (linhas.length >= (forcar ? 1 : 200)) { const b = linhas.splice(0, 200).map(norm); await chamar("tk360", "POST", b, { Prefer: "resolution=merge-duplicates,return=minimal" }); } };
  await pool(fazer, PAR, async (t) => {
    const id = String(t.ticket_id); const r = linhaLista(t);
    try {
      const [d, tl, sl] = await Promise.all([get(`/tickets/${id}`), get(`/tickets/${id}/timeline`).catch(() => []), get(`/tickets/ticket-sla/${id}`).catch(() => null)]);
      // histórico de filas (Brenda 28/11): a timeline traz uma "versão" do ticket a cada mudança, com queue_id e a data
      const hist = []; for (const v of (Array.isArray(tl) ? tl : []).filter((v) => v.queue_id != null).sort((a, b) => String(a.ticket_update_date || a.ticket_created_date || "").localeCompare(String(b.ticket_update_date || b.ticket_created_date || "")))) {
        const q = v.queue_id, quando = v.ticket_update_date || v.ticket_created_date || null; if (!hist.length || hist[hist.length - 1].id !== q) hist.push({ id: q, fila: FILAS.get(String(q)) || null, desde: quando }); }
      const sla = sl && !Array.isArray(sl) ? { inicio: sl.start_at || null, prazo: sl.sla_deadline || null, horas: sl.sla_hours ?? null, restantes: sl.horas_restantes ?? null, status: sl.sla_status || null, fim: sl.end_at || null } : null;
      const o = d.order || {}, c = d.carrier || {}, ca = c.carrier || {};
      Object.assign(r, { tipo: d.type && d.type.name || null, motivo: d.reason && d.reason.name || null, grupo: d.group && d.group.name || null, grupo_id: d.group && d.group.id || null,
        transp: ca.label || r.transp, redespacho: c.redispatch_carrier && c.redispatch_carrier.label || null, carga: c.load_number || null, datas: { ...(d.dates || {}), filas: hist, sla },
        pedido: { chave: o.access_key || null, anymarket: o.anymarket_id || null, promob: o.promob_order || null, nf: o.invoice || null, canal: o.channel || null, sub_canal: o.sub_channel || null,
          frete: o.freight ?? null, bruto: o.gross_value ?? null, total: o.total_value ?? null, desconto: o.discount ?? null, fulfillment: o.is_fulfillment ?? null, mkt: o.marketplace_number || null },
        tags: d.tags && Object.keys(d.tags).length ? d.tags : null, detalhe_em: agora });
      tipos[r.tipo || "?"] = (tipos[r.tipo || "?"] || 0) + 1;
      if (AT_RE.test(r.tipo || "")) {
        at++;
        const [ev, cm] = await Promise.all([get(`/tickets/${id}/events`).catch(() => []), get(`/tickets/${id}/comments`).catch(() => ({}))]);
        const A = { lido: agora }, tiposEv = {};
        for (const e of Array.isArray(ev) ? ev : []) {
          const x = e.event || {}; tiposEv[e.type] = 1; evGlobal[`${/assist/i.test(r.tipo) ? "AT" : "REP"} ${e.type}`] = (evGlobal[`${/assist/i.test(r.tipo) ? "AT" : "REP"} ${e.type}`] || 0) + 1;
          if (/reposi|replac|item|volume/i.test(e.type || "") && !A.itens_ev) { A.itens_ev = Object.keys(x).slice(0, 12); }
          if (e.type === "assistance-parts") { A.pecas = (x.parts || []).map((q) => ({ item: q.item ?? null, sku: q.sku ?? null, qtde: q.quantity ?? null, valor: q.price ?? null, peso: q.weight ?? null })); A.pecas_total = x.totals || null; A.pecas_em = e.datetime || null; }
          if (e.type === "assign_carrier_data") { A.transp = x.carrier_fantasy_name || x.carrier_name || null; A.frete = x.shipping_cost ?? null; A.previsao = x.delivery_estimate ?? null; A.transp_em = e.datetime || null; }
          if (e.type === "erp-order-emission") { A.pedido_erp = x.erp_order_id || null; A.pedido_erp_em = e.datetime || null; }
        }
        for (const m of (cm.comments || [])) { const k = String(m.message || "").match(/NF\s*(\d{3,})\s*-\s*(\d+)\s*emitida/i); if (k) { A.nota_at = `${k[1]}-${k[2]}`; A.nota_at_em = m.datetime || null; } }   // o último vale
        const ant = ja.get(id); if (ant && ant.rastreio) { A.rastreio = ant.rastreio; A.rastreio_em = ant.rastreio_em; }   // rastreio gravado pelo robô de AT continua
        r.at = A; if (A.nota_at) comNota++; if ((A.pecas || []).length) comPecas++; if (A.frete != null) comFrete++;
      }
    } catch (e) { erros++; r.detalhe_msg = String(e.message).slice(0, 120); }
    linhas.push(r); if (linhas.length >= 200) await gravar(false);
  });
  await gravar(true);

  if (seco) { log(`tk360 (teste): ${fazer.length - erros} detalhes lidos · ${erros} com erro · ${at} de Assistência Técnica (${comNota} com Nota AT, ${comPecas} com peças, ${comFrete} com frete) · tipos: ${JSON.stringify(tipos)}`); return; }
  if (Object.keys(evGlobal).length) log(`tipos de evento lidos: ${JSON.stringify(evGlobal)}`);
  // 4) quem não mudou: só confirma que continua em aberto (dados da lista)
  const iguais = [...porId.values()].filter((t) => !fazer.includes(t) && ja.has(String(t.ticket_id))).map(linhaLista);
  for (let i = 0; i < iguais.length; i += 500) await chamar("tk360", "POST", iguais.slice(i, i + 500), { Prefer: "resolution=merge-duplicates,return=minimal" });
  // 5) quem sumiu da lista do 360 = resolvido/encerrado
  const sairam = [...ja.entries()].filter(([k, x]) => x.na_lista && !porId.has(k)).map(([k]) => k);
  for (let i = 0; i < sairam.length; i += 100) await chamar(`tk360?ticket_id=in.(${sairam.slice(i, i + 100).join(",")})`, "PATCH", { na_lista: false, saiu_em: agora });
  log(`tk360: ${fazer.length - erros} detalhes lidos · ${erros} com erro${primeiroErro ? ` (1º erro: ${primeiroErro})` : ""} · ${at} de Assistência Técnica (${comNota} com Nota AT, ${comPecas} com peças, ${comFrete} com frete) · ${sairam.length} saíram da lista (fechados)`);

  // 6) comparação com o detalhamento (at_tk), só contagens: para saber quando dá para desligar o upload
  try {
    const AT = []; for (let de = 0; ; de += 1000) { const b = await chamar(`tk360?select=ticket_id,fila,at&na_lista=eq.true&at=not.is.null&tipo=ilike.*assist*&offset=${de}&limit=1000`); AT.push(...b); if (b.length < 1000) break; }
    const D = (await chamar("at_tk?select=ticket,fila,nota_at,data_saida&na_planilha=eq.true&limit=5000"));
    const mA = new Map(AT.map((x) => [String(x.ticket_id), x])), mD = new Map(D.map((x) => [String(x.ticket).replace(/\D/g, ""), x]));
    const ambos = [...mD.keys()].filter((k) => mA.has(k));
    const notaIgual = ambos.filter((k) => (mD.get(k).nota_at || "").replace(/^0+/, "") === ((mA.get(k).at || {}).nota_at || "").replace(/^0+/, "")).length;
    const filaIgual = ambos.filter((k) => (mD.get(k).fila || "").trim().toLowerCase() === (mA.get(k).fila || "").trim().toLowerCase()).length;
    log(`comparação AT: detalhamento ${mD.size} · API ${mA.size} · nos dois ${ambos.length} · só no detalhamento ${mD.size - ambos.length} · só na API ${mA.size - ambos.length} · Nota AT igual ${notaIgual}/${ambos.length} · fila igual ${filaIgual}/${ambos.length}`);
    await chamar("robo_estado", "POST", { nome: "tk360:comparacao", valor: { em: agora, detalhamento: mD.size, api: mA.size, ambos: ambos.length, nota_igual: notaIgual, fila_igual: filaIgual, abertos: porId.size } }, { Prefer: "resolution=merge-duplicates,return=minimal" }).catch(() => {});
    // Reposições: nota nova do 360 (comentário "NF x emitida") × NF EMITIDA PROMOB do detalhamento (tk_saida REP)
    const RP = []; for (let de = 0; ; de += 1000) { const b = await chamar(`tk360?select=ticket_id,fila,at&na_lista=eq.true&tipo=ilike.*reposi*&offset=${de}&limit=1000`); RP.push(...b); if (b.length < 1000) break; }
    const SD = await chamar("tk_saida?select=ticket,nf_nova&origem=eq.REP&limit=20000").catch(() => []);
    const mR = new Map(RP.map((x) => [String(x.ticket_id), x])), mS = new Map(SD.filter((x) => x.nf_nova).map((x) => [String(x.ticket).replace(/\D/g, ""), x]));
    const ambR = [...mS.keys()].filter((k) => mR.has(k)), lidosR = RP.filter((x) => x.at).length;
    const nNum = (v) => String(v || "").split("-")[0].replace(/\D/g, "").replace(/^0+/, "");
    const notaR = ambR.filter((k) => nNum(mS.get(k).nf_nova) === nNum((mR.get(k).at || {}).nota_at)).length;
    log(`comparação Reposições: abertas no 360 ${mR.size} (${lidosR} com detalhe lido, ${RP.filter((x) => x.at && x.at.nota_at).length} com NF nova) · detalhamento com NF nova ${mS.size} · nos dois ${ambR.length} · NF nova igual ${notaR}/${ambR.length}`);
    await chamar("robo_estado", "POST", { nome: "tk360:comparacao_rep", valor: { em: agora, api: mR.size, lidos: lidosR, detalhamento: mS.size, ambos: ambR.length, nota_igual: notaR } }, { Prefer: "resolution=merge-duplicates,return=minimal" }).catch(() => {});
  } catch (e) { log("comparação: " + String(e.message).slice(0, 120)); }
}

// diag (28/11): a API do 360 filtra tickets fechados / por NF? Só contagens e nomes de campos no log.
export async function diag360Fechados({ log, ctx, chamar }) {
  const { entrarMulti360 } = await import("./multi360.mjs");
  let auth = null, raiz = null; const vistos = new Set();
  ctx.on("request", (q) => { const h = q.headers(); if (/backend\./.test(q.url())) { const u = new URL(q.url()); vistos.add(u.pathname.replace(/\d{3,}/g, "#") + (u.search ? "?" + [...u.searchParams.keys()].join("&") : "")); if (/\/tickets/.test(q.url()) && h.authorization) { auth = h.authorization; raiz = u.origin + u.pathname.replace(/\/tickets.*$/, ""); } } });
  const p = await entrarMulti360(ctx, log); await p.waitForTimeout(6000);
  if (!auth) { await p.reload().catch(() => {}); await p.waitForTimeout(6000); }
  if (!auth) return log("diag-360fech: sem acesso");
  const get = async (cam) => { const r = await ctx.request.get(raiz + cam, { headers: { authorization: auth, accept: "application/json" }, timeout: 45000 }).catch(() => null); if (!r) return [0, null]; let j = null; try { j = await r.json(); } catch (_) {} return [r.status(), j]; };
  const resumo = (j) => !j ? "—" : Array.isArray(j) ? `lista ${j.length} · ${JSON.stringify(j.slice(0, 6).map((x) => x && (x.label || x.name || x.value || x.id))).slice(0, 200)}` : `count ${j.count ?? "?"} · páginas ${j.total_pages ?? "?"} · status ${JSON.stringify([...new Set((j.tickets || []).map((t) => t.status && (t.status.label || t.status.value)))])}`;
  for (const c of ["/parameters/status", "/parameters/statuses", "/parameters/ticket-status", "/parameters/tickets-status", "/parameters"]) { const [st, j] = await get(c); log(`  ${c}: ${st} ${st === 200 ? resumo(j) : ""}`); }
  const [, p1] = await get("/tickets?page=1"); log(`  /tickets?page=1: ${resumo(p1)} · campos do ticket ${JSON.stringify(Object.keys((p1 && p1.tickets || [])[0] || {})).slice(0, 400)}`);
  const ex = (p1 && p1.tickets || [])[0] || {}; const nf = ex.erp_invoice_number;
  for (const q of ["status=closed", "status=fechado", "status=Fechado", "status=4", "status=5", "status_id=4", "status_id=5", "situation=closed", "closed=true", "all=true", "include_closed=true", "status=all", "status[]=closed",
    ...(nf ? [`erp_invoice_number=${nf}`, `invoice=${nf}`, `nf=${nf}`, `search=${nf}`, `q=${nf}`] : [])]) {
    const [st, j] = await get("/tickets?page=1&" + q); log(`  /tickets?…&${q.replace(/\d{4,}/g, "#")}: ${st} ${st === 200 ? resumo(j) : ""}`);
  }
  // o próprio site: abre a lista de tickets e mostra quais parâmetros ele usa
  await p.goto("https://appv2.360multi.com/tickets", { waitUntil: "domcontentloaded" }).catch(() => {}); await p.waitForTimeout(8000);
  const bts = (await p.locator("button").allInnerTexts().catch(() => [])).map((t) => t.trim()).filter((t) => t && t.length < 30);
  log(`  botões da lista de tickets: ${JSON.stringify([...new Set(bts)]).slice(0, 400)}`);
  log(`  chamadas do site: ${JSON.stringify([...vistos]).slice(0, 800)}`);
}
// diag 2: quais chamadas a página do pedido (Hub › Pedidos) faz — para achar os tickets FECHADOS do pedido pela API
export async function diag360Pedido({ log, ctx, chamar }) {
  const RP = await import("./repo-pre.mjs");
  const vistos = []; let auth = null;
  ctx.on("request", (q) => { if (/backend\./.test(q.url())) { const u = new URL(q.url()); vistos.push(q.method() + " " + u.pathname.replace(/\d{3,}/g, "#") + (u.search ? "?" + [...u.searchParams.keys()].join("&") : "")); if (q.headers().authorization) auth = q.headers().authorization; } });
  const resps = []; ctx.on("response", async (r) => { try { if (!/backend\./.test(r.url()) || r.request().method() !== "GET") return; const j = await r.json().catch(() => null); if (!j) return; const txt = JSON.stringify(j); if (/ticket/i.test(txt)) resps.push({ cam: new URL(r.url()).pathname.replace(/\d{3,}/g, "#"), chaves: Array.isArray(j) ? "lista " + j.length + " " + JSON.stringify(Object.keys(j[0] || {})).slice(0, 300) : JSON.stringify(Object.keys(j)).slice(0, 300), status: [...new Set((txt.match(/"status"\s*:\s*\{[^}]*"value"\s*:\s*"([^"]+)"/g) || []).map((s) => s.replace(/.*"value"\s*:\s*"/, "").replace(/"$/, "")))] }); } catch (_) {} });
  const [b] = await chamar("base_pedidos?select=nf&nf=not.is.null&limit=1&offset=500");
  await RP.pedido360(ctx, log, b.nf);
  log(`diag-360ped: chamadas ${JSON.stringify([...new Set(vistos)]).slice(0, 1200)}`);
  for (const r of resps.slice(0, 8)) log(`  resposta ${r.cam}: ${r.chaves} · status ${JSON.stringify(r.status)}`);
}
// diag 3: formato de /orders/?invoice= e /orders/<id>/tickets (só nomes de campos e valores de status)
export async function diag360Orders({ log, ctx, chamar }) {
  const { entrarMulti360 } = await import("./multi360.mjs");
  let auth = null, raiz = null, origem = null;
  ctx.on("request", (q) => { const h = q.headers(); if (/backend\./.test(q.url()) && /\/tickets/.test(q.url()) && h.authorization) { auth = h.authorization; const u = new URL(q.url()); origem = u.origin; raiz = u.origin + u.pathname.replace(/\/tickets.*$/, ""); } });
  const p = await entrarMulti360(ctx, log); await p.waitForTimeout(6000); if (!auth) { await p.reload().catch(() => {}); await p.waitForTimeout(6000); }
  const get = async (url) => { const r = await ctx.request.get(url, { headers: { authorization: auth, accept: "application/json" }, timeout: 45000 }).catch(() => null); if (!r) return [0, null]; let j = null; try { j = await r.json(); } catch (_) {} return [r.status(), j]; };
  const B = await chamar("tk360?select=nf&nf=not.is.null&tipo=ilike.*reposi*&limit=3");
  for (const b of B.slice(0, 3)) {
    const num = String(b.nf).split("-")[0].trim();
    for (const inv of [num, b.nf]) {
      const [st, j] = await get(`${origem}/orders/?page=1&invoice=${encodeURIComponent(inv)}`);
      const lst = j && (j.orders || j.results || j.data || (Array.isArray(j) ? j : null));
      log(`  /orders?invoice=(${inv === num ? "só número" : "número-série"}): ${st} · chaves ${JSON.stringify(j && !Array.isArray(j) ? Object.keys(j) : "lista")} · itens ${lst ? lst.length : "?"} · campos ${JSON.stringify(Object.keys((lst || [])[0] || {})).slice(0, 500)}`);
      const o = (lst || [])[0]; if (!o) continue;
      const id = o.anymarket_id || o.id || o.order_id;
      const [s2, t] = await get(`${raiz}/orders/${id}/tickets`);
      const tl = t && (t.tickets || t.results || (Array.isArray(t) ? t : null));
      log(`  /orders/<id>/tickets: ${s2} · chaves ${JSON.stringify(t && !Array.isArray(t) ? Object.keys(t) : "lista")} · tickets ${tl ? tl.length : "?"} · campos ${JSON.stringify(Object.keys((tl || [])[0] || {})).slice(0, 500)} · status ${JSON.stringify([...new Set((tl || []).map((x) => JSON.stringify(x.status).replace(/\d{3,}/g, "#")))]).slice(0, 300)}`);
      if (tl && tl[0]) log(`  exemplo (sem números): ${JSON.stringify(tl[0], (k, v) => (typeof v === "string" ? v.replace(/\d{3,}/g, "#").slice(0, 40) : typeof v === "number" ? 0 : v)).slice(0, 700)}`);
      break;
    }
  }
}

// ===== Tickets FECHADOS dos pedidos (Brenda 28/11): lista de NFs vem como hashes (sha256 do número da NF, 16 letras) =====
// A lista de tickets da API só traz abertos; os fechados vêm de /orders/?invoice=<nº> → /orders/<anymarket_id>/tickets.
// Resultado vai para robo_estado "tk360:fechados" (só logados no painel leem). Log público: só contagens.
const ABERTO = /^(new|open|on_going|awaiting_.*|pending.*|in_progress)$/i;
export async function rodarFechados({ chamar, log, ctx, hashes }) {
  const { createHash } = await import("node:crypto");
  const hh = (n) => createHash("sha256").update(String(n).split("-")[0].trim()).digest("hex").slice(0, 16);
  const quero = new Set(hashes);
  const nfs = new Map();
  // 28/11: o banco às vezes dá tempo esgotado numa página; antes isso parava a leitura (só 38 de 891 achadas)
  const pagina = async (tab, chave, de) => { for (let t = 0; t < 5; t++) { try { return await chamar(`${tab}?select=nf&order=${chave}&offset=${de}&limit=1000`); } catch (_) { await new Promise((ok) => setTimeout(ok, 3000 * (t + 1))); } } throw new Error(`não li ${tab} a partir de ${de}`); };
  for (const [tab, chave] of [["base_pedidos", "pedido"], ["tk360", "ticket_id"]]) for (let de = 0; ; de += 1000) { const b = await pagina(tab, chave, de); for (const x of b) { if (!x.nf) continue; const h = hh(x.nf); if (quero.has(h) && !nfs.has(h)) nfs.set(h, String(x.nf).trim()); } if (b.length < 1000) break; }
  log(`fechados: ${quero.size} NFs pedidas · ${nfs.size} achadas na base`);
  const { entrarMulti360 } = await import("./multi360.mjs");
  let auth = null, raiz = null, origem = null;
  ctx.on("request", (q) => { const h = q.headers(); if (/backend\./.test(q.url()) && /\/tickets/.test(q.url()) && h.authorization) { auth = h.authorization; const u = new URL(q.url()); origem = u.origin; raiz = u.origin + u.pathname.replace(/\/tickets.*$/, ""); } });
  const p = await entrarMulti360(ctx, log); await p.waitForTimeout(6000); if (!auth) { await p.reload().catch(() => {}); await p.waitForTimeout(6000); }
  if (!auth) throw new Error("sem acesso à API do 360");
  let renovando = null; const renovar = () => renovando || (renovando = (async () => { const a = auth; await p.reload().catch(() => {}); for (let k = 0; k < 30 && auth === a; k++) await p.waitForTimeout(500); renovando = null; })());
  const get = async (url, t = 0) => { if (renovando) await renovando; const r = await ctx.request.get(url, { headers: { authorization: auth, accept: "application/json" }, timeout: 45000 }).catch(() => null); const st = r ? r.status() : 0;
    if (st === 401 && t < 3) { await renovar(); return get(url, t + 1); } if ((st === 0 || st === 429 || st >= 500) && t < 3) { await new Promise((ok) => setTimeout(ok, 2500 * (t + 1))); return get(url, t + 1); } if (st !== 200) throw new Error("API " + st); return r.json(); };
  const linhas = [], semPedido = [], erros = { n: 0 }; const STATUS = {};
  const itens = [...nfs.values()]; let i = 0;
  await Promise.all(Array.from({ length: 6 }, async () => { while (i < itens.length) { const nf = itens[i++]; const num = nf.split("-")[0];
    try { const o = await get(`${origem}/orders/?page=1&invoice=${encodeURIComponent(num)}`);
      const ords = (o.orders || []).filter((x) => !x.invoice || String(x.invoice).replace(/\s/g, "") === nf.replace(/\s/g, "") || String(x.invoice).split("-")[0] === num);
      if (!ords.length) { semPedido.push(nf); continue; }
      for (const od of ords) { const tks = await get(`${raiz}/orders/${od.anymarket_id}/tickets`);
        for (const t of tks || []) { STATUS[t.status] = (STATUS[t.status] || 0) + 1; if (ABERTO.test(t.status || "")) continue;
          linhas.push({ nf, nf_ticket: t.invoice || null, pedido_mkt: od.marketplace_number || null, ticket: t.ticket_id, tipo: t.type && t.type.label || null, fila: t.queue && t.queue.label || null, status: t.status }); } }
    } catch (e) { erros.n++; } } }));
  // datas de cada ticket fechado (abertura / última atualização)
  let j = 0; await Promise.all(Array.from({ length: 6 }, async () => { while (j < linhas.length) { const x = linhas[j++];
    try { const d = await get(`${raiz}/tickets/${x.ticket}`); const tk = d.ticket || d; x.criado = tk.created_date || tk.created_at || null; x.atualizado = tk.last_update_date || tk.updated_at || null; x.fechado = tk.closed_date || tk.solved_date || tk.end_date || null; x.motivo = (tk.reason && (tk.reason.label || tk.reason.name)) || null; } catch (_) {} } }));
  await chamar("robo_estado", "POST", { nome: "tk360:fechados", valor: { em: new Date().toISOString(), pedidas: quero.size, achadas: nfs.size, sem_pedido_360: semPedido, linhas }, atualizado_em: new Date().toISOString() }, { Prefer: "resolution=merge-duplicates,return=minimal" });
  log(`fechados: ${nfs.size} NFs consultadas · ${semPedido.length} sem pedido no 360 · ${erros.n} com erro · ${linhas.length} tickets fechados em ${new Set(linhas.map((x) => x.nf)).size} NFs · status vistos ${JSON.stringify(STATUS)}`);
}
