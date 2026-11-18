// Barrar entrega (portal ccp.360multi.com › Barrar Entregas): o painel recebe a planilha de tickets "Barrar entrega",
// o robô confere cada nota nos rastreios e, só nos casos que a Logística aprovar, marca no portal ✓ (barrado) ou ✗ (não barrado).
// Registro público (Actions): só contagens e estrutura mascarada — nunca número de nota, nome ou texto de anotação.
const PORTAL = "https://ccp.360multi.com";
const mascara = (t) => String(t ?? "").replace(/\d/g, "#").replace(/\s+/g, " ").trim();

export async function entrarPortal(ctx, log) {
  // login próprio do Barrar (segredos BARRAR_EMAIL/BARRAR_SENHA, ex.: o usuário da Brenda); senão o do robô de ocorrências
  const PORTAL_EMAIL = process.env.BARRAR_EMAIL || process.env.PORTAL_EMAIL, PORTAL_SENHA = process.env.BARRAR_EMAIL ? process.env.BARRAR_SENHA : process.env.PORTAL_SENHA;
  if (!PORTAL_EMAIL || !PORTAL_SENHA) throw new Error("Faltam os segredos do portal no GitHub.");
  log(`Login do portal: ${process.env.BARRAR_EMAIL ? "BARRAR_EMAIL" : "PORTAL_EMAIL"}`);
  const p = await ctx.newPage(); p.setDefaultTimeout(30000);
  await p.goto(`${PORTAL}/login`);
  await p.locator("input[name=email]").fill(PORTAL_EMAIL);
  await p.locator("input[name=password]").fill(PORTAL_SENHA);
  await p.locator("form button[type=submit]").click();
  await p.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 });
  log("Entrei no portal.");
  return p;
}

// abre a tela Barrar Entrega pelo menu (o endereço não é conhecido de antemão)
export async function abrirBarrar(p, log) {
  const link = p.getByRole("link", { name: /barrar entrega/i }).first();
  if (await link.count()) { await link.click(); }
  else { const t = p.getByText(/^\s*Barrar Entregas?\s*/i).first(); await t.click(); }
  await p.locator("table tbody tr").first().waitFor({ timeout: 45000 }).catch(() => {});
  await p.waitForTimeout(1500);
  log(`Tela Barrar: caminho ${mascara(new URL(p.url()).pathname)}`);
}

export async function diagBarrar({ ctx, log }) {
  const p = await entrarPortal(ctx, log);
  const menu = await p.evaluate(() => [...document.querySelectorAll("a[href]")].map((a) => `${(a.textContent || "").trim().slice(0, 30)} → ${a.getAttribute("href")}`).filter((x) => /barr/i.test(x)));
  log("Links com 'barr':", menu.map(mascara).join(" | ") || "nenhum");
  await abrirBarrar(p, log);
  const est = await p.evaluate(() => {
    const m = (t) => String(t ?? "").replace(/\d/g, "#").replace(/\s+/g, " ").trim().slice(0, 50);
    const ths = [...document.querySelectorAll("table thead th")].map((th) => m(th.textContent));
    const linhas = [...document.querySelectorAll("table tbody tr")];
    const l0 = linhas[0];
    const cel = l0 ? [...l0.querySelectorAll("td")].map((td, i) => {
      const bts = [...td.querySelectorAll("button,a,svg,[role=button]")].map((b) => `${b.tagName}${b.getAttribute("aria-label") ? "[aria=" + m(b.getAttribute("aria-label")) + "]" : ""}${b.getAttribute("title") ? "[title=" + m(b.getAttribute("title")) + "]" : ""}${b.getAttribute("class") ? "[cls=" + m(b.getAttribute("class")).slice(0, 40) + "]" : ""}`);
      return `td${i}: txtforma="${i === 0 ? m(td.textContent) : m(td.textContent).replace(/[A-Za-zÀ-ÿ]+/g, "w")}" bts=${bts.slice(0, 4).join(",")}`;
    }) : [];
    const abas = [...document.querySelectorAll("button,[role=tab]")].map((b) => m(b.textContent)).filter((t) => t && t.length < 30);
    const busca = [...document.querySelectorAll("input")].map((i) => `${i.type}|ph=${m(i.placeholder)}`);
    const pag = (document.body.innerText.match(/P[aá]gina\s+\d+\s+de\s+\d+/i) || [""])[0];
    return { ths, n: linhas.length, cel, abas: [...new Set(abas)].slice(0, 30), busca, pag: m(pag) };
  });
  log(`Colunas: ${est.ths.join(" | ")}`);
  log(`Linhas na página: ${est.n} · ${est.pag} · campos: ${est.busca.join(" ; ")}`);
  log(`Botões/abas: ${est.abas.join(" / ")}`);
  est.cel.forEach((c) => log("  " + c));
}

