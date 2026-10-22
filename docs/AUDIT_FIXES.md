# Correções da auditoria — 22/10/2026

As alterações abaixo corrigem os achados reproduzidos da auditoria. Foram implementadas no repositório e validadas em infraestrutura descartável; a migration nova não foi aplicada ao stack preexistente.

| Achado | Correção | Regressão |
|---|---|---|
| F01 — moeda do replay/GET | O mapper reconstrói o saldo histórico na moeda imutável da wallet, inclusive para rejeições já armazenadas. A moeda solicitada pela transação continua preservada. | `http-api.test.ts`: BET USD contra wallet BRL; primeira resposta, replay após outra movimentação e ambas as consultas mantêm o saldo original em BRL. |
| F02 — inserção retroativa no ledger | Migration aditiva `20261022000500`: valida predecessora, sucessora, posição inicial/OPENING e cauda materializada; serializa a validação com lock na wallet. Permite várias movimentações legítimas no mesmo commit e abertura zero. | `audit-regressions.test.ts`: SQL com login runtime, backfill isolado e quatro tentativas concorrentes rejeitados; duas movimentações no mesmo commit aceitas. |
| F03 — NaN no schema | CHECKs adicionais limitam todas as colunas monetárias ao intervalo finito de `NUMERIC(20,2)`. As regras anteriores de não negatividade permanecem. | SQL com login runtime rejeita NaN no saldo da wallet, valor e snapshot da transação e valores do ledger, incluindo o caso em que toda a aritmética envolve NaN. |
| F04 — métricas antes do COMMIT | Observações síncronas `afterCommit` por unidade de trabalho; callbacks descartados em rollback/retry. Falha da métrica ou do logger não transforma um commit bem-sucedido em erro financeiro. | Rollback HTTP/SQS, retry, OPENING, resolução de referência e falha diferida no COMMIT. Um observador com erro não impede o resultado confirmado nem os demais observadores. |
| F05 — purge destrutivo no E2E | E2E cria banco e filas exclusivos e inicia os entrypoints compilados em processos próprios. Removidos `PurgeQueue`, URLs de filas fixas e seleção de banco/API externos. Cleanup restrito aos recursos criados pela suíte. | Sete testes E2E; verificação adicional com tabela financeira e mensagem sentinela fora da suíte, descrita abaixo. |
| F06 — dependências | AJV 8.20.0, ESLint 10.13.0, typescript-eslint 8.72.0, cliente Prometheus mantido `@prometheus-io/client` 0.16.1 e umzug 3.8.3. Migrator carregado dinamicamente e separado da imagem das APIs/workers. Patches locais para os dois advisories ainda sem release corrigida. | Instalação frozen, lint/typecheck/build, migrations reais, `/metrics` e regressões dos patches em dependências efetivamente instaladas. |
| O01 — datas mutáveis | Cópias defensivas das datas de wallet, transação, inbox, outbox e eventos; ledger guarda timestamp numérico e retorna cópia. Snapshots de resultado copiados e congelados. | `date-immutability.test.ts`: mutação das datas de entrada e dos getters não altera o estado interno. |

## Migration e histórico existente

A migration não reescreve as quatro anteriores. Faz preflight de valores e cadeia existentes e aborta atomicamente se houver divergência. Não há reparo automático, exclusão de lançamentos ou desativação dos triggers. `down` remove somente as novas regras.

Os testes aplicam e revertem a migration em bancos já populados e comparam as linhas antes/depois. Um banco descartável reproduz a corrupção usando o schema antigo; o upgrade é recusado, o histórico permanece intacto e a migration não fica registrada como executada. DDL e validação do histórico adquirem locks: o custo em um banco grande deve ser avaliado ao planejar a atualização.

As métricas são observações operacionais, sem entrega durável: uma queda entre COMMIT e callback ainda pode deixar de contar uma operação. O ledger e os eventos de outbox continuam sendo os registros persistentes.

