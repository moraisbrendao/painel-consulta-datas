// Recolher / abrir o menu lateral (lembra a escolha neste navegador)
(function () {
  const tela = document.getElementById("tela-painel"), bt = document.getElementById("btn-recolher");
  if (!tela || !bt) return;
  document.querySelectorAll("#tela-painel .menu-item").forEach((b) => { if (!b.title) b.title = b.textContent.replace(/\s+/g, " ").trim(); });
  const aplicar = (r) => { tela.classList.toggle("menu-recolhido", r); bt.textContent = r ? "»" : "«"; bt.title = r ? "Abrir menu" : "Recolher menu"; bt.setAttribute("aria-label", bt.title); };
  let r = false; try { r = localStorage.getItem("painel.menuRecolhido") === "1"; } catch (e) {}
  aplicar(r);
  bt.addEventListener("click", () => { r = !r; aplicar(r); try { localStorage.setItem("painel.menuRecolhido", r ? "1" : "0"); } catch (e) {} });
})();
// botão ❔ Ajuda do topo: passo a passo da aba aberta
(function () {
  const b = document.getElementById("btn-ajuda"); if (!b) return;
  b.addEventListener("click", () => { const at = document.querySelector("#tela-painel .menu-item.ativo"); if (window.__abrirAjuda) window.__abrirAjuda(at ? at.dataset.pagina : "rotina"); });
})();
// Celular (iPhone): menu em gaveta (☰), ações do topo no ⋯ e filtros recolhíveis
(function () {
  const tela = document.getElementById("tela-painel"), fundo = document.getElementById("menu-fundo");
  const bm = document.getElementById("btn-menu-movel"), ba = document.getElementById("btn-acoes-movel");
  if (!tela || !bm) return;
  const movel = () => window.matchMedia("(max-width: 760px)").matches;
  const gaveta = (abrir) => { tela.classList.toggle("menu-aberto", abrir); if (fundo) fundo.hidden = !abrir; document.body.classList.toggle("sem-rolagem", abrir); };
  bm.addEventListener("click", () => gaveta(!tela.classList.contains("menu-aberto")));
  if (fundo) fundo.addEventListener("click", () => gaveta(false));
  tela.querySelectorAll(".menu-lateral .menu-item").forEach((b) => b.addEventListener("click", () => { if (movel()) { gaveta(false); window.scrollTo(0, 0); } }));
  if (ba) ba.addEventListener("click", () => { const ab = tela.classList.toggle("acoes-abertas"); ba.setAttribute("aria-expanded", ab ? "true" : "false"); });
  document.addEventListener("click", (e) => { if (movel() && tela.classList.contains("acoes-abertas") && !e.target.closest(".topo-direita, #btn-acoes-movel")) tela.classList.remove("acoes-abertas"); });
  // filtros: no celular começam recolhidos; tocar em "⛉ Filtros" abre/fecha
  document.addEventListener("click", (e) => {
    const r = e.target.closest(".filtros-rot"); if (!r || !movel()) return;
    const c = r.closest(".filtros-cartao, .filtros-topo, .filtros"); if (c) c.classList.toggle("f-aberto");
  });
})();
