import { Body, Controller, Get, Inject, Post, Query } from '@nestjs/common';
import { Permission, type Principal } from '@ocso/auth';
import { ReviewInput, ReviewQuery, ReviewService, type ActorContext } from '@ocso/application';
import { Actor, CurrentPrincipal, RequirePermission } from '../../common/decorators.js';

/** Conversation reviews with an explicit 4-criterion rubric (design/02 "Latest reviewed conversations"). */
@Controller('v1/reviews')
export class ReviewsController {
  constructor(@Inject(ReviewService) private readonly reviews: ReviewService) {}

  @Get()
  @RequirePermission(Permission.REVIEWS_MANAGE)
  list(@CurrentPrincipal() principal: Principal, @Query({ schema: ReviewQuery }) q: ReviewQuery) {
    return this.reviews.list(principal, q);
  }

  /** Rubric criteria, scale, suggested outcome tags and the score formula. */
  @Get('rubric')
  @RequirePermission(Permission.REVIEWS_MANAGE)
  rubric() {
    return this.reviews.rubric();
  }

  @Post()
  @RequirePermission(Permission.REVIEWS_MANAGE)
  create(@Actor() actor: ActorContext, @Body({ schema: ReviewInput }) body: ReviewInput) {
    return this.reviews.create(actor, body);
  }
}
