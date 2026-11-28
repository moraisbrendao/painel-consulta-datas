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

  let TODOS = [], L = [], ok = true, card = "marcar", carregou = false;
  const SEL = new Set();   // casos do Pronto para solicitar marcados para solicitar juntos
  // motivo (Brenda 27/11): Falta de volumes e Extravio = marcados estão COM a transportadora (repõe o resto);
  // Avaria = marcados são os AVARIADOS (repõe esses); Extravio com 1 volume só = extravio total; Inversão = conferir à mão
  const MOT = (x) => { const m = String(x.motivo || ""); return /avaria/i.test(m) ? "avaria" : /extravi/i.test(m) ? "extravio" : /invers/i.test(m) ? "inversao" : /sinistr|roub|furt/i.test(m) ? "sinistro" : "falta"; };
  const TOTAL = (x) => /EXTRAVIO TOTAL/.test(x.obs || "");
  const REVISAR = (x) => /^REVISAR$/.test(x.obs || "");
  // decisão por caso (Brenda 27/11, igual ao Barrar): ✓ Repor (vai para Pronto) / ✗ Não repor (card próprio). Fica no obs, junto com EXTRAVIO TOTAL.
  // quem já tinha marcado volume antes dos botões conta como aprovado, para nada sair do Pronto.
  const NAOREP = (x) => /NÃO REPOR/.test(x.obs || "");
  const APROV = (x) => /APROVADO/.test(x.obs || "") || (!!x.marcado_por && String(x.marcado_em || "") < "2026-11-28T01:00" && !REVISAR(x) && !NAOREP(x) && ((x.vol_posse || []).length > 0 || TOTAL(x)));
  const obsDe = (x, mud) => { const t = { total: TOTAL(x), aprov: /APROVADO/.test(x.obs || ""), nao: NAOREP(x), ...mud }; return [t.total && "EXTRAVIO TOTAL", t.aprov && "APROVADO", t.nao && "NÃO REPOR"].filter(Boolean).join(" · ") || null; };   // "↩ Voltar para analisar" (Brenda 27/11): sai do Pronto até alguém marcar de novo
  const repor = (x) => { const vs = x.volumes || [], mk = x.vol_posse || [], m = MOT(x);
    if (m === "avaria") return vs.filter((v) => mk.includes(v));
    if (m === "inversao" || m === "sinistro" || REVISAR(x)) return [];
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
      if (vs.length === 1) return ["acao", `Avaria em NF de 1 volume só: o avariado é ${rotVol(x, vs[0])}${vs[0]}.${PAL_AVARIA.test(an) ? " A anotação da transportadora confirma a avaria." : ""} Confira e use o ✓ Repor.`];
      { const av = volsPorAnotacao(x); if (av.length && av.length < vs.length) return ["acao", `Avaria: a anotação da transportadora cita a peça do volume ${av.map((v) => rotVol(x, v) + v + " (" + ((infoVol(x, v) || {}).descricao || "") + ")").join(", ")}. Confira e use o ✓ Repor.`]; }
      { const ev = volsPorEtiqueta(x); if (ev.length && !(x.foto_ia.volumes_vistos || []).length) return ["acao", `Avaria: a etiqueta da foto diz VOL ${(x.foto_ia.vol_nf || []).join(", ")} = volume ${ev.map((v) => rotVol(x, v) + v).join(", ")} pelo cadastro. Confira e use o ✓ Repor.`]; }
      if (!vs.some((v) => infoVol(x, v))) { if (fotos || /\S/.test(an)) return ["acao", "Avaria: este SKU não está no cadastro de volumes, então não sei a descrição nem o nº de cada volume. Suba a ⇪ Planilha de volumes ou clique no volume avariado."]; }
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
    // nota de reposição/AT (Brenda 27/11): o 360 só serve para conferir se os volumes da NF batem com o que o ticket mandou
    const org = (x.tickets || []).find((t) => t.nota_de);
    if (org && (org.itens || []).length && (x.volumes || []).length && org.nota_de !== "at") {
      const k = (v) => String(v).trim().replace(/\.0+$/, ""), it = new Set(org.itens.map(k)), fora = x.volumes.filter((v) => !it.has(k(v)) && !it.has(k(v).split(".")[0]));
      a.push(fora.length ? ["aviso", `Volumes da NF no portal que não estão no ticket ${org.id}: ${fora.join(", ")} (o ticket mandou ${org.itens.join(", ")}). Conferir.`] : ["ok", `Volumes da NF batem com o ticket de reposição ${org.id} (${org.itens.join(", ")}).`]);
    }
    return a;
  };
  const sit = (x) => {
    if (x.solicitar_status === "feito") return "feito";
    if (x.solicitar_status === "pendente") return "fila";
    if (!x.na_lista && !soComentario(x)) return "saiu";   // saiu do portal (Brenda 27/11): não fica em Conferir à mão por erro antigo
    if (x.solicitar_status === "erro") return "mao";
    if (NAOREP(x)) return "naorep";
    if (!x.analisado_em) return "robo";
    if (APROV(x) && repor(x).length) return "pronto";   // a pessoa decidiu: vale mais que o alerta
    if (alertas(x).some((a) => a[0] === "mao" || a[0] === "erro")) return "mao";
    if (["inversao", "sinistro"].includes(MOT(x))) return "mao";
    return "marcar";
  };
  const CARDS = [["marcar", "Para analisar", "marque o volume e decida ✓ Repor ou ✗ Não repor", "amarelo"], ["pronto", "Pronto para solicitar", "aprovado: falta mandar o robô", "verde"],
    ["fila", "Solicitando", "o robô está pedindo a reposição", "azul"], ["feito", "Reposição solicitada", "ticket no portal + comentário no 360", "verde"], ["mao", "Conferir à mão", "devolução, sinistro, inversão, não é venda ou erro", "vermelho"], ["robo", "Aguardando o robô", "ainda não analisados", ""], ["naorep", "Não repor", "decidido: não vai reposição", "vermelho"], ["todos", "Todos", "", ""]];

  // cadastro de volumes (parte 101): SKU → volume → número do volume e descrição
  let CAD = new Map();   // "sku|volume" e "volume" → { nro, total, descricao }
  const vKey = (v) => String(v || "").trim().replace(/\.0+$/, "");
  let ENVIO = null;
  async function carregarCad() {
    try { const e = await sb().from("vol_cadastro").select("nro,produto,descricao").eq("modelo", "__ENVIO__").maybeSingle(); ENVIO = e.error ? null : e.data; } catch (_) { ENVIO = null; }
    const skus = [...new Set(TODOS.flatMap((x) => x.sku || []))]; CAD = new Map(); if (!skus.length) return;
    const r = await sb().from("vol_cadastro").select("modelo,volume,nro,descricao").in("modelo", skus).then((x) => x, () => ({ error: 1 })); if (r.error) return;
    const tot = {}; (r.data || []).forEach((c) => (tot[c.modelo] = Math.max(tot[c.modelo] || 0, c.nro || 0)));
    (r.data || []).forEach((c) => { const i = { nro: c.nro, total: tot[c.modelo], descricao: c.descricao, modelo: c.modelo }; CAD.set(c.modelo + "|" + vKey(c.volume), i); CAD.set(c.modelo + "|" + vKey(c.volume).split(".")[0], i); });
  }
  const infoVol = (x, v) => { for (const s of x.sku || []) { const i = CAD.get(s + "|" + vKey(v)) || CAD.get(s + "|" + vKey(v).split(".")[0]); if (i) return i; } return null; };
  const rotVol = (x, v) => { const i = infoVol(x, v); return i && i.nro ? `Vol ${i.nro}/${(x.volumes || []).length || i.total} · ` : ""; };
  // robô rodando agora? (robo_estado andamento:repo-pre / repo-pre-solicitar, gravado pelo robô ao começar e terminar)
  let ANDA = "", chamadoEm = 0;
  async function checarAndamento() {
    try { const r = await sb().from("robo_estado").select("nome,valor").in("nome", ["andamento:repo-pre", "andamento:repo-pre-solicitar"]); if (r.error) return;
      const ag = Date.now(), ant = ANDA;
      ANDA = (r.data || []).map((x) => x.valor || {}).filter((v) => v.rodando && v.inicio && ag - Date.parse(v.inicio) < 3 * 3600e3)
        .map((v) => `${/solicit/i.test(v.robo || "") ? "Solicitando" : "Analisando"}… desde ${hora(v.inicio).split(" às ")[1] || hora(v.inicio)}`).join(" · ");
      if (!ANDA && chamadoEm && ag - chamadoEm < 180000 && !(r.data || []).some((x) => x.valor && x.valor.fim && Date.parse(x.valor.fim) > chamadoEm)) ANDA = ant;   // ainda subindo no GitHub
      if (ant && !ANDA) carregar(); else if (ant !== ANDA) desenhar();   // terminou: recarrega os casos
    } catch (_) {}
  }
  setInterval(() => { if ($("rp-repopre").offsetParent && window.__sb) checarAndamento(); }, 15000);
  async function carregar() {
    const r = await sb().from("repo_pre").select("*").order("criado_em", { ascending: true });
    // só o que está Novo no portal agora (Brenda 27/11); o histórico fica guardado no banco. Os que o robô está solicitando continuam até ele terminar.
    TODOS = r.error ? [] : r.data || [];
    if (r.error) { ok = false; L = []; } else { ok = true; L = (r.data || []).filter((x) => x.na_lista || x.solicitar_status === "pendente" || soComentario(x)); }
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
    $("rpp-info").innerHTML = `${fmt(L.filter((x) => x.na_lista).length)} caso(s) na lista do portal · última análise do robô ${hora(ult)} · planilha de volumes: ${ENVIO ? `enviada ${hora(ENVIO.produto)} por ${esc(String(ENVIO.descricao || "").split(" · ")[0])} (${fmt(ENVIO.nro || 0)} volumes)` : `<b style="color:var(--vermelho)">ainda não enviada</b>`}`;
    // botão com ampulheta girando enquanto o robô roda (igual aos outros robôs, Brenda 27/11)
    const bt = $("rpp-rodar"); bt.classList.toggle("ag-validando", !!ANDA); bt.innerHTML = ANDA ? `<span class="ampulheta" aria-hidden="true">⏳</span> ${esc(ANDA)}` : `<span>▶ Analisar agora<small class="btn-quando">última: ${hora(ult)}</small></span>`;
    $("rpp-vol-quando").textContent = ENVIO ? `enviada ${hora(ENVIO.produto)}` : "ainda não enviada";
    const n = (k) => L.filter((x) => (k === "todos" || sit(x) === k) && (!$("rpp-motivo").value || (x.motivo || "Falta de volumes") === $("rpp-motivo").value)).length;
    $("rpp-cards").innerHTML = CARDS.map(([k, rot, sub, cor]) => `<button type="button" class="kpi ${cor}${card === k ? " ativa" : ""}" data-rpp="${k}"><span class="kpi-rot">${rot}</span><b class="kpi-num">${fmt(n(k))}</b><small>${sub}</small></button>`).join("");
    const q = ($("rpp-busca").value || "").replace(/\D/g, "");
    const mf = $("rpp-motivo").value, mots = [...new Set(L.map((x) => x.motivo || "Falta de volumes"))].sort();
    $("rpp-motivo").innerHTML = `<option value="">Todos os motivos</option>` + mots.map((m) => `<option${m === mf ? " selected" : ""}>${esc(m)}</option>`).join("");
    const V = L.filter((x) => (card === "todos" || sit(x) === card) && (!mf || (x.motivo || "Falta de volumes") === mf) && (!q || String(x.nf).replace(/\D/g, "").includes(q)));
    $("rpp-titulo").textContent = `${CARDS.find((c) => c[0] === card)[1]} (${fmt(V.length)})`;
    const prontos = V.filter((x) => podeSol(x));
    [...SEL].forEach((nf) => { if (!prontos.some((x) => x.nf === nf)) SEL.delete(nf); });
    const barra = card === "pronto" && prontos.length ? `<div class="rpp-selbar"><label><input type="checkbox" data-rpp-todos${SEL.size && SEL.size === prontos.length ? " checked" : ""}> Selecionar todos (${fmt(prontos.length)})</label>
      <button type="button" class="btn amarelo" data-rpp-sollote${SEL.size ? "" : " disabled"}>📤 Solicitar os ${fmt(SEL.size)} selecionado(s)</button><span class="s">Marque só os que você aprovou. O robô faz até 20 por vez.</span></div>` : "";
    desenharHist();
    $("rpp-lista").innerHTML = barra + (V.map(caso).join("") || `<p class="vazio">Nenhum caso aqui.</p>`);
    $("rpp-lista").querySelectorAll("img[data-rpp-prrimg]").forEach(async (im) => { const u = await urlPrint(im.dataset.rppPrrimg); if (u) im.src = u; });
  }
  // quadro por dia do que o robô solicitou (Brenda 27/11, igual ao Barrar)
  function desenharHist() {
    const F = TODOS.filter((x) => x.solicitar_status === "feito" && x.feito_em).sort((a, b) => String(b.feito_em).localeCompare(String(a.feito_em)));
    if (!F.length) { $("rpp-hist").innerHTML = `<p class="vazio">O robô ainda não solicitou nenhuma reposição.</p>`; return; }
    const dia = (d) => new Date(d).toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" });
    const G = new Map(); F.forEach((x) => { const k = new Date(x.feito_em).toLocaleDateString("sv-SE"); if (!G.has(k)) G.set(k, []); G.get(k).push(x); });
    const hh = (d) => new Date(d).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    $("rpp-hist").innerHTML = [...G.entries()].map(([k, xs], i) => {
      const porT = Object.entries(xs.reduce((a, x) => ((a[x.transp || "—"] = (a[x.transp || "—"] || 0) + 1), a), {})).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${esc(t)} ${n}`).join(" · ");
      return `<details class="rpp-dia"${i === 0 ? " open" : ""}><summary><b>${esc(dia(xs[0].feito_em))}</b> · ${xs.length} reposição(ões) <span class="s">· ${porT}</span></summary>
        <div class="tabela-rolagem"><table class="tabela"><thead><tr><th>Hora</th><th>NF</th><th>Motivo</th><th>Transportadora</th><th>Volumes repostos</th><th>Ticket 360</th><th>Aprovado por</th></tr></thead><tbody>
        ${xs.map((x) => `<tr><td>${hh(x.feito_em)}</td><td><b>${esc(x.nf)}</b></td><td>${esc(x.motivo || "")}${TOTAL(x) ? " · total" : ""}</td><td>${esc(x.transp || "")}</td><td>${repor(x).map((v) => rotVol(x, v) + esc(v)).join(", ")}</td>
          <td>${x.ticket_360 ? `<a href="https://appv2.360multi.com/tickets/${esc(x.ticket_360)}" target="_blank" rel="noopener noreferrer">${esc(x.ticket_360)} ↗</a>` : "—"}</td><td>${esc(String(x.solicitar_por || x.marcado_por || "").split("@")[0])}</td></tr>`).join("")}
        </tbody></table></div></details>`; }).join("");
  }
  function caso(x) {
    const posse = new Set(x.vol_posse || []), rp = repor(x), al = alertas(x);
    const vols = [...(x.volumes || [])].sort((a, b) => ((infoVol(x, a) || {}).nro || 99) - ((infoVol(x, b) || {}).nro || 99)).map((v, i) => `<button type="button" class="rpp-vol${posse.has(v) ? (MOT(x) === "avaria" ? " avariado" : " posse") : ""}" data-rpp-vol="${esc(v)}" data-nf="${esc(x.nf)}" title="${esc((infoVol(x, v) || {}).descricao || "")} · ${posse.has(v) ? "Está com a transportadora (clique para desmarcar)" : "Clique se este volume aparece na foto"}">${rotVol(x, v)}${esc(v)}${posse.has(v) ? (MOT(x) === "avaria" ? " · avariado" : " · em posse") : ""}</button>`).join("")
      || `<span class="s">${x.analisado_em ? "O robô não achou os volumes da NF na janela Criar Ticket." : "Aguardando o robô."}</span>`;
    const fotos = (x.fotos || []).map((f, i) => `<div class="rpp-foto"><button type="button" class="rpp-baixa" data-rpp-baixa="${esc(f)}" data-nome="NF-${esc(x.nf)}-foto-${i + 1}" title="Clique para baixar a foto"><img src="${esc(f)}" alt="Foto anexada pela transportadora" loading="lazy"></button><a class="s" href="${esc(f)}" target="_blank" rel="noopener noreferrer">🔍 ampliar</a></div>`).join("") || `<div class="rpp-semfoto">sem foto</div>`;
    const org = (x.tickets || []).find((t) => t.nota_de);
    // nota de reposição/AT (Brenda 27/11): só o link do pedido original e a NF original (NFO)
    const tksOrg = org ? `${org.url_pedido ? `<a href="${esc(org.url_pedido)}" target="_blank" rel="noopener noreferrer"><b>Pedido original no 360 ↗</b></a>` : `<span class="s">pedido original: link ainda não lido</span>`}${org.nf_original ? ` · <b>NFO ${esc(org.nf_original)}</b>` : ""} · <span class="s">${org.nota_de === "at" ? "nota de AT" : "nota de reposição"} do <a href="https://appv2.360multi.com/tickets/${esc(org.id)}" target="_blank" rel="noopener noreferrer">ticket ${esc(org.id)} ↗</a></span>` : "";
    const tks = org ? tksOrg : (x.tickets || []).map((t) => t.nota_de ? `<span class="chip azul" title="Achado em: ${esc(t.fonte || "")}">🔁 ${t.nota_de === "at" ? "Nota de AT" : "Nota de reposição"} do <a href="https://appv2.360multi.com/tickets/${esc(t.id)}" target="_blank" rel="noopener noreferrer">ticket ${esc(t.id)} ↗</a>${t.nf_original ? " · NF original " + esc(t.nf_original) : ""}${(t.itens || []).length ? " · " + (t.nota_de === "at" ? "peças " : "volumes ") + t.itens.map(esc).join(", ") : ""}${t.fila ? " · " + esc(t.fila) : ""}</span>` : `<span class="chip${/devolu|cancel/i.test(`${t.tipo} ${t.fila}`) ? " verm" : ""}">${esc(t.tipo || "ticket")}${t.fila ? " · " + esc(t.fila) : ""}${t.situacao ? " · " + esc(t.situacao) : ""}</span>`).join(" ") || `<span class="s">${x.venda ? "sem tickets" : ""}</span>`;
    const prr = x.rastreio && x.rastreio.print ? `<div class="rpp-foto rpp-prr"><button type="button" class="rpp-baixa" data-rpp-prr="${esc(x.rastreio.print)}" title="Print do rastreio${x.rastreio.fonte ? " (" + esc(x.rastreio.fonte) + ")" : ""}: clique para ampliar"><img data-rpp-prrimg="${esc(x.rastreio.print)}" alt="Print do rastreio"></button><span class="s">📍 rastreio${x.rastreio.print_em ? " " + hora(x.rastreio.print_em) : ""}</span></div>` : "";
    return `<article class="rpp-caso${SEL.has(x.nf) ? " sel" : ""}">
      <div class="rpp-fotos">${fotos}${prr}</div>
      <div class="rpp-corpo">
        <div class="rpp-cab">${podeSol(x) ? `<label class="rpp-sel" title="Selecionar para solicitar junto com outros"><input type="checkbox" data-rpp-sel="${esc(x.nf)}"${SEL.has(x.nf) ? " checked" : ""}> aprovado</label> ` : ""}<span class="chip rpp-mot ${MOT(x)}">${esc(x.motivo || "Falta de volumes")}</span> <b>NF ${esc(x.nf)}</b> · ${esc(x.transp || "")} · solicitado ${esc(x.solicitado || "—")}${x.na_lista ? "" : ` · <span class="chip">saiu da lista</span>`}
          <span class="s">· SKU ${esc((x.sku || []).join(", ") || "—")} · 360: ${x.venda == null ? "—" : x.venda ? "venda" + (x.status_360 ? " (" + esc(x.status_360) + ")" : "") : "não achado"}${x.data_360 ? " · " + esc(x.data_360) : ""}</span></div>
        ${(([t, m]) => `<div class="rpp-sug ${t}">💡 <b>Sugestão:</b> ${esc(m)}</div>`)(sugestao(x))}
        ${x.foto_ia ? `<div class="rpp-ia">🤖 <b>Leitura da foto (teste):</b> ${(x.foto_ia.volumes_vistos || []).length ? x.foto_ia.volumes_vistos.map((v) => rotVol(x, v) + esc(v)).join(", ") : "nenhum volume da NF identificado"} · confiança ${esc(x.foto_ia.confianca || "—")}${x.foto_ia.vol_nf && x.foto_ia.vol_nf.length ? ` · etiqueta ${esc(x.foto_ia.vol_nf.join(", "))}` : ""}${x.foto_ia.observacao ? `<div class="s">${esc(x.foto_ia.observacao)}</div>` : ""}${(x.foto_ia.volumes_vistos || []).length && !["pendente", "feito"].includes(x.solicitar_status) && JSON.stringify([...(x.vol_posse || [])].sort()) !== JSON.stringify([...x.foto_ia.volumes_vistos].sort()) ? `<div><button type="button" class="btn mini contorno" data-rpp-ia="${esc(x.nf)}">✓ Usar a leitura do Claude (marcar ${x.foto_ia.volumes_vistos.map((v) => rotVol(x, v) + esc(v)).join(", ")} como ${MOT(x) === "avaria" ? "avariado" : "em posse"})</button></div>` : ""}</div>` : ""}
        ${al.map(([t, m]) => `<div class="rpp-al ${t}">${t === "ok" ? "✓" : "⚠"} ${esc(m)}</div>`).join("")}
        ${(x.anotacoes || []).length ? `<div class="rpp-anot"><span class="s">Anotações da transportadora:</span>${x.anotacoes.slice(-3).map((a) => `<div><span class="s">${esc(a.quando)}</span> ${esc(a.texto)}</div>`).join("")}</div>` : ""}
        ${x.rastreio && x.rastreio.situacao ? `<div class="s">Rastreio${x.rastreio.fonte ? " " + esc(x.rastreio.fonte) : ""}: ${esc(x.rastreio.situacao)}${x.rastreio.evento ? " · " + esc(x.rastreio.evento) : ""}${x.rastreio.data ? " · " + esc(x.rastreio.data) : ""}</div>` : ""}
        <div class="rpp-vols"><span class="s">${(x.volumes || []).length ? `A NF tem <b>${x.volumes.length} volume(s)</b> · ${MOT(x) === "avaria" ? "clique no(s) volume(s) <b>avariado(s)</b>:" : "clique no(s) que estão com a transportadora (foto):"}` : "Volumes da NF:"}</span> ${vols}</div>
        <div class="rpp-falta${rp.length ? " ok" : ""}">${rp.length ? `📦 <b>${MOT(x) === "avaria" ? "Volume avariado (repor)" : MOT(x) === "extravio" ? "Volume extraviado (repor)" : "Volume faltante (repor)"}: ${rp.map((v) => rotVol(x, v) + esc(v)).join(", ")}</b>` + (MOT(x) === "extravio" && TOTAL(x) ? ` <button type="button" class="link" data-rpp-total="${esc(x.nf)}">desfazer extravio total</button>` : "") : MOT(x) === "extravio" && (x.volumes || []).length > 1 && !posse.size ? `📦 <b>Volume extraviado: ?</b> <button type="button" class="btn mini contorno" data-rpp-total="${esc(x.nf)}">Extravio total (repor os ${x.volumes.length})</button>` : posse.size && rp.length ? `📦 <b>Volume faltante (repor): ${rp.map((v) => rotVol(x, v) + esc(v)).join(", ")}</b>` : posse.size ? `📦 <b>Nenhum volume faltante</b> <span class="s">(todos marcados como em posse)</span>` : (MOT(x) === "avaria" ? `📦 <b>Volume avariado: ?</b> <span class="s">clique acima no volume que está avariado (foto/anotação): é ele que vamos repor</span>` : `📦 <b>Volume faltante: ?</b> <span class="s">clique acima no volume que aparece na foto (está com a transportadora); o outro é o faltante</span>`)}
          ${x.marcado_por ? `<span class="s">· marcado por ${esc(String(x.marcado_por).split("@")[0])} ${hora(x.marcado_em)}</span>` : ""}</div>
        <div class="rpp-acao">${acao(x, rp)}</div>
        <div class="rpp-tks"><span class="s">${org ? "360:" : "Tickets do pedido no 360:"}</span> ${tks}</div>
      </div></article>`;
  }
  function acao(x, rp) {
    if (x.solicitar_status === "feito") return `<span class="chip verde">✓ Reposição solicitada ${hora(x.feito_em)}${x.ticket_360 ? ` · <a href="https://appv2.360multi.com/tickets/${esc(x.ticket_360)}" target="_blank" rel="noopener noreferrer">ticket ${esc(x.ticket_360)} ↗</a>` : ""}</span>`;
    if (x.solicitar_status === "pendente") return `<span class="chip">⏳ Enviado ao robô ${hora(x.solicitar_em)}${x.solicitar_msg ? " · " + esc(x.solicitar_msg) : ""}</span>`;
    const pode = podeSol(x), dec = decisao(x, rp);
    if (pode && soComentario(x)) return `<button type="button" class="btn amarelo" data-rpp-sol="${esc(x.nf)}">💬 Fazer só o comentário no 360 (o ticket do portal já existe)</button> <span class="s">${esc(x.solicitar_msg || "")}</span>`;
    const volta = APROV(x) || NAOREP(x) || x.solicitar_status === "erro" ? ` <button type="button" class="btn contorno" data-rpp-volta="${esc(x.nf)}" title="Desfaz a decisão e devolve o caso para Para analisar">↩ Voltar para analisar</button>` : "";
    if (NAOREP(x)) return `<span class="chip verm">✗ Não repor${x.marcado_por ? " · " + esc(String(x.marcado_por).split("@")[0]) + " " + hora(x.marcado_em) : ""}</span>${volta}`;
    if (!APROV(x)) return dec;
    if (pode) return `<button type="button" class="btn amarelo" data-rpp-sol="${esc(x.nf)}">📤 Mandar o robô solicitar a reposição de ${rp.map((v) => rotVol(x, v) + esc(v)).join(", ")}</button>${volta}${x.solicitar_status === "erro" ? ` <span class="s">(deu erro: tentar de novo${x.solicitar_msg ? " · " + esc(x.solicitar_msg) : ""})</span>` : ""}`;
    // por que o botão não aparece (Brenda 27/11 não achou o botão)
    const motivo = !x.na_lista ? "saiu da lista do portal" : x.venda === false ? "a NF não foi achada como venda no 360" : x.tem_devolucao ? "o pedido tem ticket de devolução/cancelamento no 360"
      : x.rastreio && x.rastreio.sinistro ? "o rastreio fala em sinistro/roubo" : !rp.length ? (x.foto_ia && (x.foto_ia.volumes_vistos || []).length ? "use a leitura do Claude acima ou clique nos volumes" : "clique nos volumes acima para dizer qual repor") : "";
    return (motivo ? `<span class="s">📤 O botão de solicitar aparece quando der: ${esc(motivo)}.</span>` : "") + volta;
  }
  // volume pelo "VOL. NF 03/05" da etiqueta branca (séries da matriz): nº 3 do cadastro, se o total bate (Brenda 27/11)
  function volsPorEtiqueta(x) {
    const vs = x.volumes || [], out = new Set();
    for (const t of (x.foto_ia && x.foto_ia.vol_nf) || []) { const m = String(t).match(/(\d{1,2})\s*\/\s*(\d{1,2})/); if (!m || +m[2] !== vs.length) continue;
      const v = vs.find((v) => (infoVol(x, v) || {}).nro === +m[1]); if (v) out.add(v); }
    return [...out];
  }
  // a anotação da transportadora cita a peça (ex.: "avaria dos espelhos"): volume cuja descrição no cadastro tem essa palavra (Brenda 27/11)
  const semAc = (t) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
  const PAL_GEN = new Set(["VOLUME", "VOLUMES", "CAIXA", "PRODUTO", "MOVEL", "MOVEIS", "PECAS", "PECA", "PARTE", "KIT", "MODULO", "COM", "PARA"]);
  function volsPorAnotacao(x) {
    const an = semAc((x.anotacoes || []).map((a) => a.texto).join(" ")); if (!an) return [];
    const ws = new Set(an.split(/[^A-Z]+/).filter((w) => w.length >= 5).map((w) => w.slice(0, 6)));
    // sinônimos do cadastro: espelho/vidro aparece como "VID ... LAP" (vidro lapidado)
    const vidro = /ESPELH|VIDR/.test(an);
    return (x.volumes || []).filter((v) => { const d = semAc((infoVol(x, v) || {}).descricao); return d && (d.split(/[^A-Z]+/).some((w) => w.length >= 5 && !PAL_GEN.has(w) && ws.has(w.slice(0, 6))) || (vidro && /\bVID\b|ESPELH|\d+\s*X\s*\d+\s*X\s*\d+\s*MM/.test(d))); });
  }
  // botões de decisão do caso (Brenda 27/11: "um botão nos casos igual no barrar")
  function decisao(x, rp) {
    const iaV = x.foto_ia && (x.foto_ia.volumes_vistos || []).length ? x.foto_ia.volumes_vistos : volsPorEtiqueta(x);
    // avaria: NF com 1 volume só = ele é o avariado; senão a anotação que cita a peça (Brenda 28/11: o ✓ tem que aparecer quando a análise já diz qual é)
    const anV = MOT(x) !== "avaria" ? [] : (x.volumes || []).length === 1 ? [...x.volumes] : volsPorAnotacao(x);
    const anRot = (x.volumes || []).length === 1 ? "único volume da NF" : "pela anotação";
    const ia = !rp.length && iaV.length ? iaV : null, an = !rp.length && !ia && anV.length && (anV.length < (x.volumes || []).length || (x.volumes || []).length === 1) ? anV : null;
    const alvo = rp.length ? rp.map((v) => rotVol(x, v) + esc(v)).join(", ") : "";
    const sim = rp.length ? `<button type="button" class="btn verde" data-rpp-dec="sim" data-nf="${esc(x.nf)}">✓ Repor ${alvo}</button>`
      : ia ? `<button type="button" class="btn verde" data-rpp-dec="ia" data-nf="${esc(x.nf)}" title="Marca os volumes que o Claude leu na foto e aprova">✓ Repor ${(MOT(x) === "avaria" ? ia : (x.volumes || []).filter((v) => !ia.includes(v))).map((v) => rotVol(x, v) + esc(v)).join(", ") || "—"} (pela leitura da foto)</button>`
      : an ? `<button type="button" class="btn verde" data-rpp-dec="an" data-nf="${esc(x.nf)}" title="A anotação da transportadora cita a peça deste volume">✓ Repor ${an.map((v) => rotVol(x, v) + esc(v) + " · " + esc((infoVol(x, v) || {}).descricao || "")).join(", ")} (${anRot})</button>`
      : `<button type="button" class="btn verde" disabled title="Clique primeiro nos volumes acima (ou em Extravio total)">✓ Repor</button>`;
    return `<div class="rpp-dec"><span class="s">Decisão:</span> ${sim} <button type="button" class="btn vermelho-cont" data-rpp-dec="nao" data-nf="${esc(x.nf)}">✗ Não repor</button>${!rp.length && !ia && !an ? ` <span class="s">${MOT(x) === "avaria" ? "clique no volume avariado acima" : "marque o volume acima"} para liberar o ✓</span>` : ""}</div>`;
  }
  async function decidir(nf, d) {
    const x = L.find((y) => y.nf === nf); if (!x || ["pendente", "feito"].includes(x.solicitar_status)) return;
    const email = ((await sb().auth.getUser()).data.user || {}).email || null;
    const novo = { marcado_por: email, marcado_em: new Date().toISOString() };
    if (d === "nao") novo.obs = obsDe(x, { aprov: false, nao: true });
    else { if (d === "ia") novo.vol_posse = (x.foto_ia.volumes_vistos || []).length ? [...x.foto_ia.volumes_vistos] : volsPorEtiqueta(x);
      if (d === "an") novo.vol_posse = (x.volumes || []).length === 1 ? [...x.volumes] : volsPorAnotacao(x); novo.obs = obsDe(REVISAR(x) ? { ...x, obs: null } : x, { aprov: true, nao: false }); }
    const r = await sb().from("repo_pre").update(novo).eq("nf", nf); if (r.error) return toast("Não salvei: " + r.error.message, true);
    Object.assign(x, novo); desenhar();
    toast(d === "nao" ? `NF ${nf}: não repor (card Não repor).` : `NF ${nf} aprovada: está em Pronto para solicitar.`);
  }
  // o robô clicou em Adicionar mas não viu o aviso (27/11): o ticket do portal existe; falta só o comentário no 360
  const soComentario = (x) => x.solicitar_status === "erro" && (x.ticket_portal_ok || /cliquei em Adicionar|Em Andamento/i.test(x.solicitar_msg || ""));
  function podeSol(x) { return !["pendente", "feito"].includes(x.solicitar_status) && (x.na_lista || soComentario(x)) && (APROV(x) || soComentario(x)) && !NAOREP(x) && repor(x).length && x.venda !== false && !x.tem_devolucao && !(x.rastreio && x.rastreio.sinistro); }
  async function voltar(nf) {
    const x = L.find((y) => y.nf === nf); if (!x || ["pendente", "feito"].includes(x.solicitar_status)) return;
    const email = ((await sb().auth.getUser()).data.user || {}).email || null;
    const novo = { vol_posse: [], obs: "REVISAR", solicitar_status: null, solicitar_msg: null, marcado_por: email, marcado_em: new Date().toISOString() };
    const r = await sb().from("repo_pre").update(novo).eq("nf", nf); if (r.error) return toast("Não salvei: " + r.error.message, true);
    Object.assign(x, novo); SEL.delete(nf); desenhar(); toast(`NF ${nf} voltou para Para analisar.`);
  }
  async function solicitarLote() {
    const xs = L.filter((x) => SEL.has(x.nf) && podeSol(x)); if (!xs.length) return toast("Marque os casos que você aprovou.", true);
    if (!confirm(`Solicitar a reposição de ${xs.length} NF(s)?\n\n${xs.map((x) => `NF ${x.nf}: repor ${repor(x).join(", ")}`).join("\n")}\n\nO robô cria o ticket no portal e comenta no ticket de Reposição do 360 de cada uma. Isso cria os tickets de verdade.`)) return;
    const email = ((await sb().auth.getUser()).data.user || {}).email || null, agora = Date.now();
    let ok = 0;
    for (const [i, x] of xs.entries()) {   // solicitar_em em sequência para o robô seguir a ordem
      const novo = { solicitar_status: "pendente", solicitar_por: email, solicitar_em: new Date(agora + i * 1000).toISOString(), solicitar_msg: null };
      const r = await sb().from("repo_pre").update(novo).eq("nf", x.nf); if (r.error) { toast("Não salvei a NF " + x.nf + ": " + r.error.message, true); continue; }
      Object.assign(x, novo); ok++;
    }
    SEL.clear(); desenhar(); if (!ok) return;
    const r2 = await sb().rpc("rodar_robo_repopre_solicitar"); if (r2.error) return toast("Marcados, mas não consegui chamar o robô: " + r2.error.message, true);
    toast(`Robô chamado para ${ok} NF(s): em alguns minutos aparecem como solicitadas.`); setTimeout(carregar, 240000);
  }
  async function solicitar(nf) {
    const x = L.find((y) => y.nf === nf); if (!x) return; const rp = repor(x);
    if (soComentario(x) ? !confirm(`NF ${nf}: o ticket do portal já existe.\n\nO robô só vai postar o comentário interno no ticket de Reposição do 360 com o print do rastreio e da solicitação. Continuar?`) : !confirm(`Solicitar a reposição da NF ${nf}?\n\nO robô vai:\n1) no portal: ⋯ › Abrir Ticket › Volumes ${rp.join(", ")} › Adicionar\n2) no 360 (login do Eduardo): comentário no ticket de Reposição com o print do rastreio e da solicitação${/jadlog/i.test(x.transp || "") ? " + o CNPJ da anotação em maiúsculas" : ""}.\n\nIsso cria o ticket de verdade.`)) return;
    const email = ((await sb().auth.getUser()).data.user || {}).email || null;
    const novo = { solicitar_status: "pendente", solicitar_por: email, solicitar_em: new Date().toISOString(), solicitar_msg: null };
    if (soComentario(x)) novo.ticket_portal_ok = true;   // o ticket do portal já existe: o robô faz só o comentário no 360
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
    const novo = { obs: obsDe(REVISAR(x) ? { ...x, obs: null } : x, { total: !TOTAL(x), aprov: false }), vol_posse: [], marcado_por: email, marcado_em: new Date().toISOString() };
    const r = await sb().from("repo_pre").update(novo).eq("nf", nf); if (r.error) return toast("Não salvei: " + r.error.message, true);
    Object.assign(x, novo); desenhar();
  }
  async function usarIa(nf) {   // marca os volumes que o Claude leu na foto; a solicitação continua sendo um clique da equipe
    const x = L.find((y) => y.nf === nf); if (!x || !x.foto_ia) return;
    const email = ((await sb().auth.getUser()).data.user || {}).email || null;
    const novo = { vol_posse: [...(x.foto_ia.volumes_vistos || [])], obs: null, marcado_por: email, marcado_em: new Date().toISOString() };
    const r = await sb().from("repo_pre").update(novo).eq("nf", nf); if (r.error) return toast("Não salvei: " + r.error.message, true);
    Object.assign(x, novo); desenhar(); toast("Marcado pela leitura do Claude. Confira e clique em ✓ Repor.");
  }
  async function marcar(nf, v) {
    const x = L.find((y) => y.nf === nf); if (!x) return;
    const S = new Set(x.vol_posse || []); S.has(v) ? S.delete(v) : S.add(v);
    const email = ((await sb().auth.getUser()).data.user || {}).email || null;
    const novo = { vol_posse: [...S], marcado_por: email, marcado_em: new Date().toISOString() }; novo.obs = REVISAR(x) ? null : obsDe(x, { aprov: false });   // mudou o volume: decide de novo
    const r = await sb().from("repo_pre").update(novo).eq("nf", nf);
    if (r.error) return toast("Não salvei: " + r.error.message, true);
    Object.assign(x, novo); desenhar();
  }
  $("rp-repopre").addEventListener("click", async (e) => {
    const pr = e.target.closest("[data-rpp-prr]"); if (pr) { const u = await urlPrint(pr.dataset.rppPrr); if (u) window.open(u, "_blank", "noopener"); else toast("Não consegui abrir o print do rastreio.", true); return; }
    const c = e.target.closest("[data-rpp]"); if (c) { card = c.dataset.rpp; desenhar(); return; }
    const v = e.target.closest("[data-rpp-vol]"); if (v) { const x = L.find((y) => y.nf === v.dataset.nf); if (x && ["pendente", "feito"].includes(x.solicitar_status)) return toast("Já foi para a solicitação: não dá para mudar o volume.", true); marcar(v.dataset.nf, v.dataset.rppVol); return; }
    const ia = e.target.closest("[data-rpp-ia]"); if (ia) { usarIa(ia.dataset.rppIa); return; }
    const bx = e.target.closest("[data-rpp-baixa]"); if (bx) { baixarFoto(bx.dataset.rppBaixa, bx.dataset.nome); return; }
    const tt = e.target.closest("[data-rpp-total]"); if (tt) { marcarTotal(tt.dataset.rppTotal); return; }
    const vt = e.target.closest("[data-rpp-volta]"); if (vt) { voltar(vt.dataset.rppVolta); return; }
    const sl = e.target.closest("[data-rpp-sel]"); if (sl) { sl.checked ? SEL.add(sl.dataset.rppSel) : SEL.delete(sl.dataset.rppSel); desenhar(); return; }
    const td = e.target.closest("[data-rpp-todos]"); if (td) { L.filter((x) => sit(x) === "pronto" && podeSol(x)).forEach((x) => (td.checked ? SEL.add(x.nf) : SEL.delete(x.nf))); desenhar(); return; }
    const dc = e.target.closest("[data-rpp-dec]"); if (dc) { decidir(dc.dataset.nf, dc.dataset.rppDec); return; }
    const lt = e.target.closest("[data-rpp-sollote]"); if (lt) { solicitarLote(); return; }
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
      // dia/hora do envio (Brenda 27/11): linha marcadora no próprio cadastro (sem SQL novo)
      const email = ((await sb().auth.getUser()).data.user || {}).email || "";
      await sb().from("vol_cadastro").upsert({ modelo: "__ENVIO__", volume: "planilha", nro: linhas.length, produto: new Date().toISOString(), descricao: (String(email).split("@")[0] + " · " + f.name).slice(0, 200), qtde: aba }).then(() => {}, () => {});
      toast(`Planilha de volumes enviada: ${linhas.length} volumes (aba ${aba}).`); carregar();
    } catch (err) { toast("Não consegui ler a planilha: " + (err.message || err), true); }
  });
  $("rpp-rodar").addEventListener("click", async () => {
    const r = await sb().rpc("rodar_robo_repopre"); if (r.error) return toast("Não consegui chamar o robô: " + r.error.message, true);
    toast("Robô chamado: em 1 a 2 minutos aparece \"analisando\" aqui em cima; quando terminar, os casos atualizam sozinhos.");
    ANDA = "Robô chamado, começando…"; chamadoEm = Date.now(); L = []; card = "marcar"; desenhar();   // zera os quadros; voltam quando o robô terminar (só os Novo)
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
