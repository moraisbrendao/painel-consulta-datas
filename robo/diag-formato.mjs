// Diagnóstico do rastreio da Formato (transformato.com.br): login 1 vez só (segredos FORMATO_USUARIO/SENHA), Consulta NF e só estrutura mascarada — nunca dados de cliente.
import { chromium } from "playwright";
import { entrarSupabase, chamar } from "./supa.mjs";
const masc = (x) => String(x).replace(/\d{4,}/g, "#####").replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>");
const log = (...a) => console.log(...a.map(masc));
const ROT = /^(filial|ct-?e|data|destinat[aá]rio|cidade|uf|n\. ?fiscal|nota fiscal|frete|peso|valor|volumes?|remetente|dest\.?|origem|destino|chegada|hora|sa[ií]da|situa[cç][aã]o|status|ocorr[eê]ncia|entrega|previs[aã]o|tipo|qtd\.?|vol\.?|frete peso|baixa|recebedor|documento|romaneio|manifesto|motorista|placa|ve[ií]culo|unidade|evento|descri[cç][aã]o|obs\.?|observa[cç][aã]o|x)$/i;
const seguro = (t) => t.split(/\n+/).map((x) => x.trim()).filter(Boolean).map((x) => {
  const m = x.match(/^([A-Za-zÀ-ú .\/-]{3,45}):\s*(.*)$/); if (m) return `${m[1].trim()}: ${/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(m[2]) ? "<data>" : m[2] ? "<texto>" : ""}`;
  if (x.includes("\t")) { const c = x.split("\t").map((y) => y.trim()); return c.every((y) => !y || ROT.test(y)) ? "[cab] " + c.join(" ; ") : `[linha ${c.length} col]`; }
  return /^(nota fiscal n[ãa]o encontrada!?|dados do .{0,20}|notas .{0,25}|hist[oó]rico.{0,20}|ocorr[eê]ncias?.{0,20})$/i.test(x) ? x.replace(/\d+/g, "#") : "~";
});
const { FORMATO_USUARIO: US, FORMATO_SENHA: SE } = process.env;
if (!US || !SE) { log("faltam os segredos FORMATO_USUARIO / FORMATO_SENHA"); process.exit(0); }
await entrarSupabase();
const T = [...await chamar("base_pedidos?select=nf,transportadora,micro_status&transportadora=ilike.*formato*&nf=not.is.null&micro_status=ilike.ENTREG*&limit=5").catch((e) => { log("entregues: erro", e.message.slice(0, 80)); return []; }),
  ...await chamar("base_pedidos?select=nf,transportadora,micro_status&transportadora=ilike.*formato*&nf=not.is.null&micro_status=ilike.*INSUCESSO*&limit=2").catch(() => []),
  ...await chamar("base_pedidos?select=nf,transportadora,micro_status&transportadora=ilike.*formato*&nf=not.is.null&micro_status=ilike.*AUSENTE*&limit=1").catch(() => [])];