// segunda parte do diagnóstico: modais (Anotações e ✗) e o Exportar — abre e fecha/cancela, não salva nada
export async function diagBarrar2({ ctx, log }) {
  const p = await entrarPortal(ctx, log);
  await abrirBarrar(p, log);
  const linha = p.locator("table tbody tr").first();
  const modal = async (rot) => {
    const d = p.locator("[role=dialog]").last(); await d.waitFor({ timeout: 10000 });
    const e = await d.evaluate((el) => { const m = (t) => String(t ?? "").replace(/\d/g, "#").replace(/\s+/g, " ").trim().slice(0, 60);
      return { tit: m((el.querySelector("h2,h3,[class*=title]") || {}).textContent), labels: [...el.querySelectorAll("label")].map((l) => m(l.textContent)),
        inputs: [...el.querySelectorAll("input,textarea,select,[role=combobox]")].map((i) => `${i.tagName}${i.type ? "|" + i.type : ""}${i.placeholder ? "|ph=" + m(i.placeholder) : ""}${i.getAttribute("role") ? "|role=" + i.getAttribute("role") : ""}`),
        botoes: [...el.querySelectorAll("button")].map((b) => m(b.textContent) || (b.getAttribute("aria-label") || "")).filter(Boolean),
        blocos: el.querySelectorAll("[class*=rounded]").length, img: el.querySelectorAll("img").length }; });
    log(`${rot}: título="${e.tit}" labels=[${e.labels.join(" | ")}] campos=[${e.inputs.join(" ; ")}] botões=[${e.botoes.join(" | ")}] img=${e.img}`);
    return d;
  };
  try {
    await linha.locator("button[title='Ver Anotações']").click(); await p.waitForTimeout(1200);
    await modal("Anotações"); await p.keyboard.press("Escape"); await p.waitForTimeout(800);
  } catch (e) { log("Anotações: " + String(e.message).split("\n")[0].slice(0, 120)); }
  try {
    await linha.locator("td").last().locator("button").first().click(); await p.waitForTimeout(1200);   // ✗ (vermelho)
    const d = await modal("Não barrado (✗)");
    const comb = d.locator("[role=combobox],button:has-text('Selecione')").first();
    if (await comb.count()) { await comb.click(); await p.waitForTimeout(800);
      const ops = await p.locator("[role=option]").allTextContents(); log("Opções: " + ops.map((o) => o.trim()).join(" | ")); await p.keyboard.press("Escape"); await p.waitForTimeout(500); }
    const canc = d.getByRole("button", { name: /cancelar/i }); if (await canc.count()) await canc.click(); else await p.keyboard.press("Escape");
    await p.waitForTimeout(800); log("✗: cancelado sem salvar.");
  } catch (e) { log("✗: " + String(e.message).split("\n")[0].slice(0, 120)); await p.keyboard.press("Escape").catch(() => {}); }
  try {
    const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 30000 }), p.getByRole("button", { name: /exportar/i }).first().click()]);
    const nome = dl.suggestedFilename(); const XLSX = (await import("xlsx")).default; const fs = await import("node:fs");
    const wb = XLSX.read(fs.readFileSync(await dl.path())); const ws = wb.Sheets[wb.SheetNames[0]]; const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
    log(`Exportar: arquivo .${nome.split(".").pop()} · ${rows.length - 1} linhas · colunas: ${(rows[0] || []).map(mascara).join(" | ")}`);
    await dl.delete().catch(() => {});
  } catch (e) { log("Exportar: " + String(e.message).split("\n")[0].slice(0, 120)); }
}

