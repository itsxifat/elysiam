import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  mistakeReviewInputSchema,
  staffActivitySettingsInputSchema,
  staffMistakesQuerySchema,
  staffTeamQuerySchema,
  staffTimelineQuerySchema,
} from '@elysium/contracts/staff-activity';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { mapStaffActivityErrors } from './staff-activity.errors.js';
import { StaffActivityService } from './staff-activity.service.js';

const userIdSchema = z.string().min(1, 'No such person.').max(64, 'No such person.');

const reviewSchema = z
  .object({
    key: z.string().min(3).max(200),
    from: z.string(),
    to: z.string(),
  })
  .and(mistakeReviewInputSchema);

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
 * Staff activity over HTTP (M57, D-1000 to D-1006). `read StaffActivity`: org_admin and hr across
 * the brand (the team table, anyone's page, timeline and mistakes), everyone else at a desk
 * `own` (their page with its comparison table, their timeline and mistakes). `update
 * StaffActivity` (org_admin): a mistake's review and the brand's thresholds and switches.
 */
@Controller('v1/staff-activity')
export class StaffActivityController {
  constructor(private readonly staff: StaffActivityService) {}

  @RequireAbility('read', 'StaffActivity')
  @Get('team')
  async team(@Req() request: FastifyRequest, @Query() query: unknown) {
    const input = parse(staffTeamQuerySchema, query ?? {});
    return mapStaffActivityErrors(() =>
      this.staff.teamTable(requireContext(request), request, input),
    );
  }

  @RequireAbility('read', 'StaffActivity')
  @Get('team/export')
  async teamExport(
    @Req() request: FastifyRequest,
    @Query() query: unknown,
    @Res() reply: FastifyReply,
  ) {
    const input = parse(staffTeamQuerySchema, query ?? {});
    const file = await mapStaffActivityErrors(() =>
      this.staff.teamCsv(requireContext(request), auditable(request), input),
    );
    await reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${file.filename}"`)
      .send(file.csv);
  }

  @RequireAbility('read', 'StaffActivity')
  @Get('me')
  async me(@Req() request: FastifyRequest, @Query() query: unknown) {
    const input = parse(staffTeamQuerySchema, query ?? {});
    const context = requireContext(request);
    return mapStaffActivityErrors(() => this.staff.person(context, request, context.userId, input));
  }

  @RequireAbility('read', 'StaffActivity')
  @Get('people/:userId')
  async person(
    @Req() request: FastifyRequest,
    @Param('userId') userId: string,
    @Query() query: unknown,
  ) {
    const id = parse(userIdSchema, userId);
    const input = parse(staffTeamQuerySchema, query ?? {});
    return mapStaffActivityErrors(() =>
      this.staff.person(requireContext(request), request, id, input),
    );
  }

  @RequireAbility('read', 'StaffActivity')
  @Get('people/:userId/timeline')
  async timeline(
    @Req() request: FastifyRequest,
    @Param('userId') userId: string,
    @Query() query: unknown,
  ) {
    const id = parse(userIdSchema, userId);
    const input = parse(staffTimelineQuerySchema, query ?? {});
    return mapStaffActivityErrors(() =>
      this.staff.timeline(requireContext(request), request, id, input),
    );
  }

  @RequireAbility('read', 'StaffActivity')
  @Get('mistakes')
  async mistakes(@Req() request: FastifyRequest, @Query() query: unknown) {
    const input = parse(staffMistakesQuerySchema, query ?? {});
    return mapStaffActivityErrors(() =>
      this.staff.mistakes(requireContext(request), request, input),
    );
  }

  @RequireAbility('update', 'StaffActivity')
  @Put('mistakes/review')
  async review(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(reviewSchema, body);
    parse(staffTimelineQuerySchema.or(staffTeamQuerySchema), { from: input.from, to: input.to });
    return mapStaffActivityErrors(() =>
      this.staff.review(requireContext(request), auditable(request), input),
    );
  }

  @RequireAbility('update', 'StaffActivity')
  @Get('settings')
  async settings(@Req() request: FastifyRequest) {
    return this.staff.settings(requireContext(request));
  }

  @RequireAbility('update', 'StaffActivity')
  @Put('settings')
  async saveSettings(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(staffActivitySettingsInputSchema, body);
    return mapStaffActivityErrors(() =>
      this.staff.saveSettings(requireContext(request), auditable(request), input),
    );
  }
}
