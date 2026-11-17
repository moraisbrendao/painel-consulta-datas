// Diagnóstico do rastreio da Formato (transformato.com.br): login 1 vez só (segredos FORMATO_USUARIO/SENHA), Consulta NF e só estrutura mascarada — nunca dados de cliente.
import { chromium } from "playwright";
import { entrarSupabase, chamar } from "./supa.mjs";
const masc = (x) => String(x).replace(/\d{4,}/g, "#####").replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>");
const log = (...a) => console.log(...a.map(masc));
const letras = (t) => t.split(/\n+/).map((x) => x.trim()).filter(Boolean).map((x) => x.replace(/[A-Za-zÀ-ú]{3,}/g, (w) => /^(nota|fiscal|nf|cte|ct-e|data|entrega|entregue|previs|status|situa|ocorr|emiss|coleta|chegada|saida|saída|destino|origem|remetente|destinat|serie|série|transit|rota|baixa|pendente|aguard|em|de|da|do|para|consulta|listar|cliente|nenhum|encontrad|n[ãa]o|registro|hist|evento|hora|unidade|filial|volume|peso|valor|frete|cidade|uf)/i.test(w) ? w : "x"));
const { FORMATO_USUARIO: US, FORMATO_SENHA: SE } = process.env;
if (!US || !SE) { log("faltam os segredos FORMATO_USUARIO / FORMATO_SENHA"); process.exit(0); }
await entrarSupabase();
const L = await chamar("base_aberta?select=nf,transportadora&transportadora=ilike.*formato*&nf=not.is.null&limit=3");
log("NFs Formato:", L.length);
const nav = await chromium.launch();
const pg = await nav.newPage();
pg.on("response", (r) => { const q = r.request(); if (["xhr", "fetch", "document"].includes(q.resourceType())) log(`${q.method()} ${new URL(r.url()).pathname} → ${r.status()} · ${q.resourceType()} · campos: ${q.postData() ? [...new URLSearchParams(q.postData()).keys()].join(",") : ""}`); });
await pg.goto("https://www.transformato.com.br/", { waitUntil: "networkidle" }).catch((e) => log("home erro:", e.message));
await pg.locator("#username").fill(US);
await pg.locator("#password").fill(SE);
await Promise.all([pg.waitForLoadState("networkidle").catch(() => {}), pg.locator("#flogin input[type=submit]").click()]);
await pg.waitForTimeout(4000);
log("depois do login:", new URL(pg.url()).pathname, "· ainda tem senha na tela:", (await pg.locator("input[type=password]:visible").count()) ? "sim" : "não");
log("textos pós-login:", letras(await pg.locator("body").innerText()).slice(0, 25).join(" | ").slice(0, 900));
if (!/consultaweb|menu|cliente/i.test(pg.url())) {   // não tenta logar de novo (trava de senha)
  await pg.goto("https://www.transformato.com.br/consultaweb.asp", { waitUntil: "networkidle" }).catch(() => {});
  log("menu:", letras(await pg.locator("body").innerText()).slice(0, 12).join(" | "));
}
await pg.goto("https://www.transformato.com.br/consnota.asp", { waitUntil: "networkidle" }).catch(() => {});
for (const l of L.slice(0, 2)) {
  const [num, ser] = String(l.nf).split("-").map((x) => (x || "").trim());
  await pg.locator("#nota").fill(num);
  await Promise.all([pg.waitForLoadState("networkidle").catch(() => {}), pg.locator("#btngravar").click()]);
  await pg.waitForTimeout(3000);
  const t = await pg.locator("body").innerText();
  log(`consulta (série ${ser}): datas: ${(t.match(/\d{2}\/\d{2}\/\d{2,4}/g) || []).length} · entreg: ${/entreg/i.test(t) ? "sim" : "não"} · previsão: ${/previs/i.test(t) ? "sim" : "não"} · não encontrad: ${/n[ãa]o (foi )?encontrad|nenhum/i.test(t) ? "sim" : "não"}`);
  log("cabeçalhos:", (await pg.$$eval("th, td b, td strong", (es) => es.map((e) => e.textContent.trim().slice(0, 30)))).slice(0, 30).join(" | "));
  log("textos:", letras(t).slice(0, 50).join(" | ").slice(0, 2000));
  log("links:", (await pg.$$eval("a[href], iframe, form", (es) => es.map((e) => (e.getAttribute("href") || e.getAttribute("src") || e.getAttribute("action") || "").slice(0, 80)))).filter((x) => !/^(consnota|conscte|relpedidosc|relconc|geracopcli|relfollowup|bolcli|logout|#)/.test(x)).slice(0, 15).join(" | "));
  await pg.goto("https://www.transformato.com.br/consnota.asp", { waitUntil: "networkidle" }).catch(() => {});
}
await nav.close();