// ---------------------------------------------------------------------------------------------
// Conferência: rastreio de cada nota + linha da nota no portal (transportadora, anotações, print) → sugestão
const PAL_BARRAR = /SEGREGAD|DEVOLU|DEVOLVID|EM RETORNO|RETORNO AO REMETENTE/;
const PAL_NAO_RECEBEU = /N[AÃ]O\s+(FOI\s+)?(LOCALIZAD|ENCONTRAD|CONSTA|RECEB|IDENTIFICAD)|SEM\s+(REGISTRO|EMISS)|N[AÃ]O\s+TEMOS|DESCONHEC/;
const OP_NAO_RECEBEU = "Sem Emissão em Sistema / Material Não Recebido";
const sa = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
const GEN = new Set(["LTDA", "ME", "SA", "S", "A", "E", "DE", "DA", "DO", "EIRELI", "TRANSPORTE", "TRANSPORTES", "TRANSPORTADORA", "LOGISTICA", "LOG", "CARGAS", "CARGA", "EXPRESS", "EXPRESSO", "STANDARD", "FILIAL", "MATRIZ", "SERVICOS", "SP", "RJ", "MG", "PE", "PR", "SC", "RS", "BA", "CE", "GO", "ES"]);
const pals = (t) => sa(t).replace(/[^A-Z0-9]+/g, " ").split(" ").filter((w) => w.length > 1 && !GEN.has(w));
const VM = (w) => (w === "VM" || w === "TEMPO" || w === "JUSTO" ? "VM" : w);   // VM Transportes e Tempo Justo são a mesma
export function mesmaTransp(a, b) {
  const x = new Set(pals(a).map(VM)), y = pals(b).map(VM); if (!x.size || !y.length) return null;
  return y.some((w) => x.has(w) || [...x].some((v) => v.length >= 4 && w.length >= 4 && (v.startsWith(w) || w.startsWith(v))));
}

