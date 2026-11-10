// =====================================================================
// Painel de Consulta de Datas de Entrega
// Não precisa mexer neste arquivo. A configuração fica em config.js.
// =====================================================================
(function () {
  "use strict";

  const CFG = window.PAINEL_CONFIG || {};
  const POR_PAGINA = 50;
  const SEM_RETORNO = "sem retorno transportadora";

  const $ = (id) => document.getElementById(id);
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);

  let todos = [];        // todos os pedidos carregados
  let filtrados = [];    // depois dos filtros
  let pagina = 1;

  // ---------------- textos fixos ----------------
  document.querySelectorAll(".js-empresa").forEach((el) => (el.textContent = CFG.EMPRESA || ""));
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
  function norm(s) {
    return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  }
  function toast(msg, erro) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.toggle("erro", !!erro);
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.hidden = true), erro ? 8000 : 4000);
  }

  // Situação de cada pedido (o que aparece na coluna "Situação")
  function situacao(p, hoje) {
    if (p.data_entrega || norm(p.status) === "entregue" || norm(p.retorno) === "entregue") return { txt: "Entregue", cor: "verde", grupo: "Entregue" };
    if (p.nova_data) {
      if (p.nova_data < hoje) return { txt: "Nova data vencida", cor: "vermelho", grupo: "Nova data vencida" };
      if (p.nova_data === hoje) return { txt: "Vence hoje", cor: "ambar", grupo: "Vence hoje" };
      return { txt: "Nova data informada", cor: "verde", grupo: "Nova data informada" };
    }
    if (p.retorno && norm(p.retorno) !== SEM_RETORNO) return { txt: p.retorno, cor: "azul", grupo: "Outros retornos" };
    return { txt: "Sem retorno", cor: "cinza", grupo: "Sem retorno" };
  }
  const GRUPOS = ["Nova data informada", "Vence hoje", "Nova data vencida", "Outros retornos", "Sem retorno", "Entregue"];

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
      $("erro-login").textContent = /invalid/i.test(error.message)
        ? "E-mail ou senha incorretos."
        : "Não foi possível entrar: " + error.message;
      return;
    }
    $("senha").value = "";
  });

  $("btn-sair").addEventListener("click", () => sb.auth.signOut());

  sb.auth.onAuthStateChange((_evento, sessao) => {
    if (sessao) abrirPainel(sessao.user);
    else mostrarLogin();
  });

  function mostrarLogin() {
    todos = [];
    $("tela-painel").hidden = true;
    $("tela-login").hidden = false;
  }

  let usuarioAtual = null;
  async function abrirPainel(user) {
    if (usuarioAtual === user.id && !$("tela-painel").hidden) return;
    usuarioAtual = user.id;
    $("tela-login").hidden = true;
    $("tela-painel").hidden = false;
    $("usuario-email").textContent = user.email;

    const { data: adm } = await sb.from("admins").select("email").limit(1);
    const ehAdmin = Array.isArray(adm) && adm.length > 0;
    $("area-admin").hidden = !ehAdmin;
    $("usuario-perfil").textContent = ehAdmin ? "Logística" : "Consulta";

    await carregar();
  }

  // ---------------- dados ----------------
  async function carregar() {
    $("info-atualizacao").textContent = "Carregando…";
    const lote = 1000;
    let lista = [];
    for (let de = 0; ; de += lote) {
      const { data, error } = await sb.from("entregas").select("*").order("pedido").range(de, de + lote - 1);
      if (error) {
        toast("Erro ao carregar os pedidos: " + error.message, true);
        break;
      }
      lista = lista.concat(data);
      if (data.length < lote) break;
    }
    todos = lista;

    const { data: at } = await sb.from("atualizacao").select("*").maybeSingle();
    $("info-atualizacao").textContent = at
      ? `Novos retornos da semana · atualizado em ${new Date(at.atualizado_em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })} · ${todos.length} pedidos`
      : "Ainda não há dados. A logística precisa enviar a planilha.";

    montarOpcoes();
    filtrar();
  }

  function montarOpcoes() {
    const preencher = (sel, valores, rotuloTodos) => {
      const atual = sel.value;
      sel.innerHTML = `<option value="">${rotuloTodos}</option>` +
        valores.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
      sel.value = valores.includes(atual) ? atual : "";
    };
    const unicos = (campo) => [...new Set(todos.map((p) => p[campo]).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));
    preencher($("f-transp"), unicos("transportadora"), "Todas");
    preencher($("f-canal"), unicos("canal"), "Todos");
    preencher($("f-situacao"), GRUPOS, "Todas");
  }

  // ---------------- filtros ----------------
  function filtrar() {
    const hoje = hojeISO();
    const busca = norm($("f-busca").value);
    const transp = $("f-transp").value;
    const canal = $("f-canal").value;
    const sit = $("f-situacao").value;

    const base = todos.filter((p) =>
      (!busca || [p.pedido, p.pedido_canal, p.nota].some((v) => norm(v).includes(busca))) &&
      (!transp || p.transportadora === transp) &&
      (!canal || p.canal === canal)
    );
    base.forEach((p) => (p._sit = situacao(p, hoje)));

    desenharResumo(base, sit);
    filtrados = sit ? base.filter((p) => p._sit.grupo === sit) : base;

    // nova data mais próxima primeiro; depois os sem data
    filtrados.sort((a, b) => (a.nova_data || "9999").localeCompare(b.nova_data || "9999") || a.pedido.localeCompare(b.pedido));
    pagina = 1;
    desenhar();
  }

  function desenharResumo(base, ativo) {
    const cont = Object.fromEntries(GRUPOS.map((g) => [g, 0]));
    base.forEach((p) => cont[p._sit.grupo]++);
    const cards = [["", "Total de pedidos", base.length]].concat(GRUPOS.map((g) => [g, g, cont[g]]));
    $("resumo").innerHTML = cards
      .map(([valor, rot, n]) =>
        `<button class="card-resumo${valor === ativo ? " ativo" : ""}" data-sit="${esc(valor)}">
           <span class="num">${n.toLocaleString("pt-BR")}</span><span class="rot">${esc(rot)}</span>
         </button>`)
      .join("");
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

  // ---------------- tabela ----------------
  function desenhar() {
    const total = filtrados.length;
    const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
    pagina = Math.min(pagina, paginas);
    const fatia = filtrados.slice((pagina - 1) * POR_PAGINA, pagina * POR_PAGINA);

    $("linhas").innerHTML = fatia.map((p) => {
      const s = p._sit;
      const obs = p.retorno_texto && norm(p.retorno_texto) !== norm(p.retorno) ? p.retorno_texto : "";
      const nova = p.nova_data
        ? `<span class="chip ${s.cor === "verde" ? "verde" : s.cor}">${br(p.nova_data)}</span>`
        : `<span class="secundario">—</span>`;
      return `<tr>
        <td><div class="principal">${esc(p.pedido)}</div>
            <div class="secundario">NF ${esc(p.nota || "—")} · ${esc(p.canal || "")}</div></td>
        <td>${esc(p.transportadora)}<div class="secundario">${esc([p.cidade, p.uf].filter(Boolean).join(" / "))}</div></td>
        <td class="num-data">${br(p.prev_original) || "—"}</td>
        <td class="num-data">${nova}</td>
        <td><span class="chip ${s.cor}">${esc(s.txt)}</span>
            ${p.data_entrega ? `<div class="secundario">em ${br(p.data_entrega)}</div>` : ""}</td>
        <td class="obs">${esc(obs) || '<span class="secundario">—</span>'}
            ${p.data_retorno ? `<div class="secundario">Retorno recebido em ${br(p.data_retorno)}</div>` : ""}</td>
        <td>${/^https?:\/\//i.test(p.link_rastreio || "") ? `<a href="${esc(p.link_rastreio)}" target="_blank" rel="noopener noreferrer">Rastrear</a>` : "—"}</td>
      </tr>`;
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

  // ---------------- baixar o que está filtrado ----------------
  $("btn-baixar").addEventListener("click", () => {
    const cab = ["Pedido", "Pedido canal", "Nota", "Canal", "Transportadora", "Prev. original", "Nova data informada",
      "Situação", "Observação da transportadora", "Retorno recebido em", "Data entrega", "Cidade", "UF", "Rastreio"];
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const linhas = filtrados.map((p) => [p.pedido, p.pedido_canal, p.nota, p.canal, p.transportadora, br(p.prev_original),
      br(p.nova_data), p._sit.txt, p.retorno_texto, br(p.data_retorno), br(p.data_entrega), p.cidade, p.uf, p.link_rastreio].map(q).join(";"));
    const blob = new Blob(["﻿" + [cab.map(q).join(";")].concat(linhas).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `novas_datas_${hojeISO()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  // ---------------- envio da planilha (só logística) ----------------
  const CAMPOS = ["pedido", "pedido_canal", "nota", "canal", "transportadora", "status", "prev_original", "prev_atual",
    "data_entrega", "nova_data", "retorno", "retorno_texto", "data_retorno", "uf", "cidade", "link_rastreio"];
  const CAMPOS_DATA = new Set(["prev_original", "prev_atual", "data_entrega", "nova_data", "data_retorno"]);

  $("arquivo-csv").addEventListener("change", (e) => {
    const arq = e.target.files[0];
    e.target.value = "";
    if (!arq) return;
    Papa.parse(arq, {
      header: true,
      skipEmptyLines: true,
      encoding: "UTF-8",
      complete: (res) => enviar(res.data, res.meta.fields || []),
      error: (err) => toast("Não consegui ler o arquivo: " + err.message, true),
    });
  });

  async function enviar(dados, colunas) {
    const faltando = CAMPOS.filter((c) => !colunas.includes(c));
    if (faltando.length) {
      toast("Esse arquivo não é o gerado pelo botão \"Exportar para o painel\". Faltam colunas: " + faltando.join(", "), true);
      return;
    }
    const vistos = new Set();
    const linhas = [];
    for (const r of dados) {
      const p = (r.pedido || "").trim();
      if (!p || vistos.has(p)) continue;
      vistos.add(p);
      const o = {};
      for (const c of CAMPOS) {
        let v = (r[c] ?? "").trim();
        if (CAMPOS_DATA.has(c) && !/^\d{4}-\d{2}-\d{2}$/.test(v)) v = "";
        o[c] = v === "" ? null : v;
      }
      linhas.push(o);
    }
    if (!linhas.length) { toast("O arquivo está vazio.", true); return; }
    if (!confirm(`Enviar ${linhas.length} pedidos? Isso substitui os dados que estão no painel agora.`)) return;

    toast("Enviando…");
    const { data, error } = await sb.rpc("substituir_entregas", { linhas });
    if (error) { toast("Erro ao enviar: " + error.message, true); return; }
    toast(`Pronto! ${data} pedidos atualizados no painel.`);
    await carregar();
  }
})();
