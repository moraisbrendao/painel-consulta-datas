// Reposições › Falta de volumes: planilha de tickets → robô olha se a transportadora retornou
// (mensagens "Externo" no ticket do Multi360 + anotações no portal, aba Faltas / Inversões). Só leitura.
(function () {
  const $ = (id) => document.getElementById(id);
  if (!$("rp-faltas")) return;
  const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
  const sem0 = (t) => String(t ?? "").trim().replace(/\.0+$/, "").replace(/^0+(?=\d)/, "");
  const fmt = (n) => Number(n || 0).toLocaleString("pt-BR");
  const br = (d) => (d ? new Date(String(d).length <= 10 ? d + "T12:00:00" : String(d).replace(" ", "T")).toLocaleDateString("pt-BR") : "");
  const hora = (d) => (d ? new Date(d).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "");
  const toast = (msg, erro) => { const t = $("toast"); if (!t) return alert(msg); t.textContent = msg; t.classList.toggle("erro", !!erro); t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), erro ? 6000 : 3500); };
  const sb = () => { const c = window.__sb; if (!c) throw new Error("Entre no painel de novo (sessão expirada)."); return c; };
  const plural = (n, um, varios) => `${fmt(n)} ${n === 1 ? um : varios}`;
  // data do portal "22/10/2026" → ISO
  const dPortal = (s) => { const m = String(s || "").match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
  const dias = (d) => (d ? Math.max(0, Math.floor((Date.now() - Date.parse(String(d).length <= 10 ? d + "T12:00:00" : String(d).replace(" ", "T"))) / 864e5)) : null);

  let L = [], info = null, ok = true, card = "todos", carregou = false;
  const sit = (x) => (x.erro && !x.tem_retorno ? "erro" : !x.conferido_em ? "robo" : x.tem_retorno ? "com" : "sem");
  const CARDS = [["com", "Com retorno", "a transportadora respondeu (360 ou portal)", "verde"], ["sem", "Sem retorno", "nada da transportadora: cobrar", "vermelho"],
    ["semchat", "⚠ Fora do chat do portal", "NF sem tratativa no Chat: urgente", "vermelho"], ["robo", "Aguardando o robô", "ainda não conferidos", ""], ["erro", "Erro na leitura", "o robô não conseguiu abrir", "laranja"], ["todos", "Todos", "da última planilha", ""]];
  const foraChat = (x) => !!(x.chat && x.chat.achou === false);
  // tratativa no Chat do portal do transportador (robô busca a NF em ccp › Chat; Brenda 25/11)
  const chipChat = (x) => !x.chat ? "" : x.chat.achou
    ? `<div class="fv-chat ok" title="A NF tem conversa no Chat do portal do transportador">✓ tratativa ok no chat${x.chat.status ? ` · ${esc(x.chat.status)}` : ""}${x.chat.ultima ? ` · últ. ${br(x.chat.ultima)}` : ""}</div>`
    : `<div class="fv-chat urgente" title="O robô buscou a NF no Chat do portal e não achou: olhar com urgência">⚠ Não está no chat do portal · urgente</div>`;
  const transpDe = (x) => ((x.portal || {}).transp || x.transp || "").trim() || "(sem transportadora)";
  const motivoDe = (x) => (x.motivo || x.motivo_ticket || "").trim() || "(sem motivo)";
  const abertoEm = (x) => dPortal((x.portal || {}).solicitado) || x.ticket_criado;   // data da solicitação no portal, senão a criação do ticket
  // dias sem retorno: desde a nossa última mensagem "Externo" no ticket, senão a solicitação no portal / abertura
  const desdeEm = (x) => (x.cobrado_em ? diaBR(x.cobrado_em) : null) || abertoEm(x);
  const diaBR = (ts) => new Date(ts).toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  const prazoVencido = (x) => { const d = dPortal((x.portal || {}).prazo); return d && d < new Date().toISOString().slice(0, 10) ? d : null; };
  const retornos = (x) => [...(x.retorno_360 || []).map((m) => ({ ...m, onde: "360" })), ...(((x.portal || {}).anotacoes) || []).map((a) => ({ ...a, onde: "portal" }))]
    .sort((a, b) => String(b.quando || "").localeCompare(String(a.quando || "")));
  const passa = (x) => {
    if (card === "semchat" ? !foraChat(x) : card !== "todos" && sit(x) !== card) return false;
    const t = $("fv-transp").value; if (t && transpDe(x) !== t) return false;
    const m = $("fv-motivo").value; if (m && motivoDe(x) !== m) return false;
    const q = norm($("fv-busca").value).split(/[\s,;]+/).filter(Boolean);
    return !q.length || q.some((b) => norm(x.nf).includes(b) || norm(x.ticket).includes(b));
  };

  async function carregar() {
    try {
      const out = []; for (let de = 0; ; de += 1000) { const { data, error } = await sb().from("falta_volumes").select("*").eq("na_planilha", true).order("ticket_criado", { ascending: true }).range(de, de + 999); if (error) throw error; out.push(...data); if (data.length < 1000) break; }
      const inf = await sb().from("falta_volumes_info").select("*").limit(1);
      L = out; info = (inf.data || [])[0] || null; ok = true;
    } catch (e) { ok = false; L = []; $("fv-info").textContent = /falta_volumes|does not exist|schema cache/i.test(e.message || "") ? "Para usar esta aba, rode a parte 50 no Supabase." : "Não consegui carregar: " + (e.message || e); }
    carregou = true; desenhar();
  }

  function opcoes(id, vals, todos) { const s = $(id), atual = s.value; s.innerHTML = `<option value="">${todos}</option>` + vals.map((v) => `<option${v === atual ? " selected" : ""}>${esc(v)}</option>`).join(""); }
  function desenhar() {
    if (!ok) return;
    const conf = L.filter((x) => x.conferido_em).map((x) => x.conferido_em).sort().pop();
    $("fv-info").textContent = info ? `Planilha: ${info.arquivo || ""} · ${hora(info.enviado_em)}${info.enviado_por ? " por " + info.enviado_por.split("@")[0] : ""} · ${fmt(L.length)} tickets${conf ? ` · robô olhou por último em ${hora(conf)}` : ""}` : "Nenhuma planilha enviada ainda.";
    const pt = (a, b) => a.localeCompare(b, "pt-BR");
    opcoes("fv-transp", [...new Set(L.map(transpDe))].sort(pt), "Todas"); opcoes("fv-motivo", [...new Set(L.map(motivoDe))].sort(pt), "Todos");
    const n = (k) => (k === "todos" ? L.length : k === "semchat" ? L.filter(foraChat).length : L.filter((x) => sit(x) === k).length);
    $("fv-cards").innerHTML = CARDS.map(([k, rot, sub, cor]) => `<button type="button" class="kpi ${cor}${card === k ? " ativa" : ""}" data-fv="${k}"><span class="kpi-rot">${rot}</span><b class="kpi-num">${fmt(n(k))}</b><small>${sub}</small><i>↗</i></button>`).join("");
    const V = L.filter(passa).sort((a, b) => (dias(desdeEm(b)) ?? -1) - (dias(desdeEm(a)) ?? -1));
    $("fv-titulo").textContent = `${CARDS.find((c) => c[0] === card)[1]} (${fmt(V.length)})`;
    $("fv-linhas").innerHTML = V.slice(0, 500).map(linha).join("") || `<tr><td colspan="8" class="vazio">Nenhum ticket aqui.</td></tr>`;
    document.querySelectorAll("#fv-linhas .fv-conversa").forEach((c) => (c.scrollTop = c.scrollHeight));
    $("fv-mais").textContent = V.length > 500 ? `Mostrando 500 de ${fmt(V.length)}. O Excel traz todos.` : "";
    desenharSem();
  }
  const hojeISO = () => { const d = new Date(), z = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; };
  const promVencida = (x) => x.data_prometida && x.data_prometida < hojeISO();
  const quem = (r) => (r.por ? ` <b class="fv-por">${esc(r.por)}</b>` : "");
  // só a conversa: tira o texto dos botões e do rodapé do 360 que entrou junto na última mensagem
  const limpaTexto = (t) => String(t || "").replace(/\s*Executar a[cç][aã]o no ticket[\s\S]*$/i, "").replace(/\s*(Coment[aá]rio Interno\s+Macros|Admin\s+\d{4}\s*©|©\s*Multim[oó]veis|Desenvolvido pela Equipe)[\s\S]*$/i, "").trim();
  // o que fazer por motivo (regras da Brenda, 23/11) — aviso piscando ao lado do motivo
  const NAO_TEM = /n[aã]o\s+(tem|temos|possui|possu[ií]mos|consta|constam|localiz|encontr|est[aá]\s+em\s+(nossa\s+)?posse|h[aá]\s+volume)|sem\s+(o\s+)?volume|volume\s+n[aã]o\s+(est[aá]|consta|foi\s+localizado)/i;
  function avisoMotivo(x, R) {
    const m = norm(motivoDe(x)), txt = R.map((r) => limpaTexto(r.texto)).join(" ");
    if (/INVERS/.test(m)) return `<div class="fv-aviso" title="Regra da Inversão">⚠ Deixar a transportadora fazer a troca. Se ela não fizer, seguir com o envio.</div>`;
    if (/FALTA/.test(m)) return NAO_TEM.test(txt)
      ? `<div class="fv-aviso forte" title="A transportadora respondeu que não tem o volume">⚠ Transportadora diz que não tem o volume: se o comprovante de entrega não tem ressalva, seguir com o envio por nossa conta.</div>`
      : `<div class="fv-aviso" title="Regra da Falta de volumes">⚠ Se a transportadora disser que não tem o volume em posse e o comprovante de entrega não tiver ressalva, seguir com o envio por nossa conta.</div>`;
    return "";
  }
  function linha(x) {
    const p = x.portal || {}, R = retornos(x), d = dias(desdeEm(x)), pv = prazoVencido(x);
    // todas as mensagens da transportadora, da 1ª resposta até a última (rola dentro da caixa)
    const ret = !x.conferido_em ? `<span class="s">o robô ainda não olhou</span>` : R.length
      ? `<div class="fv-conversa">${R.slice().reverse().map((r) => `<div class="fv-ret"><span class="chip ${r.onde === "360" ? "azul" : "lilas"}">${r.onde === "360" ? "360 · externo" : "portal · anotação"}</span>${quem(r)}${r.quando ? ` <span class="s">${hora(r.quando)}</span>` : ""}<div>${esc(limpaTexto(r.texto))}</div></div>`).join("")}</div>${R.length > 1 ? `<div class="s">${fmt(R.length)} mensagens · a mais nova embaixo</div>` : ""}`
      : `<span class="txt-vermelho">Sem retorno da transportadora</span>${p.achou === false ? `<div class="s">NF não está na aba Faltas / Inversões do portal</div>` : ""}`;
    const ed = x.editado_em ? `<div class="s">gravado${x.editado_por ? " por " + esc(String(x.editado_por).split("@")[0]) : ""} em ${hora(x.editado_em)}</div>` : "";
    return `<tr><td><b>${esc(x.nf || "—")}</b><div><a href="https://appv2.360multi.com/tickets/${encodeURIComponent(x.ticket)}" target="_blank" rel="noopener noreferrer">#${esc(x.ticket)}</a></div>${x.fila ? `<div class="s">${esc(x.fila)}</div>` : ""}${chipChat(x)}</td>
      <td>${esc(transpDe(x))}</td><td>${esc(motivoDe(x))}${avisoMotivo(x, R)}</td>
      <td class="num">${d ?? "—"}${desdeEm(x) ? `<div class="s">desde ${br(desdeEm(x))}</div>` : ""}</td>
      <td>${p.prazo ? `${esc(p.prazo)}${pv ? ` <span class="chip vermelho">vencido</span>` : ""}` : "—"}</td>
      <td class="fv-prom"><input type="date" class="fv-data" data-tk="${esc(x.ticket)}" value="${esc(x.data_prometida || "")}" title="Data que a transportadora informou para finalizar">${promVencida(x) ? ` <span class="chip vermelho">promessa vencida</span>` : ""}</td>
      <td class="fv-col-ret">${ret}${x.erro && !x.tem_retorno ? `<div class="s txt-vermelho">⚠ ${esc(x.erro)}</div>` : ""}</td>
      <td class="fv-anot"><textarea class="fv-nota" data-tk="${esc(x.ticket)}" rows="3" placeholder="Anotações da Logística">${esc(x.anotacao || "")}</textarea>${ed}<a href="#" class="s fv-hist" data-tk="${esc(x.ticket)}">histórico</a></td></tr>`;
  }
  async function gravar(tk, campos) {
    try {
      const { data, error } = await sb().from("falta_volumes").update(campos).eq("ticket", tk).select("*");
      if (error) throw error;
      const i = L.findIndex((x) => x.ticket === tk); if (i >= 0 && data && data[0]) L[i] = data[0];
      toast("Gravado."); desenhar();
    } catch (e) { toast(/data_prometida|anotacao|column/i.test(e.message || "") ? "Rode a parte 53 no Supabase para gravar anotações e datas." : "Não gravou: " + (e.message || e), true); }
  }
  $("fv-linhas").addEventListener("change", (e) => {
    const t = e.target;
    if (t.classList.contains("fv-data")) gravar(t.dataset.tk, { data_prometida: t.value || null });
    if (t.classList.contains("fv-nota")) gravar(t.dataset.tk, { anotacao: t.value.trim() || null });
  });
  $("fv-linhas").addEventListener("click", async (e) => {
    const a = e.target.closest(".fv-hist"); if (!a) return; e.preventDefault();
    try {
      const { data, error } = await sb().from("falta_volumes_hist").select("*").eq("ticket", a.dataset.tk).order("quando", { ascending: false }).limit(30);
      if (error) throw error;
      const ROT = { data_prometida: "Data prometida", anotacao: "Anotação" };
      alert(data.length ? data.map((h) => `${hora(h.quando)}${h.por ? " · " + h.por.split("@")[0] : ""} · ${ROT[h.campo] || h.campo}: ${h.campo === "data_prometida" ? br(h.antes) || "(vazia)" : h.antes || "(vazia)"} → ${h.campo === "data_prometida" ? br(h.depois) || "(vazia)" : h.depois || "(vazia)"}`).join("\n") : "Ainda sem alterações gravadas nesse ticket.");
    } catch (err) { toast(/falta_volumes_hist|does not exist|schema cache/i.test(err.message || "") ? "Rode a parte 53 no Supabase." : err.message, true); }
  });

  // Sem retorno: quadrinhos por transportadora, separados por motivo, com dias parados, mensagem e Excel
  function grupos() {
    const m = new Map(); L.filter((x) => sit(x) === "sem").filter((x) => (!$("fv-transp").value || transpDe(x) === $("fv-transp").value) && (!$("fv-motivo").value || motivoDe(x) === $("fv-motivo").value))
      .forEach((x) => { const t = (window.__nomeTranspBase ? window.__nomeTranspBase(transpDe(x)) : "") || transpDe(x); m.set(t, (m.get(t) || []).concat(x)); });   // uma por transportadora, só o nome (igual ao Barrar)
    return [...m.entries()].map(([t, xs]) => [t, xs.sort((a, b) => (dias(desdeEm(b)) ?? -1) - (dias(desdeEm(a)) ?? -1))]).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], "pt-BR"));
  }
  const porMotivo = (xs) => { const m = new Map(); xs.forEach((x) => m.set(motivoDe(x), (m.get(motivoDe(x)) || []).concat(x))); return [...m.entries()].sort((a, b) => b[1].length - a[1].length); };
  function mensagem(t, xs) {   // texto limpo (Brenda 23/11)
    const mot = porMotivo(xs).map(([m]) => m).join(" e ");
    return `Olá, ${t}! Estamos com ${plural(xs.length, "caso", "casos")} de ${mot}. Precisamos do retorno de vocês para seguir com as tratativas. Conseguem verificar?\n\n`
      + xs.map((x) => { const d = dias(desdeEm(x)), pv = prazoVencido(x); return `• NF ${x.nf || "—"} · ${motivoDe(x)}${d === null ? "" : d === 0 ? " · hoje" : ` · há ${plural(d, "dia", "dias")}`}${pv ? ` · prazo limite ${br(pv)} vencido` : ""}`; }).join("\n");
  }
  const CAB = ["Transportadora", "Nota", "Ticket", "Motivo", "Fila", "Aberto em", "Nossa última cobrança (360 externo)", "Dias sem retorno", "Prazo limite (portal)", "Prazo vencido", "Data prometida pela transportadora", "Promessa vencida", "Anotações", "Tratativa no chat do portal", "Com retorno", "Último retorno em", "Onde", "Quem retornou", "Texto do último retorno", "Todos os retornos"];
  const linhasXls = (xs) => xs.map((x) => { const R = retornos(x), u = R[0] || {}, pv = prazoVencido(x);
    return [transpDe(x), x.nf || "", x.ticket, motivoDe(x), x.fila || "", br(abertoEm(x)), x.cobrado_em ? hora(x.cobrado_em) : "", dias(desdeEm(x)) ?? "", (x.portal || {}).prazo || "", pv ? "Sim" : "", br(x.data_prometida), promVencida(x) ? "Sim" : "", x.anotacao || "", !x.chat ? "" : x.chat.achou ? "OK" + (x.chat.status ? " · " + x.chat.status : "") : "NÃO ESTÁ NO CHAT (urgente)", !x.conferido_em ? "Não conferido" : x.tem_retorno ? "Sim" : "Não",
      u.quando ? hora(u.quando) : "", u.onde === "360" ? "Ticket 360 (externo)" : u.onde === "portal" ? "Portal (anotação)" : "", u.por || "", limpaTexto(u.texto), R.slice().reverse().map((r) => `${r.quando ? hora(r.quando) + " " : ""}[${r.onde}${r.por ? " · " + r.por : ""}] ${limpaTexto(r.texto)}`).join(" | ")]; });
  function baixar(G, nome) {
    const wb = XLSX.utils.book_new(), usados = new Set();
    if (G.length > 1) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([CAB].concat(G.flatMap(([, xs]) => linhasXls(xs)))), "Todas");
    G.forEach(([t, xs]) => { let a = t.replace(/[\\/?*[\]:]/g, " ").slice(0, 28).trim() || "Transp"; while (usados.has(a)) a += "_"; usados.add(a); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([CAB].concat(linhasXls(xs))), a); });
    XLSX.writeFile(wb, `falta_volumes_${nome}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }
  function desenharSem() {
    const box = $("fv-sem"); box.hidden = card !== "sem"; if (box.hidden) return;
    const G = grupos(); box._G = G;
    box.innerHTML = `<div class="cartao-topo"><div><h2>Sem retorno por transportadora</h2><p class="sub">Nenhuma mensagem "Externo" no ticket do 360 e nenhuma anotação no portal (Faltas / Inversões). Dias = desde a nossa última mensagem "Externo" no ticket (a cobrança), senão desde a solicitação no portal ou a abertura do ticket. Cada quadrinho tem a mensagem pronta para o WhatsApp (dá para editar) e o Excel daquela transportadora.</p></div>
      ${G.length ? `<button type="button" class="btn contorno fv-todas">↓ Excel de todas (uma aba por transportadora)</button>` : ""}</div>
      <div class="br-et-grade">${G.map(([t, xs], i) => { const mx = Math.max(...xs.map((x) => dias(desdeEm(x)) ?? 0)), venc = xs.filter(prazoVencido).length;
        return `<div class="br-et-q"><div class="br-et-cab"><b>${esc(t)}</b><span class="chip ${mx >= 10 ? "vermelho" : mx >= 5 ? "ambar" : ""}">${plural(xs.length, "caso", "casos")} · mais antigo há ${plural(mx, "dia", "dias")}</span>${venc ? `<span class="chip vermelho">${fmt(venc)} com prazo vencido</span>` : ""}</div>
          <div class="br-et-lista"><table><thead><tr><th>Nota</th><th class="num">Dias</th><th>Motivo</th></tr></thead><tbody>${xs.map((x) => `<tr><td>${esc(x.nf || "—")} <a href="https://appv2.360multi.com/tickets/${encodeURIComponent(x.ticket)}" target="_blank" rel="noopener noreferrer">#${esc(x.ticket)}</a></td><td class="num">${dias(desdeEm(x)) ?? "—"}</td><td class="s">${esc(motivoDe(x))}${prazoVencido(x) ? ` · <span class="txt-vermelho">prazo vencido</span>` : ""}</td></tr>`).join("")}</tbody></table></div>
          <textarea class="br-et-msg" rows="6" data-i="${i}">${esc(mensagem(t, xs))}</textarea>
          <div class="br-et-bts"><button type="button" class="btn amarelo mini fv-copiar" data-i="${i}">Copiar mensagem</button><a class="btn contorno mini fv-wa" data-i="${i}" href="#" title="Abre o WhatsApp com a mensagem (você escolhe o contato)">WhatsApp ↗</a><button type="button" class="btn contorno mini fv-xls" data-i="${i}">↓ Excel</button></div></div>`; }).join("") || `<p class="vazio">Nenhum caso sem retorno.</p>`}</div>`;
  }

  // eventos
  $("rp-faltas").addEventListener("click", async (e) => {
    const k = e.target.closest("[data-fv]"); if (k) { card = k.dataset.fv === card ? "todos" : k.dataset.fv; desenhar(); return; }
    const box = $("fv-sem"), G = box._G || [], i = Number((e.target.closest("[data-i]") || {}).dataset?.i);
    if (e.target.closest(".fv-todas")) return baixar(G, "sem_retorno");
    if (e.target.closest(".fv-xls")) return baixar([G[i]], G[i][0].normalize("NFD").replace(/[^\w]+/g, "_").slice(0, 30));
    const txt = () => (box.querySelector(`.br-et-msg[data-i="${i}"]`) || {}).value || "";
    if (e.target.closest(".fv-copiar")) { try { await navigator.clipboard.writeText(txt()); toast("Mensagem copiada. Cole no WhatsApp da transportadora."); } catch { const t = box.querySelector(`.br-et-msg[data-i="${i}"]`); t.select(); document.execCommand("copy"); toast("Mensagem copiada."); } return; }
    if (e.target.closest(".fv-wa")) { e.preventDefault(); window.open("https://wa.me/?text=" + encodeURIComponent(txt()), "_blank", "noopener"); }
  });
  ["fv-transp", "fv-motivo"].forEach((id) => $(id).addEventListener("change", desenhar));
  $("fv-busca").addEventListener("input", () => { clearTimeout(desenhar._t); desenhar._t = setTimeout(desenhar, 250); });
  $("fv-limpar").addEventListener("click", () => { $("fv-busca").value = ""; $("fv-transp").value = ""; $("fv-motivo").value = ""; card = "todos"; desenhar(); });
  $("fv-excel").addEventListener("click", () => { const V = L.filter(passa); if (!V.length) return toast("Nada para exportar.", true);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([CAB].concat(linhasXls(V))), "Falta de volumes"); XLSX.writeFile(wb, `falta_volumes_${new Date().toISOString().slice(0, 10)}.xlsx`); });
  // botão: amarelo enquanto o robô confere, verde quando terminou (lê o andamento que o robô grava em robo_estado)
  let pedidoEm = null, estado = null;
  function pintarBotao() {
    const b = $("fv-conferir"), v = estado || {}, fimOk = v.fim && (!pedidoEm || v.fim > pedidoEm);
    const rodando = v.rodando || (pedidoEm && !fimOk);
    b.classList.remove("amarelo", "verde", "contorno");
    if (rodando) { b.classList.add("amarelo"); b.textContent = v.rodando ? "⏳ Conferindo retornos…" : "⏳ Robô chamado, já começa…"; b.disabled = true; }
    else if (v.fim && Date.now() - Date.parse(v.fim) < 6 * 3600e3) { b.classList.add("verde"); b.textContent = `✓ Conferido às ${new Date(v.fim).toLocaleTimeString("pt-BR", { timeStyle: "short" })} · conferir de novo`; b.disabled = false; b.title = v.resumo || ""; }
    else { b.classList.add("contorno"); b.textContent = "Conferir retornos agora"; b.disabled = false; }
  }
  async function lerEstado() {
    try { const { data } = await sb().from("robo_estado").select("valor").eq("nome", "andamento:faltas").limit(1); const antes = estado; estado = (data && data[0] && data[0].valor) || null;
      if (antes && antes.rodando && estado && !estado.rodando) { pedidoEm = null; carregar(); toast("Robô terminou de conferir os retornos."); }
      if (estado && estado.fim && pedidoEm && estado.fim > pedidoEm) pedidoEm = null;
    } catch (_) {}
    pintarBotao();
  }
  $("fv-conferir").addEventListener("click", async () => {
    try { const { error } = await sb().rpc("rodar_robo_faltas"); if (error) throw error; pedidoEm = new Date().toISOString(); pintarBotao(); toast("Robô chamado: ele vai abrir cada ticket no 360 e a NF no portal (leva uns minutos). A tela atualiza sozinha."); }
    catch (e) { toast(/rodar_robo_faltas|function/i.test(e.message || "") ? "Rode a parte 50 no Supabase." : e.message || String(e), true); }
  });
  setInterval(() => { if (!$("rp-faltas").hidden && !document.hidden) lerEstado(); }, 10000);
  $("fv-arq").addEventListener("change", async (e) => {
    const arq = e.target.files[0]; e.target.value = ""; if (!arq) return;
    try {
      const wb = XLSX.read(await arq.arrayBuffer(), { cellDates: true });
      // procura a aba que tem a coluna do ticket
      let rows = null; for (const a of wb.SheetNames) { const r = XLSX.utils.sheet_to_json(wb.Sheets[a], { header: 1, defval: "", raw: false, dateNF: "yyyy-mm-dd hh:mm:ss" }); const hi = r.slice(0, 5).findIndex((l) => l.some((h) => /TICKET/.test(norm(h)))); if (hi >= 0) { rows = r.slice(hi); break; } }
      if (!rows) throw new Error('A planilha precisa de uma coluna com o número do ticket (ex.: "ID do Ticket").');
      const cab = rows[0].map(norm), c = (...res) => { for (const re of res) { const i = cab.findIndex((h) => re.test(h)); if (i >= 0) return i; } return -1; };
      const iTk = c(/^ID DO TICKET$/, /^ID TICKET$/, /^TICKET$/, /TICKET/), iNf = c(/^NOTA FISCAL$/, /^NOTA TICKET$/, /^NF$/, /^NOTA$/), iNum = c(/^NUMERO DA NOTA$/), iSer = c(/^SERIE DA NOTA$/, /^SERIE$/),
        iRd = c(/REDESPACHO/), iTt = c(/^TRANSPORTADORA DO TICKET$/), iTp = c(/^TRANSPORTADOR PROMOB$/, /^TRANSPORTADORA$/, /TRANSPORTADOR/), iMo = c(/^MOTIVO$/, /^MOTIVO DO TICKET$/, /MOTIVO/), iFi = c(/^FILA ATUAL$/, /^FILA$/, /FILA/), iCr = c(/^CRIACAO DO TICKET$/, /DATA DE CRIACAO/, /CRIACAO/, /ABERTURA/);
      const mp = new Map();
      rows.slice(1).forEach((l) => {
        const tk = String(l[iTk] || "").trim().replace(/\.0+$/, ""); if (!/^\d+$/.test(tk)) return;
        let nf = iNum >= 0 && l[iNum] !== "" ? `${sem0(l[iNum])}-${sem0(l[iSer])}` : iNf >= 0 ? String(l[iNf] || "").trim().split("-").map(sem0).join("-") : "";
        if (!/^\d+-\d+$/.test(nf)) nf = "";
        const vale = (v) => v && !/^SEM\b|^-$/i.test(v);
        const rd = iRd >= 0 ? String(l[iRd] || "").trim() : "", tt = iTt >= 0 ? String(l[iTt] || "").trim() : "", tp = iTp >= 0 && iTp !== iRd && iTp !== iTt ? String(l[iTp] || "").trim() : "";
        // redespacho, se tiver; senão a transportadora do ticket; senão a do Promob
        mp.set(tk, { ticket: tk, nf, transp: vale(rd) ? rd : vale(tt) ? tt : tp, motivo: iMo >= 0 ? String(l[iMo] || "").trim() : "", fila: iFi >= 0 ? String(l[iFi] || "").trim() : "", ticket_criado: iCr >= 0 ? String(l[iCr] || "").slice(0, 19) : "" });
      });
      if (!mp.size) throw new Error("Nenhum ticket válido na planilha.");
      const semNf = [...mp.values()].filter((x) => !x.nf).length;
      const { data, error } = await sb().rpc("importar_faltas", { linhas: [...mp.values()], arquivo: arq.name });
      if (error) throw error;
      toast(`${fmt(data)} tickets na lista${semNf ? ` (${fmt(semNf)} sem NF: só o 360 será olhado)` : ""}. Clique em "Conferir retornos agora".`); await carregar();
    } catch (err) { toast(/importar_faltas|function/i.test(err.message || "") ? "Rode a parte 50 no Supabase antes de enviar a planilha." : err.message || String(err), true); }
  });
  // carrega quando a aba aparece; enquanto aberta, relê a cada 30 s (o robô vai preenchendo)
  new MutationObserver(() => { if (!$("rp-faltas").hidden) { carregar(); lerEstado(); } }).observe($("rp-faltas"), { attributes: true, attributeFilter: ["hidden"] });
  setInterval(() => { if (!$("rp-faltas").hidden && $("rp-faltas").offsetParent && !document.hidden && !document.activeElement.closest("#rp-faltas textarea")) carregar(); }, 30000);
  if (!$("rp-faltas").hidden) { carregar(); lerEstado(); }
})();
