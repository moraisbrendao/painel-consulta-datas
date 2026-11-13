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

  // ---------------- login e troca de senha ----------------
  // As contas são criadas pela Logística no Supabase. Quem esquece a senha recebe uma provisória
  // (página Logins) e troca por uma dela no primeiro acesso (user_metadata.trocar_senha).
  const TXT_LOGIN = {
    entrar: ["E-loggia", "Entre com seu e-mail e senha.", "Senha", "Entrar"],
    nova: ["Crie sua senha", "Digite uma senha nova, só sua (mínimo 6 caracteres).", "Senha nova", "Salvar senha"],
  };
  function modoLogin(m, voluntario) {
    const f = $("form-login"); f.dataset.modo = m;
    if (voluntario) f.dataset.voluntario = "1"; else delete f.dataset.voluntario;
    const [t, sub, rot, btn] = TXT_LOGIN[m];
    $("login-titulo").textContent = voluntario ? "Trocar senha" : t; $("login-sub").textContent = sub; $("rot-senha").textContent = rot; $("btn-entrar").textContent = btn;
    $("senha").autocomplete = m === "entrar" ? "current-password" : "new-password";
    $("erro-login").textContent = ""; $("ok-login").hidden = true;
    $("senha").value = ""; $("senha2").value = "";
  }
  function okLogin(msg) { $("ok-login").textContent = msg; $("ok-login").hidden = false; }
  $("lk-esqueci").addEventListener("click", () => okLogin("Peça para a Logística gerar uma senha provisória para você (página Logins do painel). No primeiro acesso você cria uma senha sua."));
  $("lk-cancelar").addEventListener("click", () => { modoLogin("entrar"); $("tela-login").hidden = true; $("tela-painel").hidden = false; });
  $("btn-trocar-senha").addEventListener("click", () => { modoLogin("nova", true); $("tela-painel").hidden = true; $("tela-login").hidden = false; $("senha").focus(); });
  function erroAuth(error) {
    const m = String(error.message || "");
    if (/invalid login/i.test(m)) return "E-mail ou senha incorretos.";
    if (/not confirmed/i.test(m)) return "Esse login ainda não foi confirmado no Supabase (Auto Confirm User).";
    if (/rate limit|too many|security purposes/i.test(m)) return "Muitas tentativas seguidas. Espere alguns minutos e tente de novo.";
    if (/at least|weak|password should/i.test(m)) return "Senha fraca: use pelo menos 6 caracteres.";
    if (/same.*password|different from the old/i.test(m)) return "A senha nova precisa ser diferente da atual.";
    return "Não deu certo: " + m;
  }

  $("form-login").addEventListener("submit", async (e) => {
    e.preventDefault();
    const modo = $("form-login").dataset.modo, voluntario = !!$("form-login").dataset.voluntario;
    const email = $("email").value.trim().toLowerCase(), senha = $("senha").value;
    $("erro-login").textContent = ""; $("ok-login").hidden = true;
    const falha = (t) => ($("erro-login").textContent = t);
    if (modo === "entrar" && !/^\S+@\S+\.\S+$/.test(email)) return falha("Digite um e-mail válido.");
    if (senha.length < 6) return falha("A senha precisa ter pelo menos 6 caracteres.");
    if (modo === "nova" && senha !== $("senha2").value) return falha("As duas senhas não são iguais.");
    $("btn-entrar").disabled = true;
    let r;
    try {
      r = modo === "entrar" ? await sb.auth.signInWithPassword({ email, password: senha })
        : await sb.auth.updateUser({ password: senha, data: { trocar_senha: false } });
    } catch (err) { r = { error: err }; }
    $("btn-entrar").disabled = false;
    if (r.error) return falha(erroAuth(r.error));
    $("senha").value = ""; $("senha2").value = "";
    if (modo === "nova") {
      modoLogin("entrar");
      toast("Senha nova salva.");
      if (voluntario) { $("tela-login").hidden = true; $("tela-painel").hidden = false; }
      else { const { data } = await sb.auth.getSession(); if (data && data.session) abrirSessao(data.session); }
    }
  });
  $("btn-sair").addEventListener("click", () => sb.auth.signOut());

  function abrirSessao(sessao) {
    if (usuarioId === sessao.user.id) return;
    usuarioId = sessao.user.id;
    $("usuario").textContent = sessao.user.email;
    $("tela-login").hidden = true;
    setTimeout(entrar, 0);
  }
  sb.auth.onAuthStateChange((ev, sessao) => {
    const prov = sessao && sessao.user && sessao.user.user_metadata && sessao.user.user_metadata.trocar_senha;
    if (sessao && (prov || ev === "PASSWORD_RECOVERY")) {
      // senha provisória: pede a senha nova antes de abrir o painel
      $("tela-painel").hidden = true; $("tela-login").hidden = false;
      if ($("form-login").dataset.modo !== "nova") modoLogin("nova");
      return;
    }
    if (sessao) abrirSessao(sessao);
    else {
      usuarioId = null; perfil = "";
      delete document.body.dataset.perfil; delete document.body.dataset.admin;
      $("tela-painel").hidden = true;
      $("tela-login").hidden = false;
      if ($("form-login").dataset.modo === "nova") modoLogin("entrar");
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
    // página Logins: só para os administradores (tabela admins_painel)
    let adm = { data: false };
    try { adm = await sb.rpc("e_admin"); } catch (err) { adm = { data: false }; }
    if (adm && adm.data === true) document.body.dataset.admin = "1"; else delete document.body.dataset.admin;
    $("tela-painel").hidden = false;
    if (perfil === "sac") {
      irPara("sac");
      carregarSac();
    } else {
      irPara("gerencial");
      carregarGerencial();   // a Visão Gerencial não depende do resto: começa junto
      carregar();
      ligarTempoReal();
    }
  }

  // ---------------- carregar ----------------
  // busca a tabela inteira em páginas de 1.000, várias ao mesmo tempo (bem mais rápido que uma por vez)
  // busca uma página; se o banco demorar (timeout), tenta de novo uma vez
  async function buscarPagina(tabela, ordem, colunas, de, ate, contar) {
    for (let tentativa = 0; ; tentativa++) {
      const r = await sb.from(tabela).select(colunas, contar ? { count: "exact" } : undefined).order(ordem).range(de, ate);
      if (!r.error) return r;
      if (tentativa >= 1 || !/timeout/i.test(r.error.message || "")) throw r.error;
      await new Promise((ok) => setTimeout(ok, 1500));
    }
  }

  async function buscarTudo(tabela, ordem, colunas = "*") {
    const PAG = 1000, JUNTAS = 4;
    const prim = await buscarPagina(tabela, ordem, colunas, 0, PAG - 1, true);
    let lista = prim.data;
    if (lista.length < PAG) return lista;
    if (prim.count == null) {   // sem contagem: segue página por página
      for (let de = PAG; ; de += PAG) {
        const { data } = await buscarPagina(tabela, ordem, colunas, de, de + PAG - 1);
        lista = lista.concat(data); if (data.length < PAG) return lista;
      }
    }
    const total = prim.count;
    const inicios = []; for (let de = PAG; de < total; de += PAG) inicios.push(de);
    for (let i = 0; i < inicios.length; i += JUNTAS) {
      const partes = await Promise.all(inicios.slice(i, i + JUNTAS).map((de) => buscarPagina(tabela, ordem, colunas, de, de + PAG - 1)));
      for (const r of partes) lista = lista.concat(r.data);
    }
    return lista;
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
      await Promise.all([carregarOcorrencias(), carregarResponsaveis(), carregarFila(), carregarTickets(), carregarSSW()]);
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
    if (G_PAGINAS.includes(paginaAtual)) montarGerencial();
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
  // se alguém enviou uma base nova (em outro computador), a Visão Gerencial relê sozinha
  setInterval(async () => {
    if (!usuarioId || document.hidden || perfil === "sac" || gCarregando || !gDados) return;
    const { data } = await sb.from("base_info").select("enviado_em").limit(1);
    const em = data && data[0] ? data[0].enviado_em : null;
    if (em && em !== gBaseEm) { carregar(); carregarGerencial(true); }
  }, 120000);
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
    ssw: (p) => !!(p._t && p._t.nova_data && p._t.nova_data_fonte === "ssw"),
    todos: () => true,
  };  const filtroVisao = (v) => { const ks = v.split("+"); return (p) => ks.some((k) => naVisao[k](p)); };
  const NOMES_VISAO = { vencem: "Vencem em até 5 dias", parados: "Parados no rastreio", vencidos: "Já vencidos", hoje: "Vencem hoje", amanha: "Vencem amanhã", ssw: "Nova data do SSW", todos: "Pedidos em aberto" };
  const nomeVisao = () => visao.split("+").map((k) => NOMES_VISAO[k]).join(" + ");


  // ---------------- filtros do topo (valem para tudo; vários itens por filtro) ----------------
  const FILTROS = {
    transp: (p) => p.transportadora || "(sem transportadora)",
    canal: (p) => p.canal || "(sem canal)",
    ms: (p) => p.micro_status || "(sem micro status)",
    resp: (p) => { const r = respDe(p.micro_status); return r ? r.nome : PENDENTE; },
    tk: (p) => { if (!ticketsInfo) return "(planilha de tickets não enviada)"; const t = ticketDe(p); return t ? t.fila || "(ticket sem fila)" : "Sem ticket"; },
    obs: (p) => (p._t && p._t.observacao ? "Com observação" : "Sem observação"),
    ssw: (p) => sswClasse(p),
  };
  // ---- conferência SSW (robô lê a previsão da transportadora no rastreio do SSW) ----
  let ssw = new Map();
  async function carregarSSW() { try { ssw = new Map((await buscarTudo("previsao_ssw", "pedido")).map((x) => [x.pedido, x])); } catch (_) { ssw = new Map(); } }
  // transportadoras que não usam SSW (regra da Brenda); nas outras, "Informação não disponível" = CT-e ainda não emitido
  const FORA_SSW = /formato|transiga/i;   // Jadlog, Bento Brasil e Trânsito Brasil: o robô consulta no sistema delas
  // transportadora fora do SSW: ignora qualquer resultado antigo do SSW (era da transportadora de first mile)
  const sitSSW = (sit, transp) => FORA_SSW.test(transp || "") ? (sit === "sem nf" || sit === "pendente" ? sit : "fora do ssw") : sit === "fora do ssw" ? "sem cte" : sit;
  function sswClasse(p) {
    const x = ssw.get(p.pedido);
    if (FORA_SSW.test(p.transportadora || "")) return "Transportadora fora do SSW";
    if (!x) return "Ainda não consultado";
    if (x.situacao === "entregue") return "Entregue no SSW";
    const venc = p._venc || p.prev_original || p.prev_atual;
    if (x.previsao) return venc && x.previsao > String(venc).slice(0, 10) ? "SSW depois da prometida" : "SSW dentro do prometido";
    if (FORA_SSW.test(p.transportadora || "")) return "Transportadora fora do SSW";
    if (/fora do ssw|sem cte|sem permissao/.test(x.situacao)) return "Sem CT-e no SSW ainda";
    return "No SSW sem previsão";
  }
  function sswLinha(p) {
    const x = ssw.get(p.pedido); if (!x || FORA_SSW.test(p.transportadora || "")) return "";
    const quando = `consultado em ${new Date(x.consultado_em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}`;
    if (x.situacao === "entregue") return `<div class="s ssw verde" title="${quando}">SSW: entregue${x.previsao ? " · prev. " + br(x.previsao) : ""}</div>`;
    if (!x.previsao) return x.situacao === "sem previsao" ? `<div class="s ssw" title="${quando}">SSW: sem previsão</div>` : "";
    const dif = p._venc ? diasEntre(p._venc, x.previsao) : 0;
    return `<div class="s ssw ${dif > 0 ? "vermelho" : "verde"}" title="Previsão da transportadora no SSW · ${quando}">SSW ${br(x.previsao)}${dif > 0 ? ` · ${dif} dia${dif === 1 ? "" : "s"} depois` : ""}</div>`;
  }
  const sel = { transp: new Set(), canal: new Set(), ms: new Set(), resp: new Set(), tk: new Set(), obs: new Set(), ssw: new Set() };
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
      b.classList.toggle("ativa", visao.split("+").includes(b.dataset.visao));
      const n = vistos.filter(naVisao[b.dataset.visao]).length;
      if (b.classList.contains("kpi")) b.querySelector(".kpi-num").textContent = fmt(n);
      else b.querySelector("span").textContent = `(${fmt(n)})`;
    });
    const daVisao = vistos.filter(filtroVisao(visao));
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
    $("ms-resumo").textContent = `${fmt(daVisao.length)} pedidos ${visao.split("+").map((k) => nomes[k]).join(" ou ")} · em média ${(daVisao.length ? somaP / daVisao.length : 0).toFixed(1).replace(".", ",")} dias sem movimento no rastreio · clique para ver e exportar.`;
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
    daVisao = buscando ? vistos : daVisao || vistos.filter(filtroVisao(visao));
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
    $("lista-titulo").textContent = `${buscando ? "Busca em todos os pedidos" : nomeVisao()}${ms ? " · " + ms : ""}${rNome} (${fmt(filtrados.length)})`;
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
        <td>${br(p._venc) || "—"}<div>${chipPrazo(p)}</div>${p.prev_atual && p.prev_atual !== p._venc ? `<div class="s">Intelipost atual ${br(p.prev_atual)}</div>` : ""}${sswLinha(p)}</td>
        <td><input type="date" data-campo="nova_data" value="${esc(t.nova_data || "")}">${t.nova_data_fonte === "ssw" ? `<div class="s" title="Gravada sozinha pela previsão do SSW (depois da prometida). Se mudar à mão, o robô não mexe mais.">🤖 data do SSW</div>` : ""}</td>
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
    // vários cards ao mesmo tempo: clique liga/desliga; "Pedidos em aberto" volta a mostrar tudo
    const k = b.dataset.visao, atuais = new Set(visao.split("+").filter((x) => x !== "todos"));
    if (k === "todos") atuais.clear(); else atuais.has(k) ? atuais.delete(k) : atuais.add(k);
    visao = atuais.size ? [...atuais].join("+") : "todos";
    msSel = ""; rangeSel = ""; redesenhar();
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
        ${item("Previsão 360", br(p.prev_360))}${item("Previsão SSW (transportadora)", (() => { const x = ssw.get(p.pedido); return x ? `${br(x.previsao) || "—"} <span class="s">${esc(sswClasse(p))}</span>` : "Ainda não consultado"; })())}${item("Expedição", br(p.data_expedicao))}
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
      "Previsão Intelipost atual", "Previsão SSW", "Conferência SSW", "Dias para vencer", "Nova data", "Observação", "Atualizado por", "Atualizado em", "Comentário 360", "Tickets SAC", "Rastreio"];
    const linhas = filtrados.map((p) => { const t = p._t || {}; return [p.pedido, p.nf, p.canal, p.transportadora, p.cidade, p.uf, p.micro_status, (respDe(p.micro_status) || { nome: PENDENTE }).nome, FILTROS.tk(p), p._parado,
      br(p.prev_original), br(p.prev_atual), br((ssw.get(p.pedido) || {}).previsao), sswClasse(p), p._dias, br(t.nova_data), t.observacao, t.atualizado_por,
      t.atualizado_em ? new Date(t.atualizado_em).toLocaleString("pt-BR") : "", p.comentario_360, p.qtd_tickets, p.link_rastreio]; });
    const ws = XLSX.utils.aoa_to_sheet([cab].concat(linhas));
    ws["!cols"] = cab.map((c, i) => ({ wch: [32, 12, 14, 20][i] || 16 }));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Pedidos");
    XLSX.writeFile(wb, `preventivo_${visao.replace(/\+/g, "-")}_${hojeISO()}.xlsx`);
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
    data_criacao: "DATA CRIACAO", data_entrega: "DATA DE ENTREGA", range_atrasos: "RANGE DE ATRASOS", dias_atraso: "DIAS DE ATRASO",
    status_prazo: "STATUS PRAZO INTELIPOST", sem_expedicao: "PEDIDO SEM EXPEDICAO",
  };
  const DATAS = new Set(["data_expedicao", "prev_original", "prev_atual", "prev_360", "data_criacao", "data_entrega"]);

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
          else if (k === "qtd_tickets" || k === "dias_atraso") o[k] = v == null || v === "" || isNaN(Number(v)) ? null : Math.round(Number(v));
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
    carregarGerencial(true);   // Visão Gerencial, Entregas e SLA e Atrasos por UF releem a base nova na hora
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
        const w = new Worker("leitor-intelipost.js?v=75");
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
  // insucesso na entrega achado pelo robô na Fila Aguardando entrega (nova NF de reposição): entra na fila do robô do portal
  let agOc = [];
  function alvoOc() {
    const naBase = new Set(base.map((p) => { const { nf, serie } = nfSerie(p); return nf + "-" + serie; }));
    const extra = agOc.filter((t) => { const { nf, serie } = nfSerie({ nf: t.nf_nova }); return nf && !naBase.has(nf + "-" + serie); })
      .map((t) => ({ nf: t.nf_nova, micro_status: t.insucesso, transportadora: t.transp_chat || String(t.transportadora || "").split(" / ")[0], _faixa: "ag", _ag: t.ticket }));
    return base.filter(precisaOc).concat(extra);
  }
  function ocCadastrada(p) { const { nf, serie } = nfSerie(p); return ocKeys.has(nf + "-" + serie) || ocSoNF.has(nf); }
  function marcaOc(p) {
    if (!precisaOc(p)) return "";
    return ocCadastrada(p) ? `<div class="tag-oc ok">✓ ocorrência cadastrada</div>` : `<div class="tag-oc pend">ocorrência a cadastrar</div>`;
  }

  async function carregarOcorrencias() {
    try {
      const [lista, inf] = await Promise.all([buscarTudo("ocorrencias_cadastradas", "nf"), sb.from("ocorrencias_info").select("*").limit(1)]);
      const ag = await sb.from("aguardando_entrega").select("ticket,nf_nova,insucesso,transp_chat,transportadora").eq("na_planilha", true).not("insucesso", "is", null).neq("situacao", "entregue");
      agOc = ag.error ? [] : ag.data;
      ocKeys = new Set(); ocSoNF = new Set();
      lista.forEach((o) => (o.serie ? ocKeys.add(semZero(o.nf) + "-" + semZero(o.serie)) : ocSoNF.add(semZero(o.nf))));
      ocInfo = inf.data && inf.data[0]; ocOk = true;
    } catch (_) { ocOk = false; }
  }

  function desenharOcorrencias() {
    desenharRobo();
    const alvo = alvoOc();
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
    "Petrymar": "Petrymar Transportes", "TRANSCAI TRANSPORTES": "Transcai", "Zelog Transportes": "Zelog Standard",
    "PROLOG TRANSPORTES E LOGISTICA LTDA": "PROLOG TRANSPORTES", "Rapido Alem Paraiba": "RÁPIDO ALÉM PARAÍBA", "Trans Sua Log": "Trans Sua Log - Standard" };   // VM: sempre a 1ª da lista (posicao 0)
  let fila = [], filaOk = true;

  function notasNaFila() {
    const s = new Set();
    fila.filter((f) => f.status === "pendente" || f.status === "processando")
      .forEach((f) => (f.grupos || []).forEach((g) => g.notas.forEach((n) => s.add(n.nf + "-" + n.serie))));
    return s;
  }
  function gruposParaRobo() {
    const naFila = notasNaFila(), mapa = new Map(), semMotivo = new Set();
    alvoOc().filter((p) => !ocCadastrada(p)).forEach((p) => {
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
    const ps = alvoOc().filter((p) => !ocCadastrada(p) && norm(p.micro_status) === norm(ms) && transpPortal(p.transportadora) === tp);
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
    const antes = alvoOc().filter((p) => !ocCadastrada(p)).length;
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
    const depois = alvoOc().filter((p) => !ocCadastrada(p)).length;
    toast(`Ocorrências atualizadas: ${fmt(antes - depois)} nota${antes - depois === 1 ? "" : "s"} saíram da lista "a cadastrar".`);
    desenharOcorrencias(); redesenhar(true);
  });

  // ---------------- visão gerencial ----------------
  // Fonte: a base ("Enviar base", aba Export), todos os pedidos dela. Data prometida = Data Original Estimada (senão a atual).
  // Atrasado = "Range de Atrasos" começando com "Vencido" (se a coluna existir).
  let gDados = null, gCarregando = false, gCard = "abertos", gSelecao = null, gLista = [], gPagina = 1, gTodos = false, gJanela = 14, gPtModo = "sit";
  const gSel = { canal: new Set(), uf: new Set(), transp: new Set(), serie: new Set(), origem: new Set(), status: new Set(), micro: new Set() };
  const G_CAMPOS = { canal: (r) => r.canal, uf: (r) => r.uf, transp: (r) => r.transp, serie: (r) => r.serie, origem: (r) => r.origem, status: (r) => r.status, micro: (r) => r.micro };
  const G_NOME = { abertos: "Pedidos em aberto", atrasados: "Atrasados (em aberto)", risco: "Em risco (vencendo)", parados: "Parados no rastreio", vencem: "Vencem em até 5 dias" };
  const SIT = [["ent_prazo", "Entregue no prazo", "#16a34a"], ["ent_atraso", "Entregue c/ atraso", "#dc2626"], ["ab_prazo", "Aberto no prazo", "#0ea5e9"],
    ["ab_risco", "Aberto em risco", "#f59e0b"], ["ab_atraso", "Aberto atrasado", "#b91c1c"], ["cancelado", "Cancelado", "#94a3b8"]];
  const FAIXAS = [["≥ 30 dias", (d) => d >= 30], ["≥ 20 dias", (d) => d >= 20 && d < 30], ["≥ 10 dias", (d) => d >= 10 && d < 20], ["≥ 5 dias", (d) => d >= 5 && d < 10],
    ["≥ 4 dias", (d) => d === 4], ["≥ 3 dias", (d) => d === 3], ["≥ 2 dias", (d) => d === 2], ["≥ 1 dia", (d) => d === 1]];
  // faixa: pelo "Range de Atrasos" da planilha (Vencido >= N dias), senão pelos dias de atraso
  const faixaDe = (r) => { const m = norm(r.range).match(/^VENCIDO\s*>=\s*(\d+)/); if (m) { const n = +m[1]; return FAIXAS.findIndex(([, f]) => f(n)); } return FAIXAS.findIndex(([, f]) => f(r._atraso)); };
  const G_DIM = { transp: ["transportadora", (r) => r.transp || "(sem transportadora)"], uf: ["UF", (r) => r.uf || "(sem UF)"], canal: ["canal", (r) => r.canal || "(sem canal)"], micro: ["micro status", (r) => r.micro || "(sem micro status)"] };
  try { const m = parseFloat(localStorage.getItem("painel.meta")); if (m) $("g-meta").value = m; } catch (_) {}
  const ddmm = (iso) => (iso ? iso.slice(8, 10) + "/" + iso.slice(5, 7) : "");
  const somaDias = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

  // lê só as colunas que a Visão Gerencial usa, em páginas paralelas (não depende de função nova no banco)
  const G_COLS = "pedido,nf,canal,uf,cidade,transportadora,status_intelipost,micro_status,origem,data_expedicao,prev_original,prev_atual,ultima_atualizacao";
  const G_COLS_NOVAS = ",data_criacao,data_entrega,range_atrasos,dias_atraso,status_prazo,sem_expedicao";
  let gGeracao = 0, gBaseEm = null;   // gBaseEm = data de envio da base que está na tela
  async function carregarGerencial(forcar) {
    if ((gCarregando && !forcar) || (gDados && gDados.length && !forcar)) return;
    const minha = ++gGeracao;   // uma carga mais nova descarta a antiga (não deixa a base velha "ganhar")
    gCarregando = true; $("g-info").textContent = $("e-info").textContent = $("u-info").textContent = "Carregando os pedidos da base…";
    try {
      let lista, semColunas = false;
      const inf = await sb.from("base_info").select("enviado_em").limit(1);
      const baseEm = inf.data && inf.data[0] ? inf.data[0].enviado_em : null;
      try { lista = await buscarTudo("base_pedidos", "pedido", G_COLS + G_COLS_NOVAS); }
      catch (e1) { if (!/column|coluna|does not exist/i.test(e1.message || "")) throw e1; semColunas = true; lista = await buscarTudo("base_pedidos", "pedido", G_COLS); }
      if (minha !== gGeracao) return;
      gAvisoColunas = semColunas; gBaseEm = baseEm;
      gDados = lista.map((b) => {
        const nf = String(b.nf || ""), m = nf.match(/^(.*?)-\s*(\w+)\s*$/);
        return { pedido: b.pedido, nf: m ? m[1] : nf, serie: m ? m[2].replace(/^0+(?=\d)/, "") : "", canal: b.canal, uf: b.uf, cidade: b.cidade || null, transp: b.transportadora,
          status: b.status_intelipost, micro: b.micro_status, origem: b.origem, criado: b.data_criacao || null, despacho: b.data_expedicao, entrega: b.data_entrega || null,
          prevOrig: b.prev_original, prev: b.prev_atual, ult: b.ultima_atualizacao ? String(b.ultima_atualizacao).slice(0, 10) : null,
          range: b.range_atrasos || null, diasAtr: b.dias_atraso ?? null, sprazo: b.status_prazo || null, semExp: b.sem_expedicao || null };
      });
    } catch (err) {
      if (minha !== gGeracao) return;
      gDados = null; gCarregando = false;
      $("g-info").textContent = $("e-info").textContent = $("u-info").textContent = "Não consegui carregar a base: " + (err.message || err) + ". Atualize a página para tentar de novo.";
      return;
    }
    gCarregando = false;
    montarGerencial();
  }
  let gAvisoColunas = false;
  function prepararG() {
    const hoje = hojeISO();
    gDados.forEach((r) => {
      const st = norm(r.status), rg = norm(r.range);
      r._prom = r.prevOrig || r.prev || null;
      r._fechado = st.startsWith("ENTREGUE") || st.startsWith("CANCELADO");
      r._d = r._prom ? diasEntre(hoje, r._prom) : null;           // >0 faltam dias, <0 atrasado
      // atrasado = range "Vencido" da planilha (se a coluna existir), senão pela data prometida
      const venc = rg ? rg.startsWith("VENCIDO") : r._d !== null && r._d < 0;
      r._atraso = !r._fechado && venc ? Math.max(1, r.diasAtr || (r._d !== null ? -r._d : 1)) : 0;
      r._parado = r.ult ? diasEntre(r.ult, hoje) : null;
      r._semExp = norm(r.semExp) === "SIM" || !r.despacho;
      if (st.startsWith("CANCELADO")) r._sit = "cancelado";
      else if (st.startsWith("ENTREGUE")) r._sit = norm(r.sprazo).includes("FORA DO PRAZO") || (r.entrega && r._prom && r.entrega > r._prom) ? "ent_atraso" : "ent_prazo";
      else r._sit = r._atraso ? "ab_atraso" : r._d === 0 || r._d === 1 ? "ab_risco" : "ab_prazo";
    });
  }
  const G_CARD = {
    abertos: (r) => !r._fechado,
    atrasados: (r) => r._atraso > 0,
    risco: (r) => !r._fechado && (r._d === 0 || r._d === 1),
    parados: (r) => !r._fechado && r._parado !== null && r._parado >= 5,
    vencem: (r) => !r._fechado && r._d !== null && r._d >= 0 && r._d <= 5,
  };

  // filtros com várias opções (mesmo visual dos filtros do Preventivo)
  function montarFiltrosG() {
    document.querySelectorAll("#g-filtros .multi").forEach((el) => {
      const k = el.dataset.g, cont = new Map();
      gDados.forEach((r) => { const v = G_CAMPOS[k](r); if (v) cont.set(v, (cont.get(v) || 0) + 1); });
      [...gSel[k]].forEach((v) => { if (!cont.has(v)) gSel[k].delete(v); });
      const ops = [...cont.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]), "pt-BR", { numeric: true }));
      const aberto = el.querySelector(".multi-painel") && !el.querySelector(".multi-painel").hidden;
      el.innerHTML = `<span class="multi-rotulo">${esc(el.dataset.rotulo)}</span>
        <button type="button" class="multi-botao"><span class="multi-valor"></span><span class="seta">▾</span></button>
        <div class="multi-painel" ${aberto ? "" : "hidden"}><input class="multi-busca" type="search" placeholder="Procurar…">
          <div class="multi-lista">${ops.map(([v, n]) => `<label class="multi-op"><input type="checkbox" value="${esc(v)}" ${gSel[k].has(v) ? "checked" : ""}><span>${esc(v)}</span><em>${fmt(n)}</em></label>`).join("")}</div>
          <div class="multi-acoes"><button type="button" class="link" data-acao="limpar">Limpar</button><span class="s">${fmt(ops.length)} opções</span></div></div>`;
      valorMultiG(el);
    });
  }
  function valorMultiG(el) {
    const s = gSel[el.dataset.g];
    el.querySelector(".multi-valor").textContent = !s.size ? "Todos" : s.size === 1 ? [...s][0] : `${s.size} selecionados`;
    el.classList.toggle("ativo", s.size > 0);
  }
  $("g-filtros").addEventListener("click", (e) => {
    const bt = e.target.closest(".multi-botao");
    if (bt) { const pn = bt.parentElement.querySelector(".multi-painel"); const ab = pn.hidden;
      document.querySelectorAll("#g-filtros .multi-painel").forEach((x) => (x.hidden = true)); pn.hidden = !ab; if (ab) pn.querySelector(".multi-busca").focus(); return; }
    const lp = e.target.closest("[data-acao=limpar]");
    if (lp) { const el = lp.closest(".multi"); gSel[el.dataset.g].clear(); el.querySelectorAll("input[type=checkbox]").forEach((c) => (c.checked = false)); valorMultiG(el); filtrosGMudaram(); }
  });
  $("g-filtros").addEventListener("change", (e) => {
    if (e.target.type !== "checkbox") return;
    const el = e.target.closest(".multi"); e.target.checked ? gSel[el.dataset.g].add(e.target.value) : gSel[el.dataset.g].delete(e.target.value);
    valorMultiG(el); filtrosGMudaram();
  });
  $("g-filtros").addEventListener("input", (e) => {
    if (!e.target.classList.contains("multi-busca")) return;
    const q = norm(e.target.value);
    e.target.closest(".multi").querySelectorAll(".multi-op").forEach((op) => (op.hidden = q && !norm(op.textContent).includes(q)));
  });
  document.addEventListener("click", (e) => { if (!e.target.closest("#g-filtros .multi")) document.querySelectorAll("#g-filtros .multi-painel").forEach((x) => (x.hidden = true)); });
  function filtrosGMudaram() { gSelecao = null; gPagina = 1; eSelecao = null; ePagina = 1; desenharGAtual(); }

  function gFiltrados() {
    const nfs = $("g-nf").value.split(/[\s,;]+/).map((x) => chaveNF(x)).filter(Boolean);
    const de = $("g-de").value, ate = $("g-ate").value;
    const ativos = Object.entries(gSel).filter(([, s]) => s.size);
    return gDados.filter((r) => {
      if (ativos.some(([k, s]) => !s.has(G_CAMPOS[k](r)))) return false;
      if (nfs.length) { const a = chaveNF(r.nf), b = chaveNF(`${r.nf}-${r.serie}`); if (!nfs.some((n) => n === a || n === b)) return false; }
      if (de && (!r.criado || r.criado < de)) return false;
      if (ate && (!r.criado || r.criado > ate)) return false;
      return true;
    });
  }
  function montarGerencial() {
    if (!G_PAGINAS.includes(paginaAtual)) return;
    if (!gDados) { carregarGerencial(); return; }
    prepararG(); montarFiltrosG(); desenharGAtual();
  }
  // Visão Gerencial e Entregas e SLA usam os mesmos dados e os mesmos filtros
  const G_PAGINAS = ["gerencial", "entregas", "uf", "transp"];
  function desenharGAtual() { if (paginaAtual === "entregas") desenharEntregas(); else if (paginaAtual === "uf") desenharUF(); else if (paginaAtual === "transp") desenharTransp(); else desenharGerencial(); }
  function selecionar(titulo, filtro) { gSelecao = { titulo, filtro }; gPagina = 1; desenharGLista(true); }

  function desenharGerencial() {
    if (!gDados) return;
    const L = gFiltrados(), hoje = hojeISO();
    const cont = Object.fromEntries(Object.entries(G_CARD).map(([k, f]) => [k, L.filter(f).length]));
    document.querySelectorAll("#g-cards .kpi[data-g]").forEach((b) => { b.classList.toggle("ativa", !gSelecao && b.dataset.g === gCard); b.querySelector(".kpi-num").textContent = fmt(cont[b.dataset.g]); });
    // performance
    const meta = Math.min(100, Math.max(50, parseFloat($("g-meta").value) || 97)) / 100;
    const denom = gTodos ? L.length : cont.abertos, outro = gTodos ? cont.abertos : L.length;
    const perf = denom ? 1 - cont.atrasados / denom : 1;
    const pct = (x) => (x * 100).toFixed(1).replace(".", ",") + "%";
    const sobre = gTodos ? "todos os pedidos" : "só os pedidos em aberto";
    const maxAtr = Math.floor(denom * (1 - meta) + 1e-9), faltam = Math.max(0, cont.atrasados - maxAtr), metaTxt = pct(meta).replace(",0%", "%");
    $("g-perf").querySelector(".kpi-num").textContent = pct(perf);
    $("g-perf").className = "kpi kpi-fixo " + (perf >= meta ? "verde" : "laranja");
    $("g-perf-sub").textContent = `${fmt(cont.atrasados)} atrasados ÷ ${fmt(denom)} ${sobre}`;
    $("g-alerta").hidden = !L.length;
    $("g-alerta-titulo").textContent = faltam ? `Para bater a meta de ${metaTxt}, faltam ${fmt(faltam)} atraso${faltam === 1 ? "" : "s"} para resolver.` : `Meta de ${metaTxt} batida.`;
    $("g-alerta-texto").innerHTML = `A performance está em <b>${pct(perf)}</b>: ${fmt(cont.atrasados)} atrasados sobre ${fmt(denom)} ${sobre}. Na meta, o máximo seria <b>${fmt(maxAtr)}</b>.`;
    $("g-perf-nota").innerHTML = `A <b>performance</b> está sendo calculada sobre <b>${sobre}</b> (${fmt(cont.atrasados)} atrasados ÷ ${fmt(denom)}). <button class="link" id="g-modo" type="button">${gTodos ? "Calcular só sobre os pedidos em aberto" : "Calcular sobre todos os pedidos"}</button> daria ${pct(outro ? 1 - cont.atrasados / outro : 1)}.`;
    $("g-info").textContent = info ? `Base de ${new Date(info.enviado_em).toLocaleDateString("pt-BR")} · ${fmt(L.length)} pedidos · clique nos cards e nas barras dos gráficos para ver a lista e exportar`
      : 'Envie a base ("Enviar base") para montar a Visão Gerencial.';
    if (gAvisoColunas) $("g-info").textContent += " · Para usar o Range de Atrasos e as datas de criação e entrega, rode de novo o supabase/schema.sql e envie a base de novo.";

    // de quem é o atraso
    const atr = L.filter(G_CARD.atrasados);
    const semExp = atr.filter((r) => r._semExp), sairam = atr.filter((r) => !r._semExp && r._prom && r.despacho > r._prom), deFato = atr.filter((r) => !r._semExp && !(r._prom && r.despacho > r._prom));
    $("g-atr").innerHTML = atr.length ? `<h2>🚚 Dos ${fmt(atr.length)} atrasados, ${fmt(deFato.length)} são de fato da transportadora.</h2>
      <p class="g-links"><button class="link vermelho" data-atr="fato">${fmt(deFato.length)} para cobrar</button><button class="link laranja" data-atr="sairam">${fmt(sairam.length)} saíram atrasados daqui</button><button class="link" data-atr="semexp">${fmt(semExp.length)} nem foram expedidos</button></p>
      <p class="s">Pedido que saiu daqui depois da data prometida já nasceu atrasado: levar ele para a reunião com a transportadora é perder a razão.</p>` : "<h2>🚚 Nenhum pedido atrasado nesse filtro.</h2>";
    gAtr = { fato: deFato, sairam, semexp: semExp };

    desenharProdutividade(L, hoje);
    desenharFaixas(atr);
    // distribuição por situação
    const porSit = new Map(SIT.map(([k]) => [k, 0])); L.forEach((r) => porSit.set(r._sit, porSit.get(r._sit) + 1));
    const maxS = Math.max(1, ...porSit.values());
    $("g-situacao").innerHTML = SIT.map(([k, nome, cor]) => `<button class="barra" data-sit="${k}" title="${nome}: ${fmt(porSit.get(k))}"><span class="barra-nome">${nome}</span>
      <span class="barra-trilho"><span style="width:${Math.max(1, (porSit.get(k) / maxS) * 100)}%;background:${cor}"></span></span><b style="color:${cor}">${fmt(porSit.get(k))}</b></button>`).join("");
    desenharCanais(L);
    // atraso por transportadora (performance)
    const porT = new Map();
    L.forEach((r) => { if (r._fechado) return; const t = r.transp || "(sem transportadora)"; const x = porT.get(t) || { ab: 0, atr: 0 }; x.ab++; if (r._atraso) x.atr++; porT.set(t, x); });
    $("g-perf-linhas").innerHTML = [...porT.entries()].sort((a, b) => b[1].atr - a[1].atr || b[1].ab - a[1].ab).map(([t, x]) => {
      const pf = 1 - x.atr / x.ab, ok = pf >= meta;
      return `<tr class="clicavel" data-pt="${esc(t)}"><td>${esc(t)}</td><td class="num ${ok ? "ok" : "ruim"}">${ok ? "●" : "↘"} ${(pf * 100).toFixed(2).replace(".", ",")}%</td><td class="num neutro">${fmt(x.ab)}</td><td class="num">${fmt(x.atr)}</td></tr>`;
    }).join("");
    desenharPorTransp(L);
    gFiltradosCache = L;
    if (!gSelecao) { gPagina = Math.min(gPagina, 9999); }
    desenharGLista(false);
  }
  let gAtr = {}, gFiltradosCache = [];

  function desenharProdutividade(L, hoje) {
    const J = gJanela, dias = []; for (let i = -J; i <= J; i++) dias.push(somaDias(hoje, i));
    const ent = new Map(), venc = new Map(); let atrHoje = 0;
    L.forEach((r) => {
      if (r.entrega && norm(r.status).startsWith("ENTREGUE")) ent.set(r.entrega, (ent.get(r.entrega) || 0) + 1);
      if (r._atraso) atrHoje++; else if (!r._fechado && r._prom && r._prom >= hoje) venc.set(r._prom, (venc.get(r._prom) || 0) + 1);
    });
    const val = dias.map((d) => ({ d, e: d <= hoje ? ent.get(d) || 0 : null, v: d >= hoje ? venc.get(d) || 0 : 0, a: d === hoje ? atrHoje : 0 }));
    const max = Math.max(1, ...val.map((x) => Math.max(x.e || 0, x.v + x.a)));
    const W = 1000, H = 260, pl = 40, pb = 40, pt = 20, cw = (W - pl - 10) / val.length, y = (n) => H - pb - (n / max) * (H - pb - pt);
    let g = "";
    for (let i = 0; i <= 4; i++) { const n = Math.round((max * i) / 4); g += `<line x1="${pl}" x2="${W - 10}" y1="${y(n)}" y2="${y(n)}" class="grade"/><text x="${pl - 6}" y="${y(n) + 4}" class="eixo" text-anchor="end">${fmt(n)}</text>`; }
    val.forEach((x, i) => {
      const cx = pl + i * cw + cw / 2, bw = Math.min(34, cw * 0.7);
      if (x.v) g += `<rect class="bar-clic" data-dia="${x.d}" data-tipo="vence" x="${cx - bw / 2}" y="${y(x.v)}" width="${bw}" height="${y(0) - y(x.v)}" fill="#16a34a" rx="2"><title>${ddmm(x.d)}: ${fmt(x.v)} vencem</title></rect>`;
      if (x.a) g += `<rect class="bar-clic" data-dia="${x.d}" data-tipo="atraso" x="${cx - bw / 2}" y="${y(x.v + x.a)}" width="${bw}" height="${y(x.v) - y(x.v + x.a)}" fill="#f5b400" rx="2"><title>${fmt(x.a)} atrasados</title></rect>`;
      if (x.v + x.a) g += `<text x="${cx}" y="${y(x.v + x.a) - 5}" class="rot" text-anchor="middle">${fmt(x.v + x.a)}</text>`;
      g += `<text x="${cx}" y="${H - pb + 16}" class="eixo ${x.d === hoje ? "hoje" : ""}" text-anchor="end" transform="rotate(-45 ${cx} ${H - pb + 16})">${ddmm(x.d)}</text>`;
    });
    const pts = val.map((x, i) => (x.e === null ? null : [pl + i * cw + cw / 2, y(x.e), x])).filter(Boolean);
    if (pts.length) {
      g += `<polyline points="${pts.map((p) => p[0] + "," + p[1]).join(" ")}" class="linha-ent"/>`;
      pts.forEach(([px, py, x]) => { g += `<circle cx="${px}" cy="${py}" r="3.5" class="ponto-ent bar-clic" data-dia="${x.d}" data-tipo="entregue"><title>${ddmm(x.d)}: ${fmt(x.e)} entregues</title></circle>`; if (x.e) g += `<text x="${px}" y="${py - 8}" class="rot azul" text-anchor="middle">${fmt(x.e)}</text>`; });
    }
    $("g-prod").innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Entregas por dia e o que vence">${g}</svg>`;
    // resumo do último dia com movimento
    const ultDia = [...ent.keys()].filter((d) => d < hoje).sort().pop();
    let txt = "";
    if (ultDia) {
      const doDia = L.filter((r) => r.entrega === ultDia && norm(r.status).startsWith("ENTREGUE")), atrasadas = doDia.filter((r) => r._sit === "ent_atraso").length;
      const porT = new Map(); doDia.forEach((r) => porT.set(r.transp, (porT.get(r.transp) || 0) + 1));
      const [tMax, nMax] = [...porT.entries()].sort((a, b) => b[1] - a[1])[0] || ["—", 0];
      txt += `<p>No último dia com movimento (<b>${ddmm(ultDia)}</b>) as transportadoras entregaram <button class="link verde" data-prod="ent">${fmt(doDia.length)} pedidos</button>, dos quais <button class="link laranja" data-prod="entatr">${fmt(atrasadas)} estavam atrasados</button>; o maior volume foi da <b>${esc(tMax)}</b>, com ${fmt(nMax)}.</p>`;
      gProd = { ent: doDia, entatr: doDia.filter((r) => r._sit === "ent_atraso"), dia: ultDia };
    }
    const vHoje = venc.get(hoje) || 0;
    txt += `<p>Para hoje há <button class="link vermelho" data-prod="hoje">${fmt(atrHoje + vHoje)} pedidos para entregar</button>: ${fmt(atrHoje)} já atrasados e ${fmt(vHoje)} vencendo hoje.</p>`;
    $("g-prod-resumo").innerHTML = txt;
  }
  let gProd = {};

  function desenharFaixas(atr) {
    const dim = $("g-faixa-dim").value, [nomeDim, fd] = G_DIM[dim];
    $("g-faixa-dim-nome").textContent = nomeDim;
    const porL = new Map();
    atr.forEach((r) => { const k = fd(r); const x = porL.get(k) || new Array(FAIXAS.length).fill(0); const i = faixaDe(r); if (i >= 0) x[i]++; porL.set(k, x); });
    const tot = FAIXAS.map((_, i) => [...porL.values()].reduce((s, x) => s + x[i], 0));
    $("g-faixa-cab").innerHTML = `<tr><th>Rótulos de linha</th>${FAIXAS.map(([n], i) => `<th class="num clic" data-fx="${i}">${n}</th>`).join("")}<th class="num">Total</th></tr>`;
    $("g-faixa-linhas").innerHTML = [...porL.entries()].map(([k, x]) => [k, x, x.reduce((a, b) => a + b, 0)]).sort((a, b) => b[2] - a[2])
      .map(([k, x, t]) => `<tr><td class="clic" data-lin="${esc(k)}">${esc(k)}</td>${x.map((n, i) => `<td class="num ${n ? "clic" : "vazio-c"}" ${n ? `data-lin="${esc(k)}" data-fx="${i}"` : ""}>${n ? fmt(n) : "·"}</td>`).join("")}<td class="num tot">${fmt(t)}</td></tr>`).join("")
      + (porL.size ? `<tr class="tot-linha"><td>Total</td>${tot.map((n) => `<td class="num">${fmt(n)}</td>`).join("")}<td class="num">${fmt(atr.length)}</td></tr>` : "");
    $("g-faixa-todos").textContent = `Extrair todos (${fmt(atr.length)})`;
  }

  function desenharCanais(L) {
    const porC = new Map();
    L.forEach((r) => { const c = r.canal || "(sem canal)"; const x = porC.get(c) || { v: 0, a: 0, t: 0 }; x.v++; if (!r._fechado) x.a++; if (r._atraso) x.t++; porC.set(c, x); });
    const top = [...porC.entries()].sort((a, b) => b[1].v - a[1].v).slice(0, 8);
    const max = Math.max(1, ...top.map(([, x]) => x.v));
    const W = 560, H = 240, pl = 44, pb = 56, pt = 16, cw = (W - pl - 6) / Math.max(1, top.length), y = (n) => H - pb - (n / max) * (H - pb - pt);
    let g = "";
    for (let i = 0; i <= 4; i++) { const n = Math.round((max * i) / 4); g += `<line x1="${pl}" x2="${W - 6}" y1="${y(n)}" y2="${y(n)}" class="grade"/><text x="${pl - 6}" y="${y(n) + 4}" class="eixo" text-anchor="end">${fmt(n)}</text>`; }
    top.forEach(([c, x], i) => {
      const x0 = pl + i * cw + cw * 0.15, bw = (cw * 0.7) / 3;
      [["v", "#f5b400", "volume"], ["a", "#0ea5e9", "em aberto"], ["t", "#b91c1c", "atrasados"]].forEach(([k, cor, nome], j) => {
        g += `<rect class="bar-clic" data-canal="${esc(c)}" data-ck="${k}" x="${x0 + j * bw}" y="${y(x[k])}" width="${bw - 2}" height="${Math.max(0.5, y(0) - y(x[k]))}" fill="${cor}" rx="2"><title>${esc(c)} · ${nome}: ${fmt(x[k])}</title></rect>`;
      });
      g += `<text x="${x0 + bw / 2}" y="${y(x.v) - 4}" class="rot" text-anchor="start">${fmt(x.v)}</text>`;
      const cx = pl + i * cw + cw / 2;
      g += `<text x="${cx}" y="${H - pb + 14}" class="eixo" text-anchor="end" transform="rotate(-25 ${cx} ${H - pb + 14})">${esc(c.length > 18 ? c.slice(0, 17) + "…" : c)}</text>`;
    });
    $("g-canais").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Pedidos por canal">${g}</svg>`;
  }

  function desenharPorTransp(L) {
    const porT = new Map(), meses = new Set();
    L.forEach((r) => {
      const t = r.transp || "(sem transportadora)"; const x = porT.get(t) || { tot: 0, ent: 0, ok: 0, can: 0, ab: 0, m: new Map() };
      x.tot++; const st = norm(r.status); if (r._sit === "ent_prazo") x.ok++; if (st.startsWith("ENTREGUE")) x.ent++; else if (st.startsWith("CANCELADO")) x.can++; else x.ab++;
      const m = (r.criado || "").slice(0, 7); if (m) { x.m.set(m, (x.m.get(m) || 0) + 1); meses.add(m); }
      porT.set(t, x);
    });
    const ord = [...porT.entries()].sort((a, b) => b[1].tot - a[1].tot);
    if (gPtModo === "sit") {
      $("g-pt-cab").innerHTML = `<tr><th>Transportadora</th><th class="num">Total</th><th class="num">Entregues</th><th class="num">SLA entrega</th><th class="num">Cancelados</th><th class="num">Em trânsito</th></tr>`;
      $("g-pt-linhas").innerHTML = ord.map(([t, x]) => `<tr class="clicavel" data-ptt="${esc(t)}"><td>${esc(t)}</td><td class="num neutro tot">${fmt(x.tot)}</td>
        <td class="num verde-t">${fmt(x.ent)} <small>(${Math.round((x.ent / x.tot) * 100)}%)</small></td><td class="num ${corSla(x.ent ? x.ok / x.ent : null)}" title="entregues no prazo ÷ entregues">${pct0(x.ent ? x.ok / x.ent : null)}</td><td class="num neutro">${fmt(x.can)}</td><td class="num azul-t">${fmt(x.ab)}</td></tr>`).join("");
    } else {
      const ms = [...meses].sort().slice(-6), NM = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
      $("g-pt-cab").innerHTML = `<tr><th>Transportadora</th>${ms.map((m) => `<th class="num">${NM[+m.slice(5) - 1]}/${m.slice(2, 4)}</th>`).join("")}<th class="num">Total</th></tr>`;
      $("g-pt-linhas").innerHTML = ord.map(([t, x]) => `<tr class="clicavel" data-ptt="${esc(t)}"><td>${esc(t)}</td>${ms.map((m) => `<td class="num neutro">${fmt(x.m.get(m) || 0)}</td>`).join("")}<td class="num neutro tot">${fmt(x.tot)}</td></tr>`).join("");
    }
  }

  function desenharGLista(rolar) {
    const L = gFiltradosCache;
    gLista = gSelecao ? gSelecao.filtro(L) : L.filter(G_CARD[gCard]);
    gLista.sort((a, b) => (b._atraso - a._atraso) || String(a._prom || "9").localeCompare(String(b._prom || "9")));
    document.querySelectorAll("#g-cards .kpi[data-g]").forEach((b) => b.classList.toggle("ativa", !gSelecao && b.dataset.g === gCard));
    $("g-lista-titulo").textContent = `${gSelecao ? gSelecao.titulo : G_NOME[gCard]} (${fmt(gLista.length)})`;
    const total = gLista.length, paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
    gPagina = Math.min(Math.max(1, gPagina), paginas);
    $("g-linhas").innerHTML = gLista.slice((gPagina - 1) * POR_PAGINA, gPagina * POR_PAGINA).map((r) => {
      const chip = r._fechado ? `<span class="chip ${r._sit === "ent_atraso" ? "vermelho" : r._sit === "cancelado" ? "cinza" : "verde"}">${esc(r.status)}</span>`
        : r._atraso ? `<span class="chip vermelho">atrasado ${r._atraso} d</span>` : r._d !== null && r._d <= 1 ? `<span class="chip ambar">${r._d === 0 ? "vence hoje" : "vence amanhã"}</span>` : `<span class="chip cinza">${esc(r.status || "")}</span>`;
      return `<tr><td><div class="p">${esc(r.pedido)}</div></td><td>${esc(r.nf)}${r.serie ? "-" + esc(r.serie) : ""}</td><td>${esc(r.canal)}</td><td>${esc(r.transp)}</td><td>${esc(r.uf)}</td>
        <td><span class="ms">${esc(r.micro)}</span><div>${chip}</div></td><td>${br(r.criado)}</td><td>${br(r._prom) || "—"}</td><td>${br(r.entrega) || "—"}</td><td class="num">${r._fechado ? "—" : r._parado ?? "—"}</td></tr>`;
    }).join("");
    $("g-vazio").hidden = total > 0;
    $("g-paginacao").innerHTML = total > POR_PAGINA
      ? `<button class="btn" data-p="-1" ${gPagina === 1 ? "disabled" : ""}>‹ Anterior</button><span>Página ${gPagina} de ${paginas}</span>
         <button class="btn" data-p="1" ${gPagina === paginas ? "disabled" : ""}>Próxima ›</button>` : "";
    if (rolar) $("g-lista-cartao").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // cliques
  $("g-cards").addEventListener("click", (e) => { const b = e.target.closest(".kpi[data-g]"); if (!b) return; gCard = b.dataset.g; gSelecao = null; gPagina = 1; desenharGLista(true); });
  $("g-atr").addEventListener("click", (e) => { const b = e.target.closest("[data-atr]"); if (!b) return;
    const nomes = { fato: "Atrasados de fato da transportadora (para cobrar)", sairam: "Atrasados que saíram daqui depois da data prometida", semexp: "Atrasados que nem foram expedidos" };
    const ids = new Set(gAtr[b.dataset.atr].map((r) => r.pedido)); selecionar(nomes[b.dataset.atr], (L) => L.filter((r) => ids.has(r.pedido))); });
  $("g-prod-resumo").addEventListener("click", (e) => { const b = e.target.closest("[data-prod]"); if (!b) return; const k = b.dataset.prod, hoje = hojeISO();
    if (k === "hoje") return selecionar("Para entregar hoje (atrasados + vencem hoje)", (L) => L.filter((r) => r._atraso || (!r._fechado && r._prom === hoje)));
    const ids = new Set(gProd[k].map((r) => r.pedido)); selecionar(k === "ent" ? `Entregues em ${ddmm(gProd.dia)}` : `Entregues atrasados em ${ddmm(gProd.dia)}`, (L) => L.filter((r) => ids.has(r.pedido))); });
  $("g-prod").addEventListener("click", (e) => { const b = e.target.closest("[data-dia]"); if (!b) return; const d = b.dataset.dia, t = b.dataset.tipo;
    if (t === "entregue") selecionar(`Entregues em ${ddmm(d)}`, (L) => L.filter((r) => r.entrega === d && norm(r.status).startsWith("ENTREGUE")));
    else if (t === "atraso") selecionar("Atrasados (em aberto)", (L) => L.filter(G_CARD.atrasados));
    else selecionar(`Vencem em ${ddmm(d)}`, (L) => L.filter((r) => !r._fechado && !r._atraso && r._prom === d)); });
  $("g-janela").addEventListener("click", (e) => { const b = e.target.closest("button[data-j]"); if (!b) return; gJanela = +b.dataset.j;
    $("g-janela").querySelectorAll("button").forEach((x) => x.classList.toggle("ativo", x === b)); desenharProdutividade(gFiltradosCache, hojeISO()); });
  $("g-faixa-dim").addEventListener("change", () => desenharFaixas(gFiltradosCache.filter(G_CARD.atrasados)));
  document.querySelector(".tabela-faixa").addEventListener("click", (e) => { const c = e.target.closest("[data-lin],[data-fx]"); if (!c) return;
    const fd = G_DIM[$("g-faixa-dim").value][1], lin = c.dataset.lin, fx = c.dataset.fx !== undefined ? +c.dataset.fx : null;
    selecionar(`Atrasados${lin ? " · " + lin : ""}${fx !== null ? " · " + FAIXAS[fx][0] : ""}`, (L) => L.filter((r) => r._atraso && (!lin || fd(r) === lin) && (fx === null || faixaDe(r) === fx))); });
  $("g-faixa-todos").addEventListener("click", () => { selecionar("Atrasados (em aberto)", (L) => L.filter(G_CARD.atrasados)); baixarGLista(); });
  $("g-situacao").addEventListener("click", (e) => { const b = e.target.closest("[data-sit]"); if (!b) return; const k = b.dataset.sit;
    selecionar(SIT.find((x) => x[0] === k)[1], (L) => L.filter((r) => r._sit === k)); });
  $("g-canais").addEventListener("click", (e) => { const b = e.target.closest("[data-canal]"); if (!b) return; const c = b.dataset.canal, k = b.dataset.ck;
    selecionar(`${c} · ${{ v: "todos", a: "em aberto", t: "atrasados" }[k]}`, (L) => L.filter((r) => (r.canal || "(sem canal)") === c && (k === "v" || (k === "a" ? !r._fechado : r._atraso > 0)))); });
  $("g-perf-linhas").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-pt]"); if (!tr) return; const t = tr.dataset.pt;
    selecionar(`Atrasados · ${t}`, (L) => L.filter((r) => r._atraso && (r.transp || "(sem transportadora)") === t)); });
  $("g-pt-linhas").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-ptt]"); if (!tr) return; verPedidosTransp(tr.dataset.ptt); });
  // a lista de pedidos fica na Visão Gerencial: abre ela já filtrada pela transportadora
  function verPedidosTransp(t) {
    if (paginaAtual !== "gerencial") { irPara("gerencial"); montarGerencial(); }
    selecionar(`Todos os pedidos · ${t}`, (L) => L.filter((r) => (r.transp || "(sem transportadora)") === t));
  }
  $("g-pt-modo").addEventListener("click", (e) => { const b = e.target.closest("button[data-m]"); if (!b) return; gPtModo = b.dataset.m;
    $("g-pt-modo").querySelectorAll("button").forEach((x) => x.classList.toggle("ativo", x === b)); desenharPorTransp(gFiltradosCache); });
  $("g-pt-extrair").addEventListener("click", () => {
    const linhas = [...document.querySelectorAll(".tabela-pt tr")].map((tr) => [...tr.children].map((c) => c.textContent.trim()));
    const ws = XLSX.utils.aoa_to_sheet(linhas); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Por transportadora");
    XLSX.writeFile(wb, `pedidos_por_transportadora_${gPtModo === "sit" ? "situacao" : "mes"}_${hojeISO()}.xlsx`);
  });
  ["g-de", "g-ate"].forEach((id) => $(id).addEventListener("change", filtrosGMudaram));
  let esperaG; $("g-nf").addEventListener("input", () => { clearTimeout(esperaG); esperaG = setTimeout(filtrosGMudaram, 300); });
  $("g-meta").addEventListener("change", () => { try { localStorage.setItem("painel.meta", $("g-meta").value); } catch (_) {} desenharGAtual(); });
  $("g-perf-nota").addEventListener("click", (e) => { if (e.target.id === "g-modo") { gTodos = !gTodos; desenharGerencial(); } });
  $("g-limpar").addEventListener("click", () => { Object.values(gSel).forEach((s) => s.clear()); ["g-de", "g-ate", "g-nf"].forEach((id) => ($(id).value = "")); montarFiltrosG(); filtrosGMudaram(); });
  $("g-paginacao").addEventListener("click", (e) => { const b = e.target.closest("button[data-p]"); if (!b) return; gPagina += Number(b.dataset.p); desenharGLista(false); });
  function baixarGLista() {
    if (!gLista.length) return toast("Nada para exportar.", true);
    const linhas = [["Pedido", "NF", "Série", "Canal", "Transportadora", "UF", "Origem", "Status", "Micro status", "Criado", "Despacho", "Prometido", "Entrega", "Dias de atraso", "Dias parado"]]
      .concat(gLista.map((r) => [r.pedido, r.nf, r.serie, r.canal, r.transp, r.uf, r.origem, r.status, r.micro, br(r.criado), br(r.despacho), br(r._prom), br(r.entrega), r._atraso || "", r._fechado ? "" : r._parado]));
    const ws = XLSX.utils.aoa_to_sheet(linhas); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Visão Gerencial");
    XLSX.writeFile(wb, `visao_gerencial_${hojeISO()}.xlsx`);
  }
  $("g-exportar").addEventListener("click", baixarGLista);

  // ---------------- transportadoras ----------------
  // Fonte: a mesma base da Visão Gerencial (botão "Enviar base"), com os mesmos filtros do topo.
  // Volume = pedidos sem os cancelados. Atraso médio = dias entre a data prometida e a entrega, nos entregues com atraso.
  // SLA entrega = entregues no prazo ÷ entregues.
  const T_CORES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"];   // até 4 transportadoras na comparação (cor fica com a transportadora)
  let tStats = [], tOrdem = "vol";
  const tCmp = new Map();   // transportadora -> índice da cor
  const tNome = (r) => r.transp || "(sem transportadora)";
  function statsTransp(L) {
    const m = new Map();
    L.forEach((r) => {
      const t = tNome(r);
      const x = m.get(t) || { t, vol: 0, ab: 0, atr: 0, risco: 0, ent: 0, entOk: 0, entAtr: 0, somaAtr: 0, nAtr: 0, can: 0, meses: new Map() };
      if (r._sit === "cancelado") { x.can++; m.set(t, x); return; }
      x.vol++;
      if (!r._fechado) x.ab++;
      if (r._atraso > 0) x.atr++;
      if (G_CARD.risco(r)) x.risco++;
      if (r._sit === "ent_prazo" || r._sit === "ent_atraso") x.ent++;
      if (r._sit === "ent_prazo") x.entOk++;
      if (r._sit === "ent_atraso") { x.entAtr++; if (r.entrega && r._prom) { const d = diasEntre(r._prom, r.entrega); if (d > 0) { x.somaAtr += d; x.nAtr++; } } }
      const mes = (r.criado || "").slice(0, 7); if (mes) x.meses.set(mes, (x.meses.get(mes) || 0) + 1);
      m.set(t, x);
    });
    return [...m.values()].map((x) => ({ ...x, med: x.nAtr ? x.somaAtr / x.nAtr : null, sla: x.ent ? x.entOk / x.ent : null }));
  }
  const pct0 = (x) => (x === null ? "—" : Math.round(x * 100) + "%");
  const diasTxt = (x) => (x === null ? "—" : x.toFixed(1).replace(".", ",") + " d");
  function corSla(x) { if (x === null) return "neutro"; const meta = (parseFloat($("g-meta").value) || 97) / 100; return x >= meta ? "verde-t" : x >= 0.85 ? "laranja-t" : "vermelho-t"; }
  function desenharTransp() {
    if (!gDados) return;
    const L = gFiltrados(); gFiltradosCache = L;
    tStats = statsTransp(L);
    $("t-info").textContent = !info ? 'Envie a base ("Enviar base") para montar esta página.'
      : `Base de ${new Date(info.enviado_em).toLocaleDateString("pt-BR")} · ${fmt(L.length)} pedidos nos filtros`;
    const soma = (k) => tStats.reduce((a, x) => a + x[k], 0);
    const ent = soma("ent"), ab = soma("ab");
    $("t-k-qtd").textContent = fmt(tStats.filter((x) => x.vol).length);
    $("t-k-vol").textContent = fmt(soma("vol"));
    $("t-k-atr").textContent = fmt(soma("atr")); $("t-k-atr-s").textContent = `de ${fmt(ab)} em aberto`;
    $("t-k-sla").textContent = ent ? pct0(soma("entOk") / ent) : "—";
    // tira da comparação quem sumiu com os filtros
    [...tCmp.keys()].forEach((t) => { if (!tStats.some((x) => x.t === t)) tCmp.delete(t); });
    desenharDetalhe(); desenharPorTransp(L); desenharComparacao();
  }
  function desenharDetalhe() {
    const ord = { vol: (a, b) => b.vol - a.vol, ab: (a, b) => b.ab - a.ab, atr: (a, b) => b.atr - a.atr, risco: (a, b) => b.risco - a.risco, entAtr: (a, b) => b.entAtr - a.entAtr,
      med: (a, b) => (b.med ?? -1) - (a.med ?? -1), sla: (a, b) => (a.sla ?? 2) - (b.sla ?? 2), nome: (a, b) => a.t.localeCompare(b.t, "pt-BR") }[tOrdem];
    const linhas = tStats.filter((x) => x.vol).sort((a, b) => ord(a, b) || b.vol - a.vol);
    $("t-det-sub").textContent = `${fmt(linhas.length)} transportadoras na base`;
    const cheio = tCmp.size >= 4;
    $("t-det-linhas").innerHTML = linhas.map((x) => { const c = tCmp.has(x.t);
      return `<tr><td class="cmp"><input type="checkbox" data-cmp="${esc(x.t)}" ${c ? "checked" : ""} ${!c && cheio ? "disabled" : ""} aria-label="Comparar ${esc(x.t)}">${c ? `<i class="t-bola" style="background:${T_CORES[tCmp.get(x.t)]}"></i>` : ""}</td>
        <td class="clic" data-ver="${esc(x.t)}">${esc(x.t)}</td><td class="num neutro">${fmt(x.vol)}</td><td class="num neutro">${fmt(x.ab)}</td>
        <td class="num vermelho-t">${fmt(x.atr)}</td><td class="num laranja-t">${fmt(x.risco)}</td><td class="num neutro">${fmt(x.entAtr)}</td>
        <td class="num neutro">${diasTxt(x.med)}</td><td class="num ${corSla(x.sla)}">${pct0(x.sla)}</td></tr>`; }).join("");
  }
  const T_METRICAS = [
    ["Volume", (x) => x.vol, fmt, "max"], ["Em aberto", (x) => x.ab, fmt, null], ["Atrasados (em aberto)", (x) => x.atr, fmt, "min"],
    ["% atrasados do em aberto", (x) => (x.ab ? x.atr / x.ab : null), (v) => (v === null ? "—" : (v * 100).toFixed(1).replace(".", ",") + "%"), "min"],
    ["Em risco (vencem hoje/amanhã)", (x) => x.risco, fmt, null], ["Entregues", (x) => x.ent, fmt, "max"], ["Entregues com atraso", (x) => x.entAtr, fmt, "min"],
    ["Atraso médio", (x) => x.med, diasTxt, "min"], ["SLA entrega", (x) => x.sla, pct0, "max"], ["Cancelados", (x) => x.can, fmt, "min"],
  ];
  function desenharComparacao() {
    const sel = [...tCmp.keys()].map((t) => tStats.find((x) => x.t === t)).filter(Boolean);
    $("t-cmp-chips").innerHTML = sel.map((x) => `<span class="t-chip"><i class="t-bola" style="background:${T_CORES[tCmp.get(x.t)]}"></i>${esc(x.t)}<button type="button" data-tirar-cmp="${esc(x.t)}" aria-label="Tirar ${esc(x.t)}">×</button></span>`).join("");
    const livres = tStats.filter((x) => x.vol && !tCmp.has(x.t)).sort((a, b) => b.vol - a.vol);
    $("t-cmp-add").innerHTML = `<option value="">${tCmp.size >= 4 ? "Máximo de 4" : "Escolha…"}</option>` + (tCmp.size >= 4 ? "" : livres.map((x) => `<option>${esc(x.t)}</option>`).join(""));
    $("t-cmp-add").disabled = tCmp.size >= 4;
    $("t-cmp-vazio").hidden = sel.length >= 2; $("t-cmp-corpo").hidden = sel.length < 2;
    if (sel.length < 2) return;
    $("t-cmp-cab").innerHTML = `<tr><th></th>${sel.map((x) => `<th class="num"><i class="t-bola" style="background:${T_CORES[tCmp.get(x.t)]}"></i>${esc(x.t)}</th>`).join("")}</tr>`;
    $("t-cmp-linhas").innerHTML = T_METRICAS.map(([nome, f, fm, melhor]) => {
      const vs = sel.map(f), ok = vs.filter((v) => v !== null);
      const alvo = melhor && ok.length > 1 ? (melhor === "max" ? Math.max(...ok) : Math.min(...ok)) : null;
      const unico = alvo !== null && ok.filter((v) => v === alvo).length < ok.length;
      return `<tr><td>${nome}</td>${vs.map((v) => `<td class="num neutro${unico && v === alvo ? " melhor" : ""}">${fm(v)}</td>`).join("")}</tr>`;
    }).join("");
    grafMeses(sel);
  }
  // linhas: volume por mês (últimos 6 meses com pedidos), uma linha por transportadora
  function grafMeses(sel) {
    const todos = new Set(); sel.forEach((x) => x.meses.forEach((_, m) => todos.add(m)));
    const ms = [...todos].sort().slice(-6), NM = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
    const box = $("t-cmp-graf");
    if (ms.length < 2) { box.innerHTML = `<p class="vazio">Sem meses suficientes para o gráfico (precisa da Data de Criação na base).</p>`; return; }
    const W = 760, H = 260, E = 44, D = 150, T = 16, B = 30, pw = W - E - D, ph = H - T - B;
    const max = Math.max(1, ...sel.flatMap((x) => ms.map((m) => x.meses.get(m) || 0)));
    const bruto = max / 4, p10 = Math.pow(10, Math.floor(Math.log10(bruto)));
    const passo = Math.max(1, [1, 2, 2.5, 5, 10].map((k) => k * p10).find((k) => k >= bruto)), topo = passo * 4;
    const X = (i) => E + (pw * i) / (ms.length - 1), Y = (v) => T + ph - (ph * v) / topo;
    const rot = (m) => `${NM[+m.slice(5) - 1]}/${m.slice(2, 4)}`;
    let g = "";
    for (let k = 0; k <= 4; k++) { const v = (topo * k) / 4, y = Y(v); g += `<line x1="${E}" x2="${E + pw}" y1="${y}" y2="${y}" class="gr-grade"/><text x="${E - 6}" y="${y + 4}" class="gr-eixo" text-anchor="end">${fmt(Math.round(v))}</text>`; }
    ms.forEach((m, i) => { g += `<text x="${X(i)}" y="${H - 8}" class="gr-eixo" text-anchor="middle">${rot(m)}</text>`; });
    // rótulos diretos no fim da linha, sem encavalar
    const fins = sel.map((x) => ({ x, y: Y(x.meses.get(ms[ms.length - 1]) || 0) })).sort((a, b) => a.y - b.y);
    for (let k = 1; k < fins.length; k++) if (fins[k].y - fins[k - 1].y < 14) fins[k].y = fins[k - 1].y + 14;
    sel.forEach((x) => {
      const cor = T_CORES[tCmp.get(x.t)], pts = ms.map((m, i) => `${X(i)},${Y(x.meses.get(m) || 0)}`);
      g += `<polyline points="${pts.join(" ")}" fill="none" stroke="${cor}" stroke-width="2" stroke-linejoin="round"/>`;
      ms.forEach((m, i) => { g += `<circle cx="${X(i)}" cy="${Y(x.meses.get(m) || 0)}" r="4" fill="${cor}" stroke="#fff" stroke-width="2"/>`; });
    });
    fins.forEach(({ x, y }) => { const nome = x.t.length > 20 ? x.t.slice(0, 19) + "…" : x.t; g += `<text x="${E + pw + 10}" y="${y + 4}" class="gr-rot">${esc(nome)}</text>`; });
    ms.forEach((m, i) => { const w = pw / (ms.length - 1); g += `<rect class="gr-alvo" data-mes="${m}" x="${X(i) - w / 2}" y="${T}" width="${w}" height="${ph}" fill="transparent"/>`; });
    const legenda = sel.map((x) => `<span><i class="t-bola" style="background:${T_CORES[tCmp.get(x.t)]}"></i>${esc(x.t)}</span>`).join("");
    box.innerHTML = `<div class="gr-legenda">${legenda}</div><div class="gr-area"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Volume por mês das transportadoras comparadas">${g}<line class="gr-mira" x1="0" x2="0" y1="${T}" y2="${T + ph}" visibility="hidden"/></svg><div class="gr-dica" hidden></div></div>`;
    const svg = box.querySelector("svg"), dica = box.querySelector(".gr-dica"), mira = box.querySelector(".gr-mira");
    svg.addEventListener("mousemove", (e) => {
      const a = e.target.closest(".gr-alvo"); if (!a) { dica.hidden = true; mira.setAttribute("visibility", "hidden"); return; }
      const m = a.dataset.mes, i = ms.indexOf(m);
      mira.setAttribute("x1", X(i)); mira.setAttribute("x2", X(i)); mira.setAttribute("visibility", "visible");
      dica.innerHTML = `<b>${rot(m)}</b>` + sel.map((x) => `<div><i class="t-bola" style="background:${T_CORES[tCmp.get(x.t)]}"></i>${esc(x.t)}: <b>${fmt(x.meses.get(m) || 0)}</b></div>`).join("");
      dica.hidden = false;
      const r = box.querySelector(".gr-area").getBoundingClientRect(), px = (X(i) / W) * r.width;
      dica.style.left = Math.min(px + 12, r.width - dica.offsetWidth - 4) + "px"; dica.style.top = "8px";
    });
    svg.addEventListener("mouseleave", () => { dica.hidden = true; mira.setAttribute("visibility", "hidden"); });
  }
  function corLivre() { const usadas = new Set(tCmp.values()); return [0, 1, 2, 3].find((i) => !usadas.has(i)); }
  function alternarCmp(t, ligar) {
    if (ligar && !tCmp.has(t) && tCmp.size < 4) tCmp.set(t, corLivre());
    if (!ligar) tCmp.delete(t);
    desenharDetalhe(); desenharComparacao();
  }
  $("t-det-linhas").addEventListener("change", (e) => { const c = e.target.closest("input[data-cmp]"); if (c) alternarCmp(c.dataset.cmp, c.checked); });
  $("t-det-linhas").addEventListener("click", (e) => { const td = e.target.closest("td[data-ver]"); if (td) verPedidosTransp(td.dataset.ver); });
  $("t-cmp-add").addEventListener("change", (e) => { if (e.target.value) alternarCmp(e.target.value, true); });
  $("t-cmp-chips").addEventListener("click", (e) => { const b = e.target.closest("button[data-tirar-cmp]"); if (b) alternarCmp(b.dataset.tirarCmp, false); });
  $("t-ordem").addEventListener("change", (e) => { tOrdem = e.target.value; desenharDetalhe(); });
  $("t-extrair").addEventListener("click", () => {
    const linhas = [["Transportadora", "Volume", "Em aberto", "Atrasados", "Em risco", "Entregues", "Entregues com atraso", "Atraso médio (dias)", "SLA entrega", "Cancelados"]]
      .concat(tStats.filter((x) => x.vol).sort((a, b) => b.vol - a.vol).map((x) => [x.t, x.vol, x.ab, x.atr, x.risco, x.ent, x.entAtr, x.med === null ? "" : +x.med.toFixed(1), x.sla === null ? "" : +(x.sla * 100).toFixed(1), x.can]));
    const ws = XLSX.utils.aoa_to_sheet(linhas); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Transportadoras");
    XLSX.writeFile(wb, `transportadoras_${hojeISO()}.xlsx`);
  });

  // ---------------- entregas e SLA ----------------
  // Fonte: a mesma base da Visão Gerencial, só os pedidos com status Entregue.
  // No prazo / com atraso: "Status Prazo Intelipost" (Fora do Prazo = atraso); senão data de entrega > data prometida.
  let eCard = "sla", eSelecao = null, eLista = [], ePagina = 1, eEntregues = [];
  const E_NOME = { sla: "Todas as entregas", todas: "Todas as entregas", prazo: "Entregues no prazo", atraso: "Entregues com atraso" };
  const E_CARD = { sla: () => true, todas: () => true, prazo: (r) => r._sit === "ent_prazo", atraso: (r) => r._sit === "ent_atraso" };
  const pctBR = (x) => (x * 100).toFixed(1).replace(".", ",") + "%";
  function desenharEntregas() {
    if (!gDados) return;
    const E = gFiltrados().filter((r) => r._sit === "ent_prazo" || r._sit === "ent_atraso");
    eEntregues = E;
    const prazo = E.filter(E_CARD.prazo).length, atraso = E.length - prazo, sla = E.length ? prazo / E.length : 0;
    const meta = Math.min(100, Math.max(50, parseFloat($("g-meta").value) || 97)) / 100, metaTxt = pctBR(meta).replace(",0%", "%");
    const num = { sla: E.length ? pctBR(sla) : "—", todas: fmt(E.length), prazo: fmt(prazo), atraso: fmt(atraso) };
    document.querySelectorAll("#e-cards .kpi[data-e]").forEach((b) => { b.querySelector(".kpi-num").textContent = num[b.dataset.e]; b.classList.toggle("ativa", !eSelecao && b.dataset.e === eCard); });
    $("e-sla-sub").textContent = `${fmt(prazo)} no prazo de ${fmt(E.length)}`;
    const faltam = Math.max(0, Math.ceil(E.length * meta - 1e-9) - prazo);
    $("e-alerta").hidden = !E.length;
    $("e-alerta-titulo").textContent = faltam ? `Faltaram ${fmt(faltam)} entregas no prazo para bater a meta de ${metaTxt}.` : `Meta de ${metaTxt} batida.`;
    $("e-alerta-texto").innerHTML = `O SLA está em <b>${pctBR(sla)}</b> — ${fmt(atraso)} entrega${atraso === 1 ? "" : "s"} saíra${atraso === 1 ? "" : "m"} com atraso.`;
    const totalBase = gDados.length, entBase = gDados.filter((r) => norm(r.status).startsWith("ENTREGUE")).length;
    $("e-info").textContent = !info ? 'Envie a base ("Enviar base") para montar esta página.'
      : !entBase ? `A base enviada (${fmt(totalBase)} pedidos) não tem pedidos com status Entregue. Para ver o SLA, envie no botão "Enviar base" uma exportação que inclua os entregues.`
      : `Base de ${new Date(info.enviado_em).toLocaleDateString("pt-BR")} · ${fmt(E.length)} entregues com esses filtros · meta de ${metaTxt} (a mesma da Visão Gerencial)`;
    // por transportadora
    const m = new Map();
    E.forEach((r) => { const t = r.transp || "(sem transportadora)"; const x = m.get(t) || { t, ent: 0, ok: 0 }; x.ent++; if (r._sit === "ent_prazo") x.ok++; m.set(t, x); });
    const linhas = [...m.values()].map((x) => ({ ...x, atr: x.ent - x.ok, sla: x.ok / x.ent })).sort((a, b) => b.atr - a.atr || b.ent - a.ent);
    const cor = (v) => (v >= meta ? "verde" : v >= 0.85 ? "laranja" : "vermelho");
    $("e-transp").innerHTML = linhas.map((x) => `<tr class="clic" data-et="${esc(x.t)}"><td>${esc(x.t)}</td><td class="num">${fmt(x.ent)}</td><td class="num txt-verde">${fmt(x.ok)}</td><td class="num txt-vermelho">${fmt(x.atr)}</td><td class="num txt-${cor(x.sla)}">${pctBR(x.sla)}</td></tr>`).join("");
    $("e-vazio-transp").hidden = linhas.length > 0;
    eLinhasTransp = linhas;
    desenharELista(false);
  }
  let eLinhasTransp = [];
  function desenharELista(rolar) {
    eLista = eSelecao ? eSelecao.filtro(eEntregues) : eEntregues.filter(E_CARD[eCard]);
    eLista.sort((a, b) => String(b.entrega || "").localeCompare(String(a.entrega || "")));
    document.querySelectorAll("#e-cards .kpi[data-e]").forEach((b) => b.classList.toggle("ativa", !eSelecao && b.dataset.e === eCard));
    $("e-lista-titulo").textContent = `${eSelecao ? eSelecao.titulo : E_NOME[eCard]} (${fmt(eLista.length)})`;
    const total = eLista.length, paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
    ePagina = Math.min(Math.max(1, ePagina), paginas);
    $("e-linhas").innerHTML = eLista.slice((ePagina - 1) * POR_PAGINA, ePagina * POR_PAGINA).map((r) =>
      `<tr><td><div class="p">${esc(r.pedido)}</div></td><td>${esc(r.nf)}${r.serie ? "-" + esc(r.serie) : ""}</td><td>${esc(r.canal)}</td><td>${esc(r.transp)}</td><td>${esc(r.uf)}</td>
        <td>${br(r.criado)}</td><td>${br(r._prom) || "—"}</td><td>${br(r.entrega) || "—"}</td>
        <td><span class="chip ${r._sit === "ent_atraso" ? "vermelho" : "verde"}">${r._sit === "ent_atraso" ? "com atraso" : "no prazo"}</span></td></tr>`).join("");
    $("e-vazio").hidden = total > 0;
    $("e-paginacao").innerHTML = total > POR_PAGINA
      ? `<button class="btn" data-p="-1" ${ePagina === 1 ? "disabled" : ""}>‹ Anterior</button><span>Página ${ePagina} de ${paginas}</span>
         <button class="btn" data-p="1" ${ePagina === paginas ? "disabled" : ""}>Próxima ›</button>` : "";
    if (rolar) $("e-lista-cartao").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  $("e-cards").addEventListener("click", (e) => { const b = e.target.closest(".kpi[data-e]"); if (!b) return; eCard = b.dataset.e; eSelecao = null; ePagina = 1; desenharELista(true); });
  $("e-transp").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-et]"); if (!tr) return; const t = tr.dataset.et;
    eSelecao = { titulo: `Entregues com atraso · ${t}`, filtro: (L) => L.filter((r) => r._sit === "ent_atraso" && (r.transp || "(sem transportadora)") === t) }; ePagina = 1; desenharELista(true); });
  $("e-paginacao").addEventListener("click", (e) => { const b = e.target.closest("button[data-p]"); if (!b) return; ePagina += Number(b.dataset.p); desenharELista(false); });
  $("e-exportar").addEventListener("click", () => {
    if (!eLista.length) return toast("Nada para exportar.", true);
    const linhas = [["Pedido", "NF", "Série", "Canal", "Transportadora", "UF", "Origem", "Micro status", "Criado", "Despacho", "Prometido", "Entrega", "Situação"]]
      .concat(eLista.map((r) => [r.pedido, r.nf, r.serie, r.canal, r.transp, r.uf, r.origem, r.micro, br(r.criado), br(r.despacho), br(r._prom), br(r.entrega), r._sit === "ent_atraso" ? "Com atraso" : "No prazo"]));
    const ws = XLSX.utils.aoa_to_sheet(linhas); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Entregas");
    XLSX.writeFile(wb, `entregas_sla_${hojeISO()}.xlsx`);
  });

  // ---------------- atrasos por UF ----------------
  // Mesma base e mesmos filtros da Visão Gerencial. % de atraso = atrasados ÷ pedidos em aberto do estado.
  let uForma = "mapa", uModo = "mapa", uUF = null, uDados = new Map(), uAtrasadosUF = [];
  const UF_NOME = { AC: "Acre", AL: "Alagoas", AP: "Amapá", AM: "Amazonas", BA: "Bahia", CE: "Ceará", DF: "Distrito Federal", ES: "Espírito Santo", GO: "Goiás", MA: "Maranhão",
    MT: "Mato Grosso", MS: "Mato Grosso do Sul", MG: "Minas Gerais", PA: "Pará", PB: "Paraíba", PR: "Paraná", PE: "Pernambuco", PI: "Piauí", RJ: "Rio de Janeiro", RN: "Rio Grande do Norte",
    RS: "Rio Grande do Sul", RO: "Rondônia", RR: "Roraima", SC: "Santa Catarina", SP: "São Paulo", SE: "Sergipe", TO: "Tocantins" };
  // posição de cada estado na visão em quadrados [linha, coluna]
  const UF_QUAD = { RR: [0, 1], AP: [0, 3], AM: [1, 1], PA: [1, 2], MA: [1, 3], CE: [1, 4], RN: [1, 5], AC: [2, 0], RO: [2, 1], TO: [2, 2], PI: [2, 3], PE: [2, 4], PB: [2, 5],
    MT: [3, 1], GO: [3, 2], DF: [3, 3], BA: [3, 4], AL: [3, 5], MS: [4, 1], MG: [4, 2], ES: [4, 3], SE: [4, 4], SP: [5, 1], RJ: [5, 2], PR: [6, 1], SC: [7, 1], RS: [8, 1] };
  const UF_PEQUENO = ["DF", "ES", "RJ", "SE", "AL", "PE", "PB", "RN"];
  const faixaUF = (x) => (!x || !x.ab ? "fv" : !x.atr ? "f0" : x.pct <= 0.04 ? "f1" : x.pct <= 0.08 ? "f2" : x.pct <= 0.15 ? "f3" : "f4");
  const ufDe = (r) => String(r.uf || "").trim().toUpperCase();
  function agruparUF(L) {
    const m = new Map();
    L.forEach((r) => { if (r._fechado) return; const u = ufDe(r); if (!u) return; const x = m.get(u) || { uf: u, ab: 0, atr: 0, transp: new Map() }; x.ab++;
      if (r._atraso) { x.atr++; const t = r.transp || "(sem transportadora)"; x.transp.set(t, (x.transp.get(t) || 0) + 1); } m.set(u, x); });
    m.forEach((x) => { x.pct = x.ab ? x.atr / x.ab : 0; x.pior = [...x.transp.entries()].sort((a, b) => b[1] - a[1])[0] || null; });
    return m;
  }
  function desenharUF() {
    if (!gDados) return;
    const L = gFiltrados(); uDados = agruparUF(L); uFiltrados = L;
    const ab = [...uDados.values()].reduce((a, x) => a + x.ab, 0), atr = [...uDados.values()].reduce((a, x) => a + x.atr, 0);
    $("u-info").textContent = !info ? 'Envie a base ("Enviar base") para montar esta página.'
      : `Base de ${new Date(info.enviado_em).toLocaleDateString("pt-BR")} · ${fmt(atr)} atrasados de ${fmt(ab)} pedidos em aberto em ${uDados.size} estados · o número em cada estado é a quantidade de atrasados`;
    $("u-mapa-cartao").hidden = uModo !== "mapa"; $("u-ranking-cartao").hidden = uModo !== "ranking";
    if (uModo === "mapa") (uForma === "mapa" ? desenharMapaBR : desenharQuadrados)();
    else desenharRankingUF();
    desenharDetalheUF(false);
  }
  let uFiltrados = [];
  const dicaUF = (u, x) => `${UF_NOME[u] || u}: ${x ? `${fmt(x.atr)} atrasados de ${fmt(x.ab)} em aberto (${pctBR(x.pct)})` : "sem pedidos em aberto"}`;
  function desenharMapaBR() {
    const M = window.MAPA_BR; if (!M) { $("u-mapa").textContent = "Não consegui carregar o desenho do mapa."; return; }
    let g = `<svg viewBox="${M.viewBox}" class="u-svg" role="img" aria-label="Mapa de atrasos por estado">`;
    for (const [u, [, d]] of Object.entries(M.estados)) { const x = uDados.get(u);
      g += `<path d="${d}" class="uf-forma ${faixaUF(x)}${uUF === u ? " sel" : ""}" data-uf="${u}"><title>${esc(dicaUF(u, x))}</title></path>`; }
    g += `<g class="uf-rotulos"></g></svg>`;
    $("u-mapa").innerHTML = g;
    // rótulos: no meio do estado; os estados pequenos do litoral ganham rótulo do lado de fora, com uma linha
    const svg = $("u-mapa").querySelector("svg"), rot = svg.querySelector(".uf-rotulos"); let h = "", fora = 0;
    const ordem = ["RN", "PB", "PE", "AL", "SE", "ES", "RJ", "DF"];
    svg.querySelectorAll("path[data-uf]").forEach((p) => {
      const u = p.dataset.uf, b = p.getBBox(), x = uDados.get(u), n = x ? fmt(x.atr) : "", cx = b.x + b.width / 2, cy = b.y + b.height / 2;
      const escuro = ["f3", "f4", "f0"].includes(faixaUF(x));
      if (UF_PEQUENO.includes(u)) {
        const i = ordem.indexOf(u), lx = u === "DF" ? cx + 18 : 600, ly = u === "DF" ? cy : u === "ES" || u === "RJ" ? cy + 4 : 175 + i * 22;
        const tx = u === "RJ" ? cx + 12 : u === "ES" ? cx + 24 : lx; const ty = u === "RJ" ? cy + 26 : ly;
        if (u !== "DF") h += `<line x1="${cx}" y1="${cy}" x2="${tx - 3}" y2="${ty - 4}" class="uf-linha"/>`;
        h += `<text x="${tx}" y="${ty}" class="uf-rot fora" data-uf="${u}">${u} <tspan class="uf-num-fora">${n}</tspan></text>`; fora++;
      } else {
        h += `<text x="${cx}" y="${cy}" text-anchor="middle" class="uf-rot${escuro ? " claro" : ""}" data-uf="${u}">${u}</text>`;
        if (n) h += `<text x="${cx}" y="${cy + 11}" text-anchor="middle" class="uf-num${escuro ? " claro" : ""}" data-uf="${u}">${n}</text>`;
      }
    });
    rot.innerHTML = h;
  }
  function desenharQuadrados() {
    $("u-mapa").innerHTML = `<div class="u-quad">${Object.entries(UF_QUAD).map(([u, [l, c]]) => { const x = uDados.get(u);
      return `<button class="uf-quad ${faixaUF(x)}${uUF === u ? " sel" : ""}" data-uf="${u}" style="grid-row:${l + 1};grid-column:${c + 1}" title="${esc(dicaUF(u, x))}"><b>${u}</b><span>${x ? fmt(x.atr) : "—"}</span><small>${x && x.ab ? pctBR(x.pct) : ""}</small></button>`; }).join("")}</div>`;
  }
  function desenharRankingUF() {
    const linhas = [...uDados.values()].sort((a, b) => b.atr - a.atr || b.pct - a.pct);
    $("u-ranking").innerHTML = linhas.map((x) => `<tr class="clic${uUF === x.uf ? " sel" : ""}" data-uf="${x.uf}"><td><span class="uf-bolinha ${faixaUF(x)}"></span>${x.uf}</td><td>${esc(UF_NOME[x.uf] || x.uf)}</td>
      <td class="num">${fmt(x.ab)}</td><td class="num txt-vermelho">${fmt(x.atr)}</td><td class="num">${pctBR(x.pct)}</td><td>${x.pior ? `${esc(x.pior[0])} <span class="s">(${fmt(x.pior[1])})</span>` : "—"}</td></tr>`).join("");
  }
  function desenharDetalheUF(rolar) {
    const caixa = $("u-detalhe");
    if (!uUF) { caixa.hidden = true; return; }
    const L = uFiltrados.filter((r) => ufDe(r) === uUF && !r._fechado), x = uDados.get(uUF);
    caixa.hidden = false;
    $("u-det-titulo").textContent = `${UF_NOME[uUF] || uUF} (${uUF})`;
    $("u-det-sub").textContent = x ? `${fmt(x.atr)} atrasados de ${fmt(x.ab)} pedidos em aberto · ${pctBR(x.pct)} de atraso` : "Nenhum pedido em aberto neste estado com esses filtros.";
    const porT = new Map(), porC = new Map();
    L.forEach((r) => {
      const t = r.transp || "(sem transportadora)", a = porT.get(t) || { n: t, ab: 0, atr: 0, series: new Set() }; a.ab++; if (r._atraso) a.atr++; if (r.serie) a.series.add(r.serie); porT.set(t, a);
      const c = r.cidade || "(sem cidade)", b = porC.get(c) || { n: c, ab: 0, atr: 0 }; b.ab++; if (r._atraso) b.atr++; porC.set(c, b);
    });
    const ord = (a, b) => b.atr - a.atr || b.ab - a.ab;
    $("u-det-transp").innerHTML = [...porT.values()].sort(ord).map((a) => `<tr><td>${esc(a.n)}</td><td>${[...a.series].sort((p, q) => p.localeCompare(q, "pt-BR", { numeric: true })).map(esc).join(", ") || "—"}</td>
      <td class="num">${fmt(a.ab)}</td><td class="num txt-vermelho">${fmt(a.atr)}</td><td class="num">${pctBR(a.atr / a.ab)}</td></tr>`).join("") || `<tr><td colspan="5" class="s">Nenhum pedido.</td></tr>`;
    $("u-det-cidades").innerHTML = [...porC.values()].sort(ord).map((b) => `<tr><td>${esc(b.n)}</td><td class="num">${fmt(b.ab)}</td><td class="num txt-vermelho">${fmt(b.atr)}</td><td class="num">${pctBR(b.atr / b.ab)}</td></tr>`).join("") || `<tr><td colspan="4" class="s">Nenhum pedido.</td></tr>`;
    uAtrasadosUF = L.filter((r) => r._atraso);
    if (rolar) caixa.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function escolherUF(u) { uUF = uUF === u ? null : u; if (uModo === "mapa") (uForma === "mapa" ? desenharMapaBR : desenharQuadrados)(); else desenharRankingUF(); desenharDetalheUF(!!uUF); }
  $("u-mapa").addEventListener("click", (e) => { const el = e.target.closest("[data-uf]"); if (el) escolherUF(el.dataset.uf); });
  $("u-ranking").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-uf]"); if (tr) escolherUF(tr.dataset.uf); });
  $("u-forma").addEventListener("click", (e) => { const b = e.target.closest("button[data-f]"); if (!b) return; uForma = b.dataset.f;
    $("u-forma").querySelectorAll("button").forEach((x) => x.classList.toggle("ativo", x === b)); desenharUF(); });
  $("u-modo").addEventListener("click", (e) => { const b = e.target.closest("button[data-m]"); if (!b) return; uModo = b.dataset.m;
    $("u-modo").querySelectorAll("button").forEach((x) => x.classList.toggle("ativo", x === b)); desenharUF(); });
  $("u-ranking-exportar").addEventListener("click", () => {
    const linhas = [["UF", "Estado", "Em aberto", "Atrasados", "% atraso", "Transportadora com mais atrasos", "Atrasados dela"]]
      .concat([...uDados.values()].sort((a, b) => b.atr - a.atr).map((x) => [x.uf, UF_NOME[x.uf] || x.uf, x.ab, x.atr, Math.round(x.pct * 1000) / 10 + "%", x.pior ? x.pior[0] : "", x.pior ? x.pior[1] : ""]));
    const ws = XLSX.utils.aoa_to_sheet(linhas); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Atrasos por UF");
    XLSX.writeFile(wb, `atrasos_por_uf_${hojeISO()}.xlsx`);
  });
  $("u-det-exportar").addEventListener("click", () => {
    if (!uAtrasadosUF.length) return toast("Nenhum atrasado neste estado.", true);
    const linhas = [["Pedido", "NF", "Série", "Canal", "Transportadora", "UF", "Cidade", "Micro status", "Criado", "Despacho", "Prometido", "Dias de atraso"]]
      .concat(uAtrasadosUF.map((r) => [r.pedido, r.nf, r.serie, r.canal, r.transp, r.uf, r.cidade, r.micro, br(r.criado), br(r.despacho), br(r._prom), r._atraso]));
    const ws = XLSX.utils.aoa_to_sheet(linhas); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Atrasados " + uUF);
    XLSX.writeFile(wb, `atrasados_${uUF}_${hojeISO()}.xlsx`);
  });

  // ---------------- alterar pedidos: nova previsão de entrega na Intelipost ----------------
  // A tela confere a lista e grava na fila (fila_intelipost). O robô da Intelipost (GitHub Actions)
  // altera a data (hora 23:59) e grava o resultado. Datas sempre lidas como dia/mês/ano.
  let apFila = [], apMostrar = 200, apProntos = [], apCarregadoEm = 0;
  const AP_ST = { pendente: ["Na fila", "cinza"], processando: ["Alterando…", "ambar"], alterado: ["Alterado", "verde"], erro: ["Não alterou", "vermelho"] };
  function dataBR(txt) {
    const t = String(txt || "").trim();
    let m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})$/), d, me, a;
    if (m) { d = +m[1]; me = +m[2]; a = +m[3]; if (a < 100) a += 2000; }
    else if ((m = t.match(/^(\d{4})-(\d{2})-(\d{2})/))) { a = +m[1]; me = +m[2]; d = +m[3]; }
    else return null;
    const dt = new Date(Date.UTC(a, me - 1, d));
    if (dt.getUTCFullYear() !== a || dt.getUTCMonth() !== me - 1 || dt.getUTCDate() !== d) return null;
    return dt.toISOString().slice(0, 10);
  }
  // confere o texto: devolve os prontos e os problemas (com o motivo)
  function conferirAlterar(texto) {
    const hoje = hojeISO(), limite = somaDias(hoje, 180), porPedido = new Map(), problemas = [];
    texto.split(/\r?\n/).forEach((linha, i) => {
      const l = linha.trim(); if (!l) return;
      const partes = l.split(/[\s;,]+/).filter(Boolean), pedido = partes[0];
      const resto = partes.slice(1);
      if (!resto.length) return problemas.push({ linha: i + 1, pedido, motivo: "sem data" });
      const iso = dataBR(resto[resto.length - 1]);
      if (!iso) return problemas.push({ linha: i + 1, pedido, motivo: `data "${resto[resto.length - 1]}" não dá para ler (use dia/mês/ano)` });
      if (iso < hoje) return problemas.push({ linha: i + 1, pedido, motivo: `data ${br(iso)} já passou` });
      if (iso > limite) return problemas.push({ linha: i + 1, pedido, motivo: `data ${br(iso)} está a mais de 6 meses (confira o ano)` });
      const x = porPedido.get(pedido) || { pedido, datas: new Set(), linhas: [] }; x.datas.add(iso); x.linhas.push(i + 1); porPedido.set(pedido, x);
    });
    const prontos = [];
    porPedido.forEach((x) => {
      if (x.datas.size > 1) problemas.push({ linha: x.linhas.join(", "), pedido: x.pedido, motivo: `o mesmo pedido com ${x.datas.size} datas diferentes (${[...x.datas].map(br).join(" e ")})` });
      else prontos.push({ pedido: x.pedido, nova_data: [...x.datas][0] });
    });
    return { prontos, problemas };
  }
  function mostrarConferencia() {
    const { prontos, problemas } = conferirAlterar($("ap-texto").value);
    apProntos = prontos;
    const caixa = $("ap-conf");
    caixa.hidden = !prontos.length && !problemas.length;
    const naBase = new Set((gDados || []).map((r) => r.pedido));
    const foraBase = naBase.size ? prontos.filter((p) => !naBase.has(p.pedido)).length : 0;
    caixa.innerHTML = `<p><b class="txt-verde">${fmt(prontos.length)} pronto${prontos.length === 1 ? "" : "s"} para alterar</b>${problemas.length ? ` · <b class="txt-vermelho">${fmt(problemas.length)} fora (não vão para o robô)</b>` : ""}${foraBase ? ` · <span class="s">${fmt(foraBase)} não estão na base atual (vão mesmo assim)</span>` : ""}</p>`
      + (problemas.length ? `<ul>${problemas.slice(0, 50).map((p) => `<li>Linha ${esc(String(p.linha))}: <b>${esc(p.pedido || "")}</b> — ${esc(p.motivo)}</li>`).join("")}${problemas.length > 50 ? `<li>… e mais ${fmt(problemas.length - 50)}</li>` : ""}</ul>` : "");
    $("ap-enviar").disabled = !prontos.length;
  }
  let esperaAp; $("ap-texto").addEventListener("input", () => { clearTimeout(esperaAp); esperaAp = setTimeout(mostrarConferencia, 250); });
  $("ap-enviar").addEventListener("click", async () => {
    if (!apProntos.length) return;
    if (!confirm(`${fmt(apProntos.length)} pedido${apProntos.length === 1 ? "" : "s"} vão para o robô alterar a previsão de entrega na Intelipost (hora 23:59).\n\nConfirmar?`)) return;
    const bt = $("ap-enviar"); bt.disabled = true; bt.textContent = "Mandando…";
    try {
      for (let i = 0; i < apProntos.length; i += 500) {
        const { error } = await sb.rpc("enfileirar_intelipost", { linhas: apProntos.slice(i, i + 500) });
        if (error) throw error;
      }
      toast(`${fmt(apProntos.length)} pedido(s) na fila do robô.`);
      $("ap-texto").value = ""; mostrarConferencia(); await carregarAlterar(true);
    } catch (err) {
      toast("Não consegui mandar: " + (err.message || err) + (/fila_intelipost|enfileirar/i.test(err.message || "") ? " (rode de novo o supabase/schema.sql)" : ""), true);
    } finally { bt.textContent = "➤ Alterar na Intelipost"; bt.disabled = !apProntos.length; }
  });
  // planilha: colunas "Pedido" e "Nova data" (ou as duas primeiras). Vira texto na caixa para passar pela mesma conferência.
  $("ap-arquivo").addEventListener("change", async (e) => {
    const arq = e.target.files[0]; e.target.value = ""; if (!arq) return;
    try {
      const wb = XLSX.read(await arq.arrayBuffer(), { type: "array", raw: true });
      const linhas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: "" });
      if (!linhas.length) return toast("A planilha está vazia.", true);
      const cab = linhas[0].map((c) => norm(c));
      let iP = cab.findIndex((c) => c.startsWith("PEDIDO")), iD = cab.findIndex((c) => c.includes("DATA"));
      let corpo = linhas.slice(1);
      if (iP < 0 || iD < 0) { iP = 0; iD = 1; corpo = linhas; }
      const txt = corpo.map((l) => {
        const p = String(l[iP] ?? "").trim(), v = l[iD];
        if (!p) return "";
        let d = "";
        if (typeof v === "number") { const c = XLSX.SSF.parse_date_code(v); if (c) d = `${String(c.d).padStart(2, "0")}/${String(c.m).padStart(2, "0")}/${c.y}`; }
        else if (v instanceof Date) d = br(v.toISOString());
        else d = String(v ?? "").trim();
        return `${p} ${d}`.trim();
      }).filter(Boolean).join("\n");
      $("ap-texto").value = ($("ap-texto").value.trim() ? $("ap-texto").value.trim() + "\n" : "") + txt;
      mostrarConferencia();
      toast(`${arq.name}: ${fmt(txt.split("\n").filter(Boolean).length)} linha(s) lidas. Confira e clique em Alterar na Intelipost.`);
    } catch (err) { toast("Não consegui ler a planilha: " + (err.message || err), true); }
  });
  $("ap-modelo").addEventListener("click", () => {
    const ws = XLSX.utils.aoa_to_sheet([["Pedido", "Nova data"], ["MAGAZINE_LUIZA1234567890123456", "27/11/2026"]]);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Nova previsão"); XLSX.writeFile(wb, "modelo_nova_previsao.xlsx");
  });
  async function carregarAlterar(forcar) {
    if (!forcar && Date.now() - apCarregadoEm < 20000) return desenharAlterar();
    try {
      const [lista, est] = await Promise.all([buscarTudo("fila_intelipost", "pedido"), sb.from("robo_estado").select("*").eq("nome", "intelipost").limit(1)]);
      apFila = lista; apCarregadoEm = Date.now();
      const e = est && est.data && est.data[0] && est.data[0].valor;
      $("ap-robo-alerta").hidden = !(e && e.tipo === "erro");
      if (e && e.tipo === "erro") { $("ap-robo-titulo").textContent = e.titulo || "O robô da Intelipost parou."; $("ap-robo-texto").textContent = (e.msg || "") + (est.data[0].atualizado_em ? ` (${new Date(est.data[0].atualizado_em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })})` : ""); }
    } catch (err) {
      $("ap-vazio").hidden = false;
      $("ap-vazio").textContent = /fila_intelipost|robo_estado|does not exist|schema cache/i.test(err.message || "") ? "Para usar esta aba, rode de novo o supabase/schema.sql no Supabase." : "Não consegui carregar: " + (err.message || err);
      return;
    }
    desenharAlterar();
  }
  function desenharAlterar() {
    const q = norm($("ap-busca").value);
    const L = apFila.filter((r) => !q || norm(r.pedido).includes(q)).sort((a, b) => String(b.feito_em || b.pedido_em).localeCompare(String(a.feito_em || a.pedido_em)));
    const cont = {}; apFila.forEach((r) => (cont[r.status] = (cont[r.status] || 0) + 1));
    $("ap-resumo").innerHTML = Object.keys(AP_ST).filter((k) => cont[k]).map((k) => `<span class="chip ${AP_ST[k][1]}">${fmt(cont[k])} · ${AP_ST[k][0]}</span>`).join(" ");
    const quando = (t) => (t ? new Date(t).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");
    $("ap-linhas").innerHTML = L.slice(0, apMostrar).map((r) => { const [n, c] = AP_ST[r.status] || [r.status, "cinza"];
      return `<tr><td class="mono">${esc(r.pedido)}</td><td>${br(r.nova_data)}</td><td><span class="chip ${c}">${esc(n)}</span>${r.motivo ? `<div class="s txt-vermelho">${esc(r.motivo)}</div>` : ""}</td>
        <td class="s">${quando(r.pedido_em)}${r.pedido_por ? " · " + esc(r.pedido_por) : ""}</td><td class="s">${quando(r.feito_em) || "—"}</td></tr>`; }).join("");
    $("ap-vazio").hidden = L.length > 0; if (!L.length) $("ap-vazio").textContent = apFila.length ? "Nenhum pedido com essa busca." : "Nenhum pedido mandado para o robô ainda.";
    $("ap-mais").hidden = L.length <= apMostrar;
  }
  $("ap-busca").addEventListener("input", () => { apMostrar = 200; desenharAlterar(); });
  $("ap-mais").addEventListener("click", () => { apMostrar += 200; desenharAlterar(); });
  $("ap-baixar").addEventListener("click", () => {
    if (!apFila.length) return toast("Nada para exportar.", true);
    const linhas = [["Pedido", "Nova data", "Situação", "Motivo", "Pedido em", "Pedido por", "Feito em"]].concat(apFila.map((r) =>
      [r.pedido, br(r.nova_data), (AP_ST[r.status] || [r.status])[0], r.motivo || "", r.pedido_em ? new Date(r.pedido_em).toLocaleString("pt-BR") : "", r.pedido_por || "", r.feito_em ? new Date(r.feito_em).toLocaleString("pt-BR") : ""]));
    const ws = XLSX.utils.aoa_to_sheet(linhas); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Robô Intelipost");
    XLSX.writeFile(wb, `alterar_pedidos_${hojeISO()}.xlsx`);
  });
  $("ap-abas").addEventListener("click", (e) => { const b = e.target.closest("button[data-ap]"); if (!b) return;
    $("ap-abas").querySelectorAll("button").forEach((x) => { const at = x === b; x.classList.toggle("amarelo", at); x.classList.toggle("contorno", !at); });
    $("ap-sec-data").hidden = b.dataset.ap !== "data"; $("ap-sec-troca").hidden = b.dataset.ap !== "troca"; $("ap-sec-ag").hidden = !["ag", "at"].includes(b.dataset.ap);
    if (b.dataset.ap === "troca") carregarTrocas();
    if (b.dataset.ap === "ag" || b.dataset.ap === "at") { agFila = b.dataset.ap === "at" ? "AT" : "AE"; agCard = "tratar"; agBusca = ""; $("ag-busca").value = "";
      $("ag-h2").textContent = agFila === "AT" ? "Aguardando entrega AT" : "Fila Aguardando entrega";
      $("ag-qual").textContent = `Suba o relatório de tickets da fila "${agFila === "AT" ? "Aguardando entrega (AT)" : "Aguardando entrega"}" do Multi360.`;
      $("ag-linhas").innerHTML = ""; carregarAguardando(); } });
  setInterval(() => { if (paginaAtual === "alterar" && !document.hidden) carregarAlterar(true); }, 60000);

  // ---------------- troca de notas (reposição TOTAL e PARCIAL) ----------------
  // Planilha detalhamento_tickets, aba Reposições: fila "Ajuste de dados na Intelipost" + Tipo de reposição "Total" ou "Parcial".
  // Parcial = mesmo passo a passo, sem a etapa 4 (volumes).
  // Método na Intelipost = DE × PARA (troca-notas.js) pela transportadora do Promob (redespacho primeiro) e pela série da nova NF.
  const TN_ETAPAS = ["Transportadora trocada na Intelipost (método pelo DE × PARA)", "Simulação de cotação feita (prazo em dias úteis)",
    "Entrega prev. atualizada (23:59)", "Volumes editados — TODOS os volumes", "Status: Macro 12 · Micro 920 · Equipe_04 Troca de notas",
    "Print no ticket + Executar ação no ticket", "Conferido: ticket na fila Aguardando entrega"];
  let tnLista = [], tnInfo = null, tnCard = "fazer", tnAberto = null, tnCarregado = false;
  const meuEmail = () => ($("usuario").textContent || "").trim();
  const tnMetodo = (t) => {
    if (t.metodo_manual) { const r = TROCA.DEPARA.find((x) => x.metodo === t.metodo_manual); return r ? { ok: r, manual: true } : { erro: "Método escolhido não está mais no DE × PARA." }; }
    if (String(t.transp_promob || "").startsWith("!")) return { erro: t.transp_promob.slice(1) };
    return TROCA.metodoPara(t.transp_promob, t.serie);
  };
  const tnParcial = (t) => t.tipo === "PARCIAL";
  // NF original (Nota ticket) de série 4: a Intelipost não reconhece -> nada na Intelipost, só a ação no ticket (regra da Logística)
  const tnSerie4 = (t) => /-\s*0*4\s*$/.test(String(t.nf_ticket || ""));
  const tnPula = (t, n) => (tnSerie4(t) && n <= 5) || (tnParcial(t) && n === 4);   // parcial não mexe nos volumes
  const tnPorque = (t) => tnSerie4(t) ? "NF série 4" : "Parcial";
  const tnTam = (t) => TN_ETAPAS.filter((_, i) => !tnPula(t, i + 1)).length;
  const tnFeitas = (t) => TN_ETAPAS.filter((_, i) => !tnPula(t, i + 1) && t.etapas && t.etapas[i + 1]).length;
  let tnTipo = "";
  const tnDoTipo = (t) => !tnTipo || (tnTipo === "PARCIAL") === tnParcial(t);
  const TN_CARD = {
    fazer: (t) => t.na_planilha && !t.responsavel && tnFeitas(t) < tnTam(t),
    andamento: (t) => t.responsavel && tnFeitas(t) < tnTam(t),
    feitos: (t) => tnFeitas(t) === tnTam(t),
    problema: (t) => t.na_planilha && tnFeitas(t) < tnTam(t) && !tnMetodo(t).ok && !tnSerie4(t),
  };
  const TN_NOME = { fazer: "A fazer", andamento: "Em andamento", feitos: "Concluídos", problema: "Sem método (DE × PARA não casou)" };
  async function carregarTrocas() {
    try {
      const [lista, inf] = await Promise.all([buscarTudo("troca_notas", "ticket"), sb.from("troca_notas_info").select("*").limit(1)]);
      tnLista = lista; tnInfo = (inf.data && inf.data[0]) || null; tnCarregado = true;
    } catch (err) {
      $("tn-info").textContent = /troca_notas|does not exist|schema cache/i.test(err.message || "") ? "Para usar a Troca de notas, rode de novo o supabase/schema.sql no Supabase." : "Não consegui carregar: " + (err.message || err);
      return;
    }
    desenharTrocas();
  }
  function desenharTrocas() {
    $("tn-info").textContent = tnInfo ? `${tnInfo.arquivo || "planilha"} · enviada em ${new Date(tnInfo.enviado_em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}${tnInfo.enviado_por ? " por " + tnInfo.enviado_por : ""} · ${fmt(tnInfo.linhas)} tickets na fila`
      : 'Suba o detalhamento_tickets ("Subir detalhamento_tickets") para trazer os tickets.';
    document.querySelectorAll("#tn-cards .kpi[data-tn]").forEach((b) => { b.querySelector(".kpi-num").textContent = fmt(tnLista.filter(tnDoTipo).filter(TN_CARD[b.dataset.tn]).length); b.classList.toggle("ativa", b.dataset.tn === tnCard); });
    const L = tnLista.filter(tnDoTipo).filter(TN_CARD[tnCard]).sort((a, b) => String(a.ticket).localeCompare(String(b.ticket), "pt-BR", { numeric: true }));
    $("tn-titulo").textContent = `${TN_NOME[tnCard]} (${fmt(L.length)})`;
    const eu = meuEmail();
    $("tn-linhas").innerHTML = L.map((t) => {
      const m = tnMetodo(t), feitas = tnFeitas(t), aberto = tnAberto === t.ticket;
      const met = m.ok ? `<b>${esc(m.ok.metodo)}</b>${m.manual ? ' <span class="chip cinza">escolhido</span>' : ""}` : `<span class="txt-vermelho">⚠ ${esc(m.erro)}</span>`;
      const quem = t.responsavel ? `<span class="chip ${t.responsavel === eu ? "ambar" : "cinza"}">${esc(t.responsavel.split("@")[0])}</span> <button class="btn mini contorno" data-voltar="${esc(t.ticket)}" title="Tira o ticket de Em andamento e volta para A fazer (o erro do robô continua aparecendo)">↩ A fazer</button>` : `<button class="btn mini" data-pegar="${esc(t.ticket)}">Pegar</button>`;
      const errRobo = t.robo_status === "erro" ? `<div class="tn-err-linha txt-vermelho">⚠ ${esc(String(t.robo_msg || "O robô não conseguiu.").slice(0, 140))}</div>` : "";
      return `<tr class="clicavel${aberto ? " aberta" : ""}" data-tn-abrir="${esc(t.ticket)}"><td>${esc(t.ticket)}</td><td><span class="chip ${tnParcial(t) ? "azul" : "cinza"}">${tnParcial(t) ? "Parcial" : "Total"}</span></td><td class="mono">${esc(t.pedido)}</td><td>${esc(t.nf_nova || "—")}</td><td>${esc(String(t.transp_promob || "").replace(/^!.*/, "—"))}</td><td>${met}</td>
        <td><span class="chip ${feitas === tnTam(t) ? "verde" : feitas ? "ambar" : "cinza"}">${feitas}/${tnTam(t)}</span>${errRobo}</td><td class="tn-quem">${quem}</td></tr>`
        + (aberto ? `<tr class="tn-detalhe"><td colspan="8">${detalheTroca(t, m)}</td></tr>` : "");
    }).join("");
    $("tn-vazio").hidden = L.length > 0;
  }
  function detalheTroca(t, m) {
    const [num, ser] = String(t.nf_nova || "").split("-");
    const copiar = (rot, v) => `<div class="tn-campo"><span>${rot}</span><b>${esc(v || "—")}</b>${v ? `<button class="link" data-copiar="${esc(v)}">copiar</button>` : ""}</div>`;
    const opcoes = m.opcoes || (!m.ok && t.transp_promob && !String(t.transp_promob).startsWith("!") ? TROCA.DEPARA : null);
    const escolha = (!m.ok || m.manual) ? `<label class="tn-escolha">Escolher o método na mão: <select data-metodo="${esc(t.ticket)}"><option value="">—</option>${(opcoes || TROCA.DEPARA).map((r) => `<option ${t.metodo_manual === r.metodo ? "selected" : ""}>${esc(r.metodo)}</option>`).join("")}</select></label>` : "";
    const hoje = hojeISO();
    return `<div class="tn-grade">
      <div><h3>Para digitar na Intelipost</h3>
        ${copiar("Pedido (Busca por Lote)", t.pedido)}
        ${copiar("Método de entrega", m.ok ? m.ok.metodo : "")}
        ${tnParcial(t) ? copiar("Nova NF (para a série)", t.nf_nova) : `${copiar("Código de rastreamento", num)}${copiar("Nota", num)}${copiar("Série", ser || t.serie)}
        ${copiar("Chave da Nota Fiscal", t.chave)}${copiar("Data da Nota Fiscal", br(t.data_emissao))}`}
        <p class="s">Transportadora no Promob: ${esc(String(t.transp_promob || "").replace(/^!/, ""))} · série ${esc(t.serie || "?")}${tnParcial(t) ? " · <b>Parcial: não altere os volumes</b>" : t.linhas > 1 ? ` · <b>${t.linhas} linhas na planilha: confira se o pedido tem mais de 1 volume e altere TODOS</b>` : ""}</p>
        ${escolha}
      </div>
      <div><h3>Robô na Intelipost</h3>
        ${tnRoboInfo(t)}
        <div class="tn-robo-bts">
          <button class="btn contorno" data-robo-troca="teste" data-tk="${esc(t.ticket)}" ${(!m.ok && !tnSerie4(t)) || /pendente|processando/.test(t.robo_status || "") ? "disabled" : ""}>Testar com o robô (não salva)</button>
          <button class="btn" data-robo-troca="real" data-tk="${esc(t.ticket)}" ${(!m.ok && !tnSerie4(t)) || /pendente|processando/.test(t.robo_status || "") ? "disabled" : ""}>Fazer com o robô</button>
        </div>
        <p class="s">O robô faz a simulação de cotação na Intelipost e pega o prazo sozinho. Só digite o prazo abaixo se quiser usar outro.</p>
        ${tnSerie4(t) ? '<p class="tn-robo ambar"><b>NF original série 4:</b> a Intelipost não reconhece essa série. Não altere nada na Intelipost; o robô só faz, no Multi360, o print do rastreio + Executar ação no ticket.</p>' : ""}
        <p class="s">${tnParcial(t) ? "Parcial: o robô troca transportadora e método, faz a simulação de cotação, a Entrega prev. 23:59, o status Micro 920 (não mexe nos volumes) e executa a ação no ticket do Multi360." : "O robô faz as 7 etapas: transportadora e método, simulação de cotação, Entrega prev. 23:59, todos os volumes, status Micro 920 e, no Multi360, o print + Executar ação no ticket e a conferência da fila."} Ele passa de 30 em 30 minutos.</p>
        <h3 class="tn-mao">Ou na mão: prazo da cotação → nova data</h3>
        <label class="tn-prazo">Prazo de entrega da simulação (dias úteis) <input type="number" min="1" max="60" data-prazo="${esc(t.ticket)}"></label>
        <p class="tn-data" id="tn-data-${esc(t.ticket)}">Digite o prazo para calcular.</p>
        <p class="s">Conta só sábado e domingo; feriado não entra (muda por estado e cidade) — confira se cair perto de feriado.</p>
        <button class="btn contorno" data-robo="${esc(t.ticket)}" disabled>Mandar a data para o robô</button>
      </div>
      <div><h3>Etapas</h3>
        ${TN_ETAPAS.map((e, i) => { if (tnPula(t, i + 1)) return `<label class="tn-etapa tn-na"><input type="checkbox" disabled> <span>${i + 1}. ${esc(e)} — não se aplica (${tnPorque(t)})</span></label>`; const x = t.etapas && t.etapas[i + 1]; return `<label class="tn-etapa"><input type="checkbox" data-etapa="${i + 1}" data-tk="${esc(t.ticket)}" ${x ? "checked" : ""}> <span>${i + 1}. ${esc(e)}</span>${x ? `<em>${esc(String(x.por || "").split("@")[0])} · ${new Date(x.em).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</em>` : ""}</label>`; }).join("")}
        ${t.responsavel ? `<p class="s">Com ${esc(t.responsavel)} desde ${new Date(t.pego_em || t.atualizado_em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}${t.responsavel === meuEmail() ? ' · <button class="link" data-soltar="' + esc(t.ticket) + '">soltar</button>' : ""}</p>` : `<button class="btn mini" data-pegar="${esc(t.ticket)}">Pegar este ticket</button>`}
      </div></div>`;
  }
  function tnRoboInfo(t) {
    const quando = (d) => d ? new Date(d).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
    const modo = t.robo_modo === "real" ? "de verdade" : "em teste";
    const dt = t.prazo_dias ? ` Prazo da simulação: <b>${t.prazo_dias} dias úteis</b>${t.nova_data ? ` → Entrega prev. <b>${br(t.nova_data)} 23:59</b>` : ""}.` : "";
    const vol = t.robo_passos && t.robo_passos.volumes ? ` ${t.robo_passos.volumes} volume(s).` : "";
    switch (t.robo_status) {
      case "pendente": return `<p class="tn-robo ambar">Na fila do robô (${modo}) desde ${quando(t.robo_pedido_em)}.</p>`;
      case "processando": return `<p class="tn-robo ambar">O robô está fazendo agora (${modo}).</p>`;
      case "testado": return `<p class="tn-robo verde">Teste ok em ${quando(t.robo_feito_em)}: o robô preencheu tudo e não salvou.${dt}${vol}</p>`;
      case "feito": return `<p class="tn-robo verde">Feito pelo robô em ${quando(t.robo_feito_em)}.${dt}${vol} ${t.etapas && t.etapas[7] ? "" : "Confira as etapas 6 e 7 (ticket)."}</p>`;
      case "erro": return `<p class="tn-robo vermelho">⚠ ${esc(t.robo_msg || "O robô não conseguiu.")}${t.robo_modo === "real" && t.robo_passos && Object.keys(t.robo_passos).some((k) => /^[1-5]$/.test(k)) ? ` Já tinha feito: etapa(s) ${Object.keys(t.robo_passos).filter((k) => /^[1-5]$/.test(k)).join(", ")}.` : ""}</p>`;
      default: return "";
    }
  }
  async function salvarTroca(ticket, campos) {
    const { data, error } = await sb.from("troca_notas").update(campos).eq("ticket", ticket).select();
    if (error) { toast("Não consegui salvar: " + error.message, true); return false; }
    const i = tnLista.findIndex((x) => x.ticket === ticket); if (i >= 0 && data && data[0]) tnLista[i] = data[0];
    desenharTrocas(); return true;
  }
  $("tn-tipo").addEventListener("change", (e) => { tnTipo = e.target.value; tnAberto = null; desenharTrocas(); });
  $("tn-cards").addEventListener("click", (e) => { const b = e.target.closest(".kpi[data-tn]"); if (!b) return; tnCard = b.dataset.tn; tnAberto = null; desenharTrocas(); });
  $("tn-linhas").addEventListener("click", async (e) => {
    const cp = e.target.closest("[data-copiar]"); if (cp) { e.stopPropagation(); try { await navigator.clipboard.writeText(cp.dataset.copiar); toast("Copiado."); } catch (_) { toast("Não consegui copiar.", true); } return; }
    const pg = e.target.closest("[data-pegar]"); if (pg) { e.stopPropagation(); const t = tnLista.find((x) => x.ticket === pg.dataset.pegar);
      if (t && t.responsavel && t.responsavel !== meuEmail()) return toast(`${t.responsavel} já pegou este ticket.`, true);
      await salvarTroca(pg.dataset.pegar, { responsavel: meuEmail(), pego_em: new Date().toISOString() }); return; }
    const vt = e.target.closest("[data-voltar]"); if (vt) { e.stopPropagation(); const t = tnLista.find((x) => x.ticket === vt.dataset.voltar); if (!t) return;
      if (!confirm(`Tirar o ticket ${t.ticket} de Em andamento (com ${String(t.responsavel || "").split("@")[0]}) e voltar para A fazer?\n\nAs etapas marcadas e o aviso do robô continuam.`)) return;
      if (await salvarTroca(t.ticket, { responsavel: null, pego_em: null })) toast(`Ticket ${t.ticket} voltou para A fazer.`); return; }
    const so = e.target.closest("[data-soltar]"); if (so) { e.stopPropagation(); await salvarTroca(so.dataset.soltar, { responsavel: null, pego_em: null }); return; }
    const rt = e.target.closest("[data-robo-troca]"); if (rt) { e.stopPropagation(); const t = tnLista.find((x) => x.ticket === rt.dataset.tk), m = t && tnMetodo(t); if (!t || (!m.ok && !tnSerie4(t))) return;
      const real = rt.dataset.roboTroca === "real";
      if (tnSerie4(t)) {   // série 4: só o ticket
        if (real && !confirm(`NF original série 4 (pedido ${t.pedido}): nada será alterado na Intelipost.\n\nO robô só vai, no Multi360, anexar o print do rastreio + Executar ação no ticket ("Pedido atualizado na Intelipost" → Sim) e conferir a fila Aguardando entrega.\n\nConfirmar?`)) return;
        const { error } = await sb.rpc("pedir_robo_troca", { tk: t.ticket, metodo: m.ok ? m.ok.metodo : "série 4", transp: m.ok ? m.ok.transp : "série 4", modo: real ? "real" : "teste", prazo: null });
        if (error) return toast("Não consegui mandar: " + error.message, true);
        toast(real ? "Mandado para o robô (só o ticket)." : "Mandado para o robô testar (não salva nada).");
        await carregarTrocas(); return;
      }
      const pz = parseInt((document.querySelector(`input[data-prazo="${CSS.escape(t.ticket)}"]`) || {}).value, 10), prazo = pz > 0 && pz <= 60 ? pz : null;
      if (real && !confirm(`O robô vai fazer na Intelipost, de verdade, o pedido ${t.pedido}:\n\n• transportadora ${m.ok.transp} · método ${m.ok.metodo}${prazo ? `\n• prazo que você digitou: ${prazo} dias úteis → Entrega prev. ${br(TROCA.somaDiasUteis(hojeISO(), prazo))} 23:59 (sem simulação)` : "\n• simulação de cotação e Entrega prev. 23:59"}${tnParcial(t) ? "\n• volumes: não mexe (Parcial)" : `\n• todos os volumes com a nota ${t.nf_nova}`}\n• status Macro 12 · Micro 920 · Equipe_04 Troca de notas\n• no Multi360: print do rastreio + Executar ação ("Pedido atualizado na Intelipost" → Sim)\n\nConfirmar?`)) return;
      const { error } = await sb.rpc("pedir_robo_troca", { tk: t.ticket, metodo: m.ok.metodo, transp: m.ok.transp, modo: real ? "real" : "teste", prazo });
      if (error) return toast(/pedir_robo_troca|schema cache/i.test(error.message) ? "Rode de novo o supabase/schema.sql (parte 18) para usar o robô da troca." : "Não consegui mandar: " + error.message, true);
      toast(real ? "Mandado para o robô fazer na Intelipost." : "Mandado para o robô testar (não salva nada).");
      await carregarTrocas(); return; }
    const rb = e.target.closest("[data-robo]"); if (rb) { e.stopPropagation(); const t = tnLista.find((x) => x.ticket === rb.dataset.robo), iso = rb.dataset.iso; if (!t || !iso) return;
      if (!confirm(`O robô vai mudar a Entrega prev. do pedido ${t.pedido} para ${br(iso)} 23:59 na Intelipost.\n\nFaça isso depois de trocar a transportadora. Confirmar?`)) return;
      const { error } = await sb.rpc("enfileirar_intelipost", { linhas: [{ pedido: t.pedido, nova_data: iso }] });
      if (error) return toast("Não consegui mandar: " + error.message, true);
      toast("Mandado para o robô. Acompanhe em Nova previsão de entrega."); return; }
    if (e.target.closest(".tn-detalhe")) return;
    const tr = e.target.closest("tr[data-tn-abrir]"); if (!tr) return;
    tnAberto = tnAberto === tr.dataset.tnAbrir ? null : tr.dataset.tnAbrir; desenharTrocas();
  });
  $("tn-linhas").addEventListener("change", async (e) => {
    const cb = e.target.closest("input[data-etapa]");
    if (cb) { const t = tnLista.find((x) => x.ticket === cb.dataset.tk); if (!t) return;
      const et = { ...(t.etapas || {}) }; if (cb.checked) et[cb.dataset.etapa] = { por: meuEmail(), em: new Date().toISOString() }; else delete et[cb.dataset.etapa];
      const completo = TN_ETAPAS.every((_, i) => tnPula(t, i + 1) || et[i + 1]);
      const campos = { etapas: et, concluido_em: completo ? new Date().toISOString() : null };
      if (!t.responsavel) { campos.responsavel = meuEmail(); campos.pego_em = new Date().toISOString(); }
      await salvarTroca(t.ticket, campos); return; }
    const sel = e.target.closest("select[data-metodo]"); if (sel) { await salvarTroca(sel.dataset.metodo, { metodo_manual: sel.value || null }); return; }
  });
  $("tn-linhas").addEventListener("input", (e) => {
    const inp = e.target.closest("input[data-prazo]"); if (!inp) return;
    const n = parseInt(inp.value, 10), tk = inp.dataset.prazo, bt = document.querySelector(`[data-robo="${CSS.escape(tk)}"]`), out = document.getElementById("tn-data-" + tk);
    if (!(n > 0 && n <= 60)) { out.textContent = "Digite o prazo para calcular."; bt.disabled = true; return; }
    const iso = TROCA.somaDiasUteis(hojeISO(), n);
    out.innerHTML = `Nova Entrega prev.: <b>${br(iso)} 23:59</b> <button class="link" data-copiar="${br(iso)} 23:59">copiar</button>`;
    bt.dataset.iso = iso; bt.disabled = false;
  });
  // leitura da aba Reposições
  $("tn-arquivo").addEventListener("change", async (e) => {
    const arq = e.target.files[0]; e.target.value = ""; if (!arq) return;
    carregando("Lendo a aba Reposições…"); await new Promise((r) => setTimeout(r, 50));
    let itens = [], totalFila = 0, outros = 0;
    try {
      const wb = XLSX.read(await arq.arrayBuffer(), { type: "array", dense: true, cellDates: true });
      const aba = wb.SheetNames.find((n) => norm(n).startsWith("REPOSI"));
      if (!aba) throw new Error('Não achei a aba "Reposições" nessa planilha.');
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[aba], { header: 1, raw: true, defval: null });
      const iCab = rows.findIndex((r) => r && r.some((c) => norm(c) === "ID TICKET"));
      if (iCab < 0) throw new Error('Não achei a coluna "ID Ticket" na aba Reposições.');
      const cab = rows[iCab].map(norm), col = (n) => cab.indexOf(n);
      const c = { tk: col("ID TICKET"), ped: col("ID INTELIPOST"), nft: col("NOTA TICKET"), fila: col("FILA ATUAL DO TICKET"), tipo: col("TIPO DE REPOSICAO"),
        nf: col("NF EMITIDA PROMOB"), chave: col("CHAVE ACESSO NF EMITIDA PROMOB"), dt: col("DATA EMISSAO PROMOB"), tn: col("TRANSP. NOTA REPOSICAO (PROMOB)"), tr: col("TRANSP. REDESPACHO NOTA REPOSICAO (PROMOB)") };
      for (const [k, v] of Object.entries(c)) if (v < 0) throw new Error(`Falta a coluna ${k === "tr" ? '"Transp. redespacho nota reposição (Promob)"' : k === "tn" ? '"Transp. nota reposição (Promob)"' : k === "dt" ? '"Data emissão Promob"' : k === "chave" ? '"Chave acesso NF emitida Promob"' : k === "nf" ? '"NF emitida Promob"' : k === "tipo" ? '"Tipo de reposição"' : k === "fila" ? '"Fila atual do ticket"' : k === "ped" ? '"ID Intelipost"' : k} na aba Reposições.`);
      const porTk = new Map();
      rows.slice(iCab + 1).forEach((r) => {
        if (!r || norm(r[c.fila]) !== "AJUSTE DE DADOS NA INTELIPOST") return;
        totalFila++;
        const tipo = norm(r[c.tipo]);
        if (tipo !== "TOTAL" && tipo !== "PARCIAL") { outros++; return; }
        const tk = String(r[c.tk] ?? "").trim(); if (!tk) return;
        const ant = porTk.get(tk); if (ant) { ant.linhas++; if (tipo === "TOTAL") ant.tipo = "TOTAL"; return; }
        const nf = String(r[c.nf] ?? "").trim(), serie = (nf.split("-")[1] || "").trim().replace(/^0+(?=\d)/, "");
        let dt = r[c.dt]; dt = dt instanceof Date ? dt.toISOString().slice(0, 10) : typeof dt === "number" ? (() => { const p = XLSX.SSF.parse_date_code(dt); return p ? `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}` : null; })() : dt ? dataBR(String(dt).slice(0, 10)) : null;
        const tp = TROCA.transpDaTroca(r[c.tr], r[c.tn]);
        porTk.set(tk, { ticket: tk, pedido: String(r[c.ped] ?? "").trim(), nf_ticket: String(r[c.nft] ?? "").trim(), nf_nova: nf, serie,
          chave: String(r[c.chave] ?? "").replace(/\D/g, ""), data_emissao: dt, transp_promob: tp.erro ? "!" + tp.erro : tp.nome, linhas: 1, tipo });
      });
      itens = [...porTk.values()];
    } catch (err) { carregando(""); toast(err.message, true); return; }
    carregando("");
    if (!confirm(`${arq.name}\n\nFila "Ajuste de dados na Intelipost": ${fmt(totalFila)} linha(s).\n${fmt(itens.filter((x) => x.tipo === "TOTAL").length)} ticket(s) Total e ${fmt(itens.filter((x) => x.tipo === "PARCIAL").length)} Parcial entram na Troca de notas${outros ? ` (${fmt(outros)} linha(s) sem tipo Total/Parcial ficam de fora)` : ""}.\n\nQuem pegou e as etapas marcadas continuam salvos. Enviar?`)) return;
    const { error } = await sb.rpc("importar_troca_notas", { itens, arquivo: arq.name });
    if (error) return toast("Erro ao enviar: " + error.message + (/importar_troca_notas|schema cache/i.test(error.message) ? " (rode de novo o supabase/schema.sql)" : ""), true);
    toast(`${fmt(itens.length)} ticket(s) na Troca de notas.`); await carregarTrocas();
  });
  $("tn-baixar").addEventListener("click", () => {
    const L = tnLista.filter(tnDoTipo).filter(TN_CARD[tnCard]); if (!L.length) return toast("Nada para exportar.", true);
    const linhas = [["Ticket", "Tipo", "Pedido", "NF do ticket", "Nova NF", "Série", "Chave", "Data emissão", "Transportadora (Promob)", "Método na Intelipost", "Etapas", "Quem pegou"]]
      .concat(L.map((t) => { const m = tnMetodo(t); return [t.ticket, tnParcial(t) ? "Parcial" : "Total", t.pedido, t.nf_ticket, t.nf_nova, t.serie, t.chave, br(t.data_emissao), String(t.transp_promob || "").replace(/^!/, ""), m.ok ? m.ok.metodo : "⚠ " + m.erro, `${tnFeitas(t)}/${tnTam(t)}`, t.responsavel || ""]; }));
    const ws = XLSX.utils.aoa_to_sheet(linhas); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Troca de notas");
    XLSX.writeFile(wb, `troca_de_notas_${hojeISO()}.xlsx`);
  });
  setInterval(() => { if (paginaAtual === "alterar" && !$("ap-sec-troca").hidden && !document.hidden && tnAberto === null) carregarTrocas(); }, 60000);

  // ---------------- Fila Aguardando entrega (relatório de tickets do Multi360) ----------------
  // O robô (modo "aguardando" do Robô do SSW) lê a nova NF no chat do ticket, confere no rastreio e dá a baixa ("Nota entregue?" → Sim).
  let agLista = [], agObs = new Map(), agInfo = null, agCard = "tratar", agBusca = "", agFila = "AE";   // AE = Aguardando entrega · AT = Aguardando entrega (AT)
  const agTransp = (t) => t.transp_chat || String(t.transportadora || "").split(" / ")[0] || "";
  function agGrupo(t) {
    if (t.baixa_status === "feita") return "baixa";
    if (t.baixa_status === "conferir" || t.baixa_status === "erro") return "conferir";
    if (t.situacao === "pendente" || t.situacao === "entregue") return "robo";
    if (t.insucesso) return "insucesso";
    if (t.situacao === "nao entregue" || t.situacao === "sem cte") return "tratar";
    return "conferir";
  }
  const AG_NOME = { tratar: "Não entregues — para tratar", insucesso: "Insucesso na entrega (vão para Ocorrências)", conferir: "Conferir à mão", baixa: "Entregues · baixa feita", robo: "Aguardando o robô", todos: "Todos" };
  function agStatus(t) {
    const ev = t.ultimo_evento ? esc(t.ultimo_evento) + (t.data_evento ? ` <span class="s">${br(t.data_evento)}</span>` : "") : "";
    const fonte = t.fonte ? `<div class="s">${esc(t.fonte)}</div>` : "";
    switch (t.situacao) {
      case "entregue": return `<span class="chip verde">Entregue${t.data_entrega ? " " + br(t.data_entrega) : ""}</span>${fonte}`;
      case "nao entregue": return `${t.insucesso ? `<span class="chip vermelho">${esc(t.insucesso)}</span><div class="s">${ev}</div>` : `<span class="chip ambar">Não entregue</span><div>${ev}</div>`}${fonte}`;
      case "sem cte": return `<span class="chip cinza">Sem CT-e ainda</span><div class="s">não achei a NF em nenhum rastreio</div>`;
      case "sem rastreio": return `<span class="chip cinza">Sem rastreio automático</span><div class="s">Transiga/Formato: ver no site</div>`;
      case "sem permissao": return `<span class="chip ambar">Pede senha no SSW</span><div class="s">cadastre em Conferência SSW → Senhas</div>`;
      case "sem nf nova": return `<span class="chip ambar">NF nova não achada</span><div class="s">${t.fila_360 && !/aguardando entrega/i.test(t.fila_360) ? "ticket: " + esc(t.fila_360) : "sem \"NF … emitida\" no chat"}</div>`;
      case "sem nf": return `<span class="chip ambar">Série sem CNPJ</span>`;
      default: return `<span class="s">o robô ainda não olhou</span>`;
    }
  }
  function agRobo(t) {
    const q = t.baixa_em ? `<div class="s">${new Date(t.baixa_em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</div>` : "";
    if (t.baixa_status === "feita") return `<span class="chip verde">✓ Baixa feita</span>${q}`;
    if (t.baixa_status === "teste") return `<span class="chip cinza">Testado (Cancelar)</span>${q}`;
    if (t.baixa_status === "conferir") return `<span class="chip ambar">Conferir</span><div class="s">${esc(t.baixa_msg || "")}</div>`;
    if (t.baixa_status === "erro") return `<span class="txt-vermelho">⚠ ${esc(t.baixa_msg || "O robô não conseguiu.")}</span>`;
    return t.situacao === "entregue" ? `<span class="s">baixa na próxima rodada</span>` : `<span class="s">—</span>`;
  }
  async function carregarAguardando() {
    try {
      const [lista, obs, inf] = await Promise.all([buscarTudo("aguardando_entrega", "ticket"), buscarTudo("aguardando_obs", "ticket"), sb.from("aguardando_info").select("*")]);
      const ativos = lista.filter((t) => t.na_planilha);
      agLista = ativos.filter((t) => (t.fila_rel || "AE") === agFila); agObs = new Map(obs.map((o) => [o.ticket, o]));
      agInfo = ((inf.data || []).find((x) => x.id === (agFila === "AT" ? 2 : 1))) || null;
      agOc = ativos.filter((t) => t.insucesso && t.situacao !== "entregue");   // aba Ocorrências já vê os novos insucessos (das duas filas)
    } catch (err) {
      $("ag-info").textContent = /aguardando|does not exist|schema cache/i.test(err.message || "") ? "Para usar a Fila Aguardando entrega, rode a parte 24 do supabase/schema.sql no Supabase." : "Não consegui carregar: " + (err.message || err);
      return;
    }
    desenharAguardando();
  }
  function desenharAguardando() {
    $("ag-info").textContent = agInfo ? `${agInfo.arquivo || "relatório"} · enviado em ${new Date(agInfo.enviado_em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}${agInfo.enviado_por ? " por " + agInfo.enviado_por : ""} · ${fmt(agLista.length)} tickets`
      : "Suba o relatório de tickets da fila Aguardando entrega para começar.";
    const ult = agLista.reduce((m, t) => (t.consultado_em && t.consultado_em > m ? t.consultado_em : m), "");
    $("ag-robo").textContent = ult ? `Robô olhou pela última vez em ${new Date(ult).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}` : "";
    document.querySelectorAll("#ag-cards .kpi[data-ag]").forEach((b) => { const k = b.dataset.ag; b.querySelector(".kpi-num").textContent = fmt(k === "todos" ? agLista.length : agLista.filter((t) => agGrupo(t) === k).length); b.classList.toggle("ativa", k === agCard); });
    const q = norm(agBusca);
    const L = agLista.filter((t) => agCard === "todos" || agGrupo(t) === agCard)
      .filter((t) => !q || [t.ticket, t.pedido, t.pedido_promob, t.nf_nova, t.nf_original].some((v) => norm(v).includes(q)))
      .sort((a, b) => String(a.ticket_criado || "").localeCompare(String(b.ticket_criado || "")) || String(a.ticket).localeCompare(String(b.ticket), "pt-BR", { numeric: true }));
    $("ag-titulo").textContent = `${AG_NOME[agCard]} (${fmt(L.length)})`;
    $("ag-linhas").innerHTML = L.slice(0, 500).map((t) => {
      const o = agObs.get(t.ticket);
      return `<tr><td><a href="https://appv2.360multi.com/tickets/${encodeURIComponent(t.ticket)}" target="_blank" rel="noopener">${esc(t.ticket)}</a>${t.ticket_criado ? `<div class="s">${br(t.ticket_criado)}</div>` : ""}</td>
        <td>${esc(t.tipo || "")}${t.tipo_reposicao ? `<div class="s">${esc(t.tipo_reposicao)}</div>` : ""}</td>
        <td class="mono">${esc(t.pedido || "")}<div class="s">NF antiga ${esc(t.nf_original || "—")}</div></td>
        <td>${t.nf_nova ? `<b>${esc(t.nf_nova)}</b> <button class="link" data-ag-rastreio="${esc(t.ticket)}">rastreio</button>${t.nf_emitida_em ? `<div class="s">emitida ${br(t.nf_emitida_em)}</div>` : ""}` : "—"}</td>
        <td>${esc(agTransp(t))}</td><td>${agStatus(t)}</td><td>${agRobo(t)}</td>
        <td class="col-obs"><input data-ag-obs="${esc(t.ticket)}" value="${esc(o ? o.observacao : "")}" placeholder="O que foi feito…" maxlength="1000"><div class="s quem">${o ? esc((o.atualizado_por || "").split("@")[0]) + " · " + new Date(o.atualizado_em).toLocaleDateString("pt-BR") : ""}</div></td></tr>`;
    }).join("") + (L.length > 500 ? `<tr><td colspan="8" class="s">Mostrando 500 de ${fmt(L.length)} — use a busca ou baixe o Excel.</td></tr>` : "");
    $("ag-vazio").hidden = L.length > 0;
  }
  $("ag-cards").addEventListener("click", (e) => { const b = e.target.closest("[data-ag]"); if (!b) return; agCard = b.dataset.ag; desenharAguardando(); });
  $("ag-busca").addEventListener("input", (e) => { agBusca = e.target.value; desenharAguardando(); });
  $("ag-linhas").addEventListener("click", (e) => {
    const b = e.target.closest("[data-ag-rastreio]"); if (!b) return;
    const t = agLista.find((x) => x.ticket === b.dataset.agRastreio); if (t) abrirSSW(t.nf_nova, agTransp(t), null);
  });
  $("ag-linhas").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.dataset.agObs) e.target.blur(); });
  $("ag-linhas").addEventListener("change", async (e) => {
    const inp = e.target.closest("input[data-ag-obs]"); if (!inp) return;
    const tk = inp.dataset.agObs, quem = inp.parentElement.querySelector(".quem"), v = inp.value.trim();
    quem.textContent = "salvando…";
    const { error } = await sb.rpc("salvar_obs_aguardando", { p_ticket: tk, p_obs: v });
    if (error) { quem.textContent = ""; return toast("Não salvou: " + error.message, true); }
    if (v) agObs.set(tk, { ticket: tk, observacao: v, atualizado_por: meuEmail(), atualizado_em: new Date().toISOString() }); else agObs.delete(tk);
    quem.innerHTML = v ? `<span class="salvo">✓ salvo</span>` : "";
  });
  $("ag-rodar").addEventListener("click", async () => {
    const { error } = await sb.rpc("rodar_robo_aguardando");
    if (error) return toast("Não foi possível: " + error.message, true);
    toast("Robô chamado. Ele começa em 1 ou 2 minutos e o resultado aparece aqui sozinho.");
  });
  $("ag-arquivo").addEventListener("change", async (e) => {
    const arq = e.target.files[0]; e.target.value = ""; if (!arq) return;
    carregando("Lendo o relatório…"); await new Promise((r) => setTimeout(r, 50));
    let itens = [], foraFila = 0;
    try {
      const wb = XLSX.read(await arq.arrayBuffer(), { type: "array", dense: true, cellDates: true });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
      const iCab = rows.findIndex((r) => r && r.some((c) => norm(c) === "ID DO TICKET" || norm(c) === "ID TICKET"));
      if (iCab < 0) throw new Error('Não achei a coluna "ID do Ticket". Use o relatório de tickets do Multi360.');
      const cab = rows[iCab].map(norm), col = (...n) => cab.findIndex((c) => n.includes(c));
      const c = { tk: col("ID DO TICKET", "ID TICKET"), tipo: col("TIPO"), rep: col("TIPO DE REPOSICAO"), mot: col("MOTIVO"), fila: col("FILA"), ped: col("PEDIDO CANAL"),
        pp: col("PEDIDO PROMOB"), nf: col("NOTA FISCAL"), tp: col("TRANSPORTADORA DO TICKET"), tpp: col("TRANSPORTADOR PROMOB"), cri: col("CRIACAO DO TICKET") };
      const iso = (v) => v instanceof Date ? v.toISOString() : typeof v === "number" ? (() => { const d = XLSX.SSF.parse_date_code(v); return d ? new Date(d.y, d.m - 1, d.d, d.H, d.M, d.S).toISOString() : null; })() : null;
      const porTk = new Map();
      rows.slice(iCab + 1).forEach((r) => {
        if (!r) return; const tk = String(r[c.tk] ?? "").trim().replace(/\.0+$/, ""); if (!tk) return;
        if (c.fila >= 0 && r[c.fila] && norm(r[c.fila]) !== (agFila === "AT" ? "AGUARDANDO ENTREGA (AT)" : "AGUARDANDO ENTREGA")) { foraFila++; return; }
        const v = (i) => (i >= 0 && r[i] != null ? String(r[i]).trim() : "");
        const ant = porTk.get(tk); if (ant) { const t = v(c.tp); if (t && !ant.transportadora.split(" / ").includes(t)) ant.transportadora += " / " + t; return; }
        porTk.set(tk, { ticket: tk, tipo: v(c.tipo), tipo_reposicao: v(c.rep), motivo: v(c.mot), pedido: v(c.ped), pedido_promob: v(c.pp), nf_original: v(c.nf),
          transportadora: v(c.tp), transp_promob: v(c.tpp), ticket_criado: c.cri >= 0 ? iso(r[c.cri]) : null });
      });
      itens = [...porTk.values()];
      if (!itens.length) throw new Error(`O relatório não tem tickets da fila ${agFila === "AT" ? "Aguardando entrega (AT)" : "Aguardando entrega"}${foraFila ? " (as linhas são de outra fila: confira se subiu no botão certo)" : ""}.`);
    } catch (err) { carregando(""); toast(err.message, true); return; }
    carregando("");
    if (!confirm(`${arq.name}\n\n${fmt(itens.length)} ticket(s) na fila ${agFila === "AT" ? "Aguardando entrega (AT)" : "Aguardando entrega"}${foraFila ? ` (${fmt(foraFila)} linha(s) de outra fila ficam de fora)` : ""}.\n\nO robô vai abrir os tickets, conferir o rastreio da nova NF e dar baixa nos entregues. As observações continuam salvas. Enviar?`)) return;
    const { error } = await sb.rpc("importar_aguardando", agFila === "AT" ? { itens, arquivo: arq.name, p_fila: "AT" } : { itens, arquivo: arq.name });
    if (error) return toast("Erro ao enviar: " + error.message + (/importar_aguardando|schema cache|p_fila/i.test(error.message) ? ` (rode a parte ${agFila === "AT" ? "26" : "24"} do supabase/schema.sql)` : ""), true);
    toast(`${fmt(itens.length)} ticket(s) enviados. O robô começa em 1 ou 2 minutos.`); await carregarAguardando();
  });
  $("ag-baixar").addEventListener("click", () => {
    const L = agLista.filter((t) => agCard === "todos" || agGrupo(t) === agCard); if (!L.length) return toast("Nada para exportar.", true);
    const SIT = { entregue: "Entregue", "nao entregue": "Não entregue", "sem cte": "Sem CT-e ainda", "sem rastreio": "Sem rastreio automático", "sem permissao": "Pede senha no SSW", "sem nf nova": "NF nova não achada", pendente: "Robô ainda não olhou" };
    const linhas = [["Ticket", "Tipo", "Tipo de reposição", "Pedido", "Pedido Promob", "NF antiga", "Nova NF", "NF emitida em", "Transportadora", "Status no rastreio", "Último evento", "Data do evento", "Data de entrega", "Insucesso", "Fonte", "Robô", "Observação", "Observação por"]]
      .concat(L.map((t) => { const o = agObs.get(t.ticket) || {}; return [t.ticket, t.tipo, t.tipo_reposicao, t.pedido, t.pedido_promob, t.nf_original, t.nf_nova, br(t.nf_emitida_em), agTransp(t), SIT[t.situacao] || t.situacao, t.ultimo_evento, br(t.data_evento), br(t.data_entrega), t.insucesso, t.fonte, [t.baixa_status, t.baixa_msg].filter(Boolean).join(" · "), o.observacao || "", o.atualizado_por || ""]; }));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(linhas), "Aguardando entrega");
    XLSX.writeFile(wb, `aguardando_entrega${agFila === "AT" ? "_AT" : ""}_${hojeISO()}.xlsx`);
  });
  setInterval(() => { if (paginaAtual === "alterar" && !$("ap-sec-ag").hidden && !document.hidden && !(document.activeElement && document.activeElement.dataset && document.activeElement.dataset.agObs)) carregarAguardando(); }, 60000);
  $("e-transp-exportar").addEventListener("click", () => {
    if (!eLinhasTransp.length) return toast("Nada para exportar.", true);
    const linhas = [["Transportadora", "Entregues", "No prazo", "Com atraso", "SLA"]].concat(eLinhasTransp.map((x) => [x.t, x.ent, x.ok, x.atr, Math.round(x.sla * 1000) / 10 + "%"]));
    const ws = XLSX.utils.aoa_to_sheet(linhas); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "SLA por transportadora");
    XLSX.writeFile(wb, `sla_por_transportadora_${hojeISO()}.xlsx`);
  });


  // ---------------- Conferência SSW (lista importada → robô confere no SSW se já foi entregue) ----------------
  let cfLista = [], cfCard = "atualizar", cfPag = 1, cfOk = true;
  // CNPJ do remetente pela série da NF (tabela da Logística) — para abrir o rastreio do SSW na hora
  const CNPJ_SERIE = { "00349443000192": [4, 6, 7, 31, 94], "00349443000435": [9, 22, 34], "00349443000516": [10],
    "00349443000788": [11, 24, 25, 27, 301, 302, 303], "00349443001083": [14, 35], "00349443001245": [17], "00349443001407": [21],
    "00349443001750": [23], "00349443001679": [26] };
  const cnpjDaSerie = (ser) => { const n = parseInt(ser, 10); return Object.keys(CNPJ_SERIE).find((c) => CNPJ_SERIE[c].includes(n)) || null; };
  const postarNovaAba = (url, campos) => { const f = document.createElement("form"); f.method = "POST"; f.action = url; f.target = "_blank"; f.rel = "noopener";
    for (const [k, v] of campos) { const i = document.createElement("input"); i.type = "hidden"; i.name = k; i.value = v; f.appendChild(i); }
    document.body.appendChild(f); f.submit(); f.remove(); };
  const copiar = (t) => { try { navigator.clipboard.writeText(t); } catch {} };
  // transportadoras que não usam SSW: abre o rastreio delas (já com a NF quando o site aceita; senão a NF vai copiada)
  const RASTREIO_PROPRIO = [
    [/bento/i, "Bento Brasil", (num) => postarNovaAba("https://sistema.bentobrasil.com.br/consultaNotas.php", [["nr", "00349443000192"], ["nrNota", num]])],
    [/tr[aâ]nsito\s*brasil/i, "Trânsito Brasil", (num, ser) => { copiar(num); window.open("https://platform.senior.com.br/logistica-tck/tms/tck-frontend/#/login/signup?tenant=ZEhKaGJuTnBkRzlpY21GemFXdz0%3D", "_blank", "noopener");
      return `NF ${num} copiada. Entre com o CNPJ ${parseInt(ser, 10) === 35 ? "00349443001083" : "00349443000192"} e cole a NF no filtro (confira a série ${ser}).`; }],
    [/jadlog/i, "Jadlog", (num) => { copiar(num); window.open("https://www.jadlog.com.br/jadlog/home", "_blank", "noopener"); return `NF ${num} copiada. No rastreio da Jadlog, escolha Nota Fiscal e cole.`; }],
    [/transiga/i, "Transiga", (num) => { copiar(num); window.open("https://www.track3r.com.br/auth/login", "_blank", "noopener"); return `NF ${num} copiada. Entre na Track3r e cole a NF em Tracking > Nº da Nota Fiscal.`; }],
    [/formato/i, "Formato", (num) => { copiar(num); return `NF ${num} copiada. Ainda não tenho o link de rastreio da Formato.`; }],
  ];
  const rastreioDe = (transp) => RASTREIO_PROPRIO.find(([re]) => re.test(transp || ""));
  // janela com o rastreio que o robô trouxe do sistema da transportadora (Jadlog, Bento Brasil, Trânsito Brasil)
  function cfJanela(x) {
    const d = x.detalhe || {}, item = (rot, val) => `<div class="det-item"><span>${rot}</span><b>${val || "—"}</b></div>`;
    const dh = (v) => { const m = String(v || "").match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}:\d{2}))?/); return m ? `${m[3]}/${m[2]}/${m[1]}${m[4] ? " " + m[4] : ""}` : esc(v || ""); };
    const sit = (CF_SIT[sitSSW(x.situacao, x.transportadora)] || [x.situacao])[0];
    $("modal-titulo").textContent = `Rastreio ${d.fonte || x.transportadora || ""} · Pedido ${x.pedido}`;
    $("modal-corpo").innerHTML = `
      <div class="det-grade">
        ${item("NF", esc(x.nf))}${item("Situação", esc(sit))}${item("Status na transportadora", esc(d.status || x.ultimo_evento))}
        ${item("Previsão de entrega", d.previsao ? dh(d.previsao) : "")}${item("Entregue em", x.data_entrega ? dh(x.data_entrega) : "")}${item("Emissão", d.emissao ? dh(d.emissao) : "")}
        ${d.codigo ? item("Código na transportadora", esc(d.codigo)) : ""}${d.cte ? item("CT-e / DACTE", esc(d.cte)) : ""}
        ${item("Consultado em", x.consultado_em ? new Date(x.consultado_em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "")}
      </div>
      <h3 class="cf-h3">Histórico</h3>
      ${(d.eventos || []).length ? `<div class="tabela-wrap"><table class="tabela-range cf-hist"><thead><tr><th>Data/hora</th><th>Evento</th><th>Unidade</th></tr></thead><tbody>
        ${[...d.eventos].reverse().map((e) => `<tr><td>${dh(e.data)}</td><td>${esc(e.status)}</td><td>${esc(e.unidade || "")}</td></tr>`).join("")}</tbody></table></div>`
        : `<p class="s">A transportadora ainda não mostra eventos para essa nota.</p>`}
      <p class="s">Dados trazidos pelo robô do sistema da transportadora na última conferência.</p>`;
    $("modal").hidden = false; document.body.classList.add("sem-rolagem");
  }
  // senhas de rastreio do SSW cadastradas no painel (parte 23)
  let senhasSSW = [], senhasOk = false;
  async function carregarSenhas() { const { data, error } = await sb.from("senhas_rastreio").select("transportadora,senha"); senhasOk = !error; senhasSSW = error ? [] : data || []; }
  const senhaDe = (transp) => { const t = norm(transp || ""); const x = senhasSSW.find((s) => t && (t.includes(norm(s.transportadora)) || norm(s.transportadora).includes(t))); return x ? x.senha : ""; };
  function janelaSenhas() {
    $("modal-titulo").textContent = "Senhas de rastreio do SSW";
    if (!senhasOk) { $("modal-corpo").innerHTML = `<p>Para guardar as senhas, rode no Supabase a parte 23 do supabase/schema.sql.</p>`; $("modal").hidden = false; return; }
    const linhas = [...senhasSSW, { transportadora: "", senha: "" }];
    $("modal-corpo").innerHTML = `<p class="s">Senha do campo "Senha (opcional)" do rastreio do SSW. O botão "Ver no SSW" e o robô usam a senha da transportadora com esse nome (ou parte dele). Para apagar, deixe a senha vazia e salve.</p>
      <div class="tabela-wrap"><table class="tabela-range"><thead><tr><th>Transportadora</th><th>Senha</th><th></th></tr></thead><tbody>
      ${linhas.map((x, i) => `<tr><td><input class="cf-sn-t" value="${esc(x.transportadora)}" placeholder="ex.: Trans Sua Log" ${x.transportadora ? "readonly" : ""}></td>
        <td><input class="cf-sn-s" type="password" value="${esc(x.senha)}" autocomplete="off"></td><td><button class="btn mini primario" data-sn="${i}">Salvar</button></td></tr>`).join("")}
      </tbody></table></div>`;
    $("modal").hidden = false; document.body.classList.add("sem-rolagem");
  }
  $("cf-senhas").addEventListener("click", async () => { await carregarSenhas(); janelaSenhas(); });
  $("modal-corpo").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-sn]"); if (!b) return;
    const tr = b.closest("tr"), t = tr.querySelector(".cf-sn-t").value.trim(), sn = tr.querySelector(".cf-sn-s").value;
    if (!t) return toast("Escreva o nome da transportadora.", true);
    const { error } = await sb.rpc("salvar_senha_rastreio", { p_transportadora: t, p_senha: sn });
    if (error) return toast("Não salvei: " + error.message, true);
    toast(sn ? "Senha salva." : "Senha apagada."); await carregarSenhas(); janelaSenhas();
  });
  function abrirSSW(nf, transp, pedido) {   // abre o rastreio numa aba nova (consulta feita pelo navegador de quem clicou)
    const [num, ser] = String(nf || "").split("-").map((x) => x.trim());
    const x = pedido && cfLista.find((y) => y.pedido === pedido);
    if (x && x.detalhe && /jadlog/i.test(x.transportadora || "")) return cfJanela(x);   // janela só para a Jadlog (pedido da Brenda)
    const prop = rastreioDe(transp);
    if (prop) { if (!num) return toast("Esse pedido não tem NF.", true); const msg = prop[2](num, ser); if (msg) toast(msg); return; }
    const c = cnpjDaSerie(ser);
    if (!num || !c) return toast("Essa NF não tem série com CNPJ conhecido.", true);
    const f = document.createElement("form"); f.method = "POST"; f.action = "https://ssw.inf.br/2/resultSSW"; f.target = "_blank"; f.rel = "noopener";
    for (const [k, v] of [["cnpj", c], ["NR", num], ["chave", senhaDe(transp)]]) { const i = document.createElement("input"); i.type = "hidden"; i.name = k; i.value = v; f.appendChild(i); }
    document.body.appendChild(f); f.submit(); f.remove();
  }
  const cfEntregueIP = (x) => /^entregue/i.test(String(x.status_intelipost || "").trim());
  const CF_CARD = {
    atualizar: (x) => sitSSW(x.situacao, x.transportadora) === "entregue" && !cfEntregueIP(x),
    nao: (x) => sitSSW(x.situacao, x.transportadora) === "nao entregue",
    semcte: (x) => /sem cte|sem permissao/.test(sitSSW(x.situacao, x.transportadora)),
    fora: (x) => /fora do ssw|sem nf/.test(sitSSW(x.situacao, x.transportadora)),
    pendente: (x) => x.situacao === "pendente",
    todos: () => true,
  };
  const CF_SIT = { entregue: ["Entregue", "verde"], "nao entregue": ["Não entregue", "ambar"], "fora do ssw": ["Fora do SSW", "cinza"], "sem cte": ["Sem CT-e ainda", "cinza"], "sem permissao": ["Pede senha", "cinza"], "sem nf": ["Sem NF", "cinza"], pendente: ["Aguardando", "cinza"] };
  async function carregarConferencia() {
    carregarSenhas().catch(() => {});
    sb.from("conferencia_pedido").select("*").limit(1).then(({ data, error }) => { cfTudo = error ? null : (data && data[0]) || null; desenharTudo(); });
    try { cfLista = await buscarTudo("conferencia_ssw", "pedido"); cfOk = true;
      // carta de correção: outra transportadora emitiu o CT-e no SSW → o pedido passa a contar para ela (regra da Brenda)
      cfLista.forEach((x) => { const em = x.detalhe && x.detalhe.emissor; if (em) { x.transp_original = x.transportadora; x.transportadora = em; } }); }
    catch (err) { cfOk = false; cfLista = []; }
    desenharConferencia(); desenharTudo();
  }
  // botão "Conferir tudo agora" (parte 25): o robô confere de novo todos os não entregues; vários podem clicar sem recomeçar
  let cfTudo = null;
  const tudoAtivo = () => cfTudo && cfTudo.pedido_em && (!cfTudo.feito_em || cfTudo.feito_em < cfTudo.pedido_em) && Date.parse(cfTudo.pedido_em) > Date.now() - 24 * 3600000;
  function desenharTudo() {
    const el = $("cf-tudo-info"); if (!cfTudo || !cfTudo.pedido_em) { el.hidden = true; return; }
    const quando = (d) => new Date(d).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
    const desde = cfTudo.pedido_em, alvo = cfLista.filter((x) => x.situacao !== "entregue" || (x.consultado_em && x.consultado_em >= desde));
    const feitos = alvo.filter((x) => x.consultado_em && x.consultado_em >= desde).length;
    el.hidden = false;
    el.innerHTML = tudoAtivo() ? `🔄 <b>Conferindo tudo de novo</b> desde ${quando(desde)} (pedido por ${esc((cfTudo.pedido_por || "").split("@")[0])}): ${fmt(feitos)} de ${fmt(alvo.length)} conferidos. Jadlog, Bento e Trânsito vão rápido; o SSW confere uns 800 por hora.`
      : `Última conferência de tudo: pedida em ${quando(desde)} por ${esc((cfTudo.pedido_por || "").split("@")[0])}${cfTudo.feito_em ? `, terminada em ${quando(cfTudo.feito_em)}` : ""}.`;
    $("cf-tudo").textContent = tudoAtivo() ? "🔄 Conferindo tudo…" : "🔄 Conferir tudo agora";
  }
  $("cf-tudo").addEventListener("click", async () => {
    const { data, error } = await sb.rpc("conferir_tudo_agora");
    if (error) return toast("Não foi possível: " + error.message + (/conferir_tudo_agora|schema cache/i.test(error.message) ? " (rode a parte 25 do supabase/schema.sql)" : ""), true);
    toast(data && data.ja ? `Já tem uma conferência de tudo em andamento (pedida por ${String(data.pedido_por || "").split("@")[0]}). O andamento aparece aqui em cima.` : "Robô chamado: ele começa em 1 ou 2 minutos e os status vão mudando aqui sozinhos.");
    await carregarConferencia();
  });
  function cfFiltrados() {
    const b = norm($("cf-busca").value), t = $("cf-transp").value;
    return cfLista.filter((x) => (!b || norm(x.pedido).includes(b) || norm(x.nf).includes(b)) && (!t || (x.transportadora || "—") === t));
  }
  function desenharConferencia() {
    if (!cfOk) { $("cf-info").textContent = "Para usar a Conferência SSW, rode no Supabase a parte 21 do supabase/schema.sql."; return; }
    const imp = cfLista.reduce((m, x) => (x.importado_em > m ? x.importado_em : m), "");
    const pend = cfLista.filter(CF_CARD.pendente).length, ult = cfLista.reduce((m, x) => (x.consultado_em && x.consultado_em > m ? x.consultado_em : m), "");
    $("cf-info").textContent = cfLista.length
      ? `${fmt(cfLista.length)} pedidos importados em ${new Date(imp).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}${cfLista[0].importado_por ? " por " + cfLista[0].importado_por.split("@")[0] : ""}`
        + (pend ? ` · o robô está conferindo sozinho, os mais atrasados primeiro (faltam ${fmt(pend)}; ~800 por hora)` : " · todos conferidos") + (ult ? ` · última conferência ${new Date(ult).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}` : "")
      : 'Clique em "Importar pedidos (Intelipost)" e escolha o arquivo de transações exportado da Intelipost.';
    const tSel = $("cf-transp").value, ts = [...new Set(cfLista.map((x) => x.transportadora || "—"))].sort((a, b) => a.localeCompare(b, "pt-BR"));
    $("cf-transp").innerHTML = `<option value="">Todas</option>` + ts.map((t) => `<option ${t === tSel ? "selected" : ""}>${esc(t)}</option>`).join("");
    const F = cfFiltrados();
    document.querySelectorAll("#cf-cards .kpi[data-cf]").forEach((b) => { b.querySelector(".kpi-num").textContent = fmt(F.filter(CF_CARD[b.dataset.cf]).length); b.classList.toggle("ativa", b.dataset.cf === cfCard); });
    const L = F.filter(CF_CARD[cfCard]);
    $("cf-titulo").textContent = `${(document.querySelector(`#cf-cards [data-cf="${cfCard}"] .kpi-rot`) || {}).textContent || "Pedidos"} (${fmt(L.length)})`;
    const POR = 100, pags = Math.max(1, Math.ceil(L.length / POR)); cfPag = Math.min(cfPag, pags);
    $("cf-linhas").innerHTML = L.slice((cfPag - 1) * POR, cfPag * POR).map((x) => { const [rot, cor] = CF_SIT[sitSSW(x.situacao, x.transportadora)] || [x.situacao, "cinza"];
      return `<tr><td class="mono">${esc(x.pedido)}</td><td>${esc(x.nf || "—")}</td><td>${esc(x.transportadora || "—")}${x.transp_original ? `<div class="s" title="Carta de correção: o CT-e foi emitido por outra transportadora">era ${esc(x.transp_original)}</div>` : ""}</td><td>${esc(x.status_intelipost || "—")}</td><td>${br(x.prev_cliente) || "—"}</td>
        <td><span class="chip ${cor}">${rot}</span></td><td>${esc(x.ultimo_evento || "")}${x.data_evento ? `<div class="s">${br(x.data_evento)}</div>` : ""}</td><td>${br(x.data_entrega) || "—"}</td>
        <td>${x.nf ? `<button class="btn mini contorno" data-ssw="${esc(x.nf)}" data-transp="${esc(x.transportadora || "")}" data-pedido="${esc(x.pedido)}" title="Abre o rastreio dessa nota agora">${rastreioDe(x.transportadora) ? "Ver na " + esc(rastreioDe(x.transportadora)[1]) : "Ver no SSW"} ↗</button>` : ""}</td></tr>`; }).join("");
    $("cf-vazio").hidden = L.length > 0;
    $("cf-paginacao").innerHTML = L.length > POR ? `<button class="btn" data-cfp="-1" ${cfPag === 1 ? "disabled" : ""}>‹ Anterior</button><span>Página ${cfPag} de ${pags}</span><button class="btn" data-cfp="1" ${cfPag === pags ? "disabled" : ""}>Próxima ›</button>` : "";
  }
  $("cf-cards").addEventListener("click", (e) => { const b = e.target.closest(".kpi[data-cf]"); if (!b) return; cfCard = b.dataset.cf; cfPag = 1; desenharConferencia(); });
  $("cf-linhas").addEventListener("click", (e) => { const b = e.target.closest("[data-ssw]"); if (b) abrirSSW(b.dataset.ssw, b.dataset.transp, b.dataset.pedido); });
  $("cf-paginacao").addEventListener("click", (e) => { const b = e.target.closest("[data-cfp]"); if (!b) return; cfPag += Number(b.dataset.cfp); desenharConferencia(); });
  $("cf-busca").addEventListener("input", () => { cfPag = 1; desenharConferencia(); });
  $("cf-transp").addEventListener("change", () => { cfPag = 1; desenharConferencia(); });
  $("cf-limpar").addEventListener("click", () => { $("cf-busca").value = ""; $("cf-transp").value = ""; cfPag = 1; desenharConferencia(); });
  $("cf-exportar").addEventListener("click", () => {
    const L = cfFiltrados().filter(CF_CARD[cfCard]);
    const linhas = [["Pedido Intelipost", "NF", "Transportadora", "Status Intelipost", "Previsão cliente", "Situação no SSW", "Último evento no SSW", "Data do evento", "Entregue em (SSW)"]]
      .concat(L.map((x) => [x.pedido, x.nf, x.transportadora, x.status_intelipost, br(x.prev_cliente), (CF_SIT[sitSSW(x.situacao, x.transportadora)] || [x.situacao])[0], x.ultimo_evento, br(x.data_evento), br(x.data_entrega)]));
    const ws = XLSX.utils.aoa_to_sheet(linhas); ws["!cols"] = [{ wch: 34 }, { wch: 12 }, { wch: 22 }, { wch: 18 }, { wch: 16 }, { wch: 26 }, { wch: 12 }, { wch: 14 }];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Conferência SSW"); XLSX.writeFile(wb, `conferencia_ssw_${cfCard}_${hojeISO()}.xlsx`);
  });
  $("arquivo-cf").addEventListener("change", async (e) => {
    const arq = e.target.files[0]; e.target.value = "";
    if (!arq) return;
    if (!cfOk) return toast("Rode no Supabase a parte 21 do supabase/schema.sql para usar a Conferência SSW.", true);
    let itens = [], semNf = 0, res;
    try {
      const dados = await arq.arrayBuffer();
      res = await new Promise((ok, falha) => {
        const w = new Worker("leitor-conferencia.js?v=75");
        w.onmessage = (m) => { if (m.data.etapa) carregando(m.data.etapa); else { w.terminate(); m.data.erro ? falha(new Error(m.data.erro)) : ok(m.data); } };
        w.onerror = (er) => { w.terminate(); falha(new Error(er.message || "Não consegui ler o arquivo.")); };
        carregando("Lendo o arquivo da Intelipost…"); w.postMessage(dados, [dados]);
      });
      const porPed = new Map(base.map((p) => [norm(p.pedido), p]));
      itens = res.abertos.map((x) => { const b = porPed.get(norm(x.pedido)) || {}; const nf = x.nf || b.nf || ""; if (!nf) semNf++;
        return { ...x, nf: chaveNF(nf), transportadora: x.transportadora || b.transportadora || "" }; });
      if (!itens.length) throw new Error("O arquivo não tem pedidos em aberto (todos estão Entregue ou Cancelado).");
    } catch (err) { carregando(""); toast(err.message, true); return; }
    carregando("");
    const horas = Math.max(1, Math.round(itens.length / 800));
    if (!confirm(`${arq.name}\n\n${fmt(res.total)} pedidos no arquivo: ${fmt(res.fechados)} já Entregue/Cancelado (ficam de fora) e ${fmt(itens.length)} em aberto${semNf ? ` (${fmt(semNf)} sem NF)` : ""}.\n\nO robô confere todos no SSW sozinho, os mais atrasados primeiro (~800 por hora, uns ${horas} h no total). Os entregues no SSW vão direto para "Falta atualizar a Intelipost". A lista anterior será substituída. Continuar?`)) return;
    carregando("Gravando…");
    const { error } = await sb.rpc("importar_conferencia", { linhas: itens });
    carregando("");
    if (error) return toast("Não consegui gravar: " + error.message, true);
    toast(`${fmt(itens.length)} pedidos importados. O robô do SSW já começou a conferir.`);
    cfCard = "todos"; await carregarConferencia();
  });
  setInterval(() => { if (paginaAtual === "conferencia" && !document.hidden && (cfLista.some(CF_CARD.pendente) || tudoAtivo())) carregarConferencia(); }, 60000);

  // ---------------- menu lateral ----------------
  function irPara(pag) {
    paginaAtual = pag;
    $("topo-pagina").textContent = { gerencial: "Visão Gerencial", entregas: "Entregas e SLA", uf: "Atrasos por UF", transp: "Transportadoras", alterar: "Alterar pedidos", preventivo: "Preventivo", ocorrencias: "Ocorrências", responsaveis: "Responsáveis", reposicao: "Reposição", conferencia: "Conferência SSW", sac: "Consulta SAC", logins: "Logins" }[pag] || "";
    document.querySelectorAll(".menu-item").forEach((x) => x.classList.toggle("ativo", x.dataset.pagina === pag));
    document.querySelectorAll("main.conteudo").forEach((m) => (m.hidden = m.id !== "pagina-" + pag));
    if (G_PAGINAS.includes(pag)) { const pg = $("pagina-" + pag), f = $("g-filtros"); if (f.parentElement !== pg) pg.prepend(f); }
    window.scrollTo(0, 0);
  }
  document.querySelector(".menu-lateral").addEventListener("click", (e) => {
    const b = e.target.closest(".menu-item"); if (!b) return;
    irPara(b.dataset.pagina);
    if (b.dataset.pagina === "sac" && perfil !== "sac") desenharSacLogistica();
    if (G_PAGINAS.includes(b.dataset.pagina)) montarGerencial();
    if (b.dataset.pagina === "alterar") carregarAlterar();
    if (b.dataset.pagina === "conferencia") carregarConferencia();
    if (b.dataset.pagina === "ocorrencias") desenharOcorrencias();
    if (b.dataset.pagina === "logins") { carregarLogins(); carregarLoginsSac(); }
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
      b.classList.toggle("ativa", sacVisao.split("+").includes(b.dataset.sv));
      b.querySelector(".kpi-num").textContent = fmt(base1.filter(naSv[b.dataset.sv]).length);
    });
    const svs = sacVisao.split("+");
    sacFiltrados = base1.filter((p) => svs.some((k) => naSv[k](p)));
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
    const k = b.dataset.sv, atuais = new Set(sacVisao.split("+").filter((x) => x !== "todos"));
    if (k === "todos") atuais.clear(); else atuais.has(k) ? atuais.delete(k) : atuais.add(k);
    sacVisao = atuais.size ? [...atuais].join("+") : "todos";
    filtrarSac();
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
    XLSX.writeFile(wb, `consulta_sac_${sacVisao.replace(/\+/g, "-")}_${hojeISO()}.xlsx`);
  });

  // ---------------- logins do painel ----------------
  const dataHora = (iso) => (iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "nunca entrou");
  async function carregarLogins() {
    const { data, error } = await sb.rpc("listar_logins");
    const msg = $("lg-msg");
    if (error) { $("lg-linhas").innerHTML = ""; msg.hidden = false; msg.textContent = /listar_logins|function/i.test(error.message) ? "Falta rodar a parte 30 do schema.sql no Supabase." : "Não consegui ler os logins: " + error.message; return; }
    msg.hidden = data.length > 0; msg.textContent = "Nenhum login.";
    $("lg-total").textContent = fmt(data.length);
    $("lg-sac").textContent = fmt(data.filter((x) => x.sac).length);
    $("lg-prov").textContent = fmt(data.filter((x) => x.trocar_senha).length);
    const eu = $("usuario").textContent;
    $("lg-linhas").innerHTML = data.map((x) => `<tr>
      <td>${esc(x.email)}${x.email === eu ? ' <span class="chip verde">você</span>' : ""}${x.trocar_senha ? ' <span class="chip ambar">senha provisória</span>' : ""}</td>
      <td>${x.sac ? "Só Consulta SAC" : "Logística (tudo)"}</td>
      <td>${esc(dataHora(x.criado_em))}</td><td>${esc(dataHora(x.ultimo_acesso))}</td>
      <td>${x.email === eu ? "" : `<button class="btn contorno" data-prov="${esc(x.email)}">Gerar senha provisória</button>`}</td></tr>`).join("");
  }
  $("lg-linhas").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-prov]"); if (!b) return;
    const email = b.dataset.prov;
    if (!confirm(`Gerar uma senha provisória para ${email}?\n\nA senha atual dessa pessoa deixa de funcionar.`)) return;
    b.disabled = true;
    const { data, error } = await sb.rpc("senha_provisoria", { p_email: email });
    b.disabled = false;
    if (error) return toast("Não consegui trocar a senha: " + error.message, true);
    const box = $("lg-nova");
    box.innerHTML = `Senha provisória de <b>${esc(email)}</b>: <code>${esc(data)}</code> <button class="btn contorno" id="lg-copiar">Copiar</button><br><small>Passe para a pessoa. Ela vai criar uma senha dela ao entrar. Esta senha não aparece de novo.</small>`;
    box.hidden = false;
    $("lg-copiar").addEventListener("click", () => navigator.clipboard.writeText(data).then(() => toast("Senha copiada.")));
    carregarLogins();
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
    $("sac-email").value = ""; toast(`${email} agora entra vendo só a Consulta SAC.`); carregarLoginsSac(); if (paginaAtual === "logins") carregarLogins();
  });
  $("lista-sac").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-tirar]"); if (!b) return;
    if (!confirm(`Tirar ${b.dataset.tirar} da lista do SAC? Esse login passa a ver o painel inteiro.`)) return;
    const { error } = await sb.from("logins_sac").delete().eq("email", b.dataset.tirar);
    if (error) return toast("Erro: " + error.message, true);
    carregarLoginsSac(); if (paginaAtual === "logins") carregarLogins();
  });
})();
