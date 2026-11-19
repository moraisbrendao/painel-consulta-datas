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
      <td><b>${esc(x.nf)}</b>${x.ticket ? `<div class="s">#${esc(x.ticket)}</div>` : ""}</td>
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

  async function carregar() {
    try {
      const out = []; for (let de = 0; ; de += 1000) { const { data, error } = await sb().from("barrar_entrega").select("*").eq("na_planilha", true).order("ticket_criado", { ascending: true }).range(de, de + 999); if (error) throw error; out.push(...data); if (data.length < 1000) break; }
      const hs = await (async () => { try { return await sb().from("barrar_entrega").select("nf,ticket,decisao,decisao_opcao,decisao_por,portal_status,portal_msg,portal_em,ticket_status,ticket_msg").not("portal_status", "is", null).order("portal_em", { ascending: false }).limit(2000); } catch (_) { return { error: true }; } })();
      H = hs.error ? [] : hs.data || [];
      const inf = await sb().from("barrar_info").select("*").limit(1);
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
  const alvoTransp = (x) => { const r = x.rastreio || {}; return (r.redesp_ticket || r.transp_ticket || x.transp_pedido || "").trim() || "(sem transportadora no ticket)"; };
  const diasDesde = (d) => (d ? Math.max(0, Math.floor((Date.now() - Date.parse(String(d).replace(" ", "T"))) / 864e5)) : null);
  const ultStatus = (x) => { const r = x.rastreio || {}; return r.evento ? `${r.evento}${r.data_evento ? " em " + br(r.data_evento) : ""}` : r.situacao && !/^erro/i.test(r.situacao) ? r.situacao : "sem informação no rastreio"; };
  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
  function gruposErro() {
    const m = new Map(); L.filter((x) => sit(x) === "manual").forEach((x) => { const t = alvoTransp(x); m.set(t, (m.get(t) || []).concat(x)); });
    return [...m.entries()].map(([t, xs]) => [t, xs.sort((a, b) => (diasDesde(b.ticket_criado) ?? -1) - (diasDesde(a.ticket_criado) ?? -1))]).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], "pt-BR"));
  }
  function msgTransp(t, xs) {
    const pd = new Map(); xs.forEach((x) => { const d = diasDesde(x.ticket_criado); pd.set(d, (pd.get(d) || 0) + 1); });
    const partes = [...pd.entries()].sort((a, b) => (b[0] ?? -1) - (a[0] ?? -1)).map(([d, n]) => d === null ? `${n} sem data de abertura` : `${n} há ${plural(d, "dia", "dias")}`);
    const sts = [...new Set(xs.map(ultStatus))];
    const fim = partes.length > 1 ? partes.slice(0, -1).join(", ") + " e " + partes[partes.length - 1] : partes[0];
    return `Olá, ${t}! Estamos com ${plural(xs.length, "nota pendente", "notas pendentes")} de barrar: ${fim}.`
      + (sts.length === 1 ? (sts[0] === "sem informação no rastreio" ? " No rastreio ainda não aparece nenhuma informação." : ` O último status no rastreio é: ${sts[0]}.`) : "")
      + ` Conseguimos seguir com a barragem ${xs.length === 1 ? "dela" : "delas"}?\n\n`
      + xs.map((x) => { const d = diasDesde(x.ticket_criado); return `• NF ${x.nf}${d !== null ? ` · há ${plural(d, "dia", "dias")}` : ""}${sts.length > 1 ? ` · ${ultStatus(x)}` : ""}`; }).join("\n");
  }
  const linhasXls = (xs) => xs.map((x) => { const r = x.rastreio || {}; return [alvoTransp(x), x.nf, x.ticket || "", x.ticket_criado ? br(x.ticket_criado) : "", diasDesde(x.ticket_criado) ?? "", ultStatus(x), r.fonte || "", x.sugestao_motivo || ""]; });
  const CAB_ERRO = ["Transportadora", "Nota", "Ticket", "Ticket aberto em", "Dias pendente", "Último status no rastreio", "Fonte do rastreio", "Observação do robô"];
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
    const G = gruposErro();
    box.innerHTML = `<div class="cartao-topo"><div><h2>Pendentes de barrar por transportadora</h2><p class="sub">Sem devolução no rastreio e sem anotação no portal: a transportadora ainda não atuou. Cada quadrinho tem a mensagem pronta para o WhatsApp (dá para editar antes de copiar) e o Excel só daquela transportadora.</p></div>
      ${G.length ? `<button type="button" class="btn contorno br-et-todas">↓ Excel de todas (uma aba por transportadora)</button>` : ""}</div>
      <div class="br-et-grade">${G.map(([t, xs], i) => { const mx = Math.max(...xs.map((x) => diasDesde(x.ticket_criado) ?? 0));
        return `<div class="br-et-q"><div class="br-et-cab"><b>${esc(t)}</b><span class="chip ${mx >= 5 ? "vermelho" : mx >= 2 ? "ambar" : ""}">${plural(xs.length, "nota", "notas")} · mais antiga há ${plural(mx, "dia", "dias")}</span></div>
          <div class="br-et-lista"><table><thead><tr><th>Nota</th><th class="num">Dias</th><th>Último status</th></tr></thead><tbody>${xs.map((x) => `<tr><td>${esc(x.nf)}${x.ticket ? ` <a href="https://appv2.360multi.com/tickets/${encodeURIComponent(x.ticket)}" target="_blank" rel="noopener noreferrer">#${esc(x.ticket)}</a>` : ""}</td><td class="num">${diasDesde(x.ticket_criado) ?? "—"}</td><td class="s">${esc(ultStatus(x))}</td></tr>`).join("")}</tbody></table></div>
          <textarea class="br-et-msg" rows="6" data-i="${i}">${esc(msgTransp(t, xs))}</textarea>
          <div class="br-et-bts"><button type="button" class="btn amarelo mini br-et-copiar" data-i="${i}">Copiar mensagem</button><a class="btn contorno mini br-et-wa" data-i="${i}" href="#" title="Abre o WhatsApp com a mensagem (você escolhe o contato)">WhatsApp ↗</a><button type="button" class="btn contorno mini br-et-xls" data-i="${i}">↓ Excel</button></div></div>`; }).join("") || `<p class="vazio">Nenhuma nota em "Erro: verificar".</p>`}</div>`;
    box._G = G;
  }
  document.addEventListener("click", async (e) => {
    const box = $("br-erro-transp"); if (!box || !box.contains(e.target)) return;
    const G = box._G || [], i = Number((e.target.closest("[data-i]") || {}).dataset?.i);
    if (e.target.closest(".br-et-todas")) return baixarErro(G, "todas");
    if (e.target.closest(".br-et-xls")) return baixarErro([G[i]], G[i][0].normalize("NFD").replace(/[^\w]+/g, "_").slice(0, 30));
    const txt = () => (box.querySelector(`.br-et-msg[data-i="${i}"]`) || {}).value || "";
    if (e.target.closest(".br-et-copiar")) { try { await navigator.clipboard.writeText(txt()); toast("Mensagem copiada. Cole no WhatsApp da transportadora."); } catch { const t = box.querySelector(`.br-et-msg[data-i="${i}"]`); t.select(); document.execCommand("copy"); toast("Mensagem copiada."); } return; }
    const wa = e.target.closest(".br-et-wa"); if (wa) { e.preventDefault(); window.open("https://wa.me/?text=" + encodeURIComponent(txt()), "_blank", "noopener"); }
  });

  function linha(x) {
    const r = x.rastreio || {}, p = x.portal || {};
    const rast = !x.conferido_em ? `<span class="s">o robô ainda não olhou</span>`
      : `<b>${esc(r.situacao || "—")}</b>${r.fonte ? ` <span class="s">(${esc(r.fonte)})</span>` : ""}${r.evento ? `<div class="s">${esc(r.evento)}${r.data_evento ? " · " + br(r.data_evento) : ""}</div>` : ""}${r.achou_palavra ? `<div><span class="chip verde">${esc(r.achou_palavra.toLowerCase())}</span></div>` : ""}${r.transp ? `<div class="s">transp. no rastreio: ${esc(r.transp)}</div>` : ""}`;
    const tp = `${esc(x.transp_pedido || "—")}${r.transp_ticket || r.redesp_ticket ? `<div class="s">ticket 360: ${esc(r.transp_ticket || "—")}${r.redesp_ticket ? ` · redespacho <b>${esc(r.redesp_ticket)}</b>` : ""}</div>` : ""}${p.transp ? `<div class="s">portal: ${esc(p.transp)}</div>` : x.conferido_em && p.achou === false ? `<div class="s txt-vermelho">não está na lista do portal</div>` : ""}${x.mesma_transp === false ? `<div><span class="chip roxo">transportadora diferente</span></div>` : ""}`;
    const an = p.anotacao ? `<div class="br-anot">${esc(p.anotacao)}</div>${x.print_path ? `<a href="#" class="br-print" data-p="${esc(x.print_path)}">ver print da anotação</a>` : ""}` : `<span class="s">${x.conferido_em ? "sem anotação" : ""}</span>`;
    const sug = x.sugestao ? `<span class="chip ${x.sugestao === "barrar" ? "verde" : x.sugestao === "nao_barrar" ? "vermelho" : "ambar"}">${SUG[x.sugestao]}</span>${x.sugestao_opcao ? `<div class="s">${esc(x.sugestao_opcao)}</div>` : ""}${x.sugestao_motivo ? `<div class="s">${esc(x.sugestao_motivo)}</div>` : ""}` : "";
    const travado = !!x.portal_status && x.portal_status === "feito";
    const dec = travado ? `<span class="chip ${x.decisao === "barrar" ? "verde" : "vermelho"}">${SUG[x.decisao] || ""}</span>`
      : `<select class="br-dec" data-nf="${esc(x.nf)}"><option value="">—</option><option value="barrar"${x.decisao === "barrar" ? " selected" : ""}>Barrar ✓</option>${OP.map((o) => `<option value="nao_barrar|${esc(o)}"${x.decisao === "nao_barrar" && x.decisao_opcao === o ? " selected" : ""}>✗ ${esc(o)}</option>`).join("")}</select>
        ${x.decisao === "nao_barrar" ? `<textarea class="br-mot" data-nf="${esc(x.nf)}" rows="2" placeholder="Motivo (vai no portal)">${esc(x.decisao_motivo || "")}</textarea>` : ""}${x.decisao_por ? `<div class="s">${esc(x.decisao_por.split("@")[0])} · ${hora(x.decisao_em)}</div>` : ""}`;
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
  $("br-linhas").addEventListener("change", async (e) => {
    const c = e.target.closest(".br-sel"); if (c) { c.checked ? marcadas.add(c.dataset.nf) : marcadas.delete(c.dataset.nf); desenhar(); return; }
    const d = e.target.closest(".br-dec");
    if (d) { const [dec, op] = d.value.split("|"); const x = L.find((y) => y.nf === d.dataset.nf);
      const mot = dec === "nao_barrar" ? (x.decisao_motivo || (x.sugestao === "nao_barrar" ? x.sugestao_motivo : "") || "") : null;
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
  $("br-linhas").addEventListener("click", async (e) => {
    const a = e.target.closest(".br-print"); if (!a) return; e.preventDefault();
    try { let u = urls.get(a.dataset.p); if (!u) { const { data, error } = await sb().storage.from("barrar").createSignedUrl(a.dataset.p, 3600); if (error) throw error; u = data.signedUrl; urls.set(a.dataset.p, u); } window.open(u, "_blank", "noopener"); }
    catch (err) { toast("Não consegui abrir o print: " + (err.message || err), true); }
  });
  const robo = async (modo, txt) => {
    const { error } = await sb().rpc("rodar_robo_barrar", { modo });
    if (error) return toast(/rodar_robo_barrar|function/i.test(error.message) ? "Rode a parte 49 no Supabase." : "Não consegui chamar o robô: " + error.message, true);
    toast(txt);
  };
  $("br-conferir").addEventListener("click", () => robo("barrar", "Robô chamado: ele confere o rastreio e o portal de cada nota. Acompanhe pelo aviso no canto da tela."));
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
  setInterval(() => { if (!$("pagina-barrar").hidden && $("pagina-barrar").offsetParent && !document.hidden && !document.activeElement.closest("#pagina-barrar textarea, #pagina-barrar select")) carregar(); }, 30000);
  if (!$("pagina-barrar").hidden) carregar();
})();
