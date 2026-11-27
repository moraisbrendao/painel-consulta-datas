// Reposição pré-entrega › Falta de volumes (Brenda 27/11): a transportadora anexa no portal a foto da etiqueta do volume
// que está com ela; por eliminação, pedimos a reposição do(s) outro(s) volume(s).
// Etiqueta da matriz (séries 7, 4, 31): código de barras = NF(7) + série(2) + volume(2) + total(2), ex. 0658695070102,
// texto "VOL. NF:01/02" e o código do volume (ex. 76280.0002).
// Registro público (Actions): só sim/não e números de volume — nunca a foto, nome, endereço ou texto da etiqueta.
import fs from "node:fs";
import { entrarPortal } from "./barrar.mjs";
import { abrirRepoPre, acharLinha } from "./anota-portal.mjs";

const mascara = (t) => String(t ?? "").replace(/\d/g, "#").replace(/\s+/g, " ").trim().slice(0, 80);
let zx = null;
async function codigosDeBarras(buf) {
  try {
    if (!zx) { zx = await import("zxing-wasm/reader"); await zx.prepareZXingModule({ overrides: { wasmBinary: fs.readFileSync(new URL("./node_modules/zxing-wasm/dist/reader/zxing_reader.wasm", import.meta.url)) }, fireImmediately: true }); }
    const sharp = (await import("sharp")).default, out = new Set();
    for (const sc of [1, 2]) {
      const meta = await sharp(buf).metadata();
      const { data, info } = await sharp(buf).rotate().resize({ width: Math.min(4000, Math.round(meta.width * sc)) }).grayscale().normalize().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const r = await zx.readBarcodes({ data: new Uint8ClampedArray(data), width: info.width, height: info.height, colorSpace: "RGBA" }, { tryHarder: true, tryRotate: true, maxNumberOfSymbols: 10, formats: ["Code128", "ITF", "Code39", "EAN-13", "DataMatrix", "QRCode"] });
      r.forEach((x) => out.add(x.text));
    }
    return [...out];
  } catch (e) { return { erro: String(e.message).slice(0, 80) }; }
}
async function ocr(buf) {
  try { const { execFileSync } = await import("node:child_process"); fs.writeFileSync("/tmp/etq.img", buf);
    const t = execFileSync("tesseract", ["/tmp/etq.img", "-", "--psm", "11"], { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "ignore"] }); fs.rmSync("/tmp/etq.img", { force: true }); return t;
  } catch (e) { return ""; }
}

// diagnóstico com UMA NF (hash do número no input transp): acha a linha no portal, abre Anexos, baixa a(s) foto(s) e testa a leitura.
export async function diagRepoPre({ chamar, log, ctx, alvo, createHash }) {
  const hh = (t) => createHash("sha256").update(String(t || "")).digest("hex").slice(0, 16);
  let nf = null;
  for (let de = 0; !nf; de += 1000) { const B = await chamar(`base_pedidos?select=nf&order=pedido&limit=1000&offset=${de}`).catch(() => []);
    const x = B.find((b) => hh(String(b.nf || "").split("-")[0].trim()) === alvo); if (x) nf = x.nf; if (B.length < 1000) break; }
  if (!nf) { log("diag-repopre: NF não achada na base"); return; }
  const num = String(nf).split("-")[0].trim(), serie = String(nf).split("-")[1];
  log(`diag-repopre: NF achada na base (série ${serie})`);
  const p = await entrarPortal(ctx, log); await abrirRepoPre(p, log);
  const linha = await acharLinha(p, nf);
  if (!linha) { log("NF não está na lista Reposições (Pré Entrega)"); return; }
  const ths = (await p.locator("table thead th").allTextContents()).map((t) => t.trim());
  log("Colunas:", ths.join(" | "));
  const ia = ths.findIndex((h) => /anexo/i.test(h)); const cel = linha.locator("td").nth(ia);
  log("Célula Anexos:", (await cel.locator("button, a, svg").evaluateAll((es) => es.map((e) => `${e.tagName.toLowerCase()}:${[e.title, e.getAttribute("aria-label"), (e.innerText || "").trim(), e.getAttribute("href") ? "href" : ""].filter(Boolean).join("/") || "(ícone)"}`))).map(mascara).join(" | "));
  const respostas = [];
  p.on("response", async (r) => { const ct = r.headers()["content-type"] || ""; if (/image\//.test(ct)) { try { respostas.push({ ct, buf: await r.body() }); } catch (_) {} } });
  const bt = cel.locator("button, a").first();
  if (!(await bt.count())) { log("Sem botão em Anexos"); return; }
  await bt.click(); await p.waitForTimeout(3500);
  const d = p.locator("[role=dialog]").last();
  if (await d.count()) {
    log("Janela de anexos:", mascara((await d.innerText()).slice(0, 120)));
    log("Na janela: imagens", await d.locator("img").count(), "· links", await d.locator("a").count(), "· botões", (await d.locator("button").evaluateAll((es) => es.map((e) => [e.title, e.getAttribute("aria-label"), (e.innerText || "").trim()].filter(Boolean).join("/") || "(ícone)"))).map(mascara).join(" | "));
    const hrefs = await d.locator("a[href], img[src]").evaluateAll((es) => es.map((e) => e.getAttribute("href") || e.getAttribute("src")));
    log("Endereços (só tipo):", hrefs.map((h) => { try { const u = new URL(h, location.href); return u.host.replace(/[a-z0-9-]+\./, "x.") + " " + (u.pathname.match(/\.[a-z0-9]{2,5}$/i) || ["(sem ext)"])[0]; } catch (e) { return "?"; } }).join(" | ") || "nenhum");
    for (const h of hrefs.slice(0, 4)) { try { const r = await p.request.get(new URL(h, p.url()).href); const ct = r.headers()["content-type"] || ""; if (/image|octet|pdf/.test(ct)) respostas.push({ ct, buf: await r.body() }); } catch (_) {} }
  } else log("Nenhuma janela abriu depois do clique");
  log("Arquivos baixados:", respostas.length, respostas.map((r) => `${r.ct.split(";")[0]} ${Math.round(r.buf.length / 1024)}KB`).join(" | "));
  for (const [i, r] of respostas.filter((r) => /image/.test(r.ct) && r.buf.length > 30000).slice(0, 4).entries()) {
    const cb = await codigosDeBarras(r.buf), txt = await ocr(r.buf), T = txt.toUpperCase().replace(/\s+/g, " ");
    const lista = Array.isArray(cb) ? cb : [];
    const nossa = lista.filter((c) => /^\d{12,14}$/.test(c) && c.includes(num));
    log(`Foto ${i + 1}: códigos lidos ${Array.isArray(cb) ? lista.length : "erro " + cb.erro} · algum com a NF: ${nossa.length ? "sim" : "não"}${nossa.length ? " · volume/total pelo código: " + nossa.map((c) => c.slice(-4, -2) + "/" + c.slice(-2)).join(", ") : ""}`);
    log(`   leitura de texto: ${txt ? txt.length + " letras" : "falhou"} · tem a NF: ${T.includes(num) ? "sim" : "não"} · "VOL. NF" ${(T.match(/VOL\.?\s*NF\s*:?\s*(\d{1,2})\s*\/\s*(\d{1,2})/) || []).slice(1).join("/") || "não achei"} · códigos de volume ${[...new Set(T.match(/\b\d{5}\.\d{4}\b/g) || [])].join(", ") || "nenhum"}`);
  }
}
