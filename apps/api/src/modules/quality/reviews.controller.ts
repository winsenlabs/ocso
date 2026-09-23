import { Body, Controller, Get, Inject, Post, Query } from '@nestjs/common';
import { Permission, type Principal } from '@ocso/auth';
import { ReviewInput, ReviewQuery, ReviewService, type ActorContext } from '@ocso/application';
import { Actor, Capability, CurrentPrincipal, RequirePermission } from '../../common/decorators.js';

/** Conversation reviews with an explicit 4-criterion rubric (design/02 "Latest reviewed conversations"). */
@Controller('v1/reviews')
export class ReviewsController {
  constructor(@Inject(ReviewService) private readonly reviews: ReviewService) {}

  @Capability({ name: 'quality.list_reviews', summary: 'List quality reviews of conversations.' })
  @Get()
  @RequirePermission(Permission.REVIEWS_MANAGE)
  list(@CurrentPrincipal() principal: Principal, @Query({ schema: ReviewQuery }) q: ReviewQuery) {
    return this.reviews.list(principal, q);
  }

  /** Rubric criteria, scale, suggested outcome tags and the score formula. */
  @Capability({ name: 'quality.get_review_rubric', summary: 'The quality review rubric: criteria, scale and outcome tags.', tags: ['rubric'] })
  @Get('rubric')
  @RequirePermission(Permission.REVIEWS_MANAGE)
  rubric() {
    return this.reviews.rubric();
  }

  @Capability({ name: 'quality.create_review', summary: 'Score a conversation against the review rubric.', risk: 'LOW_WRITE', tags: ['score'] })
  @Post()
  @RequirePermission(Permission.REVIEWS_MANAGE)
  create(@Actor() actor: ActorContext, @Body({ schema: ReviewInput }) body: ReviewInput) {
    return this.reviews.create(actor, body);
  }
}
