// Robô do portal de ocorrências (ccp.360multi.com).
// Pega o pedido mais antigo da fila do painel e, para cada grupo (micro status x transportadora):
// Importar Ocorrências -> arquivo (Nota, Serie) -> Importar -> motivo em massa -> transportadora ->
// confere as notas -> Enviar Notas -> espera "enviadas com sucesso". No modo teste, não envia.
// Os registros (logs) do GitHub são públicos: aqui só aparecem contagens, nunca números de nota.
import { chromium } from "playwright";
import XLSX from "xlsx";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entrarSupabase, pegarPedido, atualizarPedido, registrarCadastradas } from "./supa.mjs";

const PORTAL = process.env.PORTAL_URL_TESTE || "https://ccp.360multi.com";
const pasta = mkdtempSync(join(tmpdir(), "robo-"));
const re = (t) => new RegExp("^\\s*" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*$", "i");
const agora = () => new Date().toISOString();

await entrarSupabase();
const pedido = await pegarPedido();
if (!pedido) { console.log("Nada na fila."); process.exit(0); }
const grupos = pedido.grupos || [];
console.log(`Pedido ${pedido.id}: ${grupos.length} arquivo(s)${pedido.teste ? " (TESTE, sem enviar)" : ""}.`);
const resultado = [];

async function terminar(status) {
  await atualizarPedido(pedido.id, { status, resultado, terminado_em: agora() });
  console.log(`Fim: ${resultado.filter((r) => r.status === "ok").length} ok, ${resultado.filter((r) => r.status !== "ok").length} com problema.`);
}

const navegador = await chromium.launch(process.env.CHROME_TESTE ? { executablePath: process.env.CHROME_TESTE } : {});
const pagina = await (await navegador.newContext({ viewport: { width: 1440, height: 900 }, locale: "pt-BR" })).newPage();
pagina.setDefaultTimeout(20000);

try {
  // ---- login ----
  const { PORTAL_EMAIL, PORTAL_SENHA } = process.env;
  if (!PORTAL_EMAIL || !PORTAL_SENHA) throw new Error("Faltam os segredos PORTAL_EMAIL e PORTAL_SENHA no GitHub.");
  await pagina.goto(`${PORTAL}/login`);
  await pagina.locator("input[name=email]").fill(PORTAL_EMAIL);
  await pagina.locator("input[name=password]").fill(PORTAL_SENHA);
  await pagina.locator("form button[type=submit]").click();
  try { await pagina.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 }); }
  catch { throw new Error("Não consegui entrar no portal: confira o login e a senha guardados no GitHub (PORTAL_EMAIL / PORTAL_SENHA)."); }
} catch (e) {
  resultado.push({ status: "erro", msg: e.message });
  await navegador.close(); await terminar("erro"); process.exit(0);
}

async function escolher(gatilho, nome, posicao, oQue) {
  await gatilho.click();
  const lista = pagina.locator("[role=listbox][data-slot=select-content]");
  await lista.waitFor();
  const opcoes = lista.locator("[role=option]").filter({ hasText: re(nome) });
  if ((await opcoes.count()) <= posicao) {
    await pagina.keyboard.press("Escape");
    throw new Error(`${oQue} "${nome}" não existe no portal.`);
  }
  const op = opcoes.nth(posicao);
  for (let i = 0; ; i++) {
    try { await op.click({ timeout: 1500 }); break; }
    catch (e) {
      if (i > 60) throw new Error(`Não consegui escolher ${oQue.toLowerCase()} "${nome}".`);
      const desce = pagina.locator("[data-slot=select-scroll-down-button]");
      if (await desce.count()) await desce.first().hover();
      await pagina.waitForTimeout(400);
    }
  }
  await pagina.waitForTimeout(300);
  const texto = (await gatilho.innerText()).trim();
  if (!re(nome).test(texto)) throw new Error(`${oQue} ficou "${texto}" em vez de "${nome}".`);
}

