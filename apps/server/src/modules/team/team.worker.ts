import type { JobFailureReporter, JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import type { PresenceHistoryService } from './presence-history.service.js';
import { TEAM_QUEUES } from './team.queues.js';

export interface TeamWorkerDependencies {
  readonly jobs: JobsRuntime;
  readonly history: PresenceHistoryService;
  readonly report: JobFailureReporter;
}

/** The team module's worker (M57): the nightly presence-history purge (D-1005). */
export async function registerTeamJobs(deps: TeamWorkerDependencies): Promise<void> {
  await deps.jobs.work(
    TEAM_QUEUES.purgeSpans.name,
    async () => {
      await deps.history.purgeAll();
    },
    deps.report,
  );
}
