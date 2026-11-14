import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import {
  TRACKING_DESTINATION_KINDS,
  trackingDestinationInputSchema,
  trackingLogQuerySchema,
  trackingSettingsInputSchema,
} from '@elysium/contracts/tracking';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { TrackingLog } from './log.service.js';
import { TrackingSetupService } from './setup.service.js';
import { mapTrackingErrors } from './tracking.errors.js';

const idSchema = z.string().uuid('No such record.');
const kindSchema = z.enum(TRACKING_DESTINATION_KINDS);

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message:
        issue === undefined
          ? 'That is not valid.'
          : `${issue.path.join('.') || 'body'}: ${issue.message}`,
    });
  }
  return parsed.data;
}

const auditable = (request: FastifyRequest): AuditableRequest =>
  request as unknown as AuditableRequest;

/**
 * Settings → Tracking over HTTP (M54, D-969): `read Tracking` (org_admin, marketing) to see the
 * settings, the destinations, the log and an order's events; `update Tracking` to change the
 * switches, the Purchase stage, the routes and to Retry or test. A destination's ids and secret
 * also need `update TrackingCredentials` (org_admin), checked by the service.
 */
@Controller('v1/tracking')
export class TrackingController {
  constructor(
    private readonly setup: TrackingSetupService,
    private readonly log: TrackingLog,
  ) {}

  @RequireAbility('read', 'Tracking')
  @Get()
  async view(@Req() request: FastifyRequest) {
    return mapTrackingErrors(() => this.setup.setup(requireContext(request)));
  }

  @RequireAbility('update', 'Tracking')
  @Put('settings')
  async saveSettings(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(trackingSettingsInputSchema, body);
    return mapTrackingErrors(() =>
      this.setup.saveSettings(requireContext(request), auditable(request), input),
    );
  }

  @RequireAbility('update', 'Tracking')
  @Put('destinations/:kind')
  async saveDestination(
    @Req() request: FastifyRequest,
    @Param('kind') kind: string,
    @Body() body: unknown,
  ) {
    const parsedKind = parse(kindSchema, kind);
    const input = parse(trackingDestinationInputSchema, body);
    if (input.kind !== parsedKind) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'kind: the body names another platform than the address.',
      });
    }
    return mapTrackingErrors(() =>
      this.setup.saveDestination(requireContext(request), auditable(request), input),
    );
  }

  @RequireAbility('update', 'Tracking')
  @Post('destinations/:kind/test')
  @HttpCode(200)
  async test(@Req() request: FastifyRequest, @Param('kind') kind: string) {
    const parsedKind = parse(kindSchema, kind);
    return mapTrackingErrors(() =>
      this.setup.test(requireContext(request), auditable(request), parsedKind),
    );
  }

  @RequireAbility('read', 'Tracking')
  @Get('events')
  async events(@Req() request: FastifyRequest, @Query() query: unknown) {
    const input = parse(trackingLogQuerySchema, query);
    return mapTrackingErrors(() => this.log.page(requireContext(request), input));
  }

  @RequireAbility('read', 'Tracking')
  @Get('summary')
  async summary(@Req() request: FastifyRequest) {
    return mapTrackingErrors(() => this.log.summary(requireContext(request)));
  }

  @RequireAbility('read', 'Tracking')
  @Get('orders/:orderId')
  async order(@Req() request: FastifyRequest, @Param('orderId') orderId: string) {
    const id = parse(idSchema, orderId);
    return mapTrackingErrors(() => this.log.order(requireContext(request), id));
  }

  @RequireAbility('update', 'Tracking')
  @Post('deliveries/:id/retry')
  @HttpCode(200)
  async retry(@Req() request: FastifyRequest, @Param('id') id: string) {
    const deliveryId = parse(idSchema, id);
    return mapTrackingErrors(() =>
      this.log.retry(requireContext(request), auditable(request), deliveryId),
    );
  }
}
