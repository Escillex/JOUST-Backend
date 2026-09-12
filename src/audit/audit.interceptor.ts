import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { from, Observable, switchMap, tap } from 'rxjs';
import { AUDIT_KEY, AuditSpec } from './audit.decorator';
import { AuditService } from './audit.service';

/**
 * Turns an `@Audit(...)` on a route into a log entry. Runs after the guards, so
 * a refused request is never recorded; resolves names before the handler (so
 * deletions can still name what they deleted); writes only when the handler
 * succeeded, and without making the response wait on the write.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const spec = this.reflector.get<AuditSpec | undefined>(AUDIT_KEY, ctx.getHandler());
    if (!spec || ctx.getType() !== 'http') return next.handle();

    const req = ctx.switchToHttp().getRequest();
    const actor = req.user ?? {};
    if (!actor.id && !actor.sub) return next.handle(); // unauthenticated: nothing to attribute

    const params = (req.params ?? {}) as Record<string, string>;
    const body = req.body;
    return from(this.audit.prepare(spec, actor, params, body)).pipe(
      switchMap((prepared) =>
        next.handle().pipe(
          tap({
            next: (result) => {
              void this.audit.commit(spec, actor, prepared, params, body, result);
            },
          }),
        ),
      ),
    );
  }
}
