// Barrar entrega: planilha de tickets "Barrar entrega" → robô confere rastreio + portal e sugere ✓/✗ → Logística aprova → robô aplica no portal.
(function () {
  const $ = (id) => document.getElementById(id);
  if (!$("pagina-barrar")) return;
  const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
  const sem0 = (t) => String(t ?? "").trim().replace(/\.0+$/, "").replace(/^0+(?=\d)/, "");
  const fmt = (n) => Number(n || 0).toLocaleString("pt-BR");
  const br = (d) => (d ? new Date(String(d).length <= 10 ? d + "T12:00:00" : d).toLocaleDateString("pt-BR") : "");
  const hora = (d) => (d ? new Date(d).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "");
  const toast = (msg, erro) => { const t = $("toast"); if (!t) return alert(msg); t.textContent = msg; t.classList.toggle("erro", !!erro); t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), erro ? 6000 : 3500); };
  const sb = () => { const c = window.__sb; if (!c) throw new Error("Entre no painel de novo (sessão expirada)."); return c; };
  const OP = ["Entregue", "Avaria", "Extravio", "Falta Parcial", "Sem Emissão em Sistema / Material Não Recebido"];

  let L = [], H = [], info = null, ok = true, card = "todos", marcadas = new Set(), urls = new Map(), carregou = false;
  const SUG = { barrar: "Barrar ✓", nao_barrar: "Não barrar ✗", manual: "Erro: verificar" };
  const sit = (x) => (x.portal_status === "feito" ? "feito" : x.portal_status === "erro" ? "erro" : x.decisao ? "aprovado" : !x.conferido_em ? "robo" : x.sugestao === "nao_barrar" ? (x.sugestao_opcao === "Entregue" ? "nb_entregue" : "nb_naorec") : x.sugestao || "manual");
  const CARDS = [["barrar", "Barrar ✓", "status atual: devolução", "verde"], ["nb_entregue", "Não barrar ✗ · Entregue", "entregue no rastreio", "vermelho"], ["nb_naorec", "Não barrar ✗ · Não recebido", "anotação: transportadora não recebeu", "vermelho"],
    ["manual", "Erro: verificar", "nada no rastreio ou ticket sem transportadora", "laranja"], ["difer", "Transportadora diferente", "rastreio × portal", "roxo"], ["robo", "Aguardando o robô", "ainda não conferidas", ""],
    ["aprovado", "Aprovadas", "vão para o portal", "azul"], ["feito", "Feitas no portal", "✓/✗ já clicado", "verde"], ["erro", "Erro no portal", "", "vermelho"], ["todos", "Todas", "da última planilha", ""]];
  const passa = (x) => {
    if (card === "difer") { if (x.mesma_transp !== false) return false; } else if (card !== "todos" && sit(x) !== card) return false;
    const t = $("br-transp").value; if (t && (x.transp_pedido || "") !== t) return false;
    const q = norm($("br-busca").value).split(/[\s,;]+/).filter(Boolean);
    return !q.length || q.some((b) => norm(x.nf).includes(b) || norm(x.ticket).includes(b));
  };

  // histórico: notas já aplicadas no portal agrupadas por rodada (intervalo > 15 min = outro envio)
  const ehAuto = (x) => /^rob/i.test(x.decisao_por || "");
  function desenharEnvios() {
    const F = (H.length ? H : L).filter((x) => x.portal_status && x.portal_em).sort((a, b) => String(b.portal_em).localeCompare(String(a.portal_em)));
    const G = []; for (const x of F) { const g = G[G.length - 1]; if (g && Date.parse(g.ini) - Date.parse(x.portal_em) < 15 * 60e3) { g.L.push(x); g.ini = x.portal_em; } else G.push({ fim: x.portal_em, ini: x.portal_em, L: [x] }); }
    const qd = (d) => new Date(d).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
    const tab = (rs) => `<div class="tabela-wrap"><table class="tabela-pedidos"><thead><tr><th>Nota / ticket</th><th>Decisão</th><th>Quem aprovou</th><th>Portal</th><th>Ticket 360</th><th>Horário</th></tr></thead><tbody>${rs.map((x) => `<tr>
      <td><b>${esc(x.nf)}</b>${x.ticket ? `<div><a href="https://appv2.360multi.com/tickets/${encodeURIComponent(x.ticket)}" target="_blank" rel="noopener noreferrer" title="Abrir o ticket no Multi360">#${esc(x.ticket)}</a></div>` : ""}</td>
      <td><span class="chip ${x.decisao === "barrar" ? "verde" : "vermelho"}">${SUG[x.decisao] || ""}</span>${x.decisao_opcao ? `<div class="s">${esc(x.decisao_opcao)}</div>` : ""}</td>
      <td>${ehAuto(x) ? `<span class="chip azul">robô · entregue automático</span>` : esc((x.decisao_por || "").split("@")[0])}</td>
      <td>${x.portal_status === "feito" ? "✓ feito" : `<span class="txt-vermelho">⚠ ${esc(x.portal_msg || "erro")}</span>`}</td>
      <td>${x.ticket_status === "feito" ? "✓ prints" : x.ticket_status === "erro" ? `<span class="txt-vermelho">⚠ ${esc(x.ticket_msg || "")}</span>` : "—"}</td>
      <td class="s">${qd(x.portal_em)}</td></tr>`).join("")}</tbody></table></div>`;
    $("br-envios").innerHTML = G.length ? G.map((g) => { const a = g.L.filter(ehAuto), h = g.L.filter((x) => !ehAuto(x)), er = g.L.filter((x) => x.portal_status !== "feito");
      const quem = [...new Set(h.map((x) => (x.decisao_por || "").split("@")[0]).filter(Boolean))].join(", ");
      return `<details class="br-envio"><summary><b>${qd(g.ini)}${g.ini !== g.fim ? " – " + new Date(g.fim).toLocaleTimeString("pt-BR", { timeStyle: "short" }) : ""}</b> · ${fmt(g.L.length)} nota(s)
        ${h.length ? ` · <span class="chip cinza">${fmt(h.length)} aprovada(s)${quem ? " por " + esc(quem) : ""}</span>` : ""}${a.length ? ` · <span class="chip azul">${fmt(a.length)} entregue(s) pelo robô sozinho</span>` : ""}${er.length ? ` · <span class="chip vermelho">${fmt(er.length)} com erro</span>` : ""}</summary>
        ${h.length && a.length ? `<h3 class="br-envio-h">Aprovadas por você</h3>${tab(h)}<h3 class="br-envio-h">Feitas pelo robô sozinho (entregue)</h3>${tab(a)}` : tab(g.L)}</details>`; }).join("")
      : `<p class="s">Nenhuma nota enviada ao portal ainda.</p>`;
  }

  let assinatura = "";
  async function carregar(auto) {
    try {
      const out = []; for (let de = 0; ; de += 1000) { const { data, error } = await sb().from("barrar_entrega").select("*").eq("na_planilha", true).order("ticket_criado", { ascending: true }).range(de, de + 999); if (error) throw error; out.push(...data); if (data.length < 1000) break; }
      const hs = await (async () => { try { return await sb().from("barrar_entrega").select("nf,ticket,decisao,decisao_opcao,decisao_por,portal_status,portal_msg,portal_em,ticket_status,ticket_msg").not("portal_status", "is", null).order("portal_em", { ascending: false }).limit(2000); } catch (_) { return { error: true }; } })();
      H = hs.error ? [] : hs.data || [];
      const inf = await sb().from("barrar_info").select("*").limit(1);
      // atualização automática (a cada 30 s): se nada mudou, não redesenha (não mexe na rolagem de quem está lendo)
      const sig = JSON.stringify([out, H, (inf.data || [])[0] || null]);
      if (auto && sig === assinatura && ok) return; assinatura = sig;
      L = out; info = (inf.data || [])[0] || null; ok = true;
    } catch (e) { ok = false; L = []; $("br-info").textContent = /barrar_entrega|does not exist|schema cache/i.test(e.message || "") ? "Para usar esta aba, rode a parte 49 no Supabase." : "Não consegui carregar: " + (e.message || e); }
    carregou = true; desenhar();
  }
  function desenhar() {
    if (!ok) return;
    $("br-info").textContent = info ? `Planilha: ${info.arquivo || ""} · ${hora(info.enviado_em)}${info.enviado_por ? " por " + info.enviado_por.split("@")[0] : ""} · ${fmt(L.length)} notas` : "Nenhuma planilha enviada ainda.";
    const tps = [...new Set(L.map((x) => x.transp_pedido || ""))].filter(Boolean).sort((a, b) => a.localeCompare(b, "pt-BR")), atual = $("br-transp").value;
    $("br-transp").innerHTML = `<option value="">Todas</option>` + tps.map((t) => `<option${t === atual ? " selected" : ""}>${esc(t)}</option>`).join("");
    const n = (k) => (k === "todos" ? L.length : k === "difer" ? L.filter((x) => x.mesma_transp === false).length : L.filter((x) => sit(x) === k).length);
    $("br-cards").innerHTML = CARDS.map(([k, rot, sub, cor]) => `<button type="button" class="kpi ${cor}${card === k ? " ativa" : ""}" data-br="${k}"><span class="kpi-rot">${rot}</span><b class="kpi-num">${fmt(n(k))}</b><small>${sub}</small><i>↗</i></button>`).join("");
    const V = L.filter(passa);
    $("br-titulo").textContent = `${CARDS.find((c) => c[0] === card)[1]} (${fmt(V.length)})`;
    $("br-linhas").innerHTML = V.map(linha).join("") || `<tr><td colspan="8" class="vazio">Nenhuma nota aqui.</td></tr>`;
    const nm = [...marcadas].filter((nf) => L.some((x) => x.nf === nf)).length;
    $("br-aprovar").textContent = `Aprovar sugestão (${nm})`; $("br-aprovar").disabled = !nm; $("br-desfazer").disabled = !nm;
    $("br-todos").checked = V.length > 0 && V.every((x) => marcadas.has(x.nf));
    desenharEnvios(); desenharErroTransp();
    const aprov = L.filter((x) => x.decisao && !x.portal_status).length;
    $("br-portal").textContent = `Mandar para o portal (${aprov})`; $("br-portal").disabled = !aprov;
  }
  // "Erro: verificar" = rastreio sem devolução/entrega e sem anotação: a transportadora não atuou.
  // Quadrinhos por transportadora (a do ticket 360: redespacho, senão a transportadora; senão a do pedido) com Excel e mensagem para o WhatsApp.
  // um quadrinho por transportadora (Brenda 23/11): junta os métodos (Dominalog - Filial SP, Dominalog Express…) e deixa só o nome
  const NOME_BASE = [[/dominalog/i, "Dominalog"], [/\btsl\b/i, "TSL"], [/tempo\s*justo|^\s*vm\b|vm\s+transportes/i, "Tempo Justo"], [/zelog/i, "Zelog"], [/jadlog/i, "Jadlog"],
    [/transiga/i, "Transiga"], [/trans\s*sua/i, "Trans Sua"], [/aceville/i, "Aceville"], [/atual\s*cargas/i, "Atual Cargas"], [/bento\s*brasil/i, "Bento Brasil"], [/formato/i, "Formato"],
    [/tr[aâ]nsito\s*brasil/i, "Trânsito Brasil"], [/petrymar/i, "Petrymar"], [/transcai/i, "Transcai"], [/flog\b/i, "Flog"], [/zafer/i, "Zafer"], [/prolog/i, "Prolog"], [/r[aá]pido\s*al[eé]m/i, "Rápido Além Paraíba"]];
  function nomeBase(t) {
    t = String(t || "").trim(); if (!t) return "";
    const k = NOME_BASE.find(([re]) => re.test(t)); if (k) return k[1];
    let n = t.split(/\s+-\s+|\(|\//)[0].trim();
    n = n.replace(/\b(standard|express[oa]?|econ[oô]mic[oa]|filial\s+\w+|ltda|eireli|s\.?\/?a\.?|me|transportes?|log[ií]sticas?|opera[cç][oõ]es|transportadora|solu[cç][oõ]es)\b\.?/gi, " ").replace(/\s+/g, " ").trim().replace(/(\s+e)+$/i, "");
    return n || t;
  }
  window.__nomeTranspBase = nomeBase;   // faltas.js usa o mesmo agrupamento
  const alvoTransp = (x) => { const r = x.rastreio || {}; return nomeBase(r.redesp_ticket || r.transp_ticket || x.transp_pedido) || "(sem transportadora no ticket)"; };
  const diasDesde = (d) => (d ? Math.max(0, Math.floor((Date.now() - Date.parse(String(d).replace(" ", "T"))) / 864e5)) : null);
  const ultStatus = (x) => { const r = x.rastreio || {}; return r.evento ? `${r.evento}${r.data_evento ? " em " + br(r.data_evento) : ""}` : r.situacao && !/^erro/i.test(r.situacao) ? r.situacao : "sem informação no rastreio"; };
  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
  function gruposErro() {
    // só as que ainda não têm decisão aprovada; cada nota uma vez só
    const m = new Map(), vistas = new Set();
    L.filter((x) => sit(x) === "manual").forEach((x) => { if (vistas.has(x.nf)) return; vistas.add(x.nf); const t = alvoTransp(x); m.set(t, (m.get(t) || []).concat(x)); });
    return [...m.entries()].map(([t, xs]) => [t, xs.sort((a, b) => (diasDesde(b.ticket_criado) ?? -1) - (diasDesde(a.ticket_criado) ?? -1))]).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], "pt-BR"));
  }
  function msgTransp(t, xs) {   // texto limpo (Brenda 23/11): cabeçalho curto + uma linha por nota com dias e último status
    return `Olá, ${t}! Estamos com ${plural(xs.length, "nota pendente", "notas pendentes")} de barrar. Conseguimos seguir com a barragem ${xs.length === 1 ? "dela" : "delas"}?\n\n`
      + xs.map((x) => { const d = diasDesde(x.ticket_criado); const a = anotsDe(x)[0]; return `• NF ${x.nf}${d !== null ? ` · há ${plural(d, "dia", "dias")}` : ""} · rastreio: ${ultStatus(x)}${a ? ` · última anotação${a.por ? " de " + a.por : ""}${a.quando ? " em " + String(a.quando).split(",")[0] : ""}: ${a.texto}` : ""}`; }).join("\n\n");   // linha em branco entre as notas (Brenda 23/11)
  }
  const linhasXls = (xs) => xs.map((x) => { const r = x.rastreio || {}; return [alvoTransp(x), x.nf, x.ticket || "", x.ticket_criado ? br(x.ticket_criado) : "", diasDesde(x.ticket_criado) ?? "", ultStatus(x), r.fonte || "", x.sugestao_motivo || "", anotTexto(x)]; });
  const CAB_ERRO = ["Transportadora", "Nota", "Ticket", "Ticket aberto em", "Dias pendente", "Último status no rastreio", "Fonte do rastreio", "Observação do robô", "Anotações no portal"];
  // anotações do portal (Barrar Entrega › Anotações), mais recente primeiro
  const anotsDe = (x) => { const p = x.portal || {}; const A = (p.anotacoes || []).filter((a) => a && a.texto);
    const dk = (q) => { const m = String(q || "").match(/(\d{2})\/(\d{2})\/(\d{4}),?\s*(\d{2}):(\d{2})/); return m ? `${m[3]}${m[2]}${m[1]}${m[4]}${m[5]}` : ""; };
    return A.length ? A.map((a, i) => [a, i]).sort((u, v) => dk(v[0].quando).localeCompare(dk(u[0].quando)) || v[1] - u[1]).map(([a]) => a) : p.anotacao ? [{ quando: "", texto: String(p.anotacao).replace(/\s*Close\s*$/i, "") }] : []; };
  const anotTexto = (x) => anotsDe(x).map((a) => `${a.por ? a.por + " · " : ""}${a.quando ? a.quando + ": " : ""}${a.texto}`).join(" | ");
  const anotHtml = (a) => `<div class="br-anot">${a.por ? `<b>${esc(a.por)}</b> ` : ""}${a.quando ? `<span class="s">${esc(a.quando)}</span>` : ""}${a.por || a.quando ? "<br>" : ""}${esc(a.texto)}</div>`;
  function baixarErro(grupos, nome) {
    const wb = XLSX.utils.book_new(); const usados = new Set();
    if (grupos.length > 1) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([CAB_ERRO].concat(grupos.flatMap(([, xs]) => linhasXls(xs)))), "Todas");
    grupos.forEach(([t, xs]) => { let a = t.replace(/[\\/?*\[\]:]/g, " ").slice(0, 28).trim() || "Transp"; while (usados.has(a)) a += "_"; usados.add(a); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([CAB_ERRO].concat(linhasXls(xs))), a); });
    XLSX.writeFile(wb, `barrar_pendentes_${nome}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }
  function desenharErroTransp() {
    let box = $("br-erro-transp");
    if (!box) { box = document.createElement("section"); box.id = "br-erro-transp"; box.className = "cartao br-et"; $("br-cards").after(box); }
    box.hidden = card !== "manual"; if (box.hidden) return;
    const rolT = [...box.querySelectorAll(".br-et-lista, .tabela-wrap")].map((el) => el.scrollTop);
    const msgs = new Map([...box.querySelectorAll(".br-et-msg")].filter((t) => t.dataset.editada).map((t) => [t.dataset.t, t.value]));
    const yAntes = window.scrollY;
    const G = gruposErro();
    const C = L.filter((x) => sit(x) === "manual" && anotsDe(x).length)
      .map((x) => [alvoTransp(x), x]).sort((a, b) => (diasDesde(b[1].ticket_criado) ?? -1) - (diasDesde(a[1].ticket_criado) ?? -1) || String(a[1].nf).localeCompare(String(b[1].nf)));
    const quadroAnot = `<div class="br-an-q"><div class="br-et-cab"><b>📝 Com anotação da transportadora no portal</b><span class="chip ${C.length ? "azul" : ""}">${plural(C.length, "nota", "notas")}</span>${C.length ? `<button type="button" class="btn contorno mini br-an-xls">↓ Excel</button><button type="button" class="btn lilas mini br-an-enviar" title="Salva as decisões escolhidas: as notas vão para o card Aprovadas">Aprovar decisões</button>` : ""}</div>
      ${C.length ? `<p class="s">A transportadora escreveu algo no portal, mas o robô não achou devolução no rastreio nem "não recebeu" na anotação. Escolha a decisão de cada nota na última coluna (fica em rascunho; o ✗ já vem com a anotação mais recente como motivo, dá para editar). No fim, clique em <b>Aprovar decisões</b>: elas vão para o card <b>Aprovadas</b> e você manda para o portal quando quiser. As que você não decidir continuam nos quadrinhos de cobrança abaixo.</p>
      <div class="tabela-wrap br-an-lista"><table class="tabela-pedidos"><thead><tr><th>Nota / ticket</th><th>Transportadora</th><th class="num">Dias</th><th>Anotações (mais recente primeiro)</th><th>Último status no rastreio</th><th>Decisão (vai para o robô)</th></tr></thead><tbody>${C.map(([t, x]) => `<tr>
        <td><b>${esc(x.nf)}</b>${x.ticket ? `<div><a href="https://appv2.360multi.com/tickets/${encodeURIComponent(x.ticket)}" target="_blank" rel="noopener noreferrer">#${esc(x.ticket)}</a></div>` : ""}</td>
        <td>${esc(t)}</td><td class="num">${diasDesde(x.ticket_criado) ?? "—"}</td>
        <td>${anotsDe(x).map(anotHtml).join("")}${x.print_path ? `<a href="#" class="br-print" data-p="${esc(x.print_path)}">ver print da anotação</a>` : ""}</td>
        <td class="s">${esc(ultStatus(x))}${x.print_rastreio ? `<div><a href="#" class="br-print" data-p="${esc(x.print_rastreio)}">ver print do rastreio</a></div>` : ""}</td><td class="br-an-dec">${celDecAnot(x)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="s">Nenhuma nota em "Erro: verificar" tem anotação no portal.</p>`}</div>`;
    box.innerHTML = `<div class="cartao-topo"><div><h2>Pendentes de barrar por transportadora</h2><p class="sub">Sem devolução no rastreio e sem "não recebeu" no portal. Cada quadrinho tem a mensagem pronta para o WhatsApp (dá para editar antes de copiar) e o Excel só daquela transportadora.</p></div>
      ${G.length ? `<button type="button" class="btn contorno br-et-todas">↓ Excel de todas (uma aba por transportadora)</button>` : ""}</div>
      ${quadroAnot}
      <div class="br-et-grade">${G.map(([t, xs], i) => { const mx = Math.max(...xs.map((x) => diasDesde(x.ticket_criado) ?? 0));
        return `<div class="br-et-q"><div class="br-et-cab"><b>${esc(t)}</b><span class="chip ${mx >= 5 ? "vermelho" : mx >= 2 ? "ambar" : ""}">${plural(xs.length, "nota", "notas")} · mais antiga há ${plural(mx, "dia", "dias")}</span></div>
          <div class="br-et-lista"><table><thead><tr><th>Nota</th><th class="num">Dias</th><th>Anotações e rastreio</th></tr></thead><tbody>${xs.map((x) => `<tr><td>${esc(x.nf)}${x.ticket ? ` <a href="https://appv2.360multi.com/tickets/${encodeURIComponent(x.ticket)}" target="_blank" rel="noopener noreferrer">#${esc(x.ticket)}</a>` : ""}</td><td class="num">${diasDesde(x.ticket_criado) ?? "—"}</td><td class="s">${anotsDe(x).map((a) => `<div class="br-et-an">${a.por ? `<b>${esc(a.por)}</b> · ` : ""}${a.quando ? `<span class="s">${esc(a.quando)}</span>` : ""}${a.por || a.quando ? "<br>" : ""}${esc(a.texto)}</div>`).join("")}<div class="br-et-rast"><b>Status atual do rastreio:</b> ${esc(ultStatus(x))}${x.print_rastreio ? ` · <a href="#" class="br-print" data-p="${esc(x.print_rastreio)}">ver print do rastreio</a>` : ""}</div></td></tr>`).join("")}</tbody></table></div>
          <textarea class="br-et-msg" rows="6" data-i="${i}" data-t="${esc(t)}">${esc(msgTransp(t, xs))}</textarea>
          <div class="br-et-bts"><button type="button" class="btn amarelo mini br-et-copiar" data-i="${i}">Copiar mensagem</button><a class="btn contorno mini br-et-wa" data-i="${i}" href="#" title="Abre o WhatsApp com a mensagem (você escolhe o contato)">WhatsApp ↗</a><button type="button" class="btn contorno mini br-et-xls" data-i="${i}">↓ Excel</button></div></div>`; }).join("") || `<p class="vazio">Nenhuma nota em "Erro: verificar".</p>`}</div>`;
    box._G = G; box._C = C; contarAnot();
    box.querySelectorAll(".br-et-lista, .tabela-wrap").forEach((el, k) => { if (rolT[k]) el.scrollTop = rolT[k]; });
    box.querySelectorAll(".br-et-msg").forEach((t) => { if (msgs.has(t.dataset.t)) { t.value = msgs.get(t.dataset.t); t.dataset.editada = "1"; } });
    if (Math.abs(window.scrollY - yAntes) > 2) window.scrollTo(0, yAntes);
  }
  document.addEventListener("click", async (e) => {
    const box = $("br-erro-transp"); if (!box || !box.contains(e.target)) return;
    const G = box._G || [], i = Number((e.target.closest("[data-i]") || {}).dataset?.i);
    if (e.target.closest(".br-et-todas")) return baixarErro(G, "todas");
    if (e.target.closest(".br-an-enviar")) return enviarAnot(box);
    if (e.target.closest(".br-an-xls")) { const C = box._C || [], wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([CAB_ERRO].concat(linhasXls(C.map(([, x]) => x)))), "Com anotação"); return XLSX.writeFile(wb, `barrar_com_anotacao_${new Date().toISOString().slice(0, 10)}.xlsx`); }
    if (e.target.closest(".br-et-xls")) return baixarErro([G[i]], G[i][0].normalize("NFD").replace(/[^\w]+/g, "_").slice(0, 30));
    const txt = () => (box.querySelector(`.br-et-msg[data-i="${i}"]`) || {}).value || "";
    if (e.target.closest(".br-et-copiar")) { try { await navigator.clipboard.writeText(txt()); toast("Mensagem copiada. Cole no WhatsApp da transportadora."); } catch { const t = box.querySelector(`.br-et-msg[data-i="${i}"]`); t.select(); document.execCommand("copy"); toast("Mensagem copiada."); } return; }
    const wa = e.target.closest(".br-et-wa"); if (wa) { e.preventDefault(); window.open("https://wa.me/?text=" + encodeURIComponent(txt()), "_blank", "noopener"); }
  });

  // célula de decisão (lista principal e quadro de anotações): o que o robô vai fazer no portal
  function celDec(x) {
    const travado = x.portal_status === "feito";
    return travado ? `<span class="chip ${x.decisao === "barrar" ? "verde" : "vermelho"}">${SUG[x.decisao] || ""}</span>`
      : `<select class="br-dec" data-nf="${esc(x.nf)}"><option value="">—</option><option value="barrar"${x.decisao === "barrar" ? " selected" : ""}>Barrar ✓</option>${OP.map((o) => `<option value="nao_barrar|${esc(o)}"${x.decisao === "nao_barrar" && x.decisao_opcao === o ? " selected" : ""}>✗ ${esc(o)}</option>`).join("")}</select>
        ${x.decisao === "nao_barrar" ? `<textarea class="br-mot" data-nf="${esc(x.nf)}" rows="2" placeholder="Motivo (vai no portal)">${esc(x.decisao_motivo || "")}</textarea>` : ""}${x.decisao_por ? `<div class="s">${esc(x.decisao_por.split("@")[0])} · ${hora(x.decisao_em)}</div>` : ""}`;;
  }
  // quadro de anotações: decisões ficam em rascunho (sem salvar nem redesenhar) até "Enviar decisões para o robô"
  const rasc = new Map();
  const valDec = (x) => (rasc.has(x.nf) ? rasc.get(x.nf).v : x.decisao === "barrar" ? "barrar" : x.decisao === "nao_barrar" ? "nao_barrar|" + (x.decisao_opcao || "") : "");
  const motDec = (x) => (rasc.has(x.nf) && rasc.get(x.nf).mot != null ? rasc.get(x.nf).mot : x.decisao_motivo || (anotsDe(x)[0] || {}).texto || "");
  function celDecAnot(x) {
    if (x.portal_status === "feito") return celDec(x);
    const v = valDec(x);
    return `<select class="br-an-sel" data-nf="${esc(x.nf)}"><option value="">—</option><option value="barrar"${v === "barrar" ? " selected" : ""}>Barrar ✓</option>${OP.map((o) => `<option value="nao_barrar|${esc(o)}"${v === "nao_barrar|" + o ? " selected" : ""}>✗ ${esc(o)}</option>`).join("")}</select>
      <textarea class="br-an-mot" data-nf="${esc(x.nf)}" rows="2" placeholder="Motivo (vai no portal)"${v.startsWith("nao_barrar") ? "" : " hidden"}>${esc(motDec(x))}</textarea>
      ${x.decisao && !rasc.has(x.nf) ? `<div class="s">✓ salva${x.decisao_por ? " por " + esc(x.decisao_por.split("@")[0]) : ""}</div>` : rasc.has(x.nf) ? `<div class="s txt-ambar">rascunho · ainda não enviado</div>` : ""}`;
  }
  function contarAnot() {
    const box = $("br-erro-transp"); if (!box) return; const C = box._C || [];
    const n = C.filter(([, x]) => x.portal_status !== "feito" && (rasc.has(x.nf) ? rasc.get(x.nf).v : x.decisao)).length;
    const b = box.querySelector(".br-an-enviar"); if (b) { b.textContent = `Aprovar decisões (${n})`; b.disabled = !n; }
  }
  function linha(x) {
    const r = x.rastreio || {}, p = x.portal || {};
    const rast = !x.conferido_em ? `<span class="s">o robô ainda não olhou</span>`
      : `<b>${esc(r.situacao || "—")}</b>${r.fonte ? ` <span class="s">(${esc(r.fonte)})</span>` : ""}${r.evento ? `<div class="s">${esc(r.evento)}${r.data_evento ? " · " + br(r.data_evento) : ""}</div>` : ""}${r.achou_palavra ? `<div><span class="chip verde">${esc(r.achou_palavra.toLowerCase())}</span></div>` : ""}${r.transp ? `<div class="s">transp. no rastreio: ${esc(r.transp)}</div>` : ""}`;
    const tp = `${esc(x.transp_pedido || "—")}${r.transp_ticket || r.redesp_ticket ? `<div class="s">ticket 360: ${esc(r.transp_ticket || "—")}${r.redesp_ticket ? ` · redespacho <b>${esc(r.redesp_ticket)}</b>` : ""}</div>` : ""}${p.transp ? `<div class="s">portal: ${esc(p.transp)}</div>` : x.conferido_em && p.achou === false ? `<div class="s txt-vermelho">não está na lista do portal</div>` : ""}${x.mesma_transp === false ? `<div><span class="chip roxo">transportadora diferente</span></div>` : ""}`;
    const an = p.anotacao ? `${anotsDe(x).map(anotHtml).join("")}${x.print_path ? `<a href="#" class="br-print" data-p="${esc(x.print_path)}">ver print da anotação</a>` : ""}` : `<span class="s">${x.conferido_em ? "sem anotação" : ""}</span>`;
    const sug = x.sugestao ? `<span class="chip ${x.sugestao === "barrar" ? "verde" : x.sugestao === "nao_barrar" ? "vermelho" : "ambar"}">${SUG[x.sugestao]}</span>${x.sugestao_opcao ? `<div class="s">${esc(x.sugestao_opcao)}</div>` : ""}${x.sugestao_motivo ? `<div class="s">${esc(x.sugestao_motivo)}</div>` : ""}` : "";
    const travado = !!x.portal_status && x.portal_status === "feito";
    const dec = celDec(x);
    const port = x.portal_status === "feito" ? `<span class="chip verde">✓ Feito</span><div class="s">${esc(x.portal_msg || "")} ${hora(x.portal_em)}</div>` : x.portal_status === "erro" ? `<span class="txt-vermelho">⚠ ${esc(x.portal_msg || "erro")}</span>` : x.decisao ? `<span class="s">na próxima ida ao portal</span>` : "";
    return `<tr><td><input type="checkbox" class="br-sel" data-nf="${esc(x.nf)}"${marcadas.has(x.nf) ? " checked" : ""}${travado ? " disabled" : ""}></td>
      <td><b>${esc(x.nf)}</b>${x.ticket ? `<div><a href="https://appv2.360multi.com/tickets/${encodeURIComponent(x.ticket)}" target="_blank" rel="noopener noreferrer">#${esc(x.ticket)}</a></div>` : ""}${x.status_intelipost ? `<div class="s">${esc(x.status_intelipost)}</div>` : ""}</td>
      <td>${tp}</td><td>${rast}${x.print_rastreio ? `<div><a href="#" class="br-print" data-p="${esc(x.print_rastreio)}">ver print do rastreio</a></div>` : ""}</td><td>${an}</td><td>${sug}</td><td>${dec}</td><td>${port}${x.ticket_status === "feito" ? `<div class="s">✓ prints no ticket (comentário interno)</div>` : x.ticket_status === "erro" ? `<div class="s txt-vermelho">⚠ ticket: ${esc(x.ticket_msg || "erro")}</div>` : ""}</td></tr>`;
  }

  async function salvarDecisao(nfs, dec, opcao, motivo) {
    const email = (((await sb().auth.getSession()).data.session || {}).user || {}).email || null;
    for (const nf of nfs) {
      const x = L.find((y) => y.nf === nf); if (!x || x.portal_status === "feito") continue;
      const campos = dec ? { decisao: dec, decisao_opcao: dec === "nao_barrar" ? opcao : null, decisao_motivo: dec === "nao_barrar" ? motivo : null, decisao_por: email, decisao_em: new Date().toISOString(), portal_status: null, portal_msg: null }
        : { decisao: null, decisao_opcao: null, decisao_motivo: null, decisao_por: null, decisao_em: null };
      const { error } = await sb().from("barrar_entrega").update(campos).eq("nf", nf);
      if (error) return toast("Não consegui salvar: " + error.message, true);
      Object.assign(x, campos);
    }
    desenhar();
  }

  $("br-cards").addEventListener("click", (e) => { const b = e.target.closest("[data-br]"); if (!b) return; card = b.dataset.br === card ? "todos" : b.dataset.br; desenhar(); });
  $("br-busca").addEventListener("input", desenhar); $("br-transp").addEventListener("change", desenhar);
  $("br-limpar").addEventListener("click", () => { $("br-busca").value = ""; $("br-transp").value = ""; card = "todos"; desenhar(); });
  document.addEventListener("change", async (e) => {
    const dentro = e.target.closest("#br-linhas") ? "lista" : e.target.closest("#br-erro-transp") ? "anot" : ""; if (!dentro) return;
    const an = e.target.closest(".br-an-sel");
    if (an) { const x = L.find((y) => y.nf === an.dataset.nf); const r = rasc.get(an.dataset.nf) || { mot: null }; r.v = an.value; rasc.set(an.dataset.nf, r);
      const t = an.parentElement.querySelector(".br-an-mot"); if (t) { t.hidden = !an.value.startsWith("nao_barrar"); if (!t.value) t.value = motDec(x); }
      const st = an.parentElement.querySelector(".s"); if (st) { st.className = "s txt-ambar"; st.textContent = "rascunho · ainda não enviado"; } else an.parentElement.insertAdjacentHTML("beforeend", `<div class="s txt-ambar">rascunho · ainda não enviado</div>`);
      contarAnot(); return; }
    if (e.target.closest(".br-an-mot")) return;
    const c = e.target.closest(".br-sel"); if (c) { c.checked ? marcadas.add(c.dataset.nf) : marcadas.delete(c.dataset.nf); desenhar(); return; }
    const d = e.target.closest(".br-dec");
    if (d) { const [dec, op] = d.value.split("|"); const x = L.find((y) => y.nf === d.dataset.nf);
      const mot = dec === "nao_barrar" ? (x.decisao_motivo || (x.sugestao === "nao_barrar" ? x.sugestao_motivo : "") || (anotsDe(x)[0] || {}).texto || "") : null;
      await salvarDecisao([d.dataset.nf], dec || null, op || null, mot); return; }
    const m = e.target.closest(".br-mot");
    if (m) { const x = L.find((y) => y.nf === m.dataset.nf); await salvarDecisao([m.dataset.nf], "nao_barrar", x.decisao_opcao, m.value.trim()); }
  });
  $("br-todos").addEventListener("change", (e) => { L.filter(passa).forEach((x) => { if (x.portal_status === "feito") return; e.target.checked ? marcadas.add(x.nf) : marcadas.delete(x.nf); }); desenhar(); });
  $("br-aprovar").addEventListener("click", async () => {
    const sel = L.filter((x) => marcadas.has(x.nf) && x.portal_status !== "feito");
    const comSug = sel.filter((x) => x.sugestao === "barrar" || x.sugestao === "nao_barrar"), sem = sel.length - comSug.length;
    if (!comSug.length) return toast("As notas marcadas não têm sugestão de ✓ ou ✗. Escolha a decisão na própria linha.", true);
    if (!confirm(`Aprovar a sugestão do robô em ${comSug.length} nota(s)?${sem ? `\n${sem} marcada(s) sem sugestão ficam de fora (escolha na linha).` : ""}\n\nNada vai para o portal até alguém clicar em "Mandar para o portal".`)) return;
    for (const x of comSug) await salvarDecisao([x.nf], x.sugestao, x.sugestao_opcao, x.sugestao === "nao_barrar" ? x.sugestao_motivo || "" : null);
    marcadas.clear(); desenhar(); toast(`${comSug.length} aprovada(s).`);
  });
  $("br-desfazer").addEventListener("click", async () => { await salvarDecisao([...marcadas], null); marcadas.clear(); desenhar(); });
  document.addEventListener("click", async (e) => {
    const a = e.target.closest(".br-print"); if (!a || !(e.target.closest("#br-linhas") || e.target.closest("#br-erro-transp"))) return; e.preventDefault();
    try { let u = urls.get(a.dataset.p); if (!u) { const { data, error } = await sb().storage.from("barrar").createSignedUrl(a.dataset.p, 3600); if (error) throw error; u = data.signedUrl; urls.set(a.dataset.p, u); } window.open(u, "_blank", "noopener"); }
    catch (err) { toast("Não consegui abrir o print: " + (err.message || err), true); }
  });
  const robo = async (modo, txt) => {
    const { error } = await sb().rpc("rodar_robo_barrar", { modo });
    if (error) return toast(/rodar_robo_barrar|function/i.test(error.message) ? "Rode a parte 49 no Supabase." : "Não consegui chamar o robô: " + error.message, true);
    toast(txt);
  };
  $("br-conferir").addEventListener("click", () => robo("barrar", "Robô chamado: ele confere o rastreio e o portal de cada nota. Acompanhe pelo aviso no canto da tela."));
  document.addEventListener("input", (e) => { const m = e.target.closest("#br-erro-transp .br-et-msg"); if (m) m.dataset.editada = "1";
    const t = e.target.closest("#br-erro-transp .br-an-mot"); if (!t) return;
    const x = L.find((y) => y.nf === t.dataset.nf); const r = rasc.get(t.dataset.nf) || { v: valDec(x) }; r.mot = t.value; rasc.set(t.dataset.nf, r); contarAnot(); });
  async function enviarAnot(box) {
    const muda = (box._C || []).map(([, x]) => x).filter((x) => x.portal_status !== "feito" && rasc.has(x.nf) && rasc.get(x.nf).v);
    if (!muda.length) return toast("Escolha a decisão de pelo menos uma nota.", true);
    const semMot = muda.filter((x) => rasc.get(x.nf).v.startsWith("nao_barrar") && !String(motDec(x)).trim());
    if (semMot.length) return toast(`Falta o motivo em ${plural(semMot.length, "nota", "notas")} com ✗: ${semMot.map((x) => x.nf).join(", ")}.`, true);
    const email = (((await sb().auth.getSession()).data.session || {}).user || {}).email || null;
    for (const x of muda) {
      const [dec, op] = String(rasc.get(x.nf).v).split("|");
      const campos = { decisao: dec, decisao_opcao: dec === "nao_barrar" ? op : null, decisao_motivo: dec === "nao_barrar" ? String(motDec(x)).trim() : null, decisao_por: email, decisao_em: new Date().toISOString(), portal_status: null, portal_msg: null };
      const { error } = await sb().from("barrar_entrega").update(campos).eq("nf", x.nf);
      if (error) { desenhar(); return toast(`Não consegui salvar a NF ${x.nf}: ${error.message}`, true); }
      Object.assign(x, campos); rasc.delete(x.nf);
    }
    desenhar();
    toast(`${plural(muda.length, "nota aprovada", "notas aprovadas")}: estão no card Aprovadas. Clique em "Mandar para o portal" quando quiser enviar ao robô.`);
  }
  $("br-portal").addEventListener("click", () => {
    const ap = L.filter((x) => x.decisao && !x.portal_status), b = ap.filter((x) => x.decisao === "barrar").length;
    if (!confirm(`Mandar ${ap.length} nota(s) para o portal?\n\n${b} serão marcadas como BARRADAS (✓) e ${ap.length - b} como NÃO BARRADAS (✗) com a opção e o motivo escolhidos.\nIsso fica gravado no portal da transportadora.`)) return;
    robo("barrar-portal", "Robô chamado: ele vai marcar no portal só as notas aprovadas.");
  });
  $("br-arq").addEventListener("change", async (e) => {
    const arq = e.target.files[0]; e.target.value = ""; if (!arq) return;
    try {
      const wb = XLSX.read(await arq.arrayBuffer(), { cellDates: true }); const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "", raw: false, dateNF: "yyyy-mm-dd hh:mm:ss" });
      const cab = (rows[0] || []).map(norm), c = (re) => cab.findIndex((h) => re.test(h));
      const iNf = c(/^NOTA FISCAL$/), iNum = c(/^NUMERO DA NOTA$/), iSer = c(/^SERIE DA NOTA$/), iTk = c(/^ID DO TICKET$/), iTp = c(/^TRANSPORTADOR PROMOB$/), iRd = c(/^TRANSPORTADOR REDESPACHO PROMOB$/), iSt = c(/^STATUS INTELIPOST$/), iCr = c(/^CRIACAO DO TICKET$/);
      if (iNf < 0 && iNum < 0) throw new Error('A planilha precisa da coluna "Nota fiscal" (ou "Número da nota" e "Série da Nota").');
      const mp = new Map();
      rows.slice(1).forEach((l) => {
        let nf = iNum >= 0 && l[iNum] !== "" ? `${sem0(l[iNum])}-${sem0(l[iSer])}` : String(l[iNf] || "").trim().split("-").map(sem0).join("-");
        if (!/^\d+-\d+$/.test(nf)) return;
        const rd = iRd >= 0 ? String(l[iRd] || "").trim() : "", tp = iTp >= 0 ? String(l[iTp] || "").trim() : "";
        mp.set(nf, { nf, ticket: iTk >= 0 ? String(l[iTk] || "").trim() : "", transp_pedido: rd && !/^SEM\b|^-$/i.test(rd) ? rd : tp, status_intelipost: iSt >= 0 ? String(l[iSt] || "").trim() : "", ticket_criado: iCr >= 0 ? String(l[iCr] || "").slice(0, 19) : "" });
      });
      if (!mp.size) throw new Error("Nenhuma nota válida (formato 1234-35) na planilha.");
      const { data, error } = await sb().rpc("importar_barrar", { linhas: [...mp.values()], arquivo: arq.name });
      if (error) throw error;
      toast(`${fmt(data)} notas na lista. Clique em "Conferir agora" para o robô olhar.`); await carregar();
    } catch (err) { toast(/importar_barrar|function/i.test(err.message || "") ? "Rode a parte 49 no Supabase antes de enviar a planilha." : err.message || String(err), true); }
  });
  $("br-excel").addEventListener("click", () => {
    const V = L.filter(passa); if (!V.length) return toast("Nada para exportar.", true);
    const cab = ["Nota", "Ticket", "Transportadora (pedido)", "Transportadora (portal)", "Transportadora (rastreio)", "Mesma transportadora", "Rastreio", "Fonte", "Último evento", "Data do evento", "Segregado/devolução", "Anotação no portal", "Sugestão", "Opção sugerida", "Motivo sugerido", "Decisão", "Opção", "Motivo", "Aprovado por", "Portal", "Mensagem do portal"];
    const ws = XLSX.utils.aoa_to_sheet([cab].concat(V.map((x) => { const r = x.rastreio || {}, p = x.portal || {};
      return [x.nf, x.ticket, x.transp_pedido, p.transp || "", r.transp || "", x.mesma_transp === null || x.mesma_transp === undefined ? "" : x.mesma_transp ? "Sim" : "Não", r.situacao || "", r.fonte || "", r.evento || "", br(r.data_evento), r.achou_palavra || "", p.anotacao || "",
        SUG[x.sugestao] || "", x.sugestao_opcao || "", x.sugestao_motivo || "", SUG[x.decisao] || "", x.decisao_opcao || "", x.decisao_motivo || "", (x.decisao_por || "").split("@")[0], x.portal_status || "", x.portal_msg || ""]; })));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Barrar entrega"); XLSX.writeFile(wb, `barrar_entrega_${new Date().toISOString().slice(0, 10)}.xlsx`);
  });
  // carrega quando a página aparece; enquanto aberta, relê a cada 30 s (o robô vai preenchendo)
  new MutationObserver(() => { if (!$("pagina-barrar").hidden) carregar(); }).observe($("pagina-barrar"), { attributes: true, attributeFilter: ["hidden"] });
  setInterval(() => { if (!$("pagina-barrar").hidden && $("pagina-barrar").offsetParent && !document.hidden && !document.activeElement.closest("#pagina-barrar textarea, #pagina-barrar select")) carregar(true); }, 30000);
  if (!$("pagina-barrar").hidden) carregar();
})();
