export class JsonResponse extends Response {
  constructor(body: any, init?: ResponseInit) {
    super(JSON.stringify(body), {
      headers: {
        "Content-Type": "application/json",
        ...init?.headers,
      },
      ...init,
    });
  }
}

export class ErrorResponse extends JsonResponse {
  constructor(message: string, status = 400) {
    super({ error: { message } }, { status });
  }
}

export class StreamResponse extends Response {
  constructor(body: any, init?: ResponseInit) {
    super(body, {
      headers: {
        "Content-Type": "text/plain",
        ...init?.headers,
      },
      ...init,
    });
  }
}

export enum ResponseMessages {
  MissingAppId = "Missing app id",
  MissingAuth = "Missing auth header",
  NotAuthorized = "Not authorized",
  GenericError = "Something went wrong",
}
