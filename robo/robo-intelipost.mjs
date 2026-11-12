// Robô da Intelipost (aba "Alterar pedidos" do painel): muda a previsão de entrega dos pedidos da fila.
// Modos (variável MODO):
//   diag   -> só entra e anota no registro COMO são as telas (nomes de campos e botões, nunca dados de pedido)
//   dryrun -> abre cada pedido e preenche a data, mas NÃO salva (o pedido volta para a fila)
//   real   -> altera de verdade e grava o resultado na fila
//   diag-troca -> só OLHA as telas da troca de notas (transportadora, volumes, cotação, status) e fecha sem salvar
// Os registros (logs) do GitHub são públicos: aqui nunca aparece número de pedido, nome ou endereço.
// Trava da senha: se o login falhar, grava uma "impressão" da senha (16 letras de um sha256) e não tenta
// de novo enquanto a senha guardada no GitHub for a mesma, para a Intelipost não bloquear a conta do time.
import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { entrarSupabase, pegarIntelipost, resultadoIntelipost, lerEstado, gravarEstado, umPedidoParaOlhar, pegarTroca, resultadoTroca } from "./supa.mjs";

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
  if (MODO.startsWith("diag")) await esqueleto("Tela de login");
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
async function abrirPedido(pedido, olhar, soAbrir) {
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
  // "Entrega prev.:" é um link (ng-click edit_estimated_delivery_date) que abre a edição da previsão do cliente
  const link = tela.locator("a[ng-click^='edit_estimated_delivery_date']").first();
  try { await link.waitFor({ timeout: 60000 }); }
  catch { if (olhar) await camposDeData(tela); if (aba) await aba.close(); throw new Error("A tela do pedido abriu, mas não achei o link da previsão de entrega."); }
  // pedido já entregue/cancelado: não mexe na previsão (avisa em vez de tentar)
  await tela.waitForFunction(() => /Pedido:[^(]{0,80}\(\s*\S/.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {});
  const fechado = await tela.evaluate(() => { const m = document.body.innerText.match(/Pedido:[^(]{0,80}\(\s*(Entregue|Cancelado)\s*\)/i); return m ? m[1] : ""; });
  if (olhar) log("Cabeçalho do pedido:", await tela.evaluate(() => (document.body.innerText.match(/Pedido:[\s\S]{0,60}/) || [""])[0].replace(/\s+/g, " ")));
  if (fechado) { if (olhar) log(`O pedido está ${fechado} na Intelipost.`); if (aba) await aba.close(); throw new Error(`O pedido já está ${fechado.toLowerCase()} na Intelipost: não dá para mudar a previsão.`); }
  if (soAbrir) return { tela, aba };
  const assinatura = () => tela.evaluate(() => [...document.querySelectorAll("input, select, textarea, button, [contenteditable=true]")]
    .filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; })
    .map((e) => `${e.tagName.toLowerCase()} | ${e.type || ""} | id=${e.id} | name=${e.name || ""} | ng-model=${e.getAttribute("ng-model") || ""} | class=${String(e.className).slice(0, 50)} | ${(e.innerText || "").trim().slice(0, 25)}`));
  const antes = olhar ? new Set(await assinatura()) : null;
  const novaAba = ctx.waitForEvent("page", { timeout: 5000 }).catch(() => null);
  await link.click();
  await tela.waitForTimeout(3000);
  if (olhar) {
    const outra = await novaAba;
    log(outra ? "O clique abriu outra aba." : "O clique não abriu outra aba.");
    const depois = await assinatura();
    const novos = depois.filter((x) => !antes.has(x));
    log(`Elementos que apareceram depois do clique: ${novos.length}`);
    novos.slice(0, 30).forEach((x) => log("  novo:", x));
    const ocultos = await tela.evaluate(() => [...document.querySelectorAll("[id*=formated i], [name*=formated i], input[type=datetime-local], [ng-model*=estimated i], .modal, [uib-modal-window], [modal-window]")]
      .slice(0, 20).map((e) => `${e.tagName.toLowerCase()} | id=${e.id} | ng-model=${e.getAttribute("ng-model") || ""} | class=${String(e.className).slice(0, 50)} | ${e.getBoundingClientRect().width > 0 ? "visível" : "escondido"}`));
    ocultos.forEach((x) => log("  formated/modal:", x));
  }
  // ao clicar, aparece o campo de data e hora (input#estimated_delivery_date, datetime-local) e o botão "Atualizar"
  const campo = tela.locator(process.env.INTELIPOST_CAMPO || "input#estimated_delivery_date").first();
  try { await campo.waitFor({ timeout: 20000 }); }
  catch { if (aba) await aba.close(); throw new Error("A tela do pedido abriu, mas não apareceu o campo da previsão."); }
  return { tela, campo, aba };
}

// diagnóstico: todos os campos de data da tela do pedido (inclusive escondidos) e os botões, sem valores
async function camposDeData(tela) {
  const r = await tela.evaluate(() => {
    const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    const campos = [...document.querySelectorAll("input")].filter((e) => /date|data|previs|estimat|formated|delivery|entrega/i.test(`${e.id} ${e.name} ${e.type} ${e.className} ${e.getAttribute("ng-model") || ""}`))
      .slice(0, 40).map((e) => `${e.type} | id=${e.id} | name=${e.name} | ng-model=${e.getAttribute("ng-model") || ""} | ${vis(e) ? "visível" : "escondido"}`);
    const outros = [...document.querySelectorAll("[id*=formated i], [name*=formated i], [ng-model*=estimated i], [ng-model*=delivery i], [ng-model*=previs i], [ng-click*=estimated i], [ng-click*=delivery i], [ng-click*=edit i]")]
      .slice(0, 40).map((e) => `${e.tagName.toLowerCase()} | id=${e.id} | ng-model=${e.getAttribute("ng-model") || ""} | ng-click=${(e.getAttribute("ng-click") || "").slice(0, 60)} | class=${String(e.className).slice(0, 40)} | ${vis(e) ? "visível" : "escondido"}`);
    const perto = [...document.querySelectorAll("*")].filter((e) => e.children.length === 0 && /^\s*Entrega prev\.:?\s*$/i.test(e.textContent || "")).slice(0, 2)
      .map((e) => { const pai = e.parentElement; return [...pai.querySelectorAll("*")].map((x) => `${x.tagName.toLowerCase()}${x.id ? "#" + x.id : ""}${x.getAttribute("ng-click") ? " ng-click=" + x.getAttribute("ng-click").slice(0, 50) : ""}${x.getAttribute("ng-model") ? " ng-model=" + x.getAttribute("ng-model") : ""}`).join(" > "); });
    const rotulos = [...document.querySelectorAll("label, th, dt, .control-label, strong, b, h3, h4, h5")].map((e) => e.innerText.trim()).filter((t) => t && t.length < 50 && /previs|entrega|data/i.test(t)).slice(0, 30);
    const botoes = [...document.querySelectorAll("button, a.btn, [role=button], input[type=submit], input[type=button]")].map((e) => `${(e.innerText || e.value || e.title || "").trim().slice(0, 30)}${vis(e) ? "" : " (escondido)"}`).filter((t) => t && !/^\(escondido\)$/.test(t));
    return { campos, outros, perto, rotulos: [...new Set(rotulos)], botoes: [...new Set(botoes)].slice(0, 50) };
  });
  log("== Tela do pedido · campos de data:"); r.campos.forEach((c) => log("  campo:", c));
  r.outros.forEach((c) => log("  elemento:", c));
  r.perto.forEach((c) => log("  perto de 'Entrega prev.':", c));
  log("  botões:", r.botoes.join(" / "));
}

async function alterar(pedido, iso) {
  const { tela, campo, aba } = await abrirPedido(pedido, false);
  try {
    await campo.fill(`${iso}T23:59`);
    const valor = await campo.inputValue();
    if (!valor.startsWith(iso)) throw new Error("Não consegui preencher a data na Intelipost.");
    if (MODO !== "real") return "teste";
    // o "Atualizar" do mesmo formulário do campo (há outros botões Atualizar na tela)
    let botao = campo.locator("xpath=ancestor::form[1]//button[@type='submit']").first();
    if (!(await botao.count())) botao = tela.locator("button.btn-primary:visible").filter({ hasText: /^\s*atualizar\s*$/i }).last();
    const resp = tela.waitForResponse((r) => ["PUT", "POST", "PATCH"].includes(r.request().method()) && /intelipost/i.test(r.url()) && !/log|track|analytics|hotjar|segment/i.test(r.url()), { timeout: 45000 });
    await botao.click();
    const r = await resp;   // confirma pela resposta do servidor, não pela tela
    if (r.status() >= 400) throw new Error(`A Intelipost recusou a alteração (código ${r.status()}).`);
    log(`Resposta da Intelipost: ${r.request().method()} ${r.status()}`);
    return "ok";
  } finally { if (aba) await aba.close().catch(() => {}); }
}

// Cotação > Cotação de frete > aba "Simulação de cotação": ignorar regras = Sim, CEP destino, método,
// Adicionar + tabela Vigente, volume com 1 em tudo, Calcular -> "Prazo de entrega" (em dias). Só consulta, não altera pedido.
async function simularPrazo(cep, metodo, olhar) {
  const p = pagina;
  const passo = async (nome, fn) => { try { await fn(); if (olhar) log("  ok:", nome); } catch (e) { if (olhar) { log("  falhou:", nome, "-", e.message.split("\n")[0]); await camposDetalhe(p, "Na hora do erro (" + nome + ")"); } throw new Error(`Simulação de cotação: não consegui "${nome}" (${e.message.split("\n")[0].slice(0, 160)})`); } };
  await p.bringToFront();
  await p.goto(BASE + "/quote/freight-quote", { waitUntil: "domcontentloaded" });
  await p.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await passo("abrir a aba Simulação de cotação", async () => { await p.getByText(/^\s*Simulação de cotação\s*$/i).first().click(); await p.waitForTimeout(2000); });
  await passo("marcar Sim em ignorar regras", async () => {
    let i = -1;
    for (let k = 0; k < 15 && i < 0; k++) { if (k) await p.waitForTimeout(1000); i = await p.evaluate(() => [...document.querySelectorAll("input[type=checkbox]")].filter((e) => e.getBoundingClientRect().width > 0)
      .findIndex((e) => { let a = e.parentElement; while (a && (a.innerText || "").trim().length < 25) a = a.parentElement; return a && /ignorar regras/i.test(a.innerText); })); }
    if (i < 0) throw new Error("não achei a chave");
    const caixa = p.locator("input[type=checkbox]:visible").nth(i);
    if (!(await caixa.isChecked())) await caixa.click({ force: true });
    await p.waitForTimeout(800);
    if (!(await caixa.isChecked())) throw new Error("continua Não");
  });
  const destino = p.locator("input[placeholder*='cep de destino' i]:visible").first();
  if (!cep) cep = await p.locator("xpath=//*[starts-with(normalize-space(text()),'Cep Origem')]/following::input[1] >> visible=true").first().inputValue();   // teste: usa o CEP da própria loja
  await passo("preencher o CEP de destino", async () => { await destino.click(); await destino.fill(""); await p.keyboard.type(String(cep).replace(/\D/g, ""), { delay: 40 }); await destino.press("Tab");
    if (olhar) log("  CEP destino ficou com", (await destino.inputValue()).replace(/\D/g, "").length, "dígitos"); });
  await passo("escolher o método de entrega", async () => {
    const sel = p.locator("select:visible").filter({ has: p.locator("option", { hasText: /selecione um método/i }) }).first();
    const nomes = await sel.locator("option").allInnerTexts();
    const certo = nomes.map((x) => x.trim()).find((x) => x.toLowerCase() === metodo.toLowerCase());
    if (!certo) throw new Error("o método não está na lista da Intelipost");
    await sel.selectOption({ label: certo });
    await p.waitForTimeout(800);
  });
  await passo("clicar em Adicionar", async () => { await p.getByRole("button", { name: /^\s*Adicionar\s*$/i }).first().click(); await p.waitForTimeout(2000); });
  await passo("marcar a tabela Vigente", async () => {
    await p.locator("text=/^\\s*Tabelas\\s*$/ >> visible=true").last().click();
    await p.waitForTimeout(1500);
    const vig = p.locator("xpath=//*[normalize-space(text())='Vigente']/following::input[@type='checkbox'][1] >> visible=true").first();
    await vig.click({ force: true });
    if (olhar) log("  tabelas vigentes/rascunho na lista:", await p.locator("xpath=//*[normalize-space(text())='Vigente' or normalize-space(text())='Rascunho']").count());
    const fechar = p.getByRole("button", { name: /^\s*Fechar\s*$/i }).last();
    if (await fechar.count()) await fechar.click();
  });
  await passo("pôr 1 no peso, altura, comprimento, largura e valor", async () => {
    for (const r of ["Peso", "Altura", "Comprimento", "Largura", "Valor Nota Fiscal"]) {
      const c = p.locator(`xpath=//*[starts-with(normalize-space(text()),'${r}')]/following::input[1] >> visible=true`).last();
      await c.click(); await c.fill(""); await p.keyboard.type("1");
    }
  });
  let prazo = null;
  await passo("Calcular e ler o prazo", async () => {
    if (olhar) {
      const v = await p.evaluate(() => [...document.querySelectorAll("input[type=text]")].filter((e) => e.getBoundingClientRect().width > 0).map((e) => e.value).filter((x) => !/\d{5}/.test(x)).join(" | "));
      log("  valores dos campos de volume:", v);
      log("  tabela vigente marcada:", await p.locator("xpath=//*[normalize-space(text())='Vigente']/following::input[@type='checkbox'][1] >> visible=true").first().isChecked().catch(() => "não achei"));
    }
    // a resposta da cotação vem do graphql (quoteFreightVolume): lê o prazo direto dela
    const resp = p.waitForResponse(async (r) => /graphql\.intelipost/i.test(r.url()) && (await r.text().catch(() => "")).includes("quoteFreightVolume"), { timeout: 60000 });
    await p.getByRole("button", { name: /^\s*Calcular\s*$/i }).first().click();
    const corpo = await (await resp).json();
    const q = corpo && corpo.data && corpo.data.quoteFreightVolume;
    const ms = (q && q.delivery_methods) || [];
    if (!ms.length) {
      const exc = (q && q.excluded_methods) || [];
      if (!q) log("  resposta da simulação sem quoteFreightVolume:", JSON.stringify(corpo).replace(/\d{5,}/g, "#####").slice(0, 300));
      else log("  simulação voltou vazia. Chaves:", Object.keys(q).join(", "));
      if (exc.length) log("  métodos excluídos na simulação:", JSON.stringify(exc).slice(0, 400));
      const msg = (corpo.errors && corpo.errors[0] && corpo.errors[0].message) || (exc[0] && (exc[0].reason || exc[0].message || exc[0].description)) || "sem opção de entrega";
      throw new Error(`a Intelipost não achou frete para esse CEP com ${metodo} (${msg.slice(0, 120)})`);
    }
    if (olhar) ms.forEach((m) => log("  opção de envio:", m.name || m.description, "->", m.delivery_estimate_business_days, "dias úteis"));
    const m = ms.find((x) => semAcento(x.name || x.description) === semAcento(metodo)) || (ms.length === 1 ? ms[0] : null);
    if (!m) throw new Error(`a simulação não trouxe o método ${metodo}`);
    prazo = Number(m.delivery_estimate_business_days);
    if (!(prazo > 0)) throw new Error("a simulação veio sem prazo em dias úteis");
  });
  return prazo;
}

// ---- diagnóstico da troca de notas: só abre e fecha, nunca clica em Salvar/Atualizar/Confirmar ----
const PROIBIDO = /^\s*(salvar|atualizar|confirmar|alterar|gravar|enviar|executar|aplicar|ok|sim)\s*$/i;
async function mapaTela(tela, titulo) {
  const r = await tela.evaluate(() => {
    const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    const clic = [...new Set([...document.querySelectorAll("[ng-click]")].filter(vis).map((e) => `${e.tagName.toLowerCase()} ng-click=${e.getAttribute("ng-click").slice(0, 70)} | ${(e.innerText || e.title || "").trim().length > 0 ? "com texto" : "sem texto"}`))].slice(0, 60);
    const titulos = [...new Set([...document.querySelectorAll("label,th,dt,.control-label,legend")].filter(vis).map((e) => e.innerText.trim()).filter((t) => t && t.length < 45 && !/@|\d{4}/.test(t)))].slice(0, 60);
    return { clic, titulos };
  });
  log(`== ${titulo}`);
  log("  títulos/rótulos:", r.titulos.join(" / "));
  r.clic.forEach((c) => log("  ng-click:", c));
}
async function camposDetalhe(tela, titulo, filtroOpcao) {
  const r = await tela.evaluate((f) => {
    const re = f ? new RegExp(f, "i") : null;
    const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    const rot = (e) => { const l = (e.labels && e.labels[0]) || (e.id && document.querySelector(`label[for="${e.id}"]`)); if (l) return l.innerText.trim(); let g = e.parentElement; for (let i = 0; i < 3 && g; i++, g = g.parentElement) { const t = g.querySelector("label, .control-label"); if (t) return t.innerText.trim(); } return e.type === "checkbox" || e.type === "radio" ? "pai: " + (e.parentElement.innerText || e.parentElement.parentElement.innerText || "").trim().slice(0, 40) : ""; };
    return [...document.querySelectorAll("input,select,textarea")].filter(vis).slice(0, 50).map((e) => {
      let ops = "";
      if (e.tagName === "SELECT") { const o = [...e.options].map((o) => o.text.trim()); ops = ` | ${o.length} opções: ` + (re ? o.filter((t) => re.test(t)) : o).slice(0, 25).join(" / "); }
      return `${e.tagName.toLowerCase()} | ${e.type || ""} | ng-model=${e.getAttribute("ng-model") || ""} | rótulo=${rot(e).replace(/\s+/g, " ").slice(0, 40)}${ops}`;
    });
  }, filtroOpcao || null);
  log(`== ${titulo} · campos`); r.forEach((x) => log("  campo:", x));
}
async function abrirEFechar(tela, alvo, titulo, semFechar) {
  const antes = new Set(await tela.evaluate(() => [...document.querySelectorAll("input,select,textarea,button")].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; }).map((e, i) => e.outerHTML.slice(0, 120))));
  await alvo.click();
  await tela.waitForTimeout(2500);
  const novos = await tela.evaluate((antes) => {
    const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    const rot = (e) => { const l = (e.labels && e.labels[0]) || (e.id && document.querySelector(`label[for="${e.id}"]`)); if (l) return l.innerText.trim(); const g = e.closest(".form-group, .row, td, div"); const t = g && g.querySelector("label, .control-label"); return t ? t.innerText.trim() : ""; };
    return [...document.querySelectorAll("input,select,textarea,button")].filter(vis).filter((e) => !antes.includes(e.outerHTML.slice(0, 120)))
      .map((e) => `${e.tagName.toLowerCase()} | ${e.type || ""} | id=${e.id} | name=${e.name || ""} | ng-model=${e.getAttribute("ng-model") || ""} | rótulo=${rot(e).slice(0, 40)} | ${e.tagName === "BUTTON" ? (e.innerText || "").trim().slice(0, 25) : ""}${e.tagName === "SELECT" ? " | opções: " + [...e.options].map((o) => o.text.trim()).slice(0, 25).join(" / ") : ""}`);
  }, [...antes]);
  log(`== ${titulo}: ${novos.length} elemento(s) novos`);
  novos.slice(0, 40).forEach((x) => log("  novo:", x));
  if (semFechar) return;
  // fecha sem salvar: Cancelar/Fechar/X ou Esc
  const fechar = tela.locator(".modal:visible, [uib-modal-window]:visible, [role=dialog]:visible").locator("button, a").filter({ hasText: /^\s*(cancelar|fechar|voltar|×|x)\s*$/i }).first();
  if (await fechar.count()) {
    const txt = (await fechar.innerText().catch(() => "")).trim();
    if (!PROIBIDO.test(txt)) await fechar.click().catch(() => {});
  } else await tela.keyboard.press("Escape").catch(() => {});
  await tela.waitForTimeout(1500);
}
async function diagTroca() {
  if (!process.env.MAPA) {   // teste completo da troca SEM salvar, com nota/chave fictícias, num pedido já alterado
    const alvo = await umPedidoParaOlhar();
    if (!alvo) { log("Não achei pedido para o teste."); return; }
    // usa a transportadora e o método que o pedido já tem (assim a simulação acha frete para o CEP dele)
    let atual = {};
    try {
      const { tela, aba } = await abrirPedido(alvo.pedido, false, true);
      atual = await tela.evaluate(() => { const t = document.body.innerText; return { transp: (t.match(/Transportadora:\s*([^\n]+)/) || [])[1], metodo: (t.match(/M[eé]todo de entrega:\s*([^\n]+)/) || [])[1] }; });
      if (aba) await aba.close();
      log("Transportadora/método atuais do pedido:", atual.transp, "/", atual.metodo);
    } catch (e) { log("Não li a transportadora atual:", e.message.split("\n")[0]); }
    try {
      const r = await fazerTroca({ ticket: "diag", pedido: alvo.pedido, nf_nova: "123456-7", serie: "7", chave: "0".repeat(44), data_emissao: hojeBR(),
        robo_metodo: (atual.metodo || "Transiga Standard").trim(), robo_transp: (atual.transp || "Transiga").trim(), robo_modo: "teste" });
      log("Teste da troca (sem salvar): ok. Passos:", JSON.stringify(r.passos).replace(/"nova_data":"[^"]+",?/, ""));
    } catch (e) { log("Teste da troca:", e.message, "| passos ok:", JSON.stringify(e.passos || {})); }
    return;
  }
  // 1) menu: onde fica a Cotação de frete / Simulação
  await pagina.goto(BASE, { waitUntil: "domcontentloaded" });
  await pagina.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await pagina.waitForTimeout(3000);
  const links = await pagina.evaluate(() => [...new Set([...document.querySelectorAll("a[href]")].map((a) => `${(a.innerText || a.title || "").trim().replace(/\s+/g, " ").slice(0, 40)} -> ${a.getAttribute("href").slice(0, 80)}`))]
    .filter((t) => /cota|simul|frete|alterar|volume|transport|quote/i.test(t)).slice(0, 40));
  log("== Menu (links de cotação/simulação/alterar):"); links.forEach((l) => log("  link:", l));
  try {
    const prazo = await simularPrazo(process.env.CEP_TESTE || "01310100", process.env.METODO_TESTE || "Transiga Standard", true);
    log(`Simulação de teste: prazo = ${prazo} dia(s) úteis`);
  } catch (e) { log("Simulação:", e.message.split("\n")[0]); }
  // 2) tela do pedido: transportadora e volumes (abre a caixinha e fecha sem salvar)
  const alvo = await umPedidoParaOlhar();
  if (!alvo) { log("Não achei pedido para olhar (nem na troca de notas, nem alterado na fila)."); return; }
  log(`Pedido para olhar veio da aba: ${alvo.de}`);
  const { tela, aba } = await abrirPedido(alvo.pedido, false).catch((e) => { log("Tela do pedido:", e.message); return {}; });
  if (tela) {
    await tela.reload({ waitUntil: "domcontentloaded" }).catch(() => {});   // descarta o campo da previsão que abrirPedido abriu (sem salvar)
    await tela.locator("a[ng-click^='edit_estimated_delivery_date']").first().waitFor({ timeout: 60000 }).catch(() => {});
    await tela.waitForTimeout(2000);
    await mapaTela(tela, "Tela do pedido");
    const transp = tela.locator("a[ng-click^='edit_logistic_provider_modal']:visible").first();
    if (await transp.count()) await abrirEFechar(tela, transp, "Caixinha da transportadora").catch((e) => log("Transportadora:", e.message.split("\n")[0]));
    else log("Não achei um ng-click de transportadora (ver lista acima).");
    const vol = tela.locator("[ng-click^='edit_volume_modal']").first();
    const nvol = await tela.locator("[ng-click^='edit_volume_modal']").count();
    log(`Botões de editar volume na tela: ${nvol}`);
    if (nvol) await abrirEFechar(tela, vol, "Editar volume").catch((e) => log("Volume:", e.message.split("\n")[0]));
    if (aba) await aba.close().catch(() => {});
  }
  // 3) Alterar Pedidos: busca o pedido e lista as opções (Macro/Micro/Evento) sem clicar em Atualizar
  try {
    await pagina.goto(BASE + "/order/change-order", { waitUntil: "domcontentloaded" });
    const caixa = pagina.locator("textarea:visible, input[type=text]:visible").first();
    await caixa.waitFor({ timeout: 45000 });
    await pagina.locator("select:visible").first().selectOption({ label: "Pedido" }).catch(() => {});
    await caixa.fill(alvo.pedido);
    await pagina.getByRole("button", { name: /^\s*buscar\s*$/i }).first().click();
    await pagina.waitForTimeout(5000);
    await esqueleto("Alterar Pedidos depois de buscar");
    await mapaTela(pagina, "Alterar Pedidos · ng-click");
    // marca o pedido e escolhe "Micro" (isso só mostra os campos; nada é salvo sem o Atualizar)
    const cx = await pagina.evaluate(() => [...document.querySelectorAll("input[type=checkbox]")].filter((e) => e.getBoundingClientRect().width > 0)
      .map((e) => `ng-model=${e.getAttribute("ng-model") || ""} | ng-change=${(e.getAttribute("ng-change") || e.getAttribute("ng-click") || "").slice(0, 50)} | dentro de ${e.closest("thead") ? "thead" : e.closest("tbody") ? "tbody" : e.closest("table") ? "table" : "fora da tabela"} | ${e.disabled ? "desativado" : "ativo"}`));
    cx.forEach((c) => log("  caixinha:", c));
    const sels = await pagina.evaluate(() => [...document.querySelectorAll("select")].filter((e) => e.getBoundingClientRect().width > 0).map((e) => `ng-model=${e.getAttribute("ng-model") || ""} | ${e.disabled ? "desativado" : "ativo"}`));
    sels.forEach((c) => log("  select:", c));
    await pagina.locator("input[type=checkbox]:visible").last().click({ force: true }).catch((e) => log("Marcar pedido:", e.message.split("\n")[0]));
    await pagina.waitForTimeout(1500);
    const porSel = pagina.locator("select:visible").filter({ has: pagina.locator("option", { hasText: /^\s*Micro\s*$/ }) }).first();
    await porSel.selectOption({ label: "Micro" }, { timeout: 10000 }).catch((e) => log("Alterar por Micro:", e.message.split("\n")[0]));
    await pagina.waitForTimeout(3000);
    await camposDetalhe(pagina, "Alterar Pedidos · Alterar por Micro", "^(12|920)\\b|tr[aâ]nsito|nova nota|equipe_?04|troca");
    const selPor = (re) => pagina.locator("select:visible").filter({ has: pagina.locator("option", { hasText: re }) }).first();
    const escolher = async (re, nome) => {
      const sel = selPor(re);
      const label = await sel.locator("option", { hasText: re }).first().innerText().catch(() => "");
      if (!label) { log(`Não achei a opção ${nome}.`); return false; }
      await sel.selectOption({ label: label.trim() }, { timeout: 10000 }).catch((e) => log(nome + ":", e.message.split("\n")[0]));
      await pagina.waitForTimeout(2500); log(`Escolhi ${nome}: ${label.trim()}`); return true;
    };
    if (await escolher(/^\s*12\s*-/, "Macro 12")) {
      await camposDetalhe(pagina, "Depois do Macro 12", "^\\s*920|nova nota");
      if (await escolher(/^\s*920\b/, "Micro 920")) await camposDetalhe(pagina, "Depois do Micro 920", "equipe_?04|troca");
    }
    const botoes = await pagina.evaluate(() => [...new Set([...document.querySelectorAll("button, input[type=submit]")].filter((e) => e.getBoundingClientRect().width > 0).map((e) => (e.innerText || e.value || "").trim()).filter(Boolean))]);
    log("  botões:", botoes.join(" / "));
  } catch (e) { log("Alterar Pedidos:", e.message.split("\n")[0]); }
}

// ================= TROCA DE NOTAS (reposição TOTAL) =================
// Passos do "ajuste intelipost.docx": 1) transportadora/método  2) simulação de cotação  3) Entrega prev. 23:59
// 4) TODOS os volumes (rastreio, nota, série, chave, data)  5) status Macro 12 · Micro 920 · Equipe_04 Troca de notas.
// modo "teste": preenche e confere tudo, mas fecha sem salvar (recarrega a tela). modo "real": salva cada passo.
// Nada de dado do pedido no registro (pedido, CEP, nota, chave): só "ok" ou o nome do passo que falhou.
const semAcento = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const brData = (iso) => iso.split("-").reverse().join("/");
function hojeBR() { return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10); }
function somaDiasUteis(iso, dias) { const d = new Date(iso + "T12:00:00Z"); let n = 0; while (n < dias) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w !== 0 && w !== 6) n++; } return d.toISOString().slice(0, 10); }
const SALVOU = (r) => ["PUT", "POST", "PATCH"].includes(r.request().method()) && /intelipost\.com\.br/i.test(r.url()) && !/jserrors|kissmetrics|analytics|hotjar|segment|nr-data|log/i.test(r.url());
async function escolherOpcao(sel, alvo) {
  const ops = (await sel.locator("option").allInnerTexts()).map((x) => x.trim());
  const a = semAcento(alvo);
  const certo = ops.find((o) => semAcento(o) === a) || ops.find((o) => semAcento(o).startsWith(a + " ")) ;
  if (!certo) return null;
  await sel.selectOption({ label: certo }); return certo;
}
async function salvarNoModal(tela, campo) {   // o "Atualizar" logo depois do último campo preenchido
  const bt = campo.locator("xpath=following::button[normalize-space()='Atualizar'][1]");
  const resp = tela.waitForResponse(SALVOU, { timeout: 45000 });
  await bt.click();
  const r = await resp;
  if (r.status() >= 400) throw new Error(`a Intelipost recusou (código ${r.status()})`);
  await tela.waitForTimeout(1500);
}
async function fecharModal(tela) {
  const modal = tela.locator(".modal:visible, [uib-modal-window]:visible, [role=dialog]:visible").last();
  const x = modal.locator("button.close, [ng-click*='dismiss'], [ng-click*='cancel'], [ng-click*='close']").first();
  if (await x.count()) await x.click().catch(() => {}); else await tela.keyboard.press("Escape").catch(() => {});
  await tela.waitForTimeout(1000);
}
async function recarregar(tela) {
  await tela.reload({ waitUntil: "domcontentloaded" });
  await tela.locator("a[ng-click^='edit_estimated_delivery_date']").first().waitFor({ timeout: 60000 });
  await tela.waitForTimeout(1500);
}

