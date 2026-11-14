import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  type HttpException,
} from '@nestjs/common';
import type { ErrorCode } from '@elysium/contracts';

import { SealedBoxUnavailable } from '../../platform/crypto/sealed-box.js';

/**
 * The tracking hub's failures as the API reports them (architecture §23): a stable code and a
 * sentence a person can act on. Never a token, a secret or a buyer's details (invariant 10).
 */
export class TrackingError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TrackingError';
  }
}

const STATUS: Readonly<Partial<Record<ErrorCode, number>>> = {
  TRACKING_NOT_FOUND: 404,
  TRACKING_INVALID: 400,
  TRACKING_CREDENTIALS_MISSING: 409,
  TRACKING_NOT_READY: 409,
  TRACKING_DESTINATION_UNAVAILABLE: 409,
  TRACKING_CREDENTIALS_FORBIDDEN: 403,
  TRACKING_RETRY_INVALID: 409,
};

export function trackingHttpError(error: TrackingError): HttpException {
  const body = { code: error.code, message: error.message };
  switch (STATUS[error.code] ?? 400) {
    case 404:
      return new NotFoundException(body);
    case 403:
      return new ForbiddenException(body);
    case 409:
      return new ConflictException(body);
    default:
      return new BadRequestException(body);
  }
}

/** Run `work`, turning this module's errors into problem+json and leaving others alone. */
export async function mapTrackingErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (cause) {
    if (cause instanceof TrackingError) throw trackingHttpError(cause);
    if (cause instanceof SealedBoxUnavailable) {
      throw trackingHttpError(
        new TrackingError(
          'TRACKING_CREDENTIALS_MISSING',
          'This installation has no credentials key, so a token or secret cannot be kept or opened.',
        ),
      );
    }
    throw cause;
  }
}
