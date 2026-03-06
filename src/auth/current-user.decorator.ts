
import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';

export const CurrentUser = createParamDecorator(
    (data: unknown, ctx: ExecutionContext) => {
        const request = ctx.switchToHttp().getRequest();
        if (!request.user || !request.user.userId) {
            throw new UnauthorizedException('User not found in request');
        }
        return request.user;
    },
);

export const CurrentUserId = createParamDecorator(
    (data: unknown, ctx: ExecutionContext) => {
        const request = ctx.switchToHttp().getRequest();
        if (!request.user || !request.user.userId) {
            throw new UnauthorizedException('User ID not found in request');
        }
        return request.user.userId;
    },
);
