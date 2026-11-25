// Reposição pré-entrega: depois que a nova NF da troca de notas existe, registrar no portal do transportador
// (ccp.360multi.com › Reposições › aba "Reposições (Pré Entrega)") uma anotação na NF original: "NF <nova> emitida para o pedido"
// (mesmo texto que a Logística já usa; pedido da Brenda 24/11). Antes de escrever, lê as anotações: se a nova NF já está lá, não repete.
// Registro público (Actions): só contagens e estrutura mascarada — nunca número de nota, nome ou texto de anotação.
import { entrarPortal } from "./barrar.mjs";
import { entrarMulti360, abrirTicket, comentarioPublico } from "./multi360.mjs";
import { textoPdf } from "./repo-itens.mjs";

const mascara = (t) => String(t ?? "").replace(/\d/g, "#").replace(/\s+/g, " ").trim().slice(0, 80);
const soNum = (t) => String(t ?? "").replace(/\D/g, "");
// número da nova NF sem a série ("84468-4" → "84468"): é o que aparece no texto da anotação "NF 84468-4 …"
const numNova = (x) => soNum(String(x.nf_nova || "").split("-")[0]);
export const TXT_CHAT = "Segue PDF da NF de reposição em anexo";
// PDFs anexados no ticket: devolve o da nova NF (número da nota lido na chave de acesso da DANFE: posições 26 a 34), com o arquivo em memória
export async function pdfDaNovaNf(p, nfNova) {
  const alvo = Number(soNum(String(nfNova).split("-")[0]));
  const hrefs = await p.evaluate(() => [...document.querySelectorAll("a[href]")].filter((a) => /\.pdf(\?|#|$)/i.test(a.getAttribute("href") || "") || /baixar anexo/i.test(a.textContent || "")).map((a) => a.href));
  let pdfs = 0;
  for (const h of [...new Set(hrefs)].reverse()) {
    try {
      const r = await p.context().request.get(h, { timeout: 30000 }); if (!r.ok()) continue;
      const buf = await r.body(); if (buf.slice(0, 4).toString() !== "%PDF") continue; pdfs++;
      const t = (await textoPdf(buf)).txt || "";
      const chaves = (t.replace(/[ .]/g, "").match(/\d{44}/g) || []);
      if (chaves.some((c) => Number(c.slice(25, 34)) === alvo)) return { buf, anexos: hrefs.length, pdfs };
    } catch (_) {}
  }
  return { buf: null, anexos: hrefs.length, pdfs };
}
// já existe comentário público (Externo) com o texto do PDF?
export const jaMandouPdf = (p) => p.evaluate((txt) => { const ls = document.body.innerText.split("\n").map((l) => l.trim()); return ls.some((l, i) => l.startsWith(txt) && ls.slice(Math.max(0, i - 6), i).some((x) => /^externo$/i.test(x))); }, TXT_CHAT);
const nfComSerie = (x) => { const n = String(x.nf_nova || "").trim(); return /-/.test(n) || !x.serie ? n : `${n}-${String(x.serie).trim()}`; };
export const textoAnotacao = (x, comPdf) => `NF ${nfComSerie(x)} emitida para o pedido${comPdf ? ", também temos o pdf em anexo na aba chat" : ""}`;

async function abrirRepoPre(p, log) {
  const link = p.getByRole("link", { name: /reposi[cç][oõ]es/i }).first();
  if (await link.count()) await link.click(); else await p.getByText(/^\s*Reposi[cç][oõ]es\s*\d*\s*$/i).first().click();
  await p.waitForTimeout(2500);
  const aba = p.getByRole("tab", { name: /pr[eé]\s*entrega/i }).first();
  if (await aba.count()) await aba.click(); else await p.getByText(/Reposi[cç][oõ]es\s*\(Pr[eé]/i).first().click().catch(() => {});
  await p.locator("table tbody tr").first().waitFor({ timeout: 45000 }).catch(() => {});
  await p.waitForTimeout(1500);
  log(`Portal: Reposições (Pré Entrega) aberta (${mascara(new URL(p.url()).pathname)})`);
}
// filtra a NF original e devolve a linha (primeira coluna igual à NF)
async function acharLinha(p, nf) {
  const filtro = p.locator("input[placeholder^='Filtrar por nota'], input[placeholder*='nota' i]").first();
  const nfL = String(nf).trim().split("-").map((t) => t.trim().replace(/^0+(?=\d)/, "")).join("-");   // "09873-034" → "9873-34", como no portal
  await filtro.fill(""); await filtro.fill(nfL); await p.waitForTimeout(400);
  // a pesquisa só roda com Enter / botão da lupa ao lado (sem isso a tabela fica na 1ª página sem filtro)
  await filtro.press("Enter").catch(() => {});
  const lupa = filtro.locator("xpath=following::button[1]");
  if (await lupa.count()) await lupa.click({ timeout: 5000 }).catch(() => {});
  await p.waitForTimeout(3000);
  const linhas = p.locator("table tbody tr");
  if (acharLinha.log) acharLinha.log(`  portal: pesquisa trouxe ${await linhas.count()} linha(s)`);
  for (let i = 0; i < await linhas.count(); i++) { const t = ((await linhas.nth(i).locator("td").first().textContent().catch(() => "")) || "").trim(); if (t === nf || t === nfL || soNum(t) === soNum(nfL)) return linhas.nth(i); }
  return null;
}
async function abrirAnotacoes(p, linha) {
  let bt = linha.locator("button[title*='Anota' i], [aria-label*='Anota' i]").first();
  if (!(await bt.count())) bt = linha.locator("td").last().locator("button").first();
  await bt.click(); const d = p.locator("[role=dialog]").last(); await d.waitFor({ timeout: 10000 }); await p.waitForTimeout(900); return d;
}
const textoModal = async (d) => (await d.innerText()).replace(/\s+/g, " ");
const campoNovo = (d) => d.locator("textarea, input[type=text], input:not([type]), [contenteditable=true]").last();
async function botaoSalvar(d) {
  for (const re of [/adicionar|salvar|enviar|gravar|incluir|registrar/i]) { const b = d.getByRole("button", { name: re }).last(); if (await b.count()) return b; }
  const sub = d.locator("button[type=submit]").last(); if (await sub.count()) return sub;
  return null;
}

// diagnóstico: procura as NFs das últimas trocas na lista e mostra só a estrutura (mascarada) da linha e das anotações. Não escreve nada.
export async function diagAnota({ chamar, log, ctx }) {
  const L = await chamar("troca_notas?select=ticket,nf_ticket,nf_nova,serie,robo_status&nf_nova=not.is.null&nf_ticket=not.is.null&order=robo_feito_em.desc.nullslast&limit=40");
  if (!L.length) { log("diag-anota: nenhuma troca com nova NF"); return; }
  const p = await entrarPortal(ctx, log); await abrirRepoPre(p, log);
  log("Linhas na lista sem filtro:", await p.locator("table tbody tr").count(), "· paginação:", mascara((await p.locator("nav, [aria-label*='pagina' i], [class*='pagination' i]").allTextContents().catch(() => [])).join(" ")).slice(0, 80));
  let achou = null, n = 0;
  for (const x of L) { const l = await acharLinha(p, x.nf_ticket); if (l) { n++; if (!achou) achou = { x, l }; } }
  log(`Das ${L.length} últimas trocas com nova NF, ${n} estão na lista do portal (status das trocas: ${[...new Set(L.map((x) => x.robo_status || "vazio"))].join(", ")})`);
  if (!achou) return;
  const { x } = achou; const linha = await acharLinha(p, x.nf_ticket);
  const ths = (await p.locator("table thead th").allTextContents()).map((t) => t.trim().toLowerCase()), ia = ths.findIndex((h) => /anota/.test(h));
  const cel = linha.locator("td").nth(ia);
  log("Célula Anotações:", mascara(await cel.innerText()).slice(0, 60), "·", (await cel.locator("input, textarea, button, svg, a").evaluateAll((es) => es.map((e) => `${e.tagName.toLowerCase()}${e.type ? "[" + e.type + "]" : ""}:${[e.title, e.getAttribute("aria-label"), e.placeholder, e.innerText].filter(Boolean).join("/")}`))).map(mascara).join(" | "));
  log("Botões da linha:", (await linha.locator("button").evaluateAll((es) => es.map((e) => [e.title, e.getAttribute("aria-label"), e.innerText].filter(Boolean).join("/") || "(ícone)"))).map(mascara).join(" | "));
  const tem = (await cel.innerText()).includes(numNova(x));
  log(`Texto da célula já tem a nova NF: ${tem ? "sim" : "não"}`);
  const bt = cel.locator("button[title*='Anota' i], [aria-label*='Anota' i], button").first();
  if (await bt.count()) { try { await bt.click(); const d = p.locator("[role=dialog]").last(); await d.waitFor({ timeout: 8000 }); await p.waitForTimeout(800);
    log(`Janela: ${mascara((await textoModal(d)).slice(0, 60))} · já tem a nova NF: ${(await textoModal(d)).includes(numNova(x)) ? "sim" : "não"}`);
    log("Janela campos:", (await d.locator("textarea, input, [contenteditable=true]").evaluateAll((es) => es.map((e) => `${e.tagName.toLowerCase()} "${e.placeholder || ""}"`))).map(mascara).join(" | "));
    log("Janela botões:", (await d.locator("button").evaluateAll((es) => es.map((e) => `${e.type}:${[e.title, e.getAttribute("aria-label"), e.innerText].filter(Boolean).join("/") || "(ícone)"}`))).map(mascara).join(" | "));
    await p.keyboard.press("Escape"); } catch (e) { log("Janela não abriu:", mascara(e.message).slice(0, 80)); } }
  // Multi360: o ticket da troca tem o PDF da nova NF? já tem o comentário público? como trocar Interno → Público (abre o menu e fecha, não envia)
  const t = L.find((y) => y.robo_status === "feito") || L[0];
  const m = await entrarMulti360(ctx, log); await abrirTicket(m, t.ticket);
  const pdf = await pdfDaNovaNf(m, t.nf_nova);
  log(`360: anexos ${pdf.anexos} · PDFs ${pdf.pdfs} · PDF da nova NF: ${pdf.buf ? "achei" : "não achei"} · comentário público do PDF já existe: ${(await jaMandouPdf(m)) ? "sim" : "não"}`);
  const btc = m.getByRole("button", { name: /coment[aá]rio (interno|p[uú]blico)/i }).first();
  log("Botão do tipo de comentário:", (await btc.count()) ? mascara(await btc.innerText()) : "não achei");
  if (await btc.count()) {
    await btc.click(); await m.waitForTimeout(1500);
    const r = await m.evaluate(() => { const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
      return { menu: [...document.querySelectorAll("[role=menuitem], [role=option], [role=menuitemradio], [role=menu] *")].filter(vis).map((e) => (e.innerText || "").trim().slice(0, 40)).filter(Boolean).slice(0, 12),
        caixas: [...document.querySelectorAll("textarea, [contenteditable=true]")].filter(vis).map((e) => e.getAttribute("placeholder") || "(sem)"), arquivos: document.querySelectorAll("input[type=file]").length,
        enviar: document.querySelectorAll("button:has(svg.lucide-send)").length }; });
    log("Depois de clicar:", JSON.stringify(r).replace(/\d{4,}/g, "#"));
    await m.keyboard.press("Escape"); await abrirTicket(m, t.ticket);
  }
}

// Para cada troca de notas FEITA pelo robô na Intelipost (pré-entrega), nos últimos 15 dias:
//   1) ticket do 360: baixa o PDF da nova NF que está anexado no ticket e manda num Comentário Público (Externo) com
//      "Segue PDF da NF de reposição em anexo" → aparece no chat do portal do transportador. Sem PDF ainda: tenta de novo até 3 dias.
//   2) portal › Reposições (Pré Entrega): anotação "NF <nova> emitida para o pedido[, também temos o pdf em anexo na aba chat]"
//      no campo da linha + "Criar Anotação". NF fora da lista: tenta de novo nas próximas rodadas.
// Nada se repete: antes de escrever, confere se o comentário / a anotação já existem.
export async function rodarAnota({ chamar, log, ctx, limite = 100 }) {
  const q15 = new Date(Date.now() - 15 * 864e5).toISOString(), ontem = new Date(Date.now() - 20 * 3600e3).toISOString();
  const L = await chamar(`troca_notas?select=ticket,nf_ticket,nf_nova,serie,robo_feito_em,chat_pdf_status,chat_pdf_msg,portal_anot_status,portal_anot_em&nf_nova=not.is.null&nf_ticket=not.is.null&robo_status=eq.feito&robo_feito_em=gte.${q15}&or=(chat_pdf_status.is.null,chat_pdf_status.eq.sem_pdf,chat_pdf_status.eq.conferir,and(chat_pdf_status.eq.erro,chat_pdf_msg.like.Coment*),portal_anot_status.is.null,portal_anot_status.eq.erro,and(portal_anot_status.eq.nao_achou,portal_anot_em.lt.${ontem}))&order=robo_feito_em.asc&limit=${limite}`);
  // só alguns tickets (teste pedido pela Brenda): TRANSP = "h:" + hashes sha256[:16] dos tickets, para não expor o número no registro público
  if (/^h:/.test(process.env.TRANSP || "")) {
    const { createHash } = await import("node:crypto"); const hs = new Set(process.env.TRANSP.slice(2).split(","));
    const T = await chamar(`troca_notas?select=ticket,nf_ticket,nf_nova,serie,robo_status,robo_feito_em,chat_pdf_status,chat_pdf_msg,portal_anot_status,portal_anot_em&order=criado_em.desc&limit=5000`).catch(() => chamar(`troca_notas?select=ticket,nf_ticket,nf_nova,serie,robo_status,robo_feito_em,chat_pdf_status,chat_pdf_msg,portal_anot_status,portal_anot_em&limit=5000`));
    const A = T.filter((x) => hs.has(createHash("sha256").update(String(x.ticket)).digest("hex").slice(0, 16)));
    log(`anota-portal: filtro por hash → ${A.length} troca(s)` + A.map((x) => ` [robô ${x.robo_status || "-"} · nova NF ${x.nf_nova ? "sim" : "não"} · NF do ticket ${x.nf_ticket ? "sim" : "não"} · chat ${x.chat_pdf_status || "-"} · portal ${x.portal_anot_status || "-"}]`).join(""));
    L.splice(0, L.length, ...A.filter((x) => x.robo_status === "feito" && x.nf_nova && x.nf_ticket));
    L.forEach((x) => { if (x.portal_anot_status === "nao_achou") x.portal_anot_status = null; });
  }
  // envio da 1ª versão marcado como erro "Comentário enviado…": só conferir, nunca reenviar
  L.forEach((x) => { if (x.chat_pdf_status === "erro" && /^Coment[aá]rio enviado/.test(x.chat_pdf_msg || "")) x.chat_pdf_status = "conferir"; });
  log(`anota-portal: ${L.length} troca(s) para olhar`);
  if (!L.length) return;
  const cont = {}; const soma = (k) => (cont[k] = (cont[k] || 0) + 1);
  const patch = (x, o) => chamar(`troca_notas?ticket=eq.${encodeURIComponent(x.ticket)}`, "PATCH", o);
  // 1) chat do ticket
  const chat = L.filter((x) => !x.chat_pdf_status || x.chat_pdf_status === "sem_pdf" || x.chat_pdf_status === "conferir");
  if (chat.length) {
    const m = await entrarMulti360(ctx, log);
    for (const x of chat) {
      try {
        await abrirTicket(m, x.ticket);
        // já enviado numa rodada anterior e não confirmado: só confere, NUNCA envia de novo
        if (x.chat_pdf_status === "conferir") { let ok = false; for (let k = 0; k < 3 && !ok; k++) { if (k) { await m.waitForTimeout(4000); await abrirTicket(m, x.ticket); } ok = await jaMandouPdf(m); }
          x.chat_pdf_status = ok ? "feito" : "conferir"; soma(ok ? "chat: envio anterior confirmado" : "chat: envio anterior ainda sem confirmação"); if (ok) await patch(x, { chat_pdf_status: "feito", chat_pdf_em: new Date().toISOString(), chat_pdf_msg: null }); continue; }
        if (await jaMandouPdf(m)) { x.chat_pdf_status = "ja_tinha"; soma("chat: já tinha o PDF"); await patch(x, { chat_pdf_status: "ja_tinha", chat_pdf_em: new Date().toISOString(), chat_pdf_msg: null }); continue; }
        const pdf = await pdfDaNovaNf(m, x.nf_nova);
        if (!pdf.buf) { x.chat_pdf_status = "sem_pdf"; soma("chat: PDF da nova NF ainda não está no ticket"); await patch(x, { chat_pdf_status: "sem_pdf", chat_pdf_em: new Date().toISOString(), chat_pdf_msg: `PDF da nova NF não encontrado no ticket (${pdf.pdfs} PDF(s) olhados)` }); continue; }
        await comentarioPublico(m, x.ticket, TXT_CHAT, [{ name: `NF ${nfComSerie(x)}.pdf`, mimeType: "application/pdf", buffer: pdf.buf }]);
        // confere (o comentário demora a aparecer): até 3 vezes; sem confirmação fica "conferir" e a próxima rodada só olha, não reenvia
        let ok = false; for (let k = 0; k < 3 && !ok; k++) { await m.waitForTimeout(5000); await abrirTicket(m, x.ticket); ok = await jaMandouPdf(m); }
        x.chat_pdf_status = ok ? "feito" : "conferir"; soma(ok ? "chat: PDF enviado" : "chat: enviei, confirmo na próxima rodada");
        await patch(x, { chat_pdf_status: x.chat_pdf_status, chat_pdf_em: new Date().toISOString(), chat_pdf_msg: ok ? null : "Comentário enviado; ainda não apareceu como Externo (o robô confere de novo, sem reenviar)" });
      } catch (e) { if (x.chat_pdf_status === "conferir") continue; x.chat_pdf_status = "erro"; soma("chat: erro"); log("  chat erro:", mascara(String(e.message).split("\n")[0])); await patch(x, { chat_pdf_status: "erro", chat_pdf_em: new Date().toISOString(), chat_pdf_msg: String(e.message).split("\n")[0].slice(0, 200) }).catch(() => {}); }
    }
  }
  // 2) anotação no portal (depois do chat; sem PDF, espera até 3 dias da troca antes de anotar só a NF)
  const tres = Date.now() - 3 * 864e5;
  const anota = L.filter((x) => (!x.portal_anot_status || ["nao_achou", "erro"].includes(x.portal_anot_status)) && (["feito", "ja_tinha"].includes(x.chat_pdf_status) || Date.parse(x.robo_feito_em) < tres));
  if (anota.length) {
    const p = await entrarPortal(ctx, log); await abrirRepoPre(p, log); acharLinha.log = log;
    const ths = (await p.locator("table thead th").allTextContents()).map((t) => t.trim().toLowerCase()), ia = ths.findIndex((h) => /anota/.test(h));
    if (ia < 0) throw new Error("coluna Anotações não encontrada");
    const grava = (x, st, msg = null) => patch(x, { portal_anot_status: st, portal_anot_em: new Date().toISOString(), portal_anot_msg: msg });
    for (const x of anota) {
      try {
        const linha = await acharLinha(p, x.nf_ticket);
        if (!linha) { soma("portal: NF ainda fora da lista"); await grava(x, "nao_achou", "NF original não aparece em Reposições (Pré Entrega) do portal"); continue; }
        const cel = linha.locator("td").nth(ia), txt = textoAnotacao(x, ["feito", "ja_tinha"].includes(x.chat_pdf_status));
        if ((await cel.innerText()).includes(numNova(x))) { soma("portal: já tinha a anotação"); await grava(x, "ja_tinha"); continue; }
        let ok;
        const campo = cel.locator("input[placeholder^='Escreva uma anota']").first(), b = cel.getByRole("button", { name: /criar anota/i }).first();
        if (await campo.count() && await b.count()) {   // NF sem anotação: campo na própria linha
          await campo.click(); await campo.fill(txt); await p.waitForTimeout(300); await b.click(); await p.waitForTimeout(3000);
          const l2 = await acharLinha(p, x.nf_ticket); ok = l2 && (await l2.locator("td").nth(ia).innerText()).includes(numNova(x));
          if (!ok && l2) { const vb2 = l2.locator("td").nth(ia).locator("button:has-text('Ver Anota'), button[title*='Anota' i]").first(); if (await vb2.count()) { await vb2.click(); const d2 = p.locator("[role=dialog]").last(); await d2.waitFor({ timeout: 10000 }); await p.waitForTimeout(900); ok = (await textoModal(d2)).includes(numNova(x)); await p.keyboard.press("Escape"); await p.waitForTimeout(500); } }
        } else {   // NF que já tem anotação: botão "Ver Anotações" → janela com "Adicione aqui a sua anotação..." + botão de enviar
          const vb = cel.locator("button:has-text('Ver Anota'), button[title*='Anota' i]").first();
          if (!(await vb.count())) throw new Error("nem campo de anotação nem Ver Anotações na linha");
          await vb.click(); const d = p.locator("[role=dialog]").last(); await d.waitFor({ timeout: 10000 }); await p.waitForTimeout(900);
          if ((await textoModal(d)).includes(numNova(x))) { soma("portal: já tinha a anotação"); await grava(x, "ja_tinha"); await p.keyboard.press("Escape"); await p.waitForTimeout(500); continue; }
          const ta = d.locator("textarea[placeholder^='Adicione aqui'], textarea").first(), env = d.locator("button[type=submit]").first();
          if (!(await ta.count()) || !(await env.count())) throw new Error("campo ou botão da janela de anotações não encontrado");
          await ta.click(); await ta.fill(txt); await p.waitForTimeout(300); await env.click(); await p.waitForTimeout(3000);
          ok = (await textoModal(p.locator("[role=dialog]").last())).includes(numNova(x));
          await p.keyboard.press("Escape"); await p.waitForTimeout(600);
        }
        if (ok) { soma("portal: anotado"); await grava(x, "feito"); } else { soma("portal: gravei mas não confirmei"); await grava(x, "erro", "Não apareceu na coluna Anotações depois de gravar: conferir à mão"); }
      } catch (e) { soma("portal: erro"); log("  portal erro:", mascara(String(e.message).split("\n")[0])); await grava(x, "erro", String(e.message).split("\n")[0].slice(0, 200)).catch(() => {}); }
    }
  }
  log("anota-portal: " + Object.entries(cont).map(([k, v]) => `${k} ${v}`).join(" · "));
}

// diagnóstico da troca que deu erro: como ficou o chat do ticket (só a forma das linhas) e a célula de anotações no portal. Não escreve nada.
export async function diagAnota2({ chamar, log, ctx }) {
  const [x] = await chamar("troca_notas?select=ticket,nf_ticket,nf_nova,serie,chat_pdf_status,portal_anot_status&or=(chat_pdf_status.eq.erro,portal_anot_status.eq.erro)&order=chat_pdf_em.desc.nullslast&limit=1");
  if (!x) { log("diag-anota2: nenhuma troca com erro"); return; }
  const forma = (l) => /^externo$/i.test(l) ? "[Externo]" : /^interno$/i.test(l) ? "[Interno]" : l.startsWith(TXT_CHAT) ? "[TEXTO DO PDF]" : /baixar anexo/i.test(l) ? "[Baixar anexo]" : /\d{2}\/\d{2}\/\d{4}/.test(l) ? "[linha com data]" : `[${l.length} letras]`;
  const m = await entrarMulti360(ctx, log); await abrirTicket(m, x.ticket);
  const ls = await m.evaluate(() => document.body.innerText.split("\n").map((l) => l.trim()).filter(Boolean));
  const idx = ls.map((l, i) => (l.startsWith("Segue PDF da NF de reposição") ? i : -1)).filter((i) => i >= 0);
  log(`360: texto do PDF aparece ${idx.length}x · jaMandouPdf=${await jaMandouPdf(m)}`);
  idx.forEach((i) => log("  em volta:", ls.slice(Math.max(0, i - 6), i + 4).map(forma).join(" › ")));
  const p = await entrarPortal(ctx, log); await abrirRepoPre(p, log);
  const ths = (await p.locator("table thead th").allTextContents()).map((t) => t.trim().toLowerCase()), ia = ths.findIndex((h) => /anota/.test(h));
  const linha = await acharLinha(p, x.nf_ticket); log(`Portal: linha ${!!linha} · coluna anotações ${ia} de ${ths.length} · tds na linha ${linha ? await linha.locator("td").count() : 0}`);
  if (!linha) return;
  const vb = linha.locator("button[title*='Anota' i], button:has-text('Ver Anota')").first();
  if (await vb.count()) { await vb.click(); const d = p.locator("[role=dialog]").last(); await d.waitFor({ timeout: 10000 }); await p.waitForTimeout(900);
    log(`  janela: tem a nova NF ${(await textoModal(d)).includes(numNova(x)) ? "sim" : "não"} · campos:`, (await d.locator("textarea, input, [contenteditable=true]").evaluateAll((es) => es.map((e) => `${e.tagName.toLowerCase()} "${e.placeholder || ""}"`))).map(mascara).join(" | "),
      "· botões:", (await d.locator("button").evaluateAll((es) => es.map((e) => `${e.type}:${[e.title, e.getAttribute("aria-label"), e.innerText].filter(Boolean).join("/") || "(ícone)"}`))).map(mascara).join(" | "));
    await p.keyboard.press("Escape"); await p.waitForTimeout(500); }
  for (let k = 0; k < await linha.locator("td").count(); k++) { const c = linha.locator("td").nth(k); const el = await c.locator("input, textarea, button").evaluateAll((es) => es.map((e) => `${e.tagName.toLowerCase()}:${e.placeholder || e.innerText || e.title || e.getAttribute("aria-label") || "?"}`)); if (el.length) log(`  td ${k}:`, el.map(mascara).join(" | ")); }
}
