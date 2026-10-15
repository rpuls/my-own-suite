// The one error shape Suite Manager answers a request with. An error without a
// `statusCode`, or marked `internal`, is answered as an internal error and logged.
class CodedError extends Error {
  constructor(code, message, { details, internal = false, retryAfterSeconds, statusCode } = {}) {
    super(message);
    this.code = code;
    this.details = details;
    this.internal = internal;
    this.retryAfterSeconds = retryAfterSeconds;
    this.statusCode = statusCode;
  }
}

module.exports = { CodedError };
