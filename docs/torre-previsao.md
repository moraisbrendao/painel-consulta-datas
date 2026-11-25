# Torre de Controle → E-loggia: envio de previsões logísticas (MVP)

A previsão é uma **estimativa logística**, não uma promessa de entrega. Ela não substitui a promessa original do pedido.

## Endereço e autenticação
- `POST https://qncselfuymeximgmetjp.supabase.co/functions/v1/torre-previsao`
- Cabeçalhos: `Authorization: Bearer <TORRE_PREVISAO_TOKEN>` e `Content-Type: application/json`
- Token errado ou ausente → `401`.

## Corpo
Um objeto ou uma lista (até 1000 por envio):

```json
[
  {
    "pedido": "123456789",
    "nf": "98765-4",
    "previsao": "2026-12-02",
    "confianca": "media",
    "situacao": "Em transferência para o CD de destino",
    "revisao": 3,
    "calculada_em": "2026-11-25T14:30:00-03:00"
  }
]
```

| Campo | Obrigatório | Regra |
|---|---|---|
| pedido | sim (ou nf) | Pedido Intelipost, o mesmo número que o E-loggia usa |
| nf | só se não houver pedido | "numero-serie"; usado apenas se essa NF tiver um único pedido na base |
| previsao | sim | data `AAAA-MM-DD` |
| revisao | sim | número inteiro que aumenta a cada nova previsão do mesmo pedido |
| confianca | não | `alta`, `media` ou `baixa` |
| situacao | não | texto curto (até 120 caracteres), sem dados de cliente |
| calculada_em | não | data/hora ISO 8601 de quando a Torre calculou |

## Regras
- Revisão maior que a guardada → atualiza (`atualizada`).
- Mesma revisão → nada muda (`duplicada`), pode reenviar sem medo.
- Revisão menor → ignorada (`antiga`).
- Pedido que não está na base → `pedido_nao_encontrado`. Formato errado → `invalida`.
- Todo recebimento fica registrado no histórico.

## Resposta
`200` com `{"ok":true,"recebidas":N,"resumo":{"nova":1,...},"resultados":[{"pedido":"…","nf":"…","resultado":"nova"}]}`.
`400` JSON inválido/vazio, `401` token, `413` mais de 1000, `500` falha ao gravar (pode reenviar o mesmo lote).