async function rastrear(it, R) {
  const { jadlog, bento, transito, formato, EH_FORMATO, pagina, lerEntrega, cnpjDaSerie, chaveDe, sohTexto, EH_JADLOG, EH_BENTO, EH_TRANSITO, chamar } = R;
  const tp = it.transp_pedido || "";
  const ordem = [EH_JADLOG.test(tp) ? "jadlog" : EH_BENTO.test(tp) ? "bento" : EH_TRANSITO.test(tp) ? "transito" : EH_FORMATO.test(tp) ? "formato" : /transiga/i.test(tp) ? "transiga" : "ssw"];
  // regra (Brenda): olha só o rastreio da transportadora do ticket (redespacho, se tiver); não procura em outras
  const um = [{ pedido: it.nf, nf: it.nf, transportadora: tp, chave: "" }];
  let primeiro = null;
  for (const k of ordem) {
    let r = null, txt = "", transp = null, html = null;
    try {
      if (k === "ssw") {
        const [num, ser] = it.nf.split("-"), c = cnpjDaSerie(ser); if (!c) continue;
        const pg = await pagina("https://ssw.inf.br/2/resultSSW", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ cnpj: c, NR: num, chave: chaveDe(tp) || "" }).toString() });
        await new Promise((ok) => setTimeout(ok, 2500));
        if (pg.status !== 200) continue;
        r = lerEntrega(pg.txt); txt = sohTexto(pg.txt).join("\n"); html = pg.txt;
        const det = (pg.txt.match(/opx\('(\/2\/ssw_SSWDetalhado\?[^']+)'\)/) || [])[1];
        if (det) { const d = await pagina("https://ssw.inf.br" + det.replace(/&amp;/g, "&")).catch(() => null); await new Promise((ok) => setTimeout(ok, 2500));
          if (d && d.status === 200) { html = d.txt; const t = sohTexto(d.txt).join("\n"); txt += "\n" + t; transp = ((t.match(/transportando a sua mercadoria:\s*([^\n]+)/i) || [])[1] || "").trim().slice(0, 60) || null; } }
      } else if (k === "transiga") {
        const x = (await chamar(`rastreio_transiga?select=descricao,data_evento,entregue&nf=eq.${encodeURIComponent(it.nf)}&limit=1`).catch(() => []))[0];
        r = x ? { situacao: x.entregue ? "entregue" : "nao entregue", ultimo_evento: (x.descricao || "").toUpperCase().slice(0, 60), data_evento: x.data_evento ? String(x.data_evento).slice(0, 10) : null } : { situacao: "sem cte" };
        txt = JSON.stringify(x || {}); transp = x ? "Transiga" : null;
      } else {
        const fn = { jadlog: process.env.JADLOG_TOKEN ? jadlog : null, bento, transito, formato }[k]; if (!fn) continue;
        r = (await fn(um)).get(it.nf); txt = JSON.stringify(r || {});
        transp = r && !/^(sem cte|sem nf)$/.test(r.situacao) ? { jadlog: "Jadlog", bento: "Bento Brasil", transito: "Trânsito Brasil", formato: "Formato" }[k] : null;
      }
    } catch (_) { continue; }
    if (!r) continue;
    const res = { situacao: r.situacao, fonte: { ssw: "SSW", jadlog: "Jadlog", bento: "Bento Brasil", transito: "Trânsito Brasil", formato: "Formato", transiga: "Transiga" }[k],
      evento: r.ultimo_evento || null, data_evento: r.data_evento || null, transp, achou_palavra: (sa(txt).match(PAL_BARRAR) || [])[0] || null };
    Object.defineProperty(res, "_html", { value: html, enumerable: false });   // só para o print, não vai para o banco
    if (!/^(sem cte|sem nf|sem permissao)$/.test(r.situacao)) return res;
    if (!primeiro) primeiro = res;
  }
  return primeiro || { situacao: "sem cte", fonte: null };
}

// linha da nota no portal: filtra pela nota, lê transportadora/prazo e as anotações (texto vai só para o banco) + print
async function lerPortal(p, nf, R) {
  const filtro = p.locator("input[placeholder^='Filtrar por nota']").first();
  await filtro.fill(""); await filtro.fill(nf); await p.waitForTimeout(2200);
  const linhas = p.locator("table tbody tr");
  const n = await linhas.count();
  let alvo = null;
  for (let i = 0; i < n; i++) { const t = (await linhas.nth(i).locator("td").first().textContent().catch(() => "")) || ""; if (t.trim() === nf) { alvo = linhas.nth(i); break; } }
  if (!alvo) return { achou: false };
  const tds = await alvo.locator("td").allTextContents();
  const out = { achou: true, transp: (tds[1] || "").trim(), solicitado: (tds[2] || "").trim(), prazo: (tds[3] || "").trim() };
  const bt = alvo.locator("button[title='Ver Anotações']");
  if (await bt.count()) {
    await bt.click(); const d = p.locator("[role=dialog]").last(); await d.waitFor({ timeout: 10000 }); await p.waitForTimeout(800);
    out.anotacao = ((await d.innerText()).replace(/^\s*Anota[cç][oõ]es\s*/i, "").replace(/Aqui voc[eê] pode ver suas anota[cç][oõ]es da nota selecionada\.?/i, "").replace(/\s+/g, " ").trim()).slice(0, 600);
    try { out.print = await d.screenshot(); } catch (_) {}
    await p.keyboard.press("Escape"); await p.waitForTimeout(600);
  }
  return out;
}

