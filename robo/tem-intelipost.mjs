// Passo rápido do robô da Intelipost: só monta o navegador se houver pedido pendente (nova data ou troca de notas).
import { entrarSupabase, contarIntelipost, temTroca, saida } from "./supa.mjs";
await entrarSupabase();
const tem = (await contarIntelipost()) || (await temTroca());
console.log(tem ? "Há trabalho na fila da Intelipost." : "Fila da Intelipost vazia.");
saida("tem", tem ? "sim" : "nao");
