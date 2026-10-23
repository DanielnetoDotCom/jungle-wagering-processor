# Relatório de testes

Execução após correções da auditoria: **22/10/2026**, Bun 1.4.3 em container de ferramentas, PostgreSQL 17 e LocalStack 4.14 reais no projeto descartável `jungle-fix-20261022-02`, com redes, volume e tags de imagem próprios. O stack original não foi atualizado nesta etapa. Para reproduzir pelo Compose do repositório: `docker compose --profile tools run --rm --build toolbox bun run verify`. Detalhes das correções, isolamento e limitações em [AUDIT_FIXES.md](AUDIT_FIXES.md).

`bun run verify` executa, em ordem e falhando no primeiro erro: **ESLint** (`--max-warnings=0`, regras com type-checking e fronteiras de camadas) → **Prettier** (`--check`) → **typecheck** (`tsc --noEmit`, modo estrito) → **`check:money`** → **build** (`tsc`) → **testes**.

## Resultado

| Suíte | Comando | Arquivos | Testes | Resultado | Duração |
|---|---|---|---|---|---|
| Unitários (domínio, contratos, hash e patches) | `bun run test:unit` | 10 | 151 | ✅ 151 pass | 0,3 s |
| Integração (PostgreSQL + LocalStack reais) | `bun run test:integration` | 10 | 99 | ✅ 99 pass | 62,0 s |
| Concorrência (paralelismo real, processos reais) | `bun run test:concurrency` | 4 | 12 | ✅ 12 pass | 25,2 s |
| Falhas (SIGKILL em pontos exatos) | `bun run test:fault` | 1 | 4 | ✅ 4 pass | 17,3 s |
| **Subtotal `bun run test`** | | **25** | **266** | ✅ **266 pass, 0 fail** | |
| E2E (processos compilados, banco/filas próprios) | `bun run test:e2e` | 1 | 7 | ✅ 7 pass | 8,1 s |
| Carga (execução histórica, não repetida nesta correção) | `bun run test:load` | — | — | 201 wallets reconciliadas, 0 inconsistências | ver LOAD_TEST.md |

Também verificados: `lint` ✅, `typecheck` ✅, `check:money` ✅ (98 arquivos), `build` ✅ (6 entrypoints compilados). **273 testes aprovados** incluindo E2E. Build Docker com lockfile congelado e patches, imagem de migration separada e smoke do Compose completo: jobs concluídos, serviços saudáveis, três APIs pelo nginx e reconciliação consistente. A verificação dos patches não elimina os dois alertas upstream que continuam aparecendo no `bun audit`; ver [AUDIT_FIXES.md](AUDIT_FIXES.md).

## Como os testes são isolados e realistas

- **Infraestrutura real.** Nenhum teste de integração usa mocks de PostgreSQL ou SQS. Mocks aparecem apenas nos unitários de domínio e, pontualmente, como *dublês de falha*: um publisher que falha sob comando e um use case que lança erro transitório.
- **Um banco por arquivo de teste** (`test/support/database.ts`): `CREATE DATABASE wagering_test_<rótulo>_<aleatório>`, migrations reais como owner, provisionamento do login de menor privilégio (como em produção) e `DROP DATABASE … WITH (FORCE)` ao final. Os serviços sob teste conectam com o **login de runtime**, não com superusuário.
- **Filas próprias por arquivo** (`test/support/sqs.ts`), criadas com a mesma topologia de produção (FIFO, DLQ, redrive).
- **Paralelismo real.** Promises concorrentes usam conexões diferentes do pool (até 50). Os cenários multi-instância sobem **processos do sistema operacional** independentes (`Bun.spawn` dos mesmos entrypoints dos containers), cada um com seu pool.
- **Falhas reais.** `FAULT_INJECTION=<ponto>=crash` faz o processo se matar com **SIGKILL** no ponto exato: depois do commit e antes do ack, depois de publicar e antes de confirmar, antes do commit. Nenhum hook de shutdown roda.
- **Tempo controlado.** Backoff, TTL e leases usam `ManualClock`, sem `sleep` longo.
- **Invariante final.** Toda suíte com escrita termina em `expectAllWalletsConsistent()`, que calcula em SQL puro (independente do código da aplicação): saldo = Σ ledger, versão = última linha, cadeia contínua, **timestamps do ledger não-decrescentes por versão** e nenhum saldo negativo.

## Cobertura dos testes obrigatórios do desafio (§13)

### Unidade

