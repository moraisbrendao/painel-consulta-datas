// Diagnóstico: como o front da Senior (Trânsito Brasil) guarda o login e se aceita a NF pela URL (só trechos do código público do site)
import { chromium } from "playwright";
const log = (...a) => console.log(...a.map((x) => String(x).replace(/\d{11,}/g, "#")));
const nav = await chromium.launch(); const pg = await nav.newPage(); const js = [];
pg.on("response", async (r) => { if (/\.js(\?|$)/.test(r.url()) && /tck-frontend/.test(r.url())) { try { js.push([r.url(), await r.text()]); } catch {} } });
await pg.goto("https://platform.senior.com.br/logistica-tck/tms/tck-frontend/#/login/signup?tenant=ZEhKaGJuTnBkRzlpY21GemFXdz0%3D", { waitUntil: "networkidle" });
await pg.locator("input").first().fill("00349443000192");
await pg.getByRole("button", { name: /entrar/i }).click(); await pg.waitForTimeout(5000);
log("url após login:", pg.url());
log("localStorage:", JSON.stringify(await pg.evaluate(() => Object.keys(localStorage))), "· sessionStorage:", JSON.stringify(await pg.evaluate(() => Object.keys(sessionStorage))));
log("sessionStorage valores (tamanho):", JSON.stringify(await pg.evaluate(() => Object.fromEntries(Object.keys(sessionStorage).map((k) => [k, String(sessionStorage.getItem(k)).length])))));
for (const [u, t] of js) {
  const achados = [];
  for (const re of [/queryParam[^;]{0,200}/g, /documento[^;]{0,120}/g, /identificadorCliente[^;]{0,160}/g, /sessionStorage\.[gs]etItem\([^)]{0,120}\)/g, /localStorage\.[gs]etItem\([^)]{0,120}\)/g, /path:\s*["'][^"']{1,60}["']/g])
    for (const m of t.matchAll(re)) { achados.push(m[0].replace(/\s+/g, " ").slice(0, 200)); if (achados.length > 60) break; }
  if (achados.length) log("JS", u.split("/").pop(), "·", achados.slice(0, 60).join(" || ").slice(0, 6000));
}
await nav.close();
