import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import {
  INITIALIZATION_KEY_HEADER,
  type InitializeSystemRequest,
} from '../../shared/contracts/initialization'
import { decodeInitializationKeyHeader } from '../../shared/contracts/initialization-key-header'
import {
  authorizeInitializationKey,
  getSystemStatus,
  InitializationConflictError,
  InitializationInputError,
  InitializationKeyError,
  initializeSystem,
  isSystemInitialized,
  SystemAlreadyInitializedError,
} from '../../modules/system/public'
import {
  processOutboundProviderEvent,
  ProviderEventAuthorizationError,
  ProviderEventInputError,
} from '../../modules/sending/public'
import { parseStorageMode, type WorkerBindings } from '../bindings'
import { createAuthenticationRoutes } from './authentication-routes'

const MAX_INITIALIZATION_BODY_BYTES = 16_384
type AppContext = Context<{ Bindings: WorkerBindings }>

export function createHttpApp() {
  const app = new Hono<{ Bindings: WorkerBindings }>()

  app.use('*', async (context, next) => {
    await next()
    context.header('Cache-Control', 'no-store')
    context.header(
      'Content-Security-Policy',
      "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: https:; object-src 'none'",
    )
    context.header('Referrer-Policy', 'no-referrer')
    context.header('X-Content-Type-Options', 'nosniff')
  })

  app.get('/api/system/status', async (context) => {
    const storageMode = parseStorageMode(context.env.STORAGE_MODE)
    return context.json(await getSystemStatus(context.env.DB, storageMode))
  })

  app.route('/api/auth', createAuthenticationRoutes())

  app.post('/api/outbound/events/:providerType/:configurationKey', async (context) => {
    try {
      const result = await processOutboundProviderEvent({
        database: context.env.DB,
        ...(context.env.CONFIG_KEY ? { encryptionKeyBase64: context.env.CONFIG_KEY } : {}),
        providerType: context.req.param('providerType') ?? '',
        configurationKey: context.req.param('configurationKey') ?? '',
        request: context.req.raw,
      })
      return context.json({ data: { accepted: true as const, ...result } })
    } catch (error) {
      if (error instanceof ProviderEventAuthorizationError) {
        return errorResponse(context, 401, 'provider_event_unauthorized', error.message)
      }
      if (error instanceof ProviderEventInputError) {
        return errorResponse(
          context,
          error.code === 'body_too_large' ? 413 : 400,
          error.code,
          error.message,
        )
      }
      throw error
    }
  })

  app.post('/api/initialization/authorize', async (context) => {
    if (await isSystemInitialized(context.env.DB)) {
      return errorResponse(context, 409, 'already_initialized', '系统已经完成初始化')
    }

    const authorizationError = await authorizeInitializationRequest(context)
    if (authorizationError) {
      return authorizationError
    }

    return context.json({
      data: {
        authorized: true as const,
        storageMode: parseStorageMode(context.env.STORAGE_MODE),
      },
    })
  })

  app.post('/api/initialization/complete', async (context) => {
    if (await isSystemInitialized(context.env.DB)) {
      return errorResponse(context, 409, 'already_initialized', '系统已经完成初始化')
    }

    const authorizationError = await authorizeInitializationRequest(context)
    if (authorizationError) {
      return authorizationError
    }

    try {
      const input = await readInitializationBody(context.req.raw)
      const result = await initializeSystem({
        database: context.env.DB,
        storageMode: parseStorageMode(context.env.STORAGE_MODE),
        input,
      })
      return context.json(result, 201)
    } catch (error) {
      if (error instanceof InitializationInputError) {
        return errorResponse(context, 422, 'invalid_input', error.message, error.field)
      }

      if (error instanceof SystemAlreadyInitializedError) {
        return errorResponse(context, 409, 'already_initialized', error.message)
      }

      if (error instanceof InitializationConflictError) {
        return errorResponse(
          context,
          409,
          'initialization_conflict',
          '初始化数据发生冲突，没有保存任何部分数据',
        )
      }

      throw error
    }
  })

  app.notFound((context) => errorResponse(context, 404, 'not_found', '请求的接口不存在'))

  app.onError((error, context) => {
    console.error(
      JSON.stringify({
        event: 'http_error',
        method: context.req.method,
        path: new URL(context.req.url).pathname,
        errorName: error instanceof Error ? error.name : 'UnknownError',
        errorMessage: safeErrorMessage(error),
      }),
    )
    return errorResponse(context, 500, 'internal_error', '服务暂时不可用')
  })

  return app
}

async function authorizeInitializationRequest(context: AppContext): Promise<Response | null> {
  try {
    await authorizeInitializationKey({
      database: context.env.DB,
      configuredKey: context.env.INIT_KEY,
      providedKey: decodeInitializationKeyHeader(
        context.req.header(INITIALIZATION_KEY_HEADER) ?? '',
      ),
      source: context.req.header('CF-Connecting-IP') ?? 'unknown-source',
    })
    return null
  } catch (error) {
    if (!(error instanceof InitializationKeyError)) {
      throw error
    }

    if (error.code === 'rate_limited') {
      context.header('Retry-After', String(error.retryAfterSeconds ?? 900))
      return errorResponse(context, 429, error.code, error.message)
    }

    if (error.code === 'configuration_invalid') {
      return errorResponse(context, 503, error.code, error.message)
    }

    return errorResponse(context, 401, error.code, error.message)
  }
}

async function readInitializationBody(request: Request): Promise<InitializeSystemRequest> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new InitializationInputError('adminDisplayName', '初始化请求必须使用 JSON 格式')
  }

  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_INITIALIZATION_BODY_BYTES) {
    throw new InitializationInputError('adminDisplayName', '初始化请求内容过大')
  }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new InitializationInputError('adminDisplayName', '初始化请求格式无效')
  }

  if (!isRecord(value)) {
    throw new InitializationInputError('adminDisplayName', '初始化请求格式无效')
  }

  return {
    adminDisplayName: getRequiredString(value, 'adminDisplayName'),
    domainName: getRequiredString(value, 'domainName'),
    localPart: getRequiredString(value, 'localPart'),
    password: getRequiredString(value, 'password'),
    timezone: getRequiredString(value, 'timezone'),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getRequiredString(
  value: Record<string, unknown>,
  field: keyof InitializeSystemRequest,
): string {
  const fieldValue = value[field]
  if (typeof fieldValue !== 'string') {
    throw new InitializationInputError(field, '请完整填写初始化信息')
  }

  return fieldValue
}

function errorResponse(
  context: AppContext,
  status: ContentfulStatusCode,
  code: string,
  message: string,
  field?: string,
): Response {
  return context.json(
    {
      error: {
        code,
        message,
        ...(field ? { field } : {}),
      },
    },
    status,
  )
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '未知运行错误'
  return message
    .replace(/[\r\n]+/gu, ' ')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu, '[邮箱已隐藏]')
    .slice(0, 240)
}