log("Formato na base:", T.length, "· por série:", Object.entries(T.reduce((a, l) => { const s = String(l.nf).split("-")[1] || "?"; a[s] = (a[s] || 0) + 1; return a; }, {})).map(([k, v]) => `${k}:${v}`).join(" "), "· por micro status:", Object.entries(T.reduce((a, l) => { const s = (l.micro_status || "?").slice(0, 25); a[s] = (a[s] || 0) + 1; return a; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}:${v}`).join(" | "));
// amostra variada: 2 por série, preferindo quem já saiu (micro status sem "aguard"/"emiss")
const L = [];
log("NFs Formato:", L.length);
const nav = await chromium.launch();
const pg = await nav.newPage();
pg.on("request", (q) => { if (/login\.asp/i.test(q.url())) { const h = q.headers(); log("login req headers:", Object.keys(h).map((k) => /cookie/i.test(k) ? `${k}=<${(h[k].match(/[^=;\s]+(?==)/g) || []).join(",")}>` : /referer|origin|content-type|user-agent/i.test(k) ? `${k}=${h[k].slice(0, 80)}` : k).join(" | "), "· corpo campos:", [...new URLSearchParams(q.postData() || "").keys()].join(",")); } });
pg.on("response", async (r) => { if (/login\.asp/i.test(r.url())) { const h = r.headers(); log("login resp:", r.status(), "· location:", h.location || "", "· set-cookie nomes:", (h["set-cookie"] || "").split("\n").map((c) => c.split("=")[0]).join(",")); } });
pg.on("response", (r) => { const q = r.request(); if (["xhr", "fetch", "document"].includes(q.resourceType())) log(`${q.method()} ${new URL(r.url()).pathname} → ${r.status()} · ${q.resourceType()} · campos: ${q.postData() ? [...new URLSearchParams(q.postData()).keys()].join(",") : ""}`); });
await pg.goto("https://www.transformato.com.br/", { waitUntil: "networkidle" }).catch((e) => log("home erro:", e.message));
log("campos do login:", (await pg.$$eval("#flogin input, #flogin select", (es) => es.map((e) => `${e.tagName}[${e.type}] ${e.name}=${e.name === "sistema" ? e.value : ""}`))).join(" | "));
await pg.locator("#username").fill(US);
await pg.locator("#password").fill(SE);
await Promise.all([pg.waitForLoadState("networkidle").catch(() => {}), pg.locator("#flogin input[type=submit]").click()]);
await pg.waitForTimeout(4000);
log("depois do login:", new URL(pg.url()).pathname, "· ainda tem senha na tela:", (await pg.locator("input[type=password]:visible").count()) ? "sim" : "não");

if (!/consultaweb|menu|cliente/i.test(pg.url())) {   // não tenta logar de novo (trava de senha)
  await pg.goto("https://www.transformato.com.br/consultaweb.asp", { waitUntil: "networkidle" }).catch(() => {});
}
await pg.goto("https://www.transformato.com.br/consnota.asp", { waitUntil: "networkidle" }).catch(() => {});
let achou = 0;
for (const l of L) {
  const [num, ser] = String(l.nf).split("-").map((x) => (x || "").trim());
  await pg.locator("#nota").fill(num);
  await Promise.all([pg.waitForLoadState("networkidle").catch(() => {}), pg.locator("#btngravar").click()]);
  await pg.waitForTimeout(3000);
  const t = await pg.locator("body").innerText();
  log(`[${(l.micro_status || "?").slice(0, 25)}]`);
  log(`consulta (série ${ser}): datas: ${(t.match(/\d{2}\/\d{2}\/\d{2,4}/g) || []).length} · entreg: ${/entreg/i.test(t) ? "sim" : "não"} · previsão: ${/previs/i.test(t) ? "sim" : "não"} · não encontrad: ${/n[ãa]o (foi )?encontrad|nenhum/i.test(t) ? "sim" : "não"}`);
  if (!/n[ãa]o (foi )?encontrad/i.test(t)) achou++; else { log("   micro status:", (l.micro_status || "?").slice(0, 30)); await pg.goto("https://www.transformato.com.br/consnota.asp", { waitUntil: "networkidle" }).catch(() => {}); continue; }
  if (achou > 4) { await pg.goto("https://www.transformato.com.br/consnota.asp", { waitUntil: "networkidle" }).catch(() => {}); continue; }
  log("cabeçalhos:", (await pg.$$eval("th, td b, td strong", (es) => es.map((e) => e.textContent.trim().slice(0, 30)))).slice(0, 30).join(" | "));
  log("linhas ~ (formato):", t.split(/\n+/).map((x) => x.trim()).filter(Boolean).filter((x) => seguro(x)[0] === "~").map((x) => x.replace(/\d/g, "9").replace(/[A-Za-zÀ-ú]{4,}/g, (w) => /^(entreg|recebid|baixa|ocorr|data|hora|situa|status|pend|devol|insuc|ausen|endere|recus|previs|cliente|ol[áa])/i.test(w) ? w : "x")).slice(0, 12).join(" | "));
  log("textos:", seguro(t).slice(0, 60).join(" | ").slice(0, 2000));
  log("links:", (await pg.$$eval("a[href], iframe, form", (es) => es.map((e) => (e.getAttribute("href") || e.getAttribute("src") || e.getAttribute("action") || "").slice(0, 80)))).filter((x) => !/^(consnota|conscte|relpedidosc|relconc|geracopcli|relfollowup|bolcli|logout|#)/.test(x)).slice(0, 15).join(" | "));
  await pg.goto("https://www.transformato.com.br/consnota.asp", { waitUntil: "networkidle" }).catch(() => {});
}
{ // Follow-Up das Entregas: relatório por período
  await pg.goto("https://www.transformato.com.br/relfollowup.asp", { waitUntil: "networkidle" }).catch(() => {});
  log("followup form:", (await pg.$$eval("form, input, select, option, label", (es) => es.map((e) => e.tagName === "FORM" ? `FORM ${e.method} ${e.getAttribute("action")}` : e.tagName === "LABEL" || e.tagName === "OPTION" ? `${e.tagName} ${e.getAttribute("value") || ""}=${e.textContent.trim().slice(0, 30)}` : `${e.tagName}[${e.type}] ${e.name} val=${(e.value || "").slice(0, 12)} ph=${e.placeholder || ""}`))).join(" | ").slice(0, 2500));
  log("followup textos:", seguro(await pg.locator("body").innerText()).filter((x) => x !== "~").slice(0, 30).join(" | ").slice(0, 800));
  log("followup rótulos:", (await pg.locator("body").innerText()).split(/\n+/).map((x) => x.trim()).filter((x) => x && x.length < 60 && !/\d{3,}/.test(x)).slice(0, 40).join(" | ").replace(/[A-ZÀ-Ú][a-zà-ú]+ [A-ZÀ-Ú][a-zà-ú]+ [A-ZÀ-Ú]/g, "x").slice(0, 1200));
  const hoje = new Date(Date.now() - 3 * 3600000), ini = new Date(hoje - 20 * 86400000), f = (d) => d.toISOString().slice(0, 10).split("-").reverse().join("/");
  const di = pg.locator("input[name=dataini]"); if (await di.count()) { await di.first().fill(f(ini)); await pg.locator("input[name=datafin]").first().fill(f(hoje)); }
  const dl = pg.waitForEvent("download", { timeout: 60000 }).catch(() => null);
  await Promise.all([pg.waitForLoadState("networkidle").catch(() => {}), pg.locator("input[type=submit]").first().click().catch(() => {})]);
  const d = await Promise.race([dl, new Promise((ok) => setTimeout(() => ok(null), 15000))]);
  if (d) log("followup: baixou arquivo", d.suggestedFilename().replace(/\d{4,}/g, "#"));
  const t = await pg.locator("body").innerText().catch(() => "");
  log("followup resultado: linhas tr:", await pg.locator("tr").count(), "· datas:", (t.match(/\d{1,2}\/\d{1,2}\/\d{2,4}/g) || []).length, "· url:", new URL(pg.url()).pathname);
  log("followup cabeçalhos:", (await pg.$$eval("th, tr:first-child td", (es) => es.map((e) => e.textContent.trim().slice(0, 25)))).filter((x) => !/\d{3,}/.test(x)).slice(0, 40).join(" | "));
  log("followup linhas:", seguro(t).filter((x) => x !== "~").slice(0, 25).join(" | ").slice(0, 1500));
}
for (const pag of []) {
  await pg.goto("https://www.transformato.com.br/" + pag, { waitUntil: "networkidle" }).catch(() => {});
  log(pag, "· campos:", (await pg.$$eval("input,select,button", (es) => es.map((e) => `${e.tagName}[${e.type || ""}] ${e.name || e.id || ""}`))).join(" | ").slice(0, 600));
  log(pag, "· cabeçalhos:", (await pg.$$eval("th", (es) => es.map((e) => e.textContent.trim().slice(0, 25)))).slice(0, 30).join(" | "), "· linhas de tabela:", await pg.locator("tr").count());
}
await nav.close();
