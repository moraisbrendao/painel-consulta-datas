// Reposição pré-entrega › Falta de volumes (Brenda 27/11): a transportadora anexa no portal a foto da etiqueta do volume
// que está com ela; por eliminação, pedimos a reposição do(s) outro(s) volume(s).
// Etiqueta da matriz (séries 7, 4, 31): código de barras = NF(7) + série(2) + volume(2) + total(2), ex. 0658695070102,
// texto "VOL. NF:01/02" e o código do volume (ex. 76280.0002).
// Registro público (Actions): só sim/não e números de volume — nunca a foto, nome, endereço ou texto da etiqueta.
import fs from "node:fs";
import { entrarPortal } from "./barrar.mjs";
import { abrirRepoPre, acharLinha } from "./anota-portal.mjs";
import { entrarMulti360 } from "./multi360.mjs";

const mascara = (t) => String(t ?? "").replace(/\d/g, "#").replace(/\s+/g, " ").trim().slice(0, 80);
// reposições: o 360 usa o login do Eduardo (ele cuida das reposições; Brenda 27/11), se estiver nos segredos do GitHub
const CRED_REPO = () => (process.env.MULTI360_EMAIL_EDUARDO && process.env.MULTI360_SENHA_EDUARDO ? { email: process.env.MULTI360_EMAIL_EDUARDO, senha: process.env.MULTI360_SENHA_EDUARDO, nome: "Eduardo (reposições)" } : undefined);
let zx = null;
async function codigosDeBarras(buf) {
  try {
    if (!zx) { zx = await import("zxing-wasm/reader"); await zx.prepareZXingModule({ overrides: { wasmBinary: fs.readFileSync(new URL("./node_modules/zxing-wasm/dist/reader/zxing_reader.wasm", import.meta.url)) }, fireImmediately: true }); }
    const sharp = (await import("sharp")).default, out = new Set();
    for (const sc of [1, 2]) {
      const meta = await sharp(buf).metadata();
      const { data, info } = await sharp(buf).rotate().resize({ width: Math.min(4000, Math.round(meta.width * sc)) }).grayscale().normalize().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const r = await zx.readBarcodes({ data: new Uint8ClampedArray(data), width: info.width, height: info.height, colorSpace: "RGBA" }, { tryHarder: true, tryRotate: true, maxNumberOfSymbols: 10, formats: ["Code128", "ITF", "Code39", "EAN-13", "DataMatrix", "QRCode"] });
      r.forEach((x) => out.add(x.text));
    }
    return [...out];
  } catch (e) { return { erro: String(e.message).slice(0, 80) }; }
}
async function ocr(buf) {
  try { const { execFileSync } = await import("node:child_process"); fs.writeFileSync("/tmp/etq.img", buf);
    const t = execFileSync("tesseract", ["/tmp/etq.img", "-", "--psm", "11"], { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "ignore"] }); fs.rmSync("/tmp/etq.img", { force: true }); return t;
  } catch (e) { return ""; }
}