async function importar(g, n) {
  await pagina.goto(`${PORTAL}/occurrences`);
  await pagina.getByRole("button", { name: /Importar( Ocorrências)?/ }).first().click();
  const modal = pagina.locator("[role=dialog][data-state=open]");
  await modal.waitFor();

  const arq = join(pasta, `grupo${n}.xlsx`);
  const linhas = [["Nota", "Serie"], ...g.notas.map((x) => [/^\d+$/.test(x.nf) ? Number(x.nf) : x.nf, /^\d+$/.test(x.serie) ? Number(x.serie) : x.serie])];
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(linhas), "Planilha1");
  writeFileSync(arq, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
  await modal.locator("input[type=file]").setInputFiles(arq);
  await modal.getByRole("button", { name: re("Importar") }).click();
  await pagina.locator("li[data-sonner-toast]").filter({ hasText: /importado com sucesso/i }).first().waitFor({ timeout: 30000 });

  // confere as notas carregadas (no máximo 10 por arquivo = 1 página)
  const linhasTab = modal.locator("table tbody tr");
  await pagina.waitForFunction((n) => document.querySelectorAll("[role=dialog][data-state=open] table tbody tr").length === n, g.notas.length, { timeout: 15000 })
    .catch(() => { throw new Error(`O portal carregou um número de notas diferente de ${g.notas.length}.`); });
  const nfsTab = (await linhasTab.locator("td:first-child").allInnerTexts()).map((t) => t.trim().replace(/^0+/, ""));
  const faltam = g.notas.filter((x) => !nfsTab.includes(String(x.nf).replace(/^0+/, "")));
  if (faltam.length) throw new Error(`${faltam.length} nota(s) não apareceram na tabela do portal.`);

  const gatilhos = modal.locator("button[role=combobox][data-slot=select-trigger]");
  await escolher(gatilhos.nth(0), g.motivo, 0, "Motivo");
  await escolher(gatilhos.nth(1), g.transportadora, g.posicao || 0, "Transportadora");
  const motivos = (await linhasTab.locator("button[role=combobox]").allInnerTexts()).map((t) => t.trim());
  if (motivos.length !== g.notas.length || motivos.some((t) => !re(g.motivo).test(t)))
    throw new Error("O motivo em massa não foi aplicado em todas as notas.");

  if (pedido.teste) { await pagina.keyboard.press("Escape"); return; }

  await modal.getByRole("button", { name: re("Enviar Notas") }).click();
  try {
    await pagina.locator("li[data-sonner-toast]").filter({ hasText: /enviadas com sucesso/i }).first().waitFor({ timeout: 120000 });
  } catch {
    throw new Error("O portal não confirmou o envio em 2 minutos. Confira essas notas no portal antes de mandar de novo.");
  }
}

let n = 0;
for (const g of grupos) {
  n++;
  const base = { ms: g.ms, motivo: g.motivo, transportadora: g.transportadora, notas: g.notas.length };
  try {
    await importar(g, n);
    resultado.push({ ...base, status: "ok" });
    if (!pedido.teste) {
      await registrarCadastradas(g.notas.map((x) => ({ nf: x.nf, serie: x.serie, motivo: g.motivo })))
        .catch((e) => console.log("Aviso: enviado, mas não consegui marcar no painel: " + e.message));
    }
    console.log(`Arquivo ${n}/${grupos.length}: ok (${g.notas.length} notas).`);
  } catch (e) {
    resultado.push({ ...base, status: "erro", msg: String(e.message || e).split("\n")[0].slice(0, 300) });
    console.log(`Arquivo ${n}/${grupos.length}: problema.`);
  }
  await atualizarPedido(pedido.id, { resultado }).catch(() => {});
}

await navegador.close();
await terminar(resultado.some((r) => r.status === "ok") || !resultado.length ? "feito" : "erro");
