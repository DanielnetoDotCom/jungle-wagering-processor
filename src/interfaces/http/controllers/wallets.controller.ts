import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { WalletQueries } from '../../../application/queries/wallet-queries';
import { CreateWalletUseCase } from '../../../application/use-cases/create-wallet.use-case';
import {
  type ReconciliationReport,
  ReconcileWalletUseCase,
} from '../../../application/use-cases/reconcile-wallet.use-case';
import type { WalletView } from '../../../application/views';
import {
  type CreateWalletRequest,
  createWalletRequestSchema,
  type LedgerQuery,
  ledgerQuerySchema,
  uuidSchema,
} from '../../contracts/wager-contracts';
import { ProviderAuthGuard } from '../auth/provider-identity';
import { decodeLedgerCursor, encodeLedgerCursor } from '../presenters/ledger-cursor';
import { currentCorrelationId } from '../support/request-context';
import { ZodValidationPipe } from '../support/zod-validation.pipe';

const walletIdPipe = new ZodValidationPipe(uuidSchema, 'walletId');

@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    @Inject(CreateWalletUseCase) private readonly createWallet: CreateWalletUseCase,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
    @Inject(ReconcileWalletUseCase) private readonly reconcile: ReconcileWalletUseCase,
  ) {}

  /** 201 + Location. Duplicate player+currency -> 409 WALLET_ALREADY_EXISTS (details.walletId). */
  @Post()
  @HttpCode(201)
  async create(
    @Body(new ZodValidationPipe(createWalletRequestSchema, 'wallet request')) body: CreateWalletRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Pick<WalletView, 'id' | 'playerId' | 'balance' | 'version' | 'createdAt'>> {
    const wallet = await this.createWallet.execute({
      playerId: body.playerId,
      initialBalance: body.initialBalance,
      correlationId: currentCorrelationId(),
    });
    response.setHeader('Location', `/wallets/${wallet.id}`);
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance,
      version: wallet.version,
      createdAt: wallet.createdAt,
    };
  }

  @Get(':walletId')
  getWallet(@Param('walletId', walletIdPipe) walletId: string): Promise<WalletView> {
    return this.queries.getWallet(walletId);
  }

  /** Keyset pagination: ?limit=1..200 (default 50), ?order=asc|desc, ?cursor=<opaque nextCursor>. */
  @Get(':walletId/ledger')
  async getLedger(
    @Param('walletId', walletIdPipe) walletId: string,
    @Query(new ZodValidationPipe(ledgerQuerySchema, 'ledger query')) query: LedgerQuery,
  ): Promise<Record<string, unknown>> {
    const cursor = query.cursor ? decodeLedgerCursor(walletId, query.cursor) : undefined;
    const order = cursor?.order ?? query.order ?? 'asc';
    const page = await this.queries.getLedgerPage({
      walletId,
      afterVersion: cursor?.afterVersion,
      limit: query.limit,
      order,
    });
    return {
      walletId: page.walletId,
      order,
      limit: query.limit,
      items: page.items,
      nextCursor:
        page.nextAfterVersion === null
          ? null
          : encodeLedgerCursor(walletId, { order, afterVersion: page.nextAfterVersion }),
    };
  }

  /** Read-only check. Divergences are reported, logged and counted; never auto-corrected. */
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcileWallet(@Param('walletId', walletIdPipe) walletId: string): Promise<ReconciliationReport> {
    return this.reconcile.execute(walletId);
  }
}
