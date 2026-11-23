// Análise de canais › Gargalos por transportadora: onde (região, cidade) e em que etapa (micro status) a transportadora mais atrasa.
// Só leitura: usa a mesma base que o painel já carregou (pedidos em aberto).
(function () {
  const $ = (id) => document.getElementById(id);
  if (!$("gx-box")) return;
  const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
  const titulo = (t) => String(t || "").toLowerCase().replace(/(^|[\s/(-])([a-zà-ú])/g, (m, a, b) => a + b.toUpperCase()).replace(/ (D[aeo]s?|E) /g, (m) => m.toLowerCase());
  const fmt = (n) => Number(n || 0).toLocaleString("pt-BR");
  const pct = (a, b) => (b ? Math.round((100 * a) / b) + "%" : "—");
  const nomeT = (t) => (window.__nomeTranspBase ? window.__nomeTranspBase(t || "") : t) || "(sem transportadora)";
  const hoje = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });

  const CAPITAL = { AC: "RIO BRANCO", AL: "MACEIO", AP: "MACAPA", AM: "MANAUS", BA: "SALVADOR", CE: "FORTALEZA", DF: "BRASILIA", ES: "VITORIA", GO: "GOIANIA", MA: "SAO LUIS", MT: "CUIABA", MS: "CAMPO GRANDE", MG: "BELO HORIZONTE", PA: "BELEM", PB: "JOAO PESSOA", PR: "CURITIBA", PE: "RECIFE", PI: "TERESINA", RJ: "RIO DE JANEIRO", RN: "NATAL", RS: "PORTO ALEGRE", RO: "PORTO VELHO", RR: "BOA VISTA", SC: "FLORIANOPOLIS", SP: "SAO PAULO", SE: "ARACAJU", TO: "PALMAS" };
  const ZONA_SP = { "01": "Centro", "02": "Zona Norte", "03": "Zona Leste", "04": "Zona Sul", "05": "Zona Oeste", "08": "Zona Leste (extremo)" };
  const cepDe = (p) => String((p.extra && p.extra.cep) || p.cep || "").replace(/\D/g, "");
  function regiao(p) {
    const uf = norm(p.uf) || "?", cid = norm(p.cidade), cep = cepDe(p), c2 = cep.length >= 7 ? cep.padStart(8, "0").slice(0, 2) : "";
    if (uf === "SP") {
      if (cid === "SAO PAULO") return `SP · Capital · ${ZONA_SP[c2] || "zona não identificada"}`;
      if (/^0[6-9]/.test(c2)) return "SP · Grande São Paulo";
      if (c2 === "11") return "SP · Litoral (Baixada Santista e Vale do Ribeira)";
      return "SP · Interior";
    }
    if (uf === "?") return "(sem UF)";
    return cid && cid === CAPITAL[uf] ? `${uf} · Capital (${titulo(cid)})` : `${uf} · Interior`;
  }
  const nomeCid = (p) => titulo(String(p.cidade || "").trim()) || "(sem cidade)";
  const atrasado = (p) => !!p._atrasoG;
  const semNova = (p) => { const nv = p._t && p._t.nova_data; return !nv || String(nv).slice(0, 10) < hoje(); };
  const parado7 = (p) => p._parado !== null && p._parado !== undefined && p._parado >= 7;

  let aberto = {}, sel = "", G = [], X = [];
  function base() {
    const B = (window.__basePainel && window.__basePainel(true)) || [];   // true = calcula atraso, nova data e dias parados
    const canal = ($("c-canal") || {}).value || "";
    return B.filter((p) => !p.entregue_ip && (!canal || (p.canal || "(sem canal)") === canal));
  }
  const top = (L, f, n) => { const m = new Map(); L.forEach((p) => { const k = f(p); m.set(k, (m.get(k) || 0) + 1); }); return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n); };

  function desenhar() {
    const B = base();
    if (!B.length) { $("gx-resumo").textContent = "Carregando os pedidos…"; $("gx-linhas").innerHTML = ""; return; }
    // transportadoras com mais atrasos primeiro
    const porT = new Map(); B.forEach((p) => { const k = nomeT(p.transportadora), x = porT.get(k) || porT.set(k, { k, n: 0, a: 0 }).get(k); x.n++; if (atrasado(p)) x.a++; });
    const ts = [...porT.values()].sort((a, b) => b.a - a.a || b.n - a.n);
    if (!sel || !porT.has(sel)) sel = (ts[0] || {}).k || "";
    $("gx-transp").innerHTML = ts.map((t) => `<option value="${esc(t.k)}" ${t.k === sel ? "selected" : ""}>${esc(t.k)} · ${fmt(t.a)} atrasados</option>`).join("");
    X = B.filter((p) => nomeT(p.transportadora) === sel);
    const m = new Map(); X.forEach((p) => { const r = regiao(p); (m.get(r) || m.set(r, []).get(r)).push(p); });
    G = [...m.entries()].map(([r, L]) => { const A = L.filter(atrasado); return { r, L, A, sn: A.filter(semNova).length, pa: A.filter(parado7).length }; })
      .sort((a, b) => b.A.length - a.A.length || b.L.length - a.L.length);
    const A = X.filter(atrasado);
    // resumo em texto
    const g1 = G[0], ms = top(A, (p) => p.micro_status || "(sem micro status)", 3), pa = A.filter(parado7).length;
    $("gx-resumo").innerHTML = !A.length ? `<p><b>${esc(sel)}</b> não tem pedido atrasado ${$("c-canal").value ? "neste canal" : ""} agora (${fmt(X.length)} em aberto).</p>`
      : `<p><b>${esc(sel)}</b>: ${fmt(A.length)} atrasados de ${fmt(X.length)} em aberto (${pct(A.length, X.length)}).${g1 && g1.A.length ? ` O maior gargalo é <b>${esc(g1.r)}</b>, com ${fmt(g1.A.length)} atrasados (${pct(g1.A.length, A.length)} dos atrasos dela; ${pct(g1.A.length, g1.L.length)} do que ela tem em aberto lá).` : ""}</p>
         <p>Onde trava: ${ms.map(([k, n]) => `<b>${esc(titulo(k))}</b> ${fmt(n)}`).join(" · ")}. ${fmt(pa)} atrasado(s) sem movimento no rastreio há 7 dias ou mais.</p>`;
    const cel = (n, i, q, cls = "") => `<td class="num ${cls} ${n ? "clic" : "vazio-c"}" ${n ? `data-gi="${i}" data-q="${q}"` : ""}>${n ? fmt(n) : "·"}</td>`;
    $("gx-linhas").innerHTML = G.map((g, i) => {
      const t1 = top(g.A, (p) => p.micro_status || "(sem micro status)", 2).map(([k, n]) => `${esc(titulo(k))} (${fmt(n)})`).join(" · ");
      let h = `<tr class="gx-reg${aberto[g.r] ? " aberta" : ""}" data-gr="${esc(g.r)}"><td class="clic">${aberto[g.r] ? "▾" : "▸"} ${esc(g.r)}</td>${cel(g.L.length, i, "todos", "tot")}${cel(g.A.length, i, "atr")}<td class="num ${g.A.length / g.L.length >= 0.25 ? "ruim-t" : ""}">${pct(g.A.length, g.L.length)}</td>${cel(g.sn, i, "sn")}${cel(g.pa, i, "pa")}<td class="s">${t1 || "—"}</td></tr>`;
      if (aberto[g.r]) {
        const cids = top(g.L, (p) => nomeCid(p), 40), mss = top(g.A, (p) => p.micro_status || "(sem micro status)", 10);
        const aC = new Map(top(g.A, (p) => nomeCid(p), 999));
        h += `<tr class="gx-det"><td colspan="7"><div class="gx-det-grade">
          <div><h4>Cidades (${fmt(cids.length)})</h4><table class="gx-mini"><thead><tr><th>Cidade</th><th class="num">Em aberto</th><th class="num">Atrasados</th><th class="num">%</th></tr></thead><tbody>${cids.sort((a, b) => (aC.get(b[0]) || 0) - (aC.get(a[0]) || 0) || b[1] - a[1]).map(([c, n]) => { const a = aC.get(c) || 0;
            return `<tr><td>${esc(c)}</td><td class="num">${fmt(n)}</td><td class="num ${a ? "clic" : "vazio-c"}" ${a ? `data-gi="${i}" data-q="cid" data-v="${esc(c)}"` : ""}>${a ? fmt(a) : "·"}</td><td class="num">${pct(a, n)}</td></tr>`; }).join("")}</tbody></table></div>
          <div><h4>Onde os atrasados travam</h4><table class="gx-mini"><thead><tr><th>Micro status</th><th class="num">Atrasados</th><th class="num">% da região</th></tr></thead><tbody>${mss.map(([k, n]) => `<tr><td>${esc(titulo(k))}</td><td class="num clic" data-gi="${i}" data-q="ms" data-v="${esc(k)}">${fmt(n)}</td><td class="num">${pct(n, g.A.length)}</td></tr>`).join("") || `<tr><td colspan="3" class="vazio">Nenhum atrasado.</td></tr>`}</tbody></table></div>
        </div></td></tr>`;
      }
      return h;
    }).join("") || `<tr><td colspan="7" class="vazio">Sem pedidos em aberto.</td></tr>`;
  }

  $("gx-box").addEventListener("click", (e) => {
    const c = e.target.closest("[data-gi]");
    if (c) {
      const g = G[+c.dataset.gi], q = c.dataset.q, v = c.dataset.v;
      const L = q === "todos" ? g.L : q === "atr" ? g.A : q === "sn" ? g.A.filter(semNova) : q === "pa" ? g.A.filter(parado7)
        : q === "cid" ? g.A.filter((p) => nomeCid(p) === v) : g.A.filter((p) => (p.micro_status || "(sem micro status)") === v);
      const rot = { todos: "em aberto", atr: "atrasados", sn: "atrasados sem nova data", pa: "atrasados parados 7+ dias", cid: `atrasados · ${v}`, ms: `atrasados · ${titulo(v)}` }[q];
      if (window.__abrirListaCard) window.__abrirListaCard(`${sel} · ${g.r} · ${rot}`, L);
      return;
    }
    const r = e.target.closest("tr.gx-reg"); if (r) { aberto[r.dataset.gr] = !aberto[r.dataset.gr]; desenhar(); return; }
    if (e.target.closest("#gx-excel")) {
      if (!G.length) return;
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Região", "Em aberto", "Atrasados", "% de atraso", "Sem nova data", "Parados 7+ dias", "Onde mais trava"]]
        .concat(G.map((g) => [g.r, g.L.length, g.A.length, g.L.length ? Math.round((100 * g.A.length) / g.L.length) : 0, g.sn, g.pa, top(g.A, (p) => p.micro_status || "", 3).map(([k, n]) => `${k} (${n})`).join(" · ")]))), "Regiões");
      const cid = []; G.forEach((g) => { const aC = new Map(top(g.A, (p) => nomeCid(p), 999)); top(g.L, (p) => nomeCid(p), 999).forEach(([c, n]) => cid.push([g.r, c, n, aC.get(c) || 0])); });
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Região", "Cidade", "Em aberto", "Atrasados"]].concat(cid)), "Cidades");
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Pedido", "NF", "Região", "Cidade", "UF", "CEP", "Micro status", "Atrasado", "Prometido", "Nova data", "Dias sem movimento"]]
        .concat(X.map((p) => [p.pedido, p.nf, regiao(p), p.cidade, p.uf, cepDe(p), p.micro_status, atrasado(p) ? "Sim" : "", String(p.prev_original || "").slice(0, 10), (p._t && p._t.nova_data) || "", p._parado ?? ""]))), "Pedidos");
      XLSX.writeFile(wb, `gargalos_${sel.replace(/[^\wÀ-ú]+/g, "_")}_${hoje()}.xlsx`);
    }
  });
  $("gx-transp").addEventListener("change", (e) => { sel = e.target.value; aberto = {}; desenhar(); });
  if ($("c-canal")) $("c-canal").addEventListener("change", () => setTimeout(desenhar, 0));

  // desenha quando a página aparece e a base estiver pronta; redesenha se a base mudar
  const pag = $("pagina-canais"); let ultB = null, ultN = -1;
  const tick = () => { if (pag.hidden) return; const B = window.__basePainel && window.__basePainel(); if (B && (B !== ultB || B.length !== ultN)) { ultB = B; ultN = B.length; desenhar(); } };
  new MutationObserver(() => { if (!pag.hidden) desenhar(); }).observe(pag, { attributes: true, attributeFilter: ["hidden"] });
  setInterval(tick, 5000);
})();
