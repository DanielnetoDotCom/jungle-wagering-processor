import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ApplicationError, ErrorCategory } from '../../../application/errors/application-errors';

/** Who is calling. `providers: '*'` means not scoped to a single provider. */
export interface ProviderIdentity {
  subject: string;
  providers: readonly string[] | '*';
  mechanism: 'none' | 'oidc';
}

/**
 * Extension point for authentication. Production design (documented in
 * ARCHITECTURE.md, ADR-015): an OIDC adapter validating a client-credentials
 * JWT issued by Keycloak/Zitadel (signature via JWKS, iss, aud, exp) and
 * mapping a `provider_id` claim to `providers`.
 */
export interface ProviderIdentityResolver {
  resolve(request: Request): Promise<ProviderIdentity>;
}

export const PROVIDER_IDENTITY_RESOLVER = Symbol('PROVIDER_IDENTITY_RESOLVER');

/**
 * LOCAL/DEVELOPMENT ONLY: trusts every caller. This is NOT security; it only
 * keeps the seam explicit so a real IdP adapter can replace it without
 * touching controllers or use cases.
 */
export class NoopProviderIdentityResolver implements ProviderIdentityResolver {
  resolve(): Promise<ProviderIdentity> {
    return Promise.resolve({ subject: 'anonymous', providers: '*', mechanism: 'none' });
  }
}

export class ProviderForbiddenError extends ApplicationError {
  readonly code = 'PROVIDER_FORBIDDEN';
  readonly category = ErrorCategory.Forbidden;

  constructor(providerId: string) {
    super(`Caller is not allowed to act for provider ${providerId}`);
  }
}

type RequestWithIdentity = Request & { providerIdentity?: ProviderIdentity };

@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(@Inject(PROVIDER_IDENTITY_RESOLVER) private readonly resolver: ProviderIdentityResolver) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithIdentity>();
    request.providerIdentity = await this.resolver.resolve(request);
    return true;
  }
}

/** Whether the authenticated caller may act for (or read the data of) this provider. */
export function canActFor(request: Request, providerId: string): boolean {
  const identity = (request as RequestWithIdentity).providerIdentity;
  return identity !== undefined && (identity.providers === '*' || identity.providers.includes(providerId));
}

/** The provider identity carried in the payload must match the authenticated caller. */
export function assertCanActFor(request: Request, providerId: string): void {
  if (!canActFor(request, providerId)) {
    throw new ProviderForbiddenError(providerId);
  }
}
