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
  return { status: r.status, url: r.url, txt };
}

// CNPJ do remetente pela série da NF (tabela da Logística)
const CNPJ_SERIE = { "00349443000192": [4, 6, 7, 31, 94], "00349443000435": [9, 22, 34], "00349443000516": [10],
  "00349443000788": [11, 24, 25, 27, 301, 302, 303], "00349443001083": [14, 35], "00349443001245": [17], "00349443001407": [21],
  "00349443001750": [23], "00349443001679": [26] };
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
  if (ls.some((l) => /informa[cç][aã]o n[ãa]o dispon[ií]vel/i.test(l))) return { situacao: "fora do ssw" };
  return { situacao: "sem previsao" };
}
if (MODO === "real") {
  await entrarSupabase();
  const todos = [];
  for (let de = 0; ; de += 1000) { const L = await chamar(`base_aberta?select=pedido,nf,transportadora,status_intelipost,micro_status,data_entrega,prev_original,prev_atual&nf=not.is.null&order=pedido&limit=1000&offset=${de}`); todos.push(...L); if (L.length < 1000) break; }
  // só os pedidos em aberto: fora os entregues e cancelados (status, micro status ou data de entrega preenchida)
  const fechado = (l) => /\bentregue\b|cancelad|entrega realizada/i.test(`${l.status_intelipost || ""} ${l.micro_status || ""}`) || !!l.data_entrega;
  const abertos = todos.filter((l) => !fechado(l));
  log(`Entregues ou cancelados deixados de fora: ${(todos.length - abertos.length).toLocaleString("pt-BR")}`);
  const fila = abertos.map((l) => { const [num, ser] = String(l.nf).split("-").map((x) => (x || "").trim()); return { ...l, num, c: cnpjDaSerie(ser) }; }).filter((l) => l.num && l.c);
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
  const fimEm = Date.now() + Number(process.env.SSW_MINUTOS || 80) * 60000;
  for (const l of fila) {
    if (Date.now() > fimEm) { log("Tempo da rodada acabou; o resto fica para a próxima."); break; }
    const t = l.transportadora || "?"; const st = (porT[t] ||= { n: 0, fora: 0 });
    let r;
    if (st.n >= 8 && st.fora === st.n) r = { situacao: "fora do ssw" };   // as 8 primeiras não estão no SSW: a transportadora não usa (ou pede senha)
    else {
      try {
        const pg = await pegar("https://ssw.inf.br/2/resultSSW", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ cnpj: l.c, NR: l.num, chave: "" }).toString() });
        r = lerResultado(pg.txt);
        // a 1ª página mostra só o último evento: a previsão fica no histórico completo (link "ssw_SSWDetalhado")
        const det = (pg.txt.match(/opx\('(\/2\/ssw_SSWDetalhado\?[^']+)'\)/) || [])[1];
        if (det && !r.previsao && !/fora do ssw|sem permissao/.test(r.situacao)) {
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
      st.n++; if (/fora do ssw|sem permissao/.test(r.situacao)) st.fora++;
    }
    cont[r.situacao] = (cont[r.situacao] || 0) + 1;
    grava.push({ pedido: l.pedido, nf: l.nf, previsao: r.previsao || null, situacao: r.situacao });
    if (++feitos % 250 === 0) log(`${feitos.toLocaleString("pt-BR")} de ${fila.length.toLocaleString("pt-BR")} em ${Math.round((Date.now() - t0) / 60000)} min · com previsão ${cont.previsao || 0}`);
    await salvar(false);
  }
  await salvar(true);
  log("Resultado:", Object.entries(cont).map(([k, v]) => `${k} ${v}`).join(" · "));
  log("Transportadoras fora do SSW (ou com senha):", Object.entries(porT).filter(([, v]) => v.n && v.fora === v.n).map(([k]) => k).join(", ") || "nenhuma");
}
