export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string,
    public param: string | null = null,
  ) {
    super(message);
  }
}
export function providerError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const message = error instanceof Error ? error.message : "";
  // Never return raw SDK errors: they can contain prompts or authentication material.
  if (/auth|sign.?in|log.?in|credential|401/i.test(message))
    return new ApiError(
      503,
      "Provider login required. Authenticate using its official CLI.",
      "provider_auth_required",
    );
  if (/429|rate.?limit|quota|usage limit/i.test(message))
    return new ApiError(
      429,
      "Provider usage limit reached.",
      "provider_rate_limit",
    );
  if (/model.*(invalid|unknown|not|unavailable)|invalid.*model/i.test(message))
    return new ApiError(
      400,
      "The provider rejected this model.",
      "model_not_available",
      "model",
    );
  return new ApiError(
    502,
    "Provider execution failed. Check the official CLI login and model availability.",
    "provider_error",
  );
}
export function errorBody(error: ApiError) {
  return {
    error: {
      message: error.message,
      type: error.status < 500 ? "invalid_request_error" : "server_error",
      param: error.param,
      code: error.code,
    },
  };
}
