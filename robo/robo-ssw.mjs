// Robô da conferência SSW: lê a previsão de entrega no rastreio público do SSW (ssw.inf.br)
// pela NF (sem a série) + CNPJ do remetente (escolhido pela série da NF).
// Registro público (Actions): só contagens, nomes de campos e datas — nunca nome, endereço ou NF.
import { entrarSupabase, chamar } from "./supa.mjs";
const MODO = process.env.MODO || "diag";
const log = (...a) => console.log(...a.map((x) => String(x).replace(/\d{5,}/g, "#####")));
const tags = (html, re) => [...html.matchAll(re)].map((m) => m[0].replace(/\s+/g, " ").slice(0, 200));

async function pagina(url, opts) {
  const r = await fetch(url, { redirect: "follow", ...opts, headers: { "User-Agent": "Mozilla/5.0", ...(opts && opts.headers) } });
  const buf = Buffer.from(await r.arrayBuffer());
  const txt = new TextDecoder(/8859|latin/i.test(r.headers.get("content-type") || "") ? "latin1" : "utf-8").decode(buf);
  return { status: r.status, url: r.url, txt, cookie: (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map((c) => c.split(";")[0]).join("; ") };
}

// CNPJ do remetente pela série da NF (tabela da Logística)
const CNPJ_SERIE = { "00349443000192": [4, 6, 7, 31, 94], "00349443000435": [9, 22, 34], "00349443000516": [10],
  "00349443000788": [11, 24, 25, 27, 301, 302, 303], "00349443001083": [14, 35], "00349443001245": [17], "00349443001407": [21],
  "00349443001750": [23], "00349443001679": [26] };
// senha do rastreio (campo "Senha (opcional)" do SSW = chave) de transportadoras que exigem senha; fica só no segredo do GitHub
const SENHAS = [[/sua\s*log/i, process.env.SSW_SENHA_TRANSSUA || ""], [/^\s*vm\b|vm transportes/i, process.env.SSW_SENHA_VM || ""], [/aceville/i, process.env.SSW_SENHA_ACEVILLE || ""], [/dominalog/i, process.env.SSW_SENHA_DOMINALOG || ""]];
const chaveDe = (transp) => (SENHAS.find(([re, s]) => s && re.test(transp || "")) || [, ""])[1];
// transportadoras que não usam SSW (regra da Brenda): nem consulta; nas outras, "Informação não disponível" = CT-e ainda não emitido
const FORA_SSW = /formato|transiga/i;
// Trânsito Brasil não usa SSW: consulta no rastreio dela (Senior), pela NF + CNPJ (série 35 → ...1083, outras → ...0192); só vale se a série bater
const EH_TRANSITO = /tr[aâ]nsito\s*brasil/i;
async function transito(itens) {
  const out = new Map(); if (!itens.length) return out;
  const URL_T = "https://platform.senior.com.br/t/senior.com.br/bridge/1.0/anonymous/rest/tms/tck/actions/externalTenantConsultaTracking";
  const dorme = (ms) => new Promise((ok) => setTimeout(ok, ms)); let erros = 0;
  const dia = (v) => v ? String(v).slice(0, 10) : null;
  for (const l of itens) {
    const [num, ser] = String(l.nf || "").split("-").map((x) => (x || "").trim()), sn = String(parseInt(ser, 10));
    if (!num || sn === "NaN") { out.set(l.pedido, { situacao: "sem nf" }); continue; }
    let j = null;
    try {
      const r = await fetch(URL_T, { method: "POST", headers: { "Content-Type": "application/json", "x-tenantdomain": "transitobrasil.com.br", "x-tenant": "transitobrasil" },
        body: JSON.stringify({ documento: num, inscricaoFiscal: sn === "35" ? "00349443001083" : "00349443000192", somenteFasesExecutadas: false, pageRequest: { offset: 0, size: 10 } }) });
      if (!r.ok) { if (++erros > 5) { log(`Trânsito Brasil respondeu ${r.status}; paro nesta rodada.`); break; } await dorme(10000); continue; }
      erros = 0; j = await r.json();
    } catch (e) { if (++erros > 5) break; await dorme(10000); continue; }
    const limite = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
    const ts = (j.listaTracking || []).filter((x) => x.tracking && String(parseInt(x.tracking.serie, 10)) === sn)   // série diferente = outra nota: desconsidera
      .map((x) => ({ x, fases: (x.listaTrackingFase || []).filter((f) => f.executada && f.dataExecucao).sort((a, b) => String(a.dataExecucao).localeCompare(String(b.dataExecucao))) }))
      .filter(({ x, fases }) => (dia(x.tracking.dataEntrega) || dia((fases[fases.length - 1] || {}).dataExecucao) || "9999") >= limite);   // nota antiga com o mesmo número: desconsidera
    const t = ts[ts.length - 1];
    if (!t) out.set(l.pedido, { situacao: "sem cte" });
    else {
      const tr = t.x.tracking, prev = dia(tr.dataPrevisaoEntrega), ult = t.fases[t.fases.length - 1];
      const detalhe = { fonte: "Trânsito Brasil", codigo: tr.codigo || null, status: tr.situacao && tr.situacao.descricao || null, previsao: prev,
        eventos: t.fases.map((f) => ({ data: String(f.dataExecucao).replace("T", " ").slice(0, 16), status: f.fase && f.fase.descricao || "", unidade: "" })) };
      if (tr.dataEntrega) out.set(l.pedido, { situacao: "entregue", data_entrega: dia(tr.dataEntrega), data_evento: dia(tr.dataEntrega), ultimo_evento: "ENTREGUE", previsao: prev });
      else out.set(l.pedido, { situacao: "nao entregue", data_evento: ult ? dia(ult.dataExecucao) : null, ultimo_evento: ult && ult.fase ? String(ult.fase.descricao || "").toUpperCase().slice(0, 60) : null, previsao: prev });
    }
    await dorme(1000);
  }
  const cont = {}; out.forEach((v) => (cont[v.situacao] = (cont[v.situacao] || 0) + 1));
  log("Trânsito Brasil (Senior):", Object.entries(cont).map(([k, v]) => `${k} ${v}`).join(" · ") || "nada");
  return out;
}
// Bento Brasil não usa SSW: consulta no rastreio do site dela (CNPJ da Multi + número da NF), 1 por vez com pausa
const EH_BENTO = /bento/i;
function lerBento(txt) {
  const m = String(txt || "").match(/dados = '([\s\S]*?)';/); let d = null; try { d = m && JSON.parse(m[1]); } catch {}
  if (Array.isArray(d)) d = d[d.length - 1];
  if (!d || !d.dtemissao) return { situacao: "sem cte" };
  const dia = (v) => v ? String(v).slice(0, 10) : null, prev = dia(d.dtagendamentoentrega || d.dtprevisaoentrega || d.dtprevchegadaredespacho);
  const NOMES = [["dtemissao", "Emitido"], ["dtsaida", "Saiu da origem"], ["dtprevchegcarregamento", "Previsão de chegada do carregamento"], ["dtchegada", "Chegou na unidade de entrega"],
    ["dtemissaoredespacho", "Redespacho emitido"], ["dtprevchegadaredespacho", "Previsão de chegada do redespacho"], ["dtsaidadistribuicao", "Saiu para entrega"],
    ["dtdistribuicaopreventrega", "Previsão de entrega na rota"], ["dtagendamentoentrega", "Entrega agendada"], ["dtprevisaoentrega", "Previsão de entrega"], ["dtentrega", "Entregue"]];
  const detalhe = { fonte: "Bento Brasil", previsao: prev, eventos: NOMES.filter(([k]) => d[k]).map(([k, n]) => ({ data: String(d[k]).slice(0, 16), status: n, unidade: "" })).sort((a, b) => a.data.localeCompare(b.data)) };
  if (d.dtentrega) return { situacao: "entregue", data_entrega: dia(d.dtentrega), data_evento: dia(d.dtentrega), ultimo_evento: "ENTREGUE", previsao: prev };
  const ev = [["dtsaidadistribuicao", "SAIU PARA ENTREGA"], ["dtemissaoredespacho", "REDESPACHO"], ["dtchegada", "CHEGOU NA UNIDADE DE ENTREGA"], ["dtsaida", "EM TRANSFERENCIA"], ["dtemissao", "EMITIDO"]].find(([k]) => d[k]);
  return { situacao: "nao entregue", data_evento: dia(d[ev[0]]), ultimo_evento: ev[1], previsao: prev };
}
async function bento(itens) {
  const out = new Map(); if (!itens.length) return out;
  const dorme = (ms) => new Promise((ok) => setTimeout(ok, ms)); let erros = 0;
  for (const l of itens) {
    const num = String(l.nf || "").split("-")[0].trim();
    if (!num) { out.set(l.pedido, { situacao: "sem nf" }); continue; }
    try {
      const r = await pagina("https://sistema.bentobrasil.com.br/consultaNotas.php", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ nr: "00349443000192", nrNota: num }).toString() });
      if (r.status !== 200) { if (++erros > 5) { log(`Bento Brasil respondeu ${r.status}; paro a Bento nesta rodada.`); break; } await dorme(10000); continue; }
      erros = 0; out.set(l.pedido, lerBento(r.txt));
    } catch (e) { if (++erros > 5) break; await dorme(10000); continue; }
    await dorme(1500);
  }
  const cont = {}; out.forEach((v) => (cont[v.situacao] = (cont[v.situacao] || 0) + 1));
  log("Bento Brasil (site):", Object.entries(cont).map(([k, v]) => `${k} ${v}`).join(" · ") || "nada");
  return out;
}
// Jadlog não usa SSW: consulta pela API dela (segredo JADLOG_TOKEN), por NF + série + CNPJ do remetente, 10 por vez
const EH_JADLOG = /jadlog/i;
const isoBR = (d) => !d ? null : /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : (() => { const [dd, mm, aa] = String(d).split(" ")[0].split("/"); return aa ? `${aa.length === 2 ? "20" + aa : aa}-${mm}-${dd}` : null; })();
function lerJadlog(c) {
  const t = c && c.tracking, prev = c && isoBR(c.previsaoEntrega);
  if (!t || (!t.status && !(t.eventos || []).length)) return { situacao: "sem cte", previsao: prev };
  const ev = t.eventos || [], ult = ev[ev.length - 1] || {}, st = String(t.status || ult.status || "").toUpperCase().trim();
  // detalhe para a janela do painel (só dados do envio: códigos, datas, status e unidades da Jadlog — nada do destinatário)
  const detalhe = { fonte: "Jadlog", codigo: t.shipmentId || t.codigo || null, cte: t.dacte || null, emissao: isoBR(t.dtEmissao), status: st || null, previsao: prev,
    eventos: ev.map((e) => ({ data: String(e.data || "").slice(0, 16), status: e.status || "", unidade: e.unidade || "" })) };
  if (/^ENTREGUE|ENTREGA REALIZADA/.test(st)) { const e = [...ev].reverse().find((x) => /ENTREGUE|ENTREGA REALIZADA/i.test(x.status || "")) || ult;
    return { situacao: "entregue", data_entrega: isoBR(e.data), data_evento: isoBR(e.data), ultimo_evento: "ENTREGUE", previsao: prev, detalhe }; }
  return { situacao: "nao entregue", data_evento: isoBR(ult.data), ultimo_evento: st.slice(0, 60) || null, previsao: prev, detalhe };
}
async function jadlog(itens) {
  const tok = process.env.JADLOG_TOKEN, out = new Map(); if (!tok || !itens.length) return out;
  const dorme = (ms) => new Promise((ok) => setTimeout(ok, ms));
  for (let i = 0; i < itens.length; i += 10) {
    const lote = itens.slice(i, i + 10).map((l) => { const [num, ser] = String(l.nf || "").split("-").map((x) => (x || "").trim()); return { l, num, ser, c: cnpjDaSerie(ser) }; });
    lote.filter((x) => !x.num || !x.c).forEach((x) => out.set(x.l.pedido, { situacao: "sem nf" }));
    const ok = lote.filter((x) => x.num && x.c); if (!ok.length) continue;
    let j = null;
    try {
      const r = await fetch("https://www.jadlog.com.br/embarcador/api/tracking/consultar", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ consulta: ok.map((x) => ({ df: { nf: x.num, serie: x.ser, tpDocumento: 2, cnpjRemetente: x.c } })) }) });
      if (r.status === 401 || r.status === 403) { log(`Jadlog recusou o token (${r.status}); paro a Jadlog nesta rodada.`); break; }
      if (!r.ok) { log(`Jadlog respondeu ${r.status}; espero e sigo.`); await dorme(5000); continue; }
      j = await r.json();
    } catch (e) { log("Jadlog:", String(e.message).slice(0, 80)); await dorme(5000); continue; }
    const res = (j && j.consulta) || [];
    ok.forEach((x, k) => { const c = res.find((z) => z && z.df && String(z.df.nf) === x.num && String(z.df.serie) === x.ser) || res[k]; out.set(x.l.pedido, lerJadlog(c)); });
    await dorme(700);
  }
  const cont = {}; out.forEach((v) => (cont[v.situacao] = (cont[v.situacao] || 0) + 1));
  log("Jadlog (API):", Object.entries(cont).map(([k, v]) => `${k} ${v}`).join(" · ") || "nada");
  return out;
}
const cnpjDaSerie = (serie) => { const n = parseInt(serie, 10); return Object.keys(CNPJ_SERIE).find((c) => CNPJ_SERIE[c].includes(n)) || null; };
const sohTexto = (html) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<svg[\s\S]*?<\/svg>/gi, " ").replace(/<br\s*\/?>|<\/(tr|p|div|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&nbsp;/g, " ").replace(/&([a-z]+);/gi, (m, n) => ({ amp: "&", atilde: "ã", otilde: "õ", ccedil: "ç", aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", ecirc: "ê", acirc: "â", ocirc: "ô", agrave: "à", ordf: "ª", ordm: "º", lt: "<", gt: ">", quot: '"' })[n.toLowerCase()] ?? " ").split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
async function consultar(cnpj, nfs) {
  return pagina("https://ssw.inf.br/2/resultSSW", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ cnpj, NR: nfs.join("\n"), chave: "" }).toString() });
}
if (MODO === "diag-nf") {
  await entrarSupabase();
  const linhas = await chamar("base_aberta?select=transportadora,nf,prev_original&nf=not.is.null&limit=6000");
  log("Pedidos em aberto lidos:", linhas.length, "· exemplo do formato da NF:", String((linhas[0] || {}).nf || "").replace(/\d/g, "9"));
  const porT = {};
  for (const l of linhas) { const [num, ser] = String(l.nf).split("-"); const c = cnpjDaSerie(ser); if (!c || !num) continue; (porT[l.transportadora || "?"] ||= []).push({ num: num.trim(), c }); }
  let mostrou = false;
  for (const [t, L] of Object.entries(porT)) {
    const x = L[0];
    try {
      const p = await consultar(x.c, [x.num]);
      const ls = sohTexto(p.txt);
      const prev = ls.filter((l) => /previs/i.test(l)).map((l) => l.replace(/[A-Za-zÀ-ú]{3,}/g, (w) => /previs|entrega|prevista|data|de|em/i.test(w) ? w : "x").slice(0, 80));
      const nao = ls.some((l) => /n[ãa]o (localizad|encontrad)|nenhum/i.test(l));
      log(`${t}: ${L.length} pedido(s) · resposta ${p.status} · ${nao ? "NÃO localizado" : "achou"} · linhas com previsão: ${prev.length ? prev.slice(0, 3).join(" | ") : "nenhuma"}`);
      if (!mostrou && !nao && prev.length) { mostrou = true;
        log("  rótulos da página (só palavras sem números, curtas):", ls.filter((l) => !/\d/.test(l) && l.length < 40).slice(0, 40).join(" / ")); }
    } catch (e) { log(`${t}: erro ${e.message}`); }
    await new Promise((r) => setTimeout(r, 1500));
  }
}
// só deixa passar palavras "de sistema" (nada de nome, cidade ou endereço) — para os registros públicos
const OK_PAL = /^(previs[aã]o|de|da|do|entrega|chegada|na|no|em|unidade|cidade|ct-e|nota|fiscal|notas|fiscais|nf|n[ãa]o|localizad[ao]s?|encontrad[ao]s?|nenhum[a]?|documento|documentos|para|o|a|os|as|e|ou|kg|volume|volumes|destino|entregue|entrega|realizada|situa[cç][aã]o|ocorr[eê]ncia|data|hora|remetente|destinat[aá]rio|cnpj|inv[aá]lido|rastreamento|senha|informe|consulta|resultado|mercadoria|saida|sa[ií]da|transfer[eê]ncia|em|tr[aâ]nsito|coleta|emiss[aã]o|h)$/i;
const limpo = (l) => l.replace(/[A-Za-zÀ-ú][A-Za-zÀ-ú\-]*/g, (w) => OK_PAL.test(w) ? w : "x").replace(/\d{5,}/g, "#").replace(/(x[\s\/.,]*){2,}/g, "x ");
if (MODO === "diag-nf2") {
  await entrarSupabase();
  const linhas = await chamar("base_aberta?select=transportadora,nf&nf=not.is.null&limit=6000");
  const porT = {};
  for (const l of linhas) { const [num, ser] = String(l.nf).split("-"); const c = cnpjDaSerie(ser); if (!c || !num) continue; (porT[l.transportadora || "?"] ||= []).push({ num: num.trim(), c }); }
  for (const t of ["Dominalog", "Jadlog", "Tsl Transportes"]) { const x = (porT[t] || [])[0]; if (!x) continue;
    const ls = sohTexto((await consultar(x.c, [x.num])).txt); const i = ls.findIndex((l) => /pelo pagador/i.test(l));
    log(`${t}:`, ls.slice(i + 1).filter((l) => !/^(Para |Rastreamento|Pelo |Preciso|Solicitar|Coleta|Serviço|Imprimir|Download|Reemis|Pré-|ssw|Sistema|Quem)/i.test(l)).slice(0, 25).map(limpo).join(" / "));
    log("   mensagem:", ls.filter((l) => /n[ãa]o /i.test(l) && !/\d/.test(l) && l.length < 70).slice(0, 3).join(" | ")); }
  const L = (porT["Prolog Transportes E Logistica Ltda"] || []).filter((x) => x.c === (porT["Prolog Transportes E Logistica Ltda"] || [{}])[0].c).slice(0, 3);
  for (const sep of [",", " ", ";"]) { const l2 = sohTexto((await pagina("https://ssw.inf.br/2/resultSSW", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ cnpj: L[0].c, NR: L.map((x) => x.num).join(sep), chave: "" }).toString() })).txt);
    log(`Lote separado por "${sep}": linhas com previsão: ${l2.filter((l) => /previs[aã]o de entrega/i.test(l)).length} · mensagem: ${l2.filter((l) => /n[ãa]o /i.test(l) && !/\d/.test(l) && l.length < 70).slice(0, 2).join(" | ")}`); }
  const ls = sohTexto((await consultar(L[0].c, L.map((x) => x.num))).txt);
  log("Lote de 3 NFs Prolog: linhas com previsão:", ls.filter((l) => /previs/i.test(l)).length, "·", ls.slice(ls.findIndex((l) => /pelo pagador/i.test(l)) + 1).filter((l) => !/^(Para |Rastreamento|Pelo |Preciso|Solicitar|Coleta|Serviço|Imprimir|Download|Reemis|Pré-|ssw|Sistema|Quem)/i.test(l)).slice(0, 30).map(limpo).join(" / "));
  log("  links no resultado do lote:", tags((await consultar(L[0].c, L.map((x) => x.num))).txt, /<a [^>]*href=["'][^"']*["'][^>]*>|onclick=["'][^"']{0,120}["']/gi).filter((t) => !/rastreamento|ajuda|\.css|ssw\.inf\.br\/?["']|menu/i.test(t)).slice(0, 8).map((t) => t.replace(/\d{4,}/g, "#")).join(" | "));
}
if (MODO === "diag-st") {
  await entrarSupabase();
  const todos = [];
  for (let de = 0; ; de += 1000) { const L = await chamar(`base_aberta?select=pedido,nf,transportadora,status_intelipost,micro_status,data_entrega&nf=not.is.null&order=pedido&limit=1000&offset=${de}`); todos.push(...L); if (L.length < 1000) break; }
  const conta = (f) => { const c = {}; todos.forEach((l) => { const k = f(l); c[k] = (c[k] || 0) + 1; }); return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${k}=${v.toLocaleString("pt-BR")}`).join(" | "); };
  log("Total na base_aberta:", todos.length.toLocaleString("pt-BR"));
  log("status_intelipost:", conta((l) => l.status_intelipost || "(vazio)"));
  log("micro_status:", conta((l) => l.micro_status || "(vazio)"));
  log("data_entrega:", conta((l) => (l.data_entrega ? "preenchida" : "vazia")));
  const f = await chamar("intelipost_fechados?select=pedido&limit=1"); const fi = await chamar("fechados_info?select=*&limit=1");
  log("intelipost_fechados tem linhas:", f.length ? "sim" : "não", "· último arquivo Intelipost:", fi[0] ? fi[0].enviado_em : "nenhum");
  // amostra de 40 sem previsão: quais situações o SSW mostra (só palavras de sistema)
  const SIT = /(MERCADORIA|ENTREG|SAIDA|SAÍDA|CHEGADA|TRANSFER|COLETA|AGUARD|EMISS|DOCUMENTO|OCORR|DEVOL|ROTA|CONHECIMENTO|EMBARQUE|DESCARREG|INFORMA)/i;
  const resumo = {};
  for (const l of todos.slice(0, 4000).filter((_, i) => i % 100 === 0)) {
    const [num, ser] = String(l.nf).split("-"); const c = cnpjDaSerie(ser); if (!c) continue;
    const ls = sohTexto((await consultar(c, [num.trim()])).txt);
    const sit = ls.filter((x) => SIT.test(x) && x.length < 90).map((x) => x.split(/\s+/).slice(0, 3).join(" ").replace(/\d/g, "9")).slice(-2).join(" > ") || "(nada)";
    const k = `${l.transportadora}: ${sit}`; resumo[k] = (resumo[k] || 0) + 1;
  }
  Object.entries(resumo).forEach(([k, v]) => log("  ", v, "×", k));
}
if (MODO === "diag-link") {
  await entrarSupabase();
  const L = await chamar("base_aberta?select=nf,transportadora&transportadora=ilike.vm*&limit=3");
  log("pedidos VM:", L.length);
  for (const l of L) {
    const [num, ser] = String(l.nf).split("-"); const p = await consultar(cnpjDaSerie(ser), [num.trim()]);
    const corpo = p.txt.slice(p.txt.search(/N Fiscal/i));
    log("links/onclick:", tags(corpo, /<a [^>]*>|onclick=["'][^"']{0,200}["']|<form[^>]*>|<input type=.?hidden[^>]*>/gi).map((t) => t.replace(/\d{4,}/g, "#").replace(/value=["'][^"']{12,}["']/g, 'value="…"')).slice(0, 15).join(" | "));
    log("linhas:", sohTexto(corpo).length, "· tem 'Previsao':", /previs/i.test(corpo) ? "sim" : "não");
  }
}
if (MODO === "diag-senha") {   // Trans Sua: testa a senha de jeitos diferentes (só mostra o resultado, sem dados)
  await entrarSupabase();
  const L = await chamar("conferencia_ssw?select=nf,transportadora&situacao=eq.sem%20permissao&limit=3");
  const senha = chaveDe(L[0] && L[0].transportadora);
  log("transportadoras:", [...new Set(L.map((x) => x.transportadora))].join(", "));
  log("pedidos Trans Sua:", L.length, "· com senha:", senha ? `sim (${senha.length} caracteres)` : "não");
  const dorme = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const tenta = async (rot, cnpj, nr, chave, url = "https://ssw.inf.br/2/resultSSW") => {
    const pg = await pagina(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ cnpj, NR: nr, chave }).toString() });
    const ls = sohTexto(pg.txt), txt = ls.join(" ");
    log(`${rot}: ${pg.status} · ${lerEntrega(pg.txt).situacao} · NF na página: ${(txt.match(/N Fiscal/gi) || []).length} · datas: ${(txt.match(/\d{2}\/\d{2}\/\d{2}/g) || []).length} · senha inválida: ${/senha (inv|incorr)/i.test(txt) ? "sim" : "não"} · avisos: ${limpo(ls.filter((l) => /senha|permiss|dispon|inv[aá]lid|localiz/i.test(l)).join(" | ")).slice(0, 200)}`);
    await dorme(3000);
  };
  const [num, ser] = String(L[0].nf).split("-").map((x) => (x || "").trim());
  log("série:", ser, "· CNPJ final:", String(cnpjDaSerie(ser)).slice(-4));
  for (const l of L) { const [n, se] = String(l.nf).split("-").map((x) => (x || "").trim());
    await tenta(`série ${se} · sem senha`, cnpjDaSerie(se), n, "");
    await tenta(`série ${se} · com senha`, cnpjDaSerie(se), n, chaveDe(l.transportadora)); }
}
if (MODO === "diag-ajuda") {   // página pública de ajuda do SSW (sem dados de cliente)
  const p = await pagina("https://ssw.inf.br/ajuda/rastreamento.html");
  log("status:", p.status);
  log(p.txt.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/<[^>]+>/g, (t) => /form|input|textarea|action|name=/i.test(t) ? t : " ").replace(/\s+/g, " ").slice(0, 6000));
}
if (MODO === "diag-jadlog") {   // API da Jadlog: manual público + teste com 2 NFs (só status e nomes de campos)
  const manual = await pagina("http://integracoes.jadlog.com.br").catch((e) => ({ status: e.message, txt: "" }));
  log("manual:", manual.status, "· links:", tags(manual.txt, /href=["'][^"']+["']/gi).filter((h) => !/\.(css|png|ico|svg|js)/i.test(h)).slice(0, 30).join(" "));
  log("manual trechos:", tags(manual.txt, /[^<>]{0,60}(tracking|consultar|previs)[^<>]{0,80}/gi).slice(0, 15).join(" | ").replace(/\d{5,}/g, "#"));
  const tok = process.env.JADLOG_TOKEN || "";
  log("token:", tok ? `sim (${tok.length} caracteres)` : "não", "· usuário:", process.env.JADLOG_USUARIO ? "sim" : "não", "· código cliente:", process.env.JADLOG_CODIGO ? "sim" : "não");
  if (!tok) process.exit(0);
  await entrarSupabase();
  const L = await chamar("base_aberta?select=nf,transportadora&transportadora=ilike.*jadlog*&nf=not.is.null&limit=2");
  const chaves = (o, p = "") => o && typeof o === "object" ? Object.entries(o).flatMap(([k, v]) => Array.isArray(v) ? [`${p}${k}[${v.length}]`, ...chaves(v[0], `${p}${k}[0].`)] : v && typeof v === "object" ? chaves(v, `${p}${k}.`) : [`${p}${k}=${/^(data|dt|prev|status|descr|situa|tipo|erro|mensagem|message|error)/i.test(k) ? String(v).replace(/\d{5,}/g, "#").slice(0, 40) : typeof v}`]) : [];
  for (const l of L) {
    const [num, ser] = String(l.nf).split("-").map((x) => (x || "").trim());
    for (const body of [{ consulta: [{ df: { nf: num, serie: ser, tpDocumento: 2, cnpjRemetente: cnpjDaSerie(ser) } }] }]) {
      const r = await fetch("https://www.jadlog.com.br/embarcador/api/tracking/consultar", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` }, body: JSON.stringify(body) });
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
      log(`tracking/consultar: ${r.status} · ${j ? chaves(j).join(" | ").slice(0, 1800) : t.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/\d{5,}/g, "#").slice(0, 300)}`);
      await new Promise((ok) => setTimeout(ok, 2000));
    }
  }
}
if (MODO === "diag-bento") {   // rastreio da Bento Brasil: formulário e estrutura do resultado (sem dados de cliente)
  const URL_B = "https://sistema.bentobrasil.com.br/rastreamentoCarga.php";
  const f = await pagina(URL_B);
  log("form:", f.status, tags(f.txt, /<form[^>]*>|<input[^>]*>|<button[^>]*>|<select[^>]*>/gi).map((x) => x.replace(/value=["'][^"']{10,}["']/g, 'value="…"').replace(/class="[^"]*"|style="[^"]*"/g, "")).join(" | ").slice(0, 1500));
  log("scripts:", tags(f.txt, /<script[^>]*>[\s\S]{0,600}?<\/script>/gi).map((x) => x.replace(/\d{5,}/g, "#").slice(0, 500)).join(" || ").slice(0, 2500));
  await entrarSupabase();
  const L = await chamar("base_aberta?select=nf,transportadora&transportadora=ilike.*bento*&nf=not.is.null&limit=1");
  if (!L.length) process.exit(0);
  const num = String(L[0].nf).split("-")[0].trim();
  const acao = (f.txt.match(/<form[^>]*action=["']([^"']*)["']/i) || [])[1] || "";
  const nomes = tags(f.txt, /<input[^>]*>/gi).map((x) => (x.match(/name=["']([^"']+)["']/i) || [])[1]).filter(Boolean);
  log("action:", acao, "· campos:", nomes.join(", "));
  const corpo = new URLSearchParams(); nomes.forEach((n, i) => corpo.set(n, /cnpj|cpf|doc/i.test(n) ? "00349443000192" : /nf|nota|num/i.test(n) ? num : ""));
  if (nomes.length >= 2 && !/cnpj|cpf|doc/i.test(nomes.join())) { corpo.set(nomes[0], "00349443000192"); corpo.set(nomes[1], num); }
  const r = await pagina(new URL(acao || URL_B, URL_B).href, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: corpo.toString() });
  const ls = sohTexto(r.txt);
  log("resultado:", r.status, "· linhas:", ls.length, "· datas:", (r.txt.match(/\d{2}\/\d{2}\/\d{2,4}/g) || []).length, "· tem previsão:", /previs/i.test(r.txt) ? "sim" : "não", "· tem entreg:", /entreg/i.test(r.txt) ? "sim" : "não");
  log("textos:", ls.map((l) => limpo(l)).filter((l) => l.replace(/[x\s#]/g, "").length > 2).slice(0, 60).join(" | ").slice(0, 2500));
  const mj = r.txt.match(/dados = '([\s\S]*?)';/);
  if (mj) { let d = null; try { d = JSON.parse(mj[1]); } catch (e) { log("JSON:", e.message); }
    const um = Array.isArray(d) ? d[0] : d;
    log("dados:", Array.isArray(d) ? `lista de ${d.length}` : "objeto", "·", um ? Object.entries(um).map(([k, v]) => `${k}=${v === null ? "null" : /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? String(v).slice(0, 16) : typeof v}`).join(" | ") : ""); }
  log("scripts do resultado:", tags(r.txt, /<script[^>]*>[\s\S]*?<\/script>/gi).filter((x) => !/_gaq|jquery/i.test(x)).map((x) => x.replace(/\d{5,}/g, "#").replace(/\s+/g, " ").slice(0, 1500)).join(" || ").slice(0, 4000));
  const i0 = r.txt.search(/para a consulta/i);
  log("resultado html:", r.txt.slice(Math.max(0, i0 - 200), i0 + 3000).replace(/<script[\s\S]*?<\/script>/gi, "").replace(/>[^<]+</g, (t) => ">" + limpo(t.slice(1, -1)) + "<").replace(/class="[^"]*"|style="[^"]*"/g, "").replace(/\d{4,}/g, "#").replace(/\s+/g, " ").slice(0, 3000));
  log("cabeçalhos/links:", tags(r.txt, /<th[^>]*>[^<]{0,40}|<a [^>]*href=["'][^"']{0,120}["']|<iframe[^>]*>|<form[^>]*>/gi).map((x) => x.replace(/\d{4,}/g, "#")).slice(0, 30).join(" | "));
}
if (MODO === "diag-track3r") {   // documentação pública da API da Track3r (sem token): lista os métodos
  for (const u of ["https://api.track3r.com.br/", "https://api.track3r.com.br/swagger/index.html", "https://api.track3r.com.br/swagger/v2/swagger.json", "https://api.track3r.com.br/swagger/v1/swagger.json", "https://api.track3r.com.br/help", "https://api.track3r.com.br/v2/help", "https://api.track3r.com.br/swagger/docs/v2", "https://api.track3r.com.br/swagger/docs/v1"]) {
    const r = await pagina(u).catch((e) => ({ status: e.message, txt: "" }));
    let rotas = "";
    try { const j = JSON.parse(r.txt); rotas = Object.entries(j.paths || {}).map(([k, v]) => `${Object.keys(v).join("/").toUpperCase()} ${k}`).join(" | "); } catch {}
    log(u, "→", r.status, "·", rotas || r.txt.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 1500));
  }
}
if (MODO === "diag-form1") {   // formulário 1 da ajuda (ssw_resultSSW, sem senha): 1 NF e lote de NFs — só contagens
  await entrarSupabase();
  const P = await chamar("conferencia_ssw?select=nf,transportadora,situacao&situacao=in.(sem%20permissao,sem%20cte,fora%20do%20ssw)&limit=400");
  const porT = {}; P.forEach((x) => { const t = (x.transportadora || "?").slice(0, 25); (porT[t] ||= []).length < 2 && porT[t].push(x); });
  for (const [t, xs] of Object.entries(porT)) for (const x of xs) {
    const [n, se] = String(x.nf).split("-").map((v) => (v || "").trim()), c = cnpjDaSerie(se); if (!c) continue;
    const a = await pagina("https://ssw.inf.br/2/ssw_resultSSW", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ NR: n, cnpj: c, urlori: "https://ssw.inf.br/ajuda/rastreamento.html" }).toString() });
    await new Promise((ok) => setTimeout(ok, 2500));
    log(`${t} (${x.situacao}) → form1: ${lerEntrega(a.txt).situacao} · ${lerEntrega(a.txt).ultimo_evento || ""}`);
  }
  const L = await chamar("conferencia_ssw?select=nf,transportadora,situacao&nf=like.*-7&situacao=in.(entregue,nao%20entregue)&limit=20");
  const nums = L.map((l) => String(l.nf).split("-")[0].trim());
  log("NFs de teste (série 7):", nums.length, "· situações:", JSON.stringify(L.reduce((m, x) => (m[x.situacao] = (m[x.situacao] || 0) + 1, m), {})));
  const dorme = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const conta = (rot, txt) => { const ls = sohTexto(txt), t = ls.join("\n");
    log(`${rot}: linhas ${ls.length} · NFs achadas ${nums.filter((n) => new RegExp("\\b0*" + n + "\\b").test(t)).length}/${nums.length} · 'ENTREGUE' ${(t.match(/MERCADORIA ENTREGUE|ENTREGA REALIZADA/gi) || []).length} · datas ${(t.match(/\d{2}\/\d{2}\/\d{2}/g) || []).length} · previsão ${(t.match(/previs/gi) || []).length} · sem permissão ${/permiss/i.test(t) ? "sim" : "não"} · não disponível ${(t.match(/n[ãa]o dispon/gi) || []).length}`); };
  for (const [url, rot] of [["https://ssw.inf.br/2/ssw_resultSSW", "form1"], ["https://ssw.inf.br/2/resultSSW", "atual"]]) {
    const um = await pagina(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ NR: nums[0], cnpj: "00349443000192", urlori: "https://ssw.inf.br/ajuda/rastreamento.html" }).toString() });
    conta(`${rot} 1 NF (${um.status})`, um.txt); await dorme(3000);
    const lote = await pagina(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ NR: nums.join("\n"), cnpj: "00349443000192", urlori: "https://ssw.inf.br/ajuda/rastreamento.html" }).toString() });
    conta(`${rot} lote ${nums.length} NFs (${lote.status})`, lote.txt); await dorme(3000);
    if (rot === "form1") { const csvL = (lote.txt.match(/href="(\/2\/ssw_resultSSW\?[^"]*output=csv[^"]*)"/) || [])[1];
      if (csvL) { await dorme(3000); log("  cookie do lote:", lote.cookie ? "sim" : "não", "· link csv params:", [...new URL("https://ssw.inf.br" + csvL.replace(/&amp;/g, "&")).searchParams.keys()].join(","));
        let c = await pagina("https://ssw.inf.br" + csvL.replace(/&amp;/g, "&"), { headers: { Cookie: lote.cookie || "", Referer: "https://ssw.inf.br/2/ssw_resultSSW" } });
        if (c.txt.split(/\r?\n/).filter(Boolean).length <= 1) { await dorme(3000); const u = new URL("https://ssw.inf.br" + csvL.replace(/&amp;/g, "&"));
          c = await pagina("https://ssw.inf.br/2/ssw_resultSSW", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: lote.cookie || "" }, body: new URLSearchParams({ NR: nums.join("\n"), cnpj: "00349443000192", output: "csv" }).toString() });
          log("  (tentei por POST com output=csv)"); } const lin = c.txt.split(/\r?\n/).filter(Boolean);
        log(`  CSV (${c.status}): ${lin.length} linhas · cabeçalho: ${limpo(lin[0] || "").slice(0, 400)} · 'ENTREGUE' ${(c.txt.match(/ENTREGUE/gi) || []).length} · datas ${(c.txt.match(/\d{2}\/\d{2}\/\d{2}/g) || []).length} · previsão ${(c.txt.match(/previs/gi) || []).length}`);
        log("  colunas por linha:", lin.slice(0, 5).map((l) => l.split(/;|,|\t/).length).join(","), "· separador:", (lin[0] || "").includes(";") ? ";" : (lin[0] || "").includes("\t") ? "tab" : ","); } }
    if (rot === "form1") log("  estrutura lote:", tags(lote.txt, /<(table|tr|form|a)[^>]*>/gi).map((x) => x.replace(/\d{4,}/g, "#").replace(/class="[^"]*"|style="[^"]*"/g, "")).slice(0, 25).join(" "));
  }
}
if (MODO === "diag-emissor") {   // Trânsito Brasil "sem CT-e" na Senior: quem emitiu o CT-e no SSW (só rótulos e o nome da transportadora)
  await entrarSupabase();
  const L = await chamar("conferencia_ssw?select=nf,transportadora&transportadora=ilike.*sito*brasil*&situacao=eq.sem%20cte&limit=6");
  for (const l of L) {
    const [n, se] = String(l.nf).split("-").map((v) => (v || "").trim()), c = cnpjDaSerie(se); if (!c) continue;
    const a = await pagina("https://ssw.inf.br/2/resultSSW", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ cnpj: c, NR: n, chave: "" }).toString() });
    const e = lerEntrega(a.txt); log("SSW:", e.situacao, e.ultimo_evento || "");
    if (/sem cte|sem permissao/.test(e.situacao)) { await new Promise((ok) => setTimeout(ok, 2500)); continue; }
    log("  1ª página img/title:", tags(a.txt, /<img[^>]*(alt|title|src)=["'][^"']{0,80}["'][^>]*>|<title>[^<]*/gi).map((x) => x.replace(/\d{5,}/g, "#")).slice(0, 6).join(" | "));
    const det = (a.txt.match(/opx\('(\/2\/ssw_SSWDetalhado\?[^']+)'\)/) || [])[1];
    if (det) { await new Promise((ok) => setTimeout(ok, 2500)); const d = await pagina("https://ssw.inf.br" + det); const ls = sohTexto(d.txt);
      const i = ls.findIndex((x) => /transportador/i.test(x));
      log("  detalhe: rótulo transportadora na linha", i, "·", i >= 0 ? ls.slice(i, i + 3).map((x) => x.replace(/\d{5,}/g, "#").slice(0, 80)).join(" / ") : "", "· img/title:", tags(d.txt, /<img[^>]*(alt|title)=["'][^"']{0,80}["'][^>]*>|<title>[^<]*/gi).map((x) => x.replace(/\d{5,}/g, "#")).slice(0, 4).join(" | "));
      log("  unidades (siglas):", [...new Set((d.txt.match(/\(([A-Z]{2,5} [A-Z]{2,4}(?: \d{1,3})?)\)/g) || []))].join(" "));
      log("  linhas com emissão/transportadora:", ls.filter((x) => /emitid|emiss|transport|redespach|parceir/i.test(x)).map((x) => x.replace(/\d{5,}/g, "#").slice(0, 140)).slice(0, 8).join(" || "));
      const t1 = sohTexto(a.txt); log("  1ª página, linhas do evento:", t1.filter((x) => /\(([A-Z]{2,5} [A-Z]{2,4})/.test(x) || /^[A-Z ]{6,}$/.test(x.trim())).map((x) => x.replace(/\d{5,}/g, "#").slice(0, 100)).slice(0, 6).join(" || ")); }
    await new Promise((ok) => setTimeout(ok, 2500));
  }
}
if (MODO === "diag-det") {
  await entrarSupabase();
  const L = await chamar("base_aberta?select=nf,transportadora&order=pedido.desc&limit=3000");
  const vistos = {};
  for (const l of L) {
    if ((vistos[l.transportadora] || 0) >= 1) continue;
    const [num, ser] = String(l.nf).split("-"); const c = cnpjDaSerie(ser); if (!c) continue;
    const pg = await consultar(c, [num.trim()]);
    const det = (pg.txt.match(/opx\('(\/2\/ssw_SSWDetalhado\?[^']+)'\)/) || [])[1]; if (!det) continue;
    vistos[l.transportadora] = 1;
    const ls = sohTexto((await pagina("https://ssw.inf.br" + det.replace(/&amp;/g, "&"))).txt);
    const comData = ls.filter((x) => /prev|prazo|estimad|agend/i.test(x)).map(limpo).slice(0, 6);
    log(`${l.transportadora}: ${ls.length} linhas · com prev/prazo: ${comData.join(" | ") || "nenhuma"}`);
    log("   rótulos:", ls.filter((x) => !/\d/.test(x) && x.length < 30).slice(-25).map(limpo).join(" / "));
  }
}
if (MODO === "diag-api") {   // API do SSW com login da transportadora (Dominalog): só mostra status e nomes de campos
  const { DOMINALOG_DOMINIO: domain, DOMINALOG_USUARIO: username, DOMINALOG_SENHA: password, DOMINALOG_CNPJ: cnpjEdi } = process.env;
  log("Segredos:", ["DOMINIO", "USUARIO", "SENHA", "CNPJ"].map((k) => `${k} ${process.env["DOMINALOG_" + k] ? "ok" : "falta"}`).join(" · "));
  const chaves = (o, p = "") => o && typeof o === "object" ? Object.entries(o).flatMap(([k, v]) => Array.isArray(v) ? [`${p}${k}[${v.length}]`, ...chaves(v[0], `${p}${k}[0].`)] : v && typeof v === "object" ? chaves(v, `${p}${k}.`) : [`${p}${k}=${/data|prev|date|hora|status|ocorr|descr|situa|tipo|codigo|success|message|erro/i.test(k) ? String(v).replace(/\d{5,}/g, "#").slice(0, 40) : typeof v}`]) : [];
  const post = async (url, corpo, h = {}) => { const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...h }, body: JSON.stringify(corpo) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { st: r.status, j, t }; };
  let token = null;
  for (const corpo of [{ domain, username, password, cnpj_edi: cnpjEdi || "00349443000192" }, { domain, username, password }]) {
    const r = await post("https://ssw.inf.br/api/generateToken", corpo);
    log("generateToken:", r.st, r.j ? chaves(r.j).filter((k) => !/token=/.test(k)).join(" | ").slice(0, 400) : r.t.replace(/\d{5,}/g, "#").slice(0, 200));
    token = r.j && (r.j.token || (r.j.data && r.j.data.token)); if (token) break;
  }
  await entrarSupabase();
  const L = (await chamar("base_aberta?select=nf,transportadora&transportadora=ilike.dominalog*&limit=3")) || [];
  log("Notas Dominalog para teste:", L.length);
  for (const l of L.slice(0, 2)) {
    const [num, ser] = String(l.nf).split("-").map((x) => x.trim()); const c = cnpjDaSerie(ser);
    const tent = [["https://ssw.inf.br/api/tracking", { cnpj: c, nro_nf: num, senha: password }, {}],
      ...(token ? [["https://ssw.inf.br/api/tracking", { cnpj: c, nro_nf: num }, { Authorization: token }], ["https://ssw.inf.br/api/trackingpag", { cnpj: c, nro_nf: num }, { Authorization: token }]] : [])];
    for (const [u, corpo, h] of tent) {
      const r = await post(u, corpo, h);
      log(`${u.replace("https://ssw.inf.br", "")}${h.Authorization ? " (token)" : " (senha)"}: ${r.st} · ${r.j ? chaves(r.j).slice(0, 40).join(" | ").slice(0, 1500) : r.t.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/\d{5,}/g, "#").slice(0, 200)}`);
      await new Promise((ok) => setTimeout(ok, 2500));
    }
  }
}
if (MODO === "diag-ent") {   // como o SSW mostra a entrega (só datas e palavras de sistema)
  await entrarSupabase();
  const L = await chamar("previsao_ssw?select=nf&situacao=eq.entregue&limit=3");
  for (const l of L) {
    const [num, ser] = String(l.nf).split("-").map((x) => x.trim());
    const pg = await pagina("https://ssw.inf.br/2/resultSSW", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ cnpj: cnpjDaSerie(ser), NR: num, chave: "" }).toString() });
    const ls1 = sohTexto(pg.txt); const i1 = ls1.findIndex((x) => /entreg/i.test(x) && !/previs/i.test(x));
    log("1ª página, perto de ENTREG:", ls1.slice(Math.max(0, i1 - 4), i1 + 3).map(limpo).join(" / "));
    const det = (pg.txt.match(/opx\('(\/2\/ssw_SSWDetalhado\?[^']+)'\)/) || [])[1];
    if (det) { await new Promise((ok) => setTimeout(ok, 2500)); const ls = sohTexto((await pagina("https://ssw.inf.br" + det.replace(/&amp;/g, "&"))).txt);
      ls.forEach((x, i) => { if (/entreg/i.test(x) && !/previs/i.test(x)) log("  detalhe:", ls.slice(Math.max(0, i - 3), i + 2).map(limpo).join(" / ")); }); }
    await new Promise((ok) => setTimeout(ok, 2500));
  }
}
if (MODO === "diag-form") {
  const p = await pagina("https://ssw.inf.br/2/rastreamento?");
  const i = p.txt.search(/<form/i), f = p.txt.slice(i, p.txt.indexOf("</form>", i) + 7);
  log(f.replace(/<svg[\s\S]*?<\/svg>/gi, "").replace(/class="[^"]*"/g, "").replace(/\s+/g, " ").slice(0, 3500));
  tags(p.txt, /<script[^>]*>[\s\S]*?<\/script>/gi).forEach((t) => log("  script:", t));
}
if (MODO === "diag") {
  for (const u of ["https://ssw.inf.br/ajuda/rastreamento.html", "https://ssw.inf.br/2/rastreamento", "https://ssw.inf.br/2/rastreamento_pf"]) {
    try {
      const p = await pagina(u);
      log(`== ${u} -> ${p.status} ${p.url} (${p.txt.length} letras)`);
      tags(p.txt, /<form[^>]*>/gi).forEach((t) => log("  form:", t));
      tags(p.txt, /<input[^>]*>/gi).slice(0, 30).forEach((t) => log("  input:", t));
      tags(p.txt, /<select[^>]*>/gi).forEach((t) => log("  select:", t));
      tags(p.txt, /<a [^>]*href="[^"]*(rastre|track|ssw)[^"]*"[^>]*>/gi).slice(0, 30).forEach((t) => log("  link:", t));
      tags(p.txt, /(action|url|href)\s*[:=]\s*["'][^"']*(result|rastre)[^"']*["']/gi).slice(0, 20).forEach((t) => log("  js:", t));
    } catch (e) { log(`== ${u}: erro ${e.message}`); }
  }
  // links de rastreio da base: só os sites (hosts), para ver quais transportadoras usam SSW
  try {
    await entrarSupabase();
    const linhas = await chamar("base_pedidos?select=transportadora,link_rastreio&limit=5000");
    const hosts = {};
    for (const l of linhas) { let h = "sem link"; try { if (l.link_rastreio) h = new URL(l.link_rastreio).host + new URL(l.link_rastreio).pathname.replace(/[^/]{6,}/g, "*").slice(0, 40); } catch { h = "link estranho"; }
      const k = `${h} · ${l.transportadora || "?"}`; hosts[k] = (hosts[k] || 0) + 1; }
    Object.entries(hosts).sort((a, b) => b[1] - a[1]).slice(0, 60).forEach(([k, n]) => log(`  base: ${n} × ${k}`));
  } catch (e) { log("Base:", e.message); }
}

// ---- de verdade: consulta todos os pedidos em aberto, 1 NF por vez, e grava a previsão no painel ----
function lerResultado(txt) {
  const ls = sohTexto(txt);
  if (ls.some((l) => /n[ãa]o tem permiss[ãa]o/i.test(l))) return { situacao: "sem permissao" };
  const datas = [...ls.join("\n").matchAll(/Previs[aã]o de entrega:\s*(\d{2})\/(\d{2})\/(\d{2,4})/gi)];
  const entregue = ls.some((l) => /mercadoria entregue|entrega realizada/i.test(l));
  if (datas.length) { const [, d, m, a] = datas[datas.length - 1]; return { situacao: entregue ? "entregue" : "previsao", previsao: `${a.length === 2 ? "20" + a : a}-${m}-${d}` }; }
  if (entregue) return { situacao: "entregue" };
  if (ls.some((l) => /informa[cç][aã]o n[ãa]o dispon[ií]vel/i.test(l))) return { situacao: "sem cte" };
  return { situacao: "sem previsao" };
}
if (MODO === "real") {
  await entrarSupabase();
  await conferir(60).catch((e) => log("Conferência SSW:", e.message.slice(0, 120)));
  const todos = [];
  for (let de = 0; ; de += 1000) { const L = await chamar(`base_aberta?select=pedido,nf,transportadora,status_intelipost,micro_status,data_entrega,prev_original,prev_atual&nf=not.is.null&order=pedido&limit=1000&offset=${de}`); todos.push(...L); if (L.length < 1000) break; }
  // só os pedidos em aberto: fora os entregues e cancelados (status, micro status ou data de entrega preenchida)
  const fechado = (l) => /\bentregue\b|cancelad|entrega realizada/i.test(`${l.status_intelipost || ""} ${l.micro_status || ""}`) || !!l.data_entrega;
  const abertos = todos.filter((l) => !fechado(l));
  log(`Entregues ou cancelados deixados de fora: ${(todos.length - abertos.length).toLocaleString("pt-BR")}`);
  let fila = abertos.map((l) => { const [num, ser] = String(l.nf).split("-").map((x) => (x || "").trim()); return { ...l, num, c: cnpjDaSerie(ser) }; }).filter((l) => l.num && l.c);
  for (const [EH, fn] of [[EH_JADLOG, process.env.JADLOG_TOKEN ? jadlog : null], [EH_BENTO, bento], [EH_TRANSITO, transito]]) if (fn) {   // Jadlog (API) e Bento (site): antes do SSW
    const jad = fila.filter((l) => EH.test(l.transportadora || "")); fila = fila.filter((l) => !EH.test(l.transportadora || ""));
    const m = await fn(jad), linhas = jad.filter((l) => m.has(l.pedido)).map((l) => { const r = m.get(l.pedido);
      return { pedido: l.pedido, nf: l.nf, previsao: r.previsao || null, situacao: r.situacao === "entregue" ? "entregue" : r.previsao ? "previsao" : r.situacao === "sem cte" ? "sem cte" : "sem previsao" }; });
    for (let i = 0; i < linhas.length; i += 100) await chamar("rpc/gravar_ssw", "POST", { linhas: linhas.slice(i, i + 100) }).catch((e) => log("Não gravei um lote Jadlog:", e.message.slice(0, 120)));
  }
  const ja = new Map();
  for (let de = 0; ; de += 1000) { const L = await chamar(`previsao_ssw?select=pedido,consultado_em,situacao&order=pedido&limit=1000&offset=${de}`); L.forEach((x) => ja.set(x.pedido, x)); if (L.length < 1000) break; }
  const recente = (l) => { const x = ja.get(l.pedido); return x && x.situacao !== "sem previsao" && Date.now() - Date.parse(x.consultado_em) < 20 * 3600000; };
  fila.sort((a, b) => (recente(a) - recente(b)) || String(a.prev_original || a.prev_atual || "9999").localeCompare(String(b.prev_original || b.prev_atual || "9999")));
  if (Number(process.env.SSW_LIMITE) > 0) fila.splice(Number(process.env.SSW_LIMITE));   // teste: só os N primeiros
  log(`Pedidos em aberto: ${abertos.length.toLocaleString("pt-BR")} · com série conhecida: ${fila.length.toLocaleString("pt-BR")}`);
  const porT = {}, cont = {}, grava = [];
  const salvar = async (forca) => { if (grava.length >= 100 || (forca && grava.length)) { const lote = grava.splice(0); try { await chamar("rpc/gravar_ssw", "POST", { linhas: lote }); } catch (e) { log("Não gravei um lote:", e.message.slice(0, 120)); } } };
  // o SSW bloqueia (403) quem consulta rápido demais: 1 consulta por vez, com pausa; se bloquear, espera e tenta de novo
  const PAUSA = Number(process.env.SSW_PAUSA || 2500);
  const ESPERAS = [3, 10, 20];   // minutos de espera a cada bloqueio seguido; depois disso para e continua na próxima rodada
  const dorme = (ms) => new Promise((ok) => setTimeout(ok, ms));
  let feitos = 0, bloqueios = 0; const t0 = Date.now();
  const pegar = async (url, opts) => {
    for (let k = 0; ; k++) {
      const pg = await pagina(url, opts);
      if (pg.status !== 403 && pg.status !== 429) { bloqueios = 0; return pg; }
      if (k >= ESPERAS.length) throw Object.assign(new Error("bloqueado"), { bloqueado: true });
      log(`SSW bloqueou (${pg.status}) depois de ${feitos.toLocaleString("pt-BR")} consultas em ${Math.round((Date.now() - t0) / 60000)} min; espero ${ESPERAS[k]} min.`);
      await dorme(ESPERAS[k] * 60000);
    }
  };
  const pendCf = new Set(), gravaCf = [];
  try { for (let de = 0; ; de += 1000) { const L = await chamar(`conferencia_ssw?select=pedido&situacao=eq.pendente&order=pedido&limit=1000&offset=${de}`); L.forEach((x) => pendCf.add(x.pedido)); if (L.length < 1000) break; } } catch {}
  const fimEm = Date.now() + Number(process.env.SSW_MINUTOS || 80) * 60000;
  for (const l of fila) {
    if (Date.now() > fimEm) { log("Tempo da rodada acabou; o resto fica para a próxima."); break; }
    const t = l.transportadora || "?"; const st = (porT[t] ||= { n: 0, fora: 0 });
    let r;
    if (FORA_SSW.test(t)) r = { situacao: "fora do ssw" };   // transportadora que não usa SSW: nem consulta
    else if (st.n >= 8 && st.fora === st.n) r = { situacao: "sem permissao" };   // as 8 primeiras pedem senha: pula a transportadora nesta rodada
    else {
      try {
        const pg = await pegar("https://ssw.inf.br/2/resultSSW", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ cnpj: l.c, NR: l.num, chave: chaveDe(l.transportadora) }).toString() });
        r = lerResultado(pg.txt);
        if (pendCf.has(l.pedido)) { pendCf.delete(l.pedido); const e = lerEntrega(pg.txt);   // aproveita a mesma consulta para a aba Conferência SSW
          gravaCf.push({ pedido: l.pedido, situacao: e.situacao, ultimo_evento: e.ultimo_evento || null, data_evento: e.data_evento || null, data_entrega: e.data_entrega || null });
          if (gravaCf.length >= 50) await chamar("rpc/gravar_conferencia", "POST", { linhas: gravaCf.splice(0) }).catch(() => {}); }
        // a 1ª página mostra só o último evento: a previsão fica no histórico completo (link "ssw_SSWDetalhado")
        const det = (pg.txt.match(/opx\('(\/2\/ssw_SSWDetalhado\?[^']+)'\)/) || [])[1];
        if (det && !r.previsao && !/fora do ssw|sem cte|sem permissao/.test(r.situacao)) {
          await dorme(PAUSA);
          const r2 = lerResultado((await pegar("https://ssw.inf.br" + det.replace(/&amp;/g, "&"))).txt);
          if (r2.previsao || r2.situacao === "entregue") r = r2;
        }
      } catch (e) {
        if (e.bloqueado) { log("O SSW continua bloqueando; paro aqui e continuo na próxima rodada."); break; }
        r = null;
      }
      await dorme(PAUSA);
      if (!r) continue;
      st.n++; if (/sem permissao/.test(r.situacao)) st.fora++;
    }
    cont[r.situacao] = (cont[r.situacao] || 0) + 1;
    grava.push({ pedido: l.pedido, nf: l.nf, previsao: r.previsao || null, situacao: r.situacao });
    if (++feitos % 250 === 0) log(`${feitos.toLocaleString("pt-BR")} de ${fila.length.toLocaleString("pt-BR")} em ${Math.round((Date.now() - t0) / 60000)} min · com previsão ${cont.previsao || 0}`);
    await salvar(false);
  }
  await salvar(true);
  if (gravaCf.length) await chamar("rpc/gravar_conferencia", "POST", { linhas: gravaCf.splice(0) }).catch(() => {});
  log("Resultado:", Object.entries(cont).map(([k, v]) => `${k} ${v}`).join(" · "));
  log("Transportadoras fora do SSW (ou com senha):", Object.entries(porT).filter(([, v]) => v.n && v.fora === v.n).map(([k]) => k).join(", ") || "nenhuma");
}

// ---- aba Conferência SSW: a lista importada pela Logística (entregue ou não no SSW) ----
function lerEntrega(txt) {
  const ls = sohTexto(txt);
  if (ls.some((l) => /n[ãa]o tem permiss[ãa]o/i.test(l))) return { situacao: "sem permissao" };
  if (ls.some((l) => /informa[cç][aã]o n[ãa]o dispon[ií]vel/i.test(l))) return { situacao: "sem cte" };
  const iso = (d) => { const [dd, mm, aa] = d.split("/"); return `${aa.length === 2 ? "20" + aa : aa}-${mm}-${dd}`; };
  const ehData = (l) => /^\d{2}\/\d{2}\/\d{2,4}$/.test(l);
  const iEnt = ls.findIndex((l) => /MERCADORIA ENTREGUE|ENTREGA REALIZADA/i.test(l) && !/previs/i.test(l));
  if (iEnt >= 0) { let d = (ls[iEnt].match(/\d{2}\/\d{2}\/\d{2,4}/) || [])[0] || null; for (let k = iEnt - 1; !d && k >= Math.max(0, iEnt - 4); k--) if (ehData(ls[k])) { d = ls[k]; break; }
    return { situacao: "entregue", data_entrega: d ? iso(d) : null, data_evento: d ? iso(d) : null, ultimo_evento: "MERCADORIA ENTREGUE" }; }
  const iD = ls.findIndex(ehData);
  if (iD < 0) return { situacao: "nao entregue" };
  const ev = (ls.slice(iD + 1, iD + 4).find((l) => /^[A-ZÀ-Ú][A-ZÀ-Ú0-9 \-\/.]{3,}/.test(l) && !/^\d/.test(l)) || "").replace(/\s*\(.*$/, "").trim();
  return { situacao: "nao entregue", data_evento: iso(ls[iD]), ultimo_evento: /^[A-ZÀ-Ú0-9 \-\/.]{4,60}$/.test(ev) ? ev : null };
}
async function conferir(minutos) {
  // confere TODOS os pendentes, os de previsão mais antiga primeiro (vencidos e urgentes saem antes)
  const lista = [];
  for (let de = 0; ; de += 1000) { const L = await chamar(`conferencia_ssw?select=pedido,nf,transportadora&situacao=eq.pendente&order=prev_cliente.asc.nullsfirst,pedido&limit=1000&offset=${de}`); lista.push(...L); if (L.length < 1000) break; }
  // "Informação não disponível" = a transportadora ainda não emitiu o CT-e: confere de novo depois (1 vez a cada 20 h), depois dos pendentes
  { const antes = new Date(Date.now() - 20 * 3600000).toISOString();
    const L = await chamar(`conferencia_ssw?select=pedido,nf,transportadora,situacao&situacao=in.(fora%20do%20ssw,sem%20cte,sem%20permissao)&consultado_em=lt.${antes}&order=prev_cliente.asc.nullsfirst&limit=1000`).catch(() => []);
    const de_novo = L.filter((x) => !FORA_SSW.test(x.transportadora || "") && (!/sem permissao/.test(x.situacao || "") || chaveDe(x.transportadora)));
    // "Pede senha" de transportadora com senha cadastrada: confere já, sem esperar 20 h
    for (let de = 0; ; de += 1000) { const P = await chamar(`conferencia_ssw?select=pedido,nf,transportadora,situacao&situacao=eq.sem%20permissao&consultado_em=gte.${antes}&order=pedido&limit=1000&offset=${de}`).catch(() => []);
      de_novo.unshift(...P.filter((x) => chaveDe(x.transportadora))); if (P.length < 1000) break; }
    lista.unshift(...de_novo.filter((x) => x.situacao === "sem permissao")); lista.push(...de_novo.filter((x) => x.situacao !== "sem permissao"));
    if (de_novo.length) log(`Conferência SSW: ${de_novo.length.toLocaleString("pt-BR")} sem CT-e na última consulta para conferir de novo.`); }
  if (!lista.length) { log("Conferência SSW: nada pendente."); return; }
  for (const [EH, fn, nome] of [[EH_JADLOG, process.env.JADLOG_TOKEN ? jadlog : null, "jadlog"], [EH_BENTO, bento, "bento"], [EH_TRANSITO, transito, "sito*brasil"]]) if (fn) {   // Jadlog (API) e Bento (site): antes do SSW
    const jad = lista.filter((l) => EH.test(l.transportadora || ""));
    // fora do SSW e rápido: confere de novo toda a transportadora que ainda não foi entregue
    for (let de = 0; ; de += 1000) { const L = await chamar(`conferencia_ssw?select=pedido,nf,transportadora,detalhe&transportadora=ilike.*${nome}*&${nome === "jadlog" ? "or=(situacao.neq.entregue,detalhe.is.null)" : "situacao=neq.entregue"}&order=pedido&limit=1000&offset=${de}`).catch(() => []);
      L.forEach((x) => { if (!(x.detalhe && x.detalhe.emissor) && !jad.some((y) => y.pedido === x.pedido)) jad.push(x); }); if (L.length < 1000) break; }
    // ajuste único de 13/11 (carta de correção): pedidos já passados para a transportadora que emitiu o CT-e não são mais mexidos aqui
    for (let i = jad.length - 1; i >= 0; i--) if (jad[i].detalhe && jad[i].detalhe.emissor) jad.splice(i, 1);
    for (let i = lista.length - 1; i >= 0; i--) if (EH.test(lista[i].transportadora || "")) lista.splice(i, 1);
    const m = await fn(jad), linhas = jad.filter((l) => m.has(l.pedido)).map((l) => { const r = m.get(l.pedido);
      return { pedido: l.pedido, situacao: r.situacao, ultimo_evento: r.ultimo_evento || null, data_evento: r.data_evento || null, data_entrega: r.data_entrega || null, detalhe: r.detalhe ? { ...r.detalhe, previsao: r.previsao || r.detalhe.previsao || null } : null }; });
    for (let i = 0; i < linhas.length; i += 50) await chamar("rpc/gravar_conferencia", "POST", { linhas: linhas.slice(i, i + 50) }).catch((e) => log("Não gravei um lote Jadlog:", e.message.slice(0, 120)));
  }
  { // transportadora fora do SSW (Bento, Formato, Transiga, Trânsito Brasil): desfaz resultados antigos do SSW (eram da first mile)
    const F = [];
    for (let de = 0; ; de += 1000) { const P = await chamar(`conferencia_ssw?select=pedido,transportadora,situacao&situacao=not.in.(fora%20do%20ssw,sem%20nf)&or=(transportadora.ilike.*formato*,transportadora.ilike.*transiga*)&order=pedido&limit=1000&offset=${de}`).catch(() => []); F.push(...P); if (P.length < 1000) break; }
    const fx = F.filter((x) => FORA_SSW.test(x.transportadora || "")).map((x) => ({ pedido: x.pedido, situacao: "fora do ssw", ultimo_evento: null, data_evento: null, data_entrega: null }));
    for (let i = 0; i < fx.length; i += 50) await chamar("rpc/gravar_conferencia", "POST", { linhas: fx.slice(i, i + 50) }).catch(() => {});
    if (fx.length) log(`Conferência SSW: ${fx.length.toLocaleString("pt-BR")} de transportadora fora do SSW corrigidos.`);
    const tira = new Set(fx.map((x) => x.pedido)); for (let i = lista.length - 1; i >= 0; i--) if (tira.has(lista[i].pedido)) lista.splice(i, 1);
  }
  log(`Conferência SSW: ${lista.length.toLocaleString("pt-BR")} pedido(s) para conferir.`);
  const PAUSA = Number(process.env.SSW_PAUSA || 2500), fim = Date.now() + minutos * 60000, cont = {}, grava = [];
  const dorme = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const salvar = async () => { if (grava.length) { const lote = grava.splice(0); try { await chamar("rpc/gravar_conferencia", "POST", { linhas: lote }); } catch (e) { log("Não gravei um lote:", e.message.slice(0, 120)); } } };
  let bloq = 0;
  for (const l of lista) {
    if (Date.now() > fim) { log("Tempo acabou; o resto fica para a próxima rodada."); if (MODO === "conferencia") (await import("node:fs")).writeFileSync("continuar", "1"); break; }
    const [num, ser] = String(l.nf || "").split("-").map((x) => (x || "").trim());
    const c = cnpjDaSerie(ser);
    let r;
    if (FORA_SSW.test(l.transportadora || "")) r = { situacao: "fora do ssw" };   // não usa SSW: nem consulta
    else if (!num || !c) r = { situacao: "sem nf" };
    else {
      const pg = await pagina("https://ssw.inf.br/2/resultSSW", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ cnpj: c, NR: num, chave: chaveDe(l.transportadora) }).toString() }).catch(() => null);
      if (!pg) { await dorme(PAUSA); continue; }
      if (pg.status === 403 || pg.status === 429) {
        if (++bloq > 3) { log("O SSW continua bloqueando; paro e continuo na próxima rodada."); break; }
        log(`SSW bloqueou; espero ${bloq * 5} min.`); await dorme(bloq * 5 * 60000); continue;
      }
      bloq = 0; r = lerEntrega(pg.txt); await dorme(PAUSA);
    }
    cont[r.situacao] = (cont[r.situacao] || 0) + 1;
    grava.push({ pedido: l.pedido, situacao: r.situacao, ultimo_evento: r.ultimo_evento || null, data_evento: r.data_evento || null, data_entrega: r.data_entrega || null });
    if (grava.length >= 50) await salvar();
  }
  await salvar();
  log("Conferência SSW:", Object.entries(cont).map(([k, v]) => `${k} ${v}`).join(" · "));
}
if (MODO === "conferencia") { await entrarSupabase(); await conferir(Number(process.env.SSW_MINUTOS || 320)); }
if (MODO === "jadlog") {   // só a Jadlog pela API (conferência), sem tocar no SSW
  await entrarSupabase(); process.env.SSW_MINUTOS = "0"; await conferir(0);
}
