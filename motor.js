// Preventivo · Fase 1 (aba Transportadoras): tempos reais de entrega em dias úteis (mediana, P80, P90) das entregas
// dos últimos 3 meses, etapas logísticas padronizadas para conferir e cobertura dos dados. Só leitura (parte 51).
(function () {
  const $ = (id) => document.getElementById(id);
  if (!$("mt-fase1")) return;
  const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
  const fmt = (n) => Number(n || 0).toLocaleString("pt-BR");
  const num1 = (n) => (n === null || n === undefined ? "—" : Number(n).toLocaleString("pt-BR", { maximumFractionDigits: 1 }));
  const pct = (a, b) => (b ? Math.round((100 * a) / b) + "%" : "—");
  const hora = (d) => (d ? new Date(d).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "");
  const toast = (msg, erro) => { const t = $("toast"); if (!t) return alert(msg); t.textContent = msg; t.classList.toggle("erro", !!erro); t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), erro ? 6000 : 3500); };
  const sb = () => { const c = window.__sb; if (!c) throw new Error("Entre no painel de novo (sessão expirada)."); return c; };
  const MIN = 30;   // amostra mínima para o motor usar o grupo

  // 7 etapas logísticas, a partir do micro status da Intelipost (proposta para a Brenda conferir)
  const ETAPAS = ["1. Aguardando expedição", "2. Expedido sem CT-e", "3. Em trânsito / transferência", "4. Redespacho", "5. Na unidade de destino / saiu para entrega", "6. Ocorrência", "7. Entregue"];
  function etapaDe(ms) {
    const s = norm(ms);
    if (!s) return "Sem micro status";
    if (/ENTREGUE|ENTREGA REALIZADA|ENTREGA EFETUADA/.test(s) && !/NAO ENTREGUE|SAIU PARA ENTREGA|EM ROTA DE ENTREGA|SERA FINALIZADA|TENTATIVA/.test(s)) return ETAPAS[6];
    if (/AUSENTE|ENDERECO|RECUS|AVARIA|EXTRAVI|SINISTR|ROUB|FURT|FALHA|DEVOLU|MUDOU|FECHADO|INSTRU|REENTREGA|INSUCESSO|NAO ENTREGUE|BARRAD|RETIDO|FISCALIZ|ACIDENTE|AVERIGU|DIVERGEN|CONFIRMACAO DE DADOS|TENTATIVA/.test(s)) return ETAPAS[5];
    if (/SAIU PARA ENTREGA|EM ROTA DE ENTREGA|ROTA DE ENTREGA|UNIDADE DE DESTINO|UNIDADE DE ENTREGA|AGUARDANDO RETIRADA|DISPONIVEL PARA RETIRADA|AGENDAD|BASE DE DESTINO|FILIAL DE DESTINO/.test(s)) return ETAPAS[4];
    if (/REDESPACH|PARCEIRO|TRANSBORDO/.test(s)) return ETAPAS[3];
    if (/TRANSITO|TRANSFER|COLETAD|RECEBID|CHEGADA|EM VIAGEM|EMBARCAD|CENTRO DE DISTRIBUICAO|HUB|EM ROTA|ENCAMINHAD|SERA FINALIZADA/.test(s)) return ETAPAS[2];
    if (/DESPACHAD|CT-?E|CTE|AGUARDANDO COLETA|COLETA SOLICITADA|EMISSAO|PRONTO PARA (ENVIO|COLETA)|EXPEDID/.test(s)) return ETAPAS[1];
    if (/AGUARDANDO (EXPEDI|FATUR|SEPARA|PRODU)|PEDIDO CRIADO|NOVO|EM SEPARACAO|FATURAD|NOTA FISCAL EMITIDA|SEM EXPEDI/.test(s)) return ETAPAS[0];
    return "Não classificado";
  }

  const TRECHOS = [["expedicao_entrega", "Expedição → entrega"], ["cte_entrega", "CT-e → entrega"], ["criacao_expedicao", "Criação → expedição"], ["expedicao_cte", "Expedição → CT-e"]];
  let T = [], trecho = "expedicao_entrega", abertos = null, aberto = {}, etapasVer = false, carregando = false, carregou = false, mudancas = null;
  const tEf = (t, rd) => { const x = norm((rd && !/^SEM\b|^-$/i.test(rd) ? rd : t) || "(SEM TRANSPORTADORA)"); return /TEMPO\s*JUSTO|^VM\b|VM TRANSP/.test(x) ? "VM TRANSPORTES / TEMPO JUSTO" : x; };

  async function paginas(tab, sel, filtro) {
    const out = []; for (let de = 0; ; de += 1000) { let q = sb().from(tab).select(sel).range(de, de + 999); if (filtro) q = filtro(q); const { data, error } = await q; if (error) throw error; out.push(...data); if (data.length < 1000) break; }
    return out;
  }
  async function carregar() {
    if (carregando) return; carregando = true; $("mt-info").textContent = "Carregando…";
    try {
      T = await paginas("tempos_referencia", "*");
      const m = await sb().from("pedido_mudancas").select("id", { count: "exact", head: true }); mudancas = m.error ? null : m.count;
      // pedidos em aberto (mesma base da Visão Gerencial) + quando o rastreio foi lido
      const [ab, cf, ps] = await Promise.all([paginas("base_aberta_bi", "pedido,transportadora,uf,cidade,micro_status,extra->>redespacho"),
        paginas("conferencia_ssw", "pedido,consultado_em").catch(() => []), paginas("previsao_ssw", "pedido,consultado_em").catch(() => [])]);
      const lido = new Map(); [...cf, ...ps].forEach((x) => { if (x.consultado_em && (!lido.get(x.pedido) || x.consultado_em > lido.get(x.pedido))) lido.set(x.pedido, x.consultado_em); });
      abertos = ab.map((p) => ({ ...p, _t: tEf(p.transportadora, p.redespacho), _uf: norm(p.uf) || "?", _cid: norm(p.cidade) || "?", _lido: lido.get(p.pedido) || null, _et: etapaDe(p.micro_status) }));
      carregou = true; desenhar();
    } catch (e) { $("mt-info").textContent = /tempos_referencia|pedido_mudancas|does not exist|schema cache/i.test(e.message || "") ? "Para ver esta parte, rode a parte 51 no Supabase." : "Não consegui carregar: " + (e.message || e); }
    finally { carregando = false; }
  }

  function desenhar() {
    const R = T.filter((x) => x.trecho === trecho), calc = T.map((x) => x.calculado_em).sort().pop(), per = T[0] ? `${new Date(T[0].periodo_de + "T12:00").toLocaleDateString("pt-BR")} a ${new Date(T[0].periodo_ate + "T12:00").toLocaleDateString("pt-BR")}` : "";
    $("mt-info").textContent = T.length ? `Entregas de ${per} · dias úteis sem sábado, domingo e feriados do destino · calculado em ${hora(calc)}${mudancas !== null ? ` · memória: ${fmt(mudancas)} mudanças anotadas` : ""}` : "Ainda sem cálculo: clique em Recalcular agora.";
    // cobertura: grupo com amostra suficiente para cada pedido em aberto (cidade, senão UF, senão transportadora)
    const E = T.filter((x) => x.trecho === "expedicao_entrega"), g = new Map(E.map((x) => [`${x.transp}|${x.uf}|${x.cidade}`, x.n]));
    const nivel = (p) => ((g.get(`${p._t}|${p._uf}|${p._cid}`) || 0) >= MIN ? "cidade" : (g.get(`${p._t}|${p._uf}|`) || 0) >= MIN ? "uf" : (g.get(`${p._t}||`) || 0) >= MIN ? "transp" : "inconclusivo");
    const A = abertos || [], nv = { cidade: 0, uf: 0, transp: 0, inconclusivo: 0 }; A.forEach((p) => nv[nivel(p)]++);
    const rec = A.filter((p) => p._lido && Date.now() - Date.parse(p._lido) < 48 * 3600e3).length, semEt = A.filter((p) => !ETAPAS.includes(p._et)).length;
    const tr = E.filter((x) => !x.uf), trOk = tr.filter((x) => x.n >= MIN).length, nEnt = tr.reduce((s, x) => s + x.n, 0);
    const kp = (rot, n, sub, cor = "") => `<div class="kpi kpi-info ${cor}"><span class="kpi-rot">${rot}</span><b class="kpi-num">${n}</b><small>${sub}</small></div>`;
    $("mt-cards").innerHTML = kp("Entregas usadas", fmt(nEnt), "últimos 3 meses, com expedição e entrega")
      + kp("Transportadoras com amostra", `${fmt(trOk)} de ${fmt(tr.length)}`, `${MIN} ou mais entregas`)
      + kp("Em aberto com referência", pct(A.length - nv.inconclusivo, A.length), `cidade ${fmt(nv.cidade)} · UF ${fmt(nv.uf)} · só transportadora ${fmt(nv.transp)}`, "azul")
      + kp("Seriam inconclusivos", fmt(nv.inconclusivo), "sem histórico suficiente", nv.inconclusivo ? "laranja" : "")
      + kp("Rastreio lido em 48 h", pct(rec, A.length), `${fmt(rec)} de ${fmt(A.length)} em aberto`)
      + `<button type="button" class="kpi kpi-info kpi-clic ${semEt ? "vermelho" : ""}${etapasVer ? " ativa" : ""}" data-mt="etapas"><span class="kpi-rot">Etapas para conferir</span><b class="kpi-num">${fmt(semEt)}</b><small>micro status sem etapa · clique para ver todas</small><i>↗</i></button>`;
    $("mt-trechos").innerHTML = TRECHOS.map(([k, r]) => `<button data-tr="${k}"${k === trecho ? ' class="ativo"' : ""}>${r}</button>`).join("");
    const linha = (x, cls, rot, chave, temFilhos) => `<tr class="${cls}${temFilhos ? " mt-abre" : ""}"${temFilhos ? ` data-k="${esc(chave)}"` : ""}><td>${temFilhos ? (aberto[chave] ? "▾ " : "▸ ") : ""}${esc(rot)}${x.n < MIN ? ` <span class="chip cinza">amostra pequena</span>` : ""}</td><td class="num">${fmt(x.n)}</td><td class="num tot">${num1(x.p50)}</td><td class="num">${num1(x.p80)}</td><td class="num">${num1(x.p90)}</td><td class="num">${num1(x.media)}</td>${trecho === "expedicao_entrega" ? `<td class="num">${x.no_prazo === null ? "—" : num1(x.no_prazo) + "%"}</td>` : ""}</tr>`;
    let h = "";
    R.filter((x) => !x.uf).sort((a, b) => b.n - a.n).forEach((t) => {
      const kt = t.transp; h += linha(t, "mt-t", t.transp, kt, true);
      if (aberto[kt]) R.filter((x) => x.transp === t.transp && x.uf && !x.cidade).sort((a, b) => b.n - a.n).forEach((u) => {
        const ku = kt + "|" + u.uf; h += linha(u, "mt-u", u.uf === "?" ? "(sem UF)" : u.uf, ku, true);
        if (aberto[ku]) R.filter((x) => x.transp === t.transp && x.uf === u.uf && x.cidade).sort((a, b) => b.n - a.n).slice(0, 40).forEach((c) => (h += linha(c, "mt-c", c.cidade === "?" ? "(sem cidade)" : c.cidade, "", false)));
      });
    });
    $("mt-cab").innerHTML = `<tr><th>Transportadora › UF › cidade</th><th class="num">Entregas</th><th class="num">Mediana</th><th class="num">P80</th><th class="num">P90</th><th class="num">Média</th>${trecho === "expedicao_entrega" ? `<th class="num">No prazo</th>` : ""}</tr>`;
    $("mt-linhas").innerHTML = h || `<tr><td colspan="7" class="vazio">Sem entregas nesse trecho.</td></tr>`;
    // etapas
    $("mt-etapas").hidden = !etapasVer;
    if (etapasVer) {
      const m = new Map(); A.forEach((p) => { const k = p.micro_status || "(vazio)"; const x = m.get(k) || { ms: k, et: p._et, n: 0 }; x.n++; m.set(k, x); });
      const L = [...m.values()].sort((a, b) => (ETAPAS.includes(a.et) ? 1 : 0) - (ETAPAS.includes(b.et) ? 1 : 0) || a.et.localeCompare(b.et) || b.n - a.n);
      $("mt-et-linhas").innerHTML = L.map((x) => `<tr><td>${esc(x.ms)}</td><td>${ETAPAS.includes(x.et) ? esc(x.et) : `<span class="chip vermelho">${esc(x.et)}</span>`}</td><td class="num">${fmt(x.n)}</td></tr>`).join("") || `<tr><td colspan="3" class="vazio">Sem pedidos em aberto.</td></tr>`;
      const pe = new Map(); A.forEach((p) => pe.set(p._et, (pe.get(p._et) || 0) + 1));
      $("mt-et-resumo").innerHTML = [...ETAPAS, "Não classificado", "Sem micro status"].filter((e) => pe.get(e)).map((e) => `<span class="chip ${ETAPAS.includes(e) ? "" : "vermelho"}">${esc(e)} · ${fmt(pe.get(e))}</span>`).join(" ");
      $("mt-etapas")._L = L;
    }
  }

  $("mt-fase1").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-tr]"); if (b) { trecho = b.dataset.tr; desenhar(); return; }
    const k = e.target.closest("tr.mt-abre"); if (k) { aberto[k.dataset.k] = !aberto[k.dataset.k]; desenhar(); return; }
    if (e.target.closest('[data-mt="etapas"]')) { etapasVer = !etapasVer; desenhar(); if (etapasVer) $("mt-etapas").scrollIntoView({ block: "start", behavior: "smooth" }); return; }
    if (e.target.closest("#mt-carregar")) { carregar(); return; }
    if (e.target.closest("#mt-recalc")) {
      try { $("mt-info").textContent = "Recalculando (pode levar até 1 minuto)…"; const { data, error } = await sb().rpc("recalcular_tempos"); if (error) throw error; toast(`Tempos recalculados (${fmt(data)} grupos).`); carregar(); }
      catch (er) { toast(/recalcular_tempos|function/i.test(er.message || "") ? "Rode a parte 51 no Supabase." : er.message || String(er), true); }
      return;
    }
    if (e.target.closest("#mt-excel")) {
      if (!T.length) return toast("Nada para exportar.", true);
      const wb = XLSX.utils.book_new(), cab = ["Trecho", "Transportadora", "UF", "Cidade", "Entregas", "Mediana (dias úteis)", "P80", "P90", "Média", "% no prazo"];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([cab].concat(T.slice().sort((a, b) => a.trecho.localeCompare(b.trecho) || a.transp.localeCompare(b.transp) || a.uf.localeCompare(b.uf) || a.cidade.localeCompare(b.cidade))
        .map((x) => [(TRECHOS.find((t) => t[0] === x.trecho) || [, x.trecho])[1], x.transp, x.uf, x.cidade, x.n, x.p50, x.p80, x.p90, x.media, x.no_prazo]))), "Tempos reais");
      const L = $("mt-etapas")._L || []; if (L.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Micro status", "Etapa", "Pedidos em aberto"]].concat(L.map((x) => [x.ms, x.et, x.n]))), "Etapas");
      XLSX.writeFile(wb, `tempos_reais_${new Date().toISOString().slice(0, 10)}.xlsx`);
    }
  });
  // carrega na primeira vez que a aba Transportadoras aparece
  const pag = $("pagina-transp");
  new MutationObserver(() => { if (!pag.hidden && !carregou && window.__sb) carregar(); }).observe(pag, { attributes: true, attributeFilter: ["hidden"] });
  if (!pag.hidden && window.__sb) setTimeout(carregar, 1500);
})();