async function fazerTroca(job) {
  const real = job.robo_modo === "real";
  const parcial = job.tipo === "PARCIAL";   // reposição parcial: mesmo passo a passo, sem mexer nos volumes
  const passos = {};
  const [num, serieNF] = String(job.nf_nova || "").split("-").map((x) => (x || "").trim());
  const serie = (job.serie || serieNF || "").replace(/^0+(?=\d)/, "");
  if (!num || !serie) throw new Error("Falta a nova nota (NF emitida Promob) ou a série na planilha.");
  if (!parcial && (!job.chave || String(job.chave).replace(/\D/g, "").length !== 44)) throw new Error("A chave da nova nota não tem 44 números.");
  if (!parcial && !job.data_emissao) throw new Error("Falta a data de emissão da nova nota.");
  const { tela, aba } = await abrirPedido(job.pedido, false, true);
  let etapa = "abrir o pedido";
  try {
    // status do pedido e CEP do destinatário (o CEP só é usado na simulação; não vai para registro nem painel)
    const fechado = await tela.evaluate(() => { const m = document.body.innerText.match(/Pedido:[^(]{0,80}\(\s*(Entregue|Cancelado)\s*\)/i); return m ? m[1] : ""; });
    if (fechado) throw new Error(`O pedido está ${fechado.toLowerCase()} na Intelipost.`);
    const cep = await tela.evaluate(() => { const m = document.body.innerText.match(/Destinat[aá]rio[\s\S]{0,2000}?CEP:\s*([\d.\-]{8,10})/i); return m ? m[1].replace(/\D/g, "") : ""; });
    if (cep.length !== 8) throw new Error("Não achei o CEP do destinatário na tela do pedido.");
    if (job.ticket === "diag") log(`CEP lido: ${cep.length} dígitos, começa com ${cep[0]} (a loja começa com 9) · CEPs na tela: ${await tela.evaluate(() => (document.body.innerText.match(/CEP:/gi) || []).length)}`);
    const nVol = await tela.locator("[ng-click^='edit_volume_modal']").count();
    if (!nVol && !parcial) throw new Error("Não achei os volumes do pedido (botão Editar).");

    // 2) simulação de cotação (na aba principal) -> prazo em dias úteis
    etapa = "simulação de cotação";
    let prazo;
    try { prazo = await simularPrazo(cep, job.robo_metodo, false); }
    catch (e) { if (job.ticket !== "diag") throw e; log("Diagnóstico: simulação sem frete para esse pedido; sigo com prazo 5 só para testar os outros passos."); prazo = 5; }
    if (!(prazo > 0 && prazo <= 60)) throw new Error(`Prazo estranho na simulação (${prazo}).`);
    const nova = somaDiasUteis(hojeBR(), prazo);
    passos[2] = true; passos.prazo = prazo; passos.volumes = nVol;

    // 1) transportadora e método de entrega
    etapa = "trocar a transportadora";
    await tela.bringToFront();
    await tela.locator("a[ng-click^='edit_logistic_provider_modal']:visible").first().click();
    const selMet = tela.locator("select[ng-model='delivery_method_id']:visible").first();
    await selMet.waitFor({ timeout: 20000 });
    // caixinha: select logistic_provider_id (Transportadora) e delivery_method_id (Método); as opções chegam depois
    const selTransp = tela.locator("select[ng-model='logistic_provider_id']:visible").first();
    await tela.waitForFunction(() => { const e = document.querySelector("select[ng-model='logistic_provider_id']"); return e && e.options.length > 1; }, null, { timeout: 30000 })
      .catch(() => { throw new Error("a lista de transportadoras não carregou"); });
    if (!(await escolherOpcao(selTransp, job.robo_transp))) throw new Error(`A transportadora "${job.robo_transp}" não aparece na caixinha da Intelipost.`);
    await tela.waitForFunction(() => { const e = document.querySelector("select[ng-model='delivery_method_id']"); return e && e.options.length > 1; }, null, { timeout: 30000 }).catch(() => {});
    await tela.waitForTimeout(500);
    if (!(await escolherOpcao(selMet, job.robo_metodo))) throw new Error(`O método "${job.robo_metodo}" não aparece para essa transportadora na Intelipost.`);
    if (real) await salvarNoModal(tela, selMet);
    passos[1] = true;
    if (!real) await recarregar(tela);

    // 3) Entrega prev. = hoje + prazo (dias úteis) 23:59
    etapa = "mudar a Entrega prev.";
    await tela.locator("a[ng-click^='edit_estimated_delivery_date']").first().click();
    const campo = tela.locator("input#estimated_delivery_date").first();
    await campo.waitFor({ timeout: 20000 });
    await campo.fill(`${nova}T23:59`);
    if (!(await campo.inputValue()).startsWith(nova)) throw new Error("não consegui preencher a data");
    if (real) {
      const resp = tela.waitForResponse(SALVOU, { timeout: 45000 });
      await campo.locator("xpath=ancestor::form[1]//button[@type='submit']").first().click();
      const r = await resp; if (r.status() >= 400) throw new Error(`a Intelipost recusou (código ${r.status()})`);
    }
    passos[3] = true; passos.nova_data = nova;
    await recarregar(tela);

    // 4) TODOS os volumes
    etapa = "editar os volumes";
    const n2 = parcial ? 0 : await tela.locator("[ng-click^='edit_volume_modal']").count();
    for (let i = 0; i < n2; i++) {
      etapa = `editar o volume ${i + 1} de ${n2}`;
      await tela.locator("[ng-click^='edit_volume_modal']").nth(i).click();
      const campos = [["current_volume.client_tracking_code", num], ["current_volume.invoice.invoice_number", num], ["current_volume.invoice.invoice_series", serie],
        ["current_volume.invoice.invoice_key", String(job.chave).replace(/\D/g, "")], ["current_volume.invoice.invoice_date_iso", brData(job.data_emissao)]];
      for (const [ng, v] of campos) {
        const c = tela.locator(`input[ng-model='${ng}']:visible`).first();
        await c.waitFor({ timeout: 20000 });
        await c.fill(v);
        if (ng.endsWith("date_iso")) { await c.press("Tab").catch(() => {}); }
        const lido = (await c.inputValue()).replace(/\D/g, "");
        if (lido !== v.replace(/\D/g, "")) throw new Error(`o campo ${ng.split(".").pop()} não aceitou o valor`);
      }
      if (real) await salvarNoModal(tela, tela.locator("input[ng-model='current_volume.invoice.invoice_date_iso']:visible").first());
      await recarregar(tela);   // no teste, recarregar descarta o que foi preenchido
    }
    if (!parcial) passos[4] = true;

    // 5) status: Entregas > Alterar Pedidos > Micro
    etapa = "mudar o status (Alterar Pedidos)";
    await pagina.bringToFront();
    await pagina.goto(BASE + "/order/change-order", { waitUntil: "domcontentloaded" });
    const caixa = pagina.getByPlaceholder(/digite seus pedidos/i).first();
    await caixa.waitFor({ timeout: 45000 });
    await pagina.locator("select:visible").first().selectOption({ label: "Pedido" });
    await caixa.fill(job.pedido);
    await pagina.getByRole("button", { name: /^\s*buscar\s*$/i }).first().click();
    await pagina.locator("table tbody tr").first().waitFor({ timeout: 45000 });
    const linhas = await pagina.locator("table tbody tr").count();
    if (linhas !== 1) throw new Error(`a busca trouxe ${linhas} linhas (esperava 1)`);
    await pagina.locator("table tbody tr input[type=checkbox]").first().click({ force: true });
    await pagina.waitForTimeout(1000);
    const sel = (re) => pagina.locator("select:visible").filter({ has: pagina.locator("option", { hasText: re }) }).first();
    const pick = async (re, nome) => { const s = sel(re); const l = (await s.locator("option", { hasText: re }).first().innerText().catch(() => "")).trim(); if (!l) throw new Error(`não achei a opção ${nome}`); await s.selectOption({ label: l }); await pagina.waitForTimeout(2000); };
    await pick(/^\s*Micro\s*$/, "Alterar por: Micro");
    await pick(/^\s*12\s*-/, "Macro 12");
    await pick(/^\s*920\b/, "Micro 920");
    await pick(/equipe_?04.*troca de notas/i, "Evento Equipe_04 - Troca de notas");
    if (real) {
      const resp = pagina.waitForResponse(SALVOU, { timeout: 45000 });
      await pagina.getByRole("button", { name: /^\s*alterar\s*$/i }).first().click();
      await pagina.waitForTimeout(1500);
      const conf = pagina.locator("[role=dialog]:visible, .modal:visible").getByRole("button", { name: /^\s*(confirmar|sim|ok|alterar)\s*$/i }).first();
      if (await conf.count()) await conf.click();
      const r = await resp; if (r.status() >= 400) throw new Error(`a Intelipost recusou (código ${r.status()})`);
    }
    passos[5] = true;
    return { passos, prazo, nova };
  } catch (e) {
    e.message = `Parei em "${etapa}": ${e.message.split("\n")[0]}`; e.passos = passos; throw e;
  } finally { if (aba) await aba.close().catch(() => {}); }
}

let ok = 0, erro = 0;
try {
  await entrar();
  if (MODO === "diag-troca") await diagTroca();
  else if (MODO === "diag") {
    for (const [nome, caminho] of [["Busca por Lote", "/order/transactions-batch"], ["Alterar Pedidos", "/order/change-order"]]) {
      try {
        await pagina.goto(BASE + caminho, { waitUntil: "domcontentloaded" });
        await pagina.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
        await pagina.waitForTimeout(3000);
        await esqueleto(nome);
      } catch (e) { log(nome + ":", e.message.split("\n")[0]); }
    }
    const fila = await pegarIntelipost(5);
    for (const item of fila) {
      try {
        const { tela, campo, aba } = await abrirPedido(item.pedido, true);
        log("Achei o campo da previsão. Saio sem salvar.");
        if (aba) await aba.close();
        break;
      } catch (e) { log("Pedido da fila:", e.message.split("\n")[0]); }
    }
    for (const item of fila) await resultadoIntelipost(item.pedido, "pendente");   // diagnóstico não mexe nos pedidos
    if (!fila.length) log("Fila vazia: não abri nenhum pedido.");
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
    // troca de notas: cada ticket já diz se é teste ou real (quem pediu no painel escolheu)
    const trocas = await pegarTroca(20).catch((e) => { log("Troca de notas:", e.message.split("\n")[0]); return []; });
    if (trocas.length) log(`${trocas.length} troca(s) de nota na passagem.`);
    let tOk = 0, tErro = 0;
    for (const job of trocas) {
      const modoJob = MODO === "real" ? job.robo_modo : "teste";   // dryrun nunca salva
      try {
        const r = await fazerTroca({ ...job, robo_modo: modoJob });
        await resultadoTroca(job.ticket, modoJob === "real" ? "feito" : "testado", modoJob === "real" ? "Feito na Intelipost." : "Teste ok: tudo preenchido, nada salvo.", r.passos, r.prazo, r.nova);
        tOk++; log(`Troca ${tOk + tErro}: ok (${modoJob}).`);
      } catch (e) {
        tErro++; log(`Troca ${tOk + tErro}: problema -`, e.message);
        await resultadoTroca(job.ticket, "erro", e.message.slice(0, 300), e.passos || {}, e.passos && e.passos.prazo || null, null).catch(() => {});
      }
    }
    if (trocas.length) log(`Troca de notas: ${tOk} ok, ${tErro} com problema.`);
  }
} catch (e) {
  log("Parei:", e.message);
} finally {
  await navegador.close();
}
