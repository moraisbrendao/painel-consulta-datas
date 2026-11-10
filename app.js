// =====================================================================
// Painel de Consulta de Datas de Entrega
// Não precisa mexer neste arquivo. A configuração fica em config.js.
// =====================================================================
(function () {
  "use strict";

  const CFG = window.PAINEL_CONFIG || {};
  const PAD = window.Padronizacao;
  const POR_PAGINA = 50;
  const $ = (id) => document.getElementById(id);
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);

  // ---------------- estado ----------------
  let pedidos = [];          // pedidos em cobrança
  let ultimos = new Map();   // pedido -> último retorno
  let regras = [];           // [{id, categoria, termo}]
  let grupos = [];           // regras agrupadas por categoria (na ordem)
  let filtrados = [];
  let pagina = 1;
  let ehAdmin = false;
  let usuarioAtual = null;

  $("contato").textContent = CFG.CONTATO_LOGISTICA || "";

  // ---------------- utilidades ----------------
  function hojeISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function br(iso) {
    if (!iso) return "";
    const [a, m, d] = String(iso).slice(0, 10).split("-");
    return `${d}/${m}/${a}`;
  }
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  const norm = (s) => PAD.normalizar(s).toLowerCase();
  function toast(msg, erro) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.toggle("erro", !!erro);
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.hidden = true), erro ? 9000 : 4500);
  }
  async function buscarTudo(tabela, colunas, ajustar) {
    const lote = 1000;
    let lista = [];
    for (let de = 0; ; de += lote) {
      let q = sb.from(tabela).select(colunas);
      if (ajustar) q = ajustar(q);
      const { data, error } = await q.range(de, de + lote - 1);
      if (error) throw error;
      lista = lista.concat(data);
      if (data.length < lote) break;
    }
    return lista;
  }

  // ---------------- situação de cada pedido ----------------
  const G_NOVA = "Nova data informada", G_HOJE = "Vence hoje", G_VENCIDA = "Nova data vencida";
  const G_SEM = "Sem retorno", G_NAOPAD = "Não padronizado", G_ENTREGUE = "Entregue";
  const CARDS = [G_NOVA, G_HOJE, G_VENCIDA, G_SEM, G_NAOPAD];

  function situacao(ult, hoje) {
    if (!ult) return { txt: G_SEM, cor: "cinza", grupo: G_SEM, categoria: null };
    const cat = PAD.categorizar(ult.texto, grupos);
    if (cat && norm(cat) === "entregue") return { txt: cat, cor: "verde", grupo: G_ENTREGUE, categoria: cat };
    if (ult.nova_data) {
      const g = ult.nova_data < hoje ? G_VENCIDA : ult.nova_data === hoje ? G_HOJE : G_NOVA;
      const cor = g === G_VENCIDA ? "vermelho" : g === G_HOJE ? "ambar" : "verde";
      return { txt: cat || g, cor: cat ? "azul" : cor, corData: cor, grupo: g, categoria: cat };
    }
    if (cat) return { txt: cat, cor: "azul", grupo: cat, categoria: cat };
    return { txt: G_NAOPAD, cor: "ambar", grupo: G_NAOPAD, categoria: null };
  }

  // ---------------- login ----------------
  $("ver-senha").addEventListener("click", () => {
    const i = $("senha");
    const mostrar = i.type === "password";
    i.type = mostrar ? "text" : "password";
    $("ver-senha").textContent = mostrar ? "Ocultar" : "Mostrar";
  });

  $("form-login").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("erro-login").textContent = "";
    $("btn-entrar").disabled = true;
    const { error } = await sb.auth.signInWithPassword({ email: $("email").value.trim(), password: $("senha").value });
    $("btn-entrar").disabled = false;
    if (error) {
      $("erro-login").textContent = /invalid/i.test(error.message) ? "E-mail ou senha incorretos." : "Não foi possível entrar: " + error.message;
      return;
    }
    $("senha").value = "";
  });

  $("btn-sair").addEventListener("click", () => sb.auth.signOut());

  sb.auth.onAuthStateChange((_evento, sessao) => {
    if (sessao) abrirPainel(sessao.user);
    else {
      usuarioAtual = null;
      $("tela-painel").hidden = true;
      $("tela-login").hidden = false;
    }
  });

  async function abrirPainel(user) {
    if (usuarioAtual === user.id) return;
    usuarioAtual = user.id;
    $("tela-login").hidden = true;
    $("tela-painel").hidden = false;
    $("usuario-email").textContent = user.email;

    const { data: adm } = await sb.from("admins").select("email").limit(1);
    ehAdmin = Array.isArray(adm) && adm.length > 0;
    $("abas").hidden = !ehAdmin;
    $("usuario-perfil").textContent = ehAdmin ? "Logística" : "Consulta";
    mostrarAba("consulta");
    await carregar();
  }

  // ---------------- abas ----------------
  function mostrarAba(nome) {
    ["consulta", "envios", "regras"].forEach((a) => ($("aba-" + a).hidden = a !== nome));
    document.querySelectorAll(".aba").forEach((b) => b.classList.toggle("ativa", b.dataset.aba === nome));
    if (nome === "envios") carregarEnvios();
    if (nome === "regras") desenharRegras();
  }
  $("abas").addEventListener("click", (e) => {
    const b = e.target.closest(".aba");
    if (b) mostrarAba(b.dataset.aba);
  });

  // ---------------- carregar dados ----------------
  async function carregar() {
    $("info-atualizacao").textContent = "Carregando…";
    try {
      const [ps, us, rs] = await Promise.all([
        buscarTudo("pedidos", "*", (q) => q.eq("em_cobranca", true).order("pedido")),
        buscarTudo("ultimo_retorno", "*", (q) => q.order("pedido")),
        buscarTudo("regras", "id,categoria,termo", (q) => q.order("id")),
      ]);
      pedidos = ps;
      ultimos = new Map(us.map((u) => [u.pedido, u]));
      regras = rs;
      grupos = PAD.agruparRegras(regras);
    } catch (err) {
      toast("Erro ao carregar: " + err.message, true);
      return;
    }
    let ultData = "";
    pedidos.forEach((p) => {
      const u = ultimos.get(p.pedido);
      if (u && u.data_retorno > ultData) ultData = u.data_retorno;
    });
    $("info-atualizacao").textContent = pedidos.length
      ? `${pedidos.length.toLocaleString("pt-BR")} pedidos em cobrança` + (ultData ? ` · último retorno em ${br(ultData)}` : "")
      : "Ainda não há pedidos. A Logística precisa enviar a lista de cobrança.";
    montarOpcoes();
    filtrar();
    if (ehAdmin && !$("aba-regras").hidden) desenharRegras();
    if (ehAdmin) $("info-cobranca").textContent = `Hoje há ${pedidos.length.toLocaleString("pt-BR")} pedidos em cobrança no painel.`;
  }

  function montarOpcoes() {
    const preencher = (sel, valores, rotuloTodos) => {
      const atual = sel.value;
      sel.innerHTML = `<option value="">${rotuloTodos}</option>` +
        valores.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
      sel.value = valores.includes(atual) ? atual : "";
    };
    const unicos = (campo) => [...new Set(pedidos.map((p) => p[campo]).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));
    preencher($("f-transp"), unicos("transportadora"), "Todas");
    preencher($("f-canal"), unicos("canal"), "Todos");
    const sits = [...CARDS, G_ENTREGUE, ...grupos.map((g) => g.categoria).filter((c) => norm(c) !== "entregue")];
    preencher($("f-situacao"), [...new Set(sits)], "Todas");
  }

  // ---------------- consulta ----------------
  function filtrar() {
    const hoje = hojeISO();
    const busca = norm($("f-busca").value);
    const transp = $("f-transp").value;
    const canal = $("f-canal").value;
    const sit = $("f-situacao").value;

    const base = pedidos.filter((p) =>
      (!busca || [p.pedido, p.pedido_canal, p.nota, p.nova_nf].some((v) => norm(v).includes(busca))) &&
      (!transp || p.transportadora === transp) &&
      (!canal || p.canal === canal));
    base.forEach((p) => { p._ult = ultimos.get(p.pedido); p._sit = situacao(p._ult, hoje); });

    desenharResumo(base, sit);
    filtrados = sit ? base.filter((p) => p._sit.grupo === sit || p._sit.categoria === sit) : base;
    filtrados.sort((a, b) =>
      ((a._ult && a._ult.nova_data) || "9999").localeCompare((b._ult && b._ult.nova_data) || "9999") ||
      a.pedido.localeCompare(b.pedido));
    pagina = 1;
    desenhar();
  }

  function desenharResumo(base, ativo) {
    const cont = Object.fromEntries(CARDS.map((g) => [g, 0]));
    base.forEach((p) => { if (p._sit.grupo in cont) cont[p._sit.grupo]++; });
    const cards = [["", "Total em cobrança", base.length]].concat(CARDS.map((g) => [g, g, cont[g]]));
    $("resumo").innerHTML = cards.map(([valor, rot, n]) =>
      `<button class="card-resumo${valor === ativo ? " ativo" : ""}" data-sit="${esc(valor)}">
         <span class="num">${n.toLocaleString("pt-BR")}</span><span class="rot">${esc(rot)}</span>
       </button>`).join("");
  }
  $("resumo").addEventListener("click", (e) => {
    const b = e.target.closest(".card-resumo");
    if (!b) return;
    $("f-situacao").value = b.dataset.sit;
    filtrar();
  });
  let timer;
  $("f-busca").addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(filtrar, 200); });
  ["f-transp", "f-canal", "f-situacao"].forEach((id) => $(id).addEventListener("change", filtrar));

  function desenhar() {
    const total = filtrados.length;
    const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
    pagina = Math.min(pagina, paginas);
    const fatia = filtrados.slice((pagina - 1) * POR_PAGINA, pagina * POR_PAGINA);

    $("linhas").innerHTML = fatia.map((p) => {
      const s = p._sit, u = p._ult;
      const nova = u && u.nova_data
        ? `<span class="chip ${s.corData || s.cor}">${br(u.nova_data)}</span>`
        : `<span class="secundario">—</span>`;
      const ret = u
        ? `${esc(u.texto)}<div class="secundario">Recebido em ${br(u.data_retorno)}
             · <button class="link" data-hist="${esc(p.pedido)}">histórico (${u.qtd_retornos})</button></div>`
        : `<span class="secundario">Aguardando retorno</span>`;
      return `<tr>
        <td><div class="principal">${esc(p.pedido)}</div>
            <div class="secundario">NF ${esc(p.nota || "—")}${p.nova_nf ? " · nova NF " + esc(p.nova_nf) : ""} · ${esc(p.canal || "")}</div></td>
        <td>${esc(p.transportadora)}<div class="secundario">${esc([p.cidade, p.uf].filter(Boolean).join(" / "))}</div></td>
        <td class="num-data">${br(p.prev_original) || "—"}</td>
        <td class="num-data">${nova}</td>
        <td><span class="chip ${s.cor}">${esc(s.txt)}</span></td>
        <td class="obs">${ret}</td>
        <td>${/^https?:\/\//i.test(p.link_rastreio || "") ? `<a href="${esc(p.link_rastreio)}" target="_blank" rel="noopener noreferrer">Rastrear</a>` : "—"}</td>
      </tr><tr class="historico" data-de="${esc(p.pedido)}" hidden><td colspan="7"></td></tr>`;
    }).join("");

    $("vazio").hidden = total > 0;
    $("paginacao").innerHTML = total > POR_PAGINA
      ? `<button class="btn fantasma" data-p="-1" ${pagina === 1 ? "disabled" : ""}>‹ Anterior</button>
         <span>Página ${pagina} de ${paginas} · ${total.toLocaleString("pt-BR")} pedidos</span>
         <button class="btn fantasma" data-p="1" ${pagina === paginas ? "disabled" : ""}>Próxima ›</button>`
      : `<span>${total.toLocaleString("pt-BR")} pedidos</span>`;
  }

  $("paginacao").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-p]");
    if (!b) return;
    pagina += Number(b.dataset.p);
    desenhar();
    window.scrollTo({ top: $("resumo").offsetTop - 10, behavior: "smooth" });
  });

  // histórico de retornos de um pedido
  $("linhas").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-hist]");
    if (!b) return;
    const ped = b.dataset.hist;
    const tr = [...document.querySelectorAll("tr.historico")].find((t) => t.dataset.de === ped);
    if (!tr) return;
    if (!tr.hidden) { tr.hidden = true; return; }
    tr.hidden = false;
    tr.firstElementChild.innerHTML = `<span class="secundario">Carregando…</span>`;
    const { data, error } = await sb.from("retornos").select("texto,nova_data,data_retorno,transportadora,arquivo")
      .eq("pedido", ped).order("data_retorno", { ascending: false }).order("id", { ascending: false });
    if (error) { tr.firstElementChild.textContent = "Erro: " + error.message; return; }
    tr.firstElementChild.innerHTML = `<ol class="linha-tempo">${data.map((r) => {
      const cat = PAD.categorizar(r.texto, grupos);
      return `<li><span class="quando">${br(r.data_retorno)}</span>
        <span>${esc(r.texto)}</span>
        ${r.nova_data ? `<span class="chip cinza">data: ${br(r.nova_data)}</span>` : ""}
        ${cat ? `<span class="chip azul">${esc(cat)}</span>` : ""}</li>`;
    }).join("")}</ol>`;
  });

  // baixar o que está filtrado
  $("btn-baixar").addEventListener("click", () => {
    const cab = ["Pedido", "Pedido canal", "Nota", "Nova NF", "Canal", "Transportadora", "Prev. original", "Nova data informada",
      "Situação", "Último retorno", "Retorno recebido em", "Cidade", "UF", "Rastreio"];
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const linhas = filtrados.map((p) => [p.pedido, p.pedido_canal, p.nota, p.nova_nf, p.canal, p.transportadora,
      br(p.prev_original), br(p._ult && p._ult.nova_data), p._sit.txt, p._ult && p._ult.texto,
      br(p._ult && p._ult.data_retorno), p.cidade, p.uf, p.link_rastreio].map(q).join(";"));
    const blob = new Blob(["﻿" + [cab.map(q).join(";")].concat(linhas).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `novas_datas_${hojeISO()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  // =================================================================
  // LOGÍSTICA: leitura de planilhas
  // =================================================================
  function serialParaISO(n) {
    const d = new Date(Math.round((n - 25569) * 86400000));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  }
  function valorCelula(c) {
    if (!c || c.v === undefined || c.v === null) return "";
    if (c.t === "d") return { iso: c.v.toISOString().slice(0, 10) };
    if (c.t === "n" && c.z && window.XLSX.SSF.is_date(c.z)) return { iso: serialParaISO(c.v) };
    if (c.t === "n") return c.v;
    return String(c.v).trim();
  }
  function paraISO(v) {
    if (v && typeof v === "object" && v.iso) return v.iso;
    if (typeof v === "number" && v > 30000 && v < 80000) return serialParaISO(v);
    const s = String(v ?? "").trim();
    let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? m[0] : null;
  }
  function texto(v) {
    if (v && typeof v === "object" && v.iso) return br(v.iso);
    return String(v ?? "").trim();
  }

  // Lê a planilha e devolve {cab: [...], linhas: [[...]]} a partir da linha de cabeçalho
  async function lerPlanilha(arquivo, abaPreferida, cabecalhoObrigatorio) {
    const buf = await arquivo.arrayBuffer();
    const wb = window.XLSX.read(buf, { type: "array", cellNF: true, cellDates: false, raw: false });
    const nomeAba = wb.SheetNames.find((n) => norm(n) === norm(abaPreferida)) || wb.SheetNames[0];
    const ws = wb.Sheets[nomeAba];
    if (!ws["!ref"]) return { cab: [], linhas: [] };
    const rng = window.XLSX.utils.decode_range(ws["!ref"]);
    const ler = (r) => {
      const linha = [];
      for (let c = rng.s.c; c <= rng.e.c; c++) linha.push(valorCelula(ws[window.XLSX.utils.encode_cell({ r, c })]));
      return linha;
    };
    let rCab = rng.s.r;
    for (let r = rng.s.r; r <= Math.min(rng.e.r, rng.s.r + 15); r++) {
      if (ler(r).some((v) => PAD.normalizar(texto(v)) === cabecalhoObrigatorio)) { rCab = r; break; }
    }
    const cab = ler(rCab).map((v) => PAD.normalizar(texto(v)));
    const linhas = [];
    for (let r = rCab + 1; r <= rng.e.r; r++) {
      const l = ler(r);
      if (l.some((v) => v !== "")) linhas.push(l);
    }
    return { cab, linhas };
  }
  function indice(cab, ...nomes) {
    for (const n of nomes) { const i = cab.indexOf(n); if (i >= 0) return i; }
    return -1;
  }

  // ---------------- prévia (conferir antes de salvar) ----------------
  let acaoSalvar = null;
  function mostrarPrevia(titulo, resumoHtml, colunas, linhas, salvar) {
    $("previa-titulo").textContent = titulo;
    $("previa-resumo").innerHTML = resumoHtml;
    $("previa-cab").innerHTML = `<tr>${colunas.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>`;
    $("previa-linhas").innerHTML = linhas.slice(0, 30).map((l) => `<tr>${l.map((v) => `<td>${v}</td>`).join("")}</tr>`).join("") +
      (linhas.length > 30 ? `<tr><td colspan="${colunas.length}" class="secundario">… e mais ${linhas.length - 30} linhas</td></tr>` : "");
    acaoSalvar = salvar;
    $("previa").hidden = false;
    $("previa").scrollIntoView({ behavior: "smooth" });
  }
  $("previa-cancelar").addEventListener("click", () => { $("previa").hidden = true; acaoSalvar = null; });
  $("previa-salvar").addEventListener("click", async () => {
    if (!acaoSalvar) return;
    $("previa-salvar").disabled = true;
    try { await acaoSalvar(); $("previa").hidden = true; acaoSalvar = null; }
    finally { $("previa-salvar").disabled = false; }
  });

  // ---------------- 1. lista de cobrança ----------------
  $("arq-cobranca").addEventListener("change", async (e) => {
    const arq = e.target.files[0];
    e.target.value = "";
    if (!arq) return;
    let plan;
    try { plan = await lerPlanilha(arq, "Pedidos", "PEDIDO INTELIPOST"); }
    catch (err) { toast("Não consegui ler o arquivo: " + err.message, true); return; }
    const c = plan.cab;
    const col = {
      pedido: indice(c, "PEDIDO INTELIPOST"), pedido_canal: indice(c, "PEDIDO ANYMARKET"), nota: indice(c, "NOTA-SERIE"),
      nova_nf: indice(c, "NOVA NF REPOSICAO"), canal: indice(c, "CANAL"), transportadora: indice(c, "TRANSPORTADORA"),
      status: indice(c, "STATUS"), micro_status: indice(c, "MICRO STAUTS", "MICRO STATUS"), dias_atraso: indice(c, "DIAS DE ATRASO"),
      prev_original: indice(c, "PREV. ORIGINAL"), prev_atual: indice(c, "PREV. ATUAL"), data_entrega: indice(c, "DATA ENTREGA"),
      uf: indice(c, "UF"), cidade: indice(c, "CIDADE"), link_rastreio: indice(c, "LINK RASTREIO"),
    };
    if (col.pedido < 0) { toast('Não achei a coluna "Pedido Intelipost". Confira se é o arquivo da cobrança.', true); return; }
    const datas = new Set(["prev_original", "prev_atual", "data_entrega"]);
    const vistos = new Set();
    const linhas = [];
    for (const l of plan.linhas) {
      const o = {};
      for (const [campo, i] of Object.entries(col)) {
        const v = i >= 0 ? l[i] : "";
        if (datas.has(campo)) o[campo] = paraISO(v);
        else if (campo === "dias_atraso") o[campo] = Number.isFinite(+v) && v !== "" ? Math.round(+v) : null;
        else o[campo] = texto(v) || null;
      }
      if (!o.pedido || vistos.has(o.pedido)) continue;
      vistos.add(o.pedido);
      linhas.push(o);
    }
    if (!linhas.length) { toast("Não encontrei pedidos nesse arquivo.", true); return; }
    const atuais = new Set(pedidos.map((p) => p.pedido));
    const novos = linhas.filter((l) => !atuais.has(l.pedido)).length;
    const saem = pedidos.filter((p) => !vistos.has(p.pedido)).length;
    mostrarPrevia(`Lista de cobrança: ${arq.name}`,
      `<span><b>${linhas.length}</b> pedidos no arquivo</span><span><b>${novos}</b> novos na cobrança</span>
       <span><b>${saem}</b> saem da cobrança (o histórico fica guardado)</span>`,
      ["Pedido", "Nota", "Transportadora", "Canal", "Prev. original", "Status"],
      linhas.map((l) => [esc(l.pedido), esc(l.nota), esc(l.transportadora), esc(l.canal), br(l.prev_original), esc(l.status)]),
      async () => {
        const { data, error } = await sb.rpc("importar_pedidos", { linhas });
        if (error) { toast("Erro ao salvar: " + error.message, true); throw error; }
        toast(`Pronto! ${data} pedidos em cobrança.`);
        await carregar();
      });
  });

  // ---------------- 2. retorno da transportadora ----------------
  $("data-retorno").value = hojeISO();
  $("arq-retorno").addEventListener("change", async (e) => {
    const arq = e.target.files[0];
    e.target.value = "";
    if (!arq) return;
    const dataRet = $("data-retorno").value || hojeISO();
    let plan;
    try { plan = await lerPlanilha(arq, "Planilha1", "PEDIDO INTELIPOST"); }
    catch (err) { toast("Não consegui ler o arquivo: " + err.message, true); return; }
    const c = plan.cab;
    const iPed = indice(c, "PEDIDO INTELIPOST", "PEDIDO"), iNota = indice(c, "NOTA-SERIE", "NOTA", "NF");
    const iTransp = indice(c, "TRANSPORTADORA"), iRet = indice(c, "RETORNO TRANSPORTADORA", "RETORNO");
    if (iRet < 0 || (iPed < 0 && iNota < 0)) {
      toast('O arquivo precisa ter as colunas "Pedido Intelipost" (ou "Nota-Série") e "Retorno Transportadora".', true);
      return;
    }
    const porPedido = new Map(pedidos.map((p) => [norm(p.pedido), p]));
    const porNota = new Map();
    pedidos.forEach((p) => {
      if (p.nota) porNota.set(norm(p.nota), p);
      if (p.nova_nf) porNota.set(norm(p.nova_nf), p);
    });

    const salvar = [], previa = [];
    let ignorados = 0, fora = 0, comData = 0, padron = 0, semPad = 0;
    for (const l of plan.linhas) {
      const bruto = iRet >= 0 ? l[iRet] : "";
      const txt = texto(bruto);
      let ped = iPed >= 0 ? texto(l[iPed]) : "";
      const nota = iNota >= 0 ? texto(l[iNota]) : "";
      let achado = ped ? porPedido.get(norm(ped)) : null;
      if (!achado && nota) achado = porNota.get(norm(nota));
      if (achado) ped = achado.pedido;
      if (!ped || !txt) {
        ignorados++;
        previa.push([esc(ped || "—"), esc(nota), esc(txt), "", `<span class="chip vermelho">${!txt ? "sem retorno" : "pedido não encontrado"}</span>`]);
        continue;
      }
      const novaData = paraISO(bruto && bruto.iso ? bruto : null) || PAD.acharData(txt, dataRet);
      const cat = PAD.categorizar(txt, grupos);
      if (!achado) fora++;
      if (novaData) comData++;
      if (cat) padron++;
      if (!cat && !novaData) semPad++;
      salvar.push({ pedido: ped, nota: nota || (achado && achado.nota) || null,
        transportadora: (iTransp >= 0 ? texto(l[iTransp]) : "") || (achado && achado.transportadora) || null,
        texto: txt, nova_data: novaData });
      previa.push([esc(ped) + (achado ? "" : ` <span class="secundario">(fora da cobrança)</span>`), esc(nota), esc(txt),
        novaData ? br(novaData) : "",
        cat ? `<span class="chip azul">${esc(cat)}</span>` : novaData ? `<span class="chip verde">data</span>`
          : `<span class="chip ambar">${G_NAOPAD}</span>`]);
    }
    if (!salvar.length) { toast("Nenhum retorno para salvar nesse arquivo.", true); return; }
    mostrarPrevia(`Retorno da transportadora: ${arq.name} · retorno de ${br(dataRet)}`,
      `<span><b>${salvar.length}</b> retornos para salvar</span><span><b>${comData}</b> com data</span>
       <span><b>${padron}</b> padronizados</span><span><b>${semPad}</b> sem data e sem padronização</span>
       ${fora ? `<span><b>${fora}</b> fora da lista de cobrança (salvos mesmo assim)</span>` : ""}
       ${ignorados ? `<span class="erro-texto"><b>${ignorados}</b> linhas ignoradas</span>` : ""}`,
      ["Pedido", "Nota", "Retorno", "Data encontrada", "Padronização"], previa,
      async () => {
        const { error } = await sb.rpc("enviar_retornos", { linhas: salvar, arquivo: arq.name, data_retorno: dataRet });
        if (error) { toast("Erro ao salvar: " + error.message, true); throw error; }
        toast(`Pronto! ${salvar.length} retornos salvos.`);
        await carregar();
        await carregarEnvios();
      });
  });

  // ---------------- envios feitos ----------------
  async function carregarEnvios() {
    const { data, error } = await sb.from("envios").select("*").order("criado_em", { ascending: false }).limit(20);
    if (error) { $("lista-envios").innerHTML = `<tr><td colspan="6">Erro: ${esc(error.message)}</td></tr>`; return; }
    $("lista-envios").innerHTML = data.length ? data.map((e) => `<tr>
        <td>${new Date(e.criado_em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</td>
        <td>${esc(e.arquivo)}</td><td>${br(e.data_retorno)}</td><td>${e.qtd}</td><td>${esc(e.enviado_por)}</td>
        <td><button class="link perigo" data-lote="${esc(e.lote)}" data-qtd="${e.qtd}">apagar</button></td></tr>`).join("")
      : `<tr><td colspan="6" class="secundario">Nenhum retorno enviado ainda.</td></tr>`;
  }
  $("lista-envios").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-lote]");
    if (!b) return;
    if (!confirm(`Apagar os ${b.dataset.qtd} retornos desse envio? Isso não pode ser desfeito.`)) return;
    const { error } = await sb.rpc("apagar_lote", { lote_id: b.dataset.lote });
    if (error) { toast("Erro: " + error.message, true); return; }
    toast("Envio apagado.");
    await carregar();
    await carregarEnvios();
  });

  // =================================================================
  // LOGÍSTICA: padronização
  // =================================================================
  function desenharRegras() {
    $("lista-categorias").innerHTML = grupos.map((g) => `<option value="${esc(g.categoria)}">`).join("");
    $("lista-regras").innerHTML = grupos.length ? grupos.map((g) => `
      <div class="regra">
        <div class="regra-nome">${esc(g.categoria)}</div>
        <div class="chips">${g.regras.map((r) =>
          `<span class="chip-regra">${esc(r.termo)}<button data-del="${r.id}" aria-label="Remover ${esc(r.termo)}">×</button></span>`).join("")}</div>
      </div>`).join("") : `<p class="secundario">Nenhuma regra ainda.</p>`;

    // retornos atuais sem data e sem categoria
    const cont = new Map();
    pedidos.forEach((p) => {
      const u = ultimos.get(p.pedido);
      if (!u || u.nova_data || PAD.categorizar(u.texto, grupos)) return;
      const k = PAD.normalizar(u.texto);
      const atual = cont.get(k) || { texto: u.texto, n: 0 };
      atual.n++;
      cont.set(k, atual);
    });
    const lista = [...cont.values()].sort((a, b) => b.n - a.n);
    $("qtd-sem-regra").textContent = lista.length ? lista.reduce((s, x) => s + x.n, 0) : "";
    $("sem-regra").innerHTML = lista.length
      ? lista.slice(0, 80).map((x) => `<button class="chip-regra clicavel" data-usar="${esc(x.texto)}">${esc(x.texto)} <b>${x.n}</b></button>`).join("")
      : `<p class="secundario">Tudo padronizado. 🎉</p>`;
  }

  $("sem-regra").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-usar]");
    if (!b) return;
    const campo = $("regra-termos");
    campo.value = campo.value.trim() ? campo.value.trim().replace(/,\s*$/, "") + ", " + b.dataset.usar : b.dataset.usar;
    $("regra-categoria").focus();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  $("form-regra").addEventListener("submit", async (e) => {
    e.preventDefault();
    const categoria = $("regra-categoria").value.trim();
    const termos = [...new Set($("regra-termos").value.split(",").map((t) => t.trim()).filter(Boolean))];
    if (!categoria || !termos.length) return;
    const { error } = await sb.from("regras")
      .upsert(termos.map((termo) => ({ categoria, termo })), { onConflict: "categoria,termo", ignoreDuplicates: true });
    if (error) { toast("Erro ao guardar: " + error.message, true); return; }
    $("regra-termos").value = "";
    toast(`Regra guardada em "${categoria}".`);
    await carregar();
    desenharRegras();
  });

  $("lista-regras").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-del]");
    if (!b) return;
    const { error } = await sb.from("regras").delete().eq("id", Number(b.dataset.del));
    if (error) { toast("Erro: " + error.message, true); return; }
    await carregar();
    desenharRegras();
  });

  $("btn-fabrica").addEventListener("click", async () => {
    if (!confirm("Voltar para as regras de fábrica? As regras que você criou serão apagadas.")) return;
    const { error } = await sb.rpc("restaurar_regras_padrao");
    if (error) { toast("Erro: " + error.message, true); return; }
    toast("Regras de fábrica restauradas.");
    await carregar();
    desenharRegras();
  });
})();
