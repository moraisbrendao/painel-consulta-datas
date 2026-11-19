// Reposições › Filas atualizadas e ocorrências (parte 52)
//  Filas: tickets em aberto da tabela de acompanhamento, por responsável (editável) › fila × dias.
//  Ocorrências: aba Ocorrências do detalhamento de tickets, por transportador × dias sem atualização (como a Planilha1 da Logística).
//  Toda célula abre os casos (com link) e exporta.
(function () {
  const $ = (id) => document.getElementById(id);
  if (!$("rp-filas")) return;
  const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
  const fmt = (n) => Number(n || 0).toLocaleString("pt-BR");
  const pt = (a, b) => String(a).localeCompare(String(b), "pt-BR");
  const toast = (msg, erro) => { const t = $("toast"); if (!t) return alert(msg); t.textContent = msg; t.classList.toggle("erro", !!erro); t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), erro ? 6000 : 3500); };
  const sb = () => { const c = window.__sb; if (!c) throw new Error("Entre no painel de novo (sessão expirada)."); return c; };
  const hora = (d) => (d ? new Date(d).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "");
  const brD = (d) => (d ? String(d).slice(0, 10).split("-").reverse().join("/") : "");
  const chaveNF = (v) => String(v ?? "").trim().split("-").map((x) => x.trim().replace(/\.0+$/, "").replace(/^0+(?=\d)/, "")).join("-");
  const hojeMs = () => { const d = new Date(); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); };
  // dias de calendário entre a data (sem hora) e hoje
  const diasDe = (ts) => { const m = String(ts || "").match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? Math.max(0, Math.round((hojeMs() - Date.UTC(+m[1], m[2] - 1, +m[3])) / 864e5)) : null; };
  const FAIXAS = [["+50 dias", 50, 1e9], ["+40 dias", 40, 49], ["+30 dias", 30, 39], ["+20 dias", 20, 29], ["+10 dias", 10, 19], ["+5 dias", 5, 9], ["4 dias", 4, 4], ["3 dias", 3, 3], ["2 dias", 2, 2], ["1 dia", 1, 1], ["Hoje", 0, 0]];
  const faixa = (n) => (n == null ? -1 : FAIXAS.findIndex(([, a, b]) => n >= a && n <= b));
  const VERM = 3;   // até o índice 3 (+20 dias) fica em vermelho
  const SEM_RESP = "Sem responsável";
  const ls = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (_) { return null; } };

  let vis = ls("painel.fo.vis") === "oc" ? "oc" : "filas", porO = ls("painel.fo.por") === "canal" ? "canal" : "transp", modoDias = ls("painel.fo.dias") === "criado" ? "criado" : "atual", editar = false;
  let F = [], fInfo = null, resp = new Map(), fOk = true, O = [], oInfo = null, oOk = true, carregou = false, tk = null;
  let sel = null;   // célula aberta: { vis, g, f, fx }
  const filtros = { grupo: new Set(), resp: new Set(), ostatus: new Set(), osol: new Set(["Transportador"]), omacro: new Set(), ocanal: new Set(), otransp: new Set() };
  // filtros ficam gravados neste navegador e só mudam quando a pessoa mexe neles
  try { const g = JSON.parse(ls("painel.fo.filtros") || "null"); if (g) Object.keys(filtros).forEach((k) => { if (Array.isArray(g[k])) filtros[k] = new Set(g[k]); }); } catch (_) {}
  const guardarFiltros = () => ls("painel.fo.filtros", JSON.stringify(Object.fromEntries(Object.entries(filtros).map(([k, v]) => [k, [...v]]))));

  // ---------- leitura ----------
  async function todas(tab, sel, chave) {
    const out = []; let ult = null;
    for (;;) { let q = sb().from(tab).select(sel).order(chave); if (ult != null) q = q.gt(chave, ult);
      const { data, error } = await q.limit(1000); if (error) throw error; out.push(...data); if (data.length < 1000) break; ult = data[data.length - 1][chave]; }
    return out;
  }
  const falta52 = (e) => /filas_tk|ocorrencias_tk|fila_responsavel|does not exist|schema cache/i.test((e && e.message) || "");
  async function carregar() {
    $("fo-info").textContent = "Carregando…";
    try {
      const [f, i, r] = await Promise.all([todas("filas_tk", "*", "ticket"), sb().from("filas_tk_info").select("*").limit(1), sb().from("fila_responsavel").select("*")]);
      if (i.error) throw i.error; if (r.error) throw r.error;
      F = f; fInfo = (i.data || [])[0] || null; resp = new Map((r.data || []).filter((x) => x.responsavel).map((x) => [norm(x.fila), x.responsavel])); fOk = true;
    } catch (e) { fOk = false; F = []; $("fo-info").textContent = falta52(e) ? "Para usar esta aba, rode a parte 52 no Supabase." : "Não consegui carregar: " + (e.message || e); }
    try {
      const [o, i] = await Promise.all([todas("ocorrencias_tk", "*", "id"), sb().from("ocorrencias_tk_info").select("*").limit(1)]);
      if (i.error) throw i.error; O = o; oInfo = (i.data || [])[0] || null; oOk = true;
    } catch (e) { oOk = false; O = []; }
    carregou = true; desenhar();
  }
  async function ticketsPorNF() {   // tickets abertos de cada nota (aba Tickets do detalhamento), para o link do caso
    if (tk) return tk;
    try { const L = await todas("tickets_abertos", "nf,id_ticket,fila", "nf"); tk = new Map(L.map((x) => [chaveNF(x.nf), x])); } catch (_) { tk = new Map(); }
    return tk;
  }

  // ---------- filas ----------
  const respDe = (fila) => resp.get(norm(fila)) || SEM_RESP;
  const filaDe = (x) => x.fila || "(sem fila)";
  const diasFila = (x) => diasDe(modoDias === "criado" ? x.criado_em : x.atualizado_em || x.criado_em);
  const passaF = (x) => (!filtros.grupo.size || filtros.grupo.has(x.grupo || "(sem grupo)")) && (!filtros.resp.size || filtros.resp.has(respDe(filaDe(x))));
  // ---------- ocorrências ----------
  const transpO = (x) => { const t = (x.transportador || "").trim(); return /TEMPO JUSTO|^VM TRANSP/.test(norm(t)) ? "VM Transportes / Tempo Justo" : t || "(sem transportador)"; };
  const canalO = (x) => { const c = (x.canal || "").trim(); return c ? c.replace(/_/g, " ").toLowerCase().replace(/(^|\s)\S/g, (m) => m.toUpperCase()) : "(sem canal)"; };
  const val = (v) => (v && String(v).trim()) || "(vazio)";
  const diasO = (x) => (x.mensagem_em ? diasDe(x.mensagem_em) : x.dias_arquivo != null && oInfo ? x.dias_arquivo + diasDe(oInfo.enviado_em.slice(0, 10)) : diasDe(x.criado_em));
  const OF = { ostatus: (x) => val(x.status), osol: (x) => val(x.solicitante), omacro: (x) => val(x.status_macro), ocanal: canalO, otransp: transpO };
  const passaO = (x, menos) => Object.entries(OF).every(([k, f]) => k === menos || !filtros[k].size || filtros[k].has(f(x)));

  // filtro de vários itens (como o filtro da tabela dinâmica)
  function multi(k, rot, valores) {
    const s = filtros[k]; [...s].forEach((v) => { if (!valores.includes(v)) valores.push(v); });
    const resumo = !s.size ? "Todos" : s.size === 1 ? [...s][0] : "Vários itens";
    return `<div class="fo-multi" data-k="${k}"><span class="fo-multi-rot">${esc(rot)}</span><details><summary title="${esc([...s].join(", "))}">${esc(resumo)}</summary><div class="fo-multi-lista">
      <label class="fo-todos"><input type="checkbox" data-todos="${k}" ${s.size ? "" : "checked"}> (Tudo)</label>
      ${valores.map((v) => `<label><input type="checkbox" data-mk="${k}" value="${esc(v)}" ${s.has(v) ? "checked" : ""}> ${esc(v)}</label>`).join("")}</div></details></div>`;
  }
  const uniq = (L, f) => [...new Set(L.map(f))].sort(pt);

  function celula(n, g, f, fx, cls = "") {
    const red = fx >= 0 && fx <= VERM ? " red" : "";
    return n ? `<td class="num${red} ${cls}"><a href="#" data-g="${esc(g)}" data-f="${esc(f)}" data-fx="${fx}">${fmt(n)}</a></td>` : `<td class="num vz ${cls}">·</td>`;
  }
  const contar = (rs, dias) => { const v = FAIXAS.map(() => 0); rs.forEach((x) => { const i = faixa(dias(x)); if (i >= 0) v[i]++; }); return v; };
  const cab = (rot) => `<tr><th>${rot}</th>${FAIXAS.map(([t], i) => `<th class="num${i <= VERM ? " red" : ""}">${t}</th>`).join("")}<th class="num">Total</th></tr>`;
  const agrupa = (L, f) => { const m = new Map(); L.forEach((x) => { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }); return m; };

  function desenharFilas() {
    $("fo-filtros").innerHTML = multi("grupo", "Grupo", uniq(F, (x) => x.grupo || "(sem grupo)")) + multi("resp", "Responsável", [...new Set([...F.map((x) => respDe(filaDe(x))), ...resp.values()])].sort(pt))
      + `<label class="fo-sel">Dias contados desde<select id="fo-dias"><option value="atual"${modoDias === "atual" ? " selected" : ""}>a última atualização do ticket</option><option value="criado"${modoDias === "criado" ? " selected" : ""}>a criação do ticket</option></select></label>`
      + `<button type="button" class="btn mini ${editar ? "amarelo" : "contorno"}" id="fo-editar">✎ ${editar ? "Terminar edição" : "Editar responsáveis"}</button>`
      + `<button type="button" class="link limpar" id="fo-limpar">Limpar filtros</button>`;
    const L = F.filter(passaF);
    const G = [...agrupa(L, (x) => respDe(filaDe(x))).entries()].sort((a, b) => (a[0] === SEM_RESP) - (b[0] === SEM_RESP) || b[1].length - a[1].length || pt(a[0], b[0]));
    let h = "";
    for (const [g, rs] of G) {
      const v = contar(rs, diasFila);
      h += `<tr class="fo-g"><td>▾ ${esc(g)}</td>${v.map((n, i) => celula(n, g, "*", i)).join("")}${celula(rs.length, g, "*", -1, "tot")}</tr>`;
      for (const [f, fs] of [...agrupa(rs, filaDe).entries()].sort((a, b) => b[1].length - a[1].length || pt(a[0], b[0]))) {
        const w = contar(fs, diasFila), r = resp.get(norm(f)) || "";
        h += `<tr class="fo-s"><td>${esc(f)}${editar ? `<input class="fo-resp" list="fo-pessoas" data-fila="${esc(f)}" value="${esc(r)}" placeholder="responsável">` : ""}</td>${w.map((n, i) => celula(n, g, f, i)).join("")}${celula(fs.length, g, f, -1, "tot")}</tr>`;
      }
    }
    const t = contar(L, diasFila);
    h += L.length ? `<tr class="fo-t"><td>Total geral</td>${t.map((n, i) => celula(n, "*", "*", i)).join("")}${celula(L.length, "*", "*", -1, "tot")}</tr>` : `<tr><td colspan="${FAIXAS.length + 2}" class="vz">${F.length ? "Nenhum ticket nesse filtro." : "Ainda sem tickets: suba a tabela de acompanhamento (botão acima)."}</td></tr>`;
    $("fo-cab").innerHTML = cab("Responsável / Fila");
    $("fo-corpo").innerHTML = h;
    $("fo-pessoas").innerHTML = [...new Set(resp.values())].sort(pt).map((p) => `<option value="${esc(p)}">`).join("");
    $("fo-sub").textContent = `${fmt(L.length)} tickets em aberto (status diferente de Resolvido/Encerrado). Dias desde ${modoDias === "criado" ? "a criação do ticket" : "a última atualização do ticket"}; vermelho = 20 dias ou mais. ${editar ? "Escreva o responsável de cada fila: grava sozinho e vale para toda a Logística." : "Clique num número para ver os tickets."}`;
  }

  const linhaO = () => (porO === "canal" ? canalO : transpO);   // linhas do quadro: transportadora ou canal
  function desenharOc() {
    $("fo-filtros").innerHTML = multi("ostatus", "Status Ocorrência", uniq(O, OF.ostatus)) + multi("osol", "Último Solicitante", uniq(O, OF.osol)) + multi("omacro", "Status macro Intelipost", uniq(O, OF.omacro))
      + `<label class="fo-sel">Ver por<select id="fo-por"><option value="transp"${porO === "transp" ? " selected" : ""}>Transportadora</option><option value="canal"${porO === "canal" ? " selected" : ""}>Canal</option></select></label>`
      + (porO === "canal" ? multi("ocanal", "Canal", uniq(O, OF.ocanal)) : multi("otransp", "Transportadora", uniq(O, OF.otransp))) + `<button type="button" class="link limpar" id="fo-limpar">Limpar filtros</button>`;
    const L = O.filter((x) => passaO(x));
    const G = [...agrupa(L, linhaO()).entries()].sort((a, b) => pt(a[0], b[0]));
    let h = G.map(([g, rs]) => { const v = contar(rs, diasO); return `<tr class="fo-s fo-s1"><td>${esc(g)}</td>${v.map((n, i) => celula(n, g, "*", i)).join("")}${celula(rs.length, g, "*", -1, "tot")}</tr>`; }).join("");
    const t = contar(L, diasO);
    h += L.length ? `<tr class="fo-t"><td>Total geral</td>${t.map((n, i) => celula(n, "*", "*", i)).join("")}${celula(L.length, "*", "*", -1, "tot")}</tr>` : `<tr><td colspan="${FAIXAS.length + 2}" class="vz">${O.length ? "Nenhuma ocorrência nesse filtro." : oOk ? "Ainda sem ocorrências: clique em Carregar tickets no topo (detalhamento) ou em Carregar ocorrências." : "Para usar esta visão, rode a parte 52 no Supabase."}</td></tr>`;
    $("fo-cab").innerHTML = cab(porO === "canal" ? "Canal" : "Transportador");
    $("fo-corpo").innerHTML = h;
    $("fo-sub").textContent = `${fmt(L.length)} ocorrências (contagem de nota fiscal). Dias sem atualização = desde a data da última mensagem; vermelho = 20 dias ou mais. Clique num número para ver os casos.`;
  }

  function desenhar() {
    if (!carregou) return;
    guardarFiltros();
    document.querySelectorAll("#fo-vis [data-vis]").forEach((b) => { b.classList.toggle("amarelo", b.dataset.vis === vis); b.classList.toggle("contorno", b.dataset.vis !== vis); });
    $("fo-titulo").textContent = vis === "filas" ? "Filas atualizadas · tickets em aberto por responsável e fila" : `Ocorrências · por ${porO === "canal" ? "canal" : "transportador"} e dias sem atualização`;
    const inf = vis === "filas" ? fInfo : oInfo;
    if (vis === "filas" ? fOk : oOk) $("fo-info").textContent = inf ? `${vis === "filas" ? "Tabela de acompanhamento" : "Ocorrências"}: ${inf.arquivo || ""} · enviada em ${hora(inf.enviado_em)}${inf.enviado_por ? " por " + inf.enviado_por.split("@")[0] : ""}` : "Ainda não enviada.";
    else if (vis === "oc") $("fo-info").textContent = "Para usar esta visão, rode a parte 52 no Supabase.";
    $("fo-arq-oc-l").hidden = vis !== "oc"; $("fo-arq-tab-l").hidden = vis !== "filas";
    if (vis === "filas") desenharFilas(); else desenharOc();
    desenharCasos();
  }

  // ---------- casos de uma célula ----------
  function casosSel() {
    if (!sel || sel.vis !== vis) return null;
    const { g, f, fx } = sel, q = +fx;
    if (vis === "filas") return F.filter(passaF).filter((x) => (g === "*" || respDe(filaDe(x)) === g) && (f === "*" || filaDe(x) === f) && (q < 0 || faixa(diasFila(x)) === q)).sort((a, b) => (diasFila(b) ?? -1) - (diasFila(a) ?? -1));
    return O.filter((x) => passaO(x)).filter((x) => (g === "*" || linhaO()(x) === g) && (q < 0 || faixa(diasO(x)) === q)).sort((a, b) => (diasO(b) ?? -1) - (diasO(a) ?? -1));
  }
  const linkTk = (id) => `<a href="https://appv2.360multi.com/tickets/${encodeURIComponent(id)}" target="_blank" rel="noopener noreferrer" title="Abrir o ticket no Multi360">#${esc(id)} ↗</a>`;
  const linkOc = (nf) => `https://ccp.360multi.com/occurrences/${encodeURIComponent(chaveNF(nf))}`;   // ocorrência no portal do transportador: /occurrences/NF-série
  function basePorNF() { const b = (window.__basePainel && window.__basePainel()) || []; const m = new Map(); b.forEach((p) => { if (p.nf) m.set(chaveNF(p.nf), p); }); return m; }
  function desenharCasos() {
    const box = $("fo-casos"), L = casosSel();
    box.hidden = !L;
    if (!L) return;
    const { g, f, fx } = sel, rotF = +fx >= 0 ? FAIXAS[+fx][0] : "todos os dias";
    $("fo-casos-tit").textContent = `${[g === "*" ? (vis === "filas" ? "Todos os responsáveis" : "Todas as transportadoras") : g, f !== "*" ? f : ""].filter(Boolean).join(" › ")} · ${rotF} · ${fmt(L.length)} ${vis === "filas" ? "tickets" : "ocorrências"}`;
    const V = L.slice(0, 400);
    if (vis === "filas") {
      $("fo-casos-t").innerHTML = `<thead><tr><th>Ticket</th><th>NF / pedido</th><th>Fila</th><th>Tipo · motivo</th><th>Status</th><th>Transportadora</th><th>Canal</th><th class="num">Dias</th><th>Criado</th><th>Última atualização</th></tr></thead><tbody>`
        + V.map((x) => `<tr><td>${linkTk(x.ticket)}</td><td>${esc(x.nf || "—")}<div class="s">${esc(x.pedido || "")}</div></td><td>${esc(filaDe(x))}<div class="s">${esc(respDe(filaDe(x)))}</div></td><td>${esc(x.tipo || "")}<div class="s">${esc(x.motivo || "")}</div></td><td>${esc(x.status || "")}</td><td>${esc(x.transportadora || "")}</td><td>${esc(x.canal || "")}</td><td class="num">${diasFila(x) ?? "—"}</td><td>${brD(x.criado_em)}</td><td>${brD(x.atualizado_em)}</td></tr>`).join("") + "</tbody>";
    } else {
      const B = basePorNF(), T = tk || new Map();
      $("fo-casos-t").innerHTML = `<thead><tr><th>NF</th><th>Transportador</th><th>Motivo · status</th><th>Canal</th><th>Último solicitante</th><th>Última mensagem</th><th class="num">Dias</th><th>Intelipost</th><th>Links</th></tr></thead><tbody>`
        + V.map((x) => { const nf = chaveNF(x.nf), p = B.get(nf), t = T.get(nf), ids = String((t && t.id_ticket) || "").split(",").map((s) => s.trim()).filter(Boolean);
          return `<tr><td><a href="${linkOc(x.nf)}" target="_blank" rel="noopener noreferrer" title="Abrir a ocorrência no portal do transportador"><b>${esc(x.nf)}</b> ↗</a>${p ? `<div class="s">${esc(p.pedido || "")}</div>` : ""}</td><td>${esc(transpO(x))}</td><td>${esc(x.motivo || "")}<div class="s">${esc(x.status || "")} · ${esc(x.operacao || "")} · aberta ${brD(x.criado_em)}</div></td><td>${esc(canalO(x))}</td><td>${esc(x.solicitante || "")}</td>
            <td class="fo-msg">${esc(x.mensagem || "")}<div class="s">${hora(x.mensagem_em ? String(x.mensagem_em).replace(" ", "T") : "")}</div></td><td class="num">${diasO(x) ?? "—"}</td>
            <td>${esc(x.status_macro || "—")}<div class="s">${esc(x.status_micro || "")}</div></td>
            <td class="fo-links"><a class="btn mini amarelo" href="${linkOc(x.nf)}" target="_blank" rel="noopener noreferrer" title="Abre a ocorrência dessa NF no portal do transportador">Abrir ocorrência ↗</a> ${ids.map(linkTk).join(" ")}${t && t.fila ? `<div class="s">fila ${esc(t.fila)}</div>` : ""}${p && /^https?:\/\//i.test(p.link_rastreio || "") ? `<a href="${esc(p.link_rastreio)}" target="_blank" rel="noopener noreferrer">Intelipost ↗</a> ` : ""}<button type="button" class="btn mini contorno" data-rastreio="${esc(x.nf)}" data-transp="${esc((p && p.transportadora) || x.transportador || "")}" data-pedido="${esc((p && p.pedido) || "")}">Ver rastreio ↗</button></td></tr>`; }).join("") + "</tbody>";
    }
    $("fo-casos-mais").textContent = L.length > V.length ? `Mostrando ${fmt(V.length)} de ${fmt(L.length)}. "Exportar estes casos" traz todos.` : "";
  }

  // ---------- Excel ----------
  const CAB_F = ["Responsável", "Fila", "Ticket", "NF", "Pedido", "Grupo", "Tipo", "Motivo", "Status", "Transportadora", "Canal", "Dias", "Faixa", "Criado em", "Última atualização", "Link do ticket"];
  const linF = (x) => { const d = diasFila(x), i = faixa(d); return [respDe(filaDe(x)), filaDe(x), x.ticket, x.nf || "", x.pedido || "", x.grupo || "", x.tipo || "", x.motivo || "", x.status || "", x.transportadora || "", x.canal || "", d ?? "", i >= 0 ? FAIXAS[i][0] : "", brD(x.criado_em), brD(x.atualizado_em), `https://appv2.360multi.com/tickets/${x.ticket}`]; };
  const CAB_O = ["NF", "Transportador", "Data criação ocorrência", "Motivo", "Status ocorrência", "Operação", "Canal", "Último solicitante", "Última mensagem", "Data última mensagem", "Status macro Intelipost", "Status micro Intelipost", "Dias sem atualização", "Faixa", "Tickets abertos da NF", "Link da ocorrência"];
  const linO = (x) => { const d = diasO(x), i = faixa(d), t = (tk || new Map()).get(chaveNF(x.nf)); return [x.nf, transpO(x), brD(x.criado_em), x.motivo || "", x.status || "", x.operacao || "", canalO(x), x.solicitante || "", x.mensagem || "", brD(x.mensagem_em), x.status_macro || "", x.status_micro || "", d ?? "", i >= 0 ? FAIXAS[i][0] : "", (t && t.id_ticket) || "", linkOc(x.nf)]; };
  function baixar(L, nome) {
    if (!L.length) return toast("Nada para exportar.", true);
    const wb = XLSX.utils.book_new(), cab = vis === "filas" ? CAB_F : CAB_O, lin = vis === "filas" ? linF : linO;
    const ws = XLSX.utils.aoa_to_sheet([cab, ...L.map(lin)]); ws["!cols"] = cab.map((c) => ({ wch: Math.max(12, Math.min(40, c.length + 4)) }));
    // resumo igual ao quadro (linhas × faixas de dias)
    const dias = vis === "filas" ? diasFila : diasO, chave = vis === "filas" ? (x) => `${respDe(filaDe(x))} › ${filaDe(x)}` : linhaO();
    const res = [[vis === "filas" ? "Responsável › Fila" : porO === "canal" ? "Canal" : "Transportador", ...FAIXAS.map((f) => f[0]), "Total"]];
    [...agrupa(L, chave).entries()].sort((a, b) => pt(a[0], b[0])).forEach(([k, rs]) => res.push([k, ...contar(rs, dias).map((n) => n || ""), rs.length]));
    res.push(["Total geral", ...contar(L, dias), L.length]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(res), "Quadro");
    XLSX.utils.book_append_sheet(wb, ws, vis === "filas" ? "Tickets" : "Ocorrências");
    XLSX.writeFile(wb, `${nome}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  // ---------- planilha de ocorrências (aba Ocorrências do detalhamento ou a planilha da Logística) ----------
  function dataTxt(v) {
    if (v == null || v === "") return null;
    if (v instanceof Date) { const p = (n) => String(n).padStart(2, "0"); return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())} ${p(v.getHours())}:${p(v.getMinutes())}:${p(v.getSeconds())}`; }
    if (typeof v === "number" && v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 19).replace("T", " ");
    const s = String(v).trim(); let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/); if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4] || "00"}:${m[5] || "00"}:${m[6] || "00"}`;
    m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/); return m ? `${m[3]}-${m[2]}-${m[1]} ${m[4] || "00"}:${m[5] || "00"}:${m[6] || "00"}` : null;
  }
  function lerOcorrencias(wb) {
    const nomes = [...wb.SheetNames].sort((a, b) => (norm(b) === "OCORRENCIAS") - (norm(a) === "OCORRENCIAS"));
    for (const n of nomes) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null });
      const iC = rows.slice(0, 15).findIndex((r) => r && r.some((c) => norm(c) === "NOTA FISCAL") && r.some((c) => norm(c) === "TRANSPORTADOR") && r.some((c) => norm(c) === "STATUS OCORRENCIA"));
      if (iC < 0) continue;
      const cab = rows[iC].map(norm), c = (x) => cab.indexOf(x), txt = (r, i) => (i >= 0 && r[i] != null && String(r[i]).trim() !== "" && !/^#N\/?A/i.test(String(r[i])) ? String(r[i]).trim() : null);
      const k = { nf: c("NOTA FISCAL"), tr: c("TRANSPORTADOR"), cr: c("DATA CRIACAO OCORRENCIA"), mo: c("MOTIVO OCORRENCIA"), st: c("STATUS OCORRENCIA"), op: c("OPERACAO OCORRENCIA"), ca: c("CANAL"),
        so: c("ULTIMO SOLICITANTE"), me: c("ULTIMA MENSAGEM"), md: c("DATA ULTIMA MENSAGEM"), ma: c("STATUS MACRO INTELIPOST"), mi: c("STATUS MICRO INTELIPOST"), di: c("DIAS SEM ATUALIZACAO") };
      const L = [];
      rows.slice(iC + 1).forEach((r) => {
        const nf = r && txt(r, k.nf); if (!nf || !/\d/.test(nf)) return;
        const d = k.di >= 0 ? parseInt(r[k.di], 10) : NaN;
        L.push({ nf: chaveNF(nf), transportador: txt(r, k.tr), criado_em: dataTxt(r[k.cr]), motivo: txt(r, k.mo), status: txt(r, k.st), operacao: txt(r, k.op), canal: txt(r, k.ca), solicitante: txt(r, k.so),
          mensagem: (txt(r, k.me) || "").slice(0, 500) || null, mensagem_em: k.md >= 0 ? dataTxt(r[k.md]) : null, status_macro: txt(r, k.ma), status_micro: txt(r, k.mi), dias_arquivo: Number.isFinite(d) ? d : null });
      });
      return L;
    }
    return null;
  }
  async function enviarOcorrencias(wb, arquivo) {
    const L = lerOcorrencias(wb);
    if (!L) return "";
    for (let i = 0; i < L.length || i === 0; i += 1000) {
      const { error } = await sb().rpc("importar_ocorrencias_tk", { linhas: L.slice(i, i + 1000), limpar: i === 0, arquivo, total: L.length });
      if (error) { if (falta52(error) || /importar_ocorrencias_tk|function/i.test(error.message)) return " · ocorrências: falta rodar a parte 52 no Supabase"; throw error; }
    }
    if (!$("rp-filas").hidden) carregar(); else carregou = false;
    return ` · ${fmt(L.length)} ocorrências guardadas`;
  }
  window.__ocorr = { ler: lerOcorrencias, enviar: enviarOcorrencias };

  // ---------- eventos ----------
  $("rp-filas").addEventListener("click", async (e) => {
    const v = e.target.closest("#fo-vis [data-vis]");
    if (v) { vis = v.dataset.vis; ls("painel.fo.vis", vis); sel = null; if (vis === "oc") ticketsPorNF().then(desenharCasos); return desenhar(); }
    const a = e.target.closest("#fo-corpo a[data-g]");
    if (a) { e.preventDefault(); const n = { vis, g: a.dataset.g, f: a.dataset.f, fx: a.dataset.fx };
      sel = sel && sel.vis === n.vis && sel.g === n.g && sel.f === n.f && sel.fx === n.fx ? null : n;
      if (vis === "oc") await ticketsPorNF();
      desenharCasos(); if (sel) $("fo-casos").scrollIntoView({ block: "nearest", behavior: "smooth" }); return; }
    if (e.target.closest("#fo-casos-x")) { sel = null; return desenharCasos(); }
    if (e.target.closest("#fo-casos-exp")) return baixar(casosSel() || [], vis === "filas" ? "filas_casos" : "ocorrencias_casos");
    if (e.target.closest("#fo-excel")) return baixar(vis === "filas" ? F.filter(passaF) : O.filter((x) => passaO(x)), vis === "filas" ? "filas_atualizadas" : "ocorrencias");
    if (e.target.closest("#fo-editar")) { editar = !editar; return desenharFilas(); }
    if (e.target.closest("#fo-limpar")) { Object.values(filtros).forEach((s) => s.clear()); sel = null; return desenhar(); }
    const r = e.target.closest("[data-rastreio]");
    if (r && window.__abrirSSW) window.__abrirSSW(r.dataset.rastreio, r.dataset.transp, r.dataset.pedido);
  });
  $("rp-filas").addEventListener("change", async (e) => {
    const t = e.target;
    if (t.id === "fo-por") { porO = t.value; ls("painel.fo.por", porO); filtros.ocanal.clear(); filtros.otransp.clear(); sel = null; return desenhar(); }
    if (t.id === "fo-dias") { modoDias = t.value; ls("painel.fo.dias", modoDias); return desenhar(); }
    if (t.dataset.todos) { filtros[t.dataset.todos].clear(); return desenharMantendo(t.dataset.todos); }
    if (t.dataset.mk) { const s = filtros[t.dataset.mk]; if (t.checked) s.add(t.value); else s.delete(t.value); return desenharMantendo(t.dataset.mk); }
    if (t.classList.contains("fo-resp")) {
      const fila = t.dataset.fila, nome = t.value.trim();
      try {
        const { error } = nome ? await sb().from("fila_responsavel").upsert({ fila, responsavel: nome, atualizado_em: new Date().toISOString() }) : await sb().from("fila_responsavel").delete().eq("fila", fila);
        if (error) throw error;
        if (nome) resp.set(norm(fila), nome); else resp.delete(norm(fila));
        toast(nome ? `${fila}: responsável ${nome}.` : `${fila}: sem responsável.`); desenharFilas();
      } catch (err) { toast(falta52(err) ? "Rode a parte 52 no Supabase para editar os responsáveis." : "Não gravou: " + (err.message || err), true); }
    }
  });
  function desenharMantendo(k) { sel = null; desenhar(); const d = document.querySelector(`.fo-multi[data-k="${k}"] details`); if (d) d.open = true; }
  document.addEventListener("click", (e) => { if (!e.target.closest(".fo-multi")) document.querySelectorAll(".fo-multi details[open]").forEach((d) => (d.open = false)); });
  $("fo-arq-oc").addEventListener("change", async (e) => {
    const arq = e.target.files[0]; e.target.value = ""; if (!arq) return;
    try {
      const wb = XLSX.read(await arq.arrayBuffer(), { type: "array", dense: true, cellDates: true });
      const L = lerOcorrencias(wb);
      if (!L) return toast('Não achei as colunas "Nota Fiscal", "Transportador" e "Status Ocorrência" nessa planilha.', true);
      if (!confirm(`${arq.name}\n\n${fmt(L.length)} ocorrências. Substitui as ocorrências guardadas para todos.\n\nEnviar?`)) return;
      toast("Enviando…"); const msg = await enviarOcorrencias(wb, arq.name); toast("Ocorrências atualizadas" + msg + ".", /falta/.test(msg));
      carregar();
    } catch (err) { toast("Erro: " + (err.message || err), true); }
  });
  window.addEventListener("filas-atualizadas", () => { carregou = false; if (!$("rp-filas").hidden) carregar(); });
  new MutationObserver(() => { if (!$("rp-filas").hidden && !carregou) { carregar(); if (vis === "oc") ticketsPorNF(); } }).observe($("rp-filas"), { attributes: true, attributeFilter: ["hidden"] });
  if (!$("rp-filas").hidden) carregar();
})();
