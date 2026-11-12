// Passo rápido do robô da Intelipost: só monta o navegador se houver pedido pendente.
import { entrarSupabase, contarIntelipost, saida } from "./supa.mjs";
await entrarSupabase();
const tem = await contarIntelipost();
console.log(tem ? "Há pedido na fila da Intelipost." : "Fila da Intelipost vazia.");
saida("tem", tem ? "sim" : "nao");
