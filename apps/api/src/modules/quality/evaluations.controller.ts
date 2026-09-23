import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { Permission, type Principal } from '@ocso/auth';
import { EvaluationResultsQuery, EvaluationRunInput, EvaluationRunQuery, EvaluationRunService, type ActorContext } from '@ocso/application';
import { z } from 'zod';
import { Actor, Capability, CurrentPrincipal, RequirePermission } from '../../common/decorators.js';

const Id = z.uuid();

/** Replay evaluations of a candidate prompt before activation (design/02 Versions tab). */
@Controller('v1/evaluations')
export class EvaluationsController {
  constructor(@Inject(EvaluationRunService) private readonly runs: EvaluationRunService) {}

  @Capability({ name: 'quality.list_evaluations', summary: 'List evaluation runs (replays of past conversations).', tags: ['evaluation', 'eval', 'test'] })
  @Get()
  @RequirePermission(Permission.EVALUATIONS_RUN)
  list(@CurrentPrincipal() principal: Principal, @Query({ schema: EvaluationRunQuery }) q: EvaluationRunQuery) {
    return this.runs.list(principal, q);
  }

  /** Queue a run (topic evaluation.run); the worker replays without executing tools. */
  @Capability({ name: 'quality.run_evaluation', summary: 'Start an evaluation run for a virtual agent (replays conversations; no tools execute).', risk: 'LOW_WRITE', tags: ['evaluation', 'eval', 'test'] })
  @Post()
  @RequirePermission(Permission.EVALUATIONS_RUN)
  create(@Actor() actor: ActorContext, @Body({ schema: EvaluationRunInput }) body: EvaluationRunInput) {
    return this.runs.create(actor, body);
  }

  @Capability({ name: 'quality.get_evaluation', summary: 'Get one evaluation run.', tags: ['evaluation'] })
  @Get(':id')
  @RequirePermission(Permission.EVALUATIONS_RUN)
  get(@CurrentPrincipal() principal: Principal, @Param('id', { schema: Id }) id: string) {
    return this.runs.get(principal, id);
  }

  @Capability({ name: 'quality.get_evaluation_results', summary: 'Results of an evaluation run, case by case.', tags: ['evaluation'] })
  @Get(':id/results')
  @RequirePermission(Permission.EVALUATIONS_RUN)
  results(@CurrentPrincipal() principal: Principal, @Param('id', { schema: Id }) id: string, @Query({ schema: EvaluationResultsQuery }) q: EvaluationResultsQuery) {
    return this.runs.results(principal, id, q);
  }
}
