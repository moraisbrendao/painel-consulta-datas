// Sincronização dos tickets do 360 direto pela API (Brenda 27/11: "pegar os dados sem precisar subir o detalhamento").
// Roda EM PARALELO ao upload do detalhamento: grava só na tabela tk360 (parte 110) e não mexe em at_tk nem nas outras.
// Não guarda dados do cliente (nome, telefone, CPF, endereço) nem texto de comentários: só número da Nota AT e datas.
// Log público: só contagens.
const AT_RE = /assist|t[eé]cnic/i;
const PAR = Number(process.env.TK360_PAR) || 15;   // chamadas ao mesmo tempo (a lista com 6 levava ~10 min)

export async function rodarTk360({ chamar, log, ctx, limite = 3000 }) {
  const { entrarMulti360 } = await import("./multi360.mjs");
  let auth = null, raiz = null;
  ctx.on("request", (q) => { const h = q.headers(); if (/backend\./.test(q.url()) && /\/tickets/.test(q.url()) && h.authorization) { auth = h.authorization; const u = new URL(q.url()); raiz = u.origin + u.pathname.replace(/\/tickets.*$/, ""); } });
  const p = await entrarMulti360(ctx, log); await p.waitForTimeout(6000);
  if (!auth) { await p.reload().catch(() => {}); await p.waitForTimeout(6000); }
  if (!auth) throw new Error("não peguei o acesso da API do 360");
  const get = async (cam, tent = 0) => {
    const r = await ctx.request.get(raiz + cam, { headers: { authorization: auth, accept: "application/json" }, timeout: 30000 }).catch((e) => ({ status: () => 0, e }));
    const st = r.status();
    if (st === 401 && tent < 2) { auth = null; await p.reload().catch(() => {}); await p.waitForTimeout(5000); return get(cam, tent + 1); }
    if ((st === 0 || st === 429 || st >= 500) && tent < 3) { await new Promise((ok) => setTimeout(ok, 2000 * (tent + 1))); return get(cam, tent + 1); }
    if (st !== 200) throw new Error(`API ${st}`);
    return r.json();
  };
  const pool = async (itens, n, fn) => { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < itens.length) { const x = itens[i++]; await fn(x); } })); };

  // 1) lista de todos os tickets em aberto (20 por página)
  const t0 = Date.now();
  const p1 = await get("/tickets?page=1"); const paginas = p1.total_pages || 1;
  const lista = [...(p1.tickets || [])];
  await pool(Array.from({ length: paginas - 1 }, (_, k) => k + 2), PAR, async (pg) => { try { lista.push(...((await get(`/tickets?page=${pg}`)).tickets || [])); } catch (e) { log(`  página falhou: ${e.message}`); } });
  const porId = new Map(lista.map((t) => [String(t.ticket_id), t]));
  log(`tk360: ${porId.size} tickets em aberto no 360 (${paginas} páginas, ${Math.round((Date.now() - t0) / 1000)} s)`);
  if (porId.size < (p1.count || 0) * 0.95) log(`  atenção: a API diz ${p1.count}, li ${porId.size}`);

  // 2) o que já temos
  const ja = new Map(); let seco = false;
  try { await chamar("tk360?select=ticket_id&limit=1"); } catch (_) { seco = true; limite = Math.min(limite, 40); log("tk360: a tabela tk360 ainda não existe (parte 110): rodo só um teste de leitura, sem gravar nada"); }
  if (!seco) for (let de = 0; ; de += 1000) { const b = await chamar(`tk360?select=ticket_id,atualizado,detalhe_em,tipo,na_lista&order=ticket_id&offset=${de}&limit=1000`); b.forEach((x) => ja.set(String(x.ticket_id), x)); if (b.length < 1000) break; }

  const agora = new Date().toISOString();
  const linhaLista = (t) => ({ ticket_id: Number(t.ticket_id), fila: t.queue && t.queue.name || null, fila_id: t.queue && t.queue.id || null, status: t.status && (t.status.label || t.status.value) || null,
    responsavel: t.assign_to && t.assign_to.name || null, transp: t.carrier || null, canal: t.channel || null, sub_canal: t.sub_channel || null,
    nf: t.erp_invoice_number ? `${t.erp_invoice_number}-${t.erp_invoice_serie ?? ""}` : null, pedido_mkt: t.marketplace_number || null, criado: t.created_date || null, atualizado: t.last_update_date || null,
    sla: t.sla || null, prioridade: t.priority || null, valor: t.total_value ?? null, reposicao: t.reposition ?? null, estornado: t.refunded_order ?? null, na_lista: true, visto_em: agora });

  // 3) detalhe só de quem é novo ou mudou (limite por rodada; o resto fica para a próxima)
  const fazer = [...porId.values()].filter((t) => { const a = ja.get(String(t.ticket_id)); return !a || !a.detalhe_em || a.atualizado !== t.last_update_date; })
    .sort((a, b) => (ja.has(String(a.ticket_id)) ? 1 : 0) - (ja.has(String(b.ticket_id)) ? 1 : 0)).slice(0, limite);
  log(`tk360: ${fazer.length} para ler o detalhe agora (novos ou atualizados) · ${[...porId.keys()].filter((k) => !ja.has(k)).length} nunca vistos`);
  const linhas = [], tipos = {}; let erros = 0, at = 0, comNota = 0, comPecas = 0, comFrete = 0;
  const gravar = async (forcar) => { if (seco) { linhas.length = 0; return; } while (linhas.length >= (forcar ? 1 : 200)) { const b = linhas.splice(0, 200); await chamar("tk360", "POST", b, { Prefer: "resolution=merge-duplicates,return=minimal" }); } };
  await pool(fazer, PAR, async (t) => {
    const id = String(t.ticket_id); const r = linhaLista(t);
    try {
      const d = await get(`/tickets/${id}`);
      const o = d.order || {}, c = d.carrier || {}, ca = c.carrier || {};
      Object.assign(r, { tipo: d.type && d.type.name || null, motivo: d.reason && d.reason.name || null, grupo: d.group && d.group.name || null, grupo_id: d.group && d.group.id || null,
        transp: ca.label || r.transp, redespacho: c.redispatch_carrier && c.redispatch_carrier.label || null, carga: c.load_number || null, datas: d.dates || null,
        pedido: { chave: o.access_key || null, anymarket: o.anymarket_id || null, promob: o.promob_order || null, nf: o.invoice || null, canal: o.channel || null, sub_canal: o.sub_channel || null,
          frete: o.freight ?? null, bruto: o.gross_value ?? null, total: o.total_value ?? null, desconto: o.discount ?? null, fulfillment: o.is_fulfillment ?? null, mkt: o.marketplace_number || null },
        tags: d.tags && Object.keys(d.tags).length ? d.tags : null, detalhe_em: agora });
      tipos[r.tipo || "?"] = (tipos[r.tipo || "?"] || 0) + 1;
      if (AT_RE.test(r.tipo || "")) {
        at++;
        const [ev, cm] = await Promise.all([get(`/tickets/${id}/events`).catch(() => []), get(`/tickets/${id}/comments`).catch(() => ({}))]);
        const A = {};
        for (const e of Array.isArray(ev) ? ev : []) {
          const x = e.event || {};
          if (e.type === "assistance-parts") { A.pecas = (x.parts || []).map((q) => ({ item: q.item ?? null, sku: q.sku ?? null, qtde: q.quantity ?? null, valor: q.price ?? null, peso: q.weight ?? null })); A.pecas_total = x.totals || null; A.pecas_em = e.datetime || null; }
          if (e.type === "assign_carrier_data") { A.transp = x.carrier_fantasy_name || x.carrier_name || null; A.frete = x.shipping_cost ?? null; A.previsao = x.delivery_estimate ?? null; A.transp_em = e.datetime || null; }
          if (e.type === "erp-order-emission") { A.pedido_erp = x.erp_order_id || null; A.pedido_erp_em = e.datetime || null; }
        }
        for (const m of (cm.comments || [])) { const k = String(m.message || "").match(/NF\s*(\d{3,})\s*-\s*(\d+)\s*emitida/i); if (k) { A.nota_at = `${k[1]}-${k[2]}`; A.nota_at_em = m.datetime || null; } }   // o último vale
        r.at = A; if (A.nota_at) comNota++; if ((A.pecas || []).length) comPecas++; if (A.frete != null) comFrete++;
      }
    } catch (e) { erros++; r.detalhe_msg = String(e.message).slice(0, 120); }
    linhas.push(r); if (linhas.length >= 200) await gravar(false);
  });
  await gravar(true);

  if (seco) { log(`tk360 (teste): ${fazer.length - erros} detalhes lidos · ${erros} com erro · ${at} de Assistência Técnica (${comNota} com Nota AT, ${comPecas} com peças, ${comFrete} com frete) · tipos: ${JSON.stringify(tipos)}`); return; }
  // 4) quem não mudou: só confirma que continua em aberto (dados da lista)
  const iguais = [...porId.values()].filter((t) => !fazer.includes(t) && ja.has(String(t.ticket_id))).map(linhaLista);
  for (let i = 0; i < iguais.length; i += 500) await chamar("tk360", "POST", iguais.slice(i, i + 500), { Prefer: "resolution=merge-duplicates,return=minimal" });
  // 5) quem sumiu da lista do 360 = resolvido/encerrado
  const sairam = [...ja.entries()].filter(([k, x]) => x.na_lista && !porId.has(k)).map(([k]) => k);
  for (let i = 0; i < sairam.length; i += 100) await chamar(`tk360?ticket_id=in.(${sairam.slice(i, i + 100).join(",")})`, "PATCH", { na_lista: false, saiu_em: agora });
  log(`tk360: ${fazer.length - erros} detalhes lidos · ${erros} com erro · ${at} de Assistência Técnica (${comNota} com Nota AT, ${comPecas} com peças, ${comFrete} com frete) · ${sairam.length} saíram da lista (fechados)`);

  // 6) comparação com o detalhamento (at_tk), só contagens: para saber quando dá para desligar o upload
  try {
    const AT = []; for (let de = 0; ; de += 1000) { const b = await chamar(`tk360?select=ticket_id,fila,at&na_lista=eq.true&at=not.is.null&offset=${de}&limit=1000`); AT.push(...b); if (b.length < 1000) break; }
    const D = (await chamar("at_tk?select=ticket,fila,nota_at,data_saida&na_planilha=eq.true&limit=5000"));
    const mA = new Map(AT.map((x) => [String(x.ticket_id), x])), mD = new Map(D.map((x) => [String(x.ticket).replace(/\D/g, ""), x]));
    const ambos = [...mD.keys()].filter((k) => mA.has(k));
    const notaIgual = ambos.filter((k) => (mD.get(k).nota_at || "").replace(/^0+/, "") === ((mA.get(k).at || {}).nota_at || "").replace(/^0+/, "")).length;
    const filaIgual = ambos.filter((k) => (mD.get(k).fila || "").trim().toLowerCase() === (mA.get(k).fila || "").trim().toLowerCase()).length;
    log(`comparação AT: detalhamento ${mD.size} · API ${mA.size} · nos dois ${ambos.length} · só no detalhamento ${mD.size - ambos.length} · só na API ${mA.size - ambos.length} · Nota AT igual ${notaIgual}/${ambos.length} · fila igual ${filaIgual}/${ambos.length}`);
    await chamar("robo_estado", "POST", { nome: "tk360:comparacao", valor: { em: agora, detalhamento: mD.size, api: mA.size, ambos: ambos.length, nota_igual: notaIgual, fila_igual: filaIgual, abertos: porId.size } }, { Prefer: "resolution=merge-duplicates,return=minimal" }).catch(() => {});
  } catch (e) { log("comparação: " + String(e.message).slice(0, 120)); }
}
