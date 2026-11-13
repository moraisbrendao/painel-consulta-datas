// Multi360 (appv2.360multi.com): etapas 6 e 7 da troca de notas, no ticket.
// 6) anexa no chat o print da página de rastreio do pedido e "Executar ação no ticket" -> "Pedido atualizado na Intelipost" -> Sim
// 7) confere se o ticket foi para a fila "Aguardando entrega".
// Registro público: nunca nome, telefone, CPF, endereço ou o print; só nomes de botões e de filas.
const BASE = (process.env.MULTI360_URL || "https://appv2.360multi.com").replace(/\/$/, "");
const EMAIL = process.env.MULTI360_EMAIL || process.env.PORTAL_EMAIL;
const SENHA = process.env.MULTI360_SENHA || process.env.PORTAL_SENHA;

export async function entrarMulti360(ctx, log) {
  if (!EMAIL || !SENHA) throw new Error("Falta o login do Multi360 no GitHub (MULTI360_EMAIL/MULTI360_SENHA ou PORTAL_EMAIL/PORTAL_SENHA).");
  const p = await ctx.newPage(); p.setDefaultTimeout(30000);
  await p.goto(BASE + "/tickets", { waitUntil: "domcontentloaded" });
  await p.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  log(`Multi360: usando o login de ${process.env.MULTI360_EMAIL ? "MULTI360_EMAIL" : "PORTAL_EMAIL"}; tela: ${new URL(p.url()).pathname}`);
  const senha = p.locator("input[type=password]:visible").first();
  await senha.waitFor({ timeout: 15000 }).catch(() => {});
  if (await senha.count()) {
    const usuario = p.locator("input[type=email]:visible, input[name*=mail i]:visible, input[name*=user i]:visible, input[type=text]:visible").first();
    await usuario.fill(EMAIL); await senha.fill(SENHA);
    const bt = p.getByRole("button", { name: /^\s*entrar\s*$/i }).first();
    if (await bt.count()) await bt.click(); else await senha.press("Enter");
    await p.waitForTimeout(4000);
    const txt = await p.evaluate(() => document.body.innerText.split("\n").map((x) => x.trim()).filter((x) => x && x.length < 120 && /inv[aá]lid|incorret|erro|senha|usu[aá]rio|bloque|tente/i.test(x)).slice(0, 5));
    if (txt.length) log("  textos na tela depois de Entrar:", txt.join(" | "));
    try { await p.waitForURL((u) => !/login|signin|auth/i.test(u.pathname), { timeout: 45000 }); }
    catch {
      const t = await p.evaluate(() => ({ campos: [...document.querySelectorAll("input")].map((e) => `${e.type}:${e.name || e.id || ""}`).join(" "),
        botoes: [...document.querySelectorAll("button")].map((b) => b.innerText.trim()).filter(Boolean).join(" / "),
        avisos: [...document.querySelectorAll("[role=alert], [class*=error i], [class*=toast i], .text-red-500, .text-destructive")].map((e) => e.innerText.trim().slice(0, 100)).filter(Boolean).join(" | ") }));
      log("  tela de login:", new URL(p.url()).pathname, "· campos:", t.campos, "· botões:", t.botoes, "· avisos:", t.avisos);
      throw new Error("O Multi360 recusou o login do robô (confira o login guardado no GitHub).");
    }
  }
  log("Entrei no Multi360.");
  return p;
}

async function abrirTicket(p, ticket) {
  await p.goto(`${BASE}/tickets/${encodeURIComponent(ticket)}`, { waitUntil: "domcontentloaded" });
  await p.getByRole("button", { name: /executar a[cç][aã]o no ticket/i }).first().waitFor({ timeout: 60000 });
  await p.waitForTimeout(1500);
}
const filaAtual = (p) => p.evaluate(() => (document.body.innerText.match(/Atribu[ií]do Fila:\s*([^\n]+)/i) || [])[1] || "").then((x) => x.trim());
const linkRastreio = (p) => p.evaluate(() => { const a = [...document.querySelectorAll("a")].find((x) => /link rastreio/i.test(x.innerText)); return a ? a.href : ""; });

