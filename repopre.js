// Reposições › Reposição pré › Falta de volumes (Brenda 27/11, parte 97).
// O robô (modo repo-pre) lê no portal os casos Novo + Falta de volumes (séries 7/4/31), os volumes da NF, a foto anexada
// e o pedido no 360. Aqui a equipe marca o volume que aparece na foto (está com a transportadora); o resto é o que repor.
// Opção C da Brenda: por enquanto a escolha do volume é manual. Nada é solicitado sozinho.
(function () {
  const $ = (id) => document.getElementById(id);
  if (!$("rp-repopre")) return;
  const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n) => Number(n || 0).toLocaleString("pt-BR");
  const hora = (d) => (d ? new Date(d).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(",", " às") : "—");
  const toast = (msg, erro) => { const t = $("toast"); if (!t) return; t.textContent = msg; t.classList.toggle("erro", !!erro); t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), erro ? 6000 : 3500); };
  const sb = () => window.__sb;
  const dBR = (s) => { const m = String(s || "").match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
  const seisMeses = () => { const d = new Date(); d.setMonth(d.getMonth() - 6); return d.toISOString().slice(0, 10); };

  let L = [], ok = true, card = "marcar", carregou = false;
  const repor = (x) => (x.volumes || []).filter((v) => !(x.vol_posse || []).includes(v));
  const alertas = (x) => {
    const a = [];
    if (x.robo_msg) a.push(["erro", "Robô: " + x.robo_msg]);
    if (x.solicitar_status === "erro") a.push(["erro", "Solicitação: " + (x.solicitar_msg || "erro")]);
    if (x.venda === false) a.push(["mao", "NF não achada em 360 › Hub › Pedidos (não é venda?): conferir à mão"]);
    if (x.tem_devolucao) a.push(["mao", "Tem ticket de devolução/cancelamento no 360: conferir à mão"]);
    const d = dBR(x.data_360); if (d && d < seisMeses()) a.push(["aviso", "Pedido com mais de 6 meses: conferir a numeração da NF"]);
    if (x.volumes && x.volumes.length && x.vol_posse && x.vol_posse.length >= x.volumes.length) a.push(["aviso", "Todos os volumes marcados como em posse: não sobra volume para repor"]);
    if (!(x.fotos || []).length && x.analisado_em) a.push(["aviso", "Sem foto anexada no portal"]);
    return a;
  };
  const sit = (x) => {
    if (x.solicitar_status === "feito") return "feito";
    if (x.solicitar_status === "pendente") return "fila";
    if (x.solicitar_status === "erro") return "mao";
    if (!x.na_lista) return "saiu";
    if (!x.analisado_em) return "robo";
    if (alertas(x).some((a) => a[0] === "mao" || a[0] === "erro")) return "mao";
    return x.vol_posse && x.vol_posse.length && repor(x).length ? "pronto" : "marcar";
  };
  const CARDS = [["marcar", "Para marcar o volume", "olhe a foto e clique no volume", "amarelo"], ["pronto", "Pronto para solicitar", "volume a repor definido", "verde"],
    ["fila", "Solicitando", "o robô está pedindo a reposição", "azul"], ["feito", "Reposição solicitada", "ticket no portal + comentário no 360", "verde"], ["mao", "Conferir à mão", "devolução, não é venda ou erro", "vermelho"], ["robo", "Aguardando o robô", "ainda não analisados", ""], ["saiu", "Saíram da lista", "não estão mais Novo no portal", ""], ["todos", "Todos", "", ""]];

  async function carregar() {
    const r = await sb().from("repo_pre").select("*").order("criado_em", { ascending: true });
    if (r.error) { ok = false; L = []; } else { ok = true; L = r.data || []; }
    desenhar();
  }
  function desenhar() {
    if (!ok) { $("rpp-info").textContent = "Para usar esta aba, rode a parte 97 no Supabase."; $("rpp-cards").innerHTML = $("rpp-lista").innerHTML = ""; return; }
    const ult = L.map((x) => x.analisado_em).filter(Boolean).sort().pop();
    $("rpp-info").textContent = `${fmt(L.filter((x) => x.na_lista).length)} caso(s) na lista do portal · última análise do robô ${hora(ult)}`;
    const n = (k) => L.filter((x) => k === "todos" || sit(x) === k).length;
    $("rpp-cards").innerHTML = CARDS.map(([k, rot, sub, cor]) => `<button type="button" class="kpi ${cor}${card === k ? " ativa" : ""}" data-rpp="${k}"><span class="kpi-rot">${rot}</span><b class="kpi-num">${fmt(n(k))}</b><small>${sub}</small></button>`).join("");
    const q = ($("rpp-busca").value || "").replace(/\D/g, "");
    const V = L.filter((x) => (card === "todos" || sit(x) === card) && (!q || String(x.nf).replace(/\D/g, "").includes(q)));
    $("rpp-titulo").textContent = `${CARDS.find((c) => c[0] === card)[1]} (${fmt(V.length)})`;
    $("rpp-lista").innerHTML = V.map(caso).join("") || `<p class="vazio">Nenhum caso aqui.</p>`;
  }
  function caso(x) {
    const posse = new Set(x.vol_posse || []), rp = repor(x), al = alertas(x);
    const vols = (x.volumes || []).map((v, i) => `<button type="button" class="rpp-vol${posse.has(v) ? " posse" : ""}" data-rpp-vol="${esc(v)}" data-nf="${esc(x.nf)}" title="${posse.has(v) ? "Está com a transportadora (clique para desmarcar)" : "Clique se este volume aparece na foto"}">${esc(v)}${posse.has(v) ? " · em posse" : ""}</button>`).join("")
      || `<span class="s">${x.analisado_em ? "O robô não achou os volumes da NF na janela Criar Ticket." : "Aguardando o robô."}</span>`;
    const fotos = (x.fotos || []).map((f, i) => `<div class="rpp-foto"><button type="button" class="rpp-baixa" data-rpp-baixa="${esc(f)}" data-nome="NF-${esc(x.nf)}-foto-${i + 1}" title="Clique para baixar a foto"><img src="${esc(f)}" alt="Foto anexada pela transportadora" loading="lazy"></button><a class="s" href="${esc(f)}" target="_blank" rel="noopener noreferrer">🔍 ampliar</a></div>`).join("") || `<div class="rpp-semfoto">sem foto</div>`;
    const tks = (x.tickets || []).map((t) => `<span class="chip${/devolu|cancel/i.test(`${t.tipo} ${t.fila}`) ? " verm" : ""}">${esc(t.tipo || "ticket")}${t.fila ? " · " + esc(t.fila) : ""}${t.situacao ? " · " + esc(t.situacao) : ""}</span>`).join(" ") || `<span class="s">${x.venda ? "sem tickets" : ""}</span>`;
    return `<article class="rpp-caso">
      <div class="rpp-fotos">${fotos}</div>
      <div class="rpp-corpo">
        <div class="rpp-cab"><b>NF ${esc(x.nf)}</b> · ${esc(x.transp || "")} · solicitado ${esc(x.solicitado || "—")}${x.na_lista ? "" : ` · <span class="chip">saiu da lista</span>`}
          <span class="s">· SKU ${esc((x.sku || []).join(", ") || "—")} · 360: ${x.venda == null ? "—" : x.venda ? "venda" + (x.status_360 ? " (" + esc(x.status_360) + ")" : "") : "não achado"}${x.data_360 ? " · " + esc(x.data_360) : ""}</span></div>
        ${al.map(([t, m]) => `<div class="rpp-al ${t}">⚠ ${esc(m)}</div>`).join("")}
        <div class="rpp-vols"><span class="s">${(x.volumes || []).length ? `A NF tem <b>${x.volumes.length} volume(s)</b> · clique no(s) que aparece(m) na foto:` : "Volumes da NF:"}</span> ${vols}</div>
        <div class="rpp-falta${posse.size && rp.length ? " ok" : ""}">${posse.size && rp.length ? `📦 <b>Volume faltante (repor): ${rp.map(esc).join(", ")}</b>` : posse.size ? `📦 <b>Nenhum volume faltante</b> <span class="s">(todos marcados como em posse)</span>` : `📦 <b>Volume faltante: ?</b> <span class="s">clique acima no volume que aparece na foto (está com a transportadora); o outro é o faltante</span>`}
          ${x.marcado_por ? `<span class="s">· marcado por ${esc(String(x.marcado_por).split("@")[0])} ${hora(x.marcado_em)}</span>` : ""}</div>
        <div class="rpp-acao">${acao(x, rp)}</div>
        <div class="rpp-tks"><span class="s">Tickets do pedido no 360:</span> ${tks}</div>
      </div></article>`;
  }
  function acao(x, rp) {
    if (x.solicitar_status === "feito") return `<span class="chip verde">✓ Reposição solicitada ${hora(x.feito_em)}${x.ticket_360 ? ` · <a href="https://appv2.360multi.com/tickets/${esc(x.ticket_360)}" target="_blank" rel="noopener noreferrer">ticket ${esc(x.ticket_360)} ↗</a>` : ""}</span>`;
    if (x.solicitar_status === "pendente") return `<span class="chip">⏳ Enviado ao robô ${hora(x.solicitar_em)}${x.solicitar_msg ? " · " + esc(x.solicitar_msg) : ""}</span>`;
    const pode = x.na_lista && rp.length && (x.vol_posse || []).length && x.venda !== false && !x.tem_devolucao;
    return pode ? `<button type="button" class="btn amarelo" data-rpp-sol="${esc(x.nf)}">📤 Solicitar reposição de ${rp.map(esc).join(", ")}</button>${x.solicitar_status === "erro" ? ` <span class="s">(tentar de novo)</span>` : ""}` : "";
  }
  async function solicitar(nf) {
    const x = L.find((y) => y.nf === nf); if (!x) return; const rp = repor(x);
    if (!confirm(`Solicitar a reposição da NF ${nf}?\n\nO robô vai:\n1) no portal: ⋯ › Abrir Ticket › Volumes ${rp.join(", ")} › Adicionar\n2) no 360 (login do Eduardo): comentário no ticket de Reposição com o print do rastreio e da solicitação${/jadlog/i.test(x.transp || "") ? " + o CNPJ da anotação em maiúsculas" : ""}.\n\nIsso cria o ticket de verdade.`)) return;
    const email = ((await sb().auth.getUser()).data.user || {}).email || null;
    const novo = { solicitar_status: "pendente", solicitar_por: email, solicitar_em: new Date().toISOString(), solicitar_msg: null };
    const r = await sb().from("repo_pre").update(novo).eq("nf", nf);
    if (r.error) return toast(/solicitar_status/.test(r.error.message) ? "Rode a parte 99 no Supabase." : "Não salvei: " + r.error.message, true);
    Object.assign(x, novo); desenhar();
    const r2 = await sb().rpc("rodar_robo_repopre_solicitar"); if (r2.error) return toast("Marcado, mas não consegui chamar o robô: " + r2.error.message, true);
    toast("Robô chamado: em alguns minutos aparece como solicitada."); setTimeout(carregar, 180000);
  }
  // clicar na foto baixa o arquivo (Brenda 27/11); se o site da foto não deixar baixar direto, abre numa aba para salvar
  async function baixarFoto(url, nome) {
    try {
      const r = await fetch(url, { mode: "cors" }); if (!r.ok) throw new Error(r.status);
      const b = await r.blob(), ext = (b.type.split("/")[1] || "jpg").replace("jpeg", "jpg"), a = document.createElement("a");
      a.href = URL.createObjectURL(b); a.download = `${nome}.${ext}`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (_) { window.open(url, "_blank", "noopener"); toast("Abri a foto numa aba: clique com o botão direito › Salvar imagem como."); }
  }
  async function marcar(nf, v) {
    const x = L.find((y) => y.nf === nf); if (!x) return;
    const S = new Set(x.vol_posse || []); S.has(v) ? S.delete(v) : S.add(v);
    const email = ((await sb().auth.getUser()).data.user || {}).email || null;
    const novo = { vol_posse: [...S], marcado_por: email, marcado_em: new Date().toISOString() };
    const r = await sb().from("repo_pre").update(novo).eq("nf", nf);
    if (r.error) return toast("Não salvei: " + r.error.message, true);
    Object.assign(x, novo); desenhar();
  }
  $("rp-repopre").addEventListener("click", (e) => {
    const c = e.target.closest("[data-rpp]"); if (c) { card = c.dataset.rpp; desenhar(); return; }
    const v = e.target.closest("[data-rpp-vol]"); if (v) { const x = L.find((y) => y.nf === v.dataset.nf); if (x && ["pendente", "feito"].includes(x.solicitar_status)) return toast("Já foi para a solicitação: não dá para mudar o volume.", true); marcar(v.dataset.nf, v.dataset.rppVol); return; }
    const bx = e.target.closest("[data-rpp-baixa]"); if (bx) { baixarFoto(bx.dataset.rppBaixa, bx.dataset.nome); return; }
    const so = e.target.closest("[data-rpp-sol]"); if (so) solicitar(so.dataset.rppSol);
  });
  $("rpp-busca").addEventListener("input", desenhar);
  $("rpp-rodar").addEventListener("click", async () => {
    const r = await sb().rpc("rodar_robo_repopre"); if (r.error) return toast("Não consegui chamar o robô: " + r.error.message, true);
    toast("Robô chamado: em uns minutos os casos aparecem aqui."); setTimeout(carregar, 240000);
  });
  $("rpp-excel").addEventListener("click", () => {
    if (!L.length) return toast("Nada para exportar.", true);
    const SIT = Object.fromEntries(CARDS.map((c) => [c[0], c[1]]));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["NF", "Transportadora", "Solicitado", "Situação", "Volumes da NF", "Em posse (foto)", "Repor", "SKU", "360", "Tickets", "Alertas", "Marcado por", "Analisado em"]]
      .concat(L.map((x) => [x.nf, x.transp, x.solicitado, SIT[sit(x)], (x.volumes || []).join(", "), (x.vol_posse || []).join(", "), repor(x).join(", "), (x.sku || []).join(", "),
        x.venda == null ? "" : x.venda ? "venda" : "não achado", (x.tickets || []).map((t) => [t.tipo, t.fila, t.situacao].filter(Boolean).join(" / ")).join(" | "),
        alertas(x).map((a) => a[1]).join(" | "), x.marcado_por || "", hora(x.analisado_em)]))), "Falta de volumes");
    XLSX.writeFile(wb, `reposicao_pre_falta_volumes_${new Date().toISOString().slice(0, 10)}.xlsx`);
  });
  setInterval(() => { if ($("rp-repopre").offsetParent && window.__sb && !carregou) { carregou = true; carregar(); setInterval(() => { if ($("rp-repopre").offsetParent) carregar(); }, 120000); } }, 2000);
})();
