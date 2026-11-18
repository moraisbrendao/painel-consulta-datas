// Barrar entrega (portal ccp.360multi.com › Barrar Entregas): o painel recebe a planilha de tickets "Barrar entrega",
// o robô confere cada nota nos rastreios e, só nos casos que a Logística aprovar, marca no portal ✓ (barrado) ou ✗ (não barrado).
// Registro público (Actions): só contagens e estrutura mascarada — nunca número de nota, nome ou texto de anotação.
const PORTAL = "https://ccp.360multi.com";
const mascara = (t) => String(t ?? "").replace(/\d/g, "#").replace(/\s+/g, " ").trim();

export async function entrarPortal(ctx, log) {
  const { PORTAL_EMAIL, PORTAL_SENHA } = process.env;
  if (!PORTAL_EMAIL || !PORTAL_SENHA) throw new Error("Faltam os segredos PORTAL_EMAIL e PORTAL_SENHA no GitHub.");
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
  await p.waitForTimeout(3000);
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
