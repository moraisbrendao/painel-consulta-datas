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
  const chaveT = (n) => { const t = norm(n); if (!t) return "(SEM TRANSPORTADORA)"; if (/TEMPO JUSTO|^VM\b|VM TRANSPORTES/.test(t)) return "VM / TEMPO JUSTO"; return t.replace(/[.,\-/]/g, " ").replace(RUIDO, " ").replace(/\s+/g, " ").trim() || t; };

  let R = [], O = [], contatos = new Map(), carregado = false, ok = true, msgErro = "", transpSel = "", tipoSel = "", busca = "";
  const opt = { repoFora: true, ocorrFora: false };
  try { Object.assign(opt, JSON.parse(localStorage.getItem("painel.cm.opt") || "{}")); } catch (_) {}
  let enviados = new Set();
  try { const e = JSON.parse(localStorage.getItem("painel.cm.env") || "{}"); if (e.dia === hojeISO()) enviados = new Set(e.lista || []); } catch (_) {}
  const salvaEnv = () => { try { localStorage.setItem("painel.cm.env", JSON.stringify({ dia: hojeISO(), lista: [...enviados] })); } catch (_) {} };

  async function carregar() {
    $("cm-info").textContent = "Carregando reposições, ocorrências e o arquivo da Intelipost…";
    try {
      const [rp, tk, oc, cf, ct] = await Promise.all([
        tudo("repo_atual", "ticket,nota_ticket,nfs_novas,fila_atual,tipo_reposicao,transp_promob,transp_redesp_promob,data_emissao_nf,data_criacao_ticket", "ticket"),
        tudo("reposicoes_tk", "ticket,status", "ticket"),
        tudo("ocorrencias_tk", "id,nf,transportador,criado_em,motivo,status,solicitante,mensagem_em", "id"),
        tudo("conferencia_ssw", "pedido,nf,status_intelipost", "pedido"),
        sb().from("transp_contatos").select("transportadora,emails,cc").then((r) => r.data || []).catch(() => []),
      ]);
      const ST = new Map(); cf.forEach((c) => { if (c.nf) ST.set(nfK(c.nf), c.status_intelipost || ""); });
      const TK = new Map(tk.map((t) => [String(t.ticket), t.status || ""]));
      contatos = new Map(); ct.forEach((c) => contatos.set(chaveT(c.transportadora), c));
      R = rp.filter((r) => r.nfs_novas).map((r) => {
        const novas = String(r.nfs_novas).split(",").map((t) => t.trim()).filter(Boolean);
        const stNova = novas.map((n) => ST.get(nfK(n))).find((s) => s != null);
        const st = stNova != null ? stNova : ST.get(nfK(r.nota_ticket));
        const transp = r.transp_redesp_promob || r.transp_promob || "";
        return { tipo: "rep", ticket: r.ticket, nf: r.nota_ticket, nova: novas.join(", "), emissao: r.data_emissao_nf, criado: r.data_criacao_ticket, tipoRep: r.tipo_reposicao, fila: r.fila_atual,
          statusTk: TK.get(String(r.ticket)) || "", st: st ?? null, transp, k: chaveT(transp) };
      });
      O = oc.map((o) => ({ tipo: "oc", nf: o.nf, motivo: o.motivo, status: o.status, criado: o.criado_em, msgEm: o.mensagem_em, solicitante: o.solicitante, st: ST.has(nfK(o.nf)) ? ST.get(nfK(o.nf)) : null, transp: o.transportador || "", k: chaveT(o.transportador) }));
      ok = true; carregado = true;
    } catch (e) { ok = false; msgErro = e.message || String(e); }
    desenhar();
  }

  // regras
  const motivoFora = (x) => {
    if (x.tipo === "rep") {
      if (/RESOLVID|ENCERRAD/.test(norm(x.statusTk))) return "ticket resolvido/encerrado";
      if (/RECUPERACAO DE CREDITO/.test(norm(x.fila))) return "fila Recuperação de crédito";
    } else {
      if (!/EM ANDAMENTO/.test(norm(x.status))) return "ocorrência não está em andamento";
      if (x.st == null && !opt.ocorrFora) return "fora do arquivo da Intelipost";
    }
    if (x.st != null && FORA_IP.test(norm(x.st))) return "status Intelipost " + x.st;
    if (x.st != null && /^(ENTREGUE|CANCELADO)/.test(norm(x.st))) return "já " + x.st.toLowerCase();
    return "";
  };
  const cobraveis = () => [...R, ...O].filter((x) => !motivoFora(x));
  const nomeDe = (k, L) => { if (k === "VM / TEMPO JUSTO") return "VM Transportes / Tempo Justo"; const c = {}; L.forEach((x) => { if (x.k === k && x.transp) c[x.transp] = (c[x.transp] || 0) + 1; }); return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] || k; };
  function grupos() {
    const L = cobraveis(), G = new Map();
    L.forEach((x) => { const g = G.get(x.k) || { k: x.k, rep: [], oc: [] }; (x.tipo === "rep" ? g.rep : g.oc).push(x); G.set(x.k, g); });
    G.forEach((g) => (g.nome = nomeDe(g.k, L)));
    return [...G.values()].sort((a, b) => (enviados.has(a.k) - enviados.has(b.k)) || (b.rep.length + b.oc.length) - (a.rep.length + a.oc.length));
  }

  function texto(g) {
    const linhas = [`Olá, equipe ${g.nome}!`, "", "Precisamos do retorno de vocês nos casos abaixo (lista completa na planilha em anexo):"];
    if (g.rep.length) linhas.push(`• Reposições com nova NF emitida: ${g.rep.length}`);
    if (g.oc.length) linhas.push(`• Ocorrências em andamento: ${g.oc.length}`);
    linhas.push("", "Por favor, nos informem o status atualizado e a previsão de entrega de cada nota ainda hoje.", "", "Obrigada!");
    return linhas.join("\n");
  }
  const LIN_REP = (x) => ({ "Ticket": x.ticket, "NF original": x.nf, "NF de reposição": x.nova, "Emissão da NF nova": br(x.emissao), "Dias desde a emissão": dias(x.emissao), "Tipo de reposição": x.tipoRep || "", "Status Intelipost": x.st ?? "não está na Intelipost" });
  const LIN_OC = (x) => ({ "NF": x.nf, "Motivo": x.motivo || "", "Aberta em": br(x.criado), "Dias aberta": dias(x.criado), "Última mensagem em": br(x.msgEm), "Status Intelipost": x.st ?? "fora do arquivo" });
  const limpaNome = (t) => String(t).replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  function excel(g) {
    const wb = XLSX.utils.book_new();
    if (g.rep.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(g.rep.map(LIN_REP)), "Reposições");
    if (g.oc.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(g.oc.map(LIN_OC)), "Ocorrências");
    XLSX.writeFile(wb, `Cobrança ${limpaNome(g.nome)} ${hojeISO().split("-").reverse().join("-")}.xlsx`);
  }
  function excelTodas(G) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(G.map((g) => ({ "Transportadora": g.nome, "Reposições": g.rep.length, "Ocorrências": g.oc.length, "Total": g.rep.length + g.oc.length, "E-mails": contatos.get(g.k)?.emails || "", "Enviado hoje": enviados.has(g.k) ? "sim" : "" }))), "Resumo");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(G.flatMap((g) => g.rep.map((x) => ({ "Transportadora": g.nome, ...LIN_REP(x) })))), "Reposições");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(G.flatMap((g) => g.oc.map((x) => ({ "Transportadora": g.nome, ...LIN_OC(x) })))), "Ocorrências");
    XLSX.writeFile(wb, `Cobrança em massa ${hojeISO().split("-").reverse().join("-")}.xlsx`);
  }
  const copiar = async (t, ok) => { try { await navigator.clipboard.writeText(t); toast(ok); } catch (_) { const a = document.createElement("textarea"); a.value = t; document.body.appendChild(a); a.select(); document.execCommand("copy"); a.remove(); toast(ok); } };

  function desenhar() {
    if (!ok) { $("cm-info").textContent = "Não consegui carregar: " + msgErro; return; }
    if (!carregado) return;
    const G = grupos(), tot = { rep: 0, oc: 0 }; G.forEach((g) => { tot.rep += g.rep.length; tot.oc += g.oc.length; });
    const fora = {}; [...R, ...O].forEach((x) => { const m = motivoFora(x); if (m) fora[m] = (fora[m] || 0) + 1; });
    $("cm-info").textContent = `${fmt(R.length)} reposições com nova NF e ${fmt(O.length)} ocorrências lidas · ficaram de fora: ` + (Object.entries(fora).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${fmt(v)}`).join(" · ") || "nenhuma");
    $("cm-k-transp").textContent = fmt(G.length); $("cm-k-rep").textContent = fmt(tot.rep); $("cm-k-oc").textContent = fmt(tot.oc);
    $("cm-k-env").textContent = `${fmt(G.filter((g) => enviados.has(g.k)).length)} de ${fmt(G.length)}`;
    $("cm-op-oc").checked = opt.ocorrFora;
    const sel = $("cm-transp"), atual = transpSel;
    sel.innerHTML = `<option value="">Todas as transportadoras</option>` + G.map((g) => `<option value="${esc(g.k)}"${g.k === atual ? " selected" : ""}>${esc(g.nome)} (${g.rep.length + g.oc.length})</option>`).join("");
    $("cm-linhas").innerHTML = G.map((g) => {
      const c = contatos.get(g.k), env = enviados.has(g.k);
      return `<tr class="${env ? "cm-enviado" : ""}${g.k === transpSel ? " cm-sel" : ""}" data-k="${esc(g.k)}">
        <td><button class="link cm-ver" type="button">${esc(g.nome)}</button></td>
        <td class="num">${fmt(g.rep.length)}</td><td class="num">${fmt(g.oc.length)}</td><td class="num"><b>${fmt(g.rep.length + g.oc.length)}</b></td>
        <td class="cm-mail">${c && c.emails ? `<button class="link cm-mail-cp" type="button" title="Copiar e-mails">${esc(c.emails)}</button>${c.cc ? `<div class="s">cc: ${esc(c.cc)}</div>` : ""}` : `<span class="s">sem e-mail cadastrado</span>`}</td>
        <td class="cm-acoes"><button class="btn contorno pequeno cm-xl" type="button">⬇ Excel</button> <button class="btn contorno pequeno cm-tx" type="button">⧉ Texto</button> <button class="btn contorno pequeno cm-ct" type="button" title="Cadastrar e-mails da transportadora">📇</button> <button class="btn pequeno ${env ? "verde" : "contorno"} cm-ok" type="button" title="Marque depois de enviar">${env ? "✓ Enviado hoje" : "✓ Enviei"}</button></td></tr>`;
    }).join("") || `<tr><td colspan="6" class="vazio">Nada para cobrar agora. 🎉</td></tr>`;
    desenharCasos(G);
  }
  function desenharCasos(G) {
    const q = norm(busca).split(/[\s,;]+/).filter(Boolean);
    const L = G.filter((g) => !transpSel || g.k === transpSel).flatMap((g) => [...(tipoSel === "oc" ? [] : g.rep), ...(tipoSel === "rep" ? [] : g.oc)].map((x) => ({ ...x, nome: g.nome })))
      .filter((x) => !q.length || q.some((b) => norm(x.nf).includes(b) || norm(x.nova).includes(b) || norm(x.ticket).includes(b)));
    $("cm-casos-tit").textContent = `Casos para cobrar${transpSel ? " · " + (G.find((g) => g.k === transpSel)?.nome || "") : ""} (${fmt(L.length)})`;
    $("cm-casos").innerHTML = L.slice(0, 500).map((x) => x.tipo === "rep"
      ? `<tr><td><span class="chip azul">Reposição</span></td><td>${esc(x.nome)}</td><td>${esc(x.nf)}</td><td>${esc(x.nova)}${x.emissao ? `<div class="s">emitida ${br(x.emissao)}</div>` : ""}</td><td>${x.ticket ? `<a href="https://appv2.360multi.com/tickets/${encodeURIComponent(x.ticket)}" target="_blank" rel="noopener noreferrer">#${esc(x.ticket)}</a>` : ""}<div class="s">${esc(x.fila || "")}</div></td><td>${esc(x.st ?? "não está na Intelipost")}</td><td class="num">${dias(x.emissao)}</td></tr>`
      : `<tr><td><span class="chip laranja">Ocorrência</span></td><td>${esc(x.nome)}</td><td>${esc(x.nf)}</td><td>${esc(x.motivo || "")}</td><td><a href="https://ccp.360multi.com/occurrences/${encodeURIComponent(x.nf)}" target="_blank" rel="noopener noreferrer">ver no portal ↗</a></td><td>${esc(x.st ?? "fora do arquivo")}</td><td class="num">${dias(x.criado)}</td></tr>`).join("")
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
  const salvaOpt = () => { try { localStorage.setItem("painel.cm.opt", JSON.stringify(opt)); } catch (_) {} };
  $("cm-op-oc").addEventListener("change", (e) => { opt.ocorrFora = e.target.checked; salvaOpt(); desenhar(); });
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
