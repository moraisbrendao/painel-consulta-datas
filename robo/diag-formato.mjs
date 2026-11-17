// Diagnóstico do rastreio da Formato (transformato.com.br): login 1 vez só (segredos FORMATO_USUARIO/SENHA), Consulta NF e só estrutura mascarada — nunca dados de cliente.
import { chromium } from "playwright";
import { entrarSupabase, chamar } from "./supa.mjs";
const masc = (x) => String(x).replace(/\d{4,}/g, "#####").replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>");
const log = (...a) => console.log(...a.map(masc));
const letras = (t) => t.split(/\n+/).map((x) => x.trim()).filter(Boolean).map((x) => x.replace(/[A-Za-zÀ-ú]{3,}/g, (w) => /^(nota|fiscal|nf|cte|ct-e|data|entrega|entregue|previs|status|situa|ocorr|emiss|coleta|chegada|saida|saída|destino|origem|remetente|destinat|serie|série|transit|rota|baixa|pendente|aguard|em|de|da|do|para|consulta|listar|cliente|nenhum|encontrad|n[ãa]o|registro|hist|evento|hora|unidade|filial|volume|peso|valor|frete|cidade|uf)/i.test(w) ? w : "x"));
const { FORMATO_USUARIO: US, FORMATO_SENHA: SE } = process.env;
if (!US || !SE) { log("faltam os segredos FORMATO_USUARIO / FORMATO_SENHA"); process.exit(0); }
await entrarSupabase();
const T = await chamar("base_aberta?select=nf,transportadora,micro_status&transportadora=ilike.*formato*&nf=not.is.null&limit=2000");
log("Formato na base:", T.length, "· por série:", Object.entries(T.reduce((a, l) => { const s = String(l.nf).split("-")[1] || "?"; a[s] = (a[s] || 0) + 1; return a; }, {})).map(([k, v]) => `${k}:${v}`).join(" "), "· por micro status:", Object.entries(T.reduce((a, l) => { const s = (l.micro_status || "?").slice(0, 25); a[s] = (a[s] || 0) + 1; return a; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}:${v}`).join(" | "));
// amostra variada: 2 por série, preferindo quem já saiu (micro status sem "aguard"/"emiss")
const L = []; const vistos = {};
for (const l of [...T].sort((a, b) => (/aguard|emiss|fatur/i.test(a.micro_status || "") ? 1 : 0) - (/aguard|emiss|fatur/i.test(b.micro_status || "") ? 1 : 0))) { const s = String(l.nf).split("-")[1] || "?"; if ((vistos[s] = (vistos[s] || 0) + 1) <= 2 && L.length < 8) L.push(l); }
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
let achou = 0;
for (const l of L) {
  const [num, ser] = String(l.nf).split("-").map((x) => (x || "").trim());
  await pg.locator("#nota").fill(num);
  await Promise.all([pg.waitForLoadState("networkidle").catch(() => {}), pg.locator("#btngravar").click()]);
  await pg.waitForTimeout(3000);
  const t = await pg.locator("body").innerText();
  log(`consulta (série ${ser}): datas: ${(t.match(/\d{2}\/\d{2}\/\d{2,4}/g) || []).length} · entreg: ${/entreg/i.test(t) ? "sim" : "não"} · previsão: ${/previs/i.test(t) ? "sim" : "não"} · não encontrad: ${/n[ãa]o (foi )?encontrad|nenhum/i.test(t) ? "sim" : "não"}`);
  if (!/n[ãa]o (foi )?encontrad/i.test(t)) achou++; else { log("   micro status:", (l.micro_status || "?").slice(0, 30)); await pg.goto("https://www.transformato.com.br/consnota.asp", { waitUntil: "networkidle" }).catch(() => {}); continue; }
  if (achou > 2) { await pg.goto("https://www.transformato.com.br/consnota.asp", { waitUntil: "networkidle" }).catch(() => {}); continue; }
  log("cabeçalhos:", (await pg.$$eval("th, td b, td strong", (es) => es.map((e) => e.textContent.trim().slice(0, 30)))).slice(0, 30).join(" | "));
  log("textos:", letras(t).slice(0, 50).join(" | ").slice(0, 2000));
  log("links:", (await pg.$$eval("a[href], iframe, form", (es) => es.map((e) => (e.getAttribute("href") || e.getAttribute("src") || e.getAttribute("action") || "").slice(0, 80)))).filter((x) => !/^(consnota|conscte|relpedidosc|relconc|geracopcli|relfollowup|bolcli|logout|#)/.test(x)).slice(0, 15).join(" | "));
  await pg.goto("https://www.transformato.com.br/consnota.asp", { waitUntil: "networkidle" }).catch(() => {});
}
for (const pag of ["relfollowup.asp", "relpedidosc.asp", "conscte.asp"]) {
  await pg.goto("https://www.transformato.com.br/" + pag, { waitUntil: "networkidle" }).catch(() => {});
  log(pag, "· campos:", (await pg.$$eval("input,select,button", (es) => es.map((e) => `${e.tagName}[${e.type || ""}] ${e.name || e.id || ""}`))).join(" | ").slice(0, 600));
  log(pag, "· cabeçalhos:", (await pg.$$eval("th", (es) => es.map((e) => e.textContent.trim().slice(0, 25)))).slice(0, 30).join(" | "), "· linhas de tabela:", await pg.locator("tr").count());
}
await nav.close();
