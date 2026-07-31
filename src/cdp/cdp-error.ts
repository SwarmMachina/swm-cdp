import type { CdpRequest, CdpResponse } from '../types.js'

/** Error returned by Chrome for a syntactically valid CDP request. */
export default class CdpError extends Error {
  /** Chrome protocol error code, when supplied. */
  readonly code?: number

  /** Chrome protocol error details, when supplied. */
  readonly data?: unknown

  /** Original local request metadata. */
  readonly request: CdpRequest

  /** Complete CDP error response. */
  readonly response: CdpResponse

  /**
   * @param request Original local request metadata.
   * @param response CDP response containing an `error` object.
   */
  constructor(request: CdpRequest, response: CdpResponse) {
    super(response.error?.message ?? 'Unknown CDP error')
    this.name = 'CdpError'
    this.request = request
    this.response = response
    this.code = response.error?.code
    this.data = response.error?.data
  }

  /**
   * Tests whether a value is a CDP protocol error.
   * @returns `true` when `error` is a {@link CdpError}.
   */
  static isCdpError(error: unknown): error is CdpError {
    return error instanceof CdpError
  }

  /** @deprecated Use {@link CdpError.isCdpError}. */
  static isProtocolError(error: unknown): error is CdpError {
    return error instanceof CdpError
  }
}
