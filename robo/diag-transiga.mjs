// Diagnóstico do rastreio da Transiga (track3r): login 1 vez só, busca por NF e mostra só nomes de campos, URLs e status — nunca dados de cliente.
import { chromium } from "playwright";
import { entrarSupabase, chamar } from "./supa.mjs";
const log = (...a) => console.log(...a.map((x) => String(x).replace(/\d{5,}/g, "#####").replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>")));
const { EMAIL_TRANSIGA, SENHA_TRANSIGA } = process.env;
if (!EMAIL_TRANSIGA || !SENHA_TRANSIGA) { log("faltam os segredos EMAIL_TRANSIGA / SENHA_TRANSIGA"); process.exit(0); }
await entrarSupabase();
const L = await chamar("base_aberta?select=nf,transportadora&transportadora=ilike.*transiga*&nf=not.is.null&limit=3");
log("pedidos Transiga:", L.length);
const nav = await chromium.launch();
const pg = await nav.newPage();
pg.on("response", async (r) => {
  const q = r.request(); if (!["xhr", "fetch", "document"].includes(q.resourceType())) return;
  const u = new URL(r.url());
  let corpo = q.postData() || ""; corpo = corpo ? (corpo.trim().startsWith("{") ? "json:" + Object.keys(JSON.parse(corpo)).join(",") : "form:" + [...new URLSearchParams(corpo).keys()].join(",")) : "";
  let resp = ""; const ct = r.headers()["content-type"] || "";
  if (/json/.test(ct)) { try { const j = await r.json(); resp = "json:" + (Array.isArray(j) ? `lista ${j.length} ` + Object.keys(j[0] || {}).join(",") : Object.keys(j).join(",")); } catch {} }
  log(`${q.method()} ${u.origin}${u.pathname} ?${[...u.searchParams.keys()].join(",")} → ${r.status()} · ${q.resourceType()} · ${corpo} · ${ct.split(";")[0]} ${resp.slice(0, 600)}`);
});
await pg.goto("https://www.track3r.com.br/auth/login", { waitUntil: "networkidle" });
log("login inputs:", (await pg.$$eval("input,button,select", (es) => es.map((e) => `${e.tagName}[${e.type || ""}] ${e.name || e.id || e.placeholder || e.textContent.trim().slice(0, 20)}`))).join(" | "));
await pg.locator("input[type=email], input[name*=mail i], input[name*=user i], input[name*=login i], input[type=text]").first().fill(EMAIL_TRANSIGA);
await pg.locator("input[type=password]").first().fill(SENHA_TRANSIGA);
await Promise.all([pg.waitForLoadState("networkidle").catch(() => {}), pg.locator("button[type=submit], input[type=submit], button:has-text('Entrar'), button:has-text('Acessar')").first().click()]);
await pg.waitForTimeout(4000);
const aindaLogin = await pg.locator("input[type=password]").count();
log("depois do login:", new URL(pg.url()).pathname, "· ainda na tela de login:", aindaLogin ? "sim" : "não");
if (aindaLogin) { log("aviso:", (await pg.locator(".alert, .validation-summary-errors, .text-danger, .field-validation-error").allTextContents()).join(" | ").slice(0, 200)); await nav.close(); process.exit(0); }   // não tenta de novo (trava de senha)
await pg.goto("https://www.track3r.com.br/tms/consultas-tracking", { waitUntil: "networkidle" });
log("tracking inputs:", (await pg.$$eval("input,button,select,a.btn", (es) => es.map((e) => `${e.tagName}[${e.type || ""}] ${e.name || e.id || e.placeholder || e.textContent.trim().slice(0, 20)}`))).join(" | "));
log("opções:", (await pg.$$eval("select option", (es) => es.map((e) => `${e.value}=${e.textContent.trim()}`))).join(" | "));
for (const l of L.slice(0, 2)) {
  const [num, ser] = String(l.nf).split("-").map((x) => (x || "").trim());
  const sel = pg.locator("select").first();
  const opt = await pg.$$eval("select option", (es) => (es.find((e) => /nota fiscal/i.test(e.textContent)) || {}).value);
  if (opt) await sel.selectOption(opt).catch(() => {});
  const campo = pg.locator("input[placeholder*=Buscar i], input[type=search], input[type=text]").first();
  await campo.fill(num); await campo.press("Enter"); await pg.waitForTimeout(5000);
  const txt = await pg.locator("body").innerText();
  const st = (txt.match(/Status:\s*([^\n]+)/i) || [])[1] || "";
  const nfs = (txt.match(/Nota Fiscal\/S[ée]rie\s*\n?\s*\d+\s*\/\s*(\d+)/i) || [])[1];
  log(`busca série ${ser}: nenhuma encontrada: ${/nenhuma encomenda/i.test(txt) ? "sim" : "não"} · status: ${/^[A-ZÀ-Ú ]{3,40}$/.test(st.trim()) ? st.trim() : "(outro)"} · série na tela: ${nfs || "?"} · url: ${new URL(pg.url()).pathname} ?${[...new URL(pg.url()).searchParams.keys()].join(",")}`);
  log("  colunas:", (await pg.$$eval("th", (es) => es.map((e) => e.textContent.trim()))).join(" | "), "· linhas:", await pg.locator("tbody tr").count(), "· status da tabela:", (await pg.$$eval("tbody tr td:nth-child(4)", (es) => es.map((e) => e.textContent.trim()).filter((t) => /^[A-Za-zÀ-ú ]{3,40}$/.test(t)))).join(", "));
}
await nav.close();