| Exigência | Onde |
|---|---|
| Money: escala, arredondamento, entradas inválidas | `unit/domain/money.test.ts`: 43 casos (NaN, Infinity, `1e3`, vazio, espaços, `25.5`, `25.001` sem arredondar, negativos, `+`, zeros à esquerda, separadores, overflow de 19 dígitos, `0.10+0.20`, 18 dígitos exatos, `-0`, imutabilidade, serialização) |
| Invariantes da Wallet | `unit/domain/wallet.test.ts`: versão 1 com OPENING, sem lançamento para saldo zero, débito/crédito com versão +1, saldo nunca negativo, moeda, overflow sem alterar estado, `rehydrate` |
| Regras BET, WIN, LOSS, REFUND, ROLLBACK | `unit/domain/wager-settlement.test.ts` (24) e `wager-transaction.test.ts` (18): máquina de estados, terminais, direção do ROLLBACK, referências inválidas, reversão dupla, reversão sem saldo, LOSS sem efeito, backoff/TTL |
| Conflito de moeda | `money.test.ts` (aritmética/comparação), `wallet.test.ts`, `wager-settlement.test.ts` (`CURRENCY_MISMATCH`) |
| Idempotency key com payload divergente | `unit/application/payload-hash.test.ts` (hash canônico, vetor fixo, ordem de chaves, exclusão de metadados) + `integration/wager-processing.test.ts` (409) |

### Integração (PostgreSQL e LocalStack reais)

| Exigência | Onde |
|---|---|
| Migrations e constraints | `migrations.test.ts` (up, down de um passo, down total, up de novo, no-op, grants) e `schema-guarantees.test.ts` (20 ataques diretos via SQL: unicidade, saldo negativo, versão, ledger append-only para owner **e** runtime, aritmética, cadeia, direção × tipo, FK de valor, transação PROCESSED sem ledger, terminal imutável, chaves de idempotência, reversão única, validação de referência, OPENING interno, inbox e outbox imutáveis) |
| Atomicidade entre wallet, ledger, inbox e outbox | `wager-processing.test.ts` → `a failure after every write but before COMMIT leaves no partial state` (HTTP e SQS); `outbox.test.ts` → `events are never visible before the financial commit` |
| Inbox e redelivery | `sqs-consumer.test.ts` (mesma mensagem 2×, HTTP e depois SQS, `messageId` reutilizado → DLQ) e `wager-processing.test.ts` (HTTP→SQS, SQS→HTTP, `DUPLICATE_MESSAGE`) |
| Publishers concorrentes sobre a mesma outbox | `outbox.test.ts` → `two concurrent publishers: disjoint claims (SKIP LOCKED), every event published exactly once` (60 eventos, `attempts = 1`) |
| Retry e DLQ | `sqs-consumer.test.ts` → transitório com backoff e sucesso único; DLQ pelo consumidor após `maxAttempts` tentativas reais, com auditoria no inbox; mensagens atrás de uma cabeça de grupo FIFO que falha mantêm o próprio orçamento (nunca vão para a DLQ sem processamento); inválidas direto para a DLQ com auditoria no inbox; queda do banco maior que o orçamento de tentativas **pausa** o consumo sem DLQ; `messageId` de 256 caracteres processado normalmente |
| Recuperação após reinicialização | `fault-injection/crash-recovery.test.ts` → `restart under load` e os demais crashes |

### Concorrência (paralelismo real)

