// Painel Preventivo da Logística
// - login por e-mail e senha (Supabase)
// - a Logística envia a planilha exportada (aba Export) e ela vira a base de todos
// - cada pedido tem tratativa, nova data e observação, salvas na hora para todos
(function () {
  const CFG = window.PAINEL_CONFIG;
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n) => Number(n || 0).toLocaleString("pt-BR");
  const norm = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
  const br = (iso) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "");
  const DIA = 86400000;

  const SITUACOES = ["Cobrado da transportadora", "Aguardando retorno da transportadora", "Acionado SAC",
    "Nova data informada", "Reentrega / reagendamento", "Resolvido"];
  const POR_PAGINA = 50;

  let usuarioId = null;
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
    { id: "hoje", nome: "Vence hoje", de: 0, ate: 0 }, { id: "1", nome: "Vence ≥ 1 dia", de: 1, ate: 1 },
    { id: "2", nome: "Vence ≥ 2 dias", de: 2, ate: 4 }, { id: "5", nome: "Vence ≥ 5 dias", de: 5, ate: 9 },
    { id: "10", nome: "Vence ≥ 10 dias", de: 10, ate: 19 }, { id: "20", nome: "Vence ≥ 20 dias", de: 20, ate: 29 },
    { id: "30", nome: "Vence ≥ 30 dias", de: 30, ate: Infinity },
  ];
  const faixa = (d) => (d === null || d < 0 ? null : RANGES.find((r) => d >= r.de && d <= r.ate).id);
  let filtrados = [];
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
      $("tela-painel").hidden = false;
      setTimeout(carregar, 0);
      ligarTempoReal();
    } else {
      usuarioId = null;
      $("tela-painel").hidden = true;
      $("tela-login").hidden = false;
    }
  });

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
    } catch (err) {
      $("info-base").textContent = "";
      toast(/base_|tratativas|fechados|schema cache/.test(err.message)
        ? "O banco ainda não foi preparado: rode o arquivo supabase/schema.sql no Supabase."
        : "Erro ao carregar: " + err.message, true);
      return;
    }
    $("info-base").textContent = info
      ? `Base: ${info.arquivo || "planilha"} · ${fmt(base.length)} pedidos · enviada em ${new Date(info.enviado_em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}${info.enviado_por ? " por " + info.enviado_por : ""}`
      : "Ainda não há base. Clique em \"Enviar base\" e escolha o arquivo exportado.";
    $("info-intelipost").textContent = infoFech
      ? `Intelipost: ${infoFech.arquivo || "arquivo"} de ${new Date(infoFech.enviado_em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })} · ${fmt(ocultos)} pedido${ocultos === 1 ? "" : "s"} da base já entregue${ocultos === 1 ? "" : "s"} ou cancelado${ocultos === 1 ? "" : "s"} fora${ocultos === 1 ? "" : "m"} tirado${ocultos === 1 ? "" : "s"} do painel.`
      : "Envie o arquivo da Intelipost (\"Enviar Intelipost\") para tirar do painel os pedidos entregues e cancelados.";
    montarOpcoes();
    redesenhar();
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
    if (el && el.closest && el.closest("#linhas")) { redesenhar._pendente = true; return; }
    redesenhar(true);
  }

  // ---------------- cálculo ----------------
  function preparar(p) {
    const t = trat.get(p.pedido);
    const hoje = hojeISO();
    const venc = p.prev_original || p.prev_atual || null;   // data prometida ao cliente
    p._venc = venc;
    p._dias = venc ? diasEntre(hoje, venc) : null;                 // >0 faltam dias, <0 vencido
    p._parado = p.ultima_atualizacao ? Math.max(0, Math.floor((Date.now() - Date.parse(p.ultima_atualizacao)) / DIA)) : null;
    p._t = t;
    p._faixa = faixa(p._dias);
    return p;
  }
  const naVisao = {
    vencem: (p) => p._dias !== null && p._dias >= 0 && p._dias <= 5,
    parados: (p) => p._parado !== null && p._parado > DIAS_PARADO,
    vencidos: (p) => p._dias !== null && p._dias < 0,
    todos: () => true,
  };

  // ---------------- desenho ----------------
  function montarOpcoes() {
    const preencher = (id, valores, todos) => {
      const sel = $(id), atual = sel.value;
      sel.innerHTML = `<option value="">${todos}</option>` + valores.map((v) => `<option value="${esc(v[0])}">${esc(v[1])}</option>`).join("");
      if (valores.some((v) => v[0] === atual)) sel.value = atual;
    };
    const unicos = (f) => [...new Set(base.map(f).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR")).map((v) => [v, v]);
    preencher("f-transp", unicos((p) => p.transportadora), "Todas");
    preencher("f-canal", unicos((p) => p.canal), "Todos");
    preencher("f-ms", unicos((p) => p.micro_status), "Todos");
    preencher("f-trat", [["__sem", "Sem tratativa"], ["__com", "Com tratativa"]].concat(SITUACOES.map((s) => [s, s])), "Todas");
  }

  function redesenhar(manterPagina) {
    base.forEach(preparar);
    // contadores das visões
    document.querySelectorAll(".visao").forEach((b) => {
      b.classList.toggle("ativa", b.dataset.visao === visao);
      b.querySelector("span").textContent = `(${fmt(base.filter(naVisao[b.dataset.visao]).length)})`;
    });
    const daVisao = base.filter(naVisao[visao]);

    // tabela por micro status
    const grupos = new Map();
    daVisao.forEach((p) => {
      const k = p.micro_status || "(sem micro status)";
      const g = grupos.get(k) || { n: 0, soma: 0, cont: 0, trat: 0 };
      g.n++; if (p._parado !== null) { g.soma += p._parado; g.cont++; } if (p._t && p._t.situacao) g.trat++;
      grupos.set(k, g);
    });
    const ord = [...grupos.entries()].sort((a, b) => b[1].n - a[1].n);
    const somaP = daVisao.reduce((s, p) => s + (p._parado || 0), 0);
    const nomes = { vencem: "vencem nos próximos 5 dias", parados: `parados há mais de ${DIAS_PARADO} dias`, vencidos: "já vencidos", todos: "em aberto" };
    $("ms-resumo").textContent = `${fmt(daVisao.length)} pedidos ${nomes[visao]} · em média ${(daVisao.length ? somaP / daVisao.length : 0).toFixed(1).replace(".", ",")} dias sem movimento no rastreio · clique para ver e exportar.`;
    if (msSel && !grupos.has(msSel)) msSel = "";
    $("ms-linhas").innerHTML = ord.length ? ord.map(([k, g]) => {
      const media = g.cont ? g.soma / g.cont : 0;
      return `<tr data-ms="${esc(k)}" class="${k === msSel ? "sel" : ""}"><td>${esc(k)}</td><td class="num">${fmt(g.n)}</td>
        <td class="num ${media >= 10 ? "alto" : ""}">${media.toFixed(1).replace(".", ",")}</td><td class="num">${fmt(g.trat)}</td></tr>`;
    }).join("") : `<tr><td colspan="4" class="vazio">Nenhum pedido nesta visão.</td></tr>`;

    desenharRange();
    filtrar(manterPagina, daVisao);
  }

  function desenharRange() {
    const linhas = new Map(), tot = {};
    base.forEach((p) => {
      if (!p._faixa) return;
      const k = p.micro_status || "(sem micro status)";
      const l = linhas.get(k) || { total: 0 };
      l[p._faixa] = (l[p._faixa] || 0) + 1; l.total++;
      tot[p._faixa] = (tot[p._faixa] || 0) + 1; tot.total = (tot.total || 0) + 1;
      linhas.set(k, l);
    });
    const cel = (ms, id, n) => n
      ? `<td class="num clic ${visao === "todos" && rangeSel === id && msSel === ms ? "sel" : ""}" data-ms="${esc(ms)}" data-faixa="${id}">${fmt(n)}</td>`
      : `<td class="num vazio-c">·</td>`;
    $("range-linhas").innerHTML = [...linhas.entries()].sort((a, b) => b[1].total - a[1].total).map(([ms, l]) =>
      `<tr><td>${esc(ms)}</td>${RANGES.map((r) => cel(ms, r.id, l[r.id])).join("")}<td class="num tot clic" data-ms="${esc(ms)}" data-faixa="">${fmt(l.total)}</td></tr>`).join("")
      || `<tr><td colspan="9" class="vazio">Sem pedidos a vencer.</td></tr>`;
    $("range-total").innerHTML = `<tr><td>Total geral</td>${RANGES.map((r) => `<td class="num clic" data-ms="" data-faixa="${r.id}">${fmt(tot[r.id] || 0)}</td>`).join("")}<td class="num clic" data-ms="" data-faixa="">${fmt(tot.total || 0)}</td></tr>`;
  }

  function filtrar(manterPagina, daVisao) {
    daVisao = daVisao || base.filter(naVisao[visao]);
    const busca = norm($("f-busca").value);
    const tp = $("f-transp").value, cn = $("f-canal").value, ms = $("f-ms").value || msSel, tr = $("f-trat").value;
    filtrados = daVisao.filter((p) => {
      if (busca && !norm(p.pedido).includes(busca) && !norm(p.nf).includes(busca)) return false;
      if (tp && p.transportadora !== tp) return false;
      if (cn && p.canal !== cn) return false;
      if (ms && (p.micro_status || "(sem micro status)") !== ms) return false;
      if (rangeSel === "__avencer" ? !p._faixa : rangeSel && p._faixa !== rangeSel) return false;
      const s = p._t && p._t.situacao;
      if (tr === "__sem" && s) return false;
      if (tr === "__com" && !s) return false;
      if (tr && !tr.startsWith("__") && s !== tr) return false;
      return true;
    });
    // ordem: mais urgente primeiro (vencido/vence antes), depois mais parado
    filtrados.sort((a, b) => (a._dias ?? 9999) - (b._dias ?? 9999) || (b._parado || 0) - (a._parado || 0));
    const nomes = { vencem: "Vencem em 5 dias", parados: "Parados no rastreio", vencidos: "Já vencidos", todos: "Todos os pedidos" };
    const rNome = rangeSel === "__avencer" ? " · a vencer" : rangeSel ? " · " + RANGES.find((r) => r.id === rangeSel).nome : "";
    $("lista-titulo").textContent = `${nomes[visao]}${ms ? " · " + ms : ""}${rNome} (${fmt(filtrados.length)})`;
    if (!manterPagina) pagina = 1;
    desenharLista();
  }

  function chipPrazo(p) {
    if (p._dias === null) return `<span class="chip cinza">sem previsão</span>`;
    if (p._dias < 0) return `<span class="chip vermelho">vencido há ${-p._dias} d</span>`;
    if (p._dias === 0) return `<span class="chip ambar">vence hoje</span>`;
    return `<span class="chip ${p._dias <= 5 ? "ambar" : "verde"}">vence em ${p._dias} d</span>`;
  }

  function desenharLista() {
    const total = filtrados.length, paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
    pagina = Math.min(pagina, paginas);
    const fatia = filtrados.slice((pagina - 1) * POR_PAGINA, pagina * POR_PAGINA);
    $("linhas").innerHTML = fatia.map((p) => {
      const t = p._t || {};
      const quem = t.atualizado_por ? `${esc(t.atualizado_por.split("@")[0])} · ${new Date(t.atualizado_em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}` : "";
      return `<tr data-pedido="${esc(p.pedido)}" class="${t.situacao ? "editado" : ""}">
        <td><div class="p">${esc(p.pedido)}</div><div class="s">NF ${esc(p.nf || "—")} · ${esc(p.canal || "")}</div>
          ${p.qtd_tickets ? `<div class="s">🎫 ${p.qtd_tickets} ticket${p.qtd_tickets > 1 ? "s" : ""} SAC${p.motivo_ticket ? " · " + esc(p.motivo_ticket) : ""}</div>` : ""}</td>
        <td>${esc(p.transportadora || "—")}<div class="s">${esc([p.cidade, p.uf].filter(Boolean).join(" / "))}</div></td>
        <td><span class="ms">${esc(p.micro_status || "—")}</span><div class="s">${p._parado !== null ? `${p._parado} dia${p._parado === 1 ? "" : "s"} sem movimento` : ""}</div></td>
        <td>${br(p._venc) || "—"}<div>${chipPrazo(p)}</div>${p.prev_atual && p.prev_atual !== p._venc ? `<div class="s">Intelipost atual ${br(p.prev_atual)}</div>` : ""}</td>
        <td><select data-campo="situacao"><option value="">— sem tratativa —</option>${SITUACOES.map((s) => `<option ${s === t.situacao ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>
          <div class="s quem">${quem}</div></td>
        <td><input type="date" data-campo="nova_data" value="${esc(t.nova_data || "")}"></td>
        <td class="col-obs"><input data-campo="observacao" value="${esc(t.observacao || "")}" placeholder="O que foi feito…" maxlength="500">
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
    visao = b.dataset.visao; msSel = ""; rangeSel = ""; $("f-ms").value = ""; redesenhar();
  });
  $("ms-linhas").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-ms]"); if (!tr) return;
    msSel = msSel === tr.dataset.ms ? "" : tr.dataset.ms; rangeSel = ""; $("f-ms").value = "";
    document.querySelectorAll("#ms-linhas tr").forEach((r) => r.classList.toggle("sel", r.dataset.ms === msSel));
    filtrar();
    if (msSel) $("lista-titulo").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  // clique na tabela de range: abre os pedidos daquela linha/coluna
  document.querySelector(".tabela-range").addEventListener("click", (e) => {
    const td = e.target.closest("td.clic"); if (!td) return;
    const ms = td.dataset.ms, fx = td.dataset.faixa || "__avencer";
    if (msSel === ms && rangeSel === fx && visao === "todos") { msSel = ""; rangeSel = ""; } else { msSel = ms; rangeSel = fx; }
    visao = "todos"; $("f-ms").value = "";
    redesenhar(); $("lista-titulo").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  ["f-transp", "f-canal", "f-trat"].forEach((id) => $(id).addEventListener("change", () => filtrar()));
  $("f-ms").addEventListener("change", () => { msSel = ""; rangeSel = ""; redesenhar(); });
  let espera; $("f-busca").addEventListener("input", () => { clearTimeout(espera); espera = setTimeout(() => filtrar(), 200); });
  $("paginacao").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-p]"); if (!b) return;
    pagina += Number(b.dataset.p); desenharLista(); $("lista-titulo").scrollIntoView({ block: "start" });
  });

  // salvar tratativa (na hora)
  async function salvar(el) {
    const tr = el.closest("tr[data-pedido]"); const ped = tr.dataset.pedido;
    const atual = trat.get(ped) || {};
    const novo = { pedido: ped, situacao: atual.situacao || null, nova_data: atual.nova_data || null, observacao: atual.observacao || null };
    novo[el.dataset.campo] = el.value.trim() || null;
    if (el.dataset.campo === "nova_data" && novo.nova_data && !novo.situacao) {
      novo.situacao = "Nova data informada";
      tr.querySelector('[data-campo="situacao"]').value = novo.situacao;
    }
    if ((atual[el.dataset.campo] || null) === novo[el.dataset.campo] && novo.situacao === (atual.situacao || null)) return;
    const quem = tr.querySelector(".quem"); quem.textContent = "salvando…";
    const { data, error } = await sb.from("tratativas").upsert(novo).select().single();
    if (error) { quem.textContent = ""; toast("Não salvou: " + error.message, true); return; }
    trat.set(ped, data);
    tr.classList.toggle("editado", !!data.situacao);
    quem.innerHTML = `<span class="salvo">✓ salvo</span> ${esc(data.atualizado_por ? data.atualizado_por.split("@")[0] : "")}`;
    if (el.dataset.campo === "nova_data") { preparar(base.find((p) => p.pedido === ped)); }
  }
  $("linhas").addEventListener("change", (e) => { if (e.target.dataset.campo) salvar(e.target); });
  $("linhas").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.dataset.campo === "observacao") e.target.blur(); });
  $("linhas").addEventListener("focusout", () => {
    setTimeout(() => {
      if (redesenhar._pendente && !(document.activeElement && document.activeElement.closest("#linhas"))) { redesenhar._pendente = false; redesenhar(true); }
    }, 300);
  });

  // exportar o que está na lista
  $("btn-exportar").addEventListener("click", () => {
    const cab = ["Pedido Intelipost", "NF", "Canal", "Transportadora", "Cidade", "UF", "Micro status", "Dias sem movimento", "Prometido ao cliente",
      "Previsão Intelipost atual", "Dias para vencer", "Tratativa", "Nova data", "Observação", "Atualizado por", "Atualizado em", "Comentário 360", "Tickets SAC", "Rastreio"];
    const linhas = filtrados.map((p) => { const t = p._t || {}; return [p.pedido, p.nf, p.canal, p.transportadora, p.cidade, p.uf, p.micro_status, p._parado,
      br(p.prev_original), br(p.prev_atual), p._dias, t.situacao, br(t.nova_data), t.observacao, t.atualizado_por,
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
    if (!confirm(`${arq.name}\n\n${fmt(linhas.length)} pedidos encontrados.\n\nEssa planilha vai substituir a base atual para todos.\nAs tratativas já feitas continuam salvas.\n\nEnviar?`)) return;
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
        const w = new Worker("leitor-intelipost.js?v=4");
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
})();
