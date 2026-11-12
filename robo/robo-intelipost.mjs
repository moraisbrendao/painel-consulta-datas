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
import { entrarSupabase, pegarIntelipost, resultadoIntelipost, lerEstado, gravarEstado, umPedidoParaOlhar } from "./supa.mjs";

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
  // "Entrega prev.:" é um link (ng-click edit_estimated_delivery_date) que abre a edição da previsão do cliente
  const link = tela.locator("a[ng-click^='edit_estimated_delivery_date']").first();
  try { await link.waitFor({ timeout: 60000 }); }
  catch { if (olhar) await camposDeData(tela); if (aba) await aba.close(); throw new Error("A tela do pedido abriu, mas não achei o link da previsão de entrega."); }
  // pedido já entregue/cancelado: não mexe na previsão (avisa em vez de tentar)
  await tela.waitForFunction(() => /Pedido:[^(]{0,80}\(\s*\S/.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {});
  const fechado = await tela.evaluate(() => { const m = document.body.innerText.match(/Pedido:[^(]{0,80}\(\s*(Entregue|Cancelado)\s*\)/i); return m ? m[1] : ""; });
  if (olhar) log("Cabeçalho do pedido:", await tela.evaluate(() => (document.body.innerText.match(/Pedido:[\s\S]{0,60}/) || [""])[0].replace(/\s+/g, " ")));
  if (fechado) { if (olhar) log(`O pedido está ${fechado} na Intelipost.`); if (aba) await aba.close(); throw new Error(`O pedido já está ${fechado.toLowerCase()} na Intelipost: não dá para mudar a previsão.`); }
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
    const rot = (e) => { const l = (e.labels && e.labels[0]) || (e.id && document.querySelector(`label[for="${e.id}"]`)); if (l) return l.innerText.trim(); let g = e.parentElement; for (let i = 0; i < 3 && g; i++, g = g.parentElement) { const t = g.querySelector("label, .control-label"); if (t) return t.innerText.trim(); } return ""; };
    return [...document.querySelectorAll("input,select,textarea")].filter(vis).slice(0, 50).map((e) => {
      let ops = "";
      if (e.tagName === "SELECT") { const o = [...e.options].map((o) => o.text.trim()); ops = ` | ${o.length} opções: ` + (re ? o.filter((t) => re.test(t)) : o).slice(0, 25).join(" / "); }
      return `${e.tagName.toLowerCase()} | ${e.type || ""} | ng-model=${e.getAttribute("ng-model") || ""} | rótulo=${rot(e).replace(/\s+/g, " ").slice(0, 40)}${ops}`;
    });
  }, filtroOpcao || null);
  log(`== ${titulo} · campos`); r.forEach((x) => log("  campo:", x));
}
async function abrirEFechar(tela, alvo, titulo) {
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
  // fecha sem salvar: Cancelar/Fechar/X ou Esc
  const fechar = tela.locator(".modal:visible, [uib-modal-window]:visible, [role=dialog]:visible").locator("button, a").filter({ hasText: /^\s*(cancelar|fechar|voltar|×|x)\s*$/i }).first();
  if (await fechar.count()) {
    const txt = (await fechar.innerText().catch(() => "")).trim();
    if (!PROIBIDO.test(txt)) await fechar.click().catch(() => {});
  } else await tela.keyboard.press("Escape").catch(() => {});
  await tela.waitForTimeout(1500);
}
async function diagTroca() {
  // 1) menu: onde fica a Cotação de frete / Simulação
  await pagina.goto(BASE, { waitUntil: "domcontentloaded" });
  await pagina.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await pagina.waitForTimeout(3000);
  const links = await pagina.evaluate(() => [...new Set([...document.querySelectorAll("a[href]")].map((a) => `${(a.innerText || a.title || "").trim().replace(/\s+/g, " ").slice(0, 40)} -> ${a.getAttribute("href").slice(0, 80)}`))]
    .filter((t) => /cota|simul|frete|alterar|volume|transport|quote/i.test(t)).slice(0, 40));
  log("== Menu (links de cotação/simulação/alterar):"); links.forEach((l) => log("  link:", l));
  for (const caminho of ["/quote/freight-quote"]) {   // Cotação > Cotação de frete (é a "simulação" do passo a passo)
    try {
      await pagina.goto(caminho.startsWith("http") ? caminho : BASE + (caminho.startsWith("/") ? caminho : "/" + caminho), { waitUntil: "domcontentloaded" });
      await pagina.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
      await pagina.waitForTimeout(3000);
      await esqueleto("Cotação/Simulação (" + caminho.replace(/^https?:\/\/[^/]+/, "").slice(0, 60) + ")");
      await mapaTela(pagina, "Cotação/Simulação · ng-click");
      await camposDetalhe(pagina, "Cotação/Simulação");
    } catch (e) { log("Simulação:", e.message.split("\n")[0]); }
  }
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
    const botoes = await pagina.evaluate(() => [...new Set([...document.querySelectorAll("button, input[type=submit]")].filter((e) => e.getBoundingClientRect().width > 0).map((e) => (e.innerText || e.value || "").trim()).filter(Boolean))]);
    log("  botões:", botoes.join(" / "));
  } catch (e) { log("Alterar Pedidos:", e.message.split("\n")[0]); }
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
  }
} catch (e) {
  log("Parei:", e.message);
} finally {
  await navegador.close();
}
