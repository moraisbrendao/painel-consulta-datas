// Reposição pré-entrega: depois que a nova NF da troca de notas existe, registrar no portal do transportador
// (ccp.360multi.com › Reposições › aba "Reposições (Pré Entrega)") uma anotação na NF original: "NF <nova> emitida para o pedido"
// (mesmo texto que a Logística já usa; pedido da Brenda 24/11). Antes de escrever, lê as anotações: se a nova NF já está lá, não repete.
// Registro público (Actions): só contagens e estrutura mascarada — nunca número de nota, nome ou texto de anotação.
import { entrarPortal } from "./barrar.mjs";

const mascara = (t) => String(t ?? "").replace(/\d/g, "#").replace(/\s+/g, " ").trim().slice(0, 80);
const soNum = (t) => String(t ?? "").replace(/\D/g, "");
export const textoAnotacao = (x) => { const n = String(x.nf_nova || "").trim(); return `NF ${/-/.test(n) || !x.serie ? n : `${n}-${String(x.serie).trim()}`} emitida para o pedido`; };

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
  await filtro.fill(""); await filtro.fill(nf); await p.waitForTimeout(2200);
  const linhas = p.locator("table tbody tr");
  for (let i = 0; i < await linhas.count(); i++) { const t = ((await linhas.nth(i).locator("td").first().textContent().catch(() => "")) || "").trim(); if (t === nf || soNum(t) === soNum(nf)) return linhas.nth(i); }
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
  const tem = (await cel.innerText()).includes(soNum(x.nf_nova));
  log(`Texto da célula já tem a nova NF: ${tem ? "sim" : "não"}`);
  const bt = cel.locator("button[title*='Anota' i], [aria-label*='Anota' i], button").first();
  if (await bt.count()) { try { await bt.click(); const d = p.locator("[role=dialog]").last(); await d.waitFor({ timeout: 8000 }); await p.waitForTimeout(800);
    log(`Janela: ${mascara((await textoModal(d)).slice(0, 60))} · já tem a nova NF: ${(await textoModal(d)).includes(soNum(x.nf_nova)) ? "sim" : "não"}`);
    log("Janela campos:", (await d.locator("textarea, input, [contenteditable=true]").evaluateAll((es) => es.map((e) => `${e.tagName.toLowerCase()} "${e.placeholder || ""}"`))).map(mascara).join(" | "));
    log("Janela botões:", (await d.locator("button").evaluateAll((es) => es.map((e) => `${e.type}:${[e.title, e.getAttribute("aria-label"), e.innerText].filter(Boolean).join("/") || "(ícone)"}`))).map(mascara).join(" | "));
    await p.keyboard.press("Escape"); } catch (e) { log("Janela não abriu:", mascara(e.message).slice(0, 80)); } }
}

// grava as anotações pendentes (troca feita, nova NF conhecida, ainda sem anotação no portal). Usa o campo da própria linha
// ("Escreva uma anotação.." + botão "Criar Anotação"). NF que ainda não está na lista do portal: tenta de novo nas próximas rodadas (até 15 dias).
export async function rodarAnota({ chamar, log, ctx, limite = 100 }) {
  const ontem = new Date(Date.now() - 20 * 3600e3).toISOString(), q15 = new Date(Date.now() - 15 * 864e5).toISOString();
  const L = await chamar(`troca_notas?select=ticket,nf_ticket,nf_nova,serie&nf_nova=not.is.null&nf_ticket=not.is.null&robo_status=eq.feito&robo_feito_em=gte.${q15}&or=(portal_anot_status.is.null,and(portal_anot_status.eq.nao_achou,portal_anot_em.lt.${ontem}))&order=robo_feito_em.asc&limit=${limite}`);
  log(`anota-portal: ${L.length} NF(s) para anotar`);
  if (!L.length) return;
  const cont = {}; const soma = (k) => (cont[k] = (cont[k] || 0) + 1);
  const grava = (x, st, msg = null) => chamar(`troca_notas?ticket=eq.${encodeURIComponent(x.ticket)}`, "PATCH", { portal_anot_status: st, portal_anot_em: new Date().toISOString(), portal_anot_msg: msg });
  const p = await entrarPortal(ctx, log); await abrirRepoPre(p, log);
  const ths = (await p.locator("table thead th").allTextContents()).map((t) => t.trim().toLowerCase()), ia = ths.findIndex((h) => /anota/.test(h));
  if (ia < 0) throw new Error("coluna Anotações não encontrada");
  for (const x of L) {
    try {
      const linha = await acharLinha(p, x.nf_ticket);
      if (!linha) { soma("NF ainda fora da lista do portal"); await grava(x, "nao_achou", "NF original não aparece em Reposições (Pré Entrega) do portal"); continue; }
      const cel = linha.locator("td").nth(ia);
      if ((await cel.innerText()).includes(soNum(x.nf_nova))) { soma("já tinha a anotação"); await grava(x, "ja_tinha"); continue; }
      const campo = cel.locator("input[placeholder^='Escreva uma anota'], textarea").first(), b = cel.getByRole("button", { name: /criar anota/i }).first();
      if (!(await campo.count()) || !(await b.count())) throw new Error("campo ou botão Criar Anotação não encontrado");
      await campo.click(); await campo.fill(textoAnotacao(x)); await p.waitForTimeout(300);
      await b.click(); await p.waitForTimeout(3000);
      const l2 = await acharLinha(p, x.nf_ticket), ok = l2 && (await l2.locator("td").nth(ia).innerText()).includes(soNum(x.nf_nova));
      if (ok) { soma("anotado"); await grava(x, "feito"); } else { soma("gravei mas não confirmei"); await grava(x, "erro", "Não apareceu na coluna Anotações depois de gravar: conferir à mão"); }
    } catch (e) {
      soma("erro"); log("  erro:", mascara(String(e.message).split("\n")[0]));
      await grava(x, "erro", String(e.message).split("\n")[0].slice(0, 200)).catch(() => {});
    }
  }
  log("anota-portal: " + Object.entries(cont).map(([k, v]) => `${k} ${v}`).join(" · "));
}
