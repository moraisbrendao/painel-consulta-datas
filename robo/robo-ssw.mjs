// Robô da conferência SSW: lê a previsão de entrega no rastreio público do SSW (ssw.inf.br)
// pela NF (sem a série) + CNPJ do remetente (escolhido pela série da NF).
// Registro público (Actions): só contagens, nomes de campos e datas — nunca nome, endereço ou NF.
import { entrarSupabase, chamar } from "./supa.mjs";
const MODO = process.env.MODO || "diag";
const log = (...a) => console.log(...a.map((x) => String(x).replace(/\d{5,}/g, "#####")));
const tags = (html, re) => [...html.matchAll(re)].map((m) => m[0].replace(/\s+/g, " ").slice(0, 200));

async function pagina(url, opts) {
  const r = await fetch(url, { redirect: "follow", ...opts, headers: { "User-Agent": "Mozilla/5.0", ...(opts && opts.headers) } });
  const buf = Buffer.from(await r.arrayBuffer());
  const txt = new TextDecoder(/8859|latin/i.test(r.headers.get("content-type") || "") ? "latin1" : "utf-8").decode(buf);
  return { status: r.status, url: r.url, txt };
}

if (MODO === "diag") {
  for (const u of ["https://ssw.inf.br/ajuda/rastreamento.html", "https://ssw.inf.br/2/rastreamento", "https://ssw.inf.br/2/rastreamento_pf"]) {
    try {
      const p = await pagina(u);
      log(`== ${u} -> ${p.status} ${p.url} (${p.txt.length} letras)`);
      tags(p.txt, /<form[^>]*>/gi).forEach((t) => log("  form:", t));
      tags(p.txt, /<input[^>]*>/gi).slice(0, 30).forEach((t) => log("  input:", t));
      tags(p.txt, /<select[^>]*>/gi).forEach((t) => log("  select:", t));
      tags(p.txt, /<a [^>]*href="[^"]*(rastre|track|ssw)[^"]*"[^>]*>/gi).slice(0, 30).forEach((t) => log("  link:", t));
      tags(p.txt, /(action|url|href)\s*[:=]\s*["'][^"']*(result|rastre)[^"']*["']/gi).slice(0, 20).forEach((t) => log("  js:", t));
    } catch (e) { log(`== ${u}: erro ${e.message}`); }
  }
  // links de rastreio da base: só os sites (hosts), para ver quais transportadoras usam SSW
  try {
    await entrarSupabase();
    const linhas = await chamar("base_pedidos?select=transportadora,link_rastreio&limit=5000");
    const hosts = {};
    for (const l of linhas) { let h = "sem link"; try { if (l.link_rastreio) h = new URL(l.link_rastreio).host + new URL(l.link_rastreio).pathname.replace(/[^/]{6,}/g, "*").slice(0, 40); } catch { h = "link estranho"; }
      const k = `${h} · ${l.transportadora || "?"}`; hosts[k] = (hosts[k] || 0) + 1; }
    Object.entries(hosts).sort((a, b) => b[1] - a[1]).slice(0, 60).forEach(([k, n]) => log(`  base: ${n} × ${k}`));
  } catch (e) { log("Base:", e.message); }
}
