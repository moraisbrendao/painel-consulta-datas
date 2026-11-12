// Robô da Intelipost (aba "Alterar pedidos" do painel): muda a previsão de entrega dos pedidos da fila.
// Modos (variável MODO):
//   diag   -> só entra e anota no registro COMO são as telas (nomes de campos e botões, nunca dados de pedido)
//   dryrun -> abre cada pedido e preenche a data, mas NÃO salva (o pedido volta para a fila)
//   real   -> altera de verdade e grava o resultado na fila
// Os registros (logs) do GitHub são públicos: aqui nunca aparece número de pedido, nome ou endereço.
// Trava da senha: se o login falhar, grava uma "impressão" da senha (16 letras de um sha256) e não tenta
// de novo enquanto a senha guardada no GitHub for a mesma, para a Intelipost não bloquear a conta do time.
import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { entrarSupabase, pegarIntelipost, resultadoIntelipost, lerEstado, gravarEstado } from "./supa.mjs";

const MODO = (process.env.MODO || "diag").toLowerCase();
const BASE = (process.env.INTELIPOST_URL || "https://secure.intelipost.com.br").replace(/\/$/, "");
const LIMITE = Number(process.env.LIMITE || 100);
const { INTELIPOST_EMAIL, INTELIPOST_SENHA } = process.env;
const mascara = (t) => String(t).replace(/\d{5,}/g, "#####").replace(/[A-Z_]{3,}\d+[A-Z0-9]*/gi, "<pedido>");
const log = (...a) => console.log(...a.map((x) => (typeof x === "string" ? mascara(x) : x)));

await entrarSupabase();
if (!INTELIPOST_EMAIL || !INTELIPOST_SENHA) {
  await gravarEstado("intelipost", { tipo: "erro", titulo: "Falta o login da Intelipost no GitHub.", msg: "Cadastre INTELIPOST_EMAIL e INTELIPOST_SENHA em Settings > Secrets and variables > Actions." });
  log("Faltam os segredos INTELIPOST_EMAIL e INTELIPOST_SENHA."); process.exit(0);
}
const impressao = createHash("sha256").update(INTELIPOST_EMAIL + ":" + INTELIPOST_SENHA).digest("hex").slice(0, 16);
const estado = (await lerEstado("intelipost")) || {};
if (estado.falhou === impressao) {
  log("A senha guardada é a mesma que já falhou: não vou tentar de novo (para não bloquear a conta). Troque o segredo INTELIPOST_SENHA.");
  process.exit(0);
}

const navegador = await chromium.launch({ headless: false });   // a Intelipost recusa navegador sem janela (o workflow usa xvfb)
const ctx = await navegador.newContext({ viewport: { width: 1440, height: 900 }, locale: "pt-BR" });
let pagina = await ctx.newPage();
pagina.setDefaultTimeout(30000);

async function entrar() {
  await pagina.goto(BASE, { waitUntil: "domcontentloaded" });
  await pagina.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  const usuario = pagina.locator("input[type=email], input[name*=mail i], input[id*=mail i], input[name*=user i], input[id*=user i], input[name*=login i], input[type=text]").first();
  const senha = pagina.locator("input[type=password]").first();
  try { await usuario.or(senha).first().waitFor({ timeout: 45000 }); }
  catch { await esqueleto("Tela de login (não achei os campos)"); throw new Error("Não achei a tela de login da Intelipost."); }
  await usuario.fill(INTELIPOST_EMAIL);
  if (!(await senha.isVisible().catch(() => false))) {   // login em 2 passos: e-mail, continuar, senha
    await pagina.getByRole("button", { name: /continuar|próximo|proximo|avançar|next/i }).first().click().catch(() => pagina.keyboard.press("Enter"));
    try { await senha.waitFor({ timeout: 30000 }); }
    catch { await esqueleto("Depois do e-mail (não apareceu a senha)"); throw new Error("Não apareceu o campo de senha da Intelipost."); }
  }
  await senha.fill(INTELIPOST_SENHA);
  if (MODO === "diag") await esqueleto("Tela de login");
  const botao = pagina.locator("button[type=submit]:visible, input[type=submit]:visible").first();
  if (await botao.count()) await botao.click(); else await senha.press("Enter");
  try { await senha.waitFor({ state: "detached", timeout: 45000 }); }
  catch {
    await gravarEstado("intelipost", { tipo: "erro", falhou: impressao, titulo: "A Intelipost recusou o login do robô.",
      msg: "O robô parou para não bloquear a conta. Confira o e-mail e a senha e troque o segredo INTELIPOST_SENHA no GitHub; ele volta sozinho." });
    throw new Error("Login recusado pela Intelipost (o robô não vai tentar de novo com esta senha).");
  }
  await gravarEstado("intelipost", { tipo: "ok", msg: "Login ok", modo: MODO });
  log("Entrei na Intelipost.");
}

