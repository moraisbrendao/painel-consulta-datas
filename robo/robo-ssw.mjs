// Robô da conferência SSW: lê a previsão de entrega no rastreio público do SSW (ssw.inf.br)
// pela NF (sem a série) + CNPJ do remetente (escolhido pela série da NF).
// Registro público (Actions): só contagens, nomes de campos e datas — nunca nome, endereço ou NF.
import { entrarSupabase, chamar, chamarFaixa, gravarEstado } from "./supa.mjs";
const MODO = process.env.MODO || "diag";
let ultimaLinha = "";
const log = (...a) => { const t = a.map((x) => String(x).replace(/\d{5,}/g, "#####")).join(" "); ultimaLinha = t; console.log(t); };
// aviso verde no painel: robô começou / terminou (só nome do robô, horário e a última linha do registro, que já é mascarada)
const ANDAMENTO = { aguardando: "Fila Aguardando entrega (AE e AT)", "conferencia-tudo": "Conferir tudo agora (SSW)", "repo-itens": "Itens da reposição (Multi360)", barrar: "Barrar entrega: conferir", faltas: "Falta de volumes: retornos", "barrar-portal": "Barrar entrega: portal", transportadora: "Conferência de uma transportadora", naoloc: "Nota não localizada", "naoloc-teste": "Nota não localizada (teste)" }[MODO];
if (ANDAMENTO) {
  const inicio = new Date().toISOString(); let fechou = false;
  try { await entrarSupabase(); await gravarEstado("andamento:" + MODO, { robo: ANDAMENTO, rodando: true, inicio }); } catch (_) {}
  const fim = async (resumo) => { if (fechou) return; fechou = true; await gravarEstado("andamento:" + MODO, { robo: ANDAMENTO, rodando: false, inicio, fim: new Date().toISOString(), resumo: String(resumo || "").slice(0, 220) }).catch(() => {}); };
  process.on("beforeExit", () => fim(ultimaLinha));
  process.on("uncaughtException", async (e) => { log("Parou com erro:", String(e && e.message).split("\n")[0].replace(/\d{4,}/g, "#").slice(0, 200)); await fim("Parou com erro: " + String(e && e.message).split("\n")[0].slice(0, 120)); process.exit(1); });
  process.on("unhandledRejection", async (e) => { log("Parou com erro:", String(e && e.message).split("\n")[0].replace(/\d{4,}/g, "#").slice(0, 200)); await fim("Parou com erro: " + String(e && e.message).split("\n")[0].slice(0, 120)); process.exit(1); });
}
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
const SENHAS = [[/sua\s*log/i, process.env.SSW_SENHA_TRANSSUA || ""], [/^\s*vm\b|vm transportes/i, process.env.SSW_SENHA_VM || ""], [/aceville/i, process.env.SSW_SENHA_ACEVILLE || ""], [/dominalog/i, process.env.SSW_SENHA_DOMINALOG || ""], [/flog/i, process.env.SSW_SENHA_FLOG || ""]];
// senhas cadastradas no painel (parte 23) completam as dos segredos do GitHub
const normT = (t) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
async function carregarSenhasDB() {
  if (carregarSenhasDB.ok) return; carregarSenhasDB.ok = true;
  const L = await chamar("senhas_rastreio?select=transportadora,senha").catch(() => []);
  for (const x of L || []) { const k = normT(x.transportadora); if (k && x.senha) SENHAS.push([{ test: (t) => { const n = normT(t); return !!n && (n.includes(k) || k.includes(n)); } }, x.senha]); }
  if ((L || []).length) log("Senhas de rastreio do painel:", L.length);
}
const chaveDe = (transp) => (SENHAS.find(([re, s]) => s && re.test(transp || "")) || [, ""])[1];
// transportadoras que não usam SSW (regra da Brenda): nem consulta; nas outras, "Informação não disponível" = CT-e ainda não emitido
const FORA_SSW = /transiga/i;   // Transiga: rastreio chega por webhook. A Formato tem rastreio próprio (função formato), nunca SSW
// Trânsito Brasil não usa SSW: consulta no rastreio dela (Senior), pela NF + CNPJ (série 35 → ...1083, outras → ...0192); só vale se a série bater
const EH_TRANSITO = /tr[aâ]nsito\s*brasil/i;
async function transito(itens) {
  const out = new Map(); if (!itens.length) return out; let ssw_emissor = 0;
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
    if (!t && MODO === "transito-cte") {   // AJUSTE ÚNICO (13/11): não está na Senior: pode ter tido carta de correção e outra transportadora emitiu o CT-e no SSW (regra da Brenda)
      const c = cnpjDaSerie(ser); let r = { situacao: "sem cte" };
      if (c) {
        await dorme(2500);
        const a = await pagina("https://ssw.inf.br/2/resultSSW", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ cnpj: c, NR: num, chave: "" }).toString() }).catch(() => null);
        const e = a && a.status === 200 ? lerEntrega(a.txt) : null;
        if (e && !/sem cte|sem permissao/.test(e.situacao)) {
          const det = (a.txt.match(/opx\('(\/2\/ssw_SSWDetalhado\?[^']+)'\)/) || [])[1]; let emissor = null;
          if (det) { await dorme(2500); const d = await pagina("https://ssw.inf.br" + det).catch(() => null); emissor = d && ((sohTexto(d.txt).join("\n").match(/transportando a sua mercadoria:\s*([^\n]+)/i) || [])[1] || "").trim().slice(0, 60) || null; }
          r = { ...e, detalhe: { fonte: "SSW", emissor } };
          ssw_emissor++;
        }
      }
      out.set(l.pedido, r);
    }
    else if (!t) out.set(l.pedido, { situacao: "sem cte" });
    else {
      const tr = t.x.tracking, prev = dia(tr.dataPrevisaoEntrega), ult = t.fases[t.fases.length - 1];
      const detalhe = { fonte: "Trânsito Brasil", codigo: tr.codigo || null, status: tr.situacao && tr.situacao.descricao || null, previsao: prev,
        eventos: t.fases.map((f) => ({ data: String(f.dataExecucao).replace("T", " ").slice(0, 16), status: f.fase && f.fase.descricao || "", unidade: "" })) };
      if (tr.dataEntrega) out.set(l.pedido, { situacao: "entregue", data_entrega: dia(tr.dataEntrega), data_evento: dia(tr.dataEntrega), ultimo_evento: "ENTREGUE", previsao: prev, detalhe });
      else out.set(l.pedido, { situacao: "nao entregue", data_evento: ult ? dia(ult.dataExecucao) : null, ultimo_evento: ult && ult.fase ? String(ult.fase.descricao || "").toUpperCase().slice(0, 60) : null, previsao: prev, detalhe });
    }
    await dorme(1000);
  }
  const cont = {}; out.forEach((v) => (cont[v.situacao] = (cont[v.situacao] || 0) + 1));
  log("Trânsito Brasil (Senior):", Object.entries(cont).map(([k, v]) => `${k} ${v}`).join(" · ") || "nada", MODO === "transito-cte" ? `· CT-e de outra transportadora no SSW: ${ssw_emissor}` : "");
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
// Formato (transformato.com.br): área do cliente com login (segredos FORMATO_USUARIO / FORMATO_SENHA); Consulta NF pelo número, 1 por vez com pausa
const EH_FORMATO = /formato/i;
const isoFmt = (d) => { const m = String(d || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); if (!m) return null; const a = m[3].length === 2 ? "20" + m[3] : m[3]; return `${a}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`; };
function lerFormato(txt) {
  const L = sohTexto(String(txt || ""));
  if (L.some((x) => /nota fiscal n.{1,2}o encontrada/i.test(x))) return { situacao: "sem cte" };
  const rot = (re) => { const x = L.find((y) => re.test(y)); return x ? isoFmt(x.replace(re, "")) : null; };
  const emitido = rot(/^.*CT-?E emitido em:?/i), embarque = rot(/^.*Embarcado em:?/i), deposito = rot(/^.*Em dep.{1,2}sito na unid[^:]*:/i), rota = rot(/^.*Em entrega na unid[^:]*:/i);
  const prevL = L.find((y) => /Previs.{1,2}o[^:]*de Entrega:/i.test(y)), previsao = prevL ? isoFmt(prevL.split(/:/).slice(1).join(":")) : null;
  if (!emitido && !embarque) return { situacao: "sem cte" };
  const iE = L.findIndex((y) => /^Entregue\.?$/i.test(y) || /^Entregue em\b/i.test(y));
  const dEnt = iE >= 0 ? isoFmt(L.slice(iE, iE + 3).join(" ")) : null;
  const eventos = [[emitido, "CT-e emitido"], [embarque, "Embarcado"], [deposito, "Em depósito na unidade"], [rota, "Saiu para entrega"], [dEnt, "Entregue"]].filter(([d]) => d).map(([d, st]) => ({ data: d.split("-").reverse().join("/"), status: st, unidade: "" }));
  const detalhe = { fonte: "Formato", previsao, eventos };
  if (emitido && emitido < new Date(Date.now() - 150 * 86400000).toISOString().slice(0, 10)) return { situacao: "sem cte", detalhe: { fonte: "Formato", antigo: true } };   // CT-e muito antigo: outra nota com o mesmo número
  if (dEnt) return { situacao: "entregue", data_entrega: dEnt, data_evento: dEnt, ultimo_evento: "ENTREGUE", previsao, detalhe };
  const ult = rota ? [rota, "SAIU PARA ENTREGA"] : deposito ? [deposito, "EM DEPOSITO NA UNIDADE"] : embarque ? [embarque, "EMBARCADO"] : [emitido, "CT-E EMITIDO"];
  return { situacao: "nao entregue", data_evento: ult[0], ultimo_evento: ult[1], previsao, detalhe };
}
let formatoCk = null, formatoFalhou = false;
async function formatoLogin() {   // login pelo navegador (o site só aceita o login vindo do formulário); depois as consultas usam o cookie da sessão
  if (formatoCk || formatoFalhou) return formatoCk;
  const US = process.env.FORMATO_USUARIO || "", SE = process.env.FORMATO_SENHA || "";
  if (!US || !SE) { formatoFalhou = true; log("Formato: faltam os segredos FORMATO_USUARIO / FORMATO_SENHA."); return null; }
  let nav = null;
  try {
    const { chromium } = await import("playwright");
    nav = await chromium.launch(); const ctx = await nav.newContext(); const pg = await ctx.newPage();
    await pg.goto("https://www.transformato.com.br/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await pg.locator("#username").fill(US); await pg.locator("#password").fill(SE);
    await Promise.all([pg.waitForURL(/consultaweb/i, { timeout: 30000 }).catch(() => {}), pg.locator("#flogin input[type=submit]").click()]);
    if (!/consultaweb/i.test(pg.url())) { formatoFalhou = true; log("Formato: o login não entrou; não tento de novo nesta rodada."); return null; }
    formatoCk = (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
    return formatoCk;
  } catch (e) { formatoFalhou = true; log("Formato: não consegui abrir o navegador para o login:", String(e.message).slice(0, 80)); return null; }
  finally { if (nav) await nav.close().catch(() => {}); }
}
// Follow-Up das Entregas: 1 consulta traz todas as notas dos últimos 180 dias (nota, CT-e, coleta, previsão, entregue, data, ocorrência, status)
let formatoRel = null;
async function formatoRelatorio() {
  if (formatoRel) return formatoRel;
  const ck = await formatoLogin(); if (!ck) return null;
  const hoje = new Date(Date.now() - 3 * 3600000), f = (d) => d.toISOString().slice(0, 10).split("-").reverse().join("/");
  const r = await pagina("https://www.transformato.com.br/relfollowup.asp", { method: "POST", headers: { Cookie: ck, "Content-Type": "application/x-www-form-urlencoded", Referer: "https://www.transformato.com.br/relfollowup.asp" },
    body: new URLSearchParams({ dataini: f(new Date(hoje - 180 * 86400000)), datafin: f(hoje), naoent: "", nota: "", tipos: "N", tipodata: "E", agenda: "T", submit: "Listar" }).toString() }).catch(() => null);
  if (!r || r.status !== 200) { log("Formato: o Follow-Up não respondeu", r ? r.status : ""); return null; }
  const cel = (h) => sohTexto("<x>" + h + "</x>").join(" ").trim();
  const m = new Map();
  for (const tr of r.txt.split(/<tr[\s>]/i).slice(1)) {
    const c = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => cel(x[1])); if (c.length !== 14) continue;
    const num = c[0].replace(/\D/g, "").replace(/^0+(?=\d)/, ""); if (!num) continue;
    const ent = /^SIM/i.test(c[9]), st = c[13], prev = isoFmt(c[8]), coleta = isoFmt(c[7]);
    const oco = (st.match(/Oco:\s*\d*\s*(.+?)\s+em:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i) || []);
    let res;
    if (ent) { const de = isoFmt(c[10]) || isoFmt(st); res = { situacao: "entregue", data_entrega: de, data_evento: de, ultimo_evento: "ENTREGUE", previsao: prev }; }
    else if (/CT-?e Emitido/i.test(st) && !oco[1]) res = { situacao: "nao entregue", data_evento: coleta, ultimo_evento: "CT-E EMITIDO", previsao: prev };
    else res = { situacao: "nao entregue", data_evento: isoFmt(oco[2]) || coleta, ultimo_evento: (oco[1] || st).toUpperCase().replace(/\s+/g, " ").slice(0, 60) || null, previsao: prev };
    res.detalhe = { fonte: "Formato", previsao: prev, cte: c[1] || null, eventos: [[coleta, "Coleta"], [res.situacao === "entregue" ? null : res.data_evento, res.ultimo_evento], [res.data_entrega, "Entregue"]].filter(([d, t]) => d && t).map(([d, t]) => ({ data: d.split("-").reverse().join("/"), status: t, unidade: "" })) };
    const ant = m.get(num); if (!ant || (coleta || "") >= (ant._coleta || "")) m.set(num, { ...res, _coleta: coleta });   // mesma nota 2x: fica a coleta mais nova
  }
  log("Formato (Follow-Up):", m.size, "notas no relatório");
  return (formatoRel = m);
}
async function formato(itens, recente) {
  const out = new Map(); if (!itens.length) return out;
  const rel = await formatoRelatorio(); const resto = [];
  for (const l of itens) { const num = String(l.nf || "").split("-")[0].trim().replace(/^0+(?=\d)/, "");
    if (!num) { out.set(l.pedido, { situacao: "sem nf" }); continue; }
    const x = rel && rel.get(num); if (x) { const { _coleta, ...r } = x; out.set(l.pedido, r); } else if (!recente || !recente(l)) resto.push(l); }
  // fora do relatório (sem CT-e ainda ou CT-e antigo): Consulta NF uma a uma, com pausa
  const ck = resto.length ? await formatoLogin() : null;
  const dorme = (ms) => new Promise((ok) => setTimeout(ok, ms)); let erros = 0;
  for (const l of ck ? resto : []) {
    const num = String(l.nf || "").split("-")[0].trim().replace(/^0+(?=\d)/, "");
    try {
      const r = await pagina("https://www.transformato.com.br/consnota.asp", { method: "POST", headers: { Cookie: formatoCk, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ nota: num, submit: "Listar" }).toString() });
      if (r.status !== 200 || /name=["']?password/i.test(r.txt)) { if (++erros > 3) { log(`Formato respondeu ${r.status}${/password/i.test(r.txt) ? " (saiu do login)" : ""}; paro a Formato nesta rodada.`); break; } await dorme(10000); continue; }
      erros = 0; out.set(l.pedido, lerFormato(r.txt));
    } catch (e) { if (++erros > 3) break; await dorme(10000); continue; }
    await dorme(1500);
  }
  const cont = {}; out.forEach((v) => (cont[v.situacao] = (cont[v.situacao] || 0) + 1));
  log("Formato (site):", Object.entries(cont).map(([k, v]) => `${k} ${v}`).join(" · ") || "nada", `· ${itens.length - resto.length} pelo Follow-Up, ${resto.length} uma a uma`);
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
  let TAM = Number(process.env.JADLOG_LOTE || 100);   // a API aceita várias notas por chamada; se recusar o tamanho, cai para 10
  for (let i = 0; i < itens.length; i += TAM) {
    const lote = itens.slice(i, i + TAM).map((l) => { const [num, ser] = String(l.nf || "").split("-").map((x) => (x || "").trim()); return { l, num, ser, c: cnpjDaSerie(ser) }; });
    lote.filter((x) => !x.num || !x.c).forEach((x) => out.set(x.l.pedido, { situacao: "sem nf" }));
    const ok = lote.filter((x) => x.num && x.c); if (!ok.length) continue;
    let j = null;
    try {
      const r = await fetch("https://www.jadlog.com.br/embarcador/api/tracking/consultar", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ consulta: ok.map((x) => ({ df: { nf: x.num, serie: x.ser, tpDocumento: 2, cnpjRemetente: x.c } })) }) });
      if (r.status === 401 || r.status === 403) { log(`Jadlog recusou o token (${r.status}); paro a Jadlog nesta rodada.`); break; }
      if (!r.ok && TAM > 10 && (r.status === 400 || r.status === 413 || r.status === 422)) { log(`Jadlog recusou ${TAM} por vez (${r.status}); passo para 10.`); TAM = 10; i -= 10; continue; }
      if (!r.ok) { log(`Jadlog respondeu ${r.status}; espero e sigo.`); await dorme(5000); continue; }
      j = await r.json();
    } catch (e) { log("Jadlog:", String(e.message).slice(0, 80)); await dorme(5000); continue; }
    const res = (j && j.consulta) || [];
    ok.forEach((x, k) => { const c = res.find((z) => z && z.df && String(z.df.nf) === x.num && String(z.df.serie) === x.ser) || res[k]; out.set(x.l.pedido, lerJadlog(c)); });
    await dorme(300);
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
  const L = await chamar(`conferencia_ssw?select=nf,transportadora&transportadora=ilike.*${process.env.TRANSP_TESTE || "flog"}*&limit=4`);
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
  for (const m of p.txt.matchAll(/<script[^>]*>([\s\S]*?)<\/script>|<script[^>]*src="([^"]+)"/gi)) log("SCRIPT", m[2] || "", (m[1] || "").replace(/\s+/g, " ").slice(0, 1500));
  for (const src of ["/scripts/rastreamento4.js", "/ajuda/rastreamento.js"]) { const j = await pagina("https://ssw.inf.br" + src).catch(() => null); if (!j) continue;
    log("JS", src, j.status, j.txt.length); const t = j.txt.replace(/\s+/g, " "); for (const k of ["NR", "split", "textarea", "submit", "resultSSW", "\\n"]) { let i = -1, c = 0; while ((i = t.indexOf(k, i + 1)) >= 0 && c++ < 3) log(`  [${k}]`, t.slice(Math.max(0, i - 200), i + 250)); } }
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
if (MODO === "diag-serie") {   // NFs achadas com outro CNPJ (não o da série): a 1ª célula do SSW traz a série? (só padrões e contagens, sem números)
  await entrarSupabase(); await carregarSenhasDB();
  const L = []; for (let de = 0; ; de += 1000) { const x = await chamar(`conferencia_ssw?select=nf,transportadora,situacao,detalhe&detalhe->>cnpj_outro=not.is.null&order=pedido&limit=1000&offset=${de}`); L.push(...x); if (x.length < 1000) break; }
  const cont = {}; L.forEach((l) => { const k = `${l.transportadora} · série ${String(l.nf).split("-")[1]} · ${l.situacao}`; cont[k] = (cont[k] || 0) + 1; });
  log(`achadas com outro CNPJ: ${L.length}`); Object.entries(cont).sort((a, b) => b[1] - a[1]).slice(0, 40).forEach(([k, n]) => log("  ", n, k));
  const TODOS = Object.keys(CNPJ_SERIE), pad = (t) => t.replace(/\d+/g, (m) => "N" + m.length);
  for (const l of L.filter((x) => x.situacao === "entregue").slice(0, 12)) {
    const [num, ser] = String(l.nf).split("-").map((x) => x.trim()), c = TODOS.find((x) => x.endsWith(l.detalhe.cnpj_outro));
    for (const [rot, cc] of [["outro", c], ["serie", cnpjDaSerie(ser)]]) { if (!cc) continue;
      const r = await pagina("https://ssw.inf.br/2/ssw_resultSSW", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ NR: sem0(num), cnpj: cc, chave: "", urlori: "https://ssw.inf.br/ajuda/rastreamento.html" }).toString() }).catch(() => null);
      const bl = r ? r.txt.split(/<tr style="background-color:#(?:FFFFFF|F0F0F0);(?:cursor:pointer;)?"/i).slice(1) : [];
      const cel = bl.map((b) => sohTexto("<td " + (b.split(/<td\b/i)[1] || "")).join(" "));
      log(`  ${l.transportadora} série ${ser} · ${rot} · linhas ${bl.length} · 1ª célula: ${cel.map(pad).join(" / ") || "-"} · começa com a série? ${cel.map((t) => (t.match(/\d+/) || [])[0] === ser ? "sim" : "não").join("/")} · outros números=série? ${cel.map((t) => (t.match(/\d+/g) || []).slice(0, -1).includes(ser) ? "sim" : "não").join("/")}`);
      await new Promise((ok) => setTimeout(ok, 1500)); } }
}
if (MODO === "diag-serie2") {   // a 1ª célula das NFs achadas (CNPJ da série) traz "série NF"? só contagens
  await entrarSupabase(); await carregarSenhasDB();
  const L = await chamar(`conferencia_ssw?select=nf,transportadora,situacao,detalhe&situacao=in.(entregue,nao%20entregue)&detalhe->>cnpj_outro=is.null&order=consultado_em.desc&limit=600`);
  const G = new Map(); L.forEach((l) => { const [n, se] = String(l.nf).split("-").map((x) => (x || "").trim()), c = cnpjDaSerie(se); if (!c) return; (G.get(c) || G.set(c, []).get(c)).push({ n: sem0(n), se: sem0(se) }); });
  const cont = { com_serie_igual: 0, com_serie_diferente: 0, sem_serie: 0, nao_achou: 0, sem_cte: 0 };
  for (const [c, xs] of G) for (let i = 0; i < xs.length; i += 100) { const parte = xs.slice(i, i + 100);
    const r = await pagina("https://ssw.inf.br/2/ssw_resultSSW", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ NR: parte.map((x) => x.n).join("\r\n"), cnpj: c, chave: "", urlori: "https://ssw.inf.br/ajuda/rastreamento.html" }).toString() }).catch(() => null);
    const m = r ? lerLote(r.txt) : new Map();
    parte.forEach((x) => { const v = m.get(x.n); if (!v) return cont.nao_achou++; const Ls = v._L.filter((y) => y.situacao !== "sem cte"); if (!Ls.length) return cont.sem_cte++;
      Ls.forEach((y) => { if (!y.serie) cont.sem_serie++; else if (y.serie === x.se) cont.com_serie_igual++; else cont.com_serie_diferente++; }); });
    await new Promise((ok) => setTimeout(ok, 1500)); }
  log("linhas achadas no SSW (CNPJ da série):", JSON.stringify(cont));
}
if (MODO === "diag-sac") {   // Consulta SAC: quanto tempo a consultar_sac leva e quantas linhas volta (só contagens)
  await entrarSupabase();
  for (const q of ["base_pedidos?select=pedido&limit=1000", "base_pedidos?select=pedido,nf,prev_original&prev_original=lte.2026-12-31&limit=1000", "tratativas?select=pedido,nova_data&limit=1000",
    "intelipost_fechados?select=pedido&limit=1000", "detalhe_nf?select=nf&limit=1000", "base_aberta_bi?select=pedido&limit=1000"]) { const t0 = Date.now();
    try { const x = await chamar(q); log(`${q.split("?")[0]} (${q.includes("prev_original=") ? "filtro data" : "simples"}): ${x.length} linhas em ${((Date.now() - t0) / 1000).toFixed(1)} s`); }
    catch (e) { log(`${q.split("?")[0]}: erro em ${((Date.now() - t0) / 1000).toFixed(1)} s ${String(e.message || e).replace(/\d{3,}/g, "#").slice(0, 120)}`); } }
  { let depois = "", tot = 0; for (let v = 0; v < 30; v++) { const t0 = Date.now();
      try { const x = await chamar("rpc/consultar_sac_pag", "POST", { p_depois: depois }); tot += x.length; log(`consultar_sac_pag parte ${v + 1}: ${x.length} linhas em ${((Date.now() - t0) / 1000).toFixed(1)} s`); if (x.length < 1000) break; depois = x[x.length - 1].pedido; }
      catch (e) { log(`consultar_sac_pag parte ${v + 1}: erro em ${((Date.now() - t0) / 1000).toFixed(1)} s ${String(e.message || e).replace(/\d{3,}/g, "#").slice(0, 160)}`); break; } }
    log(`consultar_sac_pag total: ${tot} linhas`); }
  { const t0 = Date.now(); try { const x = await chamar("rpc/consultar_sac_json", "POST", {}); log(`consultar_sac_json: ${Array.isArray(x) ? x.length : "?"} linhas em ${((Date.now() - t0) / 1000).toFixed(1)} s`); }
    catch (e) { log(`consultar_sac_json: erro em ${((Date.now() - t0) / 1000).toFixed(1)} s ${String(e.message || e).replace(/\d{3,}/g, "#").slice(0, 160)}`); } }
  for (let de = 0; de < 8000; de += 1000) { const t0 = Date.now(); let n = -1, erro = "";
    try { const x = await chamarFaixa("rpc/consultar_sac", de, de + 999); n = x.length; } catch (e) { erro = String(e.message || e).replace(/\d{3,}/g, "#").slice(0, 160); }
    log(`consultar_sac linhas ${de}-${de + 999}: ${n} linhas em ${((Date.now() - t0) / 1000).toFixed(1)} s ${erro}`); if (n < 1000) break; }
}
if (MODO === "diag-cobranca") {   // Cobrança do dia: por transportadora, sem nova data válida e em reposição (só contagens)
  await entrarSupabase();
  const hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10), am = new Date(Date.now() + 21 * 3600e3).toISOString().slice(0, 10);
  const B = []; for (let de = 0; ; de += 1000) { const x = await chamar(`base_aberta_bi?select=pedido,transportadora,prev_original,range_atrasos,entregue_ip&order=pedido&limit=1000&offset=${de}`); B.push(...x); if (x.length < 1000) break; }
  const T = new Map(); for (let de = 0; ; de += 1000) { const x = await chamar(`tratativas?select=pedido,nova_data,observacao&order=pedido&limit=1000&offset=${de}`); x.forEach((t) => T.set(t.pedido, t)); if (x.length < 1000) break; }
  const R = await chamar("retorno_regras?select=categoria,palavras&order=ordem").catch(() => []);
  const nrm = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
  const regRep = R.length ? R.filter((r) => nrm(r.categoria).includes("REPOSI")).flatMap((r) => r.palavras.map(nrm)) : ["REPOSI", "FALTA DE VOL", "FALTA VOLUME", "EXTRAVIO", "AVARIA", "MERCADORIA SINISTRADA", "CTRC BAIXADO"];
  const repDe = (o) => { const t = nrm(o); if (!t) return false; if (!R.length) return regRep.some((w) => t.includes(w));
    const c = R.find((r) => r.palavras.some((w) => w && t.includes(nrm(w)))); return !!c && nrm(c.categoria).includes("REPOSI"); };
  const por = {}; let tot = { atr: 0, vence: 0, rep: 0, repSem: 0 };
  for (const b of B) { if (b.entregue_ip) continue; const t = T.get(b.pedido) || {}, prom = String(b.prev_original || "").slice(0, 10);
    const atr = /^VENCIDO/i.test(nrm(b.range_atrasos)) || (!b.range_atrasos && prom && prom < hoje), vence = !atr && (prom === hoje || prom === am);
    const nv = String(t.nova_data || "").slice(0, 10), valida = nv && nv >= hoje, rep = repDe(t.observacao);
    if (!atr && !vence && !rep) continue;
    const k = /tempo\s*justo|^\s*vm\b|vm transportes/i.test(b.transportadora || "") ? "VM Transportes / Tempo Justo" : (b.transportadora || "(sem transportadora)");
    const x = por[k] || (por[k] = { atr: 0, vence: 0, rep: 0, repSem: 0 });
    if (!valida && atr) { x.atr++; tot.atr++; } else if (!valida && vence) { x.vence++; tot.vence++; }
    if (rep) { x.rep++; tot.rep++; if (!valida) { x.repSem++; tot.repSem++; } } }
  log(`hoje ${hoje} · em aberto ${B.length} · regras ${R.length || "fábrica"} · TOTAL atrasados sem nova data ${tot.atr} · vencem hoje/amanhã sem nova data ${tot.vence} · em reposição ${tot.rep} (sem nova data ${tot.repSem})`);
  Object.entries(por).filter(([, x]) => x.atr + x.vence + x.rep).sort((a, b) => (b[1].atr + b[1].vence) - (a[1].atr + a[1].vence)).forEach(([k, x]) => log(`  ${k} · atrasados s/ data ${x.atr} · vencem s/ data ${x.vence} · reposição ${x.rep} (s/ data ${x.repSem})`));
}
if (MODO === "diag-cf") {   // Conferência SSW: quando foi a última importação e quantos "falta atualizar" já estão fechados na Intelipost (só contagens)
  await entrarSupabase();
  const C = []; for (let de = 0; ; de += 1000) { const x = await chamar(`conferencia_ssw?select=pedido,situacao,status_intelipost,importado_em&order=pedido&limit=1000&offset=${de}`); C.push(...x); if (x.length < 1000) break; }
  const F = new Map(); for (let de = 0; ; de += 1000) { const x = await chamar(`intelipost_fechados?select=pedido,status&order=pedido&limit=1000&offset=${de}`); x.forEach((f) => F.set(f.pedido, f.status)); if (x.length < 1000) break; }
  const info = await chamar("fechados_info?select=arquivo,total_linhas,fechados,enviado_em").catch(() => []);
  const imp = {}; C.forEach((c) => { const k = String(c.importado_em || "").slice(0, 16); imp[k] = (imp[k] || 0) + 1; });
  const ent = C.filter((c) => c.situacao === "entregue" && !/^entregue/i.test(c.status_intelipost || ""));
  const jaFech = ent.filter((c) => F.has(c.pedido));
  log(`conferência ${C.length} pedidos · importado_em ${JSON.stringify(imp)}`);
  log(`último Enviar Intelipost: ${info[0] ? info[0].enviado_em + " · linhas " + info[0].total_linhas + " · fechados " + info[0].fechados : "?"} · intelipost_fechados ${F.size}`);
  log(`falta atualizar ${ent.length} · desses já Entregue/Cancelado na Intelipost (intelipost_fechados) ${jaFech.length} · sobram ${ent.length - jaFech.length}`);
}
if (MODO === "diag-gargalo") {   // onde a transportadora (input transp, padrão VM/Tempo Justo) tem mais atraso hoje: só contagens agregadas
  await entrarSupabase();
  const nrm = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
  const alvo = new RegExp(process.env.TRANSP || "TEMPO\\s*JUSTO|^VM\\b|VM TRANSP", "i");
  const hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10), dd = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
  const B = []; for (let de = 0; ; de += 1000) { const x = await chamar(`base_aberta_bi?select=transportadora,uf,cidade,micro_status,prev_original,range_atrasos,data_expedicao,ultima_atualizacao,entregue_ip,extra&order=pedido&limit=1000&offset=${de}`); B.push(...x); if (x.length < 1000) break; }
  const ef = (b) => { const rd = b.extra && b.extra.redespacho; return nrm(rd && !/^SEM\b|^-$/i.test(rd) ? rd : b.transportadora); };
  const V = B.filter((b) => !b.entregue_ip && alvo.test(ef(b)));
  const atr = (b) => /^VENCIDO/i.test(nrm(b.range_atrasos)) || (!b.range_atrasos && b.prev_original && String(b.prev_original).slice(0, 10) < hoje);
  const A = V.filter(atr);
  const conta = (L, f) => { const m = new Map(); L.forEach((b) => { const k = f(b); m.set(k, (m.get(k) || 0) + 1); }); return m; };
  const tabela = (titulo, f, n = 15) => { const a = conta(A, f), t = conta(V, f);
    log(titulo); [...a.entries()].sort((x, y) => y[1] - x[1]).slice(0, n).forEach(([k, q]) => log(`  ${k} · atrasados ${q} de ${t.get(k)} em aberto (${Math.round(100 * q / t.get(k))}%)`)); };
  log(`hoje ${hoje} · em aberto ${V.length} · atrasados ${A.length}`);
  tabela("POR UF", (b) => nrm(b.uf) || "?");
  tabela("POR CIDADE (UF)", (b) => `${nrm(b.cidade) || "?"}/${nrm(b.uf) || "?"}`, 20);
  tabela("POR MICRO STATUS", (b) => nrm(b.micro_status) || "?", 12);
  const fx = (n, cs) => (n === null ? "sem data" : cs.find(([lim]) => n <= lim)[1]);
  tabela("DIAS SEM MOVIMENTO NO RASTREIO", (b) => fx(b.ultima_atualizacao ? dd(String(b.ultima_atualizacao).slice(0, 10), hoje) : null, [[2, "0-2"], [6, "3-6"], [14, "7-14"], [29, "15-29"], [1e9, "30+"]]));
  tabela("DIAS DESDE A EXPEDIÇÃO", (b) => fx(b.data_expedicao ? dd(String(b.data_expedicao).slice(0, 10), hoje) : null, [[5, "0-5"], [10, "6-10"], [20, "11-20"], [40, "21-40"], [1e9, "41+"]]));
  tabela("DIAS DE ATRASO", (b) => fx(b.prev_original ? dd(String(b.prev_original).slice(0, 10), hoje) : null, [[0, "no prazo"], [3, "1-3"], [9, "4-9"], [19, "10-19"], [1e9, "20+"]]));
  const ZONA = { "01": "Centro", "02": "Zona Norte", "03": "Zona Leste", "04": "Zona Sul", "05": "Zona Oeste", "08": "Zona Leste (extremo)" };
  const zona = (b) => { const c = String((b.extra && b.extra.cep) || "").replace(/\D/g, "").padStart(8, "0"); if (c === "00000000") return "sem CEP"; const z = ZONA[c.slice(0, 2)]; return z ? `SP capital · ${z}` : `fora da capital (CEP ${c.slice(0, 2)}xxx)`; };
  tabela("POR REGIÃO DO CEP", zona, 12);
  tabela("REGIÃO x MICRO STATUS (atrasados)", (b) => `${zona(b)} · ${nrm(b.micro_status) || "?"}`, 15);
  tabela("UF x MICRO STATUS (atrasados)", (b) => `${nrm(b.uf) || "?"} · ${nrm(b.micro_status) || "?"}`, 15);
}
if (MODO === "parar-tudo") {   // pausa o "Conferir tudo agora" em andamento (pedido da Brenda, 17/11): só marca como terminado
  await entrarSupabase(); await chamar("rpc/fim_conferencia_tudo", "POST", {}); log("Conferir tudo: pausado.");
}
if (MODO === "diag-jadobs") {   // onde estão as "Observações" do rastreio da Jadlog: chaves da API + páginas do site (só estrutura, sem dados)
  await entrarSupabase(); const tok = process.env.JADLOG_TOKEN || "";
  const L = (await chamar("conferencia_ssw?select=nf,detalhe&transportadora=ilike.*jadlog*&situacao=eq.nao%20entregue&limit=200")).filter((x) => x.detalhe && x.detalhe.cte).slice(0, 3);
  log("notas com CT-e:", L.length);
  const chaves = (o, p = "") => o && typeof o === "object" ? Object.entries(o).flatMap(([k, v]) => Array.isArray(v) ? [`${p}${k}[${v.length}]`, ...chaves(v[0], `${p}${k}[0].`)] : v && typeof v === "object" ? chaves(v, `${p}${k}.`) : [`${p}${k}`]) : [];
  for (const l of L) {
    const [num, ser] = String(l.nf).split("-").map((x) => (x || "").trim()), cte = String(l.detalhe.cte), cod = String(l.detalhe.codigo || "");
    if (tok) { const r = await fetch("https://www.jadlog.com.br/embarcador/api/tracking/consultar", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` }, body: JSON.stringify({ consulta: [{ df: { nf: num, serie: ser, tpDocumento: 2, cnpjRemetente: cnpjDaSerie(ser) } }] }) });
      const j = await r.json().catch(() => null); log("API chaves:", j ? [...new Set(chaves(j))].join(" | ").slice(0, 1500) : r.status); }
    for (const u of [`https://www.jadlog.com.br/siteInstitucional/tracking_dev.jad?cte=${cte}`, `https://www.jadlog.com.br/siteInstitucional/tracking.jad?cte=${cte}`, `https://www.jadlog.com.br/jadlog/tracking?cte=${cte}`, cod ? `https://www.jadlog.com.br/siteInstitucional/tracking_dev.jad?shipmentId=${cod}` : null].filter(Boolean)) {
      const r = await pagina(u).catch((e) => ({ status: e.message, txt: "" })); const t = r.txt || "";
      const ths = tags(t, /<th[^>]*>[\s\S]{0,80}?<\/th>/gi).map((x) => x.replace(/<[^>]+>/g, "").trim()).filter(Boolean);
      log(`${u.replace(/=\d+/, "=#").replace(/=[A-Za-z0-9]{6,}$/, "=#")}: ${r.status} · ${t.length} bytes · observ: ${/observa/i.test(t) ? "sim" : "não"} · captcha: ${/captcha/i.test(t) ? "sim" : "não"} · tr: ${(t.match(/<tr/gi) || []).length} · th: ${ths.slice(0, 20).join(" | ")}`);
      const i = t.search(/Observa/i); if (i >= 0) log("  perto de Observação:", t.slice(i, i + 1500).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/\d{4,}/g, "#").replace(/[A-Za-zÀ-ú]{3,}/g, (w) => (/^(cte|nota|fiscal|data|descri|status|usu|observ|iniciado|andamento|finaliz|concl)/i.test(w) ? w : "x")).slice(0, 600));
      await new Promise((ok) => setTimeout(ok, 1500)); }
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
if (MODO === "diag-par") {   // quantas páginas ao mesmo tempo é mais rápido (só tempos)
  await entrarSupabase();
  for (const [tab, J] of [["base_pedidos", 1], ["base_pedidos", 2], ["base_pedidos", 4], ["base_aberta_bi", 1], ["base_aberta_bi", 3]]) {
    const t = Date.now(); let n = 0, err = 0, lento = 0;
    for (let de = 0; ; de += 1000 * J) { const ps = await Promise.all(Array.from({ length: J }, async (_, j) => { const t1 = Date.now(); const r = await chamar(`${tab}?select=*&order=pedido&limit=1000&offset=${de + j * 1000}`).catch(() => { err++; return null; }); lento = Math.max(lento, Date.now() - t1); return r || []; }));
      ps.forEach((p) => { n += p.length; }); if (ps.some((p) => p.length < 1000) || de > 20000) break; }
    log(`${tab} ${J} por vez: ${n} linhas em ${((Date.now() - t) / 1000).toFixed(1)} s · página mais lenta ${(lento / 1000).toFixed(1)} s · erros ${err}`);
  }
  process.exit(0);
}
if (MODO === "diag-db") {   // tempos de consultas simples, uma por vez (só tempos e contagens)
  await entrarSupabase();
  const T = [["tratativas?select=pedido&limit=1", "1 linha tratativas"], ["base_pedidos?select=pedido&limit=1", "1 linha base"],
    ["base_pedidos?select=pedido&order=pedido&limit=1000", "1000 pedidos (só coluna pedido)"], ["base_pedidos?select=pedido&order=pedido&limit=1000&offset=12000", "1000 pedidos offset 12000 (só pedido)"],
    ["base_pedidos?select=*&order=pedido&limit=1000", "1000 linhas inteiras"], ["base_pedidos?select=pedido,nf,canal&order=pedido&limit=1000&offset=6000", "1000 linhas 3 colunas offset 6000"],
    ["base_pedidos?select=*&order=pedido&limit=1000&offset=12000", "1000 linhas inteiras offset 12000"], ["intelipost_fechados?select=pedido&limit=1000", "1000 fechados"]];
  for (const tab of ["base_pedidos", "conferencia_ssw", "base_aberta_bi"]) { try {   // por faixas (como o painel faz agora)
    const t = Date.now(); let ch = []; for (let de = 0; ; de += 8000) { const ps = await Promise.all(Array.from({ length: 8 }, (_, j) => chamar(`${tab}?select=pedido&order=pedido&limit=1000&offset=${de + j * 1000}`)));
      ps.forEach((p) => { ch = ch.concat(p.map((x) => x.pedido)); }); if (ps.some((p) => p.length < 1000)) break; }
    const t2 = Date.now(); const cortes = [null]; for (let k = 999; k < ch.length; k += 1000) cortes.push(ch[k]); cortes.push(undefined);
    let n = 0, err = 0; for (let i = 0; i < cortes.length - 1; i += 6) { const ps = await Promise.all(cortes.slice(i, i + 6).map((a, j) => { const b = cortes[i + j + 1]; if (b === undefined && a === undefined) return [];
        return chamar(`${tab}?select=*&order=pedido&limit=1000${a != null ? "&pedido=gt." + encodeURIComponent(a) : ""}${b != null ? "&pedido=lte." + encodeURIComponent(b) : ""}`).catch(() => { err++; return []; }); }));
      ps.forEach((p) => { n += p.length; }); }
    log(`${tab} por faixas: chaves ${ch.length} em ${((t2 - t) / 1000).toFixed(1)} s · linhas ${n} em ${((Date.now() - t2) / 1000).toFixed(1)} s · erros ${err}`);
  } catch (e) { log(`${tab} por faixas: ERRO ${String(e.message).slice(-60)}`); }
  }
  for (const [u, nome] of T) { const t = Date.now(); try { const x = await chamar(u); log(`${nome}: ${x.length} em ${((Date.now() - t) / 1000).toFixed(1)} s`); } catch (e) { log(`${nome}: ERRO em ${((Date.now() - t) / 1000).toFixed(1)} s ${String(e.message).slice(-80)}`); } }
  process.exit(0);
}
if (MODO === "teste-velocidade") {   // mede quanto demora baixar a base como o painel faz (só tempos e contagens)
  await entrarSupabase();
  const COLS = "pedido,nf,canal,uf,cidade,transportadora,status_intelipost,micro_status,origem,data_expedicao,prev_original,prev_atual,ultima_atualizacao,data_criacao,data_entrega,range_atrasos,dias_atraso,status_prazo,sem_expedicao,trocas:extra->>trocas";
  const t0 = Date.now(); const x5 = await chamar(`base_pedidos?select=${COLS}&order=pedido&limit=5000&offset=0`);
  log("página pedindo 5000 linhas: veio", x5.length, "em", Date.now() - t0, "ms · tamanho", Math.round(JSON.stringify(x5).length / 1024), "KB");
  const TABS = [["base_pedidos", COLS], ["base_aberta_bi", "*"], ["tratativas", "*"], ["ocorrencias_cadastradas", "*"], ["previsao_ssw", "*"], ["tickets_abertos", "*"], ["detalhe_nf", "*"], ["reposicoes_tk", "*"], ["repo_atual", "*"], ["conferencia_ssw", "*"]];
  let sim = 0; const fl = []; const LIM = Number(process.env.LIM_SIMULT || 6);
  const chamar0 = chamar; const chamarL = async (u) => { if (sim >= LIM) await new Promise((ok) => fl.push(ok)); else sim++; try { return await chamar0(u); } finally { const n = fl.shift(); if (n) n(); else sim--; } };
  log("limite simultâneo:", LIM);
  const tv = Date.now();
  await Promise.all(TABS.map(async ([tab, cols]) => { const t1 = Date.now(); let n = 0, kb = 0;
    for (let de = 0; ; de += 8000) { const partes = await Promise.all(Array.from({ length: 8 }, (_, j) => chamarL(`${tab}?select=${cols}&order=${tab === "tickets_abertos" || tab === "detalhe_nf" || tab === "ocorrencias_cadastradas" ? "nf" : /repo/.test(tab) ? "ticket" : "pedido"}&limit=1000&offset=${de + j * 1000}`).catch((e) => { log(tab, "erro", String(e.message).slice(0, 400)); return []; })));
      partes.forEach((p) => { n += p.length; kb += JSON.stringify(p).length / 1024; }); if (partes.some((p) => p.length < 1000)) break; }
    log(`  [tudo junto] ${tab}: ${n} linhas · ${Math.round(kb)} KB · ${((Date.now() - t1) / 1000).toFixed(1)} s`); }));
  log(`TUDO JUNTO (como o painel abre): ${((Date.now() - tv) / 1000).toFixed(1)} s`);
  for (const [tab, cols, PAG, JUNTAS] of [["base_aberta_bi", "*", 1000, 8], ["base_aberta", "*", 1000, 8]]) {
    const t1 = Date.now(); let n = 0, kb = 0, rodadas = 0;
    for (let de = 0; ; de += PAG * JUNTAS) {
      const partes = await Promise.all(Array.from({ length: JUNTAS }, (_, j) => chamar(`${tab}?select=${cols}&order=pedido&limit=${PAG}&offset=${de + j * PAG}`).catch(() => [])));
      rodadas++; partes.forEach((p) => { n += p.length; kb += JSON.stringify(p).length / 1024; });
      if (partes.some((p) => p.length < PAG)) break;
    }
    log(`${tab} (${PAG} por página, ${JUNTAS} juntas): ${n} linhas · ${Math.round(kb)} KB · ${rodadas} rodadas · ${((Date.now() - t1) / 1000).toFixed(1)} s`);
  }
  process.exit(0);
}
if (MODO === "teste-scallia") {   // conta os eventos do Scallia que já chegaram (só contagens) e testa se a função responde
  await entrarSupabase();
  // tira o pedido de teste que o admin do Scallia gravou (TESTE-1)
  await chamar("scallia_eventos?pedido=eq.TESTE-1", "DELETE").then(() => log("Scallia: TESTE-1 apagado (se existia)")).catch((e) => log("Scallia: não apaguei o TESTE-1:", e.message.slice(0, 100)));
  const E = [];
  for (let de = 0; de < 60000; de += 1000) { const P = await chamar(`scallia_eventos?select=marco,chave,nf,recebido_em&order=recebido_em.desc&limit=1000&offset=${de}`).catch((e) => { log("scallia_eventos erro:", e.message.slice(0, 120)); return []; }); E.push(...P); if (P.length < 1000) break; }
  const c = {}, ch = {}, nf = {}; E.forEach((x) => { c[x.marco] = (c[x.marco] || 0) + 1; if (x.chave) ch[x.marco] = (ch[x.marco] || 0) + 1; if (x.nf) nf[x.marco] = (nf[x.marco] || 0) + 1; });
  log("Scallia: eventos gravados:", E.length, "· por marco:", JSON.stringify(c), "· com chave da NF:", JSON.stringify(ch), "· com número da NF:", JSON.stringify(nf), "· último recebido:", E[0] ? E[0].recebido_em : "nenhum");
  const r = await fetch("https://qncselfuymeximgmetjp.supabase.co/functions/v1/scallia-webhook", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch((e) => ({ status: e.message, text: async () => "" }));
  log("Scallia: função respondeu (sem assinatura, esperado 401):", r.status, String(await r.text()).slice(0, 120));
  for (const nome of ["transiga-webhook", "scallia_webhook", "scallia", "Scallia-webhook", "scallia-webhook-"]) { const q = await fetch(`https://qncselfuymeximgmetjp.supabase.co/functions/v1/${nome}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => ({ status: "erro" })); log(`  função ${nome}:`, q.status); }
  process.exit(0);
}
if (MODO === "teste-formato") {   // testa o login e a consulta da Formato pelo robô (só contagens no log)
  await entrarSupabase();
  const L = await chamar("base_aberta?select=pedido,nf,transportadora&transportadora=ilike.*formato*&nf=not.is.null&limit=6");
  const m = await formato(L);
  log("teste Formato:", L.length, "NFs ·", [...m.values()].map((r) => `${r.situacao}${r.previsao ? " c/ previsão" : ""}`).join(" | "));
  process.exit(0);
}
if (MODO === "diag-formato") {   // rastreio da Formato (transformato.com.br/consultaweb.asp): formulário, captcha e estrutura do resultado (mascarado)
  const URL_F = "https://www.transformato.com.br/consultaweb.asp";
  const lim = (x) => x.replace(/value=["'][^"']{10,}["']/g, 'value="…"').replace(/class="[^"]*"|style="[^"]*"/g, "");
  const h = await pagina("https://www.transformato.com.br/").catch((e) => ({ status: e.message, txt: "", cookie: "" }));
  log("home:", h.status, tags(h.txt, /<form[^>]*>|<input[^>]*>|<a [^>]*href=["'][^"']*(consult|login|client|logar|acesso|entrar|area)[^"']*["']/gi).map(lim).slice(0, 25).join(" | "));
  const m0 = await pagina(URL_F, { headers: h.cookie ? { Cookie: h.cookie } : {} }).catch((e) => ({ status: e.message, txt: "", cookie: "" }));
  log("menu:", m0.status, m0.url, "· cookie:", m0.cookie ? "sim" : "não");
  let ck = [h.cookie, m0.cookie].filter(Boolean).join("; ");
  // login do cliente (segredos FORMATO_USUARIO / FORMATO_SENHA): procura um formulário com campo de senha na home ou no menu
  const US = process.env.FORMATO_USUARIO || "", SE = process.env.FORMATO_SENHA || "";
  log("segredos do login:", US ? "usuário sim" : "usuário NÃO", "·", SE ? "senha sim" : "senha NÃO");
  const fl = [h, m0].map((x) => (x.txt.match(/<form[\s\S]*?<\/form>/gi) || []).find((q) => /type=["']?password/i.test(q))).find(Boolean);
  log("form de login:", fl ? tags(fl, /<form[^>]*>|<input[^>]*>/gi).map(lim).join(" | ") : "não achei");
  if (fl && US && SE) {
    const ins = tags(fl, /<input[^>]*>/gi).map((x) => ({ n: (x.match(/name=["']?([^"'\s>]+)/i) || [])[1], t: ((x.match(/type=["']?([^"'\s>]+)/i) || [])[1] || "text").toLowerCase(), v: (x.match(/value=["']([^"']*)["']/i) || [])[1] || "" })).filter((c) => c.n);
    const b = new URLSearchParams();
    ins.forEach((c) => b.set(c.n, c.t === "password" ? SE : ["text", "email"].includes(c.t) ? US : c.v));
    const act = new URL((fl.match(/action=["']?([^"'\s>]+)/i) || [])[1] || URL_F, URL_F).href;
    const r = await fetch(act, { method: "POST", redirect: "manual", headers: { "User-Agent": "Mozilla/5.0", "Content-Type": "application/x-www-form-urlencoded", ...(ck ? { Cookie: ck } : {}) }, body: b.toString() }).catch((e) => ({ status: e.message, headers: new Headers() }));
    const nc = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map((c) => c.split(";")[0]);
    const mapa = new Map(ck.split(/;\s*/).filter(Boolean).map((c) => [c.split("=")[0], c]));
    nc.forEach((c) => mapa.set(c.split("=")[0], c));
    ck = [...mapa.values()].join("; ");
    const lt = r.text ? await r.text().catch(() => "") : "";
    log("login resposta:", lt.length, "bytes · inválid/incorret/erro:", /inv[aá]lid|incorret|erro|negad/i.test(lt) ? "SIM" : "não", "· textos:", sohTexto(lt).map((x) => limpo(x)).filter((x) => x.replace(/[x\s#]/g, "").length > 2).slice(0, 25).join(" | ").slice(0, 800));
    log("login scripts:", tags(lt, /<script[^>]*>[\s\S]{0,400}?<\/script>|<meta[^>]*refresh[^>]*>/gi).map((x) => x.replace(/\d{4,}/g, "#").replace(/\s+/g, " ").slice(0, 300)).join(" || ").slice(0, 1200));
    log("login:", r.status, "· vai para:", (r.headers.get("location") || "").replace(/\d{4,}/g, "#"), "· cookies novos:", nc.length);
  }
  const CK = ck ? { Cookie: ck } : {};
  const f0 = await pagina(new URL("consnota.asp", URL_F).href, { headers: CK }).catch((e) => ({ status: e.message, txt: "", url: "" }));
  const f = { ...f0, url: f0.url || new URL("consnota.asp", URL_F).href };
  log("consnota:", f.status, f.url, "· login?", /senha|password|login/i.test(f.txt) ? "SIM" : "não");
  log("textos consnota:", sohTexto(f.txt).map((x) => limpo(x)).filter((x) => x.replace(/[x\s#]/g, "").length > 2).slice(0, 40).join(" | ").slice(0, 1500));
  log("form:", f.status, f.txt.length, "bytes · captcha:", /captcha|recaptcha|turnstile|hcaptcha/i.test(f.txt) ? "SIM" : "não");
  log("tags:", tags(f.txt, /<form[^>]*>|<input[^>]*>|<button[^>]*>|<select[^>]*>|<option[^>]*>[^<]{0,40}/gi).map((x) => x.replace(/value=["'][^"']{14,}["']/g, 'value="…"').replace(/class="[^"]*"|style="[^"]*"/g, "")).join(" | ").slice(0, 2500));
  log("scripts:", tags(f.txt, /<script[^>]*>[\s\S]{0,800}?<\/script>/gi).filter((x) => !/_gaq|gtag|jquery/i.test(x)).map((x) => x.replace(/\d{5,}/g, "#").replace(/\s+/g, " ").slice(0, 600)).join(" || ").slice(0, 2500));
  await entrarSupabase();
  const L = await chamar("base_aberta?select=nf,transportadora&transportadora=ilike.*formato*&nf=not.is.null&limit=3");
  log("NFs da Formato para testar:", L.length);
  if (!L.length) process.exit(0);
  const acao = (f.txt.match(/<form[^>]*action=["']([^"']*)["']/i) || [])[1] || "";
  const metodo = ((f.txt.match(/<form[^>]*method=["']([^"']*)["']/i) || [])[1] || "post").toLowerCase();
  const campos = tags(f.txt, /<input[^>]*>|<select[^>]*>/gi).map((x) => ({ n: (x.match(/name=["']([^"']+)["']/i) || [])[1], t: ((x.match(/type=["']([^"']+)["']/i) || [])[1] || "text").toLowerCase(), v: (x.match(/value=["']([^"']*)["']/i) || [])[1] || "" })).filter((c) => c.n);
  log("action:", acao, "· method:", metodo, "· campos:", campos.map((c) => `${c.n}(${c.t})`).join(", "));
  for (const l of L.slice(0, 2)) {
    const [num, ser] = String(l.nf).split("-").map((x) => (x || "").trim());
    const corpo = new URLSearchParams();
    campos.forEach((c) => { if (["button", "image"].includes(c.t)) return; if (c.t === "submit") { corpo.set(c.n, c.v); return; } corpo.set(c.n, /cnpj|cpf|doc|remet/i.test(c.n) ? cnpjDaSerie(ser) || "00349443000192" : /serie/i.test(c.n) ? ser : /nf|nota|num|doc|pesq|busca|valor/i.test(c.n) ? num : c.v); });
    const destino = new URL(acao || f.url, f.url).href;
    const r = metodo === "get" ? await pagina(destino + "?" + corpo.toString(), { headers: CK }).catch((e) => ({ status: e.message, txt: "" }))
      : await pagina(destino, { method: "POST", headers: { ...CK, "Content-Type": "application/x-www-form-urlencoded" }, body: corpo.toString() }).catch((e) => ({ status: e.message, txt: "" }));
    const ls = sohTexto(r.txt);
    log(`consulta (série ${ser}):`, r.status, "·", r.txt.length, "bytes · linhas:", ls.length, "· datas:", (r.txt.match(/\d{2}\/\d{2}\/\d{2,4}/g) || []).length, "· previsão:", /previs/i.test(r.txt) ? "sim" : "não", "· entreg:", /entreg/i.test(r.txt) ? "sim" : "não", "· captcha:", /captcha/i.test(r.txt) ? "SIM" : "não", "· não encontrad:", /n[ãa]o (foi )?encontrad|nenhum/i.test(r.txt) ? "sim" : "não");
    log("textos:", ls.map((x) => limpo(x)).filter((x) => x.replace(/[x\s#]/g, "").length > 2).slice(0, 70).join(" | ").slice(0, 2500));
    log("tabelas/links:", tags(r.txt, /<th[^>]*>[^<]{0,40}|<a [^>]*href=["'][^"']{0,120}["']|<iframe[^>]*>|<form[^>]*>|<input[^>]*>/gi).map((x) => x.replace(/\d{4,}/g, "#").replace(/value=["'][^"']{10,}["']/g, 'value="…"')).slice(0, 30).join(" | "));
    await new Promise((ok) => setTimeout(ok, 3000));
  }
}
if (MODO === "diag-track3r") {   // documentação pública da API da Track3r (sem token): lista os métodos
  for (const u of ["https://api.track3r.com.br/", "https://api.track3r.com.br/swagger/index.html", "https://api.track3r.com.br/swagger/v2/swagger.json", "https://api.track3r.com.br/swagger/v1/swagger.json", "https://api.track3r.com.br/help", "https://api.track3r.com.br/v2/help", "https://api.track3r.com.br/swagger/docs/v2", "https://api.track3r.com.br/swagger/docs/v1"]) {
    const r = await pagina(u).catch((e) => ({ status: e.message, txt: "" }));
    let rotas = "";
    try { const j = JSON.parse(r.txt); rotas = Object.entries(j.paths || {}).map(([k, v]) => `${Object.keys(v).join("/").toUpperCase()} ${k}`).join(" | "); } catch {}
    log(u, "→", r.status, "·", rotas || r.txt.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 1500));
  }
}
if (MODO === "diag-lote") {   // consulta em lote (até 100 NFs) pelo formulário da ajuda do SSW: só contagens e estrutura mascarada
  await entrarSupabase(); await carregarSenhasDB();
  const dorme = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const alvos = (process.env.TRANSP || "atual,vm transportes,petrymar,flog").split(",").map((s) => s.trim()).filter(Boolean);
  for (const alvo of alvos) {
    const L = [];
    for (const sit of ["entregue", "nao entregue", "sem cte"]) L.push(...await chamar(`conferencia_ssw?select=nf,transportadora,situacao&transportadora=ilike.*${encodeURIComponent(alvo)}*&situacao=eq.${encodeURIComponent(sit)}&nf=not.is.null&limit=40`));
    const porC = {}; L.forEach((x) => { const [n, se] = String(x.nf).split("-").map((v) => (v || "").trim()); const c = cnpjDaSerie(se); if (c && n) (porC[c] ||= []).push({ ...x, n }); });
    const [cnpj, itens] = Object.entries(porC).sort((a, b) => b[1].length - a[1].length)[0] || [];
    if (!itens) { log(`${alvo}: sem NFs para testar`); continue; }
    const chave = chaveDe(itens[0].transportadora);
    log(`== ${alvo}: ${itens.length} NFs (${JSON.stringify(itens.reduce((m, x) => (m[x.situacao] = (m[x.situacao] || 0) + 1, m), {}))}) · senha ${chave ? "sim" : "não"}`);
    for (const [url, rot, comChave] of [["https://ssw.inf.br/2/ssw_resultSSW", "form ajuda", !!chave], ["https://ssw.inf.br/2/ssw_resultSSW", "form ajuda sem senha", false]]) {
      if (rot.includes("sem senha") && !chave) continue;
      const t0 = Date.now();
      const r = await pagina(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ NR: itens.map((x) => x.n).join("\n"), cnpj, chave: comChave ? chave : "", urlori: "https://ssw.inf.br/ajuda/rastreamento.html" }).toString() });
      const html = r.txt, linhas = html.split(/<tr[\s>]/i).slice(1);
      log(`${rot}: HTTP ${r.status} · ${Date.now() - t0} ms · ${html.length} bytes · <tr> ${linhas.length} · links detalhe ${(html.match(/SSWDetalhado|opx\(/g) || []).length}`);
      let achou = 0, bate = 0; const conf = {};
      for (const x of itens) {
        const re = new RegExp("(^|\\D)0*" + x.n + "(\\D|$)"), tr = linhas.filter((l) => re.test(sohTexto("<tr " + l).join(" ")));
        if (!tr.length) { conf[x.situacao + "→não listada"] = (conf[x.situacao + "→não listada"] || 0) + 1; continue; }
        achou++; const t = sohTexto("<tr " + tr.join(" ")).join(" ");
        const v = /MERCADORIA ENTREGUE|ENTREGA REALIZADA/i.test(t) ? "entregue" : /n[ãa]o dispon/i.test(t) ? "sem cte" : /permiss/i.test(t) ? "sem permissao" : "nao entregue";
        if (v === x.situacao) bate++; const k = `${x.situacao}→${v}${tr.length > 1 ? " (" + tr.length + " linhas)" : ""}${/SSWDetalhado|opx\(/.test(tr.join(" ")) ? " c/link" : ""}`; conf[k] = (conf[k] || 0) + 1;
      }
      log(`  NFs listadas ${achou}/${itens.length} · situação igual à do robô ${bate} · ${JSON.stringify(conf)}`);
      log("  cabeçalhos:", sohTexto(html).slice(0, 14).map(limpo).join(" | ").slice(0, 600));
      const ex = linhas.find((l) => /\d{2}\/\d{2}\/\d{2}/.test(l)); if (ex) log("  linha exemplo:", sohTexto("<tr " + ex).map(limpo).join(" | ").slice(0, 400), "· tags:", tags("<tr " + ex, /<(td|a|input|form)[^>]*>/gi).map((y) => y.replace(/\d{4,}/g, "#").replace(/style="[^"]*"/g, "")).slice(0, 12).join(" "));
      await dorme(4000);
    }
    // NF que não aparece com o CNPJ da série: tenta os outros CNPJ (1 lote por CNPJ)
    const faltam = itens.filter((x) => x.situacao === "sem cte").map((x) => x.n);
    if (faltam.length) { let extra = 0;
      for (const c of Object.keys(CNPJ_SERIE).filter((c) => c !== cnpj)) {
        const r = await pagina("https://ssw.inf.br/2/ssw_resultSSW", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ NR: faltam.join("\n"), cnpj: c, chave, urlori: "https://ssw.inf.br/ajuda/rastreamento.html" }).toString() });
        const t = sohTexto(r.txt).join(" "); const n = faltam.filter((f) => new RegExp("(^|\\D)0*" + f + "(\\D|$)").test(t)).length; extra += n;
        log(`  'sem CT-e' com outro CNPJ (#${c.slice(-4)}): ${n}/${faltam.length} aparecem · HTTP ${r.status}`); await dorme(3000);
      } }
  }
}
if (MODO === "diag-lote2") {   // estrutura da resposta em lote (só tags, atributos e scripts, com números mascarados; sem textos)
  await entrarSupabase(); await carregarSenhasDB();
  const L = await chamar(`conferencia_ssw?select=nf,transportadora,situacao&transportadora=ilike.*flog*&situacao=eq.entregue&nf=not.is.null&limit=5`);
  const L2 = await chamar(`conferencia_ssw?select=nf,transportadora,situacao&transportadora=ilike.*flog*&situacao=eq.nao%20entregue&nf=not.is.null&limit=5`);
  const it = L.concat(L2).map((x) => ({ ...x, n: String(x.nf).split("-")[0].trim(), se: String(x.nf).split("-")[1] }));
  const cnpj = cnpjDaSerie((it[0] || {}).se); if (!cnpj) { log("sem NFs"); } else {
    const r = await pagina("https://ssw.inf.br/2/ssw_resultSSW", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ NR: it.map((x) => x.n).join("\r\n"), cnpj, chave: chaveDe(it[0].transportadora), urlori: "https://ssw.inf.br/ajuda/rastreamento.html" }).toString() });
    const mask = (t) => t.replace(/\d{3,}/g, "#").replace(/>[^<]+</g, (m) => ">" + m.slice(1, -1).replace(/[A-Za-zÀ-ú]{2,}/g, (w) => (OK_PAL.test(w) || /^(situa|entreg|unidade|data|hora|nota|fiscal|coleta|previs)/i.test(w) ? w : "x")) + "<");
    log("HTTP", r.status, "bytes", r.txt.length, "cookie", r.cookie ? "sim" : "não");
    const corpo = r.txt.replace(/\s+/g, " "), i0 = corpo.indexOf("<table"); mask(corpo.slice(i0, i0 + 7000)).match(/.{1,300}/g).forEach((l) => log("  " + l));
  }
}
if (MODO === "diag-um") {   // um pedido, achado pelo hash (o número não vai para o código nem para o log)
  const { createHash } = await import("node:crypto"); await entrarSupabase(); await carregarSenhasDB();
  const alvo = process.env.ALVO_HASH || (/^[0-9a-f]{16}$/.test(process.env.TRANSP || "") ? process.env.TRANSP : "06c17d56f26512c0"); let l = null;
  for (let de = 0; !l; de += 1000) { const L = await chamar(`conferencia_ssw?select=pedido,nf,transportadora,situacao,ultimo_evento,data_evento,data_entrega,consultado_em,detalhe&order=pedido&limit=1000&offset=${de}`);
    l = L.find((x) => createHash("sha256").update(x.pedido).digest("hex").slice(0, 16) === alvo) || null; if (L.length < 1000) break; }
  if (!l) log("não achei"); else {
    const [num, ser] = String(l.nf).split("-"), cs = cnpjDaSerie(ser);
    log("transp:", l.transportadora, "· série", ser, "· situação", l.situacao, "· evento", l.ultimo_evento, "· data_evento", l.data_evento, "· entrega", l.data_entrega, "· consultado", l.consultado_em, "· detalhe", JSON.stringify(l.detalhe || {}).replace(/\d{5,}/g, "#"));
    log("REGRA_RAJ:", REGRA_RAJ(l.transportadora, l.nf), "· chave:", chaveDe(l.transportadora) ? "sim" : "não");
    for (const c of [cs, ...Object.keys(CNPJ_SERIE).filter((x) => x !== cs)]) for (const ch of [chaveDe(l.transportadora), ""]) {
      const r = await pagina("https://ssw.inf.br/2/ssw_resultSSW", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ NR: sem0(num), cnpj: c, chave: ch, urlori: "https://ssw.inf.br/ajuda/rastreamento.html" }).toString() });
      const m = lerLote(r.txt), v = m.get(sem0(num)); await new Promise((ok) => setTimeout(ok, 1200));
      if (v && v.situacao !== "sem cte") { let em = "?"; if (v.det) { const d = await pagina("https://ssw.inf.br" + v.det).catch(() => null); em = d ? ((sohTexto(d.txt).join("\n").match(/transportando a sua mercadoria:\s*([^\n]+)/i) || [])[1] || "—").slice(0, 40) : "?"; } log(`CNPJ ...${c.slice(-6)} ${ch ? "com senha" : "sem senha"}: emissor=${em} · melhor=${v.situacao}/${v.sigla} · semRaj=${v._semRaj ? v._semRaj.situacao + "/" + v._semRaj.sigla : "—"} · temRaj=${v._temRaj} · pegaLote=${JSON.stringify(pegaLote(m, { n: sem0(num), transportadora: l.transportadora, nf: l.nf }) || {}, (k, val) => (k === "det" ? undefined : val)).replace(/\d{5,}/g, "#")}`); }
      if (!ch) break; }
  }
}
if (MODO === "diag-lote4") {   // testa a leitura do lote: só contagens e estrutura mascarada da 1ª linha
  await entrarSupabase(); await carregarSenhasDB();
  const L = await chamar(`conferencia_ssw?select=nf,transportadora,situacao&transportadora=ilike.*${encodeURIComponent(process.env.TRANSP || "flog")}*&nf=not.is.null&limit=${Number(process.env.SSW_LIMITE || 20)}`);
  const it = L.map((x) => ({ n: sem0(String(x.nf).split("-")[0].trim()), se: String(x.nf).split("-")[1], t: x.transportadora })).filter((x) => cnpjDaSerie(x.se));
  const cnpj = cnpjDaSerie((it[0] || {}).se);
  if (!cnpj) log("sem NFs"); else {
    const r = await pagina("https://ssw.inf.br/2/ssw_resultSSW", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ NR: it.map((x) => x.n).join("\r\n"), cnpj, chave: chaveDe(it[0].t), urlori: "https://ssw.inf.br/ajuda/rastreamento.html" }).toString() });
    const m = lerLote(r.txt), c = {}; m.forEach((v) => (c[v.situacao] = (c[v.situacao] || 0) + 1));
    log("HTTP", r.status, "bytes", r.txt.length, "enviadas", it.length, "lidas", m.size, "casam", it.filter((x) => m.has(x.n)).length, JSON.stringify(c));
    let k = 0; for (const bloco of r.txt.split(/<tr\b/i).slice(1)) { if (!/opx\(/.test(bloco.slice(0, 300)) || k++ >= 6) continue;
      const tds = bloco.split(/<td\b/i).slice(1), dl = (t) => sohTexto("<td " + (t || "")).join(" | ").replace(/\d+/g, (d) => "d" + d.length).replace(/[A-Za-zÀ-ú]{2,}/g, (w) => (/^(mercadoria|entregue|previs|entrega|informa|dispon|situa)/i.test(w) ? w : "x"));
      log(`linha ${k}: tds ${tds.length} · inicio ${bloco.slice(0, 60).replace(/\d+/g, "#").replace(/id=[^&'"]+/g, "id=*")} · td0 [${dl(tds[0])}] · td1 [${dl(tds[1])}] · td2 [${dl(tds[2]).slice(0, 160)}]`); }
    log("NFs distintas", new Set(it.map((x) => x.n)).size, "séries", new Set(it.map((x) => x.se)).size);
    log("tr total", (r.txt.match(/<tr\b/gi) || []).length, "tr com background", (r.txt.match(/<tr[^>]*background-color/gi) || []).length, "opx", (r.txt.match(/opx\(/g) || []).length);
    const corpo = r.txt.replace(/\s+/g, " "), i0 = corpo.search(/<tr[^>]*opx/i);
    const mask = (t) => t.replace(/\d+/g, "#").replace(/>[^<]+</g, (z) => ">" + z.slice(1, -1).replace(/[A-Za-zÀ-ú]{2,}/g, (w) => (OK_PAL.test(w) || /^(situa|entreg|unidade|data|hora|nota|fiscal|previs|mercadoria|informa|dispon)/i.test(w) ? w : "x")) + "<");
    if (i0 >= 0) mask(corpo.slice(Math.max(0, i0 - 200), i0 + 1500)).match(/.{1,300}/g).forEach((z) => log("  " + z.replace(/id=[^&'"]+|md=[^&'"]+/g, "id=*")));
  }
}
if (MODO === "diag-lote3") {   // separador das NFs no lote (CRLF, vírgula, espaço...): só contagens e estrutura mascarada
  await entrarSupabase(); await carregarSenhasDB();
  const L = (await chamar(`conferencia_ssw?select=nf,transportadora,situacao&transportadora=ilike.*flog*&situacao=in.(entregue,nao%20entregue)&nf=like.*-25&limit=12`));
  const it = L.map((x) => ({ ...x, n: String(x.nf).split("-")[0].trim() })), cnpj = cnpjDaSerie("25"), chave = chaveDe((it[0] || {}).transportadora);
  log("NFs:", it.length, JSON.stringify(it.reduce((m, x) => (m[x.situacao] = (m[x.situacao] || 0) + 1, m), {})));
  for (const [rot, sep] of [["CRLF", "\r\n"], ["virgula", ","], ["espaco", " "], ["ponto-virgula", ";"]]) {
    const r = await pagina("https://ssw.inf.br/2/ssw_resultSSW", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ NR: it.map((x) => x.n).join(sep), cnpj, chave, urlori: "https://ssw.inf.br/ajuda/rastreamento.html" }).toString() });
    const trs = r.txt.split(/<tr[\s>]/i).slice(2).filter((l) => /class="rastreamento"/.test(l));
    let bate = 0; const conf = {};
    for (const x of it) { const re = new RegExp("(^|\\D)0*" + x.n + "(\\D|$)"); const tr = trs.filter((l) => re.test(sohTexto("<tr " + l).join(" ")));
      const t = sohTexto("<tr " + tr.join(" ")).join(" "); const v = !tr.length ? "não listada" : tr.length > 1 && trs.length < 2 ? "?" : /MERCADORIA ENTREGUE|ENTREGA REALIZADA/i.test(t) ? "entregue" : /n[ãa]o dispon|n[ãa]o encontr/i.test(t) ? "sem cte" : "nao entregue";
      if (v === x.situacao) bate++; conf[x.situacao + "→" + v] = (conf[x.situacao + "→" + v] || 0) + 1; }
    log(`${rot}: HTTP ${r.status} · ${r.txt.length} bytes · linhas de resultado ${trs.length} · iguais ao robô ${bate}/${it.length} · ${JSON.stringify(conf)} · links detalhe ${(r.txt.match(/ops\(|opx\(|SSWDetalhado/g) || []).length}`);
    if (trs[0]) log("  linha 1:", sohTexto("<tr " + trs[0]).map(limpo).join(" | ").slice(0, 300), "· tags:", tags("<tr " + trs[0], /<(td|a|p)[^>]*>/gi).map((y) => y.replace(/\d{3,}/g, "#").replace(/style="[^"]*"/g, "")).slice(0, 10).join(" "));
    await new Promise((ok) => setTimeout(ok, 3000));
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
  for (const [EH, fn] of [[EH_JADLOG, process.env.JADLOG_TOKEN ? jadlog : null], [EH_BENTO, bento], [EH_TRANSITO, transito], [EH_FORMATO, formato]]) if (fn) {   // Jadlog (API) e Bento (site): antes do SSW
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
  let nReal = 0;
  for (const l of fila) {
    if (Date.now() > fimEm) { log("Tempo da rodada acabou; o resto fica para a próxima."); break; }
    if (nReal++ % 25 === 0 && await cederParaTudo()) break;
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
// botão "Conferir tudo agora" (parte 25): enquanto essa conferência estiver em andamento, as outras rodadas não consultam o SSW
async function pedidoTudo() {
  const r = await chamar("conferencia_pedido?select=pedido_em,feito_em&id=eq.1").catch(() => null);
  const c = r && r[0]; if (!c || !c.pedido_em) return null;
  const em = Date.parse(c.pedido_em), ativo = (!c.feito_em || Date.parse(c.feito_em) < em) && em > Date.now() - 24 * 3600000;
  return { em, ativo, iso: c.pedido_em };
}
const TUDO = MODO === "conferencia-tudo";
async function cederParaTudo() { if (TUDO) return false; const t = await pedidoTudo(); if (t && t.ativo) { log("Tem uma conferência de tudo (botão do painel) em andamento; paro para ela rodar."); return true; } return false; }
async function conferir(minutos) {
  await carregarSenhasDB();
  if (TUDO) return conferirTudo(minutos);
  if (await cederParaTudo()) return;
  // confere TODOS os pendentes, os de previsão mais antiga primeiro (vencidos e urgentes saem antes)
  const lista = [];
  for (let de = 0; ; de += 1000) { const L = await chamar(`conferencia_ssw?select=pedido,nf,transportadora,prev_cliente&situacao=eq.pendente&order=prev_cliente.asc.nullsfirst,pedido&limit=1000&offset=${de}`); lista.push(...L); if (L.length < 1000) break; }
  // "Informação não disponível" (CT-e ainda não emitido) e "não entregue": confere de novo 1 vez a cada 20 h, depois dos pendentes (Brenda, 13/11)
  { const antes = new Date(Date.now() - 20 * 3600000).toISOString();
    const L = await chamar(`conferencia_ssw?select=pedido,nf,transportadora,prev_cliente,situacao&situacao=in.(fora%20do%20ssw,sem%20cte,sem%20permissao,nao%20entregue)&consultado_em=lt.${antes}&order=prev_cliente.asc.nullsfirst&limit=2000`).catch(() => []);
    const de_novo = L.filter((x) => !FORA_SSW.test(x.transportadora || "") && (!/sem permissao/.test(x.situacao || "") || chaveDe(x.transportadora)));
    // "Pede senha" de transportadora com senha cadastrada: confere já, sem esperar 20 h
    for (let de = 0; ; de += 1000) { const P = await chamar(`conferencia_ssw?select=pedido,nf,transportadora,prev_cliente,situacao&situacao=eq.sem%20permissao&consultado_em=gte.${antes}&order=pedido&limit=1000&offset=${de}`).catch(() => []);
      de_novo.unshift(...P.filter((x) => chaveDe(x.transportadora))); if (P.length < 1000) break; }
    lista.unshift(...de_novo.filter((x) => x.situacao === "sem permissao")); lista.push(...de_novo.filter((x) => x.situacao !== "sem permissao"));
    if (de_novo.length) log(`Conferência SSW: ${de_novo.length.toLocaleString("pt-BR")} para conferir de novo (sem CT-e, pede senha ou não entregue há mais de 20 h).`); }
  if (!lista.length) { log("Conferência SSW: nada pendente."); return; }
  return conferirLista(lista, minutos);
}
async function conferirLista(lista, minutos) {
  for (const [EH, fn, nome] of [[EH_JADLOG, process.env.JADLOG_TOKEN ? jadlog : null, "jadlog"], [EH_BENTO, bento, "bento"], [EH_TRANSITO, transito, "sito*brasil"], [EH_FORMATO, formato, "formato"]]) if (fn) {   // Jadlog (API) e Bento (site): antes do SSW
    const jad = lista.filter((l) => EH.test(l.transportadora || ""));
    // fora do SSW e rápido: confere de novo toda a transportadora que ainda não foi entregue
    for (let de = 0; ; de += 1000) { const L = await chamar(`conferencia_ssw?select=pedido,nf,transportadora,detalhe&transportadora=ilike.*${nome}*&${nome === "jadlog" ? "or=(situacao.neq.entregue,detalhe.is.null)" : "situacao=neq.entregue"}&order=pedido&limit=1000&offset=${de}`).catch(() => []);
      L.forEach((x) => { if (!(x.detalhe && x.detalhe.emissor) && !jad.some((y) => y.pedido === x.pedido)) jad.push(x); }); if (L.length < 1000) break; }
    // ajuste único de 13/11 (carta de correção): pedidos já passados para a transportadora que emitiu o CT-e não são mais mexidos aqui
    for (let i = jad.length - 1; i >= 0; i--) if (jad[i].detalhe && jad[i].detalhe.emissor) jad.splice(i, 1);
    for (let i = lista.length - 1; i >= 0; i--) if (EH.test(lista[i].transportadora || "")) lista.splice(i, 1);
    const m = await fn(jad), linhas = jad.filter((l) => m.has(l.pedido)).map((l) => { const r = m.get(l.pedido);
      return { pedido: l.pedido, situacao: r.situacao, ultimo_evento: r.ultimo_evento || null, data_evento: r.data_evento || null, data_entrega: r.data_entrega || null, detalhe: r.detalhe ? { ...r.detalhe, previsao: r.previsao || r.detalhe.previsao || null } : r.previsao ? { fonte: nome, previsao: r.previsao } : null }; });
    for (let i = 0; i < linhas.length; i += 50) await chamar("rpc/gravar_conferencia", "POST", { linhas: linhas.slice(i, i + 50) }).catch((e) => log("Não gravei um lote Jadlog:", e.message.slice(0, 120)));
  }
  { // Transiga (fora do SSW): desfaz resultados antigos do SSW (eram da first mile); o que veio do webhook da Transiga fica
    const F = [];
    for (let de = 0; ; de += 1000) { const P = await chamar(`conferencia_ssw?select=pedido,transportadora,situacao,detalhe&situacao=not.in.(fora%20do%20ssw,sem%20nf)&transportadora=ilike.*transiga*&order=pedido&limit=1000&offset=${de}`).catch(() => []); F.push(...P); if (P.length < 1000) break; }
    const fx = F.filter((x) => FORA_SSW.test(x.transportadora || "") && !(x.detalhe && x.detalhe.fonte === "Transiga")).map((x) => ({ pedido: x.pedido, situacao: "fora do ssw", ultimo_evento: null, data_evento: null, data_entrega: null }));
    for (let i = 0; i < fx.length; i += 50) await chamar("rpc/gravar_conferencia", "POST", { linhas: fx.slice(i, i + 50) }).catch(() => {});
    if (fx.length) log(`Conferência SSW: ${fx.length.toLocaleString("pt-BR")} de transportadora fora do SSW corrigidos.`);
    const tira = new Set(fx.map((x) => x.pedido)); for (let i = lista.length - 1; i >= 0; i--) if (tira.has(lista[i].pedido)) lista.splice(i, 1);
  }
  log(`Conferência SSW: ${lista.length.toLocaleString("pt-BR")} pedido(s) para conferir.`);
  const PAUSA = Number(process.env.SSW_PAUSA || 2500), fim = Date.now() + minutos * 60000, cont = {}, grava = [];
  const dorme = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const salvar = async () => { if (grava.length) { const lote = grava.splice(0); try { await chamar("rpc/gravar_conferencia", "POST", { linhas: lote }); } catch (e) { log("Não gravei um lote:", e.message.slice(0, 120)); } } };
  let bloq = 0, nCiclo = 0, nPrev = 0;
  const desde = TUDO ? await pedidoTudo() : null;
  const mudouTudo = async () => { const t = await pedidoTudo(); return !!(t && desde && t.em !== desde.em); };
  for (const l of lista) {
    if (Date.now() > fim) { log("Tempo acabou; o resto fica para a próxima rodada."); if (MODO === "conferencia" || TUDO) (await import("node:fs")).writeFileSync("continuar", "1"); break; }
    if (++nCiclo % 25 === 0 && (TUDO ? await mudouTudo() : await cederParaTudo())) break;
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
      // não entregue, vencido ou vence em até 5 dias: guarda a previsão do SSW (o painel grava na Nova data se for depois da prometida)
      const lim = new Date(Date.now() - 3 * 3600000 + 5 * 86400000).toISOString().slice(0, 10);
      if (r.situacao === "nao entregue" && l.prev_cliente && l.prev_cliente <= lim) {   // vencidos também (Brenda, 13/11)
        let pv = lerResultado(pg.txt).previsao;
        const det = !pv && (pg.txt.match(/opx\('(\/2\/ssw_SSWDetalhado\?[^']+)'\)/) || [])[1];
        if (det) { const d = await pagina("https://ssw.inf.br" + det.replace(/&amp;/g, "&")).catch(() => null); if (d && d.status === 200) pv = lerResultado(d.txt).previsao; await dorme(PAUSA); }
        if (pv) { r.detalhe = { fonte: "SSW", previsao: pv }; nPrev++; }
      }
    }
    cont[r.situacao] = (cont[r.situacao] || 0) + 1;
    grava.push({ pedido: l.pedido, situacao: r.situacao, ultimo_evento: r.ultimo_evento || null, data_evento: r.data_evento || null, data_entrega: r.data_entrega || null, detalhe: r.detalhe || null });
    if (grava.length >= 50) await salvar();
  }
  await salvar();
  log("Conferência SSW:", Object.entries(cont).map(([k, v]) => `${k} ${v}`).join(" · "), nPrev ? `· previsão do SSW guardada (vencidos e vencem em até 5 dias) ${nPrev}` : "");
  if (TUDO) { const { existsSync } = await import("node:fs"); if (!existsSync("continuar") && !(await mudouTudo())) { await chamar("rpc/fim_conferencia_tudo", "POST", {}).catch(() => {}); log("Conferência de tudo terminada."); } }
}
// "Conferir tudo agora": todos os pedidos da lista que não estão entregues e ainda não foram conferidos desde o clique
async function conferirTudo(minutos) {
  const t = await pedidoTudo(); if (!t) { log("Ninguém pediu conferência de tudo."); return; }
  const lista = [];
  for (let de = 0; ; de += 1000) { const L = await chamar(`conferencia_ssw?select=pedido,nf,transportadora,prev_cliente,situacao,detalhe&situacao=neq.entregue&or=(consultado_em.is.null,consultado_em.lt.${encodeURIComponent(t.iso)})&order=prev_cliente.asc.nullsfirst,pedido&limit=1000&offset=${de}`); lista.push(...L); if (L.length < 1000) break; }
  log(`Conferir tudo: ${lista.length.toLocaleString("pt-BR")} pedido(s) ainda não conferidos desde o clique.`);
  return conferirLista(lista, minutos);
}
// ===== Conferência em lotes de 100 NFs (formulário da ajuda do SSW, NFs separadas por quebra de linha CRLF) =====
// Pedido da Brenda (16/11): todas as transportadoras do SSW, 100 em 100; sem senha e com senha (senha cadastrada);
// NF que não aparece com o CNPJ da série é procurada com os outros CNPJ; se não aparecer em nenhum = sem CT-e.
function sem0(n) { return String(n || "").replace(/^0+(?=\d)/, ""); }
function lerLote(html) {   // uma linha por NF: número, data/hora do último evento, situação, descrição (pode ter a previsão)
  const linhas = new Map(), iso = (d) => { const [dd, mm, aa] = d.split("/"); return `${aa.length === 2 ? "20" + aa : aa}-${mm}-${dd}`; };
  for (const bloco of html.split(/<tr style="background-color:#(?:FFFFFF|F0F0F0);(?:cursor:pointer;)?"/i).slice(1)) {
    const tds = bloco.split(/<td\b/i).slice(1); if (tds.length < 3) continue;
    const nums0 = (sohTexto("<td " + tds[0])[0] || "").match(/\d+/g) || [];
    const nf = sem0(nums0.pop()); if (!nf) continue;
    // com outro CNPJ o SSW mostra "série NF ..." na 1ª célula: guardo a série para não aceitar a NF de mesmo número de outra série (TSL/Tradicional série 34, 16/11)
    const serieAchada = nums0.length ? sem0(nums0[0]) : null;   // 1ª linha = "série NF" (achada) ou só "NF"; a 2ª é o CT-e
    const quando = (sohTexto("<td " + tds[1]).join(" ").match(/(\d{2}\/\d{2}\/\d{2,4})(?:\s+(\d{2}:\d{2}))?/) || []);
    const sigla = (sohTexto((tds[2].match(/<p class=titulo>[\s\S]*?<font[^>]*>([\s\S]*?)<\/font>/i) || [])[1] || "").join(" ").match(/\(([^)]*)\)/) || [])[1] || "";
    const titulo = sohTexto(((tds[2].match(/<p class=titulo>([\s\S]*?)<\/p>/i) || [])[1] || "").replace(/<font[\s\S]*?<\/font>/gi, "")).join(" ").trim();
    const desc = sohTexto((tds[2].match(/<p class=tdb>([\s\S]*?)<\/p>/i) || [])[1] || "").join(" ");
    const tudo = titulo + " " + desc, raj = /^RAJ\b/i.test(sigla.trim()) || /\bRAJ MOV\b/i.test(sohTexto("<td " + tds[1]).join(" "));
    let r;
    if (/n[ãa]o tem permiss[ãa]o/i.test(tudo)) r = { situacao: "sem permissao" };
    else if (/informa[cç][aã]o n[ãa]o dispon/i.test(tudo) || !quando[1]) r = { situacao: "sem cte" };
    else if (/MERCADORIA ENTREGUE|ENTREGA REALIZADA/i.test(titulo)) r = { situacao: "entregue", data_entrega: iso(quando[1]), data_evento: iso(quando[1]), ultimo_evento: "MERCADORIA ENTREGUE" };
    else { const pv = (desc.match(/Previs[aã]o de entrega:\s*(\d{2}\/\d{2}\/\d{2,4})/i) || [])[1];
      r = { situacao: "nao entregue", data_evento: iso(quando[1]), ultimo_evento: /^[A-ZÀ-Ú0-9 \-\/.]{3,60}$/.test(titulo) ? titulo : null, previsao: pv ? iso(pv) : null }; }
    r.sigla = sigla.trim().slice(0, 20) || null; r.raj = raj; r.serie = serieAchada; r.det = (bloco.slice(0, 400).match(/opx\('(\/2\/ssw_SSWDetalhado\?[^']+)'\)/) || [])[1] || null;
    (linhas.get(nf) || linhas.set(nf, []).get(nf)).push(r);
  }
  // a mesma NF em mais de uma linha: vale entregue; senão o evento mais recente. _semRaj = o mesmo sem as linhas da Rajlog (milk run)
  const rank = (x) => (x.situacao === "entregue" ? 3 : x.situacao === "nao entregue" ? 2 : x.situacao === "sem permissao" ? 1 : 0);
  const melhor = (L) => L.reduce((a, r) => (!a || rank(r) > rank(a) || (rank(r) === rank(a) && String(r.data_evento || "") > String(a.data_evento || "")) ? r : a), null);
  const out = new Map();
  linhas.forEach((L, nf) => out.set(nf, { ...melhor(L), _semRaj: melhor(L.filter((r) => !r.raj)), _temRaj: L.some((r) => r.raj), _L: L }));
  lerLote.melhor = melhor;
  return out;
}
// Dominalog, Tempo Justo, Trans Sua e Transvanio nas séries 25, 34 e 35: o CT-e da Rajlog é o milk run (coleta), não a entrega ao cliente.
// Vale só o rastreio da Dominalog; se só tiver a Rajlog, ainda não foi entregue. (Regra da Brenda, 16/11.)
function REGRA_RAJ(transp, nf) { return /dominalog|tempo\s*justo|trans\s*sua|transvanio/i.test(transp || "") && ["25", "34", "35"].includes(String(nf || "").split("-")[1]?.trim()); }
function pegaLote(m, x) {
  let v = m.get(x.n); if (!v) return null;
  const se = sem0(String(x.nf || "").split("-")[1]?.trim() || "");
  // Regra da Brenda (16/11): no SSW aparece "SÉRIE NOTA"; só vale (entregue ou qualquer status) se nota E série forem iguais às do E-loggia.
  const vale = (r) => r.situacao === "sem cte" || r.situacao === "sem permissao" || (se ? r.serie === se : !r.serie || true);
  if (v._L.some((r) => !vale(r))) {   // linha sem a série ou de outra série = não dá para garantir que é a mesma nota: descarta
    const L = v._L.filter(vale); if (!L.length) return null;
    const mm = lerLote.melhor; v = { ...mm(L), _semRaj: mm(L.filter((r) => !r.raj)), _temRaj: L.some((r) => r.raj), _L: L }; }
  if (!REGRA_RAJ(x.transportadora, x.nf) || !v._temRaj) return v;
  if (v._semRaj && v._semRaj.situacao !== "sem cte") return v._semRaj;
  const raj = v; return { situacao: "nao entregue", ultimo_evento: "MILK RUN (RAJLOG) - SEM DOMINALOG AINDA", data_evento: raj.data_evento || null, previsao: null, sigla: raj.sigla };
}
async function conferirLote() {
  const t0 = Date.now(); await carregarSenhasDB();
  const lista = [];
  for (let de = 0; ; de += 1000) { const L = await chamar(`conferencia_ssw?select=pedido,nf,transportadora,prev_cliente,situacao,detalhe&situacao=neq.entregue&order=pedido&limit=1000&offset=${de}`); lista.push(...L); if (L.length < 1000) break; }
  // "entregue" achado com outro CNPJ: confere de novo (antes não olhava a série e podia ser outra nota com o mesmo número)
  { const E = await chamar(`conferencia_ssw?select=pedido,nf,transportadora,prev_cliente,situacao,detalhe&situacao=eq.entregue&detalhe->>serie_ok=is.null&order=pedido&limit=2000`).catch(() => []);
    E.forEach((l) => { l.detalhe = { ...(l.detalhe || {}), tentados: [] }; }); lista.push(...E); if (E.length) log(`Reconfiro ${E.length} entregues ainda sem a checagem da série`); }
  // Série 35 (dropshipping) da TSL: a TSL só faz a first mile; fora do RJ o rastreio que vale é o da transportadora de redespacho (Promob).
  // Para RJ a TSL emite o CT-e da entrega e segue o rastreio da TSL. (Regra da Brenda, 16/11.)
  // (inclui as já "entregues" pela TSL fora do RJ: podem ter sido a entrega da first mile, então reconfere pelo redespacho)
  { const jaEnt = await chamar(`conferencia_ssw?select=pedido,nf,transportadora,prev_cliente,situacao,detalhe&situacao=eq.entregue&transportadora=ilike.*tsl*&nf=like.*-35&limit=5000`).catch(() => []);
    const tem = new Set(lista.map((l) => l.pedido)); jaEnt.forEach((l) => { if (!tem.has(l.pedido)) lista.push({ ...l, _jaEnt: true }); }); }
  { const L = await chamar(`conferencia_ssw?select=pedido,nf,transportadora,prev_cliente,situacao,detalhe&situacao=eq.entregue&or=(transportadora.ilike.*dominalog*,transportadora.ilike.*tempo*justo*,transportadora.ilike.*trans*sua*,transportadora.ilike.*transvanio*)&limit=5000`).catch(() => []);
    const tem = new Set(lista.map((l) => l.pedido)); let n = 0;
    L.forEach((l) => { if (REGRA_RAJ(l.transportadora, l.nf) && !tem.has(l.pedido) && !(l.detalhe && /dominalog/i.test(l.detalhe.emissor || ""))) { lista.push(l); n++; } });
    if (n) log(`Rajlog (milk run): reconfiro ${n} já marcados como entregues`); }
  { const tsl = lista.filter((l) => /\btsl\b/i.test(l.transportadora || "") && String(l.nf || "").split("-")[1]?.trim() === "35");
    let rj = 0, redesp = 0, semRd = 0; const B = new Map();
    for (let i = 0; i < tsl.length; i += 100) { const ids = tsl.slice(i, i + 100).map((l) => `"${String(l.pedido).replace(/"/g, "")}"`).join(",");
      (await chamar(`base_pedidos?select=pedido,uf,rd:extra->>redespacho&pedido=in.(${encodeURIComponent(ids)})`).catch(() => [])).forEach((b) => B.set(b.pedido, b)); }
    const fora = new Set();
    for (const l of tsl) { const b = B.get(l.pedido) || {};
      if (String(b.uf || "").trim().toUpperCase() === "RJ") { rj++; if (l._jaEnt) fora.add(l.pedido); continue; }
      if (b.rd && String(b.rd).trim()) { l.transportadora = String(b.rd).trim(); redesp++; }   // só para escolher onde rastrear; não grava a transportadora
      else { fora.add(l.pedido); semRd++; } }
    lista.forEach((l) => { if (l._jaEnt && !/\btsl\b/i.test(l.transportadora || "")) delete l._jaEnt; else if (l._jaEnt) fora.add(l.pedido); });
    if (fora.size) { const resto = lista.filter((l) => !fora.has(l.pedido)); lista.length = 0; lista.push(...resto); }
    if (tsl.length) log(`TSL série 35: ${rj} RJ (rastreio TSL) · ${redesp} pelo redespacho · ${semRd} sem redespacho na base (não conferidos)`); }
  // Jadlog: API própria (100 por chamada), roda ao mesmo tempo que o SSW
  const jad = lista.filter((l) => EH_JADLOG.test(l.transportadora || ""));
  const pJad = (async () => { if (jad.length && process.env.JADLOG_TOKEN) { const m = await jadlog(jad).catch(() => new Map());
    const linhas = jad.filter((l) => m.has(l.pedido)).map((l) => { const r = m.get(l.pedido); return { pedido: l.pedido, situacao: r.situacao, ultimo_evento: r.ultimo_evento || null, data_evento: r.data_evento || null, data_entrega: r.data_entrega || null, detalhe: r.detalhe ? { ...r.detalhe, previsao: r.previsao || r.detalhe.previsao || null } : null }; });
    for (let i = 0; i < linhas.length; i += 200) await chamar("rpc/gravar_conferencia", "POST", { linhas: linhas.slice(i, i + 200) }).catch((e) => log("Não gravei um lote Jadlog:", e.message.slice(0, 120)));
    log(`Jadlog (API): ${linhas.length} conferidos · ${Math.round((Date.now() - t0) / 1000)} s`); } })().catch((e) => log("Jadlog parou:", String(e.message).slice(0, 80)));
  // Transiga: não usa SSW; o rastreio chega por webhook na tabela rastreio_transiga (Arquivo Recebido = sem CT-e)
  const pTransiga = (async () => { const tg = lista.filter((l) => /transiga/i.test(l.transportadora || "")); if (!tg.length) return;
    const ch = (v) => String(v || "").trim().split("-").map((x) => x.trim().replace(/\.0+$/, "").replace(/^0+(?=\d)/, "")).join("-");
    const R = new Map(); for (let de = 0; ; de += 1000) { const L = await chamar(`rastreio_transiga?select=nf,descricao,data_evento,previsao,entregue,data_entrega&order=nf&limit=1000&offset=${de}`); L.forEach((x) => R.set(x.nf, x)); if (L.length < 1000) break; }
    const linhas = tg.filter((l) => R.has(ch(l.nf))).map((l) => { const x = R.get(ch(l.nf)), d = (v) => (v ? String(v).slice(0, 10) : null);
      const sit = x.entregue ? "entregue" : /arquivo recebido/i.test(x.descricao || "") ? "sem cte" : "nao entregue";
      return { pedido: l.pedido, situacao: sit, ultimo_evento: (x.descricao || "").toUpperCase().slice(0, 60) || null, data_evento: d(x.data_evento), data_entrega: x.entregue ? d(x.data_entrega || x.data_evento) : null,
        detalhe: { ...(l.detalhe || {}), fonte: "Transiga", previsao: x.previsao || null, eventos: x.descricao ? [{ data: String(x.data_entrega || x.data_evento || "").slice(0, 16), status: String(x.descricao).toUpperCase().slice(0, 60), unidade: "" }] : [] } }; });
    for (let i = 0; i < linhas.length; i += 200) await chamar("rpc/gravar_conferencia", "POST", { linhas: linhas.slice(i, i + 200) }).catch((e) => log("Não gravei um lote Transiga:", e.message.slice(0, 120)));
    log(`Transiga (webhook): ${linhas.length} de ${tg.length} com rastreio · ${R.size} NFs recebidas até agora · ${[...R.values()].filter((x) => x.previsao).length} com previsão`); })().catch((e) => log("Transiga parou:", String(e.message).slice(0, 80)));
  // Formato: site próprio com login; Follow-Up das Entregas (lote) + Consulta NF para quem não aparece nele
  const pFormato = (async () => { const F = [];
    for (let de = 0; ; de += 1000) { const P = await chamar(`conferencia_ssw?select=pedido,nf,transportadora,detalhe,consultado_em&transportadora=ilike.*formato*&situacao=neq.entregue&order=pedido&limit=1000&offset=${de}`).catch(() => []); F.push(...P); if (P.length < 1000) break; }
    const fm = F; if (!fm.length) return;   // Follow-Up: todas de uma vez; uma a uma só quem não está no relatório e não foi olhado nas últimas 4 h
    const m = await formato(fm, (x) => x.detalhe && x.detalhe.fonte === "Formato" && x.consultado_em && Date.now() - Date.parse(x.consultado_em) < 4 * 3600000);
    const linhas = fm.filter((l) => m.has(l.pedido)).map((l) => { const r = m.get(l.pedido); return { pedido: l.pedido, situacao: r.situacao, ultimo_evento: r.ultimo_evento || null, data_evento: r.data_evento || null, data_entrega: r.data_entrega || null, detalhe: r.detalhe ? { ...r.detalhe, previsao: r.previsao || r.detalhe.previsao || null } : { fonte: "Formato" } }; });
    for (let i = 0; i < linhas.length; i += 100) await chamar("rpc/gravar_conferencia", "POST", { linhas: linhas.slice(i, i + 100) }).catch((e) => log("Não gravei um lote Formato:", e.message.slice(0, 120)));
    log(`Formato (site): ${linhas.length} de ${fm.length} conferidos · ${Math.round((Date.now() - t0) / 1000)} s`); })().catch((e) => log("Formato parou:", String(e.message).slice(0, 80)));
  // Bento Brasil e Trânsito Brasil: site próprio, uma nota por vez (com pausa). Antes só rodavam no "Conferir tudo agora";
  // agora entram em toda rodada em lote, só as não entregues que não foram olhadas nas últimas 2 h.
  const pSites = (async () => { for (const [EH, fn, nome] of [[EH_BENTO, bento, "bento"], [EH_TRANSITO, transito, "sito*brasil"]]) {
    const F = []; for (let de = 0; ; de += 1000) { const P = await chamar(`conferencia_ssw?select=pedido,nf,transportadora,detalhe,consultado_em&transportadora=ilike.*${nome}*&situacao=neq.entregue&order=pedido&limit=1000&offset=${de}`).catch(() => []); F.push(...P); if (P.length < 1000) break; }
    const fila = F.filter((x) => !(x.detalhe && x.detalhe.emissor) && !(x.consultado_em && Date.now() - Date.parse(x.consultado_em) < 2 * 3600000)).slice(0, 300);
    if (!fila.length) continue;
    const m = await fn(fila), linhas = fila.filter((l) => m.has(l.pedido)).map((l) => { const r = m.get(l.pedido);
      return { pedido: l.pedido, situacao: r.situacao, ultimo_evento: r.ultimo_evento || null, data_evento: r.data_evento || null, data_entrega: r.data_entrega || null, detalhe: r.detalhe ? { ...r.detalhe, previsao: r.previsao || r.detalhe.previsao || null } : r.previsao ? { fonte: nome, previsao: r.previsao } : null }; });
    for (let i = 0; i < linhas.length; i += 100) await chamar("rpc/gravar_conferencia", "POST", { linhas: linhas.slice(i, i + 100) }).catch((e) => log(`Não gravei um lote ${nome}:`, e.message.slice(0, 120)));
    log(`${nome === "bento" ? "Bento Brasil" : "Trânsito Brasil"} (lote): ${linhas.length} de ${fila.length} conferidos (${F.length} não entregues) · ${Math.round((Date.now() - t0) / 1000)} s`); } })().catch((e) => log("Bento/Trânsito parou:", String(e.message).slice(0, 80)));
  // SSW: tudo que não é Jadlog, Bento, Trânsito Brasil (sistemas próprios) nem fora do SSW
  const ssw = lista.filter((l) => !EH_JADLOG.test(l.transportadora || "") && !EH_BENTO.test(l.transportadora || "") && !EH_FORMATO.test(l.transportadora || "") && !(EH_TRANSITO.test(l.transportadora || "") && !(l.detalhe && l.detalhe.emissor)) && !FORA_SSW.test(l.transportadora || ""));
  // CNPJ: o da série, ou o outro CNPJ em que essa NF já foi achada antes (detalhe.cnpj_outro)
  const TODOS = Object.keys(CNPJ_SERIE), cheio = (suf) => (suf ? TODOS.find((c) => c.endsWith(suf)) : null);
  const aprendido = new Map();   // transportadora → CNPJ → vezes que a NF foi achada nele (fora o da série)
  const conta = (t, c) => { const m = aprendido.get(t) || aprendido.set(t, new Map()).get(t); m.set(c, (m.get(c) || 0) + 1); };
  lista.forEach((l) => { const c = cheio(l.detalhe && l.detalhe.cnpj_outro); if (c) conta(l.transportadora, c); });
  const grupos = new Map(), semNf = [];
  for (const l of ssw) { const [num, ser] = String(l.nf || "").split("-").map((x) => (x || "").trim()); const cs = cnpjDaSerie(ser);
    if (!num || !cs) { semNf.push(l); continue; } const c = cheio(l.detalhe && l.detalhe.cnpj_outro) || cs;
    const ch = l.detalhe && l.detalhe.sem_senha ? "" : chaveDe(l.transportadora), k = c + "|" + ch; (grupos.get(k) || grupos.set(k, []).get(k)).push({ ...l, n: sem0(num), cs, c1: c }); }
  const PAUSA = Number(process.env.SSW_PAUSA || 1200), REPESCA = Number(process.env.SSW_REPESCA || 60), dorme = (ms) => new Promise((ok) => setTimeout(ok, ms));
  let consultas = 0, bloq = 0, retentando = false;
  async function lote(cnpj, chave, nums) {
    for (;;) {
      const r = await pagina("https://ssw.inf.br/2/ssw_resultSSW", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ NR: nums.join("\r\n"), cnpj, chave, urlori: "https://ssw.inf.br/ajuda/rastreamento.html" }).toString() }).catch(() => null);
      consultas++; await dorme(PAUSA);
      if (r && r.status === 200) return lerLote(r.txt);
      if (++bloq > 3 || retentando) throw new Error("SSW bloqueando");
      log(`SSW respondeu ${r ? r.status : "sem resposta"}; espero ${bloq} min.`); await dorme(bloq * 60000);
    }
  }
  const res = new Map(), cont = {}, tentados = new Map();   // pedido → resultado · pedido → CNPJs (6 últimos) já tentados sem achar
  const montar = (lista) => lista.filter((l) => res.has(l.pedido)).map((l) => { const r = res.get(l.pedido), ser = String(l.nf).split("-")[1];
    const tt = r.situacao === "sem cte" ? (tentados.get(l.pedido) || (l.detalhe && l.detalhe.tentados) || null) : null;
    const det = { ...(l.detalhe && l.detalhe.emissor ? l.detalhe : {}), ...(r.previsao ? { fonte: (l.detalhe && l.detalhe.fonte) || "SSW", previsao: r.previsao } : {}),
      ...(r._cnpj && r._cnpj !== cnpjDaSerie(ser) && r.situacao !== "sem cte" ? { cnpj_outro: r._cnpj.slice(-6) } : {}), ...(r.situacao === "entregue" || r.situacao === "nao entregue" ? { serie_ok: true } : {}), ...(tt && tt.length ? { tentados: tt } : {}), ...(r._semSenha && r.situacao !== "sem cte" ? { sem_senha: true } : {}), ...(r.sigla ? { sigla: r.sigla } : {}), ...(r.emissor ? { emissor: r.emissor } : {}) };
    if (r.situacao !== "sem cte") delete det.tentados; if (!r._semSenha) delete det.sem_senha;
    return { pedido: l.pedido, situacao: r.situacao, ultimo_evento: r.ultimo_evento || null, data_evento: r.data_evento || null, data_entrega: r.data_entrega || null, detalhe: Object.keys(det).length ? det : null }; });
  const gravar = async (linhas) => { for (let i = 0; i < linhas.length; i += 200) await chamar("rpc/gravar_conferencia", "POST", { linhas: linhas.slice(i, i + 200) }).catch((e) => log("Não gravei um lote:", e.message.slice(0, 120))); };
  let gravados = false; const mexidos = new Set(); let achou = 0; const semSenhaAchou = {};
  try {
    for (const [k, itens] of grupos) { const [cnpj, chave] = k.split("|");
      for (let i = 0; i < itens.length; i += 100) { const parte = itens.slice(i, i + 100), m = await lote(cnpj, chave, [...new Set(parte.map((x) => x.n))]);
        parte.forEach((x) => res.set(x.pedido, { ...(pegaLote(m, x) || { situacao: "sem cte" }), _cnpj: cnpj, _semSenha: !chave && !!chaveDe(x.transportadora) })); } }
    log(`SSW: ${ssw.length - semNf.length} NFs em ${consultas} consultas · ${Math.round((Date.now() - t0) / 1000)} s`);
    // Dominalog/Tempo Justo/Trans Sua/Transvanio (séries 25, 34, 35): "entregue" só vale se quem emitiu o CT-e é a Dominalog
    // (outras transportadoras nessas notas são milk run / first mile). Confere no detalhe do SSW quem está transportando.
    { let ok = 0, nao = 0; const cache = new Map();
      for (const x of [...grupos.values()].flat()) { const r = res.get(x.pedido); if (!r || r.situacao !== "entregue" || !REGRA_RAJ(x.transportadora, x.nf)) continue;
        let em = cache.get(r.det);
        if (em === undefined && r.det) { const d = await pagina("https://ssw.inf.br" + r.det).catch(() => null); consultas++; await dorme(PAUSA);
          em = d && d.status === 200 ? ((sohTexto(d.txt).join("\n").match(/transportando a sua mercadoria:\s*([^\n]+)/i) || [])[1] || "").trim().slice(0, 60) || null : null; cache.set(r.det, em); }
        if (em && /dominalog/i.test(em)) { ok++; r.emissor = em; continue; }
        nao++; res.set(x.pedido, { situacao: "nao entregue", ultimo_evento: `ENTREGUE POR ${(em || r.sigla || "OUTRA").toUpperCase()} (NÃO É A DOMINALOG)`.slice(0, 60), data_evento: r.data_evento || null, previsao: null, sigla: r.sigla, _cnpj: r._cnpj }); }
      if (ok + nao) log(`Dominalog (séries 25/34/35): ${ok} entregues confirmados pela Dominalog · ${nao} eram de outra transportadora (ficam como não entregue)`); }
    const achadosSSW = [...res.values()].filter((r) => r.situacao !== "sem cte").length;
    if (res.size > 200 && achadosSSW === 0) throw new Error("nenhuma NF reconhecida no retorno do SSW (leitura da página falhou); não gravo nada");
    await gravar(montar(ssw)); gravados = true; log(`Gravei a 1ª passada · ${Math.round((Date.now() - t0) / 1000)} s`);
    // Repescagem das sem CT-e nos outros CNPJ, em partes: até SSW_REPESCA lotes por rodada; cada NF lembra os CNPJ já tentados
    // e tenta primeiro os CNPJ em que essa transportadora mais emite. Se o SSW bloquear, para e fica para a próxima rodada.
    retentando = true; const c0 = consultas;
    const itens = [...grupos.values()].flat().filter((x) => res.get(x.pedido).situacao === "sem cte");
    itens.forEach((x) => tentados.set(x.pedido, [...new Set([...((x.detalhe && x.detalhe.tentados) || []), x.c1.slice(-6) + (x.detalhe && x.detalhe.sem_senha && chaveDe(x.transportadora) ? "s" : "")])]));
    // Com a senha, o SSW só mostra os CT-e daquela transportadora; se outra emitiu (ex.: VM na Intelipost, CT-e da Tempo Justo), só aparece sem senha.
    const proximo = (x) => { const ap = aprendido.get(x.transportadora) || new Map(), ja = tentados.get(x.pedido), tem = !!chaveDe(x.transportadora);
      const cs = [x.cs, ...[...ap.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]), ...TODOS];
      const cand = tem ? [x.cs + "|s", ...cs.flatMap((c) => [c, c + "|s"])] : cs;
      return cand.find((c) => !ja.includes(c.endsWith("|s") ? c.slice(0, -2).slice(-6) + "s" : c.slice(-6))); };
    for (let rodada = 0; consultas - c0 < REPESCA; rodada++) {
      const g = new Map(); let algum = false;
      for (const x of itens) { if (res.get(x.pedido).situacao !== "sem cte") continue; const c = proximo(x);
        if (!c) { if (rodada === 0) { tentados.set(x.pedido, []); mexidos.add(x.pedido); } continue; }   // já tentou todos: recomeça o ciclo na próxima rodada
        algum = true; const ss = c.endsWith("|s"), k = (ss ? c.slice(0, -2) : c) + "|" + (ss ? "" : chaveDe(x.transportadora)); (g.get(k) || g.set(k, []).get(k)).push(x); }
      if (!algum) break;
      for (const [k, xs] of g) { const [c, chave] = k.split("|");
        for (let i = 0; i < xs.length && consultas - c0 < REPESCA; i += 100) { const parte = xs.slice(i, i + 100), m = await lote(c, chave, [...new Set(parte.map((x) => x.n))]);
          parte.forEach((x) => { const r = pegaLote(m, x); mexidos.add(x.pedido);
            const ss = !chave && !!chaveDe(x.transportadora);
            if (r && r.situacao !== "sem cte") { res.set(x.pedido, { ...r, _cnpj: c, _semSenha: ss }); conta(x.transportadora, c); achou++; if (ss) semSenhaAchou[x.transportadora] = (semSenhaAchou[x.transportadora] || 0) + 1; }
            else tentados.get(x.pedido).push(c.slice(-6) + (ss ? "s" : "")); }); } }
    }
    log(`Outros CNPJ: ${achou} NFs achadas em ${consultas - c0} consultas · ${Math.round((Date.now() - t0) / 1000)} s · achadas só sem senha (CT-e de outra transportadora): ${JSON.stringify(semSenhaAchou)}`);
  } catch (e) { log("Parei:", e.message, `· outros CNPJ: ${achou} achadas até aqui · gravo o que já conferi.`); }
  if (!gravados && res.size > 200 && ![...res.values()].some((r) => r.situacao !== "sem cte")) { await pJad; await pTransiga; await pFormato; await pSites; log("Nada gravado do SSW nesta rodada."); return; }
  const final = gravados ? montar(ssw.filter((l) => mexidos.has(l.pedido))) : montar(ssw);
  await gravar(final.concat(semNf.map((l) => ({ pedido: l.pedido, situacao: "sem nf", ultimo_evento: null, data_evento: null, data_entrega: null, detalhe: l.detalhe || null }))));
  res.forEach((r) => (cont[r.situacao] = (cont[r.situacao] || 0) + 1));
  await pJad; await pTransiga; await pFormato; await pSites;
  log("Conferência em lote:", Object.entries(cont).map(([k, v]) => `${k} ${v}`).join(" · "), `· sem NF/série ${semNf.length} · ${Math.round((Date.now() - t0) / 1000)} s no total`);
}
if (MODO === "lote") {
  await entrarSupabase();
  // rodada automática (a cada 30 min): se outra rodada terminou há menos de 15 min, não repete
  const u = await chamar("conferencia_ssw?select=consultado_em&consultado_em=not.is.null&order=consultado_em.desc&limit=1").catch(() => []);
  if (process.env.AUTO === "1" && u[0] && Date.now() - Date.parse(u[0].consultado_em) < 15 * 60000) log("Conferido há menos de 15 min; pulo esta rodada.");
  else await conferirLote();
}
// conferência ao importar a lista e "Conferir tudo agora": agora pelo lote de 100 (Brenda, 16/11)
if (MODO === "conferencia" || MODO === "conferencia-tudo") { await entrarSupabase(); try { await conferirLote(); } finally { if (MODO === "conferencia-tudo") await chamar("rpc/fim_conferencia_tudo", "POST", {}).catch(() => {}); } }   // sempre marca o fim, mesmo se der erro
if (MODO === "transito-cte") {   // AJUSTE ÚNICO (13/11): Trânsito Brasil sem registro na Senior → transportadora que emitiu o CT-e no SSW
  await entrarSupabase();
  const L = await chamar("conferencia_ssw?select=pedido,nf,transportadora,detalhe&transportadora=ilike.*sito*brasil*&situacao=eq.sem%20cte&limit=1000");
  const m = await transito(L.filter((x) => !(x.detalhe && x.detalhe.emissor)));
  const linhas = [...m].map(([pedido, r]) => ({ pedido, situacao: r.situacao, ultimo_evento: r.ultimo_evento || null, data_evento: r.data_evento || null, data_entrega: r.data_entrega || null, detalhe: r.detalhe || null }));
  for (let i = 0; i < linhas.length; i += 50) await chamar("rpc/gravar_conferencia", "POST", { linhas: linhas.slice(i, i + 50) });
}
if (MODO === "transportadora") {   // confere de novo agora todos os não entregues de uma transportadora (ex.: depois de cadastrar a senha)
  await entrarSupabase(); await carregarSenhasDB();
  const nome = String(process.env.TRANSP || "").trim().replace(/[^\p{L}\p{N} ]/gu, "");
  if (!nome) { log("Informe a transportadora."); process.exit(0); }
  const L = await chamar(`conferencia_ssw?select=pedido,nf,transportadora&transportadora=ilike.*${encodeURIComponent(nome)}*&situacao=neq.entregue&limit=2000`);
  log(`${nome}: ${L.length} pedido(s) · senha: ${chaveDe(L[0] && L[0].transportadora) ? "sim" : "não"}`);
  const PAUSA = Number(process.env.SSW_PAUSA || 2500), cont = {}, grava = [];
  for (const l of L) {
    const [num, ser] = String(l.nf || "").split("-").map((x) => (x || "").trim()), c = cnpjDaSerie(ser);
    let r;
    if (!num || !c) r = { situacao: "sem nf" };
    else { const pg = await pagina("https://ssw.inf.br/2/resultSSW", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ cnpj: c, NR: num, chave: chaveDe(l.transportadora) }).toString() }).catch(() => null);
      if (!pg) continue; if (pg.status === 403 || pg.status === 429) { log("SSW bloqueou; paro."); break; }
      r = lerEntrega(pg.txt); await new Promise((ok) => setTimeout(ok, PAUSA)); }
    cont[r.situacao] = (cont[r.situacao] || 0) + 1;
    grava.push({ pedido: l.pedido, situacao: r.situacao, ultimo_evento: r.ultimo_evento || null, data_evento: r.data_evento || null, data_entrega: r.data_entrega || null });
    if (grava.length >= 50) await chamar("rpc/gravar_conferencia", "POST", { linhas: grava.splice(0) });
  }
  if (grava.length) await chamar("rpc/gravar_conferencia", "POST", { linhas: grava });
  log("Resultado:", Object.entries(cont).map(([k, v]) => `${k} ${v}`).join(" · "));
}
if (MODO === "jadlog") {   // só a Jadlog pela API (conferência), sem tocar no SSW
  await entrarSupabase(); process.env.SSW_MINUTOS = "0"; await conferir(0);
}
if (MODO === "diag-repo") {   // Reposição: lê 1 ticket pós (Eventos) e 1 pré (PDF da nota) em Aguardando entrega — só contagens no log
  await entrarSupabase();
  const { chromium } = await import("playwright");
  const nav = await chromium.launch(); const ctx = await nav.newContext({ acceptDownloads: true });
  try { await (await import("./repo-itens.mjs")).diagRepo({ chamar, log, ctx }); } finally { await nav.close(); }
}
if (MODO === "diag-barrar") {   // Barrar entrega: só olha a tela do portal (estrutura mascarada, não clica em nada)
  const { chromium } = await import("playwright");
  const nav = await chromium.launch(); const ctx = await nav.newContext({ viewport: { width: 1600, height: 900 }, locale: "pt-BR", acceptDownloads: true });
  try { const B = await import("./barrar.mjs"); if (process.env.TRANSP === "3") { await entrarSupabase(); await B.diagBarrar3({ chamar, ctx, log }); } else await (process.env.TRANSP === "2" ? B.diagBarrar2 : B.diagBarrar)({ ctx, log }); } catch (e) { log("diag-barrar: erro " + String(e.message).split("\n")[0].slice(0, 160)); } finally { await nav.close(); }
}
if (MODO === "barrar" || MODO === "barrar-portal") {   // Barrar entrega: confere (rastreio + portal) ou aplica no portal o que foi aprovado
  await entrarSupabase();
  const { subirArquivo } = await import("./supa.mjs");
  const { chromium } = await import("playwright");
  const nav = await chromium.launch(); const ctx = await nav.newContext({ viewport: { width: 1600, height: 900 }, locale: "pt-BR", timezoneId: "America/Sao_Paulo" });
  const B = await import("./barrar.mjs");
  try {
    if (MODO === "barrar") await B.conferirBarrar({ chamar, log, ctx, subirArquivo, limite: Number(process.env.SSW_LIMITE) || 200,
      R: { jadlog, bento, transito, formato, EH_FORMATO, pagina, lerEntrega, cnpjDaSerie, chaveDe, sohTexto, carregarSenhasDB, EH_JADLOG, EH_BENTO, EH_TRANSITO, chamar } });
    else await B.aplicarBarrar({ chamar, log, ctx, soTicket: process.env.TRANSP === "ticket", soAuto: process.env.TRANSP === "auto" });
  } finally { await nav.close(); }
}
if (MODO === "naoloc" || MODO === "naoloc-teste" || MODO === "diag-naoloc") {   // Alterar pedidos › Nota não localizada (robo/naoloc.mjs)
  await entrarSupabase();
  const { subirArquivo } = await import("./supa.mjs");
  const { chromium } = await import("playwright");
  const nav = await chromium.launch(); const ctx = await nav.newContext({ viewport: { width: 1600, height: 900 }, locale: "pt-BR", timezoneId: "America/Sao_Paulo" });
  const N = await import("./naoloc.mjs");
  try {
    if (MODO === "diag-naoloc") await N.diagNaoloc({ chamar, log, ctx });
    else await N.rodarNaoloc({ chamar, log, ctx, subirArquivo, teste: MODO === "naoloc-teste", limite: Number(process.env.SSW_LIMITE) || 200,
      R: { jadlog, bento, transito, formato, EH_FORMATO, pagina, lerEntrega, cnpjDaSerie, chaveDe, sohTexto, carregarSenhasDB, EH_JADLOG, EH_BENTO, EH_TRANSITO, chamar } });
  } catch (e) { log(MODO + ": erro " + String(e.message).split("\n")[0].replace(/\d{4,}/g, "#").slice(0, 160)); }
  finally { await nav.close(); }
}
if (MODO === "faltas" || MODO === "diag-faltas") {   // Reposições › Falta de volumes: a transportadora retornou? (só lê: ticket do 360 + anotações do portal)
  await entrarSupabase();
  const { chromium } = await import("playwright");
  const nav = await chromium.launch(); const ctx = await nav.newContext({ viewport: { width: 1600, height: 900 }, locale: "pt-BR", timezoneId: "America/Sao_Paulo" });
  const F = await import("./faltas.mjs");
  try { if (MODO === "faltas") await F.conferirFaltas({ chamar, log, ctx, limite: Number(process.env.SSW_LIMITE) || 300 }); else await F.diagFaltas({ chamar, log, ctx }); }
  catch (e) { log(MODO + ": erro " + String(e.message).split("\n")[0].replace(/\d{4,}/g, "#").slice(0, 160)); }
  finally { await nav.close(); }
}
if (MODO === "repo-itens") {   // Reposição: itens/volumes e cobrança à transportadora dos tickets em Aguardando entrega (robo/repo-itens.mjs)
  await entrarSupabase();
  const { chromium } = await import("playwright");
  const nav = await chromium.launch(); const ctx = await nav.newContext({ acceptDownloads: true });
  try { await (await import("./repo-itens.mjs")).rodarRepo({ chamar, log, ctx, limite: Number(process.env.SSW_LIMITE) || 150 }); } finally { await nav.close(); }
}
if (MODO === "aguardando" || MODO === "aguardando-teste") {   // aba Alterar pedidos → Fila Aguardando entrega (robo/aguardando.mjs)
  await entrarSupabase();
  await (await import("./aguardando.mjs")).rodar({ chamar, log, jadlog, bento, transito, formato, EH_FORMATO, pagina, lerEntrega, lerResultado, cnpjDaSerie, chaveDe, carregarSenhasDB, sohTexto, EH_JADLOG, EH_BENTO, EH_TRANSITO, MODO });
}
