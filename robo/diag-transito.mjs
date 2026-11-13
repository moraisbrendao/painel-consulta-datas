// Diagnóstico do rastreio da Trânsito Brasil (Senior TMS): mostra só URLs, métodos, nomes de campos e status — nunca dados de cliente.
import { chromium } from "playwright";
import { entrarSupabase, chamar } from "./supa.mjs";
const log = (...a) => console.log(...a.map((x) => String(x).replace(/\d{5,}/g, "#####")));
const chaves = (o, p = "", n = 0) => n > 4 || !o || typeof o !== "object" ? [] : Object.entries(o).flatMap(([k, v]) => Array.isArray(v) ? [`${p}${k}[${v.length}]`, ...chaves(v[0], `${p}${k}[0].`, n + 1)] : v && typeof v === "object" ? chaves(v, `${p}${k}.`, n + 1) : [`${p}${k}=${/^\d{4}-\d{2}-\d{2}/.test(String(v)) ? String(v).slice(0, 16) : /status|situa|tipo|evento|ocorr|descr/i.test(k) && typeof v === "string" && v.length < 40 && !/\d{3}/.test(v) ? v : typeof v}`]);
const URL_T = "https://platform.senior.com.br/logistica-tck/tms/tck-frontend/#/login/signup?tenant=ZEhKaGJuTnBkRzlpY21GemFXdz0%3D";

await entrarSupabase();
const L = await chamar("base_aberta?select=nf,transportadora&transportadora=ilike.*sito*brasil*&nf=not.is.null&limit=20");
const alvo = L.map((l) => { const [num, ser] = String(l.nf).split("-").map((x) => (x || "").trim()); return { num, ser }; }).find((x) => ["4", "7", "31", "35"].includes(String(parseInt(x.ser, 10))));
log("pedidos Trânsito Brasil:", L.length, "· série do teste:", alvo ? alvo.ser : "nenhuma");
const cnpj = alvo && String(parseInt(alvo.ser, 10)) === "35" ? "00349443001083" : "00349443000192";

let modelo = null;
const nav = await chromium.launch();
const pg = await nav.newPage();
pg.on("response", async (r) => {
  const req = r.request(); if (!["xhr", "fetch"].includes(req.resourceType())) return;
  let corpo = ""; try { const j = JSON.parse(req.postData() || "null"); corpo = j ? Object.keys(j).join(",") : ""; } catch { corpo = (req.postData() || "").slice(0, 0); }
  let resp = ""; try { const j = await r.json(); resp = chaves(j).slice(0, 60).join(" | "); } catch { resp = "(não JSON)"; }
  if (/externalTenantConsultaTracking/.test(r.url())) { modelo = { url: r.url(), corpo: JSON.parse(req.postData() || "{}"), cab: Object.fromEntries(Object.entries(req.headers()).filter(([h]) => /^x-tenant/i.test(h))) };
    log("corpo modelo:", JSON.stringify({ ...modelo.corpo, documento: "…", inscricaoFiscal: "…" }), "· x-tenant:", JSON.stringify(modelo.cab)); }
  log(`${req.method()} ${r.url().split("?")[0]} → ${r.status()} · corpo: ${corpo} · cabeçalhos: ${Object.keys(req.headers()).filter((h) => /auth|token|tenant|x-/i.test(h)).join(",")} · resposta: ${resp.slice(0, 1500)}`);
});
await pg.goto(URL_T, { waitUntil: "networkidle" }).catch((e) => log("goto:", e.message.slice(0, 100)));
log("inputs login:", (await pg.$$eval("input,button", (es) => es.map((e) => `${e.tagName}[${e.type || ""}] ${e.name || e.id || e.placeholder || e.textContent.trim().slice(0, 20)}`))).join(" | "));
await pg.locator("input").first().fill(cnpj);
await pg.getByRole("button", { name: /entrar/i }).click().catch((e) => log("entrar:", e.message.slice(0, 100)));
await pg.waitForTimeout(6000);
log("depois do login, url:", pg.url().replace(/\d{5,}/g, "#").slice(0, 200));
log("inputs:", (await pg.$$eval("input,button", (es) => es.map((e) => `${e.tagName}[${e.type || ""}] ${e.name || e.id || e.placeholder || e.textContent.trim().slice(0, 20)}`))).join(" | "));
if (alvo) {
  const campo = pg.locator("input").first();
  await campo.fill(alvo.num).catch((e) => log("campo:", e.message.slice(0, 100)));
  await pg.getByRole("button", { name: /filtrar/i }).click().catch((e) => log("filtrar:", e.message.slice(0, 100)));
  await pg.waitForTimeout(6000);
  log("cabeçalhos da lista:", (await pg.$$eval("th", (es) => es.map((e) => e.textContent.trim()))).join(" | "), "· linhas:", await pg.locator("tbody tr").count());
}
await nav.close();
// chamada direta, várias NFs da Trânsito Brasil (CNPJ pela série)
if (modelo) for (const l of L.slice(0, 10)) {
  const [num, ser] = String(l.nf).split("-").map((x) => (x || "").trim()), sn = String(parseInt(ser, 10));
  const insc = sn === "35" ? "00349443001083" : "00349443000192";
  const r = await fetch(modelo.url, { method: "POST", headers: { "Content-Type": "application/json", ...modelo.cab }, body: JSON.stringify({ ...modelo.corpo, documento: num, inscricaoFiscal: insc }) });
  let j = null; try { j = await r.json(); } catch {}
  const t = j && j.listaTracking || [];
  log(`direto série ${ser}: ${r.status} · achados ${t.length} · séries: ${t.map((x) => x.serie ?? x.serieDocumento ?? "?").join(",")}`);
  if (t.length) log("  campos:", chaves(t[0]).slice(0, 80).join(" | ").slice(0, 2500));
  await new Promise((ok) => setTimeout(ok, 1500));
}
