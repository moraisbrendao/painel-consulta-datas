// Preventivo · Links das transportadoras (Brenda 26/11): um link fixo por transportadora (retorno.html#t=TOKEN), sem login,
// onde ela vê só os pedidos dela sem retorno e informa a nova data + motivo. A resposta cai direto nas tratativas (fonte 'link').
// O token só aparece uma vez, na hora de gerar; o banco guarda só o hash (parte 82).
(function () {
  const $ = (id) => document.getElementById(id);
  if (!$("lk-box")) return;
  const sb = () => window.__sb;
  const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n) => Number(n || 0).toLocaleString("pt-BR");
  const quando = (ts) => (ts ? new Date(ts).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(",", " às") : "—");
  const hojeISO = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  const amanha = () => { const d = new Date(hojeISO() + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
  const toast = (msg, erro) => { const t = $("toast"); if (!t) return; t.textContent = msg; t.classList.toggle("erro", !!erro); t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), erro ? 6000 : 3500); };
  // VM Transportes e Tempo Justo são a mesma (regra da Brenda): um link só para as duas
  const grupo = (t) => (/tempo\s*justo|^\s*vm\b|vm transportes/i.test(t || "") ? "VM Transportes / Tempo Justo" : (t || "").trim());
  let links = [], ok = true, novo = null;

  const base = () => (window.__basePainel ? window.__basePainel(false) : []) || [];
  // mesma regra da função link_pendentes: já expedido, sem nova data válida, atrasado / vence até amanhã / nova data vencida
  function pendentes(nomes) {
    const S = new Set(nomes), h = hojeISO(), am = amanha();
    return base().filter((p) => {
      if (!S.has(p.transportadora) || p.entregue_ip || !p.data_expedicao) return false;
      const t = p._t || {}, nova = t.nova_data || null, prom = p.prev_original || p.prev_atual || null;
      if (nova && nova >= h) return false;
      return (prom && prom <= am) || /^vencido/i.test(p.range_atrasos || "") || (nova && nova < h);
    }).length;
  }

  async function carregar() {
    const r = await sb().from("transp_links").select("id,nome,transportadoras,ativo,criado_por,criado_em,ultimo_acesso,acessos,ultima_resposta,respostas").order("nome");
    if (r.error) { ok = false; links = []; } else { ok = true; links = r.data || []; }
    desenhar();
  }

  function desenhar() {
    if (!ok) { $("lk-info").textContent = "Para usar os links, rode a parte 82 no Supabase."; $("lk-linhas").innerHTML = ""; return; }
    const ativos = links.filter((l) => l.ativo);
    $("lk-info").textContent = ativos.length ? `${fmt(ativos.length)} link(s) ativo(s). A transportadora abre o link, vê só os pedidos dela sem retorno e informa a nova data e o motivo; a resposta cai na hora aqui no Preventivo.`
      : "Nenhum link ainda. Escolha a transportadora e clique em Gerar link.";
    // transportadoras da base (agrupando VM/Tempo Justo)
    const g = new Map(); base().forEach((p) => { if (!p.transportadora) return; const k = grupo(p.transportadora); if (!g.has(k)) g.set(k, new Set()); g.get(k).add(p.transportadora); });
    const sel = $("lk-transp"), atual = sel.value;
    sel.innerHTML = `<option value="">Escolha a transportadora…</option>` + [...g.keys()].sort((a, b) => a.localeCompare(b, "pt-BR")).map((k) => `<option value="${esc(k)}">${esc(k)}</option>`).join("");
    sel.value = atual; lkGrupos = g;
    $("lk-linhas").innerHTML = ativos.map((l) => `<tr>
        <td><b>${esc(l.nome)}</b>${l.transportadoras.length > 1 ? `<div class="s">${esc(l.transportadoras.join(" · "))}</div>` : ""}</td>
        <td class="num">${fmt(pendentes(l.transportadoras))}</td>
        <td>${quando(l.ultimo_acesso)}<div class="s">${fmt(l.acessos)} acesso(s)</div></td>
        <td>${quando(l.ultima_resposta)}<div class="s">${fmt(l.respostas)} pedido(s) respondido(s)</div></td>
        <td class="s">${quando(l.criado_em)}${l.criado_por ? "<br>" + esc(String(l.criado_por).split("@")[0]) : ""}</td>
        <td><button class="btn mini contorno" data-lk-novo="${esc(l.nome)}" title="Gera outro link e desativa este (use se o link vazou ou se perdeu)">↻ Novo link</button>
            <button class="btn mini contorno" data-lk-off="${l.id}" title="O link para de funcionar">Desativar</button></td></tr>`).join("")
      || `<tr><td colspan="6" class="vazio">Nenhum link ativo.</td></tr>`;
    $("lk-novo").hidden = !novo;
    if (novo) {
      $("lk-novo-nome").textContent = novo.nome; $("lk-url").value = novo.url;
      $("lk-msg").value = `Olá, equipe ${novo.nome}! Este é o link fixo da Multimóveis para informar a nova data de entrega dos nossos pedidos em atraso:\n${novo.url}\n\nÉ só abrir (não precisa de login), colocar a nova data, escolher o motivo e clicar em Salvar. A lista se atualiza sozinha todo dia e mostra só os pedidos que ainda estão sem data. Obrigado!`;
    }
  }
  let lkGrupos = new Map();

  async function gerar(nomeGrupo) {
    const nomes = [...(lkGrupos.get(nomeGrupo) || [])];
    if (!nomes.length) return toast("Escolha a transportadora.", true);
    const b = new Uint8Array(24); crypto.getRandomValues(b);
    const token = btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))].map((x) => x.toString(16).padStart(2, "0")).join("");
    const antigos = links.filter((l) => l.ativo && l.nome === nomeGrupo).map((l) => l.id);
    if (antigos.length) { const r0 = await sb().from("transp_links").update({ ativo: false }).in("id", antigos); if (r0.error) return toast("Não consegui desativar o link antigo: " + r0.error.message, true); }
    const r = await sb().from("transp_links").insert({ nome: nomeGrupo, transportadoras: nomes, token_hash: hash });
    if (r.error) return toast("Não consegui gerar o link: " + r.error.message, true);
    const url = new URL("retorno.html", location.href.split("#")[0]).href + "#t=" + token;
    novo = { nome: nomeGrupo, url };
    toast(antigos.length ? "Link novo gerado (o antigo parou de funcionar)." : "Link gerado.");
    await carregar();
  }

  const copiar = (txt) => (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(() => toast("Copiado."), () => toast("Selecione e copie com Ctrl+C.", true));
  $("lk-gerar").addEventListener("click", () => gerar($("lk-transp").value));
  $("lk-copiar-url").addEventListener("click", () => copiar($("lk-url").value));
  $("lk-copiar-msg").addEventListener("click", () => copiar($("lk-msg").value));
  $("lk-fechar").addEventListener("click", () => { novo = null; desenhar(); });
  $("lk-box").addEventListener("click", async (e) => {
    const n = e.target.closest("[data-lk-novo]"); if (n) { if (confirm(`Gerar um link novo para ${n.dataset.lkNovo}? O link atual para de funcionar e você precisa mandar o novo para eles.`)) gerar(n.dataset.lkNovo); return; }
    const o = e.target.closest("[data-lk-off]"); if (o) {
      if (!confirm("Desativar este link? A transportadora não consegue mais abrir.")) return;
      const r = await sb().from("transp_links").update({ ativo: false }).eq("id", +o.dataset.lkOff);
      if (r.error) return toast(r.error.message, true); toast("Link desativado."); carregar();
    }
  });
  // carrega quando o Preventivo estiver aberto (a base já carregada dá os nomes das transportadoras e os pendentes)
  let tentou = false, ultima = 0;
  const tick = () => {
    if (!$("lk-box").offsetParent || !window.__sb || !base().length) return;
    if (!tentou || (!novo && Date.now() - ultima > 120000 && document.activeElement !== $("lk-transp"))) { tentou = true; ultima = Date.now(); carregar(); }
  };
  setInterval(tick, 3000);
})();