function sugerir(x) {
  const r = x.rastreio || {}, pt = x.portal || {}, an = sa(pt.anotacao);
  if (r.sem_transp) return { sugestao: "manual", opcao: null, motivo: "Erro: o ticket do 360 não tem transportadora nem redespacho." };
  const ultimoBarra = PAL_BARRAR.test(sa(r.evento));
  if (r.situacao === "entregue" && !ultimoBarra) return { sugestao: "nao_barrar", opcao: "Entregue", motivo: `Entregue conforme rastreio (${r.fonte}${r.data_evento ? ", " + r.data_evento : ""}).` };
  if (r.achou_palavra) return { sugestao: "barrar", opcao: null, motivo: `Rastreio (${r.fonte}) mostra ${r.achou_palavra.toLowerCase()}.` };
  if (r.situacao === "entregue") return { sugestao: "nao_barrar", opcao: "Entregue", motivo: `Entregue conforme rastreio (${r.fonte}${r.data_evento ? ", " + r.data_evento : ""}).` };
  const naoAchou = !r.situacao || /^(sem cte|sem nf|sem permissao|sem rastreio)$/.test(r.situacao);
  if (naoAchou && PAL_NAO_RECEBEU.test(an)) return { sugestao: "nao_barrar", opcao: OP_NAO_RECEBEU, motivo: (pt.anotacao || "").replace(/^.*?\d{2}\/\d{2}\/\d{4},?\s*\d{2}:\d{2}\s*/, "").slice(0, 300) };
  const quem = r.alvo ? ` da ${r.alvo}${r.alvo_e_redesp ? " (redespacho)" : ""}` : "";
  return { sugestao: "manual", opcao: null, motivo: naoAchou ? `Erro: nada no rastreio${quem}${pt.anotacao ? "; a anotação não diz que não recebeu" : ""}.` : `Em rastreio${quem}, sem segregação/devolução nem entrega.` };
}

// print do rastreio: a página do SSW (detalhe) como ela é; nas outras fontes, um quadro com o que o rastreio respondeu
const escH = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
async function printRastreio(ctx, nf, r) {
  const pg = await ctx.newPage();
  try {
    await pg.setViewportSize({ width: 1100, height: 700 });
    const quando = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
    const topo = `<div style="font:14px Arial;background:#0b1f3a;color:#fff;padding:8px 12px">Rastreio ${escH(r.fonte)} · NF ${escH(nf)} · consultado em ${escH(quando)}</div>`;
    if (r._html) await pg.setContent(`<base href="https://ssw.inf.br/2/">${topo}${r._html.replace(/<script[\s\S]*?<\/script>/gi, "")}`, { waitUntil: "load", timeout: 20000 }).catch(() => {});
    else await pg.setContent(`${topo}<table style="font:15px Arial;border-collapse:collapse;margin:16px" border="1" cellpadding="8">
      <tr><th align="left">Situação</th><td>${escH(r.situacao)}</td></tr><tr><th align="left">Último evento</th><td>${escH(r.evento || "—")}</td></tr>
      <tr><th align="left">Data do evento</th><td>${escH(r.data_evento || "—")}</td></tr><tr><th align="left">Transportadora</th><td>${escH(r.transp || r.fonte)}</td></tr></table>`);
    await pg.waitForTimeout(800);
    return await pg.screenshot({ fullPage: true, clip: undefined, type: "png" });
  } finally { await pg.close(); }
}