// lista o "esqueleto" da tela: campos e botões (nome, id, tipo, rótulo) sem valores
async function esqueleto(titulo) {
  const info = await pagina.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const campos = [...document.querySelectorAll("input, select, textarea")].filter(vis).slice(0, 60)
      .map((e) => [e.tagName.toLowerCase(), e.type || "", e.name || "", e.id || "", e.placeholder || "", (e.labels && e.labels[0] ? e.labels[0].innerText : "").slice(0, 40)].join(" | "));
    const opcoes = [...document.querySelectorAll("select")].filter(vis).map((e) => [...e.options].map((o) => o.text.trim()).slice(0, 15).join(" / "));
    const botoes = [...document.querySelectorAll("button, a[role=button], input[type=submit]")].filter(vis).slice(0, 60)
      .map((e) => (e.innerText || e.value || e.title || "").trim().slice(0, 40)).filter(Boolean);
    const links = [...document.querySelectorAll("nav a, aside a, [class*=menu] a")].slice(0, 80).map((a) => `${(a.innerText || "").trim().slice(0, 40)} -> ${(a.getAttribute("href") || "").slice(0, 80)}`);
    return { campos, opcoes, botoes: [...new Set(botoes)], links: [...new Set(links)] };
  });
  log(`== ${titulo} · ${new URL(pagina.url()).host}${new URL(pagina.url()).pathname}${new URL(pagina.url()).hash.replace(/order-number\/[^/]+/i, "order-number/<pedido>")}`);
  info.campos.forEach((c) => log("  campo:", c));
  info.opcoes.forEach((o) => log("  opções:", o));
  log("  botões:", info.botoes.join(" / "));
  if (/inicial/i.test(titulo)) info.links.forEach((l) => log("  link:", l));
}

// abre o pedido pela "Busca por Lote" (a Gestão de Pedidos tem filtro de data e esconde pedido antigo).
// Clicar no pedido da lista abre a tela dele em ABA NOVA. Essa tela (/ng#/order-number/) nunca "termina"
// de carregar: espera o CAMPO aparecer, não a página.
async function abrirPedido(pedido, olhar) {
  await pagina.goto(BASE + "/order/transactions-batch", { waitUntil: "domcontentloaded" });
  const caixa = pagina.getByPlaceholder(/digite seus pedidos/i).first();
  await caixa.waitFor({ timeout: 45000 });
  await pagina.locator("select").first().selectOption({ label: "Pedido" }).catch(() => {});   // buscar por "Pedido" (não por rastreio)
  await caixa.fill(pedido);
  await caixa.press("Enter").catch(() => {});
  await pagina.getByRole("button", { name: /^\s*buscar\s*$/i }).first().click();
  const linha = pagina.locator("table tbody tr").filter({ hasText: pedido }).first();
  try { await linha.waitFor({ timeout: 45000 }); }
  catch { if (olhar) await esqueleto("Busca por Lote depois de buscar"); throw new Error("Não achei o pedido na Busca por Lote da Intelipost."); }
  if (olhar) {
    const t = await pagina.evaluate(() => ({
      cab: [...document.querySelectorAll("table thead th")].map((x) => x.innerText.trim()).filter(Boolean).slice(0, 30),
      clic: [...(document.querySelector("table tbody tr") || document.createElement("tr")).querySelectorAll("a, button, [role=button], [class*=link]")]
        .map((x) => `${x.tagName.toLowerCase()}${x.getAttribute("href") ? " href=" + x.getAttribute("href").replace(/order-number\/[^/]+/i, "order-number/<pedido>").replace(/\d+/g, "#") : ""}${x.getAttribute("target") ? " target=" + x.getAttribute("target") : ""} class=${(x.className || "").toString().slice(0, 40)}`).slice(0, 15),
    }));
    log("  colunas da lista:", t.cab.join(" / "));
    t.clic.forEach((c) => log("  clicável na linha:", c));
  }
  const alvo = linha.locator("a").first();
  const clicar = (await alvo.count()) ? alvo : linha.locator("td").filter({ hasText: pedido }).first();
  const [aba] = await Promise.all([ctx.waitForEvent("page", { timeout: 30000 }).catch(() => null), clicar.click()]);
  const tela = aba || pagina;
  tela.setDefaultTimeout(30000);
  // a previsão só vira campo depois de clicar em "Editar" (o "Salvar" aparece junto)
  const editar = tela.locator("button:visible, a:visible, [role=button]:visible, input[type=button]:visible").filter({ hasText: /^\s*editar\s*$/i }).first();
  try { await editar.waitFor({ timeout: 60000 }); await editar.click(); await tela.waitForTimeout(1500); }
  catch { if (olhar) await camposDeData(tela); if (aba) await aba.close(); throw new Error("A tela do pedido abriu, mas não achei o botão Editar."); }
  if (olhar) { log("Cliquei em Editar (nada é salvo no diagnóstico)."); await camposDeData(tela); }
  const campo = tela.locator(process.env.INTELIPOST_CAMPO || "[id$='_formated']:visible, [name$='_formated']:visible").first();
  try { await campo.waitFor({ timeout: 20000 }); }
  catch { if (olhar) { await tela.waitForTimeout(5000); await camposDeData(tela); } if (aba) await aba.close(); throw new Error("A tela do pedido abriu, mas não achei o campo da previsão."); }
  return { tela, campo, aba };
}

