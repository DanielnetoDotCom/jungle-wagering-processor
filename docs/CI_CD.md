# CI/CD

Os workflows ficam em [`.github/workflows/`](../.github/workflows/). As Actions de terceiros são fixadas por SHA; o Dependabot propõe atualizações desses pins. Todos os jobs usam permissões mínimas, instalação com `bun.lock` congelado e limites de tempo.

## Checks de cada push e pull request

O workflow **CI** roda em pushes para `main`, tags `v*`, pull requests e acionamento manual:

| Job | Evidência |
|---|---|
| Quality and unit tests | ESLint com fronteiras de camadas, Prettier, TypeScript estrito, `check:money`, build e testes unitários. Publica JUnit e cobertura LCOV dos arquivos exercitados pelos unitários. |
| PostgreSQL and SQS — integration | Migrations reversíveis, grants runtime, ataques SQL ao schema, atomicidade, HTTP, inbox, outbox, retry/DLQ, referências pendentes e encerramento além do prazo. |
| PostgreSQL and SQS — concurrency | Operações simultâneas, três instâncias, idempotência, wallets independentes, contenção, deadlocks e saldo não negativo. |
| PostgreSQL and SQS — fault-injection | Processos mortos com SIGKILL antes/depois de commit, antes de ACK e após publicação no broker; recuperação e reconciliação. |
| PostgreSQL and SQS — e2e | Entry points compilados em processos independentes, com banco e filas próprios. |
| Docker Compose smoke | Build das imagens reais e inicialização do stack inteiro; nginx atende pelo menos três APIs; duas BETs de 80,00 sobre saldo 100,00 produzem 201/422; replay conserva saldo histórico após WIN; conflito de payload, ledger e reconciliação são conferidos. |

Cada job de testes recebe seus próprios containers PostgreSQL 17 e LocalStack 4.14. Os testes também criam bancos e filas exclusivos por suíte. O smoke usa um projeto Compose exclusivo por execução e remove somente seus próprios recursos no encerramento. Testes com falha não são convertidos em sucesso. JUnit, cobertura, relatório do smoke e logs de diagnóstico ficam nos artefatos do run por 14 dias.

Cobertura unitária não é cobertura de todo o sistema: integrações e falhas são verificadas nas suítes reais, sem inventar uma porcentagem global. O teste de carga de longa duração permanece acionado separadamente; o relatório histórico está em [LOAD_TEST.md](LOAD_TEST.md).

## Entrega das imagens

Após **todos os jobs de CI acima passarem**, pushes para `main` e tags `v*` chamam o workflow reutilizável **Publish images**. Pull requests nunca publicam imagens nem recebem permissão de escrita no registry.

São produzidas duas imagens Linux amd64:

- `ghcr.io/danielnetodotcom/jungle-wagering-processor`: runtime das APIs e workers, sem ferramentas de migration.
- `ghcr.io/danielnetodotcom/jungle-wagering-processor-migrations`: job de migrations com suas dependências próprias.

As tags incluem `sha-<commit completo>`, `main`/`latest` para a branch principal e versão semântica para tags como `v1.0.0`. A saída do job registra o digest `sha256:...`, que deve ser usado para identificar exatamente um artefato. O BuildKit publica SBOM e provenance junto das imagens. Os campos OCI vinculam o pacote ao repositório e ao commit de origem.

A autenticação usa somente o `GITHUB_TOKEN` temporário do job com `packages: write`. Nenhum PAT, senha de servidor ou credencial de produção é necessário no repositório. A visibilidade e as permissões dos pacotes GHCR são controladas pelo GitHub; publicar uma imagem não torna automaticamente seu pacote público. Esse fluxo entrega artefatos, sem configurar um destino de produção ou executar migrations em servidores externos.

## Segurança e manutenção

**CodeQL** analisa JavaScript/TypeScript em pushes, PRs, manualmente e toda segunda-feira. Os resultados aparecem em Security and quality → Code scanning. Essa análise estática complementa os testes; não prova ausência de vulnerabilidades.

**Dependabot** acompanha Bun (`package.json` + `bun.lock`), Dockerfile e GitHub Actions semanalmente. MikroORM, NestJS e ESLint são agrupados para reduzir atualizações incompatíveis entre pacotes relacionados. As mudanças passam novamente pelo CI e não têm auto-merge configurado.

`bun audit` ainda identifica dois advisories upstream sem release corrigida. Os patches locais, testes de regressão e limites estão em [AUDIT_FIXES.md](AUDIT_FIXES.md). Esses avisos não foram ocultados nem transformados em uma alegação de dependências sem vulnerabilidades.

## Reprodução local

```bash
# Verificações e todas as suítes de testes:
docker compose up -d postgres localstack
docker compose --profile tools run --rm --build toolbox bun run verify
docker compose --profile tools run --rm toolbox bun run test:e2e

# Smoke do Compose: execute em ambiente descartável, pois cria wallets e transações.
docker compose -p jungle-ci-local up -d --build --wait
CI_BASE_URL=http://localhost:8080 bun scripts/verification/compose-smoke.ts
docker compose -p jungle-ci-local down --volumes
```

O smoke exige `CI_BASE_URL` explícita para evitar que uma execução sem configuração atinja silenciosamente outro serviço local. Ajuste `API_PUBLIC_PORT` e a URL se a porta 8080 estiver ocupada. Não reutilize nomes de projeto, volumes ou redes de instalações existentes.