| # | Cenário do desafio | Teste | Evidência verificada |
|---|---|---|---|
| 1 | Mesma aposta **50× em paralelo** → um débito | `idempotency-burst.test.ts` (use case; HTTP em **3 processos de API**; HTTP + SQS com **3 processos consumer**) | 1 RECORDED + 49 REPLAY, um único `transactionId`, uma linha DEBIT, saldo esperado, todos os replays com o saldo original |
| 2 | 100,00 com duas BETs de 80,00 | `same-wallet-race.test.ts` (25 wallets em paralelo; 10 rodadas entre 3 processos de API distintos; retries depois) | exatamente 1 PROCESSED + 1 `REJECTED INSUFFICIENT_FUNDS`, saldo **20,00**, versão 2, **um** DEBIT, retries viram replay sem novo débito |
| 3 | Wallets distintas em paralelo | `multi-instance-workload.test.ts` (30 wallets × 20 ops via 3 APIs + 3 consumers); `locks-and-deadlocks.test.ts` (`different wallets never block each other`) | saldo de cada wallet = soma decimal calculada de forma independente; versão 21 |
| 4 | ≥ 3 processos/instâncias | os testes acima e `hot wallet: 300 concurrent operations from 3 APIs + 3 consumers` | sem rejeições indevidas; saldo exato; contenção de lock observada nas métricas |
| 5 | Worker morto **depois do commit e antes do ack** | `crash-recovery.test.ts` → `consumer killed AFTER the commit and BEFORE the ack` | processo morto com SIGKILL; inbox `PROCESSED`; mensagem não apagada; novo consumer a absorve (`inbox_duplicates = 1`); um único DEBIT |
| 6 | Dois publishers sobre a mesma outbox | `outbox.test.ts` (in-process) e `crash-recovery.test.ts` → `outbox publisher killed AFTER publishing and BEFORE confirming` (processos reais) | claims disjuntos; após o crash, o lease expira e outro publisher republica (`attempts = 2`); todos os eventIds entregues |
| 7 | ROLLBACK/REFUND antes da referência | `pending-references.test.ts` (5) e E2E | 202 → resolvido ao chegar a BET; backoff 2s/4s/8s/16s; `REFERENCE_NOT_FOUND` ao esgotar; cascata ROLLBACK→REFUND→BET; 8 REFUNDs concorrentes → 1 aplicado |
| 8 | Reinício do serviço com consistência final | `crash-recovery.test.ts` → `restart under load: consumers SIGKILLed and SIGTERMed mid-stream` | 60 operações (com REFUND antes da BET) todas `PROCESSED` uma vez; 20 wallets com saldo 102,50; DLQ vazia |

Extras: deadlock provocado de forma determinística, com PostgreSQL escolhendo a vítima (`a provoked deadlock is detected by PostgreSQL, retried from scratch and applied exactly once`); `lock_timeout` com erro `503`-retryable e nada persistido; contenção medida; **PostgreSQL indisponível de verdade** (`ALLOW_CONNECTIONS false` + término das conexões) → `503 DATABASE_UNAVAILABLE`, readiness 503, liveness 200 e recuperação automática.

### API HTTP (`http-api.test.ts`, 19 testes)

Contratos e status de todos os endpoints: UUIDs em maiúsculas tratados como a mesma wallet e a mesma operação, `201` + `Location`, `200` replay com corpo idêntico e `Idempotent-Replayed`, `202` pendente, `400` (payload, JSON malformado, `Idempotency-Key` ausente, OPENING, campo desconhecido, valor inválido, cursor inválido, `limit` > 200), `404`, `409`, `422` (com `failureCode`, `transactionId`, saldo observado), `503`, propagação de `X-Correlation-Id`, paginação keyset ponta a ponta (asc/desc), reconciliação, health e `/metrics`.

### E2E (`e2e/stack.test.ts`, 7 testes, processos compilados isolados)

Três APIs com `X-Instance-Id` distintos, três consumers, dois publishers e um reference worker, usando um banco novo e filas de nomes aleatórios. Todos os tipos de transação com verificação do ledger; idempotência entre APIs; mensagem SQS entregue 2× (um efeito); REFUND antes da BET resolvido pelo worker; eventos chegando à fila exclusiva da suíte; duas apostas concorrentes de 80,00 em saldo 100,00. Ao final, reconciliação de cada wallet e remoção dos recursos próprios. Não há purge nem consumo de eventos alheios. Nginx é conferido separadamente no smoke do Compose completo.

### Regressões da auditoria

`audit-regressions.test.ts` verifica SQL com login runtime contra backfill (inclusive quatro escritores concorrentes), múltiplos movimentos legítimos no mesmo commit, NaN e métricas pós-commit em rollback/retry/OPENING/reference worker. `migrations.test.ts` também cobre upgrade/down/up com histórico e recusa atômica de corrupção preexistente. O novo teste HTTP cobre moeda histórica da rejeição em replay e nos dois GETs. `date-immutability.test.ts` cobre mutação de datas de entrada/saída; `dependency-patches.test.ts` exercita os pacotes instalados. `consumer-shutdown.test.ts` reproduziu a devolução ausente após expirar o prazo e agora verifica liberação de todo o lote, interrupção dos heartbeats, ausência de ACK tardio e redelivery com efeito financeiro único.

## Defeitos encontrados pelos testes e corrigidos

