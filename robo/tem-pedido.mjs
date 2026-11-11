// Passo rápido: só abre o navegador se houver pedido na fila.
import { entrarSupabase, temPedido, saida } from "./supa.mjs";
await entrarSupabase();
const tem = await temPedido();
console.log(tem ? "Há pedido na fila do robô." : "Fila vazia.");
saida("tem", tem ? "sim" : "nao");
