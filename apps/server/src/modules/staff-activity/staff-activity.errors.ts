import { ForbiddenException, NotFoundException, type HttpException } from '@nestjs/common';
import type { ErrorCode } from '@elysium/contracts';

/** Staff activity's refusals as the API reports them (architecture §23). */
export class StaffActivityError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StaffActivityError';
  }
}

function httpError(error: StaffActivityError): HttpException {
  const body = { code: error.code, message: error.message };
  return error.code === 'STAFF_ACTIVITY_TEAM_ONLY' || error.code === 'STAFF_ACTIVITY_OWN_MISTAKE'
    ? new ForbiddenException(body)
    : new NotFoundException(body);
}

/** Run `work`, turning this module's errors into problem+json and leaving others alone. */
export async function mapStaffActivityErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof StaffActivityError) throw httpError(error);
    throw error;
  }
}
