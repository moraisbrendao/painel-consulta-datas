// =====================================================================
// Regras de padronização dos retornos das transportadoras.
// Funções puras (sem tela), usadas pelo painel.
// =====================================================================
(function (raiz) {
  "use strict";

  // Tira acentos, deixa maiúsculo e junta espaços repetidos
  function normalizar(s) {
    return String(s ?? "")
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .toUpperCase().replace(/\s+/g, " ").trim();
  }

  // Monta a lista de categorias na ordem em que foram criadas
  // regras: [{id, categoria, termo}]
  function agruparRegras(regras) {
    const ordem = [];
    const mapa = new Map();
    [...regras].sort((a, b) => a.id - b.id).forEach((r) => {
      if (!mapa.has(r.categoria)) {
        mapa.set(r.categoria, { categoria: r.categoria, regras: [] });
        ordem.push(mapa.get(r.categoria));
      }
      mapa.get(r.categoria).regras.push(r);
    });
    return ordem;
  }

  // Devolve a categoria do texto (ou null). Vale a primeira categoria da lista que bater.
  function categorizar(texto, grupos) {
    const t = normalizar(texto);
    if (!t) return null;
    for (const g of grupos) {
      for (const r of g.regras) {
        const termo = normalizar(r.termo);
        if (termo && t.includes(termo)) return g.categoria;
      }
    }
    return null;
  }

  function iso(a, m, d) {
    return `${a}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  function dataValida(a, m, d) {
    const dt = new Date(Date.UTC(a, m - 1, d));
    return dt.getUTCFullYear() === a && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }

  // Procura datas no texto (dd/mm, dd/mm/aa, dd/mm/aaaa, dd.mm).
  // Sem ano, usa o ano que deixa a data mais perto do dia do retorno.
  // Se tiver mais de uma (ex.: "entre 06/11 e 09/11"), fica a última (mais longe).
  // referencia: "aaaa-mm-dd" (dia do retorno)
  function acharData(texto, referencia) {
    const s = String(texto ?? "");
    const ref = referencia ? new Date(referencia + "T12:00:00Z") : new Date();
    const re = /(?<![\d\/.-])(\d{1,2})[\/.](\d{1,2})(?:[\/.](\d{4}|\d{2}))?(?![\d\/]|\.\d)/g;
    let melhor = null;
    let m;
    while ((m = re.exec(s))) {
      const d = +m[1], mes = +m[2];
      if (d < 1 || d > 31 || mes < 1 || mes > 12) continue;
      let anos;
      if (m[3]) {
        let a = +m[3];
        if (a < 100) a += 2000;
        anos = [a];
      } else {
        const a0 = ref.getUTCFullYear();
        anos = [a0 - 1, a0, a0 + 1];
      }
      let escolhido = null, dist = Infinity;
      for (const a of anos) {
        if (!dataValida(a, mes, d)) continue;
        const diff = Math.abs(Date.UTC(a, mes - 1, d) - ref.getTime());
        if (diff < dist) { dist = diff; escolhido = iso(a, mes, d); }
      }
      if (escolhido && (!melhor || escolhido > melhor)) melhor = escolhido;
    }
    return melhor;
  }

  const api = { normalizar, agruparRegras, categorizar, acharData };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.Padronizacao = api;
})(typeof window !== "undefined" ? window : globalThis);