export async function olharTicket(p, ticket, log) {
  await abrirTicket(p, ticket);
  log("Ticket aberto. Fila atual:", await filaAtual(p));
  const r = await p.evaluate(() => {
    const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    return {
      botoes: [...new Set([...document.querySelectorAll("button")].filter(vis).filter((b) => !b.closest("header, nav")).map((b) => (b.innerText || b.title || b.getAttribute("aria-label") || "").trim().slice(0, 30)).filter((t) => t && /a[cç][aã]o|coment|macro|ticket|admin|enviar|anexo/i.test(t)))],
      arquivos: [...document.querySelectorAll("input[type=file]")].map((e) => `accept=${e.accept || ""} multiple=${e.multiple}`),
      caixa: [...document.querySelectorAll("textarea, [contenteditable=true]")].filter(vis).map((e) => `${e.tagName.toLowerCase()} placeholder=${e.getAttribute("placeholder") || ""}`),
    };
  });
  log("  botões:", r.botoes.join(" / "));
  log("  campos de arquivo:", r.arquivos.join(" | ") || "nenhum");
  log("  caixa de mensagem:", r.caixa.join(" | "));
  const lr = await linkRastreio(p);
  log("  link de rastreio:", lr ? new URL(lr).host + " (achei)" : "não achei");
  // abre o "Executar ação no ticket" só para ver a caixinha e fecha em Cancelar
  await p.getByRole("button", { name: /executar a[cç][aã]o no ticket/i }).first().click();
  await p.waitForTimeout(2000);
  const m = await p.evaluate(() => {
    const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    const tit = [...document.querySelectorAll("body *")].filter((e) => vis(e) && e.children.length === 0 && /atualizadas na intelipost/i.test(e.textContent || "")).pop();
    if (!tit) return null;
    let d = tit; while (d && !(d.querySelectorAll("button").length >= 2 && d.querySelector("textarea"))) d = d.parentElement;
    if (!d) return { titulo: tit.textContent.trim(), semCaixa: true };
    return { titulo: tit.textContent.trim(), texto: d.innerText.replace(/\s+/g, " ").slice(0, 200),
      botoes: [...d.querySelectorAll("button")].map((b) => (b.innerText || b.getAttribute("aria-label") || "").trim()).filter(Boolean), arquivo: !!d.querySelector("input[type=file]"), caixa: d.querySelector("textarea") ? d.querySelector("textarea").getAttribute("placeholder") : "" };
  });
  log("  caixinha Executar ação:", m ? JSON.stringify(m).replace(/#\d+/g, "#<ticket>") : "não abriu");
  const cancelar = p.getByRole("button", { name: /^\s*cancelar\s*$/i }).last();
  if (await cancelar.count()) await cancelar.click(); else await p.keyboard.press("Escape");
  await p.waitForTimeout(1000);
  log("  fila depois de cancelar:", await filaAtual(p));
}

// etapas 6 e 7: anexa o print na caixinha "Executar ação no ticket" com a mensagem e clica Sim (no teste: Cancelar).
export async function fazerTicket(p, ticket, print, real, log) {
  await abrirTicket(p, ticket);
  const antes = await filaAtual(p);
  if (/aguardando entrega/i.test(antes)) return "já estava em Aguardando entrega";
  await p.getByRole("button", { name: /executar a[cç][aã]o no ticket/i }).first().click();
  const titulo = p.getByText(/Informa[cç][oõ]es atualizadas na Intelipost\?/i).last();
  try { await titulo.waitFor({ timeout: 20000 }); }
  catch { await p.keyboard.press("Escape").catch(() => {}); throw new Error('a ação do ticket não é "Informações atualizadas na Intelipost?" (confira a fila do ticket)'); }
  const caixa = titulo.locator("xpath=ancestor::*[.//textarea and count(.//button) >= 2][1]");
  if (print) { await caixa.locator("input[type=file]").first().setInputFiles(print); await p.waitForTimeout(2500); }
  await caixa.locator("textarea").first().fill("Pedido atualizado na Intelipost");
  if (!real) { await caixa.getByRole("button", { name: /^\s*cancelar\s*$/i }).first().click(); return "teste (cancelado)"; }
  await caixa.getByRole("button", { name: /^\s*sim\s*$/i }).first().click();
  // 7) confere a fila (recarrega algumas vezes)
  for (let i = 0; i < 6; i++) {
    await p.waitForTimeout(5000);
    await abrirTicket(p, ticket).catch(() => {});
    const f = await filaAtual(p);
    if (/aguardando entrega/i.test(f)) return "ok";
    if (i === 5) throw new Error(`executei a ação, mas o ticket está na fila "${f}" (esperava Aguardando entrega)`);
  }
}

// Fila Aguardando entrega: lê no chat do ticket a última "NF 123-7 emitida para o pedido" (com a data da mensagem)
// e a última "Transportadora definida: X". Abre o ticket antes. Nada disso vai para o registro público.
export async function lerChatTicket(p, ticket) {
  await abrirTicket(p, ticket);
  // o chat pode carregar as mensagens antigas só ao rolar para cima
  for (let i = 0; i < 6; i++) {
    const subiu = await p.evaluate(() => { let s = false; for (const e of document.querySelectorAll("*")) { if (e.scrollHeight > e.clientHeight + 50 && e.scrollTop > 0 && /auto|scroll/.test(getComputedStyle(e).overflowY)) { e.scrollTop = 0; s = true; } } return s; });
    if (!subiu) break; await p.waitForTimeout(1200);
  }
  const r = await p.evaluate(() => {
    const ls = document.body.innerText.split("\n").map((x) => x.trim()).filter(Boolean);
    let nf = null, em = null, transp = null, nfs = 0;
    ls.forEach((l, i) => {
      const m = l.match(/NF\s*(\d+)\s*-\s*(\d+)\s+emitida\s+para\s+o\s+pedido/i);
      if (m) { nfs++; nf = `${m[1]}-${m[2]}`; em = null;
        for (let k = i - 1; k >= Math.max(0, i - 4); k--) { const d = ls[k].match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/); if (d) { em = `${d[3]}-${d[2]}-${d[1]}T${d[4]}:${d[5]}:${d[6] || "00"}-03:00`; break; } } }
      const t = l.match(/Transportadora definida:\s*(.+?)(?:\s*\(Intelipost|$)/i); if (t) transp = t[1].trim().slice(0, 80);
    });
    return { nf, em, transp, nfs };
  });
  return { ...r, fila: await filaAtual(p) };
}

// executa a ação do ticket cuja caixinha tem o título esperado (ex.: "Nota entregue?"), com mensagem e print; real=false clica Cancelar
export async function executarAcao(p, ticket, { titulo, msg, print, real }) {
  await abrirTicket(p, ticket);
  await p.getByRole("button", { name: /executar a[cç][aã]o no ticket/i }).first().click();
  const t = p.getByText(titulo).last();
  try { await t.waitFor({ timeout: 20000 }); }
  catch {
    const outro = await p.evaluate(() => { const h = [...document.querySelectorAll("body *")].find((e) => e.children.length === 0 && /\?\s*$/.test((e.textContent || "").trim()) && e.getBoundingClientRect().width > 0); return h ? h.textContent.trim().slice(0, 60) : ""; }).catch(() => "");
    const c = p.getByRole("button", { name: /^\s*cancelar\s*$/i }).last(); if (await c.count()) await c.click().catch(() => {}); else await p.keyboard.press("Escape").catch(() => {});
    throw new Error(`a ação do ticket é "${outro || "outra"}", não a esperada (o ticket mudou de fila?)`);
  }
  const caixa = t.locator("xpath=ancestor::*[.//textarea and count(.//button) >= 2][1]");
  if (print) { await caixa.locator("input[type=file]").first().setInputFiles(print); await p.waitForTimeout(2500); }
  await caixa.locator("textarea").first().fill(msg);
  if (!real) { await caixa.getByRole("button", { name: /^\s*cancelar\s*$/i }).first().click(); return { ok: true, teste: true }; }
  await caixa.getByRole("button", { name: /^\s*sim\s*$/i }).first().click();
  await p.waitForTimeout(6000);
  await abrirTicket(p, ticket).catch(() => {});
  return { ok: true, fila: await filaAtual(p).catch(() => "") };
}