export async function conferirBarrar({ chamar, log, ctx, R, limite = 200, subirArquivo }) {
  const L = [];
  for (let de = 0; ; de += 1000) { const P = await chamar(`barrar_entrega?select=*&na_planilha=eq.true&portal_status=is.null&order=ticket_criado.asc.nullslast&limit=1000&offset=${de}`); L.push(...P); if (P.length < 1000) break; }
  const falta = L.filter((x) => process.env.TRANSP === "refazer" || !x.conferido_em || Date.now() - new Date(x.conferido_em).getTime() > 3 * 3600e3).slice(0, limite);
  log(`barrar: ${L.length} notas na planilha sem ação no portal · ${falta.length} para conferir`);
  if (!falta.length) return;
  await R.carregarSenhasDB();
  const M = await import("./multi360.mjs");
  let m360 = null; try { m360 = await M.entrarMulti360(ctx, log); } catch (e) { log("barrar: não entrei no 360:", String(e.message).slice(0, 100)); }
  const p = await entrarPortal(ctx, log); await abrirBarrar(p, log);
  const cont = {}; const soma = (k) => (cont[k] = (cont[k] || 0) + 1);
  for (const x of falta) {
    try {
      let tk = { transp: null, redesp: null };
      if (m360 && x.ticket) { try { tk = await M.lerTranspTicket(m360, x.ticket); } catch (e) { soma("ticket do 360 não abriu"); } }
      const alvo = tk.redesp || tk.transp || null;
      const rastreio = alvo ? await rastrear({ ...x, transp_pedido: alvo }, R) : { situacao: null, fonte: null, sem_transp: true };
      rastreio.alvo = alvo; rastreio.alvo_e_redesp = !!tk.redesp; rastreio.transp_ticket = tk.transp; rastreio.redesp_ticket = tk.redesp;
      if (!rastreio.transp && alvo && rastreio.fonte && !/^(sem cte|sem nf|sem permissao)$/.test(rastreio.situacao || "")) rastreio.transp = alvo;
      const pt = await lerPortal(p, x.nf, R);
      let print_path = x.print_path, print_rastreio = x.print_rastreio || null;
      if (rastreio.fonte) { try { print_rastreio = await subirArquivo("barrar", `${encodeURIComponent(x.nf)}-rastreio.png`, await printRastreio(ctx, x.nf, rastreio)); } catch (e) { soma("print do rastreio falhou"); } }
      if (pt.print) { try { print_path = await subirArquivo("barrar", `${encodeURIComponent(x.nf)}.png`, pt.print); } catch (e) { soma("print não subiu"); } delete pt.print; }
      const mesma = mesmaTransp(rastreio.alvo || "", pt.transp || x.transp_pedido);   // transportadora do ticket (redespacho, se tiver) × a do portal
      const s = sugerir({ rastreio, portal: pt });
      await chamar(`barrar_entrega?nf=eq.${encodeURIComponent(x.nf)}`, "PATCH", { rastreio, portal: pt, mesma_transp: mesma, sugestao: s.sugestao, sugestao_opcao: s.opcao, sugestao_motivo: s.motivo, conferido_em: new Date().toISOString(), print_path, print_rastreio });
      soma(`sugestão ${s.sugestao}`); if (!pt.achou) soma("não está no portal"); if (mesma === false) soma("transportadora diferente");
    } catch (e) { soma("erro"); log("  erro:", String(e.message).split("\n")[0].replace(/\d{4,}/g, "#").slice(0, 120)); }
  }
  log("barrar: " + Object.entries(cont).map(([k, v]) => `${k} ${v}`).join(" · "));
}

