// Preventivo · Links das transportadoras (Brenda 26/11): um link fixo por transportadora (retorno.html#t=TOKEN), sem login,
// onde ela vê só os pedidos dela sem retorno e informa a nova data + motivo. A resposta cai direto nas tratativas (fonte 'link').
// O token só aparece uma vez, na hora de gerar; o banco guarda só o hash (parte 82).
(function () {
  const $ = (id) => document.getElementById(id);
  if (!$("lk-box")) return;
  const sb = () => window.__sb;
  const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n) => Number(n || 0).toLocaleString("pt-BR");
  const quando = (ts) => (ts ? new Date(ts).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(",", " às") : "—");
  const hojeISO = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  const amanha = () => { const d = new Date(hojeISO() + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
  const toast = (msg, erro) => { const t = $("toast"); if (!t) return; t.textContent = msg; t.classList.toggle("erro", !!erro); t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), erro ? 6000 : 3500); };
  // VM Transportes e Tempo Justo são a mesma (regra da Brenda): um link só para as duas
  const grupo = (t) => (/tempo\s*justo|^\s*vm\b|vm transportes/i.test(t || "") ? "VM Transportes / Tempo Justo" : (t || "").trim());
  let links = [], ok = true, novo = null;

  const base = () => (window.__basePainel ? window.__basePainel(false) : []) || [];
  // mesma regra da função link_pendentes: já expedido, sem nova data válida, atrasado / vence até amanhã / nova data vencida
  function pendentes(nomes) {
    const S = new Set(nomes), h = hojeISO(), am = amanha();
    return base().filter((p) => {
      if (!S.has(p.transportadora) || p.entregue_ip || !p.data_expedicao) return false;
      const t = p._t || {}, nova = t.nova_data || null, prom = p.prev_original || p.prev_atual || null;
      if (nova && nova >= h) return false;
      return (prom && prom <= am) || /^vencido/i.test(p.range_atrasos || "") || (nova && nova < h);
    }).length;
  }

  async function carregar() {
    const r = await sb().from("transp_links").select("id,nome,transportadoras,ativo,criado_por,criado_em,ultimo_acesso,acessos,ultima_resposta,respostas").order("nome");
    if (r.error) { ok = false; links = []; } else { ok = true; links = r.data || []; }
    desenhar();
    carregarKpi();
  }

  function desenhar() {
    if (!ok) { $("lk-info").textContent = "Para usar os links, rode a parte 82 no Supabase."; $("lk-linhas").innerHTML = ""; return; }
    const ativos = links.filter((l) => l.ativo);
    $("lk-info").textContent = ativos.length ? `${fmt(ativos.length)} link(s) ativo(s). A transportadora abre o link, vê só os pedidos dela sem retorno e informa a nova data e o motivo; a resposta cai na hora aqui no Preventivo.`
      : "Nenhum link ainda. Escolha a transportadora e clique em Gerar link.";
    // transportadoras da base (agrupando VM/Tempo Justo)
    const g = new Map(); base().forEach((p) => { if (!p.transportadora) return; const k = grupo(p.transportadora); if (!g.has(k)) g.set(k, new Set()); g.get(k).add(p.transportadora); });
    const sel = $("lk-transp"), atual = sel.value;
    sel.innerHTML = `<option value="">Escolha a transportadora…</option>` + [...g.keys()].sort((a, b) => a.localeCompare(b, "pt-BR")).map((k) => `<option value="${esc(k)}">${esc(k)}</option>`).join("");
    sel.value = atual; lkGrupos = g;
    $("lk-linhas").innerHTML = ativos.map((l) => `<tr>
        <td><b>${esc(l.nome)}</b>${l.transportadoras.length > 1 ? `<div class="s">${esc(l.transportadoras.join(" · "))}</div>` : ""}</td>
        <td class="num">${fmt(pendentes(l.transportadoras))}</td>
        <td>${quando(l.ultimo_acesso)}<div class="s">${fmt(l.acessos)} acesso(s)</div></td>
        <td>${quando(l.ultima_resposta)}<div class="s">${fmt(l.respostas)} pedido(s) respondido(s)</div></td>
        <td class="s">${quando(l.criado_em)}${l.criado_por ? "<br>" + esc(String(l.criado_por).split("@")[0]) : ""}</td>
        <td><button class="btn mini contorno" data-lk-novo="${esc(l.nome)}" title="Gera outro link e desativa este (use se o link vazou ou se perdeu)">↻ Novo link</button>
            <button class="btn mini contorno" data-lk-off="${l.id}" title="O link para de funcionar">Desativar</button></td></tr>`).join("")
      || `<tr><td colspan="6" class="vazio">Nenhum link ativo.</td></tr>`;
    $("lk-novo").hidden = !novo;
    if (novo) {
      $("lk-novo-nome").textContent = novo.nome; $("lk-url").value = novo.url;
      $("lk-msg").value = `Olá, equipe ${novo.nome}! Este é o link fixo da Multimóveis para informar a nova data de entrega dos nossos pedidos em atraso:\n${novo.url}\n\nÉ só abrir (não precisa de login), colocar a nova data e escolher o motivo (salva sozinho). A lista se atualiza sozinha todo dia e mostra só os pedidos que ainda estão sem data. Obrigado!`;
    }
  }
  let lkGrupos = new Map();

  async function gerar(nomeGrupo) {
    const nomes = [...(lkGrupos.get(nomeGrupo) || [])];
    if (!nomes.length) return toast("Escolha a transportadora.", true);
    const b = new Uint8Array(24); crypto.getRandomValues(b);
    const token = btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))].map((x) => x.toString(16).padStart(2, "0")).join("");
    const antigos = links.filter((l) => l.ativo && l.nome === nomeGrupo).map((l) => l.id);
    if (antigos.length) { const r0 = await sb().from("transp_links").update({ ativo: false }).in("id", antigos); if (r0.error) return toast("Não consegui desativar o link antigo: " + r0.error.message, true); }
    const r = await sb().from("transp_links").insert({ nome: nomeGrupo, transportadoras: nomes, token_hash: hash });
    if (r.error) return toast("Não consegui gerar o link: " + r.error.message, true);
    const url = new URL("retorno.html", location.href.split("#")[0]).href + "#t=" + token;
    novo = { nome: nomeGrupo, url };
    toast(antigos.length ? "Link novo gerado (o antigo parou de funcionar)." : "Link gerado.");
    await carregar();
  }

  const copiar = (txt) => (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(() => toast("Copiado."), () => toast("Selecione e copie com Ctrl+C.", true));
  $("lk-gerar").addEventListener("click", () => gerar($("lk-transp").value));
  $("lk-copiar-url").addEventListener("click", () => copiar($("lk-url").value));
  $("lk-copiar-msg").addEventListener("click", () => copiar($("lk-msg").value));
  $("lk-fechar").addEventListener("click", () => { novo = null; desenhar(); });
  $("lk-box").addEventListener("click", async (e) => {
    const n = e.target.closest("[data-lk-novo]"); if (n) { if (confirm(`Gerar um link novo para ${n.dataset.lkNovo}? O link atual para de funcionar e você precisa mandar o novo para eles.`)) gerar(n.dataset.lkNovo); return; }
    const o = e.target.closest("[data-lk-off]"); if (o) {
      if (!confirm("Desativar este link? A transportadora não consegue mais abrir.")) return;
      const r = await sb().from("transp_links").update({ ativo: false }).eq("id", +o.dataset.lkOff);
      if (r.error) return toast(r.error.message, true); toast("Link desativado."); carregar();
    }
  });

  // ===== KPIs dos links (Brenda 26/11, parte 86): acessos, pedidos atualizados, motivos e promessas cumpridas =====
  let kd = null, kOk = true, kLin = [];
  const dia = (ts) => new Date(ts).toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  const br = (iso) => (iso ? String(iso).slice(0, 10).split("-").reverse().join("/") : "—");
  const pct = (a, b) => (b ? Math.round((100 * a) / b) + "%" : "—");
  const horas = (h) => (h == null ? "—" : h < 1 ? "<1 h" : h < 48 ? Math.round(h) + " h" : Math.round(h / 24) + " dias");
  const mediana = (a) => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
  function situacao(r, hoje) {
    if (r.cancelado) return "Cancelado";
    if (r.entregue) return r.data_entrega ? (r.data_entrega <= r.nova_data ? "Cumpriu" : "Atrasou após a nova data") : "Entregue (sem data)";
    if (!r.na_base) return "Fora da base";
    return r.nova_data < hoje ? "Atrasou após a nova data" : "No prazo";
  }
  async function carregarKpi() {
    const r = await sb().rpc("link_kpis", { p_dias: +$("lkk-dias").value });
    if (r.error) { kOk = false; kd = null; } else { kOk = true; kd = r.data; }
    desenharKpi();
  }
  function calcular() {
    const hoje = kd.hoje, porNome = new Map();
    const G = (n) => { if (!porNome.has(n)) porNome.set(n, { nome: n, acessos: 0, dias: new Set(), vistos: new Map(), resp: new Map(), motivos: new Map() }); return porNome.get(n); };
    links.filter((l) => l.ativo).forEach((l) => G(l.nome));
    kd.acessos.forEach((a) => { const g = G(a.nome); g.acessos++; g.dias.add(dia(a.em)); (a.pedidos || []).forEach((p) => { if (!g.vistos.has(p)) g.vistos.set(p, a.em); }); });
    kd.respostas.forEach((r) => { const g = G(r.nome); if (!g.resp.has(r.pedido)) g.resp.set(r.pedido, []); g.resp.get(r.pedido).push(r); g.motivos.set(r.motivo || "—", (g.motivos.get(r.motivo || "—") || 0) + 1); });
    const baseMap = new Map(base().map((p) => [p.pedido, p]));
    return [...porNome.values()].map((g) => {
      const ult = [...g.resp.values()].map((a) => ({ ...a[a.length - 1], datas: new Set(a.map((x) => x.nova_data)).size, respostas: a.length, primeira: a[0].em }));
      ult.forEach((r) => (r.sit = situacao(r, hoje)));
      const tempos = ult.filter((r) => g.vistos.has(r.pedido) && g.vistos.get(r.pedido) <= r.primeira).map((r) => (Date.parse(r.primeira) - Date.parse(g.vistos.get(r.pedido))) / 36e5);
      const semRet = [...g.vistos.keys()].filter((p) => !g.resp.has(p)).map((p) => { const b = baseMap.get(p) || {}; return { pedido: p, nf: b.nf, transportadora: b.transportadora, cidade: b.cidade, uf: b.uf, prometido: b.prev_original || b.prev_atual, micro: b.micro_status, sit: b.pedido ? "Sem retorno" : "Sem retorno (já saiu da lista em aberto)", primeira: g.vistos.get(p) }; });
      const de = (s) => ult.filter((r) => r.sit === s);
      const emp = ult.filter((r) => r.prometido && r.nova_data).map((r) => (Date.parse(r.nova_data) - Date.parse(r.prometido)) / 864e5);
      const mot = [...g.motivos.entries()].sort((a, b) => b[1] - a[1]);
      return { nome: g.nome, acessos: g.acessos, dias: g.dias.size, vistos: g.vistos.size, ult, semRet, tempo: mediana(tempos),
        cumpriu: de("Cumpriu"), atrasou: de("Atrasou após a nova data"), prazo: de("No prazo"), remarcou: ult.filter((r) => r.datas > 1),
        emp: emp.length ? emp.reduce((a, b) => a + b, 0) / emp.length : null, motivo: mot[0] ? `${mot[0][0]} (${mot[0][1]})` : "—", motivos: g.motivos,
        ultimo: kd.acessos.filter((a) => a.nome === g.nome).map((a) => a.em).pop() };
    }).sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  }
  const lnk = (n, nome, tipo, cls) => (n ? `<a data-lkk="${esc(tipo)}" data-lkk-nome="${esc(nome)}"${cls ? ` class="${cls}"` : ""}>${fmt(n)}</a>` : "0");
  function desenharKpi() {
    if (!$("lkk")) return;
    if (!kOk) { $("lkk-info").textContent = "Para ver os KPIs, rode a parte 86 no Supabase."; $("lkk-cards").innerHTML = $("lkk-linhas").innerHTML = $("lkk-mot").innerHTML = $("lkk-mot-cab").innerHTML = ""; return; }
    if (!kd) return;
    kLin = calcular();
    const T = (f) => kLin.reduce((a, x) => a + f(x), 0);
    const vistos = T((x) => x.vistos), atual = T((x) => x.ult.length), cum = T((x) => x.cumpriu.length), atr = T((x) => x.atrasou.length);
    $("lkk-info").textContent = `Desde que a parte 86 foi rodada o painel guarda cada acesso e cada resposta. Respostas anteriores vieram do histórico de retornos (sem os acessos). Clique num número para ver os pedidos.`;
    $("lkk-cards").innerHTML = [
      [fmt(T((x) => x.acessos)), "Acessos aos links", ""], [fmt(vistos), "Pedidos que apareceram nos links", ""],
      [fmt(atual), "Pedidos atualizados pela transportadora", ""], [pct(atual, Math.max(vistos, atual)), "% atualizado", ""],
      [fmt(T((x) => x.semRet.length)), "Sem retorno", "verm"], [fmt(atr), "Atrasou após a nova data", "verm"],
      [fmt(cum), "Cumpriu a nova data", "verde"], [pct(cum, cum + atr), "% promessas cumpridas", cum + atr ? (cum / (cum + atr) >= 0.8 ? "verde" : "verm") : ""],
    ].map(([n, r, c]) => `<div class="lkk-card ${c}"><b>${n}</b><span>${r}</span></div>`).join("");
    $("lkk-linhas").innerHTML = kLin.map((x) => {
      const pa = x.vistos || x.ult.length ? Math.round((100 * x.ult.length) / Math.max(x.vistos, x.ult.length)) : null, pc = x.cumpriu.length + x.atrasou.length ? Math.round((100 * x.cumpriu.length) / (x.cumpriu.length + x.atrasou.length)) : null;
      return `<tr><td><b>${esc(x.nome)}</b><div class="s">último acesso ${quando(x.ultimo)}</div></td><td class="num">${fmt(x.acessos)}</td><td class="num">${fmt(x.dias)}</td>
        <td class="num">${lnk(x.vistos, x.nome, "vistos")}</td><td class="num">${lnk(x.ult.length, x.nome, "atual")}</td>
        <td class="num ${pa == null ? "" : pa >= 80 ? "bom" : pa < 50 ? "ruim" : ""}">${pa == null ? "—" : pa + "%"}</td>
        <td class="num">${lnk(x.semRet.length, x.nome, "sem", "ruim")}</td><td class="num">${horas(x.tempo)}</td>
        <td class="num">${lnk(x.cumpriu.length, x.nome, "cumpriu")}</td><td class="num">${lnk(x.atrasou.length, x.nome, "atrasou", "ruim")}</td>
        <td class="num ${pc == null ? "" : pc >= 80 ? "bom" : "ruim"}">${pc == null ? "—" : pc + "%"}</td><td class="num">${lnk(x.prazo.length, x.nome, "prazo")}</td>
        <td class="num">${lnk(x.remarcou.length, x.nome, "remarcou")}</td><td class="num">${x.emp == null ? "—" : x.emp.toFixed(1).replace(".", ",")}</td><td>${esc(x.motivo)}</td></tr>`;
    }).join("") || `<tr><td colspan="15" class="vazio">Nenhum link no período.</td></tr>`;
    const mots = [...new Set(kLin.flatMap((x) => [...x.motivos.keys()]))].sort((a, b) => T((x) => x.motivos.get(b) || 0) - T((x) => x.motivos.get(a) || 0));
    const comResp = kLin.filter((x) => x.motivos.size);
    $("lkk-mot-cab").innerHTML = `<tr><th>Motivo</th>${comResp.map((x) => `<th class="num">${esc(x.nome)}</th>`).join("")}<th class="num">Total</th></tr>`;
    $("lkk-mot").innerHTML = mots.map((m) => `<tr><td>${esc(m)}</td>${comResp.map((x) => `<td class="num">${lnk(x.motivos.get(m) || 0, x.nome, "mot:" + m)}</td>`).join("")}<td class="num"><b>${fmt(T((x) => x.motivos.get(m) || 0))}</b></td></tr>`).join("")
      || `<tr><td class="vazio">Nenhuma resposta no período.</td></tr>`;
  }
  const TIT = { vistos: "Pedidos que apareceram no link", atual: "Pedidos atualizados", sem: "Sem retorno", cumpriu: "Cumpriu a nova data", atrasou: "Atrasou após a nova data", prazo: "Nova data ainda no prazo", remarcou: "Remarcou (2+ datas)" };
  function linhasDe(x, tipo) {
    if (tipo === "sem") return x.semRet;
    if (tipo === "vistos") { const R = new Map(x.ult.map((r) => [r.pedido, r])); return [...x.ult, ...x.semRet.filter((s) => !R.has(s.pedido))]; }
    if (tipo.startsWith("mot:")) { const m = tipo.slice(4); return kd.respostas.filter((r) => r.nome === x.nome && (r.motivo || "—") === m).map((r) => ({ ...r, sit: situacao(r, kd.hoje) })); }
    return { atual: x.ult, cumpriu: x.cumpriu, atrasou: x.atrasou, prazo: x.prazo, remarcou: x.remarcou }[tipo] || [];
  }
  const COLS = [["NF", (r) => r.nf], ["Pedido", (r) => r.pedido], ["Transportadora", (r) => r.transportadora], ["Cidade/UF", (r) => [r.cidade, r.uf].filter(Boolean).join(" / ")],
    ["Micro status", (r) => r.micro], ["Prometido", (r) => br(r.prometido)], ["Nova data informada", (r) => br(r.nova_data)], ["Motivo", (r) => r.motivo], ["SKU", (r) => r.sku],
    ["Observação", (r) => r.obs], ["Respondido em", (r) => (r.em ? quando(r.em) : "")], ["Datas diferentes", (r) => r.datas || ""], ["Entregue em", (r) => (r.data_entrega ? br(r.data_entrega) : "")], ["Situação", (r) => r.sit]];
  function abrirLista(nome, tipo) {
    const x = kLin.find((y) => y.nome === nome); if (!x) return;
    const L = linhasDe(x, tipo), tit = `${nome} · ${tipo.startsWith("mot:") ? "Motivo: " + tipo.slice(4) : TIT[tipo]} (${fmt(L.length)})`;
    $("modal-titulo").textContent = tit;
    $("modal-corpo").innerHTML = `<p><button class="btn contorno" type="button" id="lkk-lista-xls">⤓ Baixar Excel</button></p><div class="tabela-wrap"><table class="tabela-pedidos"><thead><tr>${COLS.map((c) => `<th>${c[0]}</th>`).join("")}</tr></thead>
      <tbody>${L.map((r) => `<tr>${COLS.map((c) => `<td>${esc(c[1](r) ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    $("lkk-lista-xls").onclick = () => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([COLS.map((c) => c[0])].concat(L.map((r) => COLS.map((c) => c[1](r) ?? "")))), "Pedidos"); XLSX.writeFile(wb, `link_${tit.replace(/\s*\(\d[\d.]*\)$/, "").replace(/[^\wÀ-ú]+/g, "_").slice(0, 60)}_${hojeISO()}.xlsx`); };
    $("modal").hidden = false; document.body.classList.add("sem-rolagem");
  }
  if ($("lkk")) {
    $("lkk-dias").addEventListener("change", carregarKpi);
    $("lkk").addEventListener("click", (e) => { const a = e.target.closest("[data-lkk]"); if (a) abrirLista(a.dataset.lkkNome, a.dataset.lkk); });
    $("lkk-excel").addEventListener("click", () => {
      if (!kLin.length) return toast("Sem dados no período.", true);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Transportadora", "Acessos", "Dias com acesso", "Pedidos no link", "Atualizados", "Sem retorno", "Tempo p/ responder (h, mediana)", "Cumpriu", "Atrasou após a nova data", "% cumprido", "No prazo", "Remarcou", "Dias empurrados (média)", "Motivo principal"]]
        .concat(kLin.map((x) => [x.nome, x.acessos, x.dias, x.vistos, x.ult.length, x.semRet.length, x.tempo == null ? "" : Math.round(x.tempo), x.cumpriu.length, x.atrasou.length,
          x.cumpriu.length + x.atrasou.length ? Math.round((100 * x.cumpriu.length) / (x.cumpriu.length + x.atrasou.length)) / 100 : "", x.prazo.length, x.remarcou.length, x.emp == null ? "" : +x.emp.toFixed(1), x.motivo]))), "KPIs");
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Link", ...COLS.map((c) => c[0])]].concat(kLin.flatMap((x) => [...x.ult, ...x.semRet].map((r) => [x.nome, ...COLS.map((c) => c[1](r) ?? "")])))), "Pedidos");
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Link", "Pedido", "NF", "Nova data", "Motivo", "SKU", "Observação", "Respondido em"]].concat(kd.respostas.map((r) => [r.nome, r.pedido, r.nf, br(r.nova_data), r.motivo, r.sku || "", r.obs || "", quando(r.em)]))), "Todas as respostas");
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Link", "Acesso em", "Pedidos na tela"]].concat(kd.acessos.map((a) => [a.nome, quando(a.em), a.qtd]))), "Acessos");
      XLSX.writeFile(wb, `kpis_links_transportadoras_${hojeISO()}.xlsx`);
    });
  }
  // carrega quando o Preventivo estiver aberto (a base já carregada dá os nomes das transportadoras e os pendentes)
  let tentou = false, ultima = 0;
  const tick = () => {
    if (!$("lk-box").offsetParent || !window.__sb || !base().length) return;
    if (!tentou || (!novo && Date.now() - ultima > 120000 && document.activeElement !== $("lk-transp"))) { tentou = true; ultima = Date.now(); carregar(); }
  };
  setInterval(tick, 3000);
})();