1. **Long poll abortado no shutdown do consumidor.** Ao parar, o consumidor abortava o `ReceiveMessage` em andamento. Se o SQS já tinha respondido, as mensagens ficavam invisíveis e consumiam uma tentativa sem serem processadas, o que levava mensagens à DLQ antes da hora. Detectado em `sqs-consumer.test.ts`: o primeiro processamento já aparecia com `receiveCount = 2`. Correção: não abortar o poll e devolver imediatamente o que chegar (ADR-010). Os testes do consumidor caíram de ~6s para ~1s cada.
2. **Timestamps antes do lock.** O teste de carga mostrou o lag do outbox acompanhando a latência HTTP. O instante da operação era capturado antes de adquirir o lock da wallet, o que permitia ledger com tempo fora da ordem das versões. Correção: capturar depois do lock. A invariante "timestamps não-decrescentes por versão" passou a fazer parte da auditoria final de todas as suítes.
3. **Classificação de indisponibilidade.** "Banco não aceita conexões" (`55000`) e "banco inexistente" (`3D000`) caíam como erro interno (500). O teste de indisponibilidade real expôs isso, e esses casos agora são `503 DATABASE_UNAVAILABLE`.
4. **Lacuna de schema.** Ao escrever os ataques ao schema, faltava impedir uma transação `PROCESSED` que move dinheiro sem lançamento no ledger. Foi adicionada a constraint trigger diferida `wager_transactions_processed_has_ledger_entry`.

### Encontrados na revisão de código adversarial final (e cobertos por novos testes)

A revisão inicial do núcleo financeiro encontrou cinco casos em que **operações válidas falhavam** ou **erros transitórios viravam permanentes**, corrigidos abaixo. Posteriormente, a auditoria independente reproduziu também uma inserção histórica que quebrava a consistência do ledger e outros achados; as correções e regressões adicionais estão em [AUDIT_FIXES.md](AUDIT_FIXES.md). Os resultados desta revisão inicial não devem ser lidos como garantia de ausência de outras falhas:

5. **Queda do banco esgotava tentativas.** Durante uma queda de ~30s o consumidor continuava recebendo mensagens e mandava a cabeça de cada grupo FIFO para a DLQ, o que liberava as mensagens seguintes do grupo fora de ordem. Agora o consumidor pausa até o banco responder. Teste: `a database outage longer than the retry budget pauses consumption instead of dead-lettering`.
6. **`messageId` longo inviabilizava a mensagem.** O correlation id derivado de um `messageId` de 129 a 256 caracteres (válido pelo contrato) estourava `varchar(128)` no outbox. Agora só se usa um candidato que caiba, ou gera-se um UUID. Teste com `messageId` de 256 caracteres.
7. **UUID em maiúsculas** era aceito pela validação, mas causava 500 por divergência de grafia. Agora é normalizado no contrato. Teste HTTP com replay em minúsculas.
8. **Inbox `DEAD_LETTERED` sem hash** (mensagem ilegível) não podia virar `PROCESSED`, e um hash antigo podia gerar `MESSAGE_ID_CONFLICT` indevido. Agora a linha adota o payload processado. Teste de integração mais teste unitário.
9. **Diferença de relógio entre instâncias** podia violar `updated_at >= created_at`. Agora o `Wallet` nunca data um movimento antes do anterior. Teste unitário.
10. **Mensagens seguintes de um grupo FIFO iam para a DLQ sem processamento.** O limite de tentativas era o `ApproximateReceiveCount` (redrive do SQS). Quando a cabeça de um grupo falhava, as mensagens seguintes do mesmo lote eram recebidas e adiadas a cada retry e esgotavam o contador sem nenhuma tentativa. Agora as falhas reais são contadas em `inbox_attempts` e o consumidor decide a DLQ; o redrive do SQS virou rede de segurança. Teste: `messages behind a failing FIFO group head keep their own budget` (duas cabeças falhando; a seguinte é processada com `receive_count > maxAttempts`).

Além disso, a instabilidade de uma porta TCP entregue duas vezes pelo sistema operacional ao subir 3 processos de API em paralelo, observada uma vez, foi eliminada no harness de teste (reserva de portas e nova tentativa).

## O que não foi validado aqui

- **Desenvolvimento no host** (`bun run dev` fora do Docker com `docker-compose.dev.yml`): o Bun não estava instalado no host de validação. Os mesmos scripts foram executados dentro de containers.
- **Linux nativo**: validado em Docker Desktop/WSL2 (kernel Linux 6.6). Não houve execução num host Linux sem Docker Desktop.
- **SQS real (AWS)**: apenas LocalStack 4.14.
