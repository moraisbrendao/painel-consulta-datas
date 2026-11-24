// Cobrança em massa das transportadoras (Brenda 24/11): só cobra o que tem
//  1) reposição com nova NF emitida (ticket em andamento, fora da fila Recuperação de crédito)
//  2) ocorrência com status "Em andamento"
// e, nos dois, status na Intelipost diferente de Despachado, Pré-lista de postagem e Falha ao criar pedido com a transportadora.
// Agrupa por transportadora; 1 Excel por transportadora (abas Reposições e Ocorrências) + texto pronto. Nada é enviado sozinho.
(function () {
  const $ = (id) => document.getElementById(id);
  if (!$("pagina-cobmassa")) return;
  const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
  const nfK = (v) => String(v ?? "").trim().split("-").map((t) => t.trim().replace(/\.0+$/, "").replace(/^0+(?=\d)/, "")).join("-");
  const fmt = (n) => Number(n || 0).toLocaleString("pt-BR");
  const br = (d) => (d ? new Date(String(d).length <= 10 ? d + "T12:00:00" : String(d).replace(" ", "T")).toLocaleDateString("pt-BR") : "");
  const dias = (d) => (d ? Math.max(0, Math.floor((Date.now() - Date.parse(String(d).replace(" ", "T"))) / 864e5)) : "");
  const hojeISO = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const toast = (msg, erro) => { const t = $("toast"); if (!t) return alert(msg); t.textContent = msg; t.classList.toggle("erro", !!erro); t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), erro ? 6000 : 3500); };
  const sb = () => { const c = window.__sb; if (!c) throw new Error("Entre no painel de novo (sessão expirada)."); return c; };
  const tudo = async (tab, cols, ordem) => { const out = []; for (let de = 0; ; de += 1000) { const { data, error } = await sb().from(tab).select(cols).order(ordem).range(de, de + 999); if (error) throw error; out.push(...data); if (data.length < 1000) break; } return out; };

  const FORA_IP = /^(DESPACHADO|PRE-?LISTA DE POSTAGEM|FALHA AO CRIAR PEDIDO)/;   // status da Intelipost que NÃO entram
  const RUIDO = /\b(LTDA|ME|EPP|EIRELI|S\/?A|TRANSPORTES?|TRANSPORTADORA|LOGISTICA|STANDARD|EXPRESS)\b/g;
  // junta os métodos da mesma transportadora (Dominalog - Filial SP, Sajob Express…) com o mesmo agrupamento do Barrar
  const base1 = (n) => (window.__nomeTranspBase ? window.__nomeTranspBase(n) : n) || n;
  const chaveT = (n0) => { const n = base1(n0); const t = norm(n); if (!t) return "(SEM TRANSPORTADORA)"; if (/TEMPO JUSTO|^VM\b|VM TRANSPORTES/.test(t)) return "VM / TEMPO JUSTO"; return t.replace(/[.,\-/]/g, " ").replace(RUIDO, " ").replace(/\s+/g, " ").trim() || t; };

  let R = [], O = [], E = [], U = 0, contatos = new Map(), carregado = false, ok = true, msgErro = "", transpSel = "", tipoSel = "", busca = "", fora = {};
  let enviados = new Set();
  try { const e = JSON.parse(localStorage.getItem("painel.cm.env") || "{}"); if (e.dia === hojeISO()) enviados = new Set(e.lista || []); } catch (_) {}
  const salvaEnv = () => { try { localStorage.setItem("painel.cm.env", JSON.stringify({ dia: hojeISO(), lista: [...enviados] })); } catch (_) {} };
  const baseAberta = () => { const b = window.__basePainel && window.__basePainel(true); return b && b.length ? b : null; };

  // Universo (Brenda 24/11): pedidos em aberto vencidos, que vencem hoje ou amanhã — pela nova data quando a transportadora já
  // deu uma (igual ao Preventivo: nova data vencida volta para a cobrança); status Intelipost diferente de Despachado / Pré-lista /
  // Falha ao criar pedido. Fora: ocorrência "Novo" (a Multi deve retorno) e reposição ainda sem NF nova (filas de faturamento/digitação).
  // Grupos: Reposição (nova NF emitida) · Ocorrência em andamento · Entregas (sem reposição nem ocorrência).
  const FILAS_SEM_NF = /AGUARDANDO FATURAMENTO|CONFIRMAR NOVA DATA|DIGITAR PEDIDO DE REPOSICAO|UPLOAD DE ARQUIVO/;
  async function carregar() {
    $("cm-info").textContent = "Carregando a base, as reposições e as ocorrências…";
    try {
      for (let i = 0; i < 120 && !baseAberta(); i++) await new Promise((r) => setTimeout(r, 500));
      const B = baseAberta(); if (!B) throw new Error("a base ainda não carregou: atualize a página");
      const [rp, tk, oc, ct] = await Promise.all([
        tudo("repo_atual", "ticket,nota_ticket,nfs_novas,fila_atual,tipo_reposicao,transp_promob,transp_redesp_promob,data_emissao_nf,data_saida_nf", "ticket"),
        tudo("reposicoes_tk", "ticket,status", "ticket"),
        tudo("ocorrencias_tk", "id,nf,transportador,criado_em,motivo,status,mensagem,mensagem_em,solicitante", "id"),
        sb().from("transp_contatos").select("transportadora,emails,cc").then((r) => r.data || []).catch(() => []),
      ]);
      const TK = new Map(tk.map((t) => [String(t.ticket), t.status || ""]));
      contatos = new Map(); ct.forEach((c) => contatos.set(chaveT(c.transportadora), c));
      const RP = new Map(); rp.forEach((r) => { if (!r.nota_ticket) return; const st = TK.get(String(r.ticket)) || "";
        if (/RESOLVID|ENCERRAD/.test(norm(st)) || /RECUPERACAO DE CREDITO/.test(norm(r.fila_atual))) return;
        const k = nfK(r.nota_ticket); (RP.get(k) || RP.set(k, []).get(k)).push(r); });
      const OC = new Map(); oc.forEach((o) => { if (!/EM ANDAMENTO|^NOVO/.test(norm(o.status)) || !o.nf) return; const k = nfK(o.nf); (OC.get(k) || OC.set(k, []).get(k)).push(o); });
      R = []; O = []; E = []; U = 0; fora = {};
      const conta = (m) => (fora[m] = (fora[m] || 0) + 1);
      for (const p of B) {
        if (p.entregue_ip || p._diasEf == null || p._diasEf > 1) continue;
        U++;
        const k = nfK(p.nf), tks = RP.get(k) || [], ocs = OC.get(k) || [];
        if (FORA_IP.test(norm(p.status_intelipost))) { conta("status Intelipost " + p.status_intelipost); continue; }
        if (ocs.some((o) => /^NOVO/.test(norm(o.status)))) { conta("ocorrência Novo (a Multi deve retorno)"); continue; }
        if (tks.some((r) => FILAS_SEM_NF.test(norm(r.fila_atual)) || !r.nfs_novas)) { conta("reposição ainda sem NF nova"); continue; }
        const rs = tks.length ? tks : null, os = ocs.length ? ocs : null;
        const base = { pedido: p.pedido, nf: p.nf, micro: p.micro_status || "", st: p.status_intelipost || "", prom: p._venc, nova: (p._t && p._t.nova_data) || "", obs: (p._t && p._t.observacao) || "", diasEf: p._diasEf };
        (rs || []).forEach((r) => { const transp = r.transp_redesp_promob || r.transp_promob || p.transportadora || "";
          R.push({ ...base, tipo: "rep", ticket: r.ticket, nfNova: String(r.nfs_novas), emissao: r.data_emissao_nf, saida: r.data_saida_nf, tipoRep: r.tipo_reposicao, fila: r.fila_atual, transp, k: chaveT(transp) }); });
        (os || []).forEach((o) => { const transp = o.transportador || p.transportadora || "";
          O.push({ ...base, tipo: "oc", motivo: o.motivo, criado: o.criado_em, msgEm: o.mensagem_em, msg: o.mensagem, solic: o.solicitante, transp, k: chaveT(transp) }); });
        if (!rs && !os) { const transp = p.transportadora || ""; E.push({ ...base, tipo: "at", transp, k: chaveT(transp) }); }
      }
      ok = true; carregado = true;
    } catch (e) { ok = false; msgErro = e.message || String(e); }
    desenhar();
  }
  const venceTxt = (d) => (d < 0 ? `vencido há ${-d} dia${d < -1 ? "s" : ""}` : d === 0 ? "vence hoje" : "vence amanhã");
  const cobraveis = () => [...R, ...O, ...E];
  const tot = (g) => g.rep.length + g.oc.length + g.at.length;
  const nomeDe = (k, L) => { if (k === "VM / TEMPO JUSTO") return "VM Transportes / Tempo Justo"; const c = {}; L.forEach((x) => { if (x.k === k && x.transp) { const n = base1(x.transp); c[n] = (c[n] || 0) + 1; } }); return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] || k; };
  function grupos() {
    const L = cobraveis(), G = new Map();
    L.forEach((x) => { const g = G.get(x.k) || { k: x.k, rep: [], oc: [], at: [] }; g[x.tipo].push(x); G.set(x.k, g); });
    G.forEach((g) => (g.nome = nomeDe(g.k, L)));
    return [...G.values()].sort((a, b) => (enviados.has(a.k) - enviados.has(b.k)) || tot(b) - tot(a));
  }

  function texto(g) {
    const linhas = [`Olá, equipe ${g.nome}!`, "", "Seguem os pedidos vencidos ou que vencem até amanhã que precisam do retorno de vocês (lista completa na planilha em anexo):"];
    if (g.rep.length) linhas.push(`• Reposições com nova NF emitida: ${g.rep.length}`);
    if (g.oc.length) linhas.push(`• Ocorrências em andamento: ${g.oc.length}`);
    if (g.at.length) linhas.push(`• Entregas vencidas ou que vencem até amanhã: ${g.at.length}`);
    linhas.push("", "Por favor, nos informem o status atualizado e a previsão de entrega de cada nota ainda hoje.", "", "Obrigada!");
    return linhas.join("\n");
  }
  const COMUM = (x) => ({ "Pedido": x.pedido, "NF": x.nf, "Data prometida": br(x.prom), "Situação": venceTxt(x.diasEf), "Status Intelipost": x.st, "Micro status": x.micro });
  const LIN_AT = (x) => ({ ...COMUM(x), "Último retorno": x.obs || "" });
  const LIN_REP = (x) => ({ ...COMUM(x), "Ticket": x.ticket, "NF de reposição": x.nfNova, "Emissão da NF nova": br(x.emissao), "Saída da NF nova": br(x.saida), "Tipo de reposição": x.tipoRep || "" });
  const LIN_OC = (x) => ({ ...COMUM(x), "Motivo da ocorrência": x.motivo || "", "Ocorrência aberta em": br(x.criado), "Última mensagem da ocorrência": x.msg || "", "Data da última mensagem": br(x.msgEm), "Quem mandou a última": x.solic || "" });
  const limpaNome = (t) => String(t).replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  function excel(g) {
    const wb = XLSX.utils.book_new();
    if (g.rep.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(g.rep.map(LIN_REP)), "Reposições");
    if (g.oc.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(g.oc.map(LIN_OC)), "Ocorrências");
    if (g.at.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(g.at.map(LIN_AT)), "Entregas");
    XLSX.writeFile(wb, `Cobrança ${limpaNome(g.nome)} ${hojeISO().split("-").reverse().join("-")}.xlsx`);
  }
  function excelTodas(G) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(G.map((g) => ({ "Transportadora": g.nome, "Reposições": g.rep.length, "Ocorrências": g.oc.length, "Entregas": g.at.length, "Total": tot(g), "E-mails": contatos.get(g.k)?.emails || "", "Enviado hoje": enviados.has(g.k) ? "sim" : "" }))), "Resumo");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(G.flatMap((g) => g.rep.map((x) => ({ "Transportadora": g.nome, ...LIN_REP(x) })))), "Reposições");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(G.flatMap((g) => g.oc.map((x) => ({ "Transportadora": g.nome, ...LIN_OC(x) })))), "Ocorrências");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(G.flatMap((g) => g.at.map((x) => ({ "Transportadora": g.nome, ...LIN_AT(x) })))), "Entregas");
    XLSX.writeFile(wb, `Cobrança em massa ${hojeISO().split("-").reverse().join("-")}.xlsx`);
  }
  const copiar = async (t, ok) => { try { await navigator.clipboard.writeText(t); toast(ok); } catch (_) { const a = document.createElement("textarea"); a.value = t; document.body.appendChild(a); a.select(); document.execCommand("copy"); a.remove(); toast(ok); } };

  function desenhar() {
    if (!ok) { $("cm-info").textContent = "Não consegui carregar: " + msgErro; return; }
    if (!carregado) return;
    const G = grupos(), T = { rep: 0, oc: 0, at: 0 }; G.forEach((g) => { T.rep += g.rep.length; T.oc += g.oc.length; T.at += g.at.length; });
    $("cm-info").textContent = `${fmt(U)} pedidos vencidos, vencendo hoje ou amanhã (pela nova data quando houver) · ficaram de fora: ` + (Object.entries(fora).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${fmt(v)}`).join(" · ") || "nenhum");
    $("cm-k-transp").textContent = fmt(G.length); $("cm-k-rep").textContent = fmt(T.rep); $("cm-k-oc").textContent = fmt(T.oc); $("cm-k-at").textContent = fmt(T.at);
    $("cm-k-env").textContent = `${fmt(G.filter((g) => enviados.has(g.k)).length)} de ${fmt(G.length)}`;
    const sel = $("cm-transp"), atual = transpSel;
    sel.innerHTML = `<option value="">Todas as transportadoras</option>` + G.map((g) => `<option value="${esc(g.k)}"${g.k === atual ? " selected" : ""}>${esc(g.nome)} (${tot(g)})</option>`).join("");
    $("cm-linhas").innerHTML = G.map((g) => {
      const c = contatos.get(g.k), env = enviados.has(g.k);
      return `<tr class="${env ? "cm-enviado" : ""}${g.k === transpSel ? " cm-sel" : ""}" data-k="${esc(g.k)}">
        <td><button class="link cm-ver" type="button">${esc(g.nome)}</button></td>
        <td class="num">${fmt(g.rep.length)}</td><td class="num">${fmt(g.oc.length)}</td><td class="num">${fmt(g.at.length)}</td><td class="num"><b>${fmt(tot(g))}</b></td>
        <td class="cm-mail">${c && c.emails ? `<button class="link cm-mail-cp" type="button" title="Copiar e-mails">${esc(c.emails)}</button>${c.cc ? `<div class="s">cc: ${esc(c.cc)}</div>` : ""}` : `<span class="s">sem e-mail cadastrado</span>`}</td>
        <td class="cm-acoes"><button class="btn contorno pequeno cm-xl" type="button">⬇ Excel</button> <button class="btn contorno pequeno cm-tx" type="button">⧉ Texto</button> <button class="btn contorno pequeno cm-ct" type="button" title="Cadastrar e-mails da transportadora">📇</button> <button class="btn pequeno ${env ? "verde" : "contorno"} cm-ok" type="button" title="Marque depois de enviar">${env ? "✓ Enviado hoje" : "✓ Enviei"}</button></td></tr>`;
    }).join("") || `<tr><td colspan="7" class="vazio">Nada para cobrar agora. 🎉</td></tr>`;
    desenharCasos(G);
  }
  function desenharCasos(G) {
    const q = norm(busca).split(/[\s,;]+/).filter(Boolean);
    const L = G.filter((g) => !transpSel || g.k === transpSel).flatMap((g) => (tipoSel ? g[tipoSel] : [...g.rep, ...g.oc, ...g.at]).map((x) => ({ ...x, nome: g.nome })))
      .filter((x) => !q.length || q.some((b) => norm(x.nf).includes(b) || norm(x.pedido).includes(b) || norm(x.nfNova).includes(b) || norm(x.ticket).includes(b)))
      .sort((a, b) => a.diasEf - b.diasEf);
    $("cm-casos-tit").textContent = `Casos para cobrar${transpSel ? " · " + (G.find((g) => g.k === transpSel)?.nome || "") : ""} (${fmt(L.length)})`;
    const sit = (x) => `<b class="${x.diasEf < 0 ? "txt-vermelho" : ""}">${venceTxt(x.diasEf)}</b><div class="s">prometido ${br(x.prom)}${x.nova ? " · nova data da transportadora " + br(x.nova) : ""}</div>`;
    $("cm-casos").innerHTML = L.slice(0, 500).map((x) => x.tipo === "rep"
      ? `<tr><td><span class="chip azul">Reposição</span></td><td>${esc(x.nome)}</td><td>${esc(x.nf)}<div class="s">${esc(x.pedido)}</div></td><td>NF nova ${esc(x.nfNova)}${x.emissao ? `<div class="s">emitida ${br(x.emissao)}${x.saida ? " · saiu " + br(x.saida) : ""}</div>` : ""}</td><td>${x.ticket ? `<a href="https://appv2.360multi.com/tickets/${encodeURIComponent(x.ticket)}" target="_blank" rel="noopener noreferrer">#${esc(x.ticket)}</a>` : ""}<div class="s">${esc(x.fila || "")}</div></td><td>${esc(x.st)}<div class="s">${esc(x.micro)}</div></td><td>${sit(x)}</td></tr>`
      : x.tipo === "at" ? `<tr><td><span class="chip">Entrega</span></td><td>${esc(x.nome)}</td><td>${esc(x.nf)}<div class="s">${esc(x.pedido)}</div></td><td>${esc(x.obs || "")}</td><td></td><td>${esc(x.st)}<div class="s">${esc(x.micro)}</div></td><td>${sit(x)}</td></tr>`
      : `<tr><td><span class="chip laranja">Ocorrência</span></td><td>${esc(x.nome)}</td><td>${esc(x.nf)}<div class="s">${esc(x.pedido)}</div></td><td>${esc(x.motivo || "")}${x.msg ? `<div class="s" title="${esc(x.msg)}">última msg ${br(x.msgEm)}: ${esc(String(x.msg).slice(0, 90))}${String(x.msg).length > 90 ? "…" : ""}</div>` : ""}</td><td><a href="https://ccp.360multi.com/occurrences/${encodeURIComponent(x.nf)}" target="_blank" rel="noopener noreferrer">ver no portal ↗</a></td><td>${esc(x.st)}<div class="s">${esc(x.micro)}</div></td><td>${sit(x)}</td></tr>`).join("")
      + (L.length > 500 ? `<tr><td colspan="7" class="s">Mostrando 500 de ${fmt(L.length)}: o Excel traz todos.</td></tr>` : "");
    $("cm-casos-vazio").hidden = !!L.length;
  }

  const acharG = (k) => grupos().find((g) => g.k === k);
  $("cm-linhas").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-k]"); if (!tr) return; const k = tr.dataset.k, g = acharG(k); if (!g) return;
    if (e.target.closest(".cm-xl")) excel(g);
    else if (e.target.closest(".cm-tx")) copiar(texto(g), "Texto copiado: cole no corpo do e-mail.");
    else if (e.target.closest(".cm-mail-cp")) copiar([contatos.get(k)?.emails, contatos.get(k)?.cc].filter(Boolean).join("; "), "E-mails copiados.");
    else if (e.target.closest(".cm-ct")) { const cb = window.__cobranca; if (!cb) return toast("Recarregue a página (Ctrl+F5).", true); Promise.resolve(cb.carregar()).then(() => cb.contato(g.nome, () => carregar())); }
    else if (e.target.closest(".cm-ok")) { enviados.has(k) ? enviados.delete(k) : enviados.add(k); salvaEnv(); desenhar(); }
    else if (e.target.closest(".cm-ver")) { transpSel = transpSel === k ? "" : k; desenhar(); $("cm-casos-cartao").scrollIntoView({ behavior: "smooth", block: "start" }); }
  });
  $("cm-transp").addEventListener("change", (e) => { transpSel = e.target.value; desenhar(); });
  $("cm-tipo").addEventListener("change", (e) => { tipoSel = e.target.value; desenhar(); });
  $("cm-busca").addEventListener("input", (e) => { busca = e.target.value; desenharCasos(grupos()); });
  $("cm-xl-todas").addEventListener("click", () => { const G = grupos(); if (!G.length) return toast("Nada para cobrar.", true); excelTodas(G); });
  $("cm-xl-cada").addEventListener("click", async () => {
    const G = grupos().filter((g) => !enviados.has(g.k)); if (!G.length) return toast("Todas já foram enviadas hoje.", true);
    toast(`Baixando ${G.length} arquivos (1 por transportadora)… se o navegador perguntar, permita vários downloads.`);
    for (const g of G) { excel(g); await new Promise((r) => setTimeout(r, 600)); }
  });
  $("cm-recarregar").addEventListener("click", carregar);
  document.querySelector(".menu-lateral").addEventListener("click", (e) => { const b = e.target.closest(".menu-item"); if (b && b.dataset.pagina === "cobmassa") carregar(); });
  window.__cobMassa = { carregar };
  // abriu a página (menu, Ctrl+F5 que volta nela, etc.): carrega se ainda não carregou
  new MutationObserver(() => { if (!$("pagina-cobmassa").hidden && !carregado && window.__sb) carregar(); }).observe($("pagina-cobmassa"), { attributes: true, attributeFilter: ["hidden"] });
  const espera = setInterval(() => { if (window.__sb && !$("pagina-cobmassa").hidden && !carregado) { clearInterval(espera); carregar(); } }, 1500);
  setTimeout(() => clearInterval(espera), 60000);
})();
