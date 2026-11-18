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
