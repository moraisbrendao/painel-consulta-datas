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
