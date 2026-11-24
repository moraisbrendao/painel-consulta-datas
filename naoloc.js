// Alterar pedidos › Nota não localizada: planilha de tickets da fila "Nota não localizada (Sem Emissão)" do Multi360 →
// robô olha o rastreio e executa a ação no ticket (voltar para o barrar / seguir para cancelamento). Guarda o histórico e
// avisa se aparecer CT-e depois do cancelamento.
(function () {
  const $ = (id) => document.getElementById(id);
  if (!$("ap-sec-nl")) return;
  const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
  const sem0 = (t) => String(t ?? "").trim().replace(/\.0+$/, "").replace(/^0+(?=\d)/, "");
  const fmt = (n) => Number(n || 0).toLocaleString("pt-BR");
  const br = (d) => (d ? new Date(String(d).length <= 10 ? d + "T12:00:00" : String(d).replace(" ", "T")).toLocaleDateString("pt-BR") : "");
  const hora = (d) => (d ? new Date(d).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "");
  const toast = (msg, erro) => { const t = $("toast"); if (!t) return alert(msg); t.textContent = msg; t.classList.toggle("erro", !!erro); t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), erro ? 6000 : 3500); };
  const sb = () => { const c = window.__sb; if (!c) throw new Error("Entre no painel de novo (sessão expirada)."); return c; };
  const dias = (d) => (d ? Math.max(0, Math.floor((Date.now() - Date.parse(String(d).replace(" ", "T"))) / 864e5)) : null);
  // mesmo prazo do robô: série 35 = 30 dias corridos; 34 e 25 = 7 dias úteis; 7, 31 e 4 = 5 dias úteis (desde a criação do ticket)
  function prazoAte(serie, criado) {
    if (!criado) return null; const d = new Date(String(criado).replace(" ", "T").slice(0, 19)); if (isNaN(d)) return null;
    const sr = String(serie || "").replace(/^0+/, ""), x = new Date(d);
    const du = { "34": 7, "25": 7, "7": 5, "31": 5, "4": 5 }[sr];
    if (sr === "35") x.setDate(x.getDate() + 30); else if (du) { let n = 0; while (n < du) { x.setDate(x.getDate() + 1); if (x.getDay() % 6) n++; } } else return null;
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  }
  const tk = (id) => (id ? `<a href="https://appv2.360multi.com/tickets/${encodeURIComponent(id)}" target="_blank" rel="noopener noreferrer" title="Abrir o ticket no Multi360">#${esc(id)}</a>` : "");

  // DLOG na série 35 só faz a first mile (Brenda 24/11): conferências feitas antes da regra usaram o rastreio dela → revisar
  const serieDe = (x) => String(x.serie || String(x.nf || "").split("-")[1] || "").replace(/^0+/, "");
  const dlogRev = (x) => serieDe(x) === "35" && /\bDLOG\b/i.test((x.rastreio || {}).alvo || "");
  const SUG = { voltar_barrar: ["azul", "Voltar para o barrar"], entregue: ["verde", "Entregue → não barrado"], cancelar: ["vermelho", "Seguir para cancelamento"], aguardar: ["ambar", "Aguardando prazo"], manual: ["laranja", "Verificar à mão"] };
  const CARDS = [
    ["fila", "Na fila", "notas da última planilha", "", (x) => x.na_planilha],
    ["voltar_barrar", "Voltar para o barrar", "está no rastreio", "azul", (x) => x.na_planilha && x.sugestao === "voltar_barrar"],
    ["entregue", "Entregue", "volta para o barrar como não barrado", "verde", (x) => x.na_planilha && x.sugestao === "entregue"],
    ["cancelar", "Seguir para cancelamento", "fora do rastreio e passou do prazo", "vermelho", (x) => x.na_planilha && x.sugestao === "cancelar"],
    ["aguardar", "Aguardando prazo", "fora do rastreio, ainda no prazo", "laranja", (x) => x.na_planilha && x.sugestao === "aguardar"],
    ["manual", "Verificar à mão", "sem transportadora ou série sem regra", "roxo", (x) => x.na_planilha && x.sugestao === "manual"],
    ["robo", "Aguardando o robô", "ainda não conferidas", "", (x) => x.na_planilha && !x.conferido_em],
    ["erro", "Ação com erro", "o robô não conseguiu no ticket", "vermelho", (x) => x.acao_status === "erro"],
    ["dlog", "⚠ DLOG série 35 · revisar", "rastreio da DLOG (first mile) foi usado", "vermelho", (x) => dlogRev(x)],
    ["cte", "⚠ CT-e depois do cancelamento", "apareceu no rastreio depois", "vermelho", (x) => !!x.cte_alerta_em],
    ["hist", "Histórico", "todas as notas que passaram pela fila", "", () => true]];
  let L = [], info = null, card = "fila", busca = "", ok = true, assinatura = "", urls = new Map();

  async function carregar(auto) {
    try {
      const out = []; for (let de = 0; ; de += 1000) { const { data, error } = await sb().from("nao_localizada").select("*").order("ticket_criado", { ascending: true }).range(de, de + 999); if (error) throw error; out.push(...data); if (data.length < 1000) break; }
      const i = await sb().from("nao_localizada_info").select("*").limit(1);
      const sig = JSON.stringify([out, i.data]); if (auto && sig === assinatura) return; assinatura = sig;
      L = out; info = (i.data || [])[0] || null; ok = true;
    } catch (e) { ok = false; L = []; $("nl-info").textContent = /nao_localizada|does not exist|schema cache/i.test(e.message || "") ? "Para usar esta aba, rode a parte 64 no Supabase." : "Não consegui carregar: " + (e.message || e); }
    desenhar();
  }
  const passa = (x) => { const c = CARDS.find((k) => k[0] === card); if (c && !c[4](x)) return false; const q = norm(busca).split(/[\s,;]+/).filter(Boolean); return !q.length || q.some((b) => norm(x.nf).includes(b) || norm(x.ticket).includes(b) || norm(x.transp_pedido).includes(b)); };
  function acaoTxt(x) {
    if (!x.acao_status) return x.segurar ? `<span class="chip cinza">segurada</span>` : "";
    const nome = (SUG[x.acao] || [, x.acao])[1];
    if (x.acao_status === "feito") return `<span class="chip verde">✓ ${esc(nome)}</span><div class="s">${hora(x.acao_em)}</div>`;
    if (x.acao_status === "teste") return `<span class="chip cinza">teste · ${esc(nome)}</span><div class="s">preenchido e cancelado ${hora(x.acao_em)}</div>`;
    return `<span class="txt-vermelho">⚠ ${esc(x.acao_msg || "erro")}</span>`;
  }
  function linha(x) {
    const r = x.rastreio || {}, s = SUG[x.sugestao], d = dias(x.ticket_criado);
    const rast = !x.conferido_em ? `<span class="s">o robô ainda não olhou</span>` : `<b>${esc(r.situacao || "—")}</b>${r.fonte ? ` <span class="s">(${esc(r.fonte)})</span>` : ""}${r.evento ? `<div class="s">${esc(r.evento)}${r.data_evento ? " · " + br(r.data_evento) : ""}</div>` : ""}${r.alvo ? `<div class="s">transp.: ${esc(r.alvo)}</div>` : ""}`;
    const dl = dlogRev(x) ? `<div class="nl-cte">⚠ Série 35 com rastreio da DLOG (só first mile): esta conferência não vale${x.acao_status === "feito" ? ` e a ação "${esc((SUG[x.acao] || [, x.acao])[1])}" já foi feita no ticket: revisar` : ""}${x.acao_status === "feito" ? "" : ". O robô reconfere pelo redespacho na próxima rodada"}.</div>` : "";
    const cte = x.cte_alerta_em ? `<div class="nl-cte">⚠ CT-e no rastreio depois do cancelamento: <b>${esc((x.cte_depois || {}).situacao || "")}</b> ${esc((x.cte_depois || {}).evento || "")} · avisado ${hora(x.cte_alerta_em)}${x.cte_visto_por ? ` · visto por ${esc(x.cte_visto_por.split("@")[0])}` : ` <button type="button" class="btn contorno mini nl-visto" data-nf="${esc(x.nf)}">Marcar como visto</button>`}</div>` : "";
    return `<tr${x.na_planilha ? "" : ` class="nl-fora"`}>
      <td><b>${esc(x.nf)}</b><div>${tk(x.ticket)}</div>${x.na_planilha ? "" : `<div class="s">saiu da fila</div>`}</td>
      <td class="num">${esc(x.serie || "")}</td>
      <td>${esc(x.transp_pedido || "—")}${x.status_intelipost ? `<div class="s">Intelipost: ${esc(x.status_intelipost)}</div>` : ""}</td>
      <td class="num">${d ?? "—"}<div class="s">${br(x.ticket_criado)}</div></td>
      <td>${((pz) => (pz ? `${br(pz)}${new Date().toISOString().slice(0, 10) > pz ? `<div class="s txt-vermelho">vencido</div>` : ""}` : `<span class="s">sem regra</span>`))(x.prazo_ate || prazoAte(x.serie, x.ticket_criado))}</td>
      <td>${rast}<div class="nl-bts"><button type="button" class="btn contorno mini nl-ver" data-nf="${esc(x.nf)}">Ver rastreio</button>${x.print_rastreio ? ` <a href="#" class="nl-print" data-p="${esc(x.print_rastreio)}">print</a>` : ""}</div>${dl}${cte}</td>
      <td>${s ? `<span class="chip ${s[0]}">${s[1]}</span>` : ""}${x.sugestao_motivo ? `<div class="s">${esc(x.sugestao_motivo)}</div>` : ""}</td>
      <td>${acaoTxt(x)}${x.na_planilha && x.acao_status !== "feito" ? `<label class="s nl-seg"><input type="checkbox" class="nl-segurar" data-nf="${esc(x.nf)}"${x.segurar ? " checked" : ""}> segurar (robô não mexe)</label>` : ""}</td></tr>`;
  }
  function desenhar() {
    if (!ok) return;
    $("nl-info").textContent = info ? `Planilha: ${info.arquivo || ""} · ${hora(info.enviado_em)}${info.enviado_por ? " por " + info.enviado_por.split("@")[0] : ""} · ${fmt(L.filter((x) => x.na_planilha).length)} na fila · ${fmt(L.length)} no histórico` : "Nenhuma planilha enviada ainda.";
    $("nl-cards").innerHTML = CARDS.map(([k, rot, sub, cor, f]) => `<button type="button" class="kpi ${cor}${card === k ? " ativa" : ""}" data-nl="${k}"><span class="kpi-rot">${rot}</span><b class="kpi-num">${fmt(L.filter(f).length)}</b><small>${sub}</small></button>`).join("");
    const al = L.filter((x) => x.cte_alerta_em && !x.cte_visto_em);
    $("nl-alerta").hidden = !al.length;
    if (al.length) $("nl-alerta-txt").textContent = `${fmt(al.length)} nota(s) seguiram para cancelamento e depois apareceram no rastreio (CT-e emitido). Tome as providências e marque como visto.`;
    const V = L.filter(passa);
    const y = window.scrollY;
    $("nl-titulo").textContent = `${CARDS.find((c) => c[0] === card)[1]} (${fmt(V.length)})`;
    $("nl-linhas").innerHTML = V.map(linha).join("") || `<tr><td colspan="8" class="vazio">Nenhuma nota aqui.</td></tr>`;
    if (Math.abs(window.scrollY - y) > 2) window.scrollTo(0, y);
  }

  $("nl-cards").addEventListener("click", (e) => { const b = e.target.closest("[data-nl]"); if (!b) return; card = b.dataset.nl; desenhar(); });
  $("nl-alerta-ver").addEventListener("click", () => { card = "cte"; desenhar(); $("nl-titulo").scrollIntoView({ behavior: "smooth" }); });
  $("nl-busca").addEventListener("input", (e) => { busca = e.target.value; desenhar(); });
  $("ap-sec-nl").addEventListener("click", async (e) => {
    const v = e.target.closest(".nl-ver"); if (v) { const x = L.find((y) => y.nf === v.dataset.nf); if (window.__abrirSSW) window.__abrirSSW(x.nf, (x.rastreio || {}).alvo || x.transp_pedido, null); return; }
    const pr = e.target.closest(".nl-print"); if (pr) { e.preventDefault();
      try { let u = urls.get(pr.dataset.p); if (!u) { const { data, error } = await sb().storage.from("barrar").createSignedUrl(pr.dataset.p, 3600); if (error) throw error; u = data.signedUrl; urls.set(pr.dataset.p, u); } window.open(u, "_blank", "noopener"); }
      catch (err) { toast("Não consegui abrir o print: " + (err.message || err), true); } return; }
    const vi = e.target.closest(".nl-visto"); if (vi) {
      const email = (((await sb().auth.getSession()).data.session || {}).user || {}).email || null;
      const { error } = await sb().from("nao_localizada").update({ cte_visto_por: email, cte_visto_em: new Date().toISOString() }).eq("nf", vi.dataset.nf);
      if (error) return toast("Não consegui salvar: " + error.message, true); carregar(); }
  });
  $("ap-sec-nl").addEventListener("change", async (e) => {
    const s = e.target.closest(".nl-segurar"); if (!s) return;
    const { error } = await sb().from("nao_localizada").update({ segurar: s.checked }).eq("nf", s.dataset.nf);
    if (error) { s.checked = !s.checked; return toast("Não consegui salvar: " + error.message, true); }
    const x = L.find((y) => y.nf === s.dataset.nf); if (x) x.segurar = s.checked;
  });
  const robo = async (modo, txt) => {
    const { error } = await sb().rpc("rodar_robo_naoloc", { modo });
    if (error) return toast(/rodar_robo_naoloc|function/i.test(error.message) ? "Rode a parte 64 no Supabase." : "Não consegui chamar o robô: " + error.message, true);
    toast(txt);
  };
  $("nl-rodar").addEventListener("click", () => {
    const n = L.filter((x) => x.na_planilha && x.acao_status !== "feito" && !x.segurar).length;
    if (!confirm(`Rodar o robô em ${fmt(n)} nota(s) da fila?\n\nEle olha o rastreio de cada uma e executa a ação no ticket do Multi360:\n• no rastreio → voltar para o barrar\n• entregue → voltar para o barrar + não barrado (Entregue)\n• fora do rastreio e fora do prazo → seguir para cancelamento ("Pedido não localizado em rastreio")\n\nAs marcadas como "segurar" ficam de fora.`)) return;
    robo("naoloc", "Robô chamado: ele começa em 1 ou 2 minutos e a lista vai se atualizando sozinha.");
  });
  $("nl-teste").addEventListener("click", () => robo("naoloc-teste", "Robô chamado em TESTE: ele confere e abre a ação no ticket, mas clica em Cancelar (nada muda no Multi360)."));
  $("nl-modelo").addEventListener("click", () => {
    const cab = ["ID do Ticket", "Grupo", "Tipo", "Tipo de Reposição", "Fila", "Motivo", "Status", "Criado por", "Atualizado por", "ID Anymarket", "Pedido canal", "Canal", "Sub conta", "Criação do ticket", "Data última atualização do ticket", "Data do pagamento", "Data de saída Promob", "Data de carregamento", "Data do cancelamento", "Data de entrega", "Pedido Promob", "Código cliente Promob", "Número da carga", "Nota fiscal", "Número da nota", "Série da Nota", "Transportador Promob", "Transportador redespacho Promob", "Transportadora do Ticket", "Status Intelipost", "Fulfillment", "Valor devolvido", "Desconto", "Frete", "Valor Produtos", "Valor Pedido"];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([cab]), "Sheet1"); XLSX.writeFile(wb, "modelo_nota_nao_localizada.xlsx");
  });
  $("nl-arq").addEventListener("change", async (e) => {
    const arq = e.target.files[0]; e.target.value = ""; if (!arq) return;
    try {
      const wb = XLSX.read(await arq.arrayBuffer(), { cellDates: true }); const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "", raw: false, dateNF: "yyyy-mm-dd hh:mm:ss" });
      const cab = (rows[0] || []).map(norm), c = (re) => cab.findIndex((h) => re.test(h));
      const iNf = c(/^NOTA FISCAL$/), iNum = c(/^NUMERO DA NOTA$/), iSer = c(/^SERIE DA NOTA$/), iTk = c(/^ID DO TICKET$/), iTp = c(/^TRANSPORTADOR PROMOB$/), iRd = c(/^TRANSPORTADOR REDESPACHO PROMOB$/),
        iTt = c(/^TRANSPORTADORA DO TICKET$/), iSt = c(/^STATUS INTELIPOST$/), iCr = c(/^CRIACAO DO TICKET$/), iCa = c(/^CANAL$/), iMo = c(/^MOTIVO$/), iFi = c(/^FILA$/);
      if (iNf < 0 && iNum < 0) throw new Error('A planilha precisa da coluna "Nota fiscal" (ou "Número da nota" e "Série da Nota"). Use o modelo.');
      if (iTk < 0) throw new Error('A planilha precisa da coluna "ID do Ticket". Use o modelo.');
      const v = (l, i) => (i >= 0 ? String(l[i] ?? "").trim() : "");
      const mp = new Map(); let outraFila = 0;
      rows.slice(1).forEach((l) => {
        let nf = iNum >= 0 && l[iNum] !== "" ? `${sem0(l[iNum])}-${sem0(l[iSer])}` : String(l[iNf] || "").trim().split("-").map(sem0).join("-");
        if (!/^\d+-\d+$/.test(nf)) return;
        if (iFi >= 0 && v(l, iFi) && !/NAO LOCALIZADA/.test(norm(v(l, iFi)))) outraFila++;
        const rd = v(l, iRd), tp = v(l, iTp);
        mp.set(nf, { nf, ticket: v(l, iTk), serie: nf.split("-")[1], transp_pedido: rd && !/^(SEM\b|NAO INFORMADO|-$)/i.test(norm(rd)) ? rd : tp, transp_ticket: v(l, iTt),
          status_intelipost: v(l, iSt), canal: v(l, iCa), motivo: v(l, iMo), ticket_criado: v(l, iCr).slice(0, 19) });
      });
      if (!mp.size) throw new Error("Nenhuma nota válida (formato 1234-35) na planilha.");
      if (outraFila && !confirm(`${outraFila} linha(s) não são da fila "Nota não localizada". Enviar mesmo assim?`)) return;
      const { data, error } = await sb().rpc("importar_nao_localizada", { linhas: [...mp.values()], arquivo: arq.name });
      if (error) throw error;
      toast(`${fmt(data)} notas na fila. Clique em "Testar sem mexer" ou "Rodar o robô".`); card = "fila"; await carregar();
    } catch (err) { toast(/importar_nao_localizada|function/i.test(err.message || "") ? "Rode a parte 64 no Supabase antes de enviar a planilha." : err.message || String(err), true); }
  });
  $("nl-excel").addEventListener("click", () => {
    const V = L.filter(passa); if (!V.length) return toast("Nada para exportar.", true);
    const cab = ["Nota", "Série", "Ticket", "Na fila", "Transportadora", "Ticket aberto em", "Dias", "Prazo", "Rastreio", "Fonte", "Último evento", "Data do evento", "Sugestão do robô", "Motivo", "Ação no ticket", "Status da ação", "Ação em", "Segurada", "CT-e depois do cancelamento", "Avisado em", "Visto por"];
    const ws = XLSX.utils.aoa_to_sheet([cab].concat(V.map((x) => { const r = x.rastreio || {}, c = x.cte_depois || {};
      return [x.nf, x.serie, x.ticket, x.na_planilha ? "Sim" : "Não", x.transp_pedido, br(x.ticket_criado), dias(x.ticket_criado) ?? "", br(x.prazo_ate), r.situacao || "", r.fonte || "", r.evento || "", br(r.data_evento),
        (SUG[x.sugestao] || [, ""])[1], x.sugestao_motivo || "", (SUG[x.acao] || [, x.acao || ""])[1], x.acao_status || "", hora(x.acao_em), x.segurar ? "Sim" : "", x.cte_alerta_em ? [c.situacao, c.evento].filter(Boolean).join(" · ") : "", hora(x.cte_alerta_em), (x.cte_visto_por || "").split("@")[0]]; })));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Nota não localizada"); XLSX.writeFile(wb, `nota_nao_localizada_${card}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  });
  new MutationObserver(() => { if (!$("ap-sec-nl").hidden) carregar(); }).observe($("ap-sec-nl"), { attributes: true, attributeFilter: ["hidden"] });
  setInterval(() => { if (!$("ap-sec-nl").hidden && $("ap-sec-nl").offsetParent && !document.hidden) carregar(true); }, 30000);
})();