// diagnóstico com UMA NF (hash do número no input transp): acha a linha no portal, abre Anexos, baixa a(s) foto(s) e testa a leitura.
export async function diagRepoPre({ chamar, log, ctx, alvo, createHash }) {
  const hh = (t) => createHash("sha256").update(String(t || "")).digest("hex").slice(0, 16);
  let nf = null;
  for (let de = 0; !nf; de += 1000) { const B = await chamar(`base_pedidos?select=nf&order=pedido&limit=1000&offset=${de}`).catch(() => []);
    const x = B.find((b) => hh(String(b.nf || "").split("-")[0].trim()) === alvo); if (x) nf = x.nf; if (B.length < 1000) break; }
  if (!nf) { log("diag-repopre: NF não achada na base"); return; }
  const num = String(nf).split("-")[0].trim(), serie = String(nf).split("-")[1];
  log(`diag-repopre: NF achada na base (série ${serie})`);
  const p = await entrarPortal(ctx, log); await abrirRepoPre(p, log);
  const linha = await acharLinha(p, nf);
  if (!linha) { log("NF não está na lista Reposições (Pré Entrega)"); return; }
  const ths = (await p.locator("table thead th").allTextContents()).map((t) => t.trim());
  log("Colunas:", ths.join(" | "));
  const ia = ths.findIndex((h) => /anexo/i.test(h)); const cel = linha.locator("td").nth(ia);
  log("Célula Anexos:", (await cel.locator("button, a, svg").evaluateAll((es) => es.map((e) => `${e.tagName.toLowerCase()}:${[e.title, e.getAttribute("aria-label"), (e.innerText || "").trim(), e.getAttribute("href") ? "href" : ""].filter(Boolean).join("/") || "(ícone)"}`))).map(mascara).join(" | "));
  const respostas = [];
  p.on("response", async (r) => { const ct = r.headers()["content-type"] || ""; if (/image\//.test(ct)) { try { respostas.push({ ct, buf: await r.body() }); } catch (_) {} } });
  const bt = cel.locator("button, a").first();
  if (!(await bt.count())) { log("Sem botão em Anexos"); return; }
  await bt.click(); await p.waitForTimeout(3500);
  const d = p.locator("[role=dialog]").last();
  if (await d.count()) {
    log("Janela de anexos:", mascara((await d.innerText()).slice(0, 120)));
    log("Na janela: imagens", await d.locator("img").count(), "· links", await d.locator("a").count(), "· botões", (await d.locator("button").evaluateAll((es) => es.map((e) => [e.title, e.getAttribute("aria-label"), (e.innerText || "").trim()].filter(Boolean).join("/") || "(ícone)"))).map(mascara).join(" | "));
    const hrefs = await d.locator("a[href], img[src]").evaluateAll((es) => es.map((e) => e.getAttribute("href") || e.getAttribute("src")));
    log("Endereços (só tipo):", hrefs.map((h) => { try { const u = new URL(h, location.href); return u.host.replace(/[a-z0-9-]+\./, "x.") + " " + (u.pathname.match(/\.[a-z0-9]{2,5}$/i) || ["(sem ext)"])[0]; } catch (e) { return "?"; } }).join(" | ") || "nenhum");
    log("Imagens (esquema e tamanho):", (await d.locator("img").evaluateAll((es) => es.map((e) => `${(e.getAttribute("src") || "").split(":")[0].slice(0, 10)} ${e.naturalWidth}x${e.naturalHeight} mostrada ${Math.round(e.getBoundingClientRect().width)}px`))).join(" | "));
    const antes = respostas.length; await d.locator("img").first().click().catch(() => {}); await p.waitForTimeout(2500);
    log("Depois de clicar na imagem: novas imagens baixadas", respostas.length - antes, "· abas", ctx.pages().length, "· janelas", await p.locator("[role=dialog]").count(), "· imagens maiores na tela:", (await p.locator("img").evaluateAll((es) => es.filter((e) => e.naturalWidth > 900).map((e) => `${e.naturalWidth}x${e.naturalHeight}`))).join(", ") || "nenhuma");
    // a foto da janela vem reduzida pelo Next (/_next/image?url=...&w=...): tenta a original (parâmetro url) e a maior largura
    for (const h of hrefs.slice(0, 4)) { try { const u = new URL(h, p.url()); const orig = u.searchParams.get("url");
      if (orig) { const cand = [new URL(orig, p.url()).href]; const big = new URL(u.href); big.searchParams.set("w", "3840"); big.searchParams.set("q", "100"); cand.push(big.href);
        log("Foto original: host", new URL(orig, p.url()).host.replace(/[a-z0-9-]+\./, "x."), "· extensão", (new URL(orig, p.url()).pathname.match(/\.[a-z0-9]{2,5}$/i) || ["(sem)"])[0]);
        for (const c of cand) { const r = await p.request.get(c).catch(() => null); if (!r) { log("  baixar: falhou"); continue; } const ct = r.headers()["content-type"] || ""; log(`  baixar: status ${r.status()} · ${ct.split(";")[0]}`); if (r.ok() && /image|octet/.test(ct)) respostas.push({ ct: /octet/.test(ct) ? "image/x" : ct, buf: await r.body() }); } } } catch (e) { log("  erro original", mascara(e.message)); } }
    for (const h of hrefs.slice(0, 4)) { try { const r = await p.request.get(new URL(h, p.url()).href); const ct = r.headers()["content-type"] || ""; if (/image|octet|pdf/.test(ct)) respostas.push({ ct, buf: await r.body() }); } catch (_) {} }
  } else log("Nenhuma janela abriu depois do clique");
  const sharp = (await import("sharp")).default;
  for (const r of respostas) { try { const m = await sharp(r.buf).metadata(); r.dim = `${m.width}x${m.height}`; } catch (_) { r.dim = "?"; } }
  log("Arquivos baixados:", respostas.length, respostas.map((r) => `${r.ct.split(";")[0]} ${Math.round(r.buf.length / 1024)}KB ${r.dim}`).join(" | "));
  for (const [i, r] of respostas.filter((r) => /image/.test(r.ct) && r.buf.length > 20000).slice(0, 4).entries()) {
    const cb = await codigosDeBarras(r.buf), txt = await ocr(r.buf), T = txt.toUpperCase().replace(/\s+/g, " ");
    const lista = Array.isArray(cb) ? cb : [];
    const nossa = lista.filter((c) => /^\d{12,14}$/.test(c) && c.includes(num));
    log(`Foto ${i + 1}: códigos lidos ${Array.isArray(cb) ? lista.length : "erro " + cb.erro} · algum com a NF: ${nossa.length ? "sim" : "não"}${nossa.length ? " · volume/total pelo código: " + nossa.map((c) => c.slice(-4, -2) + "/" + c.slice(-2)).join(", ") : ""}`);
    log(`   leitura de texto: ${txt ? txt.length + " letras" : "falhou"} · tem a NF: ${T.includes(num) ? "sim" : "não"} · "VOL. NF" ${(T.match(/VOL\.?\s*NF\s*:?\s*(\d{1,2})\s*\/\s*(\d{1,2})/) || []).slice(1).join("/") || "não achei"} · códigos de volume ${[...new Set(T.match(/\b\d{5}\.\d{4}\b/g) || [])].join(", ") || "nenhum"}`);
  }
}

// 360 › Hub › Pedidos › Filtros › NF: achou = venda. Abre o pedido e lê o SKU (Produtos do Pedido) e os tickets (fila / tipo / situação).
// Nada de nome, CPF, telefone ou endereço: só SKU, filas, tipos e situação.
export async function pedido360(ctx, log, nf) {
  const BASE = (process.env.MULTI360_URL || "https://appv2.360multi.com").replace(/\/$/, "");
  const m = pedido360.pg && !pedido360.pg.isClosed() ? pedido360.pg : (pedido360.pg = await entrarMulti360(ctx, log, CRED_REPO()));
  await m.goto(BASE + "/pedidos/hub", { waitUntil: "domcontentloaded" }); await m.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await m.getByRole("button", { name: /filtros/i }).first().click(); await m.waitForTimeout(1200);
  const campo = m.locator("xpath=//*[normalize-space(text())='NF']/following::input[1]").first();
  await campo.fill(nf); await m.getByRole("button", { name: /aplicar filtros/i }).first().click();
  await m.waitForTimeout(4000); await m.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  const linhas = m.locator("table tbody tr"); const n = await linhas.count();
  const cab = (await m.locator("table thead th").allTextContents()).map((t) => t.trim());
  const iNf = cab.findIndex((h) => /^NF$/i.test(h));
  let alvo = null;
  for (let i = 0; i < n; i++) { const t = ((await linhas.nth(i).locator("td").nth(Math.max(0, iNf)).innerText().catch(() => "")) || "").trim(); if (t === nf) { alvo = linhas.nth(i); break; } }
  const r = { venda: !!alvo, linhas: n, sku: [], tickets: [] };
  if (!alvo) return r;
  const st = cab.findIndex((h) => /status/i.test(h)); r.status = st >= 0 ? ((await alvo.locator("td").nth(st).innerText().catch(() => "")) || "").trim() : "";
  const dt = cab.findIndex((h) => /data|emiss/i.test(h)); r.data = dt >= 0 ? (((await alvo.locator("td").nth(dt).innerText().catch(() => "")) || "").match(/\d{2}\/\d{2}\/\d{4}/) || [""])[0] : "";
  await alvo.locator("td").first().click(); await m.waitForTimeout(4000); await m.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  if (!/Tickets do Pedido/i.test(await m.locator("body").innerText())) { await alvo.locator("a").first().click().catch(() => {}); await m.waitForTimeout(4000); }
  const corpo = await m.locator("body").innerText();
  const prod = corpo.split(/Produtos do Pedido/i)[1] || ""; r.sku = [...new Set(prod.match(/\b[A-Z0-9]{2,}[A-Z0-9-]*\.\d{3}\b/g) || [])];
  const tk = (corpo.split(/Tickets do Pedido/i)[1] || "").split(/Informa[cç][oõ]es do Pedido|Produtos do Pedido/i)[0];
  r.semTickets = /Nenhum ticket vinculado/i.test(tk);
  for (const b of tk.split(/\bID:\s*/).slice(1)) r.tickets.push({ id: (b.match(/^\s*#?(\d{3,})/) || [])[1] || null, fila: ((b.match(/Fila:\s*([^\n]+)/) || [])[1] || "").trim(), tipo: ((b.match(/Tipo:\s*([^\n]+(?:\n[^\n:]+\))?)/) || [])[1] || "").replace(/\s+/g, " ").trim(), situacao: ((b.match(/\n(Em Andamento|Resolvido|Encerrado|Fechado|Novo|Aberto|Pendente)[^\n]*/i) || [])[1] || "").trim() });
  return r;
}
export async function diag360({ chamar, log, ctx, alvo, createHash }) {
  const hh = (t) => createHash("sha256").update(String(t || "")).digest("hex").slice(0, 16); let nf = null;
  for (let de = 0; !nf; de += 1000) { const B = await chamar(`base_pedidos?select=nf&order=pedido&limit=1000&offset=${de}`).catch(() => []); const x = B.find((b) => hh(String(b.nf || "").split("-")[0].trim()) === alvo); if (x) nf = x.nf; if (B.length < 1000) break; }
  if (!nf) { log("diag-repo360: NF não achada na base"); return; }
  const r = await pedido360(ctx, log, nf);
  log(`360: linhas depois do filtro ${r.linhas} · é venda (achou a NF): ${r.venda ? "sim" : "não"} · status ${r.status || "—"} · SKU ${r.sku.join(", ") || "nenhum"} · sem tickets: ${r.semTickets ? "sim" : "não"}`);
  for (const t of r.tickets) log(`   ticket: fila ${t.fila || "—"} · tipo ${t.tipo || "—"} · situação ${t.situacao || "—"}`);
}

// diag-repopre2: lista inteira do portal (páginas, Status/Motivo só em contagens), ⋯ → Abrir ticket → lê as opções de Volumes e FECHA sem adicionar.
// Testa também se a foto original abre sem login (para mostrar no E-loggia). Nada de nome/endereço no log.
const VOL = /\b\d{5}\.\d{4}\b/g;
export async function lerListaRepoPre(p, log, maxPag = 40) {
  const casos = [];
  for (let pg = 1; pg <= maxPag; pg++) {
    const ths = (await p.locator("table thead th").allTextContents()).map((t) => t.trim());
    const col = (re) => ths.findIndex((h) => re.test(h));
    const iNf = col(/^NF/i), iMot = col(/motivo/i), iSt = col(/^status/i), iTr = col(/transportadora/i), iDt = col(/data/i), iQv = col(/qtd.*vol/i);
    const rows = await p.locator("table tbody tr").evaluateAll((trs) => trs.map((tr) => [...tr.querySelectorAll("td")].map((td) => (td.innerText || "").trim())));
    for (const c of rows) if (c.length > 3) casos.push({ nf: c[iNf], motivo: c[iMot], status: c[iSt], transp: c[iTr], data: c[iDt], qtd: iQv >= 0 ? c[iQv] : null, pagina: pg });
    const prox = p.getByRole("button", { name: /go to next page|pr[óo]xima p[áa]gina/i }).first();
    if (!(await prox.count()) || (await prox.isDisabled().catch(() => true))) break;
    const antes = rows[0] && rows[0][iNf]; await prox.click().catch(() => {}); await p.waitForTimeout(2500);
    const depois = ((await p.locator("table tbody tr").first().locator("td").nth(Math.max(0, iNf)).innerText().catch(() => "")) || "").trim();
    if (depois === antes) { if (log) log(`  página ${pg}: a próxima não mudou a tabela`); break; }
  }
  return casos;
}
export async function volumesDoDialogo(p, linha, log) {
  const menu = linha.locator("td").last().locator("button").last();
  await menu.click(); await p.waitForTimeout(1200);
  const itens = (await p.locator("[role=menuitem], [role=menu] button, [role=menu] a").allInnerTexts().catch(() => [])).map((t) => t.trim()).filter(Boolean);
  if (log) log("  menu ⋯:", itens.join(" | ") || "(nenhum item com role=menuitem)");
  const abrir = p.getByRole("menuitem", { name: /abrir ticket/i }).first();
  if (await abrir.count()) await abrir.click(); else await p.getByText(/^\s*Abrir ticket\s*$/i).first().click();
  await p.waitForTimeout(2000);
  const d = p.locator("[role=dialog]").last();
  const r = { titulo: "", campos: [], volumes: [] };
  if (!(await d.count())) return r;
  r.titulo = ((await d.locator("h1,h2,h3,[class*=title]").first().innerText().catch(() => "")) || "").trim();
  r.campos = (await d.locator("label").allInnerTexts().catch(() => [])).map((t) => t.trim()).filter(Boolean);
  // abre o multiselect de Volumes (só para ler as opções)
  const vol = d.locator("xpath=.//*[normalize-space(text())='Volumes']/following::*[self::button or @role='combobox' or self::input][1]").first();
  if (await vol.count()) { await vol.click().catch(() => {}); await p.waitForTimeout(1200);
    const ops = await p.locator("[role=option], [role=listbox] li, [cmdk-item]").allInnerTexts().catch(() => []);
    r.opcoes = ops.length;
    r.textos = ops.map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean);
    // todas as opções da lista são volumes (o código pode vir sem ".0001", ex. 95812), menos "Selecionar todas" e "Fechar"
    r.volumes = [...new Set(r.textos.filter((t) => !/^(selecionar todas?|fechar|limpar)$/i.test(t)))];
    if (log) log("  opções de Volumes (códigos de produto, sem dado de cliente):", r.textos.map((t) => t.slice(0, 40)).join(" | "));
    await p.keyboard.press("Escape"); await p.waitForTimeout(500); }
  // fecha a janela SEM adicionar
  const fechar = d.getByRole("button", { name: /cancelar|fechar/i }).first();
  await p.keyboard.press("Escape"); await p.waitForTimeout(600);
  if (await p.locator("[role=dialog]").count()) { if (await fechar.count()) await fechar.click().catch(() => {}); await p.waitForTimeout(600); }
  r.fechou = !(await p.locator("[role=dialog]").count());
  return r;
}
export async function diagRepoPre2({ log, ctx }) {
  const p = await entrarPortal(ctx, log); await abrirRepoPre(p, log);
  const bts = await p.locator("xpath=//table/following::button").evaluateAll((es) => es.slice(0, 25).map((e) => [e.getAttribute("aria-label"), (e.innerText || "").trim(), e.disabled ? "off" : ""].filter(Boolean).join("/") || "(ícone)"));
  log("Botões depois da tabela:", bts.map(mascara).join(" | "));
  log("Texto do rodapé:", mascara(((await p.locator("xpath=//table/following::*[contains(.,'página') or contains(.,'Página') or contains(.,'de ')][1]").first().innerText().catch(() => "")) || "").slice(0, 100)));
  // filtro Status → opções
  const st = p.locator("button:has-text('Status')").first(); await st.click().catch(() => {}); await p.waitForTimeout(1200);
  log("Opções do filtro Status:", (await p.locator("[role=option], [role=menuitemcheckbox], [role=menuitem], [cmdk-item]").allInnerTexts().catch(() => [])).map((t) => t.trim()).join(" | ") || "(nenhuma com role)");
  const novo = p.locator("[role=option], [role=menuitemcheckbox], [role=menuitem], [cmdk-item]").filter({ hasText: /^\s*Novo\s*$/ }).first();
  if (await novo.count()) { await novo.click().catch(() => {}); await p.waitForTimeout(2500); log("Filtro Status = Novo aplicado"); }
  await p.keyboard.press("Escape"); await p.waitForTimeout(1500);
  log("Rodapé depois do filtro:", mascara(((await p.locator("xpath=//table/following::*[contains(.,'Página')][1]").first().innerText().catch(() => "")) || "").slice(0, 60)));
  const casos = await lerListaRepoPre(p, log);
  const cont = (f) => Object.entries(casos.reduce((a, c) => ((a[f(c)] = (a[f(c)] || 0) + 1), a), {})).map(([k, v]) => `${k}: ${v}`).join(" · ");
  log(`Lista: ${casos.length} linhas em ${Math.max(0, ...casos.map((c) => c.pagina))} página(s)`);
  log("Status →", cont((c) => c.status)); log("Motivo →", cont((c) => c.motivo));
  log("Séries (Novo + Falta) →", cont((c) => (/novo/i.test(c.status) && /falta/i.test(c.motivo) ? String(c.nf).split("-")[1] : "outros")));
  const { createHash } = await import("node:crypto"); const hh = (t) => createHash("sha256").update(String(t || "")).digest("hex").slice(0, 16);
  const quer = String(process.env.TRANSP || "").split(":")[1];
  const alvo = quer ? casos.find((c) => hh(String(c.nf).split("-")[0]) === quer) : casos.find((c) => /novo/i.test(c.status) && /falta/i.test(c.motivo) && ["7", "4", "31"].includes(String(c.nf).split("-")[1]));
  if (!alvo) { log("Nenhum Novo + Falta de volumes das séries 7/4/31"); return; }
  log(`Caso de teste: série ${String(alvo.nf).split("-")[1]} · qtd volumes ${alvo.qtd}`);
  const linha = await acharLinha(p, alvo.nf); if (!linha) { log("não achei a linha filtrando"); return; }
  const r = await volumesDoDialogo(p, linha, log);
  log(`Janela: "${mascara(r.titulo)}" · campos ${r.campos.map(mascara).join(" | ")} · opções na lista ${r.opcoes ?? "—"} · códigos de volume ${r.volumes.length} (${r.volumes.map((v) => v.replace(/\d/g, "#")).join(", ")}) · fechou sem adicionar: ${r.fechou ? "sim" : "NÃO"}`);
  // foto: abre sem login?
  const ths = (await p.locator("table thead th").allTextContents()).map((t) => t.trim()); const ia = ths.findIndex((h) => /anexo/i.test(h));
  const bt = linha.locator("td").nth(ia).locator("button, a").first();
  if (await bt.count()) { await bt.click(); await p.waitForTimeout(3000); const d = p.locator("[role=dialog]").last();
    const srcs = await d.locator("img[src]").evaluateAll((es) => es.map((e) => e.getAttribute("src")));
    for (const s of srcs.slice(0, 2)) { const u = new URL(s, p.url()), o = u.searchParams.get("url") ? new URL(u.searchParams.get("url"), p.url()).href : u.href;
      const r2 = await fetch(o).catch(() => null); log(`Foto sem login: status ${r2 ? r2.status : "falhou"} · tipo ${r2 ? (r2.headers.get("content-type") || "").split(";")[0] : "—"} · link assinado (expira): ${/X-Amz-|Signature=|Expires=/i.test(o) ? "sim" : "não"}`); }
    await p.keyboard.press("Escape"); }
}

// ===== modo repo-pre: analisa os casos Novo + Falta de volumes (séries da matriz) e grava em repo_pre. Não solicita nada. =====
const SERIES = ["7", "4", "31"];
const SINISTRO = /SINISTR\w*|ROUB\w*|FURT\w*|ASSALT\w*|ACIDENT\w*|TOMBAMENT\w*|INCENDI\w*|AVARIA TOTAL|PERDA TOTAL|BOLETIM DE OCORRENCIA/;
async function anotacoesDaLinha(p, linha) {
  const bt = linha.locator("button[title='Ver Anotações'], button[title*='Anota' i]").first(); if (!(await bt.count())) return [];
  await bt.click().catch(() => {}); const d = p.locator("[role=dialog]").last(); await d.waitFor({ timeout: 10000 }).catch(() => {}); await p.waitForTimeout(800);
  const ls = ((await d.innerText().catch(() => "")) || "").split("\n").map((l) => l.trim()).filter((l) => l && !/^(close|fechar|×|x)$/i.test(l) && !/^Anota[cç][oõ]es$/i.test(l) && !/^Aqui voc[eê] pode ver/i.test(l) && !/^Adicione aqui/i.test(l));
  await p.keyboard.press("Escape"); await p.waitForTimeout(600);
  const ehData = (l) => /^\d{2}\/\d{2}\/\d{4},?\s*\d{2}:\d{2}$/.test(l), idx = ls.map((l, i) => (ehData(l) ? i : -1)).filter((i) => i >= 0);
  return idx.map((i, k) => ({ quando: ls[i], texto: ls.slice(i + 1, k + 1 < idx.length ? idx[k + 1] - 1 : ls.length).join(" ").slice(0, 600) })).filter((a) => a.texto);
}
async function aplicarNovo(p, log) {
  const st = p.locator("button:has-text('Status')").first(); await st.click().catch(() => {}); await p.waitForTimeout(1200);
  const novo = p.locator("[role=option], [role=menuitemcheckbox], [role=menuitem], [cmdk-item]").filter({ hasText: /^\s*Novo\s*$/ }).first();
  const ok = !!(await novo.count()); if (ok) { await novo.click().catch(() => {}); await p.waitForTimeout(2500); }
  await p.keyboard.press("Escape"); await p.waitForTimeout(1500); log(`Portal: filtro Status = Novo ${ok ? "aplicado" : "NÃO achado"}`); return ok;
}
async function fotosDaLinha(p, linha) {
  const ths = (await p.locator("table thead th").allTextContents()).map((t) => t.trim()); const ia = ths.findIndex((h) => /anexo/i.test(h));
  if (ia < 0) return [];
  const bt = linha.locator("td").nth(ia).locator("button, a").first(); if (!(await bt.count())) return [];
  await bt.click(); await p.waitForTimeout(3000);
  const d = p.locator("[role=dialog]").last(); const out = [];
  if (await d.count()) { const srcs = await d.locator("img[src]").evaluateAll((es) => es.map((e) => e.getAttribute("src")));
    for (const s of srcs) { try { const u = new URL(s, p.url()); out.push(u.searchParams.get("url") ? new URL(u.searchParams.get("url"), p.url()).href : u.href); } catch (_) {} } }
  await p.keyboard.press("Escape"); await p.waitForTimeout(800);
  return [...new Set(out)].filter((u) => /^https:\/\//.test(u));
}
export async function rodarRepoPre({ chamar, log, ctx, R = null, limite = 40, reler = false }) {
  const p = await entrarPortal(ctx, log); await abrirRepoPre(p, log);
  if (!(await aplicarNovo(p, log))) throw new Error("não achei o filtro Status = Novo no portal");
  const lista = await lerListaRepoPre(p, null);
  // todos os motivos (Falta de volumes, Avaria, Extravio, Inversão...) da matriz (Brenda 27/11)
  const alvo = lista.filter((c) => SERIES.includes(String(c.nf || "").split("-")[1]?.trim()));
  log(`Portal: ${lista.length} reposições Novo · ${alvo.length} nas séries ${SERIES.join("/")} (${Object.entries(alvo.reduce((a, c) => ((a[c.motivo || "?"] = (a[c.motivo || "?"] || 0) + 1), a), {})).map(([k, v]) => k + " " + v).join(", ")})`);
  const jaTem = new Map((await chamar("repo_pre?select=nf,analisado_em,volumes,venda&limit=5000")).map((x) => [x.nf, x]));
  // quem saiu da lista (já virou ticket, cancelada ou mudou de status)
  const nfs = new Set(alvo.map((c) => c.nf));
  const sairam = [...jaTem.keys()].filter((nf) => !nfs.has(nf));
  if (sairam.length) for (let i = 0; i < sairam.length; i += 50) await chamar(`repo_pre?nf=in.(${sairam.slice(i, i + 50).map((n) => `"${n}"`).join(",")})`, "PATCH", { na_lista: false });
  let feitos = 0, erros = 0;
  for (const c of alvo) {
    const antes = jaTem.get(c.nf);
    const base = { nf: c.nf, motivo: c.motivo, status_portal: c.status, transp: c.transp, solicitado: c.data, qtd_volumes: c.qtd, serie: String(c.nf).split("-")[1].trim(), na_lista: true };
    // já analisado nas últimas 6 h com volumes e 360: só atualiza os dados da lista
    if (!reler && antes && antes.volumes && antes.volumes.length && antes.venda != null && Date.now() - Date.parse(antes.analisado_em || 0) < 6 * 3600000) { await chamar(`repo_pre?nf=eq.${encodeURIComponent(c.nf)}`, "PATCH", base); continue; }
    if (feitos >= limite) { if (!antes) await chamar("repo_pre", "POST", base, { Prefer: "resolution=merge-duplicates,return=minimal" }).catch(() => {}); continue; }
    feitos++;
    const r = { ...base, analisado_em: new Date().toISOString(), robo_msg: null };
    try {
      const linha = await acharLinha(p, c.nf); if (!linha) throw new Error("NF não achada filtrando no portal");
      const v = await volumesDoDialogo(p, linha, null); if (!v.fechou) throw new Error("a janela Criar Ticket não fechou: parei por segurança");
      r.volumes = v.volumes;
      const l2 = await acharLinha(p, c.nf); r.fotos = l2 ? await fotosDaLinha(p, l2) : [];
      // anotações da transportadora (só o texto e a data; o nome de quem escreveu não é guardado)
      const l3 = await acharLinha(p, c.nf); if (l3) r.anotacoes = await anotacoesDaLinha(p, l3);
    } catch (e) { erros++; r.robo_msg = "portal: " + String(e.message).split("\n")[0].slice(0, 150); if (/parei por segurança/.test(e.message)) { await chamar("repo_pre", "POST", r, { Prefer: "resolution=merge-duplicates,return=minimal" }); throw e; } }
    try { const q = await pedido360(ctx, log, c.nf);
      r.venda = q.venda; r.status_360 = q.status || null; r.data_360 = q.data || null; r.sku = q.sku; r.tickets = q.tickets;
      r.tem_devolucao = q.tickets.some((t) => /devolu|cancel/i.test(`${t.tipo} ${t.fila}`));
    } catch (e) { erros++; r.robo_msg = [r.robo_msg, "360: " + String(e.message).split("\n")[0].slice(0, 120)].filter(Boolean).join(" · "); }
    // rastreio da transportadora que pediu: último status + palavras de sinistro (roubo, furto, acidente...)
    if (R) try { const B = await import("./barrar.mjs"); const t = await B.rastrear({ nf: c.nf, transp_pedido: c.transp || "", palavras: SINISTRO }, R);
      r.rastreio = t ? { fonte: t.fonte, situacao: t.situacao, evento: t.evento, data: t.data_evento, transp: t.transp, sinistro: t.palavra || null } : null;
      // print do rastreio (Brenda 27/11): aparece no caso para ver se a ocorrência já está formalizada
      if (t && t.fonte) try { const { subirArquivo } = await import("./supa.mjs"); r.rastreio.print = await subirArquivo("barrar", `repopre-${encodeURIComponent(c.nf)}-rastreio.png`, await B.printRastreio(ctx, c.nf, t)); r.rastreio.print_em = new Date().toISOString(); } catch (_) { log("  print do rastreio falhou"); }
    } catch (_) {}
    try { await chamar("repo_pre", "POST", r, { Prefer: "resolution=merge-duplicates,return=minimal" }); }
    catch (e) { if (!/PGRST204|anotacoes|rastreio/.test(String(e.message))) throw e; log("  (parte 102 ainda não rodada: salvo sem anotações/rastreio)"); const { anotacoes, rastreio, ...r2 } = r; await chamar("repo_pre", "POST", r2, { Prefer: "resolution=merge-duplicates,return=minimal" }); }
  }
  log(`repo-pre: ${feitos} analisados agora · ${erros} com erro · ${sairam.length} saíram da lista`);
}

// ===== modo repo-pre-solicitar (Brenda 27/11): só os casos que a equipe mandou solicitar no E-loggia (solicitar_status = pendente) =====
// 1) portal: print das anotações/foto (solicitação da transportadora); Jadlog: CNPJ da anotação
// 2) portal: ⋯ › Abrir Ticket › Volumes = os que faltam › Adicionar → "Ticket criado com sucesso"
// 3) 360 (login do Eduardo): ticket de Reposição do pedido → Comentário Interno com o print do rastreio SSW + print da solicitação (+ CNPJ Jadlog em maiúsculas)
// TESTE (TRANSP=teste): faz tudo menos o Adicionar e o comentário (fecha a janela sem criar nada).
async function printSolicitacao(p, linha) {
  const out = { prints: [], anot: "" };
  const bt = linha.locator("button[title='Ver Anotações'], button[title*='Anota' i]").first();
  if (await bt.count()) { await bt.click().catch(() => {}); const d = p.locator("[role=dialog]").last(); await d.waitFor({ timeout: 10000 }).catch(() => {}); await p.waitForTimeout(900);
    out.anot = ((await d.innerText().catch(() => "")) || "").replace(/\s*\bClose\b\s*/g, " ");
    try { out.prints.push({ name: "solicitacao-anotacoes.png", mimeType: "image/png", buffer: await p.screenshot() }); } catch (_) {}
    await p.keyboard.press("Escape"); await p.waitForTimeout(700); }
  const ths = (await p.locator("table thead th").allTextContents()).map((t) => t.trim()); const ia = ths.findIndex((h) => /anexo/i.test(h));
  const ba = ia >= 0 ? linha.locator("td").nth(ia).locator("button, a").first() : null;
  if (ba && await ba.count()) {
    // a foto pode ser um link (abre outra página): tira o print numa aba separada e não sai da lista do portal
    const href = await ba.getAttribute("href").catch(() => null);
    if (href) { const q = await p.context().newPage(); try { await q.goto(new URL(href, p.url()).href, { timeout: 30000 }); await q.waitForTimeout(1500); out.prints.push({ name: "solicitacao-foto.png", mimeType: "image/png", buffer: await q.screenshot() }); } catch (_) {} finally { await q.close().catch(() => {}); } }
    else { const url0 = p.url(); const nova = p.context().waitForEvent("page", { timeout: 2500 }).catch(() => null);
      await ba.click().catch(() => {}); const q = await nova; await p.waitForTimeout(2500);
      try { out.prints.push({ name: "solicitacao-foto.png", mimeType: "image/png", buffer: await (q || p).screenshot() }); } catch (_) {}
      if (q) await q.close().catch(() => {});
      await p.keyboard.press("Escape").catch(() => {}); await p.waitForTimeout(700);
      if (p.url() !== url0) throw new Error("a foto saiu da lista do portal"); } }
  if (!out.prints.length) { try { out.prints.push({ name: "solicitacao.png", mimeType: "image/png", buffer: await p.screenshot() }); } catch (_) {} }
  return out;
}
// campos da janela Criar Ticket (só os rótulos, sem dados) e se o botão Adicionar está liberado
async function camposJanela(d) {
  const rot = (await d.locator("label").allTextContents().catch(() => [])).map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean).map((t) => t.replace(/\d/g, "#").slice(0, 30));
  const ad = d.getByRole("button", { name: /^\s*adicionar\s*$/i }).first();
  const lib = (await ad.count()) ? await ad.isEnabled().catch(() => false) : null;
  return { rot, lib };
}
async function criarTicketPortal(p, linha, volumes, teste, log, obs) {
  let passo = "botão ⋯ da linha";
  const clicar = async (loc, nome) => { passo = nome; await loc.click({ timeout: 12000 }); };
  try {
  await clicar(linha.locator("td").last().locator("button").last(), "botão ⋯ da linha"); await p.waitForTimeout(1200);
  const abrir = p.getByRole("menuitem", { name: /abrir ticket/i }).first();
  await clicar((await abrir.count()) ? abrir : p.getByText(/^\s*Abrir ticket\s*$/i).first(), "menu Abrir ticket");
  await p.waitForTimeout(2000);
  const d = p.locator("[role=dialog]").last(); if (!(await d.count())) throw new Error("a janela Criar Ticket não abriu");
  const vol = d.locator("xpath=.//*[normalize-space(text())='Volumes']/following::*[self::button or @role='combobox' or self::input][1]").first();
  await clicar(vol, "campo Volumes"); await p.waitForTimeout(1200);
  const marcados = [];
  for (const v of volumes) { const op = p.locator("[role=option], [role=listbox] li, [cmdk-item]").filter({ hasText: new RegExp("^\\s*" + v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*$") }).first();
    if (!(await op.count())) throw new Error(`o volume ${v} não está na lista do portal`); await op.scrollIntoViewIfNeeded().catch(() => {}); await clicar(op, "opção do volume " + v); marcados.push(v); await p.waitForTimeout(500); }
  // fecha só a lista de volumes (botão Fechar da lista; senão clica no título da janela)
  const fechar = p.getByRole("button", { name: /^\s*fechar\s*$/i }).last();
  if (await fechar.count()) await fechar.click().catch(() => {}); else await d.locator("h1,h2,h3").first().click().catch(() => {});
  await p.waitForTimeout(800);
  const naJanela = ((await d.innerText().catch(() => "")) || "");
  const faltou = volumes.filter((v) => !naJanela.includes(v)); if (faltou.length) throw new Error(`depois de fechar a lista o volume ${faltou.join(", ")} não aparece na janela`);
  // Observação (Brenda 27/11: o Adicionar não liberava sem ela?): escreve o que está sendo reposto
  const ob = d.locator("textarea").first();
  if (obs && await ob.count()) { passo = "campo Observação"; await ob.fill(obs, { timeout: 8000 }).catch(() => {}); await p.waitForTimeout(400); }
  const cj = await camposJanela(d);
  log(`  janela Criar Ticket: campos ${JSON.stringify(cj.rot)} · Observação ${(await ob.count()) ? "sim" : "não"} · Adicionar ${cj.lib === null ? "não achado" : cj.lib ? "liberado" : "BLOQUEADO"}`);
  if (cj.lib === false) throw new Error("o botão Adicionar está bloqueado (falta preencher algum campo da janela)");
  if (teste) { log(`  TESTE: volumes selecionados ${marcados.length}; NÃO cliquei em Adicionar`); await p.keyboard.press("Escape"); await p.waitForTimeout(600); if (await p.locator("[role=dialog]").count()) await d.getByRole("button", { name: /cancelar|fechar/i }).first().click().catch(() => {}); return { teste: true }; }
  await clicar(d.getByRole("button", { name: /^\s*adicionar\s*$/i }).first(), "botão Adicionar");
  for (let i = 0; i < 20; i++) { await p.waitForTimeout(1000); const b = (await p.locator("body").innerText().catch(() => "")) || ""; if (/ticket criado com sucesso/i.test(b)) return { ok: true }; if (/erro|falha/i.test(b) && !(await p.locator("[role=dialog]").count())) break; }
  throw new Error("cliquei em Adicionar mas não vi \"Ticket criado com sucesso\": conferir no portal antes de tentar de novo");
  } catch (e) { if (/Timeout/i.test(e.message)) throw new Error(`não consegui clicar em: ${passo} (a tela não respondeu)`); throw e; }
}
export async function solicitarRepoPre({ chamar, log, ctx, R, teste = false }) {
  // teste: pega 1 caso da lista (o volume em posse marcado, senão finge que o 1º está em posse) e não cria nada
  const L = teste ? [...(await chamar("repo_pre?select=*&solicitar_status=eq.erro&na_lista=eq.true&limit=5")), ...(await chamar("repo_pre?select=*&na_lista=eq.true&order=criado_em&limit=20"))].filter((x) => (x.volumes || []).length > 1 && x.venda !== false && !x.tem_devolucao).slice(0, 1).map((x) => ({ ...x, vol_posse: (x.vol_posse || []).length ? x.vol_posse : [x.volumes[0]], ticket_portal_ok: false }))
    : await chamar("repo_pre?select=*&solicitar_status=eq.pendente&order=solicitar_em&limit=20");
  if (!L.length) { log("repo-pre-solicitar: nada pendente"); return; }
  log(`repo-pre-solicitar: ${L.length} caso(s)${teste ? " · MODO TESTE (não cria nada)" : ""}`);
  const B = await import("./barrar.mjs"), M = await import("./multi360.mjs");
  const p = await entrarPortal(ctx, log); await abrirRepoPre(p, log); await aplicarNovo(p, log);
  const patch = (x, c) => chamar(`repo_pre?nf=eq.${encodeURIComponent(x.nf)}`, "PATCH", c);
  for (const x of L) {
    // Avaria: os volumes marcados são os AVARIADOS (repõe esses); Falta/Extravio: marcados = em posse (repõe os outros)
    const repor = /avaria/i.test(x.motivo || "") ? (x.vol_posse || []) : (x.volumes || []).filter((v) => !(x.vol_posse || []).includes(v));
    let etapa = "início";
    try {
      if (!repor.length) throw new Error("nenhum volume para repor");
      if (x.tem_devolucao || x.venda === false) throw new Error("caso para conferir à mão (devolução ou não é venda)");
      let linha = await acharLinha(p, x.nf); if (!linha) throw new Error("NF não está mais como Novo na lista do portal");
      etapa = "print da solicitação"; const sol = await printSolicitacao(p, linha);
      const jad = /jadlog/i.test(x.transp || "") ? (sol.anot.split(/\n+/).find((l) => /cnpj|\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/i.test(l)) || "").trim().toUpperCase() : "";
      if (/jadlog/i.test(x.transp || "") && !jad) log("  Jadlog: não achei CNPJ na anotação (sigo sem)");
      if (!x.ticket_portal_ok) {
        etapa = "criar ticket no portal"; linha = await acharLinha(p, x.nf); if (!linha) throw new Error("a NF sumiu da lista depois do print");
        const c = await criarTicketPortal(p, linha, repor, teste, log, /EXTRAVIO TOTAL/.test(x.obs || "") ? "EXTRAVIO TOTAL" : `Reposição do(s) volume(s) ${repor.join(", ")}`);
        if (!teste) await patch(x, { ticket_portal_ok: true, solicitar_msg: "Ticket criado no portal; falta o comentário no 360" });
      }
      // rastreio SSW da transportadora que pediu (a do portal)
      etapa = "rastreio"; const r = await B.rastrear({ nf: x.nf, transp_pedido: x.transp || "" }, R).catch(() => null);
      const arquivos = [];
      if (r) arquivos.push({ name: `rastreio-${x.nf}.png`, mimeType: "image/png", buffer: await B.printRastreio(ctx, x.nf, r) });
      arquivos.push(...sol.prints);
      if (teste) { log(`  TESTE: prints prontos ${arquivos.length} (rastreio ${r ? r.fonte + "/" + r.situacao : "não achado"}) · CNPJ Jadlog ${jad ? "sim" : "não"}`); await patch(x, { solicitar_msg: `Teste OK em ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}: nada foi criado.` }); continue; }
      // 360: o ticket de Reposição aparece no pedido alguns segundos depois
      etapa = "comentário no 360"; let tk = null;
      for (let i = 0; i < 4 && !tk; i++) { if (i) await new Promise((ok) => setTimeout(ok, 30000));
        const q = await pedido360(ctx, log, x.nf); const cand = q.tickets.filter((t) => t.id && /^reposi/i.test(t.tipo || "") && !/d[eé]bito/i.test(t.tipo || ""));
        tk = (cand.filter((t) => /atribuir transportador/i.test(t.fila || "")).sort((a, b) => +b.id - +a.id)[0]) || null; }
      if (!tk) throw new Error("ticket criado no portal, mas o ticket de Reposição (Atribuir transportador) ainda não apareceu no 360: tento de novo na próxima rodada");
      const texto = [`Reposição pré-entrega solicitada pelo portal do transportador (${x.motivo || "Falta de volumes"}) · NF ${x.nf}.`,
        `Volume(s) a repor: ${repor.join(", ")}.`, x.vol_posse && x.vol_posse.length && !/avaria/i.test(x.motivo || "") ? `Volume(s) em posse da transportadora (foto): ${x.vol_posse.join(", ")}.` : "",
        jad ? `REPOSIÇÃO NO CNPJ: ${jad}` : "", `Em anexo: print do rastreio${r ? " (" + r.fonte + ")" : ""} e da solicitação no portal.`].filter(Boolean).join(" ");
      await M.comentarioInterno(pedido360.pg, tk.id, texto, arquivos);
      await patch(x, { solicitar_status: "feito", ticket_360: tk.id, solicitar_msg: `Ticket do portal criado e comentário com ${arquivos.length} print(s) no ticket ${tk.id}.`, feito_em: new Date().toISOString() });
      log(`  feito: ticket portal + comentário 360 (${arquivos.length} prints)`);
    } catch (e) { const msg = (`[${etapa}] ` + String(e.message).split("\n")[0]).slice(0, 220); log("  erro: " + msg.replace(/\d{4,}/g, "#"));
      await patch(x, { solicitar_status: /tento de novo/.test(msg) ? "pendente" : "erro", solicitar_msg: msg }).catch(() => {});
      // volta para a lista limpa antes do próximo caso (janela/menu aberto travava o caso seguinte)
      await p.keyboard.press("Escape").catch(() => {}); await p.keyboard.press("Escape").catch(() => {});
      const dl = p.locator("[role=dialog]").last(); if (await dl.count()) await dl.getByRole("button", { name: /cancelar|fechar/i }).first().click({ timeout: 4000 }).catch(() => {});
      try { await p.reload({ timeout: 30000 }).catch(() => {}); await p.waitForTimeout(2000); await abrirRepoPre(p, log); await aplicarNovo(p, log); } catch (e2) { log("  não consegui voltar para a lista: " + String(e2.message).split("\n")[0].slice(0, 100)); } }
  }
}
