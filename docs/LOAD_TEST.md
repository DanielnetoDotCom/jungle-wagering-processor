# Teste de carga

> Números medidos, não estimados. Os relatórios JSON brutos ficam em `reports/` (ignorado pelo Git) e são regenerados a cada execução. Não há meta de RPS: o objetivo é mostrar como o sistema se comporta sob concorrência real e se as invariantes financeiras continuam válidas no fim.

## Ambiente

| Item | Valor |
|---|---|
| Host | Windows 11 Pro, Intel Core i5-12400 (6 núcleos / 12 threads), 31,8 GB RAM |
| Docker | Docker Desktop 29.7.2 (backend WSL2, kernel 6.6.87.2), 12 vCPUs e 15,5 GB disponíveis para os containers |
| Topologia | `docker compose up -d --build`: nginx + **3 api** + **3 consumer** + **2 outbox-worker** + 1 reference-worker + PostgreSQL 17 + LocalStack 4.14 (SQS) |
| Runtime | Bun 1.4.3, código compilado (`tsc`), `NODE_ENV=production` |
| Pools PostgreSQL | api 10 conexões × 3, consumer 5 × 3, outbox 3 × 2, reference 3 (54 no total) |
| Gerador de carga | `toolbox` (mesmo host, rede Docker interna), cliente `fetch` do Bun com keep-alive |

Todos os componentes, inclusive o gerador de carga, disputam a mesma CPU. É um ambiente de desenvolvimento, não um benchmark de produção (ver "Limitações do experimento").

As execuções aconteceram antes das correções finais da revisão de código ([TEST_REPORT.md](TEST_REPORT.md), itens 5 a 9): pausa do consumidor em queda do banco, correlation id limitado, normalização de UUID, inbox de mensagem nunca processada e timestamps monotônicos. Nenhuma delas atua no caminho medido sem falhas, e por isso os números continuam representativos. Para remedir: `bun run test:load`.

## Metodologia

Comando (reprodutível):

```bash
docker compose up -d --build
docker compose --profile tools run --rm toolbox bun run test:load
# variações por variáveis de ambiente, por exemplo:
docker compose --profile tools run --rm -e LOAD_HOT_WALLET_SHARE=0 toolbox bun run test:load
```

Script: [`scripts/load-test/load-test.ts`](../scripts/load-test/load-test.ts).

1. **Preparação**: cria 200 wallets com saldo 100.000,00 BRL e 1 *hot wallet* com 1.000.000,00 BRL (saldo alto para que nenhuma aposta seja rejeitada por falta de saldo e o resultado esperado seja determinístico).
2. **Carga por 60s, simultaneamente**:
   - **HTTP**: 32 usuários virtuais em laço fechado contra o nginx (porta 8080 → 3 réplicas). Cada iteração é BET (60%) ou WIN (40%) de 1,00 a 19,99 BRL. Por padrão 15% das operações vão para a hot wallet e 10% são **reenvios idênticos** de requisições anteriores (mesma `Idempotency-Key`, mesmo payload).
   - **SQS**: produtor enviando ~50 msg/s para `wager-transactions.fifo` (`MessageGroupId` = walletId). Cerca de 10% das mensagens são **entregues duas vezes** (mesmo `messageId`, `MessageDeduplicationId` diferente), forçando a deduplicação pelo inbox.
3. **Drenagem**: espera o outbox ficar sem eventos `PENDING`, não restar `PENDING_REFERENCE` e o inbox registrar todas as mensagens únicas.
4. **Coleta**:
   - latência HTTP (p50/p95/p99/máx) medida no cliente;
   - latência SQS ponta a ponta: envio pelo produtor → `created_at` da transação gravada pelo consumidor;
   - lag do outbox: `published_at − occurred_at` de cada evento (percentis calculados no PostgreSQL);
   - contadores Prometheus somados em **todas** as réplicas (DNS do Docker → um IP por réplica): contenção de lock, retries, deadlocks, lock timeouts, replays e duplicatas do inbox.
5. **Verificação final**: `POST /wallets/:id/reconciliation` para **todas** as 201 wallets, mais a checagem de saldos negativos no banco.

## Resultados

Três execuções de 60s com os mesmos parâmetros, exceto o indicado:

| Métrica | A: hot 15% (antes do ajuste de timestamp) | **B: hot 15% (versão final)** | C: sem hot wallet |
|---|---|---|---|
| Requisições HTTP | 17.191 | **15.808** | 20.288 |
| Throughput HTTP | 285,2 req/s | **262,2 req/s** | 337,6 req/s |
| Latência HTTP p50 / p95 / p99 | 42 / 551 / 767 ms | **48 / 616 / 863 ms** | 86 / 184 / 239 ms |
| Latência HTTP máxima | 1.797 ms | **1.867 ms** | 403 ms |
| Hot wallet p50 / p95 / p99 | 488 / 803 / 1.125 ms | **535 / 903 / 1.117 ms** | — |
| Operações na hot wallet | 2.367 | **2.098** | 0 |
| Status HTTP | 201: 15.509, 200: 1.682 | **201: 14.118, 200: 1.690** | 201: 18.314, 200: 1.974 |
| Taxa de erro (5xx / rede) | 0% | **0%** | 0% |
| Mensagens SQS enviadas (duplicatas) | 2.760 (221) | **2.740 (242)** | 2.670 (213) |
| SQS ponta a ponta p50 / p95 / p99 | 32 / 119 / 224 ms | **46 / 160 / 420 ms** | 52 / 146 / 240 ms |
| Lag do outbox p50 / p95 / p99 / máx | 97 / 571 / 802 / 1.915 ms | **90 / 219 / 421 / 587 ms** | 165 / 506 / 826 / 1.021 ms |
| Eventos publicados | 36.096 | **33.232** | 41.542 |
| Esperas por lock de wallet (contenção) | 3.097 | **2.867** | 2.126 |
| Retries de transação / deadlocks / lock timeouts | 0 / 0 / 0 | **0 / 0 / 0** | 0 / 0 / 0 |
| Replays idempotentes (HTTP) | 1.682 | **1.690** | 1.974 |
| Duplicatas absorvidas pelo inbox | 221 | **242** | 213 |
| Retries SQS / mensagens na DLQ | 0 / 0 | **0 / 0** | 0 / 0 |
| Wallets reconciliadas / inconsistentes | 201 / 0 | **201 / 0** | 201 / 0 |
| Saldos negativos | 0 | **0** | 0 |

