// =====================================================================
// Painel Preventivo (base Intelipost + responsável por micro status)
// =====================================================================
(function () {
  "use strict";
  const P = window.Painel;
  const { sb, PAD, $, esc, br, toast } = P;
  const POR_PAGINA = 50;
  const PENDENTE = "Pendente de responsável";
  const CORES = ["#2f6fdb", "#e07b00", "#1f8a4c", "#7b4fd6", "#0f9aa8", "#c2417a", "#6b7a00", "#a15c00"];

  let carregado = false, carregando = null;
  let pedidos = [];          // base intelipost (em aberto)
  let micro = new Map();     // chave -> {chave, nome, responsavel_id}
  let resps = [];            // [{id, nome, area}]
  let info = null;           // intelipost_info
  let filtrados = [];
  let pagina = 1;

  const chave = (t) => PAD.normalizar(t);
  const fmt = (n) => Number(n || 0).toLocaleString("pt-BR");
  const pct = (a, b) => (b ? ((a / b) * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + "%" : "–");

  // ---------------- ranges de vencimento ----------------
  const RANGES = [
    { id: "vencido30", nome: "Vencido há mais de 30 dias", cor: "vermelho", teste: (d) => d > 30 },
    { id: "vencido21", nome: "Vencido de 21 a 30 dias", cor: "vermelho", teste: (d) => d >= 21 && d <= 30 },
    { id: "vencido11", nome: "Vencido de 11 a 20 dias", cor: "vermelho", teste: (d) => d >= 11 && d <= 20 },
    { id: "vencido6", nome: "Vencido de 6 a 10 dias", cor: "vermelho", teste: (d) => d >= 6 && d <= 10 },
    { id: "vencido1", nome: "Vencido de 1 a 5 dias", cor: "vermelho", teste: (d) => d >= 1 && d <= 5 },
    { id: "hoje", nome: "Vence hoje", cor: "ambar", teste: (d) => d === 0 },
    { id: "risco", nome: "Vence em 1 a 3 dias", cor: "ambar", teste: (d) => d >= -3 && d <= -1 },
    { id: "prazo", nome: "No prazo (mais de 3 dias)", cor: "verde", teste: (d) => d < -3 },
    { id: "sem", nome: "Sem previsão", cor: "cinza", teste: () => false },
  ];
  function diasEntre(isoA, isoB) {
    return Math.round((Date.parse(isoA + "T12:00:00Z") - Date.parse(isoB + "T12:00:00Z")) / 86400000);
  }

  // ---------------- dados ----------------
  async function carregar(forcar) {
    if (carregado && !forcar) return;
    if (carregando) return carregando;
    carregando = (async () => {
      $("pv-info").textContent = "Carregando…";
      try {
        const [ps, ms, rs, inf] = await Promise.all([
          P.buscarTudo("intelipost", "*", (q) => q.order("pedido")),
          P.buscarTudo("micro_status", "*", (q) => q.order("nome")),
          P.buscarTudo("responsaveis", "*", (q) => q.order("nome")),
          sb.from("intelipost_info").select("*").limit(1),
        ]);
        pedidos = ps;
        micro = new Map(ms.map((m) => [m.chave, m]));
        resps = rs;
        info = inf.data && inf.data[0];
        carregado = true;
      } catch (err) {
        toast("Erro ao carregar o preventivo: " + err.message, true);
      } finally {
        carregando = null;
      }
    })();
    return carregando;
  }

  function respDe(p) {
    const m = micro.get(chave(p.micro_status));
    if (!m || !m.responsavel_id) return null;
    return resps.find((r) => r.id === m.responsavel_id) || null;
  }
  const corResp = (r) => (r ? CORES[resps.findIndex((x) => x.id === r.id) % CORES.length] : "#9aa3b2");
  const nomeResp = (r) => (r ? r.nome + (r.area ? ` (${r.area})` : "") : PENDENTE);

  // prepara os campos calculados de cada pedido
  function preparar() {
    const hoje = P.hojeISO();
    const ult = P.ultimos;
    for (const p of pedidos) {
      const u = ult.get(p.pedido);
      p._ult = u;
      p._resp = respDe(p);
      // nova data: a que a transportadora informou; senão a previsão alterada na Intelipost
      if (u && u.nova_data) { p._nova = u.nova_data; p._novaFonte = "transportadora"; }
      else if (p.prev_cliente && p.prev_cliente_original && p.prev_cliente !== p.prev_cliente_original) {
        p._nova = p.prev_cliente; p._novaFonte = "Intelipost";
      } else { p._nova = null; p._novaFonte = null; }
      const ref = p._nova || p.prev_cliente || p.prev_cliente_original;
      p._dias = ref ? diasEntre(hoje, ref) : null;
      p._range = ref ? RANGES.find((r) => r.teste(p._dias)) : RANGES[RANGES.length - 1];
      if (u) {
        const cat = PAD.categorizar(u.texto, P.grupos);
        p._sitRet = cat || u.texto;
        p._sitCat = !!cat;
      } else { p._sitRet = null; p._sitCat = false; }
    }
  }

  // ---------------- tela ----------------
  async function mostrar() {
    await carregar();
    redesenhar();
  }

  function redesenhar() {
    if (!carregado) return;
    preparar();
    const env = info ? new Date(info.enviado_em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : null;
    $("pv-info").textContent = env ? `Base Intelipost de ${env}` : "Ainda não há base da Intelipost. A Logística precisa enviar.";
    montarOpcoes();
    filtrar();
  }

  function montarOpcoes() {
    const preencher = (sel, opcoes, rotuloTodos) => {
      const atual = sel.value;
      sel.innerHTML = `<option value="">${rotuloTodos}</option>` +
        opcoes.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join("");
      sel.value = opcoes.some(([v]) => v === atual) ? atual : "";
    };
    const unicos = (f) => [...new Set(pedidos.map(f).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));
    preencher($("pv-transp"), unicos((p) => p.transportadora).map((v) => [v, v]), "Todas");
    preencher($("pv-micro"), unicos((p) => p.micro_status).map((v) => [v, v]), "Todos");
    preencher($("pv-respf"), [["__pend", PENDENTE]].concat(resps.map((r) => [String(r.id), nomeResp(r)])), "Todos");
    preencher($("pv-rangef"), [["__risco", "Em risco (vence hoje até 3 dias)"], ["__vencido", "Todos os vencidos"]]
      .concat(RANGES.map((r) => [r.id, r.nome])), "Todos");
  }

  function filtrar() {
    const busca = P.norm($("pv-busca").value);
    const transp = $("pv-transp").value, mic = $("pv-micro").value, rf = $("pv-respf").value, rg = $("pv-rangef").value;
    const base = pedidos.filter((p) =>
      (!busca || [p.nf, p.pedido, p.pedido_venda].some((v) => P.norm(v).includes(busca))) &&
      (!transp || p.transportadora === transp) &&
      (!mic || p.micro_status === mic));
    desenharCards(base);
    desenharResp(base);
    const comResp = base.filter((p) => !rf || (rf === "__pend" ? !p._resp : p._resp && String(p._resp.id) === rf));
    desenharRange(comResp, rg);
    filtrados = comResp.filter((p) => !rg ||
      (rg === "__risco" ? ["hoje", "risco"].includes(p._range.id)
        : rg === "__vencido" ? p._range.id.startsWith("vencido") : p._range.id === rg));
    // mais atrasados primeiro, depois os que vencem antes
    filtrados.sort((a, b) => (b._dias ?? -9999) - (a._dias ?? -9999) || a.pedido.localeCompare(b.pedido));
    pagina = 1;
    desenharTabela();
  }

  function desenharCards(base) {
    const risco = base.filter((p) => ["hoje", "risco"].includes(p._range.id)).length;
    const vencidos = base.filter((p) => p._range.id.startsWith("vencido")).length;
    const pend = base.filter((p) => !p._resp).length;
    const r = (info && info.resumo) || {};
    const cards = [
      ["", "Pedidos em aberto", fmt(base.length), ""],
      ["__risco", "Em risco de atraso", fmt(risco), pct(risco, base.length)],
      ["__vencido", "Já vencidos", fmt(vencidos), pct(vencidos, base.length)],
      ["__pend", PENDENTE, fmt(pend), pct(pend, base.length)],
      [null, "Entregues no prazo", fmt(r.entregues_no_prazo), r.entregues ? pct(r.entregues_no_prazo, r.entregues) + " dos entregues" : ""],
    ];
    const atual = $("pv-rangef").value || ($("pv-respf").value === "__pend" ? "__pend" : "");
    $("pv-cards").innerHTML = cards.map(([v, rot, n, sub]) =>
      `<button class="card-resumo${v !== null && v === atual ? " ativo" : ""}${v === null ? " estatico" : ""}" ${v === null ? "disabled" : `data-pv="${v}"`}>
         <span class="num">${n}</span><span class="rot">${esc(rot)}${sub ? ` · <b>${sub}</b>` : ""}</span></button>`).join("");
  }
  $("pv-cards").addEventListener("click", (e) => {
    const b = e.target.closest("[data-pv]");
    if (!b) return;
    const v = b.dataset.pv;
    $("pv-respf").value = v === "__pend" ? "__pend" : "";
    $("pv-rangef").value = v === "__pend" ? "" : v;
    filtrar();
  });

  function desenharRange(base, ativo) {
    const total = base.length;
    const linhas = RANGES.map((r) => ({ r, n: base.filter((p) => p._range.id === r.id).length })).filter((x) => x.n || x.r.id !== "sem");
    const max = Math.max(1, ...linhas.map((x) => x.n));
    $("pv-range").innerHTML = linhas.map(({ r, n }) => `
      <tr class="clicavel${ativo === r.id ? " ativo" : ""}" data-range="${r.id}">
        <td><span class="ponto ${r.cor}"></span>${esc(r.nome)}</td>
        <td class="num-data"><b>${fmt(n)}</b></td><td class="num-data">${pct(n, total)}</td>
        <td class="barra-cel"><span class="barra ${r.cor}" style="width:${(n / max) * 100}%"></span></td></tr>`).join("") +
      `<tr class="total"><td>Total</td><td class="num-data"><b>${fmt(total)}</b></td><td></td><td></td></tr>`;
  }
  $("pv-range").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-range]");
    if (!tr) return;
    $("pv-rangef").value = $("pv-rangef").value === tr.dataset.range ? "" : tr.dataset.range;
    filtrar();
  });

  function desenharResp(base) {
    const cont = new Map();
    base.forEach((p) => {
      const k = p._resp ? String(p._resp.id) : "__pend";
      cont.set(k, (cont.get(k) || 0) + 1);
    });
    const itens = resps.map((r) => [String(r.id), nomeResp(r), corResp(r), cont.get(String(r.id)) || 0])
      .concat([["__pend", PENDENTE, "#9aa3b2", cont.get("__pend") || 0]]);
    const atual = $("pv-respf").value;
    $("pv-resp").innerHTML = itens.map(([id, nome, cor, n]) =>
      `<li><button class="${id === atual ? "ativo" : ""}" data-resp="${id}"><span class="ponto" style="background:${cor}"></span>
        <span class="nome">${esc(nome)}</span><b>${fmt(n)}</b></button></li>`).join("") +
      (resps.length ? "" : `<li class="secundario">Nenhum responsável cadastrado ainda${P.ehAdmin ? " (aba Responsáveis)" : ""}.</li>`);
  }
  $("pv-resp").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-resp]");
    if (!b) return;
    $("pv-respf").value = $("pv-respf").value === b.dataset.resp ? "" : b.dataset.resp;
    filtrar();
  });

  let timer;
  $("pv-busca").addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(filtrar, 200); });
  ["pv-transp", "pv-micro", "pv-respf", "pv-rangef"].forEach((id) => $(id).addEventListener("change", filtrar));

  function desenharTabela() {
    const total = filtrados.length;
    const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
    pagina = Math.min(pagina, paginas);
    const fatia = filtrados.slice((pagina - 1) * POR_PAGINA, pagina * POR_PAGINA);
    $("pv-linhas").innerHTML = fatia.map((p) => {
      const r = p._resp;
      const nova = p._nova
        ? `<span class="chip ${p._range.cor}">${br(p._nova)}</span><div class="secundario">${p._novaFonte === "Intelipost" ? "previsão alterada na Intelipost" : "informada pela transportadora"}</div>`
        : `<span class="secundario">—</span>`;
      const dias = p._dias === null ? "" : p._dias > 0 ? `vencido há ${p._dias} dia${p._dias > 1 ? "s" : ""}`
        : p._dias === 0 ? "vence hoje" : `vence em ${-p._dias} dia${p._dias < -1 ? "s" : ""}`;
      const sit = p._ult
        ? `${p._sitCat ? `<span class="chip azul">${esc(p._sitRet)}</span>` : esc(p._sitRet)}
           <div class="secundario">retorno de ${br(p._ult.data_retorno)}</div>`
        : `<span class="secundario">Sem retorno</span>`;
      return `<tr>
        <td class="num-data"><b>${esc(p.nf || "—")}</b></td>
        <td><div class="principal">${esc(p.pedido)}</div><div class="secundario">${esc(p.canal || "")}</div></td>
        <td>${esc(p.transportadora || "—")}<div class="secundario">${esc([p.cidade, p.uf].filter(Boolean).join(" / "))}</div></td>
        <td class="num-data">${br(p.prev_cliente_original) || "—"}<div class="secundario">${dias}</div></td>
        <td class="num-data">${nova}</td>
        <td><span class="chip-ms" style="--cor:${corResp(r)}">${esc(p.micro_status || "—")}</span>
            ${p.data_ultimo_status ? `<div class="secundario">desde ${br(p.data_ultimo_status)}</div>` : ""}</td>
        <td><span class="resp"><span class="ponto" style="background:${corResp(r)}"></span>
            <span>${r ? esc(r.nome) : `<span class="pendente">${PENDENTE}</span>`}${r && r.area ? `<span class="secundario"> ${esc(r.area)}</span>` : ""}</span></span></td>
        <td class="obs">${sit}</td>
        <td>${/^https?:\/\//i.test(p.link_rastreio || "") ? `<a href="${esc(p.link_rastreio)}" target="_blank" rel="noopener noreferrer">Acompanhar ↗</a>` : "—"}</td>
      </tr>`;
    }).join("");
    $("pv-vazio").hidden = total > 0;
    $("pv-paginacao").innerHTML = total > POR_PAGINA
      ? `<button class="btn fantasma" data-p="-1" ${pagina === 1 ? "disabled" : ""}>‹ Anterior</button>
         <span>Página ${pagina} de ${paginas} · ${fmt(total)} pedidos</span>
         <button class="btn fantasma" data-p="1" ${pagina === paginas ? "disabled" : ""}>Próxima ›</button>`
      : `<span>${fmt(total)} pedidos</span>`;
  }
  $("pv-paginacao").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-p]");
    if (!b) return;
    pagina += Number(b.dataset.p);
    desenharTabela();
    window.scrollTo({ top: $("pv-linhas").closest("section").offsetTop - 10, behavior: "smooth" });
  });

  $("pv-baixar").addEventListener("click", () => {
    const cab = ["NF", "Pedido Intelipost", "Pedido de venda", "Canal", "Transportadora", "Previsão original", "Nova data informada",
      "Origem da nova data", "Vencimento", "Micro status", "Responsável", "Situação último retorno", "Data do retorno", "Cidade", "UF", "Rastreio"];
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const linhas = filtrados.map((p) => [p.nf, p.pedido, p.pedido_venda, p.canal, p.transportadora, br(p.prev_cliente_original),
      br(p._nova), p._novaFonte, p._range.nome, p.micro_status, nomeResp(p._resp), p._sitRet,
      br(p._ult && p._ult.data_retorno), p.cidade, p.uf, p.link_rastreio].map(q).join(";"));
    const blob = new Blob(["﻿" + [cab.map(q).join(";")].concat(linhas).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `preventivo_${P.hojeISO()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  // =================================================================
  // Envio da base da Intelipost (Logística)
  // =================================================================
  function infoEnvio() {
    carregar().then(() => {
      $("info-intelipost").textContent = info
        ? `Última base: ${info.arquivo || ""} (${new Date(info.enviado_em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}) · ${fmt(pedidos.length)} pedidos em aberto.`
        : "Nenhuma base enviada ainda.";
    });
  }

  $("arq-intelipost").addEventListener("change", (e) => {
    const arq = e.target.files[0];
    e.target.value = "";
    if (!arq) return;
    const prog = $("progresso-intelipost");
    prog.hidden = false;
    prog.textContent = "Lendo o arquivo… (pode levar uns segundos)";
    const worker = new Worker("leitor-intelipost.js");
    arq.arrayBuffer().then((buf) => worker.postMessage(buf, [buf]));
    worker.onerror = (err) => { prog.textContent = ""; toast("Não consegui ler o arquivo: " + (err.message || "erro"), true); worker.terminate(); };
    worker.onmessage = async (msg) => {
      const d = msg.data;
      if (d.etapa) { prog.textContent = d.etapa; return; }
      worker.terminate();
      if (d.erro) { prog.hidden = true; toast(d.erro, true); return; }
      const { abertos, resumo } = d;
      const novos = [...new Set(abertos.map((p) => p.micro_status).filter(Boolean))].filter((m) => !micro.has(chave(m)));
      prog.hidden = true;
      const ok = confirm(
        `Base da Intelipost: ${arq.name}\n\n` +
        `${fmt(resumo.total)} pedidos no arquivo\n` +
        `${fmt(resumo.entregues)} entregues e ${fmt(resumo.cancelados)} cancelados (ficam de fora)\n` +
        `${fmt(abertos.length)} pedidos em aberto vão para o painel\n` +
        (novos.length ? `\n${novos.length} micro status novo(s) vão entrar como "${PENDENTE}":\n- ${novos.slice(0, 10).join("\n- ")}\n` : "") +
        `\nIsso substitui a base anterior. Enviar?`);
      if (!ok) return;
      prog.hidden = false;
      const LOTE = 2000;
      try {
        for (let i = 0; i < Math.max(1, abertos.length); i += LOTE) {
          prog.textContent = `Enviando… ${fmt(Math.min(i + LOTE, abertos.length))} de ${fmt(abertos.length)}`;
          const { error } = await sb.rpc("importar_intelipost", {
            linhas: abertos.slice(i, i + LOTE), limpar: i === 0, arquivo: arq.name, resumo });
          if (error) throw error;
        }
      } catch (err) {
        prog.hidden = true;
        toast("Erro ao enviar a base: " + err.message + ". Tente de novo.", true);
        return;
      }
      prog.hidden = true;
      toast(`Pronto! ${fmt(abertos.length)} pedidos em aberto no preventivo.` +
        (novos.length ? ` ${novos.length} micro status novo(s) sem responsável.` : ""));
      await carregar(true);
      infoEnvio();
    };
  });

  // =================================================================
  // Responsáveis (Logística)
  // =================================================================
  async function mostrarResponsaveis() {
    await carregar();
    desenharResponsaveis();
  }
  function desenharResponsaveis() {
    $("lista-resp").innerHTML = resps.length ? resps.map((r) =>
      `<span class="chip-regra"><span class="ponto" style="background:${corResp(r)}"></span>${esc(nomeResp(r))}
        <button data-del-resp="${r.id}" aria-label="Remover ${esc(r.nome)}">×</button></span>`).join("")
      : `<p class="secundario">Cadastre as pessoas ou áreas que vão cuidar dos micro status.</p>`;

    const cont = new Map();
    pedidos.forEach((p) => { const k = chave(p.micro_status); cont.set(k, (cont.get(k) || 0) + 1); });
    const lista = [...micro.values()].sort((a, b) =>
      (a.responsavel_id ? 1 : 0) - (b.responsavel_id ? 1 : 0) || (cont.get(b.chave) || 0) - (cont.get(a.chave) || 0) ||
      a.nome.localeCompare(b.nome, "pt-BR"));
    const pend = lista.filter((m) => !m.responsavel_id).length;
    $("qtd-pendentes").textContent = pend ? `${pend} pendentes` : "";
    const opcoes = (sel) => `<option value="">${PENDENTE}</option>` +
      resps.map((r) => `<option value="${r.id}" ${r.id === sel ? "selected" : ""}>${esc(nomeResp(r))}</option>`).join("");
    $("tabela-micro").innerHTML = lista.map((m) => `
      <tr class="${m.responsavel_id ? "" : "linha-pendente"}">
        <td>${esc(m.nome)}</td><td class="num-data">${fmt(cont.get(m.chave) || 0)}</td>
        <td><select data-ms="${esc(m.chave)}">${opcoes(m.responsavel_id)}</select></td></tr>`).join("");
  }

  $("tabela-micro").addEventListener("change", async (e) => {
    const sel = e.target.closest("select[data-ms]");
    if (!sel) return;
    const id = sel.value ? Number(sel.value) : null;
    const { error } = await sb.from("micro_status").update({ responsavel_id: id }).eq("chave", sel.dataset.ms);
    if (error) { toast("Erro: " + error.message, true); return; }
    const m = micro.get(sel.dataset.ms);
    if (m) m.responsavel_id = id;
    toast("Responsável salvo.");
    desenharResponsaveis();
  });

  $("form-resp").addEventListener("submit", async (e) => {
    e.preventDefault();
    const nome = $("resp-nome").value.trim(), area = $("resp-area").value.trim() || null;
    if (!nome) return;
    const { error } = await sb.from("responsaveis").insert({ nome, area });
    if (error) { toast(/duplicate|unique/i.test(error.message) ? "Já existe um responsável com esse nome." : "Erro: " + error.message, true); return; }
    $("resp-nome").value = ""; $("resp-area").value = "";
    await carregar(true);
    desenharResponsaveis();
  });

  $("lista-resp").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-del-resp]");
    if (!b) return;
    if (!confirm("Remover esse responsável? Os micro status dele voltam para \"Pendente de responsável\".")) return;
    const { error } = await sb.from("responsaveis").delete().eq("id", Number(b.dataset.delResp));
    if (error) { toast("Erro: " + error.message, true); return; }
    await carregar(true);
    desenharResponsaveis();
  });

  window.Preventivo = { mostrar, redesenhar, infoEnvio, mostrarResponsaveis };
})();
