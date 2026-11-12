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
    const botoes = [...document.querySelectorAll("button, a[role=button], input[type=submit]")].filter(vis).slice(0, 60)
      .map((e) => (e.innerText || e.value || e.title || "").trim().slice(0, 40)).filter(Boolean);
    const links = [...document.querySelectorAll("nav a, aside a, [class*=menu] a")].slice(0, 80).map((a) => `${(a.innerText || "").trim().slice(0, 40)} -> ${(a.getAttribute("href") || "").slice(0, 80)}`);
    return { campos, botoes: [...new Set(botoes)], links: [...new Set(links)] };
  });
  log(`== ${titulo} · ${new URL(pagina.url()).host}${new URL(pagina.url()).pathname}${new URL(pagina.url()).hash.replace(/[^#/a-z-]/gi, "")}`);
  info.campos.forEach((c) => log("  campo:", c));
  log("  botões:", info.botoes.join(" / "));
  info.links.forEach((l) => log("  link:", l));
}

// abre o pedido. A página /ng#/order-number/ nunca "termina" de carregar: espera o CAMPO, não a página.
async function abrirPedido(pedido) {
  await pagina.goto(`${BASE}/ng#/order-number/${encodeURIComponent(pedido)}`, { waitUntil: "commit" });
  const campo = pagina.locator(process.env.INTELIPOST_CAMPO || "[id$='_formated'], [name$='_formated']").first();
  try { await campo.waitFor({ timeout: 60000 }); } catch { throw new Error("Não achei o pedido na Intelipost (ou a tela não abriu)."); }
  return campo;
}

async function alterar(pedido, iso) {
  const campo = await abrirPedido(pedido);
  await campo.click();   // o input datetime-local de verdade só aparece depois de clicar na caixa de cima
  const dt = pagina.locator("input[type=datetime-local]").first();
  await dt.waitFor({ timeout: 15000 });
  await dt.fill(`${iso}T23:59`);
  if (MODO !== "real") return "teste";
  const resp = pagina.waitForResponse((r) => r.request().method() === "PUT" && /intelipost/i.test(r.url()), { timeout: 45000 });
  await pagina.getByRole("button", { name: /salvar|atualizar|confirmar|gravar/i }).first().click();
  const r = await resp;   // confirma pela resposta do servidor, não pela tela
  if (r.status() >= 400) throw new Error(`A Intelipost recusou a alteração (código ${r.status()}).`);
  return "ok";
}

let ok = 0, erro = 0;
try {
  await entrar();
  if (MODO === "diag") {
    await esqueleto("Tela inicial");
    const fila = await pegarIntelipost(1);
    if (fila[0]) {
      try { await abrirPedido(fila[0].pedido); await esqueleto("Tela do pedido"); }
      catch (e) { log("Tela do pedido:", e.message); await esqueleto("Onde parou"); }
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
