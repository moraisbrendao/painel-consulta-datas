// Reposições › Assistência Técnica · visão gerencial (Brenda 27/11, parte 106).
// Fonte: aba "Assistência Técnica" do detalhamento de tickets (botão de tickets no topo) → at_tk + uma foto por upload em at_hist.
// Robô (modo at): peças de cada ticket no 360 (Eventos › Peças de Assistência) e rastreio da Nota AT na transportadora.
// A AT não tem prazo próprio: o que vale é a entrega, acompanhada pelo rastreio.
(function () {
  const $ = (id) => document.getElementById(id);
  if (!$("rp-at")) return;
  const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n) => Number(n || 0).toLocaleString("pt-BR");
  const hora = (d) => (d ? new Date(d).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(",", " às") : "—");
  const br = (d) => (d ? String(d).slice(0, 10).split("-").reverse().join("/") : "—");
  const toast = (msg, erro) => { const t = $("toast"); if (!t) return; t.textContent = msg; t.classList.toggle("erro", !!erro); t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), erro ? 6000 : 3500); };
  const sb = () => window.__sb;
  const dias = (d) => (d ? Math.max(0, Math.floor((Date.now() - Date.parse(d)) / 86400000)) : null);
  const sem = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  let T = [], ok = true, carregou = false, card = "aberto", fTransp = "", fGrupo = "", busca = "", pag = 1;
  const alvo = (x) => x.transp_envio || x.redesp_promob || x.transp_promob || "(sem transportadora)";
  const entregue = (x) => /^entregue/i.test((x.rastreio && x.rastreio.situacao) || "");
  // etapa do ticket (fila atual + Nota AT + saída + rastreio)
  function etapa(x) {
    const f = sem(x.fila);
    if (!x.na_planilha) return "fechado";
    if (entregue(x)) return "entregue";
    if (/digitar pedido/.test(f)) return "digitar";
    if (/aguardando faturamento/.test(f)) return x.nota_at ? (x.data_saida ? "transito" : "semsaida") : "faturar";
    if (x.nota_at && !x.data_saida) return "semsaida";
    if (x.data_saida || /aguardando entrega/.test(f)) return "transito";
    return "outras";
  }
  const CARDS = [
    ["aberto", "Em aberto", "todos os tickets de AT na planilha", ""],
    ["digitar", "Digitar pedido", "fila Digitar pedido de AT", ""],
    ["faturar", "Aguardando faturamento", "sem Nota AT emitida", "c-amarelo"],
    ["semsaida", "NF AT sem saída", "Nota AT emitida, sem data de saída", "c-amarelo"],
    ["transito", "Em trânsito", "saiu ou aguardando entrega, sem entrega no rastreio", ""],
    ["parado", "Parados no trânsito", "saiu há mais de 10 dias e não entregou", "c-verm"],
    ["entregue", "Entregue no rastreio", "ainda aberto no 360: falta dar baixa", "c-verde"],
    ["outras", "Outras filas", "SAC, depósito, produção de peças, crédito…", ""],
    ["fechado", "Saíram da planilha", "fechados desde o 1º upload", ""],
  ];
  const noCard = (x, k) => k === "aberto" ? x.na_planilha : k === "parado" ? etapa(x) === "transito" && x.data_saida && dias(x.data_saida) > 10 : etapa(x) === k;
  const filtroBase = (x) => (!fTransp || alvo(x) === fTransp) && (!fGrupo || (x.grupo || "—") === fGrupo)
    && (!busca || [x.ticket, x.nota_ticket, x.nota_at, x.pedido].some((v) => String(v || "").includes(busca)));

  async function carregar() {
    let tudo = [];
    for (let de = 0; de < 50000; de += 1000) {
      const r = await sb().from("at_tk").select("*").order("criado_em", { ascending: false }).range(de, de + 999);
      if (r.error) { ok = false; T = []; desenhar(); return; }
      tudo = tudo.concat(r.data || []); if (!r.data || r.data.length < 1000) break;
    }
    ok = true; T = tudo; desenhar();
  }
  function opcoes(id, vals, atual, todos) {
    const v = [...new Set(vals)].sort((a, b) => a.localeCompare(b, "pt-BR"));
    $(id).innerHTML = `<option value="">${todos}</option>` + v.map((x) => `<option${x === atual ? " selected" : ""}>${esc(x)}</option>`).join("");
  }
  function desenhar() {
    if (!ok) { $("at-info").textContent = "Para usar esta aba, rode a parte 106 no Supabase e depois suba o detalhamento de tickets."; ["at-cards", "at-lista", "at-env", "at-transp", "at-pecas", "at-evol"].forEach((i) => ($(i).innerHTML = "")); return; }
    const abertos = T.filter((x) => x.na_planilha);
    const ult = T.map((x) => x.visto_em).filter(Boolean).sort().pop(), pc = T.map((x) => x.pecas_em).filter(Boolean).sort().pop(), rs = T.map((x) => x.rastreio_em).filter(Boolean).sort().pop();
    $("at-info").textContent = T.length ? `${fmt(abertos.length)} tickets de AT em aberto · planilha de ${hora(ult)} · peças lidas pelo robô ${hora(pc)} · rastreio ${hora(rs)}` : "Nenhum ticket de AT ainda: suba o detalhamento de tickets (botão Tickets no topo).";
    opcoes("at-f-transp", T.map(alvo), fTransp, "Todas as transportadoras");
    opcoes("at-f-grupo", T.map((x) => x.grupo || "—"), fGrupo, "Todos os grupos");
    const B = T.filter(filtroBase);
    $("at-cards").innerHTML = CARDS.map(([k, rot, sub, cor]) => `<button type="button" class="kpi ${cor}${card === k ? " ativa" : ""}" data-atc="${k}"><span class="kpi-rot">${rot}</span><b class="kpi-num">${fmt(B.filter((x) => noCard(x, k)).length)}</b><small>${sub}</small></button>`).join("");
    const V = B.filter((x) => noCard(x, card));
    // envelhecimento: dias desde a criação do ticket, por fila (só abertos)
    const FX = [["0–7", 0, 7], ["8–15", 8, 15], ["16–30", 16, 30], ["31–60", 31, 60], ["+60", 61, 1e9]];
    const porFila = new Map(); B.filter((x) => x.na_planilha).forEach((x) => { const f = x.fila || "—"; if (!porFila.has(f)) porFila.set(f, { f, g: x.grupo || "—", n: FX.map(() => 0), t: 0, soma: 0 }); const o = porFila.get(f), d = dias(x.criado_em) ?? 0; o.n[FX.findIndex(([, a, b]) => d >= a && d <= b)]++; o.t++; o.soma += d; });
    const filas = [...porFila.values()].sort((a, b) => b.t - a.t);
    $("at-env").innerHTML = filas.length ? `<table class="tabela-pedidos"><thead><tr><th>Fila atual</th><th>Grupo</th>${FX.map(([r]) => `<th class="num">${r} dias</th>`).join("")}<th class="num">Total</th><th class="num">Média (dias)</th></tr></thead><tbody>${filas.map((o) => `<tr><td>${esc(o.f)}</td><td>${esc(o.g)}</td>${o.n.map((v, i) => `<td class="num${i >= 3 && v ? " at-ruim" : ""}">${v ? fmt(v) : "·"}</td>`).join("")}<td class="num"><b>${fmt(o.t)}</b></td><td class="num">${fmt(Math.round(o.soma / o.t))}</td></tr>`).join("")}</tbody></table>` : `<p class="vazio">Nada aqui.</p>`;
    // por transportadora do envio da AT
    const porT = new Map(); B.filter((x) => x.na_planilha || entregue(x)).forEach((x) => { const t = alvo(x); if (!porT.has(t)) porT.set(t, { t, n: 0, nota: 0, saiu: 0, ent: 0, trans: 0, par: 0, sd: 0, sn: 0 }); const o = porT.get(t); o.n++; if (x.nota_at) o.nota++; if (x.data_saida) o.saiu++;
      if (entregue(x)) o.ent++; else if (x.data_saida) { o.trans++; const d = dias(x.data_saida); o.sd += d; o.sn++; if (d > 10) o.par++; } });
    const tps = [...porT.values()].sort((a, b) => b.n - a.n);
    $("at-transp").innerHTML = tps.length ? `<table class="tabela-pedidos"><thead><tr><th>Transportadora (envio da AT)</th><th class="num">Tickets</th><th class="num">Com Nota AT</th><th class="num">Saíram</th><th class="num">Entregues (rastreio)</th><th class="num">Em trânsito</th><th class="num">Dias em trânsito (média)</th><th class="num">Parados +10 dias</th></tr></thead><tbody>${tps.map((o) => `<tr data-att="${esc(o.t)}" class="at-cli"><td>${esc(o.t)}</td><td class="num"><b>${fmt(o.n)}</b></td><td class="num">${fmt(o.nota)}</td><td class="num">${fmt(o.saiu)}</td><td class="num">${fmt(o.ent)}</td><td class="num">${fmt(o.trans)}</td><td class="num">${o.sn ? fmt(Math.round(o.sd / o.sn)) : "—"}</td><td class="num${o.par ? " at-ruim" : ""}">${fmt(o.par)}</td></tr>`).join("")}</tbody></table>` : `<p class="vazio">Nada aqui.</p>`;
    // peças que mais dão AT (Brenda 27/11). No 360: SKU = produto (móvel), Item = código da peça. Todos os tickets lidos, abertos e fechados.
    const pecas = new Map(), prods = new Map(); let lidos = 0;
    B.forEach((x) => { if (!x.pecas_em) return; lidos++; (x.pecas || []).forEach((p) => {
      const k = (p.peca || "?").trim(); if (!pecas.has(k)) pecas.set(k, { item: k, skus: new Set(), tk: new Set(), q: 0 }); const o = pecas.get(k); o.tk.add(x.ticket); o.q += Number(p.qtde) || 1; if (p.sku) o.skus.add(p.sku);
      const s2 = (p.sku || "?").trim(); if (!prods.has(s2)) prods.set(s2, { sku: s2, tk: new Set(), itens: new Set() }); const q = prods.get(s2); q.tk.add(x.ticket); q.itens.add(k); }); });
    const rk = [...pecas.values()].sort((a, b) => b.tk.size - a.tk.size || b.q - a.q), rp = [...prods.values()].sort((a, b) => b.tk.size - a.tk.size);
    $("at-pecas-info").textContent = `${fmt(lidos)} de ${fmt(B.length)} tickets já lidos pelo robô · Item = código da peça, SKU = produto`;
    const barra = (v, m) => `<div class="at-barra" style="width:${Math.round((v / (m || 1)) * 100)}%"></div>`;
    $("at-pecas").innerHTML = rk.length ? `<div class="at-duas"><div><h3>Peças (Item)</h3><table class="tabela-pedidos"><thead><tr><th>#</th><th>Item (peça)</th><th>Produto(s) SKU</th><th class="num">Tickets</th><th class="num">Qtde</th><th></th></tr></thead><tbody>${rk.slice(0, 30).map((o, i) => `<tr><td>${i + 1}</td><td><b>${esc(o.item)}</b></td><td class="s">${esc([...o.skus].slice(0, 3).join(", "))}${o.skus.size > 3 ? ` +${o.skus.size - 3}` : ""}</td><td class="num"><b>${fmt(o.tk.size)}</b></td><td class="num">${fmt(o.q)}</td><td style="width:22%">${barra(o.tk.size, rk[0].tk.size)}</td></tr>`).join("")}</tbody></table>${rk.length > 30 ? `<p class="s">Mostrando 30 de ${fmt(rk.length)} peças. O Excel tem todas.</p>` : ""}</div>
      <div><h3>Produtos (SKU)</h3><table class="tabela-pedidos"><thead><tr><th>#</th><th>SKU</th><th class="num">Tickets</th><th class="num">Peças diferentes</th><th></th></tr></thead><tbody>${rp.slice(0, 30).map((o, i) => `<tr><td>${i + 1}</td><td><b>${esc(o.sku)}</b></td><td class="num"><b>${fmt(o.tk.size)}</b></td><td class="num">${fmt(o.itens.size)}</td><td style="width:30%">${barra(o.tk.size, rp[0].tk.size)}</td></tr>`).join("")}</tbody></table></div></div>`
      : `<p class="vazio">${lidos ? "O robô ainda não achou peças nos tickets lidos." : "O robô ainda não leu as peças: clique em ▶ Ler peças e rastreio."}</p>`;
    // evolução semanal: tickets abertos × que saíram da planilha (fechados)
    const sem0 = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x.toISOString().slice(0, 10); };
    const W = new Map(); const add = (d, k) => { if (!d) return; const s = sem0(d); if (!W.has(s)) W.set(s, { s, a: 0, f: 0, e: 0 }); W.get(s)[k]++; };
    B.forEach((x) => { add(x.criado_em, "a"); add(x.saiu_em, "f"); if (x.data_saida) add(x.data_saida + "T12:00:00", "e"); });
    const ws = [...W.values()].sort((a, b) => a.s.localeCompare(b.s)).slice(-12);
    $("at-evol").innerHTML = ws.length ? `<table class="tabela-pedidos"><thead><tr><th>Semana de</th><th class="num">Tickets abertos</th><th class="num">Notas AT que saíram</th><th class="num">Fechados (saíram da planilha)</th></tr></thead><tbody>${ws.map((w) => `<tr><td>${br(w.s)}</td><td class="num">${fmt(w.a)}</td><td class="num">${fmt(w.e)}</td><td class="num">${fmt(w.f)}</td></tr>`).join("")}</tbody></table><p class="s">Fechados só contam a partir do 1º upload do detalhamento com a parte 106.</p>` : `<p class="vazio">Nada aqui.</p>`;
    // lista do card
    $("at-titulo").textContent = `${CARDS.find((c) => c[0] === card)[1]} (${fmt(V.length)})`;
    const POR = 100, pags = Math.max(1, Math.ceil(V.length / POR)); if (pag > pags) pag = pags;
    $("at-lista").innerHTML = V.length ? `<table class="tabela-pedidos"><thead><tr><th>Ticket</th><th>Criado</th><th class="num">Dias</th><th>Fila / grupo</th><th>NF do pedido</th><th>Nota AT</th><th>Saída</th><th>Transportadora</th><th>Rastreio</th><th>Peças</th></tr></thead><tbody>${V.slice((pag - 1) * POR, pag * POR).map((x) => `<tr>
        <td><a href="https://appv2.360multi.com/tickets/${encodeURIComponent(x.ticket)}" target="_blank" rel="noopener">${esc(x.ticket)}</a></td><td>${br(x.criado_em)}</td><td class="num">${dias(x.criado_em) ?? "—"}</td>
        <td>${esc(x.fila || "—")}<div class="s">${esc(x.grupo || "")}</div></td><td>${esc(x.nota_ticket || "—")}</td><td>${esc(x.nota_at || "—")}</td><td>${br(x.data_saida)}</td><td>${esc(alvo(x))}</td>
        <td>${x.rastreio ? `${entregue(x) ? "✅ " : ""}${esc(x.rastreio.situacao || "—")}${x.rastreio.evento ? `<div class="s">${esc(x.rastreio.evento)}${x.rastreio.data ? " · " + esc(x.rastreio.data) : ""}</div>` : ""}` : `<span class="s">${x.nota_at ? "aguardando robô" : "—"}</span>`}</td>
        <td>${(x.pecas || []).length ? x.pecas.map((p) => `<div><b>${esc(p.peca || "?")}</b>${p.qtde ? ` ×${fmt(p.qtde)}` : ""}${p.sku ? ` <span class="s">${esc(p.sku)}</span>` : ""}</div>`).join("") : `<span class="s">${x.pecas_em ? x.pecas_msg || "sem peça" : "aguardando robô"}</span>`}</td></tr>`).join("")}</tbody></table>
        ${pags > 1 ? `<div class="paginacao"><button class="btn mini contorno" data-atp="-1"${pag === 1 ? " disabled" : ""}>‹</button> página ${pag} de ${pags} <button class="btn mini contorno" data-atp="1"${pag === pags ? " disabled" : ""}>›</button></div>` : ""}` : `<p class="vazio">Nenhum ticket aqui.</p>`;
  }
  $("rp-at").addEventListener("click", (e) => {
    const c = e.target.closest("[data-atc]"); if (c) { card = c.dataset.atc; pag = 1; desenhar(); return; }
    const t = e.target.closest("[data-att]"); if (t) { fTransp = fTransp === t.dataset.att ? "" : t.dataset.att; pag = 1; desenhar(); return; }
    const p = e.target.closest("[data-atp]"); if (p) { pag += Number(p.dataset.atp); desenhar(); }
  });
  $("at-f-transp").addEventListener("change", (e) => { fTransp = e.target.value; pag = 1; desenhar(); });
  $("at-f-grupo").addEventListener("change", (e) => { fGrupo = e.target.value; pag = 1; desenhar(); });
  $("at-busca").addEventListener("input", (e) => { busca = e.target.value.replace(/\D/g, ""); pag = 1; desenhar(); });
  $("at-rodar").addEventListener("click", async () => {
    const { error } = await sb().rpc("rodar_robo_at");
    if (error) return toast(/rodar_robo_at|function/i.test(error.message) ? "Falta rodar a parte 106 no Supabase." : "Não consegui chamar o robô: " + error.message, true);
    toast("Robô chamado: as peças e o rastreio aparecem aqui em alguns minutos."); setTimeout(carregar, 300000);
  });
  $("at-excel").addEventListener("click", () => {
    if (!window.XLSX) return toast("O Excel ainda está carregando.", true);
    const B = T.filter(filtroBase);
    const tk = B.map((x) => ({ Ticket: x.ticket, Criado: br(x.criado_em), "Dias desde a criação": dias(x.criado_em), Etapa: (CARDS.find((c) => c[0] === etapa(x)) || [, etapa(x)])[1], "Fila atual": x.fila, Grupo: x.grupo, "Nota do ticket": x.nota_ticket, "Pedido Intelipost": x.pedido,
      "Nota AT": x.nota_at, "Saída da Nota AT": br(x.data_saida), "Transportadora (envio AT)": alvo(x), "Rastreio": x.rastreio ? x.rastreio.situacao : "", "Último evento": x.rastreio ? [x.rastreio.evento, x.rastreio.data].filter(Boolean).join(" · ") : "",
      "Peças (item × qtde)": (x.pecas || []).map((p) => `${p.peca || "?"}${p.qtde ? " ×" + p.qtde : ""}`).join("; "), "Produto (SKU)": [...new Set((x.pecas || []).map((p) => p.sku).filter(Boolean))].join(", "), "Na planilha": x.na_planilha ? "sim" : "não (fechado)" }));
    const pc = new Map(); B.forEach((x) => (x.pecas || []).forEach((p) => { const k = (p.peca || "?").trim(); if (!pc.has(k)) pc.set(k, { "Item (peça)": k, sk: new Set(), tk: new Set(), Qtde: 0 }); const o = pc.get(k); o.tk.add(x.ticket); o.Qtde += Number(p.qtde) || 1; if (p.sku) o.sk.add(p.sku); }));
    const rk = [...pc.values()].sort((a, b) => b.tk.size - a.tk.size).map(({ tk: s2, sk, ...o }) => ({ ...o, "Produtos (SKU)": [...sk].join(", "), Tickets: s2.size }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(tk), "Tickets AT");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rk.length ? rk : [{ "Item (peça)": "ainda sem peças lidas" }]), "Peças");
    XLSX.writeFile(wb, `assistencia_tecnica_${new Date().toISOString().slice(0, 10)}.xlsx`);
  });
  window.__at = { recarregar: () => { if (carregou) carregar(); } };
  setInterval(() => { if ($("rp-at").offsetParent && window.__sb && !carregou) { carregou = true; carregar(); setInterval(() => { if ($("rp-at").offsetParent) carregar(); }, 180000); } }, 2000);
})();
