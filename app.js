// Painel Preventivo da Logística
// - login por e-mail e senha (Supabase)
// - a Logística envia a planilha exportada (aba Export) e ela vira a base de todos
// - cada pedido tem nova data e observação, salvas na hora para todos (ficam até o pedido
//   aparecer como entregue ou cancelado no arquivo da Intelipost)
(function () {
  const CFG = window.PAINEL_CONFIG;
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n) => Number(n || 0).toLocaleString("pt-BR");
  const norm = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
  const br = (iso) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "");
  const DIA = 86400000;

  const POR_PAGINA = 50;

  let usuarioId = null;
  let perfil = "";              // "sac" ou "logistica"
  let paginaAtual = "preventivo";
  let base = [];               // pedidos da planilha
  let trat = new Map();        // pedido -> tratativa
  let info = null;
  let infoFech = null;         // último arquivo da Intelipost enviado
  let ocultos = 0;             // pedidos da base tirados por estarem entregues/cancelados
  let visao = "vencem";
  let msSel = "";              // micro status clicado
  let rangeSel = "";           // faixa de vencimento clicada na tabela de range
  const DIAS_PARADO = 7;       // parado no rastreio = mais de 7 dias sem atualização
  const RANGES = [
    { id: "v30", nome: "Vencido há 30+ d", de: -Infinity, ate: -30, venc: true }, { id: "v10", nome: "Vencido há 10–29 d", de: -29, ate: -10, venc: true },
    { id: "v1", nome: "Vencido há 1–9 d", de: -9, ate: -1, venc: true },
    { id: "hoje", nome: "Vence hoje", de: 0, ate: 0 }, { id: "1", nome: "Vence ≥ 1 dia", de: 1, ate: 1 },
    { id: "2", nome: "Vence ≥ 2 dias", de: 2, ate: 4 }, { id: "5", nome: "Vence ≥ 5 dias", de: 5, ate: 9 },
    { id: "10", nome: "Vence ≥ 10 dias", de: 10, ate: 19 }, { id: "20", nome: "Vence ≥ 20 dias", de: 20, ate: 29 },
    { id: "30", nome: "Vence ≥ 30 dias", de: 30, ate: Infinity },
  ];
  const faixa = (d) => (d === null ? null : RANGES.find((r) => d >= r.de && d <= r.ate).id);
  let filtrados = [];
  let vistos = [];             // base depois dos filtros do topo
  let pagina = 1;

  function hojeISO() { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
  function diasEntre(isoA, isoB) { return Math.round((Date.parse(isoB.slice(0, 10)) - Date.parse(isoA.slice(0, 10))) / DIA); }

  function toast(msg, erro) {
    const t = $("toast");
    t.textContent = msg; t.classList.toggle("erro", !!erro); t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), erro ? 6000 : 3000);
  }
  function carregando(txt) { $("carregando").hidden = !txt; if (txt) $("carregando-texto").textContent = txt; }

  // ---------------- login ----------------
  $("form-login").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("erro-login").textContent = "";
    $("btn-entrar").disabled = true;
    const { error } = await sb.auth.signInWithPassword({ email: $("email").value.trim(), password: $("senha").value });
    $("btn-entrar").disabled = false;
    if (error) $("erro-login").textContent = /invalid/i.test(error.message) ? "E-mail ou senha incorretos." : "Não foi possível entrar: " + error.message;
    else $("senha").value = "";
  });
  $("btn-sair").addEventListener("click", () => sb.auth.signOut());

  sb.auth.onAuthStateChange((_ev, sessao) => {
    if (sessao) {
      if (usuarioId === sessao.user.id) return;
      usuarioId = sessao.user.id;
      $("usuario").textContent = sessao.user.email;
      $("tela-login").hidden = true;
      setTimeout(entrar, 0);
    } else {
      usuarioId = null; perfil = "";
      delete document.body.dataset.perfil;
      $("tela-painel").hidden = true;
      $("tela-login").hidden = false;
    }
  });

  // descobre o perfil antes de mostrar o painel (SAC só vê a Consulta SAC)
  async function entrar() {
    carregando("Entrando…");
    let r = { data: "logistica" };
    try { r = await sb.rpc("meu_perfil_painel"); } catch (err) { r = { error: err }; }
    carregando("");
    if (!r || r.error) {
      // banco ainda sem a parte do SAC: avisa (sem isso, o login do SAC veria tudo)
      $("aviso-perfil").hidden = false;
      r = { data: "logistica" };
    }
    perfil = r && r.data === "sac" ? "sac" : "logistica";
    document.body.dataset.perfil = perfil;
    $("tela-painel").hidden = false;
    if (perfil === "sac") {
      irPara("sac");
      carregarSac();
    } else {
      irPara("preventivo");
      carregar();
      ligarTempoReal();
    }
  }

  // ---------------- carregar ----------------
  async function buscarTudo(tabela, ordem) {
    let lista = [];
    for (let de = 0; ; de += 1000) {
      const { data, error } = await sb.from(tabela).select("*").order(ordem).range(de, de + 999);
      if (error) throw error;
      lista = lista.concat(data);
      if (data.length < 1000) return lista;
    }
  }

  async function carregar() {
    $("info-base").textContent = "Carregando…";
    try {
      const [b, t, i, fi, tot] = await Promise.all([
        buscarTudo("base_aberta", "pedido"),
        buscarTudo("tratativas", "pedido"),
        sb.from("base_info").select("*").limit(1),
        sb.from("fechados_info").select("*").limit(1),
        sb.from("base_pedidos").select("pedido", { count: "exact", head: true }),
      ]);
      base = b;
      trat = new Map(t.map((x) => [x.pedido, x]));
      info = i.data && i.data[0];
      infoFech = fi.data && fi.data[0];
      ocultos = Math.max(0, (tot.count || 0) - base.length);
      await carregarOcorrencias();
      await carregarResponsaveis();
      await carregarFila();
      await carregarTickets();
      if (perfil !== "sac") carregarReposicoes();
    } catch (err) {
      $("info-base").textContent = "";
      toast(/base_|tratativas|fechados|schema cache/.test(err.message)
        ? "O banco ainda não foi preparado: rode o arquivo supabase/schema.sql no Supabase."
        : "Erro ao carregar: " + err.message, true);
      return;
    }
    $("info-base").textContent = info
      ? `Base de ${new Date(info.enviado_em).toLocaleDateString("pt-BR")} · ${fmt(base.length)} pedidos em aberto · clique nos cards e nos micro status para ver a lista e exportar · ${info.arquivo || "planilha"} enviada em ${new Date(info.enviado_em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}${info.enviado_por ? " por " + info.enviado_por : ""}`
      : "Ainda não há base. Clique em \"Enviar base\" e escolha o arquivo exportado.";
    $("info-intelipost").textContent = infoFech
      ? `Intelipost: ${infoFech.arquivo || "arquivo"} de ${new Date(infoFech.enviado_em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })} · ${fmt(ocultos)} pedido${ocultos === 1 ? "" : "s"} da base já entregue${ocultos === 1 ? "" : "s"} ou cancelado${ocultos === 1 ? "" : "s"} fora${ocultos === 1 ? "" : "m"} tirado${ocultos === 1 ? "" : "s"} do painel.`
      : "Envie o arquivo da Intelipost (\"Enviar Intelipost\") para tirar do painel os pedidos entregues e cancelados.";
    $("topo-arquivos").innerHTML = [info && info.arquivo, ticketsInfo && ticketsInfo.arquivo].filter(Boolean)
      .map((a, i) => `<span class="arq ${i ? "tk" : ""}">▤ ${esc(a)}</span>`).join("")
      + (info ? `<span class="arq-data">base de ${new Date(info.enviado_em).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}</span>` : "");
    $("info-tickets").textContent = !ticketsOk ? "" : ticketsInfo
      ? `Tickets: ${ticketsInfo.arquivo || "planilha"} de ${new Date(ticketsInfo.enviado_em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}${ticketsInfo.enviado_por ? " por " + ticketsInfo.enviado_por : ""} · ${fmt(base.filter((p) => ticketDe(p)).length)} pedidos do painel com ticket aberto.`
      : "Envie a planilha de tickets (\"Enviar tickets\") para ver em que fila está o ticket de cada pedido.";
    montarOpcoes();
    redesenhar();
    desenharOcorrencias();
    if (paginaAtual === "sac") desenharSacLogistica();
    desenharResponsaveis();
  }

  // atualização das tratativas feitas por outras pessoas
  let canal = null;
  function ligarTempoReal() {
    if (canal || !sb.channel) return;
    try {
      canal = sb.channel("tratativas")
        .on("postgres_changes", { event: "*", schema: "public", table: "tratativas" }, (m) => {
          const t = m.new && m.new.pedido ? m.new : null;
          if (t) trat.set(t.pedido, t); else if (m.old && m.old.pedido) trat.delete(m.old.pedido);
          redesenharSemPerderFoco();
        })
        .subscribe();
    } catch (_) { /* sem tempo real: o recarregamento a cada minuto cobre */ }
  }
  setInterval(async () => {
    if (!usuarioId || document.hidden) return;
    const { data, error } = await sb.from("tratativas").select("*").gte("atualizado_em", new Date(Date.now() - 5 * 60000).toISOString());
    if (error || !data || !data.length) return;
    let mudou = false;
    data.forEach((t) => { const a = trat.get(t.pedido); if (!a || a.atualizado_em !== t.atualizado_em) { trat.set(t.pedido, t); mudou = true; } });
    if (mudou) redesenharSemPerderFoco();
  }, 60000);

  function redesenharSemPerderFoco() {
    const el = document.activeElement;
    if ((el && el.closest && el.closest("#linhas")) || !$("modal").hidden) { redesenhar._pendente = true; return; }
    redesenhar(true);
  }

  // ---------------- cálculo ----------------
  function preparar(p) {
    const t = trat.get(p.pedido);
    const hoje = hojeISO();
    const venc = p.prev_original || p.prev_atual || null;   // data prometida ao cliente
    p._venc = venc;
    p._dias = venc ? diasEntre(hoje, venc) : null;                 // >0 faltam dias, <0 vencido
    // vencimento para tratar: a nova data informada pela Logística (se houver), senão a data prometida
    const ef = (t && t.nova_data) || venc;
    p._diasEf = ef ? diasEntre(hoje, ef) : null;
    p._pelaNova = !!(t && t.nova_data);
    p._parado = p.ultima_atualizacao ? Math.max(0, Math.floor((Date.now() - Date.parse(p.ultima_atualizacao)) / DIA)) : null;
    p._t = t;
    p._faixa = faixa(p._dias);
    return p;
  }
  const naVisao = {
    vencidos: (p) => p._diasEf !== null && p._diasEf < 0,
    hoje: (p) => p._diasEf === 0,
    amanha: (p) => p._diasEf === 1,
    vencem: (p) => p._diasEf !== null && p._diasEf >= 0 && p._diasEf <= 5,
    parados: (p) => p._parado !== null && p._parado > DIAS_PARADO,
    todos: () => true,
  };

  // ---------------- filtros do topo (valem para tudo; vários itens por filtro) ----------------
  const FILTROS = {
    transp: (p) => p.transportadora || "(sem transportadora)",
    canal: (p) => p.canal || "(sem canal)",
    ms: (p) => p.micro_status || "(sem micro status)",
    resp: (p) => { const r = respDe(p.micro_status); return r ? r.nome : PENDENTE; },
    tk: (p) => { if (!ticketsInfo) return "(planilha de tickets não enviada)"; const t = ticketDe(p); return t ? t.fila || "(ticket sem fila)" : "Sem ticket"; },
    obs: (p) => (p._t && p._t.observacao ? "Com observação" : "Sem observação"),
  };
  const sel = { transp: new Set(), canal: new Set(), ms: new Set(), resp: new Set(), tk: new Set(), obs: new Set() };
  function passaFiltros(p) {
    const busca = norm($("f-busca").value);
    if (busca && !norm(p.pedido).includes(busca) && !norm(p.nf).includes(busca)) return false;
    for (const k in sel) if (sel[k].size && !sel[k].has(FILTROS[k](p))) return false;
    return true;
  }

  // ---------------- desenho ----------------
  function montarOpcoes() {
    document.querySelectorAll("#filtros .multi").forEach((el) => {
      const k = el.dataset.filtro, cont = new Map();
      base.forEach((p) => { const v = FILTROS[k](p); cont.set(v, (cont.get(v) || 0) + 1); });
      if (k === "obs") ["Com observação", "Sem observação"].forEach((v) => cont.has(v) || cont.set(v, 0));
      const valores = k === "obs" ? ["Com observação", "Sem observação"] : [...cont.keys()].sort((a, b) => a.localeCompare(b, "pt-BR"));
      [...sel[k]].forEach((v) => cont.has(v) || sel[k].delete(v));
      const aberto = el.querySelector(".multi-painel:not([hidden])");
      el.innerHTML = `<span class="multi-rotulo">${esc(el.dataset.rotulo)}</span>
        <button type="button" class="multi-botao"><span class="multi-valor"></span><span class="seta">▾</span></button>
        <div class="multi-painel" ${aberto ? "" : "hidden"}>
          ${valores.length > 6 ? `<input class="multi-busca" type="search" placeholder="Procurar…">` : ""}
          <div class="multi-lista">${valores.map((v) => `<label class="multi-op"><input type="checkbox" value="${esc(v)}" ${sel[k].has(v) ? "checked" : ""}>
            <span>${esc(v)}</span><em>${fmt(cont.get(v))}</em></label>`).join("")}</div>
          <div class="multi-acoes"><button type="button" class="link" data-acao="limpar">Limpar</button><button type="button" class="btn primario" data-acao="ok">OK</button></div>
        </div>`;
      rotuloMulti(el);
    });
  }
  function rotuloMulti(el) {
    const k = el.dataset.filtro, n = sel[k].size;
    el.querySelector(".multi-valor").textContent = n === 0 ? el.dataset.todos : n === 1 ? [...sel[k]][0] : `${n} selecionados`;
    el.classList.toggle("ativo", n > 0);
    $("f-limpar").hidden = !Object.values(sel).some((x) => x.size) && !$("f-busca").value;
  }
  function filtrosMudaram() {
    msSel = ""; rangeSel = "";
    document.querySelectorAll("#filtros .multi").forEach(rotuloMulti);
    redesenhar();
  }
  $("filtros").addEventListener("click", (e) => {
    const multi = e.target.closest(".multi");
    if (e.target.closest(".multi-botao")) {
      const painel = multi.querySelector(".multi-painel"), abrir = painel.hidden;
      document.querySelectorAll("#filtros .multi-painel").forEach((x) => (x.hidden = true));
      painel.hidden = !abrir;
      if (abrir) { const b = painel.querySelector(".multi-busca"); if (b) b.focus(); }
      return;
    }
    const acao = e.target.closest("[data-acao]");
    if (acao) {
      if (acao.dataset.acao === "limpar") {
        sel[multi.dataset.filtro].clear();
        multi.querySelectorAll("input[type=checkbox]").forEach((c) => (c.checked = false));
        filtrosMudaram();
      }
      multi.querySelector(".multi-painel").hidden = true;
    }
  });
  $("filtros").addEventListener("change", (e) => {
    if (e.target.type !== "checkbox") return;
    const k = e.target.closest(".multi").dataset.filtro;
    e.target.checked ? sel[k].add(e.target.value) : sel[k].delete(e.target.value);
    filtrosMudaram();
  });
  $("filtros").addEventListener("input", (e) => {
    if (!e.target.classList.contains("multi-busca")) return;
    const q = norm(e.target.value);
    e.target.closest(".multi").querySelectorAll(".multi-op").forEach((op) => (op.hidden = q && !norm(op.textContent).includes(q)));
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".multi")) document.querySelectorAll("#filtros .multi-painel").forEach((x) => (x.hidden = true));
  });
  $("f-limpar").addEventListener("click", () => {
    Object.values(sel).forEach((x) => x.clear()); $("f-busca").value = "";
    montarOpcoes(); filtrosMudaram();
  });

  function redesenhar(manterPagina) {
    base.forEach(preparar);
    vistos = base.filter(passaFiltros);          // tudo já com os filtros do topo
    // contadores das visões
    document.querySelectorAll(".visao").forEach((b) => {
      b.classList.toggle("ativa", b.dataset.visao === visao);
      const n = vistos.filter(naVisao[b.dataset.visao]).length;
      if (b.classList.contains("kpi")) b.querySelector(".kpi-num").textContent = fmt(n);
      else b.querySelector("span").textContent = `(${fmt(n)})`;
    });
    const daVisao = vistos.filter(naVisao[visao]);
    // aviso do topo: o que vence hoje/amanhã e ainda não tem nova data
    const semNova = (p) => !(p._t && p._t.nova_data);
    const urg = vistos.filter((p) => (naVisao.hoje(p) || naVisao.amanha(p)) && semNova(p)).length;
    const vencSem = vistos.filter((p) => naVisao.vencidos(p) && semNova(p)).length;
    $("alerta-prev").hidden = !base.length;
    $("alerta-titulo").textContent = urg ? `Para não virar atraso, faltam ${fmt(urg)} pedido${urg === 1 ? "" : "s"} para tratar hoje.` : "Nada vencendo hoje ou amanhã sem nova data.";
    $("alerta-texto").innerHTML = `Vencem hoje ou amanhã e ainda <b>sem nova data</b>: ${fmt(urg)}. Já vencidos sem nova data: <b>${fmt(vencSem)}</b>.`;

    // tabela por micro status
    const grupos = new Map();
    daVisao.forEach((p) => {
      const k = p.micro_status || "(sem micro status)";
      const g = grupos.get(k) || { n: 0, soma: 0, cont: 0, trat: 0 };
      g.n++; if (p._parado !== null) { g.soma += p._parado; g.cont++; } if (p._t && p._t.observacao) g.trat++;
      grupos.set(k, g);
    });
    const ord = [...grupos.entries()].sort((a, b) => b[1].n - a[1].n);
    const somaP = daVisao.reduce((s, p) => s + (p._parado || 0), 0);
    const nomes = { vencem: "vencem nos próximos 5 dias", parados: `parados há mais de ${DIAS_PARADO} dias`, vencidos: "já vencidos", hoje: "que vencem hoje", amanha: "que vencem amanhã", todos: "em aberto" };
    $("ms-resumo").textContent = `${fmt(daVisao.length)} pedidos ${nomes[visao]} · em média ${(daVisao.length ? somaP / daVisao.length : 0).toFixed(1).replace(".", ",")} dias sem movimento no rastreio · clique para ver e exportar.`;
    if (msSel && !grupos.has(msSel)) msSel = "";
    $("ms-linhas").innerHTML = ord.length ? ord.map(([k, g]) => {
      const media = g.cont ? g.soma / g.cont : 0;
      return `<tr data-ms="${esc(k)}" class="${k === msSel ? "sel" : ""}"><td>${esc(k)}</td><td>${nomeResp(k)}</td><td class="num">${fmt(g.n)}</td>
        <td class="num ${media >= 10 ? "alto" : ""}">${media.toFixed(1).replace(".", ",")}</td><td class="num">${fmt(g.trat)}</td></tr>`;
    }).join("") : `<tr><td colspan="5" class="vazio">Nenhum pedido nesta visão.</td></tr>`;

    desenharRange();
    filtrar(manterPagina, daVisao);
  }

  function desenharRange() {
    const linhas = new Map(), tot = {};
    vistos.forEach((p) => {
      if (!p._faixa) return;
      const k = p.micro_status || "(sem micro status)";
      const l = linhas.get(k) || { total: 0 };
      l[p._faixa] = (l[p._faixa] || 0) + 1; l.total++;
      tot[p._faixa] = (tot[p._faixa] || 0) + 1; tot.total = (tot.total || 0) + 1;
      linhas.set(k, l);
    });
    const cel = (ms, id, n) => n
      ? `<td class="num clic ${id[0] === "v" ? "venc" : ""} ${visao === "todos" && rangeSel === id && msSel === ms ? "sel" : ""}" data-ms="${esc(ms)}" data-faixa="${id}">${fmt(n)}</td>`
      : `<td class="num vazio-c ${id[0] === "v" ? "venc" : ""}">·</td>`;
    $("range-linhas").innerHTML = [...linhas.entries()].sort((a, b) => b[1].total - a[1].total).map(([ms, l]) =>
      `<tr><td>${esc(ms)}</td>${RANGES.map((r) => cel(ms, r.id, l[r.id])).join("")}<td class="num tot clic" data-ms="${esc(ms)}" data-faixa="">${fmt(l.total)}</td></tr>`).join("")
      || `<tr><td colspan="12" class="vazio">Sem pedidos com data prometida.</td></tr>`;
    document.querySelectorAll(".tabela-range th.clic").forEach((th) => th.classList.toggle("sel", visao === "todos" && !msSel && rangeSel === (th.dataset.faixa || "__avencer")));
    $("range-total").innerHTML = `<tr><td>Total geral</td>${RANGES.map((r) => `<td class="num clic" data-ms="" data-faixa="${r.id}">${fmt(tot[r.id] || 0)}</td>`).join("")}<td class="num clic" data-ms="" data-faixa="">${fmt(tot.total || 0)}</td></tr>`;
  }

  function filtrar(manterPagina, daVisao) {
    // com algo digitado em Buscar, procura em TODOS os pedidos (inclusive vencidos), não só na visão escolhida
    const buscando = !!$("f-busca").value.trim();
    daVisao = buscando ? vistos : daVisao || vistos.filter(naVisao[visao]);
    const ms = msSel;   // micro status clicado numa das tabelas
    filtrados = daVisao.filter((p) => {
      if (ms && (p.micro_status || "(sem micro status)") !== ms) return false;
      if (rangeSel === "__avencer" ? !p._faixa : rangeSel && p._faixa !== rangeSel) return false;
      return true;
    });
    // ordem: mais urgente primeiro (vencido/vence antes), depois mais parado
    filtrados.sort((a, b) => (a._diasEf ?? 9999) - (b._diasEf ?? 9999) || (b._parado || 0) - (a._parado || 0));
    const nomes = { vencem: "Vencem em 5 dias", parados: "Parados no rastreio", vencidos: "Já vencidos", hoje: "Vencem hoje", amanha: "Vencem amanhã", todos: "Todos os pedidos" };
    const rNome = rangeSel === "__avencer" ? " · vencidos e a vencer" : rangeSel ? " · " + RANGES.find((r) => r.id === rangeSel).nome : "";
    $("lista-titulo").textContent = `${buscando ? "Busca em todos os pedidos" : nomes[visao]}${ms ? " · " + ms : ""}${rNome} (${fmt(filtrados.length)})`;
    if (!manterPagina) pagina = 1;
    desenharLista();
  }

  function chipPrazo(p) {
    const d = p._diasEf, extra = p._pelaNova ? " (nova data)" : "";
    if (d === null) return `<span class="chip cinza">sem previsão</span>`;
    if (d < 0) return `<span class="chip vermelho">vencido há ${-d} d${extra}</span>`;
    if (d === 0) return `<span class="chip ambar">vence hoje${extra}</span>`;
    return `<span class="chip ${d <= 5 ? "ambar" : "verde"}">${d === 1 ? "vence amanhã" : `vence em ${d} d`}${extra}</span>`;
  }

  function desenharLista() {
    const total = filtrados.length, paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
    pagina = Math.min(pagina, paginas);
    const fatia = filtrados.slice((pagina - 1) * POR_PAGINA, pagina * POR_PAGINA);
    $("linhas").innerHTML = fatia.map((p) => {
      const t = p._t || {};
      const quem = t.atualizado_por ? `${esc(t.atualizado_por.split("@")[0])} · ${new Date(t.atualizado_em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}` : "";
      return `<tr data-pedido="${esc(p.pedido)}" class="clicavel ${t.observacao ? "editado" : ""}" title="Clique para ver o detalhe do pedido">
        <td><div class="p">${esc(p.pedido)}</div><div class="s">NF ${esc(p.nf || "—")} · ${esc(p.canal || "")}</div>
          ${marcaTicket(p)}</td>
        <td>${esc(p.transportadora || "—")}<div class="s">${esc([p.cidade, p.uf].filter(Boolean).join(" / "))}</div></td>
        <td><span class="ms">${esc(p.micro_status || "—")}</span><div class="s">${p._parado !== null ? `${p._parado} dia${p._parado === 1 ? "" : "s"} sem movimento` : ""}</div><div class="s resp-p">👤 ${nomeResp(p.micro_status)}</div>${marcaOc(p)}</td>
        <td>${br(p._venc) || "—"}<div>${chipPrazo(p)}</div>${p.prev_atual && p.prev_atual !== p._venc ? `<div class="s">Intelipost atual ${br(p.prev_atual)}</div>` : ""}</td>
        <td><input type="date" data-campo="nova_data" value="${esc(t.nova_data || "")}"></td>
        <td class="col-obs"><input data-campo="observacao" value="${esc(t.observacao || "")}" placeholder="O que foi feito…" maxlength="1000">
          <div class="s quem">${quem}</div>
          ${p.comentario_360 ? `<div class="c360" title="Comentário 360">360: ${esc(p.comentario_360)}</div>` : ""}</td>
        <td>${/^https?:\/\//i.test(p.link_rastreio || "") ? `<a href="${esc(p.link_rastreio)}" target="_blank" rel="noopener noreferrer">Rastreio ↗</a>` : ""}</td>
      </tr>`;
    }).join("");
    $("vazio").hidden = total > 0;
    $("paginacao").innerHTML = total > POR_PAGINA
      ? `<button class="btn" data-p="-1" ${pagina === 1 ? "disabled" : ""}>‹ Anterior</button><span>Página ${pagina} de ${paginas}</span>
         <button class="btn" data-p="1" ${pagina === paginas ? "disabled" : ""}>Próxima ›</button>` : "";
  }

  // ---------------- eventos da tela ----------------
  $("visoes").addEventListener("click", (e) => {
    const b = e.target.closest(".visao"); if (!b) return;
    visao = b.dataset.visao; msSel = ""; rangeSel = ""; redesenhar();
  });
  $("ms-linhas").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-ms]"); if (!tr) return;
    msSel = msSel === tr.dataset.ms ? "" : tr.dataset.ms; rangeSel = "";
    document.querySelectorAll("#ms-linhas tr").forEach((r) => r.classList.toggle("sel", r.dataset.ms === msSel));
    filtrar();
    if (msSel) $("lista-titulo").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  // clique na tabela de range: abre os pedidos daquela linha/coluna
  document.querySelector(".tabela-range").addEventListener("click", (e) => {
    const td = e.target.closest("td.clic, th.clic"); if (!td) return;
    const ms = td.dataset.ms || "", fx = td.dataset.faixa || "__avencer";
    if (msSel === ms && rangeSel === fx && visao === "todos") { msSel = ""; rangeSel = ""; } else { msSel = ms; rangeSel = fx; }
    visao = "todos";
    redesenhar(); $("lista-titulo").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  let espera; $("f-busca").addEventListener("input", () => { clearTimeout(espera); espera = setTimeout(filtrosMudaram, 250); });
  $("paginacao").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-p]"); if (!b) return;
    pagina += Number(b.dataset.p); desenharLista(); $("lista-titulo").scrollIntoView({ block: "start" });
  });

  // salvar observação / nova data (na hora). Fica guardado até o pedido sair como entregue/cancelado.
  async function gravar(ped, campo, valor, elQuem) {
    const atual = trat.get(ped) || {};
    valor = (valor || "").trim() || null;
    if ((atual[campo] || null) === valor) return;
    const novo = { pedido: ped, situacao: atual.situacao || null, nova_data: atual.nova_data || null, observacao: atual.observacao || null };
    novo[campo] = valor;
    if (elQuem) elQuem.textContent = "salvando…";
    const { data, error } = await sb.from("tratativas").upsert(novo).select().single();
    if (error) { if (elQuem) elQuem.textContent = ""; toast("Não salvou: " + error.message, true); return; }
    trat.set(ped, data);
    const p = base.find((x) => x.pedido === ped); if (p) preparar(p);
    if (elQuem) elQuem.innerHTML = `<span class="salvo">✓ salvo</span> ${esc(data.atualizado_por ? data.atualizado_por.split("@")[0] : "")}`;
    const tr = document.querySelector(`#linhas tr[data-pedido="${CSS.escape(ped)}"]`);
    if (tr) {
      tr.classList.toggle("editado", !!data.observacao);
      const inp = tr.querySelector(`[data-campo="${campo}"]`); if (inp && inp.value !== (valor || "")) inp.value = valor || "";
      if (elQuem && !tr.contains(elQuem)) tr.querySelector(".quem").innerHTML = elQuem.innerHTML;
    }
    return data;
  }
  function salvar(el) {
    const tr = el.closest("tr[data-pedido]");
    return gravar(tr.dataset.pedido, el.dataset.campo, el.value, tr.querySelector(".quem"));
  }

  // ---------------- detalhe do pedido ----------------
  function abrirDetalhe(ped) {
    const p = base.find((x) => x.pedido === ped); if (!p) return;
    const t = p._t || {};
    const dh = (v) => (v ? new Date(v).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—");
    const item = (rot, val) => `<div class="det-item"><span>${rot}</span><b>${val || "—"}</b></div>`;
    $("modal-titulo").textContent = "Pedido " + p.pedido;
    $("modal-corpo").innerHTML = `
      <div class="det-grade">
        ${item("NF", esc(p.nf))}${item("Canal", esc(p.canal))}${item("Origem", esc(p.origem))}
        ${item("Transportadora", esc(p.transportadora))}${item("Destino", esc([p.cidade, p.uf].filter(Boolean).join(" / ")))}
        ${item("Rastreio", /^https?:\/\//i.test(p.link_rastreio || "") ? `<a href="${esc(p.link_rastreio)}" target="_blank" rel="noopener noreferrer">Abrir rastreio ↗</a>` : "")}
      </div>
      <h3>Prazos</h3>
      <div class="det-grade">
        ${item("Prometido ao cliente", `${br(p.prev_original) || "—"} ${chipPrazo(p)}`)}${item("Previsão Intelipost atual", br(p.prev_atual))}
        ${item("Previsão 360", br(p.prev_360))}${item("Expedição", br(p.data_expedicao))}
      </div>
      <h3>Rastreio</h3>
      <div class="det-grade">
        ${item("Micro status", `<span class="ms">${esc(p.micro_status)}</span>${marcaOc(p)}`)}${item("Responsável", nomeResp(p.micro_status))}${ticketsInfo ? item("Ticket", (() => { const t = ticketDe(p); return t ? `${esc(t.fila || "")}<div class="s">${esc([t.tipo, t.motivo, t.id_ticket ? "nº " + t.id_ticket : "", t.qtd > 1 ? t.qtd + " tickets" : ""].filter(Boolean).join(" · "))}</div>` : "Sem ticket"; })()) : ""}${item("Status Intelipost", esc(p.status_intelipost))}
        ${item("Última atualização", `${dh(p.ultima_atualizacao)}${p._parado !== null ? ` <span class="s">(${p._parado} dia${p._parado === 1 ? "" : "s"} sem movimento)</span>` : ""}`)}
        ${item("Ocorrência", esc(p.ocorrencia))}
      </div>
      ${p.descricao ? `<p class="det-desc">${esc(p.descricao)}</p>` : ""}
      ${p.qtd_tickets || p.comentario_360 ? `<h3>SAC</h3><div class="det-grade">
        ${item("Tickets", p.qtd_tickets ? esc(String(p.qtd_tickets)) : "")}${item("Motivo do 1º ticket", esc(p.motivo_ticket))}
        ${item("Comentário 360", esc(p.comentario_360))}</div>` : ""}
      <h3>Logística</h3>
      <div class="det-form" data-pedido="${esc(p.pedido)}">
        <label>Nova data<input type="date" id="det-nova" value="${esc(t.nova_data || "")}"></label>
        <label class="cresce">Observação<textarea id="det-obs" rows="4" maxlength="1000" placeholder="O que foi feito com a transportadora / SAC…">${esc(t.observacao || "")}</textarea></label>
        <div class="det-acoes"><span class="s" id="det-quem">${t.atualizado_por ? `Última alteração: ${esc(t.atualizado_por.split("@")[0])} · ${dh(t.atualizado_em)}` : ""}</span>
          <button class="btn primario" id="det-salvar">Salvar</button></div>
        <p class="s">A observação fica salva até o pedido aparecer como entregue ou cancelado no arquivo da Intelipost.</p>
      </div>`;
    $("modal").hidden = false;
    document.body.classList.add("sem-rolagem");
  }
  function fecharDetalhe() { $("modal").hidden = true; document.body.classList.remove("sem-rolagem"); if (redesenhar._pendente) { redesenhar._pendente = false; redesenhar(true); } }
  $("modal-fechar").addEventListener("click", fecharDetalhe);
  $("modal").addEventListener("click", (e) => { if (e.target.id === "modal") fecharDetalhe(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("modal").hidden) fecharDetalhe(); });
  $("modal-corpo").addEventListener("click", async (e) => {
    if (!e.target.closest("#det-salvar")) return;
    const ped = $("modal-corpo").querySelector(".det-form").dataset.pedido;
    const quem = $("det-quem");
    await gravar(ped, "nova_data", $("det-nova").value, quem);
    await gravar(ped, "observacao", $("det-obs").value, quem);
    if (!quem.textContent.startsWith("✓")) quem.innerHTML = `<span class="salvo">✓ salvo</span>`;
  });
  $("linhas").addEventListener("click", (e) => {
    if (e.target.closest("input, select, textarea, a, button")) return;
    const tr = e.target.closest("tr[data-pedido]"); if (tr) abrirDetalhe(tr.dataset.pedido);
  });

  $("linhas").addEventListener("change", (e) => { if (e.target.dataset.campo) salvar(e.target); });
  $("linhas").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.dataset.campo === "observacao") e.target.blur(); });
  $("linhas").addEventListener("focusout", () => {
    setTimeout(() => {
      if (redesenhar._pendente && !(document.activeElement && document.activeElement.closest("#linhas"))) { redesenhar._pendente = false; redesenhar(true); }
    }, 300);
  });

  // exportar o que está na lista
  $("btn-exportar").addEventListener("click", () => {
    const cab = ["Pedido Intelipost", "NF", "Canal", "Transportadora", "Cidade", "UF", "Micro status", "Responsável", "Fila do ticket", "Dias sem movimento", "Prometido ao cliente",
      "Previsão Intelipost atual", "Dias para vencer", "Nova data", "Observação", "Atualizado por", "Atualizado em", "Comentário 360", "Tickets SAC", "Rastreio"];
    const linhas = filtrados.map((p) => { const t = p._t || {}; return [p.pedido, p.nf, p.canal, p.transportadora, p.cidade, p.uf, p.micro_status, (respDe(p.micro_status) || { nome: PENDENTE }).nome, FILTROS.tk(p), p._parado,
      br(p.prev_original), br(p.prev_atual), p._dias, br(t.nova_data), t.observacao, t.atualizado_por,
      t.atualizado_em ? new Date(t.atualizado_em).toLocaleString("pt-BR") : "", p.comentario_360, p.qtd_tickets, p.link_rastreio]; });
    const ws = XLSX.utils.aoa_to_sheet([cab].concat(linhas));
    ws["!cols"] = cab.map((c, i) => ({ wch: [32, 12, 14, 20][i] || 16 }));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Pedidos");
    XLSX.writeFile(wb, `preventivo_${visao}_${hojeISO()}.xlsx`);
  });

  // ---------------- envio da planilha ----------------
  const COLUNAS = {   // campo do banco -> nome da coluna na planilha
    pedido: "PEDIDO INTELIPOST", nf: "NOTA", canal: "CANAL", origem: "ORIGEM", transportadora: "TRANSPORTADORA",
    micro_status: "MICRO STATUS INTELIPOST", status_intelipost: "STATUS INTELIPOST", descricao: "DESCRICAO MICRO STATUS INTELIPOST",
    ultima_atualizacao: "DATA DA ULTIMA ATUALIZACAO NA INTELIPOST", data_expedicao: "DATA DE EXPEDICAO",
    prev_original: "DATA ORIGINAL ESTIMADA DA ENTREGA(INTELIPOST)", prev_atual: "DATA ESTIMADA DA ENTREGA(INTELIPOST)",
    prev_360: "DATA ESTIMADA DA ENTREGA(360)", comentario_360: "COMENTARIO 360", uf: "ESTADO DESTINO INTELIPOST",
    cidade: "CIDADE DESTINO INTELIPOST", ocorrencia: "OCORRENCIA INTELIPOST", qtd_tickets: "QTD TICKETS",
    motivo_ticket: "MOTIVO DO PRIMEIRO TICKET", link_rastreio: "LINK DE RASTREIO",
  };
  const DATAS = new Set(["data_expedicao", "prev_original", "prev_atual", "prev_360"]);

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
    const p2 = (n) => String(n).padStart(2, "0");
    if (Number(y) < 2000) return null;   // datas inválidas (ex.: 1926)
    const dt = `${y}-${p2(m)}-${p2(d)}`;
    return comHora ? `${dt}T${p2(H)}:${p2(M)}:${p2(S)}` : dt;
  }

  $("arquivo").addEventListener("change", async (e) => {
    const arq = e.target.files[0]; e.target.value = "";
    if (!arq) return;
    carregando("Lendo a planilha…");
    await new Promise((r) => setTimeout(r, 50));
    let linhas;
    try {
      const wb = XLSX.read(await arq.arrayBuffer(), { type: "array", cellDates: false, dense: true });
      const nomeAba = wb.SheetNames.find((n) => norm(n) === "EXPORT") || wb.SheetNames[0];
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[nomeAba], { header: 1, raw: true, defval: null });
      const iCab = rows.findIndex((r) => r && r.some((c) => norm(c) === "PEDIDO INTELIPOST") && r.some((c) => norm(c) === "MICRO STATUS INTELIPOST"));
      if (iCab < 0) throw new Error('Não achei as colunas "Pedido Intelipost" e "Micro Status Intelipost". Confira se é a planilha exportada.');
      const cab = rows[iCab].map(norm);
      const idx = {}; Object.entries(COLUNAS).forEach(([k, nome]) => (idx[k] = cab.indexOf(nome)));
      const vistos = new Set();
      linhas = [];
      for (const r of rows.slice(iCab + 1)) {
        const ped = r[idx.pedido] == null ? "" : String(r[idx.pedido]).trim();
        if (!ped || vistos.has(ped)) continue;
        vistos.add(ped);
        const o = {};
        for (const k of Object.keys(COLUNAS)) {
          const v = idx[k] >= 0 ? r[idx[k]] : null;
          if (k === "ultima_atualizacao") o[k] = dataCelula(v, true);
          else if (DATAS.has(k)) o[k] = dataCelula(v, false);
          else if (k === "qtd_tickets") o[k] = v == null || v === "" || isNaN(Number(v)) ? null : Math.round(Number(v));
          else o[k] = v == null || v === "" ? null : String(v).trim();
        }
        linhas.push(o);
      }
      if (!linhas.length) throw new Error("A planilha não tem pedidos.");
    } catch (err) {
      carregando(""); toast(err.message, true); return;
    }
    carregando("");
    if (!confirm(`${arq.name}\n\n${fmt(linhas.length)} pedidos encontrados.\n\nEssa planilha vai substituir a base atual para todos.\nAs observações já feitas continuam salvas.\n\nEnviar?`)) return;
    try {
      for (let i = 0; i < linhas.length; i += 2000) {
        carregando(`Enviando… ${fmt(Math.min(i + 2000, linhas.length))} de ${fmt(linhas.length)}`);
        const { error } = await sb.rpc("importar_base", { linhas: linhas.slice(i, i + 2000), limpar: i === 0, arquivo: arq.name, total: linhas.length });
        if (error) throw error;
      }
    } catch (err) {
      carregando(""); toast("Erro ao enviar: " + err.message, true); return;
    }
    carregando("");
    toast(`Base atualizada: ${fmt(linhas.length)} pedidos.`);
    carregar();
  });
  // ---------------- arquivo da Intelipost (entregues e cancelados) ----------------
  $("arquivo-intelipost").addEventListener("change", async (e) => {
    const arq = e.target.files[0]; e.target.value = "";
    if (!arq) return;
    carregando("Lendo o arquivo da Intelipost… (pode levar uns 30 segundos)");
    let res;
    try {
      const dados = await arq.arrayBuffer();
      res = await new Promise((ok, falha) => {
        const w = new Worker("leitor-intelipost.js?v=32");
        w.onmessage = (m) => {
          if (m.data.etapa) carregando(m.data.etapa);
          else { w.terminate(); m.data.erro ? falha(new Error(m.data.erro)) : ok(m.data); }
        };
        w.onerror = (er) => { w.terminate(); falha(new Error(er.message || "Não consegui ler o arquivo.")); };
        w.postMessage(dados, [dados]);
      });
    } catch (err) {
      carregando(""); toast(err.message, true); return;
    }
    carregando("");
    const lista = res.fechados;
    const naBase = new Set(lista.map((x) => x.pedido));
    const sairao = base.filter((p) => naBase.has(p.pedido)).length;
    const ent = lista.filter((x) => x.status === "Entregue").length;
    if (!confirm(`${arq.name}\n\n${fmt(res.total)} pedidos no arquivo: ${fmt(ent)} entregues e ${fmt(lista.length - ent)} cancelados.\n` +
      `${fmt(sairao)} pedido${sairao === 1 ? "" : "s"} que está${sairao === 1 ? "" : "ão"} no painel vai${sairao === 1 ? "" : "ão"} sair.\n\nEnviar?`)) return;
    try {
      const LOTE = 5000, qtd = lista.length;
      if (!lista.length) lista.push({ pedido: "", status: null });
      for (let i = 0; i < lista.length; i += LOTE) {
        carregando(`Enviando… ${fmt(Math.min(i + LOTE, lista.length))} de ${fmt(lista.length)}`);
        const { error } = await sb.rpc("importar_fechados", { linhas: lista.slice(i, i + LOTE), limpar: i === 0,
          arquivo: arq.name, total_linhas: res.total, fechados: qtd });
        if (error) throw error;
      }
    } catch (err) {
      carregando(""); toast("Erro ao enviar: " + err.message, true); return;
    }
    carregando("");
    toast(`Intelipost atualizada: ${fmt(sairao)} pedido${sairao === 1 ? "" : "s"} saíram do painel.`);
    carregar();
  });
  // =================================================================
  // OCORRÊNCIAS: micro status que precisam de ocorrência no portal
  // =================================================================
  const MS_OCORRENCIA = ["DESTINATÁRIO AUSENTE", "ENDEREÇO NÃO LOCALIZADO", "AGUARDANDO INSTRUÇÃO", "DESTINATÁRIO MUDOU-SE",
    "CARGA RECUSADA PELO DESTINATARIO", "ESTABELECIMENTO FECHADO"];
  const MS_OC = new Set(MS_OCORRENCIA.map(norm));
  // nome da transportadora como aparece no portal (planilha "metodos_tps_int": coluna "Transportadora a considerar")
  const TRANSP_PORTAL = ["Aceville", "Anjun Express", "Atual Cargas", "Bento Brasil", "Costa Transportes", "DLOG Transportes",
    "Dominalog Express", "Flog Transportes", "Formato Transportes", "IDH", "JadLog", "MF Transportes", "Frota Interna",
    "Passaro transportes", "Petrymar", "PROLOG TRANSPORTES E LOGISTICA LTDA", "RAJLOG SERVICOS LOGISTICOS", "Rapido Alem Paraiba",
    "Reunidas", "SAJOB", "VM TRANSPORTES", "Termaco", "Tradicional Log", "Trans Sua Log", "TRANSCAI TRANSPORTES", "Transiga",
    "Transito Brasil", "Translaguna", "Translovato", "Transportadora BLZ", "Transvanio", "Trilog Express", "TSL Transportes",
    "Zafer Standard", "Zelog Transportes"];
  // como escolher no portal (definido pela Logística em 10/11/2026)
  const NOME_NO_PORTAL = { "VM TRANSPORTES": "VM TRANSPORTES (a 1ª da lista)", "Atual Cargas": "Atual Cargas Standard",
    "Transiga": "TRANSIGA", "Petrymar": "Petrymar Transportes", "TRANSCAI TRANSPORTES": "Transcai" };
  const MOTIVO_PORTAL = { "CARGA RECUSADA PELO DESTINATARIO": "Recusa", "AGUARDANDO INSTRUCAO": "Confirmação de dados",
    "ESTABELECIMENTO FECHADO": "Destinatário ausente", "DESTINATARIO MUDOU-SE": "Mudança de endereço" };
  const motivoPortal = (ms) => MOTIVO_PORTAL[norm(ms)] || ms;
  function transpPortal(nome) {
    const n = norm(nome); if (!n) return "(sem transportadora)";
    const igual = TRANSP_PORTAL.find((t) => norm(t) === n); if (igual) return igual;
    const w = n.split(" ")[0];
    const porPalavra = TRANSP_PORTAL.filter((t) => norm(t).split(" ")[0] === w);
    return porPalavra.length === 1 ? porPalavra[0] : nome;
  }
  const semZero = (v) => String(v ?? "").trim().replace(/\.0+$/, "").replace(/^0+(?=\d)/, "");
  function nfSerie(p) { const [n, sr] = String(p.nf || "").split("-"); return { nf: semZero(n), serie: semZero(sr) }; }
  let ocKeys = new Set(), ocSoNF = new Set(), ocInfo = null, ocOk = true;
  // mesmos pedidos da tabela de range: vencidos e a vencer (com data prometida)
  const precisaOc = (p) => !!p._faixa && MS_OC.has(norm(p.micro_status));
  function ocCadastrada(p) { const { nf, serie } = nfSerie(p); return ocKeys.has(nf + "-" + serie) || ocSoNF.has(nf); }
  function marcaOc(p) {
    if (!precisaOc(p)) return "";
    return ocCadastrada(p) ? `<div class="tag-oc ok">✓ ocorrência cadastrada</div>` : `<div class="tag-oc pend">ocorrência a cadastrar</div>`;
  }

  async function carregarOcorrencias() {
    try {
      const [lista, inf] = await Promise.all([buscarTudo("ocorrencias_cadastradas", "nf"), sb.from("ocorrencias_info").select("*").limit(1)]);
      ocKeys = new Set(); ocSoNF = new Set();
      lista.forEach((o) => (o.serie ? ocKeys.add(semZero(o.nf) + "-" + semZero(o.serie)) : ocSoNF.add(semZero(o.nf))));
      ocInfo = inf.data && inf.data[0]; ocOk = true;
    } catch (_) { ocOk = false; }
  }

  function desenharOcorrencias() {
    desenharRobo();
    const alvo = base.filter(precisaOc);
    const falta = alvo.filter((p) => !ocCadastrada(p));
    $("oc-info").textContent = !ocOk ? "Para usar esta página, rode de novo o supabase/schema.sql no Supabase."
      : ocInfo ? `Última planilha de ocorrências: ${ocInfo.arquivo || ""} · ${new Date(ocInfo.enviado_em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}${ocInfo.enviado_por ? " por " + ocInfo.enviado_por : ""} · ${fmt(ocKeys.size + ocSoNF.size)} notas cadastradas no total`
      : "Ainda não foi enviada nenhuma planilha de ocorrências cadastradas.";
    $("menu-oc").hidden = !falta.length; $("menu-oc").textContent = fmt(falta.length);
    $("oc-resumo").innerHTML = MS_OCORRENCIA.map((ms) => {
      const t = alvo.filter((p) => norm(p.micro_status) === norm(ms)), f = t.filter((p) => !ocCadastrada(p)).length;
      return `<div class="oc-card ${f ? "pend" : ""}"><span>${esc(ms)}</span><b>${fmt(f)}</b><em>a cadastrar · ${fmt(t.length - f)} de ${fmt(t.length)} já cadastrada${t.length - f === 1 ? "" : "s"}</em></div>`;
    }).join("");
    if (!falta.length) { $("oc-grupos").innerHTML = `<p class="vazio">Nenhuma nota para cadastrar agora. 🎉</p>`; return; }
    $("oc-grupos").innerHTML = MS_OCORRENCIA.map((ms) => {
      const doMs = falta.filter((p) => norm(p.micro_status) === norm(ms));
      if (!doMs.length) return "";
      const grupos = new Map();
      doMs.forEach((p) => { const k = transpPortal(p.transportadora); (grupos.get(k) || grupos.set(k, []).get(k)).push(p); });
      const linhas = [...grupos.entries()].sort((a, b) => b[1].length - a[1].length).map(([tp, ps]) => `
        <tr><td><b>${esc(NOME_NO_PORTAL[tp] || tp)}</b>${norm(tp) !== norm(ps[0].transportadora) ? `<div class="s">na base: ${esc(ps[0].transportadora || "—")}</div>` : ""}</td>
          <td class="num">${fmt(ps.length)}</td>
          <td><details><summary>ver notas</summary><div class="s">${ps.map((p) => esc(p.nf)).join(", ")}</div></details></td>
          <td class="dir"><button class="btn" data-template="${esc(ms)}|${esc(tp)}">⬇ Baixar template</button></td></tr>`).join("");
      return `<div class="oc-grupo"><h3>${esc(ms)} <span class="s">· motivo em massa no portal: <b>${esc(motivoPortal(ms))}</b> · ${fmt(doMs.length)} nota${doMs.length === 1 ? "" : "s"}</span></h3>
        <table class="tabela-oc"><thead><tr><th>Transportadora no portal</th><th class="num">Notas</th><th></th><th></th></tr></thead><tbody>${linhas}</tbody></table></div>`;
    }).join("");
  }

  // ---------------- robô do portal (fila no banco; o robô roda no GitHub) ----------------
  // motivo e transportadora exatamente como aparecem no portal (definido pela Logística em 10/11/2026)
  const MOTIVO_ROBO = { "DESTINATARIO AUSENTE": "Destinatário ausente", "ENDERECO NAO LOCALIZADO": "Endereço não localizado",
    "AGUARDANDO INSTRUCAO": "Confirmação de dados", "CARGA RECUSADA PELO DESTINATARIO": "Recusa",
    "ESTABELECIMENTO FECHADO": "Destinatário ausente", "DESTINATARIO MUDOU-SE": "Mudança de endereço" };
  const TRANSP_ROBO = { "VM TRANSPORTES": "VM TRANSPORTES", "Atual Cargas": "Atual Cargas Standard", "Transiga": "TRANSIGA",
    "Petrymar": "Petrymar Transportes", "TRANSCAI TRANSPORTES": "Transcai" };   // VM: sempre a 1ª da lista (posicao 0)
  let fila = [], filaOk = true;

  function notasNaFila() {
    const s = new Set();
    fila.filter((f) => f.status === "pendente" || f.status === "processando")
      .forEach((f) => (f.grupos || []).forEach((g) => g.notas.forEach((n) => s.add(n.nf + "-" + n.serie))));
    return s;
  }
  function gruposParaRobo() {
    const naFila = notasNaFila(), mapa = new Map(), semMotivo = new Set();
    base.filter((p) => precisaOc(p) && !ocCadastrada(p)).forEach((p) => {
      const { nf, serie } = nfSerie(p); if (!nf || naFila.has(nf + "-" + serie)) return;
      const motivo = MOTIVO_ROBO[norm(p.micro_status)]; if (!motivo) { semMotivo.add(p.micro_status); return; }
      const tp = transpPortal(p.transportadora), transportadora = TRANSP_ROBO[tp] || tp;
      const k = motivo + "|" + transportadora;
      if (!mapa.has(k)) mapa.set(k, { ms: p.micro_status, motivo, transportadora, posicao: 0, notas: [] });
      mapa.get(k).notas.push({ nf, serie });
    });
    // no máximo 10 notas por arquivo (a tabela do portal mostra 10 por página)
    const grupos = [];
    mapa.forEach((g) => { for (let i = 0; i < g.notas.length; i += 10) grupos.push({ ...g, notas: g.notas.slice(i, i + 10) }); });
    return { grupos, semMotivo: [...semMotivo] };
  }

  async function carregarFila() {
    const { data, error } = await sb.from("fila_portal").select("*").order("id", { ascending: false }).limit(8);
    if (error) { filaOk = false; return; }
    filaOk = true; fila = data;
  }
  function desenharRobo() {
    if (!filaOk) { $("robo-aviso").textContent = "Para usar o robô, rode de novo o supabase/schema.sql no Supabase."; $("robo-fila").innerHTML = ""; return; }
    const { grupos, semMotivo } = gruposParaRobo();
    const nNotas = grupos.reduce((s, g) => s + g.notas.length, 0);
    const ocupado = fila.some((f) => f.status === "pendente" || f.status === "processando");
    $("robo-enviar").disabled = !nNotas || ocupado; $("robo-testar").disabled = !nNotas || ocupado;
    $("robo-aviso").innerHTML = (ocupado ? "⏳ O robô já tem um pedido na fila. Espere ele terminar. " : "")
      + (nNotas ? `${fmt(nNotas)} nota${nNotas === 1 ? "" : "s"} pronta${nNotas === 1 ? "" : "s"} para o robô, em ${grupos.length} arquivo${grupos.length === 1 ? "" : "s"}.` : "Nenhuma nota pendente para o robô.")
      + (semMotivo.length ? ` <b>Sem motivo definido no portal (o robô não envia):</b> ${semMotivo.map(esc).join(", ")}.` : "");
    const nomeSt = { pendente: "⏳ Na fila", processando: "🤖 Trabalhando", feito: "✓ Terminado", erro: "⚠ Erro" };
    const quando = (d) => (d ? new Date(d).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "");
    $("robo-fila").innerHTML = fila.length ? `<table class="tabela-oc"><thead><tr><th>Pedido ao robô</th><th>Situação</th><th>Resultado</th></tr></thead><tbody>${fila.map((f) => {
      const res = Array.isArray(f.resultado) ? f.resultado : [];
      const ok = res.filter((r) => r.status === "ok"), er = res.filter((r) => r.status !== "ok");
      const notasOk = ok.reduce((s, r) => s + (r.notas || 0), 0);
      return `<tr><td>${quando(f.criado_em)}${f.teste ? ' <span class="chip cinza">teste</span>' : ""}<div class="s">${esc((f.criado_por || "").split("@")[0])} · ${(f.grupos || []).reduce((s, g) => s + g.notas.length, 0)} notas</div></td>
        <td>${nomeSt[f.status] || esc(f.status)}<div class="s">${quando(f.terminado_em || f.iniciado_em)}</div></td>
        <td>${res.length ? `${ok.length ? `✓ ${ok.length} arquivo${ok.length === 1 ? "" : "s"} ${f.teste ? "conferido" + (ok.length === 1 ? "" : "s") : "enviado" + (ok.length === 1 ? "" : "s") + ` (${notasOk} notas)`}` : ""}
          ${er.length ? `<details><summary class="erro-txt">⚠ ${er.length} com problema</summary>${er.map((r) => `<div class="s">${esc([r.ms, r.transportadora].filter(Boolean).join(" · "))}: ${esc(r.msg || "")}</div>`).join("")}</details>` : ""}` : '<span class="s">—</span>'}</td></tr>`;
    }).join("")}</tbody></table>` : "";
  }
  async function mandarRobo(teste) {
    const { grupos } = gruposParaRobo(); if (!grupos.length) return;
    const n = grupos.reduce((s, g) => s + g.notas.length, 0);
    if (!confirm(teste ? `Testar o robô com ${n} notas? Ele entra no portal e prepara tudo, mas NÃO clica em Enviar Notas.`
      : `Mandar ${n} notas (${grupos.length} arquivos) para o robô cadastrar no portal?`)) return;
    const { error } = await sb.from("fila_portal").insert({ grupos, teste });
    if (error) return toast("Não foi possível: " + error.message, true);
    toast("Pedido enviado ao robô. Ele começa em até 10 minutos.");
    await carregarFila(); desenharRobo();
  }
  $("robo-enviar").addEventListener("click", () => mandarRobo(false));
  $("robo-testar").addEventListener("click", () => mandarRobo(true));
  setInterval(async () => {
    if (!usuarioId || perfil === "sac" || paginaAtual !== "ocorrencias" || document.hidden) return;
    const antes = JSON.stringify(fila.map((f) => [f.id, f.status]));
    await carregarFila();
    if (antes !== JSON.stringify(fila.map((f) => [f.id, f.status]))) { await carregarOcorrencias(); desenharOcorrencias(); redesenhar(true); }
  }, 30000);

  $("oc-grupos").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-template]"); if (!b) return;
    const [ms, tp] = b.dataset.template.split("|");
    const ps = base.filter((p) => precisaOc(p) && !ocCadastrada(p) && norm(p.micro_status) === norm(ms) && transpPortal(p.transportadora) === tp);
    const linhas = [["Nota", "Serie"]].concat(ps.map((p) => { const { nf, serie } = nfSerie(p); return [/^\d+$/.test(nf) ? Number(nf) : nf, /^\d+$/.test(serie) ? Number(serie) : serie]; }));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(linhas), "Planilha1");
    const limpa = (t) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w -]+/g, "").trim();
    XLSX.writeFile(wb, `${limpa(ms)} - ${limpa(tp)}.xlsx`);
    b.textContent = "✓ Baixado"; b.classList.add("feito");
  });

  // planilha de ocorrências cadastradas (todo dia)
  $("arquivo-ocorrencias").addEventListener("change", async (e) => {
    const arq = e.target.files[0]; e.target.value = "";
    if (!arq) return;
    carregando("Lendo a planilha de ocorrências…");
    await new Promise((r) => setTimeout(r, 50));
    let linhas;
    try {
      const wb = XLSX.read(await arq.arrayBuffer(), { type: "array", dense: true });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
      const ehNota = (c) => { const n = norm(c); return n === "NF" || n === "NOTA" || (n.includes("NOTA") && !n.includes("CHAVE") && !n.includes("SERIE") && !n.includes("VALOR") && !n.includes("DATA")) || n === "NUMERO NF"; };
      const iCab = rows.findIndex((r) => r && r.some(ehNota));
      if (iCab < 0) throw new Error('Não achei a coluna da nota fiscal (ex.: "Nota", "NF" ou "Nota Fiscal").');
      const cab = rows[iCab];
      const cNf = cab.findIndex(ehNota);
      const cSr = cab.findIndex((c) => norm(c).includes("SERIE"));
      const cMot = cab.findIndex((c) => /MOTIVO|OCORRENCIA/.test(norm(c)));
      const vistos = new Set(); linhas = [];
      rows.slice(iCab + 1).forEach((r) => {
        if (!r || r[cNf] == null || r[cNf] === "") return;
        let nf = semZero(r[cNf]), serie = cSr >= 0 ? semZero(r[cSr]) : "";
        if (nf.includes("-") && !serie) [nf, serie] = nf.split("-").map(semZero);
        const k = nf + "-" + serie; if (!nf || vistos.has(k)) return; vistos.add(k);
        linhas.push({ nf, serie, motivo: cMot >= 0 && r[cMot] != null ? String(r[cMot]).trim() : null });
      });
      if (!linhas.length) throw new Error("A planilha não tem notas.");
    } catch (err) { carregando(""); toast(err.message, true); return; }
    carregando("");
    const antes = base.filter((p) => precisaOc(p) && !ocCadastrada(p)).length;
    if (!confirm(`${arq.name}\n\n${fmt(linhas.length)} notas com ocorrência encontradas.\nElas serão somadas às já enviadas antes.\n\nEnviar?`)) return;
    try {
      for (let i = 0; i < linhas.length; i += 5000) {
        carregando(`Enviando… ${fmt(Math.min(i + 5000, linhas.length))} de ${fmt(linhas.length)}`);
        const { error } = await sb.rpc("importar_ocorrencias", { linhas: linhas.slice(i, i + 5000), arquivo: arq.name, primeiro: i === 0, total: linhas.length });
        if (error) throw error;
      }
    } catch (err) { carregando(""); toast("Erro ao enviar: " + err.message, true); return; }
    await carregarOcorrencias();
    carregando("");
    const depois = base.filter((p) => precisaOc(p) && !ocCadastrada(p)).length;
    toast(`Ocorrências atualizadas: ${fmt(antes - depois)} nota${antes - depois === 1 ? "" : "s"} saíram da lista "a cadastrar".`);
    desenharOcorrencias(); redesenhar(true);
  });

  // ---------------- menu lateral ----------------
  function irPara(pag) {
    paginaAtual = pag;
    $("topo-pagina").textContent = { preventivo: "Preventivo", ocorrencias: "Ocorrências", responsaveis: "Responsáveis", reposicao: "Reposição", sac: "Consulta SAC" }[pag] || "";
    document.querySelectorAll(".menu-item").forEach((x) => x.classList.toggle("ativo", x.dataset.pagina === pag));
    document.querySelectorAll("main.conteudo").forEach((m) => (m.hidden = m.id !== "pagina-" + pag));
    window.scrollTo(0, 0);
  }
  document.querySelector(".menu-lateral").addEventListener("click", (e) => {
    const b = e.target.closest(".menu-item"); if (!b) return;
    irPara(b.dataset.pagina);
    if (b.dataset.pagina === "sac" && perfil !== "sac") desenharSacLogistica();
  });

  // ---------------- retornos em massa (modelo: Pedido Intelipost, NF, Transportadora, Nova Data, Observação) ----------------
  // Coluna Nova Data: só data -> Nova data. Coluna Observação: texto -> Observação. Fica salvo até o pedido sair como entregue/cancelado.
  $("btn-modelo-retornos").addEventListener("click", () => {
    const linhas = [["Pedido Intelipost", "NF", "Transportadora", "Nova Data", "Observação"]]
      .concat(filtrados.map((p) => [p.pedido, p.nf, p.transportadora, null, null]));
    const ws = XLSX.utils.aoa_to_sheet(linhas); ws["!cols"] = [{ wch: 34 }, { wch: 12 }, { wch: 22 }, { wch: 14 }, { wch: 40 }];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Planilha1");
    XLSX.writeFile(wb, `template_retornos_${hojeISO()}.xlsx`);
  });
  $("arquivo-retornos").addEventListener("change", async (e) => {
    const arq = e.target.files[0]; e.target.value = "";
    if (!arq) return;
    carregando("Lendo o modelo de retornos…");
    await new Promise((r) => setTimeout(r, 50));
    const mudancas = new Map(); let lidas = 0, naoAchados = [], datasInvalidas = 0;
    try {
      const wb = XLSX.read(await arq.arrayBuffer(), { type: "array", dense: true });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
      const iCab = rows.findIndex((r) => r && r.some((c) => norm(c) === "RETORNO" || norm(c).startsWith("NOVA DATA") || norm(c).startsWith("OBSERVA")));
      if (iCab < 0) throw new Error('Não achei as colunas "Nova Data" e "Observação" no modelo.');
      const cab = rows[iCab].map(norm);
      const cPed = cab.findIndex((c) => c.includes("PEDIDO")), cNf = cab.findIndex((c) => c === "NF" || c === "NOTA" || c.startsWith("NOTA FISCAL") || c === "NOTA-SERIE");
      const cRet = cab.findIndex((c) => c === "RETORNO"), cData = cab.findIndex((c) => c.startsWith("NOVA DATA")), cObs = cab.findIndex((c) => c.startsWith("OBSERVA"));
      const porPed = new Map(base.map((p) => [norm(p.pedido), p])), porNf = new Map(base.map((p) => [chaveNF(p.nf), p]));
      rows.slice(iCab + 1).forEach((r) => {
        if (!r) return;
        const ret = cRet >= 0 ? r[cRet] : null, dat = cData >= 0 ? r[cData] : null, obs = cObs >= 0 ? r[cObs] : null;
        if ([ret, dat, obs].every((v) => v == null || String(v).trim() === "")) return;
        lidas++;
        const p = (cPed >= 0 && r[cPed] != null && porPed.get(norm(r[cPed]))) || (cNf >= 0 && r[cNf] != null && porNf.get(chaveNF(r[cNf])));
        if (!p) { naoAchados.push(String((cPed >= 0 && r[cPed]) || (cNf >= 0 && r[cNf]) || "?")); return; }
        const m = mudancas.get(p.pedido) || {};
        // coluna antiga "Retorno": data vira nova data, texto vira observação
        if (ret != null && String(ret).trim() !== "") { const d = dataCelula(ret); if (d) m.nova_data = d; else m.observacao = String(ret).trim().slice(0, 1000); }
        // Nova Data: só data (o que não for data é ignorado e avisado)
        if (dat != null && String(dat).trim() !== "") { const d = dataCelula(dat); if (d) m.nova_data = d; else datasInvalidas++; }
        // Observação: sempre texto
        if (obs != null && String(obs).trim() !== "") m.observacao = String(obs).trim().slice(0, 1000);
        if (!m.nova_data && !m.observacao) return;
        mudancas.set(p.pedido, m);
      });
      if (!lidas) throw new Error("O modelo não tem nenhum retorno preenchido.");
    } catch (err) { carregando(""); toast(err.message, true); return; }
    carregando("");
    const nDatas = [...mudancas.values()].filter((m) => m.nova_data).length, nObs = [...mudancas.values()].filter((m) => m.observacao).length;
    if (!confirm(`${arq.name}\n\n${fmt(mudancas.size)} pedidos encontrados no painel: ${fmt(nDatas)} com nova data e ${fmt(nObs)} com observação.`
      + (datasInvalidas ? `\n⚠ ${fmt(datasInvalidas)} linha(s) com algo que não é data na coluna Nova Data: essas datas serão ignoradas.` : "")
      + (naoAchados.length ? `\n${fmt(naoAchados.length)} linha(s) não estão no painel (já entregues, canceladas ou fora da base) e serão ignoradas.` : "")
      + `\n\nGravar para todos?`)) return;
    const linhas = [...mudancas.entries()].map(([ped, m]) => {
      const a = trat.get(ped) || {};
      return { pedido: ped, situacao: a.situacao || null, nova_data: m.nova_data || a.nova_data || null, observacao: m.observacao || a.observacao || null };
    });
    try {
      for (let i = 0; i < linhas.length; i += 500) {
        carregando(`Gravando… ${fmt(Math.min(i + 500, linhas.length))} de ${fmt(linhas.length)}`);
        const { data, error } = await sb.from("tratativas").upsert(linhas.slice(i, i + 500)).select();
        if (error) throw error;
        (data || []).forEach((t) => trat.set(t.pedido, t));
      }
    } catch (err) { carregando(""); toast("Erro ao gravar: " + err.message, true); return; }
    carregando("");
    redesenhar(true);
    toast(`Retornos gravados em ${fmt(linhas.length)} pedidos.` + (naoAchados.length ? ` ${fmt(naoAchados.length)} não estavam no painel.` : ""));
  });

  // ---------------- tickets abertos (planilha detalhamento_tickets360, aba Tickets) ----------------
  let tickets = new Map(), ticketsInfo = null, ticketsOk = true;
  const chaveNF = (v) => String(v ?? "").trim().split("-").map((x) => x.trim().replace(/\.0+$/, "").replace(/^0+(?=\d)/, "")).join("-");
  const ticketDe = (p) => tickets.get(chaveNF(p.nf)) || null;
  function marcaTicket(p) {
    if (!ticketsInfo) return p.qtd_tickets ? `<div class="s">🎫 ${p.qtd_tickets} ticket${p.qtd_tickets > 1 ? "s" : ""} SAC${p.motivo_ticket ? " · " + esc(p.motivo_ticket) : ""}</div>` : "";
    const t = ticketDe(p);
    return t ? `<div class="s tk" title="${esc([t.tipo, t.motivo].filter(Boolean).join(" · "))}">🎫 Fila: ${esc(t.fila || "—")}${t.qtd > 1 ? ` (${t.qtd} tickets)` : ""}</div>`
      : `<div class="s sem-tk">Sem ticket</div>`;
  }
  async function carregarTickets() {
    try {
      const [lista, inf] = await Promise.all([buscarTudo("tickets_abertos", "nf"), sb.from("tickets_info").select("*").limit(1)]);
      tickets = new Map(lista.map((t) => [chaveNF(t.nf), t]));
      ticketsInfo = (inf.data && inf.data[0]) || null; ticketsOk = true;
    } catch (_) { ticketsOk = false; ticketsInfo = null; }
  }
  $("arquivo-tickets").addEventListener("change", async (e) => {
    const arq = e.target.files[0]; e.target.value = "";
    if (!arq) return;
    if (!ticketsOk) return toast("Rode de novo o supabase/schema.sql no Supabase para usar os tickets.", true);
    carregando("Lendo a planilha de tickets…");
    await new Promise((r) => setTimeout(r, 50));
    let linhas, total = 0;
    try {
      const wb = XLSX.read(await arq.arrayBuffer(), { type: "array", dense: true, cellDates: true });
      const nomeAba = wb.SheetNames.find((n) => norm(n) === "TICKETS") || wb.SheetNames[0];
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[nomeAba], { header: 1, raw: true, defval: null });
      const iCab = rows.findIndex((r) => r && r.some((c) => norm(c) === "FILA"));
      if (iCab < 0) throw new Error('Não achei a coluna "Fila" na aba Tickets.');
      const cab = rows[iCab].map(norm), col = (nome) => cab.indexOf(nome);
      const cNf = col("NOTA TICKET"), cFila = col("FILA"), cTipo = col("TIPO DE TICKET"), cMot = col("MOTIVO TICKET"),
        cId = col("ID TICKET"), cData = col("DATA CRIACAO TICKET");
      if (cNf < 0) throw new Error('Não achei a coluna "Nota ticket" na aba Tickets.');
      const porNF = new Map();
      rows.slice(iCab + 1).forEach((r) => {
        if (!r || r[cNf] == null || r[cNf] === "") return;
        total++;
        const nf = chaveNF(r[cNf]); if (!nf) return;
        let d = cData >= 0 ? r[cData] : null;
        d = d instanceof Date ? d.toISOString() : d ? String(d).replace(" ", "T") : null;
        const novo = { nf, fila: cFila >= 0 && r[cFila] != null ? String(r[cFila]).trim() : null, tipo: cTipo >= 0 && r[cTipo] != null ? String(r[cTipo]).trim() : null,
          motivo: cMot >= 0 && r[cMot] != null ? String(r[cMot]).trim() : null, id_ticket: cId >= 0 && r[cId] != null ? String(r[cId]).trim() : null, criado_em: d, qtd: 1 };
        const ant = porNF.get(nf);
        if (!ant) porNF.set(nf, novo);
        else { novo.qtd = ant.qtd + 1; porNF.set(nf, String(novo.criado_em || "") >= String(ant.criado_em || "") ? novo : { ...ant, qtd: novo.qtd }); }
      });
      linhas = [...porNF.values()];
      if (!linhas.length) throw new Error("A aba Tickets não tem notas.");
    } catch (err) { carregando(""); toast(err.message, true); return; }
    carregando("");
    if (!confirm(`${arq.name}\n\n${fmt(total)} tickets abertos, em ${fmt(linhas.length)} notas.\nSubstitui a planilha de tickets anterior para todos.\n\nEnviar?`)) return;
    try {
      for (let i = 0; i < linhas.length; i += 2000) {
        carregando(`Enviando… ${fmt(Math.min(i + 2000, linhas.length))} de ${fmt(linhas.length)}`);
        const { error } = await sb.rpc("importar_tickets", { linhas: linhas.slice(i, i + 2000), limpar: i === 0, arquivo: arq.name, total });
        if (error) throw error;
      }
    } catch (err) { carregando(""); toast("Erro ao enviar: " + err.message, true); return; }
    carregando("");
    await carregar();
    toast(`Tickets atualizados: ${fmt(base.filter((p) => ticketDe(p)).length)} pedidos do painel têm ticket aberto.`);
  });

  // ---------------- reposição (planilha TABELA DE ACOMPANHAMENTO, aba Export) ----------------
  // Pré entrega = criado pelo CCP (coluna Via) e na fila "Atribuir transportador"; pós entrega = Tipo "Reposição Pós Entrega".
  // Transportadora = redespacho se houver, senão a final.
  let reps = [], repInfo = null, repOk = true, repVisao = "pre", repFiltradas = [];
  const FILA_PRE = "ATRIBUIR TRANSPORTADOR";
  const SEM_MOTIVO = "(sem motivo)", SEM_TRANSP = "(sem transportadora)";
  const ePre = (r) => norm(r.fila) === FILA_PRE && norm(r.via) === "CCP";
  const ePos = (r) => !ePre(r) && norm(r.tipo) === "REPOSICAO POS ENTREGA";
  async function carregarReposicoes() {
    try {
      const [lista, inf] = await Promise.all([buscarTudo("reposicoes_tk", "ticket"), sb.from("reposicoes_tk_info").select("*").limit(1)]);
      if (inf.error) throw inf.error;
      reps = lista; repInfo = (inf.data && inf.data[0]) || null; repOk = true;
    } catch (_) { repOk = false; reps = []; repInfo = null; }
    montarReposicao();
  }
  function montarReposicao() {
    $("rep-info").textContent = !repOk ? "Para usar esta página, rode de novo o supabase/schema.sql no Supabase."
      : repInfo ? `Tabela: ${repInfo.arquivo || "planilha"} enviada em ${new Date(repInfo.enviado_em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}${repInfo.enviado_por ? " por " + repInfo.enviado_por : ""} · ${fmt(reps.length)} tickets guardados`
      : 'Ainda não há tabela. Clique em "Enviar tabela de acompanhamento".';
    const mesSel = $("rep-mes").value, trSel = $("rep-transp").value;
    const meses = [...new Set(reps.map((r) => String(r.criado_em || "").slice(0, 7)).filter(Boolean))].sort().reverse();
    const NOME_MES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
    $("rep-mes").innerHTML = `<option value="">Todos</option>` + meses.map((m) => `<option value="${m}">${NOME_MES[+m.slice(5) - 1]}/${m.slice(0, 4)}</option>`).join("");
    $("rep-mes").value = meses.includes(mesSel) ? mesSel : "";
    const trs = [...new Set(reps.filter((r) => ePre(r) || ePos(r)).map((r) => r.transportadora || SEM_TRANSP))].sort((a, b) => a.localeCompare(b, "pt-BR"));
    $("rep-transp").innerHTML = `<option value="">Todas</option>` + trs.map((t) => `<option>${esc(t)}</option>`).join("");
    $("rep-transp").value = trs.includes(trSel) ? trSel : "";
    filtrarRep();
  }
  function filtrarRep() {
    const de = $("rep-de").value, ate = $("rep-ate").value, mes = $("rep-mes").value, tr = $("rep-transp").value;
    const base0 = reps.filter((r) => {
      const d = String(r.criado_em || "").slice(0, 10);
      if (de && (!d || d < de)) return false;
      if (ate && (!d || d > ate)) return false;
      if (mes && d.slice(0, 7) !== mes) return false;
      if (tr && (r.transportadora || SEM_TRANSP) !== tr) return false;
      return true;
    });
    const pre = base0.filter(ePre), pos = base0.filter(ePos);
    const cont = { pre: pre.length, pos: pos.length, todas: pre.length + pos.length };
    document.querySelectorAll("#rep-visoes .visao-sac").forEach((b) => { b.classList.toggle("ativa", b.dataset.rv === repVisao); b.querySelector(".kpi-num").textContent = fmt(cont[b.dataset.rv]); });
    repFiltradas = repVisao === "pre" ? pre : repVisao === "pos" ? pos : pre.concat(pos);
    $("rep-titulo").textContent = `Casos por transportadora e motivo · ${{ pre: "Pré entrega", pos: "Pós entrega", todas: "Pré e pós entrega" }[repVisao]} (${fmt(repFiltradas.length)})`;
    const porMot = new Map(), porTr = new Map();
    repFiltradas.forEach((r) => {
      const m = r.motivo || SEM_MOTIVO, t = r.transportadora || SEM_TRANSP;
      porMot.set(m, (porMot.get(m) || 0) + 1);
      const x = porTr.get(t) || { total: 0, m: new Map() }; x.total++; x.m.set(m, (x.m.get(m) || 0) + 1); porTr.set(t, x);
    });
    const mots = [...porMot.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]);
    const cel = (n) => `<td class="num ${n ? "" : "vazio-c"}">${n ? fmt(n) : "·"}</td>`;
    $("rep-vazio").hidden = repFiltradas.length > 0;
    $("rep-cab").innerHTML = repFiltradas.length ? `<tr><th>Transportadora</th>${mots.map((m) => `<th>${esc(m)}</th>`).join("")}<th>Total</th></tr>` : "";
    $("rep-linhas").innerHTML = [...porTr.entries()].sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0], "pt-BR"))
      .map(([t, x]) => `<tr><td>${esc(t)}</td>${mots.map((m) => cel(x.m.get(m) || 0)).join("")}<td class="num tot">${fmt(x.total)}</td></tr>`).join("");
    $("rep-rodape").innerHTML = repFiltradas.length ? `<tr><td>Total</td>${mots.map((m) => `<td class="num">${fmt(porMot.get(m))}</td>`).join("")}<td class="num">${fmt(repFiltradas.length)}</td></tr>` : "";
  }
  $("rep-visoes").addEventListener("click", (e) => { const b = e.target.closest(".visao-sac"); if (!b) return; repVisao = b.dataset.rv; filtrarRep(); });
  ["rep-de", "rep-ate", "rep-mes", "rep-transp"].forEach((id) => $(id).addEventListener("change", filtrarRep));
  $("rep-limpar").addEventListener("click", () => { ["rep-de", "rep-ate", "rep-mes", "rep-transp"].forEach((id) => ($(id).value = "")); filtrarRep(); });
  $("rep-exportar").addEventListener("click", () => {
    if (!repFiltradas.length) return toast("Nada para exportar nesse filtro.", true);
    const linhas = [["Ticket", "Criado em", "Pré/Pós", "Transportadora", "Motivo", "Tipo", "Fila", "Status", "Nota fiscal", "Criado por", "Via"]]
      .concat(repFiltradas.map((r) => [r.ticket, r.criado_em ? br(r.criado_em) : "", ePre(r) ? "Pré entrega" : "Pós entrega", r.transportadora || "", r.motivo || "", r.tipo || "", r.fila || "", r.status || "", r.nf || "", r.criado_por || "", r.via || ""]));
    const ws = XLSX.utils.aoa_to_sheet(linhas); ws["!cols"] = [{ wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 34 }, { wch: 26 }, { wch: 22 }, { wch: 30 }, { wch: 14 }, { wch: 14 }, { wch: 22 }];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Reposições");
    XLSX.writeFile(wb, `reposicoes_${repVisao}_${hojeISO()}.xlsx`);
  });
  $("arquivo-rep").addEventListener("change", async (e) => {
    const arq = e.target.files[0]; e.target.value = "";
    if (!arq) return;
    if (!repOk) return toast("Rode de novo o supabase/schema.sql no Supabase para usar a Reposição.", true);
    carregando("Lendo a tabela de acompanhamento…");
    await new Promise((r) => setTimeout(r, 50));
    let linhas, total = 0;
    try {
      const wb = XLSX.read(await arq.arrayBuffer(), { type: "array", dense: true });
      const nomeAba = wb.SheetNames.find((n) => norm(n) === "EXPORT") || wb.SheetNames[0];
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[nomeAba], { header: 1, raw: true, defval: null });
      const iCab = rows.findIndex((r) => r && r.some((c) => norm(c) === "FILA") && r.some((c) => norm(c) === "TICKET"));
      if (iCab < 0) throw new Error('Não achei as colunas "Ticket" e "Fila" na aba Export.');
      const cab = rows[iCab].map(norm), col = (n) => cab.indexOf(n);
      const c = { ticket: col("TICKET"), via: col("VIA"), data: col("DATA DE CRIACAO"), por: col("TICKET CRIADO POR"), fila: col("FILA"), tipo: col("TIPO"), motivo: col("MOTIVO"),
        status: col("STATUS"), redesp: col("TRANSPORTADORA REDESPACHO"), final: col("TRANSPORTADORA FINAL"), nf: col("NOTA FISCAL") };
      if (c.via < 0 || c.tipo < 0) throw new Error('Não achei as colunas "Via" e "Tipo".');
      const txt = (r, i) => (i >= 0 && r[i] != null && String(r[i]).trim() !== "" ? String(r[i]).trim() : null);
      const porTk = new Map();
      rows.slice(iCab + 1).forEach((r) => {
        if (!r || txt(r, c.ticket) == null) return;
        total++;
        const fila = txt(r, c.fila), tipo = txt(r, c.tipo);
        if (norm(fila) !== FILA_PRE && !norm(tipo).startsWith("REPOSICAO")) return;
        porTk.set(txt(r, c.ticket), { ticket: txt(r, c.ticket), criado_em: c.data >= 0 ? dataCelula(r[c.data], true) : null, criado_por: txt(r, c.por), via: txt(r, c.via),
          fila, tipo, motivo: txt(r, c.motivo), status: txt(r, c.status), transportadora: txt(r, c.redesp) || txt(r, c.final), nf: txt(r, c.nf) });
      });
      linhas = [...porTk.values()];
      if (!linhas.length) throw new Error("A planilha não tem tickets de reposição.");
    } catch (err) { carregando(""); toast(err.message, true); return; }
    carregando("");
    const nPre = linhas.filter(ePre).length;
    if (!confirm(`${arq.name}\n\n${fmt(total)} tickets na planilha, ${fmt(linhas.length)} de reposição (${fmt(nPre)} pré entrega, ${fmt(linhas.filter(ePos).length)} pós entrega).\nTickets já guardados são atualizados; os novos são acrescentados.\n\nEnviar?`)) return;
    try {
      for (let i = 0; i < linhas.length; i += 2000) {
        carregando(`Enviando… ${fmt(Math.min(i + 2000, linhas.length))} de ${fmt(linhas.length)}`);
        const { error } = await sb.rpc("importar_reposicoes_tk", { linhas: linhas.slice(i, i + 2000), primeiro: i === 0, arquivo: arq.name, total });
        if (error) throw error;
      }
    } catch (err) { carregando(""); toast("Erro ao enviar: " + err.message, true); return; }
    await carregarReposicoes();
    carregando("");
    toast(`Reposições atualizadas: ${fmt(reps.length)} tickets guardados.`);
  });

  // ---------------- responsáveis por micro status ----------------
  const PENDENTE = "Pendente de responsável";
  let pessoas = [], respMs = new Map(), respOk = true;
  function respDe(ms) { const id = respMs.get(norm(ms)); return id ? pessoas.find((x) => x.id === id) || null : null; }
  function nomeResp(ms) { const r = respDe(ms); return r ? esc(r.nome) : `<span class="pendente">${PENDENTE}</span>`; }

  async function carregarResponsaveis() {
    try {
      const [ps, rm] = await Promise.all([buscarTudo("pessoas_responsaveis", "nome"), buscarTudo("responsavel_por_ms", "micro_status")]);
      pessoas = ps; respMs = new Map(rm.filter((x) => x.responsavel_id).map((x) => [x.micro_status, x.responsavel_id])); respOk = true;
    } catch (_) { respOk = false; }
  }

  function desenharResponsaveis() {
    if (!respOk) {
      $("lista-resp").innerHTML = `<p class="s">Para usar esta página, rode de novo o supabase/schema.sql no Supabase.</p>`;
      $("resp-linhas").innerHTML = ""; $("menu-resp").hidden = true; return;
    }
    $("lista-resp").innerHTML = pessoas.length
      ? pessoas.map((x) => `<span>${esc(x.nome)}${x.area ? ` <em class="s">· ${esc(x.area)}</em>` : ""}<button type="button" data-tirar-resp="${x.id}" title="Remover">×</button></span>`).join("")
      : `<p class="s">Nenhum responsável cadastrado ainda.</p>`;
    const cont = new Map(), nomeMs = new Map();
    base.forEach((p) => { const k = norm(p.micro_status || "(sem micro status)"); cont.set(k, (cont.get(k) || 0) + 1); if (!nomeMs.has(k)) nomeMs.set(k, p.micro_status || "(sem micro status)"); });
    const chaves = [...new Set([...cont.keys(), ...respMs.keys()])];
    chaves.sort((a, b) => (respMs.has(a) ? 1 : 0) - (respMs.has(b) ? 1 : 0) || (cont.get(b) || 0) - (cont.get(a) || 0) || a.localeCompare(b));
    const pend = chaves.filter((k) => !respMs.has(k) && cont.get(k)).length;
    $("menu-resp").hidden = !pend; $("menu-resp").textContent = fmt(pend);
    $("resp-resumo").textContent = `${fmt(chaves.length)} micro status · ${fmt(pend)} pendente${pend === 1 ? "" : "s"} de responsável`;
    const opcoes = (id) => `<option value="">${PENDENTE}</option>` + pessoas.map((x) => `<option value="${x.id}" ${x.id === id ? "selected" : ""}>${esc(x.nome)}${x.area ? " · " + esc(x.area) : ""}</option>`).join("");
    $("resp-linhas").innerHTML = chaves.map((k) => `<tr class="${respMs.has(k) ? "" : "linha-pendente"}">
        <td>${esc(nomeMs.get(k) || k)}</td><td class="num">${fmt(cont.get(k) || 0)}</td>
        <td><select data-resp-ms="${esc(k)}">${opcoes(respMs.get(k))}</select></td></tr>`).join("")
      || `<tr><td colspan="3" class="vazio">Envie a base para ver os micro status.</td></tr>`;
  }

  $("resp-linhas").addEventListener("change", async (e) => {
    const s = e.target.closest("select[data-resp-ms]"); if (!s) return;
    const ms = s.dataset.respMs, id = s.value ? Number(s.value) : null;
    const { error } = id
      ? await sb.from("responsavel_por_ms").upsert({ micro_status: ms, responsavel_id: id }, { onConflict: "micro_status" })
      : await sb.from("responsavel_por_ms").delete().eq("micro_status", ms);
    if (error) return toast("Não foi possível salvar: " + error.message, true);
    if (id) respMs.set(ms, id); else respMs.delete(ms);
    toast("Responsável salvo.");
    montarOpcoes(); redesenhar(true); desenharResponsaveis();
  });
  $("form-resp").addEventListener("submit", async (e) => {
    e.preventDefault();
    const nome = $("resp-nome").value.trim(), area = $("resp-area").value.trim() || null; if (!nome) return;
    const { error } = await sb.from("pessoas_responsaveis").insert({ nome, area });
    if (error) return toast(/duplicate|unique/i.test(error.message) ? "Já existe um responsável com esse nome." : "Erro: " + error.message, true);
    $("resp-nome").value = ""; $("resp-area").value = "";
    await carregarResponsaveis(); desenharResponsaveis(); montarOpcoes();
  });
  $("lista-resp").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-tirar-resp]"); if (!b) return;
    if (!confirm("Remover esse responsável? Os micro status dele voltam para \"Pendente de responsável\".")) return;
    const { error } = await sb.from("pessoas_responsaveis").delete().eq("id", Number(b.dataset.tirarResp));
    if (error) return toast("Erro: " + error.message, true);
    await carregarResponsaveis(); desenharResponsaveis(); montarOpcoes(); redesenhar(true);
  });

  // ---------------- consulta SAC ----------------
  // O SAC recebe só as colunas liberadas (função consultar_sac do banco).
  // A Logística vê a mesma consulta montada com os dados que já carregou.
  let sacLinhas = [], sacFiltrados = [], sacPagina = 1, sacCarregadoEm = 0, sacVisao = "todos";

  async function carregarSac() {
    $("sac-info").textContent = "Carregando…";
    let lista = [];
    try {
      for (let de = 0; ; de += 1000) {
        const { data, error } = await sb.rpc("consultar_sac").range(de, de + 999);
        if (error) throw error;
        lista = lista.concat(data);
        if (data.length < 1000) break;
      }
    } catch (err) {
      $("sac-info").textContent = "";
      toast("Erro ao carregar: " + err.message, true);
      return;
    }
    sacCarregadoEm = Date.now();
    montarSac(lista);
  }
  setInterval(() => { if (perfil === "sac" && !document.hidden && Date.now() - sacCarregadoEm > 5 * 60000) carregarSac(); }, 60000);

  function desenharSacLogistica() {
    montarSac(base.map((p) => {
      const t = trat.get(p.pedido) || {};
      return { pedido: p.pedido, nf: p.nf, canal: p.canal, transportadora: p.transportadora, micro_status: p.micro_status,
        prometido: p.prev_original || p.prev_atual, nova_data: t.nova_data, observacao: t.observacao,
        atualizado_em: t.atualizado_em, link_rastreio: p.link_rastreio };
    }));
    carregarLoginsSac();
  }

  // SAC vê só os vencidos, os que vencem hoje e os que vencem amanhã
  const limiteSac = () => { const d = new Date(Date.parse(hojeISO()) + DIA); return d.toISOString().slice(0, 10); };
  function montarSac(lista) {
    const lim = limiteSac();
    lista = lista.filter((l) => (l.prometido && String(l.prometido).slice(0, 10) <= lim) || (l.nova_data && String(l.nova_data).slice(0, 10) <= lim));
    sacLinhas = lista;
    $("sac-info").textContent = `${fmt(lista.length)} pedidos vencidos ou que vencem hoje ou amanhã · atualizado às ${new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
    const preencher = (id, valores, rotulo) => {
      const sel = $(id), atual = sel.value;
      const unicos = [...new Set(valores.filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));
      sel.innerHTML = `<option value="">${rotulo}</option>` + unicos.map((v) => `<option>${esc(v)}</option>`).join("");
      if (unicos.includes(atual)) sel.value = atual;
    };
    preencher("sac-canal", lista.map((l) => l.canal), "Todos");
    preencher("sac-transp", lista.map((l) => l.transportadora), "Todas");
    filtrarSac(true);
  }

  function filtrarSac(manter) {
    const busca = norm($("sac-busca").value).replace(/\s/g, "");
    const canal = $("sac-canal").value, transp = $("sac-transp").value, nova = $("sac-nova").value;
    const hoje = hojeISO(), amanha = limiteSac();
    const dia = (l) => String(l.nova_data || l.prometido || "").slice(0, 10);   // nova data vale como vencimento
    const naSv = { todos: () => true, vencidos: (l) => dia(l) < hoje, hoje: (l) => dia(l) === hoje, amanha: (l) => dia(l) === amanha };
    const passa = (l) =>
      (!busca || [l.nf, l.pedido].some((v) => norm(v).replace(/\s/g, "").includes(busca))) &&
      (!canal || l.canal === canal) && (!transp || l.transportadora === transp) &&
      (!nova || (nova === "com" && l.nova_data) || (nova === "sem" && !l.nova_data) || (nova === "obs" && l.observacao));
    const base1 = sacLinhas.filter(passa);
    document.querySelectorAll("#sac-visoes .visao-sac").forEach((b) => {
      b.classList.toggle("ativa", b.dataset.sv === sacVisao);
      b.querySelector(".kpi-num").textContent = fmt(base1.filter(naSv[b.dataset.sv]).length);
    });
    sacFiltrados = base1.filter(naSv[sacVisao]);
    sacFiltrados.sort((a, b) => String(a.prometido || "9999").localeCompare(String(b.prometido || "9999")));
    if (!manter) sacPagina = 1;
    desenharSac();
  }

  function chipData(d) {
    if (!d) return "";
    const n = diasEntre(hojeISO(), d);
    return n < 0 ? `<span class="chip vermelho">vencido há ${-n} d</span>` : n === 0 ? `<span class="chip ambar">hoje</span>` : `<span class="chip ${n <= 5 ? "ambar" : "verde"}">em ${n} d</span>`;
  }

  function desenharSac() {
    const total = sacFiltrados.length, paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
    sacPagina = Math.min(sacPagina, paginas);
    $("sac-linhas").innerHTML = sacFiltrados.slice((sacPagina - 1) * POR_PAGINA, sacPagina * POR_PAGINA).map((l) => `<tr>
        <td><b>${esc(l.nf || "—")}</b></td><td>${esc(l.pedido)}</td><td>${esc(l.canal || "")}</td><td>${esc(l.transportadora || "—")}</td>
        <td><span class="ms">${esc(l.micro_status || "—")}</span></td>
        <td>${br(l.prometido) || "—"}<div>${chipData(l.prometido)}</div></td>
        <td>${l.nova_data ? `<b>${br(l.nova_data)}</b><div>${chipData(l.nova_data)}</div>` : `<span class="s">—</span>`}</td>
        <td class="col-obs">${l.observacao ? esc(l.observacao) : `<span class="s">—</span>`}${l.observacao && l.atualizado_em ? `<div class="s">${new Date(l.atualizado_em).toLocaleDateString("pt-BR")}</div>` : ""}</td>
        <td>${/^https?:\/\//i.test(l.link_rastreio || "") ? `<a href="${esc(l.link_rastreio)}" target="_blank" rel="noopener noreferrer">Rastreio ↗</a>` : ""}</td>
      </tr>`).join("");
    $("sac-vazio").hidden = total > 0;
    $("sac-paginacao").innerHTML = total > POR_PAGINA
      ? `<button class="btn" data-p="-1" ${sacPagina === 1 ? "disabled" : ""}>‹ Anterior</button><span>Página ${sacPagina} de ${paginas} · ${fmt(total)} pedidos</span>
         <button class="btn" data-p="1" ${sacPagina === paginas ? "disabled" : ""}>Próxima ›</button>` : "";
  }

  let esperaSac; $("sac-busca").addEventListener("input", () => { clearTimeout(esperaSac); esperaSac = setTimeout(() => filtrarSac(), 250); });
  $("sac-visoes").addEventListener("click", (e) => {
    const b = e.target.closest(".visao-sac"); if (!b) return;
    sacVisao = b.dataset.sv; filtrarSac();
  });
  ["sac-canal", "sac-transp", "sac-nova"].forEach((id) => $(id).addEventListener("change", () => filtrarSac()));
  $("sac-paginacao").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-p]"); if (!b) return;
    sacPagina += Number(b.dataset.p); desenharSac(); $("pagina-sac").scrollIntoView({ block: "start" });
  });
  $("sac-baixar").addEventListener("click", () => {
    const linhas = [["Nota fiscal", "Pedido", "Canal", "Transportadora", "Micro status", "Prometido ao cliente", "Nova data", "Observação da Logística", "Rastreio"]]
      .concat(sacFiltrados.map((l) => [l.nf, l.pedido, l.canal, l.transportadora, l.micro_status, br(l.prometido), br(l.nova_data), l.observacao || "", l.link_rastreio || ""]));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(linhas), "Consulta");
    XLSX.writeFile(wb, `consulta_sac_${sacVisao}_${hojeISO()}.xlsx`);
  });

  // lista de logins do SAC (só a Logística mexe)
  async function carregarLoginsSac() {
    const { data, error } = await sb.from("logins_sac").select("email").order("email");
    if (error) { $("lista-sac").innerHTML = `<p class="s">Para usar a lista de logins do SAC, rode de novo o supabase/schema.sql no Supabase.</p>`; return; }
    $("lista-sac").innerHTML = data.length
      ? data.map((x) => `<span>${esc(x.email)}<button type="button" data-tirar="${esc(x.email)}" title="Tirar da lista">×</button></span>`).join("")
      : `<p class="s">Nenhum login do SAC ainda.</p>`;
  }
  $("form-sac").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("sac-email").value.trim().toLowerCase(); if (!email) return;
    const { error } = await sb.from("logins_sac").upsert({ email, incluido_por: $("usuario").textContent }, { onConflict: "email" });
    if (error) return toast("Não foi possível adicionar: " + error.message, true);
    $("sac-email").value = ""; toast(`${email} agora entra vendo só a Consulta SAC.`); carregarLoginsSac();
  });
  $("lista-sac").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-tirar]"); if (!b) return;
    if (!confirm(`Tirar ${b.dataset.tirar} da lista do SAC? Esse login passa a ver o painel inteiro.`)) return;
    const { error } = await sb.from("logins_sac").delete().eq("email", b.dataset.tirar);
    if (error) return toast("Erro: " + error.message, true);
    carregarLoginsSac();
  });
})();
