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
    ["robo", "Aguardando o robô", "ainda não conferidos", ""], ["erro", "Erro na leitura", "o robô não conseguiu abrir", "laranja"], ["todos", "Todos", "da última planilha", ""]];
  const transpDe = (x) => ((x.portal || {}).transp || x.transp || "").trim() || "(sem transportadora)";
  const motivoDe = (x) => (x.motivo || x.motivo_ticket || "").trim() || "(sem motivo)";
  const abertoEm = (x) => dPortal((x.portal || {}).solicitado) || x.ticket_criado;   // data da solicitação no portal, senão a criação do ticket
  const prazoVencido = (x) => { const d = dPortal((x.portal || {}).prazo); return d && d < new Date().toISOString().slice(0, 10) ? d : null; };
  const retornos = (x) => [...(x.retorno_360 || []).map((m) => ({ ...m, onde: "360" })), ...(((x.portal || {}).anotacoes) || []).map((a) => ({ ...a, onde: "portal" }))]
    .sort((a, b) => String(b.quando || "").localeCompare(String(a.quando || "")));
  const passa = (x) => {
    if (card !== "todos" && sit(x) !== card) return false;
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
    const n = (k) => (k === "todos" ? L.length : L.filter((x) => sit(x) === k).length);
    $("fv-cards").innerHTML = CARDS.map(([k, rot, sub, cor]) => `<button type="button" class="kpi ${cor}${card === k ? " ativa" : ""}" data-fv="${k}"><span class="kpi-rot">${rot}</span><b class="kpi-num">${fmt(n(k))}</b><small>${sub}</small><i>↗</i></button>`).join("");
    const V = L.filter(passa).sort((a, b) => (dias(abertoEm(b)) ?? -1) - (dias(abertoEm(a)) ?? -1));
    $("fv-titulo").textContent = `${CARDS.find((c) => c[0] === card)[1]} (${fmt(V.length)})`;
    $("fv-linhas").innerHTML = V.slice(0, 500).map(linha).join("") || `<tr><td colspan="6" class="vazio">Nenhum ticket aqui.</td></tr>`;
    $("fv-mais").textContent = V.length > 500 ? `Mostrando 500 de ${fmt(V.length)}. O Excel traz todos.` : "";
    desenharSem();
  }
  function linha(x) {
    const p = x.portal || {}, R = retornos(x), d = dias(abertoEm(x)), pv = prazoVencido(x);
    const ret = !x.conferido_em ? `<span class="s">o robô ainda não olhou</span>` : R.length
      ? R.slice(0, 3).map((r) => `<div class="fv-ret"><span class="chip ${r.onde === "360" ? "azul" : "lilas"}">${r.onde === "360" ? "360 · externo" : "portal · anotação"}</span>${r.quando ? ` <span class="s">${hora(r.quando)}</span>` : ""}<div>${esc(r.texto)}</div></div>`).join("") + (R.length > 3 ? `<div class="s">+${R.length - 3} retorno(s) mais antigo(s) no Excel</div>` : "")
      : `<span class="txt-vermelho">Sem retorno da transportadora</span>${p.achou === false ? `<div class="s">NF não está na aba Faltas / Inversões do portal</div>` : ""}`;
    return `<tr><td><b>${esc(x.nf || "—")}</b><div><a href="https://appv2.360multi.com/tickets/${encodeURIComponent(x.ticket)}" target="_blank" rel="noopener noreferrer">#${esc(x.ticket)}</a></div>${x.fila ? `<div class="s">${esc(x.fila)}</div>` : ""}</td>
      <td>${esc(transpDe(x))}</td><td>${esc(motivoDe(x))}</td>
      <td class="num">${d ?? "—"}${abertoEm(x) ? `<div class="s">desde ${br(abertoEm(x))}</div>` : ""}</td>
      <td>${p.prazo ? `${esc(p.prazo)}${pv ? ` <span class="chip vermelho">vencido</span>` : ""}` : "—"}</td>
      <td class="fv-col-ret">${ret}${x.erro && !x.tem_retorno ? `<div class="s txt-vermelho">⚠ ${esc(x.erro)}</div>` : ""}</td></tr>`;
  }

  // Sem retorno: quadrinhos por transportadora, separados por motivo, com dias parados, mensagem e Excel
  function grupos() {
    const m = new Map(); L.filter((x) => sit(x) === "sem").filter((x) => (!$("fv-transp").value || transpDe(x) === $("fv-transp").value) && (!$("fv-motivo").value || motivoDe(x) === $("fv-motivo").value))
      .forEach((x) => { const t = transpDe(x); m.set(t, (m.get(t) || []).concat(x)); });
    return [...m.entries()].map(([t, xs]) => [t, xs.sort((a, b) => (dias(abertoEm(b)) ?? -1) - (dias(abertoEm(a)) ?? -1))]).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], "pt-BR"));
  }
  const porMotivo = (xs) => { const m = new Map(); xs.forEach((x) => m.set(motivoDe(x), (m.get(motivoDe(x)) || []).concat(x))); return [...m.entries()].sort((a, b) => b[1].length - a[1].length); };
  function mensagem(t, xs) {
    const pd = new Map(); xs.forEach((x) => { const d = dias(abertoEm(x)); pd.set(d, (pd.get(d) || 0) + 1); });
    const partes = [...pd.entries()].sort((a, b) => (b[0] ?? -1) - (a[0] ?? -1)).map(([d, n]) => d === null ? `${n} sem data` : `${n} há ${plural(d, "dia", "dias")}`);
    const fim = partes.length > 1 ? partes.slice(0, -1).join(", ") + " e " + partes[partes.length - 1] : partes[0];
    const mot = porMotivo(xs).map(([m, ys]) => `${m} (${ys.length})`).join(", ");
    const venc = xs.filter(prazoVencido).length;
    return `Olá, ${t}! Estamos com ${plural(xs.length, "caso", "casos")} de ${mot} parados sem retorno de vocês: ${fim}.${venc ? ` ${venc === 1 ? "Um deles já passou" : venc + " já passaram"} do prazo limite no portal.` : ""} Precisamos do retorno de vocês para seguir com as tratativas. Conseguem verificar?\n\n`
      + xs.map((x) => { const d = dias(abertoEm(x)), pv = prazoVencido(x); return `• NF ${x.nf || "—"} · ${motivoDe(x)}${d !== null ? ` · há ${plural(d, "dia", "dias")}` : ""}${pv ? ` · prazo limite ${br(pv)} vencido` : ""}`; }).join("\n");
  }
  const CAB = ["Transportadora", "Nota", "Ticket", "Motivo", "Fila", "Aberto em", "Dias parado", "Prazo limite (portal)", "Prazo vencido", "Com retorno", "Último retorno em", "Onde", "Texto do último retorno", "Todos os retornos"];
  const linhasXls = (xs) => xs.map((x) => { const R = retornos(x), u = R[0] || {}, pv = prazoVencido(x);
    return [transpDe(x), x.nf || "", x.ticket, motivoDe(x), x.fila || "", br(abertoEm(x)), dias(abertoEm(x)) ?? "", (x.portal || {}).prazo || "", pv ? "Sim" : "", !x.conferido_em ? "Não conferido" : x.tem_retorno ? "Sim" : "Não",
      u.quando ? hora(u.quando) : "", u.onde === "360" ? "Ticket 360 (externo)" : u.onde === "portal" ? "Portal (anotação)" : "", u.texto || "", R.map((r) => `${r.quando ? hora(r.quando) + " " : ""}[${r.onde}] ${r.texto}`).join(" | ")]; });
  function baixar(G, nome) {
    const wb = XLSX.utils.book_new(), usados = new Set();
    if (G.length > 1) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([CAB].concat(G.flatMap(([, xs]) => linhasXls(xs)))), "Todas");
    G.forEach(([t, xs]) => { let a = t.replace(/[\\/?*[\]:]/g, " ").slice(0, 28).trim() || "Transp"; while (usados.has(a)) a += "_"; usados.add(a); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([CAB].concat(linhasXls(xs))), a); });
    XLSX.writeFile(wb, `falta_volumes_${nome}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }
  function desenharSem() {
    const box = $("fv-sem"); box.hidden = card !== "sem"; if (box.hidden) return;
    const G = grupos(); box._G = G;
    box.innerHTML = `<div class="cartao-topo"><div><h2>Sem retorno por transportadora</h2><p class="sub">Nenhuma mensagem "Externo" no ticket do 360 e nenhuma anotação no portal (Faltas / Inversões). Dias parado = desde a solicitação no portal (ou a abertura do ticket). Cada quadrinho tem a mensagem pronta para o WhatsApp (dá para editar) e o Excel daquela transportadora.</p></div>
      ${G.length ? `<button type="button" class="btn contorno fv-todas">↓ Excel de todas (uma aba por transportadora)</button>` : ""}</div>
      <div class="br-et-grade">${G.map(([t, xs], i) => { const mx = Math.max(...xs.map((x) => dias(abertoEm(x)) ?? 0)), venc = xs.filter(prazoVencido).length;
        return `<div class="br-et-q"><div class="br-et-cab"><b>${esc(t)}</b><span class="chip ${mx >= 10 ? "vermelho" : mx >= 5 ? "ambar" : ""}">${plural(xs.length, "caso", "casos")} · mais antigo há ${plural(mx, "dia", "dias")}</span>${venc ? `<span class="chip vermelho">${fmt(venc)} com prazo vencido</span>` : ""}</div>
          <div class="br-et-lista">${porMotivo(xs).map(([m, ys]) => `<div class="fv-mot">${esc(m)} · ${fmt(ys.length)}</div><table><tbody>${ys.map((x) => `<tr><td>${esc(x.nf || "—")} <a href="https://appv2.360multi.com/tickets/${encodeURIComponent(x.ticket)}" target="_blank" rel="noopener noreferrer">#${esc(x.ticket)}</a></td><td class="num">${dias(abertoEm(x)) ?? "—"} dias</td><td class="s">${prazoVencido(x) ? "prazo vencido" : (x.portal || {}).prazo ? "prazo " + esc(x.portal.prazo) : ""}</td></tr>`).join("")}</tbody></table>`).join("")}</div>
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