// diagnóstico: todos os campos de data da tela do pedido (inclusive escondidos) e os botões, sem valores
async function camposDeData(tela) {
  const r = await tela.evaluate(() => {
    const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    const campos = [...document.querySelectorAll("input")].filter((e) => /date|data|previs|estimat|formated|delivery|entrega/i.test(`${e.id} ${e.name} ${e.type} ${e.className} ${e.getAttribute("ng-model") || ""}`))
      .slice(0, 40).map((e) => `${e.type} | id=${e.id} | name=${e.name} | ng-model=${e.getAttribute("ng-model") || ""} | ${vis(e) ? "visível" : "escondido"}`);
    const rotulos = [...document.querySelectorAll("label, th, dt, .control-label, strong, b, h3, h4, h5")].map((e) => e.innerText.trim()).filter((t) => t && t.length < 50 && /previs|entrega|data/i.test(t)).slice(0, 30);
    const botoes = [...document.querySelectorAll("button, a.btn, [role=button], input[type=submit], input[type=button]")].map((e) => `${(e.innerText || e.value || e.title || "").trim().slice(0, 30)}${vis(e) ? "" : " (escondido)"}`).filter((t) => t && !/^\(escondido\)$/.test(t));
    return { campos, rotulos: [...new Set(rotulos)], botoes: [...new Set(botoes)].slice(0, 50) };
  });
  log("== Tela do pedido · campos de data:"); r.campos.forEach((c) => log("  campo:", c));
  log("  rótulos com data/previsão:", r.rotulos.join(" / "));
  log("  botões:", r.botoes.join(" / "));
}

async function alterar(pedido, iso) {
  const { tela, campo, aba } = await abrirPedido(pedido, false);
  try {
    await campo.click();   // o input datetime-local de verdade só aparece depois de clicar na caixa de cima
    const dt = tela.locator("input[type=datetime-local]").first();
    await dt.waitFor({ timeout: 15000 });
    await dt.fill(`${iso}T23:59`);
    if (MODO !== "real") return "teste";
    const resp = tela.waitForResponse((r) => r.request().method() === "PUT" && /intelipost/i.test(r.url()), { timeout: 45000 });
    await tela.locator("button:visible, a:visible, [role=button]:visible").filter({ hasText: /^\s*salvar\s*$/i }).first().click();
    const r = await resp;   // confirma pela resposta do servidor, não pela tela
    if (r.status() >= 400) throw new Error(`A Intelipost recusou a alteração (código ${r.status()}).`);
    return "ok";
  } finally { if (aba) await aba.close().catch(() => {}); }
}

let ok = 0, erro = 0;
try {
  await entrar();
  if (MODO === "diag") {
    for (const [nome, caminho] of [["Busca por Lote", "/order/transactions-batch"], ["Alterar Pedidos", "/order/change-order"]]) {
      try {
        await pagina.goto(BASE + caminho, { waitUntil: "domcontentloaded" });
        await pagina.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
        await pagina.waitForTimeout(3000);
        await esqueleto(nome);
      } catch (e) { log(nome + ":", e.message.split("\n")[0]); }
    }
    const fila = await pegarIntelipost(1);
    if (fila[0]) {
      try { const { tela, aba } = await abrirPedido(fila[0].pedido, true); const p0 = pagina; pagina = tela; await esqueleto("Tela do pedido"); pagina = p0; if (aba) await aba.close(); }
      catch (e) { log("Tela do pedido:", e.message.split("\n")[0]); }
      await resultadoIntelipost(fila[0].pedido, "pendente");   // diagnóstico não mexe no pedido
    } else log("Fila vazia: não abri nenhum pedido.");
  } else {
    const fila = await pegarIntelipost(LIMITE);
    log(`${fila.length} pedido(s) na passagem (${MODO}).`);
    for (const item of fila) {
      try {
        const r = await alterar(item.pedido, item.nova_data);
        if (r === "ok") { await resultadoIntelipost(item.pedido, "alterado"); ok++; }
        else { await resultadoIntelipost(item.pedido, "pendente"); ok++; }
      } catch (e) {
        erro++; log("Problema:", e.message);
        await resultadoIntelipost(item.pedido, "erro", e.message.slice(0, 300));
      }
    }
    log(`Fim: ${ok} ${MODO === "real" ? "alterados" : "preenchidos sem salvar"}, ${erro} com problema.`);
  }
} catch (e) {
  log("Parei:", e.message);
} finally {
  await navegador.close();
}
