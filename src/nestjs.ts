import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  ExceptionFilter,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  DynamicModule,
  Module,
  Global,
  Inject,
} from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { ActiveTrace, BeaconConfig, BeaconSDK, generateTraceId } from './index';

export const BEACON_SDK = Symbol('BEACON_SDK');

@Injectable()
export class BeaconInterceptor implements NestInterceptor {
  constructor(@Inject(BEACON_SDK) private readonly beacon: BeaconSDK) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();
    const start = performance.now();
    const trace = new ActiveTrace(req.headers?.['traceparent']);
    if (typeof res?.setHeader === 'function') {
      res.setHeader('traceparent', trace.traceparent);
    }

    return this.beacon.runWithTrace(trace, () =>
      next.handle().pipe(
        tap(() => {
          this.beacon.reportTrace(
            trace,
            {
              method: req.method,
              route: req.route?.path || req.path,
              url: req.originalUrl || req.url,
              status_code: res.statusCode || 200,
              client_ip: req.ip || req.headers['x-forwarded-for'],
            },
            performance.now() - start,
          );
        }),
        catchError((err) => {
          const status =
            err instanceof HttpException ? err.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

          this.beacon.reportTrace(
            trace,
            {
              method: req.method,
              route: req.route?.path || req.path,
              url: req.originalUrl || req.url,
              status_code: status,
              client_ip: req.ip || req.headers['x-forwarded-for'],
            },
            performance.now() - start,
            {
              type: err.name || 'Error',
              message: err.message,
              handled: false,
              stacktrace: (err.stack || '')
                .split('\n')
                .slice(1)
                .map((line: string) => ({ file: line.trim(), line: 0, function: line.trim() })),
            },
          );
          return throwError(() => err);
        }),
      ),
    );
  }
}

@Injectable()
export class BeaconExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    response.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
      message: (exception as any)?.message || 'Internal server error',
    });
  }
}

@Global()
@Module({})
export class BeaconModule {
  static forRoot(config: BeaconConfig): DynamicModule {
    const sdkProvider = {
      provide: BEACON_SDK,
      useValue: new BeaconSDK(config),
    };

    return {
      module: BeaconModule,
      providers: [sdkProvider, BeaconInterceptor, BeaconExceptionFilter],
      exports: [sdkProvider, BeaconInterceptor, BeaconExceptionFilter],
    };
  }
}
