// Preventivo · Retornos das transportadoras: controle da semana (o retorno mudou? quantas vezes?) e auditoria
// (o retorno é crível pelo histórico de entregas do CEP e pelos dias parados?). Só leitura: retornos_hist (parte 40),
// tempos_referencia (parte 51) e a base que o Preventivo já carregou.
(function () {
  const $ = (id) => document.getElementById(id);
  if (!$("rs-box")) return;
  const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
  const fmt = (n) => Number(n || 0).toLocaleString("pt-BR");
  const br = (iso) => (iso ? String(iso).slice(0, 10).split("-").reverse().join("/") : "");
  const dm = (iso) => (iso ? br(iso).slice(0, 5) : "");
  const diaBR = (ts) => (ts ? new Date(ts).toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" }) : null);
  const hojeISO = () => diaBR(Date.now());
  const somaDias = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const diasCorr = (a, b) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 864e5);
  // dias úteis de a (exclusive) até b (inclusive), sem sábado e domingo (o motor também tira os feriados do destino)
  function diasUteis(a, b) {
    if (!a || !b || b <= a) return 0;
    let n = 0, d = new Date(a + "T12:00:00Z"); const fim = Date.parse(b + "T12:00:00Z");
    for (let i = 0; i < 400; i++) { d.setUTCDate(d.getUTCDate() + 1); if (d.getTime() > fim) break; const w = d.getUTCDay(); if (w && w !== 6) n++; }
    return n;
  }
  const segundaDe = (iso) => { const w = new Date(iso + "T12:00:00Z").getUTCDay(); return somaDias(iso, -((w + 6) % 7)); };
  const toast = (msg, erro) => { const t = $("toast"); if (!t) return; t.textContent = msg; t.classList.toggle("erro", !!erro); t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), erro ? 6000 : 3500); };
  const sb = () => { const c = window.__sb; if (!c) throw new Error("Entre no painel de novo (sessão expirada)."); return c; };
  const MIN = 30;
  const tEf = (t, rd) => { const x = norm((rd && !/^SEM\b|^-$/i.test(rd) ? rd : t) || "(SEM TRANSPORTADORA)"); return /TEMPO\s*JUSTO|^VM\b|VM TRANSP/.test(x) ? "VM TRANSPORTES / TEMPO JUSTO" : x; };
  const nomeT = (p) => (window.__nomeTranspBase ? window.__nomeTranspBase(p._rsT) : p._rsT);
  const PERTO = /SAIU PARA ENTREGA|ROTA DE ENTREGA|UNIDADE DE DESTINO|UNIDADE DE ENTREGA|BASE DE DESTINO|FILIAL DE DESTINO|AGUARDANDO RETIRADA|AGENDAD/;

  let H = new Map(), T = new Map(), carregado = false, carregando = false, semana = segundaDe(hojeISO()), L = [], porT = [], lido = null;

  async function paginasHist(desde) {
    const out = []; let ult = 0;
    for (let i = 0; i < 200; i++) {
      const { data, error } = await sb().from("retornos_hist").select("id,pedido,nova_data,nova_data_antes,observacao,fonte,feito_por,feito_em")
        .gte("feito_em", desde + "T00:00:00-03:00").gt("id", ult).order("id").limit(1000);
      if (error) throw error; out.push(...data); if (data.length < 1000) break; ult = data[data.length - 1].id;
    }
    return out;
  }
  async function paginasTempos() {
    const out = [];
    for (let de = 0; de < 100000; de += 1000) {
      const { data, error } = await sb().from("tempos_referencia").select("transp,uf,cidade,n,p50,p80,p90").eq("trecho", "expedicao_entrega")
        .order("transp").order("uf").order("cidade").range(de, de + 999);
      if (error) throw error; out.push(...data); if (data.length < 1000) break;
    }
    return out;
  }
  const baseAberta = () => { const b = window.__basePainel && window.__basePainel(); return b && b.length ? b.filter((p) => !p.entregue_ip) : null; };

  async function carregar() {
    if (carregando) return; carregando = true; $("rs-info").textContent = "Lendo o histórico de retornos…";
    try {
      for (let i = 0; i < 120 && !baseAberta(); i++) await new Promise((r) => setTimeout(r, 500));
      if (!baseAberta()) throw new Error("a base ainda não carregou: atualize a página");
      const desde = [somaDias(semana, -35), somaDias(hojeISO(), -60)].sort()[0];
      const [hs, ts] = await Promise.all([paginasHist(desde), paginasTempos().catch(() => [])]);
      H = new Map(); hs.forEach((r) => { (H.get(r.pedido) || H.set(r.pedido, []).get(r.pedido)).push(r); });
      H.forEach((xs) => xs.sort((a, b) => String(a.feito_em).localeCompare(String(b.feito_em)) || a.id - b.id));
      T = new Map(ts.map((x) => [`${x.transp}|${x.uf}|${x.cidade}`, x]));
      carregado = true; lido = new Date(); desenhar();
    } catch (e) {
      $("rs-info").textContent = /retornos_hist|does not exist|schema cache/i.test(e.message || "") ? "Para ver esta parte, rode a parte 40 no Supabase." : "Não consegui carregar: " + (e.message || e);
    } finally { carregando = false; }
  }

  function refDe(p) {
    const tr = p._rsT, uf = norm(p.uf) || "?", cid = norm(p.cidade) || "?";
    for (const [k, nivel] of [[`${tr}|${uf}|${cid}`, "cidade"], [`${tr}|${uf}|`, "UF"], [`${tr}||`, "transportadora"]]) { const x = T.get(k); if (x && x.n >= MIN && x.p90 != null) return { ...x, nivel }; }
    return null;
  }

  function avaliar(p, hoje) {
    p._rsT = tEf(p.transportadora, (p.extra && p.extra.redespacho) || p.redespacho);
    const t = p._t || {}, cur = t.nova_data ? String(t.nova_data).slice(0, 10) : null, rows = H.get(p.pedido) || [];
    const muda = (r) => (r.nova_data || null) !== (r.nova_data_antes || null);
    const trocas = rows.filter(muda), semRows = rows.filter((r) => diaBR(r.feito_em) >= semana), trocasSem = semRows.filter(muda);
    const antes = rows.filter((r) => diaBR(r.feito_em) < semana);
    const inicio = semRows.length ? semRows[0].nova_data_antes || null : antes.length ? antes[antes.length - 1].nova_data || null : cur;
    const urgente = !!(p._atrasoG || (p._diasEf !== null && p._diasEf !== undefined && p._diasEf <= 2));
    let sit = null;
    if (!cur) sit = urgente ? "sem" : null;
    else if (!inicio) sit = "novo";
    else if (inicio !== cur) sit = "mudou";
    else sit = "mantido";
    // promessas que a transportadora deu e não cumpriu: trocou a data depois que ela já tinha passado, ou a data de hoje já venceu
    const quebHist = trocas.filter((r) => r.nova_data_antes && r.nova_data_antes < diaBR(r.feito_em)).length;
    const vencida = !!(cur && cur < hoje);
    const quebradas = quebHist + (vencida ? 1 : 0);
    const primeira = trocas.length ? trocas[0].nova_data_antes || trocas[0].nova_data : cur;
    const empurrou = primeira && cur && cur > primeira ? diasCorr(primeira, cur) : 0;
    const obsSem = semRows.some((r, i) => { const ant = i ? semRows[i - 1].observacao : antes.length ? antes[antes.length - 1].observacao : null; return (r.observacao || "") !== (ant || "") && i + antes.length > 0; });
    // auditoria
    const ref = refDe(p), exp = p.data_expedicao ? String(p.data_expedicao).slice(0, 10) : null;
    const du = exp && exp <= hoje ? diasUteis(exp, hoje) : null, par = p._parado ?? null, ms = norm(p.micro_status);
    const motivos = []; let fora = false, impossivel = false, longe = false;
    if (ref && du !== null && du > ref.p90) { fora = true; motivos.push(`${du} dias úteis desde a expedição (90% das entregas ${ref.nivel === "cidade" ? "nesta cidade" : ref.nivel === "UF" ? "neste estado" : "dela"} chegam em até ${Math.round(ref.p90)})`); }
    if (par !== null && par >= 7) motivos.push(`sem atualização no rastreio há ${par} dias`);
    if (trocas.length >= 2) motivos.push(`data remarcada ${trocas.length} vezes${empurrou ? ` (+${empurrou} dias no total)` : ""}`);
    if (quebradas) motivos.push(vencida ? `data prometida ${br(cur)} já venceu${quebHist ? ` (+${quebHist} previsão anterior)` : ""}` : `${quebHist} previsão(ões) anterior(es) não realizada(s)`);
    if (cur && cur >= hoje && diasUteis(hoje, cur) <= 2 && par !== null && par >= 5 && !PERTO.test(ms)) { impossivel = true; motivos.push(`promete ${dm(cur)}, mas está parado e ainda não chegou na unidade de destino`); }
    if (ref && cur && exp && cur > hoje && diasUteis(exp, cur) > ref.p90 + 5) { longe = true; motivos.push(`nova data = ${diasUteis(exp, cur)} dias úteis desde a expedição (prazo usual até ${Math.round(ref.p90)})`); }
    const reinc = trocas.length >= 2 || quebradas >= 1;
    let ver;
    if ((reinc && ((par !== null && par >= 7) || fora || impossivel)) || (impossivel && trocas.length >= 1)) ver = "enrola";
    else if (motivos.length) ver = "atencao";
    else ver = ref ? "ok" : "inconc";
    const dePara = sit === "mudou" ? `${dm(inicio)} → ${dm(cur)}${inicio && cur ? ` (${cur > inicio ? "+" : ""}${diasCorr(inicio, cur)} d)` : ""}` : sit === "novo" ? `novo: ${dm(cur)}` : sit === "mantido" ? `mantido: ${dm(cur)}` : sit === "sem" ? "sem retorno" : "";
    return { p, cur, inicio, sit, trocas: trocas.length, trocasSem: trocasSem.length, quebradas, vencida, empurrou, obsSem, ref, du, par, motivos, fora, impossivel, longe, ver, dePara, urgente, rows };
  }

  const CARDS = [
    ["todos", "Em acompanhamento", "em aberto com retorno ou urgentes", "azul", () => true],
    ["sem", "Sem retorno", "atrasados ou vencendo em até 2 dias, sem nova data", "vermelho", (x) => x.sit === "sem"],
    ["novo", "Retorno novo na semana", "não tinham data no começo da semana", "", (x) => x.sit === "novo"],
    ["mudou", "Mudou na semana", "data diferente da do começo da semana", "laranja", (x) => x.sit === "mudou"],
    ["mantido", "Mesmo retorno", "a mesma data do começo da semana", "", (x) => x.sit === "mantido"],
    ["vezes", "Mudou 2+ vezes", "data trocada mais de uma vez", "laranja", (x) => x.trocas >= 2],
    ["vencida", "Previsão vencida", "a nova data passou e não entregou", "vermelho", (x) => x.vencida],
    ["fora", "Acima do prazo usual da região", "já passou do tempo de 90% das entregas", "roxo", (x) => x.fora],
    ["enrola", "Crítico · prioridade máxima", "data já remarcada + parado / acima do prazo usual", "vermelho", (x) => x.ver === "enrola"],
  ];
  const VER = { enrola: ["vermelho", "Crítico · prioridade máxima"], atencao: ["ambar", "Atenção"], ok: ["verde", "Dentro do prazo usual"], inconc: ["cinza", "Sem referência para a região"] };

  function desenhar() {
    const B = baseAberta(); if (!B || !carregado) return;
    const hoje = hojeISO();
    $("rs-semana").value = semana;
    L = B.map((p) => avaliar(p, hoje)).filter((x) => x.sit);
    const cont = {}; CARDS.forEach(([k, , , , f]) => (cont[k] = L.filter(f).length));
    $("rs-cards").innerHTML = CARDS.map(([k, rot, sub, cor]) => `<button type="button" class="kpi ${cor}" data-rs="${k}"><span class="kpi-rot">${rot}</span><b class="kpi-num">${fmt(cont[k])}</b><small>${sub}</small><i>↗</i></button>`).join("");
    const m = new Map();
    L.forEach((x) => { const k = nomeT(x.p); const g = m.get(k) || m.set(k, { k, n: 0, sem: 0, novo: 0, mudou: 0, mantido: 0, vezes: 0, vencida: 0, fora: 0, enrola: 0, sp: 0, cp: 0 }).get(k);
      g.n++; g[x.sit]++; if (x.trocas >= 2) g.vezes++; if (x.vencida) g.vencida++; if (x.fora) g.fora++; if (x.ver === "enrola") g.enrola++; if (x.par !== null) { g.sp += x.par; g.cp++; } });
    porT = [...m.values()].sort((a, b) => b.enrola - a.enrola || b.sem + b.vencida - (a.sem + a.vencida) || b.n - a.n);
    const c = (n, ruim) => `<td class="num ${n && ruim ? "ruim-t" : ""}">${n ? fmt(n) : "—"}</td>`;
    $("rs-linhas").innerHTML = porT.map((g) => `<tr class="clicavel" data-rst="${esc(g.k)}"><td>${esc(g.k)}</td><td class="num"><b>${fmt(g.n)}</b></td>${c(g.sem, 1)}${c(g.novo)}${c(g.mudou)}${c(g.mantido)}${c(g.vezes, 1)}${c(g.vencida, 1)}<td class="num">${g.cp ? (g.sp / g.cp).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) : "—"}</td>${c(g.fora, 1)}${c(g.enrola, 1)}
      <td><button type="button" class="btn mini contorno" data-rsm="${esc(g.k)}" title="Texto de cobrança pronto">⧉ Mensagem</button></td></tr>`).join("") || `<tr><td colspan="12" class="vazio">Nenhum pedido em aberto com retorno.</td></tr>`;
    const comHist = L.filter((x) => x.rows.length).length;
    $("rs-info").textContent = `Semana de ${br(semana)} · ${fmt(L.length)} pedidos em aberto acompanhados · ${fmt(comHist)} com histórico de retorno · lido às ${lido.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}${T.size ? "" : " · Tempos reais ainda não calculados (aba Transportadoras): a auditoria por CEP fica de fora"}`;
  }

  // ---------- lista (mesmo modelo de janela dos cards) ----------
  let mLista = [], mTit = "";
  function abrir(titulo, lista) {
    const ord = { enrola: 0, atencao: 1, inconc: 2, ok: 3 };
    mLista = lista.slice().sort((a, b) => ord[a.ver] - ord[b.ver] || b.quebradas - a.quebradas || b.trocas - a.trocas || (b.par || 0) - (a.par || 0)); mTit = titulo;
    let m = $("rs-modal");
    if (!m) {
      m = document.createElement("div"); m.id = "rs-modal"; m.className = "lm-fundo"; m.hidden = true;
      m.innerHTML = `<div class="lm-caixa rs-caixa" role="dialog" aria-modal="true"><header class="lm-topo"><div><h2 id="rs-m-tit"></h2><small id="rs-m-qtd"></small></div>
        <div class="lm-acoes"><button type="button" class="btn lm-excel" id="rs-m-excel">⤓ Baixar Excel</button><button type="button" class="lm-fechar" id="rs-m-fechar" aria-label="Fechar">×</button></div></header>
        <div class="lm-corpo" id="rs-m-corpo"></div><footer class="lm-rodape" id="rs-m-rodape"></footer></div>`;
      document.body.appendChild(m);
      const fechar = () => { m.hidden = true; document.body.classList.remove("lm-aberto"); };
      m.addEventListener("click", (e) => {
        if (e.target === m || e.target.closest("#rs-m-fechar")) return fechar();
        const b = e.target.closest("[data-ssw]"); if (b && window.__abrirSSW) return window.__abrirSSW(b.dataset.ssw, b.dataset.transp, b.dataset.pedido);
        if (e.target.closest("#rs-m-excel")) return excel(mLista, mTit);
        if (e.target.closest("#rs-m-copiar")) { const ta = $("rs-m-texto"); ta.select(); (navigator.clipboard ? navigator.clipboard.writeText(ta.value) : Promise.reject()).then(() => toast("Mensagem copiada."), () => { document.execCommand("copy"); toast("Mensagem copiada."); }); }
      });
      document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !m.hidden) fechar(); });
    }
    const MAX = 500;
    $("rs-m-tit").textContent = titulo; $("rs-m-qtd").textContent = `${fmt(mLista.length)} pedido(s)`; $("rs-m-excel").hidden = false;
    $("rs-m-corpo").innerHTML = `<table class="lm-tab rs-mtab"><thead><tr><th>Nota</th><th>Transportadora</th><th>Destino</th><th>Micro status</th><th>Prometida</th><th>Retorno da semana</th><th class="num">Trocas (semana/total)</th><th class="num">Parado</th><th class="num">Dias úteis desde exp.</th><th>Padrão do CEP</th><th>Auditoria</th><th>Rastreio</th></tr></thead><tbody>${
      mLista.slice(0, MAX).map((x) => { const p = x.p, v = VER[x.ver];
        return `<tr><td class="p" title="${esc(p.pedido)}">${esc(p.nf || p.pedido)}</td><td>${esc(nomeT(p))}</td><td>${esc(p.cidade || "")}/${esc(p.uf || "")}</td><td class="s">${esc(p.micro_status || "")}</td><td>${br(p.prev_original || p.prev_atual) || "—"}</td>
          <td><span class="chip ${x.sit === "mudou" ? "ambar" : x.sit === "sem" ? "vermelho" : x.sit === "novo" ? "azul" : "cinza"}">${esc(x.dePara)}</span>${x.obsSem ? ' <span class="s" title="A observação mudou nesta semana">obs. nova</span>' : ""}</td>
          <td class="num">${x.trocasSem}/${x.trocas}</td><td class="num">${x.par ?? "—"}</td><td class="num">${x.du ?? "—"}</td>
          <td>${x.ref ? `${Math.round(x.ref.p50)}–${Math.round(x.ref.p90)} d <span class="s">(${x.ref.nivel})</span>` : "—"}</td>
          <td class="rs-aud"><span class="chip ${v[0]}">${v[1]}</span>${x.motivos.length ? `<div class="s">${x.motivos.map(esc).join(" · ")}</div>` : ""}</td>
          <td>${p.nf ? `<button type="button" class="link" data-ssw="${esc(p.nf)}" data-transp="${esc(p.transportadora || "")}" data-pedido="${esc(p.pedido)}">abrir</button>` : ""}</td></tr>`; }).join("")
      || `<tr><td colspan="12" class="vazio">Nenhum pedido.</td></tr>`}</tbody></table>`;
    $("rs-m-rodape").textContent = mLista.length > MAX ? `Mostrando ${MAX} de ${fmt(mLista.length)}. O Excel traz todos.` : "Mais graves primeiro. Prazos em dias úteis (sem sábado e domingo).";
    m.hidden = false; document.body.classList.add("lm-aberto");
  }

  function mensagem(nome) {
    const X = L.filter((x) => nomeT(x.p) === nome);
    const alvo = X.filter((x) => x.sit === "sem" || x.vencida || x.trocas >= 2 || x.ver === "enrola" || x.fora || (x.par !== null && x.par >= 7))
      .sort((a, b) => (b.ver === "enrola") - (a.ver === "enrola") || b.vencida - a.vencida || (b.sit === "sem") - (a.sit === "sem") || b.trocas - a.trocas);
    const n = (f) => X.filter(f).length, sem = n((x) => x.sit === "sem"), venc = n((x) => x.vencida), vez = n((x) => x.trocas >= 2), par = n((x) => x.par !== null && x.par >= 7);
    const partes = [sem && `${sem} sem retorno`, venc && `${venc} com a data informada por vocês já vencida`, vez && `${vez} com a data alterada mais de uma vez`, par && `${par} sem movimentação no rastreio há 7 dias ou mais`].filter(Boolean);
    const lin = alvo.slice(0, 60).map((x) => { const p = x.p, d = [];
      d.push(x.cur ? `nova data ${br(x.cur)}${x.vencida ? " (vencida)" : ""}` : "sem retorno");
      if (x.trocas >= 2) d.push(`data alterada ${x.trocas}x`); if (x.par !== null && x.par >= 7) d.push(`parado há ${x.par} dias`);
      return `• NF ${p.nf || p.pedido} · ${p.cidade || ""}/${p.uf || ""} · ${d.join(" · ")}`; });
    const txt = `Olá, ${nome}! Estamos na semana da Black Friday e precisamos finalizar com urgência as entregas em aberto com vocês. Hoje são ${alvo.length} pedido(s) que precisam de atenção${partes.length ? ": " + partes.join(", ") : ""}.\nConseguem nos passar uma posição real de cada um e priorizar essas entregas?\n\n${lin.join("\n")}${alvo.length > 60 ? `\n… e mais ${alvo.length - 60} (segue planilha).` : ""}`;
    abrir(`Mensagem · ${nome}`, []);
    $("rs-m-qtd").textContent = `${fmt(alvo.length)} pedido(s) na cobrança`; $("rs-m-excel").hidden = true;
    $("rs-m-corpo").innerHTML = `<div class="rs-msg"><textarea id="rs-m-texto" rows="18">${esc(txt)}</textarea><button type="button" class="btn amarelo" id="rs-m-copiar">⧉ Copiar mensagem</button></div>`;
    $("rs-m-rodape").textContent = "Nada é enviado sozinho: copie e mande pelo canal de sempre.";
    mLista = alvo;
  }

  function excel(lista, titulo) {
    if (!lista.length) return toast("Nada para exportar.", true);
    const SIT = { sem: "Sem retorno", novo: "Retorno novo na semana", mudou: "Mudou na semana", mantido: "Mesmo retorno" };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Pedido", "NF", "Transportadora", "Transportadora (base)", "Cidade", "UF", "Canal", "Micro status", "Prometida ao cliente", `Retorno em ${br(semana)}`, "Retorno atual", "Situação na semana", "O que mudou", "Observação mudou na semana", "Trocas de data na semana", "Trocas de data no total", "Dias empurrados", "Previsões anteriores não realizadas", "Dias parado", "Expedição", "Dias úteis desde a expedição", "Mediana do CEP (dias úteis)", "P90 do CEP (dias úteis)", "Nível da referência", "Auditoria", "Motivos", "Observação atual"]]
      .concat(lista.map((x) => { const p = x.p; return [p.pedido, p.nf, nomeT(p), p.transportadora, p.cidade, p.uf, p.canal, p.micro_status, br(p.prev_original || p.prev_atual), br(x.inicio), br(x.cur), SIT[x.sit] || "", x.dePara, x.obsSem ? "Sim" : "", x.trocasSem, x.trocas, x.empurrou || "", x.quebradas || "", x.par ?? "", br(p.data_expedicao), x.du ?? "",
        x.ref ? Number(x.ref.p50) : "", x.ref ? Number(x.ref.p90) : "", x.ref ? x.ref.nivel : "", VER[x.ver][1], x.motivos.join(" · "), (p._t && p._t.observacao) || ""]; }))), "Retornos da semana");
    const hist = []; lista.forEach((x) => x.rows.forEach((r) => hist.push([x.p.pedido, x.p.nf, nomeT(x.p), new Date(r.feito_em).toLocaleString("pt-BR"), r.feito_por || "", r.fonte || "", br(r.nova_data_antes), br(r.nova_data), r.observacao || ""])));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Pedido", "NF", "Transportadora", "Quando", "Quem", "Origem", "Data antes", "Nova data", "Observação"]].concat(hist)), "Histórico");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Transportadora", "Em aberto", "Sem retorno", "Retorno novo", "Mudou na semana", "Mesmo retorno", "Mudou 2+ vezes", "Promessa vencida", "Parado (média dias)", "Acima do prazo usual da região", "Crítico · prioridade máxima"]]
      .concat(porT.map((g) => [g.k, g.n, g.sem, g.novo, g.mudou, g.mantido, g.vezes, g.vencida, g.cp ? Math.round((g.sp / g.cp) * 10) / 10 : "", g.fora, g.enrola]))), "Por transportadora");
    XLSX.writeFile(wb, `retornos_semana_${(titulo || "todos").replace(/[^\wÀ-ú]+/g, "_").slice(0, 40)}_${hojeISO()}.xlsx`);
  }

  $("rs-box").addEventListener("click", (e) => {
    const c = e.target.closest("[data-rs]"); if (c && !e.target.closest(".kpi > i")) return; if (c) { const d = CARDS.find((x) => x[0] === c.dataset.rs); return abrir(`${d[1]} · semana de ${br(semana)}`, L.filter(d[4])); }
    const mb = e.target.closest("[data-rsm]"); if (mb) return mensagem(mb.dataset.rsm);
    const t = e.target.closest("[data-rst]"); if (t) return abrir(`${t.dataset.rst} · retornos da semana`, L.filter((x) => nomeT(x.p) === t.dataset.rst));
    if (e.target.closest("#rs-atualizar")) return carregar();
    if (e.target.closest("#rs-excel")) return excel(L, "todos");
  });
  $("rs-semana").addEventListener("change", (e) => { const v = e.target.value; if (!v) return; const s = segundaDe(v); const recarregar = s < somaDias(hojeISO(), -60); semana = s; recarregar ? carregar() : desenhar(); });

  // carrega quando o Preventivo aparece com a base pronta; redesenha quando a base muda (nova data gravada)
  const pag = $("pagina-preventivo");
  const tentar = () => { if (!pag.hidden && window.__sb && !carregado && !carregando) carregar(); };
  new MutationObserver(tentar).observe(pag, { attributes: true, attributeFilter: ["hidden"] });
  setInterval(() => { if (pag.hidden) return; if (!carregado) return tentar(); if (lido && Date.now() - lido > 10 * 60000) return carregar(); const B = baseAberta(); if (B && (B !== desenhar._b || B.length !== desenhar._n)) { desenhar._b = B; desenhar._n = B.length; desenhar(); } }, 4000);
  setTimeout(tentar, 2500);
})();
