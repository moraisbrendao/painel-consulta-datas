// Consulta SAC: visão limitada (NF, pedido, canal, transportadora, previsão,
// nova data, anotações e rastreio). Os dados vêm da função consulta_sac()
// do banco, que só devolve essas colunas.
(function () {
  const P = window.Painel;
  const { sb, $, esc, br } = P;
  const POR_PAGINA = 50;
  const fmt = (n) => Number(n || 0).toLocaleString("pt-BR");

  let linhas = [];
  let filtrados = [];
  let pagina = 1;
  let carregadoEm = 0;

  async function carregar(forcar) {
    if (!forcar && carregadoEm && Date.now() - carregadoEm < 60000) return;
    $("sac-info").textContent = "Carregando…";
    const lote = 1000;
    let lista = [];
    try {
      for (let de = 0; ; de += lote) {
        const { data, error } = await sb.rpc("consulta_sac").order("pedido").range(de, de + lote - 1);
        if (error) throw error;
        lista = lista.concat(data);
        if (data.length < lote) break;
      }
    } catch (err) {
      $("sac-info").textContent = "";
      P.toast("Erro ao carregar: " + err.message, true);
      return;
    }
    linhas = lista;
    carregadoEm = Date.now();
    $("sac-info").textContent = `${fmt(linhas.length)} pedidos em aberto`;
    montarOpcoes();
    filtrar();
  }

  function montarOpcoes() {
    const preencher = (id, valores, rotulo) => {
      const sel = $(id);
      const atual = sel.value;
      const unicos = [...new Set(valores.filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));
      sel.innerHTML = `<option value="">${rotulo}</option>` + unicos.map((v) => `<option>${esc(v)}</option>`).join("");
      if (unicos.includes(atual)) sel.value = atual;
    };
    preencher("sac-canal", linhas.map((l) => l.canal), "Todos");
    preencher("sac-transp", linhas.map((l) => l.transportadora), "Todas");
  }

  function filtrar() {
    const busca = P.norm($("sac-busca").value);
    const canal = $("sac-canal").value;
    const transp = $("sac-transp").value;
    const nova = $("sac-nova").value;
    const hoje = P.hojeISO();
    filtrados = linhas.filter((l) =>
      (!busca || [l.nf, l.pedido].some((v) => P.norm(v).includes(busca))) &&
      (!canal || l.canal === canal) &&
      (!transp || l.transportadora === transp) &&
      (!nova ||
        (nova === "com" && l.nova_data) ||
        (nova === "sem" && !l.nova_data) ||
        (nova === "vencida" && (l.nova_data || l.previsao_entrega) && (l.nova_data || l.previsao_entrega) < hoje)));
    pagina = 1;
    desenhar();
  }

  function corData(d) {
    if (!d) return "cinza";
    const hoje = P.hojeISO();
    return d < hoje ? "vermelho" : d === hoje ? "ambar" : "verde";
  }

  function celulaNotas(l) {
    const notas = Array.isArray(l.anotacoes) ? l.anotacoes : [];
    if (!notas.length) return `<span class="secundario">—</span>`;
    const quando = (n) => new Date(n.criado_em).toLocaleDateString("pt-BR");
    const ult = notas[0];
    const resto = notas.slice(1);
    return `<div class="sac-nota">${esc(ult.texto)} <span class="secundario">(${quando(ult)})</span></div>` +
      (resto.length
        ? `<details class="sac-mais"><summary>+${resto.length} anterior${resto.length > 1 ? "es" : ""}</summary>` +
          resto.map((n) => `<div class="sac-nota">${esc(n.texto)} <span class="secundario">(${quando(n)})</span></div>`).join("") +
          `</details>`
        : "");
  }

  function desenhar() {
    const total = filtrados.length;
    const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
    pagina = Math.min(pagina, paginas);
    const fatia = filtrados.slice((pagina - 1) * POR_PAGINA, pagina * POR_PAGINA);
    $("sac-linhas").innerHTML = fatia.map((l) => {
      const nova = l.nova_data
        ? `<span class="chip ${corData(l.nova_data)}">${br(l.nova_data)}</span>
           <div class="secundario">${l.origem_nova_data === "Intelipost" ? "previsão alterada na Intelipost" : "informada pela transportadora"}</div>`
        : `<span class="secundario">—</span>`;
      return `<tr>
        <td class="num-data"><b>${esc(l.nf || "—")}</b></td>
        <td>${esc(l.pedido)}</td>
        <td>${esc(l.canal || "—")}</td>
        <td>${esc(l.transportadora || "—")}</td>
        <td class="num-data">${br(l.previsao_entrega) || "—"}</td>
        <td class="num-data">${nova}</td>
        <td class="obs">${celulaNotas(l)}</td>
        <td>${/^https?:\/\//i.test(l.link_rastreio || "") ? `<a href="${esc(l.link_rastreio)}" target="_blank" rel="noopener noreferrer">Acompanhar ↗</a>` : "—"}</td>
        <td>${celulaUrg(l)}</td>
      </tr>`;
    }).join("");
    $("sac-vazio").hidden = total > 0;
    $("sac-paginacao").innerHTML = total > POR_PAGINA
      ? `<button class="btn fantasma" data-p="-1" ${pagina === 1 ? "disabled" : ""}>‹ Anterior</button>
         <span>Página ${pagina} de ${paginas} · ${fmt(total)} pedidos</span>
         <button class="btn fantasma" data-p="1" ${pagina === paginas ? "disabled" : ""}>Próxima ›</button>`
      : total ? `<span>${fmt(total)} pedido${total > 1 ? "s" : ""}</span>` : "";
  }

  $("sac-paginacao").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-p]");
    if (!b) return;
    pagina += Number(b.dataset.p);
    desenhar();
    window.scrollTo({ top: $("sac-linhas").closest("section").offsetTop - 10, behavior: "smooth" });
  });
  ["sac-canal", "sac-transp", "sac-nova"].forEach((id) => $(id).addEventListener("change", filtrar));
  let espera;
  $("sac-busca").addEventListener("input", () => { clearTimeout(espera); espera = setTimeout(filtrar, 200); });

  $("sac-baixar").addEventListener("click", () => {
    const cab = ["Nota fiscal", "Pedido Intelipost", "Canal", "Transportadora", "Previsão de entrega", "Nova data informada",
      "Origem da nova data", "Anotações", "Rastreio"];
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const corpo = filtrados.map((l) => [l.nf, l.pedido, l.canal, l.transportadora, br(l.previsao_entrega), br(l.nova_data),
      l.origem_nova_data === "Intelipost" ? "previsão alterada na Intelipost" : l.nova_data ? "transportadora" : "",
      (l.anotacoes || []).map((n) => `${new Date(n.criado_em).toLocaleDateString("pt-BR")}: ${n.texto}`).join(" | "),
      l.link_rastreio].map(q).join(";"));
    const blob = new Blob(["﻿" + [cab.map(q).join(";")].concat(corpo).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `consulta_sac_${P.hojeISO()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  // ---------------- Usuários do SAC (Logística) ----------------
  async function mostrarUsuarios() {
    const { data, error } = await sb.from("usuarios_sac").select("email").order("email");
    if (error) {
      $("lista-sac").innerHTML = `<span class="secundario">Rode de novo o schema.sql no Supabase para liberar o perfil SAC.</span>`;
      return;
    }
    $("lista-sac").innerHTML = data.length
      ? data.map((u) => `<span class="chip-regra">${esc(u.email)}<button data-email="${esc(u.email)}" title="Tirar do SAC">×</button></span>`).join("")
      : `<span class="secundario">Nenhum e-mail marcado como SAC ainda.</span>`;
  }

  $("form-sac").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("sac-email").value.trim().toLowerCase();
    if (!email) return;
    if (email === $("usuario-email").textContent.trim().toLowerCase())
      return P.toast("Esse é o seu próprio login. Se marcar, você perde o acesso da Logística.", true);
    const { error } = await sb.from("usuarios_sac").upsert({ email });
    if (error) return P.toast("Não foi possível salvar: " + error.message, true);
    $("sac-email").value = "";
    P.toast(`${email} agora vê só a Consulta SAC.`);
    mostrarUsuarios();
  });

  $("lista-sac").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-email]");
    if (!b) return;
    if (!confirm(`Tirar ${b.dataset.email} do SAC? Ele passa a ver o painel como o perfil Consulta.`)) return;
    const { error } = await sb.from("usuarios_sac").delete().eq("email", b.dataset.email);
    if (error) return P.toast("Não foi possível remover: " + error.message, true);
    mostrarUsuarios();
  });

  // =================================================================
  // Urgências: o SAC pede, a Logística vê o alerta e resolve
  // =================================================================
  const MOTIVOS = ["Cliente muito insatisfeito", "Reclamação em site de reclamação", "Procon / órgão de defesa",
    "Cliente ameaça cancelar", "Prazo prometido ao cliente"];
  let perfil = null;
  let urgencias = [];
  let abertas = new Map();      // pedido -> urgência aberta
  let timer = null;
  let chaveAntes = "";

  const quando = (iso) => new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  function haQuanto(iso) {
    const min = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
    if (min < 60) return `há ${min} min`;
    const h = Math.round(min / 60);
    return h < 24 ? `há ${h} h` : `há ${Math.round(h / 24)} dia${h >= 48 ? "s" : ""}`;
  }

  async function carregarUrg() {
    const { data, error } = await sb.from("urgencias").select("*").order("criado_em", { ascending: false }).limit(500);
    if (error) return;   // schema ainda não rodado: sem urgências
    urgencias = data || [];
    abertas = new Map();
    urgencias.filter((u) => !u.resolvida_em).forEach((u) => { if (!abertas.has(u.pedido)) abertas.set(u.pedido, u); });
    desenharAlerta();
    if (perfil === "sac") { desenharMinhas(); if (linhas.length) desenhar(); }
    if (perfil === "logistica" && !$("aba-sac").hidden && linhas.length) desenhar();
  }

  function iniciar(p) {
    perfil = p;
    carregarUrg();
    clearInterval(timer);
    timer = setInterval(carregarUrg, 60000);
  }

  // ---- lado SAC ----
  function celulaUrg(l) {
    const u = abertas.get(l.pedido);
    if (u) return `<span class="chip vermelho" title="${esc(u.motivo)}">Urgência pedida</span><div class="secundario">${haQuanto(u.criado_em)}</div>`;
    if (perfil !== "sac") return `<span class="secundario">—</span>`;
    return `<button class="btn-urg" data-urg="${esc(l.pedido)}">🚨 Pedir urgência</button>`;
  }

  function desenharMinhas() {
    const recentes = urgencias.filter((u) => !u.resolvida_em || Date.now() - new Date(u.resolvida_em) < 7 * 864e5);
    $("sac-urg").hidden = !recentes.length;
    if (!recentes.length) return;
    const n = recentes.filter((u) => !u.resolvida_em).length;
    $("sac-urg").innerHTML = `<h2>Urgências pedidas</h2>
      <p class="sub">${n ? `${n} aguardando a Logística.` : "Nenhuma aguardando."} As resolvidas ficam aqui por 7 dias.</p>
      <div class="lista-urg">${recentes.map((u) => `
        <div class="item-urg ${u.resolvida_em ? "ok" : ""}">
          <div><b>${esc(u.pedido)}</b>${u.nf ? ` · NF ${esc(u.nf)}` : ""} · <span class="secundario">${quando(u.criado_em)} por ${esc(u.pedido_por)}</span></div>
          <div>${esc(u.motivo)}</div>
          ${u.resolvida_em
            ? `<div class="resposta-urg">✔ Resolvida em ${quando(u.resolvida_em)}${u.resposta ? `: ${esc(u.resposta)}` : ""}</div>`
            : `<div><span class="chip vermelho">Aguardando Logística</span></div>`}
        </div>`).join("")}</div>`;
  }

  $("sac-linhas").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-urg]");
    if (!b) return;
    const l = linhas.find((x) => x.pedido === b.dataset.urg);
    if (!l) return;
    window.Preventivo.abrirModal(`Pedir urgência · ${l.pedido}`, `
      <section class="cartao form-urg">
        <p><b>NF ${esc(l.nf || "—")}</b> · ${esc(l.transportadora || "")} · ${esc(l.canal || "")}</p>
        <p class="sub">A Logística vai ver um alerta no painel. Escolha o motivo e, se precisar, explique.</p>
        <div class="chips">${MOTIVOS.map((m) => `<button type="button" class="chip-regra clicavel" data-motivo="${esc(m)}">${esc(m)}</button>`).join("")}</div>
        <label>O que está acontecendo?<textarea id="urg-texto" rows="4" maxlength="1000" placeholder="Ex.: cliente já ligou 3 vezes, precisa receber até sexta"></textarea></label>
        <div class="modal-acoes"><span></span><button class="btn primario" id="urg-enviar" data-pedido="${esc(l.pedido)}">Enviar urgência</button></div>
      </section>`, false);
  });

  $("modal-corpo").addEventListener("click", async (e) => {
    const m = e.target.closest("button[data-motivo]");
    if (m) {
      const t = $("urg-texto");
      t.value = t.value.trim() ? `${m.dataset.motivo}. ${t.value.trim()}` : m.dataset.motivo + ". ";
      t.focus();
      return;
    }
    const env = e.target.closest("#urg-enviar");
    if (env) {
      const motivo = $("urg-texto").value.trim();
      if (!motivo) return P.toast("Escolha um motivo ou escreva o que está acontecendo.", true);
      const l = linhas.find((x) => x.pedido === env.dataset.pedido);
      env.disabled = true;
      const { error } = await sb.from("urgencias").insert({ pedido: l.pedido, nf: l.nf, motivo });
      env.disabled = false;
      if (error) return P.toast("Não foi possível enviar: " + error.message, true);
      window.Preventivo.fecharModal();
      P.toast("Urgência enviada para a Logística.");
      carregarUrg();
      return;
    }
    const res = e.target.closest("button[data-resolver]");
    if (res) {
      const id = Number(res.dataset.resolver);
      const resposta = ($("resp-urg-" + id).value || "").trim() || null;
      res.disabled = true;
      const { error } = await sb.from("urgencias").update({
        resolvida_em: new Date().toISOString(), resolvida_por: $("usuario-email").textContent, resposta,
      }).eq("id", id);
      if (error) { res.disabled = false; return P.toast("Erro: " + error.message, true); }
      P.toast("Urgência resolvida. O SAC vai ver a resposta.");
      await carregarUrg();
      abertas.size ? abrirUrgencias() : window.Preventivo.fecharModal();
      return;
    }
    const ab = e.target.closest("button[data-abrir-ped]");
    if (ab && !window.Preventivo.abrirPedidoPorNumero(ab.dataset.abrirPed))
      P.toast("Esse pedido não está na base atual da Intelipost (pode já ter sido entregue ou cancelado).", true);
  });

  // ---- lado Logística ----
  function desenharAlerta() {
    const n = abertas.size;
    const ver = perfil === "logistica" && n > 0;
    $("btn-urgencias").hidden = !ver;
    $("qtd-urg").textContent = `${n} urgência${n > 1 ? "s" : ""} do SAC`;
    $("pv-urg").hidden = !ver;
    if (ver) {
      const ult = [...abertas.values()][0];
      $("pv-urg").innerHTML = `<span class="sino">🚨</span>
        <div class="cresce"><b>O SAC está solicitando urgência em ${n} pedido${n > 1 ? "s" : ""}.</b>
          <div>Mais recente: ${esc(ult.pedido)} · ${esc(ult.motivo)} (${haQuanto(ult.criado_em)})</div></div>
        <button class="btn primario" id="pv-urg-ver">Ver urgências</button>`;
    }
    const chave = [...abertas.keys()].sort().join(",");
    if (chave !== chaveAntes) {   // só redesenha a tabela quando mudar algo (para não perder página/filtros)
      chaveAntes = chave;
      if (perfil === "logistica" && window.Preventivo && !$("aba-preventivo").hidden) window.Preventivo.redesenhar();
    }
  }

  function abrirUrgencias() {
    const lista = [...abertas.values()].sort((a, b) => a.criado_em.localeCompare(b.criado_em));
    window.Preventivo.abrirModal(`Urgências do SAC (${lista.length})`, `
      <p class="sub">Da mais antiga para a mais nova. Ao resolver, escreva o que foi feito: o SAC vê a resposta na tela dele.</p>
      <div class="lista-urg">${lista.map((u) => `
        <div class="item-urg">
          <div><b>${esc(u.pedido)}</b>${u.nf ? ` · NF ${esc(u.nf)}` : ""} · <span class="secundario">pedido por ${esc(u.pedido_por)} ${haQuanto(u.criado_em)} (${quando(u.criado_em)})</span></div>
          <div class="motivo-urg">${esc(u.motivo)}</div>
          <div class="acoes-urg">
            <input id="resp-urg-${u.id}" placeholder="Resposta para o SAC (opcional)" maxlength="500">
            <button class="btn primario" data-resolver="${u.id}">Marcar como resolvida</button>
            <button class="btn fantasma" data-abrir-ped="${esc(u.pedido)}">Abrir pedido</button>
          </div>
        </div>`).join("")}</div>`, false);
  }
  $("btn-urgencias").addEventListener("click", abrirUrgencias);
  $("pv-urg").addEventListener("click", (e) => { if (e.target.closest("#pv-urg-ver")) abrirUrgencias(); });

  window.SAC = { mostrar: () => carregar(false), mostrarUsuarios, iniciar, urgente: (ped) => abertas.has(ped) };
})();
