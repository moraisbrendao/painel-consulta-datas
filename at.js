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

  let T = [], ok = true, carregou = false, card = "acao", fTransp = "", fGrupo = "", fQuem = "", busca = "", pag = 1, DESC = new Map(), FR = [], FRn = new Map(), FRp = new Map();
  // um nome só por transportadora (Brenda 27/11: "une as duplicadas"): tira filial, Standard, Transportes… e junta VM com Tempo Justo
  const NOMES = [[/jad\s*log/, "JadLog"], [/dominalog/, "Dominalog"], [/prolog/, "Prolog"], [/atual\s*cargas/, "Atual Cargas"], [/transiga/, "Transiga"], [/trans\s*sua/, "Trans Sua Log"],
    [/^blz/, "BLZ"], [/aceville/, "Aceville"], [/vm\s*transp|tempo\s*justo/, "VM Transportes / Tempo Justo"], [/petrymar/, "Petrymar"], [/sajob/, "SAJOB"], [/bento/, "Bento Brasil"], [/transvanio/, "Transvanio"],
    [/rapido\s*alem/, "Rápido Além Paraíba"], [/translovato/, "Translovato"], [/transito\s*brasil/, "Trânsito Brasil"], [/formato/, "Formato"], [/trilog/, "Trilog"], [/flog/, "Flog"], [/tsl/, "TSL"]];
  const nomeTp = (t) => { const n = sem(t).trim(); if (!n) return ""; for (const [re, v] of NOMES) if (re.test(n)) return v;
    return String(t).replace(/\s*-?\s*filial\s+\w+$/i, "").replace(/\s*-?\s*standard$/i, "").replace(/\s+(transportes?|log[ií]stica|ltda)$/i, "").trim(); };
  const alvo = (x) => nomeTp(x.transp_envio || x.redesp_promob || x.transp_promob) || "(sem transportadora)";
  const entregue = (x) => /^entregue/i.test((x.rastreio && x.rastreio.situacao) || "");
  const dBR = (s) => { const m = String(s || "").match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
  const entregaEm = (x) => (entregue(x) ? dBR(x.rastreio.data) : null);
  const entre = (a, b) => (a && b ? Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 86400000)) : null);
  const ev = (x) => sem((x.rastreio && x.rastreio.evento) || "");
  // insucesso que depende do cliente / devolução (eventos vistos no rastreio das Notas AT em 27/11)
  const EV_CLIENTE = /ausente|endereco insuficiente|recusad|nao entrou|impossibilidade|fechado|mudou|desconhecido/, EV_DEVOL = /devolu/;
  const FILA_CLIENTE = /aprovacao de devolucao cliente|dados para deposito/;
  // Central de ações (Brenda 27/11): cada ticket aberto tem um "cartão", quem precisa agir e o próximo passo
  function situacao(x) {
    const f = sem(x.fila), dc = dias(x.criado_em) ?? 0, ds = dias(x.data_saida), st = sem((x.rastreio && x.rastreio.situacao) || "");
    if (!x.na_planilha) return { k: "fechado", quem: "", passo: "Concluído (saiu da planilha)", p: 0 };
    if (entregue(x)) { const de = dias(entregaEm(x)); return { k: "entregue", quem: "Multimóveis", passo: `Confirmar com o cliente e dar baixa no ticket (entregue ${x.rastreio.data ? "em " + String(x.rastreio.data).slice(0, 10) : "no rastreio"})`, p: 60 + (de || 0) }; }
    // filas do financeiro / SAC: a entrega já não é o assunto (ex.: Recuperação de crédito com saída antiga)
    if (/recuperacao de credito|devolver valor|definir pagador/.test(f)) return { k: "outras", quem: "Multimóveis", passo: `Resolver na fila ${x.fila}`, p: 20 + dc };
    if (FILA_CLIENTE.test(f)) return { k: "outras", quem: "Cliente", passo: `Aguardando o cliente (${x.fila})`, p: 20 + dc };
    if (x.data_saida || /aguardando entrega/.test(f)) {
      if (!x.data_saida) return { k: "transporte", quem: "Multimóveis", passo: "Fila Aguardando entrega sem data de saída da Nota AT: conferir se a peça saiu", p: 40 + dc, alerta: true };
      if (EV_DEVOL.test(ev(x))) return { k: "atrasada", quem: "Transportadora", passo: `Peça em devolução: falar com a transportadora e decidir o reenvio (${x.rastreio.evento})`, p: 200 + ds };
      if (EV_CLIENTE.test(ev(x))) return { k: "atrasada", quem: "Cliente", passo: `Insucesso na entrega (${x.rastreio.evento}): contatar o cliente e reagendar`, p: 190 + ds };
      if (/sem cte/.test(st) && ds > 3) return { k: "atrasada", quem: "Transportadora", passo: `Saiu há ${ds} dias e a transportadora ainda não emitiu CT-e: cobrar a coleta`, p: 150 + ds };
      if (ds > 10) return { k: "atrasada", quem: "Transportadora", passo: `${ds} dias em trânsito sem entrega: cobrar previsão da transportadora`, p: 100 + ds };
      return { k: "transporte", quem: "Transportadora", passo: x.rastreio ? `Acompanhar o rastreio (${x.rastreio.situacao}${x.rastreio.evento ? " · " + x.rastreio.evento : ""})` : "Acompanhar o rastreio (o robô ainda não leu)", p: 10 + ds };
    }
    if (x.nota_at) return { k: "expedicao", quem: "Multimóveis", passo: "Nota AT emitida sem saída: expedir a peça", p: 50 + dc };
    if (/digitar pedido/.test(f)) return { k: "pecas", quem: "Multimóveis", passo: "Digitar o pedido da peça", p: 30 + dc };
    if (/aguardando faturamento/.test(f)) return { k: "pecas", quem: "Multimóveis", passo: "Faturar a Nota AT da peça", p: 30 + dc };
    if (/producao de pecas/.test(f)) return { k: "pecas", quem: "Fornecedor", passo: "Aguardando produção da peça pelo terceiro: cobrar prazo", p: 30 + dc };
    if (FILA_CLIENTE.test(f)) return { k: "outras", quem: "Cliente", passo: `Aguardando o cliente (${x.fila})`, p: 20 + dc };
    return { k: "outras", quem: "Multimóveis", passo: `Resolver na fila ${x.fila || "—"}`, p: 20 + dc };
  }
  const CARDS = [
    ["acao", "Precisa de ação agora", "do mais urgente ao menos (sem os em trânsito normal)", "vermelho"],
    ["aberto", "Tickets em aberto", "total da operação", ""],
    ["pecas", "Aguardando peças", "pendência interna: digitar pedido, faturar", "laranja"],
    ["expedicao", "Aguardando expedição", "Nota AT emitida, peça ainda não saiu", "laranja"],
    ["transporte", "Em transporte", "Notas AT em trânsito, dentro do normal", "azul"],
    ["atrasada", "Entrega com problema", "+10 dias, sem CT-e, insucesso ou devolução", "vermelho"],
    ["entregue", "Entregue sem confirmação", "pós-entrega pendente: dar baixa", "roxo"],
    ["outras", "Financeiro e outras filas", "devolução de valor, crédito, pagador…", ""],
    ["fechado", "Concluídos", "saíram da planilha desde o 1º upload", ""],
  ];
  // "Precisa de ação": abertos menos os que estão só em trânsito normal (aí é esperar a transportadora)
  const noCard = (x, k) => k === "aberto" ? x.na_planilha : k === "acao" ? x.na_planilha && situacao(x).k !== "transporte" : situacao(x).k === k;
  const filtroBase = (x) => (!fTransp || alvo(x) === fTransp) && (!fGrupo || (x.grupo || "—") === fGrupo)
    && (!busca || [x.ticket, x.nota_ticket, x.nota_at, x.pedido].some((v) => String(v || "").includes(busca)));
  const brl = (v) => (v == null ? "—" : Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }));
  // valor da linha da peça no 360 (a coluna valor; se vier unitário, o total é valor × qtde: sem saber, usamos o valor da linha)
  const valorPeca = (p) => (p && p.valor != null ? Number(p.valor) || 0 : null);
  const kN = (t) => String(t || "").split("-").map((v) => v.trim().replace(/^0+(?=\d)/, "")).join("-");
  const freteTk = (x) => (x._fr && x._fr.length ? x._fr.reduce((a, f) => a + (Number(f.valor_cte) || 0), 0) : null);
  const dataNota = (x) => (x._fr && x._fr.length ? x._fr.map((f) => f.data_nota).filter(Boolean).sort()[0] || null : null);
  const valorTk = (x) => { const vs = (x.pecas || []).map(valorPeca).filter((v) => v != null); return vs.length ? vs.reduce((a, b) => a + b, 0) : null; };

  async function carregar() {
    let tudo = [];
    for (let de = 0; de < 50000; de += 1000) {
      const r = await sb().from("at_tk").select("*").order("criado_em", { ascending: false }).range(de, de + 999);
      if (r.error) { ok = false; T = []; desenhar(); return; }
      tudo = tudo.concat(r.data || []); if (!r.data || r.data.length < 1000) break;
    }
    ok = true; T = tudo;
    // frete das ATs (parte 109): planilha de CT-e ligada pela Nota AT (nota-série) ou pela Ordem de Compra (NF do pedido)
    try { let fr = []; for (let de = 0; de < 50000; de += 1000) { const r = await sb().from("at_frete").select("*").range(de, de + 999); if (r.error) break; fr = fr.concat(r.data || []); if (!r.data || r.data.length < 1000) break; }
      FR = fr; FRn = new Map(); FRp = new Map();
      FR.forEach((f) => { const k = kN(f.nota); if (!FRn.has(k)) FRn.set(k, []); FRn.get(k).push(f);
        const oc = (String(f.ordem_compra || "").match(/(\d{4,7})\s*-\s*(\d{1,3})/) || []); if (oc[1]) { const k2 = kN(oc[1] + "-" + oc[2]); if (!FRp.has(k2)) FRp.set(k2, []); FRp.get(k2).push(f); } });
      T.forEach((x) => { const a = x.nota_at && FRn.get(kN(x.nota_at)), b = !a && x.nota_ticket && FRp.get(kN(x.nota_ticket)); x._fr = a || b || null; });
    } catch (_) {}
    // descrição da peça: o código do item costuma ser o código do volume da planilha de volumes (Base Cadastros)
    try { const its = [...new Set(T.flatMap((x) => (x.pecas || []).map((p) => (p.peca || "").trim())).filter(Boolean))];
      for (let i = 0; i < its.length; i += 300) { const r = await sb().from("vol_cadastro").select("volume,descricao").in("volume", its.slice(i, i + 300)); (r.data || []).forEach((c) => c.descricao && DESC.set(String(c.volume).trim(), c.descricao)); } } catch (_) {}
    desenhar();
  }
  function opcoes(id, vals, atual, todos) {
    const v = [...new Set(vals)].sort((a, b) => a.localeCompare(b, "pt-BR"));
    $(id).innerHTML = `<option value="">${todos}</option>` + v.map((x) => `<option${x === atual ? " selected" : ""}>${esc(x)}</option>`).join("");
  }
  const med = (a) => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y), m = Math.floor(b.length / 2); return b.length % 2 ? b[m] : Math.round((b[m - 1] + b[m]) / 2); };
  const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
  const QUEM_COR = { "Multimóveis": "at-q-mm", Transportadora: "at-q-tp", Cliente: "at-q-cl", Fornecedor: "at-q-fo" };
  function desenhar() {
    if (!ok) { $("at-info").textContent = "Para usar esta aba, rode a parte 106 no Supabase e depois suba o detalhamento de tickets."; ["at-cards", "at-lista", "at-env", "at-transp", "at-pecas", "at-evol", "at-quem", "at-tempo", "at-custo", "at-reinc"].forEach((i) => $(i) && ($(i).innerHTML = "")); return; }
    const abertos = T.filter((x) => x.na_planilha);
    const ult = T.map((x) => x.visto_em).filter(Boolean).sort().pop(), pc = T.map((x) => x.pecas_em).filter(Boolean).sort().pop(), rs = T.map((x) => x.rastreio_em).filter(Boolean).sort().pop();
    $("at-info").textContent = T.length ? `${fmt(abertos.length)} tickets de AT em aberto · planilha de ${hora(ult)} · peças lidas pelo robô ${hora(pc)} · rastreio ${hora(rs)}` : "Nenhum ticket de AT ainda: suba o detalhamento de tickets (botão Tickets no topo).";
    opcoes("at-f-transp", T.map(alvo), fTransp, "Todas as transportadoras");
    opcoes("at-f-grupo", T.map((x) => x.grupo || "—"), fGrupo, "Todos os grupos");
    const B = T.filter(filtroBase), S = new Map(B.map((x) => [x.ticket, situacao(x)]));
    const sit = (x) => S.get(x.ticket) || situacao(x);
    $("at-cards").innerHTML = CARDS.map(([k, rot, sub, cor]) => `<button type="button" class="kpi ${cor}${card === k ? " ativa" : ""}" data-atc="${k}"><span class="kpi-rot">${rot}</span><b class="kpi-num">${fmt(B.filter((x) => noCard(x, k) && (!fQuem || k === "fechado" || sit(x).quem === fQuem)).length)}</b><small>${sub}</small></button>`).join("");
    // quem precisa agir (abertos)
    const Q = new Map(); B.filter((x) => x.na_planilha).forEach((x) => { const s = sit(x); if (!Q.has(s.quem)) Q.set(s.quem, { n: 0, urg: 0, passos: new Map() }); const o = Q.get(s.quem); o.n++; if (s.k === "atrasada" || s.alerta) o.urg++; const pk = s.passo.replace(/\d+ dias/g, "N dias").replace(/\(.*\)/, "").trim(); o.passos.set(pk, (o.passos.get(pk) || 0) + 1); });
    $("at-quem").innerHTML = [...Q.entries()].sort((a, b) => b[1].n - a[1].n).map(([q, o]) => `<button type="button" class="at-quem-b ${QUEM_COR[q] || ""}${fQuem === q ? " ativa" : ""}" data-atq="${esc(q)}"><b>${esc(q)}</b> <span class="at-quem-n">${fmt(o.n)}</span>${o.urg ? ` <span class="at-quem-u">${fmt(o.urg)} com problema</span>` : ""}<span class="s">${[...o.passos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p, n]) => `${fmt(n)} · ${esc(p)}`).join("<br>")}</span></button>`).join("") || "";
    const V = B.filter((x) => noCard(x, card) && (!fQuem || sit(x).quem === fQuem)).sort((a, b) => card === "fechado" ? String(b.saiu_em || "").localeCompare(String(a.saiu_em || "")) : sit(b).p - sit(a).p);

    // 2) o que está acontecendo: tempo por etapa (Multimóveis × transportadora × conclusão)
    const ETP = [
      ...(FR.length ? [["Abertura do ticket → emissão da Nota AT", "Multimóveis", "analisar, digitar o pedido e faturar (data da nota na planilha de frete)", B.filter((x) => dataNota(x)).map((x) => entre(x.criado_em, dataNota(x))), B.filter((x) => x.na_planilha && !x.nota_at).map((x) => dias(x.criado_em))],
        ["Emissão da Nota AT → saída", "Multimóveis", "separar e expedir a peça", B.filter((x) => dataNota(x) && x.data_saida).map((x) => entre(dataNota(x), x.data_saida)), B.filter((x) => x.na_planilha && x.nota_at && !x.data_saida).map((x) => (dataNota(x) ? dias(dataNota(x)) : null))]] : []),
      ["Abertura do ticket → saída da Nota AT", "Multimóveis", "analisar, digitar, faturar e expedir a peça", B.filter((x) => x.data_saida).map((x) => entre(x.criado_em, x.data_saida)), B.filter((x) => x.na_planilha && !x.data_saida && !entregue(x)).map((x) => dias(x.criado_em))],
      ["Saída da Nota AT → entrega", "Transportadora", "transporte da peça até o cliente (rastreio)", B.filter((x) => entregaEm(x) && x.data_saida).map((x) => entre(x.data_saida, entregaEm(x))), B.filter((x) => x.na_planilha && x.data_saida && !entregue(x)).map((x) => dias(x.data_saida))],
      ["Entrega → baixa do ticket", "Multimóveis", "confirmar com o cliente e encerrar", B.filter((x) => entregaEm(x) && x.saiu_em).map((x) => entre(entregaEm(x), x.saiu_em)), B.filter((x) => x.na_planilha && entregue(x)).map((x) => dias(entregaEm(x)))],
      ["Total: abertura → entrega", "—", "o que o cliente sente", B.filter((x) => entregaEm(x)).map((x) => entre(x.criado_em, entregaEm(x))), B.filter((x) => x.na_planilha && !entregue(x)).map((x) => dias(x.criado_em))],
    ];
    $("at-tempo").innerHTML = `<table class="tabela-pedidos"><thead><tr><th>Etapa</th><th>Quem</th><th class="num">Concluídos</th><th class="num">Mediana (dias)</th><th class="num">Média (dias)</th><th class="num">Em andamento agora</th><th class="num">Média até hoje</th><th class="num">Mais antigo</th></tr></thead><tbody>${ETP.map(([e, q, d, feitos, and]) => { const a = and.filter((v) => v != null), f = feitos.filter((v) => v != null);
      return `<tr><td><b>${esc(e)}</b><div class="s">${esc(d)}</div></td><td>${q === "—" ? "—" : `<span class="at-quem-chip ${QUEM_COR[q] || ""}">${esc(q)}</span>`}</td><td class="num">${fmt(f.length)}</td><td class="num"><b>${med(f) ?? "—"}</b></td><td class="num">${avg(f) ?? "—"}</td><td class="num">${fmt(a.length)}</td><td class="num">${avg(a) ?? "—"}</td><td class="num${a.length && Math.max(...a) > 30 ? " at-ruim" : ""}">${a.length ? Math.max(...a) : "—"}</td></tr>`; }).join("")}</tbody></table>
      <p class="s">A AT não tem prazo próprio: o prazo é a entrega. Aqui fica separado o tempo da Multimóveis (até a peça sair) do tempo da transportadora (da saída até a entrega no rastreio). ${FR.length ? "A data de emissão da Nota AT vem da planilha de frete (CT-e)." : "Para separar análise/faturamento da expedição, suba a planilha de frete (CT-e): ela traz a data de emissão da Nota AT."} Entregas contam só as confirmadas pelo robô no rastreio.</p>`;

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
    // 3) por que está acontecendo: peças que mais dão AT (Brenda 27/11). No 360: SKU = produto (móvel), Item = código da peça. Abertos e fechados.
    const mes = (d) => String(d || "").slice(0, 7), hoje = new Date(), MS = [2, 1, 0].map((k) => { const d = new Date(hoje.getFullYear(), hoje.getMonth() - k, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; });
    const nomeMes = (m) => new Date(m + "-15").toLocaleString("pt-BR", { month: "short" }).replace(".", "");
    const pecas = new Map(), prods = new Map(); let lidos = 0, comValor = 0;
    B.forEach((x) => { if (!x.pecas_em) return; lidos++; if (valorTk(x) != null) comValor++; const ped = x.nota_ticket || x.pedido || x.ticket; (x.pecas || []).forEach((p) => {
      const k = (p.peca || "?").trim(); if (!pecas.has(k)) pecas.set(k, { item: k, skus: new Set(), tk: new Set(), ped: new Set(), q: 0, v: 0, m: {} }); const o = pecas.get(k); o.tk.add(x.ticket); o.ped.add(ped); o.q += Number(p.qtde) || 1; if (valorPeca(p) != null) { o.v += valorPeca(p); o.tv = true; } if (p.sku) o.skus.add(p.sku); o.m[mes(x.criado_em)] = (o.m[mes(x.criado_em)] || 0) + 1;
      const s2 = (p.sku || "?").trim(); if (!prods.has(s2)) prods.set(s2, { sku: s2, tk: new Set(), itens: new Set(), v: 0 }); const q = prods.get(s2); q.tk.add(x.ticket); q.itens.add(k); q.v += valorPeca(p) || 0; }); });
    const rk = [...pecas.values()].sort((a, b) => b.tk.size - a.tk.size || b.q - a.q), rp = [...prods.values()].sort((a, b) => b.tk.size - a.tk.size);
    const tem$ = comValor > 0;
    $("at-pecas-info").textContent = `${fmt(lidos)} de ${fmt(B.length)} tickets já lidos pelo robô · Item = código da peça, SKU = produto · Reincidência = a peça voltou em 3 ou mais tickets` + (tem$ ? "" : " · o valor das peças aparece depois que o robô reler os tickets");
    const barra = (v, m) => `<div class="at-barra" style="width:${Math.round((v / (m || 1)) * 100)}%"></div>`;
    $("at-pecas").innerHTML = rk.length ? `<div class="at-duas"><div><h3>Peças (Item)</h3><table class="tabela-pedidos"><thead><tr><th>#</th><th>Item (peça)</th><th>Produto(s) SKU</th><th class="num">Tickets</th><th class="num">Pedidos afetados</th><th class="num">Qtde</th>${tem$ ? `<th class="num">Valor</th>` : ""}${MS.map((m) => `<th class="num">${nomeMes(m)}</th>`).join("")}<th></th></tr></thead><tbody>${rk.slice(0, 30).map((o, i) => `<tr><td>${i + 1}</td><td><b>${esc(o.item)}</b>${o.tk.size >= 3 ? ` <span class="at-reinc">reincidente</span>` : ""}${DESC.has(o.item) ? `<div class="s">${esc(DESC.get(o.item))}</div>` : ""}</td><td class="s">${esc([...o.skus].slice(0, 3).join(", "))}${o.skus.size > 3 ? ` +${o.skus.size - 3}` : ""}</td><td class="num"><b>${fmt(o.tk.size)}</b></td><td class="num">${fmt(o.ped.size)}</td><td class="num">${fmt(o.q)}</td>${tem$ ? `<td class="num">${o.tv ? brl(o.v) : "—"}</td>` : ""}${MS.map((m) => `<td class="num">${o.m[m] ? fmt(o.m[m]) : "·"}</td>`).join("")}<td style="width:14%">${barra(o.tk.size, rk[0].tk.size)}</td></tr>`).join("")}</tbody></table>${rk.length > 30 ? `<p class="s">Mostrando 30 de ${fmt(rk.length)} peças. O Excel tem todas.</p>` : ""}</div>
      <div><h3>Produtos (SKU)</h3><table class="tabela-pedidos"><thead><tr><th>#</th><th>SKU</th><th class="num">Tickets</th><th class="num">Peças diferentes</th>${tem$ ? `<th class="num">Valor</th>` : ""}<th></th></tr></thead><tbody>${rp.slice(0, 30).map((o, i) => `<tr><td>${i + 1}</td><td><b>${esc(o.sku)}</b></td><td class="num"><b>${fmt(o.tk.size)}</b></td><td class="num">${fmt(o.itens.size)}</td>${tem$ ? `<td class="num">${brl(o.v)}</td>` : ""}<td style="width:24%">${barra(o.tk.size, rp[0].tk.size)}</td></tr>`).join("")}</tbody></table>
      <p class="s">Muitas peças diferentes no mesmo produto = problema espalhado (embalagem, montagem, transporte). Poucas peças repetidas = possível defeito de fabricação: vale levar para a qualidade.</p></div></div>`
      : `<p class="vazio">${lidos ? "O robô ainda não achou peças nos tickets lidos." : "O robô ainda não leu as peças: clique em ▶ Ler peças e rastreio."}</p>`;
    // pedidos com mais de um ticket de AT (o mesmo cliente voltou)
    const porPed = new Map(); B.forEach((x) => { const k = x.nota_ticket || x.pedido; if (!k) return; if (!porPed.has(k)) porPed.set(k, []); porPed.get(k).push(x); });
    const rein = [...porPed.entries()].filter(([, l]) => l.length > 1).sort((a, b) => b[1].length - a[1].length);
    $("at-reinc").innerHTML = rein.length ? `<p class="s">${fmt(rein.length)} pedido(s) com mais de um ticket de AT (${fmt(rein.reduce((a, [, l]) => a + l.length, 0))} tickets).</p><table class="tabela-pedidos"><thead><tr><th>NF do pedido</th><th class="num">Tickets de AT</th><th>Tickets</th><th>Peças</th></tr></thead><tbody>${rein.slice(0, 20).map(([k, l]) => `<tr><td><b>${esc(k)}</b></td><td class="num"><b>${l.length}</b></td><td>${l.map((x) => `<a href="https://appv2.360multi.com/tickets/${encodeURIComponent(x.ticket)}" target="_blank" rel="noopener">${esc(x.ticket)}</a>`).join(", ")}</td><td class="s">${esc([...new Set(l.flatMap((x) => (x.pecas || []).map((p) => p.peca)).filter(Boolean))].join(", "))}</td></tr>`).join("")}</tbody></table>` : `<p class="vazio">Nenhum pedido com mais de um ticket de AT.</p>`;
    // custo da AT (Brenda 27/11): peças (valor no 360) + frete (Valor CTe da planilha de frete, parte 109)
    const vt = B.map(valorTk).filter((v) => v != null), tot = vt.reduce((a, b) => a + b, 0);
    const ft = B.map(freteTk).filter((v) => v != null), totF = ft.reduce((a, b) => a + b, 0);
    const porTv = new Map(); B.forEach((x) => { const v = valorTk(x), fv = freteTk(x); if (v == null && fv == null) return; const t = nomeTp(x._fr && x._fr[0] && x._fr[0].emitente) || alvo(x); if (!porTv.has(t)) porTv.set(t, { p: 0, f: 0, n: 0, nf: 0 }); const o = porTv.get(t); o.p += v || 0; if (fv != null) { o.f += fv; o.nf++; } o.n++; });
    const semLiga = FR.filter((f) => !T.some((x) => x._fr && x._fr.includes(f)));
    const cc = (r, v, s2) => `<div><span class="s">${r}</span><b>${v}</b><span class="s">${s2}</span></div>`;
    $("at-custo").innerHTML = (tem$ || FR.length) ? `<div class="at-custo-cards">${cc("Valor das peças", tem$ ? brl(tot) : "—", tem$ ? `${fmt(vt.length)} tickets com valor` : "aguardando o robô")}${cc("Frete das ATs", FR.length ? brl(totF) : "—", FR.length ? `${fmt(ft.length)} tickets com CT-e · ${fmt(FR.length)} CT-e na planilha` : "suba a planilha de frete (CT-e)")}${cc("Custo médio por ticket", brl((vt.length ? tot / vt.length : 0) + (ft.length ? totF / ft.length : 0)), "peças + frete")}</div>
      <table class="tabela-pedidos"><thead><tr><th>Transportadora</th><th class="num">Tickets</th><th class="num">Valor das peças</th><th class="num">Frete (CT-e)</th><th class="num">Frete médio</th><th class="num">Total</th><th class="num">% do total</th></tr></thead><tbody>${[...porTv.entries()].sort((a, b) => (b[1].p + b[1].f) - (a[1].p + a[1].f)).map(([t, o]) => `<tr><td>${esc(t)}</td><td class="num">${fmt(o.n)}</td><td class="num">${brl(o.p)}</td><td class="num">${o.nf ? brl(o.f) : "—"}</td><td class="num">${o.nf ? brl(o.f / o.nf) : "—"}</td><td class="num"><b>${brl(o.p + o.f)}</b></td><td class="num">${tot + totF ? Math.round(((o.p + o.f) / (tot + totF)) * 100) : 0}%</td></tr>`).join("")}</tbody></table>
      <p class="s">Peças = coluna de valor da tabela Peças de Assistência no 360. Frete = Valor CTe da planilha de frete, ligado pela Nota AT (nota-série) ou, se não achar, pela Ordem de Compra (NF do pedido); transportadora = emitente do CT-e.${semLiga.length ? ` ${fmt(semLiga.length)} CT-e da planilha não acharam ticket de AT (${brl(semLiga.reduce((a, f) => a + (Number(f.valor_cte) || 0), 0))}): ficam fora da tabela, mas estão no Excel.` : ""} Custo por motivo: a planilha de AT não tem motivo.</p>`
      : `<p class="vazio">O robô está relendo os tickets para trazer o valor das peças. Suba também a planilha de frete (CT-e) no botão acima.</p>`;
    // evolução semanal: tickets abertos × que saíram da planilha (fechados)
    const sem0 = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x.toISOString().slice(0, 10); };
    const W = new Map(); const add = (d, k) => { if (!d) return; const s = sem0(d); if (!W.has(s)) W.set(s, { s, a: 0, f: 0, e: 0 }); W.get(s)[k]++; };
    B.forEach((x) => { add(x.criado_em, "a"); add(x.saiu_em, "f"); if (x.data_saida) add(x.data_saida + "T12:00:00", "e"); });
    const ws = [...W.values()].sort((a, b) => a.s.localeCompare(b.s)).slice(-12);
    $("at-evol").innerHTML = ws.length ? `<table class="tabela-pedidos"><thead><tr><th>Semana de</th><th class="num">Tickets abertos</th><th class="num">Notas AT que saíram</th><th class="num">Fechados (saíram da planilha)</th></tr></thead><tbody>${ws.map((w) => `<tr><td>${br(w.s)}</td><td class="num">${fmt(w.a)}</td><td class="num">${fmt(w.e)}</td><td class="num">${fmt(w.f)}</td></tr>`).join("")}</tbody></table><p class="s">Fechados só contam a partir do 1º upload do detalhamento com a parte 106.</p>` : `<p class="vazio">Nada aqui.</p>`;
    // lista do card
    $("at-titulo").textContent = `${CARDS.find((c) => c[0] === card)[1]} (${fmt(V.length)})`;
    const POR = 100, pags = Math.max(1, Math.ceil(V.length / POR)); if (pag > pags) pag = pags;
    $("at-lista").innerHTML = V.length ? `<table class="tabela-pedidos"><thead><tr><th>Ticket</th><th>Quem age</th><th>Próximo passo</th><th class="num">Dias</th><th>Fila / grupo</th><th>NF do pedido</th><th>Nota AT</th><th>Saída</th><th>Transportadora</th><th>Rastreio</th><th>Peças</th></tr></thead><tbody>${V.slice((pag - 1) * POR, pag * POR).map((x) => `<tr>
        <td><a href="https://appv2.360multi.com/tickets/${encodeURIComponent(x.ticket)}" target="_blank" rel="noopener">${esc(x.ticket)}</a><div class="s">${br(x.criado_em)}</div></td><td>${sit(x).quem ? `<span class="at-quem-chip ${QUEM_COR[sit(x).quem] || ""}">${esc(sit(x).quem)}</span>` : "—"}</td><td class="${sit(x).k === "atrasada" || sit(x).alerta ? "at-ruim" : ""}">${esc(sit(x).passo)}</td><td class="num">${dias(x.criado_em) ?? "—"}</td>
        <td>${esc(x.fila || "—")}<div class="s">${esc(x.grupo || "")}</div></td><td>${esc(x.nota_ticket || "—")}</td><td>${esc(x.nota_at || "—")}</td><td>${br(x.data_saida)}</td><td>${esc(alvo(x))}</td>
        <td>${x.rastreio ? `${entregue(x) ? "✅ " : ""}${esc(x.rastreio.situacao || "—")}${x.rastreio.evento ? `<div class="s">${esc(x.rastreio.evento)}${x.rastreio.data ? " · " + esc(x.rastreio.data) : ""}</div>` : ""}` : `<span class="s">${x.nota_at ? "aguardando robô" : "—"}</span>`}</td>
        <td>${(x.pecas || []).length ? x.pecas.map((p) => `<div><b>${esc(p.peca || "?")}</b>${p.qtde ? ` ×${fmt(p.qtde)}` : ""}${p.sku ? ` <span class="s">${esc(p.sku)}</span>` : ""}</div>`).join("") : `<span class="s">${x.pecas_em ? x.pecas_msg || "sem peça" : "aguardando robô"}</span>`}</td></tr>`).join("")}</tbody></table>
        ${pags > 1 ? `<div class="paginacao"><button class="btn mini contorno" data-atp="-1"${pag === 1 ? " disabled" : ""}>‹</button> página ${pag} de ${pags} <button class="btn mini contorno" data-atp="1"${pag === pags ? " disabled" : ""}>›</button></div>` : ""}` : `<p class="vazio">Nenhum ticket aqui.</p>`;
  }
  $("rp-at").addEventListener("click", (e) => {
    const c = e.target.closest("[data-atc]"); if (c) { card = c.dataset.atc; pag = 1; desenhar(); return; }
    const q = e.target.closest("[data-atq]"); if (q) { fQuem = fQuem === q.dataset.atq ? "" : q.dataset.atq; pag = 1; desenhar(); return; }
    const t = e.target.closest("[data-att]"); if (t) { fTransp = fTransp === t.dataset.att ? "" : t.dataset.att; pag = 1; desenhar(); return; }
    const p = e.target.closest("[data-atp]"); if (p) { pag += Number(p.dataset.atp); desenhar(); }
  });
  $("at-f-transp").addEventListener("change", (e) => { fTransp = e.target.value; pag = 1; desenhar(); });
  $("at-f-grupo").addEventListener("change", (e) => { fGrupo = e.target.value; pag = 1; desenhar(); });
  $("at-busca").addEventListener("input", (e) => { busca = e.target.value.replace(/\D/g, ""); pag = 1; desenhar(); });
  // planilha de frete das ATs (Brenda 27/11): colunas Chave de acesso, Valor CTe, Nota, Série, Data… (cidade/CEP não são guardados)
  $("at-frete-arq").addEventListener("change", async (e) => {
    const f = e.target.files[0]; e.target.value = ""; if (!f) return;
    try {
      const wb = XLSX.read(await f.arrayBuffer(), { type: "array", cellDates: true });
      let M = null, hi = -1;
      for (const n of wb.SheetNames) { const R = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: null, raw: true }); const i = R.findIndex((r) => r && r.some((c) => /chave de acesso/i.test(String(c || ""))) && r.some((c) => /valor\s*ct-?e/i.test(String(c || "")))); if (i >= 0) { M = R; hi = i; break; } }
      if (!M) throw new Error('não achei as colunas "Chave de acesso" e "Valor CTe"');
      const H = M[hi].map((c) => sem(String(c || "").trim())), col = (re, de = 0) => H.findIndex((h, i) => i >= de && re.test(h));
      const iCh = col(/^chave de acesso$/), iNum = col(/^numero$/), iSer = col(/^serie$/), iEm = col(/^data de emissao$/), iEmit = col(/^emitente$/), iTom = col(/^tomador$/), iUf = col(/^uf cte$/), iVc = col(/^valor cte$/), iIc = col(/^valor icms$/), iVp = col(/^valor produtos$/), iPe = col(/^peso bruto$/), iNo = col(/^nota$/), iSn = col(/^serie$/, iNo + 1), iDn = col(/^data$/), iOc = col(/^ordem de compra$/), iRd = col(/^redespacho$/);
      if (iNo < 0 || iVc < 0) throw new Error('faltam as colunas "Nota" ou "Valor CTe"');
      const d = (v) => { if (v == null || v === "") return null; if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`; if (typeof v === "number") { const q = XLSX.SSF.parse_date_code(v); return q ? `${q.y}-${String(q.m).padStart(2, "0")}-${String(q.d).padStart(2, "0")}` : null; } const m = String(v).match(/(\d{4})-(\d{2})-(\d{2})/) || String(v).match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? (m[1].length === 4 ? `${m[1]}-${m[2]}-${m[3]}` : `${m[3]}-${m[2]}-${m[1]}`) : null; };
      const n = (v) => { if (v == null || v === "") return null; if (typeof v === "number") return v; const t = String(v).replace(/[^\d,.-]/g, ""); return Number(/,\d{1,2}$/.test(t) ? t.replace(/\./g, "").replace(",", ".") : t) || 0; };
      const t = (v) => (v == null || v === "" ? null : String(v).trim().replace(/\.0+$/, ""));
      const L = M.slice(hi + 1).filter((r) => r && t(r[iCh])).map((r) => ({ chave_cte: t(r[iCh]), numero_cte: iNum >= 0 ? t(r[iNum]) : null, serie_cte: iSer >= 0 ? t(r[iSer]) : null, emissao_cte: iEm >= 0 ? d(r[iEm]) : null,
        emitente: iEmit >= 0 ? t(r[iEmit]) : null, tomador: iTom >= 0 ? t(r[iTom]) : null, uf: iUf >= 0 ? t(r[iUf]) : null, valor_cte: n(r[iVc]), valor_icms: iIc >= 0 ? n(r[iIc]) : null, valor_produtos: iVp >= 0 ? n(r[iVp]) : null, peso: iPe >= 0 ? n(r[iPe]) : null,
        nota: [t(r[iNo]), iSn >= 0 ? t(r[iSn]) : null].filter(Boolean).join("-"), data_nota: iDn >= 0 ? d(r[iDn]) : null, ordem_compra: iOc >= 0 ? t(r[iOc]) : null, redespacho: iRd >= 0 ? t(r[iRd]) : null }));
      if (!L.length) throw new Error("planilha sem linhas");
      toast(`Enviando ${L.length} CT-e…`);
      let tot = 0; for (let i = 0; i < L.length; i += 500) { const r = await sb().rpc("importar_at_frete", { linhas: L.slice(i, i + 500) }); if (r.error) throw new Error(/importar_at_frete|function|schema cache/i.test(r.error.message) ? "falta rodar a parte 109 no Supabase" : r.error.message); tot += r.data || 0; }
      await carregar(); const lig = T.filter((x) => x._fr).length;
      toast(`Planilha de frete enviada: ${fmt(tot)} CT-e · ${fmt(lig)} tickets de AT com frete.`);
    } catch (err) { toast("Não consegui ler a planilha de frete: " + (err.message || err), true); }
  });
  $("at-rodar").addEventListener("click", async () => {
    const { error } = await sb().rpc("rodar_robo_at");
    if (error) return toast(/rodar_robo_at|function/i.test(error.message) ? "Falta rodar a parte 106 no Supabase." : "Não consegui chamar o robô: " + error.message, true);
    toast("Robô chamado: as peças e o rastreio aparecem aqui em alguns minutos."); setTimeout(carregar, 300000);
  });
  $("at-excel").addEventListener("click", () => {
    if (!window.XLSX) return toast("O Excel ainda está carregando.", true);
    const B = T.filter(filtroBase);
    const tk = B.map((x) => ({ Ticket: x.ticket, Criado: br(x.criado_em), "Dias desde a criação": dias(x.criado_em), Situação: (CARDS.find((c) => c[0] === situacao(x).k) || [, situacao(x).k])[1], "Quem age": situacao(x).quem, "Próximo passo": situacao(x).passo, "Fila atual": x.fila, Grupo: x.grupo, "Nota do ticket": x.nota_ticket, "Pedido Intelipost": x.pedido,
      "Nota AT": x.nota_at, "Saída da Nota AT": br(x.data_saida), "Transportadora (envio AT)": alvo(x), "Rastreio": x.rastreio ? x.rastreio.situacao : "", "Último evento": x.rastreio ? [x.rastreio.evento, x.rastreio.data].filter(Boolean).join(" · ") : "",
      "Peças (item × qtde)": (x.pecas || []).map((p) => `${p.peca || "?"}${p.qtde ? " ×" + p.qtde : ""}`).join("; "), "Produto (SKU)": [...new Set((x.pecas || []).map((p) => p.sku).filter(Boolean))].join(", "), "Valor das peças": valorTk(x), "Frete (Valor CTe)": freteTk(x), "Emissão da Nota AT": dataNota(x) ? br(dataNota(x)) : "", "Transportadora do CT-e": x._fr ? [...new Set(x._fr.map((f) => nomeTp(f.emitente)))].join(", ") : "", "Na planilha": x.na_planilha ? "sim" : "não (fechado)" }));
    const pc = new Map(); B.forEach((x) => (x.pecas || []).forEach((p) => { const k = (p.peca || "?").trim(); if (!pc.has(k)) pc.set(k, { "Item (peça)": k, sk: new Set(), tk: new Set(), Qtde: 0 }); const o = pc.get(k); o.tk.add(x.ticket); o.Qtde += Number(p.qtde) || 1; if (p.sku) o.sk.add(p.sku); }));
    const rk = [...pc.values()].sort((a, b) => b.tk.size - a.tk.size).map(({ tk: s2, sk, ...o }) => ({ ...o, "Produtos (SKU)": [...sk].join(", "), Tickets: s2.size }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(tk), "Tickets AT");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rk.length ? rk : [{ "Item (peça)": "ainda sem peças lidas" }]), "Peças");
    if (FR.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(FR.map((f) => ({ "CT-e": f.numero_cte, "Emissão CT-e": br(f.emissao_cte), Emitente: f.emitente, Tomador: f.tomador, "UF": f.uf, "Valor CTe": Number(f.valor_cte) || 0, "Valor produtos": Number(f.valor_produtos) || 0, Peso: Number(f.peso) || 0, "Nota AT": f.nota, "Data da nota": br(f.data_nota), "Ordem de compra": f.ordem_compra, Redespacho: f.redespacho, "Ticket de AT": (T.find((x) => x._fr && x._fr.includes(f)) || {}).ticket || "não achado" }))), "Frete (CT-e)");
    XLSX.writeFile(wb, `assistencia_tecnica_${new Date().toISOString().slice(0, 10)}.xlsx`);
  });
  window.__at = { recarregar: () => { if (carregou) carregar(); } };
  setInterval(() => { if ($("rp-at").offsetParent && window.__sb && !carregou) { carregou = true; carregar(); setInterval(() => { if ($("rp-at").offsetParent) carregar(); }, 180000); } }, 2000);
})();
