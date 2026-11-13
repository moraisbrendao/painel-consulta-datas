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

// CNPJ do remetente pela série da NF (tabela da Logística)
const CNPJ_SERIE = { "00349443000192": [4, 6, 7, 31, 94], "00349443000435": [9, 22, 34], "00349443000516": [10],
  "00349443000788": [11, 24, 25, 27, 301, 302, 303], "00349443001083": [14, 35], "00349443001245": [17], "00349443001407": [21],
  "00349443001750": [23], "00349443001679": [26] };
const cnpjDaSerie = (serie) => { const n = parseInt(serie, 10); return Object.keys(CNPJ_SERIE).find((c) => CNPJ_SERIE[c].includes(n)) || null; };
const sohTexto = (html) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<svg[\s\S]*?<\/svg>/gi, " ").replace(/<br\s*\/?>|<\/(tr|p|div|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
async function consultar(cnpj, nfs) {
  return pagina("https://ssw.inf.br/2/resultSSW", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ cnpj, NR: nfs.join("\n"), chave: "" }).toString() });
}
if (MODO === "diag-nf") {
  await entrarSupabase();
  const linhas = await chamar("base_aberta?select=transportadora,nf,prev_original&nf=not.is.null&limit=6000");
  log("Pedidos em aberto lidos:", linhas.length, "· exemplo do formato da NF:", String((linhas[0] || {}).nf || "").replace(/\d/g, "9"));
  const porT = {};
  for (const l of linhas) { const [num, ser] = String(l.nf).split("-"); const c = cnpjDaSerie(ser); if (!c || !num) continue; (porT[l.transportadora || "?"] ||= []).push({ num: num.trim(), c }); }
  let mostrou = false;
  for (const [t, L] of Object.entries(porT)) {
    const x = L[0];
    try {
      const p = await consultar(x.c, [x.num]);
      const ls = sohTexto(p.txt);
      const prev = ls.filter((l) => /previs/i.test(l)).map((l) => l.replace(/[A-Za-zÀ-ú]{3,}/g, (w) => /previs|entrega|prevista|data|de|em/i.test(w) ? w : "x").slice(0, 80));
      const nao = ls.some((l) => /n[ãa]o (localizad|encontrad)|nenhum/i.test(l));
      log(`${t}: ${L.length} pedido(s) · resposta ${p.status} · ${nao ? "NÃO localizado" : "achou"} · linhas com previsão: ${prev.length ? prev.slice(0, 3).join(" | ") : "nenhuma"}`);
      if (!mostrou && !nao && prev.length) { mostrou = true;
        log("  rótulos da página (só palavras sem números, curtas):", ls.filter((l) => !/\d/.test(l) && l.length < 40).slice(0, 40).join(" / ")); }
    } catch (e) { log(`${t}: erro ${e.message}`); }
    await new Promise((r) => setTimeout(r, 1500));
  }
}
if (MODO === "diag-form") {
  const p = await pagina("https://ssw.inf.br/2/rastreamento?");
  const i = p.txt.search(/<form/i), f = p.txt.slice(i, p.txt.indexOf("</form>", i) + 7);
  log(f.replace(/<svg[\s\S]*?<\/svg>/gi, "").replace(/class="[^"]*"/g, "").replace(/\s+/g, " ").slice(0, 3500));
  tags(p.txt, /<script[^>]*>[\s\S]*?<\/script>/gi).forEach((t) => log("  script:", t));
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