Em todas as execuções:

- **Nenhuma divergência** entre saldo materializado e ledger, em 201 wallets.
- Cada replay HTTP respondeu `200` com o resultado original. O número de replays medido pelo servidor é **exatamente** igual ao de reenvios do cliente (1.690 = 1.690 na execução B).
- Cada duplicata SQS foi absorvida pelo inbox: 242 enviadas, 242 contadas em `wagering_inbox_duplicates_total`.
- A versão final da hot wallet é igual ao número de operações aplicadas mais o OPENING (2.099 = 2.098 + 1): nenhuma operação foi aplicada duas vezes.

## Análise

### 1. Hot wallet: o custo do lock pessimista é localizado e mensurável

Toda alteração de uma wallet é serializada pelo `SELECT … FOR UPDATE` da sua linha. Com ~15% de 32 usuários virtuais (~5 em média) disputando a mesma wallet, cada requisição espera, em mediana, que as anteriores façam commit (p50 de 535ms na hot wallet). Isso é o comportamento desejado: correção antes de throughput. O efeito colateral aparece na comparação B × C:

- Sem hot wallet, o p95 geral cai de 616ms para 184ms e o p99 de 863ms para 239ms.
- A causa é que **quem espera o lock segura uma conexão do pool** enquanto espera. As requisições da hot wallet ocupam parte das 30 conexões das APIs, e requisições de outras wallets passam a esperar por conexão. A hot wallet não bloqueia as outras wallets no banco (não há lock global; o teste `different wallets never block each other` comprova isso), mas compete com elas por um recurso compartilhado do processo.
- O p50 menor na execução B (48ms × 86ms em C) não indica que B seja mais rápida. Em B parte dos usuários fica "estacionada" na hot wallet, e os demais encontram o banco menos ocupado.

Mitigações possíveis, não implementadas porque não melhoram a correção: (a) fila em memória por wallet dentro de cada instância (*single-flight*), que reduz conexões ociosas sem substituir o lock do banco; (b) pool dedicado ou `lock_timeout` menor para wallets reconhecidamente quentes, devolvendo `503 LOCK_TIMEOUT` (retryable) mais cedo; (c) particionar o saldo de wallets institucionais em sub-wallets. Ver ADR-005 no [ARCHITECTURE.md](../ARCHITECTURE.md).

### 2. Nenhum retry, deadlock ou lock timeout

Com uma única wallet por operação e ordem de locks fixa (wallet → transação → demais linhas), deadlocks não ocorreram sob carga. A recuperação de deadlock é testada à parte, de forma determinística (`test/concurrency/locks-and-deadlocks.test.ts`). O `lock_timeout` de 5s nunca foi atingido; a maior latência HTTP observada, que inclui a espera pelo lock, foi de cerca de 1,9s.

### 3. Lag do outbox e um ajuste feito por causa deste teste

Na execução A, o lag do outbox (p95 571ms) acompanhava a latência HTTP. A investigação mostrou que o instante da operação (`occurred_at`, `processed_at`, `created_at` do ledger) era capturado **antes** de adquirir o lock da wallet, e portanto incluía o tempo de espera. Além de distorcer o lag, isso permitia que a versão N+1 de uma wallet tivesse timestamp anterior ao da versão N.

A correção passou a capturar o instante **depois** do lock (`process-wager-transaction.use-case.ts` e `resolve-pending-reference.use-case.ts`). Também acrescentei a toda a suíte de testes a verificação de que `created_at` do ledger é não-decrescente por versão. Na execução B, o lag passou a medir de fato commit → publicação: p95 219ms, máximo 587ms.

Na execução C (mais eventos por segundo: 692/s contra 554/s em B) o lag sobe novamente (p95 506ms). Isso indica que 2 publishers com lote de 50 eventos e envio sequencial dos `SendMessageBatch` estão perto da capacidade neste ambiente. É ajustável com `OUTBOX_BATCH_SIZE`, `OUTBOX_POLL_INTERVAL_MS` e réplicas de `outbox-worker` (o claim com `SKIP LOCKED` escala horizontalmente).

### 4. SQS

Os consumidores acompanharam os ~46 msg/s sem fila acumulada (drenagem ≤ 1s após o fim da carga), com p95 ponta a ponta de 146 a 160ms. Não houve retries nem DLQ.

## Limitações do experimento

- Um único host executa todos os componentes **e** o gerador de carga: os números refletem disputa de CPU entre eles, não o limite de nenhum componente isolado.
- Docker Desktop no Windows (WSL2) adiciona latência de rede virtual entre containers. Em Linux nativo os números tendem a ser melhores.
- LocalStack não reproduz latência, limites nem throttling do SQS real.
- PostgreSQL com configuração padrão (exceto `max_connections=200`, `shared_buffers=256MB`), em volume Docker.
- Execuções de 60s não mostram efeitos de longo prazo (crescimento de tabelas, autovacuum, retenção do outbox/inbox).
- Carga em laço fechado: a taxa de chegada se ajusta à latência e não testa sobrecarga por taxa fixa (*open model*).
