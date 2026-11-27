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
  // motivo (Brenda 27/11): Falta de volumes e Extravio = marcados estão COM a transportadora (repõe o resto);
  // Avaria = marcados são os AVARIADOS (repõe esses); Extravio com 1 volume só = extravio total; Inversão = conferir à mão
  const MOT = (x) => { const m = String(x.motivo || ""); return /avaria/i.test(m) ? "avaria" : /extravi/i.test(m) ? "extravio" : /invers/i.test(m) ? "inversao" : /sinistr|roub|furt/i.test(m) ? "sinistro" : "falta"; };
  const TOTAL = (x) => /EXTRAVIO TOTAL/.test(x.obs || "");
  const repor = (x) => { const vs = x.volumes || [], mk = x.vol_posse || [], m = MOT(x);
    if (m === "avaria") return vs.filter((v) => mk.includes(v));
    if (m === "inversao" || m === "sinistro") return [];
    if (m === "extravio" && !mk.length && (vs.length === 1 || TOTAL(x))) return vs;
    return mk.length ? vs.filter((v) => !mk.includes(v)) : []; };
  const PAL_AVARIA = /avari|amassad|quebrad|rasgad|danific|molhad/i, PAL_TOTAL = /extravio total|todos os volumes|nenhum volume|n[aã]o (temos|recebemos|localizamos) (nenhum|o pedido|a carga)/i;
  const ultAnot = (x) => (x.anotacoes || []).slice(-1)[0] || null;
  // sugestão do robô para o caso (o que acha que falta fazer)
  function sugestao(x) {
    const m = MOT(x), vs = x.volumes || [], mk = x.vol_posse || [], fotos = (x.fotos || []).length, an = (x.anotacoes || []).map((a) => a.texto).join(" "), rs = x.rastreio || {};
    if (/^entregue/i.test(rs.situacao || "")) return ["mao", `O rastreio${rs.fonte ? " (" + rs.fonte + ")" : ""} diz ENTREGUE${rs.data ? " em " + rs.data : ""}: conferir o comprovante (tem ressalva?) antes de repor.`];
    if (rs.sinistro) return ["mao", `O rastreio${rs.fonte ? " (" + rs.fonte + ")" : ""} fala em "${rs.sinistro.toLowerCase()}": possível sinistro. Conferir com a transportadora antes de repor.`];
    if (x.tem_devolucao) return ["mao", "Tem ticket de devolução/cancelamento no 360: não repor, conferir à mão."];
    if (x.venda === false) return ["mao", "NF não achada como venda no 360: conferir à mão."];
    if (!vs.length) return ["aviso", "O robô não leu os volumes da NF: conferir no portal."];
    if (m === "inversao") return ["aviso", "Inversão: deixar a transportadora fazer a troca; se ela não fizer, seguimos com o envio. Conferir à mão."];
    if (m === "sinistro") return ["mao", "Sinistro: conferir o rastreio e o boletim/ocorrência com a transportadora antes de repor."];
    if (m === "avaria") {
      if (mk.length) return ["ok", `Avaria: repor o(s) volume(s) avariado(s) ${mk.map((v) => rotVol(x, v) + v).join(", ")}.`];
      if (fotos) return ["acao", `Avaria: olhe a foto e clique no volume AVARIADO.${PAL_AVARIA.test(an) ? " A anotação da transportadora também fala da avaria." : ""}`];
      if (PAL_AVARIA.test(an)) return ["acao", "Avaria sem foto, mas a anotação descreve a avaria: leia a anotação e clique no volume avariado."];
      return ["aviso", "Avaria sem foto e sem anotação: pedir à transportadora a foto do volume avariado."];
    }
    if (m === "extravio") {
      if (vs.length === 1) return ["ok", `Extravio de produto com 1 volume só = extravio total: repor ${rotVol(x, vs[0])}${vs[0]}.`];
      if (TOTAL(x)) return ["ok", `Extravio total marcado: repor todos os ${vs.length} volumes.`];
      if (mk.length) return ["ok", `Extravio parcial: a transportadora tem ${mk.length} volume(s); repor ${repor(x).map((v) => rotVol(x, v) + v).join(", ")}.`];
      if (fotos) return ["acao", "Extravio: a transportadora mandou foto de volume em posse? Clique no(s) volume(s) da foto; o que sobrar é o extraviado."];
      if (PAL_TOTAL.test(an)) return ["acao", "Extravio: a anotação indica que não tem nenhum volume. Se confirmar, use \"Extravio total\"."];
      return ["acao", `Extravio sem foto: se nenhum volume está com a transportadora, use "Extravio total" (repor os ${vs.length}).`];
    }
    // falta de volumes
    if (mk.length && repor(x).length) return ["ok", `Falta de volumes: repor ${repor(x).map((v) => rotVol(x, v) + v).join(", ")}.`];
    if (mk.length) return ["aviso", "Todos os volumes marcados como em posse: não sobra volume faltante. Conferir."];
    if (fotos) return ["acao", "Falta de volumes: olhe a foto e clique no(s) volume(s) que estão com a transportadora."];
    return ["aviso", "Falta de volumes sem foto: pedir à transportadora a foto da etiqueta do volume em posse."];
  }
  const alertas = (x) => {
    const a = [];
    if (x.robo_msg) a.push(["erro", "Robô: " + x.robo_msg]);
    if (x.solicitar_status === "erro") a.push(["erro", "Solicitação: " + (x.solicitar_msg || "erro")]);
    if (x.venda === false) a.push(["mao", "NF não achada em 360 › Hub › Pedidos (não é venda?): conferir à mão"]);
    if (x.tem_devolucao) a.push(["mao", "Tem ticket de devolução/cancelamento no 360: conferir à mão"]);
    const d = dBR(x.data_360); if (d && d < seisMeses()) a.push(["aviso", "Pedido com mais de 6 meses: conferir a numeração da NF"]);
    if (x.rastreio && x.rastreio.sinistro) a.push(["mao", `Rastreio com "${x.rastreio.sinistro.toLowerCase()}": possível sinistro`]);
    return a;
  };
  const sit = (x) => {
    if (x.solicitar_status === "feito") return "feito";
    if (x.solicitar_status === "pendente") return "fila";
    if (x.solicitar_status === "erro") return "mao";
    if (!x.na_lista) return "saiu";
    if (!x.analisado_em) return "robo";
    if (alertas(x).some((a) => a[0] === "mao" || a[0] === "erro")) return "mao";
    if (["inversao", "sinistro"].includes(MOT(x))) return "mao";
    return repor(x).length ? "pronto" : "marcar";
  };
  const CARDS = [["marcar", "Para analisar", "olhe a foto/anotação e marque o volume", "amarelo"], ["pronto", "Pronto para solicitar", "volume a repor definido", "verde"],
    ["fila", "Solicitando", "o robô está pedindo a reposição", "azul"], ["feito", "Reposição solicitada", "ticket no portal + comentário no 360", "verde"], ["mao", "Conferir à mão", "devolução, sinistro, inversão, não é venda ou erro", "vermelho"], ["robo", "Aguardando o robô", "ainda não analisados", ""], ["saiu", "Saíram da lista", "não estão mais Novo no portal", ""], ["todos", "Todos", "", ""]];

  // cadastro de volumes (parte 101): SKU → volume → número do volume e descrição
  let CAD = new Map();   // "sku|volume" e "volume" → { nro, total, descricao }
  const vKey = (v) => String(v || "").trim().replace(/\.0+$/, "");
  async function carregarCad() {
    const skus = [...new Set(L.flatMap((x) => x.sku || []))]; CAD = new Map(); if (!skus.length) return;
    const r = await sb().from("vol_cadastro").select("modelo,volume,nro,descricao").in("modelo", skus).then((x) => x, () => ({ error: 1 })); if (r.error) return;
    const tot = {}; (r.data || []).forEach((c) => (tot[c.modelo] = Math.max(tot[c.modelo] || 0, c.nro || 0)));
    (r.data || []).forEach((c) => { const i = { nro: c.nro, total: tot[c.modelo], descricao: c.descricao, modelo: c.modelo }; CAD.set(c.modelo + "|" + vKey(c.volume), i); CAD.set(c.modelo + "|" + vKey(c.volume).split(".")[0], i); });
  }
  const infoVol = (x, v) => { for (const s of x.sku || []) { const i = CAD.get(s + "|" + vKey(v)) || CAD.get(s + "|" + vKey(v).split(".")[0]); if (i) return i; } return null; };
  const rotVol = (x, v) => { const i = infoVol(x, v); return i && i.nro ? `Vol ${i.nro}/${(x.volumes || []).length || i.total} · ` : ""; };
  async function carregar() {
    const r = await sb().from("repo_pre").select("*").order("criado_em", { ascending: true });
    if (r.error) { ok = false; L = []; } else { ok = true; L = r.data || []; }
    await carregarCad();
    desenhar();
  }
  const urlsP = new Map();
  async function urlPrint(p) {   // print do rastreio fica no bucket privado "barrar": link assinado por 1 h
    if (urlsP.has(p)) return urlsP.get(p);
    try { const { data, error } = await sb().storage.from("barrar").createSignedUrl(p, 3600); if (error) throw error; urlsP.set(p, data.signedUrl); setTimeout(() => urlsP.delete(p), 3000000); return data.signedUrl; } catch (_) { return null; }
  }
  function desenhar() {
    if (!ok) { $("rpp-info").textContent = "Para usar esta aba, rode a parte 97 no Supabase."; $("rpp-cards").innerHTML = $("rpp-lista").innerHTML = ""; return; }
    const ult = L.map((x) => x.analisado_em).filter(Boolean).sort().pop();
    $("rpp-info").textContent = `${fmt(L.filter((x) => x.na_lista).length)} caso(s) na lista do portal · última análise do robô ${hora(ult)}`;
    const n = (k) => L.filter((x) => (k === "todos" || sit(x) === k) && (!$("rpp-motivo").value || (x.motivo || "Falta de volumes") === $("rpp-motivo").value)).length;
    $("rpp-cards").innerHTML = CARDS.map(([k, rot, sub, cor]) => `<button type="button" class="kpi ${cor}${card === k ? " ativa" : ""}" data-rpp="${k}"><span class="kpi-rot">${rot}</span><b class="kpi-num">${fmt(n(k))}</b><small>${sub}</small></button>`).join("");
    const q = ($("rpp-busca").value || "").replace(/\D/g, "");
    const mf = $("rpp-motivo").value, mots = [...new Set(L.map((x) => x.motivo || "Falta de volumes"))].sort();
    $("rpp-motivo").innerHTML = `<option value="">Todos os motivos</option>` + mots.map((m) => `<option${m === mf ? " selected" : ""}>${esc(m)}</option>`).join("");
    const V = L.filter((x) => (card === "todos" || sit(x) === card) && (!mf || (x.motivo || "Falta de volumes") === mf) && (!q || String(x.nf).replace(/\D/g, "").includes(q)));
    $("rpp-titulo").textContent = `${CARDS.find((c) => c[0] === card)[1]} (${fmt(V.length)})`;
    $("rpp-lista").innerHTML = V.map(caso).join("") || `<p class="vazio">Nenhum caso aqui.</p>`;
    $("rpp-lista").querySelectorAll("img[data-rpp-prrimg]").forEach(async (im) => { const u = await urlPrint(im.dataset.rppPrrimg); if (u) im.src = u; });
  }
  function caso(x) {
    const posse = new Set(x.vol_posse || []), rp = repor(x), al = alertas(x);
    const vols = [...(x.volumes || [])].sort((a, b) => ((infoVol(x, a) || {}).nro || 99) - ((infoVol(x, b) || {}).nro || 99)).map((v, i) => `<button type="button" class="rpp-vol${posse.has(v) ? (MOT(x) === "avaria" ? " avariado" : " posse") : ""}" data-rpp-vol="${esc(v)}" data-nf="${esc(x.nf)}" title="${esc((infoVol(x, v) || {}).descricao || "")} · ${posse.has(v) ? "Está com a transportadora (clique para desmarcar)" : "Clique se este volume aparece na foto"}">${rotVol(x, v)}${esc(v)}${posse.has(v) ? (MOT(x) === "avaria" ? " · avariado" : " · em posse") : ""}</button>`).join("")
      || `<span class="s">${x.analisado_em ? "O robô não achou os volumes da NF na janela Criar Ticket." : "Aguardando o robô."}</span>`;
    const fotos = (x.fotos || []).map((f, i) => `<div class="rpp-foto"><button type="button" class="rpp-baixa" data-rpp-baixa="${esc(f)}" data-nome="NF-${esc(x.nf)}-foto-${i + 1}" title="Clique para baixar a foto"><img src="${esc(f)}" alt="Foto anexada pela transportadora" loading="lazy"></button><a class="s" href="${esc(f)}" target="_blank" rel="noopener noreferrer">🔍 ampliar</a></div>`).join("") || `<div class="rpp-semfoto">sem foto</div>`;
    const tks = (x.tickets || []).map((t) => `<span class="chip${/devolu|cancel/i.test(`${t.tipo} ${t.fila}`) ? " verm" : ""}">${esc(t.tipo || "ticket")}${t.fila ? " · " + esc(t.fila) : ""}${t.situacao ? " · " + esc(t.situacao) : ""}</span>`).join(" ") || `<span class="s">${x.venda ? "sem tickets" : ""}</span>`;
    const prr = x.rastreio && x.rastreio.print ? `<div class="rpp-foto rpp-prr"><button type="button" class="rpp-baixa" data-rpp-prr="${esc(x.rastreio.print)}" title="Print do rastreio${x.rastreio.fonte ? " (" + esc(x.rastreio.fonte) + ")" : ""}: clique para ampliar"><img data-rpp-prrimg="${esc(x.rastreio.print)}" alt="Print do rastreio"></button><span class="s">📍 rastreio${x.rastreio.print_em ? " " + hora(x.rastreio.print_em) : ""}</span></div>` : "";
    return `<article class="rpp-caso">
      <div class="rpp-fotos">${fotos}${prr}</div>
      <div class="rpp-corpo">
        <div class="rpp-cab"><span class="chip rpp-mot ${MOT(x)}">${esc(x.motivo || "Falta de volumes")}</span> <b>NF ${esc(x.nf)}</b> · ${esc(x.transp || "")} · solicitado ${esc(x.solicitado || "—")}${x.na_lista ? "" : ` · <span class="chip">saiu da lista</span>`}
          <span class="s">· SKU ${esc((x.sku || []).join(", ") || "—")} · 360: ${x.venda == null ? "—" : x.venda ? "venda" + (x.status_360 ? " (" + esc(x.status_360) + ")" : "") : "não achado"}${x.data_360 ? " · " + esc(x.data_360) : ""}</span></div>
        ${(([t, m]) => `<div class="rpp-sug ${t}">💡 <b>Sugestão:</b> ${esc(m)}</div>`)(sugestao(x))}
        ${x.foto_ia ? `<div class="rpp-ia">🤖 <b>Leitura da foto (teste):</b> ${(x.foto_ia.volumes_vistos || []).length ? x.foto_ia.volumes_vistos.map((v) => rotVol(x, v) + esc(v)).join(", ") : "nenhum volume da NF identificado"} · confiança ${esc(x.foto_ia.confianca || "—")}${x.foto_ia.vol_nf && x.foto_ia.vol_nf.length ? ` · etiqueta ${esc(x.foto_ia.vol_nf.join(", "))}` : ""}${x.foto_ia.observacao ? `<div class="s">${esc(x.foto_ia.observacao)}</div>` : ""}</div>` : ""}
        ${al.map(([t, m]) => `<div class="rpp-al ${t}">⚠ ${esc(m)}</div>`).join("")}
        ${(x.anotacoes || []).length ? `<div class="rpp-anot"><span class="s">Anotações da transportadora:</span>${x.anotacoes.slice(-3).map((a) => `<div><span class="s">${esc(a.quando)}</span> ${esc(a.texto)}</div>`).join("")}</div>` : ""}
        ${x.rastreio && x.rastreio.situacao ? `<div class="s">Rastreio${x.rastreio.fonte ? " " + esc(x.rastreio.fonte) : ""}: ${esc(x.rastreio.situacao)}${x.rastreio.evento ? " · " + esc(x.rastreio.evento) : ""}${x.rastreio.data ? " · " + esc(x.rastreio.data) : ""}</div>` : ""}
        <div class="rpp-vols"><span class="s">${(x.volumes || []).length ? `A NF tem <b>${x.volumes.length} volume(s)</b> · ${MOT(x) === "avaria" ? "clique no(s) volume(s) <b>avariado(s)</b>:" : "clique no(s) que estão com a transportadora (foto):"}` : "Volumes da NF:"}</span> ${vols}</div>
        <div class="rpp-falta${rp.length ? " ok" : ""}">${rp.length ? `📦 <b>${MOT(x) === "avaria" ? "Volume avariado (repor)" : MOT(x) === "extravio" ? "Volume extraviado (repor)" : "Volume faltante (repor)"}: ${rp.map((v) => rotVol(x, v) + esc(v)).join(", ")}</b>` + (MOT(x) === "extravio" && TOTAL(x) ? ` <button type="button" class="link" data-rpp-total="${esc(x.nf)}">desfazer extravio total</button>` : "") : MOT(x) === "extravio" && (x.volumes || []).length > 1 && !posse.size ? `📦 <b>Volume extraviado: ?</b> <button type="button" class="btn mini contorno" data-rpp-total="${esc(x.nf)}">Extravio total (repor os ${x.volumes.length})</button>` : posse.size && rp.length ? `📦 <b>Volume faltante (repor): ${rp.map((v) => rotVol(x, v) + esc(v)).join(", ")}</b>` : posse.size ? `📦 <b>Nenhum volume faltante</b> <span class="s">(todos marcados como em posse)</span>` : `📦 <b>Volume faltante: ?</b> <span class="s">clique acima no volume que aparece na foto (está com a transportadora); o outro é o faltante</span>`}
          ${x.marcado_por ? `<span class="s">· marcado por ${esc(String(x.marcado_por).split("@")[0])} ${hora(x.marcado_em)}</span>` : ""}</div>
        <div class="rpp-acao">${acao(x, rp)}</div>
        <div class="rpp-tks"><span class="s">Tickets do pedido no 360:</span> ${tks}</div>
      </div></article>`;
  }
  function acao(x, rp) {
    if (x.solicitar_status === "feito") return `<span class="chip verde">✓ Reposição solicitada ${hora(x.feito_em)}${x.ticket_360 ? ` · <a href="https://appv2.360multi.com/tickets/${esc(x.ticket_360)}" target="_blank" rel="noopener noreferrer">ticket ${esc(x.ticket_360)} ↗</a>` : ""}</span>`;
    if (x.solicitar_status === "pendente") return `<span class="chip">⏳ Enviado ao robô ${hora(x.solicitar_em)}${x.solicitar_msg ? " · " + esc(x.solicitar_msg) : ""}</span>`;
    const pode = x.na_lista && rp.length && x.venda !== false && !x.tem_devolucao && !(x.rastreio && x.rastreio.sinistro);
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
  async function marcarTotal(nf) {
    const x = L.find((y) => y.nf === nf); if (!x) return;
    const email = ((await sb().auth.getUser()).data.user || {}).email || null;
    const novo = { obs: TOTAL(x) ? null : "EXTRAVIO TOTAL", vol_posse: [], marcado_por: email, marcado_em: new Date().toISOString() };
    const r = await sb().from("repo_pre").update(novo).eq("nf", nf); if (r.error) return toast("Não salvei: " + r.error.message, true);
    Object.assign(x, novo); desenhar();
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
  $("rp-repopre").addEventListener("click", async (e) => {
    const pr = e.target.closest("[data-rpp-prr]"); if (pr) { const u = await urlPrint(pr.dataset.rppPrr); if (u) window.open(u, "_blank", "noopener"); else toast("Não consegui abrir o print do rastreio.", true); return; }
    const c = e.target.closest("[data-rpp]"); if (c) { card = c.dataset.rpp; desenhar(); return; }
    const v = e.target.closest("[data-rpp-vol]"); if (v) { const x = L.find((y) => y.nf === v.dataset.nf); if (x && ["pendente", "feito"].includes(x.solicitar_status)) return toast("Já foi para a solicitação: não dá para mudar o volume.", true); marcar(v.dataset.nf, v.dataset.rppVol); return; }
    const bx = e.target.closest("[data-rpp-baixa]"); if (bx) { baixarFoto(bx.dataset.rppBaixa, bx.dataset.nome); return; }
    const tt = e.target.closest("[data-rpp-total]"); if (tt) { marcarTotal(tt.dataset.rppTotal); return; }
    const so = e.target.closest("[data-rpp-sol]"); if (so) solicitar(so.dataset.rppSol);
  });
  $("rpp-busca").addEventListener("input", desenhar);
  $("rpp-motivo").addEventListener("change", desenhar);
  $("rpp-vol-arq").addEventListener("change", async (e) => {
    const f = e.target.files[0]; e.target.value = ""; if (!f) return;
    try {
      const wb = XLSX.read(await f.arrayBuffer(), { type: "array" });
      const aba = wb.SheetNames.find((n) => /base\s*cadastr/i.test(n)) || wb.SheetNames[0];
      const M = XLSX.utils.sheet_to_json(wb.Sheets[aba], { header: 1, defval: "" });
      const hi = M.findIndex((r) => r.some((c) => /c[oó]digo\s*modelo/i.test(String(c))) && r.some((c) => /^volume$/i.test(String(c).trim()))); if (hi < 0) throw new Error(`não achei as colunas "Código Modelo" e "Volume" na aba ${aba}`);
      const H = M[hi].map((c) => String(c).trim()), col = (re) => H.findIndex((h) => re.test(h));
      const iM = col(/c[oó]digo\s*modelo/i), iV = col(/^volume$/i), iN = col(/nro\s*volume/i), iQ = col(/qtde/i), iP = col(/^produto$/i), iD = col(/descri/i);
      const vis = new Set(), linhas = [];
      for (const r of M.slice(hi + 1)) { const m = String(r[iM] || "").trim(), v = String(r[iV] || "").trim(); if (!m || !v || vis.has(m + "|" + v)) continue; vis.add(m + "|" + v);
        linhas.push({ modelo: m, volume: v, nro: parseInt(r[iN], 10) || null, qtde: iQ >= 0 ? String(r[iQ]) : null, produto: iP >= 0 ? String(r[iP]) : null, descricao: iD >= 0 ? String(r[iD]).slice(0, 200) : null }); }
      if (!linhas.length) throw new Error("planilha sem linhas");
      toast(`Enviando ${linhas.length} volumes…`);
      for (let i = 0; i < linhas.length; i += 1000) { const r = await sb().from("vol_cadastro").upsert(linhas.slice(i, i + 1000)); if (r.error) throw new Error(/vol_cadastro/.test(r.error.message) ? "Rode a parte 101 no Supabase." : r.error.message); }
      toast(`Planilha de volumes enviada: ${linhas.length} volumes (aba ${aba}).`); carregar();
    } catch (err) { toast("Não consegui ler a planilha: " + (err.message || err), true); }
  });
  $("rpp-rodar").addEventListener("click", async () => {
    const r = await sb().rpc("rodar_robo_repopre"); if (r.error) return toast("Não consegui chamar o robô: " + r.error.message, true);
    toast("Robô chamado: em uns minutos os casos aparecem aqui."); setTimeout(carregar, 240000);
  });
  $("rpp-excel").addEventListener("click", () => {
    if (!L.length) return toast("Nada para exportar.", true);
    const SIT = Object.fromEntries(CARDS.map((c) => [c[0], c[1]]));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["NF", "Motivo", "Sugestão", "Transportadora", "Solicitado", "Situação", "Volumes da NF", "Em posse (foto)", "Repor", "SKU", "360", "Tickets", "Alertas", "Marcado por", "Analisado em"]]
      .concat(L.map((x) => [x.nf, x.motivo, sugestao(x)[1], x.transp, x.solicitado, SIT[sit(x)], (x.volumes || []).join(", "), (x.vol_posse || []).join(", "), repor(x).join(", "), (x.sku || []).join(", "),
        x.venda == null ? "" : x.venda ? "venda" : "não achado", (x.tickets || []).map((t) => [t.tipo, t.fila, t.situacao].filter(Boolean).join(" / ")).join(" | "),
        alertas(x).map((a) => a[1]).join(" | "), x.marcado_por || "", hora(x.analisado_em)]))), "Reposição pré");
    XLSX.writeFile(wb, `reposicao_pre_falta_volumes_${new Date().toISOString().slice(0, 10)}.xlsx`);
  });
  setInterval(() => { if ($("rp-repopre").offsetParent && window.__sb && !carregou) { carregou = true; carregar(); setInterval(() => { if ($("rp-repopre").offsetParent) carregar(); }, 120000); } }, 2000);
})();