// Aplica no portal só o que alguém da Logística aprovou no painel (decisao preenchida)
export async function aplicarBarrar({ chamar, log, ctx }) {
  const L = await chamar("barrar_entrega?select=nf,decisao,decisao_opcao,decisao_motivo&na_planilha=eq.true&portal_status=is.null&decisao=in.(barrar,nao_barrar)&limit=500");
  log(`barrar-portal: ${L.length} nota(s) aprovadas para o portal`);
  if (!L.length) return;
  const p = await entrarPortal(ctx, log); await abrirBarrar(p, log);
  const cont = {}; const soma = (k) => (cont[k] = (cont[k] || 0) + 1);
  const grava = (nf, st, msg) => chamar(`barrar_entrega?nf=eq.${encodeURIComponent(nf)}`, "PATCH", { portal_status: st, portal_msg: msg, portal_em: new Date().toISOString() });
  for (const x of L) {
    try {
      const filtro = p.locator("input[placeholder^='Filtrar por nota']").first();
      await filtro.fill(""); await filtro.fill(x.nf); await p.waitForTimeout(2200);
      const linhas = p.locator("table tbody tr"); let alvo = null;
      for (let i = 0; i < await linhas.count(); i++) if (((await linhas.nth(i).locator("td").first().textContent().catch(() => "")) || "").trim() === x.nf) { alvo = linhas.nth(i); break; }
      if (!alvo) { await grava(x.nf, "erro", "Nota não está mais na lista Barrar Entrega do portal."); soma("não está na lista"); continue; }
      const bts = alvo.locator("td").last().locator("button");
      if (x.decisao === "barrar") {
        await bts.nth(1).click(); await p.waitForTimeout(1500);   // ✓ verde
        const d = p.locator("[role=dialog]").last();
        if (await d.count() && await d.isVisible().catch(() => false)) {   // se o portal pedir confirmação
          const forma = (await d.innerText()).replace(/\d/g, "#").replace(/\s+/g, " ").slice(0, 160); log("  ✓ abriu janela:", forma);
          const ok = d.getByRole("button", { name: /confirmar|salvar|sim|barrar/i }).first();
          if (await ok.count()) { await ok.click(); await p.waitForTimeout(1500); } else { await p.keyboard.press("Escape"); throw new Error("O ✓ abriu uma janela sem botão de confirmar."); }
        }
      } else {
        await bts.nth(0).click(); const d = p.locator("[role=dialog]").last(); await d.waitFor({ timeout: 10000 });   // ✗ vermelho
        await d.locator("[role=combobox]").first().click(); await p.waitForTimeout(600);
        await p.getByRole("option", { name: x.decisao_opcao || OP_NAO_RECEBEU, exact: true }).click(); await p.waitForTimeout(400);
        await d.locator("textarea").first().fill(String(x.decisao_motivo || "").slice(0, 500));
        await d.getByRole("button", { name: /salvar/i }).click(); await p.waitForTimeout(2000);
      }
      // conferência: a nota sai da lista Barrar Entrega
      await filtro.fill(""); await filtro.fill(x.nf); await p.waitForTimeout(2200);
      let ainda = false; const l2 = p.locator("table tbody tr");
      for (let i = 0; i < await l2.count(); i++) if (((await l2.nth(i).locator("td").first().textContent().catch(() => "")) || "").trim() === x.nf) ainda = true;
      if (ainda) { await grava(x.nf, "erro", "Cliquei, mas a nota continua na lista Barrar Entrega."); soma("continua na lista"); }
      else { await grava(x.nf, "feito", x.decisao === "barrar" ? "Marcada como barrada (✓) no portal." : `Marcada como não barrada (✗): ${x.decisao_opcao || OP_NAO_RECEBEU}.`); soma(`feito ${x.decisao}`); }
    } catch (e) { soma("erro"); await grava(x.nf, "erro", String(e.message).split("\n")[0].slice(0, 200)).catch(() => {}); await p.keyboard.press("Escape").catch(() => {}); }
  }
  log("barrar-portal: " + Object.entries(cont).map(([k, v]) => `${k} ${v}`).join(" · "));
}

// diagnóstico do ticket no Multi360 (login da Brenda): abre 1 ticket da lista, olha a tela e cancela
export async function diagBarrar3({ chamar, ctx, log }) {
  const [x] = await chamar("barrar_entrega?select=ticket&na_planilha=eq.true&ticket=not.is.null&order=ticket_criado.asc&limit=1");
  if (!x) { log("diag-barrar 3: nenhuma nota com ticket (envie a planilha no painel)"); return; }
  const M = await import("./multi360.mjs");
  const cred = null;   // Multi360: o mesmo login já cadastrado (MULTI360_EMAIL/MULTI360_SENHA), a pedido da Brenda
  const p = await M.entrarMulti360(ctx, log, cred);
  await M.diagComentario(p, x.ticket, log);
}
