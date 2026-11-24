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

// diagnóstico: abre a NF de 1 troca já feita, mostra só a estrutura da janela de anotações (mascarada). Não escreve nada.
export async function diagAnota({ chamar, log, ctx }) {
  const [x] = await chamar("troca_notas?select=ticket,nf_ticket,nf_nova,serie&nf_nova=not.is.null&nf_ticket=not.is.null&order=robo_feito_em.desc.nullslast&limit=1");
  if (!x) { log("diag-anota: nenhuma troca com nova NF"); return; }
  const p = await entrarPortal(ctx, log); await abrirRepoPre(p, log);
  log("Abas:", (await p.getByRole("tab").allTextContents()).map(mascara).join(" | "));
  log("Colunas:", (await p.locator("table thead th").allTextContents()).map(mascara).join(" | "));
  log("Filtros (placeholder):", (await p.locator("input").evaluateAll((es) => es.map((e) => e.placeholder).filter(Boolean))).map(mascara).join(" | "));
  const linha = await acharLinha(p, x.nf_ticket);
  log(`NF de teste: formato ${mascara(x.nf_ticket)} · nova ${mascara(textoAnotacao(x))} · achou na lista: ${!!linha}`);
  if (!linha) return;
  log("Botões da linha:", (await linha.locator("button").evaluateAll((es) => es.map((e) => [e.title, e.getAttribute("aria-label"), e.innerText].filter(Boolean).join("/")))).map(mascara).join(" | "));
  const d = await abrirAnotacoes(p, linha);
  const tx = await textoModal(d);
  log(`Janela: ${mascara(tx).slice(0, 80)} · já tem a nova NF: ${tx.includes(soNum(x.nf_nova)) ? "sim" : "não"}`);
  log("Campos:", (await d.locator("textarea, input, [contenteditable=true]").evaluateAll((es) => es.map((e) => `${e.tagName.toLowerCase()}[${e.type || ""}] "${e.placeholder || e.getAttribute("aria-label") || ""}"`))).map(mascara).join(" | "));
  log("Botões:", (await d.locator("button").evaluateAll((es) => es.map((e) => `${e.type}:${[e.title, e.getAttribute("aria-label"), e.innerText].filter(Boolean).join("/")}${e.disabled ? " (desligado)" : ""}`))).map(mascara).join(" | "));
  const b = await botaoSalvar(d); log(`Botão de gravar reconhecido: ${b ? mascara(await b.innerText().catch(() => "") || await b.getAttribute("type")) : "NÃO"}`);
  await p.keyboard.press("Escape");
}

// grava as anotações pendentes (troca feita, nova NF conhecida, ainda sem anotação no portal)
export async function rodarAnota({ chamar, log, ctx, limite = 100 }) {
  const L = await chamar(`troca_notas?select=ticket,nf_ticket,nf_nova,serie&nf_nova=not.is.null&nf_ticket=not.is.null&robo_status=eq.feito&portal_anot_status=is.null&order=robo_feito_em.asc&limit=${limite}`);
  log(`anota-portal: ${L.length} NF(s) para anotar`);
  if (!L.length) return;
  const cont = {}; const soma = (k) => (cont[k] = (cont[k] || 0) + 1);
  const grava = (x, st, msg = null) => chamar(`troca_notas?ticket=eq.${encodeURIComponent(x.ticket)}`, "PATCH", { portal_anot_status: st, portal_anot_em: new Date().toISOString(), portal_anot_msg: msg });
  const p = await entrarPortal(ctx, log); await abrirRepoPre(p, log);
  for (const x of L) {
    try {
      const linha = await acharLinha(p, x.nf_ticket);
      if (!linha) { soma("NF fora da lista do portal"); await grava(x, "nao_achou", "NF original não aparece em Reposições (Pré Entrega)"); continue; }
      const d = await abrirAnotacoes(p, linha);
      if ((await textoModal(d)).includes(soNum(x.nf_nova))) { soma("já tinha a anotação"); await grava(x, "ja_tinha"); await p.keyboard.press("Escape"); await p.waitForTimeout(500); continue; }
      const campo = campoNovo(d), b = await botaoSalvar(d);
      if (!(await campo.count()) || !b) throw new Error("campo ou botão de gravar não encontrado");
      await campo.click(); await campo.fill(textoAnotacao(x)); await p.waitForTimeout(400);
      await b.click(); await p.waitForTimeout(2500);
      // confere: a anotação nova aparece na janela (se a janela fechou, abre de novo)
      let d2 = p.locator("[role=dialog]").last(); if (!(await d2.count()) || !(await d2.isVisible().catch(() => false))) { const l2 = await acharLinha(p, x.nf_ticket); d2 = l2 ? await abrirAnotacoes(p, l2) : null; }
      const ok = d2 && (await textoModal(d2)).includes(soNum(x.nf_nova));
      if (ok) { soma("anotado"); await grava(x, "feito"); } else { soma("gravei mas não confirmei"); await grava(x, "erro", "Não apareceu na lista de anotações depois de gravar: conferir à mão"); }
      await p.keyboard.press("Escape"); await p.waitForTimeout(600);
    } catch (e) {
      soma("erro"); log("  erro:", mascara(String(e.message).split("\n")[0]));
      await grava(x, "erro", String(e.message).split("\n")[0].slice(0, 200)).catch(() => {});
      await p.keyboard.press("Escape").catch(() => {});
    }
  }
  log("anota-portal: " + Object.entries(cont).map(([k, v]) => `${k} ${v}`).join(" · "));
}
