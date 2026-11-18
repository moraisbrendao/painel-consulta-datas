// Painel Preventivo da Logística
// - login por e-mail e senha (Supabase)
// - a Logística envia a planilha exportada (aba Export) e ela vira a base de todos
// - cada pedido tem nova data e observação, salvas na hora para todos (ficam até o pedido
//   aparecer como entregue ou cancelado no arquivo da Intelipost)
(function () {
  const CFG = window.PAINEL_CONFIG;
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY); window.__sb = sb;
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
  $("btn-sair").addEventListener("click", () => { cacheLimpar(); sb.auth.signOut(); });

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

  // abas liberadas para o login (null = todas). Passo a passo é de todos; Logins segue a regra de administrador.
  let acessoPag = null;
  const LIVRES = ["ajuda", "logins"];
  const podePag = (p) => !acessoPag || LIVRES.includes(p) || acessoPag.has(p);
  const primeiraPag = () => { const b = [...document.querySelectorAll(".menu-lateral .menu-item")].find((x) => !x.classList.contains("sem-acesso") && x.dataset.pagina !== "logins" && getComputedStyle(x).display !== "none"); return b ? b.dataset.pagina : "ajuda"; };
  function aplicarAcesso() {
    document.querySelectorAll(".menu-lateral .menu-item").forEach((b) => b.classList.toggle("sem-acesso", !podePag(b.dataset.pagina)));
  }
  async function lerAcesso() {
    acessoPag = null;
    if (document.body.dataset.admin) return aplicarAcesso();   // administrador sempre vê tudo
    try { const r = await sb.rpc("meu_acesso"); if (r && !r.error && Array.isArray(r.data)) acessoPag = new Set(r.data); } catch (_) {}
    aplicarAcesso();
  }

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
    if (perfil !== "sac") await lerAcesso(); else { acessoPag = null; aplicarAcesso(); }
    $("tela-painel").hidden = false;
    if (perfil === "sac") {
      irPara("sac");
      carregarSac();
    } else {
      // Ctrl+F5 / atualizar: volta para a página (e a aba de Alterar pedidos) em que a pessoa estava
      let volta = "gerencial", voltaAp = "";
      try { volta = localStorage.getItem("painel.pagina") || "gerencial"; voltaAp = localStorage.getItem("painel.ap") || ""; } catch (_) {}
      if (volta === "ocorrencias") { volta = "alterar"; voltaAp = "oc"; }   // Ocorrências agora fica dentro de Alterar pedidos
      const botaoMenu = document.querySelector(`.menu-item[data-pagina="${volta}"]`);
      if (!botaoMenu || (volta === "logins" && !document.body.dataset.admin) || volta === "sac") volta = "gerencial";
      if (!podePag(volta)) volta = primeiraPag();
      irPara(volta);
      carregarGerencial();   // a Visão Gerencial não depende do resto: começa junto
      carregar();
      if (volta === "alterar") { carregarAlterar(); const b = voltaAp && document.querySelector(`#ap-abas [data-ap="${voltaAp}"]`); if (b) b.click(); }
      if (volta === "conferencia") carregarConferencia();
      if (volta === "retornos") setTimeout(function esperaBase() { if (base.length) abrirRetornos(); else setTimeout(esperaBase, 800); }, 800);
      ligarTempoReal();
      vigiarCodigoIntelipost();
      setTimeout(() => carregarSenhas().catch(() => {}), 3000);   // senhas do SSW para os botões de rastreio de todas as páginas
    }
  }

  // ---------- código de verificação da Intelipost ----------
  // quando o robô chega na tela do código, ele grava robo_estado "intelipost" = {tipo:"codigo"}; aqui aparece a caixa
  // em qualquer página; o código digitado vai para robo_estado "intelipost_codigo" e o robô continua o login.
  let codigoPedidoEm = "", codigoTimer = null;
  async function checarCodigoIntelipost() {
    if (perfil === "sac") return;
    const r = await sb.from("robo_estado").select("valor").eq("nome", "intelipost").limit(1);
    const v = r.data && r.data[0] && r.data[0].valor;
    const pede = v && v.tipo === "codigo" && v.pedido_em && Date.now() - new Date(v.pedido_em).getTime() < 10 * 60e3;
    if (pede && codigoPedidoEm !== v.pedido_em) { codigoPedidoEm = v.pedido_em; $("ip-codigo-num").value = ""; }
    $("ip-codigo").hidden = !pede || $("ip-codigo").dataset.enviado === codigoPedidoEm;
  }
  function vigiarCodigoIntelipost() {
    if (codigoTimer) return;
    checarCodigoIntelipost().catch(() => {}); checarRobos().catch(() => {});
    let n = 0;
    codigoTimer = setInterval(() => { if (document.hidden) return; checarCodigoIntelipost().catch(() => {}); if (++n % 2 === 0) checarRobos().catch(() => {}); }, 8000);
  }

  // ---------- aviso pequeno no canto: robô rodando (azul) / terminou (verde) ----------
  const fechados = (() => { try { return new Set(JSON.parse(localStorage.getItem("painel.robosVistos") || "[]")); } catch (_) { return new Set(); } })();
  async function checarRobos() {
    if (perfil === "sac") return;
    const r = await sb.from("robo_estado").select("nome,valor,atualizado_em").like("nome", "andamento:%");
    if (r.error) return;
    const hora = (iso) => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    const agora = Date.now();
    const itens = (r.data || []).map((x) => ({ nome: x.nome, ...(x.valor || {}) })).filter((v) => v.inicio
      && (v.rodando ? agora - new Date(v.inicio).getTime() < 6 * 3600e3 : v.fim && agora - new Date(v.fim).getTime() < 2 * 3600e3 && !fechados.has(v.nome + "|" + v.fim)));
    $("robo-avisos").innerHTML = itens.sort((a, b) => String(b.inicio).localeCompare(String(a.inicio))).map((v) => v.rodando
      ? `<div class="robo-aviso rodando"><span class="pisca"></span><div><b>${esc(v.robo)}</b><small>rodando desde ${hora(v.inicio)}</small></div></div>`
      : `<div class="robo-aviso feito" title="${esc(v.resumo || "")}"><span>✓</span><div><b>${esc(v.robo)}</b><small>terminou às ${hora(v.fim)}${v.resumo ? " · " + esc(v.resumo) : ""}</small></div><button type="button" class="robo-aviso-x" data-k="${esc(v.nome + "|" + v.fim)}" title="Fechar">✕</button></div>`).join("");
  }
  $("robo-avisos").addEventListener("click", (e) => { const b = e.target.closest(".robo-aviso-x"); if (!b) return; fechados.add(b.dataset.k);
    try { localStorage.setItem("painel.robosVistos", JSON.stringify([...fechados].slice(-50))); } catch (_) {} b.closest(".robo-aviso").remove(); });
  $("ip-codigo-form2").addEventListener("submit", (e) => { e.preventDefault(); enviarCodigoIntelipost($("ip-codigo-num2")); });
  $("ip-codigo-form").addEventListener("submit", (e) => { e.preventDefault(); enviarCodigoIntelipost($("ip-codigo-num")); });
  async function enviarCodigoIntelipost(campo) {
    const c = campo.value.replace(/\D/g, "");
    if (c.length < 4) return toast("Digite o código que chegou no e-mail.", true);
    const { error } = await sb.from("robo_estado").upsert({ nome: "intelipost_codigo", valor: { codigo: c, em: new Date().toISOString() }, atualizado_em: new Date().toISOString() }, { onConflict: "nome" });
    if (error) return toast("Não consegui enviar o código: " + error.message, true);
    $("ip-codigo").dataset.enviado = codigoPedidoEm; $("ip-codigo").hidden = true; campo.value = "";
    toast("Código enviado. O robô continua o login em alguns segundos.");
  }

  // ---------------- carregar ----------------
  // busca a tabela inteira em páginas de 1.000, várias ao mesmo tempo (bem mais rápido que uma por vez)
  // busca uma página; se o banco demorar (timeout), tenta de novo uma vez
  // Limite GERAL de páginas baixando ao mesmo tempo (somando todas as tabelas): o banco do Supabase engasga
  // (erros 500/504 e mais de 1 minuto) quando o painel pede ~80 páginas de uma vez ao abrir.
  const MAX_SIMULT = 6; let simult = 0; const filaPag = [];
  async function vez() { if (simult < MAX_SIMULT) { simult++; return; } await new Promise((ok) => filaPag.push(ok)); }
  function libera() { const prox = filaPag.shift(); if (prox) prox(); else simult--; }
  async function buscarPagina(tabela, ordem, colunas, de, ate, contar) {
    for (let tentativa = 0; ; tentativa++) {
      await vez();
      let r; try { r = await sb.from(tabela).select(colunas, contar ? { count: "exact" } : undefined).order(ordem).range(de, ate); } finally { libera(); }
      if (!r.error) return r;
      if (tentativa >= 2 || !/timeout|time out|canceling|upstream|50[0234]|fetch/i.test((r.error.message || "") + " " + (r.status || ""))) throw r.error;
      await new Promise((ok) => setTimeout(ok, 1500 * (tentativa + 1)));
    }
  }

  async function buscarTudo(tabela, ordem, colunas = "*") {
    const PAG = 1000, JUNTAS = 8;
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

  // leitura de planilha sem montar o texto formatado de cada célula (o painel só usa os valores): ~2x mais rápido
  const LINHA_RODAPE = /^filtros aplicados/i;
  const LEITURA_RAPIDA = { cellNF: false, cellText: false, cellHTML: false, cellFormula: false, cellStyles: false };
  // envia os lotes: o 1º sozinho (ele limpa/prepara), os outros 3 de cada vez
  // tira os campos vazios de cada linha antes de mandar (o banco entende campo ausente como vazio): o envio fica bem menor
  const compactar = (lote) => lote.map((l) => { const o = {}; for (const k in l) { const v = l[k]; if (v !== null && v !== undefined && v !== "") o[k] = v; } return o; });
  async function enviarLotes(rpc, linhas0, tam, args, desde = 0) {
    const linhas = { length: linhas0.length, slice: (a, b) => compactar(linhas0.slice(a, b)) };
    if (desde === 0 && linhas.length) {   // o 1º lote limpa a tabela: precisa terminar antes dos outros
      let r = await sb.rpc(rpc, args(linhas.slice(0, tam), true));
      if (r.error && /timeout|time out|canceling/i.test(r.error.message || "")) { await new Promise((ok) => setTimeout(ok, 2000)); r = await sb.rpc(rpc, args(linhas.slice(0, tam), true)); }
      if (r.error) throw r.error;
      carregando(`Enviando… ${fmt(Math.min(tam, linhas.length))} de ${fmt(linhas.length)}`); desde = tam;
    }
    const inicios = []; for (let i = desde; i < linhas.length; i += tam) inicios.push(i);
    let feitos = desde;
    const JUNTOS = 3;
    for (let k = 0; k < inicios.length; k += JUNTOS) {
      const grupo = inicios.slice(k, k + JUNTOS);
      const res = await Promise.all(grupo.map((i) => sb.rpc(rpc, args(linhas.slice(i, i + tam), i === 0))));
      // se o banco recusar algum lote (ex.: tempo esgotado com 3 ao mesmo tempo), manda esse lote de novo sozinho
      for (let g = 0; g < grupo.length; g++) {
        let r = res[g];
        for (let t = 0; r.error && t < 3; t++) { await new Promise((ok) => setTimeout(ok, 1500 * (t + 1))); r = await sb.rpc(rpc, args(linhas.slice(grupo[g], grupo[g] + tam), false)); }
        if (r.error) throw r.error;
      }
      feitos = Math.min(inicios[Math.min(k + JUNTOS - 1, inicios.length - 1)] + tam, linhas.length);
      carregando(`Enviando… ${fmt(feitos)} de ${fmt(linhas.length)}`);
    }
  }

  // ---------- cópia local (IndexedDB) das tabelas grandes ----------
  // A base muda uma vez por dia: guarda a cópia no navegador junto com a data do envio ("versão").
  // Se a versão no banco for a mesma, abre na hora sem baixar os ~13 mil pedidos de novo.
  const CACHE_DB = "eloggia-cache";
  function abrirCache() {
    return new Promise((ok) => {
      try { const r = indexedDB.open(CACHE_DB, 1); r.onupgradeneeded = () => r.result.createObjectStore("t"); r.onsuccess = () => ok(r.result); r.onerror = () => ok(null); }
      catch (_) { ok(null); }
    });
  }
  async function cacheLer(chave) {
    const db = await abrirCache(); if (!db) return null;
    return new Promise((ok) => { try { const q = db.transaction("t").objectStore("t").get(chave); q.onsuccess = () => ok(q.result || null); q.onerror = () => ok(null); } catch (_) { ok(null); } });
  }
  async function cacheGravar(chave, valor) {
    const db = await abrirCache(); if (!db) return;
    try { db.transaction("t", "readwrite").objectStore("t").put(valor, chave); } catch (_) { /* sem espaço: segue sem cópia */ }
  }
  function cacheLimpar() { try { indexedDB.deleteDatabase(CACHE_DB); } catch (_) {} }
  // versao vazia/nula = não usa cópia
  // ---------- cópia compartilhada (Supabase Storage, pasta "copias") ----------
  // O 1º login que abre o painel depois de um envio baixa a base do jeito normal e guarda UM arquivo compactado
  // com essa versão; todos os outros baixam só esse arquivo (poucos MB) em vez de ~18 pedaços de 1.000 linhas.
  // SAC não usa (pode ter acesso diferente). Qualquer falha volta para o jeito normal.
  const COPIA_BUCKET = "copias";
  let copiaDesligada = false;
  async function resumo(txt) {
    const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(txt));
    return [...new Uint8Array(b)].slice(0, 12).map((x) => x.toString(16).padStart(2, "0")).join("");
  }
  const podeCopia = () => !copiaDesligada && perfil !== "sac" && typeof CompressionStream === "function" && typeof DecompressionStream === "function" && window.crypto && crypto.subtle;
  async function copiaLer(chave, versao) {
    if (!podeCopia()) return null;
    try {
      const pasta = await resumo(chave), arq = `${pasta}/${await resumo(versao)}.json.gz`;
      const { data, error } = await sb.storage.from(COPIA_BUCKET).download(arq);
      if (error || !data) { if (error && /bucket not found|not found.*bucket/i.test(error.message || "")) copiaDesligada = true; return null; }
      const dados = await new Response(data.stream().pipeThrough(new DecompressionStream("gzip"))).json();
      return Array.isArray(dados) ? dados : null;
    } catch (_) { return null; }
  }
  async function copiaGravar(chave, versao, dados) {
    if (!podeCopia()) return;
    try {
      const pasta = await resumo(chave), nome = `${await resumo(versao)}.json.gz`;
      const gz = await new Response(new Blob([JSON.stringify(dados)]).stream().pipeThrough(new CompressionStream("gzip"))).blob();
      const { error } = await sb.storage.from(COPIA_BUCKET).upload(`${pasta}/${nome}`, gz, { upsert: true, contentType: "application/gzip" });
      if (error) { if (/bucket not found/i.test(error.message || "")) copiaDesligada = true; return; }
      // apaga as versões antigas desta mesma tabela (não precisa mais delas)
      const { data: L } = await sb.storage.from(COPIA_BUCKET).list(pasta, { limit: 100 });
      const velhos = (L || []).filter((f) => f.name !== nome).map((f) => `${pasta}/${f.name}`);
      if (velhos.length) await sb.storage.from(COPIA_BUCKET).remove(velhos);
    } catch (_) { /* sem cópia compartilhada: segue normal */ }
  }

  async function buscarComCache(tabela, ordem, colunas, versao) {
    const chave = `${tabela}|${colunas || "*"}`;
    if (versao) { const c = await cacheLer(chave); if (c && c.versao === versao && Array.isArray(c.dados)) return c.dados; }
    if (versao) { const d = await copiaLer(chave, versao); if (d) { cacheGravar(chave, { versao, dados: d }); return d; } }
    const dados = await buscarTudo(tabela, ordem, colunas);
    if (versao) { cacheGravar(chave, { versao, dados }); copiaGravar(chave, versao, dados); }
    return dados;
  }

  // topo no estilo do E-loggia do Danilo: arquivo + selo "compartilhada", idade da planilha em dias úteis, botões "Carregar"
  function diasUteisDesde(iso) {
    const d = new Date(iso.slice(0, 10) + "T12:00:00"), hoje = new Date(hojeISO() + "T12:00:00"); let n = 0;
    while (d < hoje) { d.setDate(d.getDate() + 1); const w = d.getDay(); if (w !== 0 && w !== 6) n++; }
    return n;
  }
  function desenharTopoArquivos() {
    const quando = (x) => `${new Date(x.enviado_em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}${x.enviado_por ? " por " + x.enviado_por : ""}`;
    const chip = (x, cls) => `<span class="arq ${cls}" title="Enviada em ${esc(quando(x))} · todos os logins veem esta mesma planilha">▤ ${esc(x.arquivo || "planilha")} <b class="selo">compartilhada</b></span>`;
    let h = (info ? chip(info, "") : "") + (ticketsInfo ? chip(ticketsInfo, "tk") : "");
    if (info) {
      const du = diasUteisDesde(diaLocal(info.enviado_em)), dt = new Date(info.enviado_em).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
      h += `<span class="arq-data ${du ? "velha" : "nova"}" title="Envie a base do dia para os números ficarem atualizados">planilha de ${dt} · ${du ? `${du} dia${du > 1 ? "s" : ""} út${du > 1 ? "eis" : "il"} atrás` : "de hoje"}</span>`;
    }
    $("topo-arquivos").innerHTML = h;
    $("rot-base").textContent = "Carregar planilha";
    $("rot-tickets").textContent = ticketsInfo ? "Tickets carregados" : "Carregar tickets";
  }

  async function carregar() {
    $("info-base").textContent = "Carregando…";
    try {
      const [i, fi] = await Promise.all([sb.from("base_info").select("*").limit(1), sb.from("fechados_info").select("*").limit(1)]);
      const vBase = i.data && i.data[0] ? i.data[0].enviado_em : "", vFech = fi.data && fi.data[0] ? fi.data[0].enviado_em : "";
      const [b, t, tot] = await Promise.all([
        // em aberto pela BASE (igual à Visão Gerencial); entregue_ip marca o que a Intelipost já deu como entregue/cancelado (parte 40)
        buscarComCache("base_aberta_bi", "pedido", "*", vBase && `bi|${vBase}|${vFech}`).catch(() => buscarComCache("base_aberta", "pedido", "*", vBase && `${vBase}|${vFech}`)),
        buscarTudo("tratativas", "pedido"),
        sb.from("base_pedidos").select("pedido", { count: "exact", head: true }),
      ]);
      base = b.filter((p) => !(p.extra && p.extra.fonte === "intelipost") && !LINHA_RODAPE.test(p.pedido || ""));   // a base (BI) manda; nada vem só da Intelipost
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
      : "Ainda não há base. Clique em \"Carregar planilha\" e escolha o arquivo exportado.";
    $("info-intelipost").textContent = infoFech
      ? `Intelipost: ${infoFech.arquivo || "arquivo"} de ${new Date(infoFech.enviado_em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })} · ${fmt(ocultos)} pedido${ocultos === 1 ? "" : "s"} da base já entregue${ocultos === 1 ? "" : "s"} ou cancelado${ocultos === 1 ? "" : "s"} fora${ocultos === 1 ? "" : "m"} tirado${ocultos === 1 ? "" : "s"} do painel.`
      : "Envie o arquivo da Intelipost (\"Enviar Intelipost\") para tirar do painel os pedidos entregues e cancelados.";
    desenharTopoArquivos();
    $("info-tickets").textContent = !ticketsOk ? "" : ticketsInfo
      ? `Tickets: ${ticketsInfo.arquivo || "planilha"} de ${new Date(ticketsInfo.enviado_em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}${ticketsInfo.enviado_por ? " por " + ticketsInfo.enviado_por : ""} · ${fmt(base.filter((p) => ticketDe(p)).length)} pedidos do painel com ticket aberto.`
      : "Envie a planilha de tickets (\"Carregar tickets\") para ver em que fila está o ticket de cada pedido.";
    montarOpcoes();
    redesenhar();
    desenharOcorrencias();
    if (G_PAGINAS.includes(paginaAtual)) montarGerencial();
    if (paginaAtual === "sac") desenharSacLogistica();
    desenharResponsaveis();
    desenharDrop(true);
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
    // atrasado igual à Visão Gerencial: range "Vencido" da base (se houver), senão a data prometida já passou
    const rg = norm(p.range_atrasos);
    p._atrasoG = rg ? rg.startsWith("VENCIDO") : !!(venc && venc < hoje);
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
    vencidos: (p) => p._atrasoG,
    hoje: (p) => p._diasEf === 0,
    amanha: (p) => p._diasEf === 1,
    vencem: (p) => p._diasEf !== null && p._diasEf >= 0 && p._diasEf <= 5,
    parados: (p) => p._parado !== null && p._parado > DIAS_PARADO,
    ssw: (p) => !!(p._t && p._t.nova_data && p._t.nova_data_fonte === "ssw"),
    todos: () => true,
  };  const filtroVisao = (v) => { const ks = v.split("+"); return (p) => ks.some((k) => naVisao[k](p)); };
  const NOMES_VISAO = { vencem: "Vencem em até 5 dias", parados: "Parados no rastreio", vencidos: "Atrasados", hoje: "Vencem hoje", amanha: "Vencem amanhã", ssw: "Nova data do SSW", todos: "Pedidos em aberto" };
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
  const FORA_SSW = /transiga/i;   // Jadlog, Bento Brasil, Trânsito Brasil e Formato: o robô consulta no sistema delas
  // transportadora fora do SSW: ignora qualquer resultado antigo do SSW (era da transportadora de first mile)
  // Transiga: o robô só grava entregue / não entregue / sem CT-e com o que chega do webhook dela (resultados antigos do SSW ele zera)
  const sitSSW = (sit, transp) => FORA_SSW.test(transp || "") ? (/^(sem nf|pendente|entregue|nao entregue|sem cte)$/.test(sit) ? sit : "fora do ssw") : sit === "fora do ssw" ? "sem cte" : sit;
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
    const nomes = { vencem: "vencem nos próximos 5 dias", parados: `parados há mais de ${DIAS_PARADO} dias`, vencidos: "atrasados", hoje: "que vencem hoje", amanha: "que vencem amanhã", todos: "em aberto" };
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
    const nomes = { vencem: "Vencem em 5 dias", parados: "Parados no rastreio", vencidos: "Atrasados", hoje: "Vencem hoje", amanha: "Vencem amanhã", todos: "Todos os pedidos" };
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

  // linha da lista do Preventivo (também usada na Análise de canais, com uma coluna a mais)
  function linhaPreventivo(p, attr = "data-campo", extra = "") {
      const t = p._t || {};
      const quem = t.atualizado_por ? `${esc(t.atualizado_por.split("@")[0])} · ${new Date(t.atualizado_em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}` : "";
      return `<tr data-pedido="${esc(p.pedido)}" class="clicavel ${t.observacao ? "editado" : ""}" title="Clique para ver o detalhe do pedido">
        <td><div class="p">${esc(p.pedido)}</div><div class="s">NF ${esc(p.nf || "—")} · ${esc(p.canal || "")}</div>
          ${p.entregue_ip ? '<div><span class="chip verde" title="O arquivo da Intelipost já mostra este pedido como entregue/cancelado; a base ainda não.">✓ entregue na Intelipost</span></div>' : ""}${marcaTicket(p)}</td>
        <td>${esc(p.transportadora || "—")}<div class="s">${esc([p.cidade, p.uf].filter(Boolean).join(" / "))}</div></td>
        <td><span class="ms">${esc(p.micro_status || "—")}</span><div class="s">${p._parado !== null ? `${p._parado} dia${p._parado === 1 ? "" : "s"} sem movimento` : ""}</div><div class="s resp-p">👤 ${nomeResp(p.micro_status)}</div>${marcaOc(p)}</td>
        <td>${br(p._venc) || "—"}<div>${chipPrazo(p)}</div>${p.prev_atual && p.prev_atual !== p._venc ? `<div class="s">Intelipost atual ${br(p.prev_atual)}</div>` : ""}${sswLinha(p)}</td>
        <td><input type="date" ${attr}="nova_data" value="${esc(t.nova_data || "")}">${t.nova_data_fonte === "ssw" ? `<div class="s" title="Gravada sozinha pela previsão do SSW (depois da prometida). Se mudar à mão, o robô não mexe mais.">🤖 data do SSW</div>` : ""}</td>
        <td class="col-obs"><input ${attr}="observacao" value="${esc(t.observacao || "")}" placeholder="O que foi feito…" maxlength="1000">
          <div class="s quem">${quem}</div>
          ${p.comentario_360 ? `<div class="c360" title="Comentário 360">360: ${esc(p.comentario_360)}</div>` : ""}</td>
${extra}
        <td>${p.nf ? `<button class="btn mini contorno" data-ssw="${esc(p.nf)}" data-transp="${esc(p.transportadora || "")}" data-pedido="${esc(p.pedido)}" title="Abre o rastreio da transportadora dessa nota agora">${rastreioDe(p.transportadora) ? "Ver na " + esc(rastreioDe(p.transportadora)[1]) : "Ver rastreio"} ↗</button>` : ""}${/^https?:\/\//i.test(p.link_rastreio || "") ? `<div><a class="s" href="${esc(p.link_rastreio)}" target="_blank" rel="noopener noreferrer">Intelipost ↗</a></div>` : ""}</td>
      </tr>`;
  }
  function desenharLista() {
    const total = filtrados.length, paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
    pagina = Math.min(pagina, paginas);
    const fatia = filtrados.slice((pagina - 1) * POR_PAGINA, pagina * POR_PAGINA);
    $("linhas").innerHTML = fatia.map((p) => linhaPreventivo(p)).join("");
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
        ${item("Micro status", `<span class="ms">${esc(p.micro_status)}</span>${marcaOc(p)}`)}${item("Responsável", nomeResp(p.micro_status))}${ticketsInfo ? item("Ticket", (() => { const t = ticketDe(p); return t ? `${esc(t.fila || "")}<div class="s">${esc([t.tipo, t.motivo, t.qtd > 1 ? t.qtd + " tickets" : ""].filter(Boolean).join(" · "))}</div>${String(t.id_ticket || "").split(",").map((x) => x.trim()).filter(Boolean).map((id) => `<a href="https://appv2.360multi.com/tickets/${encodeURIComponent(id)}" target="_blank" rel="noopener noreferrer">#${esc(id)} ↗</a>`).join(" ")}` : "Sem ticket"; })()) : ""}${item("Status Intelipost", esc(p.status_intelipost))}
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
    // histórico de retornos (parte 40)
    sb.from("retornos_hist").select("nova_data,nova_data_antes,observacao,fonte,feito_por,feito_em").eq("pedido", p.pedido).order("feito_em", { ascending: false }).limit(30).then(({ data, error }) => {
      if (error || !data || !data.length || $("modal").hidden || $("modal-titulo").textContent !== "Pedido " + p.pedido) return;
      const d = document.createElement("div"); d.className = "rt-hist";
      d.innerHTML = `<h3 class="cf-h3">Histórico de retornos (${data.length})</h3><div class="tabela-wrap"><table class="tabela-range"><thead><tr><th>Quando</th><th>Quem</th><th>Nova data</th><th>Observação</th></tr></thead><tbody>${data.map((h) => {
        const quebrou = h.nova_data_antes && h.nova_data !== h.nova_data_antes && h.nova_data_antes < String(h.feito_em).slice(0, 10);
        return `<tr><td>${new Date(h.feito_em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</td><td>${h.fonte === "ssw" ? "🤖 SSW" : esc((h.feito_por || "").split("@")[0])}</td><td>${br(h.nova_data) || "—"}${quebrou ? ` <span class="chip vermelho" title="A data anterior (${br(h.nova_data_antes)}) já tinha passado">promessa quebrada</span>` : h.nova_data_antes && h.nova_data !== h.nova_data_antes ? ` <span class="s">antes ${br(h.nova_data_antes)}</span>` : ""}</td><td>${esc(h.observacao || "")}</td></tr>`; }).join("")}</tbody></table></div>`;
      $("modal-corpo").appendChild(d);
    });
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
  // colunas que só vão para o Excel da Visão Gerencial (ficam juntas na coluna "extra" do banco, parte 32)
  const EXTRA = {
    id_any: ["ID ANYMARKET"], pedido_any: ["PEDIDO ANYMARKET"], promob: ["PEDIDO PROMOB"], sku: ["SKU"],
    faturamento: ["DATA DE FATURAMENTO", "d"], emissao_cte: ["DATA EMISSAO CTE OOBJ", "d"], cep: ["CEP DESTINO INTELIPOST"], chave: ["CHAVE NOTA"],
    valor_nf: ["VALOR TOTAL NF NA INTELIPOST", "n"], valor_cte: ["VALOR RECEBIDO CTE", "n"], num_cte: ["NUMERO CTE"],
    redespacho: ["TRANSPORTADORA REDESPACHO PROMOB"], transp_promob: ["TRANSPORTADORA PROMOB"], trocas: ["QTD DE ALTERACOES / DATA PREVISTA PARA ENTREGAR(360)", "n"],
    prazo_transp: ["TEMPO EM DIAS UTEIS PARA A TRANSPORTADORA ENTREGAR (INTELIPOST)", "n"], fornecedor: ["FORNECEDOR"],
  };

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

  let baseExtraOk = true;   // false se o banco ainda não tem a coluna "extra" (parte 32)
  // Lê a base num Worker (a tela não trava) e manda só os pedidos que mudaram desde a última base (parte 42).
  function lerBaseWorker(buf) {
    return new Promise((ok, falha) => {
      const w = new Worker("leitor-base.js?v=126");
      w.onmessage = (m) => { if (m.data.etapa) carregando(m.data.etapa); else { w.terminate(); m.data.erro ? falha(new Error(m.data.erro)) : ok(m.data); } };
      w.onerror = (er) => { w.terminate(); falha(new Error(er.message || "Não consegui ler a planilha.")); };
      w.postMessage({ buf, COLUNAS, EXTRA, DATAS: [...DATAS], rodape: LINHA_RODAPE.source }, [buf]);
    });
  }
  async function enviarBaseNova(res, arq) {   // devolve false se o banco ainda não tem a parte 42
    carregando("Comparando com a base atual…");
    let hsDb = await sb.rpc("base_hashes");
    if (hsDb.error && /timeout|canceling/i.test(hsDb.error.message || "")) hsDb = await sb.rpc("base_hashes");
    if (hsDb.error) { if (/base_hashes|function|schema cache/i.test(hsDb.error.message || "")) return false; throw hsDb.error; }
    const atual = new Map(hsDb.data || []), noArquivo = new Set();
    const mudou = [];
    res.rows.forEach((r, i) => { noArquivo.add(r[0]); if (atual.get(r[0]) !== res.hs[i]) mudou.push(i); });
    const remover = [...atual.keys()].filter((p) => !noArquivo.has(p));
    const total = res.rows.length;
    const chamar = async (args) => { let r;
      for (let t = 0; t < 4; t++) { r = await sb.rpc("importar_base_c", { cols: res.cols, linhas: [], hs: [], remover: null, fim: false, arquivo: arq.name, total, ...args });
        if (!r.error) return r; await new Promise((ok) => setTimeout(ok, 1500 * (t + 1))); }
      throw r.error; };
    for (let i = 0; i < remover.length; i += 5000) { carregando(`Tirando ${fmt(remover.length)} pedidos que saíram da planilha…`); await chamar({ remover: remover.slice(i, i + 5000) }); }
    const TAM = 2000, JUNTOS = 4, inicios = []; for (let i = 0; i < mudou.length; i += TAM) inicios.push(i);
    let feitos = 0; carregando(`Enviando ${fmt(mudou.length)} pedidos novos ou alterados (de ${fmt(total)})…`);
    for (let k = 0; k < inicios.length; k += JUNTOS) {
      await Promise.all(inicios.slice(k, k + JUNTOS).map(async (i) => { const ix = mudou.slice(i, i + TAM);
        await chamar({ linhas: ix.map((n) => res.rows[n]), hs: ix.map((n) => res.hs[n]) }); feitos += ix.length;
        carregando(`Enviando… ${fmt(feitos)} de ${fmt(mudou.length)} pedidos novos ou alterados`); }));
    }
    await chamar({ fim: true });
    return { mudou: mudou.length, removidos: remover.length };
  }
  $("arquivo").addEventListener("change", async (e) => {
    const arq = e.target.files[0]; e.target.value = "";
    if (!arq) return;
    carregando("Lendo a planilha…");
    let res;
    try { res = await lerBaseWorker(await arq.arrayBuffer()); }
    catch (err) { carregando(""); toast(err.message, true); return; }
    carregando("");
    if (res.semPromob) toast('Aviso: não achei a coluna "Transportadora Promob" nesta planilha. A página Transportadora divergente vai ficar vazia.', true);
    if (!confirm(`${arq.name}\n\n${fmt(res.rows.length)} pedidos encontrados.\nTransportadora Promob preenchida em ${fmt(res.nTp)} pedidos.\n\nEssa planilha vai substituir a base atual para todos.\nAs observações já feitas continuam salvas.\n\nEnviar?`)) return;
    let r = false;
    try { r = await enviarBaseNova(res, arq); }
    catch (err) { carregando(""); toast("Erro ao enviar: " + err.message + " · Pode enviar de novo: só vai o que faltou.", true); return; }
    if (r === false) {   // banco sem a parte 42: envia do jeito antigo (tudo)
      const nEx = res.cols.filter((c) => c.startsWith("x:")).length, nB = res.cols.length - nEx;
      const linhas = res.rows.map((row) => { const o = {}, ex = {};
        res.cols.forEach((c, j) => { const v = row[j] === undefined ? null : row[j]; if (j < nB) o[c] = v; else if (v !== null) ex[c.slice(2)] = v; });
        if (baseExtraOk) o.extra = ex; return o; });
    try {
      const argsBase = (lote, primeiro) => ({ linhas: compactar(lote), limpar: primeiro, arquivo: arq.name, total: linhas.length });
      // 1º passo só limpa a base (sem linhas), com novas tentativas se o banco demorar; depois manda em lotes menores
      carregando("Limpando a base antiga…");
      let { error } = await sb.rpc("importar_base", argsBase([], true));
      for (let t = 0; error && /timeout|time out|canceling/i.test(error.message || "") && t < 3; t++) {
        await new Promise((ok) => setTimeout(ok, 3000 * (t + 1))); ({ error } = await sb.rpc("importar_base", argsBase([], true))); }
      if (error) throw error;
      carregando(`Enviando… 0 de ${fmt(linhas.length)}`);
      ({ error } = await sb.rpc("importar_base", argsBase(linhas.slice(0, 1000), false)));
      if (error && /extra/i.test(error.message || "") && baseExtraOk) {   // banco sem a parte 32: manda sem as colunas extras
        baseExtraOk = false; linhas.forEach((l) => delete l.extra); ({ error } = await sb.rpc("importar_base", argsBase(linhas.slice(0, 1000), false))); }
      if (error && !/timeout|time out|canceling/i.test(error.message || "")) throw error;
      await enviarLotes("importar_base", linhas, 1000, (lote) => argsBase(lote, false), error ? 0 : 1000);
    } catch (err) {
      carregando(""); toast("Erro ao enviar: " + err.message, true); return;
    }
    }
    carregando("");
    toast(r ? `Base atualizada: ${fmt(res.rows.length)} pedidos (${fmt(r.mudou)} novos ou alterados${r.removidos ? `, ${fmt(r.removidos)} saíram da planilha` : ""}).` : `Base atualizada: ${fmt(res.rows.length)} pedidos.`);
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
      `${fmt(sairao)} pedido${sairao === 1 ? " que está" : "s que estão"} no painel ${sairao === 1 ? "vai" : "vão"} sair.\n\nEnviar?`)) return;
    try {
      const qtd = lista.length;
      // só interessam os pedidos que estão na base (a base inteira, inclusive os que já saíram do painel):
      // o arquivo traz ~70 mil pedidos de 3 meses, mas a base tem ~13 mil. Manda só esses (bem mais rápido).
      carregando("Separando os pedidos da base…");
      if (!gDados) await carregarGerencial();
      const daBase = gDados && gDados.length ? new Set(gDados.map((r) => r.pedido)) : null;
      const enviar = daBase ? lista.filter((x) => daBase.has(x.pedido)) : lista.slice();
      if (!enviar.length) enviar.push({ pedido: "", status: null });
      await enviarLotes("importar_fechados", enviar, 5000, (lote, primeiro) => ({ linhas: lote, limpar: primeiro, arquivo: arq.name, total_linhas: res.total, fechados: qtd }));
      // a Intelipost só serve para tirar entregues/cancelados da base: esvazia a lista de "em aberto só na Intelipost" (parte 33, desfeita)
      try { await sb.rpc("importar_abertos", { linhas: [], limpar: true }); } catch (_) {}
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
    // só fica de fora quem já entra pela base com micro status de ocorrência (senão a nota sumia: ex. AT com a nova NF na base "em trânsito")
    const jaVai = new Set(base.filter(precisaOc).map((p) => { const { nf, serie } = nfSerie(p); return nf + "-" + serie; }));
    const extra = agOc.filter((t) => { const { nf, serie } = nfSerie({ nf: t.nf_nova }); return nf && !jaVai.has(nf + "-" + serie); })
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
    if (!usuarioId || perfil === "sac" || paginaAtual !== "alterar" || $("ap-sec-oc").hidden || document.hidden) return;
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
      const wb = XLSX.read(await arq.arrayBuffer(), { type: "array", dense: true, ...LEITURA_RAPIDA });
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
  // Fonte: a base ("Carregar planilha", aba Export), todos os pedidos dela. Data prometida = Data Original Estimada (senão a atual).
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
  const G_COLS_NOVAS = ",data_criacao,data_entrega,range_atrasos,dias_atraso,status_prazo,sem_expedicao,trocas:extra->>trocas";
  let gGeracao = 0, gBaseEm = null;   // gBaseEm = data de envio da base que está na tela
  async function carregarGerencial(forcar) {
    if ((gCarregando && !forcar) || (gDados && gDados.length && !forcar)) return;
    const minha = ++gGeracao;   // uma carga mais nova descarta a antiga (não deixa a base velha "ganhar")
    gCarregando = true; $("g-info").textContent = $("e-info").textContent = $("u-info").textContent = "Carregando os pedidos da base…";
    try {
      let lista, semColunas = false;
      const inf = await sb.from("base_info").select("enviado_em").limit(1);
      const baseEm = inf.data && inf.data[0] ? inf.data[0].enviado_em : null;
      try { lista = await buscarComCache("base_pedidos", "pedido", G_COLS + G_COLS_NOVAS, baseEm); }
      catch (e1) { if (!/column|coluna|does not exist/i.test(e1.message || "")) throw e1; semColunas = true; lista = await buscarTudo("base_pedidos", "pedido", G_COLS); }
      if (minha !== gGeracao) return;
      gAvisoColunas = semColunas; gBaseEm = baseEm;
      gDados = lista.filter((b) => !LINHA_RODAPE.test(b.pedido || "")).map((b) => {
        const nf = String(b.nf || ""), m = nf.match(/^(.*?)-\s*(\w+)\s*$/);
        return { pedido: b.pedido, nf: m ? m[1] : nf, serie: m ? m[2].replace(/^0+(?=\d)/, "") : "", canal: b.canal, uf: b.uf, cidade: b.cidade || null, transp: b.transportadora,
          status: b.status_intelipost, micro: b.micro_status, origem: b.origem, criado: b.data_criacao || null, despacho: b.data_expedicao, entrega: b.data_entrega || null,
          prevOrig: b.prev_original, prev: b.prev_atual, ult: b.ultima_atualizacao ? String(b.ultima_atualizacao).slice(0, 10) : null,
          range: b.range_atrasos || null, diasAtr: b.dias_atraso ?? null, sprazo: b.status_prazo || null, semExp: b.sem_expedicao || null,
          trocas: Math.max(0, parseInt(b.trocas, 10) || 0) };
      });
    } catch (err) {
      if (minha !== gGeracao) return;
      gDados = null; gCarregando = false;
      $("g-info").textContent = $("e-info").textContent = $("u-info").textContent = "Não consegui carregar a base: " + (err.message || err) + ". Atualize a página para tentar de novo.";
      return;
    }
    gCarregando = false;
    fotoDoDia(gBaseEm, minha);
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
  const G_PAGINAS = ["gerencial", "entregas", "uf", "transp", "canais"];
  function desenharGAtual() { if (paginaAtual === "canais") desenharCanaisPag(); else if (paginaAtual === "entregas") desenharEntregas(); else if (paginaAtual === "uf") desenharUF(); else if (paginaAtual === "transp") desenharTransp(); else desenharGerencial(); }
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
      : 'Envie a base ("Carregar planilha") para montar a Visão Gerencial.';
    if (gAvisoColunas) $("g-info").textContent += " · Para usar o Range de Atrasos e as datas de criação e entrega, rode de novo o supabase/schema.sql e envie a base de novo.";

    // de quem é o atraso
    const atr = L.filter(G_CARD.atrasados);
    // pedido com ocorrência ou reposição (detalhamento de tickets) não entra na cobrança da transportadora
    if (!detNF && !gDetTentou) { gDetTentou = true; carregarDetNF().then((m) => { if (m.size && G_PAGINAS.includes(paginaAtual)) montarGerencial(); }); }
    const ocRep = (r) => { const d = detNF && detNF.get(chaveNF(r.serie ? `${r.nf}-${r.serie}` : r.nf)); return !!(d && (d.tem_ocorr || d.tem_repo)); };
    const semExp = atr.filter((r) => r._semExp), sairam = atr.filter((r) => !r._semExp && r._prom && r.despacho > r._prom),
      daTransp = atr.filter((r) => !r._semExp && !(r._prom && r.despacho > r._prom)), comOcRep = daTransp.filter(ocRep), deFato = daTransp.filter((r) => !ocRep(r));
    $("g-atr").innerHTML = atr.length ? `<h2>🚚 Dos ${fmt(atr.length)} atrasados, ${fmt(deFato.length)} são de fato erro da transportadora.</h2>
      <p class="g-links"><button class="link vermelho" data-atr="fato">${fmt(deFato.length)} para cobrar</button><button class="link roxo" data-atr="ocrep">${fmt(comOcRep.length)} têm ocorrência ou reposição</button><button class="link laranja" data-atr="sairam">${fmt(sairam.length)} saíram atrasados daqui</button><button class="link" data-atr="semexp">${fmt(semExp.length)} nem foram expedidos</button></p>
      <p class="s">Pedido que saiu daqui depois da data prometida já nasceu atrasado, e pedido com ocorrência ou reposição aberta no detalhamento de tickets não é só culpa da transportadora: levar eles para a reunião é perder a razão.${detNF ? "" : " (Carregando ocorrências e reposições…)"}</p>` : "<h2>🚚 Nenhum pedido atrasado nesse filtro.</h2>";
    gAtr = { fato: deFato, ocrep: comOcRep, sairam, semexp: semExp };

    desenharProdutividade(L, hoje);
    desenharFaixas(atr);
    // distribuição por situação
    const porSit = new Map(SIT.map(([k]) => [k, 0])); L.forEach((r) => porSit.set(r._sit, porSit.get(r._sit) + 1));
    const maxS = Math.max(1, ...porSit.values());
    $("g-situacao").innerHTML = SIT.map(([k, nome, cor]) => `<button class="barra" data-sit="${k}" title="${nome}: ${fmt(porSit.get(k))}"><span class="barra-nome">${nome}</span>
      <span class="barra-trilho"><span style="width:${Math.max(1, (porSit.get(k) / maxS) * 100)}%;background:${cor}"></span></span><b style="color:${cor}">${fmt(porSit.get(k))}</b></button>`).join("");
    desenharCanais(L);
    gFiltradosCache = L;
    desenharCruz();
    desenharPorTransp(L);
    if (!gSelecao) { gPagina = Math.min(gPagina, 9999); }
    desenharGLista(false);
  }
  let gAtr = {}, gFiltradosCache = [], gDetTentou = false;

  // Atraso por transportadora × UF × cidade × canal (filtro cruzado, como no BI): pedidos em aberto
  const CZ = { transp: (r) => r.transp || "(sem transportadora)", uf: (r) => r.uf || "(sem UF)", cid: (r) => r.cidade || "(sem cidade)", can: (r) => r.canal || "(sem canal)" };
  const CZ_NOME = { transp: "Transportadora", uf: "UF", cid: "Cidade", can: "Canal" };
  const gCruz = { transp: null, uf: null, cid: null, can: null };
  const czPassa = (r, menos) => Object.keys(CZ).every((d) => d === menos || gCruz[d] === null || CZ[d](r) === gCruz[d]);
  function czAgrupa(L, d) {
    const m = new Map();
    L.forEach((r) => { const k = CZ[d](r), x = m.get(k) || { k, q: 0, a: 0, pa: 0, ta: 0 }; x.q++; if (r._atraso) x.a++; if (r.trocas) { x.pa++; x.ta += r.trocas; } m.set(k, x); });
    return [...m.values()].sort((a, b) => b.a - a.a || b.q - a.q || String(a.k).localeCompare(String(b.k), "pt-BR"));
  }
  const czIfa = (x) => (x.a ? (x.q / x.a).toFixed(2).replace(".", ",") : "—");
  function czPerf(x, meta) { const pf = x.q ? 1 - x.a / x.q : 1, ok = pf >= meta; return `<td class="num ${ok ? "ok" : "ruim"}">${ok ? "●" : "↘"} ${(pf * 100).toFixed(2).replace(".", ",")}%</td>`; }
  function czTotal(xs) { return xs.reduce((t, x) => ({ q: t.q + x.q, a: t.a + x.a, pa: t.pa + x.pa, ta: t.ta + x.ta }), { q: 0, a: 0, pa: 0, ta: 0 }); }
  function desenharCruz() {
    const meta = Math.min(100, Math.max(50, parseFloat($("g-meta").value) || 97)) / 100;
    const AB = gFiltradosCache.filter((r) => !r._fechado);
    const linha = (d, x) => `<tr class="clicavel ${gCruz[d] === x.k ? "sel" : ""}" data-czd="${d}" data-czk="${esc(x.k)}"><td>${esc(x.k)}</td>`;
    const nums = (x) => `<td class="num neutro">${fmt(x.q)}</td><td class="num">${fmt(x.a)}</td><td class="num">${czIfa(x)}</td><td class="num">${x.pa ? fmt(x.pa) : ""}</td><td class="num">${fmt(x.ta)}</td>`;
    // transportadora: Performance primeiro (como era)
    const T = czAgrupa(AB.filter((r) => czPassa(r, "transp")), "transp"), tt = czTotal(T);
    $("g-perf-linhas").innerHTML = T.map((x) => linha("transp", x) + czPerf(x, meta) + nums(x) + "</tr>").join("")
      + (T.length ? `<tr class="tot-linha"><td>Total</td>${czPerf(tt, meta)}${nums(tt)}</tr>` : "");
    [["uf", "g-cz-uf"], ["cid", "g-cz-cid"], ["can", "g-cz-can"]].forEach(([d, id]) => {
      const X = czAgrupa(AB.filter((r) => czPassa(r, d)), d), t = czTotal(X);
      $(id).innerHTML = X.map((x) => linha(d, x) + nums(x) + czPerf(x, meta) + "</tr>").join("")
        + (X.length ? `<tr class="tot-linha"><td>Total</td>${nums(t)}${czPerf(t, meta)}</tr>` : `<tr><td colspan="7" class="vazio">Nenhum pedido em aberto.</td></tr>`);
    });
    const sel = Object.keys(CZ).filter((d) => gCruz[d] !== null);
    $("g-cruz-sel").hidden = $("g-cruz-limpar").hidden = !sel.length;
    $("g-cruz-sel").innerHTML = sel.map((d) => `<span class="chip-sel">${CZ_NOME[d]}: <b>${esc(gCruz[d])}</b> <button class="link" data-czx="${d}" title="Tirar">✕</button></span>`).join("");
  }
  function czMudou() {
    desenharCruz();
    const sel = Object.keys(CZ).filter((d) => gCruz[d] !== null);
    if (!sel.length) { gSelecao = null; gPagina = 1; desenharGLista(false); return; }
    selecionar(`Pedidos em aberto · ${sel.map((d) => gCruz[d]).join(" · ")}`, (L) => L.filter((r) => !r._fechado && czPassa(r, null)));
  }
  $("g-cruz-cartao").addEventListener("click", (e) => {
    const x = e.target.closest("[data-czx]"); if (x) { gCruz[x.dataset.czx] = null; return czMudou(); }
    const tr = e.target.closest("tr[data-czd]"); if (!tr) return;
    const d = tr.dataset.czd, k = tr.dataset.czk; gCruz[d] = gCruz[d] === k ? null : k;
    if (d === "uf" && gCruz.cid !== null && gCruz.uf !== null && !gFiltradosCache.some((r) => !r._fechado && CZ.uf(r) === gCruz.uf && CZ.cid(r) === gCruz.cid)) gCruz.cid = null;   // cidade de outra UF
    czMudou();
  });
  $("g-cruz-limpar").addEventListener("click", () => { Object.keys(gCruz).forEach((d) => (gCruz[d] = null)); czMudou(); });
  $("g-cruz-extrair").addEventListener("click", () => {
    const wb = XLSX.utils.book_new();
    [["Transportadora", "#g-perf-linhas"], ["UF", "#g-cz-uf"], ["Cidade", "#g-cz-cid"], ["Canal", "#g-cz-can"]].forEach(([nome, sel]) => {
      const tb = document.querySelector(sel), cab = [...tb.closest("table").querySelectorAll("thead th")].map((c) => c.textContent.trim());
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([cab].concat([...tb.querySelectorAll("tr")].map((tr) => [...tr.children].map((c) => c.textContent.replace(/[●↘]/g, "").trim())))), nome);
    });
    XLSX.writeFile(wb, `atraso_por_transportadora_uf_cidade_canal_${hojeISO()}.xlsx`);
  });

  const gProdK = (t) => (/tempo\s*justo|^\s*vm\b|vm transportes/i.test(t || "") ? "VM Transportes / Tempo Justo" : t || "(sem transportadora)");
  let gProdT = "", gProdCheia = false;
  // celular em pé: na tela cheia o gráfico é girado para ficar deitado (iPhone não deixa travar a tela na horizontal)
  const gProdGiro = () => gProdCheia && innerWidth <= 760 && innerHeight > innerWidth;
  const ajustaGiro = () => $("g-prod-cartao").classList.toggle("girado", gProdGiro());
  function desenharProdutividade(L0, hoje) {
    // filtro de transportadora só do gráfico (VM e Tempo Justo juntas)
    const sel = $("g-prod-transp"), ts = new Map();
    L0.forEach((r) => { const k = gProdK(r.transp); ts.set(k, (ts.get(k) || 0) + 1); });
    if (gProdT && !ts.has(gProdT)) gProdT = "";
    sel.innerHTML = `<option value="">Todas as transportadoras</option>` + [...ts.entries()].sort((a, b) => a[0].localeCompare(b[0], "pt-BR"))
      .map(([k, n]) => `<option value="${esc(k)}" ${k === gProdT ? "selected" : ""}>${esc(k)} (${fmt(n)})</option>`).join("");
    const L = gProdT ? L0.filter((r) => gProdK(r.transp) === gProdT) : L0;
    const J = gJanela, dias = []; for (let i = -J; i <= J; i++) dias.push(somaDias(hoje, i));
    const ent = new Map(), venc = new Map(); let atrHoje = 0;
    L.forEach((r) => {
      if (r.entrega && norm(r.status).startsWith("ENTREGUE")) ent.set(r.entrega, (ent.get(r.entrega) || 0) + 1);
      if (r._atraso) atrHoje++; else if (!r._fechado && r._prom && r._prom >= hoje) venc.set(r._prom, (venc.get(r._prom) || 0) + 1);
    });
    const val = dias.map((d) => ({ d, e: d <= hoje ? ent.get(d) || 0 : null, v: d >= hoje ? venc.get(d) || 0 : 0, a: d === hoje ? atrHoje : 0 }));
    const max = Math.max(1, ...val.map((x) => Math.max(x.e || 0, x.v + x.a)));
    const W = 1000, H = gProdCheia ? Math.max(gProdGiro() ? 180 : 260, Math.round((1000 * Math.max(gProdGiro() ? 160 : 240, gProdGiro() ? innerWidth - 92 : innerHeight - 230)) / Math.max(320, $("g-prod").clientWidth || innerWidth - 40))) : 260, pl = 40, pb = 40, pt = 20, cw = (W - pl - 10) / val.length, y = (n) => H - pb - (n / max) * (H - pb - pt);
    let g = "";
    for (let i = 0; i <= 4; i++) { const n = Math.round((max * i) / 4); g += `<line x1="${pl}" x2="${W - 10}" y1="${y(n)}" y2="${y(n)}" class="grade"/><text x="${pl - 6}" y="${y(n) + 4}" class="eixo" text-anchor="end">${fmt(n)}</text>`; }
    val.forEach((x, i) => {
      const cx = pl + i * cw + cw / 2, bw = Math.min(34, cw * 0.7);
      if (x.v) g += `<rect class="bar-clic" data-dia="${x.d}" data-tipo="vence" x="${cx - bw / 2}" y="${y(x.v)}" width="${bw}" height="${y(0) - y(x.v)}" fill="#16a34a" rx="2"><title>${ddmm(x.d)}: ${fmt(x.v)} vencem</title></rect>`;
      if (x.a) g += `<rect class="bar-clic" data-dia="${x.d}" data-tipo="atraso" x="${cx - bw / 2}" y="${y(x.v + x.a)}" width="${bw}" height="${y(x.v) - y(x.v + x.a)}" fill="#f5b400" rx="2"><title>${fmt(x.a)} atrasados · clique para ver a lista e baixar o Excel</title></rect>`;
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
      txt += `<p>No último dia com movimento (<b>${ddmm(ultDia)}</b>) ${gProdT ? `a <b>${esc(gProdT)}</b> entregou` : "as transportadoras entregaram"} <button class="link verde" data-prod="ent">${fmt(doDia.length)} pedidos</button>, dos quais <button class="link laranja" data-prod="entatr">${fmt(atrasadas)} estavam atrasados</button>${gProdT ? "" : `; o maior volume foi da <b>${esc(tMax)}</b>, com ${fmt(nMax)}`}.</p>`;
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

  // performance de um grupo = (entregues no prazo + em aberto sem atraso) ÷ (entregues + em aberto); cancelados ficam fora
  const ptNovo = () => ({ v: 0, ok: 0, abOk: 0, ent: 0, ab: 0 });
  const ptSoma = (x, r) => { const st = norm(r.status); x.v++;
    if (st.startsWith("CANCELADO")) return; if (st.startsWith("ENTREGUE")) { x.ent++; if (r._sit === "ent_prazo") x.ok++; } else { x.ab++; if (!r._atraso) x.abOk++; } };
  const ptPerf = (x) => (x && x.ent + x.ab ? (x.ok + x.abOk) / (x.ent + x.ab) : null);
  let ptMes = null;
  function desenharPorTransp(L) {
    const porT = new Map(), meses = new Set(), totM = new Map(), totG = ptNovo();
    L.forEach((r) => {
      const t = gProdK(r.transp); const x = porT.get(t) || { tot: 0, ent: 0, ok: 0, can: 0, ab: 0, m: new Map(), g: ptNovo() };
      x.tot++; const st = norm(r.status); if (r._sit === "ent_prazo") x.ok++; if (st.startsWith("ENTREGUE")) x.ent++; else if (st.startsWith("CANCELADO")) x.can++; else x.ab++;
      ptSoma(x.g, r); ptSoma(totG, r);
      const m = (r.criado || "").slice(0, 7);
      if (m) { if (!x.m.has(m)) x.m.set(m, ptNovo()); ptSoma(x.m.get(m), r); if (!totM.has(m)) totM.set(m, ptNovo()); ptSoma(totM.get(m), r); meses.add(m); }
      porT.set(t, x);
    });
    const ord = [...porT.entries()].sort((a, b) => b[1].tot - a[1].tot);
    if (gPtModo === "sit") {
      ptMes = null;
      $("g-pt-cab").innerHTML = `<tr><th>Transportadora</th><th class="num">Total</th><th class="num">Entregues</th><th class="num">SLA entrega</th><th class="num">Cancelados</th><th class="num">Em trânsito</th></tr>`;
      $("g-pt-linhas").innerHTML = ord.map(([t, x]) => `<tr class="clicavel" data-ptt="${esc(t)}"><td>${esc(t)}</td><td class="num neutro tot">${fmt(x.tot)}</td>
        <td class="num verde-t">${fmt(x.ent)} <small>(${Math.round((x.ent / x.tot) * 100)}%)</small></td><td class="num ${corSla(x.ent ? x.ok / x.ent : null)}" title="entregues no prazo ÷ entregues">${pct0(x.ent ? x.ok / x.ent : null)}</td><td class="num neutro">${fmt(x.can)}</td><td class="num azul-t">${fmt(x.ab)}</td></tr>`).join("");
    } else {
      const ms = [...meses].sort().slice(-6), NM = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"], nomeM = (m) => `${NM[+m.slice(5) - 1]}/${m.slice(2, 4)}`;
      const p1 = (x) => (x === null ? "—" : (x * 100).toFixed(1).replace(".", ",") + "%");
      const cel = (x, cls = "") => { const p = ptPerf(x);
        return `<td class="num neutro pt-cel ${cls}" title="${x ? `${fmt(x.v)} pedidos · ${fmt(x.ok)} entregues no prazo, ${fmt(x.ent - x.ok)} entregues com atraso, ${fmt(x.abOk)} em aberto no prazo, ${fmt(x.ab - x.abOk)} em aberto atrasados` : ""}">
          <span class="pt-vol">${fmt(x ? x.v : 0)}</span><span class="pt-perf ${corSla(p)}">${p1(p)}</span></td>`; };
      $("g-pt-cab").innerHTML = `<tr><th>Transportadora</th>${ms.map((m) => `<th class="num">${nomeM(m)}<small class="pt-sub">volume · perf.</small></th>`).join("")}<th class="num">Total<small class="pt-sub">volume · perf.</small></th></tr>`;
      $("g-pt-linhas").innerHTML = ord.map(([t, x]) => `<tr class="clicavel" data-ptt="${esc(t)}"><td>${esc(t)}</td>${ms.map((m) => cel(x.m.get(m))).join("")}${cel(x.g, "tot")}</tr>`).join("")
        + `<tr class="tot-linha"><td>Total</td>${ms.map((m) => cel(totM.get(m))).join("")}${cel(totG, "tot")}</tr>`;
      ptMes = { ms, nomeM, ord, totM, totG };
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
    const nomes = { fato: "Atrasados de fato da transportadora (para cobrar)", ocrep: "Atrasados com ocorrência ou reposição (fora da cobrança)", sairam: "Atrasados que saíram daqui depois da data prometida", semexp: "Atrasados que nem foram expedidos" };
    const ids = new Set(gAtr[b.dataset.atr].map((r) => r.pedido)); selecionar(nomes[b.dataset.atr], (L) => L.filter((r) => ids.has(r.pedido))); });
  $("g-prod-resumo").addEventListener("click", (e) => { const b = e.target.closest("[data-prod]"); if (!b) return; const k = b.dataset.prod, hoje = hojeISO();
    sairCheia();
    if (k === "hoje") return selecionar(`Para entregar hoje (atrasados + vencem hoje)${gProdT ? " · " + gProdT : ""}`, (L) => L.filter((r) => gProdPassa(r) && (r._atraso || (!r._fechado && r._prom === hoje))));
    const ids = new Set(gProd[k].map((r) => r.pedido)); selecionar(k === "ent" ? `Entregues em ${ddmm(gProd.dia)}` : `Entregues atrasados em ${ddmm(gProd.dia)}`, (L) => L.filter((r) => ids.has(r.pedido))); });
  const gProdPassa = (r) => !gProdT || gProdK(r.transp) === gProdT;
  function sairCheia() { if (!gProdCheia) return; gProdCheia = false; $("g-prod-cartao").classList.remove("tela-cheia", "girado"); document.body.classList.remove("sem-rolagem");
    $("g-prod-cheia").textContent = "⛶ Tela cheia"; desenharProdutividade(gFiltradosCache, hojeISO()); }
  $("g-prod").addEventListener("click", (e) => { const b = e.target.closest("[data-dia]"); if (!b) return; const d = b.dataset.dia, t = b.dataset.tipo, sx = gProdT ? " · " + gProdT : "";
    sairCheia();
    if (t === "entregue") selecionar(`Entregues em ${ddmm(d)}${sx}`, (L) => L.filter((r) => gProdPassa(r) && r.entrega === d && norm(r.status).startsWith("ENTREGUE")));
    else if (t === "atraso") { selecionar(`Atrasados (em aberto)${sx}`, (L) => L.filter((r) => gProdPassa(r) && G_CARD.atrasados(r))); baixarGLista(); }
    else selecionar(`Vencem em ${ddmm(d)}${sx}`, (L) => L.filter((r) => gProdPassa(r) && !r._fechado && !r._atraso && r._prom === d)); });
  $("g-prod-transp").addEventListener("change", (e) => { gProdT = e.target.value; desenharProdutividade(gFiltradosCache, hojeISO()); });
  $("g-prod-cheia").addEventListener("click", () => {
    if (gProdCheia) return sairCheia();
    gProdCheia = true; $("g-prod-cartao").classList.add("tela-cheia"); document.body.classList.add("sem-rolagem"); ajustaGiro();
    $("g-prod-cheia").textContent = "✕ Sair da tela cheia"; desenharProdutividade(gFiltradosCache, hojeISO()); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") sairCheia(); });
  addEventListener("resize", () => { if (gProdCheia) { ajustaGiro(); desenharProdutividade(gFiltradosCache, hojeISO()); } });
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
  $("g-pt-linhas").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-ptt]"); if (!tr) return; verPedidosTransp(tr.dataset.ptt); });

  // ---------------- Análise de canais (pedido da Brenda 16/11) ----------------
  // Mesma base e filtros da Visão Gerencial. Amazon e Mercado Livre têm a metodologia própria do canal (índice de impactos ≤ 1%)
  // e a previsão de risco da planilha "Recuperação Amazon" (score por atraso, alterações, status crítico, transportadora de risco, rastreio parado).
  const cSel = { canal: "", card: "agir", transp: null, uf: null, faixa: null, venc: null, risco: null };
  let cDetTentou = false, cPagina = 1, cLista = [], cImp = { canal: null, lista: [], info: null }, cImpCarregado = {};
  const C_FAIXAS = [["1 a 2 dias", 1, 2], ["3 a 5 dias", 3, 5], ["6 a 10 dias", 6, 10], ["11 a 20 dias", 11, 20], ["Acima de 20 dias", 21, 99999]];
  const C_PTS_ATR = [["No prazo", -99999, 0, 0], ["1 a 5 dias", 1, 5, 1], ["6 a 10 dias", 6, 10, 2], ["11 a 20 dias", 11, 20, 3], ["21+ dias", 21, 99999, 5]];
  const C_METODO = {
    amazon: { nome: "Amazon", tit: "Amazon · Índice de pedidos com problemas", rot: "Índice de pedidos com problemas", meta: 0.01,
      sub: "Meta: abaixo de 1% em 60 dias. Soma de avaliações negativas, reivindicações da Garantia de A a Z e pedidos de estorno. A A a Z pode ser aberta a partir do momento em que a data de entrega passa e fica 60 dias na métrica: o canal é 100% preventivo (o cliente nem recebe o link de rastreio).",
      arquivo: "Envie a planilha de impactos da Amazon (colunas ID do pedido, Data do pedido e as marcações X de Avaliações negativas, Reivindicações da Garantia de A a Z e Pedidos de estorno)." },
    ml: { nome: "Mercado Livre", tit: "Mercado Livre · Reclamações", rot: "Reclamações", meta: 0.01,
      sub: "Máximo de 1% das vendas com reclamação (60 dias); acima disso perde a medalha e campanhas. Atraso não é removido do impacto mesmo se o cliente desistir. Mediações: retorno concreto dentro do prazo, senão o valor volta ao cliente.",
      arquivo: "Envie as vendas afetadas do Mercado Livre (\"Baixar vendas afetadas\"): o painel acha o nº da venda em qualquer coluna; se houver coluna de tipo (reclamação/mediação) ela é usada." },
  };
  const metodoDe = (canal) => (/amazon/i.test(canal || "") ? "amazon" : /mercado\s*livre/i.test(canal || "") ? "ml" : null);
  const idCanal = (pedido) => String(pedido || "").replace(/^[A-Z_]+/i, "").trim();   // AMAZON_GLOBAL_API701-… → 701-…; MERCADO_LIVRE2000… → 2000…
  const novaDe = (r) => { const t = trat.get(r.pedido); return t && t.nova_data ? t.nova_data : null; };
  const semNova = (r) => { const n = novaDe(r); return !n || n < hojeISO(); };
  const detDe = (r) => (detNF ? detNF.get(chaveNF(`${r.nf}-${r.serie}`)) : null);
  const atrDias = (r) => (r._d === null ? null : -r._d);   // >0 = dias de atraso pela data prometida original
  const faixaC = (r) => { const d = r._atraso ? Math.max(1, atrDias(r) || r._atraso) : 0; return d ? C_FAIXAS.findIndex(([, a, b]) => d >= a && d <= b) : -1; };

  async function carregarImpactos(canalM) {
    if (!canalM || cImpCarregado[canalM]) return;
    cImpCarregado[canalM] = "carregando";
    const nome = C_METODO[canalM].nome;
    try {
      const [l, i] = await Promise.all([sb.from("canal_impactos").select("id_pedido,tipo,data_pedido").eq("canal", nome).limit(5000), sb.from("canal_impactos_info").select("*").eq("canal", nome).limit(1)]);
      if (l.error) throw l.error;
      cImpCarregado[canalM] = { lista: l.data || [], info: (i.data || [])[0] || null };
    } catch (err) { cImpCarregado[canalM] = { lista: [], info: null, erro: err.message || String(err) }; }
    if (paginaAtual === "canais") desenharCanaisPag();
  }

  // previsão de risco (planilha Recuperação Amazon)
  function riscoCanal(L, imp) {
    const ids = new Set(imp.map((x) => x.id_pedido)), comImp = (r) => ids.has(idCanal(r.pedido));
    const ref = hojeISO(), lim = somaDias(ref, -20);
    const periodo = L.filter((r) => r._sit !== "cancelado" && r.criado && r.criado <= lim);   // pedidos que já tiveram tempo de virar impacto
    const dias = (r) => { if (!r.prevOrig && !r._prom) return null; const o = r.prevOrig || r._prom; return r.entrega ? diasEntre(o, r.entrega) : r._fechado ? null : diasEntre(o, ref); };
    const fx = C_PTS_ATR.map(([n, a, b, p]) => { const ps = periodo.filter((r) => { const d = dias(r); return d !== null && d >= a && d <= b; }); return { n, a, b, p, q: ps.length, i: ps.filter(comImp).length }; });
    const media = periodo.length ? periodo.filter(comImp).length / periodo.length : 0;
    const porT = new Map(); periodo.forEach((r) => { const t = r.transp || "(sem transportadora)", x = porT.get(t) || { t, q: 0, i: 0 }; x.q++; if (comImp(r)) x.i++; porT.set(t, x); });
    const tr = [...porT.values()].map((x) => ({ ...x, tx: x.q ? x.i / x.q : 0, risco: x.q >= 30 && media > 0 && x.i / x.q >= 2 * media })).sort((a, b) => b.i - a.i || b.q - a.q);
    const tRisco = new Set(tr.filter((x) => x.risco).map((x) => x.t));
    const score = new Map();
    L.forEach((r) => { if (r._fechado) return;
      const d = dias(r), pa = d === null ? 0 : (C_PTS_ATR.find(([, a, b]) => d >= a && d <= b) || [0, 0, 0, 0])[3];
      const pal = Math.min(3, r.trocas || 0), pst = /FALHA NA ENTREGA|AVERIGUAR FALHA/i.test(`${r.micro || ""} ${r.status || ""}`) ? 2 : 0;
      const ptr = tRisco.has(r.transp || "(sem transportadora)") ? 1 : 0, psa = r._parado !== null && r._parado >= 10 ? 1 : 0, s = pa + pal + pst + ptr + psa;
      score.set(r.pedido, { s, nivel: s >= 5 ? "Alto" : s >= 3 ? "Médio" : "Baixo", imp: comImp(r) }); });
    return { fx, tr, media, score, comImp, periodo: periodo.length };
  }

  function cBase() {   // pedidos do canal (todos os status), já com os filtros do topo
    const L = gFiltrados();
    return cSel.canal ? L.filter((r) => (r.canal || "(sem canal)") === cSel.canal) : L;
  }
  const C_CARD = { abertos: (r) => !r._fechado, atrasados: (r) => r._atraso > 0, repo: (r) => r._atraso > 0 && !!(detDe(r) || {}).tem_repo,
    ocorr: (r) => r._atraso > 0 && !!(detDe(r) || {}).tem_ocorr, semnova: (r) => r._atraso > 0 && semNova(r),
    agir: (r) => r._atraso > 0 && semNova(r), vence: (r) => !r._atraso && r._d !== null && r._d >= 0 && r._d <= 1 && semNova(r),
    alto: (r) => { const x = cRiscoAtual && cRiscoAtual.score.get(r.pedido); return !!(x && x.nivel === "Alto"); } };
  let cRiscoAtual = null;
  function cPassa(r, menos, risco) {
    if (r._fechado) return false;
    if (menos !== "card" && cSel.card && !C_CARD[cSel.card](r)) return false;
    if (menos !== "transp" && cSel.transp !== null && (r.transp || "(sem transportadora)") !== cSel.transp) return false;
    if (menos !== "uf" && cSel.uf !== null && (r.uf || "(sem UF)") !== cSel.uf) return false;
    if (menos !== "faixa" && cSel.faixa !== null && faixaC(r) !== cSel.faixa) return false;
    if (menos !== "venc" && cSel.venc !== null && !(!r._atraso && (cSel.venc === 8 ? r._d > 7 : r._d === cSel.venc))) return false;
    if (menos !== "risco" && cSel.risco !== null && risco) { const x = risco.score.get(r.pedido); if (cSel.risco === "impab" ? !(x && x.imp) : !(x && x.nivel === cSel.risco)) return false; }
    return true;
  }

  function desenharCanaisPag() {
    if (!gDados) return;
    if (!detNF && !cDetTentou) { cDetTentou = true; carregarDetNF().then(() => { if (paginaAtual === "canais" && detNF) desenharCanaisPag(); }); }
    const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1).replace(".", ",") + "%" : "—"), pct0 = (a, b) => (b ? Math.round((a / b) * 100) + "%" : "—");
    // select de canais (por volume em aberto)
    const todos = gFiltrados(), porC = new Map();
    todos.forEach((r) => { if (r._fechado) return; const c = r.canal || "(sem canal)", x = porC.get(c) || { c, ab: 0, at: 0, sn: 0 }; x.ab++; if (r._atraso) { x.at++; if (semNova(r)) x.sn++; } porC.set(c, x); });
    const canais = [...porC.values()].sort((a, b) => b.ab - a.ab);
    if (cSel.canal && !porC.has(cSel.canal)) cSel.canal = "";
    $("c-canal").innerHTML = `<option value="">Todos os canais</option>` + canais.map((x) => `<option value="${esc(x.c)}" ${x.c === cSel.canal ? "selected" : ""}>${esc(x.c)} (${fmt(x.ab)})</option>`).join("");
    const totAt = canais.reduce((s, x) => s + x.at, 0), meta = Math.min(100, Math.max(50, parseFloat($("g-meta").value) || 97)) / 100;
    $("c-canais-cartao").hidden = !!cSel.canal;
    $("c-canais").innerHTML = canais.map((x) => { const pf = x.ab ? 1 - x.at / x.ab : 1, ok = pf >= meta;
      return `<tr class="clicavel" data-cc="${esc(x.c)}"><td>${esc(x.c)}${metodoDe(x.c) ? ' <span class="chip ambar">métrica do canal</span>' : ""}</td><td class="num neutro">${fmt(x.ab)}</td><td class="num">${fmt(x.at)}</td><td class="num">${pct(x.at, x.ab)}</td><td class="num">${pct0(x.at, totAt)}</td><td class="num">${fmt(x.sn)}</td><td class="num ${ok ? "ok" : "ruim"}">${ok ? "●" : "↘"} ${(pf * 100).toFixed(2).replace(".", ",")}%</td></tr>`; }).join("");

    const B = cBase(), mK = metodoDe(cSel.canal);
    let risco = null;
    if (mK) { carregarImpactos(mK); const im = cImpCarregado[mK]; if (im && im !== "carregando") risco = riscoCanal(B, im.lista); }
    if (!mK) cSel.risco = null;
    cRiscoAtual = risco; if (!risco && cSel.card === "alto") cSel.card = "agir";
    $("c-cards").querySelector('[data-c="alto"]').hidden = !risco;
    // cards (seguem transportadora / UF / faixa / risco, não o próprio card)
    const base = B.filter((r) => cPassa(r, "card", risco));
    const cont = Object.fromEntries(Object.entries(C_CARD).map(([k, f]) => [k, base.filter(f).length]));
    document.querySelectorAll("#c-cards .kpi[data-c]").forEach((b) => { b.querySelector(".kpi-num").textContent = fmt(cont[b.dataset.c]); b.classList.toggle("ativa", cSel.card === b.dataset.c); });
    $("c-pct-txt").textContent = `${pct(cont.atrasados, cont.abertos)} do que está em aberto`;
    // transportadoras e estados (atrasados)
    const rank = (d, f, id) => { const A = B.filter((r) => cPassa(r, d, risco)), m = new Map(), at = A.filter((r) => r._atraso).length;
      A.forEach((r) => { const k = f(r), x = m.get(k) || { k, ab: 0, at: 0 }; x.ab++; if (r._atraso) x.at++; m.set(k, x); });
      $(id).innerHTML = [...m.values()].filter((x) => x.at || cSel[d] === x.k).sort((a, b) => b.at - a.at || b.ab - a.ab).map((x) => `<tr class="clicavel ${cSel[d] === x.k ? "sel" : ""}" data-cd="${d}" data-ck="${esc(x.k)}"><td>${esc(x.k)}</td><td class="num ruim-t">${fmt(x.at)}</td><td class="num">${pct0(x.at, at)}</td><td class="num">${pct0(x.at, x.ab)}</td><td class="num neutro">${fmt(x.ab)}</td></tr>`).join("")
        || `<tr><td colspan="5" class="vazio">Nenhum atraso nesse filtro.</td></tr>`; };
    rank("transp", (r) => r.transp || "(sem transportadora)", "c-transp");
    rank("uf", (r) => r.uf || "(sem UF)", "c-uf");
    // a vencer D0..D+7 e após
    const V = B.filter((r) => cPassa(r, "venc", risco) && !r._atraso && r._d !== null && r._d >= 0), hoje = hojeISO();
    $("c-vencer").innerHTML = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => { const n = V.filter((r) => (i === 8 ? r._d > 7 : r._d === i)).length;
      return `<tr class="clicavel ${cSel.venc === i ? "sel" : ""}" data-cd="venc" data-ck="${i}"><td>${i === 8 ? "Após D+7" : i === 0 ? "Hoje (D0)" : "D+" + i}</td><td>${i === 8 ? "depois de " + br(somaDias(hoje, 7)) : br(somaDias(hoje, i))}</td><td class="num">${fmt(n)}</td></tr>`; }).join("")
      + `<tr class="tot-linha"><td>Total a vencer</td><td></td><td class="num">${fmt(V.length)}</td></tr>`;
    const F = B.filter((r) => cPassa(r, "faixa", risco) && r._atraso), tF = F.length;
    $("c-faixas").innerHTML = C_FAIXAS.map(([n], i) => { const xs = F.filter((r) => faixaC(r) === i);
      return `<tr class="clicavel ${cSel.faixa === i ? "sel" : ""}" data-cd="faixa" data-ck="${i}"><td>${n}</td><td class="num">${fmt(xs.length)}</td><td class="num">${pct0(xs.length, tF)}</td><td class="num">${fmt(xs.filter(semNova).length)}</td></tr>`; }).join("")
      + `<tr class="tot-linha"><td>Total em atraso</td><td class="num">${fmt(tF)}</td><td class="num">${tF ? "100%" : "—"}</td><td class="num">${fmt(F.filter(semNova).length)}</td></tr>`;
    // metodologia do canal (Amazon / Mercado Livre)
    $("c-metodo").hidden = !mK;
    if (mK) {
      const M = C_METODO[mK], im = cImpCarregado[mK];
      $("c-metodo-tit").textContent = M.tit; $("c-metodo-sub").textContent = M.sub; $("c-m-indice-rot").textContent = M.rot;
      if (!im || im === "carregando") $("c-m-info").textContent = "Carregando os impactos do canal…";
      else {
        const v60 = B.filter((r) => r._sit !== "cancelado" && r.criado && r.criado >= somaDias(hoje, -60)).length, vendas = (im.info && im.info.vendas_60d) || v60;
        const n = im.lista.length ? new Set(im.lista.map((x) => x.id_pedido)).size : 0, idx = vendas ? n / vendas : 0;
        const el = $("c-m-indice"); el.querySelector(".kpi-num").textContent = im.lista.length ? (idx * 100).toFixed(2).replace(".", ",") + "%" : "—";
        el.className = "kpi kpi-fixo " + (!im.lista.length ? "" : idx < M.meta ? "verde" : "vermelho");
        $("c-m-indice-sub").innerHTML = im.lista.length ? `${fmt(n)} de ${fmt(vendas)} pedidos · 60 dias · meta abaixo de 1% <button class="link" id="c-vendas">${im.info && im.info.vendas_60d ? "vendas informadas" : "vendas pela base"} ✎</button>` : "envie a lista de impactos";
        const tipos = new Map(); im.lista.forEach((x) => tipos.set(x.tipo || "(sem tipo)", (tipos.get(x.tipo || "(sem tipo)") || 0) + 1));
        $("c-m-info").innerHTML = im.erro ? `Não consegui ler os impactos (${esc(im.erro)}). Rode a parte 39 do supabase/schema.sql.`
          : im.info && im.info.enviado_em ? `Impactos: <b>${esc(im.info.arquivo || "")}</b> enviado em ${new Date(im.info.enviado_em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}${im.info.enviado_por ? " por " + esc(im.info.enviado_por) : ""} · ${[...tipos].map(([t, q]) => `${esc(t)}: ${fmt(q)}`).join(" · ")} · ${fmt(risco.periodo)} pedidos do canal na base para calcular as taxas (média ${(risco.media * 100).toFixed(1).replace(".", ",")}%).`
          : M.arquivo;
        if (risco) {
          const ab = B.filter((r) => cPassa(r, "risco", risco)), cnt = { impab: 0, Alto: 0, Médio: 0, Baixo: 0 };
          ab.forEach((r) => { const x = risco.score.get(r.pedido); if (!x) return; cnt[x.nivel]++; if (x.imp) cnt.impab++; });
          document.querySelectorAll("#c-m-cards .kpi[data-r]").forEach((b) => { b.querySelector(".kpi-num").textContent = fmt(cnt[b.dataset.r]); b.classList.toggle("ativa", cSel.risco === b.dataset.r); });
          $("c-m-faixa").innerHTML = risco.fx.map((x) => `<tr><td>${x.n}</td><td class="num">${fmt(x.q)}</td><td class="num">${fmt(x.i)}</td><td class="num">${pct(x.i, x.q)}</td><td class="num">${x.p}</td></tr>`).join("");
          $("c-m-transp").innerHTML = risco.tr.map((x) => `<tr class="clicavel ${cSel.transp === x.t ? "sel" : ""}" data-cd="transp" data-ck="${esc(x.t)}"><td>${esc(x.t)}</td><td class="num">${fmt(x.q)}</td><td class="num">${fmt(x.i)}</td><td class="num">${pct(x.i, x.q)}</td><td class="num ${x.risco ? "ruim" : ""}">${x.risco ? "Sim" : "Não"}</td></tr>`).join("");
        }
      }
    }
    // seleção
    const nomes = { card: (v) => ({ abertos: "Em aberto", atrasados: "Atrasados", repo: "Com reposição", ocorr: "Com ocorrência", semnova: "Sem nova data", agir: "Atrasados sem nova data", vence: "Vencem hoje ou amanhã", alto: "Risco alto" }[v]), transp: (v) => v, uf: (v) => "UF " + v,
      faixa: (v) => "Atraso " + C_FAIXAS[v][0], venc: (v) => (v === 8 ? "Vence após D+7" : v === 0 ? "Vence hoje" : "Vence em D+" + v), risco: (v) => (v === "impab" ? "Impactos em aberto" : "Risco " + v) };
    const sel = Object.keys(nomes).filter((k) => cSel[k] !== null);
    $("c-sel").hidden = !sel.length;
    $("c-sel").innerHTML = sel.map((k) => `<span class="chip-sel">${esc(nomes[k](cSel[k]))} <button class="link" data-cx="${k}" title="Tirar">✕</button></span>`).join("") + (sel.length ? ' <button class="link" data-cx="tudo">Limpar seleção</button>' : "");
    // lista
    // ordem de ação: risco do canal (Amazon/ML) primeiro, depois mais dias de atraso, depois quem vence antes
    const sc = (r) => (risco && risco.score.get(r.pedido) || {}).s || 0;
    cLista = B.filter((r) => cPassa(r, null, risco)).sort((a, b) => (sc(b) - sc(a)) || (b._atraso - a._atraso) || String(a._prom || "9").localeCompare(String(b._prom || "9")));
    cLista._risco = risco;
    $("c-lista-titulo").textContent = `${cSel.canal || "Todos os canais"} · ${sel.length ? sel.map((k) => nomes[k](cSel[k])).join(" · ") : "Pedidos em aberto"} (${fmt(cLista.length)})`;
    const idxTxt = mK && !$("c-metodo").hidden && cImpCarregado[mK] && cImpCarregado[mK].lista && cImpCarregado[mK].lista.length ? ` · ${$("c-m-indice-rot").textContent}: <b>${$("c-m-indice").querySelector(".kpi-num").textContent}</b> (meta abaixo de 1%)` : "";
    $("c-info").innerHTML = `${esc(cSel.canal || "Todos os canais")} · ${fmt(cont.abertos)} em aberto · ${fmt(cont.atrasados)} atrasados (${pct(cont.atrasados, cont.abertos)})${idxTxt} · base de ${info ? new Date(info.enviado_em).toLocaleDateString("pt-BR") : "—"}`;
    desenharCLista();
  }
  function desenharCLista() {
    const total = cLista.length, pags = Math.max(1, Math.ceil(total / POR_PAGINA)); cPagina = Math.min(Math.max(1, cPagina), pags);
    const risco = cLista._risco;
    $("c-linhas").innerHTML = cLista.slice((cPagina - 1) * POR_PAGINA, cPagina * POR_PAGINA).map((r) => {
      const t = trat.get(r.pedido) || {}, d = detDe(r) || {}, x = risco ? risco.score.get(r.pedido) : null;
      const at = [x && x.nivel !== "Baixo" ? `<span class="chip ${x.nivel === "Alto" ? "vermelho" : "ambar"}">risco ${x.nivel.toLowerCase()}</span>` : "", x && x.imp ? '<span class="chip vermelho">já reclamou</span>' : "",
        d.tem_repo ? '<span class="chip roxo">reposição</span>' : "", d.tem_ocorr ? '<span class="chip laranja">ocorrência</span>' : "",
        !r._atraso && r._d === 0 ? '<span class="chip laranja">vence hoje</span>' : !r._atraso && r._d === 1 ? '<span class="chip ambar">vence amanhã</span>' : "",
        t.nova_data && t.nova_data < hojeISO() ? '<span class="chip vermelho">nova data vencida</span>' : ""].filter(Boolean).join(" ");
      const p = cBaseMapa().get(r.pedido);
      if (p) return linhaPreventivo(p, "data-c-campo", `<td>${at || '<span class="s">—</span>'}</td>`);
      return `<tr data-pedido="${esc(r.pedido)}"><td><div class="p">${esc(r.pedido)}</div><div class="s">NF ${esc(r.nf)}${r.serie ? "-" + esc(r.serie) : ""} · ${esc(r.canal)}</div></td>
        <td>${esc(r.transp)}<div class="s">${esc([r.cidade, r.uf].filter(Boolean).join(" / "))}</div></td><td><span class="ms">${esc(r.micro)}</span></td>
        <td>${br(r._prom) || "—"}${r._atraso ? `<div><span class="chip vermelho">vencido há ${fmt(r._atraso)} d</span></div>` : ""}</td>
        <td><input type="date" data-c-campo="nova_data" value="${esc(t.nova_data || "")}"></td>
        <td class="col-obs"><input data-c-campo="observacao" value="${esc(t.observacao || "")}" placeholder="O que foi feito…" maxlength="1000"><div class="s quem"></div></td>
        <td>${at}</td><td></td></tr>`; }).join("");
    $("c-vazio").hidden = total > 0;
    $("c-paginacao").innerHTML = total > POR_PAGINA ? `<button class="btn" data-p="-1" ${cPagina === 1 ? "disabled" : ""}>‹ Anterior</button><span>Página ${cPagina} de ${pags}</span><button class="btn" data-p="1" ${cPagina === pags ? "disabled" : ""}>Próxima ›</button>` : "";
  }
  const cMudou = () => { cPagina = 1; desenharCanaisPag(); };
  // pedidos do Preventivo por número (para a lista dos canais mostrar as mesmas informações)
  let cMapaBase = null, cMapaDe = null;
  const cBaseMapa = () => { if (cMapaDe !== base) { cMapaBase = new Map(base.map((p) => [p.pedido, p])); cMapaDe = base; } return cMapaBase; };
  $("c-linhas").addEventListener("click", (e) => { if (e.target.closest("input, select, textarea, a, button")) return; const tr = e.target.closest("tr[data-pedido]"); if (tr && cBaseMapa().has(tr.dataset.pedido)) abrirDetalhe(tr.dataset.pedido); });
  $("c-linhas").addEventListener("change", async (e) => {
    const inp = e.target.closest("[data-c-campo]"); if (!inp) return; const tr = inp.closest("tr[data-pedido]");
    await gravar(tr.dataset.pedido, inp.dataset.cCampo, inp.value, tr.querySelector(".quem"));
    // a contagem dos cards acompanha; a linha fica na tela até mudar de página ou de card (para não sumir enquanto escreve)
    if (inp.dataset.cCampo === "nova_data") { const B = cBase(), base = B.filter((r) => cPassa(r, "card", cRiscoAtual));
      document.querySelectorAll("#c-cards .kpi[data-c]").forEach((b) => { b.querySelector(".kpi-num").textContent = fmt(base.filter(C_CARD[b.dataset.c]).length); }); }
  });
  $("c-canal").addEventListener("change", () => { cSel.canal = $("c-canal").value; cSel.risco = null; cMudou(); });
  $("c-cards").addEventListener("click", (e) => { const b = e.target.closest(".kpi[data-c]"); if (!b) return; cSel.card = cSel.card === b.dataset.c && b.dataset.c !== "abertos" ? "abertos" : b.dataset.c; cMudou(); });
  $("c-m-cards").addEventListener("click", (e) => { const b = e.target.closest(".kpi[data-r]"); if (!b) return; cSel.risco = cSel.risco === b.dataset.r ? null : b.dataset.r; cMudou(); });
  $("pagina-canais").addEventListener("click", async (e) => {
    const cc = e.target.closest("tr[data-cc]"); if (cc) { cSel.canal = cc.dataset.cc; return cMudou(); }
    const tr = e.target.closest("tr[data-cd]");
    if (tr) { const d = tr.dataset.cd, k = d === "faixa" || d === "venc" ? +tr.dataset.ck : tr.dataset.ck; cSel[d] = cSel[d] === k ? null : k; return cMudou(); }
    const x = e.target.closest("[data-cx]");
    if (x) { if (x.dataset.cx === "tudo") ["card", "transp", "uf", "faixa", "venc", "risco"].forEach((k) => (cSel[k] = null)); else cSel[x.dataset.cx] = null; return cMudou(); }
    if (e.target.id === "c-vendas") {
      const mK = metodoDe(cSel.canal); if (!mK) return;
      const v = prompt(`Vendas do canal ${C_METODO[mK].nome} nos últimos 60 dias (o mesmo número do painel do canal). Deixe vazio para contar pela base.`, (cImpCarregado[mK].info || {}).vendas_60d || "");
      if (v === null) return; const n = parseInt(String(v).replace(/\D/g, ""), 10) || null;
      const { error } = await sb.rpc("salvar_vendas_canal", { p_canal: C_METODO[mK].nome, p_vendas: n }); if (error) return toast("Erro: " + error.message, true);
      delete cImpCarregado[mK]; carregarImpactos(mK); return;
    }
    const pb = e.target.closest("#c-paginacao button[data-p]"); if (pb) { cPagina += Number(pb.dataset.p); desenharCLista(); }
  });
  // lista de impactos do canal: acha o id do pedido em qualquer coluna; usa as marcações X / coluna de tipo quando houver
  $("c-imp-arq").addEventListener("change", async (e) => {
    const f = e.target.files[0]; e.target.value = ""; const mK = metodoDe(cSel.canal); if (!f || !mK) return;
    try {
      carregando("Lendo os impactos…");
      const wb = XLSX.read(await f.arrayBuffer(), { type: "array", cellDates: true }), RX = mK === "amazon" ? /\b\d{3}-\d{7}-\d{7}\b/ : /\b2\d{15}\b/, out = new Map();
      for (const nome of wb.SheetNames) {
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[nome], { header: 1, defval: "", raw: true }); let cab = null;
        for (const row of rows) {
          const cel = row.map((v) => (v instanceof Date ? v : String(v ?? "").trim()));
          if (!cab && cel.filter((v) => typeof v === "string" && /pedido|venda|reivindica|avalia|estorno|reclama|media/i.test(v)).length >= 1 && !cel.some((v) => typeof v === "string" && RX.test(v))) { cab = cel.map((v) => norm(String(v))); continue; }
          const idCel = cel.find((v) => typeof v === "string" && RX.test(v)); if (!idCel) continue;
          const id = idCel.match(RX)[0]; let tipo = "", data = null;
          if (cab) {
            const marc = cab.map((h, i) => [h, cel[i]]).filter(([h, v]) => /^x$/i.test(String(v)) && !/IMPACTA/.test(h)).map(([h]) => h);
            if (marc.length) tipo = marc.map((h) => (/REIVINDICA|GARANTIA/.test(h) ? "Garantia A a Z" : /AVALIA/.test(h) ? "Avaliação negativa" : /ESTORNO/.test(h) ? "Estorno" : h)).join(" + ");
            const it = cab.findIndex((h) => /^(TIPO|MOTIVO|ESTADO|SITUACAO)/.test(h)); if (!tipo && it >= 0) tipo = String(cel[it] || "");
            const id2 = cab.findIndex((h) => /DATA/.test(h)); if (id2 >= 0) { const v = cel[id2]; data = v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === "number" ? new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10) : null; }
          }
          if (!tipo) tipo = mK === "ml" ? "Reclamação" : "";
          if (/media/i.test(tipo)) tipo = "Mediação"; else if (mK === "ml" && /reclama/i.test(tipo)) tipo = "Reclamação";
          out.set(id + "|" + tipo, { id_pedido: id, tipo: tipo.slice(0, 60), data_pedido: data });
        }
      }
      if (!out.size) throw new Error(mK === "amazon" ? "não achei nenhum ID de pedido da Amazon (formato 701-1234567-1234567)." : "não achei nenhum número de venda do Mercado Livre (16 dígitos começando com 2).");
      const { data, error } = await sb.rpc("importar_impactos", { p_canal: C_METODO[mK].nome, p_arquivo: f.name, linhas: [...out.values()] });
      if (error) throw error;
      delete cImpCarregado[mK]; await carregarImpactos(mK);
      const base = new Set(gDados.map((r) => idCanal(r.pedido))), achados = [...new Set([...out.values()].map((x) => x.id_pedido))].filter((x) => base.has(x)).length;
      toast(`${fmt(data)} impactos guardados para ${C_METODO[mK].nome} · ${fmt(achados)} encontrados na base.`);
    } catch (err) { toast("Não consegui ler: " + (err.message || err), true); }
    finally { carregando(false); }
  });
  function linhasCExcel(L) {
    const risco = cLista._risco;
    return [["Pedido", "NF", "Série", "Canal", "Transportadora", "UF", "Cidade", "Status", "Micro status", "Prometido", "Dias de atraso", "Faixa", "Nova data", "Observação", "Reposição", "Ocorrência", "Impacto", "Risco", "Score", "Alterações da data", "Dias sem atualização"]]
      .concat(L.map((r) => { const t = trat.get(r.pedido) || {}, d = detDe(r) || {}, x = risco ? risco.score.get(r.pedido) : null, fi = faixaC(r);
        return [r.pedido, r.nf, r.serie, r.canal, r.transp, r.uf, r.cidade || "", r.status, r.micro, br(r._prom), r._atraso || 0, fi >= 0 ? C_FAIXAS[fi][0] : "", t.nova_data ? br(t.nova_data) : "", t.observacao || "",
          d.tem_repo ? "Sim" : "", d.tem_ocorr ? "Sim" : "", x && x.imp ? "Sim" : "", x ? x.nivel : "", x ? x.s : "", r.trocas || 0, r._parado ?? ""]; }));
  }
  $("c-exportar").addEventListener("click", () => { if (!cLista.length) return toast("Nada para exportar.", true);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(linhasCExcel(cLista)), "Pedidos"); XLSX.writeFile(wb, `analise_canais_${(cSel.canal || "todos").replace(/\W+/g, "_")}_${hojeISO()}.xlsx`); });
  $("c-extrair").addEventListener("click", () => { const A = cLista.filter((r) => r._atraso); if (!A.length) return toast("Nenhum atraso nessa seleção.", true);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(linhasCExcel(A)), "Atrasos"); XLSX.writeFile(wb, `atrasos_${(cSel.canal || "todos").replace(/\W+/g, "_")}_${hojeISO()}.xlsx`); });
  $("c-copiar").addEventListener("click", async () => {
    const txt = (id) => [...document.querySelectorAll(`#${id} tr`)].slice(0, 5).map((tr) => `  • ${tr.cells[0].textContent.trim()}: ${tr.cells[1].textContent.trim()} atrasados (${tr.cells[3].textContent.trim()})`).join("\n");
    const B = cBase().filter((r) => !r._fechado), k = (c) => fmt(B.filter(C_CARD[c]).length);
    let t = `Análise de canais · ${cSel.canal || "Todos os canais"} · ${new Date().toLocaleDateString("pt-BR")}\n`
      + `Em aberto: ${k("abertos")} · Atrasados: ${k("atrasados")} (${$("c-pct-txt").textContent})\n`
      + `Atrasados sem nova data: ${k("agir")} · vencem hoje ou amanhã sem nova data: ${k("vence")} · atrasados com reposição: ${k("repo")} · com ocorrência: ${k("ocorr")}\n`
      + `Transportadoras que mais seguram o canal:\n${txt("c-transp")}\nEstados com mais atraso:\n${txt("c-uf")}`;
    if (!$("c-metodo").hidden) t += `\n${$("c-m-indice-rot").textContent}: ${$("c-m-indice").querySelector(".kpi-num").textContent} (meta abaixo de 1%) · risco alto: ${document.querySelector('#c-m-cards [data-r="Alto"] .kpi-num').textContent} · médio: ${document.querySelector('#c-m-cards [data-r="Médio"] .kpi-num').textContent}`;
    try { await navigator.clipboard.writeText(t); toast("Análise copiada: é só colar no e-mail ou no WhatsApp."); } catch (_) { prompt("Copie o texto:", t); }
  });


  // ---------------- Cobrança do dia (controle de retornos das transportadoras) ----------------
  // Cada pedido em aberto cai em UM balde, na ordem de prioridade. Retorno válido = nova data de hoje em diante.
  const RT_NOMES = { p1: "Atrasado sem retorno", p2: "Promessa quebrada", p3: "Atrasado só com observação", p4: "Vence hoje sem retorno", p5: "Vence amanhã sem retorno", p6: "Nova data vence hoje/amanhã", ok: "Em dia", cobrar: "Tudo para cobrar" };
  const RT_ACAO = { p1: "Cobrar retorno com nova data", p2: "Cobrar de novo e escalar (data não cumprida)", p3: "Pedir a previsão de entrega", p4: "Cobrar hoje para não atrasar", p5: "Confirmar a entrega de amanhã", p6: "Confirmar que entrega na nova data" };
  // Retorno padronizado (como no E-loggia do Danilo): palavras do retorno → categoria, com responsável por categoria.
  // As regras ficam no banco (parte 43) e valem para todos; sem regra guardada, valem as de fábrica.
  const RT_FABRICA = [
    ["Entrega agendada", ["AGENDAD", "AGENDAMENTO"]],
    ["Em processo de devolução", ["DEVOLU", "RETORNANDO PARA O REMETENTE", "BARRADA", "CANCELADA", "AGUARDANDO NFD"]],
    ["Em processo de reposição", ["REPOSI", "FALTA DE VOL", "FALTA VOLUME", "EXTRAVIO", "AVARIA", "MERCADORIA SINISTRADA", "CTRC BAIXADO"]],
    ["Em buscas", ["BUSCAS", "EM BUSCA"]],
    ["Não chegou para a transportadora", ["NAO COLETAD", "NAO FOI COLETAD", "NAO TEMOS EM SISTEMA", "NAO DEU ENTRADA", "NAO EMBARCAD", "SEM ENTRADA", "NAO RECEBEMOS", "MERCADORIA NAO COLETA", "SEM EMISSAO", "NAO TENHO ESTA NF", "NAO CONSTA EM NOSSA BASE"]],
    ["Ocorrência - pendência SAC", ["AUSENTE", "RECUSA", "NAO LOCALIZAD", "ENDERECO INCORRETO", "MUDOU-SE", "FECHADO", "AGUARDANDO INSTRU", "CONTATO", "AGUARDANDO RETORNO", "CONFIRMACAO DE DADOS"]],
    ["Mercadoria retida", ["RETIDA", "RETENCAO", "FISCALIZACAO"]],
    ["Roubo / área de risco", ["ROUBO", "FURTO", "AREA DE RISCO", "SINISTRO"]],
    ["Pendência transportadora - cobrar", ["SEM PREVISAO", "AGUARDANDO POSICAO", "VERIFICANDO", "TRATANDO", "EM ANALISE", "EM TRATATIVA", "AGUARDANDO ATUALIZACAO", "SOBRA CONSTATADA", "ENTREGA PREJUDICADA", "VOLUME TROCADO", "AGUARDANDO O RECEBIMENTO", "AGUARDANDO LIBERACAO"]],
    ["Em rota de entrega", ["EM ROTA", "EMROTA", "ROTA DE ENTREGA", "SAIDA PARA ENTREGA"]],
    ["Entregue", ["ENTREGUE", "ENTREGA FINALIZADA", "FINALIZADO"]],
  ].map(([categoria, palavras], i) => ({ categoria, palavras, responsavel_id: null, ordem: i + 1 }));
  let rtRegras = RT_FABRICA.map((x) => ({ ...x, palavras: [...x.palavras] })), rtRegrasSalvas = false, rtRegrasOk = true;
  const RT_SEMOBS = "Sem observação", RT_NAOPAD = "Não padronizado";
  const rtCatCache = new Map();
  function rtCat(obs) {   // categoria do retorno (texto da observação): a 1ª regra cuja palavra aparece no texto
    if (!obs) return RT_SEMOBS;
    if (rtCatCache.has(obs)) return rtCatCache.get(obs);
    const t = norm(obs), r = rtRegras.find((g) => g.palavras.some((w) => w && t.includes(norm(w))));
    const c = r ? r.categoria : RT_NAOPAD; rtCatCache.set(obs, c); return c;
  }
  const rtRegraDe = (cat) => rtRegras.find((g) => g.categoria === cat) || null;
  const rtRespDe = (cat) => { const g = rtRegraDe(cat); return g && g.responsavel_id ? pessoas.find((x) => x.id === g.responsavel_id) || null : null; };
  async function carregarRegrasRetorno() {
    const { data, error } = (await sb.from("retorno_regras").select("*").order("ordem").then((r) => r, (e) => ({ error: e }))) || { error: true };
    rtRegrasOk = !error;
    if (!error && data && data.length) { rtRegras = data.map((x) => ({ ...x, palavras: x.palavras || [] })); rtRegrasSalvas = true; }
    rtCatCache.clear();
  }
  async function salvarRegras(lista, apagar = []) {   // grava as regras passadas (na 1ª vez, a lista inteira, com as de fábrica)
    if (!rtRegrasOk) { toast("Para guardar as regras, rode no Supabase a parte 43 do supabase/schema.sql.", true); return false; }
    if (apagar.length) { const { error } = await sb.from("retorno_regras").delete().in("categoria", apagar); if (error) { toast("Não salvei: " + error.message, true); return false; } }
    const linhas = lista.map((g) => ({ categoria: g.categoria, palavras: g.palavras, responsavel_id: g.responsavel_id || null, ordem: g.ordem }));
    if (linhas.length) { const { error } = await sb.from("retorno_regras").upsert(linhas, { onConflict: "categoria" }); if (error) { toast("Não salvei: " + error.message, true); return false; } }
    rtRegrasSalvas = true; rtCatCache.clear(); return true;
  }
  function desenharRegras() {
    const ops = (sel) => `<option value="">${PENDENTE}</option>` + pessoas.map((x) => `<option value="${x.id}" ${x.id === sel ? "selected" : ""}>${esc(x.nome)}${x.area ? " · " + esc(x.area) : ""}</option>`).join("");
    $("rt-regras").innerHTML = rtRegras.map((g) => `<div class="rt-regra" data-cat="${esc(g.categoria)}">
        <div class="rt-regra-nome"><b>${esc(g.categoria)}</b><select class="rt-regra-resp" title="Responsável por este retorno">${ops(g.responsavel_id)}</select></div>
        <div class="rt-regra-pal">${g.palavras.map((w, i) => `<span class="t-chip">${esc(w)}<button type="button" data-tirar-pal="${i}" title="Tirar">×</button></span>`).join("")}
          <button type="button" class="link" data-tirar-cat title="Apagar esta categoria">apagar categoria</button></div></div>`).join("");
    $("rt-cat-lista").innerHTML = rtRegras.map((g) => `<option value="${esc(g.categoria)}">`).join("");
    $("rt-regras-aviso").hidden = rtRegrasOk;
    const v = $("rt-resp").value;
    $("rt-resp").innerHTML = `<option value="">Todos</option><option value="-">${PENDENTE}</option>` + pessoas.map((x) => `<option value="${x.id}" ${String(x.id) === v ? "selected" : ""}>${esc(x.nome)}</option>`).join("");
    if (v === "-") $("rt-resp").value = "-";
  }
  // VM Transportes e Tempo Justo são a mesma transportadora (regra da Brenda, 16/11)
  const rtT = (p) => (/tempo\s*justo|^\s*vm\b|vm transportes/i.test(p.transportadora || "") ? "VM Transportes / Tempo Justo" : p.transportadora || "(sem transportadora)");
  const rtNovaValida = (p) => { const nv = p._t && p._t.nova_data; return !!nv && String(nv).slice(0, 10) >= hojeISO(); };
  let rtSemData = new Map();
  let rtCards = new Set(), rtTransp = null, rtCatSel = null, rtPag = 1, rtLista = [], rtResumo = null, rtResumoEm = 0;
  function rtBalde(p) {
    if (p.entregue_ip) return null;
    const t = p._t || {}, hoje = hojeISO(), amanha = somaDias(hoje, 1), nova = t.nova_data ? String(t.nova_data).slice(0, 10) : null, obs = (t.observacao || "").trim();
    if (p._atrasoG && !nova && !obs) return "p1";
    if (nova && nova < hoje) return "p2";
    if (p._atrasoG && !nova && obs) return "p3";
    if (!p._atrasoG && !nova && p._dias === 0) return "p4";
    if (!p._atrasoG && !nova && p._dias === 1) return "p5";
    if (nova && (nova === hoje || nova === amanha)) return "p6";
    if (nova) return "ok";
    return null;   // no prazo, sem retorno: ainda não precisa cobrar
  }
  async function carregarResumoRetornos() {
    if (rtResumo && Date.now() - rtResumoEm < 5 * 60000) return;
    const { data, error } = (await sb.rpc("resumo_retornos").then((r) => r, (e) => ({ error: e }))) || { error: true };
    rtResumoEm = Date.now();
    rtResumo = error ? null : new Map((data || []).map((x) => [x.pedido, x]));
    $("rt-aviso").hidden = !error;
    if (error) $("rt-aviso").innerHTML = '⚠ O histórico de retornos ainda não está ligado: rode a <b>parte 40</b> do supabase/schema.sql no Supabase (SQL Editor › New query › Run). O resto da página já funciona.';
  }
  function rtPassaFiltro(p) {
    const q = norm($("rt-busca").value), tr = $("rt-transp").value, cn = $("rt-canal").value;
    if (q && !norm(p.pedido).includes(q) && !norm(p.nf).includes(q)) return false;
    if (tr && (rtT(p)) !== tr) return false;
    if (cn && (p.canal || "(sem canal)") !== cn) return false;
    const rs = $("rt-resp").value;
    if (rs) { const r = rtRespDe(rtCat(p._t && p._t.observacao)); if (rs === "-" ? !!r : !r || String(r.id) !== rs) return false; }
    return true;
  }
  function desenharRetornos() {
    if (!base.length) { $("rt-info").textContent = "Carregando os pedidos…"; return; }
    const opts = (id, f) => { const el = $(id), v = el.value, xs = [...new Set(base.map(f))].sort((a, b) => a.localeCompare(b, "pt-BR"));
      el.innerHTML = `<option value="">Todas</option>` + xs.map((x) => `<option ${x === v ? "selected" : ""}>${esc(x)}</option>`).join(""); };
    opts("rt-transp", (p) => rtT(p)); opts("rt-canal", (p) => p.canal || "(sem canal)");
    const L = base.filter(rtPassaFiltro).map((p) => { p._rt = rtBalde(p); return p; });
    const cont = { p1: 0, p2: 0, p3: 0, p4: 0, p5: 0, p6: 0, ok: 0, cobrar: 0 };
    L.forEach((p) => { if (!p._rt) return; cont[p._rt]++; if (p._rt !== "ok") cont.cobrar++; });
    document.querySelectorAll("#rt-cards .kpi[data-rt]").forEach((b) => { b.querySelector(".kpi-num").textContent = fmt(cont[b.dataset.rt]); b.classList.toggle("ativa", b.dataset.rt === "cobrar" ? !rtCards.size : rtCards.has(b.dataset.rt)); });
    $("menu-rt").hidden = !cont.p1 && !cont.p2; $("menu-rt").textContent = fmt(cont.p1 + cont.p2);
    // por transportadora
    const porT = new Map();
    L.forEach((p) => { const k = rtT(p), x = porT.get(k) || porT.set(k, { k, p1: 0, p2: 0, p3: 0, p4: 0, p5: 0, p6: 0, ok: 0, alvo: 0, cob: 0, queb: 0 }).get(k);
      if (p._rt) x[p._rt]++;
      if (p._atrasoG || p._dias === 0 || p._dias === 1) { x.alvo++; const nv = p._t && p._t.nova_data; if (nv && String(nv).slice(0, 10) >= hojeISO()) x.cob++; }
      const r = rtResumo && rtResumo.get(p.pedido); if (r) x.queb += r.quebradas || 0; });
    const pctTxt = (a, b) => (b ? Math.round((a / b) * 100) + "%" : "—");
    $("rt-transp-linhas").innerHTML = [...porT.values()].map((x) => ({ ...x, cobrar: x.p1 + x.p2 + x.p3 + x.p4 + x.p5 + x.p6 })).filter((x) => x.cobrar || x.ok).sort((a, b) => (b.p1 + b.p2) - (a.p1 + a.p2) || b.cobrar - a.cobrar)
      .map((x) => `<tr class="clicavel ${rtTransp === x.k ? "sel" : ""}" data-rtt="${esc(x.k)}"><td>${esc(x.k)}</td><td class="num ${x.p1 ? "ruim-t" : ""}">${fmt(x.p1)}</td><td class="num ${x.p2 ? "ruim-t" : ""}">${fmt(x.p2)}</td><td class="num">${fmt(x.p3)}</td><td class="num">${fmt(x.p4)}</td><td class="num">${fmt(x.p5)}</td><td class="num">${fmt(x.p6)}</td><td class="num"><b>${fmt(x.cobrar)}</b></td>
        <td class="num ${x.alvo && x.cob / x.alvo < 0.7 ? "ruim" : "ok"}">${pctTxt(x.cob, x.alvo)}</td><td class="num">${rtResumo ? fmt(x.queb) : "—"}</td>
        <td><button class="btn mini contorno" data-rtx="${esc(x.k)}" title="Excel no formato do Enviar retornos, só desta transportadora">⤓ Cobrança</button> <button class="btn mini contorno" data-rtm="${esc(x.k)}" title="Texto pronto para e-mail ou WhatsApp">⧉ Mensagem</button></td></tr>`).join("")
      || `<tr><td colspan="11" class="vazio">Nada para cobrar.</td></tr>`;
    // observações
    const C = L.filter((p) => p._rt), porC = new Map();
    const naCard = (p) => p._rt && (rtCards.size ? rtCards.has(p._rt) : p._rt !== "ok");
    C.filter(naCard).forEach((p) => { const c = rtCat(p._t && p._t.observacao); const x = porC.get(c) || porC.set(c, { c, n: 0 }).get(c); x.n++; });
    const ordC = new Map(rtRegras.map((g, i) => [g.categoria, i])); ordC.set(RT_NAOPAD, 998); ordC.set(RT_SEMOBS, 999);
    $("rt-cats").innerHTML = [...porC.values()].sort((a, b) => (ordC.get(a.c) ?? 997) - (ordC.get(b.c) ?? 997)).map((x) => { const r = rtRespDe(x.c);
      return `<button class="rt-cat ${rtCatSel === x.c ? "sel" : ""} ${x.c === RT_NAOPAD ? "naopad" : ""}" data-rtc="${esc(x.c)}"><b>${fmt(x.n)}</b> ${esc(x.c)}<small>${x.c === RT_SEMOBS || x.c === RT_NAOPAD ? (x.c === RT_NAOPAD ? "padronize abaixo" : "cobrar o retorno") : r ? "👤 " + esc(r.nome) : PENDENTE}</small></button>`; }).join("")
      || '<p class="s">Nada para cobrar nos cards marcados.</p>';
    // resumo por retorno padronizado (cada retorno é uma linha, como um status; todas as transportadoras juntas)
    { const G = new Map(), linha = (c) => G.get(c) || G.set(c, { c, n: 0, atr: 0, vence: 0, soma: 0, sem: 0 }).get(c);
      rtRegras.forEach((g) => linha(g.categoria)); linha(RT_NAOPAD); linha(RT_SEMOBS);
      L.filter(naCard).forEach((p) => { const x = linha(rtCat(p._t && p._t.observacao)); x.n++;
        if (p._atrasoG) { x.atr++; x.soma += Math.max(0, -(p._dias ?? 0)); } else if (p._dias === 0 || p._dias === 1) x.vence++;
        if (!rtNovaValida(p)) x.sem++; });
      const tot = [...G.values()].reduce((a, x) => ({ n: a.n + x.n, atr: a.atr + x.atr, vence: a.vence + x.vence, soma: a.soma + x.soma, sem: a.sem + x.sem }), { n: 0, atr: 0, vence: 0, soma: 0, sem: 0 });
      const med = (x) => (x.atr ? (x.soma / x.atr).toFixed(1).replace(".", ",") : "—");
      $("rt-resumo-linhas").innerHTML = [...G.values()].map((x) => { const r = rtRespDe(x.c);
        return `<tr class="clicavel ${rtCatSel === x.c ? "sel" : ""} ${x.n ? "" : "zero"}" data-rtc="${esc(x.c)}"><td>${esc(x.c)}</td><td>${x.c === RT_SEMOBS || x.c === RT_NAOPAD ? "—" : r ? esc(r.nome) : `<span class="pendente">${PENDENTE}</span>`}</td>
          <td class="num"><b>${fmt(x.n)}</b></td><td class="num">${fmt(x.atr)}</td><td class="num">${fmt(x.vence)}</td><td class="num">${med(x)}</td><td class="num ${x.sem ? "ruim-t" : ""}">${fmt(x.sem)}</td></tr>`; }).join("")
        + `<tr class="total"><td><b>Total</b></td><td></td><td class="num"><b>${fmt(tot.n)}</b></td><td class="num"><b>${fmt(tot.atr)}</b></td><td class="num"><b>${fmt(tot.vence)}</b></td><td class="num">${med(tot)}</td><td class="num"><b>${fmt(tot.sem)}</b></td></tr>`; }
    // transportadoras sem nova data e em reposição (independe dos cards)
    { rtSemData = new Map();
      L.filter((p) => p._rt && p._rt !== "ok").forEach((p) => { const k = rtT(p), x = rtSemData.get(k) || rtSemData.set(k, { k, atr: 0, vence: 0, rep: 0, repSem: 0, peds: [] }).get(k);
        const sem = !rtNovaValida(p), rep = norm(rtCat(p._t && p._t.observacao)).includes("REPOSI");
        if (sem && p._atrasoG) x.atr++; else if (sem) x.vence++;
        if (rep) { x.rep++; if (sem) x.repSem++; }
        if (sem || rep) x.peds.push(p); });
      $("rt-semdata-linhas").innerHTML = [...rtSemData.values()].filter((x) => x.atr + x.vence + x.rep).sort((a, b) => (b.atr + b.vence) - (a.atr + a.vence) || b.rep - a.rep)
        .map((x) => `<tr class="clicavel ${rtTransp === x.k ? "sel" : ""}" data-rtt="${esc(x.k)}"><td>${esc(x.k)}</td><td class="num ${x.atr ? "ruim-t" : ""}">${fmt(x.atr)}</td><td class="num">${fmt(x.vence)}</td><td class="num"><b>${fmt(x.atr + x.vence)}</b></td><td class="num">${fmt(x.rep)}</td><td class="num ${x.repSem ? "ruim-t" : ""}">${fmt(x.repSem)}</td></tr>`).join("")
        || `<tr><td colspan="6" class="vazio">Todas as transportadoras com nova data. 🎉</td></tr>`; }
    // lista
    const ordem = { p1: 1, p2: 2, p4: 3, p3: 4, p5: 5, p6: 6, ok: 9 };
    rtLista = L.filter((p) => naCard(p) && (!rtTransp || (rtT(p)) === rtTransp)
      && (!rtCatSel || rtCat(p._t && p._t.observacao) === rtCatSel))
      .sort((a, b) => ordem[a._rt] - ordem[b._rt] || (a._dias ?? 0) - (b._dias ?? 0));
    $("rt-titulo").textContent = `${rtCards.size ? [...rtCards].map((k) => RT_NOMES[k]).join(" + ") : RT_NOMES.cobrar}${rtTransp ? " · " + rtTransp : ""}${rtCatSel ? " · " + rtCatSel : ""} (${fmt(rtLista.length)})`;
    const totAlvo = L.filter((p) => !p.entregue_ip && (p._atrasoG || p._dias === 0 || p._dias === 1)).length, totCob = L.filter((p) => !p.entregue_ip && (p._atrasoG || p._dias === 0 || p._dias === 1) && p._t && p._t.nova_data && String(p._t.nova_data).slice(0, 10) >= hojeISO()).length;
    $("rt-info").innerHTML = `${fmt(cont.cobrar)} pedidos para cobrar hoje · cobertura geral <b>${pctTxt(totCob, totAlvo)}</b> (atrasados e vencendo com retorno válido) · ${fmt(L.filter((p) => p.entregue_ip).length)} já entregues na Intelipost ficam fora`;
    desenharRtLista();
  }
  function desenharRtLista() {
    const tot = rtLista.length, pags = Math.max(1, Math.ceil(tot / POR_PAGINA)); rtPag = Math.min(Math.max(1, rtPag), pags);
    $("rt-linhas").innerHTML = rtLista.slice((rtPag - 1) * POR_PAGINA, rtPag * POR_PAGINA).map((p) => {
      const c = rtCat(p._t && p._t.observacao), r = rtResumo && rtResumo.get(p.pedido), rp = rtRespDe(c);
      const cob = `<span class="chip ${["p1", "p2"].includes(p._rt) ? "vermelho" : ["p3", "p4"].includes(p._rt) ? "laranja" : p._rt === "ok" ? "verde" : "ambar"}">${RT_NOMES[p._rt]}</span>
        <div class="s">${RT_ACAO[p._rt] || "acompanhar"}</div>${c !== RT_SEMOBS ? `<div class="s">📝 ${esc(c)}${c !== RT_NAOPAD ? ` · ${rp ? "👤 " + esc(rp.nome) : PENDENTE}` : ""}</div>` : ""}${r ? `<div class="s">${fmt(r.retornos)} retorno${r.retornos === 1 ? "" : "s"}${r.quebradas ? ` · <b class="txt-vermelho">${fmt(r.quebradas)} promessa${r.quebradas === 1 ? "" : "s"} quebrada${r.quebradas === 1 ? "" : "s"}</b>` : ""}</div>` : ""}`;
      return linhaPreventivo(p, "data-rt-campo", `<td>${cob}</td>`); }).join("");
    $("rt-vazio").hidden = tot > 0;
    $("rt-paginacao").innerHTML = tot > POR_PAGINA ? `<button class="btn" data-p="-1" ${rtPag === 1 ? "disabled" : ""}>‹ Anterior</button><span>Página ${rtPag} de ${pags}</span><button class="btn" data-p="1" ${rtPag === pags ? "disabled" : ""}>Próxima ›</button>` : "";
  }
  async function abrirRetornos() { desenharRetornos(); await Promise.all([carregarResumoRetornos(), carregarRegrasRetorno(), pessoas.length ? null : carregarResponsaveis()]); desenharRegras(); desenharRetornos(); }
  // regras: guardar, tirar palavra, apagar categoria, responsável, voltar às de fábrica
  $("rt-regra-salvar").addEventListener("click", async () => {
    const cat = $("rt-regra-cat").value.trim(), pal = $("rt-regra-pal").value.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);
    if (!cat || !pal.length) return toast("Diga a categoria e pelo menos uma palavra.", true);
    const lista = rtRegras.map((g) => ({ ...g, palavras: [...g.palavras] }));
    let g = lista.find((x) => norm(x.categoria) === norm(cat));
    if (!g) { g = { categoria: cat, palavras: [], responsavel_id: null, ordem: Math.max(0, ...lista.map((x) => x.ordem || 0)) + 1 }; lista.push(g); }
    pal.forEach((w) => { if (!g.palavras.some((x) => norm(x) === norm(w))) g.palavras.push(w); });
    if (!(await salvarRegras(rtRegrasSalvas ? [g] : lista))) return;
    rtRegras = lista; rtCatCache.clear(); $("rt-regra-pal").value = ""; desenharRegras(); desenharRetornos(); toast("Regra guardada: vale para todos.");
  });
  $("rt-regras").addEventListener("click", async (e) => {
    const box = e.target.closest(".rt-regra"); if (!box) return; const cat = box.dataset.cat;
    const lista = rtRegras.map((g) => ({ ...g, palavras: [...g.palavras] })), g = lista.find((x) => x.categoria === cat);
    const tp = e.target.closest("[data-tirar-pal]");
    if (tp) { g.palavras.splice(Number(tp.dataset.tirarPal), 1); if (!(await salvarRegras(rtRegrasSalvas ? [g] : lista))) return; rtRegras = lista; }
    else if (e.target.closest("[data-tirar-cat]")) { if (!confirm(`Apagar a categoria "${cat}"? Os retornos dela passam a "${RT_NAOPAD}".`)) return;
      const resto = lista.filter((x) => x.categoria !== cat); if (!(await salvarRegras(resto, rtRegrasSalvas ? [cat] : []))) return; rtRegras = resto; }
    else return;
    rtCatCache.clear(); desenharRegras(); desenharRetornos();
  });
  $("rt-regras").addEventListener("change", async (e) => {
    const sel = e.target.closest(".rt-regra-resp"); if (!sel) return; const cat = sel.closest(".rt-regra").dataset.cat;
    const lista = rtRegras.map((g) => ({ ...g })), g = lista.find((x) => x.categoria === cat); g.responsavel_id = sel.value ? Number(sel.value) : null;
    if (!(await salvarRegras(rtRegrasSalvas ? [g] : lista))) { desenharRegras(); return; }
    rtRegras = lista; toast(`Responsável de "${cat}" salvo.`); desenharRetornos();
  });
  $("rt-regras-fabrica").addEventListener("click", async () => {
    if (!confirm("Voltar para as regras de fábrica? As palavras e categorias que vocês criaram serão apagadas (os responsáveis das categorias de fábrica ficam).")) return;
    const resp = new Map(rtRegras.map((g) => [g.categoria, g.responsavel_id]));
    const lista = RT_FABRICA.map((g) => ({ ...g, palavras: [...g.palavras], responsavel_id: resp.get(g.categoria) || null }));
    const apagar = rtRegrasSalvas ? rtRegras.map((g) => g.categoria).filter((c) => !lista.some((x) => x.categoria === c)) : [];
    rtRegrasSalvas = true; if (!(await salvarRegras(lista, apagar))) return;
    rtRegras = lista; rtCatCache.clear(); desenharRegras(); desenharRetornos(); toast("Regras de fábrica de volta.");
  });
  // planilha de cobrança: mesmas colunas do "Enviar retornos" (Pedido Intelipost, NF, Transportadora, Nova Data, Observação) + o que a transportadora precisa saber
  function rtLinhasExcel(L) {
    return [["Pedido Intelipost", "NF", "Transportadora", "Nova Data", "Observação", "Motivo da cobrança", "Prometido ao cliente", "Data informada antes", "Último retorno", "Canal", "UF", "Cidade", "Micro status", "Retorno padronizado", "Responsável"]]
      .concat(L.map((p) => { const t = p._t || {}; return [p.pedido, p.nf, p.transportadora, null, null, RT_NOMES[p._rt], br(p._venc), br(t.nova_data), t.observacao || "", p.canal, p.uf, p.cidade || "", p.micro_status, rtCat(t.observacao), (rtRespDe(rtCat(t.observacao)) || {}).nome || ""]; }));
  }
  const rtParaCobrar = (tr) => base.filter((p) => rtPassaFiltro(p) && (p._rt = rtBalde(p)) && p._rt !== "ok" && (!tr || (rtT(p)) === tr));
  function rtBaixar(tr) {
    const L = rtParaCobrar(tr); if (!L.length) return toast("Nada para cobrar.", true);
    const wb = XLSX.utils.book_new(), porT = new Map(); L.forEach((p) => { const k = rtT(p); (porT.get(k) || porT.set(k, []).get(k)).push(p); });
    for (const [k, xs] of [...porT.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const ws = XLSX.utils.aoa_to_sheet(rtLinhasExcel(xs)); ws["!cols"] = [{ wch: 34 }, { wch: 12 }, { wch: 22 }, { wch: 12 }, { wch: 40 }, { wch: 26 }, { wch: 12 }, { wch: 12 }, { wch: 40 }];
      XLSX.utils.book_append_sheet(wb, ws, k.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Transportadora"); }
    XLSX.writeFile(wb, `cobranca_${tr ? tr.replace(/\W+/g, "_") + "_" : ""}${hojeISO()}.xlsx`);
    toast(`${fmt(L.length)} pedido(s) na planilha. Mande para a transportadora; quando voltar preenchida (Nova Data e Observação), suba no Enviar retornos do Preventivo.`);
  }
  function rtMensagem(tr) {
    const L = rtParaCobrar(tr); if (!L.length) return "";
    const grupo = (k) => L.filter((p) => p._rt === k);
    let t = `Olá, equipe ${tr}! Precisamos do retorno dos pedidos abaixo, com a nova data de entrega de cada um, ainda hoje:\n`;
    for (const k of ["p1", "p2", "p3", "p4", "p5", "p6"]) { const xs = grupo(k); if (!xs.length) continue;
      t += `\n${RT_NOMES[k]} (${xs.length}):\n` + xs.slice(0, 60).map((p) => `• NF ${p.nf} · pedido ${p.pedido} · prometido ${br(p._venc)}${p._t && p._t.nova_data ? ` · data informada ${br(p._t.nova_data)}` : ""}`).join("\n") + (xs.length > 60 ? `\n… e mais ${xs.length - 60} (na planilha)` : "") + "\n"; }
    return t + "\nObrigado!";
  }
  $("rt-cards").addEventListener("click", (e) => { const b = e.target.closest(".kpi[data-rt]"); if (!b) return; const k = b.dataset.rt;   // marca vários; "Tudo para cobrar" limpa
    if (k === "cobrar") rtCards.clear(); else if (rtCards.has(k)) rtCards.delete(k); else rtCards.add(k); rtPag = 1; desenharRetornos(); });
  $("pagina-retornos").addEventListener("click", async (e) => {
    const x = e.target.closest("[data-rtx]"); if (x) return rtBaixar(x.dataset.rtx);
    const m = e.target.closest("[data-rtm]");
    if (m) { const t = rtMensagem(m.dataset.rtm); if (!t) return toast("Nada para cobrar.", true); try { await navigator.clipboard.writeText(t); toast("Mensagem copiada: cole no e-mail ou WhatsApp da transportadora."); } catch (_) { prompt("Copie a mensagem:", t); } return; }
    const tt = e.target.closest("tr[data-rtt]"); if (tt) { rtTransp = rtTransp === tt.dataset.rtt ? null : tt.dataset.rtt; rtPag = 1; return desenharRetornos(); }
    const c = e.target.closest("[data-rtc]"); if (c) { rtCatSel = rtCatSel === c.dataset.rtc ? null : c.dataset.rtc; rtPag = 1; return desenharRetornos(); }
    const pb = e.target.closest("#rt-paginacao button[data-p]"); if (pb) { rtPag += Number(pb.dataset.p); return desenharRtLista(); }
    if (e.target.closest("input, select, textarea, a, button")) return;
    const tr = e.target.closest("#rt-linhas tr[data-pedido]"); if (tr) abrirDetalhe(tr.dataset.pedido);
  });
  $("rt-linhas").addEventListener("change", async (e) => { const inp = e.target.closest("[data-rt-campo]"); if (!inp) return; const tr = inp.closest("tr[data-pedido]");
    await gravar(tr.dataset.pedido, inp.dataset.rtCampo, inp.value, tr.querySelector(".quem")); });
  let rtEspera; $("rt-busca").addEventListener("input", () => { clearTimeout(rtEspera); rtEspera = setTimeout(() => { rtPag = 1; desenharRetornos(); }, 250); });
  ["rt-transp", "rt-canal", "rt-resp"].forEach((id) => $(id).addEventListener("change", () => { rtPag = 1; desenharRetornos(); }));
  $("rt-limpar").addEventListener("click", () => { $("rt-busca").value = ""; $("rt-transp").value = ""; $("rt-canal").value = ""; $("rt-resp").value = ""; rtTransp = null; rtCatSel = null; rtCards.clear(); rtPag = 1; desenharRetornos(); });
  $("rt-excel").addEventListener("click", () => rtBaixar(null));
  $("rt-semdata-excel").addEventListener("click", () => {
    const L = [...rtSemData.values()].flatMap((x) => x.peds); if (!L.length) return toast("Nada sem nova data.", true);
    const linhas = [["Transportadora", "Pedido Intelipost", "NF", "Situação", "Prometido ao cliente", "Nova data informada", "Observação", "Retorno padronizado", "Responsável", "Canal", "UF"]]
      .concat(L.map((p) => { const t = p._t || {}, c = rtCat(t.observacao); return [p.transportadora, p.pedido, p.nf, rtNovaValida(p) ? "Em reposição (com nova data)" : p._atrasoG ? "Atrasado sem nova data" : "Vence hoje/amanhã sem nova data", br(p._venc), br(t.nova_data), t.observacao || "", c, (rtRespDe(c) || {}).nome || "", p.canal, p.uf]; }));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(linhas), "Sem nova data"); XLSX.writeFile(wb, `transportadoras_sem_nova_data_${hojeISO()}.xlsx`);
  });
  $("rt-copiar").addEventListener("click", async () => {
    const L = base.filter((p) => (p._rt = rtBalde(p))), c = (k) => L.filter((p) => p._rt === k).length, porT = new Map();
    L.filter((p) => p._rt === "p1" || p._rt === "p2").forEach((p) => { const k = rtT(p); porT.set(k, (porT.get(k) || 0) + 1); });
    const t = `Cobrança do dia · ${new Date().toLocaleDateString("pt-BR")}\n`
      + `1) Atrasados sem retorno: ${fmt(c("p1"))}\n2) Promessas quebradas: ${fmt(c("p2"))}\n3) Atrasados só com observação: ${fmt(c("p3"))}\n4) Vencem hoje sem retorno: ${fmt(c("p4"))}\n5) Vencem amanhã sem retorno: ${fmt(c("p5"))}\n6) Nova data vence hoje/amanhã: ${fmt(c("p6"))}\n`
      + `Transportadoras com mais pendências (1 + 2):\n` + [...porT.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `  • ${k}: ${fmt(n)}`).join("\n");
    try { await navigator.clipboard.writeText(t); toast("Resumo copiado."); } catch (_) { prompt("Copie o resumo:", t); }
  });

  // a lista de pedidos fica na Visão Gerencial: abre ela já filtrada pela transportadora
  function verPedidosTransp(t) {
    if (paginaAtual !== "gerencial") { irPara("gerencial"); montarGerencial(); }
    selecionar(`Todos os pedidos · ${t}`, (L) => L.filter((r) => (r.transp || "(sem transportadora)") === t || gProdK(r.transp) === t));
  }
  $("g-pt-modo").addEventListener("click", (e) => { const b = e.target.closest("button[data-m]"); if (!b) return; gPtModo = b.dataset.m;
    $("g-pt-modo").querySelectorAll("button").forEach((x) => x.classList.toggle("ativo", x === b)); desenharPorTransp(gFiltradosCache); });
  $("g-pt-extrair").addEventListener("click", () => {
    let linhas;
    if (gPtModo === "mes" && ptMes) {
      const { ms, nomeM, ord, totM, totG } = ptMes, pc = (x) => { const p = ptPerf(x); return p === null ? "" : +(p * 100).toFixed(1); };
      const vals = (x) => [x ? x.v : 0, pc(x), x ? x.ok : 0, x ? x.ent - x.ok : 0, x ? x.abOk : 0, x ? x.ab - x.abOk : 0];
      const cab = ["Transportadora"]; ms.concat(["total"]).forEach((m) => { const n = m === "total" ? "Total" : nomeM(m);
        cab.push(`${n} · Volume`, `${n} · Performance %`, `${n} · Entregues no prazo`, `${n} · Entregues c/ atraso`, `${n} · Em aberto no prazo`, `${n} · Em aberto atrasados`); });
      linhas = [cab].concat(ord.map(([t, x]) => [t].concat(...ms.map((m) => vals(x.m.get(m))), vals(x.g))), [["Total"].concat(...ms.map((m) => vals(totM.get(m))), vals(totG))]);
    } else linhas = [...document.querySelectorAll(".tabela-pt tr")].map((tr) => [...tr.children].map((c) => c.textContent.trim()));
    const ws = XLSX.utils.aoa_to_sheet(linhas); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Por transportadora");
    XLSX.writeFile(wb, `pedidos_por_transportadora_${gPtModo === "sit" ? "situacao" : "mes"}_${hojeISO()}.xlsx`);
  });
  ["g-de", "g-ate"].forEach((id) => $(id).addEventListener("change", filtrosGMudaram));
  let esperaG; $("g-nf").addEventListener("input", () => { clearTimeout(esperaG); esperaG = setTimeout(filtrosGMudaram, 300); });
  $("g-meta").addEventListener("change", () => { try { localStorage.setItem("painel.meta", $("g-meta").value); } catch (_) {} desenharGAtual(); });
  $("g-perf-nota").addEventListener("click", (e) => { if (e.target.id === "g-modo") { gTodos = !gTodos; desenharGerencial(); } });
  $("g-limpar").addEventListener("click", () => { Object.values(gSel).forEach((s) => s.clear()); ["g-de", "g-ate", "g-nf"].forEach((id) => ($(id).value = "")); montarFiltrosG(); filtrosGMudaram(); });
  $("g-paginacao").addEventListener("click", (e) => { const b = e.target.closest("button[data-p]"); if (!b) return; gPagina += Number(b.dataset.p); desenharGLista(false); });
  // Excel da Visão Gerencial no modelo "multimoveis-atrasados-em-aberto" (55 colunas, pedido da Brenda 13/11)
  let detNF = null, detNFErro = "";   // nf -> ocorrência / reposição / assistência técnica (aba do detalhamento, parte 32)
  async function carregarDetNF() {
    if (detNF) return detNF;
    try { const L = await buscarComCache("detalhe_nf", "nf", "*", ticketsInfo ? ticketsInfo.enviado_em : ""); detNF = new Map(L.map((x) => [x.nf, x])); detNFErro = ""; return detNF; }
    catch (err) { detNFErro = err.message || String(err); return new Map(); }   // não guarda o erro: tenta de novo no próximo Excel
  }
  // colunas que não ficam na memória da Visão Gerencial: busca só dos pedidos que vão para o Excel
  async function extrasDe(pedidos) {
    const out = new Map(), lotes = [];
    for (let i = 0; i < pedidos.length; i += 150) lotes.push(pedidos.slice(i, i + 150));
    let cols = "pedido,extra,prev_360,link_rastreio";
    for (let i = 0; i < lotes.length; i += 4) {
      carregando(`Montando o Excel… ${fmt(Math.min((i + 4) * 150, pedidos.length))} de ${fmt(pedidos.length)}`);
      const rs = await Promise.all(lotes.slice(i, i + 4).map(async (l) => {
        let r = await sb.from("base_pedidos").select(cols).in("pedido", l);
        if (r.error && /extra/i.test(r.error.message || "")) { cols = "pedido,prev_360,link_rastreio"; r = await sb.from("base_pedidos").select(cols).in("pedido", l); }
        if (r.error) throw r.error; return r.data; }));
      rs.flat().forEach((x) => out.set(x.pedido, x));
    }
    return out;
  }
  const G_XLS_COLS = ["Pedido Intelipost", "ID Any", "Pedido Anymarket", "Nota-Série", "Número da NF", "Série", "Nova NF reposição", "Data Estimada 360 (AL)", "Nova Data (sistema)",
    "Observação do BI", "Fila", "Status da fila", "Status da Ocorrencia", "Ultima mensagem da ocorrencia", "Canal", "Origem", "Transportadora", "Status", "Micro Stauts",
    "Range de Atraso", "Dias de Atraso", "De quem é o atraso", "Últ. Movimento", "Data Criação", "Data Emissão", "Data Expedição", "Emissão do CT-e", "Prev. Original",
    "Prev. Atual", "Data Entrega", "UF", "Cidade", "CEP", "Chave da nota", "Link Rastreio", "Valor da NF", "Valor recebido CT-e", "Nº do CT-e", "Ticket", "Qtd de tickets",
    "Pedido Promob", "SKU", "Status Prazo", "Situação", "Transportadora de redespacho", "Trocas da data prometida", "Prazo da transportadora (dias úteis)", "Dias sem movimento",
    "Prazo médio da transportadora (dias)", "Previsão estimada", "Dias além da previsão estimada", "Observação (sistema)", "Tem reposição", "Tem ocorrência", "Tem assistência técnica"];
  const G_SIT_NOME = { ent_prazo: "Entregue (no prazo)", ent_atraso: "Entregue (com atraso)", ab_prazo: "Em aberto (no prazo)", ab_risco: "Em aberto (em risco)", ab_atraso: "Em aberto (atrasado)", cancelado: "Cancelado" };
  async function baixarGLista() {
    if (!gLista.length) return toast("Nada para exportar.", true);
    const lista = gLista.slice(), hoje = hojeISO();
    carregando("Montando o Excel…");
    let ex, det;
    try { [ex, det] = await Promise.all([extrasDe(lista.map((r) => r.pedido)), carregarDetNF()]); }
    catch (err) { carregando(""); return toast("Não consegui montar o Excel: " + (err.message || err), true); }
    // prazo médio de cada transportadora = média de dias entre expedição e entrega dos já entregues da base
    const pm = new Map();
    gDados.forEach((r) => { if (r._sit !== "ent_prazo" && r._sit !== "ent_atraso") return; if (!r.despacho || !r.entrega) return;
      const d = diasEntre(r.despacho, r.entrega); if (!Number.isFinite(d) || d < 0 || d > 120) return; const x = pm.get(r.transp) || [0, 0]; x[0] += d; x[1]++; pm.set(r.transp, x); });
    const media = (t) => { const x = pm.get(t); return x && x[1] ? Math.round(x[0] / x[1]) : null; };
    const quem = (r) => !r._atraso ? "" : r._semExp ? "Ainda não foi expedido" : r._prom && r.despacho > r._prom ? "Já saiu atrasado daqui" : "Atraso da transportadora";
    const sim = (v) => (v ? "sim" : "");
    const somaSeg = (iso, n) => { try { return somaDias(iso, n); } catch (_) { return null; } };
    let linhas;
    try { linhas = [G_XLS_COLS].concat(lista.map((r) => {
      const e = ex.get(r.pedido) || {}, x = e.extra || {}, nfs = r.serie ? `${r.nf}-${r.serie}` : r.nf, d = det.get(chaveNF(nfs)) || {}, tk = tickets.get(chaveNF(nfs)) || {}, t = trat.get(r.pedido) || {};
      const pmT = media(r.transp), base = r.despacho || r.criado, prevEst = pmT !== null && /^\d{4}-\d{2}-\d{2}/.test(base || "") ? somaSeg(base.slice(0, 10), pmT) : null;
      return [r.pedido, x.id_any || "", x.pedido_any || "", nfs, r.nf, r.serie, d.repo_nf || "", br(e.prev_360), br(t.nova_data), "",
        tk.fila || "", "", d.ocorr_status || "", d.ocorr_msg || "", r.canal || "", r.origem || "", r.transp || "", r.status || "", r.micro || "",
        r.range || "", r.diasAtr ?? (r._atraso || 0), quem(r), br(r.ult), br(r.criado), br(x.faturamento), br(r.despacho), br(x.emissao_cte), br(r.prevOrig),
        br(r.prev), br(r.entrega), r.uf || "", r.cidade || "", x.cep || "", x.chave || "", e.link_rastreio || "", x.valor_nf ?? "", x.valor_cte ?? "", x.num_cte || "", tk.id_ticket || "", tk.qtd || "",
        x.promob || "", x.sku || "", r.sprazo || "", G_SIT_NOME[r._sit] || "", x.redespacho || "", x.trocas ?? 0, x.prazo_transp ?? "", r._fechado ? "" : r._parado ?? "",
        pmT ?? "", br(prevEst), prevEst && !r._fechado ? diasEntre(prevEst, hoje) : "", t.observacao || "", sim(d.tem_repo), sim(d.tem_ocorr), sim(d.tem_at)];
    })); } catch (err) { carregando(""); return toast("Não consegui montar o Excel: " + (err.message || err), true); }
    const ws = XLSX.utils.aoa_to_sheet(linhas); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Pedidos");
    carregando("");
    XLSX.writeFile(wb, `multimoveis-${(gSelecao ? gSelecao.titulo : G_NOME[gCard]).normalize("NFD").replace(/[^\w]+/g, "-").replace(/-+$/, "").toLowerCase()}_${hoje}.xlsx`);
    const nDet = lista.filter((r) => det.has(chaveNF(r.serie ? `${r.nf}-${r.serie}` : r.nf))).length;
    if (detNFErro) toast("Ocorrências e reposições não vieram: " + detNFErro, true);
    else if (!det.size) toast('Ocorrências e reposições estão vazias: envie o detalhamento de tickets de novo no botão "Carregar tickets".', true);
    else toast(`Excel baixado. ${fmt(nDet)} de ${fmt(lista.length)} pedidos têm ocorrência, reposição ou AT no detalhamento (${fmt(det.size)} notas guardadas).`);
  }
  $("g-exportar").addEventListener("click", baixarGLista);

  // ---------------- transportadoras ----------------
  // Fonte: a mesma base da Visão Gerencial (botão "Carregar planilha"), com os mesmos filtros do topo.
  // Volume = pedidos sem os cancelados. Atraso médio = dias entre a data prometida e a entrega, nos entregues com atraso.
  // SLA entrega = entregues no prazo ÷ entregues.
  const T_CORES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];   // até 8 transportadoras na comparação (cor fica com a transportadora)
  const T_MAX = T_CORES.length;
  let tStats = [], tOrdem = "vol";
  const tCmp = new Map();   // transportadora -> índice da cor
  const tNome = (r) => r.transp || "(sem transportadora)";
  function statsTransp(L) {
    const m = new Map();
    L.forEach((r) => {
      const t = tNome(r);
      const x = m.get(t) || { t, vol: 0, ab: 0, atr: 0, risco: 0, ent: 0, entOk: 0, entAtr: 0, somaAtr: 0, nAtr: 0, can: 0, meses: new Map(), ufs: new Map() };
      if (r._sit === "cancelado") { x.can++; [[x.ufs, r.uf || "(sem UF)"], [x.meses, (r.criado || "").slice(0, 7)]].forEach(([mp, k]) => { if (!k) return; const u = mp.get(k) || { vol: 0, ab: 0, atr: 0, ent: 0, ok: 0, can: 0 }; u.can++; mp.set(k, u); }); m.set(t, x); return; }
      x.vol++;
      if (!r._fechado) x.ab++;
      if (r._atraso > 0) x.atr++;
      if (G_CARD.risco(r)) x.risco++;
      if (r._sit === "ent_prazo" || r._sit === "ent_atraso") x.ent++;
      if (r._sit === "ent_prazo") x.entOk++;
      if (r._sit === "ent_atraso") { x.entAtr++; if (r.entrega && r._prom) { const d = diasEntre(r._prom, r.entrega); if (d > 0) { x.somaAtr += d; x.nAtr++; } } }
      const soma = (mp, k) => { const u = mp.get(k) || { vol: 0, ab: 0, atr: 0, ent: 0, ok: 0, can: 0 };
        u.vol++; if (!r._fechado) u.ab++; if (r._atraso > 0) u.atr++;
        if (r._sit === "ent_prazo" || r._sit === "ent_atraso") u.ent++; if (r._sit === "ent_prazo") u.ok++; mp.set(k, u); };
      const mes = (r.criado || "").slice(0, 7); if (mes) soma(x.meses, mes);
      soma(x.ufs, r.uf || "(sem UF)");
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
    $("t-info").textContent = !info ? 'Envie a base ("Carregar planilha") para montar esta página.'
      : `Base de ${new Date(info.enviado_em).toLocaleDateString("pt-BR")} · ${fmt(L.length)} pedidos nos filtros`;
    const soma = (k) => tStats.reduce((a, x) => a + x[k], 0);
    const ent = soma("ent"), ab = soma("ab");
    $("t-k-qtd").textContent = fmt(tStats.filter((x) => x.vol).length);
    $("t-k-vol").textContent = fmt(soma("vol"));
    $("t-k-atr").textContent = fmt(soma("atr")); $("t-k-atr-s").textContent = `de ${fmt(ab)} em aberto`;
    $("t-k-sla").textContent = ent ? pct0(soma("entOk") / ent) : "—";
    // tira da comparação quem sumiu com os filtros
    [...tCmp.keys()].forEach((t) => { if (!tStats.some((x) => x.t === t)) tCmp.delete(t); });
    desenharDetalhe(); desenharPorTransp(L); desenharComparacao(); desenharHistorico();
  }
  function desenharDetalhe() {
    const ord = { vol: (a, b) => b.vol - a.vol, ab: (a, b) => b.ab - a.ab, atr: (a, b) => b.atr - a.atr, risco: (a, b) => b.risco - a.risco, entAtr: (a, b) => b.entAtr - a.entAtr,
      med: (a, b) => (b.med ?? -1) - (a.med ?? -1), sla: (a, b) => (a.sla ?? 2) - (b.sla ?? 2), nome: (a, b) => a.t.localeCompare(b.t, "pt-BR") }[tOrdem];
    const linhas = tStats.filter((x) => x.vol).sort((a, b) => ord(a, b) || b.vol - a.vol);
    $("t-det-sub").textContent = `${fmt(linhas.length)} transportadoras na base`;
    const cheio = tCmp.size >= T_MAX;
    $("t-det-linhas").innerHTML = linhas.map((x) => { const c = tCmp.has(x.t);
      return `<tr><td class="cmp"><input type="checkbox" data-cmp="${esc(x.t)}" ${c ? "checked" : ""} ${!c && cheio ? "disabled" : ""} aria-label="Comparar ${esc(x.t)}">${c ? `<i class="t-bola" style="background:${T_CORES[tCmp.get(x.t)]}"></i>` : ""}</td>
        <td class="clic" data-ver="${esc(x.t)}">${esc(x.t)}</td><td class="num neutro">${fmt(x.vol)}</td><td class="num neutro">${fmt(x.ab)}</td>
        <td class="num vermelho-t">${fmt(x.atr)}</td><td class="num laranja-t">${fmt(x.risco)}</td><td class="num neutro">${fmt(x.entAtr)}</td>
        <td class="num neutro">${diasTxt(x.med)}</td><td class="num ${corSla(x.sla)}">${pct0(x.sla)}</td></tr>`; }).join("");
  }
  // performance igual à da Visão Gerencial: 1 − atrasados ÷ em aberto (ou ÷ todos os pedidos, se lá estiver "todos")
  const perfT = (u) => { if (!u) return null; const d = gTodos ? u.vol + (u.can || 0) : u.ab; return d ? 1 - u.atr / d : null; };
  const pct1 = (v) => (v === null ? "—" : (v * 100).toFixed(1).replace(".", ",") + "%");
  const T_METRICAS = [
    ["Performance", (x) => perfT(x), pct1, "max"],
    ["Volume", (x) => x.vol, fmt, "max"], ["Em aberto", (x) => x.ab, fmt, null], ["Atrasados (em aberto)", (x) => x.atr, fmt, "min"],
    ["% atrasados do em aberto", (x) => (x.ab ? x.atr / x.ab : null), (v) => (v === null ? "—" : (v * 100).toFixed(1).replace(".", ",") + "%"), "min"],
    ["Em risco (vencem hoje/amanhã)", (x) => x.risco, fmt, null], ["Entregues", (x) => x.ent, fmt, "max"], ["Entregues com atraso", (x) => x.entAtr, fmt, "min"],
    ["Atraso médio", (x) => x.med, diasTxt, "min"], ["SLA entrega", (x) => x.sla, pct0, "max"], ["Cancelados", (x) => x.can, fmt, "min"],
  ];
  function desenharComparacao() {
    const sel = [...tCmp.keys()].map((t) => tStats.find((x) => x.t === t)).filter(Boolean);
    $("t-cmp-chips").innerHTML = sel.map((x) => `<span class="t-chip"><i class="t-bola" style="background:${T_CORES[tCmp.get(x.t)]}"></i>${esc(x.t)}<button type="button" data-tirar-cmp="${esc(x.t)}" aria-label="Tirar ${esc(x.t)}">×</button></span>`).join("");
    const livres = tStats.filter((x) => x.vol && !tCmp.has(x.t)).sort((a, b) => b.vol - a.vol);
    $("t-cmp-add").innerHTML = `<option value="">${tCmp.size >= T_MAX ? "Máximo de " + T_MAX : "Escolha…"}</option>` + (tCmp.size >= T_MAX ? "" : livres.map((x) => `<option>${esc(x.t)}</option>`).join(""));
    $("t-cmp-add").disabled = tCmp.size >= T_MAX;
    $("t-cmp-vazio").hidden = sel.length >= 2; $("t-cmp-corpo").hidden = sel.length < 2;
    if (sel.length < 2) return;
    $("t-cmp-cab").innerHTML = `<tr><th></th>${sel.map((x) => `<th class="num"><i class="t-bola" style="background:${T_CORES[tCmp.get(x.t)]}"></i>${esc(x.t)}</th>`).join("")}</tr>`;
    $("t-cmp-linhas").innerHTML = T_METRICAS.map(([nome, f, fm, melhor]) => {
      return `<tr><td>${nome}</td>${celulasMelhor(sel.map(f), fm, melhor)}</tr>`;
    }).join("");
    grafMeses(sel); tabelaUF(sel);
  }
  // células de uma linha da comparação, com a melhor em negrito (pelo valor que aparece; empate de todas = nenhuma)
  function celulasMelhor(vs, fm, melhor) {
    const ok = vs.filter((v) => v !== null);
    const alvo = melhor && ok.length > 1 ? (melhor === "max" ? Math.max(...ok) : Math.min(...ok)) : null;
    const txtAlvo = alvo === null ? null : fm(alvo), iguais = ok.filter((v) => fm(v) === txtAlvo).length;
    const marca = alvo !== null && iguais < ok.length;
    return vs.map((v) => `<td class="num neutro${marca && v !== null && fm(v) === txtAlvo ? " melhor" : ""}">${fm(v)}</td>`).join("");
  }
  // por UF: um estado por linha, as transportadoras comparadas nas colunas
  let tUfMet = "vol";
  const T_UF_MET = {
    vol: ["Volume", (u) => (u ? u.vol : null), fmt, "max"], ab: ["Em aberto", (u) => (u ? u.ab : null), fmt, null],
    atr: ["Atrasados", (u) => (u ? u.atr : null), fmt, "min"],
    patr: ["% atrasados", (u) => (u && u.ab ? u.atr / u.ab : null), (v) => (v === null ? "—" : (v * 100).toFixed(1).replace(".", ",") + "%"), "min"],
    sla: ["SLA entrega", (u) => (u && u.ent ? u.ok / u.ent : null), pct0, "max"],
    perf: ["Performance", perfT, pct1, "max"],
  };
  function tabelaUF(sel) {
    const [, f, fm, melhor] = T_UF_MET[tUfMet];
    const tot = new Map(); sel.forEach((x) => x.ufs.forEach((u, uf) => tot.set(uf, (tot.get(uf) || 0) + u.vol)));
    const ufs = [...tot.entries()].sort((a, b) => b[1] - a[1]).map(([uf]) => uf);
    $("t-uf-met").querySelectorAll("button").forEach((b) => b.classList.toggle("ativo", b.dataset.m === tUfMet));
    $("t-uf-cab").innerHTML = `<tr><th>UF</th>${sel.map((x) => `<th class="num"><i class="t-bola" style="background:${T_CORES[tCmp.get(x.t)]}"></i>${esc(x.t)}</th>`).join("")}</tr>`;
    $("t-uf-linhas").innerHTML = ufs.map((uf) => `<tr><td>${esc(uf)}</td>${celulasMelhor(sel.map((x) => f(x.ufs.get(uf))), fm, melhor)}</tr>`).join("");
  }
  $("t-uf-met").addEventListener("click", (e) => { const b = e.target.closest("button[data-m]"); if (!b) return; tUfMet = b.dataset.m; desenharComparacao(); });

  // linhas: volume por mês (últimos 6 meses com pedidos), uma linha por transportadora
  function grafMeses(sel) {
    const [nomeMet, fMet, fmMet] = T_UF_MET[tUfMet], pctMet = ["patr", "sla", "perf"].includes(tUfMet);
    const val = (x, m) => { const v = fMet(x.meses.get(m)); return v === null || v === undefined ? (pctMet ? null : 0) : v; };
    $("t-graf-tit").textContent = `${nomeMet} por mês (criação do pedido)`;
    const todos = new Set(); sel.forEach((x) => x.meses.forEach((_, m) => todos.add(m)));
    const ms = [...todos].sort().slice(-6), NM = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
    const box = $("t-cmp-graf");
    if (ms.length < 2) { box.innerHTML = `<p class="vazio">Sem meses suficientes para o gráfico (precisa da Data de Criação na base).</p>`; return; }
    const W = 760, H = 260, E = 44, D = sel.length <= 4 ? 150 : 20, T = 16, B = 30, pw = W - E - D, ph = H - T - B;
    const max = Math.max(pctMet ? 0.01 : 1, ...sel.flatMap((x) => ms.map((m) => val(x, m) || 0)));
    let topo;
    if (pctMet) topo = Math.min(1, Math.ceil(max / 0.2) * 0.2) || 1;
    else { const bruto = max / 4, p10 = Math.pow(10, Math.floor(Math.log10(bruto))); topo = Math.max(1, [1, 2, 2.5, 5, 10].map((k) => k * p10).find((k) => k >= bruto)) * 4; }
    const eixo = (v) => (pctMet ? Math.round(v * 100) + "%" : fmt(Math.round(v)));
    const X = (i) => E + (pw * i) / (ms.length - 1), Y = (v) => T + ph - (ph * v) / topo;
    const rot = (m) => `${NM[+m.slice(5) - 1]}/${m.slice(2, 4)}`;
    let g = "";
    for (let k = 0; k <= 4; k++) { const v = (topo * k) / 4, y = Y(v); g += `<line x1="${E}" x2="${E + pw}" y1="${y}" y2="${y}" class="gr-grade"/><text x="${E - 6}" y="${y + 4}" class="gr-eixo" text-anchor="end">${eixo(v)}</text>`; }
    ms.forEach((m, i) => { g += `<text x="${X(i)}" y="${H - 8}" class="gr-eixo" text-anchor="middle">${rot(m)}</text>`; });
    // rótulos diretos no fim da linha, sem encavalar
    const fins = sel.map((x) => ({ x, y: Y(val(x, ms[ms.length - 1]) || 0) })).sort((a, b) => a.y - b.y);
    for (let k = 1; k < fins.length; k++) if (fins[k].y - fins[k - 1].y < 14) fins[k].y = fins[k - 1].y + 14;
    sel.forEach((x) => {
      const cor = T_CORES[tCmp.get(x.t)];
      // sem valor no mês (ex.: % sem pedidos em aberto) = quebra a linha
      let seg = []; const fecha = () => { if (seg.length > 1) g += `<polyline points="${seg.join(" ")}" fill="none" stroke="${cor}" stroke-width="2" stroke-linejoin="round"/>`; seg = []; };
      ms.forEach((m, i) => { const v = val(x, m); if (v === null) { fecha(); return; } seg.push(`${X(i)},${Y(v)}`); g += `<circle cx="${X(i)}" cy="${Y(v)}" r="4" fill="${cor}" stroke="#fff" stroke-width="2"/>`; });
      fecha();
    });
    if (sel.length <= 4) fins.forEach(({ x, y }) => { const nome = x.t.length > 20 ? x.t.slice(0, 19) + "…" : x.t; g += `<text x="${E + pw + 10}" y="${y + 4}" class="gr-rot">${esc(nome)}</text>`; });
    ms.forEach((m, i) => { const w = pw / (ms.length - 1); g += `<rect class="gr-alvo" data-mes="${m}" x="${X(i) - w / 2}" y="${T}" width="${w}" height="${ph}" fill="transparent"/>`; });
    const legenda = sel.map((x) => `<span><i class="t-bola" style="background:${T_CORES[tCmp.get(x.t)]}"></i>${esc(x.t)}</span>`).join("");
    box.innerHTML = `<div class="gr-legenda">${legenda}</div><div class="gr-area"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(nomeMet)} por mês das transportadoras comparadas">${g}<line class="gr-mira" x1="0" x2="0" y1="${T}" y2="${T + ph}" visibility="hidden"/></svg><div class="gr-dica" hidden></div></div>`;
    const svg = box.querySelector("svg"), dica = box.querySelector(".gr-dica"), mira = box.querySelector(".gr-mira");
    svg.addEventListener("mousemove", (e) => {
      const a = e.target.closest(".gr-alvo"); if (!a) { dica.hidden = true; mira.setAttribute("visibility", "hidden"); return; }
      const m = a.dataset.mes, i = ms.indexOf(m);
      mira.setAttribute("x1", X(i)); mira.setAttribute("x2", X(i)); mira.setAttribute("visibility", "visible");
      dica.innerHTML = `<b>${rot(m)}</b>` + sel.map((x) => `<div><i class="t-bola" style="background:${T_CORES[tCmp.get(x.t)]}"></i>${esc(x.t)}: <b>${fmMet(val(x, m))}</b></div>`).join("");
      dica.hidden = false;
      const r = box.querySelector(".gr-area").getBoundingClientRect(), px = (X(i) / W) * r.width;
      dica.style.left = Math.min(px + 12, r.width - dica.offsetWidth - 4) + "px"; dica.style.top = "8px";
    });
    svg.addEventListener("mouseleave", () => { dica.hidden = true; mira.setAttribute("visibility", "hidden"); });
  }
  function corLivre() { const usadas = new Set(tCmp.values()); return T_CORES.findIndex((_, i) => !usadas.has(i)); }
  function alternarCmp(t, ligar) {
    if (ligar && !tCmp.has(t) && tCmp.size < T_MAX) tCmp.set(t, corLivre());
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

  // ---------------- transportadora divergente (coluna H × coluna BD da base) ----------------
  // H = transportadora na Intelipost; BD = "Transportadora Promob" (a da nota). A certa sai do DE × PARA pela série da nota
  // (planilha "modelos_eloggia_ajuste tp"); se tiver redespacho no Promob (BE), vale o redespacho.
  // Tabela de apelidos da planilha "Ajuste_Transportadoras" (aba Apelidos): transportadora da coluna H -> apelido ->
  // trecho que tem que aparecer no nome da transportadora do Promob (coluna BD) -> ID considerado.
  // Transvanio (MEI): o Promob mostra o nome do dono; aqui é reconhecida pelo CNPJ ou pela impressão do nome (troca-notas.js).
  const AJ_TP = [
    ["Aceville", "Aceville", "Aceville", 230], ["Atual Cargas", "Atual Cargas", "Atual Cargas", 33], ["Bento Brasil", "Bento Brasil", "Bento Brasil", 1345],
    ["Costa Transportes", "Costa Transportes", "Costa", 20844], ["DLOG Transportes", "DLOG Transportes", "Dlog", 21816], ["Dominalog", "Dominalog", "Dominalog", 196],
    ["Flog Transportes", "Flog Transportes", "Flog", 4946], ["Formato Transportes", "Formato Transportes", "Formato", 880], ["IDH Transportes", "IDH Transportes", "IDH", 15578],
    ["JadLog", "LDC", "LDC", 22], ["MF Transportes", "MF Transportes", "MF Almeida", 21601], ["Frota Interna", "Frota Interna", "Frota Interna", 20028],
    ["Petrymar", "Petrymar", "Petrymar", 10897], ["PROLOG TRANSPORTES E LOGISTICA LTDA", "PROLOG TRANSPORTES E LOGISTICA LTDA", "Prolog", 9704],
    ["RAJLOG SERVICOS LOGISTICOS", "RAJLOG SERVICOS LOGISTICOS", "Rajlog", 23558], ["Rapido Alem Paraiba", "Rapido Alem Paraiba", "Rapido Alem Paraiba", 22359],
    ["Reunidas", "Reunidas", "Reunidas", 149], ["SAJOB OPERACOES E LOGISTICAS LTDA", "SAJOB OPERACOES E LOGISTICAS LTDA", "Sajob", 16749],
    ["VM TRANSPORTES", "VM TRANSPORTES", "Tempo Justo", 601], ["Termaco", "Termaco", "Termaco", 76], ["Tradicional Log", "Tradicional Log", "Tradicional Log", 17241],
    ["Trans Sua Log", "JS Oliveira", "J S De Oliveira", 15128], ["TRANSCAI TRANSPORTES", "TRANSCAI TRANSPORTES", "Transcai", 21511], ["Transiga", "Via Cargas", "Via Cargas", 22575],
    ["Transito Brasil", "HB Transportes", "HB Transportes", 617], ["Translaguna", "Translaguna", "Translaguna", 624], ["Translovato", "Translovato", "Translovato", 256],
    ["Transportadora BLZ", "BLZ", "BLZ", 14980], ["Transvanio", "Transvanio (CNPJ 44.657.205)", "CNPJ 44657205", 20062], ["Trilog Express", "Trilog Express", "Trilog", 21211],
    ["Tsl Solucoes Transportes E Logistica Ltd", "LLS", "LLS", 18001], ["Zafer Standard", "Zafer Standard", "Zafer", 22950], ["Zelog Transportes", "Zelog Transportes", "Zelog", 19536],
  ].map(([h, apelido, chave, id]) => ({ h, apelido, chave, id }));
  // a tabela de verdade fica no banco (parte 34), cadastrada pela Logística; a lista acima é só o ponto de partida
  let ajLista = AJ_TP.slice(), ajPorH = new Map(ajLista.map((x) => [norm(x.h), x])), ajOk = false, ajCarregado = false;
  function ajMontar(L) { L = L.filter((x) => x.h && x.chave); ajLista = L; ajPorH = new Map(L.map((x) => [norm(x.h), x])); }
  async function carregarApelidos() {
    const { data, error } = await sb.from("apelidos_transp").select("h,apelido,chave,id_metodo,atualizado_por,atualizado_em").order("h");
    ajCarregado = true;
    if (error) { ajOk = false; $("aj-sub").textContent = 'Para cadastrar transportadoras aqui, rode a parte 34 do schema.sql no Supabase. Por enquanto vale a tabela da planilha "Ajuste_Transportadoras".'; desenharApelidos(); return; }
    ajOk = true;
    if (!data.length) {   // 1ª vez: grava a tabela da planilha para vocês editarem
      const ins = await sb.from("apelidos_transp").insert(AJ_TP.map((x) => ({ h: x.h, apelido: x.apelido, chave: x.chave, id_metodo: x.id })));
      if (!ins.error) return carregarApelidos();
    }
    ajMontar(data.map((x) => ({ h: x.h, apelido: x.apelido || x.h, chave: x.chave, id: x.id_metodo, por: x.atualizado_por, em: x.atualizado_em })));
    desenharApelidos();
  }
  function desenharApelidos() {
    $("aj-qtd").textContent = fmt(ajLista.length);
    $("aj-linhas").innerHTML = ajLista.map((x, i) => `<tr><td>${esc(x.h)}</td><td>${esc(x.apelido || "")}</td><td><b>${esc(x.chave)}</b></td><td>${x.id ?? ""}</td>
      <td class="nowrap">${ajOk ? `<button class="link" data-aj-ed="${i}" title="Editar">✎</button> <button class="link" data-aj-del="${i}" title="Apagar">🗑</button>` : ""}</td></tr>`).join("");
    ["aj-h", "aj-ap", "aj-ch", "aj-id", "aj-salvar"].forEach((id) => ($(id).disabled = !ajOk));
  }
  async function salvarApelidos(linhas) {
    const { error } = await sb.from("apelidos_transp").upsert(linhas.map((x) => ({ h: x.h, apelido: x.apelido || x.h, chave: x.chave, id_metodo: x.id ?? null, atualizado_em: new Date().toISOString() })), { onConflict: "h" });
    if (error) { toast("Não consegui salvar: " + error.message, true); return false; }
    await carregarApelidos(); desenharDivTP(); return true;
  }
  $("aj-abrir").addEventListener("click", () => { $("aj-corpo").hidden = !$("aj-corpo").hidden; if (!ajCarregado) carregarApelidos(); });
  $("aj-salvar").addEventListener("click", async () => {
    const x = { h: $("aj-h").value.trim(), apelido: $("aj-ap").value.trim(), chave: $("aj-ch").value.trim(), id: $("aj-id").value ? Number($("aj-id").value) : null };
    if (!x.h || !x.chave) return toast("Preencha pelo menos a transportadora (coluna H) e a chave de busca.", true);
    if (await salvarApelidos([x])) { ["aj-h", "aj-ap", "aj-ch", "aj-id"].forEach((id) => ($(id).value = "")); toast(`${x.h} salva.`); }
  });
  $("aj-linhas").addEventListener("click", async (e) => {
    const ed = e.target.closest("[data-aj-ed]"), del = e.target.closest("[data-aj-del]");
    if (ed) { const x = ajLista[+ed.dataset.ajEd]; $("aj-h").value = x.h; $("aj-ap").value = x.apelido || ""; $("aj-ch").value = x.chave; $("aj-id").value = x.id ?? ""; $("aj-h").focus(); }
    if (del) { const x = ajLista[+del.dataset.ajDel]; if (!confirm(`Apagar ${x.h} da tabela de apelidos?`)) return;
      const { error } = await sb.from("apelidos_transp").delete().eq("h", x.h); if (error) return toast("Não consegui apagar: " + error.message, true);
      await carregarApelidos(); desenharDivTP(); }
  });
  $("aj-modelo").addEventListener("click", () => {
    const L = [["Transportadora (col. H)", "Apelido", "Chave de busca na col. BD", "ID considerado"]].concat(ajLista.map((x) => [x.h, x.apelido || "", x.chave, x.id ?? ""]));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(L), "Apelidos"); XLSX.writeFile(wb, "apelidos_transportadoras.xlsx");
  });
  $("aj-arquivo").addEventListener("change", async (e) => {
    const arq = e.target.files[0]; e.target.value = ""; if (!arq) return;
    if (!ajOk) return toast("Rode a parte 34 do schema.sql no Supabase primeiro.", true);
    try {
      const wb = XLSX.read(await arq.arrayBuffer(), { type: "array", ...LEITURA_RAPIDA });
      const nome = wb.SheetNames.find((n) => norm(n) === "APELIDOS") || wb.SheetNames[0];
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[nome], { header: 1, raw: true, defval: null });
      const cab = (rows[0] || []).map(norm), c = (re) => cab.findIndex((x) => re.test(x));
      const cH = c(/^TRANSPORTADORA/), cA = c(/^APELIDO/), cC = c(/^CHAVE/), cI = c(/^ID (CONSIDERADO|PADRAO|DO METODO)|^ID$/);
      if (cH < 0 || cC < 0) throw new Error('A planilha precisa das colunas "Transportadora (col. H)" e "Chave de busca na col. BD".');
      const L = rows.slice(1).filter((r) => r && r[cH] && r[cC]).map((r) => ({ h: String(r[cH]).trim(), apelido: cA >= 0 && r[cA] ? String(r[cA]).trim() : "", chave: String(r[cC]).trim(),
        id: cI >= 0 && r[cI] != null && !isNaN(parseInt(r[cI], 10)) ? parseInt(r[cI], 10) : null }));
      if (!L.length) throw new Error("A planilha não tem linhas.");
      if (!confirm(`${arq.name}\n\n${fmt(L.length)} transportadora(s). As que já existem são atualizadas e as novas, acrescentadas.\n\nEnviar?`)) return;
      if (await salvarApelidos(L)) toast(`${fmt(L.length)} transportadora(s) salvas.`);
    } catch (err) { toast(err.message, true); }
  });
  // o trecho (chave) aparece no nome do Promob? (como o PROCURAR do Excel: sem diferença de maiúscula)
  function ajTem(chave, nome) {
    if (!nome) return false;
    if (chave.startsWith("CNPJ ")) return nome.replace(/\D/g, "").includes(chave.slice(5)) || TROCA.ehCnpjImpressao(nome) === chave;
    return norm(nome).includes(norm(chave));
  }
  const ajIdPromob = (nome) => { if (!nome) return null; const x = ajLista.find((a) => ajTem(a.chave, nome)); return x || null; };

  let dvPromob = null, dvGer = -1, dvCard = "div", dvLista = [], dvBusca = "", dvGrupo = null, dvResumo = [];
  async function carregarDvPromob() {
    if (dvPromob && dvGer === gGeracao) return true;
    try {
      const L = await buscarComCache("base_pedidos", "pedido", "pedido,tp:extra->>transp_promob,rd:extra->>redespacho,pr:extra->>promob,cep:extra->>cep", gBaseEm);
      dvPromob = new Map(L.map((x) => [x.pedido, x])); dvGer = gGeracao; return true;
    } catch (err) { dvPromob = new Map(); dvGer = gGeracao; $("dv-info").textContent = /extra/i.test(err.message || "") ? "Falta rodar a parte 32 do schema.sql e enviar a base de novo." : "Não consegui ler: " + err.message; return false; }
  }
  const DV_CARD = { div: (x) => x.sit === "div", ok: (x) => x.sit === "ok", sem: (x) => x.sit === "sem", todos: () => true };
  const DV_NOME = { div: "Divergente", ok: "OK", sem: "Sem apelido cadastrado" };
  const dvChave = (x) => `${x.r.transp || ""}\u0001${x.promob}`;
  async function desenharDivTP() {
    // fica em Alterar pedidos: usa a base inteira, só os pedidos em trânsito (sem entregues e cancelados)
    if (!gDados) {
      $("dv-info").textContent = "Carregando os pedidos da base…";
      if (!gCarregando) await carregarGerencial(); else { setTimeout(() => { if (!$("ap-sec-dv").hidden) desenharDivTP(); }, 1500); return; }
      if (!gDados) { $("dv-info").textContent = "Não consegui carregar a base. Atualize a página."; return; }
    }
    prepararG();
    if (!ajCarregado) await carregarApelidos();
    if (!dvPromob || dvGer !== gGeracao) { $("dv-info").textContent = "Lendo a transportadora do Promob…"; if (!(await carregarDvPromob())) return; }
    const temPromob = [...dvPromob.values()].some((x) => x.tp);
    const todos = [];
    // em aberto = o que está no Preventivo: sem entregue/cancelado na base E sem entregue/cancelado no arquivo da Intelipost
    const abertos = base && base.length ? new Set(base.map((p) => p.pedido)) : null;
    gDados.forEach((r) => {
      if (r._fechado || (abertos && !abertos.has(r.pedido))) return;
      const p = dvPromob.get(r.pedido) || {}, bd = p.tp || "", rd = p.rd || "", promob = rd || bd;
      if (!r.transp && !promob) return;
      const ap = ajPorH.get(norm(r.transp));
      const sit = !ap ? "sem" : ajTem(ap.chave, promob) ? "ok" : "div";
      todos.push({ r, bd, rd, promob, ped: p.pr || "", ap, sit, idp: ajIdPromob(promob) });
    });
    const n = (k) => todos.filter(DV_CARD[k]).length, nOk = n("ok"), nDiv = n("div");
    document.querySelectorAll("#dv-cards .kpi[data-dv]").forEach((b) => { b.querySelector(".kpi-num").textContent = fmt(n(b.dataset.dv)); b.classList.toggle("ativa", b.dataset.dv === dvCard); });
    $("dv-pct").textContent = `${nOk + nDiv ? ((nDiv / (nOk + nDiv)) * 100).toFixed(2).replace(".", ",") : "0"}% divergente`;
    const nTp = [...dvPromob.values()].filter((x) => x.tp).length;
    $("dv-info").textContent = !temPromob
      ? ([...dvPromob.values()].some((x) => x.cep) ? 'A base atual foi enviada com a versão antiga do painel, que ainda não guardava a coluna "Transportadora Promob". Aperte Ctrl+F5 e carregue a planilha de novo.'
        : 'A base ainda não tem a coluna "Transportadora Promob" (BD): aperte Ctrl+F5 e carregue a planilha de novo.')
      : `Transportadora Promob na base: ${fmt(nTp)} de ${fmt(dvPromob.size)} pedidos · ${fmt(todos.length)} pedidos em aberto (sem entregues e cancelados da base e do arquivo da Intelipost)`;
    // resumo: transportadora (H) × transportadora Promob, só os divergentes (como a aba "Divergências")
    const g = new Map();
    todos.filter(DV_CARD.div).forEach((x) => { const k = dvChave(x); const y = g.get(k) || { k, h: x.r.transp || "", ap: x.ap, promob: x.promob, idp: x.idp, qtd: 0 }; y.qtd++; g.set(k, y); });
    dvResumo = [...g.values()].sort((a, b) => a.h.localeCompare(b.h) || b.qtd - a.qtd);
    const faz = (idp, h) => !idp ? '<span class="chip cinza">transportadora do Promob não cadastrada</span>'
      : `Intelipost: trocar <b>${esc(h || "—")}</b> por <b>${esc(idp.h)}</b> (ID ${idp.id}) · BI: <b>${esc(idp.h)}</b>`;
    if ($("dv-resumo")) $("dv-resumo").innerHTML = dvResumo.length ? dvResumo.map((y) => `<tr class="clicavel${dvGrupo === y.k ? " aberta" : ""}" data-dvg="${esc(y.k)}"><td>${esc(y.h)}</td><td>${esc(y.ap ? y.ap.apelido : "")}</td><td>${esc(y.promob || "— sem transportadora no Promob")}</td><td class="num"><b>${fmt(y.qtd)}</b></td><td>${y.idp ? y.idp.id : '<span class="s">Não cadastrada</span>'}</td><td>${faz(y.idp, y.h)}</td></tr>`).join("")
      : '<tr><td colspan="6" class="s">Sem divergências.</td></tr>';
    const q = norm(dvBusca);
    dvLista = todos.filter(DV_CARD[dvCard]).filter((x) => !dvGrupo || dvChave(x) === dvGrupo)
      .filter((x) => !q || [x.r.pedido, x.ped, x.r.nf, x.r.transp, x.bd, x.rd].some((v) => norm(v).includes(q)));
    dvLista.sort((a, b) => String(a.r.transp || "").localeCompare(String(b.r.transp || "")) || (b.r._atraso - a.r._atraso));
    $("dv-titulo").textContent = `${{ div: "Pedidos com divergência", ok: "Pedidos OK", sem: "Sem apelido cadastrado", todos: "Todos os pedidos em trânsito" }[dvCard]} (${fmt(dvLista.length)})`;
    $("dv-sub-lista").innerHTML = dvGrupo ? `Só: ${esc(dvGrupo.replace("\u0001", " × "))} · <button class="link" id="dv-limpa-grupo">ver todos</button>` : "";
    $("dv-linhas").innerHTML = dvLista.slice(0, 500).map((x) => {
      const st = x.sit === "ok" ? '<span class="chip verde">OK</span>' : x.sit === "div" ? '<span class="chip vermelho">Divergente</span>' : '<span class="chip laranja">Sem apelido cadastrado</span>';
      return `<tr><td class="mono">${esc(x.ped)}</td><td class="mono">${esc(x.r.pedido)}</td><td>${esc(x.r.nf)}${x.r.serie ? "-" + esc(x.r.serie) : ""}</td><td><span class="ms">${esc(x.r.status || "")}</span>${x.r._atraso ? `<div><span class="chip vermelho">atrasado ${x.r._atraso} d</span></div>` : ""}</td>
        <td>${esc(x.r.transp || "—")}</td><td>${esc(x.promob || "—")}${x.rd ? `<div class="s">redespacho · nota: ${esc(x.bd || "—")}</div>` : ""}</td><td>${x.idp ? x.idp.id : '<span class="s">Não cadastrada</span>'}</td><td>${st}</td></tr>`;
    }).join("") + (dvLista.length > 500 ? `<tr><td colspan="8" class="s">Mostrando 500 de ${fmt(dvLista.length)} — use a busca ou baixe o Excel.</td></tr>` : "");
    $("dv-vazio").hidden = dvLista.length > 0;
  }
  $("dv-cards").addEventListener("click", (e) => { const b = e.target.closest(".kpi[data-dv]"); if (!b) return; dvCard = b.dataset.dv; dvGrupo = null; desenharDivTP(); });
  if ($("dv-resumo")) $("dv-resumo").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-dvg]"); if (!tr) return; dvGrupo = dvGrupo === tr.dataset.dvg ? null : tr.dataset.dvg; dvCard = "div"; desenharDivTP(); });
  $("dv-sub-lista").addEventListener("click", (e) => { if (e.target.id === "dv-limpa-grupo") { dvGrupo = null; desenharDivTP(); } });
  let esperaDv; $("dv-busca").addEventListener("input", (e) => { dvBusca = e.target.value; clearTimeout(esperaDv); esperaDv = setTimeout(desenharDivTP, 250); });
  $("dv-exportar").addEventListener("click", () => {
    if (!dvLista.length && !dvResumo.length) return toast("Nada para exportar.", true);
    const res = [["Transportadora (H)", "Apelido Esperado", "Transportadora Promob (BD)", "Qtd", "ID Transportadora Promob (BD)", "Trocar na Intelipost para"]]
      .concat(dvResumo.map((y) => [y.h, y.ap ? y.ap.apelido : "", y.promob, y.qtd, y.idp ? y.idp.id : "Não cadastrada", y.idp ? y.idp.h : ""]));
    const ped = [["Pedido Promob", "Pedido Intelipost", "Nota", "Status Intelipost", "Transportadora (col. H)", "Transportadora Promob (col. BD)", "Transportadora Redespacho Promob (col. BE)", "ID Transportadora Promob (BD)", "Situação"]]
      .concat(dvLista.map((x) => [x.ped, x.r.pedido, x.r.serie ? `${x.r.nf}-${x.r.serie}` : x.r.nf, x.r.status || "", x.r.transp || "", x.bd, x.rd, x.idp ? x.idp.id : "Não cadastrada", DV_NOME[x.sit]]));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(res), "Divergências");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ped), "Pedidos");
    XLSX.writeFile(wb, `ajuste_transportadoras_${hojeISO()}.xlsx`);
  });

  // ---------------- histórico diário (parte 31) ----------------
  // A 1ª base enviada no dia vira a foto do dia (o banco ignora as seguintes). Grava agrupado por transportadora × canal × UF,
  // para a tabela seguir esses filtros do topo.
  let tHist = null, tHistErro = "", fotoFeita = "";
  const diaLocal = (iso) => { const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  async function fotoDoDia(baseEm, geracao) {
    if (!baseEm || !gDados || !gDados.length || perfil === "sac") return;
    const dia = diaLocal(baseEm);
    if (dia !== hojeISO() || fotoFeita === dia) return;
    fotoFeita = dia;
    prepararG();
    const g = new Map();
    gDados.forEach((r) => {
      const k = [r.transp || "", r.canal || "", r.uf || ""].join("\u0001");
      const x = g.get(k) || [r.transp || "", r.canal || "", r.uf || "", 0, 0, 0, 0, 0, 0];
      x[3]++; if (!r._fechado) x[4]++; if (r._atraso > 0) x[5]++; if (G_CARD.risco(r)) x[6]++;
      if (r._sit === "ent_prazo") x[7]++; if (r._sit === "ent_atraso") x[8]++;
      g.set(k, x);
    });
    if (geracao !== gGeracao) return;   // chegou uma base mais nova no meio do caminho
    const inf = info && info.arquivo ? info.arquivo : null;
    const { data, error } = await sb.rpc("gravar_historico", { p_dia: dia, p_dados: [...g.values()], p_arquivo: inf });
    if (error) { fotoFeita = ""; return; }   // parte 31 ainda não rodada: tenta na próxima carga
    if (data) { tHist = null; if (paginaAtual === "transp") carregarHistorico(); }
  }
  async function carregarHistorico() {
    const { data, error } = await sb.from("historico_base").select("dia,dados").order("dia", { ascending: false }).limit(180);
    tHistErro = error ? (/historico_base|does not exist|schema cache/i.test(error.message) ? "Falta rodar a parte 31 do schema.sql no Supabase." : "Não consegui ler o histórico: " + error.message) : "";
    tHist = error ? [] : data || [];
    desenharHistorico();
  }
  function desenharHistorico() {
    if (tHist === null) { carregarHistorico(); return; }
    const fs = ["transp", "canal", "uf"].map((k) => gSel[k]);
    const linhas = tHist.map((h) => {
      const s = [0, 0, 0, 0, 0, 0];
      (h.dados || []).forEach((x) => { if ((fs[0].size && !fs[0].has(x[0])) || (fs[1].size && !fs[1].has(x[1])) || (fs[2].size && !fs[2].has(x[2]))) return; for (let i = 0; i < 6; i++) s[i] += x[3 + i] || 0; });
      const [vol, ab, atr, risco, ok, entAtr] = s;
      return { dia: h.dia, vol, ab, atr, risco, ok, entAtr, sla: ok + entAtr ? ok / (ok + entAtr) : null, geral: ok + entAtr + ab ? (ok + ab - atr) / (ok + entAtr + ab) : null };
    });
    tHistLinhas = linhas;
    const outros = ["serie", "origem", "status", "micro"].some((k) => gSel[k].size) || $("g-nf").value.trim() || $("g-de").value || $("g-ate").value;
    $("t-hist-sub").textContent = tHistErro || (linhas.length
      ? `Foto do 1º arquivo da base enviado em cada dia · ${fmt(linhas.length)} dia(s) registrado(s)${outros ? " · aqui só valem os filtros de transportadora, canal e UF" : ""}`
      : "Ainda não há dias registrados. A foto de hoje é gravada quando a base do dia é enviada (ou já está carregada).");
    const p1 = (x) => (x === null ? "—" : (x * 100).toFixed(1).replace(".", ",") + "%");
    $("t-hist-linhas").innerHTML = linhas.map((x) => `<tr><td>${ddmm(x.dia)}</td><td class="num neutro">${fmt(x.vol)}</td><td class="num neutro">${fmt(x.ab)}</td>
      <td class="num vermelho-t">${fmt(x.atr)}</td><td class="num laranja-t">${fmt(x.risco)}</td><td class="num verde-t">${fmt(x.ok)}</td><td class="num neutro">${fmt(x.entAtr)}</td>
      <td class="num neutro"><b>${p1(x.sla)}</b></td><td class="num cinza-t">${p1(x.geral)}</td></tr>`).join("");
  }
  let tHistLinhas = [];
  $("t-hist-extrair").addEventListener("click", () => {
    if (!tHistLinhas.length) return toast("Nada para exportar.", true);
    const linhas = [["Dia", "Volume", "Em aberto", "Atrasados", "Em risco", "Entregues no prazo", "Entregues c/ atraso", "SLA entrega %", "SLA geral %"]]
      .concat(tHistLinhas.map((x) => [br(x.dia), x.vol, x.ab, x.atr, x.risco, x.ok, x.entAtr, x.sla === null ? "" : +(x.sla * 100).toFixed(1), x.geral === null ? "" : +(x.geral * 100).toFixed(1)]));
    const ws = XLSX.utils.aoa_to_sheet(linhas); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Histórico");
    XLSX.writeFile(wb, `historico_${hojeISO()}.xlsx`);
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
    $("e-info").textContent = !info ? 'Envie a base ("Carregar planilha") para montar esta página.'
      : !entBase ? `A base enviada (${fmt(totalBase)} pedidos) não tem pedidos com status Entregue. Para ver o SLA, envie no botão "Carregar planilha" uma exportação que inclua os entregues.`
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
  let uForma = "mapa", uModo = "mapa", uUF = null, uT = null, uC = null, uDados = new Map(), uAtrasadosUF = [];
  const uTDe = (r) => r.transp || "(sem transportadora)", uCDe = (r) => r.cidade || "(sem cidade)";
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
    // filtro cruzado: a transportadora (e a cidade) escolhidas no detalhe valem também para o mapa e o ranking
    const L = gFiltrados(); uFiltrados = L; uDados = agruparUF(L.filter((r) => (uT === null || uTDe(r) === uT) && (uC === null || uCDe(r) === uC)));
    const sel = [uT !== null ? `<span class="chip-sel">🚚 ${esc(uT)} <button class="link" data-ux="t" title="Tirar">✕</button></span>` : "", uC !== null ? `<span class="chip-sel">🏙 ${esc(uC)} <button class="link" data-ux="c" title="Tirar">✕</button></span>` : ""].join(" ");
    $("u-sel").hidden = !sel.trim(); $("u-sel").innerHTML = sel + (sel.trim() ? ' <button class="link" data-ux="tudo">Limpar seleção</button> <span class="s">o mapa mostra só essa seleção</span>' : "");
    const ab = [...uDados.values()].reduce((a, x) => a + x.ab, 0), atr = [...uDados.values()].reduce((a, x) => a + x.atr, 0);
    $("u-info").textContent = !info ? 'Envie a base ("Carregar planilha") para montar esta página.'
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
    const sufixo = [uT, uC].filter((v) => v !== null).join(" · ");
    $("u-det-titulo").textContent = `${UF_NOME[uUF] || uUF} (${uUF})${sufixo ? " · " + sufixo : ""}`;
    $("u-det-sub").textContent = (x ? `${fmt(x.atr)} atrasados de ${fmt(x.ab)} pedidos em aberto · ${pctBR(x.pct)} de atraso` : "Nenhum pedido em aberto nessa seleção.") + " · clique numa transportadora ou cidade para cruzar; clique de novo para tirar";
    const porT = new Map(), porC = new Map();
    // filtro cruzado: transportadoras seguem a cidade escolhida; cidades seguem a transportadora escolhida
    L.forEach((r) => {
      const t = uTDe(r), c = uCDe(r);
      if (uC === null || c === uC) { const a = porT.get(t) || { n: t, ab: 0, atr: 0, series: new Set() }; a.ab++; if (r._atraso) a.atr++; if (r.serie) a.series.add(r.serie); porT.set(t, a); }
      if (uT === null || t === uT) { const b = porC.get(c) || { n: c, ab: 0, atr: 0 }; b.ab++; if (r._atraso) b.atr++; porC.set(c, b); }
    });
    const ord = (a, b) => b.atr - a.atr || b.ab - a.ab;
    $("u-det-transp").innerHTML = [...porT.values()].sort(ord).map((a) => `<tr class="clic${uT === a.n ? " sel" : ""}" data-ut="${esc(a.n)}"><td>${esc(a.n)}</td><td>${[...a.series].sort((p, q) => p.localeCompare(q, "pt-BR", { numeric: true })).map(esc).join(", ") || "—"}</td>
      <td class="num">${fmt(a.ab)}</td><td class="num txt-vermelho">${fmt(a.atr)}</td><td class="num">${pctBR(a.atr / a.ab)}</td></tr>`).join("") || `<tr><td colspan="5" class="s">Nenhum pedido.</td></tr>`;
    $("u-det-cidades").innerHTML = [...porC.values()].sort(ord).map((b) => `<tr class="clic${uC === b.n ? " sel" : ""}" data-uc="${esc(b.n)}"><td>${esc(b.n)}</td><td class="num">${fmt(b.ab)}</td><td class="num txt-vermelho">${fmt(b.atr)}</td><td class="num">${pctBR(b.atr / b.ab)}</td></tr>`).join("") || `<tr><td colspan="4" class="s">Nenhum pedido.</td></tr>`;
    uAtrasadosUF = L.filter((r) => r._atraso && (uT === null || uTDe(r) === uT) && (uC === null || uCDe(r) === uC));
    if (rolar) caixa.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function escolherUF(u) { uUF = uUF === u ? null : u; uC = null; if (uModo === "mapa") (uForma === "mapa" ? desenharMapaBR : desenharQuadrados)(); else desenharRankingUF(); desenharDetalheUF(!!uUF); }
  $("u-detalhe").addEventListener("click", (e) => {
    const t = e.target.closest("tr[data-ut]"), c = e.target.closest("tr[data-uc]"); if (!t && !c) return;
    if (t) uT = uT === t.dataset.ut ? null : t.dataset.ut; else uC = uC === c.dataset.uc ? null : c.dataset.uc;
    desenharUF();
  });
  $("u-sel").addEventListener("click", (e) => { const b = e.target.closest("[data-ux]"); if (!b) return; const k = b.dataset.ux;
    if (k === "t" || k === "tudo") uT = null; if (k === "c" || k === "tudo") uC = null; desenharUF(); });
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
  // Preventivo + SSW: Nova data da Logística (vale primeiro) ou previsão do SSW depois da prometida. Data vencida não vai (pedido da Brenda).
  $("ap-puxar").addEventListener("click", async () => {
    const bt = $("ap-puxar"); bt.disabled = true;
    try {
      if (!apCarregadoEm) await carregarAlterar(true);
      const hoje = hojeISO(), naFila = new Map(apFila.map((r) => [r.pedido, r]));
      // previsão do SSW: a da conferência (detalhe.previsao) ou a da tabela previsao_ssw; vale a mais nova
      let cfL = cfLista; if (!cfL.length) { try { cfL = await buscarTudo("conferencia_ssw", "pedido"); } catch (_) { cfL = []; } }
      const cfPrev = new Map((cfL || []).filter((x) => x.detalhe && x.detalhe.previsao).map((x) => [x.pedido, String(x.detalhe.previsao).slice(0, 10)]));
      const prevSSW = (ped) => { const a = (ssw.get(ped) || {}).previsao, b = cfPrev.get(ped); return [a, b].filter(Boolean).map((x) => String(x).slice(0, 10)).sort().pop() || null; };
      const linhas = [], cont = { vencida: 0, antes: 0, jaFeito: 0, igual: 0 };
      for (const p of base) {
        if (/ENTREGUE|CANCELAD/i.test(`${p.status || ""} ${p.status_intelipost || ""}`)) continue;
        const t = trat.get(p.pedido), prom = String(p.prev_original || p.prev_atual || "").slice(0, 10);
        let d = t && t.nova_data ? String(t.nova_data).slice(0, 10) : null;
        if (!d) { const s2 = prevSSW(p.pedido); if (s2 && prom && String(s2).slice(0, 10) > prom) d = String(s2).slice(0, 10); }
        if (!d) continue;
        if (d < hoje) { cont.vencida++; continue; }
        if (prom && prom >= d) { cont.antes++; continue; }   // a data prometida ao cliente já é igual ou depois da nova data
        const f = naFila.get(p.pedido); if (f && String(f.nova_data).slice(0, 10) === d && f.status !== "erro") { cont.jaFeito++; continue; }
        if (String(p.prev_atual || "").slice(0, 10) === d) { cont.igual++; continue; }
        linhas.push(`${p.pedido} ${br(d)}`);
      }
      const atual = $("ap-texto").value.trim(), ja = new Set(atual.split(/\r?\n/).map((l) => l.trim().split(/[\s;,]+/)[0]).filter(Boolean));
      const novas = linhas.filter((l) => !ja.has(l.split(" ")[0]));
      $("ap-texto").value = (atual ? atual + "\n" : "") + novas.join("\n"); mostrarConferencia();
      toast(`${fmt(novas.length)} pedido(s) trazidos do Preventivo e SSW. Fora: ${fmt(cont.vencida)} com data vencida · ${fmt(cont.antes)} com a data prometida igual ou depois da nova · ${fmt(cont.jaFeito)} já mandados com essa data · ${fmt(cont.igual)} já com essa data na Intelipost. Confira e clique em Alterar na Intelipost.`);
    } catch (err) { toast("Não consegui trazer: " + (err.message || err), true); }
    finally { bt.disabled = false; }
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
    try { localStorage.setItem("painel.ap", b.dataset.ap); } catch (_) {}
    $("ap-abas").querySelectorAll("button").forEach((x) => { const at = x === b; x.classList.toggle("amarelo", at); x.classList.toggle("contorno", !at); });
    $("ap-sec-data").hidden = b.dataset.ap !== "data"; $("ap-sec-troca").hidden = b.dataset.ap !== "troca"; $("ap-sec-ag").hidden = !["ag", "at"].includes(b.dataset.ap); $("ap-sec-dv").hidden = b.dataset.ap !== "dv"; $("ap-sec-oc").hidden = b.dataset.ap !== "oc"; $("pagina-barrar").hidden = b.dataset.ap !== "barrar";
    if (b.dataset.ap === "oc") { const de = $("pagina-ocorrencias"), para = $("ap-sec-oc"); while (de.firstChild) para.appendChild(de.firstChild); desenharOcorrencias(); }
    if (b.dataset.ap === "dv") desenharDivTP();
    if (b.dataset.ap === "troca") carregarTrocas();
    if (b.dataset.ap === "ag" || b.dataset.ap === "at") { agFila = b.dataset.ap === "at" ? "AT" : "AE"; agCard = "tratar"; agBusca = ""; $("ag-busca").value = "";
      $("ag-h2").textContent = agFila === "AT" ? "Aguardando entrega AT" : "Fila Aguardando entrega";
      $("ag-dica-fila").textContent = agFila === "AT" ? "fila Aguardando entrega (AT)" : "fila Aguardando entrega";
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
      $("tn-info").textContent = /troca_notas|does not exist|schema cache/i.test(err.message || "") ? "Para usar o Ajuste Intelipost, rode de novo o supabase/schema.sql no Supabase." : "Não consegui carregar: " + (err.message || err);
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
      const wb = XLSX.read(await arq.arrayBuffer(), { type: "array", dense: true, cellDates: true, ...LEITURA_RAPIDA });
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
    if (!confirm(`${arq.name}\n\nFila "Ajuste de dados na Intelipost": ${fmt(totalFila)} linha(s).\n${fmt(itens.filter((x) => x.tipo === "TOTAL").length)} ticket(s) Total e ${fmt(itens.filter((x) => x.tipo === "PARCIAL").length)} Parcial entram no Ajuste Intelipost${outros ? ` (${fmt(outros)} linha(s) sem tipo Total/Parcial ficam de fora)` : ""}.\n\nQuem pegou e as etapas marcadas continuam salvos. Enviar?`)) return;
    const { error } = await sb.rpc("importar_troca_notas", { itens, arquivo: arq.name });
    if (error) return toast("Erro ao enviar: " + error.message + (/importar_troca_notas|schema cache/i.test(error.message) ? " (rode de novo o supabase/schema.sql)" : ""), true);
    toast(`${fmt(itens.length)} ticket(s) no Ajuste Intelipost.`); await carregarTrocas();
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
  // mesmo botão da Conferência SSW: abre o rastreio da NF nova (no site de quem achou a nota, se o robô achou em outro)
  function agBotao(t) {
    if (!t.nf_nova) return "";
    const tr = t.fonte && t.fonte !== "SSW" ? t.fonte : agTransp(t), r = rastreioDe(tr);
    return `<div><button class="btn mini contorno" data-ag-rastreio="${esc(t.ticket)}" title="Abre o rastreio dessa nota agora">${r ? "Ver na " + esc(r[1]) : "Ver no SSW"} ↗</button></div>`;
  }
  function agStatus(t) {
    const ev = t.ultimo_evento ? esc(t.ultimo_evento) + (t.data_evento ? ` <span class="s">${br(t.data_evento)}</span>` : "") : "";
    const pv = t.situacao === "nao entregue" && t.detalhe && t.detalhe.previsao ? String(t.detalhe.previsao).slice(0, 10) : null;
    const prev = pv ? `<div class="ag-prev ${pv < hojeISO() ? "vencida" : ""}">Previsão de entrega: <b>${br(pv)}</b>${pv < hojeISO() ? " (já passou)" : ""}</div>` : "";
    const fonte = t.fonte ? `<div class="s">${esc(t.fonte)}</div>` : "";
    switch (t.situacao) {
      case "entregue": return `<span class="chip verde">Entregue${t.data_entrega ? " " + br(t.data_entrega) : ""}</span>${fonte}`;
      case "nao entregue": return `${t.insucesso ? `<span class="chip vermelho">${esc(t.insucesso)}</span><div class="s">${ev}</div>` : `<span class="chip ambar">Não entregue</span><div>${ev}</div>`}${prev}${fonte}`;
      case "sem cte": return `<span class="chip cinza">Sem CT-e ainda</span><div class="s">não achei a NF em nenhum rastreio</div>`;
      case "sem rastreio": return `<span class="chip cinza">Sem rastreio automático</span><div class="s">Transiga: ver no site</div>`;
      case "sem permissao": return `<span class="chip ambar">Pede senha no SSW</span><div class="s">cadastre em Conferência SSW → Senhas</div>`;
      case "sem nf nova": return `<span class="chip ambar">NF nova não achada</span><div class="s">${t.fila_360 && !/aguardando entrega/i.test(t.fila_360) ? "ticket: " + esc(t.fila_360) : "sem \"NF … emitida\" no chat"}</div>`;
      case "sem nf": return `<span class="chip ambar">Série sem CNPJ</span>`;
      default: return `<span class="s">o robô ainda não olhou</span>`;
    }
  }
  function agRobo(t) {
    const q = t.baixa_em ? `<div class="s">${new Date(t.baixa_em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</div>` : "";
    if (t.baixa_status === "feita") return `<span class="chip verde">✓ Baixa feita</span>${q}`;
    if (t.insucesso && t.situacao !== "entregue" && t.nf_nova) {   // onde está a ocorrência desse insucesso
      const n = nfSerie({ nf: t.nf_nova });
      if (ocCadastrada({ nf: t.nf_nova })) return `<span class="chip verde">✓ Ocorrência cadastrada</span>`;
      if (notasNaFila().has(n.nf + "-" + n.serie)) return `<span class="chip azul">No robô do portal</span>`;
      return `<span class="chip ambar">Pronta em Ocorrências</span><div class="s">falta mandar para o robô</div>`;
    }
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
  // o relatório do Multi360 traz o pedido do marketplace; mostra o pedido da Intelipost (da base: pela NF antiga ou pelo fim do número)
  let agMapaGer = -1, agPorNF = new Map(), agPorFim = new Map();
  function pedidoIntelipost(t) {
    const fonte = gDados && gDados.length ? gDados : base;
    if (agMapaGer !== (gDados ? gGeracao : -2) || !agPorNF.size) {
      agPorNF = new Map(); agPorFim = new Map();
      fonte.forEach((r) => { const nf = r.serie !== undefined ? (r.serie ? `${r.nf}-${r.serie}` : r.nf) : r.nf; if (nf) agPorNF.set(chaveNF(nf), r.pedido); });
      agMapaGer = gDados ? gGeracao : -2;
    }
    const p = t.nf_original && agPorNF.get(chaveNF(t.nf_original));
    if (p) return p;
    const ped = String(t.pedido || "").trim();
    if (ped.length >= 8) { const f = fonte.find((r) => String(r.pedido || "").endsWith(ped)); if (f) return f.pedido; }
    return null;
  }
  function desenharAguardando() {
    $("ag-info").textContent = agInfo ? `${agInfo.arquivo || "relatório"} · enviado em ${new Date(agInfo.enviado_em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}${agInfo.enviado_por ? " por " + agInfo.enviado_por : ""} · ${fmt(agLista.length)} tickets`
      : "Suba o relatório de tickets da fila Aguardando entrega para começar.";
    const ult = agLista.reduce((m, t) => (t.consultado_em && t.consultado_em > m ? t.consultado_em : m), "");
    $("ag-robo").textContent = ult ? `Robô olhou pela última vez em ${new Date(ult).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}` : "";
    document.querySelectorAll("#ag-cards .kpi[data-ag]").forEach((b) => { const k = b.dataset.ag; b.querySelector(".kpi-num").textContent = fmt(k === "todos" ? agLista.length : agLista.filter((t) => agGrupo(t) === k).length); b.classList.toggle("ativa", k === agCard); });
    const q = norm(agBusca);
    const L = agLista.filter((t) => agCard === "todos" || agGrupo(t) === agCard)
      .filter((t) => !q || [t.ticket, t.pedido, pedidoIntelipost(t), t.pedido_promob, t.nf_nova, t.nf_original].some((v) => norm(v).includes(q)))
      .sort((a, b) => String(a.ticket_criado || "").localeCompare(String(b.ticket_criado || "")) || String(a.ticket).localeCompare(String(b.ticket), "pt-BR", { numeric: true }));
    $("ag-titulo").textContent = `${AG_NOME[agCard]} (${fmt(L.length)})`;
    $("ag-linhas").innerHTML = L.slice(0, 500).map((t) => {
      const o = agObs.get(t.ticket);
      return `<tr><td><a href="https://appv2.360multi.com/tickets/${encodeURIComponent(t.ticket)}" target="_blank" rel="noopener">${esc(t.ticket)}</a>${t.ticket_criado ? `<div class="s">${br(t.ticket_criado)}</div>` : ""}</td>
        <td>${esc(t.tipo || "")}${t.tipo_reposicao ? `<div class="s">${esc(t.tipo_reposicao)}</div>` : ""}</td>
        <td class="mono">${(() => { const pi = pedidoIntelipost(t); return pi ? `${esc(pi)}${pi !== t.pedido && t.pedido ? `<div class="s">marketplace ${esc(t.pedido)}</div>` : ""}` : esc(t.pedido || ""); })()}<div class="s">NF antiga ${esc(t.nf_original || "—")}</div></td>
        <td>${t.nf_nova ? `<b>${esc(t.nf_nova)}</b>${t.nf_emitida_em ? `<div class="s">emitida ${br(t.nf_emitida_em)}</div>` : ""}` : "—"}</td>
        <td>${esc(agTransp(t))}</td><td>${agStatus(t)}${agBotao(t)}</td><td>${agRobo(t)}</td>
        <td class="col-obs"><input data-ag-obs="${esc(t.ticket)}" value="${esc(o ? o.observacao : "")}" placeholder="O que foi feito…" maxlength="1000"><div class="s quem">${o ? esc((o.atualizado_por || "").split("@")[0]) + " · " + new Date(o.atualizado_em).toLocaleDateString("pt-BR") : ""}</div></td></tr>`;
    }).join("") + (L.length > 500 ? `<tr><td colspan="8" class="s">Mostrando 500 de ${fmt(L.length)} — use a busca ou baixe o Excel.</td></tr>` : "");
    $("ag-vazio").hidden = L.length > 0;
  }
  $("ag-cards").addEventListener("click", (e) => { const b = e.target.closest("[data-ag]"); if (!b) return; agCard = b.dataset.ag; desenharAguardando(); });
  $("ag-busca").addEventListener("input", (e) => { agBusca = e.target.value; desenharAguardando(); });
  $("ag-linhas").addEventListener("click", (e) => {
    const b = e.target.closest("[data-ag-rastreio]"); if (!b) return;
    const t = agLista.find((x) => x.ticket === b.dataset.agRastreio); if (!t) return;
    const tr = t.fonte && t.fonte !== "SSW" ? t.fonte : agTransp(t);
    abrirSSW(t.nf_nova, tr, null, /jadlog|formato|transiga/i.test(tr) ? { titulo: `Ticket ${t.ticket}`, pedido: t.pedido, nf: t.nf_nova, transportadora: /formato/i.test(tr) ? "Formato" : /transiga/i.test(tr) ? "Transiga" : "Jadlog", situacao: t.situacao, ultimo_evento: t.ultimo_evento,
      data_entrega: t.data_entrega, consultado_em: t.consultado_em, detalhe: t.detalhe } : null);
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
      const wb = XLSX.read(await arq.arrayBuffer(), { type: "array", dense: true, cellDates: true, ...LEITURA_RAPIDA });
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
    const linhas = [["Ticket", "Tipo", "Tipo de reposição", "Pedido Intelipost", "Pedido marketplace", "Pedido Promob", "NF antiga", "Nova NF", "NF emitida em", "Transportadora", "Status no rastreio", "Último evento", "Data do evento", "Data de entrega", "Insucesso", "Fonte", "Robô", "Observação", "Observação por"]]
      .concat(L.map((t) => { const o = agObs.get(t.ticket) || {}; return [t.ticket, t.tipo, t.tipo_reposicao, pedidoIntelipost(t) || "", t.pedido, t.pedido_promob, t.nf_original, t.nf_nova, br(t.nf_emitida_em), agTransp(t), SIT[t.situacao] || t.situacao, t.ultimo_evento, br(t.data_evento), br(t.data_entrega), t.insucesso, t.fonte, [t.baixa_status, t.baixa_msg].filter(Boolean).join(" · "), o.observacao || "", o.atualizado_por || ""]; }));
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
    [/formato/i, "Formato", (num) => { copiar(num); window.open("https://www.transformato.com.br/", "_blank", "noopener"); return `NF ${num} copiada. Entre com o login da Multi, clique em Consulta NF e cole a NF.`; }],
  ];
  const rastreioDe = (transp) => RASTREIO_PROPRIO.find(([re]) => re.test(transp || ""));
  // janela com o rastreio que o robô trouxe do sistema da transportadora (Jadlog, Bento Brasil, Trânsito Brasil)
  function cfJanela(x) {
    const d = x.detalhe || {}, item = (rot, val) => `<div class="det-item"><span>${rot}</span><b>${val || "—"}</b></div>`;
    const dh = (v) => { const m = String(v || "").match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}:\d{2}))?/); return m ? `${m[3]}/${m[2]}/${m[1]}${m[4] ? " " + m[4] : ""}` : esc(v || ""); };
    const sit = (CF_SIT[sitSSW(x.situacao, x.transportadora)] || [x.situacao])[0];
    $("modal-titulo").textContent = `Rastreio ${d.fonte || x.transportadora || ""} · ${x.titulo || "Pedido " + x.pedido}`;
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
        : `<p class="s">${x.detalhe ? "A transportadora ainda não mostra eventos para essa nota." : `O robô ainda não ${/transiga/i.test(x.transportadora || "") ? "recebeu o rastreio dessa nota da Transiga" : "consultou essa nota na " + (/formato/i.test(x.transportadora || "") ? "Formato" : "Jadlog")}.`}</p>`}
      <div class="cartao-topo" style="margin-top:10px"><p class="s" style="margin:0">Dados trazidos pelo robô do sistema da transportadora na última conferência.</p>
        ${/jadlog|formato|transiga/i.test(d.fonte || x.transportadora || "") && x.nf ? `<button class="btn mini contorno" id="cf-site-jadlog">Abrir no site da ${/formato/i.test(d.fonte || x.transportadora || "") ? "Formato" : /transiga/i.test(d.fonte || x.transportadora || "") ? "Transiga" : "Jadlog"} ↗</button>` : ""}</div>`;
    const bs = $("cf-site-jadlog");
    if (bs) bs.addEventListener("click", () => { const msg = rastreioDe(/formato/i.test(d.fonte || x.transportadora || "") ? "Formato" : /transiga/i.test(d.fonte || x.transportadora || "") ? "Transiga" : "Jadlog")[2](String(x.nf).split("-")[0].trim()); if (msg) toast(msg); });
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
  async function abrirSSW(nf, transp, pedido, dados) {   // abre o rastreio numa aba nova (consulta feita pelo navegador de quem clicou)
    const [num, ser] = String(nf || "").split("-").map((x) => x.trim());
    let x = dados || (pedido && cfLista.find((y) => y.pedido === pedido));
    // fora da Conferência SSW a lista não está carregada: busca só esse pedido (ou a NF) no que o robô já conferiu
    if (!x && (pedido || nf) && /jadlog|formato|transiga/i.test(transp || "")) {
      const q = (k, v) => sb.from("conferencia_ssw").select("*").eq(k, v).limit(1).then((r) => (r.data && r.data[0]) || null, () => null);
      x = (pedido && (await q("pedido", pedido))) || (nf && (await q("nf", nf))) || null;
    }
    // Transiga: lê na hora o último status que ela mandou pelo webhook (não espera a próxima rodada do robô)
    if (/transiga/i.test(transp || "") && nf) {
      const k = String(nf).trim().split("-").map((v) => v.trim().replace(/\.0+$/, "").replace(/^0+(?=\d)/, "")).join("-");
      const w = await sb.from("rastreio_transiga").select("descricao,data_evento,previsao,entregue,data_entrega,eventos,recebido_em,codigo").eq("nf", k).limit(1).then((r) => (r.data && r.data[0]) || null, () => null);
      if (w) { const base = x || { pedido: pedido || "", nf, transportadora: "Transiga" }, d0 = base.detalhe || {};
        x = { ...base, nf: base.nf || nf, situacao: w.entregue ? "entregue" : /arquivo recebido/i.test(w.descricao || "") ? "sem cte" : "nao entregue", ultimo_evento: (w.descricao || "").toUpperCase(),
          data_entrega: w.entregue ? String(w.data_entrega || w.data_evento || "").slice(0, 10) : null, consultado_em: w.recebido_em,
          detalhe: { ...d0, fonte: "Transiga", status: (w.descricao || "").toUpperCase(), previsao: w.previsao || null, codigo: d0.codigo || w.codigo || null,
            eventos: w.descricao ? [{ data: String(w.data_entrega || w.data_evento || "").slice(0, 16), status: (w.descricao || "").toUpperCase() + (w.eventos > 1 ? ` (último de ${w.eventos} eventos recebidos)` : ""), unidade: "" }] : [] } }; }
    }
    // Jadlog, Formato e Transiga (sites com login): sempre a janela com os dados do robô; o site fica num botão dentro dela
    if (/jadlog|formato|transiga/i.test(transp || "") || (x && /jadlog|formato|transiga/i.test(x.transportadora || ""))) return cfJanela(x || { pedido: pedido || "", nf, transportadora: transp, situacao: "pendente" });
    const prop = rastreioDe(transp);
    if (prop) { if (!num) return toast("Esse pedido não tem NF.", true); const msg = prop[2](num, ser); if (msg) toast(msg); return; }
    // usa o mesmo jeito que o robô achou a nota: outro CNPJ (detalhe.cnpj_outro) e/ou sem a senha (detalhe.sem_senha)
    if (!x && nf) x = cfLista.find((y) => y.nf === nf) || null;   // sem esperar o banco: o navegador só abre a aba nova se for na hora do clique
    const d = (x && x.detalhe) || {}, outro = d.cnpj_outro ? Object.keys(CNPJ_SERIE).find((k) => k.endsWith(d.cnpj_outro)) : null;
    const c = outro || cnpjDaSerie(ser);
    if (!num || !c) return toast("Essa NF não tem série com CNPJ conhecido.", true);
    const f = document.createElement("form"); f.method = "POST"; f.action = "https://ssw.inf.br/2/ssw_resultSSW"; f.target = "_blank"; f.rel = "noopener";
    for (const [k, v] of [["cnpj", c], ["NR", num], ["chave", d.sem_senha ? "" : senhaDe(transp)], ["urlori", "https://ssw.inf.br/ajuda/rastreamento.html"]]) { const i = document.createElement("input"); i.type = "hidden"; i.name = k; i.value = v; f.appendChild(i); }
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
  const tudoAtivo = () => cfTudo && cfTudo.pedido_em && (!cfTudo.feito_em || cfTudo.feito_em < cfTudo.pedido_em) && Date.parse(cfTudo.pedido_em) > Date.now() - 2 * 3600000;   // em lotes não passa de ~30 min; depois de 2 h não fica "conferindo" para sempre
  function desenharTudo() {
    const el = $("cf-tudo-info"); if (!cfTudo || !cfTudo.pedido_em) { el.hidden = true; return; }
    const quando = (d) => new Date(d).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
    const desde = cfTudo.pedido_em, alvo = cfLista.filter((x) => x.situacao !== "entregue" || (x.consultado_em && x.consultado_em >= desde));
    const feitos = alvo.filter((x) => x.consultado_em && x.consultado_em >= desde).length;
    el.hidden = false;
    el.innerHTML = tudoAtivo() ? `🔄 <b>Conferindo tudo de novo</b> desde ${quando(desde)} (pedido por ${esc((cfTudo.pedido_por || "").split("@")[0])}): ${fmt(feitos)} de ${fmt(alvo.length)} conferidos. A conferência em lotes leva uns 10 a 15 minutos; notas sem NF ou fora do SSW não entram na conta.`
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
        + (pend ? ` · o robô está conferindo sozinho, em lotes de 100 (faltam ${fmt(pend)}; rodada de uns 10 a 15 min)` : " · todos conferidos") + (ult ? ` · última conferência ${new Date(ult).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}` : "")
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
  // botão "Ver rastreio" nas listas que usam a linha do Preventivo (Preventivo, Análise de canais, Cobrança do dia)
  ["linhas", "c-linhas", "rt-linhas", "d-linhas"].forEach((id) => $(id).addEventListener("click", (e) => { const b = e.target.closest("[data-ssw]"); if (b) { e.stopPropagation(); abrirSSW(b.dataset.ssw, b.dataset.transp, b.dataset.pedido); } }));
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
    const minutos = Math.max(5, Math.round((itens.length / 9000) * 10) + 3);   // em lotes de 100: ~9 mil notas em ~10 min (16/11)
    if (!confirm(`${arq.name}\n\n${fmt(res.total)} pedidos no arquivo: ${fmt(res.fechados)} já Entregue/Cancelado (ficam de fora) e ${fmt(itens.length)} em aberto${semNf ? ` (${fmt(semNf)} sem NF)` : ""}.\n\nO robô confere todos no SSW sozinho, em lotes de 100 (uns ${minutos} minutos no total). Os entregues no SSW vão direto para "Falta atualizar a Intelipost". A lista anterior será substituída. Continuar?`)) return;
    carregando("Gravando…");
    const { error } = await sb.rpc("importar_conferencia", { linhas: itens });
    carregando("");
    if (error) return toast("Não consegui gravar: " + error.message, true);
    toast(`${fmt(itens.length)} pedidos importados. O robô do SSW já começou a conferir.`);
    cfCard = "todos"; await carregarConferencia();
  });
  setInterval(() => { if (paginaAtual === "conferencia" && !document.hidden && (cfLista.some(CF_CARD.pendente) || tudoAtivo())) carregarConferencia(); }, 60000);

  // ---------------- menu lateral ----------------
  function abrirRespPrev() { const d = $("prev-resp"); d.open = true; setTimeout(() => d.scrollIntoView({ behavior: "smooth", block: "start" }), 50); }
  $("btn-prev-resp").addEventListener("click", abrirRespPrev);
  function irPara(pag) {
    if (pag === "responsaveis") { pag = "preventivo"; setTimeout(abrirRespPrev, 100); }
    if (pag === "barrar") { pag = "alterar"; try { localStorage.setItem("painel.ap", "barrar"); } catch (_) {} setTimeout(() => { const b = document.querySelector('#ap-abas [data-ap="barrar"]'); if (b) b.click(); }, 300); }   // Barrar entrega agora fica dentro de Alterar pedidos   // Responsáveis agora fica dentro do Preventivo
    if (perfil !== "sac" && !podePag(pag)) { toast("Você não tem acesso a essa aba. Fale com a administradora do painel.", true); pag = primeiraPag(); }
    paginaAtual = pag;
    try { localStorage.setItem("painel.pagina", pag); } catch (_) {}
    $("topo-pagina").textContent = { gerencial: "Visão Gerencial", entregas: "Entregas e SLA", uf: "Atrasos por UF", canais: "Análise de canais", drop: "Dropshipping", transp: "Transportadoras", divtp: "Transportadora divergente", alterar: "Alterar pedidos", preventivo: "Preventivo", ocorrencias: "Ocorrências", responsaveis: "Responsáveis", reposicao: "Reposição", conferencia: "Conferência SSW", documentos: "Gerar XML", barrar: "Barrar entrega", retornos: "Cobrança do dia", ajuda: "Passo a passo", sac: "Consulta SAC", logins: "Logins" }[pag] || "";
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
    if (b.dataset.pagina === "retornos") abrirRetornos();
    if (b.dataset.pagina === "drop") desenharDrop();
    if (b.dataset.pagina === "ocorrencias") desenharOcorrencias();
    if (b.dataset.pagina === "logins") { carregarLogins(); carregarLoginsSac(); }
  });


  // ---------------- Dropshipping ----------------
  // pedidos com origem "Dropshipping" na base; diagnóstico pelo rastreio + detalhamento de tickets; nova data/observação = tratativas (valem em todas as abas)
  const D_EXTRAVIO = 15, D_PARADO = 7;
  const D_DIAG = [
    ["repo", "Reposição aberta", "laranja"], ["ocorr", "Ocorrência", "laranja"], ["entregue", "Já entregue (falta baixar)", "verde"],
    ["sinistro", "Extravio / sinistro", "vermelho"], ["falha", "Problema na entrega", "vermelho"], ["semexp", "Sem expedição", "cinza"],
    ["naocoletado", "Atrasado sem coleta", "vermelho"], ["extravio", "Provável extravio", "vermelho"], ["semcte", "Sem CT-e", "cinza"], ["parado", "Parado no rastreio", "roxo"],
    ["aguardando", "Aguardando 1º movimento", "cinza"],
    ["atraso", "Atrasado em trânsito", "ambar"], ["prazo", "No prazo", "verde"]];
  const D_NOME = Object.fromEntries(D_DIAG.map(([k, n]) => [k, n])), D_COR = Object.fromEntries(D_DIAG.map(([k, , c]) => [k, c]));
  const dSel = { card: "agir", diag: "", transp: "" };
  let dLista = [], dPagina = 1, dDetTentou = false;
  const ehDrop = (p) => norm(p.origem).includes("DROP");
  // Scallia (webhook "retorno dos pedidos", parte 45): último marco por NF e por número de pedido
  let scMapa = null, scTentou = false, scInfo = "", scTodos = new Map();
  const SC_ORDEM = { faturado: 1, coletado: 2, entregue: 3, cancelado: 4 };
  async function carregarScallia() {
    try {
      const L = await buscarTudo("scallia_eventos", "pedido"), m = new Map();
      const poe = (k, e) => { if (!k) return; const a = m.get(k); if (!a || (SC_ORDEM[e.marco] || 0) > (SC_ORDEM[a.marco] || 0) || ((SC_ORDEM[e.marco] || 0) === (SC_ORDEM[a.marco] || 0) && String(e.data_evento || "") > String(a.data_evento || ""))) m.set(k, e); };
      const todos = new Map(); const junta = (k, e) => { if (!k) return; const a = todos.get(k) || []; a.push(e); todos.set(k, a); };
      L.forEach((e) => { poe(e.pedido ? "P:" + norm(e.pedido) : "", e); if (e.nf) poe("N:" + chaveNF(e.serie ? `${e.nf}-${e.serie}` : e.nf), e);
        junta(e.pedido ? "P:" + norm(e.pedido) : "", e); if (e.nf) junta("N:" + chaveNF(e.serie ? `${e.nf}-${e.serie}` : e.nf), e); });
      L.forEach((e) => { if (e.pedido && e.nf) { const k = "N:" + chaveNF(e.serie ? `${e.nf}-${e.serie}` : e.nf); const a = todos.get("P:" + norm(e.pedido)); if (a) a.forEach((x) => { if (!(todos.get(k) || []).includes(x)) junta(k, x); }); } });
      scTodos = todos;
      scMapa = m; scInfo = L.length ? `Scallia: ${fmt(L.length)} avisos recebidos` : "Scallia: nenhum aviso recebido ainda";
    } catch (_) { scMapa = new Map(); scInfo = ""; }
  }
  const scChaves = (p) => { const x = p.extra || {}; return ["N:" + chaveNF(p.nf), "P:" + norm(p.pedido), x.promob && "P:" + norm(x.promob), x.pedido_any && "P:" + norm(x.pedido_any), x.id_any && "P:" + norm(x.id_any)].filter(Boolean); };
  const dScallia = (p) => { if (!scMapa || !scMapa.size) return null;
    for (const k of scChaves(p)) if (scMapa.has(k)) return scMapa.get(k);
    return null; };
  const scEventos = (p) => { for (const k of scChaves(p)) if (scTodos.has(k)) return scTodos.get(k); return []; };
  // etapa no jeito do Scallia. O aviso só traz faturado/coletado/entregue/cancelado: depois da coleta não dá para separar Transferência, CD e Last Mile
  const SC_ETAPA = { faturado: ["Aguardando Coleta", "azul"], coletado: ["Transferência", "lilas"], entregue: ["Entregue", "verde"], cancelado: ["Devolução/Cancelado", "cinza"] };
  function scJanela(p) {
    const ev = [...scEventos(p)].sort((a, b) => (SC_ORDEM[a.marco] || 0) - (SC_ORDEM[b.marco] || 0) || String(a.data_evento || "").localeCompare(String(b.data_evento || "")));
    const ult = dScallia(p) || {}, et = SC_ETAPA[ult.marco] || [ult.marco || "—"];
    const dh = (v) => v ? new Date(v).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "";
    const passos = [["faturado", "Aguardando Faturamento → faturado"], ["coletado", "Aguardando Coleta → coletado"], ["", "Transferência / CD / Last Mile"], ["entregue", "Entregue"]];
    const tem = (m) => ev.find((e) => e.marco === m);
    const nfE = ev.find((e) => e.nf) || {};
    $("modal-titulo").textContent = `Jornada no Scallia · Pedido ${p.pedido || ""}`;
    $("modal-corpo").innerHTML = `
      <div class="det-grade">
        <div class="det-item"><span>Etapa</span><b>${esc(et[0])}</b></div>
        <div class="det-item"><span>NF</span><b>${esc(nfE.nf ? nfE.nf + (nfE.serie ? "-" + nfE.serie : "") : p.nf || "—")}</b></div>
        <div class="det-item"><span>Transportadora (coleta)</span><b>${esc((tem("coletado") || {}).transportadora || ult.transportadora || "—")}</b></div>
        <div class="det-item"><span>Chave da NF-e</span><b style="font-size:11px;word-break:break-all">${esc(nfE.chave || "—")}</b></div>
      </div>
      <h3 class="cf-h3">Jornada</h3>
      <ol class="sc-jornada">${tem("cancelado") ? `<li class="feito"><b>Devolução/Cancelado</b> <span class="s">${dh(tem("cancelado").data_evento)}</span></li>` : ""}
        ${passos.map(([m, rot]) => { const e = m && tem(m); const depois = !m && (tem("entregue") || tem("coletado"));
          const passou = m && SC_ORDEM[m] < 4 && ev.some((x) => (SC_ORDEM[x.marco] || 0) > SC_ORDEM[m] && x.marco !== "cancelado");
          return `<li class="${e || passou ? "feito" : !m && tem("coletado") && !tem("entregue") ? "atual" : depois ? "feito" : ""}"><b>${esc(rot)}</b>${e ? ` <span class="s">${dh(e.data_evento)}${e.transportadora ? " · " + esc(e.transportadora) : ""}</span>` : !m && tem("coletado") && !tem("entregue") ? ` <span class="s">em trânsito</span>` : ""}</li>`; }).join("")}</ol>
      <p class="s">Dados dos avisos que o Scallia manda ao painel (faturado, coletado, entregue, cancelado). Transferência, CD e Last Mile ainda não vêm separados no aviso.</p>`;
    $("modal").hidden = false; document.body.classList.add("sem-rolagem");
  }
  const dDet = (p) => (detNF ? detNF.get(chaveNF(p.nf)) || null : null);
  const dForn = (p) => (p.extra && p.extra.fornecedor) || "";
  function dDiag(p) {
    const d = dDet(p) || {}, ms = norm(`${p.micro_status || ""} ${p.status_intelipost || ""}`), x = ssw.get(p.pedido) || {};
    if (d.tem_repo) return "repo";
    if (d.tem_ocorr) return "ocorr";
    if (p.entregue_ip || x.situacao === "entregue" || (dScallia(p) || {}).marco === "entregue") return "entregue";
    if (/EXTRAVI|ROUB|SINISTR|FURT/.test(ms)) return "sinistro";
    if (/FALHA|AVARI|DEVOLU|RECUS|ENDERECO|AUSENTE|MUDOU|INSUCESSO|NAO ENTREGUE/.test(ms)) return "falha";
    if (!p.data_expedicao || norm(p.sem_expedicao).startsWith("S")) return "semexp";
    if (dSemMov(p)) return p._atrasoG ? "naocoletado" : /sem cte/.test(x.situacao || "") ? "semcte" : "aguardando";
    if (p._parado !== null && p._parado >= D_EXTRAVIO && p._atrasoG) return "extravio";
    if (p._parado !== null && p._parado > D_PARADO) return "parado";
    if (p._atrasoG) return "atraso";
    return "prazo";
  }
  // "Despachado" / "Emissão do CT-e" = a transportadora ainda não deu nenhum movimento: tempo parado aqui não é extravio
  const dSemMov = (p) => /^(DESPACHADO|EMISSAO DO CT-?E)/.test(norm(p.micro_status));
  const dSemNova = (p) => { const n = p._t && p._t.nova_data; return !n || n < hojeISO(); };
  const D_CARD = { agir: (p) => p._atrasoG && dSemNova(p) && !["entregue", "repo", "ocorr"].includes(p._dd),
    extravio: (p) => ["extravio", "sinistro"].includes(p._dd), coleta: (p) => p._dd === "naocoletado",
    repocorr: (p) => ["repo", "ocorr"].includes(p._dd), abertos: () => true };
  const D_ORDEM = ["sinistro", "extravio", "naocoletado", "falha", "repo", "ocorr", "parado", "semcte", "semexp", "atraso", "aguardando", "entregue", "prazo"];
  // filtros do topo (mesmo modelo da Visão Gerencial: várias opções em cada um)
  const D_CAMPOS = { canal: (p) => p.canal || "", uf: (p) => p.uf || "", transp: (p) => gProdK(p.transportadora) || "", serie: (p) => String(p.nf || "").split("-")[1]?.trim() || "",
    forn: (p) => dForn(p) || "", status: (p) => p.status_intelipost || "", micro: (p) => p.micro_status || "" };
  const dMS = Object.fromEntries(Object.keys(D_CAMPOS).map((k) => [k, new Set()]));
  function montarFiltrosD(D) {
    document.querySelectorAll("#d-filtros .multi").forEach((el) => {
      const k = el.dataset.dm, cont = new Map();
      D.forEach((p) => { const v = D_CAMPOS[k](p); if (v) cont.set(v, (cont.get(v) || 0) + 1); });
      [...dMS[k]].forEach((v) => { if (!cont.has(v)) dMS[k].delete(v); });
      const ops = [...cont.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]), "pt-BR", { numeric: true }));
      const pn0 = el.querySelector(".multi-painel"), aberto = pn0 && !pn0.hidden, q = el.querySelector(".multi-busca") ? el.querySelector(".multi-busca").value : "";
      el.innerHTML = `<span class="multi-rotulo">${esc(el.dataset.rotulo)}</span>
        <button type="button" class="multi-botao"><span class="multi-valor"></span><span class="seta">▾</span></button>
        <div class="multi-painel" ${aberto ? "" : "hidden"}><input class="multi-busca" type="search" placeholder="Procurar…" value="${esc(q)}">
          <div class="multi-lista">${ops.map(([v, n]) => `<label class="multi-op"><input type="checkbox" value="${esc(v)}" ${dMS[k].has(v) ? "checked" : ""}><span>${esc(v)}</span><em>${fmt(n)}</em></label>`).join("")}</div>
          <div class="multi-acoes"><button type="button" class="link" data-acao="limpar">Limpar</button><span class="s">${fmt(ops.length)} opções</span></div></div>`;
      valorMultiD(el);
    });
  }
  function valorMultiD(el) { const s = dMS[el.dataset.dm]; el.querySelector(".multi-valor").textContent = !s.size ? "Todos" : s.size === 1 ? [...s][0] : `${s.size} selecionados`; el.classList.toggle("ativo", s.size > 0); }
  $("d-filtros").addEventListener("click", (e) => {
    const bt = e.target.closest(".multi-botao");
    if (bt) { const pn = bt.parentElement.querySelector(".multi-painel"), ab = pn.hidden; document.querySelectorAll("#d-filtros .multi-painel").forEach((x) => (x.hidden = true)); pn.hidden = !ab; if (ab) pn.querySelector(".multi-busca").focus(); return; }
    const lp = e.target.closest("[data-acao=limpar]");
    if (lp) { const el = lp.closest(".multi"); dMS[el.dataset.dm].clear(); dMudou(); }
  });
  $("d-filtros").addEventListener("change", (e) => {
    if (e.target.type === "checkbox") { const el = e.target.closest(".multi"); e.target.checked ? dMS[el.dataset.dm].add(e.target.value) : dMS[el.dataset.dm].delete(e.target.value); dMudou(); }
    else if (e.target.type === "date") dMudou();
  });
  $("d-filtros").addEventListener("input", (e) => {
    if (!e.target.classList.contains("multi-busca")) return; const q = norm(e.target.value);
    e.target.closest(".multi").querySelectorAll(".multi-op").forEach((op) => (op.hidden = q && !norm(op.textContent).includes(q)));
  });
  document.addEventListener("click", (e) => { if (!e.target.closest("#d-filtros .multi")) document.querySelectorAll("#d-filtros .multi-painel").forEach((x) => (x.hidden = true)); });
  function desenharDrop(soSeAberta) {
    const D = base.filter(ehDrop);
    D.forEach((p) => { p._dd = dDiag(p); });
    const atrasados = D.filter(D_CARD.agir).length;
    $("menu-drop").hidden = !atrasados; $("menu-drop").textContent = fmt(atrasados);
    if (soSeAberta && paginaAtual !== "drop") return;
    if (!detNF && !dDetTentou) { dDetTentou = true; carregarDetNF().then((m) => { if (m.size) desenharDrop(true); }); }
    if (!scTentou) { scTentou = true; carregarScallia().then(() => desenharDrop(true)); }
    // opções dos filtros
    const opc = (id, f, todos) => { const el = $(id), v = el.value, c = new Map(); D.forEach((p) => { const k = f(p); if (k) c.set(k, (c.get(k) || 0) + 1); });
      el.innerHTML = `<option value="">${todos}</option>` + [...c].sort((a, b) => a[0].localeCompare(b[0], "pt-BR")).map(([k, n]) => `<option value="${esc(k)}">${esc(k)} (${fmt(n)})</option>`).join(""); el.value = c.has(v) ? v : ""; };
    void opc; montarFiltrosD(D);
    const busca = norm($("d-busca").value).split(/[\s,;]+/).filter(Boolean), forn = [...dMS.forn].join(", ");
    const dDe = $("d-de").value, dAte = $("d-ate").value;
    const passa = (p, menos) => {
      if (busca.length && !busca.some((b) => norm(p.pedido).includes(b) || norm(p.nf).includes(b))) return false;
      if (menos !== "transp" && dSel.transp && (gProdK(p.transportadora)) !== dSel.transp) return false;
      for (const k in dMS) if (dMS[k].size && !dMS[k].has(D_CAMPOS[k](p))) return false;
      const dc = String(p.data_criacao || "").slice(0, 10); if (dDe && (!dc || dc < dDe)) return false; if (dAte && (!dc || dc > dAte)) return false;
      if (menos !== "diag" && dSel.diag && p._dd !== dSel.diag) return false;
      if (menos !== "card" && !D_CARD[dSel.card](p)) return false;
      return true; };
    const B = D.filter((p) => passa(p, "card"));
    document.querySelectorAll("#d-cards .kpi[data-d]").forEach((b) => { b.querySelector(".kpi-num").textContent = fmt(B.filter(D_CARD[b.dataset.d]).length); b.classList.toggle("ativa", dSel.card === b.dataset.d); });
    // diagnóstico
    const BD = D.filter((p) => passa(p, "diag"));
    $("d-diag-linhas").innerHTML = D_DIAG.map(([k, n, c]) => { const xs = BD.filter((p) => p._dd === k); if (!xs.length && dSel.diag !== k) return "";
      return `<tr class="clicavel ${dSel.diag === k ? "sel" : ""}" data-dd="${k}"><td><span class="chip ${c}">${n}</span></td><td class="num">${fmt(xs.length)}</td><td class="num">${fmt(xs.filter((p) => p._atrasoG).length)}</td><td class="num">${fmt(xs.filter((p) => p._atrasoG && dSemNova(p)).length)}</td></tr>`; }).join("")
      + `<tr class="tot-linha"><td>Total</td><td class="num">${fmt(BD.length)}</td><td class="num">${fmt(BD.filter((p) => p._atrasoG).length)}</td><td class="num">${fmt(BD.filter((p) => p._atrasoG && dSemNova(p)).length)}</td></tr>`;
    // transportadoras
    const BT = D.filter((p) => passa(p, "transp")), mt = new Map();
    BT.forEach((p) => { const t = gProdK(p.transportadora), x = mt.get(t) || { t, ab: 0, at: 0, pa: 0, ex: 0 }; x.ab++; if (p._atrasoG) x.at++; if (!dSemMov(p) && p._parado !== null && p._parado > D_PARADO) x.pa++; if (D_CARD.extravio(p)) x.ex++; mt.set(t, x); });
    $("d-transp-linhas").innerHTML = [...mt.values()].sort((a, b) => b.at - a.at || b.ab - a.ab).map((x) => `<tr class="clicavel ${dSel.transp === x.t ? "sel" : ""}" data-dt="${esc(x.t)}"><td>${esc(x.t)}</td><td class="num neutro">${fmt(x.ab)}</td><td class="num">${fmt(x.at)}</td><td class="num">${fmt(x.pa)}</td><td class="num">${fmt(x.ex)}</td></tr>`).join("")
      || `<tr><td colspan="5" class="vazio">Nenhum pedido.</td></tr>`;
    // lista
    const ord = (p) => D_ORDEM.indexOf(p._dd);
    dLista = D.filter((p) => passa(p)).sort((a, b) => ord(a) - ord(b) || (b._parado || 0) - (a._parado || 0) || String(a._venc || "9").localeCompare(String(b._venc || "9")));
    const card = { agir: "Atrasados sem nova data", extravio: "Possível extravio", coleta: "Atrasado sem coleta", repocorr: "Com reposição ou ocorrência", abertos: "Todos em aberto" }[dSel.card];
    $("d-sel").hidden = !(dSel.diag || dSel.transp);
    $("d-sel").innerHTML = [dSel.diag && `<span class="chip-sel">${esc(D_NOME[dSel.diag])} <button class="link" data-dx="diag" title="Tirar">✕</button></span>`, dSel.transp && `<span class="chip-sel">${esc(dSel.transp)} <button class="link" data-dx="transp" title="Tirar">✕</button></span>`].filter(Boolean).join("");
    const cont = (k) => D.filter((p) => passa(p, "card") && p._dd === k).length;
    $("d-abertos-sub").textContent = `${fmt(cont("aguardando"))} aguardando coleta no prazo · ${fmt(cont("prazo"))} em trânsito no prazo`;
    $("d-lista-titulo").textContent = `${[card, dSel.diag && D_NOME[dSel.diag], dSel.transp, forn].filter(Boolean).join(" · ")} (${fmt(dLista.length)})`;
    $("d-info").textContent = D.length ? `${fmt(D.length)} pedidos de dropshipping em aberto · ${fmt(D.filter((p) => p._atrasoG).length)} atrasados · base de ${info ? new Date(info.enviado_em).toLocaleDateString("pt-BR") : "—"}${scInfo ? " · " + scInfo : ""}${detNF ? "" : " · carregando ocorrências e reposições…"}`
      : base.length ? "Nenhum pedido com origem Dropshipping na base em aberto." : "Carregando…";
    desenharDLista();
  }
  function dChip(p) {
    const d = dDet(p) || {}, ids = String(d.repo_ticket || "").split(",").filter(Boolean);
    return `<span class="chip ${D_COR[p._dd]}">${D_NOME[p._dd]}</span>`
      + (p._parado !== null ? `<div class="s">${fmt(p._parado)} dia${p._parado === 1 ? "" : "s"} sem movimento</div>` : "")
      + (d.ocorr_status ? `<div class="s" title="${esc(d.ocorr_msg || "")}">Ocorrência: ${esc(d.ocorr_status)}</div>` : "")
      + (ids.length ? `<div class="s tk-links">Reposição ${ids.map((id) => `<a href="https://appv2.360multi.com/tickets/${encodeURIComponent(id)}" target="_blank" rel="noopener noreferrer">#${esc(id)}</a>`).join(" ")}${d.repo_fila ? " · " + esc(d.repo_fila) : ""}</div>` : "")
      + (dForn(p) ? `<div class="s">Fornecedor: ${esc(dForn(p))}</div>` : "")
      + ((s) => (s ? `<div class="s sc"><a href="#" class="sc-abrir" data-p="${esc(p.pedido)}" title="Ver a jornada no Scallia">Scallia</a>: <span class="chip ${(SC_ETAPA[s.marco] || [, "cinza"])[1]}">${esc((SC_ETAPA[s.marco] || [s.marco])[0])}</span>${s.data_evento ? " " + br(String(s.data_evento).slice(0, 10)) : ""}</div>` : ""))(dScallia(p));
  }
  function desenharDLista() {
    const total = dLista.length, pags = Math.max(1, Math.ceil(total / POR_PAGINA)); dPagina = Math.min(Math.max(1, dPagina), pags);
    $("d-linhas").innerHTML = dLista.slice((dPagina - 1) * POR_PAGINA, dPagina * POR_PAGINA).map((p) => linhaPreventivo(p, "data-d-campo", `<td>${dChip(p)}</td>`)).join("");
    $("d-vazio").hidden = total > 0;
    $("d-paginacao").innerHTML = total > POR_PAGINA ? `<button class="btn" data-p="-1" ${dPagina === 1 ? "disabled" : ""}>‹ Anterior</button><span>Página ${dPagina} de ${pags}</span><button class="btn" data-p="1" ${dPagina === pags ? "disabled" : ""}>Próxima ›</button>` : "";
  }
  const dMudou = () => { dPagina = 1; desenharDrop(); };
  $("d-cards").addEventListener("click", (e) => { const b = e.target.closest(".kpi[data-d]"); if (!b) return; dSel.card = b.dataset.d; dMudou(); });
  $("pagina-drop").addEventListener("click", (e) => {
    const sa = e.target.closest(".sc-abrir"); if (sa) { e.preventDefault(); const p = dLista.find((x) => String(x.pedido) === sa.dataset.p); if (p) scJanela(p); return; }
    const dx = e.target.closest("[data-dx]"); if (dx) { dSel[dx.dataset.dx] = ""; return dMudou(); }
    const dd = e.target.closest("tr[data-dd]"); if (dd) { dSel.diag = dSel.diag === dd.dataset.dd ? "" : dd.dataset.dd; if (dSel.diag) dSel.card = "abertos"; dMudou(); return $("d-lista-titulo").scrollIntoView({ behavior: "smooth", block: "start" }); }
    const dt = e.target.closest("tr[data-dt]"); if (dt) { dSel.transp = dSel.transp === dt.dataset.dt ? "" : dt.dataset.dt; dMudou(); return $("d-lista-titulo").scrollIntoView({ behavior: "smooth", block: "start" }); }
    const pb = e.target.closest("#d-paginacao button[data-p]"); if (pb) { dPagina += Number(pb.dataset.p); desenharDLista(); $("d-lista-titulo").scrollIntoView({ block: "start" }); }
  });
  let dEspera; $("d-busca").addEventListener("input", () => { clearTimeout(dEspera); dEspera = setTimeout(dMudou, 250); });
  $("d-limpar").addEventListener("click", () => { dSel.card = "agir"; dSel.diag = ""; dSel.transp = ""; $("d-busca").value = ""; $("d-de").value = ""; $("d-ate").value = ""; Object.values(dMS).forEach((x) => x.clear()); dMudou(); });
  $("d-linhas").addEventListener("click", (e) => { if (e.target.closest("input, select, textarea, a, button")) return; const tr = e.target.closest("tr[data-pedido]"); if (tr) abrirDetalhe(tr.dataset.pedido); });
  $("d-linhas").addEventListener("change", async (e) => {
    const inp = e.target.closest("[data-d-campo]"); if (!inp) return; const tr = inp.closest("tr[data-pedido]");
    await gravar(tr.dataset.pedido, inp.dataset.dCampo, inp.value, tr.querySelector(".quem"));
  });
  $("d-exportar").addEventListener("click", () => {
    if (!dLista.length) return toast("Nada para exportar.", true);
    const linhas = [["Pedido Intelipost", "NF", "Canal", "Fornecedor", "Transportadora", "UF", "Cidade", "Micro status", "Expedição", "Prometido ao cliente", "Atrasado", "Dias sem movimento", "Diagnóstico",
      "Tem ticket", "Fila do ticket", "Ticket(s)", "Tipo / motivo do ticket", "Tem ocorrência", "Ocorrência", "Reposição (tickets)", "Fila da reposição", "Previsão SSW", "Scallia (último aviso)", "Nova data", "Observação", "Atualizado por", "Link de rastreio"]]
      .concat(dLista.map((p) => { const d = dDet(p) || {}, t = p._t || {}, tk = ticketDe(p) || {};
        return [p.pedido, p.nf, p.canal, dForn(p), p.transportadora, p.uf, p.cidade, p.micro_status, br(p.data_expedicao), br(p._venc), p._atrasoG ? "Sim" : "Não", p._parado ?? "", D_NOME[p._dd],
          tk.fila || tk.id_ticket ? "Sim" : "Não", tk.fila || "", tk.id_ticket || "", [tk.tipo, tk.motivo].filter(Boolean).join(" · "), d.ocorr_status ? "Sim" : "Não", d.ocorr_status || "", d.repo_ticket || "", d.repo_fila || "", br((ssw.get(p.pedido) || {}).previsao), ((s) => (s ? `${s.marco}${s.data_evento ? " " + br(String(s.data_evento).slice(0, 10)) : ""}${s.transportadora ? " · " + s.transportadora : ""}` : ""))(dScallia(p)), br(t.nova_data), t.observacao || "", t.atualizado_por || "", p.link_rastreio || ""]; }));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(linhas), "Dropshipping");
    XLSX.writeFile(wb, `dropshipping_${hojeISO()}.xlsx`);
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
      const wb = XLSX.read(await arq.arrayBuffer(), { type: "array", dense: true, ...LEITURA_RAPIDA });
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
    const ids = String((t && t.id_ticket) || "").split(",").map((x) => x.trim()).filter(Boolean);
    return t ? `<div class="s tk" title="${esc([t.tipo, t.motivo].filter(Boolean).join(" · "))}">🎫 Fila: ${esc(t.fila || "—")}${t.qtd > 1 ? ` (${t.qtd} tickets)` : ""}${ids.length ? `<div class="tk-links">${ids.map((id) => `<a href="https://appv2.360multi.com/tickets/${encodeURIComponent(id)}" target="_blank" rel="noopener noreferrer" title="Abrir o ticket no Multi360">#${esc(id)}</a>`).join(" ")}</div>` : ""}</div>`
      : `<div class="s sem-tk">Sem ticket</div>`;
  }
  async function carregarTickets() {
    try {
      const inf = await sb.from("tickets_info").select("*").limit(1);
      const lista = await buscarComCache("tickets_abertos", "nf", "*", inf.data && inf.data[0] ? inf.data[0].enviado_em : "");
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
    let linhas, total = 0, detLinhas = [], wbDet = null;
    try {
      const wb = XLSX.read(await arq.arrayBuffer(), { type: "array", dense: true, cellDates: true, ...LEITURA_RAPIDA });
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
        else { novo.qtd = ant.qtd + 1; const mais = String(novo.criado_em || "") >= String(ant.criado_em || "");
          const ids = [...new Set((mais ? [novo.id_ticket, ant.id_ticket] : [ant.id_ticket, novo.id_ticket]).flatMap((x) => String(x || "").split(",")).map((x) => x.trim()).filter(Boolean))].join(",");   // guarda todos os números (o mais novo primeiro)
          porNF.set(nf, { ...(mais ? novo : ant), qtd: novo.qtd, id_ticket: ids || null }); }
      });
      linhas = [...porNF.values()];
      if (!linhas.length) throw new Error("A aba Tickets não tem notas.");
      detLinhas = lerDetalheNF(wb); wbDet = wb;
    } catch (err) { carregando(""); toast(err.message, true); return; }
    carregando("");
    if (!confirm(`${arq.name}\n\n${fmt(total)} tickets abertos, em ${fmt(linhas.length)} notas.\nSubstitui a planilha de tickets anterior para todos.\n\nEnviar?`)) return;
    try {
      await enviarLotes("importar_tickets", linhas, 2000, (lote, primeiro) => ({ linhas: lote, limpar: primeiro, arquivo: arq.name, total }));
    } catch (err) { carregando(""); toast("Erro ao enviar: " + err.message, true); return; }
    // abas Ocorrências, Reposições e Assistência Técnica (colunas do Excel da Visão Gerencial, parte 32)
    let avisoDet = "";
    if (detLinhas.length) {
      try { await enviarLotes("importar_detalhe_nf", detLinhas, 2000, (lote, primeiro) => ({ linhas: lote, limpar: primeiro })); }
      catch (error) { avisoDet = /importar_detalhe_nf|function/i.test(error.message) ? " (ocorrências e reposições não foram: falta rodar a parte 32 do schema.sql)" : " (ocorrências e reposições: " + error.message + ")"; }
      detNF = null; gDetTentou = false;
    }
    carregando("");
    const avisoHist = wbDet ? await guardarHistRepo(arq, wbDet).catch((err) => " · histórico: " + err.message) : "";
    carregando("Atualizando o painel…");
    try { await carregar(); } finally { carregando(""); }   // o histórico deixava a janela "Enviando…" aberta para sempre
    if (avisoHist && /guardados/.test(avisoHist)) carregarReposicoes();
    if (avisoDet) toast("Tickets atualizados" + avisoDet + avisoHist, true); else toast(`Tickets atualizados: ${fmt(base.filter((p) => ticketDe(p)).length)} pedidos do painel têm ticket aberto · ${fmt(detLinhas.filter((x) => x.tem_ocorr).length)} notas com ocorrência e ${fmt(detLinhas.filter((x) => x.repo_nf).length)} com NF de reposição guardadas${avisoHist}.`);
  });

  // abas Ocorrências, Reposições e Assistência Técnica do detalhamento_tickets360 → uma linha por NF
  function lerDetalheNF(wb) {
    const aba = (nome) => { const n = wb.SheetNames.find((x) => norm(x) === nome); if (!n) return null;
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null }); if (!rows.length) return null;
      const cab = rows[0].map(norm); return { rows: rows.slice(1), c: (nome2) => cab.indexOf(nome2) }; };
    const txt = (v) => (v == null || v === "" ? null : v instanceof Date ? v.toISOString() : String(v).trim());
    const m = new Map(), de = (nf) => { const k = chaveNF(nf); if (!k || !k.includes("-")) return null; if (!m.has(k)) m.set(k, { nf: k }); return m.get(k); };
    const oc = aba("OCORRENCIAS");
    if (oc) { const cN = oc.c("NOTA FISCAL"), cS = oc.c("STATUS OCORRENCIA"), cM = oc.c("ULTIMA MENSAGEM"), cD = oc.c("DATA ULTIMA MENSAGEM"), cC = oc.c("DATA CRIACAO OCORRENCIA");
      if (cN >= 0) oc.rows.forEach((r) => { const x = r && de(r[cN]); if (!x) return; const d = txt(cD >= 0 ? r[cD] : null) || txt(cC >= 0 ? r[cC] : null) || "";
        if (x.ocorr_em && String(x.ocorr_em) > d) return;   // fica a ocorrência com a mensagem mais recente
        Object.assign(x, { tem_ocorr: true, ocorr_status: txt(cS >= 0 ? r[cS] : null), ocorr_msg: (txt(cM >= 0 ? r[cM] : null) || "").slice(0, 1000) || null, ocorr_em: d || null }); }); }
    const rp = aba("REPOSICOES");
    if (rp) { const cN = rp.c("NOTA TICKET"), cR = rp.c("NF EMITIDA PROMOB"), cD = rp.c("DATA EMISSAO PROMOB"), cId = rp.c("ID TICKET"), cF = rp.c("FILA ATUAL DO TICKET"), cC = rp.c("DATA CRIACAO TICKET");
      if (cN >= 0) rp.rows.forEach((r) => { const x = r && de(r[cN]); if (!x) return; x.tem_repo = true;
        const nova = cR >= 0 ? txt(r[cR]) : null, d = txt(cD >= 0 ? r[cD] : null) || "";
        if (nova && (!x.repo_nf || d >= (x._rd || ""))) { x.repo_nf = chaveNF(nova); x._rd = d; }
        const id = cId >= 0 ? txt(r[cId]) : null, dc = txt(cC >= 0 ? r[cC] : null) || "";
        if (id) { const ids = x.repo_ticket ? x.repo_ticket.split(",") : []; if (!ids.includes(id)) ids.push(id); x.repo_ticket = ids.slice(-5).join(","); }
        if (cF >= 0 && txt(r[cF]) && dc >= (x._rc || "")) { x.repo_fila = txt(r[cF]); x._rc = dc; } }); }
    const at = aba("ASSISTENCIA TECNICA");
    if (at) { const cN = at.c("NOTA TICKET"); if (cN >= 0) at.rows.forEach((r) => { const x = r && de(r[cN]); if (x) x.tem_at = true; }); }
    return [...m.values()].map(({ _rd, _rc, ...x }) => x);
  }

  // ---------------- BI de Reposições ----------------
  // Contagem oficial = TABELA DE ACOMPANHAMENTO (aba Export, um ticket por linha). Tipo "Reposição" = pré-entrega;
  // "Reposição Pós Entrega" = pós-entrega. Transportadora da entrega original = coluna R (redespacho) se houver, senão Q.
  // Nova NF, datas e transportadora Promob = visão consolidada do histórico do detalhamento (parte 36, repo_atual).
  let reps = [], repInfo = null, repOk = true, repAtual = new Map(), repEnvio = null, repHistOk = true, repAba = "geral", repFiltradas = [], rpdPag = 1;
  const SEM_MOTIVO = "(sem motivo)", SEM_TRANSP = "(sem transportadora)", SEM_FILIAL = "(sem filial)", SEM_RESP = "(sem responsável)";
  const NOME_MES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  const rotMes = (m) => (m ? `${NOME_MES[+m.slice(5, 7) - 1]}/${m.slice(0, 4)}` : "(sem data)");
  const tipoRep = (r) => { const t = norm(r.tipo); return t === "REPOSICAO" ? "pre" : t === "REPOSICAO POS ENTREGA" ? "pos" : null; };
  const mesRep = (r) => String(r.criado_em || "").slice(0, 7);
  const trRep = (r) => r.transportadora || SEM_TRANSP;
  const motRep = (r) => r.motivo || SEM_MOTIVO;
  const filRep = (r) => r.filial || SEM_FILIAL;
  const respRep = (r) => r.responsavel || SEM_RESP;
  // situação (regra da Brenda 18/11): Resolvido ou Encerrado = finalizado; fila "Recuperação de crédito" = pendente de
  // solução da Recuperação de crédito (não faz mais parte de reposição, não conta como em aberto); o resto = em aberto
  const filaRep = (r) => r.fila || (r._d && r._d.fila_atual) || "";   // regra da Brenda (18/11): fila da TABELA DE ACOMPANHAMENTO vale primeiro
  const sitRep = (r) => /^(RESOLVID|ENCERRAD|FINALIZAD)/.test(norm(r.status)) ? "fin" : /RECUPERACAO DE CREDITO/.test(norm(filaRep(r))) ? "rec" : "ab";
  const ROT_SIT = { ab: "Em aberto", fin: "Finalizado", rec: "Pendente Recuperação de crédito" };
  const abertoRep = (r) => sitRep(r) === "ab";
  const SEM_SERIE = "(sem série)", SEM_FILA = "(sem fila)", SEM_GRUPO = "(sem grupo)";
  const grupoRep = (r) => r.grupo || SEM_GRUPO;   // coluna Grupo da tabela de acompanhamento (parte 47)
  const serieRep = (r) => { const m = String(r.nf || "").trim().match(/-\s*(\d+)\s*$/); return m ? String(Number(m[1])) : SEM_SERIE; };
  // dias parados na fila atual: desde a mudança de fila vista no histórico do detalhamento; se o ticket já estava nessa
  // fila no 1º detalhamento guardado, conta desde a Data da Última Atualização do ticket (tabela de acompanhamento)
  function diasFila(r) {
    const d = r._d, hoje = hojeISO();
    const mesma = d && norm(d.fila_atual) === norm(filaRep(r));   // a mudança vista no detalhamento só vale se for a mesma fila da tabela
    const viu = mesma && d.ultima_mudanca_em && d.primeiro_envio_em && d.ultima_mudanca_em > d.primeiro_envio_em ? d.ultima_mudanca_em : null;
    const base = viu || r.atualizado_em || r.criado_em;
    return base ? Math.max(0, diasEntre(diaLocal(base), hoje)) : null;
  }
  const FAIXAS_FILA = [["+50 dias", 50, 1e9], ["+40 dias", 40, 49], ["+30 dias", 30, 39], ["+20 dias", 20, 29], ["+10 dias", 10, 19], ["+5 dias", 5, 9], ["4 dias", 4, 4], ["3 dias", 3, 3], ["2 dias", 2, 2], ["1 dia", 1, 1], ["Hoje", 0, 0]];
  const faixaFila = (n) => (n == null ? -1 : FAIXAS_FILA.findIndex(([, a, b]) => n >= a && n <= b));
  const diasAberto = (r) => (abertoRep(r) && r.criado_em ? Math.max(0, diasEntre(String(r.criado_em).slice(0, 10), hojeISO())) : null);
  const semAtualiz = (r) => abertoRep(r) && r.atualizado_em && diasEntre(String(r.atualizado_em).slice(0, 10), hojeISO()) > 2;
  const ROT_FLUXO = { pre: "Pré-entrega", pos: "Pós-entrega" };
  const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1).replace(".", ",") + "%" : "–");
  const mediana = (L) => { if (!L.length) return null; const s = L.slice().sort((a, b) => a - b), k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
  const dia1 = (n) => (n == null ? "–" : n.toFixed(1).replace(".", ","));
  // transportadora Promob (razão social) → nome da lista de apelidos (Alterar pedidos › Transportadora divergente)
  const promobNome = (nome) => {
    if (!nome) return null;
    const x = ajLista.filter((a) => ajTem(a.chave, nome)).sort((a, b) => b.chave.length - a.chave.length)[0];
    return x ? x.h : nome + " (sem apelido)";
  };

  async function carregarReposicoes() {
    try {
      const [lista, inf] = await Promise.all([buscarTudo("reposicoes_tk", "ticket"), sb.from("reposicoes_tk_info").select("*").limit(1)]);
      if (inf.error) throw inf.error;
      reps = lista.filter((r) => (r._t = tipoRep(r))); repInfo = (inf.data && inf.data[0]) || null; repOk = true;
    } catch (_) { repOk = false; reps = []; repInfo = null; }
    try {
      const [at, env] = await Promise.all([buscarTudo("repo_atual", "ticket"), sb.from("repo_envios").select("id,arquivo,extraido_em,enviado_em,tickets").order("id", { ascending: false }).limit(1)]);
      if (env.error) throw env.error;
      repAtual = new Map(at.map((x) => [String(x.ticket), x])); repEnvio = (env.data && env.data[0]) || null; repHistOk = true;
    } catch (_) { repHistOk = false; repAtual = new Map(); repEnvio = null; }
    try {   // itens/volumes lidos pelo robô no Multi360 (parte 48)
      const [tk, it, cad] = await Promise.all([buscarTudo("repo_itens_tk", "ticket"), buscarTudo("repo_itens", "ticket,codigo"), buscarTudo("volumes_cad", "codigo", "codigo,descricao")]);
      repItTk = new Map(tk.map((x) => [String(x.ticket), x])); repItens = new Map(); it.forEach((x) => { const k = String(x.ticket); (repItens.get(k) || repItens.set(k, []).get(k)).push(x.codigo); });
      volCad = new Map(cad.map((x) => [x.codigo, x.descricao])); repItOk = true;
    } catch (_) { repItOk = false; repItTk = new Map(); repItens = new Map(); volCad = new Map(); }
    if (!ajCarregado) await carregarApelidos().catch(() => {});
    reps.forEach((r) => { r._d = repAtual.get(String(r.ticket)) || null; r._promob = r._d ? promobNome(r._d.transp_promob) : null;
      r._it = repItTk.get(String(r.ticket)) || null; r._cods = repItens.get(String(r.ticket)) || []; });
    montarReposicao();
  }
  function opcoesRep(id, valores, todos, rot = (v) => v) {
    const sel = $(id);
    if (sel.multiple) {   // várias escolhas (filtros do topo da Reposição): mantém as marcadas que ainda existem
      const atuais = new Set([...sel.selectedOptions].map((o) => o.value));
      sel.innerHTML = valores.map((v) => `<option value="${esc(v)}"${atuais.has(v) ? " selected" : ""}>${esc(rot(v))}</option>`).join(""); return;
    }
    const atual = sel.value;
    sel.innerHTML = `<option value="">${todos}</option>` + valores.map((v) => `<option value="${esc(v)}">${esc(rot(v))}</option>`).join("");
    sel.value = valores.includes(atual) ? atual : "";
  }
  function montarReposicao() {
    const fd = (iso) => new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
    $("rep-info").innerHTML = !repOk ? "Para usar esta página, rode de novo o supabase/schema.sql no Supabase."
      : (repInfo ? `Tabela: ${esc(repInfo.arquivo || "planilha")} enviada em ${fd(repInfo.enviado_em)} · ${fmt(reps.length)} reposições`
        : 'Ainda não há tabela. Clique em "Subir tabela de acompanhamento".')
      + (!repHistOk ? " · <b>Histórico do detalhamento: rode a parte 36 do schema.sql.</b>"
        : repEnvio ? ` · Detalhamento: ${fmt(repAtual.size)} tickets no histórico, último extraído em ${fd(repEnvio.extraido_em)}` : " · Detalhamento: ainda sem histórico (suba o detalhamento em Carregar tickets).");
    const pt = (a, b) => a.localeCompare(b, "pt-BR");
    const meses = [...new Set(reps.map(mesRep).filter(Boolean))].sort().reverse();
    opcoesRep("rep-ano", [...new Set(meses.map((m) => m.slice(0, 4)))], "Todos");
    opcoesRep("rep-mes", meses, "Todos", rotMes);
    opcoesRep("rep-transp", [...new Set(reps.map(trRep))].sort(pt), "Todas");
    opcoesRep("rep-motivo", [...new Set(reps.map(motRep))].sort(pt), "Todos");
    opcoesRep("rep-filial", [...new Set(reps.map(filRep))].sort(pt), "Todas");
    opcoesRep("rep-status", [...new Set(reps.map((r) => r.status || "(sem status)"))].sort(pt), "Todos");
    opcoesRep("rep-resp", [...new Set(reps.map(respRep))].sort(pt), "Todos");
    opcoesRep("rep-serie", [...new Set(reps.map(serieRep))].sort((x, y) => (Number(x) || 1e9) - (Number(y) || 1e9) || pt(x, y)), "Todas", (s) => (s === SEM_SERIE ? s : "Série " + s));
    filtrarRep();
  }
  // filtros do topo; "sem" = filtros que essa análise ignora
  function filtroRep(sem = []) {
    const v = (id) => (sem.includes(id) ? "" : $(id).value);
    const m = (id) => (sem.includes(id) ? null : (($(id).selectedOptions.length && new Set([...$(id).selectedOptions].map((o) => o.value).filter(Boolean))) || null));   // várias escolhas
    const ok = (s, x) => !s || !s.size || s.has(x);
    const ano = m("rep-ano"), mes = m("rep-mes"), de = v("rep-de"), ate = v("rep-ate"), tipo = v("rep-tipo"), tr = m("rep-transp"), mot = m("rep-motivo"),
      fil = m("rep-filial"), st = m("rep-status"), resp = m("rep-resp"), se = m("rep-serie");
    return reps.filter((r) => {
      const d = String(r.criado_em || "").slice(0, 10);
      return ok(ano, d.slice(0, 4)) && ok(mes, d.slice(0, 7)) && (!de || (d && d >= de)) && (!ate || (d && d <= ate)) &&
        (!tipo || r._t === tipo) && ok(tr, trRep(r)) && ok(mot, motRep(r)) && ok(fil, filRep(r)) &&
        ok(st, r.status || "(sem status)") && ok(resp, respRep(r)) && ok(se, serieRep(r));
    });
  }
  const contaPor = (lista, chave) => { const m = new Map(); lista.forEach((r) => { const k = chave(r); m.set(k, (m.get(k) || []).concat(r)); }); return [...m.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], "pt-BR")); };
  const num = (n) => `<td class="num${n ? "" : " vazio-c"}">${n ? fmt(n) : "·"}</td>`;
  const kpi = (rot, n, sub, cor = "", extra = "") => `<div class="kpi kpi-info ${cor}"><span class="kpi-rot">${rot}</span><b class="kpi-num">${n}</b><small>${sub}</small>${extra}</div>`;
  // card clicável: abre os tickets dele no Detalhamento (e dá para exportar de lá)
  const kpiC = (card, rot, n, sub, cor = "") => `<button type="button" class="kpi kpi-info kpi-clic ${cor}" data-card="${card}" title="Clique para ver os tickets e exportar"><span class="kpi-rot">${rot}</span><b class="kpi-num">${n}</b><small>${sub}</small><i>↗</i></button>`;
  const ROT_CARD = { todos: "Todas as reposições", pre: "Pré-entrega", pos: "Pós-entrega", ab: "Em aberto", fin: "Finalizados (Resolvido/Encerrado)", rec: "Pendente Recuperação de crédito", total: "Reposição total", parcial: "Reposição parcial", comdet: "Com detalhamento", nfs: "Com nova NF emitida", saida: "Nova NF com saída", tempo: "Finalizados (com tempo de resolução)" };
  let repCard = "", repFaixa = -1;
  const kpiGarg = (L) => { const g = gargalos(L)[0]; return kpiC("garg", "Gargalos por fila", g ? esc(g.fila) : "–", g ? `maior gargalo · ${fmt(g.n)} casos, média ${dia1(g.media)} dias parados` : "nenhum caso em aberto", "laranja kpi-garg"); };
  // quadro "em aberto por fila": só aparece ao clicar no card Em aberto; filtros próprios (série, fila, responsável)
  let pvAberto = false; const pv = { serie: "", fila: "", resp: "", grupo: "" }; let pvDet = null;
  const casaPv = (r, f) => (!f.serie || serieRep(r) === f.serie) && (!f.fila || (filaRep(r) || SEM_FILA) === f.fila) && (!f.resp || respRep(r) === f.resp) && (!f.grupo || grupoRep(r) === f.grupo) && (!f.grupos || !f.grupos.length || f.grupos.includes(grupoRep(r)));
  function casaCard(r) {
    const d = r._d || {};
    switch (repCard) {
      case "pre": case "pos": return r._t === repCard;
      case "ab": case "fin": case "rec": return sitRep(r) === repCard;
      case "tempo": return sitRep(r) === "fin";
      case "total": return tpRep(r) === "TOTAL";
      case "parcial": return tpRep(r) === "PARCIAL";
      case "comdet": return !!r._d;
      case "nfs": return !!d.nfs_novas;
      case "saida": return !!d.data_saida_nf;
      default: return true;
    }
  }
  const clic = (f, v, txt) => `<a href="#" class="rp-ir" data-f="${f}" data-v="${esc(v)}">${esc(txt)}</a>`;

  function filtrarRep() {
    document.querySelectorAll("#rep-abas [data-ra]").forEach((b) => { b.classList.toggle("amarelo", b.dataset.ra === repAba); b.classList.toggle("contorno", b.dataset.ra !== repAba); });
    $("rp-geral").hidden = repAba !== "geral"; $("rp-fluxo").hidden = !["pre", "pos"].includes(repAba); $("rp-det").hidden = repAba !== "det";
    const fl = repAba === "pre" || repAba === "pos";
    repFiltradas = filtroRep(fl ? ["rep-tipo"] : []).filter((r) => !fl || r._t === repAba);
    if (repAba === "det" && repCard) repFiltradas = repFiltradas.filter(casaCard);
    if (repAba === "det" && pvDet) repFiltradas = repFiltradas.filter((r) => casaPv(r, pvDet));
    if (repAba === "det" && repFaixa >= 0) repFiltradas = repFiltradas.filter((r) => abertoRep(r) && faixaFila(diasFila(r)) === repFaixa);
    $("rep-vazio").hidden = repFiltradas.length > 0 || repAba === "det";
    if (repAba === "geral") desenharRepGeral(); else if (fl) desenharRepFluxo(repAba); else desenharRepDet();
  }

  function evolucaoMeses(lista, tipo) {
    const m = new Map(); lista.forEach((r) => { const k = mesRep(r), x = m.get(k) || { pre: 0, pos: 0, ab: 0 }; x[r._t]++; if (abertoRep(r)) x.ab++; m.set(k, x); });
    return [...m.keys()].sort().map((k) => ({ mes: k, ...m.get(k), tot: tipo ? m.get(k)[tipo] : m.get(k).pre + m.get(k).pos }));
  }
  const varia = (tot, ant) => { if (!ant) return `<td class="num vazio-c">·</td>`; const p = Math.round(((tot - ant) / ant) * 100);
    return `<td class="num"><span class="rp-var ${p > 0 ? "sobe" : p < 0 ? "desce" : ""}">${p > 0 ? "▲ +" : p < 0 ? "▼ " : ""}${p}%</span></td>`; };

  // quadro de gargalos (card próprio "Gargalos por fila"): por fila, quantos casos e há quantos dias estão parados
  let gargAberto = false; const gf = { grupo: [], fila: [] };   // várias escolhas let gargCasos = [];
  const casaGf = (r) => (!gf.grupo.length || gf.grupo.includes(grupoRep(r))) && (!gf.fila.length || gf.fila.includes(filaRep(r) || SEM_FILA));
  function gargalos(L, comFiltro) {
    const ab = L.filter((r) => abertoRep(r) && (!comFiltro || casaGf(r)));
    return contaPor(ab, (r) => filaRep(r) || SEM_FILA).map(([fila, rs]) => { const d = rs.map(diasFila).filter((n) => n != null);
      const soma = d.reduce((x, y) => x + y, 0); const grs = contaPor(rs, grupoRep).map((x) => x[0]);
      return { fila, grupo: grs.join(", "), n: rs.length, media: d.length ? soma / d.length : 0, max: d.length ? Math.max(...d) : 0, mais10: d.filter((x) => x >= 10).length, soma }; })
      .sort((x, y) => y.soma - x.soma || y.n - x.n);
  }
  function desenharGargalos(caixa, L) {
    const gbox = $(caixa); gbox.hidden = !gargAberto;
    // com Gargalos ou Em aberto abertos, a página mostra só os cards e esses quadros (os outros somem até fechar o card)
    [...gbox.parentElement.children].forEach((el) => { if (el === gbox || el.classList.contains("kpis") || el.id === "rpf-parados-q" || el.id === "rpg-parados" || el.classList.contains("rp-vol-box")) return;
      if (gargAberto || pvAberto || volAberto) { if (!el.hidden) { el.hidden = true; el.dataset.gargEsc = "1"; } } else if (el.dataset.gargEsc) { el.hidden = false; delete el.dataset.gargEsc; } });
    document.querySelectorAll('#rpg-cards [data-card="garg"], #rpf-cards [data-card="garg"]').forEach((k) => k.classList.toggle("ativa", gargAberto));
    if (!gargAberto) return;
    const ab0 = L.filter(abertoRep), pt = (x, y) => x.localeCompare(y, "pt-BR");
    const ops = { grupo: [...new Set(ab0.map(grupoRep))].sort(pt), fila: [...new Set(ab0.filter((r) => !gf.grupo.length || gf.grupo.includes(grupoRep(r))).map((r) => filaRep(r) || SEM_FILA))].sort(pt) };
    gbox.querySelectorAll(".garg-sel").forEach((s) => { const k = s.dataset.gf; gf[k].forEach((v) => { if (!ops[k].includes(v)) ops[k].unshift(v); });
      s.innerHTML = ops[k].map((v) => `<option value="${esc(v)}"${gf[k].includes(v) ? " selected" : ""}>${esc(v)}</option>`).join(""); });
    gargCasos = ab0.filter(casaGf);
    const gs = gargalos(L, true);
    const gmax = Math.max(1, ...gs.map((g) => g.soma));
    gbox.querySelector(".rp-garg-corpo").innerHTML = gs.map((g) => `<tr class="rp-garg-l" data-pfila="${esc(g.fila)}" title="Ver os tickets desta fila"><td><a href="#">${esc(g.fila)}</a></td><td class="s">${esc(g.grupo)}</td><td class="num tot">${fmt(g.n)}</td>
      <td class="num"><b class="${g.media >= 20 ? "txt-vermelho" : g.media >= 10 ? "txt-laranja" : ""}">${dia1(g.media)}</b></td><td class="num">${fmt(g.max)}</td>${num(g.mais10)}
      <td class="rp-col-barra"><div class="rp-barra rp-barra-garg"><span class="${g.media >= 20 ? "alto" : g.media >= 10 ? "medio" : "baixo"}" style="width:${(g.soma / gmax) * 100}%"></span></div><span class="s">${fmt(g.soma)} dias</span></td></tr>`).join("")
      || `<tr><td colspan="7" class="vazio">Nenhum caso em aberto nesse filtro.</td></tr>`;
  }

  // quadro "Em aberto por fila × dias parados na fila", agrupado por responsável (como a dinâmica da Brenda)
  function desenharParados(caixa, L) {
    const box = $(caixa); box.hidden = !pvAberto;
    document.querySelectorAll('#rpg-cards [data-card="ab"], #rpf-cards [data-card="ab"]').forEach((k) => k.classList.toggle("ativa", pvAberto));
    if (!pvAberto) return;
    const ab0 = L.filter(abertoRep), pt = (x, y) => x.localeCompare(y, "pt-BR");
    const ops = { serie: [...new Set(ab0.map(serieRep))].sort((x, y) => (Number(x) || 1e9) - (Number(y) || 1e9) || pt(x, y)), fila: [...new Set(ab0.map((r) => filaRep(r) || SEM_FILA))].sort(pt), resp: [...new Set(ab0.map(respRep))].sort(pt), grupo: [...new Set(ab0.map(grupoRep))].sort(pt) };
    box.querySelectorAll(".pv-sel").forEach((s) => { const k = s.dataset.pv; if (pv[k] && !ops[k].includes(pv[k])) ops[k].unshift(pv[k]);
      s.innerHTML = `<option value="">${k === "fila" ? "Todas" : "Todos"}</option>` + ops[k].map((v) => `<option value="${esc(v)}">${esc(k === "serie" && v !== SEM_SERIE ? "Série " + v : v)}</option>`).join(""); s.value = pv[k]; });
    const ab = ab0.filter((r) => casaPv(r, pv));
    const cel = (n, resp, fila, fx, cls = "") => n ? `<td class="num ${cls}"><a href="#" data-pfila="${esc(fila)}"${resp != null ? ` data-pgrupo="${esc(resp)}"` : ""}${fx >= 0 ? ` data-pfx="${fx}"` : ""}>${fmt(n)}</a></td>` : `<td class="num vazio-c ${cls}">·</td>`;
    const conta = (rs) => { const v = FAIXAS_FILA.map(() => 0); rs.forEach((r) => { const i = faixaFila(diasFila(r)); if (i >= 0) v[i]++; }); return v; };
    box.querySelector(".rp-pivo-cab").innerHTML = `<tr><th>Grupo / Fila</th>${FAIXAS_FILA.map(([t]) => `<th class="num">${t}</th>`).join("")}<th class="num">Total</th></tr>`;
    let h = "";
    for (const [resp, rs] of contaPor(ab, grupoRep)) {
      const v = conta(rs);
      h += `<tr class="rp-grupo"><td>${esc(resp)}</td>${v.map((n, i) => cel(n, resp, "*", i)).join("")}${cel(rs.length, resp, "*", -1, "tot")}</tr>`;
      for (const [fila, fs] of contaPor(rs, (r) => filaRep(r) || SEM_FILA)) {
        const w = conta(fs);
        h += `<tr class="rp-sub"><td>${esc(fila)}</td>${w.map((n, i) => cel(n, resp, fila, i)).join("")}${cel(fs.length, resp, fila, -1, "tot")}</tr>`;
      }
    }
    const t = conta(ab);
    h += ab.length ? `<tr class="rp-total"><td>Total geral</td>${t.map((n, i) => cel(n, null, "*", i)).join("")}${cel(ab.length, null, "*", -1, "tot")}</tr>` : `<tr><td colspan="${FAIXAS_FILA.length + 2}" class="vazio">Nenhum caso em aberto nesse filtro.</td></tr>`;
    box.querySelector(".rp-pivo-corpo").innerHTML = h;
    const viu = ab.filter((r) => r._d && norm(r._d.fila_atual) === norm(filaRep(r)) && r._d.ultima_mudanca_em > r._d.primeiro_envio_em).length;
    box.querySelector(".rp-parados-sub").textContent = `${fmt(ab.length)} casos em aberto (sem Recuperação de crédito). Dias na fila: desde que o ticket mudou de fila no detalhamento (${fmt(viu)} casos); nos outros, desde a Data da Última Atualização do ticket. Clique num número para ver os tickets e exportar.` + (ab0.length && ab0.every((r) => !r.grupo) ? " Para separar por grupo (Logística, Sac, Faturamento, Projetos), rode a parte 47 no Supabase e suba a tabela de acompanhamento de novo." : "");
  }

  function desenharRepGeral() {
    const L = repFiltradas, pre = L.filter((r) => r._t === "pre").length, pos = L.length - pre, ab = L.filter(abertoRep).length;
    const fin = L.filter((r) => sitRep(r) === "fin").length, rec = L.filter((r) => sitRep(r) === "rec").length;
    // Parcial/Total: o que o robô leu em Eventos no Multi360 vale primeiro; senão o detalhamento
    const tot = L.filter((r) => tpRep(r) === "TOTAL").length, par = L.filter((r) => tpRep(r) === "PARCIAL").length, semTp = L.length - tot - par;
    $("rpg-cards").innerHTML = kpiC("todos", "Reposições", fmt(L.length), "tickets (pré + pós)")
      + kpiC("pre", "Pré-entrega", fmt(pre), pct(pre, L.length) + " do total", "laranja")
      + kpiC("pos", "Pós-entrega", fmt(pos), pct(pos, L.length) + " do total", "azul")
      + kpiC("ab", "Em aberto", fmt(ab), pct(ab, L.length) + " do total", "vermelho")
      + kpiC("fin", "Finalizados", fmt(fin), `Resolvido ou Encerrado · ${pct(fin, L.length)}`)
      + kpiGarg(L)
      + kpiC("rec", "Recup. de crédito", fmt(rec), "pendente, fora de reposição", "roxo")
      + kpiC("comdet", "Totais × parciais", tot + par ? `${fmt(tot)} × ${fmt(par)}` : "–", semTp ? `${fmt(semTp)} ainda sem a informação (o robô lê em Eventos)` : "de todos os tickets do filtro");
    const ev = evolucaoMeses(filtroRep(["rep-mes"]), $("rep-tipo").value), maior = Math.max(1, ...ev.map((x) => x.tot)), mesSel = new Set([...$("rep-mes").selectedOptions].map((o) => o.value)), tipo = $("rep-tipo").value;
    $("rep-ev-titulo").textContent = `Evolução mensal · ${tipo ? ROT_FLUXO[tipo].toLowerCase() : "pré-entrega × pós-entrega"}`;
    $("rep-meses").innerHTML = ev.map((x, i) => `<tr data-f="rep-mes" data-v="${esc(x.mes)}" class="${mesSel.has(x.mes) ? "sel" : ""}"><td>${esc(rotMes(x.mes))}</td>${num(tipo === "pos" ? 0 : x.pre)}${num(tipo === "pre" ? 0 : x.pos)}<td class="num tot">${fmt(x.tot)}</td>${varia(x.tot, i ? ev[i - 1].tot : 0)}`
      + `<td class="rp-col-barra"><div class="rp-barra"><span class="pre" style="width:${tipo === "pos" ? 0 : (x.pre / maior) * 100}%"></span><span class="pos" style="width:${tipo === "pre" ? 0 : (x.pos / maior) * 100}%"></span></div></td></tr>`).reverse().join("");
    const linhaPP = (f, [k, rs]) => { const p = rs.filter((r) => r._t === "pre").length; return `<tr data-f="${f}" data-v="${esc(k)}"><td>${esc(k)}</td>${num(p)}${num(rs.length - p)}<td class="num tot">${fmt(rs.length)}</td><td class="num">${pct(rs.length, L.length)}</td></tr>`; };
    desenharParados("rpg-parados", L); desenharGargalos("rpg-garg", L); desenharVolumes("rpg-vol", L);
    $("rpg-transps").innerHTML = contaPor(L, trRep).map((e) => linhaPP("rep-transp", e)).join("");
    $("rpg-motivos").innerHTML = contaPor(L, motRep).map((e) => linhaPP("rep-motivo", e)).join("");
  }

  function desenharRepFluxo(tipo) {
    const L = repFiltradas, ab = L.filter(abertoRep), res = L.filter((r) => sitRep(r) === "fin");
    const comDet = L.filter((r) => r._d), tr = L.filter((r) => tpRep(r)), tot = tr.filter((r) => tpRep(r) === "TOTAL").length;
    const nfs = comDet.filter((r) => r._d.nfs_novas).length, sai = comDet.filter((r) => r._d.data_saida_nf).length;
    const tRes = res.map((r) => Number(r.tempo_resolucao)).filter((n) => Number.isFinite(n) && n >= 0);
    const recN = L.filter((r) => sitRep(r) === "rec").length, finN = L.filter((r) => sitRep(r) === "fin").length;
    $("rpf-cards").innerHTML = kpiC(tipo, `Reposições · ${ROT_FLUXO[tipo]}`, fmt(L.length), "tickets no filtro", tipo === "pre" ? "laranja" : "azul")
      + kpiC("ab", "Em aberto", fmt(ab.length), pct(ab.length, L.length) + " do total", "vermelho")
      + kpiC("fin", "Finalizados", fmt(finN), `Resolvido ou Encerrado · ${pct(finN, L.length)}`)
      + kpiGarg(L)
      + kpiC("rec", "Recup. de crédito", fmt(recN), "pendente, fora de reposição", "roxo")
      + kpiC("tempo", "Tempo de resolução", tRes.length ? dia1(mediana(tRes)) + " dias" : "–", tRes.length ? `mediana de ${fmt(tRes.length)} resolvidos (média ${dia1(tRes.reduce((a, b) => a + b, 0) / tRes.length)})` : "sem resolvidos no filtro")
      + kpiC("total", "Totais", tr.length ? fmt(tot) : "–", tr.length < L.length ? `${fmt(L.length - tr.length)} ainda sem a informação` : `de ${fmt(L.length)} tickets`)
      + kpiC("parcial", "Parciais", tr.length ? fmt(tr.length - tot) : "–", tr.length < L.length ? `${fmt(L.length - tr.length)} ainda sem a informação` : `de ${fmt(L.length)} tickets`)
      + kpiC("nfs", "Novas NFs emitidas", fmt(nfs), `de ${fmt(comDet.length)} tickets com detalhamento`)
      + kpiC("saida", "Novas NFs com saída", fmt(sai), `de ${fmt(comDet.length)} tickets com detalhamento`);
    desenharParados("rpf-parados-q", L); desenharGargalos("rpf-garg", L); desenharVolumes("rpf-vol", L);
    $("rpf-nota").textContent = comDet.length < L.length
      ? `Nova NF, total/parcial, tempos e transportadora Promob só existem para os ${fmt(comDet.length)} de ${fmt(L.length)} tickets que já apareceram no detalhamento Tickets360 (o detalhamento traz só os abertos; o histórico cresce a cada envio).` : "";
    // evolução (sem o filtro de mês)
    const ev = evolucaoMeses(filtroRep(["rep-tipo", "rep-mes"]).filter((r) => r._t === tipo), tipo), maior = Math.max(1, ...ev.map((x) => x.tot)), mesSel = new Set([...$("rep-mes").selectedOptions].map((o) => o.value));
    $("rpf-meses").innerHTML = ev.map((x, i) => `<tr data-f="rep-mes" data-v="${esc(x.mes)}" class="${mesSel.has(x.mes) ? "sel" : ""}"><td>${esc(rotMes(x.mes))}</td><td class="num tot">${fmt(x.tot)}</td>${varia(x.tot, i ? ev[i - 1].tot : 0)}${num(x.ab)}`
      + `<td class="rp-col-barra"><div class="rp-barra"><span class="${tipo}" style="width:${(x.tot / maior) * 100}%"></span></div></td></tr>`).reverse().join("");
    // aging
    const FX = [["0 a 5 dias", 0, 5], ["6 a 10 dias", 6, 10], ["11 a 20 dias", 11, 20], ["21 a 30 dias", 21, 30], ["Acima de 30 dias", 31, 1e9]];
    const fx = FX.map(([rot, a, b]) => [rot, ab.filter((r) => { const d = diasAberto(r); return d != null && d >= a && d <= b; }).length]), mx = Math.max(1, ...fx.map((x) => x[1]));
    $("rpf-aging").innerHTML = fx.map(([rot, n]) => `<tr><td>${rot}</td>${num(n)}<td class="num">${pct(n, ab.length)}</td><td class="rp-col-barra"><div class="rp-barra"><span class="${tipo}" style="width:${(n / mx) * 100}%"></span></div></td></tr>`).join("");
    $("rpf-parados").textContent = ab.length ? `${fmt(ab.filter(semAtualiz).length)} dos ${fmt(ab.length)} abertos estão sem atualização há mais de 2 dias (Data da Última Atualização).` : "";
    // rankings
    $("rpf-transps").innerHTML = contaPor(L, trRep).map(([k, rs]) => { const t = rs.filter((r) => !abertoRep(r)).map((r) => Number(r.tempo_resolucao)).filter(Number.isFinite);
      return `<tr data-f="rep-transp" data-v="${esc(k)}"><td>${esc(k)}</td><td class="num tot">${fmt(rs.length)}</td><td class="num">${pct(rs.length, L.length)}</td>${num(rs.filter(abertoRep).length)}<td class="num">${t.length ? dia1(mediana(t)) : "–"}</td></tr>`; }).join("");
    $("rpf-motivos").innerHTML = contaPor(L, motRep).map(([k, rs]) => `<tr data-f="rep-motivo" data-v="${esc(k)}"><td>${esc(k)}</td><td class="num tot">${fmt(rs.length)}</td><td class="num">${pct(rs.length, L.length)}</td>${num(rs.filter(abertoRep).length)}</tr>`).join("");
    $("rpf-filial").innerHTML = contaPor(L, filRep).map(([k, rs]) => `<tr data-f="rep-filial" data-v="${esc(k)}"><td>${esc(k)}</td><td class="num tot">${fmt(rs.length)}</td><td class="num">${pct(rs.length, L.length)}</td>${num(rs.filter(abertoRep).length)}</tr>`).join("");
    // matriz transportadora × motivo
    const trs = contaPor(L, trRep).slice(0, 12), mots = contaPor(L, motRep).slice(0, 6).map((x) => x[0]);
    const mxm = Math.max(1, ...trs.flatMap(([, rs]) => mots.map((m) => rs.filter((r) => motRep(r) === m).length)));
    $("rpf-matriz-cab").innerHTML = `<tr><th>Transportadora</th>${mots.map((m) => `<th class="num">${esc(m)}</th>`).join("")}<th class="num">Total</th></tr>`;
    $("rpf-matriz").innerHTML = trs.map(([t, rs]) => `<tr><td><a href="#" class="rp-ir" data-f="rep-transp" data-v="${esc(t)}">${esc(t)}</a></td>${mots.map((m) => { const n = rs.filter((r) => motRep(r) === m).length;
      return `<td class="num rp-calor" style="--a:${n ? (0.12 + 0.75 * n / mxm).toFixed(2) : 0}">${n ? fmt(n) : "·"}</td>`; }).join("")}<td class="num tot">${fmt(rs.length)}</td></tr>`).join("");
    // tempos da nova NF
    const dd = (a, b) => (a && b ? diasEntre(String(a).slice(0, 10), String(b).slice(0, 10)) : null);
    const T = [["Abertura → emissão da nova NF", (r) => dd(r.criado_em, r._d && r._d.data_emissao_nf)], ["Emissão → saída da nova NF", (r) => r._d && dd(r._d.data_emissao_nf, r._d.data_saida_nf)], ["Abertura → saída da nova NF", (r) => dd(r.criado_em, r._d && r._d.data_saida_nf)]];
    $("rpf-tempos").innerHTML = T.map(([rot, f]) => { const v = comDet.map(f).filter((n) => n != null), ok = v.filter((n) => n >= 0), ruim = v.length - ok.length;
      return `<tr><td>${rot}</td>${num(ok.length)}<td class="num">${ok.length ? dia1(ok.reduce((a, b) => a + b, 0) / ok.length) : "–"}</td><td class="num">${ok.length ? dia1(mediana(ok)) : "–"}</td>${num(ruim)}</tr>`; }).join("");
    $("rpf-promob").innerHTML = contaPor(comDet.filter((r) => r._promob), (r) => r._promob).map(([k, rs]) => `<tr><td>${esc(k)}</td><td class="num tot">${fmt(rs.length)}</td>${num(rs.filter((r) => r._d.nfs_novas).length)}${num(rs.filter((r) => r._d.data_saida_nf).length)}</tr>`).join("")
      || `<tr><td colspan="4" class="s">Nenhum ticket desse filtro com transportadora Promob no detalhamento.</td></tr>`;
    // pendências
    const pend = (chave, f) => contaPor(ab, chave).map(([k, rs]) => `<tr data-f="${f}" data-v="${esc(k)}"><td>${esc(k)}</td><td class="num tot">${fmt(rs.length)}</td>${num(rs.filter((r) => diasAberto(r) > 30).length)}${num(rs.filter(semAtualiz).length)}</tr>`).join("");
    $("rpf-pend-tr").innerHTML = pend(trRep, "rep-transp"); $("rpf-pend-resp").innerHTML = pend(respRep, "rep-resp");
    $("rpf-antigos").innerHTML = ab.slice().sort((a, b) => diasAberto(b) - diasAberto(a)).slice(0, 10).map((r) => `<tr><td>${linkTicket(r.ticket)}</td><td>${esc(trRep(r))}</td><td>${esc((r._d && r._d.fila_atual) || "–")}</td><td class="num tot">${fmt(diasAberto(r))}</td></tr>`).join("");
  }

  function linhaDet(r) {
    const d = r._d || {}, ab = abertoRep(r);
    const nova = d.nfs_novas ? esc(d.nfs_novas) : d.fila_atual ? `<span class="s">Sem NF ainda: está na fila ${esc(d.fila_atual)}</span>` : `<span class="s">${r._d ? "Sem NF" : "não está no detalhamento"}</span>`;
    return `<tr><td>${linkTicket(r.ticket)}</td><td>${esc(r.nf || "")}</td><td>${nova}</td><td>${esc(r.pedido || "")}</td><td>${ROT_FLUXO[r._t]}</td><td>${esc(tpRep(r) ? tpRep(r)[0] + tpRep(r).slice(1).toLowerCase() : "")}</td>
      <td>${esc(r.transportadora || "")}</td><td>${esc(r._promob || "")}</td><td>${esc(r.motivo || "")}</td><td>${esc(r.filial || "")}</td><td>${esc(r.responsavel || "")}</td>
      <td>${br(r.criado_em)}</td><td>${br(d.data_emissao_nf)}</td><td>${br(d.data_saida_nf)}</td><td>${esc(r.status || "")}${sitRep(r) === "rec" ? `<div class="s txt-roxo">Pendente Recuperação de crédito</div>` : ""}</td><td>${esc(filaRep(r))}</td><td class="num">${ab ? fmt(diasAberto(r)) : ""}</td><td class="num">${ab && diasFila(r) != null ? fmt(diasFila(r)) : ""}</td><td>${br(r.finalizado_em)}</td>
      <td class="num">${r.valor_pedido != null ? Number(r.valor_pedido).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : ""}</td></tr>`;
  }
  function detFiltradas() {
    const q = norm($("rpd-busca").value).split(/[\s,;]+/).filter(Boolean);
    return !q.length ? repFiltradas : repFiltradas.filter((r) => q.some((b) => [r.ticket, r.nf, r.pedido, r._d && r._d.nfs_novas].some((v) => norm(v).includes(b))));
  }
  function desenharRepDet() {
    const L = detFiltradas().slice().sort((a, b) => String(b.criado_em || "").localeCompare(String(a.criado_em || ""))), POR = 100, pags = Math.max(1, Math.ceil(L.length / POR));
    rpdPag = Math.min(rpdPag, pags);
    $("rpd-titulo").innerHTML = `${fmt(L.length)} tickets` + (repCard ? ` <button type="button" class="chip amarelo rp-card-x" title="Tirar o filtro do card">${esc(ROT_CARD[repCard] || repCard)} ✕</button>` : "")
      + (repFaixa >= 0 ? ` <button type="button" class="chip amarelo rp-card-x" title="Tirar o filtro de dias">Parados na fila: ${esc(FAIXAS_FILA[repFaixa][0])} ✕</button>` : "")
      + (pvDet ? [pvDet.serie && "Série " + pvDet.serie, pvDet.grupo && "Grupo " + pvDet.grupo, pvDet.grupos && pvDet.grupos.length && "Grupo " + pvDet.grupos.join(", "), pvDet.fila, pvDet.resp].filter(Boolean).map((t) => ` <button type="button" class="chip amarelo rp-card-x">${esc(t)} ✕</button>`).join("") : "");
    $("rpd-linhas").innerHTML = L.slice((rpdPag - 1) * POR, rpdPag * POR).map(linhaDet).join("") || `<tr><td colspan="20" class="vazio">Nenhum ticket nesse filtro.</td></tr>`;
    $("rpd-pag").innerHTML = L.length > POR ? `<button class="btn" data-p="-1" ${rpdPag === 1 ? "disabled" : ""}>‹ Anterior</button><span>Página ${rpdPag} de ${pags}</span><button class="btn" data-p="1" ${rpdPag === pags ? "disabled" : ""}>Próxima ›</button>` : "";
  }

  // ---------- volumes enviados na reposição (card Totais × parciais): robô lê o Multi360 em Aguardando entrega (parte 48) ----------
  let repItTk = new Map(), repItens = new Map(), volCad = new Map(), repItOk = false, volAberto = false, volTipo = "", volCasos = [];
  const ehAgEnt = (r) => /AGUARDANDO ENTREGA/.test(norm(filaRep(r)));
  const tpRep = (r) => { const t = norm((r._it && r._it.parcial) || (r._d && r._d.tipo_reposicao) || ""); return /PARCIAL/.test(t) ? "PARCIAL" : /TOTAL/.test(t) ? "TOTAL" : ""; };
  const descVol = (c) => volCad.get(c) || "(sem cadastro)";
  const cobRep = (r) => !r._it || r._t !== "pre" ? "" : r._it.cobrado_transp ? "Cobrado: " + r._it.cobrado_transp : r._it.dest_doc === "cpf" ? "Sem cobrança (CPF do cliente)" : r._it.pdf_ok ? "Sem cobrança (outro CNPJ)" : "Nota não lida";
  function desenharVolumes(caixa, L) {
    const box = $(caixa); if (!box) return; box.hidden = !volAberto;
    document.querySelectorAll('#rpg-cards [data-card="comdet"], #rpf-cards [data-card="total"], #rpf-cards [data-card="parcial"]').forEach((k) => k.classList.toggle("ativa", volAberto && (k.dataset.card === "comdet" ? !volTipo : k.dataset.card.toUpperCase() === volTipo)));
    if (!volAberto) return;
    const base = L.filter((r) => !volTipo || tpRep(r) === volTipo);
    const ag = base.filter((r) => ehAgEnt(r) && r._d && r._d.nfs_novas), lidos = ag.filter((r) => r._it && r._it.eventos_ok), naoLidos = ag.length - lidos.length;
    const proc = base.filter((r) => abertoRep(r) && !ehAgEnt(r));
    volCasos = lidos;
    // volumes mais enviados
    const m = new Map();
    lidos.forEach((r) => r._cods.forEach((c) => { const x = m.get(c) || { c, n: 0, tot: 0, par: 0, pre: 0, pos: 0, mot: new Map() }; x.n++; tpRep(r) === "TOTAL" ? x.tot++ : x.par++; x[r._t]++; x.mot.set(motRep(r), (x.mot.get(motRep(r)) || 0) + 1); m.set(c, x); }));
    const vs = [...m.values()].sort((a, b) => b.n - a.n || a.c.localeCompare(b.c));
    const topMot = (mp) => [...mp.entries()].sort((a, b) => b[1] - a[1])[0] || ["", 0];
    // por motivo
    const pm = contaPor(lidos, motRep).map(([mot, rs]) => { const cc = new Map(); rs.forEach((r) => r._cods.forEach((c) => cc.set(c, (cc.get(c) || 0) + 1)));
      const tv = topMot(cc); return { mot, n: rs.length, vols: rs.reduce((a, r) => a + (Number(r._it.volumes) || r._cods.length), 0), top: tv[0], topN: tv[1] }; });
    // cobrança (pré)
    const pre = lidos.filter((r) => r._t === "pre"), cob = contaPor(pre, cobRep);
    const tit = volTipo === "TOTAL" ? "totais" : volTipo === "PARCIAL" ? "parciais" : "totais e parciais";
    box.innerHTML = `<section class="cartao rp-garg-q"><div class="cartao-topo"><div><h2>Volumes enviados nas reposições · ${tit}</h2>
      <p class="sub">O robô lê cada ticket quando ele chega em <b>Aguardando entrega</b> com nova NF: o quadro Reposição em Eventos (volume, parcial/total) e, no pré-entrega, o PDF da nota (destinatário com CNPJ de transportadora = saiu com cobrança; CPF = sem cobrança). Segue os filtros do topo.</p></div>
      <div class="rp-vol-bts"><button type="button" class="btn contorno vol-excel">↓ Baixar Excel</button><label class="btn contorno vol-cad" title="Qualquer planilha com o código do item (ex.: 76157.0001) e a descrição">Atualizar cadastro de volumes<input type="file" accept=".xlsx,.xlsm,.xls" hidden class="vol-cad-arq"></label></div></div>
      ${!repItOk ? `<p class="aviso">Para ver os volumes, rode a <b>parte 48</b> no Supabase.</p>` : ""}
      <div class="rp-vol-resumo">
        <div><b>${fmt(lidos.length)}</b><span>tickets lidos (Aguardando entrega)</span></div>
        <div><b>${fmt(naoLidos)}</b><span>em Aguardando entrega ainda não lidos pelo robô</span></div>
        <div><b>${fmt(proc.length)}</b><span>em processo (outras filas)</span></div>
        <div><b>${fmt(vs.length)}</b><span>volumes diferentes enviados</span></div>
        <div><b>${volCad.size ? fmt(volCad.size) : "–"}</b><span>${volCad.size ? "volumes no cadastro" : "cadastro de volumes não enviado"}</span></div>
      </div>
      <div class="rp-vol-grade">
        <div><h3>Volumes mais enviados</h3><div class="tabela-wrap rp-vol-rol"><table class="tabela-pedidos rp-vol-t"><thead><tr><th>Volume</th><th>Descrição</th><th class="num">Tickets</th><th class="num">Total</th><th class="num">Parcial</th><th class="num">Pré</th><th class="num">Pós</th><th>Motivo que mais aparece</th></tr></thead>
          <tbody>${vs.slice(0, 50).map((v) => { const tm = topMot(v.mot); return `<tr><td>${esc(v.c)}</td><td>${esc(descVol(v.c))}</td><td class="num tot">${fmt(v.n)}</td>${num(v.tot)}${num(v.par)}${num(v.pre)}${num(v.pos)}<td class="s">${esc(tm[0])}${tm[1] ? ` (${fmt(tm[1])})` : ""}</td></tr>`; }).join("")
            || `<tr><td colspan="8" class="vazio">Nenhum ticket lido ainda nesse filtro.</td></tr>`}</tbody></table></div>${vs.length > 50 ? `<p class="s">Mostrando os 50 mais enviados de ${fmt(vs.length)}. O Excel traz todos.</p>` : ""}</div>
        <div class="rp-vol-lado"><div><h3>Por motivo</h3><div class="tabela-wrap"><table class="tabela-pedidos rp-vol-t"><thead><tr><th>Motivo</th><th class="num">Tickets</th><th class="num">Volumes</th><th>Volume que mais aparece</th></tr></thead>
          <tbody>${pm.map((x) => `<tr><td>${esc(x.mot)}</td><td class="num tot">${fmt(x.n)}</td>${num(x.vols)}<td class="s">${x.top ? esc(x.top + " · " + descVol(x.top)) + ` (${fmt(x.topN)})` : ""}</td></tr>`).join("") || `<tr><td colspan="4" class="vazio">—</td></tr>`}</tbody></table></div>
</div>
          ${repAba !== "pos" ? `<div><h3>Pré-entrega · cobrança à transportadora</h3><div class="tabela-wrap"><table class="tabela-pedidos rp-vol-t"><thead><tr><th>Nota da reposição</th><th class="num">Tickets</th><th class="num">%</th></tr></thead>
          <tbody>${cob.map(([k, rs]) => `<tr><td>${esc(k)}</td><td class="num tot">${fmt(rs.length)}</td><td class="num">${pct(rs.length, pre.length)}</td></tr>`).join("") || `<tr><td colspan="3" class="vazio">Nenhum pré-entrega lido nesse filtro.</td></tr>`}</tbody></table></div></div>` : ""}
          <div><h3>Em processo · ainda não chegaram em Aguardando entrega</h3><div class="tabela-wrap"><table class="tabela-pedidos rp-vol-t"><thead><tr><th>Fila atual</th><th class="num">Tickets</th></tr></thead>
          <tbody>${contaPor(proc, (r) => filaRep(r) || SEM_FILA).map(([f, rs]) => `<tr><td>${esc(f)}</td><td class="num tot">${fmt(rs.length)}</td></tr>`).join("") || `<tr><td colspan="2" class="vazio">Nenhum.</td></tr>`}</tbody></table></div></div>
        </div>
      </div></section>`;
  }
  $("pagina-reposicao").addEventListener("click", (e) => {
    if (!e.target.closest(".vol-excel")) return;
    if (!volCasos.length) return toast("Nenhum ticket lido nesse filtro.", true);
    const cab = ["Ticket", "NF original", "Série da NF", "Pré/pós", "Total/Parcial", "Antes/depois da entrega", "Qtd volumes", "Volumes (código)", "Descrição dos volumes", "Motivo", "Transportadora", "Nota da reposição (pré)", "Fila atual", "Nova NF", "Lido pelo robô em"];
    const linhas = [cab].concat(volCasos.map((r) => [r.ticket, r.nf || "", serieRep(r), ROT_FLUXO[r._t], tpRep(r), r._it.quando || "", r._it.volumes ?? "", r._cods.join(", "), r._cods.map(descVol).join(" | "), motRep(r), trRep(r), cobRep(r), filaRep(r), (r._d && r._d.nfs_novas) || "", br(r._it.lido_em)]));
    const vol = new Map(); volCasos.forEach((r) => r._cods.forEach((c) => { const x = vol.get(c) || [c, descVol(c), 0, 0, 0]; x[2]++; tpRep(r) === "TOTAL" ? x[3]++ : x[4]++; vol.set(c, x); }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Volume", "Descrição", "Tickets", "Total", "Parcial"]].concat([...vol.values()].sort((a, b) => b[2] - a[2]))), "Volumes mais enviados");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(linhas), "Tickets");
    XLSX.writeFile(wb, `reposicao_volumes_${hojeISO()}.xlsx`);
  });
  $("pagina-reposicao").addEventListener("change", async (e) => {
    const inp = e.target.closest(".vol-cad-arq"); if (!inp || !inp.files[0]) return;
    const arq = inp.files[0]; inp.value = "";
    try {
      carregando("Lendo o cadastro de volumes…");
      const buf = await arq.arrayBuffer();
      // qualquer planilha: em cada aba acha a coluna com códigos de item (ex.: 76157.0001) e a de descrição
      const wb = XLSX.read(buf); const mp = new Map(); const RX = /^\d{5}\.\d{4}$/; const usadas = [];
      for (const aba of wb.SheetNames) {
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[aba], { header: 1, defval: "", raw: false });
        if (!rows.length) continue;
        const nc = Math.max(...rows.slice(0, 200).map((l) => l.length));
        const cont = Array.from({ length: nc }, (_, j) => rows.slice(0, 2000).filter((l) => RX.test(String(l[j] || "").trim())).length);
        const iC = cont.indexOf(Math.max(...cont)); if (cont[iC] < 3) continue;
        const iCab = rows.findIndex((l) => RX.test(String(l[iC] || "").trim())) - 1;
        const cab = iCab >= 0 ? (rows[iCab] || []).map(norm) : [];
        let iD = cab.findIndex((c, j) => j !== iC && /DESCRI/.test(c));
        if (iD < 0) {   // sem título: a coluna de texto mais longo
          const tam = Array.from({ length: nc }, (_, j) => j === iC ? -1 : rows.slice(iCab + 1, iCab + 300).reduce((t, l) => t + (/[A-Za-z]/.test(String(l[j] || "")) ? String(l[j]).length : 0), 0));
          iD = tam.indexOf(Math.max(...tam));
        }
        let n = 0;
        rows.slice(iCab + 1).forEach((l) => { const c = String(l[iC] || "").trim(), d = String(l[iD] || "").trim(); if (RX.test(c) && d) { mp.set(c, d); n++; } });
        if (n) usadas.push(`${aba} (${fmt(n)})`);
      }
      if (!mp.size) throw new Error("Não achei códigos de item (ex.: 76157.0001) com descrição nessa planilha.");
      const L = [...mp].map(([codigo, descricao]) => ({ codigo, descricao, atualizado_em: new Date().toISOString() }));
      for (let i = 0; i < L.length; i += 1000) { carregando(`Gravando volumes… ${fmt(Math.min(i + 1000, L.length))} de ${fmt(L.length)}`); const { error } = await sb.from("volumes_cad").upsert(L.slice(i, i + 1000)); if (error) throw error; }
      L.forEach((x) => volCad.set(x.codigo, x.descricao)); carregando(""); toast(`Cadastro de volumes atualizado: ${fmt(L.length)} itens (aba ${usadas.join(", ")}). Os que já existiam e não vieram continuam.`); filtrarRep();
    } catch (err) { carregando(""); toast(/volumes_cad|relation|schema cache/i.test(err.message) ? "Rode a parte 48 no Supabase antes de enviar o cadastro." : err.message, true); }
  });

  // clique num mês, transportadora, motivo, filial ou responsável: filtra e abre os tickets
  $("pagina-reposicao").addEventListener("click", (e) => {
    const a = e.target.closest("[data-f]"); if (!a || !a.closest("#rp-geral, #rp-fluxo")) return;
    e.preventDefault();
    if (["pre", "pos"].includes(repAba)) $("rep-tipo").value = repAba;
    $(a.dataset.f).value = a.dataset.v; repAba = "det"; rpdPag = 1; filtrarRep(); $("rp-det").scrollIntoView({ block: "start" });
  });
  $("pagina-reposicao").addEventListener("click", (e) => {
    const k = e.target.closest("button[data-card]");
    if (k && k.dataset.card === "garg") { e.preventDefault(); e.stopPropagation(); gargAberto = !gargAberto; filtrarRep();
      if (gargAberto) { const q = $(repAba === "geral" ? "rpg-garg" : "rpf-garg"); if (q) q.scrollIntoView({ block: "start", behavior: "smooth" }); } return; }
    if (k && ["comdet", "total", "parcial"].includes(k.dataset.card) && repAba !== "det") { e.preventDefault(); e.stopPropagation();
      const t = k.dataset.card === "comdet" ? "" : k.dataset.card.toUpperCase(); volAberto = !(volAberto && volTipo === t); volTipo = t; filtrarRep();
      if (volAberto) { const q = $(repAba === "geral" ? "rpg-vol" : "rpf-vol"); if (q) q.scrollIntoView({ block: "start", behavior: "smooth" }); } return; }
    if (k && k.dataset.card === "ab" && repAba !== "det") { e.preventDefault(); e.stopPropagation(); pvAberto = !pvAberto; filtrarRep();
      if (pvAberto) { const q = $(repAba === "geral" ? "rpg-parados" : "rpf-parados-q"); if (q) q.scrollIntoView({ block: "start", behavior: "smooth" }); } return; }
    if (e.target.closest(".pv-limpar")) { pv.serie = pv.fila = pv.resp = pv.grupo = ""; filtrarRep(); return; }
    if (k) { e.preventDefault(); e.stopPropagation(); const c = k.dataset.card;
      if (["pre", "pos"].includes(repAba)) $("rep-tipo").value = repAba;
      repCard = c === "todos" ? "" : c; repAba = "det"; rpdPag = 1; filtrarRep(); $("rp-det").scrollIntoView({ block: "start" }); return; }
    if (e.target.closest(".rp-card-x")) { repCard = ""; repFaixa = -1; pvDet = null; rpdPag = 1; filtrarRep(); return; }
    const c = e.target.closest("[data-pfila]");
    if (c) { e.preventDefault(); e.stopPropagation();
      if (["pre", "pos"].includes(repAba)) $("rep-tipo").value = repAba;
      pvDet = c.closest(".rp-garg-box") ? { serie: "", fila: "", resp: "", grupo: "", grupos: gf.grupo.slice() } : { ...pv }; if (c.dataset.pgrupo) pvDet.grupo = c.dataset.pgrupo; if (c.dataset.pfila !== "*") pvDet.fila = c.dataset.pfila;
      repCard = "ab"; repFaixa = c.dataset.pfx === undefined ? -1 : +c.dataset.pfx; repAba = "det"; rpdPag = 1; filtrarRep(); $("rp-det").scrollIntoView({ block: "start" }); }
  }, true);
  $("pagina-reposicao").addEventListener("change", (e) => { const g = e.target.closest(".garg-sel"); if (g) { gf[g.dataset.gf] = [...g.selectedOptions].map((o) => o.value); filtrarRep(); return; } });
  $("pagina-reposicao").addEventListener("click", (e) => {
    if (e.target.closest(".garg-limpar")) { gf.grupo = []; gf.fila = []; filtrarRep(); return; }
    if (!e.target.closest(".garg-excel")) return;
    if (!gargCasos.length) return toast("Nenhum caso em aberto nesse filtro.", true);
    const L = gargCasos.slice().sort((x, y) => (diasFila(y) ?? -1) - (diasFila(x) ?? -1));
    const cab = ["Ticket", "NF original", "Série da NF", "Pedido", "Pré/pós", "Grupo", "Fila atual", "Dias parados na fila", "Dias em aberto", "Status", "Transportadora", "Motivo", "Filial", "Responsável", "Criado em", "Última atualização", "Nova NF", "No detalhamento"];
    const linhas = [cab].concat(L.map((r) => { const d = r._d || {}; return [r.ticket, r.nf || "", serieRep(r), r.pedido || "", ROT_FLUXO[r._t], r.grupo || "", filaRep(r), diasFila(r) ?? "", diasAberto(r) ?? "", r.status || "",
      r.transportadora || "", r.motivo || "", r.filial || "", r.responsavel || "", br(r.criado_em), br(r.atualizado_em), d.nfs_novas || "", r._d ? "Sim" : "Não"]; }));
    const ws = XLSX.utils.aoa_to_sheet(linhas); ws["!cols"] = cab.map((c) => ({ wch: Math.min(34, Math.max(10, c.length)) }));
    const gs = contaPor(L, (r) => filaRep(r) || SEM_FILA).map(([fila, rs]) => { const d = rs.map(diasFila).filter((n) => n != null), s = d.reduce((x, y) => x + y, 0);
      return [fila, contaPor(rs, grupoRep).map((x) => x[0]).join(", "), rs.length, d.length ? Math.round((s / d.length) * 10) / 10 : 0, d.length ? Math.max(...d) : 0, d.filter((x) => x >= 10).length, s]; }).sort((x, y) => y[6] - x[6]);
    const ws2 = XLSX.utils.aoa_to_sheet([["Fila", "Grupo", "Casos", "Média de dias na fila", "Mais antigo (dias)", "Parados +10 dias", "Dias parados (total)"]].concat(gs));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws2, "Gargalos por fila"); XLSX.utils.book_append_sheet(wb, ws, "Casos em aberto");
    XLSX.writeFile(wb, `reposicao_gargalos_${hojeISO()}.xlsx`);
  });
  $("pagina-reposicao").addEventListener("change", (e) => { const s = e.target.closest(".pv-sel"); if (!s) return; pv[s.dataset.pv] = s.value; filtrarRep(); });
  $("rep-abas").addEventListener("click", (e) => { const b = e.target.closest("[data-ra]"); if (!b) return; repAba = b.dataset.ra; if (repAba !== "det") { repCard = ""; repFaixa = -1; pvDet = null; pvAberto = false; gargAberto = false; volAberto = false; } try { localStorage.setItem("painel.rep", repAba); } catch (_) {} filtrarRep(); });
  try { const s = localStorage.getItem("painel.rep"); if (["geral", "pre", "pos", "det"].includes(s)) repAba = s; } catch (_) {}
  const FILTROS_REP = ["rep-ano", "rep-mes", "rep-de", "rep-ate", "rep-tipo", "rep-transp", "rep-motivo", "rep-filial", "rep-status", "rep-resp", "rep-serie"];
  FILTROS_REP.forEach((id) => $(id).addEventListener("change", () => { rpdPag = 1; filtrarRep(); }));
  $("rep-limpar").addEventListener("click", () => { repCard = ""; repFaixa = -1; pvDet = null; FILTROS_REP.forEach((id) => ($(id).value = "")); $("rpd-busca").value = ""; filtrarRep(); });
  let esperaRpd; $("rpd-busca").addEventListener("input", () => { clearTimeout(esperaRpd); esperaRpd = setTimeout(() => { rpdPag = 1; desenharRepDet(); }, 250); });
  $("rpd-pag").addEventListener("click", (e) => { const b = e.target.closest("button[data-p]"); if (!b) return; rpdPag += Number(b.dataset.p); desenharRepDet(); });
  $("rep-exportar").addEventListener("click", () => {
    const L = repAba === "det" ? detFiltradas() : repFiltradas;
    if (!L.length) return toast("Nada para exportar nesse filtro.", true);
    const ord = L.slice().sort((a, b) => String(a.criado_em || "").localeCompare(String(b.criado_em || "")));
    const cab = ["Ticket", "NF original", "Nova NF", "Fila atual (detalhamento)", "Pedido", "Pré/pós", "Tipo de reposição", "Transportadora da entrega original (com redespacho)", "Transportadora Final (Q)", "Transportadora Redespacho (R)",
      "Transportadora da reposição (Promob)", "Transp. nota reposição (Promob) original", "Transp. redespacho nota reposição (Promob)", "Transportador definido para envio", "Motivo", "Filial", "Responsável", "Criado em", "Mês",
      "Emissão nova NF", "Saída nova NF", "Status", "Situação", "Grupo", "Fila atual", "Série da NF", "Dias em aberto", "Dias parados na fila", "Sem atualização > 2 dias", "Finalizado em", "Tempo de resolução (dias)", "Valor do pedido", "No detalhamento"];
    const linhas = [cab].concat(ord.map((r) => { const d = r._d || {}; return [r.ticket, r.nf || "", d.nfs_novas || "", d.fila_atual || "", r.pedido || "", ROT_FLUXO[r._t], tpRep(r) ? tpRep(r)[0] + tpRep(r).slice(1).toLowerCase() : "", r.transportadora || "", r.transp_final || "", r.transp_redesp || "",
      r._promob || "", d.transp_promob || "", d.transp_redesp_promob || "", d.transp_definida || "", r.motivo || "", r.filial || "", r.responsavel || "", br(r.criado_em), rotMes(mesRep(r)),
      br(d.data_emissao_nf), br(d.data_saida_nf), r.status || "", ROT_SIT[sitRep(r)], r.grupo || "", filaRep(r), serieRep(r), abertoRep(r) ? diasAberto(r) : "", abertoRep(r) && diasFila(r) != null ? diasFila(r) : "", semAtualiz(r) ? "Sim" : "", br(r.finalizado_em), r.tempo_resolucao != null ? Math.round(r.tempo_resolucao * 10) / 10 : "",
      r.valor_pedido != null ? Number(r.valor_pedido) : "", r._d ? "Sim" : "Não"]; }));
    const ws = XLSX.utils.aoa_to_sheet(linhas); ws["!cols"] = cab.map((c) => ({ wch: Math.min(34, Math.max(10, c.length)) }));
    const ev = evolucaoMeses(ord);
    const ws2 = XLSX.utils.aoa_to_sheet([["Mês", "Pré-entrega", "Pós-entrega", "Total", "Ainda abertos"]].concat(ev.map((x) => [rotMes(x.mes), x.pre, x.pos, x.pre + x.pos, x.ab])));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Tickets"); XLSX.utils.book_append_sheet(wb, ws2, "Por mês");
    XLSX.writeFile(wb, `reposicoes_${repAba}_${hojeISO()}.xlsx`);
  });
  $("arquivo-rep").addEventListener("change", async (e) => {
    const arq = e.target.files[0]; e.target.value = "";
    if (!arq) return;
    if (!repOk) return toast("Rode de novo o supabase/schema.sql no Supabase para usar a Reposição.", true);
    carregando("Lendo a tabela de acompanhamento…");
    await new Promise((r) => setTimeout(r, 50));
    let linhas, total = 0;
    try {
      const wb = XLSX.read(await arq.arrayBuffer(), { type: "array", dense: true, ...LEITURA_RAPIDA });
      const nomeAba = wb.SheetNames.find((n) => norm(n) === "EXPORT") || wb.SheetNames[0];
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[nomeAba], { header: 1, raw: true, defval: null });
      const iCab = rows.findIndex((r) => r && r.some((c) => norm(c) === "TIPO") && r.some((c) => norm(c) === "TICKET"));
      if (iCab < 0) throw new Error('Não achei as colunas "Ticket" e "Tipo" na aba Export.');
      const cab = rows[iCab].map(norm), col = (n) => cab.indexOf(n);
      const c = { ticket: col("TICKET"), via: col("VIA"), data: col("DATA DE CRIACAO"), por: col("TICKET CRIADO POR"), fila: col("FILA"), tipo: col("TIPO"), motivo: col("MOTIVO"),
        status: col("STATUS"), redesp: col("TRANSPORTADORA REDESPACHO"), final: col("TRANSPORTADORA FINAL"), nf: col("NOTA FISCAL"), filial: col("CENTRAL DE DISTRIBUICAO"),
        resp: col("RESPONSAVEL"), atual: col("DATA DA ULTIMA ATUALIZACAO"), fim: col("DATA DE FINALIZACAO"), tres: col("TEMPO DE RESOLUCAO DO TICKET (DIA)"),
        estag: cab.findIndex((x) => x.startsWith("FLAG - TICKET SEM ATUALIZACAO")), pedido: col("HUB - NUMERO DO MARKETPLACE"), valor: col("HUB - VALOR TOTAL"), grupo: col("GRUPO") };
      if (c.data < 0) throw new Error('Não achei a coluna "Data de Criação".');
      if (c.final < 0) throw new Error('Não achei a coluna "Transportadora Final".');
      const txt = (r, i) => (i >= 0 && r[i] != null && String(r[i]).trim() !== "" ? String(r[i]).trim() : null);
      const numero = (r, i) => { const v = i >= 0 ? r[i] : null; const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(",", ".")); return Number.isFinite(n) ? n : null; };
      const porTk = new Map();
      rows.slice(iCab + 1).forEach((r) => {
        if (!r || txt(r, c.ticket) == null || LINHA_RODAPE.test(txt(r, c.ticket))) return;
        total++;
        const tipo = txt(r, c.tipo);
        if (!tipoRep({ tipo })) return;
        porTk.set(txt(r, c.ticket), { ticket: txt(r, c.ticket), criado_em: dataCelula(r[c.data], true), criado_por: txt(r, c.por), via: txt(r, c.via),
          fila: txt(r, c.fila), tipo, motivo: txt(r, c.motivo), status: txt(r, c.status), transportadora: txt(r, c.redesp) || txt(r, c.final), nf: txt(r, c.nf),
          filial: txt(r, c.filial), responsavel: txt(r, c.resp), atualizado_em: c.atual >= 0 ? dataCelula(r[c.atual], true) : null, finalizado_em: c.fim >= 0 ? dataCelula(r[c.fim], true) : null,
          tempo_resolucao: numero(r, c.tres), estagnada: txt(r, c.estag), transp_final: txt(r, c.final), transp_redesp: txt(r, c.redesp), pedido: txt(r, c.pedido), valor_pedido: numero(r, c.valor), grupo: txt(r, c.grupo) });
      });
      linhas = [...porTk.values()];
      if (!linhas.length) throw new Error('A planilha não tem tickets com Tipo "Reposição" ou "Reposição Pós Entrega".');
    } catch (err) { carregando(""); toast(err.message, true); return; }
    carregando("");
    const nPre = linhas.filter((r) => tipoRep(r) === "pre").length;
    if (!confirm(`${arq.name}\n\n${fmt(total)} tickets na planilha, ${fmt(linhas.length)} de reposição (${fmt(nPre)} pré-entrega, ${fmt(linhas.length - nPre)} pós-entrega).\nTickets já guardados são atualizados; os novos são acrescentados.\n\nEnviar?`)) return;
    try {
      await enviarLotes("importar_reposicoes_tk", linhas, 2000, (lote, primeiro) => ({ linhas: lote, primeiro, arquivo: arq.name, total }));
    } catch (err) { carregando(""); toast("Erro ao enviar: " + (/column|filial|function/i.test(err.message) ? "rode a parte 36 do schema.sql no Supabase." : err.message), true); return; }
    await carregarReposicoes();
    carregando("");
    toast(`Reposições atualizadas: ${fmt(reps.length)} tickets.`);
  });

  // histórico do detalhamento (aba Reposições): cada envio é guardado; nada é apagado (parte 36)
  function lerHistRepo(wb) {
    const n = wb.SheetNames.find((x) => norm(x) === "REPOSICOES"); if (!n) return { linhas: [], lidas: 0 };
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null }); if (!rows.length) return { linhas: [], lidas: 0 };
    const cab = rows[0].map(norm), c = (x) => cab.indexOf(x);
    const p2 = (k) => String(k).padStart(2, "0");
    const dt = (v) => (v instanceof Date ? `${v.getFullYear()}-${p2(v.getMonth() + 1)}-${p2(v.getDate())}T${p2(v.getHours())}:${p2(v.getMinutes())}:${p2(v.getSeconds())}` : dataCelula(v, true));
    const tx = (r, i) => (i >= 0 && r[i] != null && String(r[i]).trim() !== "" ? String(r[i]).trim() : null);
    const C = { ticket: c("ID TICKET"), criado: c("DATA CRIACAO TICKET"), any: c("ID ANY"), ped: c("ID DO PEDIDO"), ip: c("ID INTELIPOST"), nota: c("NOTA TICKET"), saidaNota: c("DATA SAIDA NOTA TICKET"),
      tipo: c("TIPO DE TICKET"), fila: c("FILA ATUAL DO TICKET"), trep: c("TIPO DE REPOSICAO"), tdef: c("TRANSPORTADOR DEFINIDO PARA ENVIO"), pp: c("PEDIDO_PROMOB"), nf: c("NF EMITIDA PROMOB"),
      chave: c("CHAVE ACESSO NF EMITIDA PROMOB"), emi: c("DATA EMISSAO PROMOB"), sai: c("DATA SAIDA PROMOB"), tp: c("TRANSP. NOTA REPOSICAO (PROMOB)"), trd: c("TRANSP. REDESPACHO NOTA REPOSICAO (PROMOB)") };
    if (C.ticket < 0) return { linhas: [], lidas: 0 };
    const m = new Map(); let lidas = 0;
    rows.slice(1).forEach((r) => {
      const tk = r && tx(r, C.ticket); if (!tk) return; lidas++;
      const x = { ticket: tk.replace(/\.0+$/, ""), nf_nova: tx(r, C.nf) ? chaveNF(tx(r, C.nf)) : "", data_criacao_ticket: C.criado >= 0 ? dt(r[C.criado]) : null, id_any: tx(r, C.any), id_pedido: tx(r, C.ped),
        id_intelipost: tx(r, C.ip), nota_ticket: tx(r, C.nota), data_saida_nota_ticket: C.saidaNota >= 0 ? dt(r[C.saidaNota]) : null, tipo_ticket: tx(r, C.tipo), fila_atual: tx(r, C.fila),
        tipo_reposicao: tx(r, C.trep), transp_definida: tx(r, C.tdef), pedido_promob: tx(r, C.pp), chave_nf_nova: tx(r, C.chave), data_emissao_nf: C.emi >= 0 ? dt(r[C.emi]) : null,
        data_saida_nf: C.sai >= 0 ? dt(r[C.sai]) : null, transp_promob: tx(r, C.tp), transp_redesp_promob: tx(r, C.trd) };
      const k = x.ticket + "|" + x.nf_nova, a = m.get(k);
      // linha repetida do mesmo ticket e NF no mesmo arquivo: fica uma só, com as datas mais recentes preenchidas
      if (!a) m.set(k, x); else for (const f of Object.keys(x)) if (x[f] != null && x[f] !== "" && (a[f] == null || a[f] === "" || (/^data_/.test(f) && x[f] > a[f]))) a[f] = x[f];
    });
    return { linhas: [...m.values()], lidas };
  }
  async function guardarHistRepo(arq, wb) {
    const { linhas, lidas } = lerHistRepo(wb);
    if (!linhas.length) return "";
    const tickets = new Set(linhas.map((x) => x.ticket)).size;
    const d0 = new Date(arq.lastModified || Date.now()), p2 = (k) => String(k).padStart(2, "0");
    const sug = `${p2(d0.getDate())}/${p2(d0.getMonth() + 1)}/${d0.getFullYear()} ${p2(d0.getHours())}:${p2(d0.getMinutes())}`;
    const resp = prompt(`Histórico de reposições: ${fmt(tickets)} tickets (${fmt(lidas)} linhas na aba Reposições).\n\nData e hora em que esse detalhamento foi EXTRAÍDO (é a data do arquivo; corrija se precisar):`, sug);
    if (resp == null) return " · histórico de reposições não guardado (cancelado)";
    const mm = resp.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
    if (!mm) return " · histórico não guardado: data inválida (use dd/mm/aaaa hh:mm)";
    const ext = new Date(+mm[3], +mm[2] - 1, +mm[1], +(mm[4] || 0), +(mm[5] || 0));
    const json = JSON.stringify(linhas);
    let assinatura;
    if (window.crypto && crypto.subtle) { const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json)); assinatura = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join(""); }
    else { let h1 = 0x811c9dc5, h2 = 0x01000193; for (let i = 0; i < json.length; i++) { const c = json.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619) >>> 0; h2 = Math.imul(h2 + c, 2654435761) >>> 0; } assinatura = "f" + h1.toString(16) + h2.toString(16) + json.length; }
    const ab = await sb.rpc("abrir_envio_repo", { p_arquivo: arq.name, p_assinatura: assinatura, p_extraido_em: ext.toISOString(), p_linhas: lidas, p_tickets: tickets });
    if (ab.error) return /já está no histórico/i.test(ab.error.message) ? " · histórico: esse detalhamento já estava guardado" : /abrir_envio_repo|function/i.test(ab.error.message) ? " · histórico: falta rodar a parte 36 do schema.sql" : " · histórico: " + ab.error.message;
    try { await enviarLotes("gravar_hist_repo", linhas, 500, (lote) => ({ p_envio: ab.data, linhas: lote }), 0); }
    catch (err) { return " · histórico: erro ao gravar (" + err.message + ")"; }
    return ` · histórico de reposições: ${fmt(tickets)} tickets guardados`;
  }

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
    $("btn-prev-resp").textContent = pend ? `👤 Responsáveis · ${fmt(pend)} pendente${pend === 1 ? "" : "s"}` : "👤 Responsáveis";
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
    if (!detNF) { carregarDetNF().then((m) => { if (m.size && paginaAtual === "sac") desenharSacLogistica(); }); }
    if (!senhasSSW.length) carregarSenhas().catch(() => {});
    const det = detNF || new Map();
    montarSac(base.map((p) => {
      const t = trat.get(p.pedido) || {}, d = det.get(chaveNF(p.nf)) || {};
      return { pedido: p.pedido, nf: p.nf, canal: p.canal, transportadora: p.transportadora, micro_status: p.micro_status,
        prometido: p.prev_original || p.prev_atual, nova_data: t.nova_data, observacao: t.observacao,
        atualizado_em: t.atualizado_em, link_rastreio: p.link_rastreio,
        tem_ocorr: d.tem_ocorr, ocorr_status: d.ocorr_status, ocorr_msg: d.ocorr_msg, ocorr_em: d.ocorr_em,
        tem_repo: d.tem_repo, repo_ticket: d.repo_ticket, repo_fila: d.repo_fila, repo_nf: d.repo_nf };
    }));
  }
  // embaixo da nota: ocorrência e reposição em andamento (detalhamento de tickets)
  const linkTicket = (id) => `<a href="https://appv2.360multi.com/tickets/${encodeURIComponent(id)}" target="_blank" rel="noopener noreferrer" title="Abrir o ticket no Multi360">#${esc(id)}</a>`;
  function marcasSac(l) {
    let h = "";
    if (l.tem_ocorr) {
      const dica = [l.ocorr_msg ? "Última mensagem: " + l.ocorr_msg : "", l.ocorr_em ? "em " + br(l.ocorr_em) : ""].filter(Boolean).join(" ");
      h += `<div class="sac-marca oc" title="${esc(dica)}">⚠ Ocorrência${l.ocorr_status ? " · " + esc(l.ocorr_status) : ""}</div>`;
    }
    if (l.tem_repo) {
      const ids = String(l.repo_ticket || "").split(",").filter(Boolean);
      const rot = ids.length ? `<a href="https://appv2.360multi.com/tickets/${encodeURIComponent(ids[0])}" target="_blank" rel="noopener noreferrer" title="Abrir o ticket no Multi360">↻ Reposição</a>` : "↻ Reposição";
      const dica = ids.length ? (l.repo_fila ? "Fila: " + l.repo_fila : "") : "Sem número do ticket: suba de novo o detalhamento de tickets";
      h += `<div class="sac-marca rp" title="${esc(dica)}">${rot}${ids.length ? " " + ids.map(linkTicket).join(" ") : ""}${l.repo_nf ? ` <span class="s">NF ${esc(l.repo_nf)}</span>` : ""}${!l.repo_nf && l.repo_fila ? `<div class="s">Sem NF ainda: está na fila ${esc(l.repo_fila)}</div>` : l.repo_fila ? `<div class="s">${esc(l.repo_fila)}</div>` : ""}</div>`;
    }
    return h;
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
    const buscas = norm($("sac-busca").value).split(/[\s,;]+/).filter(Boolean);   // um ou vários números
    const canal = $("sac-canal").value, transp = $("sac-transp").value, nova = $("sac-nova").value;
    const hoje = hojeISO(), amanha = limiteSac();
    const dia = (l) => String(l.nova_data || l.prometido || "").slice(0, 10);   // nova data vale como vencimento
    const naSv = { todos: () => true, vencidos: (l) => dia(l) < hoje, hoje: (l) => dia(l) === hoje, amanha: (l) => dia(l) === amanha };
    const passa = (l) =>
      (!buscas.length || buscas.some((b) => [l.nf, l.pedido].some((v) => norm(v).replace(/\s/g, "").includes(b)))) &&
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
        <td><b>${esc(l.nf || "—")}</b></td><td>${esc(l.pedido)}${marcasSac(l)}</td><td>${esc(l.canal || "")}</td><td>${esc(l.transportadora || "—")}</td>
        <td><span class="ms">${esc(l.micro_status || "—")}</span></td>
        <td>${br(l.prometido) || "—"}<div>${chipData(l.prometido)}</div></td>
        <td>${l.nova_data ? `<b>${br(l.nova_data)}</b><div>${chipData(l.nova_data)}</div>` : `<span class="s">—</span>`}</td>
        <td class="col-obs">${l.observacao ? esc(l.observacao) : `<span class="s">—</span>`}${l.observacao && l.atualizado_em ? `<div class="s">${new Date(l.atualizado_em).toLocaleDateString("pt-BR")}</div>` : ""}</td>
        <td class="sac-rastreio">${l.nf ? `<button class="btn mini contorno" data-ssw="${esc(l.nf)}" data-transp="${esc(l.transportadora || "")}" data-pedido="${esc(l.pedido)}" title="Abre o rastreio dessa nota na transportadora">${rastreioDe(l.transportadora) ? "Ver na " + esc(rastreioDe(l.transportadora)[1]) : "Ver rastreio"} ↗</button>` : ""}
          ${/^https?:\/\//i.test(l.link_rastreio || "") ? `<div><a href="${esc(l.link_rastreio)}" target="_blank" rel="noopener noreferrer" title="Rastreio da Intelipost">Intelipost ↗</a></div>` : ""}</td>
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
  $("sac-limpar").addEventListener("click", () => { ["sac-busca", "sac-canal", "sac-transp", "sac-nova"].forEach((id) => ($(id).value = "")); filtrarSac(); });
  $("sac-linhas").addEventListener("click", (e) => { const b = e.target.closest("[data-ssw]"); if (b) abrirSSW(b.dataset.ssw, b.dataset.transp, b.dataset.pedido); });
  $("sac-paginacao").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-p]"); if (!b) return;
    sacPagina += Number(b.dataset.p); desenharSac(); $("pagina-sac").scrollIntoView({ block: "start" });
  });
  $("sac-baixar").addEventListener("click", () => {
    const linhas = [["Nota fiscal", "Pedido", "Canal", "Transportadora", "Micro status", "Prometido ao cliente", "Nova data", "Observação da Logística", "Rastreio",
      "Ocorrência", "Última mensagem da ocorrência", "Reposição (tickets)", "Fila da reposição", "NF da reposição"]]
      .concat(sacFiltrados.map((l) => [l.nf, l.pedido, l.canal, l.transportadora, l.micro_status, br(l.prometido), br(l.nova_data), l.observacao || "", l.link_rastreio || "",
        l.tem_ocorr ? l.ocorr_status || "Sim" : "", l.ocorr_msg || "", l.tem_repo ? l.repo_ticket || "Sim" : "", l.repo_fila || "", l.repo_nf || ""]));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(linhas), "Consulta");
    XLSX.writeFile(wb, `consulta_sac_${sacVisao.replace(/\+/g, "-")}_${hojeISO()}.xlsx`);
  });

  // ---------------- logins do painel ----------------
  const dataHora = (iso) => (iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "nunca entrou");
  let lgAcessos = new Map(), lgAbasEmail = "";
  const lgPaginas = () => [...document.querySelectorAll(".menu-lateral .menu-item")].filter((b) => !LIVRES.includes(b.dataset.pagina))
    .map((b) => { const c = b.cloneNode(true); c.querySelectorAll(".menu-icone,.menu-cont").forEach((x) => x.remove()); return [b.dataset.pagina, c.textContent.trim()]; });
  const lgAbasTexto = (email) => { const p = lgAcessos.get(email); if (!p) return "Todas as abas";
    const nomes = lgPaginas().filter(([k]) => p.includes(k)).map(([, n]) => n); return nomes.length ? nomes.join(", ") : "Nenhuma (só o Passo a passo)"; };
  async function carregarLogins() {
    lgAcessos = new Map(); let semParte44 = false;
    try { const r = await sb.rpc("listar_acessos"); if (r.error) semParte44 = /listar_acessos|function/i.test(r.error.message); else (r.data || []).forEach((x) => lgAcessos.set(x.email, x.paginas)); } catch (_) { semParte44 = true; }
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
      <td>${x.sac ? "Só Consulta SAC" : lgAcessos.get(x.email) ? "Logística (abas escolhidas)" : "Logística (tudo)"}</td>
      <td class="lg-abas-txt">${x.sac ? '<span class="s">só a Consulta SAC</span>' : `${esc(lgAbasTexto(x.email))} ${semParte44 ? "" : `<button class="btn contorno mini" data-abas="${esc(x.email)}">Escolher abas</button>`}`}</td>
      <td>${esc(dataHora(x.criado_em))}</td><td>${esc(dataHora(x.ultimo_acesso))}</td>
      <td>${x.email === eu ? "" : `<button class="btn contorno" data-prov="${esc(x.email)}">Gerar senha provisória</button>`}</td></tr>`).join("");
  }
  function abrirAbas(email) {
    lgAbasEmail = email; const p = lgAcessos.get(email);
    $("lg-abas-email").textContent = email;
    $("lg-abas-lista").innerHTML = lgPaginas().map(([k, n]) => `<label><input type="checkbox" value="${esc(k)}" ${!p || p.includes(k) ? "checked" : ""}> ${esc(n)}</label>`).join("");
    $("lg-abas").hidden = false; $("lg-abas").scrollIntoView({ behavior: "smooth", block: "center" });
  }
  const lgMarcar = (v) => $("lg-abas-lista").querySelectorAll("input").forEach((i) => (i.checked = v));
  $("lg-abas-todas").addEventListener("click", () => lgMarcar(true));
  $("lg-abas-nenhuma").addEventListener("click", () => lgMarcar(false));
  $("lg-abas-cancelar").addEventListener("click", () => { $("lg-abas").hidden = true; });
  $("lg-abas-salvar").addEventListener("click", async () => {
    const caixas = [...$("lg-abas-lista").querySelectorAll("input")], marc = caixas.filter((i) => i.checked).map((i) => i.value);
    const paginas = marc.length === caixas.length ? null : marc;
    const b = $("lg-abas-salvar"); b.disabled = true;
    const { error } = await sb.rpc("salvar_acesso", { p_email: lgAbasEmail, p_paginas: paginas });
    b.disabled = false;
    if (error) return toast("Não consegui salvar: " + error.message, true);
    toast(paginas ? `${lgAbasEmail} agora vê ${marc.length} aba(s). Vale no próximo acesso (ou Ctrl+F5).` : `${lgAbasEmail} vê todas as abas.`);
    $("lg-abas").hidden = true; carregarLogins();
  });
  $("lg-linhas").addEventListener("click", (e) => { const b = e.target.closest("button[data-abas]"); if (b) abrirAbas(b.dataset.abas); });
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
