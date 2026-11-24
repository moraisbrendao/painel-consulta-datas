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
import { entrarMulti360, olharTicket, fazerTicket } from "./multi360.mjs";
import { createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { entrarSupabase, pegarIntelipost, resultadoIntelipost, lerEstado, gravarEstado, umPedidoParaOlhar, pegarTroca, resultadoTroca, ultimaTrocaComErro, trocaDoTicket, chamar } from "./supa.mjs";

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
// a Intelipost passou a pedir código de verificação no login: não tenta de novo por 3 h (cada tentativa manda um código por e-mail)
if (estado.codigo_em && Date.now() - new Date(estado.codigo_em).getTime() < 3 * 3600e3 && process.env.GITHUB_EVENT_NAME === "schedule") {
  log("A Intelipost pediu código de verificação há menos de 3 h: não vou tentar agora.");
  process.exit(0);
}

const navegador = await chromium.launch({ headless: false });   // a Intelipost recusa navegador sem janela (o workflow usa xvfb)
// sessão guardada (depois de um login com código): fica CRIPTOGRAFADA no Supabase com chave tirada da senha do GitHub
const chaveSessao = createHash("sha256").update("sessao-intelipost:" + INTELIPOST_EMAIL + ":" + INTELIPOST_SENHA).digest();
function cifrar(obj) { const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", chaveSessao, iv); const d = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]); return { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), dados: d.toString("base64") }; }
function decifrar(v) { try { const c = createDecipheriv("aes-256-gcm", chaveSessao, Buffer.from(v.iv, "base64")); c.setAuthTag(Buffer.from(v.tag, "base64")); return JSON.parse(Buffer.concat([c.update(Buffer.from(v.dados, "base64")), c.final()]).toString("utf8")); } catch { return null; } }
const sessaoGuardada = await lerEstado("intelipost_sessao").then((v) => (v && v.dados ? decifrar(v) : null)).catch(() => null);
const ctx = await navegador.newContext({ viewport: { width: 1440, height: 900 }, locale: "pt-BR", timezoneId: "America/Sao_Paulo", ...(sessaoGuardada ? { storageState: sessaoGuardada } : {}) });
async function guardarSessao() { try { await gravarEstado("intelipost_sessao", cifrar(await ctx.storageState())); log("Sessão da Intelipost guardada (criptografada)."); } catch (e) { log("Não consegui guardar a sessão:", e.message.slice(0, 80)); } }
let pagina = await ctx.newPage();
ctx.on("page", (pg) => pg.on("dialog", (d) => d.accept().catch(() => {})));   // "sair da página?" da simulação travava a próxima busca
pagina.on("dialog", (d) => d.accept().catch(() => {}));
pagina.setDefaultTimeout(30000);

const sessaoExpirou = (pg) => pg.getByText(/sess[aã]o expirou/i).first().isVisible().catch(() => false);
async function entrar(forcar = false) {
  if (sessaoGuardada && !forcar) {
    await pagina.goto(BASE + "/order/transactions-batch", { waitUntil: "domcontentloaded" }).catch(() => {});
    let ok = await pagina.getByPlaceholder(/digite seus pedidos/i).first().waitFor({ timeout: 25000 }).then(() => true).catch(() => false);
    // a tela da busca aparece por alguns segundos mesmo com a sessão morta e depois a Intelipost joga para o /login:
    // espera e confere de novo, para pedir o código já no começo (e não estourar o tempo no meio do ajuste)
    if (ok) { await pagina.waitForTimeout(6000);
      const naLogin = /\/login/i.test(new URL(pagina.url()).pathname) || (await pagina.locator("input[type=password]:visible").count().catch(() => 0)) > 0;
      if (naLogin) { ok = false; log("A sessão guardada caiu (a Intelipost voltou para o login)."); await pagina.context().clearCookies().catch(() => {}); } }
    // a Busca por Lote abre mesmo com a sessão vencida; a tela de cotação mostra "Esta sessão expirou! (inativo por 240 minutos)"
    let expirou = false;
    if (ok) {
      await pagina.goto(BASE + "/quote/freight-quote", { waitUntil: "domcontentloaded" }).catch(() => {});
      expirou = await pagina.getByText(/sess[aã]o expirou/i).first().waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
      if (!expirou) await pagina.goto(BASE + "/order/transactions-batch", { waitUntil: "domcontentloaded" }).catch(() => {});
    }
    if (expirou) { log("A Intelipost diz que a sessão guardada expirou (240 min sem uso)."); await pagina.context().clearCookies().catch(() => {}); }
    if (ok && !expirou && !/\/login/i.test(new URL(pagina.url()).pathname)) { log("Entrei na Intelipost com a sessão guardada."); await gravarEstado("intelipost", { tipo: "ok", msg: "Login ok (sessão guardada)", modo: MODO }); await guardarSessao(); return true; }
    if (MODO === "manter") {   // rodada só para manter a sessão viva: não pede código fora de hora
      await gravarEstado("intelipost", { tipo: "aviso", titulo: "A sessão da Intelipost caiu.", msg: "No próximo envio para o robô, a Intelipost vai pedir o código de 6 dígitos: a caixa amarela aparece aqui e o robô espera até 10 minutos.", modo: MODO });
      log("Sessão caiu: aviso deixado no painel (o código será pedido no próximo envio)."); return false;
    }
    log("A sessão guardada venceu: vou fazer o login.");
  }
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
  await pagina.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await pagina.waitForTimeout(3000);
  if (MODO.startsWith("diag")) await esqueleto("Logo depois do login");
  // a Intelipost às vezes não guarda a sessão (volta para a tela de login ou pede mais uma etapa): para aqui com aviso claro
  if (/\/login/i.test(new URL(pagina.url()).pathname)) {
    const caixas = pagina.locator("input[type=text]:visible, input[type=tel]:visible, input[type=number]:visible, input[autocomplete=one-time-code]:visible");
    const n = await caixas.count();
    if (!n) {
      await esqueleto("Depois do login continuou na tela de login");
      await gravarEstado("intelipost", { tipo: "erro", titulo: "A Intelipost não deixou o robô entrar.", msg: "Depois da senha, a Intelipost voltou para a tela de login. Entre no site com o login do robô para ver o que ela pede." });
      throw new Error("A Intelipost voltou para a tela de login depois da senha.");
    }
    // pede o código no painel e espera alguém digitar (até 10 min)
    const pedidoEm = new Date().toISOString();
    await gravarEstado("intelipost", { tipo: "codigo", pedido_em: pedidoEm, titulo: "A Intelipost pediu o código de verificação.",
      msg: "Digite no painel o código de 6 dígitos que chegou no e-mail do login do robô. O robô espera até 10 minutos." });
    log("A Intelipost pediu código de verificação: esperando alguém digitar no painel (até 10 min).");
    let codigo = "";
    for (let i = 0; i < 120 && !codigo; i++) {
      const c = await lerEstado("intelipost_codigo").catch(() => null);
      if (c && c.codigo && c.em && c.em > pedidoEm) codigo = String(c.codigo).replace(/\D/g, "");
      else await pagina.waitForTimeout(5000);
    }
    await gravarEstado("intelipost_codigo", { usado_em: new Date().toISOString() }).catch(() => {});
    if (!codigo) {
      await gravarEstado("intelipost", { tipo: "erro", codigo_em: new Date().toISOString(), titulo: "Ninguém digitou o código da Intelipost.",
        msg: "O robô esperou 10 minutos e parou. Ele pede de novo quando você mandar um pedido para alterar (ou na próxima rodada, em até 3 h)." });
      throw new Error("Ninguém digitou o código de verificação a tempo.");
    }
    log(`Código recebido do painel (${codigo.length} dígitos); a tela tem ${n} caixas.`);
    // registra só o caminho e o status das chamadas de login (nada do conteúdo)
    const vistas = [];
    const ouvir = (r) => { const u = new URL(r.url()); if (r.request().method() !== "GET" && /login|auth|token|mfa|otp|code|codigo|verif|session/i.test(u.pathname)) vistas.push(`${r.request().method()} ${u.host}${u.pathname.replace(/\d{4,}/g, "#")} → ${r.status()}`); };
    pagina.on("response", ouvir);
    // digita como uma pessoa: clica na 1ª caixa e vai teclando (a tela pula sozinha para a próxima caixa)
    await caixas.first().click(); await pagina.keyboard.type(codigo, { delay: 150 });
    await pagina.waitForTimeout(800);
    let cheias = await caixas.evaluateAll((L) => L.map((e) => e.value).join("").length).catch(() => 0);
    if (cheias < codigo.length && n >= codigo.length) {   // não pulou sozinha: preenche caixa por caixa
      for (let i = 0; i < codigo.length; i++) { await caixas.nth(i).click(); await caixas.nth(i).press("Backspace").catch(() => {}); await pagina.keyboard.type(codigo[i], { delay: 100 }); }
      cheias = await caixas.evaluateAll((L) => L.map((e) => e.value).join("").length).catch(() => 0);
    }
    log(`Dígitos nas caixas: ${cheias} de ${codigo.length}.`);
    await pagina.waitForTimeout(2500);
    if (/\/login/i.test(new URL(pagina.url()).pathname)) {
      const bs = pagina.getByRole("button", { name: /fazer login|confirmar|verificar|validar|entrar|continuar/i });
      const nb = await bs.count(); let clicou = false;
      for (let i = 0; i < nb && !clicou; i++) { const b = bs.nth(i); if (await b.isVisible().catch(() => false)) { log("Botão:", (await b.innerText().catch(() => "")).trim().slice(0, 30), "· habilitado:", await b.isEnabled().catch(() => "?")); await b.click().catch((e) => log("clique falhou:", e.message.slice(0, 80))); clicou = true; } }
      if (!clicou) await pagina.keyboard.press("Enter");
    }
    await pagina.waitForTimeout(4000);
    log("Chamadas depois do código:", vistas.join(" | ") || "(nenhuma)");
    await pagina.waitForURL((u) => !/\/login/i.test(u.pathname), { timeout: 45000 }).catch(() => {});
    if (/\/login/i.test(new URL(pagina.url()).pathname)) {
      const aviso = await pagina.evaluate(() => [...document.querySelectorAll("[class*=error i], [class*=alert i], [class*=invalid i], [role=alert], small, p, span")].map((e) => (e.innerText || "").trim()).filter((t) => t && t.length < 120 && /c[oó]digo|inv[aá]lid|expir|incorret|tente/i.test(t)).slice(0, 4).join(" | ")).catch(() => "");
      log("Mensagem da Intelipost:", aviso || "(nenhuma)");
      await esqueleto("Depois de digitar o código");
      await gravarEstado("intelipost", { tipo: "erro", titulo: "A Intelipost não aceitou o código.", msg: "Use sempre o código do e-mail mais recente e digite logo que a caixa aparecer (o código vence rápido). Mande o pedido de novo para o robô pedir outro código." });
      throw new Error("A Intelipost não aceitou o código de verificação.");
    }
    log("Código aceito.");
  }
  await guardarSessao();
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

// abre uma tela da Intelipost que tem a caixa "Digite seus pedidos". Se a caixa não aparecer, diz o porquê no registro
// (tela de login / sessão expirada → erro com "expirou", para o robô entrar de novo) e tenta recarregar 1x.
async function caixaPedidos(caminho) {
  for (let tent = 1; tent <= 2; tent++) {
    await pagina.goto(BASE + caminho, { waitUntil: "domcontentloaded" }).catch(() => {});
    const caixa = pagina.getByPlaceholder(/digite seus pedidos/i).first();
    if (await caixa.waitFor({ timeout: 40000 }).then(() => true).catch(() => false)) return caixa;
    const p = (() => { try { return new URL(pagina.url()).pathname; } catch (_) { return "?"; } })();
    const exp = await sessaoExpirou(pagina), login = /login|auth|signin/i.test(p) || (await pagina.locator("input[type=password]:visible").count().catch(() => 0)) > 0;
    const tit = await pagina.evaluate(() => [...document.querySelectorAll("h1,h2,h3,.modal-title,[role=dialog] *")].map((e) => e.textContent.trim()).filter((t) => t && t.length < 60).slice(0, 6).join(" | ")).catch(() => "");
    log(`Tela ${p} sem a caixa de pedidos (tentativa ${tent}) · login ${login ? "sim" : "não"} · sessão expirada ${exp ? "sim" : "não"} · títulos: ${mascara(tit).slice(0, 200)}`);
    if (exp || login) throw new Error("A sessão da Intelipost expirou (a tela de busca pediu login).");
  }
  throw new Error(`A tela ${caminho} da Intelipost não mostrou a caixa "Digite seus pedidos".`);
}

// abre o pedido pela "Busca por Lote" (a Gestão de Pedidos tem filtro de data e esconde pedido antigo).
// Clicar no pedido da lista abre a tela dele em ABA NOVA. Essa tela (/ng#/order-number/) nunca "termina"
// de carregar: espera o CAMPO aparecer, não a página.
async function abrirPedido(pedido, olhar, soAbrir, aceitarEntregue) {
  const caixa = await caixaPedidos("/order/transactions-batch");
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
  if (fechado && !(aceitarEntregue && /entregue/i.test(fechado))) { if (olhar) log(`O pedido está ${fechado} na Intelipost.`); if (aba) await aba.close(); throw new Error(`O pedido já está ${fechado.toLowerCase()} na Intelipost: não dá para mudar a previsão.`); }
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
  const passo = async (nome, fn) => { try { await fn(); if (olhar) log("  ok:", nome); } catch (e) { if (await sessaoExpirou(p)) { const x = new Error("A sessão da Intelipost expirou (240 min sem uso)."); x.sessao = true; throw x; } if (olhar) { log("  falhou:", nome, "-", e.message.split("\n")[0]); log("  janela aberta:", (await p.locator(".modal.is-active, .dialog.is-active").first().innerText({ timeout: 3000 }).catch(() => "nenhuma")).replace(/\s+/g, " ").replace(/\d{5,}/g, "#").slice(0, 300)); log("  por quê:", (e.message.split("\n").filter((l) => /intercept|not visible|not enabled|not stable|outside|waiting for/i.test(l)).slice(0, 4).join(" | ") || "-").replace(/\d{5,}/g, "#").slice(0, 500)); await camposDetalhe(p, "Na hora do erro (" + nome + ")"); } throw new Error(`Simulação de cotação: não consegui "${nome}" (${e.message.split("\n")[0].slice(0, 160)})`); } };
  await p.bringToFront();
  await p.goto(BASE + "/quote/freight-quote", { waitUntil: "domcontentloaded" });
  await p.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await passo("abrir a aba Simulação de cotação", async () => { await p.getByText(/^\s*Simulação de cotação\s*$/i).first().click(); await p.waitForTimeout(3500); });
  await passo("marcar Sim em ignorar regras", async () => {
    // o menor bloco com "ignorar regras" e uma chave (sem pegar o de "modo de validação"); clica no rótulo da chave (Buefy)
    const bloco = p.locator("xpath=(//*[contains(normalize-space(.),'ignorar regras') and .//input[@type='checkbox'] and not(.//*[contains(normalize-space(.),'modo de valida')])])[last()]").first();
    await bloco.waitFor({ timeout: 15000 });
    const caixa = bloco.locator("input[type=checkbox]").first();
    const querSim = process.env.IGNORAR_REGRAS !== "nao";
    const tentativas = [() => bloco.locator("label.switch").first().evaluate((e) => e.click()), () => caixa.evaluate((e) => e.click()), () => bloco.locator("label.switch, label").first().click({ timeout: 5000 }), () => bloco.locator("span.check").first().click({ force: true, timeout: 5000 }), () => caixa.click({ force: true, timeout: 5000 })];
    for (const t of tentativas) {
      if ((await caixa.isChecked()) === querSim) break;
      await t().catch((e) => { if (olhar) log("    clique falhou:", e.message.split("\n")[0].slice(0, 120)); }); await p.waitForTimeout(1500);
      if (olhar) log("    chave agora:", await caixa.isChecked().catch(() => "?"), "· url:", new URL(p.url()).pathname);
    }
    if ((await caixa.isChecked()) !== querSim) throw new Error("a chave não mudou");
  });
  const destino = p.locator("input[placeholder*='cep de destino' i]:visible").first();
  if (!cep) cep = await p.locator("xpath=//*[starts-with(normalize-space(text()),'Cep Origem')]/following::input[1] >> visible=true").first().inputValue();   // teste: usa o CEP da própria loja
  await passo("preencher o CEP de destino", async () => { await destino.waitFor({ state: "visible", timeout: 30000 }); await destino.scrollIntoViewIfNeeded().catch(() => {}); await destino.click({ force: true }); await destino.fill(""); await p.keyboard.type(String(cep).replace(/\D/g, ""), { delay: 40 }); await destino.press("Tab");
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
    // marca TODAS as tabelas da seção "Vigente" do método (algumas transportadoras têm uma tabela por região)
    const marcar = await p.evaluate(() => {
      const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
      const titulos = [...document.querySelectorAll("body *")].filter((e) => vis(e) && e.children.length === 0 && /^(Vigente|Rascunho|Vencid[ao]s?|Futur[ao]s?|Inativ[ao]s?)$/i.test((e.textContent || "").trim()));
      const caixas = [...document.querySelectorAll("input[type=checkbox]")].filter(vis);
      const lista = [];
      caixas.forEach((c, i) => {
        let sec = null;
        for (const t of titulos) if (t.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING) sec = t.textContent.trim();
        if (sec && /^vigente$/i.test(sec)) lista.push(i);
      });
      return { lista, titulos: titulos.map((t) => t.textContent.trim()) };
    });
    if (olhar) log("  seções na lista de tabelas:", marcar.titulos.join(" / "), "· vigentes:", marcar.lista.length);
    if (!marcar.lista.length) throw new Error("o método não tem tabela Vigente");
    const caixasVis = p.locator("input[type=checkbox]:visible");
    for (const i of marcar.lista) { const c = caixasVis.nth(i); if (!(await c.isChecked())) await c.click({ force: true }); }
    const fechar = p.getByRole("button", { name: /^\s*Fechar\s*$/i }).last();
    if (await fechar.count()) await fechar.click();
  });
  // o campo tem máscara de centavos: digitar "100" vira 1,00. Peso PESO_SIMULACAO kg (algumas tabelas recusam 0,01 kg).
  const PESO = String(process.env.PESO_SIMULACAO || "1");
  await passo("pôr peso, medidas e valor", async () => {
    const V = (process.env.VOL_SIMULACAO || `${PESO},1,1,1,1`).split(",");   // peso, altura, comprimento, largura, valor
    for (const [i, r] of ["Peso", "Altura", "Comprimento", "Largura", "Valor Nota Fiscal"].entries()) {
      const c = p.locator(`xpath=//*[starts-with(normalize-space(text()),'${r}')]/following::input[1] >> visible=true`).last();
      await c.click(); await c.fill(""); await p.keyboard.type(String(Math.round(Number(V[i]) * 100)));
    }
  });
  let prazo = null;
  await passo("Calcular e ler o prazo", async () => {
    if (olhar) {
      const v = await p.evaluate(() => [...document.querySelectorAll("input[type=text]")].filter((e) => e.getBoundingClientRect().width > 0).map((e) => e.value).filter((x) => !/\d{5}/.test(x)).join(" | "));
      log("  valores dos campos de volume:", v);
    }
    // a resposta da cotação vem do graphql (quoteFreightVolume): lê o prazo direto dela
    const resp = p.waitForResponse(async (r) => /graphql\.intelipost/i.test(r.url()) && (await r.text().catch(() => "")).includes("quoteFreightVolume"), { timeout: 60000 });
    await p.getByRole("button", { name: /^\s*Calcular\s*$/i }).first().click();
    const rr = await resp;
    const corpo = await rr.json();
    if (olhar) log("  tabelas (contract_ids):", (((rr.request().postData() || "").match(/"contract_ids":\[([^\]]*)\]/) || [])[1] || "").replace(/\d/g, (d) => d + "·"), "· ignorar regras:", ((rr.request().postData() || "").match(/"skip_quote_rules":(\w+)/) || [])[1]);
    if (olhar) log("  pedido da simulação:", mascara((rr.request().postData() || "").split(String(cep)).join("<cep>")).replace(/\\n/g, " ").replace(/\s+/g, " ").slice(0, 900));
    const q = corpo && corpo.data && corpo.data.quoteFreightVolume;
    const ms = (q && (q.delivery_methods || (q.logistic_provider && q.logistic_provider.delivery_methods))) || [];   // a resposta traz os métodos dentro de logistic_provider
    if (!ms.length) {
      const exc = (q && q.excluded_methods) || [];
      if (!q || olhar) log("  resposta da simulação:", JSON.stringify(corpo).replace(/\d{5,}/g, "#####").slice(0, 300));
      else log("  simulação voltou vazia. Chaves:", Object.keys(q).join(", "));
      if (exc.length) log("  métodos excluídos na simulação:", JSON.stringify(exc).slice(0, 400));
      const msg = (corpo.errors && corpo.errors[0] && corpo.errors[0].message) || (exc[0] && (exc[0].reason || exc[0].message || exc[0].description)) || "sem opção de entrega";
      throw new Error(`a Intelipost não achou frete para esse CEP com ${metodo} (${msg.slice(0, 120)})`);
    }
    if (olhar) ms.forEach((m) => log("  opção de envio:", m.name || m.description, "->", m.delivery_estimate_business_days, "dias úteis · campos:", Object.keys(m).filter((k) => /estimat|days|prazo/i.test(k)).map((k) => k + "=" + m[k]).join(", ")));
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
async function diagStatus() {   // confere, sem salvar nada, como ficou o pedido da última troca com erro
  const t = await ultimaTrocaComErro();
  if (!t) { log("Nenhuma troca com erro."); return; }
  const { tela, aba } = await abrirPedido(t.pedido, false, true);
  await tela.waitForTimeout(3000);
  const r = await tela.evaluate(() => { const x = document.body.innerText; return {
    s920: /\b920\b|nova nota fiscal/i.test(x), troca: /troca de notas/i.test(x), metodo: (x.match(/M[eé]todo de entrega:\s*([^\n]+)/) || [])[1] || "?",
    prev: /Entrega prev\.:\s*\d{2}\/\d{2}\/\d{4}\s*23:59/.test(x), cab: (x.match(/Pedido:[^(]{0,80}\(\s*([^)]+)\)/) || [])[1] || "?" }; });
  log("Tipo do ticket no painel:", t.tipo || "?", "· passos gravados na última passagem:", JSON.stringify(t.robo_passos || {}).replace(/"nova_data":"[^"]+",?/, ""), "· começou:", t.robo_iniciado_em);
  log(`Tela do pedido: status ${r.cab} · método ${r.metodo} · Entrega prev. 23:59: ${r.prev ? "sim" : "não"} · aparece 920/nova nota: ${r.s920 ? "sim" : "não"} · aparece "Troca de notas": ${r.troca ? "sim" : "não"}`);
  const vols = await tela.locator("[ng-click^='edit_volume_modal']").count();
  log("Volumes:", vols);
  if (aba) await aba.close();
}
async function diagData() {   // por que a Entrega prev. não mudou: abre o pedido do ticket, tenta salvar a data e mostra o que a Intelipost respondeu
  const t = await trocaDoTicket(process.env.TICKET || "");
  if (!t) { log("Ticket não encontrado na troca de notas."); return; }
  const nova = (t.robo_passos || {}).nova_data;
  log("Tipo:", t.tipo, "· status no painel:", t.robo_status, "· tem nova data gravada:", nova ? "sim" : "não");
  const { tela, aba } = await abrirPedido(t.pedido, false, true, true);
  await tela.waitForTimeout(3000);
  const ler = () => tela.evaluate(() => { const x = document.body.innerText; return {
    cab: (x.match(/Pedido:[^(]{0,80}\(\s*([^)]+)\)/) || [])[1] || "?",
    prev: (x.match(/Entrega prev\.:\s*([^\n]{0,25})/) || [])[1] || "?",
    links: [...document.querySelectorAll("a[href]")].map((a) => a.href).filter((h) => /rastre|track|status|onde/i.test(h)).map((h) => { try { const u = new URL(h); return u.host + u.pathname.replace(/[^/]{5,}/g, "*"); } catch { return "?"; } }) }; });
  const a = await ler();
  log(`Antes: status ${a.cab} · Entrega prev. ${a.prev} · links de rastreio: ${a.links.join(" | ") || "nenhum"}`);
  log("Página de rastreio abre e mostra o histórico:", await printRastreio(tela, "/tmp/rastreio.png").catch((e) => "não: " + mascara(e.message.split("\n")[0])));
  log("Botões/links com rastreio:", JSON.stringify(await tela.evaluate(() => [...document.querySelectorAll("a,button")].map((e) => (e.innerText || "").trim()).filter((x) => /rastre|track/i.test(x)).slice(0, 10))));
  if (!nova) { if (aba) await aba.close(); return; }
  const respostas = [];
  tela.on("response", (r) => { if (["PUT", "POST", "PATCH"].includes(r.request().method())) respostas.push(`${r.request().method()} ${mascara(new URL(r.url()).host + new URL(r.url()).pathname)} ${r.status()}`); });
  await tela.locator("a[ng-click^='edit_estimated_delivery_date']").first().click();
  const campo = tela.locator("input#estimated_delivery_date").first();
  const abriu = await campo.waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
  log("Campo de data abriu:", abriu ? "sim" : "não");
  if (abriu) {
    await campo.fill(`${nova}T23:59`);
    const bt = campo.locator("xpath=ancestor::form[1]//button[@type='submit']").first();
    log("Botão salvar:", (await bt.innerText().catch(() => "?")).trim(), "· visível:", await bt.isVisible().catch(() => false));
    await bt.click();
    await tela.waitForTimeout(8000);
    log("Avisos na tela:", JSON.stringify(await tela.evaluate(() => [...document.querySelectorAll(".toast,.alert,.notification,[class*=toast],[class*=alert],.sweet-alert,.swal2-popup")].map((e) => e.innerText.trim()).filter(Boolean).slice(0, 5))));
  }
  log("Respostas de gravação:", respostas.length ? respostas.join(" | ") : "nenhuma");
  await recarregar(tela);
  const d = await ler();
  log(`Depois: Entrega prev. ${d.prev} · mudou: ${d.prev !== a.prev ? "sim" : "não"}`);
  if (aba) await aba.close();
}
async function diagCep() {   // por que a simulação volta vazia: refaz a da última troca com erro, mostrando cada passo
  const controle = async (q) => { try { log(`== controle (CEP público SP, Transiga) ${q}: prazo ${await simularPrazo("01310100", "Transiga Standard", true)}`); } catch (e) { log(`== controle ${q}:`, e.message.split("\n")[0]); } };
  const modo = await pagina.evaluate(() => { const t = document.body.innerText; const i = t.search(/\bLive\b/); return i >= 0 ? t.slice(i, i + 20).replace(/\s+/g, " ") : "não achei"; });
  log("Chave Live/Teste:", JSON.stringify(await pagina.evaluate(() => { const e = [...document.querySelectorAll("body *")].filter((x) => x.children.length < 6 && /^\s*Live\s*Teste/i.test(x.innerText || "")).pop();
    if (!e) return null; return { html: e.outerHTML.replace(/\d{5,}/g, "#").slice(0, 700) }; })));
  log("Topo (Live/Teste):", modo, "· chaves marcadas no topo:", await pagina.evaluate(() => [...document.querySelectorAll("header input[type=checkbox], nav input[type=checkbox]")].map((e) => e.checked).join(",")));
  await controle("logo depois do login");
  const t = process.env.TICKET ? await trocaDoTicket(process.env.TICKET) : await ultimaTrocaComErro();
  if (t && process.env.METODO) t.robo_metodo = process.env.METODO;
  log("Método do ticket:", t && t.robo_metodo);
  if (!t) { log("Nenhuma troca com erro."); return; }
  { const { aba } = await abrirPedido(t.pedido, false, true, true); if (aba) await aba.close(); }
  await controle("depois de abrir um pedido");
  // CEP na Busca por Lote (linha do pedido) — compara com o do quadro Destinatário, sem mostrar
  await pagina.goto(BASE + "/order/transactions-batch", { waitUntil: "domcontentloaded" });
  const cx = pagina.getByPlaceholder(/digite seus pedidos/i).first(); await cx.waitFor({ timeout: 45000 });
  await pagina.locator("select").first().selectOption({ label: "Pedido" }).catch(() => {});
  await cx.fill(t.pedido); await pagina.getByRole("button", { name: /^\s*buscar\s*$/i }).first().click();
  await pagina.locator("table tbody tr").first().waitFor({ timeout: 45000 });
  const lote = await pagina.evaluate(() => {
    const th = [...document.querySelectorAll("table thead th")].map((x) => x.innerText.trim());
    const tr = document.querySelector("table tbody tr"); const td = tr ? [...tr.querySelectorAll("td")].map((x) => x.innerText.trim()) : [];
    const i = th.findIndex((x) => /cep/i.test(x));
    const ceps = td.join(" ").match(/\d{5}-?\d{3}/g) || [];
    return { th, cep: i >= 0 ? (td[i] || "").replace(/\D/g, "") : "", qtd: ceps.length, todos: ceps.map((c) => c.replace(/\D/g, "")) };
  });
  log("Busca por Lote · colunas:", lote.th.join(" / "), `· coluna CEP ${lote.cep ? "com valor" : "não achei"} · CEPs na linha: ${lote.qtd}`);
  const { tela, aba } = await abrirPedido(t.pedido, false, true, true);
  const info = await tela.evaluate(() => { const txt = document.body.innerText; const m = txt.match(/Destinat[aá]rio[\s\S]{0,2000}?CEP:\s*([^\n]{0,20})/i); return { bruto: m ? m[1] : "", uf: (txt.match(/Destinat[aá]rio[\s\S]{0,2500}?Estado:\s*([A-Z]{2})/i) || [])[1] || "?" }; });
  if (aba) await aba.close();
  const cep = info.bruto.replace(/\D/g, "");
  log(`CEP do Destinatário ${lote.todos.includes(info.bruto.replace(/\D/g, "")) || lote.cep === info.bruto.replace(/\D/g, "") ? "IGUAL" : "DIFERENTE"} ao da Busca por Lote`);
  const cepLote = lote.cep || lote.todos.find((c) => c !== info.bruto.replace(/\D/g, "") && c[0] !== "9");
  if (cepLote && cepLote !== info.bruto.replace(/\D/g, "")) {
    process.env.VOL_SIMULACAO = "1,1,1,1,1";
    try { log(`== com o CEP da Busca por Lote: prazo ${await simularPrazo(cepLote, t.robo_metodo, true)}`); } catch (e) { log("== com o CEP da Busca por Lote:", e.message.split("\n")[0]); }
    delete process.env.VOL_SIMULACAO; return;
  }
  log(`CEP: texto com ${info.bruto.length} letras, ${cep.length} dígitos, começa com ${cep.slice(0, 1)} · UF ${info.uf} · método ${t.robo_metodo}`);
  for (const [peso, ign] of [["25,0.11,0.01,0.01,0.01", "sim"]]) {
    process.env.VOL_SIMULACAO = peso; process.env.IGNORAR_REGRAS = ign;
    try { log(`== ${t.robo_metodo} ${peso} kg, ignorar regras ${ign}: prazo ${await simularPrazo(cep, t.robo_metodo, true)}`); } catch (e) { log(`== ${t.robo_metodo} ${peso} kg, ignorar regras ${ign}:`, e.message.split("\n")[0]); }
  }
  delete process.env.VOL_SIMULACAO; delete process.env.IGNORAR_REGRAS;
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
const SALVOU = (r) => ["PUT", "POST", "PATCH"].includes(r.request().method()) && /intelipost\.com\.br/i.test(r.url()) && !/jserrors|kissmetrics|analytics|hotjar|segment|nr-data|newrelic|sentry|intercom/i.test(r.url());
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

async function printRastreio(tela, arquivo) {   // print da página pública de rastreio (Status de Rastreamento), como a Logística mostra ao cliente
  const href = await tela.evaluate(() => (([...document.querySelectorAll("a[href]")].find((a) => /ondeestameupedido/i.test(a.href)) || {}).href) || "");
  if (!href) return false;
  const p = await ctx.newPage();
  try {
    await p.setViewportSize({ width: 700, height: 1000 });
    await p.goto(href, { waitUntil: "domcontentloaded", timeout: 60000 });
    await p.getByText(/hist[oó]rico completo do pedido/i).first().waitFor({ timeout: 45000 });
    await p.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await p.getByText(/hist[oó]rico completo do pedido/i).first().click().catch(() => {});   // abre o histórico
    await p.waitForTimeout(2500);
    await p.screenshot({ path: arquivo, fullPage: true });
    return true;
  } finally { await p.close().catch(() => {}); }
}
// NF original (Nota ticket) de série 4: a Intelipost não reconhece -> não altera nada nela; só o print do rastreio para o ticket
const serie4 = (job) => /-\s*0*4\s*$/.test(String(job.nf_ticket || ""));
async function soPrint(job) {
  const passos = { serie4: true, 1: true, 2: true, 3: true, 4: true, 5: true };
  const print = `/tmp/pedido-${Date.now()}.png`;
  let aberto = null;
  try {
    aberto = await abrirPedido(job.pedido, false, true, true);
    passos.print_rastreio = await printRastreio(aberto.tela, print).catch(() => false);
    if (!passos.print_rastreio) await aberto.tela.screenshot({ path: print, fullPage: true });
    return { passos, prazo: null, nova: null, print };
  } catch (e) { log("Série 4: não consegui o print na Intelipost -", mascara(e.message.split("\n")[0])); return { passos, prazo: null, nova: null, print: null };
  } finally { if (aberto && aberto.aba) await aberto.aba.close().catch(() => {}); }
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
  const { tela, aba } = await abrirPedido(job.pedido, false, true, parcial);   // parcial entregue: só a previsão
  let etapa = "abrir o pedido";
  let soData = false;
  try {
    // status do pedido e CEP do destinatário (o CEP só é usado na simulação; não vai para registro nem painel)
    const fechado = await tela.evaluate(() => { const m = document.body.innerText.match(/Pedido:[^(]{0,80}\(\s*(Entregue|Cancelado)\s*\)/i); return m ? m[1] : ""; });
    if (fechado && !(parcial && /entregue/i.test(fechado))) throw new Error(`O pedido está ${fechado.toLowerCase()} na Intelipost.`);
    // regra da Logística: reposição PARCIAL com pedido ENTREGUE -> altera SOMENTE a previsão de entrega
    // (a Intelipost não deixa mudar o status; transportadora e volumes também ficam como estão)
    if (fechado) { soData = true; passos.so_previsao = true; passos[1] = true; passos[5] = true; }   // 1 e 5 não se aplicam
    const cep = await tela.evaluate(() => { const m = document.body.innerText.match(/Destinat[aá]rio[\s\S]{0,2000}?CEP:\s*([\d.\-]{8,10})/i); return m ? m[1].replace(/\D/g, "") : ""; });
    if (cep.length !== 8) throw new Error("Não achei o CEP do destinatário na tela do pedido.");
    if (job.ticket === "diag") log(`CEP lido: ${cep.length} dígitos, começa com ${cep[0]} (a loja começa com 9) · CEPs na tela: ${await tela.evaluate(() => (document.body.innerText.match(/CEP:/gi) || []).length)}`);
    const nVol = await tela.locator("[ng-click^='edit_volume_modal']").count();
    if (!nVol && !parcial) throw new Error("Não achei os volumes do pedido (botão Editar).");

    // 2) simulação de cotação (na aba principal) -> prazo em dias úteis
    etapa = "simulação de cotação";
    let prazo;
    if (job.robo_prazo_manual > 0) { prazo = Number(job.robo_prazo_manual); passos.prazo_manual = true; }   // a Logística fez a simulação na mão
    else try { prazo = await simularPrazo(cep, job.robo_metodo, false); }
    catch (e) { if (job.ticket !== "diag") throw e; log("Diagnóstico: simulação sem frete para esse pedido; sigo com prazo 5 só para testar os outros passos."); prazo = 5; }
    if (!(prazo > 0 && prazo <= 60)) throw new Error(`Prazo estranho na simulação (${prazo}).`);
    const nova = somaDiasUteis(hojeBR(), prazo);
    passos[2] = true; passos.prazo = prazo; passos.volumes = nVol;

    // 1) transportadora e método de entrega
    etapa = "trocar a transportadora";
    if (!soData) {
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

    }
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

    // 5) status: Entregas > Alterar Pedidos > Micro (não no parcial entregue)
    etapa = "mudar o status (Alterar Pedidos)";
    if (!soData) {
    await pagina.bringToFront();
    const caixa = await caixaPedidos("/order/change-order");
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
      const r = await resp.catch(() => null);
      if (r && r.status() >= 400) throw new Error(`a Intelipost recusou (código ${r.status()})`);
      if (!r) {   // sem resposta reconhecida: confere no histórico do pedido se o evento entrou
        await recarregar(tela);
        const ok = await tela.evaluate(() => /Troca de notas/i.test(document.body.innerText) && /nova nota fiscal/i.test(document.body.innerText));
        if (!ok) throw new Error("cliquei em Alterar, mas o status não apareceu no pedido");
      }
    }
    passos[5] = true;
    }
    // print da tela do pedido (vai só para dentro do ticket; o arquivo fica no runner e some no fim)
    await tela.bringToFront(); await recarregar(tela).catch(() => {});
    const print = `/tmp/pedido-${Date.now()}.png`;
    const rastreio = await printRastreio(tela, print).catch(() => false);
    if (!rastreio) await tela.screenshot({ path: print, fullPage: true });   // sem a página de rastreio: vai a tela do pedido
    passos.print_rastreio = rastreio;
    return { passos, prazo, nova, print };
  } catch (e) {
    e.message = `Parei em "${etapa}": ${e.message.split("\n")[0]}`; e.passos = passos; throw e;
  } finally { if (aba) await aba.close().catch(() => {}); }
}

// diagnóstico da tela de Simulação de cotação e da Busca por Lote (só olha; mascarado)
// ===== Baixa ENTREGUE na Intelipost (Brenda 24/11) =====
// Fila Aguardando entrega: reposição TOTAL que o robô deu baixa (nova NF entregue no rastreio) → se o pedido ainda não está
// Entregue na Intelipost: Entregas › Alterar Pedidos › Pedido › Alterar por Macro › Status Entregue, com a data da entrega → Alterar Status.
// real=false: preenche tudo e NÃO clica em Alterar Status. Registro: só contagens.
const BAIXA_ENTREGUE_AUTO = false;   // liga depois do 1º teste real aprovado pela Brenda
async function baixaEntregueIP(real, limite) {
  const L = await chamar(`aguardando_entrega?select=ticket,pedido,nf_original,tipo_reposicao,data_entrega,ip_entregue_status&baixa_status=eq.feita&situacao=eq.entregue&pedido=not.is.null&or=(ip_entregue_status.is.null,ip_entregue_status.eq.erro)&order=consultado_em.desc&limit=200`)
    .catch((e) => { log(/ip_entregue/i.test(e.message || "") ? "baixa-entregue: rode a parte 71 no Supabase." : "baixa-entregue: " + String(e.message).slice(0, 120)); return []; });
  // só reposição TOTAL (a parcial não fecha o pedido); confirma pela troca de notas quando a planilha não diz
  const tn = new Map((await chamar(`troca_notas?select=ticket,tipo&ticket=in.(${L.map((x) => `"${x.ticket}"`).join(",") || '""'})`).catch(() => [])).map((t) => [String(t.ticket), String(t.tipo || "")]));
  const tot = (x) => /total/i.test(x.tipo_reposicao || "") || /total/i.test(tn.get(String(x.ticket)) || "");
  const A = L.filter(tot).slice(0, limite || 50);
  const tipos = {}; L.forEach((x) => { const k = `${x.tipo_reposicao || "(vazio)"} / troca ${tn.get(String(x.ticket)) || "-"}`; tipos[k] = (tipos[k] || 0) + 1; });
  log("baixa-entregue: tipos " + Object.entries(tipos).map(([k, v]) => `${k}: ${v}`).join(" · "));
  log(`baixa-entregue: ${L.length} baixa(s) feitas na fila · ${A.length} de reposição total para conferir na Intelipost · ${real ? "DE VERDADE" : "TESTE (não clica em Alterar Status)"}`);
  const cont = {}; const soma = (k) => (cont[k] = (cont[k] || 0) + 1);
  const grava = (x, st, msg) => chamar(`aguardando_entrega?ticket=eq.${encodeURIComponent(x.ticket)}`, "PATCH", { ip_entregue_status: st, ip_entregue_msg: msg, ip_entregue_em: new Date().toISOString() }).catch(() => {});
  const sel = (re) => pagina.locator("select:visible").filter({ has: pagina.locator("option", { hasText: re }) }).first();
  const pick = async (re, nome) => { const sx = sel(re); const l = (await sx.locator("option", { hasText: re }).first().innerText().catch(() => "")).trim(); if (!l) throw new Error(`não achei a opção ${nome}`); await sx.selectOption({ label: l }); await pagina.waitForTimeout(1500); };
  const buscar = async (pedido, por = "Pedido") => {
    const caixa = await caixaPedidos("/order/change-order");
    await pagina.locator("select:visible").first().selectOption({ label: por });
    await caixa.fill(pedido);
    await pagina.getByRole("button", { name: /^\s*buscar\s*$/i }).first().click();
    await pagina.locator("table tbody tr").first().waitFor({ timeout: 45000 }).catch(() => {});
    await pagina.waitForTimeout(2500);
    const rows = await pagina.evaluate(() => [...document.querySelectorAll("table tbody tr")].map((r) => r.innerText.replace(/\s+/g, " ")).filter((t) => t.trim() && !/nenhum/i.test(t)));
    return rows;
  };
  // pedido na Intelipost: o da base pela NF original (ex.: SHOPEE + nº do marketplace); senão o pedido da planilha
  const nfK = (v) => String(v ?? "").trim().split("-").map((t) => t.trim().replace(/\.0+$/, "").replace(/^0+(?=\d)/, "")).join("-");
  const pedidoIP = async (x) => {
    if (x.nf_original) for (const nf of [...new Set([String(x.nf_original).trim(), nfK(x.nf_original)])]) { const b = (await chamar(`base_pedidos?select=pedido&nf=eq.${encodeURIComponent(nf)}&limit=1`).catch(() => []))[0]; if (b && b.pedido) return b.pedido; }
    const ped = String(x.pedido || "").trim();
    if (ped.length >= 8) { const b = await chamar(`base_pedidos?select=pedido&pedido=like.*${encodeURIComponent(ped)}&limit=2`).catch(() => []); if (b.length === 1) return b[0].pedido; }
    return ped;
  };
  for (const x of A) {
    try {
      const ped0 = x.pedido; x.pedido = await pedidoIP(x); log(`  pedido: ${x.pedido === ped0 ? "o da planilha" : "achado na base pela NF"} · ${String(x.pedido).length} caracteres`);
      let rows = await buscar(x.pedido), pelaNF = false;
      // não achou pelo pedido: procura pela NF original (número), só vale se vier 1 linha
      if (!rows.length && x.nf_original) { const n = nfK(x.nf_original).split("-")[0]; rows = await buscar(n, "Nota Fiscal"); pelaNF = true; log(`  pela NF: ${rows.length} linha(s)`); }
      if (pelaNF && rows.length === 1) x._porNF = nfK(x.nf_original).split("-")[0];
      if (rows.length !== 1) { soma(`busca trouxe ${rows.length} linhas`); await grava(x, "erro", `A busca do pedido trouxe ${rows.length} linhas (esperava 1): conferir à mão.`); continue; }
      if (/\bentregue\b/i.test(rows[0])) { soma("já estava entregue"); await grava(x, "ja_estava", "O pedido já estava Entregue na Intelipost."); continue; }
      if (/cancelad/i.test(rows[0])) { soma("cancelado na Intelipost"); await grava(x, "erro", "O pedido está Cancelado na Intelipost: conferir à mão."); continue; }
      await pagina.locator("table tbody tr input[type=checkbox]").first().click({ force: true }); await pagina.waitForTimeout(800);
      await pick(/^\s*Macro\s*$/, "Alterar por: Macro");
      await pick(/^\s*Entregue\s*$/, "Status Entregue");
      // data da alteração = data da entrega no rastreio (hora 12:00 quando não é hoje)
      if (x.data_entrega) {
        const dd = x.data_entrega.split("-").reverse().join("/");
        const campoD = pagina.locator("div.field, div.control").filter({ has: pagina.locator("label", { hasText: /Data da altera/i }) }).locator("input[type=text]").first();
        const dataIn = (await campoD.count()) ? campoD : pagina.locator("input.input[type=text]:visible").nth(1);
        await dataIn.click(); await dataIn.fill(dd); await dataIn.press("Enter").catch(() => {}); await pagina.keyboard.press("Escape").catch(() => {}); await pagina.waitForTimeout(600);
        const lido = await dataIn.inputValue();
        if (lido !== dd) throw new Error("o campo Data da alteração não aceitou a data da entrega");
        if (x.data_entrega !== hojeBR()) {
          const campoH = pagina.locator("div.field, div.control").filter({ has: pagina.locator("label", { hasText: /Hora da altera/i }) }).locator("input[type=text]").first();
          const horaIn = (await campoH.count()) ? campoH : pagina.locator("input.input[type=text]:visible").nth(2);
          await horaIn.click(); await horaIn.fill("12:00"); await horaIn.press("Enter").catch(() => {}); await pagina.keyboard.press("Escape").catch(() => {}); await pagina.waitForTimeout(600);
          if ((await horaIn.inputValue()) !== "12:00") throw new Error("o campo Hora da alteração não aceitou 12:00");
        }
      }
      const bt = pagina.getByRole("button", { name: /^\s*alterar status\s*$/i }).first();
      if (!(await bt.count())) throw new Error("não achei o botão Alterar Status");
      if (!real) { soma("teste ok (não salvou)"); await grava(x, null, null); continue; }
      await bt.click(); await pagina.waitForTimeout(1500);
      const conf = pagina.locator("[role=dialog]:visible, .modal:visible").getByRole("button", { name: /^\s*(confirmar|sim|ok|alterar|alterar status)\s*$/i }).first();
      if (await conf.count()) { await conf.click(); await pagina.waitForTimeout(2500); }
      await pagina.waitForTimeout(3000);
      const depois = x._porNF ? await buscar(x._porNF, "Nota Fiscal") : await buscar(x.pedido);
      if (depois.length === 1 && /\bentregue\b/i.test(depois[0])) { soma("alterado para Entregue"); await grava(x, "feito", `Status Entregue na Intelipost${x.data_entrega ? ` (data ${x.data_entrega.split("-").reverse().join("/")})` : ""}.`); }
      else { soma("cliquei mas não confirmou"); await grava(x, "conferir", "Cliquei em Alterar Status, mas a busca não mostrou Entregue: conferir na Intelipost."); }
    } catch (e) { soma("erro"); log("  erro: " + String(e.message).split("\n")[0].replace(/[A-Z0-9]{6,}/gi, "#").slice(0, 160)); await grava(x, "erro", String(e.message).split("\n")[0].slice(0, 200)); }
  }
  log("baixa-entregue: " + (Object.entries(cont).map(([k, v]) => `${k} ${v}`).join(" · ") || "nada"));
}

// Alterar Pedidos › status ENTREGUE (Brenda 24/11): só lista as opções de Macro/Micro/Evento para "Entregue". NÃO clica em Alterar.
async function diagEntregue() {
  const [t] = await chamar("troca_notas?select=pedido&robo_status=eq.feito&tipo=eq.TOTAL&pedido=not.is.null&order=robo_feito_em.desc&limit=1");
  if (!t) { log("diag-entregue: nenhuma troca total feita para usar de exemplo"); return; }
  const caixa = await caixaPedidos("/order/change-order");
  await pagina.locator("select:visible").first().selectOption({ label: "Pedido" });
  await caixa.fill(t.pedido);
  await pagina.getByRole("button", { name: /^\s*buscar\s*$/i }).first().click();
  await pagina.locator("table tbody tr").first().waitFor({ timeout: 45000 });
  const st = await pagina.evaluate(() => { const ths = [...document.querySelectorAll("table thead th")].map((e) => e.innerText.trim()); const i = ths.findIndex((h) => /status transportador/i.test(h)); const td = document.querySelector("table tbody tr")?.querySelectorAll("td")[i]; return { ths, st: td ? td.innerText.trim() : "?" }; });
  log(`diag-entregue: colunas ${st.ths.join(" | ")} · status transportador: ${st.st}`);
  const linha = await pagina.evaluate(() => { const tr = [...document.querySelectorAll("tr, [role=row]")].find((r) => /entregue|transito|trânsito|despachado/i.test(r.innerText)); return tr ? tr.innerText.replace(/\s+/g, " ").slice(0, 200) : "(nenhuma linha)"; });
  log("diag-entregue: linha do resultado (mascarada): " + linha.replace(/[A-Z0-9]{6,}/gi, "#"));
  await pagina.locator("table tbody tr input[type=checkbox]").first().click({ force: true }); await pagina.waitForTimeout(1000);
  const sel = (re) => pagina.locator("select:visible").filter({ has: pagina.locator("option", { hasText: re }) }).first();
  const pick = async (re, nome) => { const s = sel(re); const l = (await s.locator("option", { hasText: re }).first().innerText().catch(() => "")).trim(); if (!l) { log(`diag-entregue: não achei ${nome}`); return false; } await s.selectOption({ label: l }); await pagina.waitForTimeout(2500); log(`diag-entregue: escolhi ${nome}: ${l}`); return true; };
  if (await pick(/^\s*Macro\s*$/, "Alterar por: Macro") && await pick(/^\s*Entregue\s*$/, "Status Entregue")) {
    const ins = await pagina.evaluate(() => [...document.querySelectorAll("input,textarea,select")].filter((e) => e.getBoundingClientRect().width > 0)
      .map((e) => { let g = e.parentElement, t = ""; for (let i = 0; i < 5 && g && !t; i++, g = g.parentElement) { const l = g.querySelector("label"); t = l ? l.innerText.trim() : ""; }
        return `${e.tagName.toLowerCase()} type=${e.type} class=${String(e.className).slice(0, 60)} label=${t.slice(0, 40)} valor=${e.tagName === "INPUT" && e.type === "text" ? String(e.value).replace(/\d/g, "9").slice(0, 20) : ""} pai=${String(e.parentElement?.className || "").slice(0, 50)}`; }));
    ins.forEach((x) => log("  campo Entregue:", x.replace(/\d{5,}/g, "#")));
  }
  const botoes = await pagina.evaluate(() => [...new Set([...document.querySelectorAll("button, input[type=submit]")].filter((e) => e.getBoundingClientRect().width > 0).map((e) => (e.innerText || e.value || "").trim()).filter(Boolean))]);
  log("diag-entregue: botões " + botoes.join(" / ") + " (nada foi salvo)");
}
async function diagSim() {
  const p = pagina; const m = (t) => String(t || "").replace(/\d{5,}/g, "#");
  const ruins = []; p.on("response", (r) => { if (r.status() >= 400 && !/log|track|analytics|hotjar|segment|sentry/i.test(r.url())) ruins.push(r.status() + " " + new URL(r.url()).host + new URL(r.url()).pathname.replace(/\d+/g, "#").slice(0, 60)); });
  log("URL logo depois de entrar:", new URL(p.url()).pathname);
  await p.goto(BASE + "/quote/freight-quote", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(5000); log("respostas com erro ao abrir a cotação:", ruins.splice(0).slice(0, 8).join(" | ") || "nenhuma");
  await p.goto(BASE + "/order/transactions-batch", { waitUntil: "domcontentloaded" }); await p.waitForTimeout(5000);
  log("URL lote (antes de mexer na chave):", new URL(p.url()).pathname);
  await p.goto(BASE + "/quote/freight-quote", { waitUntil: "domcontentloaded" });
  await p.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  log("URL cotação:", new URL(p.url()).pathname);
  await p.getByText(/^\s*Simulação de cotação\s*$/i).first().click(); await p.waitForTimeout(3000);
  const info = await p.evaluate(() => {
    const t = [...document.querySelectorAll("body *")].find((e) => e.children.length === 0 && /ignorar regras/i.test(e.textContent || ""));
    if (!t) return { achou: false };
    let a = t; for (let k = 0; k < 4 && a.parentElement; k++) a = a.parentElement;
    const cb = a.querySelector("input[type=checkbox]");
    const r = cb ? cb.getBoundingClientRect() : null;
    return { achou: true, html: a.outerHTML.replace(/\s+/g, " ").slice(0, 1800), marcado: cb ? cb.checked : null, caixa: r ? [r.x, r.y, r.width, r.height].map(Math.round) : null };
  });
  log("Bloco ignorar regras:", m(JSON.stringify(info)));
  // tenta clicar no texto "Sim" e na bolinha pela posição
  const bloco = p.locator("xpath=(//*[contains(normalize-space(.),'ignorar regras') and .//input[@type='checkbox'] and not(.//*[contains(normalize-space(.),'modo de valida')])])[last()]").first();
  const cb = bloco.locator("input[type=checkbox]").first();
  log("antes:", await cb.isChecked().catch(() => "?"));
  for (const [nome, f] of [["label.switch", () => bloco.locator("label.switch").first().click()], ["span.check", () => bloco.locator("span.check").first().click()],
                           ["texto Sim", () => bloco.getByText(/^\s*Sim\s*$/).first().click()],
                           ["mouse no input", async () => { const b = await cb.boundingBox(); if (b) await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2); }]]) {
    await f().catch((e) => log("  ", nome, "erro", e.message.split("\n")[0].slice(0, 80)));
    await p.waitForTimeout(1200); log("  depois de", nome + ":", await cb.isChecked().catch(() => "?"));
  }
  log("respostas com erro ao mexer na chave:", ruins.splice(0).slice(0, 8).join(" | ") || "nenhuma");
  await p.goto(BASE + "/order/transactions-batch", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(6000);
  log("URL lote:", new URL(p.url()).pathname, "· campos:", m(JSON.stringify(await p.evaluate(() => [...document.querySelectorAll("input, textarea")].map((e) => `${e.tagName}:${e.type}:${e.placeholder || ""}`).slice(0, 15)))));
}

let ok = 0, erro = 0;
const andaIni = new Date().toISOString(), anda = MODO === "real";
if (anda) await gravarEstado("andamento:intelipost", { robo: "Nova data na Intelipost", rodando: true, inicio: andaIni }).catch(() => {});
let andaResumo = "";
try {
  const entrou = await entrar();
  if (MODO === "manter") { await gravarEstado("intelipost_manter", { em: new Date().toISOString(), ok: entrou !== false }).catch(() => {}); log(entrou !== false ? "Sessão da Intelipost mantida viva." : "Sessão não estava viva.");
    if (entrou !== false && BAIXA_ENTREGUE_AUTO) await baixaEntregueIP(true, 30).catch((e) => log("baixa-entregue: " + String(e.message).split("\n")[0].slice(0, 120))); }
  else if (MODO === "entregue-teste" || MODO === "entregue-real") await baixaEntregueIP(MODO === "entregue-real", Number(process.env.LIMITE || 0) || 1);
  else if (MODO === "diag-sim") await diagSim();
  else if (MODO === "diag-entregue") await diagEntregue();
  else if (MODO === "diag-troca") await diagTroca();
  else if (MODO === "diag-cep") await diagCep();
  else if (MODO === "diag-status") await diagStatus();
  else if (MODO === "diag-data") await diagData();
  else if (MODO === "diag-ticket") { const p = await entrarMulti360(ctx, log); const t = process.env.TICKET ? { ticket: process.env.TICKET } : await ultimaTrocaComErro(); if (t) { await olharTicket(p, t.ticket, log);
    const b = await ctx.newPage(); await b.setContent("<h1>teste do robô</h1>"); await b.screenshot({ path: "/tmp/teste.png" }); await b.close();
    log("Teste da caixinha (Cancelar no fim):", await fazerTicket(p, t.ticket, "/tmp/teste.png", false, log).catch((e) => "erro: " + e.message.split("\n")[0]));
    log("Fila no fim:", await p.evaluate(() => (document.body.innerText.match(/Atribu[ií]do Fila:\s*([^\n]+)/i) || [])[1] || "?")); } else log("Nenhuma troca para olhar."); }
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
    // vai pegando lotes até a fila acabar (máx. ~45 min); se sobrar, a rodada chama a próxima sozinha
    const ini = Date.now(); let sobrou = false;
    for (let lote = 1; ; lote++) {
      if (Date.now() - ini > 45 * 60e3) { sobrou = true; break; }
      const fila = await pegarIntelipost(LIMITE);
      if (!fila.length) break;
      log(`Lote ${lote}: ${fila.length} pedido(s) na passagem (${MODO}).`);
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
      if (MODO !== "real") break;   // dryrun devolve para pendente: um lote só
    }
    log(`Fim: ${ok} ${MODO === "real" ? "alterados" : "preenchidos sem salvar"}, ${erro} com problema.`);
    andaResumo = `${ok} alterados, ${erro} com problema` + (sobrou ? "; ainda tem pedido na fila, a próxima rodada já foi chamada" : "");
    if (sobrou && MODO === "real" && process.env.GH_TOKEN && process.env.GITHUB_REPOSITORY) {
      const r = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/robo-intelipost.yml/dispatches`, { method: "POST",
        headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" }, body: JSON.stringify({ ref: "main", inputs: { modo: "real" } }) }).catch(() => null);
      log(`Ainda tem pedido na fila: ${r && r.ok ? "chamei a próxima rodada" : "não consegui chamar a próxima rodada"}.`);
    }
    // troca de notas: cada ticket já diz se é teste ou real (quem pediu no painel escolheu)
    const trocas = await pegarTroca(20).catch((e) => { log("Troca de notas:", e.message.split("\n")[0]); return []; });
    if (trocas.length) log(`${trocas.length} troca(s) de nota na passagem.`);
    let tOk = 0, tErro = 0, multi = null;
    for (const job of trocas) {
      const modoJob = MODO === "real" ? job.robo_modo : "teste";   // dryrun nunca salva
      try {
        let r;
        try { r = serie4(job) ? await soPrint(job) : await fazerTroca({ ...job, robo_modo: modoJob }); }
        catch (e1) {
          if (!/expirou/i.test(e1.message)) throw e1;
          log("A sessão da Intelipost expirou no meio: vou fazer o login de novo (pode pedir o código no painel).");
          await ctx.clearCookies().catch(() => {}); await entrar(true);
          r = serie4(job) ? await soPrint(job) : await fazerTroca({ ...job, robo_modo: modoJob });
        }
        let msgTicket = "";
        try {   // etapas 6 e 7 no Multi360
          if (!multi) multi = await entrarMulti360(ctx, log);
          const t6 = await fazerTicket(multi, job.ticket, r.print, modoJob === "real", log);
          if (modoJob === "real") { r.passos[6] = true; r.passos[7] = true; }
          msgTicket = modoJob === "real" ? " Ticket: ação executada, fila Aguardando entrega." : " Ticket: caixinha preenchida e cancelada.";
          log(`Ticket: ${t6}.`);
        } catch (e2) { msgTicket = ` Ticket NÃO feito: ${e2.message.split("\n")[0].slice(0, 160)}`; log("Ticket:", e2.message.split("\n")[0]); }
        await resultadoTroca(job.ticket, modoJob === "real" ? "feito" : "testado", (modoJob === "real" ? (r.passos.serie4 ? "NF original série 4: nada alterado na Intelipost." : r.passos.so_previsao ? "Pedido Entregue (parcial): só a Entrega prev. foi alterada; transportadora e status ficam como estão." : "Feito na Intelipost.") : "Teste ok: tudo preenchido, nada salvo.") + msgTicket, r.passos, r.prazo, r.nova);
        tOk++; log(`Troca ${tOk + tErro}: ok (${modoJob}).`);
      } catch (e) {
        tErro++; log(`Troca ${tOk + tErro}: problema -`, e.message);
        await resultadoTroca(job.ticket, "erro", e.message.slice(0, 300), e.passos || {}, e.passos && e.passos.prazo || null, null).catch(() => {});
      }
    }
    if (trocas.length) log(`Troca de notas: ${tOk} ok, ${tErro} com problema.`);
  }
} catch (e) {
  log("Parei:", e.message); andaResumo = "Parou: " + mascara(String(e.message).split("\n")[0]).slice(0, 150);
} finally {
  await navegador.close();
  if (anda) await gravarEstado("andamento:intelipost", { robo: "Nova data na Intelipost", rodando: false, inicio: andaIni, fim: new Date().toISOString(), resumo: andaResumo }).catch(() => {});
}
