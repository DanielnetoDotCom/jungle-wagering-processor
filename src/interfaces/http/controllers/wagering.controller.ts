import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ResourceNotFoundError } from '../../../application/errors/application-errors';
import { WalletQueries } from '../../../application/queries/wallet-queries';
import { ProcessWagerTransactionUseCase } from '../../../application/use-cases/process-wager-transaction.use-case';
import type { WagerTransactionView } from '../../../application/views';
import { TransactionChannel } from '../../../domain/wagering/wager-transaction-types';
import { enrichLogContext } from '../../../infrastructure/logging/log-context';
import { parseOrThrow } from '../../contracts/validation';
import {
  identifier,
  idempotencyKeySchema,
  uuidSchema,
  type WagerTransactionRequest,
  wagerTransactionRequestSchema,
} from '../../contracts/wager-contracts';
import { assertCanActFor, canActFor, ProviderAuthGuard } from '../auth/provider-identity';
import { presentSubmission } from '../presenters/wager-presenter';
import { currentCorrelationId, currentRequestId } from '../support/request-context';
import { ZodValidationPipe } from '../support/zod-validation.pipe';

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransactionUseCase) private readonly processWager: ProcessWagerTransactionUseCase,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
  ) {}

  /**
   * Idempotency-Key header is mandatory and is the source of truth.
   * Identical retry -> same result with idempotentReplay=true; same key with
   * another payload -> 409 IDEMPOTENCY_KEY_CONFLICT (never a replay).
   */
  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') rawIdempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(wagerTransactionRequestSchema, 'wager transaction'))
    body: WagerTransactionRequest,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Record<string, unknown>> {
    const idempotencyKey = parseOrThrow(idempotencyKeySchema, rawIdempotencyKey, 'Idempotency-Key header');
    assertCanActFor(request, body.providerId);
    enrichLogContext({ providerId: body.providerId, walletId: body.walletId });

    const correlationId = currentCorrelationId();
    const result = await this.processWager.execute({
      idempotencyKey,
      payload: body,
      channel: TransactionChannel.Http,
      correlationId,
      causationId: currentRequestId(),
    });

    const presented = presentSubmission(result, correlationId);
    response.status(presented.status);
    for (const [name, value] of Object.entries(presented.headers)) {
      response.setHeader(name, value);
    }
    return presented.body;
  }

  /** A transaction of a provider the caller cannot act for is reported as missing (no existence oracle). */
  @Get('wagering/transactions/:transactionId')
  async getTransaction(
    @Param('transactionId', new ZodValidationPipe(uuidSchema, 'transactionId')) transactionId: string,
    @Req() request: Request,
  ): Promise<WagerTransactionView> {
    const transaction = await this.queries.getTransaction(transactionId);
    if (!canActFor(request, transaction.providerId)) {
      throw new ResourceNotFoundError('TRANSACTION_NOT_FOUND', `Transaction ${transactionId} not found`);
    }
    return transaction;
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  getTransactionByExternalId(
    @Param('providerId', new ZodValidationPipe(identifier(64), 'providerId')) providerId: string,
    @Param('externalTransactionId', new ZodValidationPipe(identifier(128), 'externalTransactionId'))
    externalTransactionId: string,
    @Req() request: Request,
  ): Promise<WagerTransactionView> {
    assertCanActFor(request, providerId);
    return this.queries.getTransactionByExternalId(providerId, externalTransactionId);
  }
}