## Patches de dependências

Os advisories de [braces](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) e [sprintf-js](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) não listam release corrigida na data da validação. Mantivemos as versões e os alertas visíveis, com patches versionados em `patches/` e declarados em `patchedDependencies` no package.json/lockfile:

- `braces@3.0.3`: limita o aninhamento no parser e nos walkers recursivos. Padrões profundos abaixo do limite de caracteres e ASTs passadas diretamente são recusados com erro de sintaxe controlado. Padrões usuais e ranges continuam funcionando.
- `sprintf-js@1.0.3`: limita a precisão de `e`/`f` a 0–100 e de `g` a 1–100, evitando o RangeError dos especificadores de precisão reproduzidos. Formatos usuais mantêm o resultado. Essa dependência fica nas ferramentas de migration, fora da imagem das APIs/workers.

O Dockerfile copia os patches antes de `bun install --frozen-lockfile`, inclusive no estágio de produção. Os testes carregam os pacotes instalados, não cópias simuladas. **`bun audit` ainda retorna dois avisos e exit 1**, pois verifica versões upstream. Não foi usada supressão de advisory. Reavaliar e retirar os patches quando houver atualização upstream compatível; eles não representam uma auditoria completa dessas bibliotecas.

## Encerramento além do prazo

A sonda adicional confirmou que o consumidor antigo retornava do `stop()` mantendo duas mensagens invisíveis após o prazo. Agora ele acompanha todo o lote recebido, interrompe heartbeats, espera extensões já enviadas e devolve mensagens não confirmadas com visibilidade zero. Trabalho que termina depois de perder a posse não faz ACK nem altera a visibilidade usando o recibo antigo. Um segundo loop não pode iniciar na mesma instância enquanto o primeiro ainda termina.

`consumer-shutdown.test.ts` usa PostgreSQL e SQS reais e pausa o SQL antes do commit. Com prazo configurado em 100 ms, verifica devolução da mensagem ativa e da próxima mensagem do grupo; espera passar um período de heartbeat; inicia outro consumidor; libera o commit antigo; confirma redelivery deduplicada, nenhum ACK tardio pelo consumidor antigo e saldo final exato. O teste exercita o ramo de expiração sem esperar os 20 segundos do valor padrão. A devolução é best effort se o broker estiver indisponível; nesse caso, o timeout de visibilidade continua sendo o mecanismo de recuperação.

## Isolamento e validação

Infraestrutura usada: projeto `jungle-fix-20261022-02`, redes e volume PostgreSQL próprios, imagens com tags desse projeto e nginx em `127.0.0.1:18082`. Os nomes resolvidos, volumes e mounts foram conferidos antes de iniciar. Nenhum container do stack original foi atualizado ou reiniciado nesta etapa de correções.

Além das suítes, foi iniciado o Compose completo com as imagens compiladas e o job de migration separado. Foram conferidos healthchecks, três `X-Instance-Id` pelo nginx, criação de wallet, BET e reconciliação. A imagem runtime foi inspecionada: sem migrator, umzug, sprintf-js ou ESLint; patch de braces presente. O patch de sprintf-js foi exercitado na imagem de migration.

Para conferir a segurança do E2E, uma wallet e seus registros foram criados no banco da aplicação do stack descartável e uma mensagem sentinela foi enviada à fila fixa de eventos. O E2E executou com `E2E_DB_NAME=wagering` e `E2E_BASE_URL` inválida definidos de propósito. Depois dele, contagens e hashes das cinco tabelas da aplicação permaneceram iguais e a mensagem sentinela continuou disponível. O teste usa somente seus próprios recursos. Roteamento nginx é conferido separadamente pelo smoke do Compose; os sete testes E2E passam diretamente pelas APIs compiladas.

Os números finais da execução ficam em [TEST_REPORT.md](TEST_REPORT.md). O teste de carga de longa duração não foi repetido nesta correção; os resultados históricos de carga permanecem identificados como tal.
