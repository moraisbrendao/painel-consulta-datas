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
      botoes: [...new Set([...document.querySelectorAll("button")].filter(vis).map((b) => (b.innerText || b.title || b.getAttribute("aria-label") || "").trim().slice(0, 30)).filter(Boolean))],
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
    const d = [...document.querySelectorAll("[role=dialog], .modal, [class*=modal i], [class*=dialog i]")].filter((e) => e.getBoundingClientRect().width > 0).pop();
    if (!d) return null;
    return { titulo: (d.querySelector("h1,h2,h3,h4,h5,[class*=title i]") || {}).innerText || "", texto: d.innerText.replace(/\s+/g, " ").slice(0, 200),
      botoes: [...d.querySelectorAll("button")].map((b) => (b.innerText || b.getAttribute("aria-label") || "").trim()).filter(Boolean), arquivo: !!d.querySelector("input[type=file]"), caixa: !!d.querySelector("textarea") };
  });
  log("  caixinha Executar ação:", m ? JSON.stringify(m).replace(/#\d+/g, "#<ticket>") : "não abriu");
  const cancelar = p.getByRole("button", { name: /^\s*cancelar\s*$/i }).last();
  if (await cancelar.count()) await cancelar.click(); else await p.keyboard.press("Escape");
  await p.waitForTimeout(1000);
  log("  fila depois de cancelar:", await filaAtual(p));
}
